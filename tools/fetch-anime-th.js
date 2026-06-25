#!/usr/bin/env node
/**
 * fetch-anime-th.js
 * สร้าง / อัปเดต playlist JSON จาก anime-th.com พร้อม metadata จาก TMDB
 *
 * ─── หมายเหตุ ────────────────────────────────────────────────────────────
 *   - แหล่ง: anime-th.com (WordPress + "future" theme)
 *   - 1 URL = หลาย season เลือกผ่าน --season=N
 *   - Track:
 *       --track=th     → "th-sound"  (พากย์ไทย)
 *       --track=subth  → "soundtrack" (ซับไทย)
 *   - Stream URL = anime.tonytonychopper.net/file2/{INNER_ID}/ (m3u8 HLS)
 *     ใช้ infra เดียวกับ fairyanime — ต้องผ่าน CF Worker proxy (HLS_PROXY_URL)
 *   - AJAX endpoints (POST /wp-admin/admin-ajax.php):
 *       • action=get_episode_list&season_id={SID}
 *         → { 'th-sound': {title, data:[{id,title,number,...}]}, 'soundtrack': {...} }
 *       • action=mix_get_player&post_id={EP_ID}&lang={TRACK_KEY}
 *         → { success, player: '<HTML with iframe>' }
 *         iframe src = anime.tonytonychopper.net/v2/{INNER_ID}
 *   - Shared logic อยู่ใน tools/lib/
 */

const cheerio = require('cheerio');
const fs = require('fs');
const path = require('path');

const { loadEnv } = require('./lib/env');
const { parseArgs } = require('./lib/cli');
const { makePaths } = require('./lib/type-config');
const utils = require('./lib/utils');
const tmdb = require('./lib/tmdb');
const io = require('./lib/playlist-io');
const { runUpdateMeta } = require('./lib/update-meta');

loadEnv(__dirname);

const cli = parseArgs();
let { seriesUrl, tmdbKey, customOutput, mainSlugArg, idPrefixArg,
      trackName, isDubbedTrack, seasonNum, seasonName,
      updateMeta, updateMetaMode, noTouch, forceTmdbId, tmdbSeasonNum,
      epOffset, typeArg, filterTrack } = cli;
const hlsProxy = (process.env.HLS_PROXY_URL || '').replace(/\/$/, '');
const epOffsetArg = cli.get('--ep-offset');

if (!seriesUrl && !updateMeta) {
  console.error('Usage: node fetch-anime-th.js <url> [--track=th|subth] --season=N [--output=FILE]');
  console.error('       node fetch-anime-th.js --update-meta[=poster|cover|title] [--season=N] [--track=th|subth] --output=FILE.txt');
  process.exit(1);
}

const { isMovie, playlistDir: PLAYLIST_DIR, indexPath: INDEX_PATH, githubRawBase: GITHUB_RAW_BASE } =
  makePaths({ typeArg, scriptDir: __dirname });

const SITE_BASE = 'https://anime-th.com';
const AJAX_URL  = `${SITE_BASE}/wp-admin/admin-ajax.php`;
const STATION_REFERER = `${SITE_BASE}/`;

const HEADERS = {
  'User-Agent':      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120 Safari/537.36',
  'Accept-Language': 'th-TH,th;q=0.9,en;q=0.8',
  'Accept':          'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  'Referer':         `${SITE_BASE}/`,
};

const TRACK_KEY_MAP = {
  th:    'th-sound',     // พากย์ไทย
  subth: 'soundtrack',   // ซับไทย / ซับไตเติ้ล (ต้นฉบับ + ซับไทย)
};

// ───── Source-specific helpers ─────
async function fetchText(url, extraHeaders = {}) {
  const res = await fetch(url, { headers: { ...HEADERS, ...extraHeaders } });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  return res.text();
}

async function ajaxPost(action, params, extraHeaders = {}) {
  const body = new URLSearchParams({ action, ...params }).toString();
  const res = await fetch(AJAX_URL, {
    method: 'POST',
    headers: {
      ...HEADERS,
      'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
      'X-Requested-With': 'XMLHttpRequest',
      'Origin': SITE_BASE,
      ...extraHeaders,
    },
    body,
  });
  if (!res.ok) throw new Error(`AJAX ${action} HTTP ${res.status}`);
  return res.json();
}

// ───── Step 1: Parse anime page → title, poster, season list ─────
async function parseAnimePage(url) {
  console.log(`\n📄 กำลัง fetch หน้า anime: ${url}`);
  const html = await fetchText(url);
  const $    = cheerio.load(html);

  const title = ($('h1[itemprop="name"]').first().text() || $('h1').first().text() || $('title').first().text() || '').trim();
  const posterImg = ($('meta[property="og:image"]').attr('content') || '').trim();

  // Parse season <option> tags: <option value="{season_post_id}">Season N (NN episodes)</option>
  const seasons = [];
  const seen = new Set();
  $('select#season-select option, select#season-select-mobile option, select option').each((_, el) => {
    const $el = $(el);
    const val = ($el.attr('value') || '').trim();
    const text = ($el.text() || '').trim();
    const m = text.match(/Season\s+(\d+)\s*\((\d+)\s*episodes?\)/i);
    if (!val || !m) return;
    if (seen.has(val)) return;
    seen.add(val);
    seasons.push({
      seasonId: val,
      seasonNum: parseInt(m[1]),
      epCount: parseInt(m[2]),
    });
  });
  seasons.sort((a, b) => a.seasonNum - b.seasonNum);

  if (!title) throw new Error('ไม่พบ title — ตรวจสอบ URL อีกครั้ง');
  if (!seasons.length) throw new Error('ไม่พบ season options — เว็บอาจเปลี่ยน structure');

  console.log(`✅ พบ: "${title}" — ${seasons.length} season(s)`);
  seasons.forEach((s) => console.log(`   • Season ${s.seasonNum} (id=${s.seasonId}) — ${s.epCount} ตอน`));
  return { title, posterImg, seasons };
}

// ───── Step 2: AJAX get_episode_list → episodes per track ─────
/**
 * คืน { [trackKey]: { title, episodes: [{id, number, title}] } }
 *
 * ⚠️ Filter episodes ตาม flag `has_th_sound` / `has_soundtrack`:
 *    API คืน list เดียวกันสำหรับทุก track — แต่ละ episode มี flag บอกว่ามี dub/sub จริงไหม
 *    เช่น Liar Game มี 14 ตอนใน array, แต่ has_th_sound = true แค่ 7 ตอน
 *    → ต้อง skip ตอนที่ไม่มี track ที่ต้องการ (มิฉะนั้น mix_get_player จะ return ของอีก track)
 */
const TRACK_FLAG = {
  'th-sound':   'has_th_sound',
  'soundtrack': 'has_soundtrack',
};

async function getEpisodeList(seasonId) {
  const data = await ajaxPost('get_episode_list', { season_id: seasonId });
  const result = {};
  for (const [trackKey, group] of Object.entries(data)) {
    if (!group || !Array.isArray(group.data)) continue;
    const flag = TRACK_FLAG[trackKey];
    result[trackKey] = {
      title: group.title || trackKey,
      episodes: group.data
        // ถ้ารู้ flag ของ track นี้ → กรอง episode ที่ไม่มี track นั้น
        .filter((e) => !flag || e[flag] === true)
        .map((e) => ({
          id: String(e.id),
          number: parseInt(e.number) || 0,
          title: e.title || '',
          fullTitle: e.full_title || '',
        }))
        .sort((a, b) => a.number - b.number),
    };
  }
  return result;
}

// ───── Step 3: get_player + player_change → extract innerId for chosen track ─────
/**
 * คืน { streamUrl, streamReferer }
 *   streamUrl = anime.tonytonychopper.net/file2/{INNER_ID}/
 *   streamReferer = anime.tonytonychopper.net/v2/{INNER_ID}
 *
 * Flow:
 *   1) `mix_get_player(post_id, lang)` → HTML player + server <span> elements ต่อ track
 *      iframe default คือ track อื่น (ไม่จำเป็นต้องตรง lang ที่ส่ง — เว็บอาจ default = dub เสมอ)
 *   2) Parse <span data-source="{track}" data-id="..." data-function="..."> → server config ของ track
 *   3) `mix_player_change(post_id, source, id, function)` → HTML ที่มี iframe ของ track นั้นจริงๆ
 */
async function getStreamInfo(episodeId, trackKey) {
  const data = await ajaxPost('mix_get_player', { post_id: episodeId, lang: trackKey });
  if (!data || data.success !== true || !data.player) {
    throw new Error(`mix_get_player ล้มเหลว (post_id=${episodeId}, lang=${trackKey})`);
  }
  const html = data.player;

  // หา <span data-source="{trackKey}" data-id="..." data-function="..."> → server config ของ track
  const escapedTrack = trackKey.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const spanRegex = new RegExp(`<span\\b[^>]*\\bdata-source="${escapedTrack}"[^>]*>`, 'i');
  const spanMatch = html.match(spanRegex);
  if (!spanMatch) throw new Error(`ไม่พบ source "${trackKey}" ใน player response (ep=${episodeId})`);

  const attrs = {};
  for (const m of spanMatch[0].matchAll(/(data-[a-z\-]+)="([^"]*)"/g)) {
    attrs[m[1]] = m[2];
  }
  const serverId   = attrs['data-id']       || '1';
  const serverFunc = attrs['data-function'] || 'cp1_proxy_get';

  // เรียก mix_player_change เพื่อให้ได้ iframe ของ track นั้นจริงๆ
  const change = await ajaxPost('mix_player_change', {
    post_id: episodeId,
    source: trackKey,
    id: serverId,
    function: serverFunc,
  });
  if (!change || change.success !== true || !change.data) {
    throw new Error(`mix_player_change ล้มเหลว (post_id=${episodeId}, source=${trackKey})`);
  }
  const iframeMatch = change.data.match(/<iframe[^>]+src=["']([^"']+)["']/i);
  if (!iframeMatch) throw new Error(`ไม่พบ iframe ใน player_change response (ep=${episodeId})`);
  const iframeUrl = iframeMatch[1].replace(/\\\//g, '/');

  // 2 รูปแบบ iframe:
  //   /v2/{id}  → /file2/{id}/  (เนื้อหาใหม่/1080p)
  //   /v/{id}   → /file/{id}/   (เนื้อหาเก่า/360p)
  const innerMatch = iframeUrl.match(/tonytonychopper\.net\/(v2?)\/([A-Za-z0-9_-]+)/);
  if (!innerMatch) throw new Error(`iframe ไม่ใช่ tonytonychopper/v|v2 (ep=${episodeId}, iframe=${iframeUrl})`);
  const versionPath = innerMatch[1];                          // "v" หรือ "v2"
  const innerId     = innerMatch[2];
  const filePath    = versionPath === 'v2' ? 'file2' : 'file';

  return {
    streamUrl: `https://anime.tonytonychopper.net/${filePath}/${innerId}/`,
    streamReferer: `https://anime.tonytonychopper.net/${versionPath}/${innerId}`,
  };
}

// ───── Main ─────
async function main() {
  if (updateMeta) {
    await runUpdateMeta({
      playlistDir: PLAYLIST_DIR,
      indexPath: INDEX_PATH,
      githubRawBase: GITHUB_RAW_BASE,
      isMovie,
      tmdbKey,
      customOutput,
      seasonName,
      filterTrack,
      updateMetaMode,
      forceTmdbId,
      noTouch,
    });
    return;
  }

  try {
    const { title: rawTitle, posterImg: rawPoster, seasons } = await parseAnimePage(seriesUrl);

    // Resolve season selection
    const wantSeason = seasonNum != null ? seasonNum : null;
    let chosenSeason;
    if (wantSeason != null) {
      chosenSeason = seasons.find((s) => s.seasonNum === wantSeason);
      if (!chosenSeason) {
        console.error(`❌ ไม่พบ Season ${wantSeason} ในหน้านี้`);
        console.error(`   มี: ${seasons.map((s) => `S${s.seasonNum}(${s.epCount}ep)`).join(', ')}`);
        process.exit(1);
      }
    } else if (seasons.length === 1) {
      chosenSeason = seasons[0];
    } else {
      console.error(`❌ หน้านี้มีหลาย season — กรุณาระบุ --season=N`);
      console.error(`   มี: ${seasons.map((s) => `S${s.seasonNum}(${s.epCount}ep)`).join(', ')}`);
      process.exit(1);
    }
    console.log(`📌 ใช้ Season ${chosenSeason.seasonNum} (id=${chosenSeason.seasonId})`);

    // Resolve track selection
    const wantTrack = cli.trackArg === 'subth' ? 'subth' : 'th';
    const trackKey = TRACK_KEY_MAP[wantTrack];

    // Fetch episode list
    console.log(`\n🎞  กำลังโหลด episode list...`);
    const epLists = await getEpisodeList(chosenSeason.seasonId);
    const availableTracks = Object.keys(epLists);
    console.log(`   พบ track: ${availableTracks.map((t) => `${t} (${epLists[t].episodes.length} ตอน)`).join(', ')}`);

    let chosenTrack = epLists[trackKey];
    if (!chosenTrack) {
      if (availableTracks.length === 1) {
        const only = availableTracks[0];
        console.warn(`⚠️  ไม่มี track "${trackKey}" — ใช้ "${only}" แทน`);
        chosenTrack = epLists[only];
      } else {
        console.error(`❌ ไม่พบ track "${trackKey}" ใน Season ${chosenSeason.seasonNum}`);
        console.error(`   มี: ${availableTracks.join(', ')}`);
        process.exit(1);
      }
    }
    const episodes = chosenTrack.episodes;
    console.log(`📌 ใช้ track: "${trackKey}" (${chosenTrack.title}) — ${episodes.length} ตอน`);

    if (episodes.length === 0) {
      console.error('❌ ไม่พบ episode ใดเลย');
      process.exit(1);
    }

    // TMDB lookup
    let seriesTitle = rawTitle;
    let posterUrl = rawPoster;
    let seasonPosterUrl = rawPoster;
    let tmdbEpisodes = [];
    let tmdbSeasonName = null;
    let tmdbShow = null;
    let seasonAirDate = '';

    if (tmdbKey) {
      let tmdbResult;
      if (isMovie) {
        if (forceTmdbId) {
          console.log(`\n🎬 ใช้ TMDB ID ที่ระบุ: ${forceTmdbId}`);
          tmdbResult = await tmdb.getTmdbMovieDetail(forceTmdbId, tmdbKey, 'en-US');
        } else {
          console.log('\n🎬 กำลัง search TMDB (movie)...');
          tmdbResult = await tmdb.searchTmdbMovie(rawTitle, tmdbKey);
        }
        if (tmdbResult) {
          const tmdbEnName = tmdbResult.title || rawTitle;
          const tmdbThName = await tmdb.getTmdbMovieNameTh(tmdbResult.id, tmdbKey);
          const tmdbName = utils.formatSeriesTitle(tmdbEnName, tmdbThName);
          const tmdbPoster = tmdbResult.poster_path ? `${tmdb.TMDB_IMG}${tmdbResult.poster_path}` : rawPoster;
          console.log(`✅ พบใน TMDB: "${tmdbName}" (ID: ${tmdbResult.id})`);
          tmdbShow = tmdbResult; seriesTitle = tmdbName; posterUrl = tmdbPoster;
        } else { console.warn('⚠️  ไม่พบใน TMDB ใช้ข้อมูลจาก anime-th แทน'); }
      } else {
        if (forceTmdbId) {
          console.log(`\n🎬 ใช้ TMDB ID ที่ระบุ: ${forceTmdbId}`);
          tmdbResult = await tmdb.getTmdbShow(forceTmdbId, tmdbKey, 'en-US');
        } else {
          console.log('\n🎬 กำลัง search TMDB...');
          tmdbResult = await tmdb.searchTmdbTv(rawTitle, tmdbKey);
        }
        if (tmdbResult) {
          const tmdbEnName = tmdbResult.name || rawTitle;
          const tmdbThName = await tmdb.getTmdbShowNameTh(tmdbResult.id, tmdbKey);
          const tmdbName = utils.formatSeriesTitle(tmdbEnName, tmdbThName);
          const tmdbPoster = tmdbResult.poster_path ? `${tmdb.TMDB_IMG}${tmdbResult.poster_path}` : rawPoster;
          console.log(`✅ พบใน TMDB: "${tmdbName}" (ID: ${tmdbResult.id})`);
          tmdbShow = tmdbResult; seriesTitle = tmdbName; posterUrl = tmdbPoster; seasonPosterUrl = tmdbPoster;

          // map playlist Season → TMDB Season
          const playlistSeasonNum = seasonNum || chosenSeason.seasonNum;
          const lookupSeason = tmdbSeasonNum || playlistSeasonNum;
          if (tmdbSeasonNum && tmdbSeasonNum !== playlistSeasonNum) {
            console.log(`📌 TMDB Season override: playlist Season ${playlistSeasonNum} → TMDB Season ${tmdbSeasonNum}`);
          }
          if (epOffset > 0) console.log(`📌 Episode offset: +${epOffset} (source ep 1 → TMDB ep ${epOffset + 1})`);

          const biData = await tmdb.getTmdbSeasonBilingual(tmdbResult.id, tmdbKey, lookupSeason);
          tmdbEpisodes = isDubbedTrack ? biData.thEpisodes : biData.enEpisodes;
          if (biData.poster) seasonPosterUrl = biData.poster;
          tmdbSeasonName = biData.seasonName;
          seasonAirDate = biData.air_date || '';
          console.log(`✅ ดึงข้อมูล ${tmdbEpisodes.length} ตอน (Season ${lookupSeason}, ${isDubbedTrack ? 'th-TH w/ EN fallback' : 'en-US'}) จาก TMDB`);
        } else { console.warn('⚠️  ไม่พบใน TMDB ใช้ข้อมูลจาก anime-th แทน'); }
      }
    } else { console.warn('⚠️  ไม่มี TMDB_API_KEY ข้าม TMDB lookup'); }

    // Fetch stream URLs
    console.log(`\n🔗 กำลัง fetch stream URLs (${episodes.length} ตอน)...`);
    const stations = [];

    for (let i = 0; i < episodes.length; i++) {
      const ep = episodes[i];
      // ใช้ API's `number` แทน loop index — สำคัญตอน filter ทำให้ ep หาย (เช่น ep 5 ขาด dub)
      // มิฉะนั้น station "ตอน 5" จะใส่ stream ของ ep 6 + TMDB title ของ ep 5 (mismatch)
      const epNum = ep.number || (i + 1);
      process.stdout.write(`  ตอน ${epNum}/${episodes.length} (id=${ep.id})...`);

      let streamUrl = null, streamReferer = null;
      try {
        const info = await getStreamInfo(ep.id, trackKey);
        streamUrl = info.streamUrl;
        streamReferer = info.streamReferer;
        process.stdout.write(' ✅\n');
      } catch (err) { console.warn(` ⚠️  ${err.message}`); }

      const tmdbEpNum = epNum + epOffset;
      const tmdbEp = tmdbEpisodes.find((e) => e.episode_number === tmdbEpNum);
      const epTitle = tmdbEp?.name || '';
      const epThumb = tmdbEp?.still_path ? `${tmdb.TMDB_IMG}${tmdbEp.still_path}` : '';

      let finalUrl = streamUrl || seriesUrl;
      if (streamUrl && hlsProxy) {
        finalUrl = `${hlsProxy}/?url=${encodeURIComponent(streamUrl)}&referer=${encodeURIComponent(streamReferer)}`;
      }

      stations.push({
        name: utils.buildStationName(epNum, epTitle, isDubbedTrack),
        ...(epThumb && { image: epThumb }),
        url: finalUrl,
        referer: STATION_REFERER,
        release_date: tmdbEp?.air_date || '',
      });
      if (i < episodes.length - 1) await utils.sleep(500);
    }

    // Build / save playlist
    const slug = customOutput || utils.slugify(seriesTitle.replace(/\[.*?\]/g, '').replace(/\(.*?\)/g, '').trim());
    const slugFile = slug.endsWith('.txt') ? slug : `${slug}.txt`;
    const resolvedIdPrefix = idPrefixArg || String(tmdbShow?.id || '');
    const outputFile = resolvedIdPrefix ? `${resolvedIdPrefix}-${slugFile}` : slugFile;
    const outputPath = path.resolve(PLAYLIST_DIR, outputFile);

    if (isMovie) {
      const s = stations[0];
      if (!s) { console.error('❌ ไม่พบ stream URL'); process.exit(1); }
      const partSeason = seasonNum || chosenSeason.seasonNum;
      const partPlaylist = io.buildPartFile({
        outputPath, season: partSeason, posterUrl, trackName,
        streamUrl: s.url, sourceUrl: s.referer,
      });
      io.stampPlaylist(partPlaylist, tmdbShow, true);
      fs.writeFileSync(outputPath, JSON.stringify(partPlaylist, null, 4), 'utf-8');
      console.log(`\n📁 บันทึก part file: ${outputPath}`);

      const mainFile = mainSlugArg
        ? (mainSlugArg.endsWith('.txt') ? mainSlugArg : `${mainSlugArg}.txt`)
        : slugFile;
      const mainPath = path.resolve(PLAYLIST_DIR, mainFile);
      const partRawUrl = `${GITHUB_RAW_BASE}${outputFile}`;
      const mainPlaylist = io.upsertMainFile({
        mainPath, franchiseName: seriesTitle, franchisePoster: posterUrl,
        partTitle: seriesTitle, partPoster: posterUrl,
        partFileRawUrl: partRawUrl, season: partSeason,
      });
      io.stampPlaylist(mainPlaylist, tmdbShow, true);
      fs.writeFileSync(mainPath, JSON.stringify(mainPlaylist, null, 4), 'utf-8');
      console.log(`📁 บันทึก main file: ${mainPath}`);

      io.updateIndex({
        indexPath: INDEX_PATH, githubRawBase: GITHUB_RAW_BASE,
        seriesTitle, posterUrl, filename: mainFile, upsert: true,
        releaseDate: mainPlaylist.release_date || '',
        updatedAt: mainPlaylist.updated_at,
        seasonCount: null, completion: null,
      });
    } else {
      // Override seasonName เพื่อให้ playlist groups ใช้ Season จริง
      const playlistSeasonName = seasonName || `Season ${chosenSeason.seasonNum}`;
      const playlist = io.buildOrMergePlaylist({
        outputPath, seriesTitle, posterUrl, seasonPosterUrl, stations,
        trackName, trackReferer: seriesUrl, tmdbSeasonName,
        seasonName: playlistSeasonName, seasonNum: chosenSeason.seasonNum, epOffset,
      });
      io.markSeasonTrackComplete({ playlist, seasonName: playlistSeasonName, trackName, tmdbEpCount: tmdbEpisodes.length });
      if (seasonAirDate) {
        const affectedSeason = (playlist.groups || []).find((g) => g.name === playlistSeasonName);
        if (affectedSeason) affectedSeason.release_date = seasonAirDate;
      }
      io.stampPlaylist(playlist, tmdbShow, false);
      fs.writeFileSync(outputPath, JSON.stringify(playlist, null, 4), 'utf-8');
      console.log(`\n📁 บันทึกไฟล์: ${outputPath}`);
      io.updateIndex({
        indexPath: INDEX_PATH, githubRawBase: GITHUB_RAW_BASE,
        seriesTitle, posterUrl, filename: outputFile, upsert: true,
        releaseDate: playlist.release_date || '',
        updatedAt: playlist.updated_at,
        seasonCount: playlist.season_count ?? null,
        completion: playlist.completion ?? null,
      });
    }

    console.log('\n🎉 เสร็จสิ้น!');
    console.log(`   ไฟล์: ${outputFile}`);
    console.log(`   ${isMovie ? 'ประเภท: Movie' : `จำนวนตอน: ${stations.length}`}`);
  } catch (err) {
    console.error(`\n❌ Error: ${err.message}`);
    process.exit(1);
  }
}

main();

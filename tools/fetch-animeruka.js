#!/usr/bin/env node
/**
 * fetch-animeruka.js
 * สร้าง / อัปเดต playlist JSON จาก animeruka.com พร้อม metadata จาก TMDB
 * Stream URL ดึงตรง (animemami.xyz → cdn2.maimeorder.com) — ต้องผ่าน CF Worker proxy
 *
 * ─── Flags ───────────────────────────────────────────────────────────────
 *   <url>              URL หน้า anime บน animeruka.com
 *                      เช่น https://animeruka.com/anime/megami-no-cafe-terrace-2nd-season/
 *   --track=th|subth  th = พากย์ไทย, subth = ซับไทย (default: th)
 *   --season=N        ระบุ season ที่จะ fetch หรืออัปเดต (default: 1)
 *   --output=FILE     ชื่อไฟล์ผลลัพธ์ใน playlist/anime/series/
 *   --tmdb-key=KEY    TMDB API key (อ่านจาก .env อัตโนมัติ)
 *   --tmdb-id=N       ระบุ TMDB TV ID ตรงๆ
 *   --update-meta[=poster|cover|title]
 *                     อัปเดต metadata จาก TMDB โดยไม่ fetch stream URLs ใหม่
 *   --no-touch        skip current-time stamping (deterministic rollup จาก children)
 *   --type=KIND       anime-series | anime-movie | movie | series | av
 *   --split-eps=N,M:k TMDB ตอน N ถูกเว็บแบ่งเป็น 2 ตอน (M:k = แบ่ง k ตอน)
 *                     ชื่อออกเป็น "ตอน N (1/2)" และตอนถัดไปเลขตาม TMDB ไม่ drift
 *   --auto-split      ตรวจจับตอนพิเศษเองจาก runtime ของ TMDB — ใช้เมื่อจำนวนตอน
 *                     ลงตัวเป๊ะเท่านั้น (ถ้าใส่ --split-eps เองจะใช้ค่าที่ใส่)
 *
 * ─── หมายเหตุ ────────────────────────────────────────────────────────────
 *   - DooPlay theme: GET /wp-json/dooplayer/v2/{post_id}/tv/1 → คืน embed_url
 *   - Embed (animemami.xyz) → parse <div id="app" data-page="..."> ดึง video.url
 *   - Stream เป็น HLS (cdn2.maimeorder.com/hls/.../*.txt) + segments .webp
 *   - CDN block ตาม Origin header — ต้องผ่าน CF Worker proxy (เหมือน kurokamii)
 *   - Player nume=2,3 เป็น mirror คนละ host (short.icu/ok.ru) — ใช้แค่ nume=1
 *   - Default --track = th (พากย์ไทย)
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
const { buildEpisodeMap, suggestSplitEps, applyMeasuredSplit } = require('./lib/episode-map');

loadEnv(__dirname);

// animeruka default track override: th (most content is dubbed)
const cli = parseArgs();
let { seriesUrl, tmdbKey, customOutput, mainSlugArg, idPrefixArg,
      seasonNum, seasonName, updateMeta, updateMetaMode, noTouch,
      forceTmdbId, tmdbSeasonNum, epOffset, splitEps, autoSplit, typeArg, filterTrack } = cli;

// Override default: animeruka defaults to พากย์ไทย if --track= not specified
let trackName = cli.trackName;
let isDubbedTrack = cli.isDubbedTrack;
if (!cli.trackArg) {
  trackName = 'พากย์ไทย';
  isDubbedTrack = true;
}
const epOffsetArg = cli.get('--ep-offset');

if (!seriesUrl && !updateMeta) {
  console.error('Usage: node fetch-animeruka.js <url> [--track=th|subth] [--season=N] [--output=FILE]');
  console.error('       node fetch-animeruka.js --update-meta[=poster|cover|title] [--season=N] --output=FILE.txt');
  process.exit(1);
}

const { isMovie, playlistDir: PLAYLIST_DIR, indexPath: INDEX_PATH, githubRawBase: GITHUB_RAW_BASE } =
  makePaths({ typeArg, scriptDir: __dirname });

const SITE_BASE      = 'https://animeruka.com';
const STREAM_REFERER = 'https://animemami.xyz/';
const CF_PROXY       = 'https://shy-haze-2452.natajrak-p.workers.dev/';
const REFERER        = 'https://animeruka.com/';

function wrapWithProxy(rawUrl, referer = STREAM_REFERER) {
  return `${CF_PROXY}?url=${encodeURIComponent(rawUrl)}&referer=${encodeURIComponent(referer)}`;
}

const HEADERS = {
  'User-Agent':      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  'Accept-Language': 'th-TH,th;q=0.9,en;q=0.8',
  'Accept':          'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  'Referer':         REFERER,
};

// ───── Source-specific: HTTP helpers ─────
async function fetchHtml(url) {
  const res = await fetch(url, { headers: HEADERS });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  return res.text();
}

async function fetchJson(url, extraHeaders = {}) {
  const res = await fetch(url, { headers: { ...HEADERS, ...extraHeaders } });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  return res.json();
}

// ───── Source-specific: Parse anime page → sections (track-grouped episode lists) ─────
/**
 * คืน { title, posterImg, sections: [{ track, name, episodes }] }
 * - หน้าเว็บ animeruka อาจมีหลาย <div class='se-c'> (section) ต่อหน้า
 *   • ชื่อ section "ภาคNth" (se-t.se-o) → พากย์ไทย
 *   • ชื่อ section "ภาคN" (se-t)       → ซับไทย
 */
async function parseAnimePage(url) {
  console.log(`\n📄 กำลัง fetch หน้า anime: ${url}`);
  const html = await fetchHtml(url);
  const $    = cheerio.load(html);

  const title = ($('.data h1').first().text() || $('meta[property="og:title"]').attr('content') || '').trim();
  const posterImg = ($('meta[property="og:image"]').attr('content') || '').trim();

  const sections = [];
  $('div.se-c').each((_, sec) => {
    const $sec  = $(sec);
    const sName = ($sec.find('.se-t').first().text() || '').trim();
    // "ภาคNth" (หรือลงท้ายด้วย th) → พากย์ไทย, อื่นๆ → ซับไทย
    const sectionTrack = /th\s*$/i.test(sName) ? 'th' : 'subth';

    const episodes = [];
    $sec.find('ul.episodios li').each((_, li) => {
      const $li     = $(li);
      const linkEl  = $li.find('.episodiotitle a').first();
      const epUrl   = (linkEl.attr('href') || '').trim();
      if (!epUrl) return;
      const epLabel  = (linkEl.text() || '').trim();
      const numText  = ($li.find('.numerando').text() || '').trim();
      const numMatch = numText.match(/(\d+)/);
      const epNum    = numMatch ? parseInt(numMatch[1]) : episodes.length + 1;
      const thumb    = ($li.find('.imagen img').attr('src') || '').trim();
      episodes.push({ url: epUrl, epNum, label: epLabel, thumb });
    });
    episodes.sort((a, b) => a.epNum - b.epNum);

    if (episodes.length) sections.push({ track: sectionTrack, name: sName, episodes });
  });

  if (!sections.length) throw new Error('ไม่พบ section (div.se-c) — ตรวจสอบ URL อีกครั้ง');
  console.log(`✅ พบ: "${title}" — ${sections.length} section(s)`);
  sections.forEach((s) => console.log(`   • ${s.name} (${s.track}) — ${s.episodes.length} ตอน`));
  return { title, posterImg, sections };
}

/** เลือก section ที่ match track ที่ user ระบุ; fallback ถ้ามี section เดียว */
function pickSection(sections, wantTrack) {
  const matched = sections.find((s) => s.track === wantTrack);
  if (matched) return matched;
  if (sections.length === 1) {
    const only = sections[0];
    console.warn(`⚠️  หน้านี้มี section เดียว (${only.name}, ${only.track}) แต่ขอ --track=${wantTrack}`);
    console.warn(`    ใช้ section นี้แทน — ตรวจสอบว่า URL ถูกต้องสำหรับ track ที่ต้องการ`);
    return only;
  }
  return null;
}

// ───── Source-specific: Get post_id → embed URL → stream URL ─────
async function getEpisodePostId(epPageUrl) {
  const html = await fetchHtml(epPageUrl);
  const m = html.match(/dooplay_player_option'[^>]*data-post='(\d+)'/)
         || html.match(/data-post="(\d+)"[^>]*data-nume="1"/)
         || html.match(/data-post='(\d+)'/);
  if (!m) throw new Error(`ไม่พบ data-post ใน ${epPageUrl}`);
  return m[1];
}

async function getEmbedUrl(postId, nume = 1) {
  const url = `${SITE_BASE}/wp-json/dooplayer/v2/${postId}/tv/${nume}`;
  const data = await fetchJson(url, { Referer: `${SITE_BASE}/` });
  if (!data.embed_url) throw new Error(`DooPlay API คืน embed_url ว่าง (post=${postId}, nume=${nume})`);
  return data.embed_url;
}

/** parse stream URL จาก embed page ของ animemami.xyz (Inertia data-page) */
async function getStreamUrlFromEmbed(embedUrl) {
  // รับเฉพาะ animemami.xyz/v/{slug}; host อื่น (short.icu, ok.ru) ไม่รองรับ
  if (!/animemami\.xyz/i.test(embedUrl)) {
    throw new Error(`Embed host ไม่รองรับ: ${embedUrl}`);
  }
  const html = await fetchHtml(embedUrl);
  const m = html.match(/data-page="([^"]+)"/) || html.match(/data-page='([^']+)'/);
  if (!m) throw new Error(`ไม่พบ data-page ใน embed page: ${embedUrl}`);
  let pageJson;
  try {
    pageJson = JSON.parse(m[1].replace(/&quot;/g, '"').replace(/&amp;/g, '&'));
  } catch (e) {
    throw new Error(`Parse data-page ไม่ได้: ${e.message}`);
  }
  const video = pageJson?.props?.video;
  if (!video?.url) throw new Error(`ไม่พบ video.url ใน embed page: ${embedUrl}`);
  return video.url;
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
    const urls = seriesUrl.split(',').map((u) => u.trim()).filter(Boolean);
    const isMultiUrl = urls.length > 1;
    const wantTrack = cli.trackArg === 'subth' ? 'subth' : 'th';
    let rawTitle = '', rawPoster = '';
    let episodes = [];

    for (let ui = 0; ui < urls.length; ui++) {
      if (isMultiUrl) console.log(`\n📡 Fetch part ${ui + 1}/${urls.length}: ${urls[ui]}`);
      const result = await parseAnimePage(urls[ui]);
      if (ui === 0) { rawTitle = result.title; rawPoster = result.posterImg; }

      const chosen = pickSection(result.sections, wantTrack);
      if (!chosen) {
        console.error(`❌ ไม่พบ section ที่ตรงกับ --track=${wantTrack} ใน ${urls[ui]}`);
        console.error(`   มี: ${result.sections.map((s) => `${s.name}(${s.track})`).join(', ')}`);
        process.exit(1);
      }
      console.log(`📌 ใช้ section: "${chosen.name}" (${chosen.track}) — ${chosen.episodes.length} ตอน`);

      const offset = episodes.length;
      for (const ep of chosen.episodes) {
        ep._partOffset = offset;
        episodes.push(ep);
      }
      if (isMultiUrl) console.log(`  ✅ พบ ${chosen.episodes.length} ตอน (รวม ${episodes.length})`);
    }

    if (isMultiUrl && !epOffsetArg) epOffset = 0;

    if (episodes.length === 0) {
      console.error('❌ ไม่พบ episode ใดเลย ตรวจสอบ URL อีกครั้ง');
      process.exit(1);
    }

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
          const tmdbName   = utils.formatSeriesTitle(tmdbEnName, tmdbThName);
          const tmdbPoster = tmdbResult.poster_path
            ? `${tmdb.TMDB_IMG}${tmdbResult.poster_path}`
            : rawPoster;
          console.log(`✅ พบใน TMDB: "${tmdbName}" (ID: ${tmdbResult.id})`);
          tmdbShow    = tmdbResult;
          seriesTitle = tmdbName;
          posterUrl   = tmdbPoster;
        } else {
          console.warn('⚠️  ไม่พบใน TMDB ใช้ข้อมูลจาก animeruka แทน');
        }
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
          const tmdbName   = utils.formatSeriesTitle(tmdbEnName, tmdbThName);
          const tmdbPoster = tmdbResult.poster_path
            ? `${tmdb.TMDB_IMG}${tmdbResult.poster_path}`
            : rawPoster;
          console.log(`✅ พบใน TMDB: "${tmdbName}" (ID: ${tmdbResult.id})`);
          tmdbShow        = tmdbResult;
          seriesTitle     = tmdbName;
          posterUrl       = tmdbPoster;
          seasonPosterUrl = tmdbPoster;

          const lookupSeason = tmdbSeasonNum || seasonNum || 1;
          if (tmdbSeasonNum && tmdbSeasonNum !== (seasonNum || 1)) {
            console.log(`📌 TMDB Season override: playlist Season ${seasonNum || 1} → TMDB Season ${tmdbSeasonNum}`);
          }
          if (epOffset > 0) {
            console.log(`📌 Episode offset: +${epOffset} (source ep 1 → TMDB ep ${epOffset + 1})`);
          }

          const biData = await tmdb.getTmdbSeasonBilingual(tmdbResult.id, tmdbKey, lookupSeason);
          tmdbEpisodes    = isDubbedTrack ? biData.thEpisodes : biData.enEpisodes;
          if (biData.poster) seasonPosterUrl = biData.poster;
          tmdbSeasonName  = biData.seasonName;
          seasonAirDate   = biData.air_date || '';
          console.log(`✅ ดึงข้อมูล ${tmdbEpisodes.length} ตอน (Season ${lookupSeason}, ${isDubbedTrack ? 'th-TH w/ EN fallback' : 'en-US'}) จาก TMDB`);
        } else {
          console.warn('⚠️  ไม่พบใน TMDB ใช้ข้อมูลจาก animeruka แทน');
        }
      }
    }

    let resolvedSplitEps = splitEps;
    const epMap = buildEpisodeMap({ sourceCount: episodes.length, epOffset, splitEps: resolvedSplitEps });
    if (!autoSplit) {
      suggestSplitEps({ sourceCount: episodes.length, tmdbEpisodes, epOffset, splitEps: resolvedSplitEps });
    }

    console.log(`\n🔗 กำลัง fetch stream URLs (${episodes.length} ตอน)...`);
    const stations = [];

    for (let i = 0; i < episodes.length; i++) {
      const ep = episodes[i];
      const epNum = i + 1;
      process.stdout.write(`  ตอน ${epNum}/${episodes.length}...`);

      let streamUrl = null;
      try {
        const postId    = await getEpisodePostId(ep.url);
        const embedUrl  = await getEmbedUrl(postId, 1);
        const rawStream = await getStreamUrlFromEmbed(embedUrl);
        streamUrl       = wrapWithProxy(rawStream);
        process.stdout.write(` post=${postId}`);
      } catch (err) {
        console.warn(` ⚠️  ${err.message}`);
      }

      const { epNum: tmdbEpNum, label } = epMap[i];
      const tmdbEp = tmdbEpisodes.find((e) => e.episode_number === tmdbEpNum) || tmdbEpisodes[tmdbEpNum - 1];
      const epTitle = tmdbEp?.name || '';
      const epThumb = tmdbEp?.still_path
        ? `${tmdb.TMDB_IMG}${tmdbEp.still_path}`
        : (ep.thumb || '');
      const stationName = utils.buildStationName(label, epTitle, isDubbedTrack);

      stations.push({
        name: stationName,
        ...(epThumb && { image: epThumb }),
        url: streamUrl || ep.url,
        referer: STREAM_REFERER,
        release_date: tmdbEp?.air_date || '',
      });

      console.log(' ✅');
      if (i < episodes.length - 1) await utils.sleep(800);
    }

    if (autoSplit && !splitEps && !isMovie) {
      resolvedSplitEps = await applyMeasuredSplit({ stations, tmdbEpisodes, epOffset, isDubbedTrack });
    }

    const slug = customOutput || utils.slugify(seriesTitle.replace(/\[.*?\]/g, '').replace(/\(.*?\)/g, '').trim());
    const slugFile = slug.endsWith('.txt') ? slug : `${slug}.txt`;
    const resolvedIdPrefix = idPrefixArg || String(tmdbShow?.id || '');
    const outputFile = resolvedIdPrefix ? `${resolvedIdPrefix}-${slugFile}` : slugFile;
    const outputPath = path.resolve(PLAYLIST_DIR, outputFile);

    if (isMovie) {
      const s = stations[0];
      if (!s) { console.error('❌ ไม่พบ stream URL'); process.exit(1); }

      const partSeason = seasonNum || 1;
      const partPlaylist = io.buildPartFile({
        outputPath, season: partSeason, posterUrl,
        trackName, streamUrl: s.url, sourceUrl: seriesUrl,
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
        partCount: mainPlaylist.part_count ?? null,
      });
    } else {
      const playlist = io.buildOrMergePlaylist({
        outputPath, seriesTitle, posterUrl, seasonPosterUrl, stations,
        trackName, trackReferer: seriesUrl, tmdbSeasonName,
        seasonName, seasonNum, epOffset, splitEps: resolvedSplitEps,
      });
      io.markSeasonTrackComplete({ playlist, seasonName, trackName, tmdbEpCount: tmdbEpisodes.length });
      if (seasonAirDate) {
        const targetSeasonName = seasonName || 'Season 1';
        const affectedSeason = (playlist.groups || []).find((g) => utils.matchesSeasonName(g.name, targetSeasonName));
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

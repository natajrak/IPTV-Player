#!/usr/bin/env node
/**
 * fetch-anime108.js
 * สร้าง / อัปเดต playlist JSON จาก anime108.com พร้อม metadata จาก TMDB
 *
 * ─── Flags ───────────────────────────────────────────────────────────────
 *   <url>              URL หน้า anime บน anime108.com
 *                      เช่น https://www.anime108.com/accel-world/
 *   --track=th|subth  th = พากย์ไทย (lang=Thai), subth = ซับไทย (lang=Sound Track)
 *                     (default: th)
 *   --season=N        ระบุ season ที่จะ fetch หรืออัปเดต (default: 1)
 *   --output=FILE     ชื่อไฟล์ผลลัพธ์ใน playlist/anime/series/
 *   --tmdb-key=KEY    TMDB API key (อ่านจาก .env อัตโนมัติ)
 *   --tmdb-id=N       ระบุ TMDB TV ID ตรงๆ
 *   --update-meta[=poster|cover|title]
 *                     อัปเดต metadata จาก TMDB โดยไม่ fetch stream URLs ใหม่
 *   --no-touch        skip current-time stamping (deterministic rollup จาก children)
 *   --type=KIND       anime-series | anime-movie | movie | series | av
 *
 * ─── หมายเหตุ ────────────────────────────────────────────────────────────
 *   - Halim theme (WordPress) — episode list อยู่ใน <select id="sequel_select_th">
 *     (พากย์ไทย) หรือ <select id="sequel_select_en"> (ซับไทย/Sound Track)
 *   - Stream resolution: POST /api/get.php
 *       action=halim_ajax_player&episode={N}&server=1&postid={POST_ID}&lang={Thai|Sound Track}
 *     → iframe src "https://main.108player.com/index_th.php?id={ID}"
 *   - Stream URL: https://main.108player.com/newplaylist/{ID}/{ID}.m3u8
 *   - CORS เปิดทุก layer (master + segments) — **ไม่ต้องผ่าน proxy**
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

loadEnv(__dirname);

// anime108 default track override: th (most content is dubbed)
const cli = parseArgs();
let { seriesUrl, tmdbKey, customOutput, mainSlugArg, idPrefixArg,
      seasonNum, seasonName, updateMeta, updateMetaMode, noTouch,
      forceTmdbId, tmdbSeasonNum, epOffset, typeArg, filterTrack } = cli;

// Override default: anime108 defaults to พากย์ไทย if --track= not specified
let trackName = cli.trackName;
let isDubbedTrack = cli.isDubbedTrack;
if (!cli.trackArg) {
  trackName = 'พากย์ไทย';
  isDubbedTrack = true;
}
const epOffsetArg = cli.get('--ep-offset');

if (!seriesUrl && !updateMeta) {
  console.error('Usage: node fetch-anime108.js <url> [--track=th|subth] [--season=N] [--output=FILE]');
  console.error('       node fetch-anime108.js --update-meta[=poster|cover|title] [--season=N] --output=FILE.txt');
  process.exit(1);
}

const { isMovie, playlistDir: PLAYLIST_DIR, indexPath: INDEX_PATH, githubRawBase: GITHUB_RAW_BASE } =
  makePaths({ typeArg, scriptDir: __dirname });

const SITE_BASE  = 'https://www.anime108.com';
const API_URL    = 'https://www.anime108.com/api/get.php';
const PLAYER_BASE = 'https://main.108player.com';
const REFERER    = 'https://www.anime108.com/';

// halim lang values
const HALIM_LANG = { th: 'Thai', subth: 'Sound Track' };

const HEADERS = {
  'User-Agent':      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  'Accept-Language': 'th-TH,th;q=0.9,en;q=0.8',
  'Accept':          'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  'Referer':         REFERER,
};

// ───── Source-specific: HTTP helpers ─────
async function fetchHtml(url, extraHeaders = {}) {
  const res = await fetch(url, { headers: { ...HEADERS, ...extraHeaders } });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  return res.text();
}

// ───── Source-specific: Parse anime page ─────
/**
 * คืน { title, posterImg, postId, sections: [{ track, name, episodes }] }
 * - anime108 เก็บ episode list ใน <select id="sequel_select_th"> (พากย์)
 *   และ <select id="sequel_select_en"> (ซับไทย/Sound Track) — อาจมีเฉพาะตัวใดตัวหนึ่ง
 * - post_id ดึงจาก halim_cfg.post_id (constant ต่อ anime)
 * - URL ที่ user ให้มาอาจเป็นหน้า anime list (/accel-world/) หรือ ep page
 *   (/accel-world-ep-N/) — ทั้งคู่ render select เดียวกัน
 */
async function parseAnimePage(url) {
  console.log(`\n📄 กำลัง fetch หน้า anime: ${url}`);
  const html = await fetchHtml(url);
  const $    = cheerio.load(html);

  const title = ($('h1').not('.h1-logo').first().text()
    || $('meta[property="og:title"]').attr('content')
    || '').trim();
  const posterImg = ($('meta[property="og:image"]').attr('content') || '').trim();

  // halim_cfg.post_id — same across all eps of the same anime
  const postIdMatch = html.match(/halim_cfg\s*=\s*\{[^}]*"post_id"\s*:\s*(\d+)/);
  const postId = postIdMatch ? postIdMatch[1] : null;
  if (!postId) throw new Error('ไม่พบ halim_cfg.post_id ในหน้านี้');

  const parseSelect = (selectId) => {
    const opts = $(`select#${selectId} option`);
    const eps = [];
    opts.each((_, el) => {
      const val = ($(el).attr('value') || '').trim();
      const label = ($(el).text() || '').trim();
      if (!val) return;
      // value = "/accel-world-ep-N/" หรือ "/some-slug-ep-N/"
      const epUrl = val.startsWith('http') ? val : `${SITE_BASE}${val}`;
      const epMatch = val.match(/-ep-(\d+)(?:-|\/?$)/i);
      const epNum = epMatch ? parseInt(epMatch[1]) : eps.length + 1;
      eps.push({ url: epUrl, epNum, label });
    });
    eps.sort((a, b) => a.epNum - b.epNum);
    return eps;
  };

  const sections = [];
  const thEps  = parseSelect('sequel_select_th');
  const subEps = parseSelect('sequel_select_en');
  if (thEps.length)  sections.push({ track: 'th',    name: 'พากย์ไทย', episodes: thEps });
  if (subEps.length) sections.push({ track: 'subth', name: 'ซับไทย',   episodes: subEps });

  if (!sections.length) throw new Error('ไม่พบ <select id="sequel_select_th/en"> — ตรวจสอบ URL อีกครั้ง');
  console.log(`✅ พบ: "${title}" (post_id=${postId}) — ${sections.length} section(s)`);
  sections.forEach((s) => console.log(`   • ${s.name} (${s.track}) — ${s.episodes.length} ตอน`));
  return { title, posterImg, postId, sections };
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

// ───── Source-specific: halim_ajax_player → iframe → stream URL ─────
/**
 * เรียก halim_ajax_player สำหรับ episode N + server 1 → คืน iframe src
 * iframe pattern: https://main.108player.com/index_th.php?id={ID}
 */
async function getPlayerId(postId, epNum, lang, server = 1) {
  const body = new URLSearchParams({
    action:  'halim_ajax_player',
    nonce:   '',
    episode: String(epNum),
    server:  String(server),
    postid:  String(postId),
    lang:    lang,
    title:   '',
  }).toString();

  const res = await fetch(API_URL, {
    method: 'POST',
    headers: {
      ...HEADERS,
      'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
      'X-Requested-With': 'XMLHttpRequest',
    },
    body,
  });
  if (!res.ok) throw new Error(`halim_ajax_player HTTP ${res.status} (ep=${epNum}, server=${server})`);

  const html = await res.text();
  const iframeMatch = html.match(/<iframe[^>]+src="([^"]+)"/i);
  if (!iframeMatch) {
    throw new Error(`ไม่พบ iframe ใน response (ep=${epNum}, server=${server})`);
  }
  const iframeUrl = iframeMatch[1];

  // index_th.php?id={ID} หรือ index_en.php?id={ID}
  const idMatch = iframeUrl.match(/[?&]id=([a-zA-Z0-9]+)/);
  if (!idMatch) throw new Error(`ไม่พบ id ใน iframe URL: ${iframeUrl}`);
  return idMatch[1];
}

function buildStreamUrl(playerId) {
  return `${PLAYER_BASE}/newplaylist/${playerId}/${playerId}.m3u8`;
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
    const halimLang = HALIM_LANG[wantTrack] || HALIM_LANG.th;
    let rawTitle = '', rawPoster = '';
    let episodes = [];
    let postId = null;

    for (let ui = 0; ui < urls.length; ui++) {
      if (isMultiUrl) console.log(`\n📡 Fetch part ${ui + 1}/${urls.length}: ${urls[ui]}`);
      const result = await parseAnimePage(urls[ui]);
      if (ui === 0) { rawTitle = result.title; rawPoster = result.posterImg; postId = result.postId; }

      const chosen = pickSection(result.sections, wantTrack);
      if (!chosen) {
        console.error(`❌ ไม่พบ section ที่ตรงกับ --track=${wantTrack} ใน ${urls[ui]}`);
        console.error(`   มี: ${result.sections.map((s) => `${s.name}(${s.track})`).join(', ')}`);
        process.exit(1);
      }
      console.log(`📌 ใช้ section: "${chosen.name}" (${chosen.track}) — ${chosen.episodes.length} ตอน (lang=${halimLang})`);

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
          console.warn('⚠️  ไม่พบใน TMDB ใช้ข้อมูลจาก anime108 แทน');
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
          console.warn('⚠️  ไม่พบใน TMDB ใช้ข้อมูลจาก anime108 แทน');
        }
      }
    }

    console.log(`\n🔗 กำลัง fetch stream URLs (${episodes.length} ตอน) — post_id=${postId}...`);
    const stations = [];

    for (let i = 0; i < episodes.length; i++) {
      const ep = episodes[i];
      const epNum = ep.epNum || (i + 1);
      process.stdout.write(`  ตอน ${epNum}/${episodes.length}...`);

      let streamUrl = null;
      try {
        const playerId = await getPlayerId(postId, epNum, halimLang, 1);
        streamUrl      = buildStreamUrl(playerId);
        process.stdout.write(` id=${playerId}`);
      } catch (err) {
        console.warn(` ⚠️  ${err.message}`);
      }

      const tmdbEpNum = epNum + epOffset;
      const tmdbEp = tmdbEpisodes.find((e) => e.episode_number === tmdbEpNum) || tmdbEpisodes[i + epOffset];
      const epTitle = tmdbEp?.name || '';
      const epThumb = tmdbEp?.still_path
        ? `${tmdb.TMDB_IMG}${tmdbEp.still_path}`
        : '';
      const stationName = utils.buildStationName(epNum, epTitle, isDubbedTrack);

      stations.push({
        name: stationName,
        ...(epThumb && { image: epThumb }),
        url: streamUrl || ep.url,
        referer: REFERER,
        release_date: tmdbEp?.air_date || '',
      });

      console.log(' ✅');
      if (i < episodes.length - 1) await utils.sleep(500);
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
        seasonName, seasonNum, epOffset,
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

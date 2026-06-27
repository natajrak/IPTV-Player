#!/usr/bin/env node
/**
 * fetch-gg-animes.js
 * สร้าง / อัปเดต playlist JSON จาก gg-animes.com พร้อม metadata จาก TMDB
 *
 * ─── Flags ───────────────────────────────────────────────────────────────
 *   <url>              URL หน้า anime บน gg-animes.com
 *                      เช่น https://gg-animes.com/accel-world/
 *   --track=th|subth  th = พากย์ไทย, subth = ซับไทย (default: th)
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
 *   - Anime page → list ของ /watch/{epNum}-{viewCount}/ URLs (1 URL = 1 track)
 *   - Episode page → iframe src "https://gg-player.xyz/video/{vhash}"
 *   - Iframe → MASPlayer config: { videoUrl, videoServer, videoDisk }
 *   - Stream URL formula (จาก player JS):
 *       file = "https://" + location.hostname + videoUrl
 *            + "?s=" + videoServer
 *            + "&d=" + btoa(videoDisk || ", ")
 *     เนื่องจาก iframe อยู่บน gg-player.xyz → location.hostname = "gg-player.xyz"
 *   - Sub-playlist (level 2) ไม่มี CORS → ต้องผ่าน CF Worker proxy
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

// gg-animes default track override: th (most content is dubbed)
const cli = parseArgs();
let { seriesUrl, tmdbKey, customOutput, mainSlugArg, idPrefixArg,
      seasonNum, seasonName, updateMeta, updateMetaMode, noTouch,
      forceTmdbId, tmdbSeasonNum, epOffset, typeArg, filterTrack } = cli;

// Override default: gg-animes defaults to พากย์ไทย if --track= not specified
let trackName = cli.trackName;
let isDubbedTrack = cli.isDubbedTrack;
if (!cli.trackArg) {
  trackName = 'พากย์ไทย';
  isDubbedTrack = true;
}
const epOffsetArg = cli.get('--ep-offset');

if (!seriesUrl && !updateMeta) {
  console.error('Usage: node fetch-gg-animes.js <url> [--track=th|subth] [--season=N] [--output=FILE]');
  console.error('       node fetch-gg-animes.js --update-meta[=poster|cover|title] [--season=N] --output=FILE.txt');
  process.exit(1);
}

const { isMovie, playlistDir: PLAYLIST_DIR, indexPath: INDEX_PATH, githubRawBase: GITHUB_RAW_BASE } =
  makePaths({ typeArg, scriptDir: __dirname });

const SITE_BASE      = 'https://gg-animes.com';
const PLAYER_HOST    = 'gg-player.xyz';                  // iframe host (= location.hostname)
const STREAM_REFERER = 'https://gg-player.xyz/';
const CF_PROXY       = 'https://shy-haze-2452.natajrak-p.workers.dev/';
const REFERER        = 'https://gg-animes.com/';

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
async function fetchHtml(url, extraHeaders = {}) {
  const res = await fetch(url, { headers: { ...HEADERS, ...extraHeaders } });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  return res.text();
}

// ───── Source-specific: Parse anime page → episodes ─────
/**
 * คืน { title, posterImg, episodes: [{url, epNum}] }
 * - gg-animes หน้า anime list มี episode URLs อยู่ในรูป /watch/{epNum}-{viewCount}/
 *   (จะ list ตรงในหน้า — extract ผ่าน regex)
 * - 1 URL หน้า anime = 1 track (sub/dub แยก URL คนละ slug)
 */
async function parseAnimePage(url) {
  console.log(`\n📄 กำลัง fetch หน้า anime: ${url}`);
  const html = await fetchHtml(url);
  const $    = cheerio.load(html);

  const title = ($('h1.ez-h1, h1').first().text()
    || $('meta[property="og:title"]').attr('content')
    || '').trim();
  const posterImg = ($('meta[property="og:image"]').attr('content')
    || $('.ez-cover img, .single-cover img').first().attr('src')
    || '').trim();

  // Find all /watch/{N}-{view}/ URLs
  const watchRe = /https?:\/\/(?:www\.)?gg-animes\.com\/watch\/(\d+)(?:-\d+)?\/?/gi;
  const seen = new Set();
  const episodes = [];
  let m;
  while ((m = watchRe.exec(html))) {
    const epUrl = m[0];
    const epNum = parseInt(m[1]);
    if (!Number.isFinite(epNum)) continue;
    if (seen.has(epUrl)) continue;
    seen.add(epUrl);
    episodes.push({ url: epUrl, epNum });
  }
  episodes.sort((a, b) => a.epNum - b.epNum);

  if (!episodes.length) throw new Error('ไม่พบ /watch/ URL ในหน้านี้ — ตรวจสอบ URL อีกครั้ง');
  console.log(`✅ พบ: "${title}" — ${episodes.length} ตอน`);
  return { title, posterImg, episodes };
}

// ───── Source-specific: Episode page → iframe → stream URL ─────
/** parse iframe URL จาก ep page */
async function getIframeUrl(epPageUrl) {
  const html = await fetchHtml(epPageUrl);
  const m = html.match(/<iframe[^>]+(?:src|data-src)="([^"]+gg-player[^"]+)"/i)
    || html.match(/<iframe[^>]+(?:src|data-src)="(https?:\/\/[^"]+\/video\/[^"]+)"/i);
  if (!m) throw new Error(`ไม่พบ iframe gg-player ใน ${epPageUrl}`);
  return m[1];
}

/**
 * Fetch iframe page → parse MASPlayer config → คืน raw stream URL (ยังไม่ wrap proxy)
 *
 * Player JS สร้าง file URL จาก:
 *   "https://" + location.hostname + videoUrl + "?s=" + videoServer + "&d=" + btoa(videoDisk||", ")
 * เพราะ iframe โฮสต์อยู่บน gg-player.xyz → location.hostname = "gg-player.xyz"
 */
/** ตัด JSON object ตั้งแต่ตำแหน่ง `start` โดยนับ {} ให้สมดุล (รองรับ nested) */
function extractJsonObject(html, start) {
  if (html[start] !== '{') return null;
  let depth = 0, inStr = false, escape = false;
  for (let i = start; i < html.length; i++) {
    const c = html[i];
    if (escape) { escape = false; continue; }
    if (inStr) {
      if (c === '\\') escape = true;
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"')      inStr = true;
    else if (c === '{') depth++;
    else if (c === '}') {
      depth--;
      if (depth === 0) return html.substring(start, i + 1);
    }
  }
  return null;
}

async function getRawStreamUrl(iframeUrl) {
  const html = await fetchHtml(iframeUrl, { Referer: 'https://gg-animes.com/' });
  // หา "MASPlayer(vhash, {...})" แล้ว extract object ที่ balanced braces
  const callMatch = html.match(/MASPlayer\s*\([^,]+,\s*/);
  if (!callMatch) throw new Error(`ไม่พบ MASPlayer call ใน ${iframeUrl}`);
  const objStart = callMatch.index + callMatch[0].length;
  const jsonStr = extractJsonObject(html, objStart);
  if (!jsonStr) throw new Error(`ไม่สามารถ extract MASPlayer config object ใน ${iframeUrl}`);

  let cfg;
  try {
    cfg = JSON.parse(jsonStr);
  } catch (e) {
    throw new Error(`MASPlayer JSON parse error: ${e.message}`);
  }

  const videoUrl    = cfg.videoUrl;
  const videoServer = cfg.videoServer;
  const videoDisk   = cfg.videoDisk;
  if (!videoUrl)    throw new Error('ไม่พบ videoUrl ใน MASPlayer config');
  if (!videoServer) throw new Error('ไม่พบ videoServer ใน MASPlayer config');

  // btoa(videoDisk || ", ")
  const dParam = Buffer.from(videoDisk ? String(videoDisk) : ', ', 'utf-8').toString('base64');
  return `https://${PLAYER_HOST}${videoUrl}?s=${videoServer}&d=${dParam}`;
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
    let rawTitle = '', rawPoster = '';
    let episodes = [];

    for (let ui = 0; ui < urls.length; ui++) {
      if (isMultiUrl) console.log(`\n📡 Fetch part ${ui + 1}/${urls.length}: ${urls[ui]}`);
      const result = await parseAnimePage(urls[ui]);
      if (ui === 0) { rawTitle = result.title; rawPoster = result.posterImg; }

      const offset = episodes.length;
      for (const ep of result.episodes) {
        ep._partOffset = offset;
        episodes.push(ep);
      }
      if (isMultiUrl) console.log(`  ✅ พบ ${result.episodes.length} ตอน (รวม ${episodes.length})`);
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
          console.warn('⚠️  ไม่พบใน TMDB ใช้ข้อมูลจาก gg-animes แทน');
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
          console.warn('⚠️  ไม่พบใน TMDB ใช้ข้อมูลจาก gg-animes แทน');
        }
      }
    }

    console.log(`\n🔗 กำลัง fetch stream URLs (${episodes.length} ตอน)...`);
    const stations = [];

    for (let i = 0; i < episodes.length; i++) {
      const ep = episodes[i];
      const epNum = ep.epNum || (i + 1);
      process.stdout.write(`  ตอน ${epNum}/${episodes.length}...`);

      let streamUrl = null;
      try {
        const iframeUrl = await getIframeUrl(ep.url);
        const rawStream = await getRawStreamUrl(iframeUrl);
        streamUrl       = wrapWithProxy(rawStream);
        const vhashMatch = iframeUrl.match(/\/video\/([a-zA-Z0-9]+)/);
        process.stdout.write(` vhash=${vhashMatch ? vhashMatch[1] : '?'}`);
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

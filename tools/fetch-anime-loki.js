#!/usr/bin/env node
/**
 * fetch-anime-loki.js
 * สร้าง / อัปเดต playlist JSON จาก anime-loki.com พร้อม metadata จาก TMDB
 *
 * ─── Flags ───────────────────────────────────────────────────────────────
 *   <url>              URL หน้า anime บน anime-loki.com
 *                      เช่น https://anime-loki.com/watch-anime-isekai-nonbiri-nouka-ss2-th/
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
 *   - Anime page → list ของ /watch/{slug}/ URLs (1 URL = 1 track)
 *   - Episode page → inline JS "window.displayvideo(0, {video_id})"
 *   - Stream layer: GET https://stream.anislime.com/video/{video_id}/ →
 *     "const video_data = { files: { url: 'https://overlay.miku-box.com/v/{hash}', type:'iframe' } }"
 *   - Extract hash จาก /v/{hash} URL → build raw stream URL:
 *     https://overlay.miku-box.com/file/{hash}/
 *   - Stream + sub-playlist ไม่มี CORS → ต้องผ่าน CF Worker proxy
 *   - ตอนที่มี "(รออัพ)" ใน title จะ fail (ยังไม่มี stream)
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

// anime-loki default track override: th (most content is dubbed)
const cli = parseArgs();
let { seriesUrl, tmdbKey, customOutput, mainSlugArg, idPrefixArg,
      seasonNum, seasonName, updateMeta, updateMetaMode, noTouch,
      forceTmdbId, tmdbSeasonNum, epOffset, partNum, typeArg, filterTrack } = cli;

// Override default: anime-loki defaults to พากย์ไทย if --track= not specified
let trackName = cli.trackName;
let isDubbedTrack = cli.isDubbedTrack;
if (!cli.trackArg) {
  trackName = 'พากย์ไทย';
  isDubbedTrack = true;
}
const epOffsetArg = cli.get('--ep-offset');

if (!seriesUrl && !updateMeta) {
  console.error('Usage: node fetch-anime-loki.js <url> [--track=th|subth] [--season=N] [--output=FILE]');
  console.error('       node fetch-anime-loki.js --update-meta[=poster|cover|title] [--season=N] --output=FILE.txt');
  process.exit(1);
}

const { isMovie, playlistDir: PLAYLIST_DIR, indexPath: INDEX_PATH, githubRawBase: GITHUB_RAW_BASE } =
  makePaths({ typeArg, scriptDir: __dirname });

const SITE_BASE       = 'https://anime-loki.com';
const STREAM_BASE     = 'https://stream.anislime.com';   // ชั้นกลาง (มี video_data)
const STREAM_HOST     = 'overlay.miku-box.com';          // ชั้น stream จริง
const STREAM_REFERER  = 'https://overlay.miku-box.com/';
const CF_PROXY        = 'https://shy-haze-2452.natajrak-p.workers.dev/';
const REFERER         = 'https://anime-loki.com/';

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
 * คืน { title, posterImg, episodes: [{url, epNum, label, isPending}] }
 * - anime-loki หน้า list มี <a href="/watch/{slug}/"> + <p>ชื่อ ตอนที่ NN พากย์ไทย</p>
 *   (บาง episode มี '(รออัพ)' = ยังไม่มี stream)
 * - 1 URL หน้า anime = 1 track (sub/dub แยก URL)
 */
async function parseAnimePage(url) {
  console.log(`\n📄 กำลัง fetch หน้า anime: ${url}`);
  const html = await fetchHtml(url);
  const $    = cheerio.load(html);

  const title = ($('h1.movie-title').first().text()
    || $('h1').first().text()
    || $('meta[property="og:title"]').attr('content')
    || '').trim();
  const posterImg = ($('meta[property="og:image"]').attr('content')
    || $('.movie-poster img, .single-cover img').first().attr('src')
    || '').trim();

  const seen = new Set();
  const episodes = [];

  $('a[href*="/watch/"]').each((_, el) => {
    const $el = $(el);
    const epUrl = ($el.attr('href') || '').trim();
    if (!epUrl || seen.has(epUrl)) return;
    seen.add(epUrl);

    const text = ($el.find('p').first().text() || $el.text() || '').trim();

    // เรื่องแบบ multi-part (พาร์ท 1, พาร์ท 2) จะมี "ตอนที่ NN (XX)" ที่ XX = absolute ep
    //   เช่น "พาร์ท 2 ตอนที่ 01 (14) ซับไทย" → absolute ep 14
    // เรื่องปกติ มีแค่ "ตอนที่ NN" → ใช้ NN เป็น ep number
    // ใช้ absolute ก่อนถ้ามี — จะ unique กันได้แม้ละหลายพาร์ทในหน้าเดียว
    //
    // เรื่องแบบ multi-season ที่ anime-loki รวมหลาย season ใน 1 URL จะมี "ภาค X ตอนที่ NN"
    //   เช่น "ภาค 2 ตอนที่ 01 พากย์ไทย" → partNum=2, epNum=1
    // ใช้ --part=N filter เฉพาะ ภาค ที่ต้องการ
    const partMatch = text.match(/ภาค\s*(\d+)/);
    const absMatch = text.match(/\((\d+)\)/);
    const seqMatch = text.match(/ตอนที่\s*(\d+)/);
    if (!absMatch && !seqMatch) return;
    const epNum = parseInt((absMatch || seqMatch)[1]);
    if (!Number.isFinite(epNum)) return;
    const partNum = partMatch ? parseInt(partMatch[1]) : null;

    const isPending = /รออัพ/.test(text);
    episodes.push({ url: epUrl, epNum, partNum, label: text, isPending });
  });

  // sort by (partNum, epNum) — ภาค 1 ก่อน ภาค 2, แต่ละ ภาค เรียงตอน
  episodes.sort((a, b) => (a.partNum ?? 0) - (b.partNum ?? 0) || a.epNum - b.epNum);

  if (!episodes.length) throw new Error('ไม่พบ /watch/{slug}/ link ในหน้านี้ — ตรวจสอบ URL อีกครั้ง');
  const pending = episodes.filter((e) => e.isPending).length;
  console.log(`✅ พบ: "${title}" — ${episodes.length} ตอน${pending ? ` (${pending} รออัพ)` : ''}`);
  return { title, posterImg, episodes };
}

// ───── Source-specific: Episode page → video_id → stream URL ─────
/** Episode page → window.displayvideo(0, video_id) → คืน video_id (string) */
async function getVideoId(epPageUrl) {
  const html = await fetchHtml(epPageUrl);
  const m = html.match(/window\.displayvideo\s*\(\s*\d+\s*,\s*(\d+)\s*\)/);
  if (!m) throw new Error(`ไม่พบ window.displayvideo(...) ใน ${epPageUrl}`);
  return m[1];
}

/**
 * stream.anislime.com/video/{video_id}/ → video_data.files.url ('miku-box.com/v/{hash}')
 * → extract hash → คืน raw m3u8 URL: overlay.miku-box.com/file/{hash}/
 */
async function getRawStreamUrl(videoId, refererEpUrl) {
  const innerIframeUrl = `${STREAM_BASE}/video/${videoId}/`;
  const html = await fetchHtml(innerIframeUrl, { Referer: refererEpUrl });

  const m = html.match(/['"]url['"]\s*:\s*['"](https?:\/\/[^'"]*miku-box\.com\/v\/[^'"]+)['"]/i);
  if (!m) throw new Error(`ไม่พบ miku-box iframe URL ใน video stream page (id=${videoId})`);
  const playerIframe = m[1];

  const hashMatch = playerIframe.match(/\/v\/([A-Za-z0-9]+)/);
  if (!hashMatch) throw new Error(`extract hash จาก ${playerIframe} ไม่ได้`);
  const hash = hashMatch[1];

  return `https://${STREAM_HOST}/file/${hash}/`;
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

    // --part=N filter: เลือกเฉพาะ episodes ของ ภาค N (สำหรับหน้าที่รวมหลาย season)
    const hasMultiPart = episodes.some(e => e.partNum != null) && new Set(episodes.map(e => e.partNum).filter(p => p != null)).size > 1;
    if (partNum != null) {
      const before = episodes.length;
      episodes = episodes.filter(e => e.partNum === partNum);
      console.log(`🎯 Filter ภาค ${partNum}: ${before} → ${episodes.length} ตอน`);
      if (episodes.length === 0) {
        console.error(`❌ ไม่พบตอนใน ภาค ${partNum} — ตรวจสอบ URL หรือ --part อีกครั้ง`);
        process.exit(1);
      }
    } else if (hasMultiPart) {
      const parts = [...new Set(episodes.map(e => e.partNum).filter(p => p != null))].sort();
      console.warn(`⚠️  หน้านี้รวมหลาย ภาค: ${parts.map(p => `ภาค ${p}`).join(', ')} — จะรวมทุก ภาค ไว้ใน season เดียว`);
      console.warn(`    ใช้ --part=N เพื่อ filter เฉพาะ ภาค ที่ต้องการ`);
    }

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
          console.warn('⚠️  ไม่พบใน TMDB ใช้ข้อมูลจาก anime-loki แทน');
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
          console.warn('⚠️  ไม่พบใน TMDB ใช้ข้อมูลจาก anime-loki แทน');
        }
      }
    }

    console.log(`\n🔗 กำลัง fetch stream URLs (${episodes.length} ตอน)...`);
    const stations = [];

    for (let i = 0; i < episodes.length; i++) {
      const ep = episodes[i];
      const epNum = ep.epNum || (i + 1);
      process.stdout.write(`  ตอน ${epNum}/${episodes.length}...`);

      if (ep.isPending) {
        console.log(' ⏭  (รออัพ — ข้าม)');
        continue;
      }

      let streamUrl = null;
      try {
        const videoId   = await getVideoId(ep.url);
        const rawStream = await getRawStreamUrl(videoId, ep.url);
        streamUrl       = wrapWithProxy(rawStream);
        const hashMatch = rawStream.match(/\/file\/([A-Za-z0-9]+)/);
        process.stdout.write(` video_id=${videoId} hash=${hashMatch ? hashMatch[1] : '?'}`);
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

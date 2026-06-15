#!/usr/bin/env node
/**
 * fetch-fairyanime.js
 * สร้าง / อัปเดต playlist JSON จาก fairyanime.net พร้อม metadata จาก TMDB
 *
 * ─── หมายเหตุ ────────────────────────────────────────────────────────────
 *   - แหล่ง: fairyanime.net
 *   - Stream URL: anime.tonytonychopper.net/file2/{INNER_ID}/ (CORS ผ่าน proxy)
 *   - รองรับทั้ง listing URL และ episode URL
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
let { tmdbKey, customOutput, mainSlugArg, idPrefixArg,
      trackName, isDubbedTrack, seasonNum, seasonName,
      updateMeta, updateMetaMode, noTouch, forceTmdbId, tmdbSeasonNum,
      epOffset, typeArg, filterTrack } = cli;
const firstEpUrl = cli.seriesUrl;
const hlsProxy = (process.env.HLS_PROXY_URL || '').replace(/\/$/, '');
const epOffsetArg = cli.get('--ep-offset');

if (!firstEpUrl && !updateMeta) {
  console.error('Usage: node fetch-fairyanime.js <url> [--track=th|subth] [--season=N] [--output=FILE]');
  console.error('       node fetch-fairyanime.js --update-meta[=poster|cover|title] [--season=N] [--track=th|subth] --output=FILE.txt');
  process.exit(1);
}

const { isMovie, playlistDir: PLAYLIST_DIR, indexPath: INDEX_PATH, githubRawBase: GITHUB_RAW_BASE } =
  makePaths({ typeArg, scriptDir: __dirname });

const FAIRY_BASE = 'https://fairyanime.net';
const MAX_EPISODES = 200;
const STATION_REFERER = 'https://fairyanime.net/';

const HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120 Safari/537.36',
  'Accept-Language': 'th-TH,th;q=0.9,en;q=0.8',
  'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
};

// ───── Source-specific helpers ─────
async function fetchText(url, extraHeaders = {}) {
  const res = await fetch(url, { headers: { ...HEADERS, ...extraHeaders } });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  return res.text();
}

function extractPageId(url) {
  const m = url.match(/\/watch\/([^/.]+)/);
  return m ? m[1] : null;
}

function cleanSiteTitle(rawTitle) {
  return rawTitle
    .replace(/\s*-\s*FairyAnime[^-]*$/i, '')
    .replace(/\s*ตอนที่\s*\d+.*$/, '')
    .trim();
}

function extractEpNum(rawTitle) {
  const m = rawTitle.match(/ตอนที่\s*(\d+)/);
  return m ? parseInt(m[1]) : null;
}

async function fetchEpisodePage(url) {
  const html = await fetchText(url, { Referer: FAIRY_BASE + '/' });
  const $ = cheerio.load(html);

  const pageId = extractPageId(url);
  const rawTitle = $('title').first().text().trim();

  let nextUrl = null;
  $('a[href*="/watch/"]').each((_, el) => {
    const text = $(el).text();
    if (/ถัดไป|next/i.test(text)) {
      const href = $(el).attr('href');
      if (href) nextUrl = href.startsWith('http') ? href : `${FAIRY_BASE}${href}`;
    }
  });

  const posterImg =
    $('meta[property="og:image"]').attr('content') ||
    $('meta[name="og:image"]').attr('content') ||
    $('.poster img, .thumb img').first().attr('src') ||
    '';

  return { pageId, rawTitle, nextUrl, posterImg };
}

async function fetchPlaybackId(pageId) {
  const url = `${FAIRY_BASE}/base/${pageId}/`;
  const js = await fetchText(url, { Referer: FAIRY_BASE + '/' });
  const m = js.match(/playback\/[fv]\/([A-Za-z0-9_-]+)/);
  if (!m) throw new Error(`ไม่พบ PLAYBACK_ID จาก base endpoint (pageId=${pageId})`);
  return m[1];
}

async function fetchInnerId(playbackId, pageId) {
  const url = `https://streaming.tonytonychopper.com/playback/v/${playbackId}/`;
  const referer = `${FAIRY_BASE}/watch/${pageId}.html`;
  const html = await fetchText(url, { Referer: referer });
  const m = html.match(/anime\.tonytonychopper\.net\/v2\/([A-Za-z0-9_-]+)/);
  if (!m) throw new Error(`ไม่พบ INNER_ID จาก streaming page (playbackId=${playbackId})`);
  return m[1];
}

async function getStreamInfo(epUrl) {
  const pageId = extractPageId(epUrl);
  if (!pageId) throw new Error(`ไม่สามารถ extract PAGE_ID จาก ${epUrl}`);
  const playbackId = await fetchPlaybackId(pageId);
  const innerId = await fetchInnerId(playbackId, pageId);
  return {
    streamUrl: `https://anime.tonytonychopper.net/file2/${innerId}/`,
    streamReferer: `https://anime.tonytonychopper.net/v2/${innerId}`,
  };
}

async function parseListingPage(listingUrl) {
  console.log(`\n📄 ตรวจพบหน้า listing: ${listingUrl}`);
  const html = await fetchText(listingUrl, { Referer: FAIRY_BASE + '/' });
  const $ = cheerio.load(html);

  const rawTitle = $('title').first().text().trim();
  const seriesTitle = cleanSiteTitle(rawTitle);
  const posterImg =
    $('meta[property="og:image"]').attr('content') ||
    $('meta[name="og:image"]').attr('content') ||
    $('.poster img, .thumb img').first().attr('src') ||
    '';

  const epLinks = [];
  $('a[href*="/watch/"]').each((_, el) => {
    const href = $(el).attr('href');
    if (!href) return;
    const fullUrl = href.startsWith('http') ? href : `${FAIRY_BASE}${href}`;
    const text = $(el).text().trim();
    if (/ถัดไป|next|ก่อนหน้า|prev/i.test(text)) return;
    if (!epLinks.find((e) => e.url === fullUrl)) {
      const epNum = extractEpNum(text);
      epLinks.push({ url: fullUrl, rawTitle: text, epNum });
    }
  });

  epLinks.forEach((ep, i) => {
    if (!ep.epNum) ep.epNum = i + 1;
    ep.pageId = extractPageId(ep.url) || '';
  });
  epLinks.sort((a, b) => a.epNum - b.epNum);

  console.log(`✅ Series: "${seriesTitle}"`);
  console.log(`✅ พบ ${epLinks.length} ตอนจากหน้า listing`);
  epLinks.forEach((ep) => console.log(`  ตอนที่ ${ep.epNum} — ${ep.url}`));
  return { episodes: epLinks, seriesTitle, posterImg };
}

async function crawlEpisodes(startUrl) {
  if (!startUrl.includes('/watch/')) return parseListingPage(startUrl);

  console.log(`\n📄 เริ่ม crawl จาก: ${startUrl}`);
  const episodes = [];
  let currentUrl = startUrl;
  let isFirst = true;
  let seriesTitle = '';
  let posterImg = '';

  while (currentUrl && episodes.length < MAX_EPISODES) {
    const epNum = episodes.length + 1;
    process.stdout.write(`  ตอน ${epNum} — ${currentUrl} ...`);

    let pageData;
    try { pageData = await fetchEpisodePage(currentUrl); }
    catch (err) { console.warn(` ⚠️  fetch หน้าล้มเหลว: ${err.message}`); break; }

    const { pageId, rawTitle, nextUrl, posterImg: epPoster } = pageData;
    if (isFirst) {
      seriesTitle = cleanSiteTitle(rawTitle);
      posterImg = epPoster;
      isFirst = false;
      console.log(`\n✅ Series: "${seriesTitle}"`);
      process.stdout.write(`  ตอน ${epNum} — ${currentUrl} ...`);
    }

    const epNumFromTitle = extractEpNum(rawTitle) ?? epNum;
    episodes.push({ url: currentUrl, pageId: pageId || '', rawTitle, epNum: epNumFromTitle });
    process.stdout.write(` ✅ (ตอนที่ ${epNumFromTitle})\n`);

    if (!nextUrl || nextUrl === currentUrl) break;
    currentUrl = nextUrl;
    await utils.sleep(500);
  }

  if (episodes.length >= MAX_EPISODES) console.warn(`⚠️  หยุดที่ ${MAX_EPISODES} ตอน (ถึงขีดจำกัด)`);
  console.log(`✅ รวม ${episodes.length} ตอน`);
  return { episodes, seriesTitle, posterImg };
}

// ───── Main ─────
async function main() {
  if (updateMeta) {
    await runUpdateMeta({
      playlistDir: PLAYLIST_DIR, indexPath: INDEX_PATH, githubRawBase: GITHUB_RAW_BASE,
      isMovie, tmdbKey, customOutput, seasonName, filterTrack,
      updateMetaMode, forceTmdbId, noTouch,
    });
    return;
  }

  try {
    const urls = firstEpUrl.split(',').map((u) => u.trim()).filter(Boolean);
    const isMultiUrl = urls.length > 1;
    let rawSeriesTitle = '', rawPoster = '';
    let episodes = [];

    for (let ui = 0; ui < urls.length; ui++) {
      if (isMultiUrl) console.log(`\n📡 Fetch part ${ui + 1}/${urls.length}: ${urls[ui]}`);
      const result = await crawlEpisodes(urls[ui]);
      if (ui === 0) { rawSeriesTitle = result.seriesTitle; rawPoster = result.posterImg; }

      const offset = episodes.length;
      for (const ep of result.episodes) {
        if (offset > 0) ep.epNum = ep.epNum + offset;
        episodes.push(ep);
      }
      if (isMultiUrl) console.log(`  ✅ พบ ${result.episodes.length} ตอน (รวม ${episodes.length})`);
    }

    if (isMultiUrl && !epOffsetArg) epOffset = 0;
    if (episodes.length === 0) {
      console.error('❌ ไม่พบ episode ใดเลย ตรวจสอบ URL อีกครั้ง');
      process.exit(1);
    }

    let seriesTitle = rawSeriesTitle;
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
          tmdbResult = await tmdb.searchTmdbMovie(rawSeriesTitle, tmdbKey);
        }
        if (tmdbResult) {
          const tmdbEnName = tmdbResult.title || rawSeriesTitle;
          const tmdbThName = await tmdb.getTmdbMovieNameTh(tmdbResult.id, tmdbKey);
          const tmdbName = utils.formatSeriesTitle(tmdbEnName, tmdbThName);
          const tmdbPoster = tmdbResult.poster_path ? `${tmdb.TMDB_IMG}${tmdbResult.poster_path}` : rawPoster;
          console.log(`✅ พบใน TMDB: "${tmdbName}" (ID: ${tmdbResult.id})`);
          tmdbShow = tmdbResult; seriesTitle = tmdbName; posterUrl = tmdbPoster;
        } else { console.warn('⚠️  ไม่พบใน TMDB ใช้ข้อมูลจาก fairyanime แทน'); }
      } else {
        if (forceTmdbId) {
          console.log(`\n🎬 ใช้ TMDB ID ที่ระบุ: ${forceTmdbId}`);
          tmdbResult = await tmdb.getTmdbShow(forceTmdbId, tmdbKey, 'en-US');
        } else {
          console.log('\n🎬 กำลัง search TMDB...');
          tmdbResult = await tmdb.searchTmdbTv(rawSeriesTitle, tmdbKey);
        }
        if (tmdbResult) {
          const tmdbEnName = tmdbResult.name || rawSeriesTitle;
          const tmdbThName = await tmdb.getTmdbShowNameTh(tmdbResult.id, tmdbKey);
          const tmdbName = utils.formatSeriesTitle(tmdbEnName, tmdbThName);
          const tmdbPoster = tmdbResult.poster_path ? `${tmdb.TMDB_IMG}${tmdbResult.poster_path}` : rawPoster;
          console.log(`✅ พบใน TMDB: "${tmdbName}" (ID: ${tmdbResult.id})`);
          tmdbShow = tmdbResult; seriesTitle = tmdbName; posterUrl = tmdbPoster; seasonPosterUrl = tmdbPoster;

          const lookupSeason = tmdbSeasonNum || seasonNum || 1;
          if (tmdbSeasonNum && tmdbSeasonNum !== (seasonNum || 1)) {
            console.log(`📌 TMDB Season override: playlist Season ${seasonNum || 1} → TMDB Season ${tmdbSeasonNum}`);
          }
          if (epOffset > 0) console.log(`📌 Episode offset: +${epOffset} (source ep 1 → TMDB ep ${epOffset + 1})`);

          const biData = await tmdb.getTmdbSeasonBilingual(tmdbResult.id, tmdbKey, lookupSeason);
          tmdbEpisodes = isDubbedTrack ? biData.thEpisodes : biData.enEpisodes;
          if (biData.poster) seasonPosterUrl = biData.poster;
          tmdbSeasonName = biData.seasonName;
          seasonAirDate = biData.air_date || '';
          console.log(`✅ ดึงข้อมูล ${tmdbEpisodes.length} ตอน (Season ${lookupSeason}, ${isDubbedTrack ? 'th-TH w/ EN fallback' : 'en-US'}) จาก TMDB`);
        } else { console.warn('⚠️  ไม่พบใน TMDB ใช้ข้อมูลจาก fairyanime แทน'); }
      }
    } else { console.warn('⚠️  ไม่มี TMDB_API_KEY ข้าม TMDB lookup'); }

    episodes.sort((a, b) => a.epNum - b.epNum);

    console.log(`\n🔗 กำลัง fetch stream URLs (${episodes.length} ตอน)...`);
    const stations = [];

    for (let i = 0; i < episodes.length; i++) {
      const ep = episodes[i];
      const epNum = ep.epNum;
      process.stdout.write(`  ตอน ${epNum}/${episodes.length} (${ep.pageId})...`);

      let streamUrl = null, streamReferer = null;
      try {
        const info = await getStreamInfo(ep.url);
        streamUrl = info.streamUrl; streamReferer = info.streamReferer;
        process.stdout.write(' ✅\n');
      } catch (err) { console.warn(` ⚠️  ${err.message}`); }

      const tmdbEpNum = epNum + epOffset;
      const tmdbEp = tmdbEpisodes.find((e) => e.episode_number === tmdbEpNum) || tmdbEpisodes[epNum - 1 + epOffset];
      const epTitle = tmdbEp?.name || '';
      const epThumb = tmdbEp?.still_path ? `${tmdb.TMDB_IMG}${tmdbEp.still_path}` : '';

      let finalUrl = streamUrl || ep.url;
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
        partCount: mainPlaylist.part_count ?? null,
      });
    } else {
      const playlist = io.buildOrMergePlaylist({
        outputPath, seriesTitle, posterUrl, seasonPosterUrl, stations,
        trackName, trackReferer: firstEpUrl, tmdbSeasonName,
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
    if (process.env.DEBUG) console.error(err.stack);
    process.exit(1);
  }
}

main();

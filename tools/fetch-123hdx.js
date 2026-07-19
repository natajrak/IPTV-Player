#!/usr/bin/env node
/**
 * fetch-123hdx.js
 * สร้าง / อัปเดต playlist JSON จาก 123-hdx.com พร้อม metadata จาก TMDB
 * Stream ผ่าน WordPress Halim theme → /api/get.php → main.123hd-serie.com
 *
 * โครงสร้างคล้าย 123-hds แต่ต่างกันตรง:
 *   - 123-hdx อยู่หลัง Cloudflare WAF → ต้องใช้ cookies (cf_clearance) จาก .env
 *   - Nonce แต่ละ ep ไม่ซ้ำกัน (ต้อง fetch ep page + extract nonce เอง)
 *   - post_id ต่อ ep (ไม่ share ทั้ง series)
 *   - Stream host: main.123hd-serie.com/m3u8/{HASH}/{HASH}438.m3u8 (1080p direct)
 *
 * ─── Setup ──────────────────────────────────────────────────────────────
 *   ตั้ง HDX_COOKIES ใน tools/.env — เอาจาก DevTools → Network → get.php → Copy as cURL
 *   Cookie ที่สำคัญคือ cf_clearance (อายุ ~30 นาที ต้อง refresh เป็นระยะ)
 *
 * ─── Flags ───────────────────────────────────────────────────────────────
 *   <url>              URL หน้า 123-hdx.com (comma-separated รองรับ)
 *   --track=th|subth   default: subth
 *   --season=N         default: 1
 *   --output=FILE      ชื่อไฟล์ผลลัพธ์ใน playlist/series/
 *   --tmdb-id=N        ระบุ TMDB TV ID ตรงๆ
 *   --update-meta[=poster|cover|title]
 *   --type=KIND        default: series
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
      updateMeta, updateMetaMode, noTouch,
      forceTmdbId, typeArg, filterTrack } = cli;
const epOffsetArg = cli.get('--ep-offset');
let epOffset = cli.epOffset || 0;
const HDX_COOKIES = (process.env.HDX_COOKIES || '').trim();

if (!seriesUrl && !updateMeta) {
  console.error('Usage: node fetch-123hdx.js <url>[,url2,...] [--track=th|subth] [--season=N] [--output=FILE]');
  console.error('       node fetch-123hdx.js --update-meta[=poster|cover|title] --output=FILE.txt');
  process.exit(1);
}
if (!updateMeta && !HDX_COOKIES) {
  console.error('❌ ต้องตั้งค่า HDX_COOKIES ใน tools/.env');
  console.error('   วิธีดึง cookies:');
  console.error('   1. เปิด https://www.123-hdx.com/{slug}-ep-2 ใน Chrome (รอ CF challenge ผ่าน)');
  console.error('   2. F12 > Network > กด Play video > หา request "get.php"');
  console.error('   3. Right-click > Copy > Copy as cURL (bash) → extract ค่า -b "..." มาใส่');
  console.error('   4. HDX_COOKIES=cf_clearance=xxx; PHPSESSID=yyy; ...');
  process.exit(1);
}

const SITE_ORIGIN = 'https://www.123-hdx.com';
const API_URL = `${SITE_ORIGIN}/api/get.php`;
const STREAM_HOST = 'main.123hd-serie.com';
const CF_PROXY = 'https://shy-haze-2452.natajrak-p.workers.dev/';

function buildStreamUrl(hash) {
  // 438 = 1080p variant (verified). Master {HASH}.m3u8 อาจ return 500 นอก browser context
  return `https://${STREAM_HOST}/m3u8/${hash}/${hash}438.m3u8`;
}
function proxyUrl(streamUrl, referer) {
  return `${CF_PROXY}?url=${encodeURIComponent(streamUrl)}&referer=${encodeURIComponent(referer)}`;
}

const BASE_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/150.0.0.0 Safari/537.36',
  'Accept-Language': 'th-TH,th;q=0.9,en;q=0.8',
  'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  'sec-ch-ua': '"Chromium";v="150", "Google Chrome";v="150"',
  'sec-ch-ua-mobile': '?0',
  'sec-ch-ua-platform': '"macOS"',
};

// ───── Source-specific HTTP helpers ─────
async function fetchPage(url) {
  const res = await fetch(url, {
    headers: { ...BASE_HEADERS, Referer: SITE_ORIGIN + '/', Cookie: HDX_COOKIES },
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  const html = await res.text();
  if (/Attention Required.*Cloudflare/i.test(html.substring(0, 2000))) {
    throw new Error('CF WAF ปิดกั้น — cookies (cf_clearance) หมดอายุ ต้อง refresh HDX_COOKIES ใน .env');
  }
  return html;
}

async function postApi(postId, nonce, episode = 0, server = 1, referer = SITE_ORIGIN) {
  const body = new URLSearchParams({
    action: 'halim_ajax_player',
    nonce, episode: String(episode), server: String(server), postid: String(postId),
  }).toString();

  const res = await fetch(API_URL, {
    method: 'POST',
    headers: {
      ...BASE_HEADERS,
      'Accept': '*/*',
      'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
      'Referer': referer,
      'Origin': SITE_ORIGIN,
      'X-Requested-With': 'XMLHttpRequest',
      'Cookie': HDX_COOKIES,
    },
    body,
  });
  if (!res.ok) throw new Error(`/api/get.php returned ${res.status}`);
  const text = await res.text();
  if (/Attention Required.*Cloudflare/i.test(text.substring(0, 2000))) {
    throw new Error('CF WAF ปิดกั้น AJAX — cookies หมดอายุ');
  }
  return text;
}

function extractHalimData(html) {
  // halim_cfg JSON บางครั้ง JSON.parse ล้มเหลว (เจอ escape ยากๆ) → extract field ที่ต้องใช้ตรงๆ
  const postIdMatch = html.match(/["']post_id["']\s*:\s*(\d+)/);
  const episodeMatch = html.match(/["']episode["']\s*:\s*(\d+)/);
  const serverMatch = html.match(/["']server["']\s*:\s*(\d+)/);
  const titleMatch = html.match(/["']post_title["']\s*:\s*["']([^"']+)["']/);
  // ajax_player.nonce (สำคัญกว่า data-nonce page-level)
  const nonceMatch = html.match(/var\s+ajax_player\s*=\s*\{[^\n]*?["']nonce["']\s*:\s*["']([^"']+)["']/)
    || html.match(/["']nonce["']\s*:\s*["']([a-f0-9]{8,})["']/);
  // Detect available tracks — halim-list-server แต่ละ movieidN = 1 track
  //   movieid1 = server 1 (พากย์ไทย), movieid2 = server 2 (ซับไทย)
  const availableServers = new Set();
  for (const m of html.matchAll(/movieid(\d+)/g)) availableServers.add(parseInt(m[1], 10));
  return {
    postId: postIdMatch ? parseInt(postIdMatch[1], 10) : null,
    server: serverMatch ? parseInt(serverMatch[1], 10) : 1,
    episode: episodeMatch ? parseInt(episodeMatch[1], 10) : 0,
    nonce: nonceMatch ? nonceMatch[1] : '',
    title: titleMatch ? titleMatch[1] : '',
    availableServers: [...availableServers].sort(),
  };
}

// Map track flag → server number (halim-list-server_n classes)
//   --track=th    → server 1 (พากย์ไทย)  (movieid1)
//   --track=subth → server 2 (ซับไทย)   (movieid2)
function serverForTrack(trackArg) {
  return trackArg === 'subth' ? 2 : 1;
}

async function getStreamHash(postId, nonce, episode, server, referer) {
  const html = await postApi(postId, nonce, episode, server, referer);
  const m = html.match(/[?&]id=([a-f0-9]{20,})/);
  if (!m) throw new Error(`ไม่พบ hash ใน response: ${html.substring(0, 200)}`);
  return m[1];
}

async function parsePage(url) {
  console.log(`\n📄 กำลัง fetch หน้า: ${url}`);
  const html = await fetchPage(url);
  const $ = cheerio.load(html);
  const halim = extractHalimData(html);

  let rawTitle = halim.title;
  if (!rawTitle) {
    rawTitle = $('title').text()
      .replace(/\s*ดูซีรี่ย์ฟรี.*$/i, '')
      .replace(/\s*ดูหนังฟรี.*$/i, '')
      .replace(/\s*\|.*$/, '')
      .trim();
  }

  const slugBase = url.replace(/\/$/, '').split('/').pop();
  const seen = new Set([url]);
  const epMap = new Map([[1, url]]); // ep 1 = base URL

  $(`a[href*="${slugBase}-ep-"]`).each((_, el) => {
    const href = $(el).attr('href');
    if (!href || seen.has(href)) return;
    const m = href.match(new RegExp(`${slugBase}-ep-(\\d+)(?:\\/)?$`));
    if (m) {
      const epNum = parseInt(m[1], 10);
      if (!epMap.has(epNum)) { epMap.set(epNum, href); seen.add(href); }
    }
  });

  const isMoviePage = epMap.size === 1 && !$(`a[href*="${slugBase}-ep-"]`).length;
  const sortedEps = new Map([...epMap.entries()].sort((a, b) => a[0] - b[0]));

  console.log(`✅ "${rawTitle}" — ${isMoviePage ? 'Movie' : `Series (${sortedEps.size} ตอน)`}`);
  return { rawTitle, halim, isMoviePage, epMap: sortedEps };
}

// ต่างจาก 123-hds: แต่ละ ep ต้องดึง nonce + postId ของตัวเอง (nonce ต่างกัน per ep)
async function getEpParams(url) {
  const html = await fetchPage(url);
  return extractHalimData(html);
}

// ───── Main ─────
async function main() {
  if (updateMeta) {
    const paths = makePaths({ typeArg, scriptDir: __dirname, defaultType: 'series' });
    await runUpdateMeta({
      playlistDir: paths.playlistDir, indexPath: paths.indexPath, githubRawBase: paths.githubRawBase,
      isMovie: paths.isMovie, tmdbKey, customOutput, seasonName, filterTrack,
      updateMetaMode, forceTmdbId, noTouch,
    });
    return;
  }

  try {
    // Multi-URL support
    const urls = seriesUrl.split(',').map(u => u.trim()).filter(Boolean);
    const isMultiUrl = urls.length > 1;

    let rawTitle = '';
    let firstHalim = null;
    let isMoviePage = false;
    let mergedEps = new Map();

    for (let ui = 0; ui < urls.length; ui++) {
      if (isMultiUrl) console.log(`\n📡 Fetch part ${ui + 1}/${urls.length}: ${urls[ui]}`);
      const result = await parsePage(urls[ui]);
      if (ui === 0) {
        rawTitle = result.rawTitle;
        firstHalim = result.halim;
        isMoviePage = result.isMoviePage;
      }
      const offset = mergedEps.size;
      for (const [epNum, epUrl] of result.epMap) {
        const finalEpNum = offset > 0 ? offset + epNum : epNum;
        if (!mergedEps.has(finalEpNum)) mergedEps.set(finalEpNum, epUrl);
      }
      if (isMultiUrl) console.log(`  ✅ พบ ${result.epMap.size} ตอน (รวม ${mergedEps.size})`);
    }
    if (isMultiUrl && !epOffsetArg) epOffset = 0;

    // Resolve server number จาก --track flag (override halim_cfg default)
    const trackServer = serverForTrack(cli.trackArg);
    if (firstHalim && firstHalim.availableServers.length > 0 && !firstHalim.availableServers.includes(trackServer)) {
      const trackLabel = trackServer === 2 ? 'ซับไทย' : 'พากย์ไทย';
      console.warn(`⚠️  หน้านี้ไม่มี track "${trackLabel}" (server=${trackServer}) — มีแค่: ${firstHalim.availableServers.join(', ')}`);
    }
    console.log(`📌 track: ${trackName} → server=${trackServer}`);

    const detectedType = isMoviePage ? 'movie' : 'series';
    const effectiveTypeArg = typeArg || detectedType;
    const { isMovie: isMovieContent, playlistDir: PLAYLIST_DIR, indexPath: INDEX_PATH, githubRawBase: GITHUB_RAW_BASE } =
      makePaths({ typeArg: effectiveTypeArg, scriptDir: __dirname, defaultType: detectedType });
    console.log(`📂 ประเภท: ${effectiveTypeArg}`);

    // TMDB lookup
    let seriesTitle = rawTitle;
    let posterUrl = '';
    let seasonPosterUrl = '';
    let tmdbEpisodes = [];
    let tmdbSeasonName = null;
    let tmdbShow = null;
    let seasonAirDate = '';

    if (tmdbKey) {
      if (isMovieContent) {
        let tmdbResult;
        if (forceTmdbId) {
          console.log(`\n🎬 ใช้ TMDB ID ที่ระบุ: ${forceTmdbId}`);
          tmdbResult = await tmdb.getTmdbMovieDetail(forceTmdbId, tmdbKey, 'en-US');
        } else {
          console.log('\n🎬 กำลัง search TMDB (movie)...');
          tmdbResult = await tmdb.searchTmdbMovie(rawTitle, tmdbKey);
        }
        if (tmdbResult) {
          const enName = tmdbResult.title || rawTitle;
          const thName = await tmdb.getTmdbMovieNameTh(tmdbResult.id, tmdbKey);
          seriesTitle = utils.formatSeriesTitle(enName, thName);
          posterUrl = tmdbResult.poster_path ? `${tmdb.TMDB_IMG}${tmdbResult.poster_path}` : '';
          seasonPosterUrl = posterUrl;
          tmdbShow = tmdbResult;
          console.log(`✅ พบใน TMDB: "${seriesTitle}" (ID: ${tmdbResult.id})`);
        } else {
          console.warn('⚠️  ไม่พบใน TMDB ใช้ชื่อจากหน้าแทน');
        }
      } else {
        let tmdbResult;
        if (forceTmdbId) {
          console.log(`\n🎬 ใช้ TMDB ID ที่ระบุ: ${forceTmdbId}`);
          tmdbResult = await tmdb.getTmdbShow(forceTmdbId, tmdbKey, 'en-US');
        } else {
          console.log('\n🎬 กำลัง search TMDB...');
          tmdbResult = await tmdb.searchTmdbTv(rawTitle, tmdbKey);
        }
        if (tmdbResult) {
          const enName = tmdbResult.name || rawTitle;
          const thName = await tmdb.getTmdbShowNameTh(tmdbResult.id, tmdbKey);
          seriesTitle = utils.formatSeriesTitle(enName, thName);
          posterUrl = tmdbResult.poster_path ? `${tmdb.TMDB_IMG}${tmdbResult.poster_path}` : '';
          seasonPosterUrl = posterUrl;
          tmdbShow = tmdbResult;

          const sNum = seasonNum || 1;
          const biData = await tmdb.getTmdbSeasonBilingual(tmdbResult.id, tmdbKey, sNum);
          tmdbEpisodes = isDubbedTrack ? biData.thEpisodes : biData.enEpisodes;
          if (biData.poster) seasonPosterUrl = biData.poster;
          tmdbSeasonName = biData.seasonName;
          seasonAirDate = biData.air_date || '';
          console.log(`✅ พบใน TMDB: "${seriesTitle}" (ID: ${tmdbResult.id}) — ${tmdbEpisodes.length} ตอน`);
        } else {
          console.warn('⚠️  ไม่พบใน TMDB ใช้ชื่อจากหน้าแทน');
        }
      }
    }

    const slug = customOutput || utils.slugify(seriesTitle.replace(/\[.*?\]/g, '').replace(/\(.*?\)/g, '').trim());
    const slugFile = slug.endsWith('.txt') ? slug : `${slug}.txt`;
    const resolvedId = idPrefixArg || String(tmdbShow?.id || '');
    const outputFile = resolvedId ? `${resolvedId}-${slugFile}` : slugFile;
    const outputPath = path.resolve(PLAYLIST_DIR, outputFile);
    const STREAM_REFERER = `https://${STREAM_HOST}/`;

    if (isMovieContent) {
      console.log('\n🔗 กำลัง fetch stream...');
      if (!firstHalim.postId) throw new Error('ไม่พบ post_id ในหน้า');
      if (!firstHalim.nonce) throw new Error('ไม่พบ nonce ในหน้า');
      const hash = await getStreamHash(firstHalim.postId, firstHalim.nonce, firstHalim.episode, trackServer, urls[0]);
      console.log(`  ✅ hash: ${hash}`);
      const streamUrl = proxyUrl(buildStreamUrl(hash), STREAM_REFERER);
      const partSeason = seasonNum || 1;

      const partPlaylist = io.buildPartFile({
        outputPath, season: partSeason, posterUrl, trackName,
        streamUrl, sourceUrl: urls[0],
      });
      const newStation = partPlaylist.stations.find((s) => s.name === trackName);
      if (newStation) newStation.release_date = tmdbShow?.release_date || '';
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
      const epEntries = [...mergedEps.entries()];
      console.log(`\n🔗 กำลัง fetch streams (${epEntries.length} ตอน)...`);
      const stations = [];

      for (let i = 0; i < epEntries.length; i++) {
        const [epNum, epUrl] = epEntries[i];
        process.stdout.write(`  ตอน ${epNum}/${epEntries.length}...`);

        // ต่างจาก 123-hds: ทุก ep ต้อง fetch page + extract nonce ของตัวเอง
        let epHalim;
        try {
          epHalim = (i === 0 && !isMultiUrl) ? firstHalim : await getEpParams(epUrl);
        } catch (err) {
          process.stdout.write(` ⚠️  fetch page: ${err.message}\n`);
          const tmdbEpFallback = tmdbEpisodes.find((e) => e.episode_number === epNum) || tmdbEpisodes[i];
          stations.push({
            name: utils.buildStationName(epNum, tmdbEpFallback?.name || '', isDubbedTrack),
            url: epUrl, referer: STREAM_REFERER,
            release_date: tmdbEpFallback?.air_date || '',
          });
          if (i < epEntries.length - 1) await utils.sleep(500);
          continue;
        }

        if (!epHalim.postId || !epHalim.nonce) {
          process.stdout.write(` ⚠️  ขาด post_id/nonce\n`);
          const tmdbEpFallback = tmdbEpisodes.find((e) => e.episode_number === epNum) || tmdbEpisodes[i];
          stations.push({
            name: utils.buildStationName(epNum, tmdbEpFallback?.name || '', isDubbedTrack),
            url: epUrl, referer: STREAM_REFERER,
            release_date: tmdbEpFallback?.air_date || '',
          });
          if (i < epEntries.length - 1) await utils.sleep(500);
          continue;
        }

        let streamUrl = null;
        try {
          const hash = await getStreamHash(epHalim.postId, epHalim.nonce, epHalim.episode, trackServer, epUrl);
          streamUrl = proxyUrl(buildStreamUrl(hash), STREAM_REFERER);
          process.stdout.write(` ${hash.substring(0, 8)}… ✅\n`);
        } catch (err) {
          process.stdout.write(` ⚠️  ${err.message}\n`);
        }

        const tmdbEp = tmdbEpisodes.find((e) => e.episode_number === epNum) || tmdbEpisodes[i];
        const epTitle = tmdbEp?.name || '';
        const epThumb = tmdbEp?.still_path ? `${tmdb.TMDB_IMG}${tmdbEp.still_path}` : '';
        stations.push({
          name: utils.buildStationName(epNum, epTitle, isDubbedTrack),
          ...(epThumb && { image: epThumb }),
          url: streamUrl || epUrl,
          referer: STREAM_REFERER,
          release_date: tmdbEp?.air_date || '',
        });

        if (i < epEntries.length - 1) await utils.sleep(600);
      }

      const playlist = io.buildOrMergePlaylist({
        outputPath, seriesTitle, posterUrl, seasonPosterUrl, stations,
        trackName, trackReferer: urls[0], tmdbSeasonName,
        seasonName, seasonNum, epOffset: 0,
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
  } catch (err) {
    console.error(`\n❌ Error: ${err.message}`);
    process.exit(1);
  }
}

main();

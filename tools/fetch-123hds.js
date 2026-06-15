#!/usr/bin/env node
/**
 * fetch-123hds.js
 * สร้าง / อัปเดต playlist JSON จาก 123-hds.com พร้อม metadata จาก TMDB
 * Stream ผ่าน WordPress Halim theme → /api/get.php → 24playerhd.com
 *
 * ─── Flags ───────────────────────────────────────────────────────────────
 *   <url>              URL หน้า 123-hds.com (movie หรือ series)
 *   --track=th|subth   th = พากย์ไทย, subth = ซับไทย (default: subth)
 *   --season=N         ระบุ season (default: 1, สำหรับ series)
 *   --output=FILE      ชื่อไฟล์ผลลัพธ์ใน playlist/ (ไม่ต้องใส่ path)
 *   --tmdb-id=N        ระบุ TMDB ID ตรงๆ
 *   --update-meta[=poster|cover|title]
 *                      อัปเดต metadata จาก TMDB โดยไม่ fetch stream URLs ใหม่
 *   --type=KIND        anime-series|series|anime-movie|movie (default: auto-detect)
 *
 * ─── Stream URL ──────────────────────────────────────────────────────────
 *   https://main.24playerhd.com/newplaylist/{hash}/{hash}.m3u8 (ผ่าน CF Worker)
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
let { seriesUrl: pageUrl, tmdbKey, customOutput, mainSlugArg, idPrefixArg,
      trackName, isDubbedTrack, seasonNum, seasonName,
      updateMeta, updateMetaMode, noTouch,
      forceTmdbId, typeArg, filterTrack } = cli;

if (!pageUrl && !updateMeta) {
  console.error('Usage: node fetch-123hds.js <url> [--track=th|subth] [--season=N] [--output=FILE]');
  console.error('       node fetch-123hds.js --update-meta[=poster|cover|title] --output=FILE.txt');
  process.exit(1);
}

const SITE_ORIGIN = 'https://www.123-hds.com';
const STREAM_REFERER = 'https://main.24playerhd.com/';
const CF_PROXY = 'https://shy-haze-2452.natajrak-p.workers.dev/';

function proxyUrl(streamUrl, referer) {
  return `${CF_PROXY}?url=${encodeURIComponent(streamUrl)}&referer=${encodeURIComponent(referer)}`;
}

const BASE_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'Accept-Language': 'th-TH,th;q=0.9,en;q=0.8',
  'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
};

// ───── Source-specific HTTP helpers ─────
async function fetchPage(url) {
  const res = await fetch(url, { headers: { ...BASE_HEADERS, Referer: SITE_ORIGIN } });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  return res.text();
}

async function postApi(postId, server, episode, nonce) {
  const body = new URLSearchParams({
    action: 'halim_ajax_player',
    nonce,
    episode: String(episode),
    server: String(server),
    postid: String(postId),
  }).toString();

  const res = await fetch(`${SITE_ORIGIN}/api/get.php`, {
    method: 'POST',
    headers: {
      ...BASE_HEADERS,
      'Content-Type': 'application/x-www-form-urlencoded',
      'Referer': SITE_ORIGIN,
      'Origin': SITE_ORIGIN,
    },
    body,
  });
  if (!res.ok) throw new Error(`/api/get.php returned ${res.status}`);
  return res.text();
}

function extractHalimData(html) {
  const cfgMatch = html.match(/var\s+halim_cfg\s*=\s*(\{[^\n]+\})/);
  let cfg = {};
  if (cfgMatch) { try { cfg = JSON.parse(cfgMatch[1]); } catch {} }
  const nonceMatch = html.match(/var\s+ajax_player\s*=\s*\{[^\n]*["']nonce["']\s*:\s*["']([^"']+)["']/)
    || html.match(/ajax_player\.nonce\s*=\s*["']([^"']+)["']/);
  return {
    postId: cfg.post_id ?? null,
    server: cfg.server ?? 2,
    episode: cfg.episode ?? 0,
    nonce: nonceMatch ? nonceMatch[1] : '',
    title: cfg.post_title || '',
  };
}

async function getStreamHash(postId, server, episode, nonce) {
  const html = await postApi(postId, server, episode, nonce);
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
  const epMap = new Map([[1, url]]);

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

async function getEpPostId(url) {
  const html = await fetchPage(url);
  const halim = extractHalimData(html);
  return { postId: halim.postId, server: halim.server, episode: halim.episode };
}

// ───── Main ─────
async function main() {
  if (updateMeta) {
    // Default to series for update-meta
    const paths = makePaths({ typeArg, scriptDir: __dirname, defaultType: 'series' });
    await runUpdateMeta({
      playlistDir: paths.playlistDir, indexPath: paths.indexPath, githubRawBase: paths.githubRawBase,
      isMovie: paths.isMovie, tmdbKey, customOutput, seasonName, filterTrack,
      updateMetaMode, forceTmdbId, noTouch,
    });
    return;
  }

  try {
    const { rawTitle, halim, isMoviePage, epMap } = await parsePage(pageUrl);

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

    // ── Fetch streams ──
    const { nonce, server: mainServer, episode: mainEpisode, postId: mainPostId } = halim;
    if (!nonce) throw new Error('ไม่พบ nonce ในหน้า ลอง reload หน้าอีกครั้ง');

    const slug = customOutput || utils.slugify(seriesTitle.replace(/\[.*?\]/g, '').replace(/\(.*?\)/g, '').trim());
    const slugFile = slug.endsWith('.txt') ? slug : `${slug}.txt`;
    const resolvedId = idPrefixArg || String(tmdbShow?.id || '');
    const outputFile = resolvedId ? `${resolvedId}-${slugFile}` : slugFile;
    const outputPath = path.resolve(PLAYLIST_DIR, outputFile);

    if (isMovieContent) {
      console.log('\n🔗 กำลัง fetch stream...');
      if (!mainPostId) throw new Error('ไม่พบ post_id ในหน้า');
      let hash;
      try {
        hash = await getStreamHash(mainPostId, mainServer, mainEpisode, nonce);
        console.log('  ✅ ได้ hash แล้ว');
      } catch (err) {
        console.error(`  ❌ ${err.message}`);
        process.exit(1);
      }
      const streamUrl = proxyUrl(`https://main.24playerhd.com/newplaylist/${hash}/${hash}.m3u8`, STREAM_REFERER);
      const partSeason = seasonNum || 1;

      const partPlaylist = io.buildPartFile({
        outputPath, season: partSeason, posterUrl, trackName,
        streamUrl, sourceUrl: pageUrl,
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
      });
    } else {
      const epEntries = [...epMap.entries()];
      console.log(`\n🔗 กำลัง fetch streams (${epEntries.length} ตอน)...`);
      const stations = [];

      for (let i = 0; i < epEntries.length; i++) {
        const [epNum, epUrl] = epEntries[i];
        process.stdout.write(`  ตอน ${epNum}/${epEntries.length}...`);

        let postId = mainPostId;
        let server = mainServer;
        let epEpisode = mainEpisode;

        if (epNum > 1) {
          try {
            const epData = await getEpPostId(epUrl);
            postId = epData.postId ?? postId;
            server = epData.server ?? server;
            epEpisode = epData.episode ?? epEpisode;
          } catch (err) {
            process.stdout.write(` ⚠️  fetch page: ${err.message}\n`);
            const tmdbEpFallback = tmdbEpisodes.find((e) => e.episode_number === epNum) || tmdbEpisodes[i];
            stations.push({
              name: utils.buildStationName(epNum, tmdbEpFallback?.name || '', isDubbedTrack),
              url: epUrl,
              referer: STREAM_REFERER,
              release_date: tmdbEpFallback?.air_date || '',
            });
            if (i < epEntries.length - 1) await utils.sleep(500);
            continue;
          }
        }

        if (!postId) {
          process.stdout.write(' ⚠️  ไม่พบ post_id\n');
          const tmdbEpFallback = tmdbEpisodes.find((e) => e.episode_number === epNum) || tmdbEpisodes[i];
          stations.push({
            name: utils.buildStationName(epNum, tmdbEpFallback?.name || '', isDubbedTrack),
            url: epUrl,
            referer: STREAM_REFERER,
            release_date: tmdbEpFallback?.air_date || '',
          });
          if (i < epEntries.length - 1) await utils.sleep(500);
          continue;
        }

        let streamUrl = null;
        try {
          const hash = await getStreamHash(postId, server, epEpisode, nonce);
          streamUrl = proxyUrl(`https://main.24playerhd.com/newplaylist/${hash}/${hash}.m3u8`, STREAM_REFERER);
          process.stdout.write(' ✅\n');
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
        trackName, trackReferer: pageUrl, tmdbSeasonName,
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

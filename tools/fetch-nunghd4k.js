#!/usr/bin/env node
/**
 * fetch-nunghd4k.js
 * สร้าง / อัปเดต playlist JSON จาก nunghd4k.com พร้อม metadata จาก TMDB
 *
 * ─── Flags ───────────────────────────────────────────────────────────────
 *   <url>              URL หน้า nunghd4k.com (movie หรือ series)
 *   --track=th|subth   th = พากย์ไทย, subth = ซับไทย (default: th)
 *   --season=N         ระบุ season (default: 1, สำหรับ series)
 *   --output=FILE      ชื่อไฟล์ผลลัพธ์ใน playlist/ (ไม่ต้องใส่ path)
 *   --tmdb-id=N        ระบุ TMDB ID ตรงๆ
 *   --update-meta[=poster|cover|title]
 *                      อัปเดต metadata จาก TMDB โดยไม่ fetch stream URLs ใหม่
 *   --type=KIND        anime-series|series|anime-movie|movie (default: auto-detect)
 *
 * ─── Workflow ────────────────────────────────────────────────────────────
 *   Movie : page → iframe#player-iframe vid.php?...&id={movieId}
 *         → doo-play.com/embed/fasthd.php?key=nunghd4k&id={movieId}
 *         → var videoSrc = "{m3u8}"
 *   Series: page → select#primary-player-select option[0].value → api_player1.php URL
 *         → fetch → JSON [{url, episode}, ...]
 *         → doo-play.com/embed/?id={seriesId}&ep={N}&type=series
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

// nunghd4k default track override: th (พากย์ไทย)
const cli = parseArgs();
let { seriesUrl: pageUrl, tmdbKey, customOutput, mainSlugArg, idPrefixArg,
      seasonNum, seasonName, updateMeta, updateMetaMode, noTouch,
      forceTmdbId, typeArg, filterTrack } = cli;
let trackName = cli.trackName;
let isDubbedTrack = cli.isDubbedTrack;
if (!cli.trackArg) {
  trackName = 'พากย์ไทย';
  isDubbedTrack = true;
}

if (!pageUrl && !updateMeta) {
  console.error('Usage: node fetch-nunghd4k.js <url> [--track=th|subth] [--season=N] [--output=FILE]');
  console.error('       node fetch-nunghd4k.js --update-meta[=poster|cover|title] --output=FILE.txt');
  process.exit(1);
}

const SITE_ORIGIN = 'https://www.nunghd4k.com';
const DOOPLAY_REFERER = 'https://www.nunghd4k.com/';
const SITE_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120 Safari/537.36',
  'Accept-Language': 'th-TH,th;q=0.9,en;q=0.8',
  'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  'Referer': SITE_ORIGIN + '/',
};

// ───── Source-specific helpers ─────
async function fetchHtml(url, extraHeaders = {}) {
  const res = await fetch(url, { headers: { ...SITE_HEADERS, ...extraHeaders } });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  return res.text();
}

async function fetchJson(url, extraHeaders = {}) {
  const res = await fetch(url, { headers: { ...SITE_HEADERS, ...extraHeaders } });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  return res.json();
}

async function parsePage(url) {
  console.log(`\n📄 กำลัง fetch หน้า: ${url}`);
  const html = await fetchHtml(url);
  const $ = cheerio.load(html);

  const pageTitle = $('title').text()
    .replace(/^ดู\s+/i, '')
    .replace(/\s*ฟรี.*$/i, '')
    .replace(/\s*พากย์ไทย.*$/i, '')
    .trim();

  const iframeSrc = $('iframe#player-iframe').attr('src') || '';
  const hasVidPhp = iframeSrc.includes('vid.php');
  const hasApiSelect = $('select#primary-player-select').length > 0;

  if (hasVidPhp) {
    const iUrl = iframeSrc.startsWith('http') ? iframeSrc : `${SITE_ORIGIN}${iframeSrc}`;
    const u = new URL(iUrl);
    const movieId = u.searchParams.get('id');
    if (!movieId) throw new Error('ไม่พบ movie ID ใน iframe src');
    console.log(`✅ พบ: Movie — ID: ${movieId}, ชื่อ: "${pageTitle}"`);
    return { isMoviePage: true, pageTitle, movieId };
  } else if (hasApiSelect) {
    const apiUrl = $('select#primary-player-select option').first().attr('value') || '';
    const idMatch = apiUrl.match(/[?&]id=([^&?\s]+)(?:[?&].*)?$/);
    const seriesId = idMatch ? idMatch[1].split('&')[0] : null;
    if (!seriesId) throw new Error('ไม่พบ series ID ใน api_player URL');

    const allText = $('title, h1').text();
    const epMatch = allText.match(/Ep\d+\s*[-–]\s*(\d+)/i);
    const totalEpisodes = epMatch ? parseInt(epMatch[1]) : 0;

    console.log(`✅ พบ: Series — ID: ${seriesId}, ตอน: ${totalEpisodes || '?'}, ชื่อ: "${pageTitle}"`);
    return { isMoviePage: false, pageTitle, seriesId, apiUrl, totalEpisodes };
  } else {
    throw new Error('ไม่สามารถตรวจจับประเภท (ไม่พบ #player-iframe หรือ #primary-player-select)');
  }
}

async function getMovieStream(movieId) {
  const embedUrl = `https://doo-play.com/embed/fasthd.php?key=nunghd4k&id=${movieId}`;
  console.log(`\n🔗 กำลัง fetch embed: ${embedUrl}`);
  const html = await fetchHtml(embedUrl, { Referer: DOOPLAY_REFERER });
  const m = html.match(/var\s+videoSrc\s*=\s*["']([^"']+)["']/);
  if (!m) throw new Error('ไม่พบ videoSrc ใน doo-play embed');
  console.log('✅ พบ stream URL');
  return { url: m[1], referer: DOOPLAY_REFERER };
}

async function getSeriesStream(seriesId, epNum) {
  const embedUrl = `https://doo-play.com/embed/?id=${seriesId}&ep=${epNum}&type=series`;
  const html = await fetchHtml(embedUrl, { Referer: DOOPLAY_REFERER });

  const m1 = html.match(/var\s+videoSrc\s*=\s*["']([^"']+)["']/);
  if (m1) return { url: m1[1], referer: DOOPLAY_REFERER };
  const m2 = html.match(/sources\s*:\s*\[\s*\{[^}]*file\s*:\s*["']([^"']+)["']/);
  if (m2) return { url: m2[1], referer: DOOPLAY_REFERER };
  const m3 = html.match(/['"](https?:\/\/[^'"]+\.m3u8[^'"]*)['"]/);
  if (m3) return { url: m3[1], referer: DOOPLAY_REFERER };

  throw new Error(`ไม่พบ stream URL ใน episode ${epNum} (seriesId: ${seriesId})`);
}

async function fetchEpisodeList(apiUrl) {
  try {
    const data = await fetchJson(apiUrl, { Referer: DOOPLAY_REFERER });
    if (Array.isArray(data) && data.length > 0 && data[0].url) return data;
    if (data?.error) console.warn(`⚠️  api_player คืน error: ${data.error}`);
    return null;
  } catch (err) {
    console.warn(`⚠️  fetch api_player ล้มเหลว: ${err.message}`);
    return null;
  }
}

// ───── Main ─────
async function main() {
  if (updateMeta) {
    // Default to series for update-meta when no --type given
    const paths = makePaths({ typeArg, scriptDir: __dirname, defaultType: 'series' });
    await runUpdateMeta({
      playlistDir: paths.playlistDir, indexPath: paths.indexPath, githubRawBase: paths.githubRawBase,
      isMovie: paths.isMovie, tmdbKey, customOutput, seasonName, filterTrack,
      updateMetaMode, forceTmdbId, noTouch,
    });
    return;
  }

  try {
    const pageInfo = await parsePage(pageUrl);

    // Determine type (auto-detect if --type not given)
    const detectedType = pageInfo.isMoviePage ? 'movie' : 'series';
    const effectiveTypeArg = typeArg || detectedType;
    const { isMovie, playlistDir: PLAYLIST_DIR, indexPath: INDEX_PATH, githubRawBase: GITHUB_RAW_BASE } =
      makePaths({ typeArg: effectiveTypeArg, scriptDir: __dirname, defaultType: detectedType });

    console.log(`📂 ประเภท: ${effectiveTypeArg}`);

    // TMDB lookup
    let seriesTitle = pageInfo.pageTitle;
    let posterUrl = '';
    let seasonPosterUrl = '';
    let tmdbEpisodes = [];
    let tmdbSeasonName = null;
    let tmdbShow = null;
    let seasonAirDate = '';

    if (tmdbKey) {
      if (isMovie) {
        let tmdbResult;
        if (forceTmdbId) {
          console.log(`\n🎬 ใช้ TMDB ID ที่ระบุ: ${forceTmdbId}`);
          tmdbResult = await tmdb.getTmdbMovieDetail(forceTmdbId, tmdbKey, 'en-US');
        } else {
          console.log('\n🎬 กำลัง search TMDB (movie)...');
          tmdbResult = await tmdb.searchTmdbMovie(pageInfo.pageTitle, tmdbKey);
        }
        if (tmdbResult) {
          const enName = tmdbResult.title || pageInfo.pageTitle;
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
          tmdbResult = await tmdb.searchTmdbTv(pageInfo.pageTitle, tmdbKey);
        }
        if (tmdbResult) {
          const enName = tmdbResult.name || pageInfo.pageTitle;
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

    // Fetch stream URLs
    const stations = [];
    if (isMovie) {
      const stream = await getMovieStream(pageInfo.movieId);
      stations.push({
        name: trackName,
        image: posterUrl,
        url: stream.url,
        referer: stream.referer,
        release_date: tmdbShow?.release_date || '',
      });
    } else {
      let episodeItems = await fetchEpisodeList(pageInfo.apiUrl);
      let episodeUrls = [];
      if (episodeItems && episodeItems.length > 0) {
        console.log(`✅ api_player คืน ${episodeItems.length} ตอน`);
        episodeUrls = episodeItems.map((item) => ({ ep: item.episode, url: item.url }));
      } else {
        const total = pageInfo.totalEpisodes;
        if (!total) { console.error('❌ ไม่พบจำนวนตอนทั้งหมด'); process.exit(1); }
        console.log(`⚠️  ใช้ fallback URL จาก ep range (1-${total})`);
        for (let n = 1; n <= total; n++) {
          episodeUrls.push({
            ep: n,
            url: `https://doo-play.com/embed/?id=${pageInfo.seriesId}&ep=${n}&type=series`,
          });
        }
      }

      console.log(`\n🔗 กำลัง fetch stream URLs (${episodeUrls.length} ตอน)...`);
      for (let i = 0; i < episodeUrls.length; i++) {
        const { ep, url: epEmbedUrl } = episodeUrls[i];
        process.stdout.write(`  ตอน ${ep}/${episodeUrls.length}...`);
        let stream = null;
        try {
          stream = await getSeriesStream(pageInfo.seriesId, ep);
          process.stdout.write(' ✅\n');
        } catch (err) {
          process.stdout.write(` ⚠️  ${err.message}\n`);
        }

        const tmdbEp = tmdbEpisodes.find((e) => e.episode_number === ep) || tmdbEpisodes[i];
        const epTitle = tmdbEp?.name || '';
        const epThumb = tmdbEp?.still_path ? `${tmdb.TMDB_IMG}${tmdbEp.still_path}` : '';
        stations.push({
          name: utils.buildStationName(ep, epTitle, isDubbedTrack),
          ...(epThumb && { image: epThumb }),
          url: stream?.url || epEmbedUrl,
          referer: stream?.referer || DOOPLAY_REFERER,
          release_date: tmdbEp?.air_date || '',
        });
        if (i < episodeUrls.length - 1) await utils.sleep(600);
      }
    }

    const slug = customOutput || utils.slugify(seriesTitle.replace(/\[.*?\]/g, '').replace(/\(.*?\)/g, '').trim());
    const slugFile = slug.endsWith('.txt') ? slug : `${slug}.txt`;
    const resolvedId = idPrefixArg || String(tmdbShow?.id || '');
    const outputFile = resolvedId ? `${resolvedId}-${slugFile}` : slugFile;
    const outputPath = path.resolve(PLAYLIST_DIR, outputFile);

    if (isMovie) {
      const s = stations[0];
      if (!s) { console.error('❌ ไม่พบ stream URL'); process.exit(1); }
      const partSeason = seasonNum || 1;
      const partPlaylist = io.buildPartFile({
        outputPath, season: partSeason, posterUrl, trackName,
        streamUrl: s.url, sourceUrl: pageUrl,
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
      const playlist = io.buildOrMergePlaylist({
        outputPath, seriesTitle, posterUrl, seasonPosterUrl, stations,
        trackName, trackReferer: pageUrl, tmdbSeasonName,
        seasonName, seasonNum, epOffset: 0,
      });
      io.markSeasonTrackComplete({ playlist, seasonName, trackName, tmdbEpCount: tmdbEpisodes.length });
      if (seasonAirDate) {
        const targetSeasonName = seasonName || 'Season 1';
        const affectedSeason = (playlist.groups || []).find((g) => g.name === targetSeasonName);
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

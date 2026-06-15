#!/usr/bin/env node
/**
 * fetch-7hd.js
 * สร้าง / อัปเดต playlist JSON จาก 7-hd.com พร้อม metadata จาก TMDB
 * Stream ผ่าน weplayhls.xyz embed → window.playerConfig
 *
 * ─── Flags ───────────────────────────────────────────────────────────────
 *   <url>              URL หน้า 7-hd.com (movie หรือ series)
 *   --track=th|subth   th = พากย์ไทย, subth = ซับไทย (default: subth)
 *   --season=N         ระบุ season (default: 1, สำหรับ series)
 *   --output=FILE      ชื่อไฟล์ผลลัพธ์ใน playlist/ (ไม่ต้องใส่ path)
 *   --tmdb-id=N        ระบุ TMDB ID ตรงๆ
 *   --update-meta[=poster|cover|title]
 *                      อัปเดต metadata จาก TMDB โดยไม่ fetch stream URLs ใหม่
 *   --type=KIND        anime-series|series|anime-movie|movie (default: auto-detect)
 *
 * ─── Stream URL ──────────────────────────────────────────────────────────
 *   https://{playerConfig.asset}/{playerConfig.medias.original}/video.m3u8
 *   (ผ่าน CF Worker, Referer: https://weplayhls.xyz/)
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
  console.error('Usage: node fetch-7hd.js <url> [--track=th|subth] [--season=N] [--output=FILE]');
  console.error('       node fetch-7hd.js --update-meta[=poster|cover|title] --output=FILE.txt');
  process.exit(1);
}

const WEPLAYHLS_REFERER = 'https://weplayhls.xyz/';
const CF_WORKER = 'https://shy-haze-2452.natajrak-p.workers.dev/';
const SITE_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120 Safari/537.36',
  'Accept-Language': 'th-TH,th;q=0.9,en;q=0.8',
  'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  'Referer': 'https://7-hd.com/',
};

// ───── Source-specific helpers ─────
async function fetchHtml(url, extraHeaders = {}) {
  const res = await fetch(url, { headers: { ...SITE_HEADERS, ...extraHeaders } });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  return res.text();
}

async function parsePage(url) {
  console.log(`\n📄 กำลัง fetch หน้า: ${url}`);
  const html = await fetchHtml(url);
  const $ = cheerio.load(html);

  let rawTitle = $('title').text()
    .replace(/^ดู\s+/i, '')
    .replace(/\s+ฟรี.*$/i, '')
    .trim();
  if (!rawTitle) rawTitle = $('h1').first().text().trim();

  const embedUrls = [];
  const seen = new Set();
  $("a[href*='weplayhls.xyz/embed/']").each((_, el) => {
    let href = $(el).attr('href') || '';
    if (!href) return;
    if (!href.startsWith('http')) href = 'https:' + href;
    if (!seen.has(href)) { seen.add(href); embedUrls.push(href); }
  });

  if (embedUrls.length === 0) throw new Error('ไม่พบ weplayhls embed URL บนหน้านี้');
  const isMoviePage = embedUrls.length === 1;
  console.log(`✅ พบ: "${rawTitle}" — ${isMoviePage ? 'Movie' : `Series (${embedUrls.length} ตอน)`}`);
  return { rawTitle, embedUrls, isMoviePage };
}

async function getStreamFromEmbed(embedUrl) {
  const html = await fetchHtml(embedUrl, { Referer: 'https://7-hd.com/' });
  const m = html.match(/playerConfig\s*=\s*(\{[^\n]+\})\s*;?/);
  if (!m) throw new Error(`ไม่พบ playerConfig ใน ${embedUrl}`);

  let config;
  try { config = JSON.parse(m[1]); }
  catch (e) { throw new Error(`parse playerConfig ไม่ได้: ${e.message}`); }

  const asset = config.asset;
  const medias = config.medias || {};
  const preferOrder = ['original', '1080', '720', '480', '360'];
  const bestKey = preferOrder.find((k) => medias[k]) || Object.keys(medias).pop();
  const mediaId = bestKey ? medias[bestKey] : null;
  if (!asset || !mediaId) throw new Error('ไม่พบ asset/mediaId ใน playerConfig');

  console.log(`    📺 quality: ${bestKey} (มี: ${Object.keys(medias).join(', ')})`);

  const rawUrl = `https://${asset}/${mediaId}/video.m3u8`;
  return {
    url: `${CF_WORKER}?url=${encodeURIComponent(rawUrl)}&referer=${encodeURIComponent(WEPLAYHLS_REFERER)}`,
    referer: WEPLAYHLS_REFERER,
  };
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
    const { rawTitle, embedUrls, isMoviePage } = await parsePage(pageUrl);

    const detectedType = isMoviePage ? 'movie' : 'series';
    const effectiveTypeArg = typeArg || detectedType;
    const { isMovie, playlistDir: PLAYLIST_DIR, indexPath: INDEX_PATH, githubRawBase: GITHUB_RAW_BASE } =
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
      if (isMovie) {
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

    // Fetch stream URLs
    console.log(`\n🔗 กำลัง fetch stream URLs (${embedUrls.length} embed)...`);
    const stations = [];

    for (let i = 0; i < embedUrls.length; i++) {
      const epNum = i + 1;
      process.stdout.write(`  ${isMovie ? 'Movie' : `ตอน ${epNum}/${embedUrls.length}`}...`);

      let stream = null;
      try {
        stream = await getStreamFromEmbed(embedUrls[i]);
        process.stdout.write(' ✅\n');
      } catch (err) {
        process.stdout.write(` ⚠️  ${err.message}\n`);
      }

      if (!isMovie) {
        const tmdbEp = tmdbEpisodes.find((e) => e.episode_number === epNum) || tmdbEpisodes[i];
        const epTitle = tmdbEp?.name || '';
        const epThumb = tmdbEp?.still_path ? `${tmdb.TMDB_IMG}${tmdbEp.still_path}` : '';
        stations.push({
          name: utils.buildStationName(epNum, epTitle, isDubbedTrack),
          ...(epThumb && { image: epThumb }),
          url: stream?.url || embedUrls[i],
          referer: stream?.referer || WEPLAYHLS_REFERER,
          release_date: tmdbEp?.air_date || '',
        });
        if (i < embedUrls.length - 1) await utils.sleep(600);
      } else {
        stations.push({
          name: trackName,
          image: posterUrl,
          url: stream?.url || embedUrls[i],
          referer: stream?.referer || WEPLAYHLS_REFERER,
          release_date: tmdbShow?.release_date || '',
        });
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
      const newStation = partPlaylist.stations.find((st) => st.name === trackName);
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
    console.log(`   ${isMovie ? 'ประเภท: Movie' : `จำนวนตอน: ${stations.length}`}`);
  } catch (err) {
    console.error(`\n❌ Error: ${err.message}`);
    process.exit(1);
  }
}

main();

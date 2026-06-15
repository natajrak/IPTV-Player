#!/usr/bin/env node
/**
 * fetch-allinhd.js
 * สร้าง / อัปเดต playlist JSON จาก allinhd.com พร้อม metadata จาก TMDB
 *
 * ─── Flags ───────────────────────────────────────────────────────────────
 *   <url>              URL หน้าหนังบน allinhd.com
 *   --track=th|subth   th = พากย์ไทย, subth = ซับไทย (default: จากหน้าเว็บ)
 *   --season=N         ระบุ season/ภาค (default: 1)
 *   --output=FILE      ชื่อไฟล์ผลลัพธ์ (ไม่ต้องใส่ path)
 *   --tmdb-key=KEY     TMDB API key (อ่านจาก .env)
 *   --tmdb-id=N        ระบุ TMDB ID ตรงๆ
 *   --tmdb-season=N    TMDB season override
 *   --ep-offset=N      source ep → TMDB ep offset
 *   --type=KIND        anime-series|anime-movie|movie|series (default: movie)
 *   --update-meta[=poster|cover|title]
 *                      อัปเดต metadata จาก TMDB โดยไม่ fetch stream URLs ใหม่
 *
 * ─── Stream URL ──────────────────────────────────────────────────────────
 *   embed iframe → movieid → https://player3.fastfastcdn.com/ttplaylist_{movieid}.m3u8
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
      trackArg, seasonNum, seasonName, updateMeta, updateMetaMode, noTouch,
      forceTmdbId, tmdbSeasonNum, epOffset, typeArg, filterTrack } = cli;
// allinhd: --track may override; otherwise auto-detect from page
const trackNameOverride = cli.trackArg ? cli.trackName : null;

if (!pageUrl && !updateMeta) {
  console.error('Usage: node fetch-allinhd.js <url> [--track=th|subth] [--type=movie|series|anime-series|anime-movie] [--output=FILE]');
  console.error('       node fetch-allinhd.js --update-meta[=poster|cover|title] --output=FILE.txt');
  process.exit(1);
}

const { isMovie, playlistDir: PLAYLIST_DIR, indexPath: INDEX_PATH, githubRawBase: GITHUB_RAW_BASE } =
  makePaths({ typeArg, scriptDir: __dirname, defaultType: 'movie' });

const STREAM_BASE = 'https://player3.fastfastcdn.com/ttplaylist_';
const STREAM_REFERER = 'https://allinhd.com/';
const HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120 Safari/537.36',
  'Accept-Language': 'th-TH,th;q=0.9,en;q=0.8',
  'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
};

// ───── Source-specific helpers ─────
async function fetchHtml(url) {
  const res = await fetch(url, { headers: HEADERS });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  return res.text();
}

function extractMovieId($) {
  const iframe = $('iframe[src*="movieid="]');
  if (iframe.length) {
    const src = iframe.attr('src');
    const m = src.match(/movieid=([a-f0-9]+)/i);
    if (m) return m[1];
  }
  const iframe2 = $('iframe[src*="fastplayer"]');
  if (iframe2.length) {
    const src = iframe2.attr('src');
    const m = src.match(/movieid=([a-f0-9]+)/i);
    if (m) return m[1];
  }
  const scripts = $('script:not([src])');
  let found = null;
  scripts.each((_, el) => {
    const text = $(el).text();
    const m = text.match(/movieid[=:]?\s*["']?([a-f0-9]{20,})["']?/i);
    if (m && !found) found = m[1];
  });
  return found;
}

function buildStreamUrl(movieId) {
  return `${STREAM_BASE}${movieId}.m3u8`;
}

function extractTrackLabel($) {
  const cat = $('.movie-category').text().trim();
  if (cat.includes('พากย์ไทย')) return 'พากย์ไทย';
  if (cat.includes('ซับไทย')) return 'ซับไทย';
  const title = $('h1').first().text();
  if (title.includes('พากย์ไทย')) return 'พากย์ไทย';
  if (title.includes('ซับไทย')) return 'ซับไทย';
  return 'พากย์ไทย';
}

function extractTitle($) {
  let title = $('h1').first().text().trim()
    || $('.entry-title').first().text().trim()
    || $('title').text().split('|')[0].trim();
  title = title.replace(/\s*[-|]?\s*ดูหนัง.*$/i, '').trim();
  title = title.replace(/\s*\(\d{4}\)\s*$/, '').trim();
  title = title.replace(/\s*(พากย์ไทย|ซับไทย|เต็มเรื่อง|HD)\s*/g, ' ').trim();
  return title;
}

async function parsePage(url) {
  console.log(`\n📄 กำลัง fetch: ${url}`);
  const html = await fetchHtml(url);
  const $ = cheerio.load(html);

  const title = extractTitle($);
  const movieId = extractMovieId($);
  const track = trackNameOverride || extractTrackLabel($);
  const poster = $('.poster img, .sheader img, .movie-poster img, .entry-content img').first().attr('src') || '';

  if (!movieId) throw new Error('ไม่พบ movieid ในหน้านี้ — ตรวจสอบ URL อีกครั้ง');

  const streamUrl = buildStreamUrl(movieId);
  console.log(`  ✅ title: ${title}`);
  console.log(`  ✅ movieId: ${movieId}`);
  console.log(`  ✅ track: ${track}`);
  console.log(`  ✅ stream: ${streamUrl}`);
  return { title, movieId, streamUrl, track, poster };
}

async function parseSeriesPage(url) {
  console.log(`\n📄 กำลัง fetch series: ${url}`);
  const html = await fetchHtml(url);
  const $ = cheerio.load(html);

  const title = extractTitle($);
  const poster = $('.poster img, .sheader img, .movie-poster img, .entry-content img').first().attr('src') || '';
  const track = trackNameOverride || extractTrackLabel($);
  const episodeLinks = [];

  $('a[href*="episode"], a[href*="-ep-"], a[href*="-ep"]').each((_, el) => {
    const href = $(el).attr('href');
    const text = $(el).text().trim();
    if (href && !episodeLinks.find((e) => e.url === href)) episodeLinks.push({ url: href, text });
  });
  if (episodeLinks.length === 0) {
    $('.episodios li a, .episodes li a, .ep-list a').each((_, el) => {
      const href = $(el).attr('href');
      const text = $(el).text().trim();
      if (href) episodeLinks.push({ url: href, text });
    });
  }
  if (episodeLinks.length === 0) {
    const movieIds = [];
    $('iframe[src*="movieid="]').each((_, el) => {
      const src = $(el).attr('src');
      const m = src.match(/movieid=([a-f0-9]+)/i);
      if (m && !movieIds.includes(m[1])) movieIds.push(m[1]);
    });
    $('script:not([src])').each((_, el) => {
      const text = $(el).text();
      const matches = text.matchAll(/movieid[=:]?\s*["']?([a-f0-9]{20,})["']?/gi);
      for (const m of matches) if (!movieIds.includes(m[1])) movieIds.push(m[1]);
    });
    if (movieIds.length > 1) {
      return { title, poster, track, episodes: movieIds.map((id, i) => ({ movieId: id, epNum: i + 1 })) };
    }
  }

  console.log(`  📺 พบ ${episodeLinks.length} ตอน`);
  return { title, poster, track, episodeLinks };
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
    if (isMovie) {
      const { title, streamUrl, track, poster } = await parsePage(pageUrl);
      let seriesTitle = title;
      let posterUrl = poster;
      let tmdbShow = null;

      if (tmdbKey) {
        let tmdbResult;
        if (forceTmdbId) {
          console.log(`\n🎬 ใช้ TMDB ID ที่ระบุ: ${forceTmdbId}`);
          tmdbResult = await tmdb.getTmdbMovieDetail(forceTmdbId, tmdbKey, 'en-US');
        } else {
          console.log('\n🎬 กำลัง search TMDB (movie)...');
          tmdbResult = await tmdb.searchTmdbMovie(title, tmdbKey);
        }
        if (tmdbResult) {
          const tmdbEnName = tmdbResult.title || title;
          const tmdbThName = await tmdb.getTmdbMovieNameTh(tmdbResult.id, tmdbKey);
          seriesTitle = utils.formatSeriesTitle(tmdbEnName, tmdbThName);
          posterUrl = tmdbResult.poster_path ? `${tmdb.TMDB_IMG}${tmdbResult.poster_path}` : poster;
          tmdbShow = tmdbResult;
          console.log(`✅ พบใน TMDB: "${seriesTitle}" (ID: ${tmdbResult.id})`);
        } else {
          console.warn('⚠️  ไม่พบใน TMDB ใช้ข้อมูลจาก allinhd แทน');
        }
      }

      const partSeason = seasonNum || 1;
      const slug = customOutput || utils.slugify(seriesTitle.replace(/\[.*?\]/g, '').trim());
      const slugFile = slug.endsWith('.txt') ? slug : `${slug}.txt`;
      const resolvedId = idPrefixArg || String(tmdbShow?.id || '');
      const partFile = resolvedId ? `${resolvedId}-${slugFile}` : slugFile;
      const partPath = path.resolve(PLAYLIST_DIR, partFile);

      // Use track derived from page (may differ from default --track convention)
      const partPlaylist = io.buildPartFile({
        outputPath: partPath, season: partSeason, posterUrl,
        trackName: track, streamUrl, sourceUrl: pageUrl,
      });
      // Inject release_date AFTER referer for the newly-added/updated station
      const newStation = partPlaylist.stations.find((s) => s.name === track);
      if (newStation) newStation.release_date = tmdbShow?.release_date || '';
      io.stampPlaylist(partPlaylist, tmdbShow, true);
      fs.writeFileSync(partPath, JSON.stringify(partPlaylist, null, 4), 'utf-8');
      console.log(`\n📁 บันทึก part file: ${partPath}`);

      const mainFile = mainSlugArg
        ? (mainSlugArg.endsWith('.txt') ? mainSlugArg : `${mainSlugArg}.txt`)
        : slugFile;
      const mainPath = path.resolve(PLAYLIST_DIR, mainFile);
      const partRawUrl = `${GITHUB_RAW_BASE}${partFile}`;
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

      console.log('\n🎉 เสร็จสิ้น!');
      console.log(`   Part: ${partFile}`);
      console.log(`   Main: ${mainFile}`);
    } else {
      const result = await parseSeriesPage(pageUrl);
      const { title, poster, track } = result;

      let episodes = [];
      if (result.episodes) {
        episodes = result.episodes;
      } else if (result.episodeLinks?.length > 0) {
        console.log(`\n🔗 กำลัง fetch stream URLs (${result.episodeLinks.length} ตอน)...`);
        for (let i = 0; i < result.episodeLinks.length; i++) {
          const ep = result.episodeLinks[i];
          process.stdout.write(`  ตอน ${i + 1}/${result.episodeLinks.length}...`);
          try {
            const epHtml = await fetchHtml(ep.url);
            const $ep = cheerio.load(epHtml);
            const movieId = extractMovieId($ep);
            if (movieId) {
              episodes.push({ movieId, epNum: i + 1, text: ep.text });
              process.stdout.write(` movieId: ${movieId} ✅\n`);
            } else console.warn(' ⚠️ ไม่พบ movieId');
          } catch (err) {
            console.warn(` ⚠️ ${err.message}`);
          }
          if (i < result.episodeLinks.length - 1) await utils.sleep(500);
        }
      } else {
        const html = await fetchHtml(pageUrl);
        const $ = cheerio.load(html);
        const movieId = extractMovieId($);
        if (movieId) episodes.push({ movieId, epNum: 1 });
        else { console.error('❌ ไม่พบ episode หรือ movieid ใดเลย'); process.exit(1); }
      }

      if (episodes.length === 0) { console.error('❌ ไม่พบ episode ที่มี stream URL'); process.exit(1); }

      let seriesTitle = title;
      let posterUrl = poster;
      let seasonPosterUrl = poster;
      let tmdbEpisodes = [];
      let tmdbSeasonName = null;
      let tmdbShow = null;
      let seasonAirDate = '';
      const isDubbedTrack = track === 'พากย์ไทย';

      if (tmdbKey) {
        let tmdbResult;
        if (forceTmdbId) tmdbResult = await tmdb.getTmdbShow(forceTmdbId, tmdbKey, 'en-US');
        else tmdbResult = await tmdb.searchTmdbTv(title, tmdbKey);
        if (tmdbResult) {
          const tmdbEnName = tmdbResult.name || title;
          const tmdbThName = await tmdb.getTmdbShowNameTh(tmdbResult.id, tmdbKey);
          seriesTitle = utils.formatSeriesTitle(tmdbEnName, tmdbThName);
          posterUrl = tmdbResult.poster_path ? `${tmdb.TMDB_IMG}${tmdbResult.poster_path}` : poster;
          seasonPosterUrl = posterUrl;
          tmdbShow = tmdbResult;
          console.log(`✅ พบใน TMDB: "${seriesTitle}" (ID: ${tmdbResult.id})`);

          const lookupSeason = tmdbSeasonNum || seasonNum || 1;
          const biData = await tmdb.getTmdbSeasonBilingual(tmdbResult.id, tmdbKey, lookupSeason);
          tmdbEpisodes = isDubbedTrack ? biData.thEpisodes : biData.enEpisodes;
          if (biData.poster) seasonPosterUrl = biData.poster;
          tmdbSeasonName = biData.seasonName;
          seasonAirDate = biData.air_date || '';
          console.log(`✅ ดึงข้อมูล ${tmdbEpisodes.length} ตอน จาก TMDB`);
        } else {
          console.warn('⚠️  ไม่พบใน TMDB ใช้ข้อมูลจาก allinhd แทน');
        }
      }

      const stations = episodes.map((ep, i) => {
        const epNum = ep.epNum || (i + 1);
        const tmdbEpNum = epNum + epOffset;
        const tmdbEp = tmdbEpisodes.find((e) => e.episode_number === tmdbEpNum) || tmdbEpisodes[i + epOffset];
        const epTitle = tmdbEp?.name || '';
        const epThumb = tmdbEp?.still_path ? `${tmdb.TMDB_IMG}${tmdbEp.still_path}` : '';
        return {
          name: utils.buildStationName(epNum, epTitle, isDubbedTrack),
          ...(epThumb && { image: epThumb }),
          url: buildStreamUrl(ep.movieId),
          referer: STREAM_REFERER,
          release_date: tmdbEp?.air_date || '',
        };
      });

      const slug = customOutput || utils.slugify(seriesTitle.replace(/\[.*?\]/g, '').trim());
      const slugFile = slug.endsWith('.txt') ? slug : `${slug}.txt`;
      const resolvedId = idPrefixArg || String(tmdbShow?.id || '');
      const outputFile = resolvedId ? `${resolvedId}-${slugFile}` : slugFile;
      const outputPath = path.resolve(PLAYLIST_DIR, outputFile);

      const playlist = io.buildOrMergePlaylist({
        outputPath, seriesTitle, posterUrl, seasonPosterUrl, stations,
        trackName: track, trackReferer: pageUrl, tmdbSeasonName,
        seasonName, seasonNum, epOffset,
      });
      io.markSeasonTrackComplete({ playlist, seasonName, trackName: track, tmdbEpCount: tmdbEpisodes.length });
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

      console.log('\n🎉 เสร็จสิ้น!');
      console.log(`   ไฟล์: ${outputFile}`);
      console.log(`   จำนวนตอน: ${stations.length}`);
    }
  } catch (err) {
    console.error(`\n❌ Error: ${err.message}`);
    process.exit(1);
  }
}

main();

#!/usr/bin/env node
/**
 * fetch-24hd.js
 * สร้าง / อัปเดต playlist JSON จาก 24hd.vip พร้อม metadata จาก TMDB
 * Stream: player77hdfree.xyz/embed/{SLUG} → media.vdohls.com/{SLUG}/playlist.m3u8
 *
 * ─── โครงสร้างเว็บ ───────────────────────────────────────────────────────
 *   - Anime page (WordPress + Elementor) มีปุ่ม <button class="swicth-ep mov_source">
 *     ต่อ 1 ตอน — data-link="https://player77hdfree.xyz/embed/{SLUG}" data-link2="{BACKUP}"
 *     Text: "... EP.N" (หรือแค่ 1 button = movie)
 *   - Stream URL (master playlist multi-quality): https://media.vdohls.com/{SLUG}/playlist.m3u8
 *   - CDN: ไม่มี referer check, CORS `*` → เล่นตรงได้ ไม่ต้อง CF Worker proxy
 *
 * ─── Flags ───────────────────────────────────────────────────────────────
 *   <url>              URL 24hd.vip (comma-separated รองรับ)
 *   --track=th|subth   default: subth (24hd มี track เดียวต่อเรื่อง — flag ใช้แค่ label)
 *   --season=N         default: 1
 *   --output=FILE
 *   --tmdb-id=N
 *   --update-meta[=poster|cover|title]
 *   --type=KIND        default: auto-detect (series/movie)
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

if (!seriesUrl && !updateMeta) {
  console.error('Usage: node fetch-24hd.js <url>[,url2,...] [--track=th|subth] [--season=N] [--output=FILE]');
  console.error('       node fetch-24hd.js --update-meta[=poster|cover|title] --output=FILE.txt');
  process.exit(1);
}

const SITE_ORIGIN = 'https://www.24hd.vip';
const STREAM_HOST = 'media.vdohls.com';
const EMBED_HOST = 'player77hdfree.xyz';
const STATION_REFERER = `${SITE_ORIGIN}/`;

const BASE_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
  'Accept-Language': 'th-TH,th;q=0.9,en;q=0.8',
  'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
};

async function fetchPage(url) {
  const res = await fetch(url, { headers: { ...BASE_HEADERS, Referer: SITE_ORIGIN + '/' } });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  return res.text();
}

function buildStreamUrl(slug) {
  return `https://${STREAM_HOST}/${slug}/playlist.m3u8`;
}

// Extract SLUG จาก data-link (e.g. https://player77hdfree.xyz/embed/xb3r5agqwz)
function extractSlug(embedUrl) {
  if (!embedUrl) return null;
  const m = embedUrl.match(/\/embed\/([a-z0-9_-]+)/i);
  return m ? m[1] : null;
}

// Movie chain: ongetplay.xyz/playhls/play.php?id=N → iframe playermhd.p2phls.xyz/embed/{SLUG}
//              → build media.vdohls.com/{SLUG}/playlist.m3u8 (same infra as series)
async function resolveOngetplaySlug(ongetplayUrl) {
  const html = await fetchPage(ongetplayUrl);
  const m = html.match(/<iframe[^>]+src=["']([^"']*(?:playermhd|p2phls)[^"']*\/embed\/[^"'\/]+\/?)["']/i);
  if (!m) throw new Error(`ไม่พบ iframe playermhd ใน ${ongetplayUrl}`);
  const slug = (m[1].match(/\/embed\/([a-zA-Z0-9_-]+)/i) || [])[1];
  if (!slug) throw new Error(`extract slug ไม่ได้ จาก ${m[1]}`);
  return slug;
}

// ───── Parse anime page ─────
async function parseAnimePage(url) {
  console.log(`\n📄 กำลัง fetch หน้า: ${url}`);
  const html = await fetchPage(url);
  const $ = cheerio.load(html);

  const rawTitle = ($('meta[property="og:title"]').attr('content')
    || $('h1').first().text()
    || $('title').text().replace(/\s*(?:ดูหนัง|ดูซีรี)\s*/g, '')
    || '').trim().replace(/\s*(?:ดูหนังฟรี|หนังHD).*$/i, '').trim();
  const rawPoster = ($('meta[property="og:image"]').attr('content') || '').trim();

  const seen = new Set();
  const episodes = [];

  // Series pattern: button.swicth-ep with data-link="https://player77hdfree.xyz/embed/{SLUG}"
  $('button.swicth-ep, button.mov_source').each((_, el) => {
    const $el = $(el);
    const dataLink = ($el.attr('data-link') || '').trim();
    if (!dataLink || seen.has(dataLink)) return;
    const slug = extractSlug(dataLink);
    if (!slug) return;
    seen.add(dataLink);

    const text = ($el.text() || '').replace(/\s+/g, ' ').trim();
    const epMatch = text.match(/EP\.?\s*(\d+)/i);
    const epNum = epMatch ? parseInt(epMatch[1], 10) : (episodes.length + 1);
    episodes.push({ slug, epNum, label: text });
  });

  // Movie pattern: <a class="player-1-btn-link" href="https://ongetplay.xyz/playhls/play.php?id=N">
  // ต้อง resolve iframe chain → SLUG
  let isMoviePage = false;
  if (episodes.length === 0) {
    const movieLinks = [];
    $('a[href*="ongetplay"][href*="playhls"], a[href*="ongetplay"][href*="playproxy"]').each((_, el) => {
      const href = ($(el).attr('href') || '').trim();
      if (!href || seen.has(href)) return;
      seen.add(href);
      movieLinks.push(href);
    });
    if (movieLinks.length > 0) {
      isMoviePage = true;
      // Resolve หลัก (playhls) ถ้ามี ไม่งั้น playproxy
      const preferred = movieLinks.find(u => u.includes('playhls')) || movieLinks[0];
      console.log(`  🎬 movie player: ${preferred}`);
      const slug = await resolveOngetplaySlug(preferred);
      episodes.push({ slug, epNum: 1, label: 'Movie' });
    }
  }

  episodes.sort((a, b) => a.epNum - b.epNum);

  if (!rawTitle) throw new Error('ไม่พบ title — ตรวจสอบ URL');
  if (episodes.length === 0) throw new Error('ไม่พบ button.swicth-ep หรือ movie player link — เว็บอาจเปลี่ยน structure');

  if (!isMoviePage) isMoviePage = episodes.length === 1;
  console.log(`✅ "${rawTitle}" — ${isMoviePage ? 'Movie' : `Series (${episodes.length} ตอน)`}`);
  return { rawTitle, rawPoster, episodes, isMoviePage };
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
    const urls = seriesUrl.split(',').map(u => u.trim()).filter(Boolean);
    const isMultiUrl = urls.length > 1;

    let rawTitle = '', rawPoster = '';
    let mergedEps = [];
    let anyMoviePage = false;

    for (let ui = 0; ui < urls.length; ui++) {
      if (isMultiUrl) console.log(`\n📡 Fetch part ${ui + 1}/${urls.length}: ${urls[ui]}`);
      const parsed = await parseAnimePage(urls[ui]);
      if (ui === 0) {
        rawTitle = parsed.rawTitle;
        rawPoster = parsed.rawPoster;
        anyMoviePage = parsed.isMoviePage;
      }
      const offset = mergedEps.length;
      for (const ep of parsed.episodes) {
        mergedEps.push({ slug: ep.slug, epNum: offset > 0 ? offset + ep.epNum : ep.epNum });
      }
      if (isMultiUrl) console.log(`  รวม ${mergedEps.length} ตอน`);
    }

    if (mergedEps.length === 0) {
      console.error('❌ ไม่พบ episode ใดเลย');
      process.exit(1);
    }

    const detectedType = anyMoviePage && mergedEps.length === 1 ? 'movie' : 'series';
    const effectiveTypeArg = typeArg || detectedType;
    const { isMovie: isMovieContent, playlistDir: PLAYLIST_DIR, indexPath: INDEX_PATH, githubRawBase: GITHUB_RAW_BASE } =
      makePaths({ typeArg: effectiveTypeArg, scriptDir: __dirname, defaultType: detectedType });
    console.log(`📂 ประเภท: ${effectiveTypeArg} | track: ${trackName}`);

    // TMDB lookup
    let seriesTitle = rawTitle;
    let posterUrl = rawPoster;
    let seasonPosterUrl = rawPoster;
    let tmdbEpisodes = [];
    let tmdbSeasonName = null;
    let tmdbShow = null;
    let seasonAirDate = '';

    if (tmdbKey) {
      if (isMovieContent) {
        let tmdbResult;
        if (forceTmdbId) {
          console.log(`\n🎬 ใช้ TMDB ID: ${forceTmdbId}`);
          tmdbResult = await tmdb.getTmdbMovieDetail(forceTmdbId, tmdbKey, 'en-US');
        } else {
          console.log('\n🎬 search TMDB (movie)...');
          tmdbResult = await tmdb.searchTmdbMovie(rawTitle, tmdbKey);
        }
        if (tmdbResult) {
          const enName = tmdbResult.title || rawTitle;
          const thName = await tmdb.getTmdbMovieNameTh(tmdbResult.id, tmdbKey);
          seriesTitle = utils.formatSeriesTitle(enName, thName);
          posterUrl = tmdbResult.poster_path ? `${tmdb.TMDB_IMG}${tmdbResult.poster_path}` : rawPoster;
          seasonPosterUrl = posterUrl;
          tmdbShow = tmdbResult;
          console.log(`✅ พบใน TMDB: "${seriesTitle}" (ID: ${tmdbResult.id})`);
        } else { console.warn('⚠️  ไม่พบใน TMDB'); }
      } else {
        let tmdbResult;
        if (forceTmdbId) {
          console.log(`\n🎬 ใช้ TMDB ID: ${forceTmdbId}`);
          tmdbResult = await tmdb.getTmdbShow(forceTmdbId, tmdbKey, 'en-US');
        } else {
          console.log('\n🎬 search TMDB...');
          tmdbResult = await tmdb.searchTmdbTv(rawTitle, tmdbKey);
        }
        if (tmdbResult) {
          const enName = tmdbResult.name || rawTitle;
          const thName = await tmdb.getTmdbShowNameTh(tmdbResult.id, tmdbKey);
          seriesTitle = utils.formatSeriesTitle(enName, thName);
          posterUrl = tmdbResult.poster_path ? `${tmdb.TMDB_IMG}${tmdbResult.poster_path}` : rawPoster;
          seasonPosterUrl = posterUrl;
          tmdbShow = tmdbResult;

          const sNum = seasonNum || 1;
          const biData = await tmdb.getTmdbSeasonBilingual(tmdbResult.id, tmdbKey, sNum);
          tmdbEpisodes = isDubbedTrack ? biData.thEpisodes : biData.enEpisodes;
          if (biData.poster) seasonPosterUrl = biData.poster;
          tmdbSeasonName = biData.seasonName;
          seasonAirDate = biData.air_date || '';
          console.log(`✅ พบใน TMDB: "${seriesTitle}" (ID: ${tmdbResult.id}) — ${tmdbEpisodes.length} ตอน`);
        } else { console.warn('⚠️  ไม่พบใน TMDB'); }
      }
    }

    const slug = customOutput || utils.slugify(seriesTitle.replace(/\[.*?\]/g, '').replace(/\(.*?\)/g, '').trim()).toLowerCase();
    const slugFile = slug.endsWith('.txt') ? slug : `${slug}.txt`;
    const resolvedId = idPrefixArg || String(tmdbShow?.id || '');
    const outputFile = resolvedId ? `${resolvedId}-${slugFile}` : slugFile;
    const outputPath = path.resolve(PLAYLIST_DIR, outputFile);

    if (isMovieContent) {
      console.log('\n🔗 กำลัง fetch stream (movie)...');
      const first = mergedEps[0];
      const streamUrl = buildStreamUrl(first.slug);
      console.log(`  ✅ slug: ${first.slug}`);

      const partSeason = seasonNum || 1;
      const partPlaylist = io.buildPartFile({
        outputPath, season: partSeason, posterUrl, trackName,
        streamUrl, sourceUrl: urls[0],
      });
      const st = partPlaylist.stations.find(s => s.name === trackName);
      if (st) st.release_date = tmdbShow?.release_date || '';
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
      console.log(`\n🔗 กำลัง build streams (${mergedEps.length} ตอน)...`);
      const stations = [];
      for (let i = 0; i < mergedEps.length; i++) {
        const { slug: epSlug, epNum } = mergedEps[i];
        const streamUrl = buildStreamUrl(epSlug);
        const tmdbEp = tmdbEpisodes.find(e => e.episode_number === epNum) || tmdbEpisodes[i];
        const epTitle = tmdbEp?.name || '';
        const epThumb = tmdbEp?.still_path ? `${tmdb.TMDB_IMG}${tmdbEp.still_path}` : '';

        stations.push({
          name: utils.buildStationName(epNum, epTitle, isDubbedTrack),
          ...(epThumb && { image: epThumb }),
          url: streamUrl,
          referer: STATION_REFERER,
          release_date: tmdbEp?.air_date || '',
        });
        console.log(`  ตอน ${epNum}/${mergedEps.length} slug=${epSlug} ✅`);
      }

      const playlistSeasonNum = seasonNum || 1;
      const playlistSeasonName = seasonName || `Season ${playlistSeasonNum}`;
      const playlist = io.buildOrMergePlaylist({
        outputPath, seriesTitle, posterUrl, seasonPosterUrl, stations,
        trackName, trackReferer: urls[0], tmdbSeasonName,
        seasonName: playlistSeasonName, seasonNum: playlistSeasonNum, epOffset: 0,
      });
      io.markSeasonTrackComplete({ playlist, seasonName: playlistSeasonName, trackName, tmdbEpCount: tmdbEpisodes.length });
      if (seasonAirDate) {
        const affected = (playlist.groups || []).find(g => g.name === playlistSeasonName);
        if (affected) affected.release_date = seasonAirDate;
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
    if (!isMovieContent) console.log(`   จำนวนตอน: ${mergedEps.length}`);
  } catch (err) {
    console.error(`\n❌ Error: ${err.message}`);
    process.exit(1);
  }
}

main();

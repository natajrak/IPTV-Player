#!/usr/bin/env node
/**
 * fetch-kurokamii.js
 * สร้าง / อัปเดต playlist JSON จาก kurokamii.com พร้อม metadata จาก TMDB
 * Stream ผ่าน Cloudflare Worker proxy (CORS bypass)
 *
 * ─── หมายเหตุ ────────────────────────────────────────────────────────────
 *   - Stream ผ่าน CF Worker: https://shy-haze-2452.natajrak-p.workers.dev/
 *   - UUID มาจาก iframe akuma-player.xyz/play/{uuid}
 *   - Stream URL: files.akuma-player.xyz/view/{uuid}
 *   - Default --track = th (พากย์ไทย)
 *   - Shared logic อยู่ใน tools/lib/
 */

const fs = require('fs');
const path = require('path');

const { loadEnv } = require('./lib/env');
const { parseArgs } = require('./lib/cli');
const { makePaths } = require('./lib/type-config');
const utils = require('./lib/utils');
const tmdb = require('./lib/tmdb');
const io = require('./lib/playlist-io');
const { runUpdateMeta } = require('./lib/update-meta');
const { TRACK_MAP } = require('./lib/utils');

loadEnv(__dirname);

// kurokamii default track override: th (most content is dubbed)
const cli = parseArgs();
let { seriesUrl, tmdbKey, customOutput, mainSlugArg, idPrefixArg,
      seasonNum, seasonName, updateMeta, updateMetaMode, noTouch,
      forceTmdbId, tmdbSeasonNum, epOffset, typeArg, filterTrack } = cli;

// Override default: kurokamii defaults to พากย์ไทย if --track= not specified
let trackName = cli.trackName;
let isDubbedTrack = cli.isDubbedTrack;
if (!cli.trackArg) {
  trackName = 'พากย์ไทย';
  isDubbedTrack = true;
}
const epOffsetArg = cli.get('--ep-offset');

if (!seriesUrl && !updateMeta) {
  console.error('Usage: node fetch-kurokamii.js <url> [--track=th|subth] [--season=N] [--output=FILE]');
  console.error('       node fetch-kurokamii.js --update-meta[=poster|cover|title] [--season=N] --output=FILE.txt');
  process.exit(1);
}

const { isMovie, playlistDir: PLAYLIST_DIR, indexPath: INDEX_PATH, githubRawBase: GITHUB_RAW_BASE } =
  makePaths({ typeArg, scriptDir: __dirname });

const CF_PROXY = 'https://shy-haze-2452.natajrak-p.workers.dev/';
const PLAYER_REFERER = 'https://akuma-player.xyz/';
const STATION_REFERER = 'https://kurokamii.com/';

const HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120 Safari/537.36',
  'Accept-Language': 'th-TH,th;q=0.9,en;q=0.8',
  'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  'Referer': STATION_REFERER,
};

// ───── Source-specific: Inertia helpers ─────
async function fetchHtml(url) {
  const res = await fetch(url, { headers: HEADERS });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  return res.text();
}

async function getInertiaVersion(animeUrl) {
  const html = await fetchHtml(animeUrl);
  const m = html.match(/data-page='([^']+)'/) || html.match(/data-page="([^"]+)"/);
  if (!m) throw new Error('ไม่พบ data-page attribute — อาจไม่ใช่ Inertia app');
  const page = JSON.parse(m[1].replace(/&quot;/g, '"'));
  return page.version;
}

async function fetchInertia(url, version) {
  const res = await fetch(url, {
    headers: {
      ...HEADERS,
      'X-Inertia': 'true',
      'X-Inertia-Version': version,
      'X-Requested-With': 'XMLHttpRequest',
      'Accept': 'application/json, text/plain, */*',
    },
  });
  if (!res.ok) throw new Error(`Inertia HTTP ${res.status} for ${url}`);
  return res.json();
}

function buildStreamUrl(uuid) {
  const streamUrl = `https://files.akuma-player.xyz/view/${uuid}`;
  return `${CF_PROXY}?url=${encodeURIComponent(streamUrl)}&referer=${encodeURIComponent(PLAYER_REFERER)}`;
}

async function parseAnimePage(url) {
  console.log(`\n📄 กำลัง fetch หน้า anime: ${url}`);
  const version = await getInertiaVersion(url);
  console.log(`🔑 Inertia version: ${version}`);

  const data = await fetchInertia(url, version);
  const anime = data.props?.anime;
  if (!anime) throw new Error('ไม่พบ anime props ใน Inertia response');

  const title = anime.cat_title || '';
  const posterImg = anime.cat_image || anime.cover_md || '';
  const catId = anime.cat_id;

  const episodes = (anime.episode_list || []).map((ep) => ({
    url: `https://kurokamii.com/anime/${catId}/episode/${ep.list_id}`,
    epTitle: ep.list_title || '',
    listId: ep.list_id,
  }));
  episodes.sort((a, b) => a.listId - b.listId);
  console.log(`✅ พบ: "${title}" — ${episodes.length} ตอน`);
  return { title, posterImg, episodes, version };
}

async function getEpisodeUuid(epPageUrl, version) {
  const data = await fetchInertia(epPageUrl, version);
  const cur = data.props?.currentEpisode;
  if (!cur) throw new Error(`ไม่พบ currentEpisode ใน ${epPageUrl}`);
  const playerUrl = cur.player_url || '';
  const m = playerUrl.match(/akuma-player\.xyz\/play\/([a-f0-9-]+)/i)
         || (cur.uuid ? [null, cur.uuid] : null);
  if (!m) throw new Error(`ไม่พบ UUID ใน ${epPageUrl}`);
  return m[1];
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
    const urls = seriesUrl.split(',').map((u) => u.trim()).filter(Boolean);
    const isMultiUrl = urls.length > 1;
    let rawTitle = '', rawPoster = '';
    let episodes = [];
    let inertiaVersion = null;

    for (let ui = 0; ui < urls.length; ui++) {
      if (isMultiUrl) console.log(`\n📡 Fetch part ${ui + 1}/${urls.length}: ${urls[ui]}`);
      const result = await parseAnimePage(urls[ui]);
      if (ui === 0) { rawTitle = result.title; rawPoster = result.posterImg; inertiaVersion = result.version; }

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
          const tmdbName = utils.formatSeriesTitle(tmdbEnName, tmdbThName);
          const tmdbPoster = tmdbResult.poster_path ? `${tmdb.TMDB_IMG}${tmdbResult.poster_path}` : rawPoster;
          console.log(`✅ พบใน TMDB: "${tmdbName}" (ID: ${tmdbResult.id})`);
          tmdbShow = tmdbResult; seriesTitle = tmdbName; posterUrl = tmdbPoster;
        } else { console.warn('⚠️  ไม่พบใน TMDB ใช้ข้อมูลจาก kurokamii แทน'); }
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
          const tmdbName = utils.formatSeriesTitle(tmdbEnName, tmdbThName);
          const tmdbPoster = tmdbResult.poster_path ? `${tmdb.TMDB_IMG}${tmdbResult.poster_path}` : rawPoster;
          console.log(`✅ พบใน TMDB: "${tmdbName}" (ID: ${tmdbResult.id})`);
          tmdbShow = tmdbResult; seriesTitle = tmdbName; posterUrl = tmdbPoster; seasonPosterUrl = tmdbPoster;

          const lookupSeason = tmdbSeasonNum || seasonNum || 1;
          if (tmdbSeasonNum) console.log(`📌 ใช้ TMDB Season ${tmdbSeasonNum} (override)`);
          if (epOffset) console.log(`📌 EP Offset: +${epOffset}`);

          const biData = await tmdb.getTmdbSeasonBilingual(tmdbResult.id, tmdbKey, lookupSeason);
          tmdbEpisodes = isDubbedTrack ? biData.thEpisodes : biData.enEpisodes;
          if (biData.poster) seasonPosterUrl = biData.poster;
          tmdbSeasonName = biData.seasonName;
          seasonAirDate = biData.air_date || '';
          console.log(`✅ ดึงข้อมูล ${tmdbEpisodes.length} ตอน จาก TMDB`);
        } else { console.warn('⚠️  ไม่พบใน TMDB ใช้ข้อมูลจาก kurokamii แทน'); }
      }
    }

    console.log(`\n🔗 กำลัง fetch stream URLs (${episodes.length} ตอน)...`);
    const stations = [];

    for (let i = 0; i < episodes.length; i++) {
      const ep = episodes[i];
      const epNum = i + 1;
      process.stdout.write(`  ตอน ${epNum}/${episodes.length}...`);

      let streamUrl = null;
      try {
        const uuid = await getEpisodeUuid(ep.url, inertiaVersion);
        streamUrl = buildStreamUrl(uuid);
        process.stdout.write(` UUID: ${uuid}`);
      } catch (err) {
        console.warn(` ⚠️  ${err.message}`);
      }

      const tmdbEpNum = epNum + epOffset;
      const tmdbEp = tmdbEpisodes.find((e) => e.episode_number === tmdbEpNum) || tmdbEpisodes[i + epOffset];
      const epTitle = tmdbEp?.name || '';
      const epThumb = tmdbEp?.still_path ? `${tmdb.TMDB_IMG}${tmdbEp.still_path}` : '';
      const stationName = utils.buildStationName(epNum, epTitle, isDubbedTrack);

      stations.push({
        name: stationName,
        ...(epThumb && { image: epThumb }),
        url: streamUrl || ep.url,
        referer: STATION_REFERER,
        release_date: tmdbEp?.air_date || '',
      });

      console.log(' ✅');
      if (i < episodes.length - 1) await utils.sleep(800);
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
        streamUrl: s.url, sourceUrl: seriesUrl,
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
        trackName, trackReferer: seriesUrl, tmdbSeasonName,
        seasonName, seasonNum, epOffset,
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

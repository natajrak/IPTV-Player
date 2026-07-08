#!/usr/bin/env node
/**
 * fetch-anime-th.js
 * สร้าง / อัปเดต playlist JSON จาก anime-th.com พร้อม metadata จาก TMDB
 *
 * ─── หมายเหตุ ────────────────────────────────────────────────────────────
 *   - แหล่ง: anime-th.com (โครงสร้างใหม่ static HTML/JS + Tailwind — ไม่ใช่ WordPress + halim แล้ว)
 *   - 1 URL หน้า anime = 1 track (แยก URL สำหรับพากย์/ซับ)
 *   - --track=th|subth ใช้แค่ label output — user เลือก URL ตาม track เอง
 *   - Stream chain (3 layers):
 *       1. /watch/{OUTER}.html — episode page
 *       2. /base/{OUTER}/ — JS: `webmainapp + "playback/v/{INNER}/"` (extract INNER)
 *       3. streaming.tonytonychopper.com/playback/v/{INNER}/ — iframe src `anime.tonytonychopper.net/v[2]?/{PLAYER_ID}`
 *   - Stream URL: anime.tonytonychopper.net/file2/{PLAYER_ID}/ (v2) หรือ /file/{PLAYER_ID}/ (v)
 *   - ต้องผ่าน CF Worker proxy (HLS_PROXY_URL) — infra tonytonychopper ไม่มี CORS
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
let { seriesUrl, tmdbKey, customOutput, mainSlugArg, idPrefixArg,
      trackName, isDubbedTrack, seasonNum, seasonName,
      updateMeta, updateMetaMode, noTouch, forceTmdbId, tmdbSeasonNum,
      epOffset, typeArg, filterTrack } = cli;
const hlsProxy = (process.env.HLS_PROXY_URL || '').replace(/\/$/, '');
const epOffsetArg = cli.get('--ep-offset');

if (!seriesUrl && !updateMeta) {
  console.error('Usage: node fetch-anime-th.js <url> [--track=th|subth] [--season=N] [--output=FILE]');
  console.error('       node fetch-anime-th.js --update-meta[=poster|cover|title] [--season=N] [--track=th|subth] --output=FILE.txt');
  process.exit(1);
}

const { isMovie, playlistDir: PLAYLIST_DIR, indexPath: INDEX_PATH, githubRawBase: GITHUB_RAW_BASE } =
  makePaths({ typeArg, scriptDir: __dirname });

const SITE_BASE = 'https://anime-th.com';
const PLAYBACK_BASE = 'https://streaming.tonytonychopper.com';
const STATION_REFERER = `${SITE_BASE}/`;

const HEADERS = {
  'User-Agent':      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120 Safari/537.36',
  'Accept-Language': 'th-TH,th;q=0.9,en;q=0.8',
  'Accept':          'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  'Referer':         `${SITE_BASE}/`,
};

// ───── Source-specific helpers ─────
async function fetchText(url, extraHeaders = {}) {
  const res = await fetch(url, { headers: { ...HEADERS, ...extraHeaders } });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  return res.text();
}

// ───── Step 1: Parse anime page → title, poster, episode list ─────
/**
 * โครงสร้างใหม่:
 *   <a class="ep-item" href="/watch/{OUTER_HASH}.html" data-ep="0"> ตอนที่ 1 </a>
 *   data-ep = index 0-based → epNum = data-ep + 1
 */
async function parseAnimePage(url) {
  console.log(`\n📄 กำลัง fetch หน้า anime: ${url}`);
  const html = await fetchText(url);
  const $    = cheerio.load(html);

  const title = ($('h1').first().text()
    || $('meta[property="og:title"]').attr('content')
    || $('title').first().text().replace(/\s*-\s*Anime-TH\s*$/i, '')
    || '').trim();
  const posterImg = ($('meta[property="og:image"]').attr('content')
    || $('img[alt]').first().attr('src')
    || '').trim();

  const seen = new Set();
  const episodes = [];

  $('a.ep-item').each((_, el) => {
    const $el = $(el);
    const href = ($el.attr('href') || '').trim();
    if (!href || seen.has(href)) return;
    seen.add(href);

    const outerMatch = href.match(/\/watch\/([A-Za-z0-9]+)\.html/i);
    if (!outerMatch) return;
    const outerHash = outerMatch[1];

    const dataEp = parseInt($el.attr('data-ep') || '');
    const label = ($el.text() || '').trim();
    const epNumFromText = (label.match(/ตอนที่?\s*(\d+)/) || label.match(/episode\s*(\d+)/i) || [])[1];

    let epNum;
    if (!isNaN(dataEp)) epNum = dataEp + 1;
    else if (epNumFromText) epNum = parseInt(epNumFromText);
    else epNum = episodes.length + 1;

    episodes.push({ watchUrl: href, outerHash, epNum, label });
  });

  episodes.sort((a, b) => a.epNum - b.epNum);

  if (!title) throw new Error('ไม่พบ title — ตรวจสอบ URL อีกครั้ง');
  if (!episodes.length) throw new Error('ไม่พบ episode (a.ep-item) — เว็บอาจเปลี่ยน structure');

  console.log(`✅ พบ: "${title}" — ${episodes.length} ตอน`);
  return { title, posterImg, episodes };
}

// ───── Step 2: /base/{OUTER}/ → INNER hash ─────
async function getInnerHash(outerHash) {
  const url = `${SITE_BASE}/base/${outerHash}/`;
  const js = await fetchText(url, { Referer: `${SITE_BASE}/watch/${outerHash}.html` });
  const m = js.match(/playback\/v\/([A-Za-z0-9_-]+)\//);
  if (!m) throw new Error(`ไม่พบ INNER hash ใน /base/${outerHash}/`);
  return m[1];
}

// ───── Step 3: /playback/v/{INNER}/ → iframe → PLAYER_ID + version ─────
async function getPlayerInfo(innerHash) {
  const url = `${PLAYBACK_BASE}/playback/v/${innerHash}/`;
  const html = await fetchText(url, { Referer: `${SITE_BASE}/` });
  const m = html.match(/anime\.tonytonychopper\.net\/(v2?)\/([A-Za-z0-9_-]+)/i);
  if (!m) throw new Error(`ไม่พบ iframe player ใน /playback/v/${innerHash}/`);
  return { version: m[1], playerId: m[2] };
}

// ───── Combined: watch URL → stream URL + referer ─────
async function getStreamInfo(watchUrl, outerHashHint = null) {
  const outerHash = outerHashHint
    || (watchUrl.match(/\/watch\/([A-Za-z0-9]+)\.html/i) || [])[1];
  if (!outerHash) throw new Error(`extract OUTER hash ไม่ได้ จาก ${watchUrl}`);

  const innerHash = await getInnerHash(outerHash);
  const { version, playerId } = await getPlayerInfo(innerHash);
  const filePath = version === 'v2' ? 'file2' : 'file';
  return {
    streamUrl:     `https://anime.tonytonychopper.net/${filePath}/${playerId}/`,
    streamReferer: `https://anime.tonytonychopper.net/${version}/${playerId}`,
  };
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
    const { title: rawTitle, posterImg: rawPoster, episodes } = await parseAnimePage(seriesUrl);

    if (episodes.length === 0) {
      console.error('❌ ไม่พบ episode ใดเลย');
      process.exit(1);
    }

    // resolve playlist season (fallback = 1 — เว็บใหม่ไม่มี season selector)
    const playlistSeasonNum = seasonNum || 1;
    console.log(`📌 track: ${trackName} → playlist Season ${playlistSeasonNum}`);

    // TMDB lookup
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
        } else { console.warn('⚠️  ไม่พบใน TMDB ใช้ข้อมูลจาก anime-th แทน'); }
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

          const lookupSeason = tmdbSeasonNum || playlistSeasonNum;
          if (tmdbSeasonNum && tmdbSeasonNum !== playlistSeasonNum) {
            console.log(`📌 TMDB Season override: playlist Season ${playlistSeasonNum} → TMDB Season ${tmdbSeasonNum}`);
          }
          if (epOffset > 0) console.log(`📌 Episode offset: +${epOffset} (source ep 1 → TMDB ep ${epOffset + 1})`);

          const biData = await tmdb.getTmdbSeasonBilingual(tmdbResult.id, tmdbKey, lookupSeason);
          tmdbEpisodes = isDubbedTrack ? biData.thEpisodes : biData.enEpisodes;
          if (biData.poster) seasonPosterUrl = biData.poster;
          tmdbSeasonName = biData.seasonName;
          seasonAirDate = biData.air_date || '';
          console.log(`✅ ดึงข้อมูล ${tmdbEpisodes.length} ตอน (Season ${lookupSeason}, ${isDubbedTrack ? 'th-TH w/ EN fallback' : 'en-US'}) จาก TMDB`);
        } else { console.warn('⚠️  ไม่พบใน TMDB ใช้ข้อมูลจาก anime-th แทน'); }
      }
    } else { console.warn('⚠️  ไม่มี TMDB_API_KEY ข้าม TMDB lookup'); }

    // Fetch stream URLs
    console.log(`\n🔗 กำลัง fetch stream URLs (${episodes.length} ตอน)...`);
    const stations = [];

    for (let i = 0; i < episodes.length; i++) {
      const ep = episodes[i];
      const epNum = ep.epNum || (i + 1);
      process.stdout.write(`  ตอน ${epNum}/${episodes.length} (${ep.outerHash})...`);

      let streamUrl = null, streamReferer = null;
      try {
        const info = await getStreamInfo(ep.watchUrl, ep.outerHash);
        streamUrl = info.streamUrl;
        streamReferer = info.streamReferer;
        process.stdout.write(' ✅\n');
      } catch (err) { console.warn(` ⚠️  ${err.message}`); }

      const tmdbEpNum = epNum + epOffset;
      const tmdbEp = tmdbEpisodes.find((e) => e.episode_number === tmdbEpNum);
      const epTitle = tmdbEp?.name || '';
      const epThumb = tmdbEp?.still_path ? `${tmdb.TMDB_IMG}${tmdbEp.still_path}` : '';

      let finalUrl = streamUrl || ep.watchUrl;
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

    // Build / save playlist
    const slug = customOutput || utils.slugify(seriesTitle.replace(/\[.*?\]/g, '').replace(/\(.*?\)/g, '').trim());
    const slugFile = slug.endsWith('.txt') ? slug : `${slug}.txt`;
    const resolvedIdPrefix = idPrefixArg || String(tmdbShow?.id || '');
    const outputFile = resolvedIdPrefix ? `${resolvedIdPrefix}-${slugFile}` : slugFile;
    const outputPath = path.resolve(PLAYLIST_DIR, outputFile);

    if (isMovie) {
      const s = stations[0];
      if (!s) { console.error('❌ ไม่พบ stream URL'); process.exit(1); }
      const partPlaylist = io.buildPartFile({
        outputPath, season: playlistSeasonNum, posterUrl, trackName,
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
        partFileRawUrl: partRawUrl, season: playlistSeasonNum,
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
      const playlistSeasonName = seasonName || `Season ${playlistSeasonNum}`;
      const playlist = io.buildOrMergePlaylist({
        outputPath, seriesTitle, posterUrl, seasonPosterUrl, stations,
        trackName, trackReferer: seriesUrl, tmdbSeasonName,
        seasonName: playlistSeasonName, seasonNum: playlistSeasonNum, epOffset,
      });
      io.markSeasonTrackComplete({ playlist, seasonName: playlistSeasonName, trackName, tmdbEpCount: tmdbEpisodes.length });
      if (seasonAirDate) {
        const affectedSeason = (playlist.groups || []).find((g) => g.name === playlistSeasonName);
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

#!/usr/bin/env node
/**
 * fetch-1112hdss.js
 * สร้าง / อัปเดต playlist JSON จาก 1112hdss.com พร้อม metadata จาก TMDB
 *
 * ─── โครงสร้างเว็บ ───────────────────────────────────────────────────────
 *   - WordPress + custom theme + Tailwind
 *   - ทุก ep + embed URL ฝังใน `window.cjPlayerMeta` บนหน้า anime (ไม่ต้อง AJAX!)
 *     cjPlayerMeta.series.videos.{th|sub}.list.ep_N.server_1.url = "online225.com/player/index.php?data={HASH}"
 *   - embed URL → MASPlayer config (pattern เดียวกับ gg-animes):
 *       MASPlayer(vhash, { hostList, videoUrl, videoServer, videoDisk, ... })
 *   - Stream URL: https://online225.com{videoUrl}?s={videoServer}&d={btoa(videoDisk||", ")}
 *   - CDN เปิด CORS `*` แต่ต้องผ่าน CF Worker proxy เพื่อ rewrite segments
 *
 * ─── Flags ───────────────────────────────────────────────────────────────
 *   <url>              URL หน้า 1112hdss.com (comma-separated)
 *   --track=th|subth   th = พากย์ไทย, subth = ซับไทย (default: subth)
 *   --season=N         default: 1
 *   --output=FILE
 *   --tmdb-id=N
 *   --update-meta[=poster|cover|title]
 *   --split-eps=N,M:k TMDB ตอน N ถูกเว็บแบ่งเป็น 2 ตอน (M:k = แบ่ง k ตอน)
 *                     ชื่อออกเป็น "ตอน N (1/2)" และตอนถัดไปเลขตาม TMDB ไม่ drift
 *                     (flag นี้ assume เว็บลิสต์ตอนของ season เรียงต่อเนื่องครบ)
 *   --auto-split      ตรวจจับตอนพิเศษเองจาก runtime ของ TMDB — ใช้เมื่อจำนวนตอน
 *                     ลงตัวเป๊ะเท่านั้น (ถ้าใส่ --split-eps เองจะใช้ค่าที่ใส่)
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
const { buildEpisodeMap, applyMeasuredSplit } = require('./lib/episode-map');

loadEnv(__dirname);

const cli = parseArgs();
let { seriesUrl, tmdbKey, customOutput, mainSlugArg, idPrefixArg,
      trackName, isDubbedTrack, seasonNum, seasonName,
      updateMeta, updateMetaMode, noTouch,
      forceTmdbId, splitEps, autoSplit, typeArg, filterTrack } = cli;

if (!seriesUrl && !updateMeta) {
  console.error('Usage: node fetch-1112hdss.js <url>[,url2,...] [--track=th|subth] [--season=N] [--output=FILE]');
  console.error('       node fetch-1112hdss.js --update-meta[=poster|cover|title] --output=FILE.txt');
  process.exit(1);
}

const SITE_ORIGIN = 'https://1112hdss.com';
const PLAYER_HOST = 'online225.com';
const STREAM_REFERER = `https://${PLAYER_HOST}/`;
const CF_PROXY = 'https://shy-haze-2452.natajrak-p.workers.dev/';

function proxyUrl(streamUrl, referer) {
  return `${CF_PROXY}?url=${encodeURIComponent(streamUrl)}&referer=${encodeURIComponent(referer)}`;
}

const BASE_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
  'Accept-Language': 'th-TH,th;q=0.9,en;q=0.8',
  'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
};

// ───── Source-specific HTTP helpers ─────
async function fetchText(url, extraHeaders = {}) {
  const res = await fetch(url, { headers: { ...BASE_HEADERS, ...extraHeaders } });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  return res.text();
}

// ───── Balanced-brace JSON extractor (สำหรับ cjPlayerMeta = {...}) ─────
function extractJsonObject(text, start) {
  if (text[start] !== '{') return null;
  let depth = 0, inStr = false, esc = false;
  for (let i = start; i < text.length; i++) {
    const c = text[i];
    if (esc) { esc = false; continue; }
    if (inStr) {
      if (c === '\\') esc = true;
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') inStr = true;
    else if (c === '{') depth++;
    else if (c === '}') { depth--; if (depth === 0) return text.substring(start, i + 1); }
  }
  return null;
}

// ───── Parse anime page → cjPlayerMeta ─────
async function parseAnimePage(url) {
  console.log(`\n📄 กำลัง fetch หน้า: ${url}`);
  const html = await fetchText(url, { Referer: SITE_ORIGIN + '/' });
  const $ = cheerio.load(html);

  // Extract window.cjPlayerMeta = {...}
  const metaStart = html.indexOf('cjPlayerMeta');
  if (metaStart < 0) throw new Error('ไม่พบ cjPlayerMeta ใน HTML');
  const braceStart = html.indexOf('{', metaStart);
  const jsonStr = extractJsonObject(html, braceStart);
  if (!jsonStr) throw new Error('extract cjPlayerMeta object ไม่สำเร็จ');

  let meta;
  try { meta = JSON.parse(jsonStr); }
  catch (e) { throw new Error(`cjPlayerMeta JSON parse: ${e.message}`); }

  // Title + poster from OG tags
  const rawTitle = ($('meta[property="og:title"]').attr('content') || $('h1').first().text() || '').trim();
  const rawPoster = ($('meta[property="og:image"]').attr('content') || '').trim();

  // Detect type + episodes
  const contentType = meta.type; // "series" หรือ "movie"
  return { rawTitle, rawPoster, cjMeta: meta, contentType };
}

// เลือก episodes ตาม track (th/sub) → list ของ { epNum, embedUrl }
function pickEpisodes(cjMeta, trackKey, contentType) {
  const trackVideos = cjMeta[contentType === 'movie' ? 'movies' : 'series']?.videos?.[trackKey];
  if (!trackVideos) return [];

  // Movie: array of {url,type}. Series: {list: {ep_N: {server_1: {url,type}}}}
  if (contentType === 'movie') {
    const arr = Array.isArray(trackVideos) ? trackVideos : (trackVideos.list ? Object.values(trackVideos.list) : []);
    return arr.filter(v => v && (v.url || v.server_1?.url))
      .map((v, i) => ({ epNum: i + 1, embedUrl: v.url || v.server_1.url, embedType: v.type || v.server_1?.type }));
  }

  // Series
  const list = trackVideos.list || {};
  return Object.entries(list)
    .map(([epKey, servers]) => {
      const s1 = servers.server_1 || Object.values(servers)[0];
      const m = epKey.match(/ep[_\-]?(\d+)/i);
      const epNum = m ? parseInt(m[1], 10) : null;
      return epNum ? { epNum, embedUrl: s1?.url, embedType: s1?.type } : null;
    })
    .filter(x => x && x.embedUrl)
    .sort((a, b) => a.epNum - b.epNum);
}

// ───── Resolve embed URL → stream URL (MASPlayer pattern) ─────
async function getStreamUrl(embedUrl) {
  const html = await fetchText(embedUrl, { Referer: SITE_ORIGIN + '/' });
  const callMatch = html.match(/MASPlayer\s*\([^,]+,\s*/);
  if (!callMatch) throw new Error(`ไม่พบ MASPlayer ใน embed ${embedUrl}`);
  const objStart = callMatch.index + callMatch[0].length;
  const jsonStr = extractJsonObject(html, objStart);
  if (!jsonStr) throw new Error(`extract MASPlayer config ไม่ได้`);
  let cfg;
  try { cfg = JSON.parse(jsonStr); }
  catch (e) { throw new Error(`MASPlayer JSON parse: ${e.message}`); }

  const { videoUrl, videoServer, videoDisk } = cfg;
  if (!videoUrl || !videoServer) throw new Error('ขาด videoUrl/videoServer ใน MASPlayer config');

  // btoa(videoDisk || ", ") — pattern เดียวกับ gg-animes
  const dParam = Buffer.from(videoDisk ? String(videoDisk) : ', ', 'utf-8').toString('base64');
  // &v=2 cache-buster — CDN บาง edge return empty body ตอน hit cache stale ที่ CF Worker
  return `https://${PLAYER_HOST}${videoUrl}?s=${videoServer}&d=${dParam}&v=2`;
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
    let contentType = 'series';
    let mergedEps = [];

    const trackKey = cli.trackArg === 'th' ? 'th' : (cli.trackArg === 'subth' ? 'sub' : 'sub');

    for (let ui = 0; ui < urls.length; ui++) {
      if (isMultiUrl) console.log(`\n📡 Fetch part ${ui + 1}/${urls.length}: ${urls[ui]}`);
      const { rawTitle: t, rawPoster: p, cjMeta, contentType: ct } = await parseAnimePage(urls[ui]);
      if (ui === 0) { rawTitle = t; rawPoster = p; contentType = ct; }

      const eps = pickEpisodes(cjMeta, trackKey, ct);
      if (!eps.length) {
        console.warn(`⚠️  ไม่พบ ep ใน track "${trackKey}" — ลอง fallback ${trackKey === 'th' ? 'sub' : 'th'}`);
        const fallback = pickEpisodes(cjMeta, trackKey === 'th' ? 'sub' : 'th', ct);
        eps.push(...fallback);
      }

      const offset = mergedEps.length;
      for (const ep of eps) {
        mergedEps.push({ epNum: offset > 0 ? offset + ep.epNum : ep.epNum, embedUrl: ep.embedUrl });
      }
      console.log(`✅ พบ ${eps.length} ตอน (track=${trackKey})${isMultiUrl ? ` — รวม ${mergedEps.length}` : ''}`);
    }

    if (mergedEps.length === 0) {
      console.error('❌ ไม่พบ episode ใดเลย');
      process.exit(1);
    }

    const isMoviePage = contentType === 'movie';
    const detectedType = isMoviePage ? 'movie' : 'series';
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

    const slug = customOutput || utils.slugify(seriesTitle.replace(/\[.*?\]/g, '').replace(/\(.*?\)/g, '').trim());
    const slugFile = slug.endsWith('.txt') ? slug : `${slug}.txt`;
    const resolvedId = idPrefixArg || String(tmdbShow?.id || '');
    const outputFile = resolvedId ? `${resolvedId}-${slugFile}` : slugFile;
    const outputPath = path.resolve(PLAYLIST_DIR, outputFile);

    if (isMovieContent) {
      console.log('\n🔗 กำลัง fetch stream (movie)...');
      const streamUrl = proxyUrl(await getStreamUrl(mergedEps[0].embedUrl), STREAM_REFERER);
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
      console.log(`\n🔗 กำลัง fetch streams (${mergedEps.length} ตอน)...`);
      const stations = [];
      let resolvedSplitEps = splitEps;
      const splitMap = resolvedSplitEps ? buildEpisodeMap({ sourceCount: mergedEps.length, epOffset: 0, splitEps: resolvedSplitEps }) : null;

      for (let i = 0; i < mergedEps.length; i++) {
        const { epNum, embedUrl } = mergedEps[i];
        const mapped = splitMap ? splitMap[i] : null;
        const tmdbEpNum = mapped ? mapped.epNum : epNum;
        const epLabel = mapped ? mapped.label : epNum;
        process.stdout.write(`  ตอน ${epNum}/${mergedEps.length}...`);

        let streamUrl = null;
        try {
          const raw = await getStreamUrl(embedUrl);
          streamUrl = proxyUrl(raw, STREAM_REFERER);
          const hashMatch = raw.match(/\/hls\/([a-f0-9]+)/);
          process.stdout.write(` ${hashMatch ? hashMatch[1].substring(0, 8) + '…' : 'ok'} ✅\n`);
        } catch (err) {
          process.stdout.write(` ⚠️  ${err.message}\n`);
        }

        const tmdbEp = tmdbEpisodes.find(e => e.episode_number === tmdbEpNum) || (mapped ? tmdbEpisodes[tmdbEpNum - 1] : tmdbEpisodes[i]);
        const epTitle = tmdbEp?.name || '';
        const epThumb = tmdbEp?.still_path ? `${tmdb.TMDB_IMG}${tmdbEp.still_path}` : '';

        stations.push({
          name: utils.buildStationName(epLabel, epTitle, isDubbedTrack),
          ...(epThumb && { image: epThumb }),
          url: streamUrl || embedUrl,
          referer: STREAM_REFERER,
          release_date: tmdbEp?.air_date || '',
        });

        if (i < mergedEps.length - 1) await utils.sleep(500);
      }

      if (autoSplit && !splitEps) {
        resolvedSplitEps = await applyMeasuredSplit({ stations, tmdbEpisodes, epOffset: 0, isDubbedTrack });
      }

      const playlist = io.buildOrMergePlaylist({
        outputPath, seriesTitle, posterUrl, seasonPosterUrl, stations,
        trackName, trackReferer: urls[0], tmdbSeasonName,
        seasonName, seasonNum, epOffset: 0, splitEps: resolvedSplitEps,
      });
      io.markSeasonTrackComplete({ playlist, seasonName, trackName, tmdbEpCount: tmdbEpisodes.length });
      if (seasonAirDate) {
        const targetSeasonName = seasonName || 'Season 1';
        const affected = (playlist.groups || []).find(g => utils.matchesSeasonName(g.name, targetSeasonName));
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
  } catch (err) {
    console.error(`\n❌ Error: ${err.message}`);
    process.exit(1);
  }
}

main();

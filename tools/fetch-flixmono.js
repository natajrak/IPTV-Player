#!/usr/bin/env node
/**
 * fetch-flixmono.js
 * สร้าง / อัปเดต playlist JSON จาก flixmono.com พร้อม metadata จาก TMDB
 * Stream ผ่าน WordPress custom theme "serie-block" → admin-ajax.php → torbo007.com
 *
 * ─── โครงสร้างเว็บ ───────────────────────────────────────────────────────
 *   - Anime page มี <select id="season-select"> + <div id="season-{sid}"> ห่อ ep list
 *     <span episode-id="619" title="... ซีซั่น N ตอนที่ M">
 *   - AJAX: POST /wp-admin/admin-ajax.php?action=mix_get_player&post_id={episode-id}
 *     Response JSON: { success, player: { data: { th-sound|soundtrack: [{url:"torbo007/embed/{HASH}"}] }, primary } }
 *   - Extract HASH → build stream URL: https://torbo007.com/api/stream/{HASH}/index.m3u8
 *   - CDN เปิด CORS `*` → เล่นตรงได้ ไม่ต้อง CF Worker proxy
 *
 * ─── Flags ───────────────────────────────────────────────────────────────
 *   <url>              URL flixmono.com (comma-separated รองรับ)
 *   --track=th|subth   default: subth
 *   --season=N         default: 1
 *   --output=FILE
 *   --tmdb-id=N
 *   --update-meta[=poster|cover|title]
 *   --split-eps=N,M:k  TMDB ตอน N ถูกเว็บแบ่งเป็น 2 ตอน (M:k = แบ่ง k ตอน)
 *                      ชื่อออกเป็น "ตอน N (1/2)" และตอนถัดไปเลขตาม TMDB ไม่ drift
 *                      (flag นี้ assume เว็บลิสต์ตอนของ season เรียงต่อเนื่องครบ)
 *   --auto-split       ตรวจจับตอนพิเศษเองจาก runtime ของ TMDB — ใช้เมื่อจำนวนตอน
 *                      ลงตัวเป๊ะเท่านั้น (ถ้าใส่ --split-eps เองจะใช้ค่าที่ใส่)
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
  console.error('Usage: node fetch-flixmono.js <url>[,url2,...] [--track=th|subth] [--season=N] [--output=FILE]');
  console.error('       node fetch-flixmono.js --update-meta[=poster|cover|title] --output=FILE.txt');
  process.exit(1);
}

const SITE_ORIGIN = 'https://flixmono.com';
const AJAX_URL = `${SITE_ORIGIN}/wp-admin/admin-ajax.php`;
const TORBO_HOST = 'torbo007.com';
const ONLINE225_HOST = 'online225.com';
const STATION_REFERER = `${SITE_ORIGIN}/`;
// CDN ตรวจ Referer — ต้อง `https://{embed_host}/*` เท่านั้น จึงต้องผ่าน CF Worker proxy
const CF_PROXY = 'https://shy-haze-2452.natajrak-p.workers.dev/';
function proxyUrl(streamUrl, referer) {
  return `${CF_PROXY}?url=${encodeURIComponent(streamUrl)}&referer=${encodeURIComponent(referer)}`;
}

// Balanced-brace JSON extractor (สำหรับ MASPlayer config)
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

// --track=th → API key "th-sound" (พากย์ไทย)
// --track=subth → "soundtrack" (ซับไทย)
const TRACK_KEY_MAP = { th: 'th-sound', subth: 'soundtrack' };

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

async function postAjax(episodeId) {
  const body = new URLSearchParams({ action: 'mix_get_player', post_id: String(episodeId) }).toString();
  const res = await fetch(AJAX_URL, {
    method: 'POST',
    headers: {
      ...BASE_HEADERS,
      'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
      'X-Requested-With': 'XMLHttpRequest',
      'Referer': SITE_ORIGIN + '/',
      'Origin': SITE_ORIGIN,
    },
    body,
  });
  if (!res.ok) throw new Error(`mix_get_player HTTP ${res.status} (ep=${episodeId})`);
  return res.json();
}

// ───── Parse anime page ─────
async function parseAnimePage(url) {
  console.log(`\n📄 กำลัง fetch หน้า: ${url}`);
  const html = await fetchPage(url);
  const $ = cheerio.load(html);

  // Title + poster
  const rawTitle = ($('meta[property="og:title"]').attr('content')
    || $('h1').first().text()
    || $('title').text().replace(/\s*(?:ดูซีรีย์|ดูหนัง)\s*/g, '').trim()).trim();
  const rawPoster = ($('meta[property="og:image"]').attr('content') || '').trim();

  // Seasons (select#season-select) — each option: <option value="{seasonId}">ซีซั่น N</option>
  const seasons = [];
  $('select#season-select option').each((_, el) => {
    const $el = $(el);
    const value = ($el.attr('value') || '').trim();
    const label = ($el.text() || '').trim();
    if (!value) return;
    const sMatch = label.match(/ซีซั่น\s*(\d+)/i) || label.match(/season\s*(\d+)/i);
    seasons.push({ seasonId: value, seasonNum: sMatch ? parseInt(sMatch[1], 10) : null, label });
  });

  // Episodes ต่อ season — <span episode-id="N"> inside <div id="season-{sid}">
  const seasonEpsMap = new Map();
  $('div[id^="season-"]').each((_, el) => {
    const $el = $(el);
    const idAttr = ($el.attr('id') || '');
    const sMatch = idAttr.match(/^season-(\d+)/);
    if (!sMatch) return;
    const seasonId = sMatch[1];
    const eps = [];
    $el.find('[episode-id]').each((_, epEl) => {
      const $ep = $(epEl);
      const epId = ($ep.attr('episode-id') || '').trim();
      const titleAttr = ($ep.attr('title') || '').trim();
      // "House of the Dragon ซีซั่น 1 ตอนที่ 1"
      const epNumMatch = titleAttr.match(/ตอนที่\s*(\d+)/) || $ep.text().match(/ตอนที่\s*(\d+)/);
      const epNum = epNumMatch ? parseInt(epNumMatch[1], 10) : (eps.length + 1);
      if (epId) eps.push({ epId, epNum, titleAttr });
    });
    eps.sort((a, b) => a.epNum - b.epNum);
    if (eps.length > 0) seasonEpsMap.set(seasonId, eps);
  });

  if (!rawTitle) throw new Error('ไม่พบ title — ตรวจสอบ URL');
  return { rawTitle, rawPoster, seasons, seasonEpsMap };
}

// เลือก season จาก seasonNum (--season) หรือ default = first
function pickSeason(parsed, seasonNumArg) {
  const { seasons, seasonEpsMap } = parsed;
  if (seasons.length === 0) throw new Error('ไม่พบ season option ในหน้า');
  let chosen;
  if (seasonNumArg != null) {
    chosen = seasons.find(s => s.seasonNum === seasonNumArg);
    if (!chosen) {
      throw new Error(`ไม่พบ Season ${seasonNumArg} — มี: ${seasons.map(s => s.label).join(', ')}`);
    }
  } else {
    chosen = seasons[0];
  }
  const eps = seasonEpsMap.get(chosen.seasonId) || [];
  return { chosen, eps };
}

// ───── AJAX → embed URL → stream URL ─────
async function getEmbedUrl(episodeId, trackKey) {
  const json = await postAjax(episodeId);
  if (!json?.success) throw new Error('mix_get_player success=false');
  const data = json?.player?.data || {};
  let arr = data[trackKey];
  if (!arr || !Array.isArray(arr) || arr.length === 0) {
    const available = Object.keys(data);
    if (available.length === 0) throw new Error('ไม่พบ track ใดใน player.data');
    const fb = available[0];
    console.warn(` (ไม่มี ${trackKey} → ใช้ ${fb})`);
    arr = data[fb];
  }
  const first = arr[0];
  if (!first?.url) throw new Error('ไม่พบ url ใน track array');
  return first.url;
}

// Resolve embed URL → { streamUrl, streamReferer }
// flixmono มี 2 embed hosts:
//   1. torbo007.com/embed/{HASH} → direct API URL (api/stream/{HASH}/index.m3u8)
//   2. online225.com/player/index.php?data={HASH} → MASPlayer chain
async function resolveEmbed(embedUrl) {
  let host;
  try { host = new URL(embedUrl).hostname; }
  catch { throw new Error(`invalid embed URL: ${embedUrl}`); }

  if (host.includes(TORBO_HOST)) {
    const hMatch = embedUrl.match(/\/embed\/([a-f0-9]{20,})/i);
    if (!hMatch) throw new Error(`torbo007: extract hash ไม่ได้ (${embedUrl})`);
    const hash = hMatch[1];
    return {
      streamUrl: `https://${TORBO_HOST}/api/stream/${hash}/index.m3u8`,
      streamReferer: `https://${TORBO_HOST}/embed/${hash}`,
      hashPreview: hash.substring(0, 8),
    };
  }

  if (host.includes(ONLINE225_HOST)) {
    // Fetch embed page → parse MASPlayer config (เหมือน fetch-1112hdss.js)
    const html = await fetchPage(embedUrl);
    const callMatch = html.match(/MASPlayer\s*\([^,]+,\s*/);
    if (!callMatch) throw new Error(`online225: ไม่พบ MASPlayer ใน ${embedUrl}`);
    const objStart = callMatch.index + callMatch[0].length;
    const jsonStr = extractJsonObject(html, objStart);
    if (!jsonStr) throw new Error(`online225: extract MASPlayer config ไม่ได้`);
    let cfg;
    try { cfg = JSON.parse(jsonStr); }
    catch (e) { throw new Error(`online225: JSON parse: ${e.message}`); }
    const { videoUrl, videoServer, videoDisk } = cfg;
    if (!videoUrl || !videoServer) throw new Error('online225: ขาด videoUrl/videoServer');
    const dParam = Buffer.from(videoDisk ? String(videoDisk) : ', ', 'utf-8').toString('base64');
    const hashMatch = videoUrl.match(/\/hls\/([a-f0-9]+)/);
    return {
      // &v=2 cache-buster — pattern เดียวกับ gg-animes / 1112hdss
      streamUrl: `https://${ONLINE225_HOST}${videoUrl}?s=${videoServer}&d=${dParam}&v=2`,
      streamReferer: `https://${ONLINE225_HOST}/`,
      hashPreview: (hashMatch ? hashMatch[1] : '?').substring(0, 8),
    };
  }

  throw new Error(`embed host ไม่รู้จัก: ${host} — รองรับเฉพาะ ${TORBO_HOST}, ${ONLINE225_HOST}`);
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
    let chosenSeasonNum = null;

    for (let ui = 0; ui < urls.length; ui++) {
      if (isMultiUrl) console.log(`\n📡 Fetch part ${ui + 1}/${urls.length}: ${urls[ui]}`);
      const parsed = await parseAnimePage(urls[ui]);
      const { chosen, eps } = pickSeason(parsed, seasonNum);
      if (ui === 0) {
        rawTitle = parsed.rawTitle;
        rawPoster = parsed.rawPoster;
        chosenSeasonNum = chosen.seasonNum || 1;
      }
      console.log(`✅ Season "${chosen.label}" — ${eps.length} ตอน`);
      const offset = mergedEps.length;
      for (const ep of eps) {
        mergedEps.push({ epId: ep.epId, epNum: offset > 0 ? offset + ep.epNum : ep.epNum });
      }
      if (isMultiUrl) console.log(`  รวม ${mergedEps.length} ตอน`);
    }

    if (mergedEps.length === 0) {
      console.error('❌ ไม่พบ episode ใดเลย');
      process.exit(1);
    }

    const playlistSeasonNum = seasonNum || chosenSeasonNum || 1;
    const trackKey = TRACK_KEY_MAP[cli.trackArg === 'th' ? 'th' : 'subth'];
    console.log(`📌 track: ${trackName} → API key "${trackKey}" | playlist Season ${playlistSeasonNum}`);

    const effectiveTypeArg = typeArg || 'series';
    const { isMovie: isMovieContent, playlistDir: PLAYLIST_DIR, indexPath: INDEX_PATH, githubRawBase: GITHUB_RAW_BASE } =
      makePaths({ typeArg: effectiveTypeArg, scriptDir: __dirname, defaultType: 'series' });
    console.log(`📂 ประเภท: ${effectiveTypeArg}`);

    // TMDB lookup
    let seriesTitle = rawTitle;
    let posterUrl = rawPoster;
    let seasonPosterUrl = rawPoster;
    let tmdbEpisodes = [];
    let tmdbSeasonName = null;
    let tmdbShow = null;
    let seasonAirDate = '';

    if (tmdbKey && !isMovieContent) {
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

        const biData = await tmdb.getTmdbSeasonBilingual(tmdbResult.id, tmdbKey, playlistSeasonNum);
        tmdbEpisodes = isDubbedTrack ? biData.thEpisodes : biData.enEpisodes;
        if (biData.poster) seasonPosterUrl = biData.poster;
        tmdbSeasonName = biData.seasonName;
        seasonAirDate = biData.air_date || '';
        console.log(`✅ พบใน TMDB: "${seriesTitle}" (ID: ${tmdbResult.id}) — ${tmdbEpisodes.length} ตอน`);
      } else { console.warn('⚠️  ไม่พบใน TMDB'); }
    }

    // Fetch streams
    console.log(`\n🔗 กำลัง fetch streams (${mergedEps.length} ตอน)...`);
    const stations = [];
    let resolvedSplitEps = splitEps;
    const splitMap = resolvedSplitEps ? buildEpisodeMap({ sourceCount: mergedEps.length, epOffset: 0, splitEps: resolvedSplitEps }) : null;
    for (let i = 0; i < mergedEps.length; i++) {
      const { epId, epNum } = mergedEps[i];
      const mapped = splitMap ? splitMap[i] : null;
      const tmdbEpNum = mapped ? mapped.epNum : epNum;
      const epLabel = mapped ? mapped.label : epNum;
      process.stdout.write(`  ตอน ${epNum}/${mergedEps.length} (id=${epId})...`);

      let streamUrl = null;
      try {
        const embedUrl = await getEmbedUrl(epId, trackKey);
        const { streamUrl: raw, streamReferer, hashPreview } = await resolveEmbed(embedUrl);
        // wrap CF Worker proxy — CDN บล็อก referer อื่น
        streamUrl = proxyUrl(raw, streamReferer);
        process.stdout.write(` ${hashPreview}… ✅\n`);
      } catch (err) {
        process.stdout.write(` ⚠️  ${err.message}\n`);
      }

      const tmdbEp = tmdbEpisodes.find(e => e.episode_number === tmdbEpNum) || (mapped ? tmdbEpisodes[tmdbEpNum - 1] : tmdbEpisodes[i]);
      const epTitle = tmdbEp?.name || '';
      const epThumb = tmdbEp?.still_path ? `${tmdb.TMDB_IMG}${tmdbEp.still_path}` : '';

      stations.push({
        name: utils.buildStationName(epLabel, epTitle, isDubbedTrack),
        ...(epThumb && { image: epThumb }),
        url: streamUrl || urls[0],
        referer: STATION_REFERER,
        release_date: tmdbEp?.air_date || '',
      });

      if (i < mergedEps.length - 1) await utils.sleep(500);
    }

    if (autoSplit && !splitEps) {
      resolvedSplitEps = await applyMeasuredSplit({ stations, tmdbEpisodes, epOffset: 0, isDubbedTrack });
    }

    // Build / save playlist
    const slug = customOutput || utils.slugify(seriesTitle.replace(/\[.*?\]/g, '').replace(/\(.*?\)/g, '').trim());
    const slugFile = slug.endsWith('.txt') ? slug : `${slug}.txt`;
    const resolvedId = idPrefixArg || String(tmdbShow?.id || '');
    const outputFile = resolvedId ? `${resolvedId}-${slugFile}` : slugFile;
    const outputPath = path.resolve(PLAYLIST_DIR, outputFile);

    const playlistSeasonName = seasonName || `Season ${playlistSeasonNum}`;
    const playlist = io.buildOrMergePlaylist({
      outputPath, seriesTitle, posterUrl, seasonPosterUrl, stations,
      trackName, trackReferer: urls[0], tmdbSeasonName,
      seasonName: playlistSeasonName, seasonNum: playlistSeasonNum, epOffset: 0, splitEps: resolvedSplitEps,
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

    console.log('\n🎉 เสร็จสิ้น!');
    console.log(`   ไฟล์: ${outputFile}`);
    console.log(`   จำนวนตอน: ${stations.length}`);
  } catch (err) {
    console.error(`\n❌ Error: ${err.message}`);
    process.exit(1);
  }
}

main();

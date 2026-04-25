#!/usr/bin/env node
/**
 * fetch-037hdd.js
 * สร้าง / อัปเดต playlist JSON จาก 037hddmovie.com พร้อม metadata จาก TMDB
 *
 * ─── Flags ───────────────────────────────────────────────────────────────
 *   <url>              URL หน้าหนังบน 037hddmovie.com
 *                      เช่น https://www.037hddmovie.com/2016/09/22/tron-legacy-2010-.../
 *   --track=th|subth   th = พากย์ไทย, subth = ซับไทย (default: th)
 *   --season=N         ระบุ season/ภาค (default: 1)
 *   --output=FILE      ชื่อไฟล์ผลลัพธ์ (ไม่ต้องใส่ path)
 *   --tmdb-key=KEY     TMDB API key (ถ้าไม่ใส่จะอ่านจาก .env)
 *   --tmdb-id=N        ระบุ TMDB ID ตรงๆ
 *   --type=TYPE        anime-series|anime-movie|movie|series (default: movie)
 *   --update-meta[=poster|cover|title]
 *                      อัปเดต metadata จาก TMDB โดยไม่ fetch stream URLs ใหม่
 *
 * ─── Workflow ────────────────────────────────────────────────────────────
 *   Movie:
 *     page → iframe leoplayer7.com/watch?v={id} → API /api/analogy/mediahls3/{id} → hash
 *     stream: https://master.streamhls.com/hls/{hash}/master
 *
 *   Series:
 *     series page → episode links → each episode page → iframe → API → hash
 *
 * ─── Stream URL Pattern ──────────────────────────────────────────────────
 *   leoplayer7 API → hash → https://master.streamhls.com/hls/{hash}/master
 *   ไม่มี token/expiry — URL ถาวร
 */

const cheerio = require("cheerio");
const fs      = require("fs");
const path    = require("path");

// ───── Load .env ─────
const envPath = fs.existsSync(path.resolve(__dirname, ".env"))
  ? path.resolve(__dirname, ".env")
  : path.resolve(__dirname, "../.env");
if (fs.existsSync(envPath)) {
  fs.readFileSync(envPath, "utf-8").split("\n").forEach((line) => {
    const [key, ...val] = line.trim().split("=");
    if (key && !process.env[key]) process.env[key] = val.join("=").trim().replace(/^['"]|['"]$/g, "");
  });
}

// ───── CLI args ─────
const args         = process.argv.slice(2);
const pageUrl      = args.find((a) => a.startsWith("http"));
const tmdbKey      = (args.find((a) => a.startsWith("--tmdb-key=")) || "").replace("--tmdb-key=", "") || process.env.TMDB_API_KEY || "";
const customOutput = (args.find((a) => a.startsWith("--output=")) || "").replace("--output=", "");
const mainSlugArg  = (args.find((a) => a.startsWith("--main-slug=")) || "").replace("--main-slug=", "");
const idPrefixArg  = (args.find((a) => a.startsWith("--id-prefix=")) || "").replace("--id-prefix=", "");

const trackArg      = (args.find((a) => a.startsWith("--track=")) || "").replace("--track=", "");
const TRACK_MAP     = { th: "พากย์ไทย", subth: "ซับไทย" };
const trackName     = TRACK_MAP[trackArg] || trackArg || "พากย์ไทย";
const isDubbedTrack = trackName === "พากย์ไทย";

const seasonArg    = args.find((a) => a.startsWith("--season="));
const seasonNum    = seasonArg ? (parseInt(seasonArg.replace("--season=", "")) ?? null) : null;
const seasonName   = seasonNum != null ? (seasonNum === 0 ? "Specials" : `Season ${seasonNum}`) : null;

const updateMetaArg  = args.find((a) => a === "--update-meta" || a.startsWith("--update-meta="));
const updateMeta     = !!updateMetaArg;
const updateMetaMode = updateMetaArg?.includes("=") ? updateMetaArg.split("=")[1] : "all";

const tmdbIdArg   = args.find((a) => a.startsWith("--tmdb-id="));
const forceTmdbId = tmdbIdArg ? parseInt(tmdbIdArg.replace("--tmdb-id=", "")) || null : null;

const tmdbSeasonArg = args.find((a) => a.startsWith("--tmdb-season="));
const tmdbSeasonNum = tmdbSeasonArg ? (parseInt(tmdbSeasonArg.replace("--tmdb-season=", "")) || null) : null;

const epOffsetArg = args.find((a) => a.startsWith("--ep-offset="));
let epOffset = epOffsetArg ? (parseInt(epOffsetArg.replace("--ep-offset=", "")) || 0) : 0;

const typeArg     = (args.find((a) => a.startsWith("--type=")) || "").replace("--type=", "");
const contentType = ['anime-series','anime-movie','movie','series'].includes(typeArg) ? typeArg : 'movie';
const isMovie     = contentType === 'anime-movie' || contentType === 'movie';
const isSeries    = contentType === 'anime-series' || contentType === 'series';

if (!pageUrl && !updateMeta) {
  console.error("Usage: node fetch-037hdd.js <url> [--track=th|subth] [--type=movie|series] [--output=FILE]");
  console.error("       node fetch-037hdd.js --update-meta[=poster|cover|title] --output=FILE.txt");
  process.exit(1);
}

// ───── Config ─────
const TYPE_CONFIG = {
  'anime-series': { dir: '../playlist/anime/series', base: 'playlist/anime/series/'  },
  'anime-movie':  { dir: '../playlist/anime/movies', base: 'playlist/anime/movies/'  },
  'movie':        { dir: '../playlist/movies',       base: 'playlist/movies/'        },
  'series':       { dir: '../playlist/series',       base: 'playlist/series/'        },
};
const PLAYLIST_DIR    = path.resolve(__dirname, TYPE_CONFIG[contentType].dir);
const INDEX_PATH      = path.resolve(PLAYLIST_DIR, 'index.txt');
const GITHUB_RAW_BASE = `https://raw.githubusercontent.com/natajrak/IPTV-Player/refs/heads/main/${TYPE_CONFIG[contentType].base}`;

const STREAM_REFERER  = "https://www.037hddmovie.com/";

const HEADERS = {
  "User-Agent":      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120 Safari/537.36",
  "Accept-Language": "th-TH,th;q=0.9,en;q=0.8",
  "Accept":          "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
};

// ───── Helpers ─────
async function fetchHtml(url) {
  const res = await fetch(url, { headers: HEADERS });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  return res.text();
}

async function fetchJson(url) {
  const res = await fetch(url, { headers: { ...HEADERS, Accept: "application/json" } });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  return res.json();
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

function slugify(name) {
  return name.replace(/[^\w\s-]/g, "").trim().replace(/\s+/g, "-").replace(/-+/g, "-").toLowerCase();
}

// ───── 037hdd-specific functions ─────

/**
 * Extract leoplayer7 video IDs from 037hddmovie page.
 * Returns array of IDs; first = พากย์ไทย, second = ซับไทย
 */
function extractLeoPlayerIds($) {
  const ids = [];
  $('iframe').each((_, el) => {
    const src = $(el).attr("src") || "";
    if (src.includes("leoplayer")) {
      const m = src.match(/[?&]v=([^&]+)/);
      if (m) ids.push(m[1]);
    }
  });
  return ids;
}

/**
 * Call leoplayer7 API to get stream hash.
 * API: GET https://www.leoplayer7.com/api/analogy/mediahls3/{id}
 * Response: { data: { source: { url: "https://master.streamhls.com/p2p/{hash}" } } }
 */
async function getStreamHash(leoId) {
  const apiUrl = `https://www.leoplayer7.com/api/analogy/mediahls3/${leoId}`;
  try {
    const resp = await fetchJson(apiUrl);
    const data = typeof resp.data === "string" ? JSON.parse(resp.data) : resp.data;
    const sourceUrl = data?.source?.url || "";

    if (!sourceUrl) {
      // Try alternative API endpoints
      const altApis = [
        `https://www.leoplayer7.com/api/analogy/mediahls4/${leoId}`,
        `https://www.leoplayer7.com/api/analogy/mediahls2/${leoId}`,
        `https://www.leoplayer7.com/api/analogy/mediahls/${leoId}`,
      ];
      for (const altUrl of altApis) {
        try {
          const altResp = await fetchJson(altUrl);
          const altData = typeof altResp.data === "string" ? JSON.parse(altResp.data) : altResp.data;
          const altSourceUrl = altData?.source?.url || "";
          if (altSourceUrl) {
            console.log(`\n    🔄 พบ hash จาก ${altUrl.split('/api/')[1]}`);
            const am = altSourceUrl.match(/\/p2p\/([a-f0-9]+)/i) || altSourceUrl.match(/\/([a-f0-9]{32})/);
            if (am) return am[1];
          }
        } catch {}
      }
      // Log debug info for investigation
      console.warn(`\n    🔍 DEBUG: API response for ID ${leoId}:`);
      console.warn(`       resp keys: ${JSON.stringify(Object.keys(resp))}`);
      if (resp.data) console.warn(`       data: ${JSON.stringify(resp.data).substring(0, 300)}`);
      if (resp.source) console.warn(`       resp.source: ${JSON.stringify(resp.source).substring(0, 300)}`);
      if (resp.url) console.warn(`       resp.url: ${resp.url}`);
      return null;
    }

    // Extract hash from URL path: /p2p/{hash}
    const m = sourceUrl.match(/\/p2p\/([a-f0-9]+)/i) || sourceUrl.match(/\/([a-f0-9]{32})/);
    return m ? m[1] : null;
  } catch (err) {
    console.warn(`  ⚠️ API error for ID ${leoId}: ${err.message}`);
    return null;
  }
}

/** CF Worker proxy — rewrite Content-Type สำหรับ segments ที่ใช้ extension ปลอม (.jpg/.html)
 *  เพื่อให้ Safari iOS native HLS เล่นได้ */
const CF_WORKER = "https://shy-haze-2452.natajrak-p.workers.dev/";

/** Build m3u8 stream URL from hash, wrapped through CF Worker proxy */
function buildStreamUrl(hash) {
  const raw = `https://master.streamhls.com/hls/${hash}/master`;
  return `${CF_WORKER}?url=${encodeURIComponent(raw)}&referer=${encodeURIComponent("https://www.leoplayer7.com/")}`;
}

/** Extract title from 037hddmovie page */
function extractTitle($) {
  let title = $("h1").first().text().trim()
    || $(".entry-title").first().text().trim()
    || $("title").text().split("-")[0].trim();
  // Remove site name suffix
  title = title.replace(/\s*[-|]?\s*(ดูหนัง|037HDD).*$/i, "").trim();
  // Remove year in parentheses at end
  title = title.replace(/\s*\(\d{4}\)\s*$/, "").trim();
  // Remove track labels and HD markers
  title = title.replace(/\s*(พากย์ไทย|ซับไทย|บรรยายไทย|เต็มเรื่อง|HD|มาสเตอร์)\s*/g, " ").trim();
  return title;
}

/** Extract year from page */
function extractYear($) {
  const text = $("h1").text() + " " + $("title").text();
  const m = text.match(/\((\d{4})\)/);
  return m ? m[1] : null;
}

/** Extract poster image from page */
function extractPoster($) {
  return $(".poster img, .sheader img, .movie-poster img, .wp-post-image, .entry-content img").first().attr("src") || "";
}

// ───── TMDB Functions ─────
function cleanTitleForSearch(title) {
  return title
    .replace(/\[.*?\]/g, "")
    .replace(/\(.*?\)/g, "")
    .replace(/พากย์ไทย|ซับไทย|ซับ|พากย์|เต็มเรื่อง|บรรยายไทย/g, "")
    .replace(/[\u0E00-\u0E7F]+/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

async function searchTmdb(title, apiKey) {
  const query = encodeURIComponent(cleanTitleForSearch(title));
  const url   = `https://api.themoviedb.org/3/search/tv?query=${query}&language=en-US&api_key=${apiKey}`;
  const res   = await fetch(url);
  if (!res.ok) return null;
  const data  = await res.json();
  return data.results?.[0] || null;
}

async function searchTmdbMovie(title, apiKey) {
  const query = encodeURIComponent(cleanTitleForSearch(title));
  const url   = `https://api.themoviedb.org/3/search/movie?query=${query}&language=en-US&api_key=${apiKey}`;
  const res   = await fetch(url);
  if (!res.ok) return null;
  const data  = await res.json();
  return data.results?.[0] || null;
}

async function getTmdbShow(tvId, apiKey, language = "en-US") {
  const url = `https://api.themoviedb.org/3/tv/${tvId}?language=${language}&api_key=${apiKey}`;
  const res = await fetch(url);
  if (!res.ok) return null;
  return res.json();
}

async function getTmdbShowNameTh(tvId, apiKey) {
  const data = await getTmdbShow(tvId, apiKey, "th-TH");
  return data?.name || null;
}

async function getTmdbMovieDetail(movieId, apiKey, language = "en-US") {
  const url = `https://api.themoviedb.org/3/movie/${movieId}?language=${language}&api_key=${apiKey}`;
  const res = await fetch(url);
  if (!res.ok) return null;
  return res.json();
}

async function getTmdbMovieNameTh(movieId, apiKey) {
  const data = await getTmdbMovieDetail(movieId, apiKey, "th-TH");
  return data?.title || null;
}

async function getTmdbSeason(tvId, apiKey, season = 1, language = "en-US") {
  const url  = `https://api.themoviedb.org/3/tv/${tvId}/season/${season}?language=${language}&api_key=${apiKey}`;
  const res  = await fetch(url);
  if (!res.ok) return { episodes: [], poster: null };
  const data = await res.json();
  return {
    episodes: data.episodes || [],
    poster:   data.poster_path ? `https://image.tmdb.org/t/p/original${data.poster_path}` : null,
  };
}

function isGenericEpisodeName(name) {
  if (!name) return true;
  const s = name.trim();
  return /^Episode\s+\d+$/i.test(s) || /^ตอนที่\s*\d+$/.test(s);
}

async function getTmdbSeasonBilingual(tvId, apiKey, season = 1) {
  const [enData, thData] = await Promise.all([
    getTmdbSeason(tvId, apiKey, season, "en-US"),
    getTmdbSeason(tvId, apiKey, season, "th-TH"),
  ]);
  const thEps = thData.episodes.map((thEp, i) => {
    const enName = enData.episodes[i]?.name || "";
    const thName = isGenericEpisodeName(thEp.name) ? enName : (thEp.name || enName);
    return { ...enData.episodes[i], ...thEp, name: thName };
  });
  return { enEpisodes: enData.episodes, thEpisodes: thEps, poster: enData.poster };
}

function formatSeriesTitle(enName, thName) {
  if (thName && thName !== enName) return `${enName} [${thName}]`;
  return enName;
}

function buildStationName(epNum, epTitle, isDubbed) {
  if (!epTitle) return isDubbed ? `ตอน ${epNum}` : `Ep. ${epNum}`;
  return isDubbed ? `ตอน ${epNum} - ${epTitle}` : `Ep. ${epNum} - ${epTitle}`;
}

// ───── Parse 037hddmovie page ─────

/** Parse movie page → get stream URLs for both tracks */
async function parsePage(url) {
  console.log(`\n📄 กำลัง fetch: ${url}`);
  const html = await fetchHtml(url);
  const $ = cheerio.load(html);

  const title  = extractTitle($);
  const poster = extractPoster($);
  const year   = extractYear($);

  // Extract leoplayer7 IDs (first = พากย์ไทย, second = ซับไทย)
  const leoIds = extractLeoPlayerIds($);
  if (leoIds.length === 0) {
    throw new Error("ไม่พบ leoplayer iframe ในหน้านี้ — ตรวจสอบ URL อีกครั้ง");
  }

  console.log(`  ✅ title: ${title}`);
  console.log(`  ✅ leoplayer IDs: ${leoIds.join(", ")}`);

  // Get stream hashes from API
  const tracks = [];
  // ถ้ามี iframe เดียว → ใช้ --track ที่ระบุ (default: พากย์ไทย)
  // ถ้ามี 2 iframe → แรก = พากย์ไทย, สอง = ซับไทย
  const trackLabels = leoIds.length === 1
    ? [trackName]
    : ["พากย์ไทย", "ซับไทย"];
  for (let i = 0; i < leoIds.length; i++) {
    const label = trackLabels[i] || `Track ${i + 1}`;
    process.stdout.write(`  🔗 ${label} (ID: ${leoIds[i]})...`);
    const hash = await getStreamHash(leoIds[i]);
    if (hash) {
      // ถ้า hash ซ้ำกับ track ก่อนหน้า → ข้าม (เป็น track เดียวกัน)
      if (tracks.some(t => t.hash === hash)) {
        console.log(` ⚠️ hash ซ้ำกับ "${tracks.find(t => t.hash === hash).name}" → ข้าม`);
      } else {
        const streamUrl = buildStreamUrl(hash);
        tracks.push({ name: label, streamUrl, hash });
        console.log(` ✅ ${hash}`);
      }
    } else {
      console.log(` ⚠️ ไม่พบ hash`);
    }
    if (i < leoIds.length - 1) await sleep(300);
  }

  return { title, poster, year, tracks, leoIds };
}

/** Parse series page → find episode links */
async function parseSeriesPage(url) {
  console.log(`\n📄 กำลัง fetch series: ${url}`);
  const html = await fetchHtml(url);
  const $ = cheerio.load(html);

  const title  = extractTitle($);
  const poster = extractPoster($);

  // Find episode links
  const episodeLinks = [];
  const baseHost = new URL(url).origin;

  // Pattern 1: links with /episode/ path
  $('a[href*="/episode/"]').each((_, el) => {
    const href = $(el).attr("href");
    const text = $(el).text().trim();
    if (href && !episodeLinks.find(e => e.url === href)) {
      const fullUrl = href.startsWith("http") ? href : baseHost + href;
      episodeLinks.push({ url: fullUrl, text });
    }
  });

  // Pattern 2: links with "ตอนที่" text
  if (episodeLinks.length === 0) {
    $('a').each((_, el) => {
      const text = $(el).text().trim();
      const href = $(el).attr("href");
      if (href && /ตอนที่\s*\d/.test(text) && !episodeLinks.find(e => e.url === href)) {
        const fullUrl = href.startsWith("http") ? href : baseHost + href;
        episodeLinks.push({ url: fullUrl, text });
      }
    });
  }

  // Sort by episode number
  episodeLinks.sort((a, b) => {
    const na = parseInt(a.text.match(/\d+/)?.[0]) || 0;
    const nb = parseInt(b.text.match(/\d+/)?.[0]) || 0;
    return na - nb;
  });

  console.log(`  📺 title: ${title}`);
  console.log(`  📺 พบ ${episodeLinks.length} ตอน`);
  return { title, poster, episodeLinks };
}

/** Parse a single episode page → get leoplayer ID for the specified track */
async function parseEpisodePage(url, trackIndex = 0) {
  const html = await fetchHtml(url);
  const $ = cheerio.load(html);
  const leoIds = extractLeoPlayerIds($);
  // trackIndex: 0 = พากย์ไทย, 1 = ซับไทย
  return leoIds[trackIndex] || leoIds[0] || null;
}

/** Extract series037.php iframe src from episode page */
function extractSeriesIframeSrc($) {
  let src = '';
  $('iframe').each((_, el) => {
    const s = $(el).attr('src') || '';
    if (s.includes('series037') || s.includes('steamseries')) {
      src = s;
      return false;
    }
  });
  return src;
}

/**
 * Parse `movieList` JavaScript variable from series player iframe HTML.
 * Uses brace counting to handle large nested objects (40KB+).
 */
function parseMovieList(html) {
  const marker = html.indexOf('let movieList');
  if (marker < 0) return null;

  const braceStart = html.indexOf('{', marker);
  if (braceStart < 0) return null;

  let depth = 0;
  let braceEnd = -1;
  for (let i = braceStart; i < html.length; i++) {
    if (html[i] === '{') depth++;
    else if (html[i] === '}') { depth--; if (depth === 0) { braceEnd = i; break; } }
  }
  if (braceEnd < 0) return null;

  let raw = html.substring(braceStart, braceEnd + 1);
  raw = raw.replace(/,\s*([\]}])/g, '$1');

  try {
    return JSON.parse(raw);
  } catch {
    try {
      return new Function('return ' + raw)();
    } catch (e2) {
      console.warn("⚠️  ไม่สามารถ parse movieList ได้:", e2.message);
      return null;
    }
  }
}

/**
 * Extract episodes for a specific season from movieList.
 * @param {object} movieListData - parsed movieList object
 * @param {number} targetSeasonNum - season number (1, 2, 3, ...)
 * @param {string} soundKey  - "thai" or "sub"
 */
function extractSeasonEpisodes(movieListData, targetSeasonNum, soundKey) {
  const seasonList = movieListData.seasonList || {};
  let targetSeasonId = null;
  let targetSeasonName = null;

  for (const [sid, sdata] of Object.entries(seasonList)) {
    const m = (sdata.name || '').match(/Season\s*(\d+)/i);
    if (m && parseInt(m[1]) === targetSeasonNum) {
      targetSeasonId = sid;
      targetSeasonName = sdata.name;
      break;
    }
  }

  // If only one season, use it regardless of name
  const keys = Object.keys(seasonList);
  if (!targetSeasonId && keys.length === 1) {
    targetSeasonId = keys[0];
    targetSeasonName = seasonList[keys[0]].name;
  }

  if (!targetSeasonId) {
    const available = Object.values(seasonList).map(s => s.name).join(', ');
    throw new Error(`ไม่พบ Season ${targetSeasonNum} ใน movieList (มี: ${available})`);
  }

  const seasonData = seasonList[targetSeasonId];
  const epList = seasonData.epList || {};
  const episodes = [];

  // Debug: show available sound keys and link structure from first episode
  const firstEp = Object.values(epList)[0];
  if (firstEp?.link) {
    const availableKeys = Object.keys(firstEp.link);
    console.log(`    🔍 sound keys ใน episode 1: ${availableKeys.join(', ')}`);
    const firstLinks = firstEp.link[soundKey];
    if (Array.isArray(firstLinks) && firstLinks.length > 0) {
      console.log(`    🔍 link[${soundKey}][0]: ${JSON.stringify(firstLinks[0]).substring(0, 200)}`);
    } else {
      console.log(`    🔍 link[${soundKey}]: ${JSON.stringify(firstLinks).substring(0, 200)}`);
    }
  }

  for (const [epId, epData] of Object.entries(epList)) {
    const links = (epData.link && epData.link[soundKey]) || [];
    const p2pLink = links.find(l => l.MU_group === 'P2P') || links[0];
    if (!p2pLink) continue;

    // Extract hash: /p2p/{32hex} or UUID format {8-4-4-4-12}
    let hash = null;
    const hexMatch = p2pLink.MU_url.match(/\/([a-f0-9]{32})/i);
    if (hexMatch) {
      hash = hexMatch[1].toLowerCase();
    } else {
      const uuidMatch = p2pLink.MU_url.match(/([a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})/i);
      if (uuidMatch) hash = uuidMatch[1].replace(/-/g, '').toLowerCase();
    }
    if (!hash) continue;

    episodes.push({
      name: epData.name || `Episode ${episodes.length + 1}`,
      hash,
      streamUrl: buildStreamUrl(hash),
    });
  }

  return { seasonId: targetSeasonId, seasonName: targetSeasonName, episodes };
}

// ───── Playlist file operations ─────
function resolvePlaylistFile(fname) {
  if (fs.existsSync(path.resolve(PLAYLIST_DIR, fname))) return fname;
  const files = fs.readdirSync(PLAYLIST_DIR);
  const match = files.find((f) => f === fname || f.endsWith(`-${fname}`));
  return match || fname;
}

function buildPartFile(outputPath, season, posterUrl, track, streamUrl, streamReferer) {
  const partName   = `ภาค ${season}`;
  const newStation = { name: track, image: posterUrl, url: streamUrl, referer: streamReferer };

  let playlist;
  if (fs.existsSync(outputPath)) {
    try { playlist = JSON.parse(fs.readFileSync(outputPath, "utf-8")); }
    catch { playlist = null; }
  }

  if (!playlist) return { name: partName, image: posterUrl, stations: [newStation] };

  playlist.name     = partName;
  playlist.image    = posterUrl;
  playlist.stations = (playlist.stations || []).filter((s) => s.name !== track);
  playlist.stations.push(newStation);
  playlist.stations.sort((a, b) => {
    if (a.name === "พากย์ไทย") return -1;
    if (b.name === "พากย์ไทย") return 1;
    return 0;
  });
  console.log(`\n🔀 Merge "${track}" เข้า ${partName}`);
  return playlist;
}

function upsertMainFile(mainPath, franchiseName, franchisePoster, partTitle, partPoster, partFileRawUrl, season) {
  const badgeName = `ภาค ${season}`;
  let main;
  if (fs.existsSync(mainPath)) {
    try { main = JSON.parse(fs.readFileSync(mainPath, "utf-8")); }
    catch { main = null; }
  }
  if (!main) main = { name: franchiseName, image: franchisePoster, groups: [] };

  main.groups = main.groups || [];
  const existing = main.groups.find((g) => g.url === partFileRawUrl);
  if (existing) {
    existing.name  = partTitle;
    existing.image = partPoster;
    existing.badge = badgeName;
    console.log(`\n🔀 อัปเดต group "${badgeName}" ใน main file`);
  } else {
    main.groups.push({ name: partTitle, image: partPoster, url: partFileRawUrl, badge: badgeName });
    console.log(`\n➕ เพิ่ม group "${badgeName}" เข้า main file`);
  }

  main.groups.sort((a, b) => {
    const na = parseInt(a.badge?.match(/\d+/)?.[0]) || 0;
    const nb = parseInt(b.badge?.match(/\d+/)?.[0]) || 0;
    return na - nb;
  });
  return main;
}

function updateIndex(seriesTitle, posterUrl, filename, { upsert = false } = {}) {
  if (!fs.existsSync(INDEX_PATH)) { console.warn("⚠️  ไม่พบ index.txt ข้าม..."); return; }

  let index;
  try { index = JSON.parse(fs.readFileSync(INDEX_PATH, "utf-8")); }
  catch { console.warn("⚠️  index.txt parse ไม่ได้ ข้าม..."); return; }

  const fileUrl  = `${GITHUB_RAW_BASE}${filename}`;
  const existing = index.groups.find((g) => g.url === fileUrl);

  if (existing) {
    if (!upsert) { console.log(`ℹ️  มีอยู่ใน index.txt แล้ว (${existing.name}) ข้าม...`); return; }
    const changed = existing.name !== seriesTitle || existing.image !== posterUrl;
    if (!changed) { console.log(`ℹ️  index.txt ไม่มีการเปลี่ยนแปลง ข้าม...`); return; }
    existing.name  = seriesTitle;
    existing.image = posterUrl;
  } else {
    index.groups.push({ url: fileUrl, name: seriesTitle, image: posterUrl });
  }

  index.groups.sort((a, b) => (a.name || "").localeCompare(b.name || "", undefined, { sensitivity: "base" }));
  fs.writeFileSync(INDEX_PATH, JSON.stringify(index, null, 2), "utf-8");
  const action = existing ? "อัปเดต" : "เพิ่ม";
  console.log(`✅ ${action} index.txt แล้ว`);
}

// ───── Update meta only ─────
async function runUpdateMeta() {
  if (!tmdbKey)      { console.error("❌ ต้องมี TMDB_API_KEY ใน .env"); process.exit(1); }
  if (!customOutput) { console.error("❌ ต้องระบุ --output=FILENAME.txt"); process.exit(1); }

  const outputFile     = customOutput.endsWith(".txt") ? customOutput : `${customOutput}.txt`;
  const resolvedOutput = resolvePlaylistFile(outputFile);
  if (resolvedOutput !== outputFile) console.log(`📂 พบไฟล์: ${resolvedOutput}`);
  const outputPath = path.resolve(PLAYLIST_DIR, resolvedOutput);
  if (!fs.existsSync(outputPath)) { console.error(`❌ ไม่พบไฟล์: ${outputPath}`); process.exit(1); }

  const doPoster = updateMetaMode === "all" || updateMetaMode === "poster";
  const doCover  = updateMetaMode === "all" || updateMetaMode === "cover";
  const doTitle  = updateMetaMode === "all" || updateMetaMode === "title";

  console.log(`\n🔧 mode: ${updateMetaMode} (poster=${doPoster} cover=${doCover} title=${doTitle})`);

  const playlist = JSON.parse(fs.readFileSync(outputPath, "utf-8"));
  const rawTitle = playlist.name || "";

  if (isMovie) {
    let tmdbResult;
    if (forceTmdbId) {
      tmdbResult = await getTmdbMovieDetail(forceTmdbId, tmdbKey, "en-US");
    } else {
      tmdbResult = await searchTmdbMovie(rawTitle, tmdbKey);
    }
    if (!tmdbResult) { console.error("❌ ไม่พบใน TMDB"); process.exit(1); }

    const tmdbPoster = `https://image.tmdb.org/t/p/original${tmdbResult.poster_path}`;
    const tmdbEnName = tmdbResult.title || rawTitle;
    const tmdbThName = await getTmdbMovieNameTh(tmdbResult.id, tmdbKey);
    const tmdbName   = formatSeriesTitle(tmdbEnName, tmdbThName);
    console.log(`✅ พบ: "${tmdbName}" (ID: ${tmdbResult.id})`);

    if (doPoster) {
      playlist.image = tmdbPoster;
      if (playlist.stations) playlist.stations.forEach((s) => (s.image = tmdbPoster));
    }
    if (doTitle) playlist.name = tmdbName;

    fs.writeFileSync(outputPath, JSON.stringify(playlist, null, 4), "utf-8");
    updateIndex(tmdbName, tmdbPoster, resolvedOutput, { upsert: true });
    console.log(`✅ อัปเดตเสร็จ: ${resolvedOutput}`);

  } else {
    // Series
    let tmdbResult;
    if (forceTmdbId) {
      tmdbResult = await getTmdbShow(forceTmdbId, tmdbKey, "en-US");
    } else {
      tmdbResult = await searchTmdb(rawTitle, tmdbKey);
    }
    if (!tmdbResult) { console.error("❌ ไม่พบใน TMDB"); process.exit(1); }

    const tmdbPoster = `https://image.tmdb.org/t/p/original${tmdbResult.poster_path}`;
    const tmdbEnName = tmdbResult.name || rawTitle;
    const tmdbThName = await getTmdbShowNameTh(tmdbResult.id, tmdbKey);
    const tmdbName   = formatSeriesTitle(tmdbEnName, tmdbThName);
    console.log(`✅ พบ: "${tmdbName}" (ID: ${tmdbResult.id})`);

    if (doTitle)  playlist.name  = tmdbName;
    if (doPoster) playlist.image = tmdbPoster;

    // Update season posters & episode stills
    const sNum = tmdbSeasonNum || seasonNum || 1;
    if (doPoster && playlist.groups) {
      const { thEpisodes, poster: sPoster } = await getTmdbSeasonBilingual(tmdbResult.id, tmdbKey, sNum);
      for (const season of playlist.groups) {
        if (sPoster && doCover) season.image = sPoster;
        if (season.groups) {
          for (const track of season.groups) {
            if (sPoster && doCover) track.image = sPoster;
            if (track.stations) {
              track.stations.forEach((st, i) => {
                const ep = thEpisodes[i + epOffset];
                if (ep) {
                  if (ep.still_path) st.image = `https://image.tmdb.org/t/p/original${ep.still_path}`;
                  const epNum = i + 1;
                  const epTitle = ep.name || "";
                  st.name = buildStationName(epNum, epTitle, track.name === "พากย์ไทย");
                }
              });
            }
          }
        }
      }
    }

    fs.writeFileSync(outputPath, JSON.stringify(playlist, null, 4), "utf-8");
    updateIndex(tmdbName, tmdbPoster, resolvedOutput, { upsert: true });
    console.log(`✅ อัปเดตเสร็จ: ${resolvedOutput}`);
  }
}

// ───── Main ─────
async function main() {
  if (updateMeta) { await runUpdateMeta(); return; }

  try {
    if (isMovie) {
      // ── Movie flow ──
      const { title, poster, year, tracks } = await parsePage(pageUrl);

      if (tracks.length === 0) {
        console.error("❌ ไม่พบ stream URL ใดเลย");
        process.exit(1);
      }

      // TMDB lookup
      let seriesTitle = title;
      let posterUrl   = poster;
      let tmdbShow    = null;

      if (tmdbKey) {
        let tmdbResult;
        if (forceTmdbId) {
          console.log(`\n🎬 ใช้ TMDB ID ที่ระบุ: ${forceTmdbId}`);
          tmdbResult = await getTmdbMovieDetail(forceTmdbId, tmdbKey, "en-US");
        } else {
          console.log("\n🎬 กำลัง search TMDB (movie)...");
          tmdbResult = await searchTmdbMovie(title, tmdbKey);
        }
        if (tmdbResult) {
          const tmdbEnName = tmdbResult.title || title;
          const tmdbThName = await getTmdbMovieNameTh(tmdbResult.id, tmdbKey);
          seriesTitle = formatSeriesTitle(tmdbEnName, tmdbThName);
          posterUrl   = tmdbResult.poster_path
            ? `https://image.tmdb.org/t/p/original${tmdbResult.poster_path}`
            : poster;
          tmdbShow = tmdbResult;
          console.log(`✅ พบใน TMDB: "${seriesTitle}" (ID: ${tmdbResult.id})`);
        } else {
          console.warn("⚠️  ไม่พบใน TMDB ใช้ข้อมูลจาก 037hdd แทน");
        }
      }

      // Build playlist (Movie: 2-file pattern — part file + main file)
      const partSeason = seasonNum || 1;
      const slug       = customOutput || slugify(seriesTitle.replace(/\[.*?\]/g, "").trim());
      const slugFile   = slug.endsWith(".txt") ? slug : `${slug}.txt`;
      const resolvedId = idPrefixArg || String(tmdbShow?.id || "");

      // ── Part file: {tmdbId}-{slug}.txt ──
      const partFile = resolvedId ? `${resolvedId}-${slugFile}` : slugFile;
      const partPath = path.resolve(PLAYLIST_DIR, partFile);

      // Add all tracks (พากย์ไทย + ซับไทย) to the same part file
      // If --track is specified, only add that track
      const tracksToAdd = trackArg
        ? tracks.filter(t => t.name === trackName)
        : tracks;

      // Build part file with all tracks as stations
      let partPlaylist;
      if (fs.existsSync(partPath)) {
        try { partPlaylist = JSON.parse(fs.readFileSync(partPath, "utf-8")); }
        catch { partPlaylist = null; }
      }

      const partName = `ภาค ${partSeason}`;
      if (!partPlaylist) {
        partPlaylist = { name: partName, image: posterUrl, stations: [] };
      }
      partPlaylist.name  = partName;
      partPlaylist.image = posterUrl;

      for (const t of tracksToAdd) {
        partPlaylist.stations = (partPlaylist.stations || []).filter(s => s.name !== t.name);
        partPlaylist.stations.push({
          name:    t.name,
          image:   posterUrl,
          url:     t.streamUrl,
          referer: pageUrl,
        });
      }
      // Sort: พากย์ไทย first
      partPlaylist.stations.sort((a, b) => {
        if (a.name === "พากย์ไทย") return -1;
        if (b.name === "พากย์ไทย") return 1;
        return 0;
      });

      fs.writeFileSync(partPath, JSON.stringify(partPlaylist, null, 4), "utf-8");
      console.log(`\n📁 บันทึก part file: ${partPath}`);

      // ── Main file: {slug}.txt ──
      const mainFileSlug = mainSlugArg ? (mainSlugArg.endsWith(".txt") ? mainSlugArg : `${mainSlugArg}.txt`) : slugFile;
      const mainPath     = path.resolve(PLAYLIST_DIR, mainFileSlug);
      const partRawUrl   = `${GITHUB_RAW_BASE}${partFile}`;
      const mainPlaylist = upsertMainFile(mainPath, seriesTitle, posterUrl, seriesTitle, posterUrl, partRawUrl, partSeason);
      fs.writeFileSync(mainPath, JSON.stringify(mainPlaylist, null, 4), "utf-8");
      console.log(`📁 บันทึก main file: ${mainPath}`);

      updateIndex(seriesTitle, posterUrl, mainFileSlug);
      console.log("\n🎉 เสร็จสิ้น!");
      console.log(`   Part: ${TYPE_CONFIG[contentType].base}${partFile}`);
      console.log(`   Main: ${TYPE_CONFIG[contentType].base}${slugFile}`);

    } else {
      // ── Series flow ──
      const { title, poster, episodeLinks } = await parseSeriesPage(pageUrl);

      // Try movieList approach:
      // 1) หา series iframe จากหน้าหลักก่อน
      // 2) ถ้าไม่มี ลองหาจากหน้า episode แรก
      let stations = [];
      let usedMovieList = false;

      // Re-fetch main page to find series iframe directly
      console.log(`\n🔗 กำลังหา series iframe...`);
      const mainHtml = await fetchHtml(pageUrl);
      const $main = cheerio.load(mainHtml);
      let seriesIframe = extractSeriesIframeSrc($main);

      // Fallback: try first episode page if no series iframe on main page
      if (!seriesIframe && episodeLinks.length > 0) {
        console.log(`  ℹ️ ไม่พบ series iframe ในหน้าหลัก — ลองหน้า episode 1...`);
        const ep1Html = await fetchHtml(episodeLinks[0].url);
        const $ep1 = cheerio.load(ep1Html);
        seriesIframe = extractSeriesIframeSrc($ep1);
      }

      if (seriesIframe) {
        try {
          console.log(`  📺 พบ series iframe: ${seriesIframe.split('?')[0]}...`);
          const iframeHtml = await fetchHtml(seriesIframe, { Referer: pageUrl });
          const movieListData = parseMovieList(iframeHtml);

          if (movieListData) {
            const targetSeasonNum = seasonNum || 1;
            const soundKey = isDubbedTrack ? "thai" : "sub";
            const availableSeasons = Object.values(movieListData.seasonList || {}).map(s => s.name).join(', ');
            console.log(`  📋 movieList พบ seasons: ${availableSeasons}`);

            let seasonResult = extractSeasonEpisodes(movieListData, targetSeasonNum, soundKey);
            let episodes = seasonResult.episodes;
            console.log(`  ✅ Season ${targetSeasonNum}: ${episodes.length} ตอน (${soundKey})`);

            if (episodes.length === 0) {
              const altKey = soundKey === "thai" ? "sub" : "thai";
              console.log(`  ⚠️ ไม่พบ "${soundKey}" — ลอง "${altKey}"...`);
              const altResult = extractSeasonEpisodes(movieListData, targetSeasonNum, altKey);
              if (altResult.episodes.length > 0) {
                episodes = altResult.episodes;
                console.log(`  ✅ พบ ${episodes.length} ตอน ใน "${altKey}"`);
              }
            }

            if (episodes.length > 0) {
              usedMovieList = true;
              for (let i = 0; i < episodes.length; i++) {
                const epNum = i + 1 + epOffset;
                stations.push({
                  name:    buildStationName(epNum, "", isDubbedTrack),
                  image:   "",
                  url:     episodes[i].streamUrl,
                  referer: STREAM_REFERER,
                });
                console.log(`  ตอน ${epNum}: ${episodes[i].hash.substring(0, 12)}...`);
              }
            }
          }
        } catch (err) {
          console.log(`  ⚠️ movieList approach failed: ${err.message}`);
        }
      }

      // Fallback: fetch each episode page individually (old approach)
      if (!usedMovieList && episodeLinks.length > 0) {
        console.log(`\n🔗 ใช้วิธี fetch ทีละตอน (${episodeLinks.length} ตอน, ${trackName})...`);
        const trackIndex = isDubbedTrack ? 0 : 1;

        for (let i = 0; i < episodeLinks.length; i++) {
          const ep = episodeLinks[i];
          const epNum = i + 1 + epOffset;
          process.stdout.write(`  ตอน ${epNum}/${episodeLinks.length + epOffset}...`);

          try {
            const leoId = await parseEpisodePage(ep.url, trackIndex);
            if (leoId) {
              const hash = await getStreamHash(leoId);
              if (hash) {
                const streamUrl = buildStreamUrl(hash);
                stations.push({
                  name:    buildStationName(epNum, "", isDubbedTrack),
                  image:   "",
                  url:     streamUrl,
                  referer: STREAM_REFERER,
                });
                console.log(` ✅ ${hash.substring(0, 12)}...`);
              } else {
                stations.push({ name: buildStationName(epNum, "", isDubbedTrack), image: "", url: "", referer: "" });
                console.log(` ⚠️ ไม่พบ hash`);
              }
            } else {
              stations.push({ name: buildStationName(epNum, "", isDubbedTrack), image: "", url: "", referer: "" });
              console.log(` ⚠️ ไม่พบ leoplayer ID`);
            }
          } catch (err) {
            stations.push({ name: buildStationName(epNum, "", isDubbedTrack), image: "", url: "", referer: "" });
            console.log(` ⚠️ ${err.message}`);
          }

          if (i < episodeLinks.length - 1) await sleep(500);
        }
      }

      if (stations.length === 0) {
        console.error("❌ ไม่พบ episode ใดเลย — ไม่พบ series iframe หรือ episode links");
        process.exit(1);
      }

      // TMDB lookup
      let seriesTitle     = title;
      let posterUrl       = poster;
      let seasonPosterUrl = poster;
      let tmdbEpisodes    = [];
      let tmdbShow        = null;

      if (tmdbKey) {
        let tmdbResult;
        if (forceTmdbId) {
          console.log(`\n📺 ใช้ TMDB ID ที่ระบุ: ${forceTmdbId}`);
          tmdbResult = await getTmdbShow(forceTmdbId, tmdbKey, "en-US");
        } else {
          console.log("\n📺 กำลัง search TMDB (TV)...");
          tmdbResult = await searchTmdb(title, tmdbKey);
        }
        if (tmdbResult) {
          const tmdbEnName = tmdbResult.name || title;
          const tmdbThName = await getTmdbShowNameTh(tmdbResult.id, tmdbKey);
          seriesTitle = formatSeriesTitle(tmdbEnName, tmdbThName);
          posterUrl   = tmdbResult.poster_path
            ? `https://image.tmdb.org/t/p/original${tmdbResult.poster_path}`
            : poster;
          tmdbShow = tmdbResult;
          console.log(`✅ พบ: "${seriesTitle}" (ID: ${tmdbResult.id})`);

          // Get episode names + stills
          const sNum = tmdbSeasonNum || seasonNum || 1;
          const { enEpisodes, thEpisodes, poster: sPoster } = await getTmdbSeasonBilingual(tmdbResult.id, tmdbKey, sNum);
          tmdbEpisodes = isDubbedTrack ? thEpisodes : enEpisodes;
          if (sPoster) seasonPosterUrl = sPoster;

          // Update station names and images from TMDB
          stations.forEach((st, i) => {
            const ep = tmdbEpisodes[i + epOffset];
            const thEp = thEpisodes[i + epOffset];
            if (ep) {
              st.name  = buildStationName(i + 1 + epOffset, ep.name || "", isDubbedTrack);
              if (thEp?.still_path) st.image = `https://image.tmdb.org/t/p/original${thEp.still_path}`;
            }
          });
        } else {
          console.warn("⚠️  ไม่พบใน TMDB ใช้ข้อมูลจาก 037hdd แทน");
        }
      }

      // Build playlist (Series structure: seasons → tracks → episodes)
      const slug       = customOutput || slugify(seriesTitle.replace(/\[.*?\]/g, "").trim());
      const slugFile   = slug.endsWith(".txt") ? slug : `${slug}.txt`;
      const resolvedId = idPrefixArg || String(tmdbShow?.id || "");
      const outputFile = resolvedId ? `${resolvedId}-${slugFile}` : slugFile;
      const outputPath = path.resolve(PLAYLIST_DIR, outputFile);

      const targetSeason = seasonName || "Season 1";
      const newTrack = { name: trackName, image: seasonPosterUrl, referer: pageUrl, stations };

      let playlist;
      if (fs.existsSync(outputPath)) {
        try { playlist = JSON.parse(fs.readFileSync(outputPath, "utf-8")); }
        catch { playlist = null; }
      }

      if (playlist) {
        let season = playlist.groups?.find(g => g.name === targetSeason);
        if (!season) {
          playlist.groups = playlist.groups || [];
          season = { name: targetSeason, image: seasonPosterUrl, groups: [] };
          playlist.groups.push(season);
        }
        season.groups = season.groups || [];
        season.groups = season.groups.filter(t => t.name !== trackName);
        season.groups.push(newTrack);
        // Sort: พากย์ไทย first
        season.groups.sort((a, b) => {
          if (a.name === "พากย์ไทย") return -1;
          if (b.name === "พากย์ไทย") return 1;
          return 0;
        });
        console.log(`\n🔀 Merge "${trackName}" เข้า "${targetSeason}"`);
      } else {
        playlist = {
          name:   seriesTitle,
          image:  posterUrl,
          groups: [{
            name:   targetSeason,
            image:  seasonPosterUrl,
            groups: [newTrack]
          }]
        };
      }

      fs.writeFileSync(outputPath, JSON.stringify(playlist, null, 4), "utf-8");
      console.log(`\n📁 บันทึกไฟล์: ${outputPath}`);
      updateIndex(seriesTitle, posterUrl, outputFile);
      console.log("\n🎉 เสร็จสิ้น!");
      console.log(`   ไฟล์: ${TYPE_CONFIG[contentType].base}${outputFile}`);
    }

  } catch (err) {
    console.error(`\n❌ Error: ${err.message}`);
    if (process.env.DEBUG) console.error(err.stack);
    process.exit(1);
  }
}

main();

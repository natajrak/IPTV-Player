#!/usr/bin/env node
/**
 * fetch-v8hdd.js
 * สร้าง / อัปเดต playlist JSON จาก v8-hdd.com พร้อม metadata จาก TMDB
 *
 * ─── Flags ───────────────────────────────────────────────────────────────
 *   <url>              URL หน้าหนัง/ซีรีส์บน v8-hdd.com
 *                      เช่น https://www.v8-hdd.com/xxxxx/
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
 *     page → iframe stream1688.com/v8movie.php?v={id}&lang=...&langtwo=...&sub=...
 *     → fetch iframe HTML → extract 32-char hex hashes → streamhls.com/hls/{hash}/master
 *
 *   Series:
 *     page → iframe steamseries88.com/v8movie.php?vid={id}&ss={seasonId}
 *     → fetch iframe HTML → extract hashes per episode
 *
 * ─── Stream URL Pattern ──────────────────────────────────────────────────
 *   iframe HTML → hash → https://master.streamhls.com/hls/{hash}/master
 *   streamhls.com has CORS enabled — NO proxy needed, direct URL
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
  console.error("Usage: node fetch-v8hdd.js <url> [--track=th|subth] [--type=movie|series] [--output=FILE]");
  console.error("       node fetch-v8hdd.js --update-meta[=poster|cover|title] --output=FILE.txt");
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

const STREAM_REFERER  = "https://www.v8-hdd.com/";

const HEADERS = {
  "User-Agent":      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120 Safari/537.36",
  "Accept-Language": "th-TH,th;q=0.9,en;q=0.8",
  "Accept":          "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
};

// ───── Helpers ─────
async function fetchHtml(url, extraHeaders = {}) {
  const res = await fetch(url, { headers: { ...HEADERS, ...extraHeaders } });
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

// ───── v8-hdd-specific functions ─────

/**
 * Extract iframe src from v8-hdd page.
 * Movie: <iframe id="movie" src="https://www.stream1688.com/v8movie.php?v={id}&lang=...&langtwo=...&sub=...">
 * Series: <iframe id="movie" src="https://www.steamseries88.com/v8movie.php?vid={id}&ss={seasonId}">
 */
function extractIframeSrc($) {
  const iframe = $('#movie');
  if (iframe.length) return iframe.attr('src') || '';
  // Fallback: find any iframe with stream1688 or steamseries88
  let src = '';
  $('iframe').each((_, el) => {
    const s = $(el).attr('src') || '';
    if (s.includes('stream1688') || s.includes('steamseries88')) {
      src = s;
      return false;
    }
  });
  return src;
}

/**
 * Determine if iframe is movie or series based on domain.
 * stream1688.com = movie, steamseries88.com = series
 */
function isMovieIframe(iframeSrc) {
  return iframeSrc.includes('stream1688');
}

function isSeriesIframe(iframeSrc) {
  return iframeSrc.includes('steamseries88');
}

/**
 * Parse iframe URL params for movie.
 * Returns { videoId, lang, langtwo, sub }
 */
function parseMovieIframeParams(iframeSrc) {
  try {
    const url = new URL(iframeSrc);
    return {
      videoId: url.searchParams.get('v') || '',
      lang:    url.searchParams.get('lang') || '',
      langtwo: url.searchParams.get('langtwo') || '',
      sub:     url.searchParams.get('sub') || '',
    };
  } catch {
    return { videoId: '', lang: '', langtwo: '', sub: '' };
  }
}

/**
 * Parse iframe URL params for series.
 * Returns { videoId, seasonId }
 */
function parseSeriesIframeParams(iframeSrc) {
  try {
    const url = new URL(iframeSrc);
    return {
      videoId:  url.searchParams.get('vid') || '',
      seasonId: url.searchParams.get('ss') || '',
    };
  } catch {
    return { videoId: '', seasonId: '' };
  }
}

/**
 * Extract 32-char hex hashes from iframe HTML.
 * Filters out common non-stream hashes (CSS colors, WordPress IDs, etc.)
 */
function extractStreamHashes(html) {
  // First try: look for streamhls.com URLs with hashes
  const streamhlsMatches = html.match(/streamhls\.com\/hls\/([a-f0-9]{32})/gi) || [];
  const fromUrls = streamhlsMatches.map(m => {
    const match = m.match(/([a-f0-9]{32})/i);
    return match ? match[1].toLowerCase() : null;
  }).filter(Boolean);

  if (fromUrls.length > 0) {
    // Deduplicate while preserving order
    return [...new Set(fromUrls)];
  }

  // Second try: look for ArtPlayer or player config containing hashes
  // Common patterns: url: ".../{hash}/master", source: ".../{hash}..."
  const playerConfigMatches = html.match(/(?:url|source|src|file)\s*[:=]\s*['"][^'"]*\/([a-f0-9]{32})(?:\/|['"])/gi) || [];
  const fromConfig = playerConfigMatches.map(m => {
    const match = m.match(/([a-f0-9]{32})/i);
    return match ? match[1].toLowerCase() : null;
  }).filter(Boolean);

  if (fromConfig.length > 0) {
    return [...new Set(fromConfig)];
  }

  // Third try: extract all 32-char hex strings and filter
  const allHexMatches = html.match(/\b[a-f0-9]{32}\b/gi) || [];
  // Deduplicate
  const unique = [...new Set(allHexMatches.map(h => h.toLowerCase()))];

  // Filter out likely non-stream hashes:
  // - Hashes that appear in CSS (color values are 3/6 chars, not 32)
  // - Hashes in WordPress nonce/action contexts
  // - md5 of common strings
  // Keep hashes that appear near stream-related keywords
  if (unique.length <= 4) {
    // Few enough to be all stream hashes
    return unique;
  }

  // If too many, try to filter by context
  const streamRelated = [];
  for (const hash of unique) {
    // Check if hash appears near stream keywords
    const idx = html.toLowerCase().indexOf(hash);
    if (idx >= 0) {
      const context = html.substring(Math.max(0, idx - 200), Math.min(html.length, idx + 200)).toLowerCase();
      if (context.includes('stream') || context.includes('hls') || context.includes('master')
          || context.includes('player') || context.includes('artplayer') || context.includes('video')
          || context.includes('source') || context.includes('url')) {
        streamRelated.push(hash);
      }
    }
  }

  return streamRelated.length > 0 ? [...new Set(streamRelated)] : unique;
}

/**
 * Normalize track name from iframe params.
 * "พากย์ไทย" → พากย์ไทย
 * "Soundtrack ซับ" or "ซับไทย" → ซับไทย
 */
function normalizeTrackName(paramValue) {
  if (!paramValue) return null;
  if (paramValue.includes('พากย์')) return 'พากย์ไทย';
  if (paramValue.includes('ซับ')) return 'ซับไทย';
  return paramValue;
}

/** Build m3u8 stream URL from hash */
function buildStreamUrl(hash) {
  return `https://master.streamhls.com/hls/${hash}/master`;
}

/**
 * Parse `movieList` JavaScript variable from steamseries88 iframe HTML.
 * Returns the parsed object or null if not found.
 *
 * Structure:
 *   movieList.seasonName  = { "800": "Season 2", "845": "Season 1", ... }
 *   movieList.seasonList  = {
 *     "800": {
 *       name: "Season 2",
 *       epName: { epId: "Episode 1", ... },
 *       epList: {
 *         epId: {
 *           name: "Episode 1",
 *           link: {
 *             thai: [{ MU_group, MU_url, MU_sound, ... }],
 *             sub:  [{ MU_group, MU_url, MU_sound, ... }]
 *           }
 *         }
 *       }
 *     }
 *   }
 */
function parseMovieList(html) {
  // Find "let movieList = {" then use brace counting to find the matching "}"
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

  // Clean trailing commas (invalid JSON but valid JS)
  raw = raw.replace(/,\s*([\]}])/g, '$1');

  try {
    return JSON.parse(raw);
  } catch (e) {
    // Fallback: use Function constructor (handles JS object literals)
    try {
      return new Function('return ' + raw)();
    } catch {
      console.warn("⚠️  ไม่สามารถ parse movieList ได้:", e.message);
      return null;
    }
  }
}

/**
 * Extract episodes for a specific season from movieList.
 * @param {object} movieList - parsed movieList object
 * @param {number} seasonNum - season number (1, 2, 3, ...)
 * @param {string} soundKey  - "thai" or "sub"
 * @returns {{ seasonId: string, seasonName: string, episodes: Array<{name, hash, streamUrl}> }}
 */
function extractSeasonEpisodes(movieList, seasonNum, soundKey) {
  // Build Season N → seasonId mapping
  const seasonList = movieList.seasonList || {};
  let targetSeasonId = null;
  let targetSeasonName = null;

  for (const [sid, sdata] of Object.entries(seasonList)) {
    const m = (sdata.name || '').match(/Season\s*(\d+)/i);
    if (m && parseInt(m[1]) === seasonNum) {
      targetSeasonId = sid;
      targetSeasonName = sdata.name;
      break;
    }
  }

  if (!targetSeasonId) {
    // List available seasons for user
    const available = Object.values(seasonList).map(s => s.name).join(', ');
    throw new Error(`ไม่พบ Season ${seasonNum} ใน movieList (มี: ${available})`);
  }

  const seasonData = seasonList[targetSeasonId];
  const epList = seasonData.epList || {};
  const episodes = [];

  for (const [epId, epData] of Object.entries(epList)) {
    const links = (epData.link && epData.link[soundKey]) || [];
    // Prefer P2P group (streamhls.com)
    const p2pLink = links.find(l => l.MU_group === 'P2P') || links[0];
    if (!p2pLink) continue;

    // Extract hash from MU_url
    const hashMatch = p2pLink.MU_url.match(/\/([a-f0-9]{32})/i);
    const hash = hashMatch ? hashMatch[1].toLowerCase() : null;
    if (!hash) continue;

    episodes.push({
      name: epData.name || `Episode ${episodes.length + 1}`,
      hash,
      streamUrl: buildStreamUrl(hash),
    });
  }

  return { seasonId: targetSeasonId, seasonName: targetSeasonName, episodes };
}

/** Extract title from v8-hdd page */
function extractTitle($) {
  let title = $("h1").first().text().trim()
    || $(".entry-title").first().text().trim()
    || $("title").text().split("-")[0].trim()
    || $("title").text().split("|")[0].trim();
  // Remove site name suffix
  title = title.replace(/\s*[-|]?\s*(ดูหนัง|v8-hdd|v8hdd|V8|ดูซีรีส์).*$/i, "").trim();
  // Remove "Season N" and keep for later parsing
  title = title.replace(/\s*Season\s*\d+\s*/i, " ").trim();
  // Remove year in parentheses at end
  title = title.replace(/\s*\(\d{4}\)\s*$/, "").trim();
  // Remove track labels and HD markers
  title = title.replace(/\s*(พากย์ไทย|ซับไทย|บรรยายไทย|เต็มเรื่อง|HD|มาสเตอร์|4K|BluRay)\s*/gi, " ").trim();
  // Clean up extra spaces
  title = title.replace(/\s+/g, " ").trim();
  return title;
}

/** Extract year from page */
function extractYear($) {
  const text = $("h1").text() + " " + $("title").text();
  const m = text.match(/\((\d{4})\)/);
  return m ? m[1] : null;
}

/** Extract season number from page title */
function extractSeasonFromTitle($) {
  const text = $("h1").text() + " " + $("title").text();
  const m = text.match(/Season\s*(\d+)/i);
  return m ? parseInt(m[1]) : null;
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

// ───── Parse v8-hdd page ─────

/** Parse movie page → get stream URLs for both tracks */
async function parseMoviePage(url) {
  console.log(`\n📄 กำลัง fetch: ${url}`);
  const html = await fetchHtml(url);
  const $ = cheerio.load(html);

  const title  = extractTitle($);
  const poster = extractPoster($);
  const year   = extractYear($);

  // Extract iframe src
  const iframeSrc = extractIframeSrc($);
  if (!iframeSrc) {
    throw new Error("ไม่พบ iframe ในหน้านี้ — ตรวจสอบ URL อีกครั้ง");
  }

  console.log(`  ✅ title: ${title}`);
  console.log(`  ✅ iframe: ${iframeSrc}`);

  // Parse iframe params for track names
  const params = parseMovieIframeParams(iframeSrc);
  const lang1 = normalizeTrackName(params.lang);
  const lang2 = normalizeTrackName(params.langtwo);
  console.log(`  ✅ tracks: lang="${params.lang}" → ${lang1 || '(none)'}, langtwo="${params.langtwo}" → ${lang2 || '(none)'}`);

  // Fetch iframe page to extract stream hashes
  console.log(`  🔗 กำลัง fetch iframe page...`);
  const iframeHtml = await fetchHtml(iframeSrc, { Referer: "https://www.v8-hdd.com/" });
  const hashes = extractStreamHashes(iframeHtml);
  console.log(`  ✅ พบ ${hashes.length} hash(es): ${hashes.map(h => h.substring(0, 12) + '...').join(', ')}`);

  if (hashes.length === 0) {
    throw new Error("ไม่พบ stream hash ใน iframe page");
  }

  // Map hashes to tracks
  const tracks = [];
  if (hashes.length === 1) {
    // Single hash → use --track arg or lang1
    const label = lang1 || trackName;
    tracks.push({ name: label, streamUrl: buildStreamUrl(hashes[0]), hash: hashes[0] });
  } else {
    // Multiple hashes: first = lang (พากย์ไทย), second = langtwo (ซับไทย)
    if (lang1 && hashes[0]) {
      tracks.push({ name: lang1, streamUrl: buildStreamUrl(hashes[0]), hash: hashes[0] });
    }
    if (lang2 && hashes[1]) {
      // Skip if same hash as first track
      if (hashes[1] !== hashes[0]) {
        tracks.push({ name: lang2, streamUrl: buildStreamUrl(hashes[1]), hash: hashes[1] });
      } else {
        console.log(`  ⚠️ hash ที่ 2 ซ้ำกับ "${lang1}" → ข้าม`);
      }
    }
    // If there are more hashes beyond the first two, log them
    if (hashes.length > 2) {
      console.log(`  ℹ️ พบ hash เพิ่มเติมอีก ${hashes.length - 2} รายการ (ข้าม)`);
    }
  }

  for (const t of tracks) {
    console.log(`  ✅ ${t.name}: ${t.hash}`);
  }

  return { title, poster, year, tracks };
}

/** Parse series page → get iframe info and episode hashes */
async function parseSeriesPage(url) {
  console.log(`\n📄 กำลัง fetch series: ${url}`);
  const html = await fetchHtml(url);
  const $ = cheerio.load(html);

  const title    = extractTitle($);
  const poster   = extractPoster($);
  const pageSeason = extractSeasonFromTitle($);

  // Extract iframe src
  const iframeSrc = extractIframeSrc($);
  if (!iframeSrc) {
    throw new Error("ไม่พบ iframe ในหน้านี้ — ตรวจสอบ URL อีกครั้ง");
  }

  console.log(`  📺 title: ${title}`);
  console.log(`  📺 iframe: ${iframeSrc}`);
  if (pageSeason) console.log(`  📺 season from title: ${pageSeason}`);

  const params = parseSeriesIframeParams(iframeSrc);
  console.log(`  📺 videoId: ${params.videoId}, seasonId: ${params.seasonId}`);

  // Fetch iframe page to extract episode hashes
  console.log(`  🔗 กำลัง fetch iframe page...`);
  const iframeHtml = await fetchHtml(iframeSrc, { Referer: "https://www.v8-hdd.com/" });

  // Extract all stream hashes — each hash = one episode
  const hashes = extractStreamHashes(iframeHtml);
  console.log(`  ✅ พบ ${hashes.length} hash(es) (= ${hashes.length} ตอน)`);

  if (hashes.length === 0) {
    console.warn("  ⚠️ ไม่พบ stream hash ใน iframe page");
    console.warn("  ℹ️ อาจต้อง fetch แต่ละตอนแยก หรือ iframe structure ต่างออกไป");
  }

  return { title, poster, pageSeason, hashes, iframeHtml };
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
    // First, detect if page is movie or series by checking the iframe
    console.log(`\n📄 กำลัง fetch: ${pageUrl}`);
    const html = await fetchHtml(pageUrl);
    const $ = cheerio.load(html);
    const iframeSrc = extractIframeSrc($);

    if (!iframeSrc) {
      throw new Error("ไม่พบ iframe ในหน้านี้ — ตรวจสอบ URL อีกครั้ง");
    }

    // Auto-detect series vs movie from iframe domain if --type not explicitly set
    const detectedSeries = isSeriesIframe(iframeSrc);
    const detectedMovie  = isMovieIframe(iframeSrc);

    if (!typeArg && detectedSeries) {
      console.log(`  ℹ️ ตรวจพบ iframe series (steamseries88) — ใช้ series flow`);
    } else if (!typeArg && detectedMovie) {
      console.log(`  ℹ️ ตรวจพบ iframe movie (stream1688) — ใช้ movie flow`);
    }

    // Use explicit --type if set, otherwise auto-detect
    const useSeriesFlow = typeArg ? isSeries : detectedSeries;

    if (!useSeriesFlow) {
      // ── Movie flow ──
      const title  = extractTitle($);
      const poster = extractPoster($);
      const year   = extractYear($);

      console.log(`  ✅ title: ${title}`);
      console.log(`  ✅ iframe: ${iframeSrc}`);

      // Parse iframe params for track names
      const params = parseMovieIframeParams(iframeSrc);
      const lang1 = normalizeTrackName(params.lang);
      const lang2 = normalizeTrackName(params.langtwo);
      console.log(`  ✅ tracks: lang="${params.lang}" → ${lang1 || '(none)'}, langtwo="${params.langtwo}" → ${lang2 || '(none)'}`);

      // Fetch iframe page to extract stream hashes
      console.log(`  🔗 กำลัง fetch iframe page...`);
      const iframeHtml = await fetchHtml(iframeSrc, { Referer: "https://www.v8-hdd.com/" });
      const hashes = extractStreamHashes(iframeHtml);
      console.log(`  ✅ พบ ${hashes.length} hash(es): ${hashes.map(h => h.substring(0, 12) + '...').join(', ')}`);

      if (hashes.length === 0) {
        throw new Error("ไม่พบ stream hash ใน iframe page");
      }

      // Map hashes to tracks
      const tracks = [];
      if (hashes.length === 1) {
        const label = lang1 || trackName;
        tracks.push({ name: label, streamUrl: buildStreamUrl(hashes[0]), hash: hashes[0] });
      } else {
        if (lang1 && hashes[0]) {
          tracks.push({ name: lang1, streamUrl: buildStreamUrl(hashes[0]), hash: hashes[0] });
        }
        if (lang2 && hashes[1]) {
          if (hashes[1] !== hashes[0]) {
            tracks.push({ name: lang2, streamUrl: buildStreamUrl(hashes[1]), hash: hashes[1] });
          } else {
            console.log(`  ⚠️ hash ที่ 2 ซ้ำกับ "${lang1}" → ข้าม`);
          }
        }
        if (hashes.length > 2) {
          console.log(`  ℹ️ พบ hash เพิ่มเติมอีก ${hashes.length - 2} รายการ (ข้าม)`);
        }
      }

      for (const t of tracks) {
        console.log(`  ✅ ${t.name}: ${t.hash}`);
      }

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
          console.warn("⚠️  ไม่พบใน TMDB ใช้ข้อมูลจาก v8-hdd แทน");
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

      // Add tracks to the same part file
      const tracksToAdd = trackArg
        ? tracks.filter(t => t.name === trackName)
        : tracks;

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
      const title    = extractTitle($);
      const poster   = extractPoster($);
      const pageSeason = extractSeasonFromTitle($);

      console.log(`  📺 title: ${title}`);
      console.log(`  📺 iframe: ${iframeSrc}`);
      if (pageSeason) console.log(`  📺 season from title: ${pageSeason}`);

      const seriesParams = parseSeriesIframeParams(iframeSrc);
      console.log(`  📺 videoId: ${seriesParams.videoId}, seasonId: ${seriesParams.seasonId}`);

      // Fetch iframe page
      console.log(`  🔗 กำลัง fetch iframe page...`);
      const iframeHtml = await fetchHtml(iframeSrc, { Referer: "https://www.v8-hdd.com/" });

      // Parse movieList from iframe HTML (structured data with seasons & episodes)
      const movieListData = parseMovieList(iframeHtml);

      // Determine which season to extract
      const targetSeasonNum = seasonNum || pageSeason || 1;
      // Map --track arg to movieList sound key: th → "thai", subth → "sub"
      const soundKey = isDubbedTrack ? "thai" : "sub";

      let episodes;
      if (movieListData) {
        // ── Structured approach: use movieList ──
        const availableSeasons = Object.values(movieListData.seasonList || {}).map(s => s.name).join(', ');
        console.log(`  📋 movieList พบ seasons: ${availableSeasons}`);

        const seasonResult = extractSeasonEpisodes(movieListData, targetSeasonNum, soundKey);
        episodes = seasonResult.episodes;
        console.log(`  ✅ Season ${targetSeasonNum} (id: ${seasonResult.seasonId}): ${episodes.length} ตอน (${soundKey})`);

        if (episodes.length === 0) {
          // Try the other sound key as fallback
          const altKey = soundKey === "thai" ? "sub" : "thai";
          console.log(`  ⚠️ ไม่พบ "${soundKey}" — ลอง "${altKey}"...`);
          const altResult = extractSeasonEpisodes(movieListData, targetSeasonNum, altKey);
          if (altResult.episodes.length > 0) {
            episodes = altResult.episodes;
            console.log(`  ✅ พบ ${episodes.length} ตอน ใน "${altKey}"`);
          }
        }
      } else {
        // ── Fallback: regex hash extraction (old approach) ──
        console.log("  ⚠️ ไม่พบ movieList — ใช้ regex hash extraction แทน");
        const hashes = extractStreamHashes(iframeHtml);
        console.log(`  ✅ พบ ${hashes.length} hash(es)`);
        episodes = hashes.map((h, i) => ({
          name: `Episode ${i + 1}`,
          hash: h,
          streamUrl: buildStreamUrl(h),
        }));
      }

      if (episodes.length === 0) {
        console.error("❌ ไม่พบ episode สำหรับ season นี้");
        process.exit(1);
      }

      // Build stations from episodes
      const stations = [];
      for (let i = 0; i < episodes.length; i++) {
        const epNum = i + 1 + epOffset;
        stations.push({
          name:    buildStationName(epNum, "", isDubbedTrack),
          image:   "",
          url:     episodes[i].streamUrl,
          referer: pageUrl,
        });
        console.log(`  ตอน ${epNum}: ${episodes[i].hash.substring(0, 12)}...`);
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
          const sNum = tmdbSeasonNum || seasonNum || pageSeason || 1;
          const { thEpisodes, poster: sPoster } = await getTmdbSeasonBilingual(tmdbResult.id, tmdbKey, sNum);
          tmdbEpisodes = thEpisodes;
          if (sPoster) seasonPosterUrl = sPoster;

          // Update station names and images from TMDB
          stations.forEach((st, i) => {
            const ep = tmdbEpisodes[i + epOffset];
            if (ep) {
              st.name  = buildStationName(i + 1 + epOffset, ep.name || "", isDubbedTrack);
              if (ep.still_path) st.image = `https://image.tmdb.org/t/p/original${ep.still_path}`;
            }
          });
        } else {
          console.warn("⚠️  ไม่พบใน TMDB ใช้ข้อมูลจาก v8-hdd แทน");
        }
      }

      // Build playlist (Series structure: seasons → tracks → episodes)
      const slug       = customOutput || slugify(seriesTitle.replace(/\[.*?\]/g, "").trim());
      const slugFile   = slug.endsWith(".txt") ? slug : `${slug}.txt`;
      const resolvedId = idPrefixArg || String(tmdbShow?.id || "");
      const outputFile = resolvedId ? `${resolvedId}-${slugFile}` : slugFile;
      const outputPath = path.resolve(PLAYLIST_DIR, outputFile);

      const targetSeason = seasonName || (pageSeason ? (pageSeason === 0 ? "Specials" : `Season ${pageSeason}`) : "Season 1");
      const newTrack = { name: trackName, image: seasonPosterUrl, stations };

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

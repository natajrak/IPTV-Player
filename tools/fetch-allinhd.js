#!/usr/bin/env node
/**
 * fetch-allinhd.js
 * สร้าง / อัปเดต playlist JSON จาก allinhd.com พร้อม metadata จาก TMDB
 *
 * ─── Flags ───────────────────────────────────────────────────────────────
 *   <url>              URL หน้าหนังบน allinhd.com
 *                      เช่น https://allinhd.com/the-super-mario-galaxy-movie-2026/
 *   --track=th|subth   th = พากย์ไทย, subth = ซับไทย (default: จากหน้าเว็บ)
 *   --season=N         ระบุ season/ภาค (default: 1)
 *   --output=FILE      ชื่อไฟล์ผลลัพธ์ (ไม่ต้องใส่ path)
 *   --tmdb-key=KEY     TMDB API key (ถ้าไม่ใส่จะอ่านจาก .env)
 *   --tmdb-id=N        ระบุ TMDB ID ตรงๆ
 *   --type=TYPE        anime-series|anime-movie|movie|series (default: movie)
 *   --update-meta[=poster|cover|title]
 *                      อัปเดต metadata จาก TMDB โดยไม่ fetch stream URLs ใหม่
 *
 * ─── Workflow ────────────────────────────────────────────────────────────
 *
 *   # Fetch หนัง (สร้างไฟล์ใหม่)
 *   node fetch-allinhd.js https://allinhd.com/the-super-mario-galaxy-movie-2026/ --output=FILENAME.txt
 *
 *   # Series (หลายตอน) — ใส่ URL หน้ารวม series
 *   node fetch-allinhd.js https://allinhd.com/some-series/ --type=series --output=FILENAME.txt
 *
 *   # อัปเดต metadata จาก TMDB
 *   node fetch-allinhd.js --update-meta --output=FILENAME.txt
 *
 * ─── Stream URL Pattern ──────────────────────────────────────────────────
 *   embed iframe → movieid → https://player3.fastfastcdn.com/ttplaylist_{movieid}.m3u8
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

const trackArg     = (args.find((a) => a.startsWith("--track=")) || "").replace("--track=", "");
const TRACK_MAP    = { th: "พากย์ไทย", subth: "ซับไทย" };
const trackNameOverride = TRACK_MAP[trackArg] || trackArg || null;

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
  console.error("Usage: node fetch-allinhd.js <url> [--track=th|subth] [--type=movie|series|anime-series|anime-movie] [--output=FILE]");
  console.error("       node fetch-allinhd.js --update-meta[=poster|cover|title] --output=FILE.txt");
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

const STREAM_BASE     = "https://player3.fastfastcdn.com/ttplaylist_";
const STREAM_REFERER  = "https://allinhd.com/";

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

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

function slugify(name) {
  return name.replace(/[^\w\s-]/g, "").trim().replace(/\s+/g, "-").replace(/-+/g, "-").toLowerCase();
}

/** Extract movieid from allinhd page HTML */
function extractMovieId($) {
  // Pattern 1: iframe with movieid param
  const iframe = $('iframe[src*="movieid="]');
  if (iframe.length) {
    const src = iframe.attr("src");
    const m = src.match(/movieid=([a-f0-9]+)/i);
    if (m) return m[1];
  }
  // Pattern 2: iframe with fastplayer-cdn
  const iframe2 = $('iframe[src*="fastplayer"]');
  if (iframe2.length) {
    const src = iframe2.attr("src");
    const m = src.match(/movieid=([a-f0-9]+)/i);
    if (m) return m[1];
  }
  // Pattern 3: look in inline scripts
  const scripts = $("script:not([src])");
  let found = null;
  scripts.each((_, el) => {
    const text = $(el).text();
    const m = text.match(/movieid[=:]?\s*["']?([a-f0-9]{20,})["']?/i);
    if (m && !found) found = m[1];
  });
  return found;
}

/** Build m3u8 stream URL from movieid */
function buildStreamUrl(movieId) {
  return `${STREAM_BASE}${movieId}.m3u8`;
}

/** Extract track label from page */
function extractTrackLabel($) {
  const cat = $(".movie-category").text().trim();
  if (cat.includes("พากย์ไทย")) return "พากย์ไทย";
  if (cat.includes("ซับไทย")) return "ซับไทย";
  // Check title
  const title = $("h1").first().text();
  if (title.includes("พากย์ไทย")) return "พากย์ไทย";
  if (title.includes("ซับไทย")) return "ซับไทย";
  return "พากย์ไทย";
}

/** Extract title (clean up year and track labels) */
function extractTitle($) {
  let title = $("h1").first().text().trim()
    || $(".entry-title").first().text().trim()
    || $("title").text().split("|")[0].trim();
  // Remove site name suffix
  title = title.replace(/\s*[-|]?\s*ดูหนัง.*$/i, "").trim();
  // Remove year in parentheses at end
  title = title.replace(/\s*\(\d{4}\)\s*$/, "").trim();
  // Remove track labels
  title = title.replace(/\s*(พากย์ไทย|ซับไทย|เต็มเรื่อง|HD)\s*/g, " ").trim();
  return title;
}

/** Extract year from page */
function extractYear($) {
  const yearEl = $(".movie-category").text() + " " + $("h1").text();
  const m = yearEl.match(/(\d{4})/);
  return m ? m[1] : null;
}

// ───── TMDB Functions ─────
function cleanTitleForSearch(title) {
  return title
    .replace(/\[.*?\]/g, "")
    .replace(/\(.*?\)/g, "")
    .replace(/พากย์ไทย|ซับไทย|ซับ|พากย์|เต็มเรื่อง/g, "")
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

// ───── Parse allinhd.com page ─────
async function parsePage(url) {
  console.log(`\n📄 กำลัง fetch: ${url}`);
  const html = await fetchHtml(url);
  const $ = cheerio.load(html);

  const title    = extractTitle($);
  const movieId  = extractMovieId($);
  const track    = trackNameOverride || extractTrackLabel($);
  const poster   = $(".poster img, .sheader img, .movie-poster img, .entry-content img").first().attr("src") || "";
  const year     = extractYear($);

  if (!movieId) {
    throw new Error("ไม่พบ movieid ในหน้านี้ — ตรวจสอบ URL อีกครั้ง");
  }

  const streamUrl = buildStreamUrl(movieId);
  console.log(`  ✅ title: ${title}`);
  console.log(`  ✅ movieId: ${movieId}`);
  console.log(`  ✅ track: ${track}`);
  console.log(`  ✅ stream: ${streamUrl}`);

  return { title, movieId, streamUrl, track, poster, year };
}

/** Parse a series page — find episode links */
async function parseSeriesPage(url) {
  console.log(`\n📄 กำลัง fetch series: ${url}`);
  const html = await fetchHtml(url);
  const $ = cheerio.load(html);

  const title  = extractTitle($);
  const poster = $(".poster img, .sheader img, .movie-poster img, .entry-content img").first().attr("src") || "";
  const track  = trackNameOverride || extractTrackLabel($);

  // Look for episode links on the page
  const episodeLinks = [];

  // Pattern 1: links with "episode" or "ep" and numbers
  $('a[href*="episode"], a[href*="-ep-"], a[href*="-ep"]').each((_, el) => {
    const href = $(el).attr("href");
    const text = $(el).text().trim();
    if (href && !episodeLinks.find(e => e.url === href)) {
      episodeLinks.push({ url: href, text });
    }
  });

  // Pattern 2: numbered list items with links
  if (episodeLinks.length === 0) {
    $(".episodios li a, .episodes li a, .ep-list a").each((_, el) => {
      const href = $(el).attr("href");
      const text = $(el).text().trim();
      if (href) episodeLinks.push({ url: href, text });
    });
  }

  // Pattern 3: single page with multiple embeds (different movieids)
  if (episodeLinks.length === 0) {
    const movieIds = [];
    $('iframe[src*="movieid="]').each((_, el) => {
      const src = $(el).attr("src");
      const m = src.match(/movieid=([a-f0-9]+)/i);
      if (m && !movieIds.includes(m[1])) movieIds.push(m[1]);
    });
    // Also check inline scripts for multiple movieids
    $("script:not([src])").each((_, el) => {
      const text = $(el).text();
      const matches = text.matchAll(/movieid[=:]?\s*["']?([a-f0-9]{20,})["']?/gi);
      for (const m of matches) {
        if (!movieIds.includes(m[1])) movieIds.push(m[1]);
      }
    });
    if (movieIds.length > 1) {
      return { title, poster, track, episodes: movieIds.map((id, i) => ({ movieId: id, epNum: i + 1 })) };
    }
  }

  console.log(`  📺 พบ ${episodeLinks.length} ตอน`);
  return { title, poster, track, episodeLinks };
}

// ───── Playlist file operations ─────
function resolvePlaylistFile(fname) {
  if (fs.existsSync(path.resolve(PLAYLIST_DIR, fname))) return fname;
  const files = fs.readdirSync(PLAYLIST_DIR);
  const match = files.find((f) => f === fname || f.endsWith(`-${fname}`));
  return match || fname;
}

// ── Part file: เก็บ stream ของภาคเดียว ──
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

// ── Main file: index รวมทุกภาค ชี้ไปหา part files ──
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
      (playlist.groups || []).forEach(g => {
        g.image = tmdbPoster;
        (g.stations || []).forEach(s => { s.image = tmdbPoster; });
      });
    }
    if (doTitle) playlist.name = tmdbName;

    fs.writeFileSync(outputPath, JSON.stringify(playlist, null, 4), "utf-8");
    console.log(`\n📁 อัปเดตไฟล์: ${outputPath}`);
    updateIndex(tmdbName, tmdbPoster, resolvedOutput, { upsert: true });
    console.log("🎉 เสร็จสิ้น!");
    return;
  }

  // Series update-meta
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

  if (doPoster && !seasonName) { playlist.name = tmdbName; playlist.image = tmdbPoster; }

  const allSeasons      = playlist.groups || [];
  const seasonsToUpdate = seasonName
    ? allSeasons.filter((s) => s.name === seasonName)
    : allSeasons;

  for (const season of seasonsToUpdate) {
    const sNum = /specials/i.test(season.name) ? 0 : (parseInt(season.name?.match(/\d+/)?.[0]) || 1);
    const lookupSeason = tmdbSeasonNum || sNum;
    const tmdbSeason = await getTmdbSeasonBilingual(tmdbResult.id, tmdbKey, lookupSeason);
    const { enEpisodes: enEps, thEpisodes: thEps } = tmdbSeason;
    const seasonPoster = tmdbSeason.poster || tmdbPoster;

    if (doPoster) season.image = seasonPoster;

    const tracks = season.groups?.length ? season.groups : [season];
    for (const track of tracks) {
      if (!Array.isArray(track.stations)) continue;
      if (doPoster) track.image = seasonPoster;

      const dubbed  = track.name === "พากย์ไทย" || !track.name;
      const tmdbEps = dubbed ? thEps : enEps;

      track.stations.forEach((station, i) => {
        const stationEpMatch = station.name?.match(/(?:ตอน|Ep\.?)\s*(\d+)/i);
        const stationEpNum = stationEpMatch ? parseInt(stationEpMatch[1]) : (i + 1);
        const tmdbEpNum = stationEpNum + epOffset;
        const tmdbEp = tmdbEps.find(e => e.episode_number === tmdbEpNum) || tmdbEps[i + epOffset];
        if (doTitle && tmdbEp?.name) station.name  = buildStationName(stationEpNum, tmdbEp.name, dubbed);
        if (doCover && tmdbEp?.still_path) station.image = `https://image.tmdb.org/t/p/original${tmdbEp.still_path}`;
      });
    }
  }

  fs.writeFileSync(outputPath, JSON.stringify(playlist, null, 4), "utf-8");
  console.log(`\n📁 อัปเดตไฟล์: ${outputPath}`);
  updateIndex(tmdbName, tmdbPoster, resolvedOutput, { upsert: true });
  console.log("🎉 เสร็จสิ้น!");
}

// ───── Main ─────
async function main() {
  if (updateMeta) { await runUpdateMeta(); return; }

  try {
    if (isMovie) {
      // ── Movie flow ──
      const { title, movieId, streamUrl, track, poster } = await parsePage(pageUrl);

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
          console.warn("⚠️  ไม่พบใน TMDB ใช้ข้อมูลจาก allinhd แทน");
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

      const partPlaylist = buildPartFile(partPath, partSeason, posterUrl, track, streamUrl, pageUrl);
      fs.writeFileSync(partPath, JSON.stringify(partPlaylist, null, 4), "utf-8");
      console.log(`\n📁 บันทึก part file: ${partPath}`);

      // ── Main file: {slug}.txt (index รวมทุกภาค) ──
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
      const result = await parseSeriesPage(pageUrl);
      const { title, poster, track } = result;

      // If we have direct movieIds (multi-embed page)
      let episodes = [];
      if (result.episodes) {
        episodes = result.episodes;
      } else if (result.episodeLinks?.length > 0) {
        // Fetch each episode page to get movieId
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
            } else {
              console.warn(` ⚠️ ไม่พบ movieId`);
            }
          } catch (err) {
            console.warn(` ⚠️ ${err.message}`);
          }
          if (i < result.episodeLinks.length - 1) await sleep(500);
        }
      } else {
        // Single page — try to extract movieId directly
        const html = await fetchHtml(pageUrl);
        const $ = cheerio.load(html);
        const movieId = extractMovieId($);
        if (movieId) {
          episodes.push({ movieId, epNum: 1 });
        } else {
          console.error("❌ ไม่พบ episode หรือ movieid ใดเลย");
          process.exit(1);
        }
      }

      if (episodes.length === 0) {
        console.error("❌ ไม่พบ episode ที่มี stream URL");
        process.exit(1);
      }

      // TMDB lookup
      let seriesTitle     = title;
      let posterUrl       = poster;
      let seasonPosterUrl = poster;
      let tmdbEpisodes    = [];
      let tmdbShow        = null;
      const isDubbedTrack = track === "พากย์ไทย";

      if (tmdbKey) {
        let tmdbResult;
        if (forceTmdbId) {
          tmdbResult = await getTmdbShow(forceTmdbId, tmdbKey, "en-US");
        } else {
          tmdbResult = await searchTmdb(title, tmdbKey);
        }
        if (tmdbResult) {
          const tmdbEnName = tmdbResult.name || title;
          const tmdbThName = await getTmdbShowNameTh(tmdbResult.id, tmdbKey);
          seriesTitle     = formatSeriesTitle(tmdbEnName, tmdbThName);
          posterUrl       = tmdbResult.poster_path
            ? `https://image.tmdb.org/t/p/original${tmdbResult.poster_path}`
            : poster;
          seasonPosterUrl = posterUrl;
          tmdbShow        = tmdbResult;
          console.log(`✅ พบใน TMDB: "${seriesTitle}" (ID: ${tmdbResult.id})`);

          const lookupSeason = tmdbSeasonNum || seasonNum || 1;
          if (isDubbedTrack) {
            const biData = await getTmdbSeasonBilingual(tmdbResult.id, tmdbKey, lookupSeason);
            tmdbEpisodes    = biData.thEpisodes;
            if (biData.poster) seasonPosterUrl = biData.poster;
          } else {
            const seasonData = await getTmdbSeason(tmdbResult.id, tmdbKey, lookupSeason, "en-US");
            tmdbEpisodes    = seasonData.episodes;
            if (seasonData.poster) seasonPosterUrl = seasonData.poster;
          }
          console.log(`✅ ดึงข้อมูล ${tmdbEpisodes.length} ตอน จาก TMDB`);
        } else {
          console.warn("⚠️  ไม่พบใน TMDB ใช้ข้อมูลจาก allinhd แทน");
        }
      }

      // Build stations
      const stations = episodes.map((ep, i) => {
        const epNum    = ep.epNum || (i + 1);
        const tmdbEpNum = epNum + epOffset;
        const tmdbEp   = tmdbEpisodes.find(e => e.episode_number === tmdbEpNum) || tmdbEpisodes[i + epOffset];
        const epTitle  = tmdbEp?.name || "";
        const epThumb  = tmdbEp?.still_path ? `https://image.tmdb.org/t/p/original${tmdbEp.still_path}` : "";
        const stationName = buildStationName(epNum, epTitle, isDubbedTrack);

        return {
          name:  stationName,
          ...(epThumb && { image: epThumb }),
          url:   buildStreamUrl(ep.movieId),
          referer: STREAM_REFERER,
        };
      });

      // Build playlist (Series structure: seasons → tracks → episodes)
      const slug       = customOutput || slugify(seriesTitle.replace(/\[.*?\]/g, "").trim());
      const slugFile   = slug.endsWith(".txt") ? slug : `${slug}.txt`;
      const resolvedId = idPrefixArg || String(tmdbShow?.id || "");
      const outputFile = resolvedId ? `${resolvedId}-${slugFile}` : slugFile;
      const outputPath = path.resolve(PLAYLIST_DIR, outputFile);

      const targetSeason = seasonName || "Season 1";
      const newTrack = { name: track, image: seasonPosterUrl, referer: pageUrl, stations };

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
        season.groups = season.groups.filter(g => g.name !== track);
        season.groups.push(newTrack);
        season.groups.sort((a, b) => {
          if (a.name === "พากย์ไทย") return -1;
          if (b.name === "พากย์ไทย") return 1;
          return 0;
        });
        console.log(`\n🔀 Merge "${track}" เข้า "${targetSeason}"`);
      } else {
        playlist = {
          name:   seriesTitle,
          image:  posterUrl,
          groups: [{ name: targetSeason, image: seasonPosterUrl, groups: [newTrack] }],
        };
      }

      fs.writeFileSync(outputPath, JSON.stringify(playlist, null, 4), "utf-8");
      console.log(`\n📁 บันทึกไฟล์: ${outputPath}`);
      updateIndex(seriesTitle, posterUrl, outputFile);
      console.log("\n🎉 เสร็จสิ้น!");
      console.log(`   ไฟล์: ${TYPE_CONFIG[contentType].base}${outputFile}`);
      console.log(`   จำนวนตอน: ${stations.length}`);
    }
  } catch (err) {
    console.error(`\n❌ Error: ${err.message}`);
    process.exit(1);
  }
}

main();

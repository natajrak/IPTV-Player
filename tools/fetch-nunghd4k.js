#!/usr/bin/env node
/**
 * fetch-nunghd4k.js
 * สร้าง / อัปเดต playlist JSON จาก nunghd4k.com พร้อม metadata จาก TMDB
 *
 * ─── Flags ───────────────────────────────────────────────────────────────
 *   <url>              URL หน้า nunghd4k.com (movie หรือ series)
 *                      เช่น https://www.nunghd4k.com/bts-the-comeback-live-arirang-2026/
 *   --track=th|subth   th = พากย์ไทย, subth = ซับไทย (default: th)
 *   --season=N         ระบุ season (default: 1, สำหรับ series)
 *   --output=FILE      ชื่อไฟล์ผลลัพธ์ใน playlist/ (ไม่ต้องใส่ path)
 *   --tmdb-id=N        ระบุ TMDB ID ตรงๆ
 *   --update-meta[=poster|cover|title]
 *                      อัปเดต metadata จาก TMDB โดยไม่ fetch stream URLs ใหม่
 *   --type=anime-series|series|anime-movie|movie
 *                      ระบุหมวดหมู่ (default: auto-detect)
 *
 * ─── Workflow ────────────────────────────────────────────────────────────
 *   Movie : page → iframe#player-iframe[src*="vid.php?...&id={movieId}"]
 *         → https://doo-play.com/embed/fasthd.php?key=nunghd4k&id={movieId}
 *         → var videoSrc = "{m3u8}"
 *
 *   Series: page → select#primary-player-select option[0].value → api_player1.php URL
 *         → fetch → JSON [{url, episode}, ...]
 *         → ตรวจจับจำนวนตอนจาก title "Ep1-N" ถ้า API ล้มเหลว
 *         → doo-play.com/embed/?id={seriesId}&ep={N}&type=series
 *         → var videoSrc หรือ JWPlayer sources[].file
 *
 * ─── หมายเหตุ ──────────────────────────────────────────────────────────
 *   - ส่วน series ต้องการให้ admin nunghd4k ตั้งค่า episode data ไว้ที่ doo-play
 *   - ถ้า api_player1.php คืน error จะ fallback ไปสร้าง URL จาก ep range ใน title
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
const idPrefixArg  = (args.find((a) => a.startsWith("--id-prefix=")) || "").replace("--id-prefix=", "");
const mainSlugArg  = (args.find((a) => a.startsWith("--main-slug=")) || "").replace("--main-slug=", "");

const trackArg  = (args.find((a) => a.startsWith("--track=")) || "").replace("--track=", "");
const TRACK_MAP = { th: "พากย์ไทย", subth: "ซับไทย" };
const trackName = TRACK_MAP[trackArg] || trackArg || "พากย์ไทย";
const isDubbedTrack = trackName === "พากย์ไทย";

const seasonArg  = args.find((a) => a.startsWith("--season="));
const seasonNum  = seasonArg ? (parseInt(seasonArg.replace("--season=", "")) ?? null) : null;
const seasonName = seasonNum != null ? (seasonNum === 0 ? "Specials" : `Season ${seasonNum}`) : null;

const updateMetaArg  = args.find((a) => a === "--update-meta" || a.startsWith("--update-meta="));
const updateMeta     = !!updateMetaArg;
const updateMetaMode = updateMetaArg?.includes("=") ? updateMetaArg.split("=")[1] : "all";

const tmdbIdArg   = args.find((a) => a.startsWith("--tmdb-id="));
const forceTmdbId = tmdbIdArg ? parseInt(tmdbIdArg.replace("--tmdb-id=", "")) || null : null;

const typeArg    = (args.find((a) => a.startsWith("--type=")) || "").replace("--type=", "");
const validTypes = ["anime-series", "series", "anime-movie", "movie"];
const forceType  = validTypes.includes(typeArg) ? typeArg : null;

if (!pageUrl && !updateMeta) {
  console.error("Usage: node fetch-nunghd4k.js <url> [--track=th|subth] [--season=N] [--output=FILE]");
  console.error("       node fetch-nunghd4k.js --update-meta[=poster|cover|title] --output=FILE.txt");
  process.exit(1);
}

// ───── Config ─────
const TYPE_CONFIG = {
  "anime-series": { dir: "../playlist/anime/series", base: "playlist/anime/series/" },
  "anime-movie":  { dir: "../playlist/anime/movies", base: "playlist/anime/movies/"  },
  "movie":        { dir: "../playlist/movies",       base: "playlist/movies/"        },
  "series":       { dir: "../playlist/series",       base: "playlist/series/"        },
};

const SITE_ORIGIN  = "https://www.nunghd4k.com";
const DOOPLAY_REFERER = "https://www.nunghd4k.com/";
const SITE_HEADERS = {
  "User-Agent":      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120 Safari/537.36",
  "Accept-Language": "th-TH,th;q=0.9,en;q=0.8",
  "Accept":          "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
  "Referer":         SITE_ORIGIN + "/",
};

// ───── Helpers ─────
async function fetchHtml(url, extraHeaders = {}) {
  const res = await fetch(url, { headers: { ...SITE_HEADERS, ...extraHeaders } });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  return res.text();
}

async function fetchJson(url, extraHeaders = {}) {
  const res = await fetch(url, { headers: { ...SITE_HEADERS, ...extraHeaders } });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  return res.json();
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

function slugify(name) {
  return name
    .replace(/[^\w\s-]/g, "")
    .trim()
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-");
}

// ───── Step 1: Parse nunghd4k.com page ─────
async function parsePage(url) {
  console.log(`\n📄 กำลัง fetch หน้า: ${url}`);
  const html = await fetchHtml(url);
  const $    = cheerio.load(html);

  const pageTitle = $("title").text()
    .replace(/^ดู\s+/i, "")
    .replace(/\s*ฟรี.*$/i, "")
    .replace(/\s*พากย์ไทย.*$/i, "")
    .trim();

  // Detect type from page structure
  const iframeSrc = $("iframe#player-iframe").attr("src") || "";
  const hasVidPhp = iframeSrc.includes("vid.php");
  const hasApiSelect = $("select#primary-player-select").length > 0;

  if (hasVidPhp) {
    // ─── Movie ───────────────────────────────────────────────
    const iUrl   = iframeSrc.startsWith("http") ? iframeSrc : `${SITE_ORIGIN}${iframeSrc}`;
    const u      = new URL(iUrl);
    const movieId = u.searchParams.get("id");
    if (!movieId) throw new Error("ไม่พบ movie ID ใน iframe src");
    console.log(`✅ พบ: Movie — ID: ${movieId}, ชื่อ: "${pageTitle}"`);
    return { isMovie: true, pageTitle, movieId };

  } else if (hasApiSelect) {
    // ─── Series ──────────────────────────────────────────────
    const apiUrl  = $("select#primary-player-select option").first().attr("value") || "";
    // Extract last &id=... from the nested URL
    const idMatch = apiUrl.match(/[?&]id=([^&?\s]+)(?:[?&].*)?$/);
    const seriesId = idMatch ? idMatch[1].split("&")[0] : null;
    if (!seriesId) throw new Error("ไม่พบ series ID ใน api_player URL");

    // Parse episode range from title/heading: "Ep1-36" → 36
    const allText = $("title, h1").text();
    const epMatch = allText.match(/Ep\d+\s*[-–]\s*(\d+)/i);
    const totalEpisodes = epMatch ? parseInt(epMatch[1]) : 0;

    console.log(`✅ พบ: Series — ID: ${seriesId}, ตอน: ${totalEpisodes || "?"}, ชื่อ: "${pageTitle}"`);
    return { isMovie: false, pageTitle, seriesId, apiUrl, totalEpisodes };

  } else {
    throw new Error("ไม่สามารถตรวจจับประเภท (ไม่พบ #player-iframe หรือ #primary-player-select)");
  }
}

// ───── Step 2a: Get movie stream URL ─────
async function getMovieStream(movieId) {
  const embedUrl = `https://doo-play.com/embed/fasthd.php?key=nunghd4k&id=${movieId}`;
  console.log(`\n🔗 กำลัง fetch embed: ${embedUrl}`);
  const html = await fetchHtml(embedUrl, { Referer: DOOPLAY_REFERER });
  const m    = html.match(/var\s+videoSrc\s*=\s*["']([^"']+)["']/);
  if (!m) throw new Error("ไม่พบ videoSrc ใน doo-play embed");
  const streamUrl = m[1];
  console.log(`✅ พบ stream URL`);
  return { url: streamUrl, referer: DOOPLAY_REFERER };
}

// ───── Step 2b: Get series episode stream URL ─────
async function getSeriesStream(seriesId, epNum) {
  const embedUrl = `https://doo-play.com/embed/?id=${seriesId}&ep=${epNum}&type=series`;
  const html     = await fetchHtml(embedUrl, { Referer: DOOPLAY_REFERER });

  // Try: var videoSrc = "..."
  const m1 = html.match(/var\s+videoSrc\s*=\s*["']([^"']+)["']/);
  if (m1) return { url: m1[1], referer: DOOPLAY_REFERER };

  // Try: JWPlayer sources[].file
  const m2 = html.match(/sources\s*:\s*\[\s*\{[^}]*file\s*:\s*["']([^"']+)["']/);
  if (m2) return { url: m2[1], referer: DOOPLAY_REFERER };

  // Try: file: "..." anywhere in script
  const m3 = html.match(/['"](https?:\/\/[^'"]+\.m3u8[^'"]*)['"]/);
  if (m3) return { url: m3[1], referer: DOOPLAY_REFERER };

  throw new Error(`ไม่พบ stream URL ใน episode ${epNum} (seriesId: ${seriesId})`);
}

// ───── Step 2b alt: Get episode list from api_player1.php ─────
async function fetchEpisodeList(apiUrl) {
  try {
    const data = await fetchJson(apiUrl, { Referer: DOOPLAY_REFERER });
    if (Array.isArray(data) && data.length > 0 && data[0].url) return data;
    if (data?.error) console.warn(`⚠️  api_player คืน error: ${data.error}`);
    return null;
  } catch (err) {
    console.warn(`⚠️  fetch api_player ล้มเหลว: ${err.message}`);
    return null;
  }
}

// ───── TMDB functions ─────
function cleanTitleForSearch(title) {
  return title
    .replace(/\[.*?\]/g, "").replace(/\(.*?\)/g, "")
    .replace(/พากย์ไทย|ซับไทย|ซับ|พากย์|Ep\d+[\s\S]*/gi, "")
    .replace(/[\u0E00-\u0E7F]+/g, "")
    .replace(/\s+/g, " ").trim();
}

async function searchTmdb(title, apiKey) {
  const q   = encodeURIComponent(cleanTitleForSearch(title));
  const res = await fetch(`https://api.themoviedb.org/3/search/tv?query=${q}&language=en-US&api_key=${apiKey}`);
  if (!res.ok) return null;
  const d = await res.json();
  return d.results?.[0] || null;
}

async function getTmdbShow(tvId, apiKey, language = "en-US") {
  const res = await fetch(`https://api.themoviedb.org/3/tv/${tvId}?language=${language}&api_key=${apiKey}`);
  if (!res.ok) return null;
  return res.json();
}

async function getTmdbShowNameTh(tvId, apiKey) {
  const d = await getTmdbShow(tvId, apiKey, "th-TH");
  return d?.name || null;
}

async function searchTmdbMovie(title, apiKey) {
  const q   = encodeURIComponent(cleanTitleForSearch(title));
  const res = await fetch(`https://api.themoviedb.org/3/search/movie?query=${q}&language=en-US&api_key=${apiKey}`);
  if (!res.ok) return null;
  const d = await res.json();
  return d.results?.[0] || null;
}

async function getTmdbMovieDetail(movieId, apiKey, language = "en-US") {
  const res = await fetch(`https://api.themoviedb.org/3/movie/${movieId}?language=${language}&api_key=${apiKey}`);
  if (!res.ok) return null;
  return res.json();
}

async function getTmdbMovieNameTh(movieId, apiKey) {
  const d = await getTmdbMovieDetail(movieId, apiKey, "th-TH");
  return d?.title || null;
}

function formatTitle(enName, thName) {
  if (thName && thName !== enName) return `${enName} [${thName}]`;
  return enName;
}

async function getTmdbSeason(tvId, apiKey, season = 1, language = "en-US") {
  const res  = await fetch(`https://api.themoviedb.org/3/tv/${tvId}/season/${season}?language=${language}&api_key=${apiKey}`);
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

function buildStationName(epNum, epTitle, isDubbed) {
  if (!epTitle) return isDubbed ? `ตอน ${epNum}` : `Ep. ${epNum}`;
  return isDubbed ? `ตอน ${epNum} - ${epTitle}` : `Ep. ${epNum} - ${epTitle}`;
}

// ───── Playlist builders ─────
function buildOrMergePlaylist(outputPath, seriesTitle, posterUrl, seasonPosterUrl, stations, track, trackReferer = null) {
  const newTrack = { name: track, image: seasonPosterUrl, ...(trackReferer && { referer: trackReferer }), stations };

  if (fs.existsSync(outputPath)) {
    let existing;
    try { existing = JSON.parse(fs.readFileSync(outputPath, "utf-8")); }
    catch { existing = null; }

    if (existing) {
      const targetName = seasonName || "Season 1";
      let season = existing.groups?.find((g) => g.name === targetName)
        ?? (seasonNum ? null : existing.groups?.[0]);

      if (!season) {
        existing.groups = existing.groups || [];
        season = { name: targetName, image: seasonPosterUrl, groups: [] };
        existing.groups.push(season);
      }

      if (season.stations && !season.groups) {
        const other = track === "พากย์ไทย" ? "ซับไทย" : "พากย์ไทย";
        season.groups = [{ name: other, image: season.image || posterUrl, stations: season.stations }];
        delete season.stations;
      }

      season.groups = (season.groups || []).filter((g) => g.name !== track);
      season.groups.push(newTrack);
      season.groups.sort((a, b) => {
        if (a.name === "พากย์ไทย") return -1;
        if (b.name === "พากย์ไทย") return 1;
        return 0;
      });
      console.log(`\n🔀 Merge "${track}" เข้าไฟล์เดิม (${season.groups.length} tracks)`);
      return existing;
    }
  }

  return {
    name:   seriesTitle,
    image:  posterUrl,
    groups: [{ name: seasonName || "Season 1", image: seasonPosterUrl, groups: [newTrack] }],
  };
}

function buildPartFile(outputPath, season, posterUrl, track, streamUrl, streamReferer, sourceUrl = null) {
  const partName   = `ภาค ${season}`;
  const newStation = { name: track, image: posterUrl, url: streamUrl, ...(sourceUrl && { referer: sourceUrl }) };

  let playlist;
  if (fs.existsSync(outputPath)) {
    try { playlist = JSON.parse(fs.readFileSync(outputPath, "utf-8")); }
    catch { playlist = null; }
  }
  if (!playlist) return { name: partName, image: posterUrl, stations: [newStation] };

  playlist.name    = partName;
  playlist.image   = posterUrl;
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

function updateIndex(PLAYLIST_DIR, GITHUB_RAW_BASE, seriesTitle, posterUrl, filename, { upsert = false } = {}) {
  const INDEX_PATH = path.resolve(PLAYLIST_DIR, "index.txt");
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
    const dupByName = index.groups.find((g) => g.name === seriesTitle);
    if (dupByName) console.warn(`⚠️  ชื่อ "${seriesTitle}" ซ้ำกับรายการที่มีอยู่ (${dupByName.url})`);
    index.groups.push({ url: fileUrl, name: seriesTitle, image: posterUrl });
  }

  index.groups.sort((a, b) => (a.name || "").localeCompare(b.name || "", undefined, { sensitivity: "base" }));
  fs.writeFileSync(INDEX_PATH, JSON.stringify(index, null, 2), "utf-8");
  console.log(`✅ ${existing ? "อัปเดต" : "เพิ่ม"} index.txt แล้ว (เรียงตามชื่อ A–Z)`);
}

function resolvePlaylistFile(PLAYLIST_DIR, fname) {
  if (fs.existsSync(path.resolve(PLAYLIST_DIR, fname))) return fname;
  const files = fs.readdirSync(PLAYLIST_DIR);
  const match = files.find((f) => f === fname || f.endsWith(`-${fname}`));
  return match || fname;
}

// ───── Update meta only ─────
async function runUpdateMeta() {
  if (!tmdbKey)      { console.error("❌ ต้องมี TMDB_API_KEY ใน .env"); process.exit(1); }
  if (!customOutput) { console.error("❌ ต้องระบุ --output=FILENAME.txt"); process.exit(1); }

  const resolvedType = forceType || "movie";
  const cfg          = TYPE_CONFIG[resolvedType];
  const PLAYLIST_DIR = path.resolve(__dirname, cfg.dir);
  const GITHUB_RAW_BASE = `https://raw.githubusercontent.com/natajrak/IPTV-Player/refs/heads/main/${cfg.base}`;

  const outputFile     = customOutput.endsWith(".txt") ? customOutput : `${customOutput}.txt`;
  const resolvedOutput = resolvePlaylistFile(PLAYLIST_DIR, outputFile);
  if (resolvedOutput !== outputFile) console.log(`📂 พบไฟล์: ${resolvedOutput}`);
  const outputPath = path.resolve(PLAYLIST_DIR, resolvedOutput);
  if (!fs.existsSync(outputPath)) { console.error(`❌ ไม่พบไฟล์: ${outputPath}`); process.exit(1); }

  const doPoster = updateMetaMode === "all" || updateMetaMode === "poster";
  const doTitle  = updateMetaMode === "all" || updateMetaMode === "title";
  console.log(`\n🔧 mode: ${updateMetaMode}`);

  const playlist = JSON.parse(fs.readFileSync(outputPath, "utf-8"));
  const rawTitle = playlist.name || "";
  const isMovieStructure = Array.isArray(playlist.stations);

  let tmdbResult;
  if (isMovieStructure) {
    if (forceTmdbId) {
      tmdbResult = await getTmdbMovieDetail(forceTmdbId, tmdbKey, "en-US");
    } else {
      console.log(`\n🎬 กำลัง search TMDB (movie): "${rawTitle}"`);
      tmdbResult = await searchTmdbMovie(rawTitle, tmdbKey);
    }
    if (!tmdbResult) { console.error("❌ ไม่พบใน TMDB"); process.exit(1); }
    const enName = tmdbResult.title || rawTitle;
    const thName = await getTmdbMovieNameTh(tmdbResult.id, tmdbKey);
    if (doTitle)  playlist.name  = formatTitle(enName, thName);
    if (doPoster) {
      const poster = `https://image.tmdb.org/t/p/original${tmdbResult.poster_path}`;
      playlist.image = poster;
      (playlist.stations || []).forEach((s) => { s.image = poster; });
    }
    console.log(`✅ ${formatTitle(tmdbResult.title, thName)} (ID: ${tmdbResult.id})`);
  } else {
    if (forceTmdbId) {
      tmdbResult = await getTmdbShow(forceTmdbId, tmdbKey, "en-US");
    } else {
      console.log(`\n🎬 กำลัง search TMDB (tv): "${rawTitle}"`);
      tmdbResult = await searchTmdb(rawTitle, tmdbKey);
    }
    if (!tmdbResult) { console.error("❌ ไม่พบใน TMDB"); process.exit(1); }
    const enName = tmdbResult.name || rawTitle;
    const thName = await getTmdbShowNameTh(tmdbResult.id, tmdbKey);
    const title  = formatTitle(enName, thName);
    const poster = tmdbResult.poster_path
      ? `https://image.tmdb.org/t/p/original${tmdbResult.poster_path}` : playlist.image;
    if (doTitle)  playlist.name  = title;
    if (doPoster) playlist.image = poster;

    const sNum = seasonNum || 1;
    const seasonData = isDubbedTrack
      ? await getTmdbSeasonBilingual(tmdbResult.id, tmdbKey, sNum)
      : { thEpisodes: [], enEpisodes: (await getTmdbSeason(tmdbResult.id, tmdbKey, sNum, "en-US")).episodes, poster: null };

    const tmdbEps = isDubbedTrack ? seasonData.thEpisodes : seasonData.enEpisodes;
    const sPoster = seasonData.poster || poster;
    const targetSeason = playlist.groups?.find((g) => g.name === (seasonName || "Season 1"));
    if (targetSeason) {
      if (doPoster) targetSeason.image = sPoster;
      (targetSeason.groups || []).forEach((track) => {
        if (doPoster) track.image = sPoster;
        (track.stations || []).forEach((st, i) => {
          const ep = tmdbEps[i];
          if (!ep) return;
          st.name = buildStationName(i + 1, ep.name || "", isDubbedTrack);
          if (doPoster && ep.still_path) st.image = `https://image.tmdb.org/t/p/original${ep.still_path}`;
        });
      });
    }
    console.log(`✅ ${title} (ID: ${tmdbResult.id})`);
  }

  fs.writeFileSync(outputPath, JSON.stringify(playlist, null, 4), "utf-8");
  console.log(`\n📁 บันทึกไฟล์: ${outputPath}`);

  const mainSlug = resolvedOutput.replace(/^\d+-/, "");
  const mainPath = path.resolve(PLAYLIST_DIR, mainSlug);
  if (doTitle && fs.existsSync(mainPath) && resolvedOutput !== mainSlug) {
    const main = JSON.parse(fs.readFileSync(mainPath, "utf-8"));
    if (main.name !== playlist.name || main.image !== playlist.image) {
      main.name  = playlist.name;
      main.image = playlist.image;
      fs.writeFileSync(mainPath, JSON.stringify(main, null, 4), "utf-8");
      console.log(`📁 อัปเดต main file: ${mainPath}`);
    }
    updateIndex(PLAYLIST_DIR, GITHUB_RAW_BASE, playlist.name, playlist.image, mainSlug, { upsert: true });
  } else {
    updateIndex(PLAYLIST_DIR, GITHUB_RAW_BASE, playlist.name, playlist.image, resolvedOutput, { upsert: true });
  }
  console.log("\n🎉 อัปเดต metadata เสร็จสิ้น!");
}

// ───── Main ─────
async function main() {
  if (updateMeta) { await runUpdateMeta(); return; }

  try {
    const pageInfo = await parsePage(pageUrl);

    // Determine content type
    let contentType = forceType;
    if (!contentType) {
      contentType = pageInfo.isMovie ? "movie" : "series";
    }
    const isMovie = contentType === "movie" || contentType === "anime-movie";
    const cfg     = TYPE_CONFIG[contentType];
    const PLAYLIST_DIR    = path.resolve(__dirname, cfg.dir);
    const GITHUB_RAW_BASE = `https://raw.githubusercontent.com/natajrak/IPTV-Player/refs/heads/main/${cfg.base}`;

    console.log(`📂 ประเภท: ${contentType}`);

    // TMDB lookup
    let seriesTitle    = pageInfo.pageTitle;
    let posterUrl      = "";
    let seasonPosterUrl = "";
    let tmdbEpisodes   = [];
    let tmdbShow       = null;

    if (tmdbKey) {
      if (isMovie) {
        let tmdbResult;
        if (forceTmdbId) {
          console.log(`\n🎬 ใช้ TMDB ID ที่ระบุ: ${forceTmdbId}`);
          tmdbResult = await getTmdbMovieDetail(forceTmdbId, tmdbKey, "en-US");
        } else {
          console.log("\n🎬 กำลัง search TMDB (movie)...");
          tmdbResult = await searchTmdbMovie(pageInfo.pageTitle, tmdbKey);
        }
        if (tmdbResult) {
          const enName = tmdbResult.title || pageInfo.pageTitle;
          const thName = await getTmdbMovieNameTh(tmdbResult.id, tmdbKey);
          seriesTitle  = formatTitle(enName, thName);
          posterUrl    = tmdbResult.poster_path
            ? `https://image.tmdb.org/t/p/original${tmdbResult.poster_path}` : "";
          seasonPosterUrl = posterUrl;
          tmdbShow        = tmdbResult;
          console.log(`✅ พบใน TMDB: "${seriesTitle}" (ID: ${tmdbResult.id})`);
        } else {
          console.warn("⚠️  ไม่พบใน TMDB ใช้ชื่อจากหน้าแทน");
        }
      } else {
        let tmdbResult;
        if (forceTmdbId) {
          console.log(`\n🎬 ใช้ TMDB ID ที่ระบุ: ${forceTmdbId}`);
          tmdbResult = await getTmdbShow(forceTmdbId, tmdbKey, "en-US");
        } else {
          console.log("\n🎬 กำลัง search TMDB...");
          tmdbResult = await searchTmdb(pageInfo.pageTitle, tmdbKey);
        }
        if (tmdbResult) {
          const enName = tmdbResult.name || pageInfo.pageTitle;
          const thName = await getTmdbShowNameTh(tmdbResult.id, tmdbKey);
          seriesTitle     = formatTitle(enName, thName);
          posterUrl       = tmdbResult.poster_path
            ? `https://image.tmdb.org/t/p/original${tmdbResult.poster_path}` : "";
          seasonPosterUrl = posterUrl;
          tmdbShow        = tmdbResult;

          const sNum = seasonNum || 1;
          if (isDubbedTrack) {
            const biData = await getTmdbSeasonBilingual(tmdbResult.id, tmdbKey, sNum);
            tmdbEpisodes    = biData.thEpisodes;
            if (biData.poster) seasonPosterUrl = biData.poster;
          } else {
            const sData = await getTmdbSeason(tmdbResult.id, tmdbKey, sNum, "en-US");
            tmdbEpisodes    = sData.episodes;
            if (sData.poster) seasonPosterUrl = sData.poster;
          }
          console.log(`✅ พบใน TMDB: "${seriesTitle}" (ID: ${tmdbResult.id}) — ${tmdbEpisodes.length} ตอน`);
        } else {
          console.warn("⚠️  ไม่พบใน TMDB ใช้ชื่อจากหน้าแทน");
        }
      }
    }

    // Fetch stream URLs
    const stations = [];

    if (isMovie) {
      const stream = await getMovieStream(pageInfo.movieId);
      stations.push({
        name:    trackName,
        image:   posterUrl,
        url:     stream.url,
        referer: stream.referer,
      });
    } else {
      // ── Series ──────────────────────────────────────────────
      // Try api_player1.php first to get episode list
      let episodeItems = await fetchEpisodeList(pageInfo.apiUrl);

      let episodeUrls = [];
      if (episodeItems && episodeItems.length > 0) {
        console.log(`✅ api_player คืน ${episodeItems.length} ตอน`);
        episodeUrls = episodeItems.map((item) => ({ ep: item.episode, url: item.url }));
      } else {
        // Fallback: construct episode URLs from seriesId + ep range
        const total = pageInfo.totalEpisodes;
        if (!total) { console.error("❌ ไม่พบจำนวนตอนทั้งหมด"); process.exit(1); }
        console.log(`⚠️  ใช้ fallback URL จาก ep range (1-${total})`);
        for (let n = 1; n <= total; n++) {
          episodeUrls.push({
            ep:  n,
            url: `https://doo-play.com/embed/?id=${pageInfo.seriesId}&ep=${n}&type=series`,
          });
        }
      }

      console.log(`\n🔗 กำลัง fetch stream URLs (${episodeUrls.length} ตอน)...`);
      for (let i = 0; i < episodeUrls.length; i++) {
        const { ep, url: epEmbedUrl } = episodeUrls[i];
        process.stdout.write(`  ตอน ${ep}/${episodeUrls.length}...`);

        let stream = null;
        try {
          stream = await getSeriesStream(pageInfo.seriesId, ep);
          process.stdout.write(` ✅\n`);
        } catch (err) {
          process.stdout.write(` ⚠️  ${err.message}\n`);
        }

        const tmdbEp  = tmdbEpisodes[i];
        const epTitle = tmdbEp?.name || "";
        const epThumb = tmdbEp?.still_path
          ? `https://image.tmdb.org/t/p/original${tmdbEp.still_path}` : "";
        const stName  = buildStationName(ep, epTitle, isDubbedTrack);

        stations.push({
          name:    stName,
          ...(epThumb && { image: epThumb }),
          url:     stream?.url || epEmbedUrl,
          referer: stream?.referer || DOOPLAY_REFERER,
        });
        if (i < episodeUrls.length - 1) await sleep(600);
      }
    }

    // Determine output filename
    const slug       = customOutput || slugify(seriesTitle.replace(/\[.*?\]/g, "").replace(/\(.*?\)/g, "").trim());
    const slugFile   = slug.endsWith(".txt") ? slug : `${slug}.txt`;
    const resolvedId = idPrefixArg || String(tmdbShow?.id || "");
    const outputFile = resolvedId ? `${resolvedId}-${slugFile}` : slugFile;
    const outputPath = path.resolve(PLAYLIST_DIR, outputFile);

    if (isMovie) {
      const s = stations[0];
      if (!s) { console.error("❌ ไม่พบ stream URL"); process.exit(1); }

      const partSeason   = seasonNum || 1;
      const partPlaylist = buildPartFile(outputPath, partSeason, posterUrl, trackName, s.url, s.referer, pageUrl);
      fs.writeFileSync(outputPath, JSON.stringify(partPlaylist, null, 4), "utf-8");
      console.log(`\n📁 บันทึก part file: ${outputPath}`);

      const mainFileSlug = mainSlugArg ? (mainSlugArg.endsWith(".txt") ? mainSlugArg : `${mainSlugArg}.txt`) : slugFile;
      const mainPath    = path.resolve(PLAYLIST_DIR, mainFileSlug);
      const partRawUrl  = `${GITHUB_RAW_BASE}${outputFile}`;
      const mainPlaylist = upsertMainFile(mainPath, seriesTitle, posterUrl, seriesTitle, posterUrl, partRawUrl, partSeason);
      fs.writeFileSync(mainPath, JSON.stringify(mainPlaylist, null, 4), "utf-8");
      console.log(`📁 บันทึก main file: ${mainPath}`);
      updateIndex(PLAYLIST_DIR, GITHUB_RAW_BASE, seriesTitle, posterUrl, mainFileSlug);
    } else {
      const playlist = buildOrMergePlaylist(outputPath, seriesTitle, posterUrl, seasonPosterUrl, stations, trackName, pageUrl);
      fs.writeFileSync(outputPath, JSON.stringify(playlist, null, 4), "utf-8");
      console.log(`\n📁 บันทึกไฟล์: ${outputPath}`);
      updateIndex(PLAYLIST_DIR, GITHUB_RAW_BASE, seriesTitle, posterUrl, outputFile);
    }

    console.log("\n🎉 เสร็จสิ้น!");
    console.log(`   ไฟล์: ${cfg.base}${outputFile}`);
    console.log(`   ${isMovie ? "ประเภท: Movie" : `จำนวนตอน: ${stations.length}`}`);
  } catch (err) {
    console.error(`\n❌ Error: ${err.message}`);
    process.exit(1);
  }
}

main();

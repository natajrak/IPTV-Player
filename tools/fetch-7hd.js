#!/usr/bin/env node
/**
 * fetch-7hd.js
 * สร้าง / อัปเดต playlist JSON จาก 7-hd.com พร้อม metadata จาก TMDB
 * Stream ผ่าน weplayhls.xyz embed → window.playerConfig
 *
 * ─── Flags ───────────────────────────────────────────────────────────────
 *   <url>              URL หน้า 7-hd.com (movie หรือ series)
 *                      เช่น https://7-hd.com/ready-or-not-2-.../
 *   --track=th|subth   th = พากย์ไทย, subth = ซับไทย (default: subth)
 *   --season=N         ระบุ season (default: 1, สำหรับ series)
 *   --output=FILE      ชื่อไฟล์ผลลัพธ์ใน playlist/ (ไม่ต้องใส่ path)
 *   --tmdb-id=N        ระบุ TMDB ID ตรงๆ (ใช้เมื่อ search ได้ผลผิด)
 *   --update-meta[=poster|cover|title]
 *                      อัปเดต metadata จาก TMDB โดยไม่ fetch stream URLs ใหม่
 *   --type=anime-series|series|anime-movie|movie
 *                      ระบุหมวดหมู่ (default: auto-detect จากหน้า)
 *
 * ─── Workflow ────────────────────────────────────────────────────────────
 *   Movie : page → 1 weplayhls embed URL → playerConfig → stream
 *   Series: page → N weplayhls embed URLs (ตอนละ 1) → playerConfig → streams
 *
 * ─── Stream URL ──────────────────────────────────────────────────────────
 *   https://{playerConfig.asset}/{playerConfig.medias.original}/playlist.m3u8
 *   Referer: https://weplayhls.xyz/
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

const trackArg  = (args.find((a) => a.startsWith("--track=")) || "").replace("--track=", "");
const TRACK_MAP = { th: "พากย์ไทย", subth: "ซับไทย" };
const trackName = TRACK_MAP[trackArg] || trackArg || "ซับไทย";
const isDubbedTrack = trackName === "พากย์ไทย";

const seasonArg  = args.find((a) => a.startsWith("--season="));
const seasonNum  = seasonArg ? (parseInt(seasonArg.replace("--season=", "")) ?? null) : null;
const seasonName = seasonNum != null ? (seasonNum === 0 ? "Specials" : `Season ${seasonNum}`) : null;

const updateMetaArg  = args.find((a) => a === "--update-meta" || a.startsWith("--update-meta="));
const updateMeta     = !!updateMetaArg;
const updateMetaMode = updateMetaArg?.includes("=") ? updateMetaArg.split("=")[1] : "all";

const tmdbIdArg   = args.find((a) => a.startsWith("--tmdb-id="));
const forceTmdbId = tmdbIdArg ? parseInt(tmdbIdArg.replace("--tmdb-id=", "")) || null : null;

const typeArg     = (args.find((a) => a.startsWith("--type=")) || "").replace("--type=", "");
const BUILTIN_TYPES = ["anime-series", "series", "anime-movie", "movie"];

if (!pageUrl && !updateMeta) {
  console.error("Usage: node fetch-7hd.js <url> [--track=th|subth] [--season=N] [--output=FILE]");
  console.error("       node fetch-7hd.js --update-meta[=poster|cover|title] --output=FILE.txt");
  process.exit(1);
}

// ───── Config ─────
const TYPE_CONFIG = {
  "anime-series": { dir: "../playlist/anime/series", base: "playlist/anime/series/", kind: "series" },
  "anime-movie":  { dir: "../playlist/anime/movies", base: "playlist/anime/movies/", kind: "movie"  },
  "movie":        { dir: "../playlist/movies",       base: "playlist/movies/",       kind: "movie"  },
  "series":       { dir: "../playlist/series",       base: "playlist/series/",       kind: "series" },
};

// Support custom types from custom-tabs.json
if (typeArg && !BUILTIN_TYPES.includes(typeArg)) {
  try {
    const customs = JSON.parse(fs.readFileSync(path.resolve(__dirname, '../playlist/custom-tabs.json'), 'utf-8'));
    const custom = customs.find(c => c.key === typeArg);
    if (custom) {
      TYPE_CONFIG[typeArg] = { dir: `../${custom.dir}`, base: `${custom.dir}/`, kind: custom.kind };
    }
  } catch {}
}

const forceType   = TYPE_CONFIG[typeArg] ? typeArg : null;

const WEPLAYHLS_REFERER = "https://weplayhls.xyz/";
const SITE_HEADERS = {
  "User-Agent":      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120 Safari/537.36",
  "Accept-Language": "th-TH,th;q=0.9,en;q=0.8",
  "Accept":          "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
  "Referer":         "https://7-hd.com/",
};

// ───── Helpers ─────
async function fetchHtml(url, extraHeaders = {}) {
  const res = await fetch(url, { headers: { ...SITE_HEADERS, ...extraHeaders } });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  return res.text();
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

function slugify(name) {
  return name
    .replace(/[^\w\s-]/g, "")
    .trim()
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-");
}

// ───── Step 1: Parse 7-hd.com page ─────
async function parsePage(url) {
  console.log(`\n📄 กำลัง fetch หน้า: ${url}`);
  const html = await fetchHtml(url);
  const $    = cheerio.load(html);

  // Title from <title>: "ดู Title (Year) ฟรี ออนไลน์ เต็มเรื่อง คุณภาพดี 7-hd.com"
  let rawTitle = $("title").text()
    .replace(/^ดู\s+/i, "")
    .replace(/\s+ฟรี.*$/i, "")
    .trim();

  if (!rawTitle) rawTitle = $("h1").first().text().trim();

  // Collect unique weplayhls embed URLs in page order
  const embedUrls = [];
  const seen      = new Set();
  $("a[href*='weplayhls.xyz/embed/']").each((_, el) => {
    let href = $(el).attr("href") || "";
    if (!href) return;
    if (!href.startsWith("http")) href = "https:" + href;
    if (!seen.has(href)) {
      seen.add(href);
      embedUrls.push(href);
    }
  });

  if (embedUrls.length === 0) throw new Error("ไม่พบ weplayhls embed URL บนหน้านี้");

  // 1 unique URL = movie, multiple = series
  const isMoviePage = embedUrls.length === 1;

  console.log(`✅ พบ: "${rawTitle}" — ${isMoviePage ? "Movie" : `Series (${embedUrls.length} ตอน)`}`);
  return { rawTitle, embedUrls, isMoviePage };
}

// ───── Step 2: Extract stream from weplayhls embed ─────
async function getStreamFromEmbed(embedUrl) {
  const html = await fetchHtml(embedUrl, { Referer: "https://7-hd.com/" });
  const m    = html.match(/playerConfig\s*=\s*(\{[^\n]+\})\s*;?/);
  if (!m) throw new Error(`ไม่พบ playerConfig ใน ${embedUrl}`);

  let config;
  try { config = JSON.parse(m[1]); }
  catch (e) { throw new Error(`parse playerConfig ไม่ได้: ${e.message}`); }

  const asset  = config.asset;
  const medias = config.medias || {};
  // เลือก quality สูงสุดที่มี: original > 1080 > 720 > 480 > 360
  const preferOrder = ["original", "1080", "720", "480", "360"];
  const bestKey = preferOrder.find((k) => medias[k]) || Object.keys(medias).pop();
  const mediaId = bestKey ? medias[bestKey] : null;
  if (!asset || !mediaId) throw new Error(`ไม่พบ asset/mediaId ใน playerConfig`);

  console.log(`    📺 quality: ${bestKey} (มี: ${Object.keys(medias).join(", ")})`);

  // Wrap through CF Worker proxy เพื่อ fix Content-Type ของ segments ที่ใช้ extension ปลอม
  // ทำให้ Safari iOS native HLS เล่นได้
  const rawUrl = `https://${asset}/${mediaId}/video.m3u8`;
  const CF_WORKER = "https://shy-haze-2452.natajrak-p.workers.dev/";
  return {
    url:     `${CF_WORKER}?url=${encodeURIComponent(rawUrl)}&referer=${encodeURIComponent(WEPLAYHLS_REFERER)}`,
    referer: WEPLAYHLS_REFERER,
  };
}

// ───── TMDB functions ─────
function cleanTitleForSearch(title) {
  return title
    .replace(/\[.*?\]/g, "").replace(/\(.*?\)/g, "")
    .replace(/พากย์ไทย|ซับไทย|ซับ|พากย์/g, "")
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

  const resolvedType  = forceType || "series";
  const cfg           = TYPE_CONFIG[resolvedType];
  const PLAYLIST_DIR  = path.resolve(__dirname, cfg.dir);
  const GITHUB_RAW_BASE = `https://raw.githubusercontent.com/natajrak/IPTV-Player/refs/heads/main/${cfg.base}`;

  const outputFile    = customOutput.endsWith(".txt") ? customOutput : `${customOutput}.txt`;
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
    if (doTitle) playlist.name = formatTitle(enName, thName);
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

    const tmdbEps  = isDubbedTrack ? seasonData.thEpisodes : seasonData.enEpisodes;
    const sPoster  = seasonData.poster || poster;
    const targetSeason = playlist.groups?.find((g) => g.name === (seasonName || "Season 1"));
    if (targetSeason) {
      if (doPoster) targetSeason.image = sPoster;
      (targetSeason.groups || []).forEach((track) => {
        if (doPoster) track.image = sPoster;
        (track.stations || []).forEach((st, i) => {
          const ep = tmdbEps[i];
          if (!ep) return;
          const epTitle = ep.name || "";
          const epThumb = ep.still_path ? `https://image.tmdb.org/t/p/original${ep.still_path}` : "";
          st.name = buildStationName(i + 1, epTitle, isDubbedTrack);
          if (doPoster && epThumb) st.image = epThumb;
        });
      });
    }
    console.log(`✅ ${title} (ID: ${tmdbResult.id})`);
  }

  fs.writeFileSync(outputPath, JSON.stringify(playlist, null, 4), "utf-8");
  console.log(`\n📁 บันทึกไฟล์: ${outputPath}`);

  const mainSlug  = resolvedOutput.replace(/^\d+-/, "");
  const mainPath  = path.resolve(PLAYLIST_DIR, mainSlug);
  if (doTitle && fs.existsSync(mainPath) && resolvedOutput !== mainSlug) {
    const main = JSON.parse(fs.readFileSync(mainPath, "utf-8"));
    const newTitle = playlist.name;
    const newImg   = playlist.image;
    if (main.name !== newTitle || main.image !== newImg) {
      main.name  = newTitle;
      main.image = newImg;
      fs.writeFileSync(mainPath, JSON.stringify(main, null, 4), "utf-8");
      console.log(`📁 อัปเดต main file: ${mainPath}`);
    }
    updateIndex(PLAYLIST_DIR, GITHUB_RAW_BASE, newTitle, newImg, mainSlug, { upsert: true });
  } else {
    const indexFile = resolvedOutput;
    updateIndex(PLAYLIST_DIR, GITHUB_RAW_BASE, playlist.name, playlist.image, indexFile, { upsert: true });
  }

  console.log("\n🎉 อัปเดต metadata เสร็จสิ้น!");
}

// ───── Main ─────
async function main() {
  if (updateMeta) { await runUpdateMeta(); return; }

  try {
    const { rawTitle, embedUrls, isMoviePage } = await parsePage(pageUrl);

    // Determine content type
    let contentType = forceType;
    if (!contentType) {
      contentType = isMoviePage ? "movie" : "series";
    }
    const isMovie  = (TYPE_CONFIG[contentType]?.kind || contentType) === "movie" || contentType === "anime-movie";
    const cfg      = TYPE_CONFIG[contentType];
    const PLAYLIST_DIR    = path.resolve(__dirname, cfg.dir);
    const GITHUB_RAW_BASE = `https://raw.githubusercontent.com/natajrak/IPTV-Player/refs/heads/main/${cfg.base}`;

    console.log(`📂 ประเภท: ${contentType}`);

    // TMDB lookup
    let seriesTitle    = rawTitle;
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
          tmdbResult = await searchTmdbMovie(rawTitle, tmdbKey);
        }
        if (tmdbResult) {
          const enName = tmdbResult.title || rawTitle;
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
          tmdbResult = await searchTmdb(rawTitle, tmdbKey);
        }
        if (tmdbResult) {
          const enName = tmdbResult.name || rawTitle;
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
    console.log(`\n🔗 กำลัง fetch stream URLs (${embedUrls.length} embed)...`);
    const stations = [];

    for (let i = 0; i < embedUrls.length; i++) {
      const epNum = i + 1;
      process.stdout.write(`  ${isMovie ? "Movie" : `ตอน ${epNum}/${embedUrls.length}`}...`);

      let stream = null;
      try {
        stream = await getStreamFromEmbed(embedUrls[i]);
        process.stdout.write(` ✅\n`);
      } catch (err) {
        process.stdout.write(` ⚠️  ${err.message}\n`);
      }

      if (!isMovie) {
        const tmdbEp     = tmdbEpisodes[i];
        const epTitle    = tmdbEp?.name || "";
        const epThumb    = tmdbEp?.still_path
          ? `https://image.tmdb.org/t/p/original${tmdbEp.still_path}` : "";
        const stName     = buildStationName(epNum, epTitle, isDubbedTrack);
        stations.push({
          name:    stName,
          ...(epThumb && { image: epThumb }),
          url:     stream?.url || embedUrls[i],
          referer: stream?.referer || WEPLAYHLS_REFERER,
        });
        if (i < embedUrls.length - 1) await sleep(600);
      } else {
        stations.push({
          name:    trackName,
          image:   posterUrl,
          url:     stream?.url || embedUrls[i],
          referer: stream?.referer || WEPLAYHLS_REFERER,
        });
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

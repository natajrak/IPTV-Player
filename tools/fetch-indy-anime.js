#!/usr/bin/env node
/**
 * fetch-indy-anime.js
 * สร้าง / อัปเดต playlist JSON จาก indy-anime.net พร้อม metadata จาก TMDB
 *
 * ─── Flags ───────────────────────────────────────────────────────────────
 *   <url>              URL หน้ารายการบน indy-anime.net (จำเป็น ยกเว้นใช้ --update-meta)
 *   --track=th|subth  th = พากย์ไทย, subth = ซับไทย (default: subth)
 *   --season=N        ระบุ season ที่จะ fetch หรืออัปเดต (default: 1)
 *                     ใช้กับ --update-meta เพื่ออัปเดตเฉพาะ season ที่ระบุ
 *   --output=FILE     ชื่อไฟล์ผลลัพธ์ใน playlist/anime/series/ (ไม่ต้องใส่ path)
 *   --tmdb-key=KEY    TMDB API key (ถ้าไม่ใส่จะอ่านจาก .env อัตโนมัติ)
 *   --tmdb-id=N       ระบุ TMDB TV ID ตรงๆ (ใช้เมื่อ search ได้ผลผิด)
 *   --update-meta[=poster|cover|title]
 *                     อัปเดต metadata จาก TMDB โดยไม่ fetch stream URLs ใหม่
 *                     ไม่ระบุ = อัปเดตทั้งหมด
 *                     poster  = เฉพาะรูปปกซีรีส์/ซีซัน/แทร็ก
 *                     cover   = เฉพาะรูป thumbnail ของแต่ละตอน
 *                     title   = เฉพาะชื่อตอน
 *                     ต้องใช้คู่กับ --output เสมอ
 *
 * ─── Workflow ────────────────────────────────────────────────────────────
 *
 *   # Fetch ซับไทย (สร้างไฟล์ใหม่)
 *   node fetch-indy-anime.js https://indy-anime.net/SLUG/ --track=subth --output=FILENAME.txt
 *
 *   # Merge พากย์ไทยเข้าไฟล์เดิม
 *   node fetch-indy-anime.js https://indy-anime.net/SLUG-th/ --track=th --output=FILENAME.txt
 *
 *   # Fetch season 2
 *   node fetch-indy-anime.js https://indy-anime.net/SLUG-season-2/ --track=subth --season=2 --output=FILENAME.txt
 *
 *   # อัปเดต metadata จาก TMDB
 *   node fetch-indy-anime.js --update-meta --output=FILENAME.txt
 *
 *   # ระบุ TMDB ID ตรงๆ กรณี search ผิด
 *   node fetch-indy-anime.js --update-meta --tmdb-id=82684 --output=FILENAME.txt
 *
 * ─── หมายเหตุ ────────────────────────────────────────────────────────────
 *   - Stream URL รูปแบบ: https://hls.animeindy.com:8443/vid/{HASH}/video.mp4/playlist.m3u8
 *   - ไม่ต้องใช้ proxy (CDN รองรับ CORS)
 *   - TMDB_API_KEY อ่านจาก tools/.env หรือ .env อัตโนมัติ
 */

const cheerio = require("cheerio");
const fs = require("fs");
const path = require("path");

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
const args = process.argv.slice(2);
const seriesUrl = args.find((a) => a.startsWith("http"));
const tmdbKey = (args.find((a) => a.startsWith("--tmdb-key=")) || "").replace("--tmdb-key=", "") || process.env.TMDB_API_KEY || "";
const customOutput = (args.find((a) => a.startsWith("--output=")) || "").replace("--output=", "");
const idPrefixArg = (args.find((a) => a.startsWith("--id-prefix=")) || "").replace("--id-prefix=", "");

const trackArg = (args.find((a) => a.startsWith("--track=")) || "").replace("--track=", "");
const TRACK_MAP = { th: "พากย์ไทย", subth: "ซับไทย" };
const trackName = TRACK_MAP[trackArg] || trackArg || "ซับไทย";
const isDubbedTrack = trackName === "พากย์ไทย";
const filterTrack = trackArg ? trackName : null;

const seasonArg = args.find((a) => a.startsWith("--season="));
const seasonNum = seasonArg ? (parseInt(seasonArg.replace("--season=", "")) || 1) : null;
const seasonName = seasonNum ? `Season ${seasonNum}` : null;

const updateMetaArg = args.find((a) => a === "--update-meta" || a.startsWith("--update-meta="));
const updateMeta = !!updateMetaArg;
const updateMetaMode = updateMetaArg?.includes("=") ? updateMetaArg.split("=")[1] : "all";

const tmdbIdArg = args.find((a) => a.startsWith("--tmdb-id="));
const forceTmdbId = tmdbIdArg ? parseInt(tmdbIdArg.replace("--tmdb-id=", "")) || null : null;

// TMDB season override: use different TMDB season than playlist season
// e.g. --tmdb-season=1 --season=2 → puts in Season 2 but pulls metadata from TMDB Season 1
const tmdbSeasonArg = args.find((a) => a.startsWith("--tmdb-season="));
const tmdbSeasonNum = tmdbSeasonArg ? (parseInt(tmdbSeasonArg.replace("--tmdb-season=", "")) || null) : null;

// Episode offset: shift TMDB episode matching
// e.g. --ep-offset=12 → source ep 1 maps to TMDB ep 13
const epOffsetArg = args.find((a) => a.startsWith("--ep-offset="));
let epOffset = epOffsetArg ? (parseInt(epOffsetArg.replace("--ep-offset=", "")) || 0) : 0;

const typeArg     = (args.find((a) => a.startsWith("--type=")) || "").replace("--type=", "");
const contentType = ['anime-series','anime-movie','movie','series'].includes(typeArg) ? typeArg : 'anime-series';
const isMovie     = contentType === 'anime-movie' || contentType === 'movie';

if (!seriesUrl && !updateMeta) {
  console.error("Usage: node fetch-indy-anime.js <url> [--track=th|subth] [--season=N] [--output=FILE]");
  console.error("       node fetch-indy-anime.js --update-meta[=poster|cover|title] [--season=N] [--track=th|subth] --output=FILE.txt");
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
const REFERER = "https://indy-anime.net/";

const HEADERS = {
  "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120 Safari/537.36",
  "Accept-Language": "th-TH,th;q=0.9,en;q=0.8",
  "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
  "Referer": REFERER,
};

// ───── Helpers ─────
async function fetchHtml(url) {
  const res = await fetch(url, { headers: HEADERS });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  return res.text();
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function slugify(name) {
  return name
    .replace(/[^\w\s-]/g, "")
    .trim()
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-");
}

// ───── Step 1: Parse series page ─────
async function parseSeriesPage(url) {
  console.log(`\n📄 กำลัง fetch หน้ารายการ: ${url}`);
  const html = await fetchHtml(url);
  const $ = cheerio.load(html);

  // Title
  const title = $("h1").first().text().trim()
    || $(".entry-title").first().text().trim()
    || $("title").text().replace(/\s*[-|].*$/, "").trim();

  // Poster image
  const posterImg = $(".poster img, .thumb img, .series-thumbnail img").attr("src")
    || $("article img").first().attr("src")
    || "";

  // Episode links — collect all /watch/ links
  const seen = new Set();
  const episodes = [];

  $("a[href*='/watch/']").each((_, el) => {
    const epUrl = $(el).attr("href");
    if (!epUrl || seen.has(epUrl)) return;
    seen.add(epUrl);

    const thumb = $(el).find("img").attr("src") || "";
    const epTitle = $(el).text().trim();

    // Extract episode number from multiple sources
    // Priority: URL patterns → link text → sequential fallback
    const decodedUrl = decodeURIComponent(epUrl);
    let slug = "";
    let sortKey = 9000;
    let epLabel = "";

    // 1. Try URL: episode-N or ep-N → grab the number/keyword right after
    //    e.g. episode-1-sound-th → "1", ep-7-dub-thai → "7", episode-ova1 → "ova1"
    const urlMatch = decodedUrl.match(/(?:episode|ep)[-–](\d+)/i)
      || decodedUrl.match(/(?:episode|ep)[-–](ova\d*|sp\d*)\b/i)
      // 2. Try URL: Thai pattern ตอนที่-NN
      || decodedUrl.match(/ตอนที่[-–](\d+)/);
    if (urlMatch) slug = urlMatch[1];

    // 3. Fallback: extract from link text (e.g. "ตอนที่ 5", "Episode 3")
    if (!slug) {
      const textNum = epTitle.match(/ตอนที่\s*([\d.]+)/i) || epTitle.match(/episode\s*(\d+)/i);
      if (textNum) slug = textNum[1];
    }

    // Classify the slug
    if (/^ova(\d*)/i.test(slug)) {
      const ovaNum = parseInt(slug.match(/\d+/)?.[0] || "1");
      sortKey = 9000 + ovaNum;
      epLabel = `OVA${ovaNum > 1 ? " " + ovaNum : ""}`;
    } else if (/^sp(\d*)/i.test(slug)) {
      const spNum = parseInt(slug.match(/\d+/)?.[0] || "1");
      sortKey = 9500 + spNum;
      epLabel = `SP${spNum > 1 ? " " + spNum : ""}`;
    } else if (/^[\d.]+$/.test(slug)) {
      const num = parseFloat(slug);
      // Check if text says something like "5.5" but URL has "55"
      if (Number.isInteger(num)) {
        const textMatch = epTitle.match(/ตอนที่\s*([\d.]+)/);
        if (textMatch && textMatch[1].includes(".")) {
          sortKey = parseFloat(textMatch[1]);
          epLabel = textMatch[1];
        } else {
          sortKey = num;
          epLabel = String(num);
        }
      } else {
        sortKey = num;
        epLabel = String(num);
      }
    } else {
      // No number found — use "SP" as fallback
      epLabel = slug || "SP";
    }

    episodes.push({ url: epUrl, thumb, epTitle, sortKey, epLabel });
  });

  // Sort by sortKey (regular eps by number, specials at the end)
  episodes.sort((a, b) => a.sortKey - b.sortKey);

  console.log(`✅ พบ: "${title}" — ${episodes.length} ตอน`);
  return { title, posterImg, episodes };
}

// ───── Step 2: Get stream URL from episode page ─────
async function getStreamUrl(epPageUrl) {
  const html = await fetchHtml(epPageUrl);
  const $ = cheerio.load(html);

  // Method 1: iframe src from team-indy.net
  const iframeSrc = $("iframe[src*='team-indy.net/embed'], iframe[src*='indy-anime.net/embed']").attr("src") || "";
  const hashFromIframe = (iframeSrc.match(/\/embed\/([a-zA-Z0-9]+)\//i) || [])[1];
  if (hashFromIframe) {
    return buildStreamUrl(hashFromIframe);
  }

  // Method 2: inline JS containing the hash
  const scriptContent = $("script:not([src])").map((_, el) => $(el).html()).get().join("\n");
  const hashFromScript = (scriptContent.match(/\/vid\/([a-zA-Z0-9]+)\/video\.mp4/i) || [])[1]
    || (scriptContent.match(/embed\/([a-zA-Z0-9]+)\//i) || [])[1];
  if (hashFromScript) {
    return buildStreamUrl(hashFromScript);
  }

  // Method 3: direct m3u8 URL already in page
  const directMatch = html.match(/https?:\/\/hls\.animeindy\.com[^"'\s]+playlist\.m3u8/i);
  if (directMatch) return directMatch[0];

  throw new Error(`ไม่พบ stream hash ใน ${epPageUrl}`);
}

function buildStreamUrl(hash) {
  return `https://hls.animeindy.com:8443/vid/${hash}/video.mp4/playlist.m3u8`;
}

// ───── Step 3: TMDB metadata ─────
function cleanTitleForSearch(title) {
  return title
    .replace(/\[.*?\]/g, "")
    .replace(/\(.*?\)/g, "")
    .replace(/พากย์ไทย|ซับไทย|ซับ|พากย์/g, "")
    .replace(/[\u0E00-\u0E7F]+/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

async function searchTmdb(title, apiKey) {
  const query = encodeURIComponent(cleanTitleForSearch(title));
  const url = `https://api.themoviedb.org/3/search/tv?query=${query}&language=en-US&api_key=${apiKey}`;
  const res = await fetch(url);
  if (!res.ok) return null;
  const data = await res.json();
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

function formatSeriesTitle(enName, thName) {
  if (thName && thName !== enName) return `${enName} [${thName}]`;
  return enName;
}

async function getTmdbSeason(tvId, apiKey, season = 1, language = "en-US") {
  const url = `https://api.themoviedb.org/3/tv/${tvId}/season/${season}?language=${language}&api_key=${apiKey}`;
  const res = await fetch(url);
  if (!res.ok) return { episodes: [], poster: null };
  const data = await res.json();
  return {
    episodes: data.episodes || [],
    poster: data.poster_path ? `https://image.tmdb.org/t/p/original${data.poster_path}` : null,
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
  return {
    enEpisodes: enData.episodes,
    thEpisodes: thEps,
    poster: enData.poster,
  };
}

// ── TMDB Movie functions ───────────────────────────────────────────
async function searchTmdbMovie(title, apiKey) {
  const query = encodeURIComponent(cleanTitleForSearch(title));
  const url   = `https://api.themoviedb.org/3/search/movie?query=${query}&language=en-US&api_key=${apiKey}`;
  const res   = await fetch(url);
  if (!res.ok) return null;
  const data  = await res.json();
  return data.results?.[0] || null;
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

async function getTmdbEpisodes(tvId, apiKey, season = 1, language = "en-US") {
  return (await getTmdbSeason(tvId, apiKey, season, language)).episodes;
}

// ───── Step 4: Build / merge playlist JSON ─────
function buildStationName(epNum, epTitle, isDubbedTrack) {
  if (!epTitle) return isDubbedTrack ? `ตอน ${epNum}` : `Ep. ${epNum}`;
  return isDubbedTrack ? `ตอน ${epNum} - ${epTitle}` : `Ep. ${epNum} - ${epTitle}`;
}

// posterUrl      = show-level poster (playlist.image, index)
// seasonPosterUrl = season-specific poster (season.image, track.image)
function buildOrMergePlaylist(outputPath, seriesTitle, posterUrl, seasonPosterUrl, stations, trackName, trackReferer = null) {
  const newTrack = { name: trackName, image: seasonPosterUrl, ...(trackReferer && { referer: trackReferer }), stations };

  if (fs.existsSync(outputPath)) {
    let existing;
    try {
      existing = JSON.parse(fs.readFileSync(outputPath, "utf-8"));
    } catch {
      console.warn("⚠️  ไฟล์เดิม parse ไม่ได้ สร้างใหม่แทน");
      existing = null;
    }

    if (existing) {
      const targetName = seasonName || "Season 1";
      let season = existing.groups?.find((g) => g.name === targetName)
        ?? (seasonNum ? null : existing.groups?.[0]);

      if (!season) {
        existing.groups = existing.groups || [];
        season = { name: targetName, image: seasonPosterUrl, groups: [] };
        existing.groups.push(season);
      }

      // Convert old single-track structure to multi-track
      if (season.stations && !season.groups) {
        const existingTrackName = trackName === "พากย์ไทย" ? "ซับไทย" : "พากย์ไทย";
        season.groups = [{ name: existingTrackName, image: season.image || posterUrl, stations: season.stations }];
        delete season.stations;
      }

      season.groups = season.groups || [];

      // When epOffset > 0, append new stations to existing track instead of replacing
      const existingTrack = season.groups.find((g) => g.name === trackName);
      if (epOffset > 0 && existingTrack && Array.isArray(existingTrack.stations)) {
        // Merge: keep existing stations + add new ones, sort by episode number
        const merged = [...existingTrack.stations, ...stations];
        merged.sort((a, b) => {
          const aNum = parseInt(a.name?.match(/(?:ตอน|Ep\.?)\s*(\d+)/i)?.[1]) || 0;
          const bNum = parseInt(b.name?.match(/(?:ตอน|Ep\.?)\s*(\d+)/i)?.[1]) || 0;
          return aNum - bNum;
        });
        existingTrack.stations = merged;
        existingTrack.image = seasonPosterUrl;
        // Merge referer: combine source URLs with comma
        if (trackReferer && existingTrack.referer) {
          const oldRefs = existingTrack.referer.split(",").map(s => s.trim());
          if (!oldRefs.includes(trackReferer)) {
            existingTrack.referer = oldRefs.concat(trackReferer).join(",");
          }
        } else if (trackReferer) {
          existingTrack.referer = trackReferer;
        }
        console.log(`\n🔀 Append ${stations.length} ตอนเข้า "${trackName}" (รวม ${merged.length} ตอน)`);
      } else {
        season.groups = season.groups.filter((g) => g.name !== trackName);
        season.groups.push(newTrack);
      }

      // พากย์ไทย always first
      season.groups.sort((a, b) => {
        if (a.name === "พากย์ไทย") return -1;
        if (b.name === "พากย์ไทย") return 1;
        return 0;
      });

      console.log(`\n🔀 Merge "${trackName}" เข้าไฟล์เดิม (${season.groups.length} tracks)`);
      return existing;
    }
  }

  // New file
  const newSeasonName = seasonName || "Season 1";
  return {
    name: seriesTitle,
    image: posterUrl,
    groups: [{ name: newSeasonName, image: seasonPosterUrl, groups: [newTrack] }],
  };
}

// ── Build / update part file ({tmdbId}-{slug}.txt) ──────────────
function buildPartFile(outputPath, season, posterUrl, trackName, streamUrl, streamReferer, sourceUrl = null) {
  const partName   = `ภาค ${season}`;
  const newStation = {
    name:  trackName,
    image: posterUrl,
    url:   streamUrl,
    ...(sourceUrl    && { referer: sourceUrl }),
  };

  let playlist;
  if (fs.existsSync(outputPath)) {
    try { playlist = JSON.parse(fs.readFileSync(outputPath, "utf-8")); }
    catch { playlist = null; }
  }

  if (!playlist) {
    return { name: partName, image: posterUrl, stations: [newStation] };
  }

  playlist.name  = partName;
  playlist.image = posterUrl;
  playlist.stations = (playlist.stations || []).filter(s => s.name !== trackName);
  playlist.stations.push(newStation);
  playlist.stations.sort((a, b) => {
    if (a.name === "พากย์ไทย") return -1;
    if (b.name === "พากย์ไทย") return 1;
    return 0;
  });
  console.log(`\n🔀 Merge "${trackName}" เข้า ${partName}`);
  return playlist;
}

// ── Upsert group entry in main file ({slug}.txt) ──────────────
function upsertMainFile(mainPath, franchiseName, franchisePoster, partTitle, partPoster, partFileRawUrl, season) {
  const badgeName = `ภาค ${season}`;

  let main;
  if (fs.existsSync(mainPath)) {
    try { main = JSON.parse(fs.readFileSync(mainPath, "utf-8")); }
    catch { main = null; }
  }

  if (!main) {
    main = { name: franchiseName, image: franchisePoster, groups: [] };
  }
  // Don't overwrite existing root name/image

  main.groups = main.groups || [];
  const existing = main.groups.find(g => g.url === partFileRawUrl);
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

// ───── Step 5: Update index.txt ─────
function updateIndex(seriesTitle, posterUrl, filename, { upsert = false } = {}) {
  if (!fs.existsSync(INDEX_PATH)) {
    console.warn("⚠️  ไม่พบ index.txt ข้าม...");
    return;
  }

  let index;
  try {
    index = JSON.parse(fs.readFileSync(INDEX_PATH, "utf-8"));
  } catch {
    console.warn("⚠️  index.txt parse ไม่ได้ ข้าม...");
    return;
  }

  const fileUrl = `${GITHUB_RAW_BASE}${filename}`;
  const existing = index.groups.find((g) => g.url === fileUrl);

  if (existing) {
    if (!upsert) {
      console.log(`ℹ️  มีอยู่ใน index.txt แล้ว (${existing.name}) ข้าม...`);
      return;
    }
    const changed = existing.name !== seriesTitle || existing.image !== posterUrl;
    if (!changed) {
      console.log(`ℹ️  index.txt ไม่มีการเปลี่ยนแปลง ข้าม...`);
      return;
    }
    existing.name = seriesTitle;
    existing.image = posterUrl;
  } else {
    const dupByName = index.groups.find((g) => g.name === seriesTitle);
    if (dupByName) {
      console.warn(`⚠️  ชื่อ "${seriesTitle}" ซ้ำกับรายการที่มีอยู่ (${dupByName.url})`);
    }
    index.groups.push({ url: fileUrl, name: seriesTitle, image: posterUrl });
  }

  index.groups.sort((a, b) =>
    (a.name || "").localeCompare(b.name || "", undefined, { sensitivity: "base" })
  );

  fs.writeFileSync(INDEX_PATH, JSON.stringify(index, null, 2), "utf-8");
  const action = existing ? "อัปเดต" : "เพิ่ม";
  console.log(`✅ ${action} index.txt แล้ว (เรียงตามชื่อ A–Z)`);
}

// ───── Helper: resolve playlist file by name or *-name pattern ─────
function resolvePlaylistFile(fname) {
  if (fs.existsSync(path.resolve(PLAYLIST_DIR, fname))) return fname;
  const files = fs.readdirSync(PLAYLIST_DIR);
  const match = files.find(f => f === fname || f.endsWith(`-${fname}`));
  return match || fname;
}

// ───── Update meta only ─────
async function runUpdateMeta() {
  if (!tmdbKey) { console.error("❌ ต้องมี TMDB_API_KEY ใน .env"); process.exit(1); }
  if (!customOutput) { console.error("❌ ต้องระบุ --output=FILENAME.txt"); process.exit(1); }

  const outputFile = customOutput.endsWith(".txt") ? customOutput : `${customOutput}.txt`;
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
  const isMovieStructure = Array.isArray(playlist.stations);

  let tmdbResult;
  if (isMovieStructure) {
    // ── Movie update-meta ──────────────────────────────────────
    if (forceTmdbId) {
      console.log(`\n🎬 ใช้ TMDB ID ที่ระบุ: ${forceTmdbId}`);
      tmdbResult = await getTmdbMovieDetail(forceTmdbId, tmdbKey, "en-US");
      if (!tmdbResult) { console.error(`❌ ไม่พบ TMDB ID: ${forceTmdbId}`); process.exit(1); }
    } else {
      console.log(`\n🎬 กำลัง search TMDB (movie) สำหรับ: "${rawTitle}"`);
      tmdbResult = await searchTmdbMovie(rawTitle, tmdbKey);
      if (!tmdbResult) { console.error("❌ ไม่พบใน TMDB"); process.exit(1); }
    }
    const tmdbPoster = `https://image.tmdb.org/t/p/original${tmdbResult.poster_path}`;
    const tmdbEnName = tmdbResult.title || rawTitle;
    const tmdbThName = await getTmdbMovieNameTh(tmdbResult.id, tmdbKey);
    const tmdbName   = formatSeriesTitle(tmdbEnName, tmdbThName);
    console.log(`✅ พบ: "${tmdbName}" (ID: ${tmdbResult.id})`);
    if (doPoster) {
      // Part file: update image only, keep name as "ภาค N"
      playlist.image = tmdbPoster;
      (playlist.stations || []).forEach(s => { s.image = tmdbPoster; });
    }

    // Sync back to main file group entry
    const mainSlug   = resolvedOutput.replace(/^\d+-/, "");
    const mainPath   = path.resolve(PLAYLIST_DIR, mainSlug);
    if (fs.existsSync(mainPath)) {
      try {
        const main = JSON.parse(fs.readFileSync(mainPath, "utf-8"));
        const partRawUrl = `${GITHUB_RAW_BASE}${resolvedOutput}`;
        const grp = (main.groups || []).find(g => g.url === partRawUrl);
        if (grp) {
          if (doPoster) { grp.name = tmdbName; grp.image = tmdbPoster; }
          fs.writeFileSync(mainPath, JSON.stringify(main, null, 4), "utf-8");
          console.log(`✅ อัปเดต main file group: ${mainSlug}`);
        }
      } catch { /* ignore if main file missing/corrupt */ }
    }
    fs.writeFileSync(outputPath, JSON.stringify(playlist, null, 4), "utf-8");
    console.log(`\n📁 อัปเดตไฟล์: ${outputPath}`);
    updateIndex(tmdbName, tmdbPoster, resolvedOutput, { upsert: true });
    console.log("🎉 เสร็จสิ้น!");
    return;
  }

  // ── Series update-meta ──────────────────────────────────────
  if (forceTmdbId) {
    console.log(`\n🎬 ใช้ TMDB ID ที่ระบุ: ${forceTmdbId}`);
    tmdbResult = await getTmdbShow(forceTmdbId, tmdbKey, "en-US");
    if (!tmdbResult) { console.error(`❌ ไม่พบ TMDB ID: ${forceTmdbId}`); process.exit(1); }
  } else {
    console.log(`\n🎬 กำลัง search TMDB สำหรับ: "${rawTitle}"`);
    tmdbResult = await searchTmdb(rawTitle, tmdbKey);
    if (!tmdbResult) { console.error("❌ ไม่พบใน TMDB"); process.exit(1); }
  }

  const tmdbPoster = `https://image.tmdb.org/t/p/original${tmdbResult.poster_path}`;
  const tmdbEnName = tmdbResult.name || rawTitle;
  const tmdbThName = await getTmdbShowNameTh(tmdbResult.id, tmdbKey);
  const tmdbName = formatSeriesTitle(tmdbEnName, tmdbThName);
  console.log(`✅ พบ: "${tmdbName}" (ID: ${tmdbResult.id})`);

  const allSeasons = playlist.groups || [];
  const seasonsToUpdate = seasonName
    ? allSeasons.filter((s) => s.name === seasonName)
    : allSeasons;

  if (seasonName && seasonsToUpdate.length === 0) {
    console.error(`❌ ไม่พบ "${seasonName}" ในไฟล์`);
    process.exit(1);
  }

  console.log(`\n📂 จะอัปเดต: ${seasonsToUpdate.map((s) => s.name).join(", ")}${filterTrack ? ` › ${filterTrack}` : " (ทุก track)"}`);

  if (doPoster && !seasonName) {
    playlist.name = tmdbName;
    playlist.image = tmdbPoster;
  }

  for (const season of seasonsToUpdate) {
    const sNum = parseInt(season.name?.match(/\d+/)?.[0]) || 1;

    let enEps = [];
    let thEps = [];
    let seasonPoster = tmdbPoster;
    if (doPoster || doCover || doTitle) {
      const tmdbSeason = await getTmdbSeasonBilingual(tmdbResult.id, tmdbKey, sNum);
      enEps = tmdbSeason.enEpisodes;
      thEps = tmdbSeason.thEpisodes;
      if (tmdbSeason.poster) seasonPoster = tmdbSeason.poster;
      console.log(`\n✅ Season ${sNum}: ${enEps.length} ตอน | poster: ${seasonPoster !== tmdbPoster ? "season-specific" : "show-level"}`);
    }

    if (doPoster) season.image = seasonPoster;

    const tracks = season.groups?.length ? season.groups : [season];
    for (const track of tracks) {
      if (!Array.isArray(track.stations)) continue;
      if (filterTrack && track.name !== filterTrack) continue;
      if (doPoster) track.image = seasonPoster;

      const dubbed = track.name === "พากย์ไทย" || !track.name;
      const tmdbEps = dubbed ? thEps : enEps;

      track.stations.forEach((station, i) => {
        // Extract episode number from station name for TMDB matching
        const nameMatch = station.name.match(/(?:ตอน|Ep\.?)\s*([\d.]+)/i);
        const stationEpNum = nameMatch ? parseInt(nameMatch[1]) : (i + 1);
        const stationLabel = nameMatch ? nameMatch[1] : String(i + 1);
        const tmdbEp = !isNaN(stationEpNum)
          ? (tmdbEps.find(e => e.episode_number === stationEpNum) || tmdbEps[i])
          : tmdbEps[i];
        if (doTitle && tmdbEp?.name) {
          station.name = buildStationName(stationLabel, tmdbEp.name, dubbed);
        }
        if (doCover && tmdbEp?.still_path) {
          station.image = `https://image.tmdb.org/t/p/original${tmdbEp.still_path}`;
        }
      });

      const updated = [doPoster && "poster", doTitle && "title", doCover && "cover"].filter(Boolean).join("+");
      console.log(`  ✅ [${updated}] "${track.name || "stations"}" (${track.stations.length} ตอน)`);
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
    // Support comma-separated URLs for multi-part series
    const urls = seriesUrl.split(",").map(u => u.trim()).filter(Boolean);
    const isMultiUrl = urls.length > 1;
    let rawTitle = "", rawPoster = "";
    let episodes = [];

    for (let ui = 0; ui < urls.length; ui++) {
      if (isMultiUrl) console.log(`\n📡 Fetch part ${ui + 1}/${urls.length}: ${urls[ui]}`);
      const result = await parseSeriesPage(urls[ui]);
      if (ui === 0) { rawTitle = result.title; rawPoster = result.posterImg; }

      const offset = episodes.length;
      for (const ep of result.episodes) {
        if (offset > 0) {
          const origNum = parseInt(ep.epLabel);
          if (!isNaN(origNum)) {
            ep.epLabel = String(origNum + offset);
            ep.sortKey = origNum + offset;
          }
        }
        episodes.push(ep);
      }
      if (isMultiUrl) console.log(`  ✅ พบ ${result.episodes.length} ตอน (รวม ${episodes.length})`);
    }

    // Multi-URL: offset already baked into epLabel, reset epOffset
    if (isMultiUrl && !epOffsetArg) epOffset = 0;

    if (episodes.length === 0) {
      console.error("❌ ไม่พบ episode ใดเลย ตรวจสอบ URL อีกครั้ง");
      process.exit(1);
    }

    // TMDB lookup
    let seriesTitle = rawTitle;
    let posterUrl = rawPoster;
    let seasonPosterUrl = rawPoster; // season-specific poster (season.image, track.image)
    let tmdbEpisodes = [];
    let tmdbShow = null;

    if (tmdbKey) {
      let tmdbResult;
      if (isMovie) {
        if (forceTmdbId) {
          console.log(`\n🎬 ใช้ TMDB ID ที่ระบุ: ${forceTmdbId}`);
          tmdbResult = await getTmdbMovieDetail(forceTmdbId, tmdbKey, "en-US");
        } else {
          console.log("\n🎬 กำลัง search TMDB (movie)...");
          tmdbResult = await searchTmdbMovie(rawTitle, tmdbKey);
        }
        if (tmdbResult) {
          const tmdbEnName = tmdbResult.title || rawTitle;
          const tmdbThName = await getTmdbMovieNameTh(tmdbResult.id, tmdbKey);
          const tmdbName   = formatSeriesTitle(tmdbEnName, tmdbThName);
          const tmdbPoster = tmdbResult.poster_path
            ? `https://image.tmdb.org/t/p/original${tmdbResult.poster_path}`
            : rawPoster;
          console.log(`✅ พบใน TMDB: "${tmdbName}" (ID: ${tmdbResult.id})`);
          tmdbShow    = tmdbResult;
          seriesTitle = tmdbName;
          posterUrl   = tmdbPoster;
        } else {
          console.warn("⚠️  ไม่พบใน TMDB ใช้ข้อมูลจาก indy-anime แทน");
        }
      } else {
        if (forceTmdbId) {
          console.log(`\n🎬 ใช้ TMDB ID ที่ระบุ: ${forceTmdbId}`);
          tmdbResult = await getTmdbShow(forceTmdbId, tmdbKey, "en-US");
        } else {
          console.log("\n🎬 กำลัง search TMDB...");
          tmdbResult = await searchTmdb(rawTitle, tmdbKey);
        }
        if (tmdbResult) {
          const tmdbEnName = tmdbResult.name || rawTitle;
          const tmdbThName = await getTmdbShowNameTh(tmdbResult.id, tmdbKey);
          const tmdbName   = formatSeriesTitle(tmdbEnName, tmdbThName);
          const tmdbPoster = tmdbResult.poster_path
            ? `https://image.tmdb.org/t/p/original${tmdbResult.poster_path}`
            : rawPoster;
          console.log(`✅ พบใน TMDB: "${tmdbName}" (ID: ${tmdbResult.id})`);
          tmdbShow        = tmdbResult;
          seriesTitle     = tmdbName;
          posterUrl       = tmdbPoster;
          seasonPosterUrl = tmdbPoster;

          // Use tmdbSeasonNum if specified, otherwise fallback to seasonNum
          const lookupSeason = tmdbSeasonNum || seasonNum || 1;
          if (tmdbSeasonNum && tmdbSeasonNum !== (seasonNum || 1)) {
            console.log(`📌 TMDB Season override: playlist Season ${seasonNum || 1} → TMDB Season ${tmdbSeasonNum}`);
          }
          if (epOffset > 0) {
            console.log(`📌 Episode offset: +${epOffset} (source ep 1 → TMDB ep ${epOffset + 1})`);
          }

          if (isDubbedTrack) {
            const biData = await getTmdbSeasonBilingual(tmdbResult.id, tmdbKey, lookupSeason);
            tmdbEpisodes    = biData.thEpisodes;
            if (biData.poster) seasonPosterUrl = biData.poster;
            console.log(`✅ ดึงข้อมูล ${tmdbEpisodes.length} ตอน (Season ${lookupSeason}, th-TH w/ EN fallback) จาก TMDB`);
          } else {
            const seasonData = await getTmdbSeason(tmdbResult.id, tmdbKey, lookupSeason, "en-US");
            tmdbEpisodes    = seasonData.episodes;
            if (seasonData.poster) seasonPosterUrl = seasonData.poster;
            console.log(`✅ ดึงข้อมูล ${tmdbEpisodes.length} ตอน (Season ${lookupSeason}, en-US) จาก TMDB`);
          }
          console.log(`✅ poster: show-level=${posterUrl !== rawPoster} season-specific=${seasonPosterUrl !== posterUrl}`);
        } else {
          console.warn("⚠️  ไม่พบใน TMDB ใช้ข้อมูลจาก indy-anime แทน");
        }
      }
    }

    // Fetch stream URL for each episode
    console.log(`\n🔗 กำลัง fetch stream URLs (${episodes.length} ตอน)...`);
    const stations = [];

    for (let i = 0; i < episodes.length; i++) {
      const ep = episodes[i];
      const epLabel = ep.epLabel || String(i + 1);
      const epNumInt = parseInt(epLabel);  // NaN for OVA/SP
      process.stdout.write(`  ตอน ${epLabel}/${episodes.length}...`);

      let streamUrl = null;
      try {
        streamUrl = await getStreamUrl(ep.url);
        process.stdout.write(`  URL: ${streamUrl}`);
      } catch (err) {
        console.warn(` ⚠️  ${err.message}`);
      }

      // Match TMDB episode by episode_number (with offset), fallback to index
      const tmdbEpNum = !isNaN(epNumInt) ? epNumInt + epOffset : NaN;
      const tmdbEp = !isNaN(tmdbEpNum)
        ? (tmdbEpisodes.find(e => e.episode_number === tmdbEpNum) || tmdbEpisodes[i + epOffset])
        : null;
      const epTitle = tmdbEp?.name || "";
      const epThumb = tmdbEp?.still_path
        ? `https://image.tmdb.org/t/p/original${tmdbEp.still_path}`
        : ep.thumb || "";

      const stationName = buildStationName(epLabel, epTitle, isDubbedTrack);

      stations.push({
        name: stationName,
        ...(epThumb && { image: epThumb }),
        url: streamUrl || ep.url,
        referer: REFERER,
      });

      console.log(` ✅`);
      if (i < episodes.length - 1) await sleep(600);
    }

    // Build / merge playlist
    const slug = customOutput || slugify(seriesTitle.replace(/\[.*?\]/g, "").replace(/\(.*?\)/g, "").trim());
    const slugFile = slug.endsWith(".txt") ? slug : `${slug}.txt`;
    const resolvedIdPrefix = idPrefixArg || String(tmdbShow?.id || "");
    const outputFile = resolvedIdPrefix ? `${resolvedIdPrefix}-${slugFile}` : slugFile;
    const outputPath = path.resolve(PLAYLIST_DIR, outputFile);

    if (isMovie) {
      const s = stations[0];
      if (!s) { console.error("❌ ไม่พบ stream URL"); process.exit(1); }

      const partSeason   = seasonNum || 1;
      // Part file: {tmdbId}-{slug}.txt
      const partPlaylist = buildPartFile(outputPath, partSeason, posterUrl, trackName, s.url, s.referer, seriesUrl);
      fs.writeFileSync(outputPath, JSON.stringify(partPlaylist, null, 4), "utf-8");
      console.log(`\n📁 บันทึก part file: ${outputPath}`);

      // Main file: {slug}.txt (no tmdbId prefix)
      const mainFile    = slugFile;
      const mainPath    = path.resolve(PLAYLIST_DIR, mainFile);
      const partRawUrl  = `${GITHUB_RAW_BASE}${outputFile}`;
      const mainPlaylist = upsertMainFile(mainPath, seriesTitle, posterUrl, seriesTitle, posterUrl, partRawUrl, partSeason);
      fs.writeFileSync(mainPath, JSON.stringify(mainPlaylist, null, 4), "utf-8");
      console.log(`📁 บันทึก main file: ${mainPath}`);

      updateIndex(seriesTitle, posterUrl, mainFile);
    } else {
      const playlist = buildOrMergePlaylist(outputPath, seriesTitle, posterUrl, seasonPosterUrl, stations, trackName, seriesUrl);
      fs.writeFileSync(outputPath, JSON.stringify(playlist, null, 4), "utf-8");
      console.log(`\n📁 บันทึกไฟล์: ${outputPath}`);
      updateIndex(seriesTitle, posterUrl, outputFile);
    }

    console.log("\n🎉 เสร็จสิ้น!");
    console.log(`   ไฟล์: ${TYPE_CONFIG[contentType].base}${outputFile}`);
    console.log(`   ${isMovie ? 'ประเภท: Movie' : `จำนวนตอน: ${stations.length}`}`);
  } catch (err) {
    console.error(`\n❌ Error: ${err.message}`);
    process.exit(1);
  }
}

main();

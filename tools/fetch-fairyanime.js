#!/usr/bin/env node
/**
 * fetch-fairyanime.js
 * สร้าง / อัปเดต playlist JSON จาก fairyanime.net พร้อม metadata จาก TMDB
 *
 * ─── Flags ───────────────────────────────────────────────────────────────
 *   <url>              URL ตอนแรกบน fairyanime.net (จำเป็น ยกเว้นใช้ --update-meta)
 *   --track=th|subth  th = พากย์ไทย, subth = ซับไทย (default: subth)
 *   --season=N        ระบุ season ที่จะ fetch หรืออัปเดต (default: 1)
 *   --output=FILE     ชื่อไฟล์ผลลัพธ์ใน playlist/anime/series
 *   --tmdb-id=N       ระบุ TMDB TV ID ตรงๆ (ใช้เมื่อ search ได้ผลผิด)
 *   --update-meta[=poster|cover|title]
 *                     อัปเดต metadata จาก TMDB โดยไม่ fetch stream URLs ใหม่
 *
 * ─── Workflow ────────────────────────────────────────────────────────────
 *
 *   # Fetch ซับไทย
 *   node fetch-fairyanime.js https://fairyanime.net/watch/kC1KDoT9wS.html --track=subth --output=FILENAME.txt
 *
 *   # Merge พากย์ไทยเข้าไฟล์เดิม
 *   node fetch-fairyanime.js https://fairyanime.net/watch/ID.html --track=th --output=FILENAME.txt
 *
 *   # Fetch season 2
 *   node fetch-fairyanime.js https://fairyanime.net/watch/ID.html --track=subth --season=2 --output=FILENAME.txt
 *
 *   # อัปเดต metadata
 *   node fetch-fairyanime.js --update-meta --output=FILENAME.txt
 *
 * ─── Stream Extraction Chain ─────────────────────────────────────────────
 *   1. GET fairyanime.net/watch/{PAGE_ID}.html → extract VIDEO_ID (= PAGE_ID),
 *      episode title from <title>, "next" link (ตอนถัดไป)
 *   2. GET fairyanime.net/base/{VIDEO_ID}/ with Referer: fairyanime.net/
 *      → JS containing playback/v/{PLAYBACK_ID}/
 *   3. GET streaming.tonytonychopper.com/playback/v/{PLAYBACK_ID}/
 *      with Referer: fairyanime.net/watch/{PAGE_ID}.html
 *      → HTML with <iframe src="https://anime.tonytonychopper.net/v2/{INNER_ID}"
 *   4. Stream URL = https://anime.tonytonychopper.net/file2/{INNER_ID}/
 *   5. Referer = https://anime.tonytonychopper.net/v2/{INNER_ID}
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
const firstEpUrl = args.find((a) => a.startsWith("http"));
const tmdbKey = process.env.TMDB_API_KEY || "";
const hlsProxy = (process.env.HLS_PROXY_URL || "").replace(/\/$/, "");
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

if (!firstEpUrl && !updateMeta) {
  console.error("Usage: node fetch-fairyanime.js <url> [--track=th|subth] [--season=N] [--output=FILE]");
  console.error("       node fetch-fairyanime.js --update-meta[=poster|cover|title] [--season=N] [--track=th|subth] --output=FILE.txt");
  process.exit(1);
}

// ───── Config ─────
const PLAYLIST_DIR = path.resolve(__dirname, "../playlist/anime/series");
const INDEX_PATH = path.resolve(PLAYLIST_DIR, "index.txt");
const GITHUB_RAW_BASE = "https://raw.githubusercontent.com/natajrak/IPTV-Player/refs/heads/main/playlist/anime/series/";
const FAIRY_BASE = "https://fairyanime.net";
const MAX_EPISODES = 200;

const HEADERS = {
  "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120 Safari/537.36",
  "Accept-Language": "th-TH,th;q=0.9,en;q=0.8",
  "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
};

// ───── Helpers ─────
async function fetchText(url, extraHeaders = {}) {
  const res = await fetch(url, { headers: { ...HEADERS, ...extraHeaders } });
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

// Extract PAGE_ID from a fairyanime watch URL
// Supports both /watch/ID.html and /watch/ID/ forms
function extractPageId(url) {
  const m = url.match(/\/watch\/([^/.]+)/);
  return m ? m[1] : null;
}

// ───── Series title / episode title extraction ─────

// Strip site suffix " - FairyAnime แฟรี่อนิเมะ" and episode suffix "ตอนที่ N"
function cleanSiteTitle(rawTitle) {
  return rawTitle
    .replace(/\s*-\s*FairyAnime[^-]*$/i, "")
    .replace(/\s*ตอนที่\s*\d+.*$/, "")
    .trim();
}

// Extract episode number from title string (e.g. "ตอนที่ 3" → 3)
function extractEpNum(rawTitle) {
  const m = rawTitle.match(/ตอนที่\s*(\d+)/);
  return m ? parseInt(m[1]) : null;
}

// Build station display name
function buildStationName(epNum, epTitle, isDubbedTrack) {
  if (!epTitle) return isDubbedTrack ? `ตอน ${epNum}` : `Ep. ${epNum}`;
  return isDubbedTrack ? `ตอน ${epNum} - ${epTitle}` : `Ep. ${epNum} - ${epTitle}`;
}

// ───── Stream extraction ─────

// Step 1: fetch episode page → { pageId, rawTitle, nextUrl, posterImg }
async function fetchEpisodePage(url) {
  const html = await fetchText(url, { Referer: FAIRY_BASE + "/" });
  const $ = cheerio.load(html);

  const pageId = extractPageId(url);
  const rawTitle = $("title").first().text().trim();

  // Find next episode link: <a> containing "ถัดไป" (next) pointing to /watch/
  let nextUrl = null;
  $('a[href*="/watch/"]').each((_, el) => {
    const text = $(el).text();
    if (/ถัดไป|next/i.test(text)) {
      const href = $(el).attr("href");
      if (href) {
        nextUrl = href.startsWith("http") ? href : `${FAIRY_BASE}${href}`;
      }
    }
  });

  // Poster image from og:image
  const posterImg =
    $('meta[property="og:image"]').attr("content") ||
    $('meta[name="og:image"]').attr("content") ||
    $(".poster img, .thumb img").first().attr("src") ||
    "";

  return { pageId, rawTitle, nextUrl, posterImg };
}

// Step 2: fetch base JS → PLAYBACK_ID
async function fetchPlaybackId(pageId) {
  const url = `${FAIRY_BASE}/base/${pageId}/`;
  const js = await fetchText(url, { Referer: FAIRY_BASE + "/" });
  const m = js.match(/playback\/v\/([^/]+)/);
  if (!m) throw new Error(`ไม่พบ PLAYBACK_ID จาก base endpoint (pageId=${pageId})`);
  return m[1];
}

// Step 3: fetch streaming page → INNER_ID
async function fetchInnerId(playbackId, pageId) {
  const url = `https://streaming.tonytonychopper.com/playback/v/${playbackId}/`;
  const referer = `${FAIRY_BASE}/watch/${pageId}.html`;
  const html = await fetchText(url, { Referer: referer });
  const m = html.match(/anime\.tonytonychopper\.net\/v2\/([A-Za-z0-9_-]+)/);
  if (!m) throw new Error(`ไม่พบ INNER_ID จาก streaming page (playbackId=${playbackId})`);
  return m[1];
}

// Full chain: episode page URL → { streamUrl, referer }
async function getStreamInfo(epUrl) {
  const pageId = extractPageId(epUrl);
  if (!pageId) throw new Error(`ไม่สามารถ extract PAGE_ID จาก ${epUrl}`);

  const playbackId = await fetchPlaybackId(pageId);
  const innerId = await fetchInnerId(playbackId, pageId);

  const streamUrl = `https://anime.tonytonychopper.net/file2/${innerId}/`;
  const streamReferer = `https://anime.tonytonychopper.net/v2/${innerId}`;
  return { streamUrl, streamReferer };
}

// ───── Crawl all episodes ─────
async function crawlEpisodes(startUrl) {
  console.log(`\n📄 เริ่ม crawl จาก: ${startUrl}`);

  const episodes = [];
  let currentUrl = startUrl;
  let isFirst = true;
  let seriesTitle = "";
  let posterImg = "";

  while (currentUrl && episodes.length < MAX_EPISODES) {
    const epNum = episodes.length + 1;
    process.stdout.write(`  ตอน ${epNum} — ${currentUrl} ...`);

    let pageData;
    try {
      pageData = await fetchEpisodePage(currentUrl);
    } catch (err) {
      console.warn(` ⚠️  fetch หน้าล้มเหลว: ${err.message}`);
      break;
    }

    const { pageId, rawTitle, nextUrl, posterImg: epPoster } = pageData;

    if (isFirst) {
      seriesTitle = cleanSiteTitle(rawTitle);
      posterImg = epPoster;
      isFirst = false;
      console.log(`\n✅ Series: "${seriesTitle}"`);
      process.stdout.write(`  ตอน ${epNum} — ${currentUrl} ...`);
    }

    // Extract episode number from title; fallback to sequential counter
    const epNumFromTitle = extractEpNum(rawTitle) ?? epNum;

    episodes.push({
      url: currentUrl,
      pageId: pageId || "",
      rawTitle,
      epNum: epNumFromTitle,
    });

    process.stdout.write(` ✅ (ตอนที่ ${epNumFromTitle})\n`);

    // Check for next episode
    if (!nextUrl || nextUrl === currentUrl) break;
    currentUrl = nextUrl;

    await sleep(500);
  }

  if (episodes.length >= MAX_EPISODES) {
    console.warn(`⚠️  หยุดที่ ${MAX_EPISODES} ตอน (ถึงขีดจำกัด)`);
  }

  console.log(`✅ รวม ${episodes.length} ตอน`);
  return { episodes, seriesTitle, posterImg };
}

// ───── TMDB helpers ─────
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

// ───── Build / merge playlist JSON ─────
function buildOrMergePlaylist(outputPath, seriesTitle, posterUrl, seasonPosterUrl, stations, trackName) {
  const newTrack = { name: trackName, image: seasonPosterUrl, stations };

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

      // Convert old single-track structure
      if (season.stations && !season.groups) {
        const existingTrackName = trackName === "พากย์ไทย" ? "ซับไทย" : "พากย์ไทย";
        season.groups = [{ name: existingTrackName, image: season.image || seasonPosterUrl, stations: season.stations }];
        delete season.stations;
      }

      season.groups = season.groups || [];
      season.groups = season.groups.filter((g) => g.name !== trackName);
      season.groups.push(newTrack);

      season.groups.sort((a, b) => {
        if (a.name === "พากย์ไทย") return -1;
        if (b.name === "พากย์ไทย") return 1;
        return 0;
      });

      console.log(`\n🔀 Merge "${trackName}" เข้าไฟล์เดิม (${season.groups.length} tracks)`);
      return existing;
    }
  }

  const newSeasonName = seasonName || "Season 1";
  return {
    name: seriesTitle,
    image: posterUrl,
    groups: [{ name: newSeasonName, image: seasonPosterUrl, groups: [newTrack] }],
  };
}

// ───── Update index.txt ─────
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
  const outputPath = path.resolve(PLAYLIST_DIR, resolvedOutput);
  if (!fs.existsSync(outputPath)) { console.error(`❌ ไม่พบไฟล์: ${outputPath}`); process.exit(1); }

  const doPoster = updateMetaMode === "all" || updateMetaMode === "poster";
  const doCover  = updateMetaMode === "all" || updateMetaMode === "cover";
  const doTitle  = updateMetaMode === "all" || updateMetaMode === "title";

  console.log(`\n🔧 mode: ${updateMetaMode} (poster=${doPoster} cover=${doCover} title=${doTitle})`);

  const playlist = JSON.parse(fs.readFileSync(outputPath, "utf-8"));
  const rawTitle = playlist.name || "";

  let tmdbResult;
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
        const tmdbEp = tmdbEps[i];
        if (doTitle && tmdbEp?.name) {
          station.name = buildStationName(i + 1, tmdbEp.name, dubbed);
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
    // Phase 1: crawl episode list
    const { episodes, seriesTitle: rawSeriesTitle, posterImg: rawPoster } = await crawlEpisodes(firstEpUrl);

    if (episodes.length === 0) {
      console.error("❌ ไม่พบ episode ใดเลย ตรวจสอบ URL อีกครั้ง");
      process.exit(1);
    }

    // Phase 2: TMDB lookup
    let seriesTitle = rawSeriesTitle;
    let posterUrl = rawPoster;
    let seasonPosterUrl = rawPoster;
    let tmdbEpisodes = [];
    let tmdbShow = null;

    if (tmdbKey) {
      let tmdbResult;
      if (forceTmdbId) {
        console.log(`\n🎬 ใช้ TMDB ID ที่ระบุ: ${forceTmdbId}`);
        tmdbResult = await getTmdbShow(forceTmdbId, tmdbKey, "en-US");
      } else {
        console.log("\n🎬 กำลัง search TMDB...");
        tmdbResult = await searchTmdb(rawSeriesTitle, tmdbKey);
      }

      if (tmdbResult) {
        const tmdbEnName = tmdbResult.name || rawSeriesTitle;
        const tmdbThName = await getTmdbShowNameTh(tmdbResult.id, tmdbKey);
        const tmdbName = formatSeriesTitle(tmdbEnName, tmdbThName);
        const tmdbPoster = tmdbResult.poster_path
          ? `https://image.tmdb.org/t/p/original${tmdbResult.poster_path}`
          : rawPoster;
        console.log(`✅ พบใน TMDB: "${tmdbName}" (ID: ${tmdbResult.id})`);
        tmdbShow = tmdbResult;
        seriesTitle = tmdbName;
        posterUrl = tmdbPoster;
        seasonPosterUrl = tmdbPoster;

        if (isDubbedTrack) {
          const biData = await getTmdbSeasonBilingual(tmdbResult.id, tmdbKey, seasonNum || 1);
          tmdbEpisodes = biData.thEpisodes;
          if (biData.poster) seasonPosterUrl = biData.poster;
          console.log(`✅ ดึงข้อมูล ${tmdbEpisodes.length} ตอน (Season ${seasonNum || 1}, th-TH w/ EN fallback) จาก TMDB`);
        } else {
          const seasonData = await getTmdbSeason(tmdbResult.id, tmdbKey, seasonNum || 1, "en-US");
          tmdbEpisodes = seasonData.episodes;
          if (seasonData.poster) seasonPosterUrl = seasonData.poster;
          console.log(`✅ ดึงข้อมูล ${tmdbEpisodes.length} ตอน (Season ${seasonNum || 1}, en-US) จาก TMDB`);
        }
        console.log(`✅ poster: show-level=${posterUrl !== rawPoster} season-specific=${seasonPosterUrl !== posterUrl}`);
      } else {
        console.warn("⚠️  ไม่พบใน TMDB ใช้ข้อมูลจาก fairyanime แทน");
      }
    } else {
      console.warn("⚠️  ไม่มี TMDB_API_KEY ข้าม TMDB lookup");
    }

    // Phase 3: fetch stream URLs
    console.log(`\n🔗 กำลัง fetch stream URLs (${episodes.length} ตอน)...`);
    const stations = [];

    for (let i = 0; i < episodes.length; i++) {
      const ep = episodes[i];
      const epNum = ep.epNum;
      process.stdout.write(`  ตอน ${epNum}/${episodes.length} (${ep.pageId})...`);

      let streamUrl = null;
      let streamReferer = null;
      try {
        const info = await getStreamInfo(ep.url);
        streamUrl = info.streamUrl;
        streamReferer = info.streamReferer;
        process.stdout.write(` ✅\n`);
      } catch (err) {
        console.warn(` ⚠️  ${err.message}`);
      }

      const tmdbEp = tmdbEpisodes[i];
      const epTitle = tmdbEp?.name || "";
      const epThumb = tmdbEp?.still_path
        ? `https://image.tmdb.org/t/p/original${tmdbEp.still_path}`
        : "";

      let finalUrl = streamUrl || ep.url;
      let finalReferer = streamReferer || ep.url;
      if (streamUrl && hlsProxy) {
        finalUrl = `${hlsProxy}/?url=${encodeURIComponent(streamUrl)}&referer=${encodeURIComponent(streamReferer)}`;
        finalReferer = "";
      }

      const station = {
        name: buildStationName(epNum, epTitle, isDubbedTrack),
        ...(epThumb && { image: epThumb }),
        url: finalUrl,
        referer: finalReferer,
      };
      stations.push(station);

      if (i < episodes.length - 1) await sleep(500);
    }

    // Phase 4: build / merge playlist
    const slug = customOutput || slugify(seriesTitle.replace(/\[.*?\]/g, "").replace(/\(.*?\)/g, "").trim());
    const slugFile = slug.endsWith(".txt") ? slug : `${slug}.txt`;
    const resolvedIdPrefix = idPrefixArg || String(tmdbShow?.id || "");
    const outputFile = resolvedIdPrefix ? `${resolvedIdPrefix}-${slugFile}` : slugFile;
    const outputPath = path.resolve(PLAYLIST_DIR, outputFile);

    const playlist = buildOrMergePlaylist(outputPath, seriesTitle, posterUrl, seasonPosterUrl, stations, trackName);
    fs.writeFileSync(outputPath, JSON.stringify(playlist, null, 4), "utf-8");
    console.log(`\n📁 บันทึกไฟล์: ${outputPath}`);

    updateIndex(seriesTitle, posterUrl, outputFile);

    console.log("\n🎉 เสร็จสิ้น!");
    console.log(`   ไฟล์: playlist/anime/series/${outputFile}`);
    console.log(`   จำนวนตอน: ${stations.length}`);
  } catch (err) {
    console.error(`\n❌ Error: ${err.message}`);
    if (process.env.DEBUG) console.error(err.stack);
    process.exit(1);
  }
}

main();

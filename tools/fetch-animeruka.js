#!/usr/bin/env node
/**
 * fetch-animeruka.js
 * สร้าง / อัปเดต playlist JSON จาก animeruka.com พร้อม metadata จาก TMDB
 * Stream URL ดึงตรง (animemami.xyz → cdn2.maimeorder.com) — ไม่ต้องผ่าน proxy
 *
 * ─── Flags ───────────────────────────────────────────────────────────────
 *   <url>              URL หน้า anime บน animeruka.com
 *                      เช่น https://animeruka.com/anime/megami-no-cafe-terrace-2nd-season/
 *   --track=th|subth  th = พากย์ไทย, subth = ซับไทย (default: th)
 *   --season=N        ระบุ season ที่จะ fetch หรืออัปเดต (default: 1)
 *   --output=FILE     ชื่อไฟล์ผลลัพธ์ใน playlist/anime/series/ (ไม่ต้องใส่ path)
 *   --tmdb-key=KEY    TMDB API key (ถ้าไม่ใส่จะอ่านจาก .env อัตโนมัติ)
 *   --tmdb-id=N       ระบุ TMDB TV ID ตรงๆ (ใช้เมื่อ search ได้ผลผิด)
 *   --update-meta[=poster|cover|title]
 *                     อัปเดต metadata จาก TMDB โดยไม่ fetch stream URLs ใหม่
 *
 * ─── Workflow ────────────────────────────────────────────────────────────
 *
 *   # Fetch พากย์ไทย (สร้างไฟล์ใหม่)
 *   node fetch-animeruka.js https://animeruka.com/anime/SLUG/ --track=th --output=FILENAME.txt
 *
 *   # อัปเดต metadata จาก TMDB
 *   node fetch-animeruka.js --update-meta --output=FILENAME.txt
 *
 * ─── หมายเหตุ ────────────────────────────────────────────────────────────
 *   - DooPlay theme: GET /wp-json/dooplayer/v2/{post_id}/tv/1 → คืน embed_url
 *   - Embed (animemami.xyz) → parse <div id="app" data-page="..."> ดึง video.url
 *   - Stream เป็น HLS (cdn2.maimeorder.com/hls/.../*.txt) + segments .webp
 *   - CDN block ตาม Origin header — ต้องผ่าน CF Worker proxy (เหมือน kurokamii)
 *   - Player nume=2,3 เป็น mirror คนละ host (short.icu/ok.ru) — ใช้แค่ nume=1
 *   - TMDB_API_KEY อ่านจาก tools/.env หรือ .env อัตโนมัติ
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
const args        = process.argv.slice(2);
const seriesUrl   = args.find((a) => a.startsWith("http"));
const tmdbKey     = (args.find((a) => a.startsWith("--tmdb-key=")) || "").replace("--tmdb-key=", "") || process.env.TMDB_API_KEY || "";
const customOutput = (args.find((a) => a.startsWith("--output=")) || "").replace("--output=", "");
const mainSlugArg  = (args.find((a) => a.startsWith("--main-slug=")) || "").replace("--main-slug=", "");
const idPrefixArg  = (args.find((a) => a.startsWith("--id-prefix=")) || "").replace("--id-prefix=", "");

const trackArg    = (args.find((a) => a.startsWith("--track=")) || "").replace("--track=", "");
const TRACK_MAP   = { th: "พากย์ไทย", subth: "ซับไทย" };
const trackName   = TRACK_MAP[trackArg] || trackArg || "พากย์ไทย";
const isDubbedTrack = trackName === "พากย์ไทย";
const filterTrack = trackArg ? trackName : null;

const seasonArg   = args.find((a) => a.startsWith("--season="));
const seasonNum   = seasonArg ? (parseInt(seasonArg.replace("--season=", "")) ?? null) : null;
const seasonName  = seasonNum != null ? (seasonNum === 0 ? "Specials" : `Season ${seasonNum}`) : null;

const updateMetaArg  = args.find((a) => a === "--update-meta" || a.startsWith("--update-meta="));
const updateMeta     = !!updateMetaArg;
const noTouch        = args.includes("--no-touch"); // skip stamping updated_at (used by batch updates)
const updateMetaMode = updateMetaArg?.includes("=") ? updateMetaArg.split("=")[1] : "all";

const tmdbIdArg   = args.find((a) => a.startsWith("--tmdb-id="));
const forceTmdbId = tmdbIdArg ? parseInt(tmdbIdArg.replace("--tmdb-id=", "")) || null : null;

const tmdbSeasonArg = args.find((a) => a.startsWith("--tmdb-season="));
const tmdbSeasonNum = tmdbSeasonArg ? (parseInt(tmdbSeasonArg.replace("--tmdb-season=", "")) || null) : null;

const epOffsetArg = args.find((a) => a.startsWith("--ep-offset="));
let epOffset = epOffsetArg ? (parseInt(epOffsetArg.replace("--ep-offset=", "")) || 0) : 0;

const typeArg     = (args.find((a) => a.startsWith("--type=")) || "").replace("--type=", "");
const BUILTIN_TYPES = ['anime-series','anime-movie','movie','series'];

if (!seriesUrl && !updateMeta) {
  console.error("Usage: node fetch-animeruka.js <url> [--track=th|subth] [--season=N] [--output=FILE]");
  console.error("       node fetch-animeruka.js --update-meta[=poster|cover|title] [--season=N] --output=FILE.txt");
  process.exit(1);
}

// ───── Config ─────
const TYPE_CONFIG = {
  'anime-series': { dir: '../playlist/anime/series', base: 'playlist/anime/series/', kind: 'series' },
  'anime-movie':  { dir: '../playlist/anime/movies', base: 'playlist/anime/movies/', kind: 'movie'  },
  'movie':        { dir: '../playlist/movies',       base: 'playlist/movies/',       kind: 'movie'  },
  'series':       { dir: '../playlist/series',       base: 'playlist/series/',       kind: 'series' },
};

if (typeArg && !BUILTIN_TYPES.includes(typeArg)) {
  try {
    const customs = JSON.parse(fs.readFileSync(path.resolve(__dirname, '../playlist/custom-tabs.json'), 'utf-8'));
    const custom = customs.find(c => c.key === typeArg);
    if (custom) {
      TYPE_CONFIG[typeArg] = { dir: `../${custom.dir}`, base: `${custom.dir}/`, kind: custom.kind };
    }
  } catch {}
}

const contentType = TYPE_CONFIG[typeArg] ? typeArg : 'anime-series';
const isMovie     = (TYPE_CONFIG[contentType].kind || contentType) === 'movie'
                 || contentType === 'anime-movie';
const PLAYLIST_DIR    = path.resolve(__dirname, TYPE_CONFIG[contentType].dir);
const INDEX_PATH      = path.resolve(PLAYLIST_DIR, 'index.txt');
const GITHUB_RAW_BASE = `https://raw.githubusercontent.com/natajrak/IPTV-Player/refs/heads/main/${TYPE_CONFIG[contentType].base}`;

const SITE_BASE       = "https://animeruka.com";
const STREAM_REFERER  = "https://animemami.xyz/";
const CF_PROXY        = "https://shy-haze-2452.natajrak-p.workers.dev/";

function wrapWithProxy(rawUrl, referer = STREAM_REFERER) {
  return `${CF_PROXY}?url=${encodeURIComponent(rawUrl)}&referer=${encodeURIComponent(referer)}`;
}

const HEADERS = {
  "User-Agent":      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
  "Accept-Language": "th-TH,th;q=0.9,en;q=0.8",
  "Accept":          "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
  "Referer":         "https://animeruka.com/",
};

// ───── Helpers ─────
async function fetchHtml(url) {
  const res = await fetch(url, { headers: HEADERS });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  return res.text();
}

async function fetchJson(url, extraHeaders = {}) {
  const res = await fetch(url, { headers: { ...HEADERS, ...extraHeaders } });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  return res.json();
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function asMidnightUtc(dateStr) {
  return dateStr ? String(dateStr).slice(0, 10) + 'T00:00:00.000Z' : '';
}

function findMainFileFor(partFilename) {
  if (!/^\d+-/.test(partFilename)) return null;
  const partRawUrl = `${GITHUB_RAW_BASE}${partFilename}`;
  let files;
  try { files = fs.readdirSync(PLAYLIST_DIR); } catch { return null; }
  for (const fname of files) {
    if (fname === 'index.txt' || !fname.endsWith('.txt')) continue;
    if (/^\d+-/.test(fname)) continue;
    try {
      const data = JSON.parse(fs.readFileSync(path.resolve(PLAYLIST_DIR, fname), 'utf-8'));
      if (Array.isArray(data.groups) && data.groups.some(g => g && g.url === partRawUrl)) {
        return fname;
      }
    } catch { /* skip */ }
  }
  return null;
}

function stampPlaylist(playlist, tmdbResult, isMovie) {
  // For series: prefer earliest season's release_date (rollup from seasons)
  if (!isMovie && Array.isArray(playlist.groups) && playlist.groups.length > 0) {
    const seasonDates = playlist.groups.map(g => g && g.release_date).filter(Boolean);
    if (seasonDates.length > 0) {
      playlist.release_date = seasonDates.slice().sort()[0];
    } else if (tmdbResult && tmdbResult.first_air_date) {
      playlist.release_date = tmdbResult.first_air_date;
    }
  } else if (tmdbResult) {
    const rd = isMovie ? tmdbResult.release_date : tmdbResult.first_air_date;
    if (rd) playlist.release_date = rd;
  }
  if (noTouch) {
    if (!isMovie && Array.isArray(playlist.groups)) {
      const upd = playlist.groups.map(g => g && g.updated_at).filter(Boolean).slice().sort();
      if (upd.length > 0) playlist.updated_at = upd[upd.length - 1];
      else if (playlist.release_date) playlist.updated_at = asMidnightUtc(playlist.release_date);
    } else if (playlist.release_date) {
      playlist.updated_at = asMidnightUtc(playlist.release_date);
    }
  } else {
    playlist.updated_at = new Date().toISOString();
  }
  return playlist;
}

function slugify(name) {
  return name
    .replace(/[^\w\s-]/g, "")
    .trim()
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-");
}

// ───── Step 1: Parse anime page (HTML / cheerio) ─────
/**
 * คืน { title, posterImg, sections: [{ track, name, episodes }] }
 * - หน้าเว็บ animeruka อาจมีหลาย <div class='se-c'> (section) ต่อหน้า
 *   • ชื่อ section "ภาคNth" (se-t.se-o) → พากย์ไทย
 *   • ชื่อ section "ภาคN" (se-t)       → ซับไทย
 */
async function parseAnimePage(url) {
  console.log(`\n📄 กำลัง fetch หน้า anime: ${url}`);
  const html = await fetchHtml(url);
  const $    = cheerio.load(html);

  const title = ($(".data h1").first().text() || $('meta[property="og:title"]').attr("content") || "").trim();
  const posterImg = ($('meta[property="og:image"]').attr("content") || "").trim();

  const sections = [];
  $("div.se-c").each((_, sec) => {
    const $sec  = $(sec);
    const sName = ($sec.find(".se-t").first().text() || "").trim();
    // "ภาคNth" (หรือลงท้ายด้วย th) → พากย์ไทย, อื่นๆ → ซับไทย
    const sectionTrack = /th\s*$/i.test(sName) ? "th" : "subth";

    const episodes = [];
    $sec.find("ul.episodios li").each((_, li) => {
      const $li     = $(li);
      const linkEl  = $li.find(".episodiotitle a").first();
      const epUrl   = (linkEl.attr("href") || "").trim();
      if (!epUrl) return;
      const epLabel  = (linkEl.text() || "").trim();
      const numText  = ($li.find(".numerando").text() || "").trim();
      const numMatch = numText.match(/(\d+)/);
      const epNum    = numMatch ? parseInt(numMatch[1]) : episodes.length + 1;
      const thumb    = ($li.find(".imagen img").attr("src") || "").trim();
      episodes.push({ url: epUrl, epNum, label: epLabel, thumb });
    });
    episodes.sort((a, b) => a.epNum - b.epNum);

    if (episodes.length) sections.push({ track: sectionTrack, name: sName, episodes });
  });

  if (!sections.length) throw new Error("ไม่พบ section (div.se-c) — ตรวจสอบ URL อีกครั้ง");
  console.log(`✅ พบ: "${title}" — ${sections.length} section(s)`);
  sections.forEach(s => console.log(`   • ${s.name} (${s.track}) — ${s.episodes.length} ตอน`));
  return { title, posterImg, sections };
}

/** เลือก section ที่ match track ที่ user ระบุ; fallback ถ้ามี section เดียว */
function pickSection(sections, wantTrack) {
  const matched = sections.find(s => s.track === wantTrack);
  if (matched) return matched;
  if (sections.length === 1) {
    const only = sections[0];
    console.warn(`⚠️  หน้านี้มี section เดียว (${only.name}, ${only.track}) แต่ขอ --track=${wantTrack}`);
    console.warn(`    ใช้ section นี้แทน — ตรวจสอบว่า URL ถูกต้องสำหรับ track ที่ต้องการ`);
    return only;
  }
  return null;
}

// ───── Step 2: Get post_id + embed URL + stream URL ─────
async function getEpisodePostId(epPageUrl) {
  const html = await fetchHtml(epPageUrl);
  const m = html.match(/dooplay_player_option'[^>]*data-post='(\d+)'/)
         || html.match(/data-post="(\d+)"[^>]*data-nume="1"/)
         || html.match(/data-post='(\d+)'/);
  if (!m) throw new Error(`ไม่พบ data-post ใน ${epPageUrl}`);
  return m[1];
}

async function getEmbedUrl(postId, nume = 1) {
  const url = `${SITE_BASE}/wp-json/dooplayer/v2/${postId}/tv/${nume}`;
  const data = await fetchJson(url, { Referer: `${SITE_BASE}/` });
  if (!data.embed_url) throw new Error(`DooPlay API คืน embed_url ว่าง (post=${postId}, nume=${nume})`);
  return data.embed_url;
}

/** parse stream URL จาก embed page ของ animemami.xyz (Inertia data-page) */
async function getStreamUrlFromEmbed(embedUrl) {
  // รับเฉพาะ animemami.xyz/v/{slug}; host อื่น (short.icu, ok.ru) ไม่รองรับ
  if (!/animemami\.xyz/i.test(embedUrl)) {
    throw new Error(`Embed host ไม่รองรับ: ${embedUrl}`);
  }
  const html = await fetchHtml(embedUrl);
  const m = html.match(/data-page="([^"]+)"/) || html.match(/data-page='([^']+)'/);
  if (!m) throw new Error(`ไม่พบ data-page ใน embed page: ${embedUrl}`);
  let pageJson;
  try {
    pageJson = JSON.parse(m[1].replace(/&quot;/g, '"').replace(/&amp;/g, "&"));
  } catch (e) {
    throw new Error(`Parse data-page ไม่ได้: ${e.message}`);
  }
  const video = pageJson?.props?.video;
  if (!video?.url) throw new Error(`ไม่พบ video.url ใน embed page: ${embedUrl}`);
  return video.url;
}

// ───── Step 3: TMDB metadata ─────
function cleanTitleForSearch(title) {
  return title
    .replace(/\[.*?\]/g, "")
    .replace(/\(.*?\)/g, "")
    .replace(/พากย์ไทย|ซับไทย|ซับ|พากย์/g, "")
    .replace(/[฀-๿]+/g, "")
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
  const url  = `https://api.themoviedb.org/3/tv/${tvId}/season/${season}?language=${language}&api_key=${apiKey}`;
  const res  = await fetch(url);
  if (!res.ok) return { episodes: [], poster: null, name: "", air_date: "" };
  const data = await res.json();
  return {
    episodes: data.episodes || [],
    poster:   data.poster_path ? `https://image.tmdb.org/t/p/original${data.poster_path}` : null,
    name:     data.name || "",
    air_date: data.air_date || "",
  };
}

function isGenericEpisodeName(name) {
  if (!name) return true;
  const s = name.trim();
  return /^Episode\s+\d+$/i.test(s) || /^ตอนที่\s*\d+$/.test(s);
}

function isGenericSeasonName(name) {
  if (!name) return true;
  const s = name.trim();
  return /^Season\s+\d+$/i.test(s) || /^Specials$/i.test(s)
      || /^ซีซั่น\s*\d+$/.test(s) || /^ตอนพิเศษ$/.test(s);
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
  const enSeasonName = enData.name;
  const thSeasonName = thData.name;
  let seasonName = null;
  if (!isGenericSeasonName(enSeasonName)) {
    seasonName = { en: enSeasonName };
    if (thSeasonName && !isGenericSeasonName(thSeasonName)) seasonName.th = thSeasonName;
  }
  return { enEpisodes: enData.episodes, thEpisodes: thEps, poster: enData.poster, seasonName, air_date: enData.air_date || "" };
}

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

// ───── Step 4: Build station name ─────
function buildStationName(epNum, epTitle, isDubbed) {
  if (!epTitle) return isDubbed ? `ตอน ${epNum}` : `Ep. ${epNum}`;
  return isDubbed ? `ตอน ${epNum} - ${epTitle}` : `Ep. ${epNum} - ${epTitle}`;
}

// ───── Step 5: Build / merge playlist JSON ─────
function buildOrMergePlaylist(outputPath, seriesTitle, posterUrl, seasonPosterUrl, stations, trackName, trackReferer = null, tmdbSeasonName = null) {
  const newTrack = { name: trackName, image: seasonPosterUrl, ...(trackReferer && { referer: trackReferer }), stations };

  if (fs.existsSync(outputPath)) {
    let existing;
    try { existing = JSON.parse(fs.readFileSync(outputPath, "utf-8")); }
    catch { console.warn("⚠️  ไฟล์เดิม parse ไม่ได้ สร้างใหม่แทน"); existing = null; }

    if (existing) {
      const targetName = seasonName || "Season 1";
      let season = existing.groups?.find((g) => g.name === targetName)
        ?? (seasonNum ? null : existing.groups?.[0]);

      if (!season) {
        existing.groups = existing.groups || [];
        season = { name: targetName, ...(tmdbSeasonName && { season_name: tmdbSeasonName }), image: seasonPosterUrl, groups: [] };
        existing.groups.push(season);
      }

      if (tmdbSeasonName) season.season_name = tmdbSeasonName;

      if (season.stations && !season.groups) {
        const otherTrack = trackName === "พากย์ไทย" ? "ซับไทย" : "พากย์ไทย";
        season.groups = [{ name: otherTrack, image: season.image || posterUrl, stations: season.stations }];
        delete season.stations;
      }

      season.groups = season.groups || [];

      const existingTrack = season.groups.find((g) => g.name === trackName);
      if (epOffset > 0 && existingTrack && Array.isArray(existingTrack.stations)) {
        const merged = [...existingTrack.stations, ...stations];
        merged.sort((a, b) => {
          const aNum = parseInt(a.name?.match(/(?:ตอน|Ep\.?)\s*(\d+)/i)?.[1]) || 0;
          const bNum = parseInt(b.name?.match(/(?:ตอน|Ep\.?)\s*(\d+)/i)?.[1]) || 0;
          return aNum - bNum;
        });
        existingTrack.stations = merged;
        existingTrack.image = seasonPosterUrl;
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

      season.groups.sort((a, b) => {
        if (a.name === "พากย์ไทย") return -1;
        if (b.name === "พากย์ไทย") return 1;
        return 0;
      });

      console.log(`\n🔀 Merge "${trackName}" เข้าไฟล์เดิม (${season.groups.length} tracks)`);
      return existing;
    }
  }

  return {
    name:   seriesTitle,
    image:  posterUrl,
    groups: [{ name: seasonName || "Season 1", ...(tmdbSeasonName && { season_name: tmdbSeasonName }), image: seasonPosterUrl, groups: [newTrack] }],
  };
}

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

// ───── Step 6: Update index.txt ─────
function updateIndex(seriesTitle, posterUrl, filename, { upsert = false, releaseDate = "", updatedAt = "" } = {}) {
  if (!fs.existsSync(INDEX_PATH)) { console.warn("⚠️  ไม่พบ index.txt ข้าม..."); return; }

  let index;
  try { index = JSON.parse(fs.readFileSync(INDEX_PATH, "utf-8")); }
  catch { console.warn("⚠️  index.txt parse ไม่ได้ ข้าม..."); return; }

  const fileUrl  = `${GITHUB_RAW_BASE}${filename}`;
  const existing = index.groups.find((g) => g.url === fileUrl);

  if (existing) {
    if (!upsert && !updatedAt && !releaseDate) { console.log(`ℹ️  มีอยู่ใน index.txt แล้ว (${existing.name}) ข้าม...`); return; }
    existing.name  = seriesTitle;
    existing.image = posterUrl;
    if (releaseDate) existing.release_date = releaseDate;
    if (updatedAt) existing.updated_at = updatedAt;
  } else {
    const dupByName = index.groups.find((g) => g.name === seriesTitle);
    if (dupByName) console.warn(`⚠️  ชื่อ "${seriesTitle}" ซ้ำกับรายการที่มีอยู่ (${dupByName.url})`);
    const entry = { url: fileUrl, name: seriesTitle, image: posterUrl };
    if (releaseDate) entry.release_date = releaseDate;
    if (updatedAt) entry.updated_at = updatedAt;
    index.groups.push(entry);
  }

  index.groups.sort((a, b) => (a.name || "").localeCompare(b.name || "", undefined, { sensitivity: "base" }));
  fs.writeFileSync(INDEX_PATH, JSON.stringify(index, null, 2), "utf-8");
  const action = existing ? "อัปเดต" : "เพิ่ม";
  console.log(`✅ ${action} index.txt แล้ว (เรียงตามชื่อ A–Z)`);
}

function resolvePlaylistFile(fname) {
  if (fs.existsSync(path.resolve(PLAYLIST_DIR, fname))) return fname;
  const files = fs.readdirSync(PLAYLIST_DIR);
  const match = files.find((f) => f === fname || f.endsWith(`-${fname}`));
  return match || fname;
}

// ───── Update meta only ─────
async function runUpdateMeta() {
  if (!tmdbKey)      { console.error("❌ ต้องมี TMDB_API_KEY ใน .env"); process.exit(1); }
  if (!customOutput) { console.error("❌ ต้องระบุ --output=FILENAME.txt"); process.exit(1); }

  const outputFile    = customOutput.endsWith(".txt") ? customOutput : `${customOutput}.txt`;
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
  const isLegacyMovie   = Array.isArray(playlist.stations);
  const isMovieMainFile = !isLegacyMovie && Array.isArray(playlist.groups)
                       && playlist.groups.length > 0 && playlist.groups[0]?.url
                       && !playlist.groups[0]?.stations;
  const isMovieStructure = isMovie || isLegacyMovie || isMovieMainFile;

  let tmdbResult;
  if (isMovieStructure) {
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

    let cascadePartUpdates = null;
    if (isMovieMainFile) {
      if (doPoster) {
        if (!playlist._name_locked) playlist.name = tmdbName;
        playlist.image = tmdbPoster;
      }
      cascadePartUpdates = [];
      for (const group of (playlist.groups || [])) {
        if (!group.url) continue;
        const partFile = group.url.split('/').pop();
        const m = partFile.match(/^(\d+)-/);
        if (!m) continue;
        const partTmdbId = m[1];
        const partPath = path.resolve(PLAYLIST_DIR, partFile);
        if (!fs.existsSync(partPath)) continue;
        try {
          const partData  = JSON.parse(fs.readFileSync(partPath, 'utf-8'));
          const partTmdb  = await getTmdbMovieDetail(partTmdbId, tmdbKey, 'en-US');
          if (!partTmdb) { console.warn(`  ⚠️  TMDB ${partTmdbId} ไม่พบ — ข้าม ${partFile}`); continue; }
          const partTmdbEn = partTmdb.title || '';
          const partTmdbTh = await getTmdbMovieNameTh(partTmdbId, tmdbKey);
          const partTmdbName = formatSeriesTitle(partTmdbEn, partTmdbTh);
          const partTmdbPoster = partTmdb.poster_path ? `https://image.tmdb.org/t/p/original${partTmdb.poster_path}` : '';
          if (doPoster) {
            if (partTmdbName) group.name = partTmdbName;
            if (partTmdbPoster) group.image = partTmdbPoster;
          }
          stampPlaylist(partData, partTmdb, true);
          fs.writeFileSync(partPath, JSON.stringify(partData, null, 4), 'utf-8');
          if (partData.updated_at) cascadePartUpdates.push(partData.updated_at);
          console.log(`  ✅ part: ${partFile} → "${partTmdbName}" (${partData.release_date || '-'})`);
        } catch (e) {
          console.warn(`  ⚠️  ${partFile}: ${e.message}`);
        }
      }
    } else if (isLegacyMovie) {
      if (doPoster) {
        playlist.image = tmdbPoster;
        (playlist.stations || []).forEach(s => { s.image = tmdbPoster; });
      }
    } else {
      if (doPoster) {
        playlist.image = tmdbPoster;
        (playlist.groups || []).forEach(g => {
          if (g.image !== undefined) g.image = tmdbPoster;
          if (Array.isArray(g.stations)) g.stations.forEach(s => { s.image = tmdbPoster; });
        });
      }
    }

    // Detect if this is a part file by scanning for a main file that references its URL
    const partMainFile = findMainFileFor(resolvedOutput);
    const isPartFile   = !!partMainFile;
    const mainSlug     = partMainFile;
    const mainPath     = partMainFile ? path.resolve(PLAYLIST_DIR, partMainFile) : null;

    let mainStamped = null;
    if (isPartFile) {
      try {
        const main = JSON.parse(fs.readFileSync(mainPath, "utf-8"));
        const partRawUrl = `${GITHUB_RAW_BASE}${resolvedOutput}`;
        const grp = (main.groups || []).find(g => g.url === partRawUrl);
        if (grp) {
          if (doPoster) { grp.name = tmdbName; grp.image = tmdbPoster; }
          stampPlaylist(main, tmdbResult, true);
          fs.writeFileSync(mainPath, JSON.stringify(main, null, 4), "utf-8");
          mainStamped = main;
          console.log(`✅ อัปเดต main file group: ${mainSlug}`);
        }
      } catch { /* ignore */ }
    }

    stampPlaylist(playlist, tmdbResult, true);
    if (noTouch && cascadePartUpdates && cascadePartUpdates.length > 0) {
      playlist.updated_at = cascadePartUpdates.slice().sort().pop();
    }
    fs.writeFileSync(outputPath, JSON.stringify(playlist, null, 4), "utf-8");
    console.log(`\n📁 อัปเดตไฟล์: ${outputPath}`);

    if (isPartFile && mainStamped) {
      updateIndex(mainStamped.name || tmdbName, mainStamped.image || tmdbPoster, mainSlug, { releaseDate: mainStamped.release_date || "", updatedAt: mainStamped.updated_at });
    } else if (!isPartFile) {
      updateIndex(playlist.name || tmdbName, tmdbPoster, resolvedOutput, { upsert: true, releaseDate: playlist.release_date || "", updatedAt: playlist.updated_at });
    }
    console.log("🎉 เสร็จสิ้น!");
    return;
  }

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
  const tmdbName   = formatSeriesTitle(tmdbEnName, tmdbThName);
  console.log(`✅ พบ: "${tmdbName}" (ID: ${tmdbResult.id})`);

  const allSeasons     = playlist.groups || [];
  const seasonsToUpdate = seasonName
    ? allSeasons.filter((s) => s.name === seasonName)
    : allSeasons;

  if (seasonName && seasonsToUpdate.length === 0) { console.error(`❌ ไม่พบ "${seasonName}" ในไฟล์`); process.exit(1); }

  console.log(`\n📂 จะอัปเดต: ${seasonsToUpdate.map((s) => s.name).join(", ")}${filterTrack ? ` › ${filterTrack}` : " (ทุก track)"}`);

  if (doPoster && !seasonName) { if (!playlist._name_locked) playlist.name = tmdbName; playlist.image = tmdbPoster; }

  for (const season of seasonsToUpdate) {
    const sNum = /specials/i.test(season.name) ? 0 : (parseInt(season.name?.match(/\d+/)?.[0]) || 1);
    let enEps = [], thEps = [], seasonPoster = tmdbPoster;

    if (doPoster || doCover || doTitle) {
      const lookupSeason = tmdbSeasonNum || sNum;
      if (tmdbSeasonNum) console.log(`📌 ใช้ TMDB Season ${tmdbSeasonNum} (override)`);
      const tmdbSeason = await getTmdbSeasonBilingual(tmdbResult.id, tmdbKey, lookupSeason);
      enEps = tmdbSeason.enEpisodes;
      thEps = tmdbSeason.thEpisodes;
      if (tmdbSeason.poster) seasonPoster = tmdbSeason.poster;
      if (tmdbSeason.seasonName) season.season_name = tmdbSeason.seasonName;
      else delete season.season_name;
      if (tmdbSeason.air_date) season.release_date = tmdbSeason.air_date;
      // Season is "completed" if season.status === 'completed' OR all its tracks are completed
      const seasonCompleted = season.status === 'completed' || (
        Array.isArray(season.groups) && season.groups.length > 0 &&
        season.groups.every(t => t && t.status === 'completed')
      );
      if (noTouch && seasonCompleted && season.release_date) {
        season.updated_at = asMidnightUtc(season.release_date);
      }
      console.log(`\n✅ Season ${sNum} (TMDB Season ${lookupSeason}): ${enEps.length} ตอน`);
    }

    if (doPoster) season.image = seasonPoster;

    const tracks = season.groups?.length ? season.groups : [season];
    for (const track of tracks) {
      if (!Array.isArray(track.stations)) continue;
      if (filterTrack && track.name !== filterTrack) continue;
      if (doPoster) track.image = seasonPoster;

      const dubbed   = track.name === "พากย์ไทย" || !track.name;
      const tmdbEps  = dubbed ? thEps : enEps;

      track.stations.forEach((station, i) => {
        const stationEpMatch = station.name?.match(/(?:ตอน|Ep\.?)\s*(\d+)/i);
        const stationEpNum = stationEpMatch ? parseInt(stationEpMatch[1]) : (i + 1);
        const tmdbEpNum = stationEpNum + epOffset;
        const tmdbEp = tmdbEps.find(e => e.episode_number === tmdbEpNum) || tmdbEps[i + epOffset];
        if (doTitle && tmdbEp?.name) station.name  = buildStationName(stationEpNum, tmdbEp.name, dubbed);
        if (doCover && tmdbEp?.still_path) station.image = `https://image.tmdb.org/t/p/original${tmdbEp.still_path}`;
      });

      const updated = [doPoster && "poster", doTitle && "title", doCover && "cover"].filter(Boolean).join("+");
      console.log(`  ✅ [${updated}] "${track.name || "stations"}" (${track.stations.length} ตอน)`);
    }
  }

  stampPlaylist(playlist, tmdbResult, false);
  fs.writeFileSync(outputPath, JSON.stringify(playlist, null, 4), "utf-8");
  console.log(`\n📁 อัปเดตไฟล์: ${outputPath}`);
  updateIndex(playlist.name || tmdbName, tmdbPoster, resolvedOutput, { upsert: true, releaseDate: playlist.release_date || "", updatedAt: playlist.updated_at });
  console.log("🎉 เสร็จสิ้น!");
}

// ───── Main ─────
async function main() {
  if (updateMeta) { await runUpdateMeta(); return; }

  try {
    const urls = seriesUrl.split(",").map(u => u.trim()).filter(Boolean);
    const isMultiUrl = urls.length > 1;
    const wantTrack  = trackArg === "subth" ? "subth" : "th";
    let rawTitle = "", rawPoster = "";
    let episodes = [];

    for (let ui = 0; ui < urls.length; ui++) {
      if (isMultiUrl) console.log(`\n📡 Fetch part ${ui + 1}/${urls.length}: ${urls[ui]}`);
      const result = await parseAnimePage(urls[ui]);
      if (ui === 0) { rawTitle = result.title; rawPoster = result.posterImg; }

      const chosen = pickSection(result.sections, wantTrack);
      if (!chosen) {
        console.error(`❌ ไม่พบ section ที่ตรงกับ --track=${wantTrack} ใน ${urls[ui]}`);
        console.error(`   มี: ${result.sections.map(s => `${s.name}(${s.track})`).join(", ")}`);
        process.exit(1);
      }
      console.log(`📌 ใช้ section: "${chosen.name}" (${chosen.track}) — ${chosen.episodes.length} ตอน`);

      const offset = episodes.length;
      for (const ep of chosen.episodes) {
        ep._partOffset = offset;
        episodes.push(ep);
      }
      if (isMultiUrl) console.log(`  ✅ พบ ${chosen.episodes.length} ตอน (รวม ${episodes.length})`);
    }

    if (isMultiUrl && !epOffsetArg) epOffset = 0;

    if (episodes.length === 0) {
      console.error("❌ ไม่พบ episode ใดเลย ตรวจสอบ URL อีกครั้ง");
      process.exit(1);
    }

    // TMDB lookup
    let seriesTitle    = rawTitle;
    let posterUrl      = rawPoster;
    let seasonPosterUrl = rawPoster;
    let tmdbEpisodes   = [];
    let tmdbSeasonName = null;
    let tmdbShow       = null;
    let seasonAirDate  = "";

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
          console.warn("⚠️  ไม่พบใน TMDB ใช้ข้อมูลจาก animeruka แทน");
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

          const lookupSeason = tmdbSeasonNum || seasonNum || 1;
          if (tmdbSeasonNum) console.log(`📌 ใช้ TMDB Season ${tmdbSeasonNum} (override)`);
          if (epOffset) console.log(`📌 EP Offset: +${epOffset}`);

          const biData = await getTmdbSeasonBilingual(tmdbResult.id, tmdbKey, lookupSeason);
          tmdbEpisodes    = isDubbedTrack ? biData.thEpisodes : biData.enEpisodes;
          if (biData.poster) seasonPosterUrl = biData.poster;
          tmdbSeasonName  = biData.seasonName;
          seasonAirDate   = biData.air_date || "";
          console.log(`✅ ดึงข้อมูล ${tmdbEpisodes.length} ตอน จาก TMDB`);
        } else {
          console.warn("⚠️  ไม่พบใน TMDB ใช้ข้อมูลจาก animeruka แทน");
        }
      }
    }

    // Fetch stream URL ทุก episode
    console.log(`\n🔗 กำลัง fetch stream URLs (${episodes.length} ตอน)...`);
    const stations = [];

    for (let i = 0; i < episodes.length; i++) {
      const ep    = episodes[i];
      const epNum = i + 1;
      process.stdout.write(`  ตอน ${epNum}/${episodes.length}...`);

      let streamUrl = null;
      try {
        const postId    = await getEpisodePostId(ep.url);
        const embedUrl  = await getEmbedUrl(postId, 1);
        const rawStream = await getStreamUrlFromEmbed(embedUrl);
        streamUrl       = wrapWithProxy(rawStream);
        process.stdout.write(` post=${postId}`);
      } catch (err) {
        console.warn(` ⚠️  ${err.message}`);
      }

      const tmdbEpNum  = epNum + epOffset;
      const tmdbEp     = tmdbEpisodes.find(e => e.episode_number === tmdbEpNum) || tmdbEpisodes[i + epOffset];
      const epTitle    = tmdbEp?.name || "";
      const epThumb    = tmdbEp?.still_path
        ? `https://image.tmdb.org/t/p/original${tmdbEp.still_path}`
        : (ep.thumb || "");
      const stationName = buildStationName(epNum, epTitle, isDubbedTrack);

      stations.push({
        name:    stationName,
        ...(epThumb && { image: epThumb }),
        url:     streamUrl || ep.url,
        referer: STREAM_REFERER,
      });

      console.log(` ✅`);
      if (i < episodes.length - 1) await sleep(800);
    }

    // Build / merge playlist
    const slug         = customOutput || slugify(seriesTitle.replace(/\[.*?\]/g, "").replace(/\(.*?\)/g, "").trim());
    const slugFile     = slug.endsWith(".txt") ? slug : `${slug}.txt`;
    const resolvedId   = idPrefixArg || String(tmdbShow?.id || "");
    const outputFile   = resolvedId ? `${resolvedId}-${slugFile}` : slugFile;
    const outputPath   = path.resolve(PLAYLIST_DIR, outputFile);

    if (isMovie) {
      const s = stations[0];
      if (!s) { console.error("❌ ไม่พบ stream URL"); process.exit(1); }

      const partSeason   = seasonNum || 1;
      const partPlaylist = buildPartFile(outputPath, partSeason, posterUrl, trackName, s.url, s.referer, seriesUrl);
      stampPlaylist(partPlaylist, tmdbShow, true);
      fs.writeFileSync(outputPath, JSON.stringify(partPlaylist, null, 4), "utf-8");
      console.log(`\n📁 บันทึก part file: ${outputPath}`);

      const mainFile    = mainSlugArg ? (mainSlugArg.endsWith(".txt") ? mainSlugArg : `${mainSlugArg}.txt`) : slugFile;
      const mainPath    = path.resolve(PLAYLIST_DIR, mainFile);
      const partRawUrl  = `${GITHUB_RAW_BASE}${outputFile}`;
      const mainPlaylist = upsertMainFile(mainPath, seriesTitle, posterUrl, seriesTitle, posterUrl, partRawUrl, partSeason);
      stampPlaylist(mainPlaylist, tmdbShow, true);
      fs.writeFileSync(mainPath, JSON.stringify(mainPlaylist, null, 4), "utf-8");
      console.log(`📁 บันทึก main file: ${mainPath}`);

      updateIndex(seriesTitle, posterUrl, mainFile, { upsert: true, releaseDate: mainPlaylist.release_date || "", updatedAt: mainPlaylist.updated_at });
    } else {
      const playlist = buildOrMergePlaylist(outputPath, seriesTitle, posterUrl, seasonPosterUrl, stations, trackName, seriesUrl, tmdbSeasonName);
      if (seasonAirDate) {
        const targetSeasonName = seasonName || "Season 1";
        const affectedSeason = (playlist.groups || []).find(g => g.name === targetSeasonName);
        if (affectedSeason) affectedSeason.release_date = seasonAirDate;
      }
      stampPlaylist(playlist, tmdbShow, false);
      fs.writeFileSync(outputPath, JSON.stringify(playlist, null, 4), "utf-8");
      console.log(`\n📁 บันทึกไฟล์: ${outputPath}`);
      updateIndex(seriesTitle, posterUrl, outputFile, { upsert: true, releaseDate: playlist.release_date || "", updatedAt: playlist.updated_at });
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

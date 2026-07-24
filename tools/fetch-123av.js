#!/usr/bin/env node
/**
 * fetch-123av.js
 * สร้าง / อัปเดต playlist JSON จาก 123av.com
 * (แทนตัวเดิม fetch-javxx.js — javxx.com ย้ายไปเป็น 123av.com แล้ว)
 *
 * ─── Flags ───────────────────────────────────────────────────────────────
 *   <url>              URL หน้าวิดีโอบน 123av.com (เช่น https://123av.com/th/v/dvaj-644-uncensored-leaked)
 *                      รองรับ URL javxx.com เดิม → auto-rewrite host เป็น 123av.com
 *   --output=FILE      ชื่อไฟล์ผลลัพธ์ (ยังคง flag ไว้เพื่อ backward compat — playlist เป็น flat stations)
 *   --update-meta      อัปเดต metadata + auto-migrate referer javxx.com → 123av.com
 *                      (เฉพาะรายการที่ยังไม่มี metadata)
 *   --update-meta=all  อัปเดต metadata ทุกรายการ (ทับเดิม)
 *   --code=CODE        อัปเดตเฉพาะรหัสที่ระบุ
 *
 * ─── Stream extraction flow ──────────────────────────────────────────────
 *   1. Fetch 123av.com/th/v/{slug}
 *      → parse player(JSON.parse('[{url:"https://javplayer.cc/e/{ID}?poster=..."}]'))
 *   2. Extract EMBED_ID + poster URL จาก embed URL
 *   3. GET https://javplayer.cc/stream?id={ID}
 *      → { status:"ok", media:{ stream:"<m3u8>", vtt:"<vtt>" } }
 *   4. Return media.stream (direct HLS m3u8, CORS *)
 */

const cheerio = require("cheerio");
const fs = require("fs");
const path = require("path");

const args = process.argv.slice(2);
const pageUrl = args.find((a) => a.startsWith("http") && !a.startsWith("--"));
const updateMetaArg = args.find((a) => a === "--update-meta" || a.startsWith("--update-meta="));
const updateMeta = !!updateMetaArg;
const updateMetaMode = updateMetaArg?.includes("=") ? updateMetaArg.split("=")[1] : "missing";
const targetCode = (args.find((a) => a.startsWith("--code=")) || "").replace("--code=", "").toUpperCase();

if (!pageUrl && !updateMeta) {
  console.error("Usage: node fetch-123av.js <url>");
  console.error("       node fetch-123av.js --update-meta[=all] [--code=CODE]");
  process.exit(1);
}

const PLAYLIST_DIR = path.resolve(__dirname, "../playlist/av");
const INDEX_PATH = path.resolve(PLAYLIST_DIR, "index.txt");
const SITE_BASE = "https://123av.com";
const LEGACY_HOSTS = new Set(["javxx.com", "www.javxx.com"]);

const HLS_PROXY_URL = "https://iptv-player-three-flax.vercel.app/api/hls-proxy";
const EMBED_REFERER = "https://javplayer.cc/";
// 123av backend มีหลาย CDN host (cold-winter-118.space, wowstream.cloud, wowstream2.cloud, ...)
// ทุกอันใช้ path pattern เดียวกัน /blah4/{TOKEN}/video.m3u8 → match ที่ path แทน host
const RAW_STREAM_HOST_RE = /\/blah4\//i;

function wrapWithProxy(rawUrl, referer = EMBED_REFERER) {
  if (!rawUrl || rawUrl.startsWith(HLS_PROXY_URL)) return rawUrl;
  return `${HLS_PROXY_URL}?url=${encodeURIComponent(rawUrl)}&referer=${encodeURIComponent(referer)}`;
}

const HEADERS = {
  "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
  "Accept-Language": "th-TH,th;q=0.9,en-US;q=0.8,en;q=0.7",
  Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8",
};

async function fetchText(url, extraHeaders = {}) {
  const res = await fetch(url, { headers: { ...HEADERS, ...extraHeaders }, redirect: "follow" });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  return res.text();
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

const JS_ESC_MAP = { n: "\n", r: "\r", t: "\t", b: "\b", f: "\f", "\\": "\\", "'": "'", '"': '"', "/": "/", "0": "\0" };
function unescapeJsString(s) {
  return s.replace(/\\(u[0-9a-fA-F]{4}|x[0-9a-fA-F]{2}|.)/g, (_, esc) => {
    if (esc[0] === "u" || esc[0] === "x") return String.fromCharCode(parseInt(esc.slice(1), 16));
    return JS_ESC_MAP[esc] ?? esc;
  });
}

function migrateLegacyUrl(url) {
  if (!url) return url;
  try {
    const u = new URL(url);
    if (LEGACY_HOSTS.has(u.hostname)) {
      u.hostname = "123av.com";
      return u.toString();
    }
  } catch {}
  return url;
}

async function parseVideoPage(url) {
  console.log(`📡 กำลัง fetch หน้าวิดีโอ: ${url}`);
  const html = await fetchText(url);
  const $ = cheerio.load(html);

  const playerMatch = html.match(/player\(JSON\.parse\('([^']+)'\)/);
  if (!playerMatch) throw new Error("ไม่พบ player(JSON.parse(...)) — เว็บอาจเปลี่ยนโครงสร้าง");

  const playerJsonStr = unescapeJsString(playerMatch[1]);
  let playerData;
  try { playerData = JSON.parse(playerJsonStr); }
  catch (e) { throw new Error(`parse player payload ไม่ได้: ${e.message}`); }
  if (!Array.isArray(playerData) || !playerData.length) throw new Error("player payload ว่าง");

  const embedInfo = playerData.map((p, i) => {
    const embedUrl = p.url || "";
    let poster = "";
    try {
      const u = new URL(embedUrl);
      poster = u.searchParams.get("poster") || "";
    } catch {}
    return { label: p.name || `Part ${p.number || i + 1}`, embedUrl, poster };
  });

  const cover = embedInfo[0]?.poster || "";

  const urlSlug = url.match(/\/v\/([^/?#]+)/)?.[1] || "";
  const codeMatch = urlSlug.match(/^([a-z]+-\d+)/i);
  const code = codeMatch ? codeMatch[1].toUpperCase() : urlSlug.toUpperCase();

  console.log(`  รหัส: ${code}`);
  console.log(`  ปก: ${cover}`);

  const actresses = [];
  const genres = [];
  let releaseDate = "";

  $(".watch__info-row").each((_, el) => {
    const label = $(el).find("dt").first().text().trim();
    const $dd = $(el).find("dd").first();
    if (!$dd.length) return;

    if (label === "นักแสดง" || label === "นักแสดงหญิง") {
      $dd.find("a").each((__, a) => {
        const name = $(a).text().trim();
        if (name && name.length > 1) actresses.push(name);
      });
      if (actresses.length === 0) {
        $dd.text().split(/[,、，]/).forEach(n => {
          const name = n.trim();
          if (name && name.length > 1) actresses.push(name);
        });
      }
    } else if (label === "วันที่วางจำหน่าย") {
      const m = $dd.text().trim().match(/\d{4}-\d{2}-\d{2}/);
      if (m) releaseDate = m[0];
    } else if (label === "หมวดหมู่") {
      $dd.find("a").each((__, a) => {
        const name = $(a).text().trim();
        if (name && name.length > 1) genres.push(name);
      });
    }
  });

  if (actresses.length) console.log(`  นักแสดงหญิง: ${actresses.join(", ")}`);
  if (releaseDate) console.log(`  วันที่วางจำหน่าย: ${releaseDate}`);
  if (genres.length) console.log(`  หมวดหมู่: ${genres.join(", ")}`);

  return { code, cover, embedInfo, actresses, release_date: releaseDate, genres };
}

async function getStreamFromEmbed(embedUrl) {
  const embedIdMatch = embedUrl.match(/\/e\/([a-z0-9_]+)/i);
  if (!embedIdMatch) throw new Error(`ไม่พบ embed id ใน ${embedUrl}`);
  const embedId = embedIdMatch[1];

  const embedUrlObj = new URL(embedUrl);
  const apiUrl = new URL("/stream", embedUrlObj.origin);
  embedUrlObj.searchParams.forEach((v, k) => apiUrl.searchParams.set(k, v));
  apiUrl.searchParams.set("id", embedId);

  console.log(`  🔗 API: ${apiUrl.toString()}`);
  const res = await fetch(apiUrl.toString(), {
    headers: { ...HEADERS, Referer: embedUrl, Accept: "application/json" },
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${apiUrl}`);
  const json = await res.json();

  const stream = json?.media?.stream;
  if (!stream) throw new Error(`ไม่พบ media.stream: ${JSON.stringify(json).slice(0, 200)}`);
  const wrapped = wrapWithProxy(stream);
  console.log(`  ✅ stream (raw): ${stream}`);
  console.log(`  🔒 stream (proxied): ${wrapped}`);
  return wrapped;
}

function enrichStation(station, meta) {
  const rawName = station.name || "";
  const referer = station.referer || "";
  const codeMatch = rawName.match(/\d*([A-Z]+-\d+)/i);
  const cleanCode = codeMatch ? codeMatch[1].toUpperCase() : rawName.replace(/\s+.+$/, "").toUpperCase();

  const tagSource = `${rawName} ${referer}`;
  const specialTags = [];
  if (/uncensored.?leaked/i.test(tagSource)) {
    specialTags.push("UNCENSORED LEAKED");
  } else {
    if (/uncensored/i.test(tagSource)) specialTags.push("UNCENSORED");
    if (/leaked/i.test(tagSource)) specialTags.push("LEAKED");
  }
  if (/\b4K\b/i.test(tagSource)) specialTags.push("4K");

  const metaOut = {};
  if (meta?.actresses?.length) metaOut.actresses = meta.actresses;
  if (meta?.release_date) metaOut.release_date = meta.release_date;
  if (meta?.genres?.length) metaOut.genres = meta.genres;

  const badge = specialTags.length
    ? specialTags.map(t => t.split(/\s+/).map(w => w.charAt(0) + w.slice(1).toLowerCase()).join(" ")).join(", ")
    : undefined;

  const result = { ...station, name: cleanCode };
  if (badge) result.badge = badge; else delete result.badge;
  if (Object.keys(metaOut).length) result.meta = metaOut; else delete result.meta;
  return result;
}

function readIndex() {
  let index = { name: "AV", image: "", browsable: true, stations: [] };
  if (fs.existsSync(INDEX_PATH)) {
    try {
      const raw = JSON.parse(fs.readFileSync(INDEX_PATH, "utf-8"));
      index.name = raw.name || "AV";
      index.image = raw.image || "";
      index.browsable = true;
      index.stations = raw.stations || [];
    } catch {}
  }
  return index;
}

function writeIndex(index) {
  fs.writeFileSync(INDEX_PATH, JSON.stringify(index, null, 4), "utf-8");
}

function extractCode(displayName) {
  const m = displayName.match(/\d*([A-Z]+-\d+)/i);
  return m ? m[1].toUpperCase() : displayName.toUpperCase();
}

function updateIndex(code, cover, streamUrl, pageUrl, meta) {
  const index = readIndex();
  const existing = index.stations.findIndex((s) => extractCode(s.name) === code);
  let entry = { url: streamUrl, name: code, image: cover, referer: pageUrl };
  if (meta) entry = enrichStation(entry, meta);
  if (existing >= 0) {
    const prev = index.stations[existing];
    entry.url = streamUrl || prev.url;
    entry.referer = pageUrl || prev.referer;
    index.stations[existing] = entry;
  } else {
    index.stations.push(entry);
  }
  writeIndex(index);
  console.log(`📋 อัปเดต index: "${entry.name}"`);
}

async function runUpdateMeta() {
  const index = readIndex();
  if (!index.stations.length) {
    console.error("❌ ไม่มีรายการใน index.txt");
    process.exit(1);
  }

  let targets = index.stations;
  if (targetCode) {
    targets = targets.filter((s) => extractCode(s.name) === targetCode);
    if (!targets.length) {
      console.error(`❌ ไม่พบรหัส ${targetCode} ใน index.txt`);
      process.exit(1);
    }
  }

  const forceAll = updateMetaMode === "all";
  let updated = 0, skipped = 0, failed = 0, migrated = 0, proxied = 0;

  for (let i = 0; i < targets.length; i++) {
    const station = targets[i];
    const code = extractCode(station.name);
    const idx = index.stations.findIndex((s) => s === station);

    const originalReferer = station.referer || "";
    const migratedReferer = migrateLegacyUrl(originalReferer);
    const needsMigrate = migratedReferer !== originalReferer;
    if (needsMigrate) {
      index.stations[idx].referer = migratedReferer;
      station.referer = migratedReferer;
      migrated++;
    }

    const originalStreamUrl = station.url || "";
    const needsProxy = RAW_STREAM_HOST_RE.test(originalStreamUrl) && !originalStreamUrl.startsWith(HLS_PROXY_URL);
    if (needsProxy) {
      const wrapped = wrapWithProxy(originalStreamUrl);
      index.stations[idx].url = wrapped;
      station.url = wrapped;
      proxied++;
    }

    if (!forceAll && station.meta) {
      const tags = [];
      if (needsMigrate) tags.push("host");
      if (needsProxy) tags.push("proxy");
      if (tags.length) {
        console.log(`🔄 [${i + 1}/${targets.length}] ${code} — migrate ${tags.join("+")} เท่านั้น (มี metadata แล้ว)`);
      } else {
        console.log(`⏭️  [${i + 1}/${targets.length}] ${code} — มี metadata แล้ว, ข้าม`);
      }
      skipped++;
      continue;
    }

    console.log(`\n━━━ [${i + 1}/${targets.length}] ${code} ━━━`);

    try {
      let meta = null;
      if (station.referer) {
        try {
          const parsed = await parseVideoPage(station.referer);
          meta = { actresses: parsed.actresses, release_date: parsed.release_date, genres: parsed.genres };
        } catch (e) {
          console.log(`  ⚠️  fetch page error: ${e.message}`);
        }
      }

      const enriched = enrichStation(station, meta);
      index.stations[idx] = enriched;
      updated++;
      console.log(`  ✅ อัปเดต: "${enriched.name}"${enriched.badge ? ` [${enriched.badge}]` : ""}`);

      if (i < targets.length - 1) await sleep(1500);
    } catch (e) {
      console.log(`  ❌ Error: ${e.message}`);
      failed++;
    }
  }

  writeIndex(index);
  console.log(`\n━━━ สรุป ━━━`);
  console.log(`  ✅ อัปเดต: ${updated}`);
  console.log(`  🔄 migrate host: ${migrated}`);
  console.log(`  🔒 wrap proxy: ${proxied}`);
  console.log(`  ⏭️  ข้าม: ${skipped}`);
  console.log(`  ❌ ล้มเหลว: ${failed}`);
  process.exit(0);
}

async function main() {
  if (updateMeta) {
    await runUpdateMeta();
    return;
  }

  try {
    const migratedPageUrl = migrateLegacyUrl(pageUrl);
    if (migratedPageUrl !== pageUrl) {
      console.log(`🔄 migrate URL: ${pageUrl} → ${migratedPageUrl}`);
    }

    const { code, cover, embedInfo, actresses, release_date, genres } = await parseVideoPage(migratedPageUrl);
    if (!code) {
      console.error("❌ ไม่พบข้อมูลวิดีโอ");
      process.exit(1);
    }

    console.log(`\n🎬 พบ ${embedInfo.length} embed(s)`);
    const parts = [];
    for (let i = 0; i < embedInfo.length; i++) {
      const { embedUrl, label } = embedInfo[i];
      console.log(`\n🔗 Embed ${i + 1} (${label}): ${embedUrl}`);
      try {
        const streamUrl = await getStreamFromEmbed(embedUrl);
        parts.push({ name: embedInfo.length > 1 ? `Part ${i + 1}` : "Full", url: streamUrl });
      } catch (e) {
        console.log(`  ⚠️  ${e.message}`);
      }
      if (i < embedInfo.length - 1) await sleep(500);
    }

    if (parts.length === 0) {
      console.error("\n❌ ไม่สามารถหา stream URL ได้");
      process.exit(1);
    }

    console.log(`\n✅ พบ ${parts.length} stream(s)`);
    parts.forEach((p, i) => console.log(`  [${i}] ${p.name}: ${p.url}`));

    if (!fs.existsSync(PLAYLIST_DIR)) fs.mkdirSync(PLAYLIST_DIR, { recursive: true });

    const streamUrl = parts[0].url;
    const hasMeta = actresses.length || release_date || genres.length;
    const meta = hasMeta ? { actresses, release_date, genres } : null;

    updateIndex(code, cover, streamUrl, migratedPageUrl, meta);
    console.log(`\n🎉 เสร็จสิ้น!`);
    console.log(`  เพิ่ม "${code}" ลง index.txt`);
    console.log(`  stream: ${streamUrl}`);
    process.exit(0);

  } catch (err) {
    console.error(`\n❌ Error: ${err.message}`);
    if (err.stack) console.error(err.stack);
    process.exit(1);
  }
}

main();

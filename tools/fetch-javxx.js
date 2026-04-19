#!/usr/bin/env node
/**
 * fetch-javxx.js
 * สร้าง / อัปเดต playlist JSON จาก javxx.com + ดึง metadata จาก JavDB
 *
 * ─── Flags ───────────────────────────────────────────────────────────────
 *   <url>              URL หน้าวิดีโอบน javxx.com (เช่น https://javxx.com/th/v/skmj-408)
 *   --output=FILE      ชื่อไฟล์ผลลัพธ์ใน playlist/av/ (ไม่ต้องใส่ path)
 *   --update-meta      อัปเดต metadata ของ entries ที่มีอยู่แล้วใน index.txt
 *                      ไม่ต้องใส่ URL — จะวนอัปเดตทุกรายการที่ยังไม่มี metadata
 *   --update-meta=all  อัปเดต metadata ทุกรายการ (ทับข้อมูลเดิม)
 *   --code=SKMJ-408    อัปเดตเฉพาะรหัสที่ระบุ
 *
 * ─── Workflow ────────────────────────────────────────────────────────────
 *
 *   # เพิ่มวิดีโอใหม่
 *   node fetch-javxx.js https://javxx.com/th/v/skmj-408
 *
 *   # อัปเดต metadata ทุกรายการที่ยังไม่มี
 *   node fetch-javxx.js --update-meta
 *
 *   # อัปเดต metadata ทุกรายการ (ทับเดิม)
 *   node fetch-javxx.js --update-meta=all
 *
 *   # อัปเดตเฉพาะรหัสที่ระบุ
 *   node fetch-javxx.js --update-meta --code=SKMJ-408
 *
 * ─── Stream extraction flow ──────────────────────────────────────────────
 *   1. Fetch javxx page → extract title, cover, video code, encrypted data-url(s)
 *   2. Fetch app bundle JS → extract & run simpleDecrypt via vm module
 *   3. Decrypt data-url → surrit.store embed URL
 *   4. Fetch surrit.store embed → find wowstream.cloud m3u8 URL
 *
 * ─── Metadata sources ────────────────────────────────────────────────────
 *   1. javxx.com    — title, cover (og:image), tags
 *   2. JavDB.com    — title (JP/EN), actresses, genres, studio, duration, date, rating
 */

const cheerio = require("cheerio");
const fs = require("fs");
const path = require("path");
const vm = require("vm");

// ───── CLI args ─────
const args = process.argv.slice(2);
const pageUrl = args.find((a) => a.startsWith("http") && !a.startsWith("--"));
const customOutput = (args.find((a) => a.startsWith("--output=")) || "").replace("--output=", "");
const streamUrlOverride = (args.find((a) => a.startsWith("--stream-url=")) || "").replace("--stream-url=", "");
const debugMode = args.includes("--debug");

const updateMetaArg = args.find((a) => a === "--update-meta" || a.startsWith("--update-meta="));
const updateMeta = !!updateMetaArg;
const updateMetaMode = updateMetaArg?.includes("=") ? updateMetaArg.split("=")[1] : "missing";
const targetCode = (args.find((a) => a.startsWith("--code=")) || "").replace("--code=", "").toUpperCase();

if (!pageUrl && !updateMeta) {
  console.error("Usage: node fetch-javxx.js <url> [--output=FILE.txt] [--stream-url=M3U8_URL] [--debug]");
  console.error("       node fetch-javxx.js --update-meta[=all] [--code=CODE]");
  console.error("");
  console.error("  --stream-url=URL   ระบุ m3u8 URL ตรงๆ (copy จาก Network tab)");
  console.error("  --update-meta      อัปเดต metadata (เฉพาะรายการที่ยังไม่มี)");
  console.error("  --update-meta=all  อัปเดต metadata ทั้งหมด (ทับเดิม)");
  console.error("  --code=CODE        อัปเดตเฉพาะรหัสที่ระบุ");
  console.error("  --debug            บันทึก embed HTML / player JS ลงไฟล์ debug");
  process.exit(1);
}

// ───── Config ─────
const PLAYLIST_DIR = path.resolve(__dirname, "../playlist/av");
const INDEX_PATH = path.resolve(PLAYLIST_DIR, "index.txt");
const SITE_BASE = "https://javxx.com";

const HEADERS = {
  "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
  "Accept-Language": "th-TH,th;q=0.9,en-US;q=0.8,en;q=0.7",
  Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8",
  "sec-ch-ua": '"Chromium";v="131", "Not_A Brand";v="24"',
  "sec-ch-ua-mobile": "?0",
  "sec-ch-ua-platform": '"Windows"',
  "Sec-Fetch-Dest": "document",
  "Sec-Fetch-Mode": "navigate",
  "Sec-Fetch-Site": "none",
  "Sec-Fetch-User": "?1",
  "Upgrade-Insecure-Requests": "1",
};

// ───── Helpers ─────
async function fetchText(url, extraHeaders = {}) {
  const res = await fetch(url, { headers: { ...HEADERS, ...extraHeaders }, redirect: "follow" });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  return res.text();
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function slugify(str) {
  return str.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "");
}

// ───── Parse javxx page ─────
async function parseVideoPage(url) {
  console.log(`📡 กำลัง fetch หน้าวิดีโอ: ${url}`);
  const html = await fetchText(url);
  const $ = cheerio.load(html);

  // Title & code
  const h1 = $("h1").first().text().trim();
  const urlCode = url.match(/\/v\/([^/?#]+)/)?.[1] || "";
  const dtagCode = $("d-tag#player").attr("code") || "";
  const rawCode = (dtagCode || urlCode).toUpperCase();
  // Clean code: strip numeric prefix + trailing tags (e.g. "110FSET-249-UNCENSORED-LEAKED" → "FSET-249")
  const codeClean = rawCode.match(/\d*([A-Z]+-\d+)/i);
  const code = codeClean ? codeClean[1].toUpperCase() : rawCode;
  console.log(`  รหัส: ${code}`);

  // Cover image
  const ogImage = $('meta[property="og:image"]').attr("content") || "";
  const dtagCover = $("d-tag#player").attr("cover") || "";
  const cover = ogImage || dtagCover || "";
  console.log(`  ปก: ${cover}`);

  // Extract metadata from javxx detail section
  // DOM structure: <div class="meta"> → <div> per field → <label>Label:</label> <a>value</a>, ...
  // Strategy: find smallest element whose .text() matches label AND has actual value content after it
  function findFieldValue($, valueRegex) {
    let best = null;
    let bestLen = Infinity;
    $("*").each((_, el) => {
      const text = $(el).text().trim();
      const m = text.match(valueRegex);
      if (m && m[1]?.trim() && text.length < bestLen) {
        best = m[1].trim();
        bestLen = text.length;
      }
    });
    return best;
  }

  // Actresses (require actual colon, not just space)
  const actresses = [];
  const actressVal = findFieldValue($, /(?:นักแสดงหญิง|นักแสดง)\s*[:：]\s*(.+)/i);
  if (actressVal) {
    actressVal.split(/[,、，]/).forEach(n => {
      const name = n.trim();
      if (name && name.length > 1) actresses.push(name);
    });
  }

  // Release date
  const date = findFieldValue($, /วันที่วางจำหน่าย\s*[:：]\s*(\d{4}-\d{2}-\d{2})/i) || "";

  // Genres / Categories
  const categories = [];
  const genreVal = findFieldValue($, /หมวดหมู่\s*[:：]\s*(.+)/i);
  if (genreVal) {
    genreVal.split(/[,、，]/).forEach(c => {
      const cat = c.trim();
      if (cat && cat.length > 1) categories.push(cat);
    });
  }

  console.log(`  รหัส: ${code}`);
  if (actresses.length) console.log(`  นักแสดงหญิง: ${actresses.join(", ")}`);
  if (date) console.log(`  วันที่วางจำหน่าย: ${date}`);
  if (categories.length) console.log(`  หมวดหมู่: ${categories.join(", ")}`);

  // Encrypted data-url attributes
  const dataUrls = [];
  $("[data-url]").each((_, el) => {
    const val = $(el).attr("data-url");
    const label = $(el).text().trim() || `Part ${dataUrls.length + 1}`;
    if (val) dataUrls.push({ encrypted: val, label });
  });
  console.log(`  พบ ${dataUrls.length} data-url(s)`);

  // App bundle script path (for simpleDecrypt)
  const scripts = $("script[src]").map((_, el) => $(el).attr("src")).get();
  const appScript = scripts.find((s) => s.includes("/assets/") && s.includes("script"));
  console.log(`  App script: ${appScript || "NOT FOUND"}`);

  return { code, cover, dataUrls, appScript, html, actresses, release_date: date, genres: categories };
}

// ───── Fetch metadata from JavDB ─────
async function fetchJavDBMeta(code) {
  console.log(`\n🔍 ค้นหา metadata จาก JavDB: ${code}`);
  try {
    // Search by code
    const searchUrl = `https://javdb.com/search?q=${encodeURIComponent(code)}&f=all`;
    const searchHtml = await fetchText(searchUrl, {
      Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      Referer: "https://javdb.com/",
    });
    const $s = cheerio.load(searchHtml);

    // Find the detail page link from search results
    let detailPath = "";
    $s(".movie-list .item a, .grid-item a, a.box").each((_, el) => {
      const href = $s(el).attr("href") || "";
      const itemCode = $s(el).find(".video-title strong, .uid, .tag").text().trim().toUpperCase();
      if (!detailPath && (itemCode.includes(code) || href)) {
        detailPath = href;
      }
    });

    // Fallback: find first result link
    if (!detailPath) {
      detailPath = $s('a[href^="/v/"]').first().attr("href") || "";
    }

    if (!detailPath) {
      console.log(`  ⚠️  ไม่พบ ${code} บน JavDB`);
      return null;
    }

    const detailUrl = detailPath.startsWith("http") ? detailPath : `https://javdb.com${detailPath}`;
    console.log(`  📄 Detail page: ${detailUrl}`);

    const detailHtml = await fetchText(detailUrl, {
      Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      Referer: searchUrl,
    });
    const $d = cheerio.load(detailHtml);

    const meta = {};

    // Title
    const pageTitle = $d("h2.title, .video-title, h1").first().text().trim();
    if (pageTitle) meta.title = pageTitle.replace(code, "").replace(/^\s*[-–]\s*/, "").trim();

    // Cover image (high-res)
    const coverImg = $d('.video-cover img, img.video-cover, .column-video-cover img, meta[property="og:image"]');
    const coverUrl = coverImg.attr("src") || coverImg.attr("content") || "";
    if (coverUrl) meta.coverHD = coverUrl.startsWith("http") ? coverUrl : `https://javdb.com${coverUrl}`;

    // Parse info panel (dt/dd pairs or label/value rows)
    $d(".movie-panel-info .panel-block, .video-meta-panel .panel-block").each((_, el) => {
      const text = $d(el).text().trim();
      const value = $d(el).find("a, .value, span:last-child").text().trim() ||
                    text.split(/[:：]/)[1]?.trim() || "";

      if (/番號|ID|Code/i.test(text)) meta.code = value.toUpperCase();
      if (/日期|Released|Date/i.test(text)) meta.date = value;
      if (/時長|Duration|Runtime/i.test(text)) meta.duration = value;
      if (/導演|Director/i.test(text)) meta.director = value;
      if (/片商|Studio|Maker/i.test(text)) meta.studio = value;
      if (/發行|Label|Publisher/i.test(text)) meta.label = value;
      if (/評分|Rating|Score/i.test(text)) meta.rating = value;
      if (/系列|Series/i.test(text)) meta.series = value;
    });

    // Actresses
    const actresses = [];
    $d('.movie-panel-info a[href*="/actors/"], .panel-block a[href*="/actors/"], a[href*="/stars/"]').each((_, el) => {
      const name = $d(el).text().trim();
      if (name && !actresses.includes(name)) actresses.push(name);
    });
    if (actresses.length) meta.actresses = actresses;

    // Genres / Tags
    const genres = [];
    $d('.movie-panel-info a[href*="/tags"], .panel-block a[href*="/tags"]').each((_, el) => {
      const g = $d(el).text().trim();
      if (g && !genres.includes(g)) genres.push(g);
    });
    if (genres.length) meta.genres = genres;

    console.log(`  ✅ JavDB metadata:`, JSON.stringify(meta, null, 2).substring(0, 500));
    return meta;
  } catch (e) {
    console.log(`  ⚠️  JavDB fetch error: ${e.message}`);
    return null;
  }
}

// ───── Merge metadata into station entry ─────
function enrichStation(station, javxxMeta, javdbMeta) {
  const rawName = station.name || "";
  const referer = station.referer || "";

  // Extract clean CODE: strip numeric prefix + tags
  // JAV code pattern: optional digits + LETTERS-DIGITS (e.g. SKMJ-408, 110FSET-249 → FSET-249)
  const codeMatch = rawName.match(/\d*([A-Z]+-\d+)/i);
  const cleanCode = codeMatch ? codeMatch[1].toUpperCase() : rawName.replace(/\s+.+$/, "").toUpperCase();

  // Extract special tags from name + URL slug
  // e.g. name: "FSET-249 [UNCENSORED LEAKED]" or URL: ".../110fset-249-uncensored-leaked"
  const tagSource = `${rawName} ${referer}`;
  const specialTags = [];
  // Check combined patterns (more specific first)
  if (/uncensored.?leaked/i.test(tagSource)) {
    specialTags.push("UNCENSORED LEAKED");
  } else {
    if (/uncensored/i.test(tagSource)) specialTags.push("UNCENSORED");
    if (/leaked/i.test(tagSource)) specialTags.push("LEAKED");
  }
  if (/\b4K\b/i.test(tagSource)) specialTags.push("4K");

  // Build metadata object — only actresses, release_date, genres
  const meta = {};
  const actresses = javdbMeta?.actresses || javxxMeta?.actresses || [];
  if (actresses.length) meta.actresses = actresses;
  const releaseDate = javxxMeta?.release_date || javdbMeta?.date || "";
  if (releaseDate) meta.release_date = releaseDate;
  const genres = javxxMeta?.genres || javdbMeta?.genres || [];
  if (genres.length) meta.genres = genres;

  // Badge: title-case, top-level key (e.g. "UNCENSORED LEAKED" → "Uncensored Leaked")
  const badge = specialTags.length
    ? specialTags.map(t => t.split(/\s+/).map(w => w.charAt(0) + w.slice(1).toLowerCase()).join(" ")).join(", ")
    : undefined;

  const result = { ...station, name: cleanCode };
  // Always overwrite badge and meta (remove old data if no new data)
  if (badge) result.badge = badge; else delete result.badge;
  if (Object.keys(meta).length) result.meta = meta; else delete result.meta;
  return result;
}

// ───── Extract simpleDecrypt from app bundle using vm ─────
async function getDecryptFunction(appScriptPath) {
  const scriptUrl = appScriptPath.startsWith("http")
    ? appScriptPath
    : `${SITE_BASE}${appScriptPath}`;
  console.log(`\n🔑 กำลังดึง app bundle: ${scriptUrl}`);
  const js = await fetchText(scriptUrl);
  console.log(`  ขนาด: ${(js.length / 1024).toFixed(0)} KB`);

  // Find ALL occurrences of "simpleDecrypt" to understand how it's defined and called
  const allMatches = [];
  let searchIdx = 0;
  while (true) {
    const idx = js.indexOf("simpleDecrypt", searchIdx);
    if (idx < 0) break;
    const ctx = js.substring(Math.max(0, idx - 60), Math.min(js.length, idx + 80));
    allMatches.push({ idx, ctx });
    searchIdx = idx + 1;
  }
  console.log(`  พบ "simpleDecrypt" ${allMatches.length} ตำแหน่ง:`);
  allMatches.forEach((m, i) => {
    console.log(`    [${i}] @${m.idx}: ...${m.ctx.replace(/\n/g, "\\n")}...`);
  });

  if (allMatches.length === 0) return null;

  // Look for the CALL SITE pattern: something = simpleDecrypt(encryptedValue)
  // This tells us how the function is used
  const callMatch = allMatches.find(m => m.ctx.match(/simpleDecrypt\s*\(/));
  if (callMatch) {
    console.log(`\n  📞 Call site: ...${callMatch.ctx}...`);
  }

  // Find the definition: look for where simpleDecrypt is defined as a function
  const defMatch = allMatches.find(m =>
    m.ctx.match(/simpleDecrypt\s*[=:]\s*(?:function|\()/) ||
    m.ctx.match(/function\s+simpleDecrypt/) ||
    m.ctx.match(/simpleDecrypt\s*\([\w,\s]*\)\s*\{/)
  );

  if (!defMatch) {
    console.log(`  ⚠️  ไม่พบ definition ของ simpleDecrypt`);
    return null;
  }

  const fnNameIdx = defMatch.idx;
  console.log(`\n  📍 Definition @${fnNameIdx}`);

  // Check what's between "simpleDecrypt" and the first "{"
  const afterName = js.substring(fnNameIdx, fnNameIdx + 60);
  console.log(`  📝 After name: ${afterName}`);

  // Detect IIFE pattern: simpleDecrypt=(function(){...})()
  const isIIFE = /simpleDecrypt\s*=\s*\(?\s*function\s*\(\s*\)/.test(afterName);
  console.log(`  📝 Is IIFE: ${isIIFE}`);

  // Find the opening brace of the function body
  const braceStart = js.indexOf("{", fnNameIdx);
  if (braceStart < 0 || braceStart - fnNameIdx > 100) {
    console.log(`  ⚠️  ไม่พบ opening brace ใกล้ definition`);
    return null;
  }

  let depth = 0, braceEnd = braceStart;
  for (let i = braceStart; i < js.length; i++) {
    if (js[i] === "{") depth++;
    if (js[i] === "}") depth--;
    if (depth === 0) { braceEnd = i; break; }
  }

  const fnBody = js.substring(braceStart + 1, braceEnd);
  console.log(`  📝 Function body: ${fnBody.length} chars`);
  console.log(`  📝 First 200: ${fnBody.substring(0, 200)}`);

  // Check what comes after the closing brace (looking for IIFE invocation "()")
  const afterBrace = js.substring(braceEnd + 1, braceEnd + 10);
  console.log(`  📝 After closing brace: "${afterBrace}"`);

  const sandbox = {
    atob: (s) => Buffer.from(s, "base64").toString("binary"),
    btoa: (s) => Buffer.from(s, "binary").toString("base64"),
    Object, String, Number, parseInt, parseFloat, Math, Array, Boolean,
    decodeURIComponent, encodeURIComponent, decodeURI, encodeURI,
    JSON, RegExp, Date, Error, TypeError,
    console, undefined, NaN, Infinity, isNaN, isFinite,
  };
  vm.createContext(sandbox);

  if (isIIFE) {
    // simpleDecrypt = (function(){ ...body... })()
    // Execute the IIFE to get the actual function
    console.log(`\n  🔧 Executing IIFE to get actual decrypt function...`);
    try {
      const iifeCode = `(function() { ${fnBody} })()`;
      const fn = vm.runInContext(iifeCode, sandbox);
      console.log(`  ✅ IIFE executed! Result type: ${typeof fn}`);
      if (typeof fn === "function") {
        // Test with a dummy value
        try {
          const testResult = fn("dGVzdA==");
          console.log(`  🧪 Test: type=${typeof testResult}, value=${String(testResult).substring(0, 100)}`);
        } catch (e) {
          console.log(`  🧪 Test error: ${e.message}`);
        }
        return fn;
      } else {
        console.log(`  ⚠️  IIFE returned ${typeof fn}, not a function`);
        console.log(`  📝 Value: ${JSON.stringify(fn)?.substring(0, 200)}`);
      }
    } catch (e) {
      console.log(`  ⚠️  IIFE execution failed: ${e.message}`);
      // Try a broader extraction: include more surrounding code
      console.log(`  🔄 Trying broader extraction...`);
    }
  }

  // Fallback: try as regular function
  const paramMatch = js.substring(fnNameIdx, braceStart).match(/\((\w+)\)/);
  const paramName = paramMatch ? paramMatch[1] : "t";
  console.log(`\n  🔧 Trying as regular function(${paramName})...`);

  try {
    const wrappedCode = `(function simpleDecrypt(${paramName}) { ${fnBody} })`;
    const fn = vm.runInContext(wrappedCode, sandbox);
    console.log(`  ✅ compile สำเร็จ!`);

    // The function might return another function (the IIFE case)
    // Try: call it with no args to get inner function, then use that
    try {
      const inner = fn();
      if (typeof inner === "function") {
        console.log(`  ✅ fn() returned a function → using that as decrypt`);
        try {
          const testResult = inner("dGVzdA==");
          console.log(`  🧪 Test inner: type=${typeof testResult}, value=${String(testResult).substring(0, 100)}`);
        } catch (e) {
          console.log(`  🧪 Test inner error: ${e.message}`);
        }
        return inner;
      }
    } catch {}

    return fn;
  } catch (e) {
    console.log(`  ⚠️  compile failed: ${e.message}`);
  }

  // Save for manual debugging
  const debugPath = path.resolve(__dirname, "_debug_simpleDecrypt.js");
  fs.writeFileSync(debugPath, `(function() {\n${fnBody}\n})()`, "utf-8");
  console.log(`  💾 Saved to ${debugPath}`);

  return null;
}

// ───── Execute player script in vm to intercept API call ─────
async function runPlayerInVm(playerJs, embedUrl, debug = false) {
  const embedCode = embedUrl.match(/\/e\/([A-Za-z0-9_-]+)/)?.[1] || "";
  const embedUrlObj = new URL(embedUrl);

  console.log(`\n  🔧 กำลังรัน player script ใน VM sandbox...`);

  // Capture global fetch reference before it gets shadowed
  const realFetch = globalThis.fetch;

  // Promise that resolves when the player script makes a fetch call
  return new Promise((resolve) => {
    let resolved = false;
    let fallbackTimer = null;
    const done = (url) => {
      if (resolved) return;
      resolved = true;
      clearTimeout(timer);
      clearTimeout(fallbackTimer);
      resolve(url);
    };

    // Timeout after 10s
    const timer = setTimeout(() => done(null), 10000);

    // ─── Build mock browser environment ───
    const mockSearchParams = new URLSearchParams(embedUrlObj.search);

    // Mock element that ignores all operations
    const noop = () => {};
    const mockEl = () => ({
      style: {}, dataset: {},
      setAttribute: noop, getAttribute: () => null,
      appendChild: noop, removeChild: noop, append: noop,
      addEventListener: noop, removeEventListener: noop,
      querySelector: () => null, querySelectorAll: () => [],
      getElementsByTagName: () => [], getElementsByClassName: () => [],
      classList: { add: noop, remove: noop, contains: () => false, toggle: noop },
      textContent: "", innerHTML: "", innerText: "",
      src: "", href: "", id: "", className: "",
      parentNode: null, parentElement: null,
      children: [], childNodes: [],
      getBoundingClientRect: () => ({ top: 0, left: 0, width: 800, height: 450, bottom: 450, right: 800 }),
      offsetWidth: 800, offsetHeight: 450,
      play: () => Promise.resolve(), pause: noop, load: noop,
      canPlayType: () => "maybe",
    });

    const mockDoc = {
      location: {
        href: embedUrl, pathname: embedUrlObj.pathname,
        search: embedUrlObj.search, hostname: "surrit.store",
        origin: "https://surrit.store", protocol: "https:",
        host: "surrit.store", port: "",
        toString() { return this.href; },
      },
      referrer: SITE_BASE + "/",
      search: embedUrlObj.search,
      title: "", cookie: "",
      createElement: (tag) => {
        const el = mockEl();
        el.tagName = tag.toUpperCase();
        if (tag === "source") {
          Object.defineProperty(el, "src", {
            set(v) { el._src = v; },
            get() { return el._src || ""; },
          });
        }
        return el;
      },
      createTextNode: () => mockEl(),
      getElementById: () => mockEl(),
      querySelector: (sel) => {
        // Return video element mock for video queries
        if (sel === "video" || sel.includes("video")) return mockEl();
        return mockEl();
      },
      querySelectorAll: () => [],
      getElementsByTagName: () => [],
      getElementsByClassName: () => [],
      head: mockEl(), body: mockEl(),
      documentElement: mockEl(),
      addEventListener: noop, removeEventListener: noop,
    };

    const mockWindow = {
      document: mockDoc,
      location: mockDoc.location,
      navigator: { userAgent: HEADERS["User-Agent"], language: "th-TH", languages: ["th-TH", "th", "en"] },
      screen: { width: 1920, height: 1080, availWidth: 1920, availHeight: 1040 },
      innerWidth: 1920, innerHeight: 1080, outerWidth: 1920, outerHeight: 1080,
      devicePixelRatio: 1,
      addEventListener: noop, removeEventListener: noop,
      setTimeout: (fn, ms) => setTimeout(fn, Math.min(ms, 5000)),
      clearTimeout, setInterval: () => 0, clearInterval: noop,
      requestAnimationFrame: (fn) => setTimeout(fn, 16),
      cancelAnimationFrame: noop,
      getComputedStyle: () => new Proxy({}, { get: () => "0px" }),
      matchMedia: () => ({ matches: false, addEventListener: noop, removeEventListener: noop }),
      ResizeObserver: class { observe() {} unobserve() {} disconnect() {} },
      MutationObserver: class { observe() {} disconnect() {} },
      IntersectionObserver: class { observe() {} unobserve() {} disconnect() {} },
      CustomEvent: class CustomEvent { constructor(t, o) { this.type = t; this.detail = o?.detail; } },
      Event: class Event { constructor(t) { this.type = t; } },
      self: null,
      top: null,
      parent: null,
      URL, URLSearchParams, Headers,
      console: debug ? console : { log: noop, warn: noop, error: noop, info: noop, debug: noop },
      atob: (s) => Buffer.from(s, "base64").toString("binary"),
      btoa: (s) => Buffer.from(s, "binary").toString("base64"),
      parseInt, parseFloat, isNaN, isFinite,
      encodeURIComponent, decodeURIComponent, encodeURI, decodeURI,
      Object, String, Number, Boolean, Array, RegExp, Date, Error, TypeError, RangeError,
      SyntaxError, ReferenceError, EvalError, URIError,
      Map, Set, WeakMap, WeakSet, Symbol, Proxy, Reflect,
      Promise, JSON, Math, NaN, Infinity, undefined,
      // Intercepted fetch — the key part!
      fetch: async (url, opts) => {
        const urlStr = typeof url === "string" ? url : url.toString();
        if (debug) console.log(`    📡 VM fetch intercepted: ${urlStr.substring(0, 200)}`);

        // Make real fetch and capture response
        try {
          const realRes = await realFetch(urlStr, {
            headers: { ...HEADERS, Referer: embedUrl, Origin: "https://surrit.store" },
            redirect: "follow",
          });
          const body = await realRes.text();
          if (debug) console.log(`    📡 Response: ${realRes.status} (${body.length} chars)`);

          // Check if response or any decrypted form contains m3u8 URL
          const m3u8Match = body.match(/https?:\/\/[^"'\s\\]*\.m3u8[^"'\s\\]*/i);
          if (m3u8Match) {
            console.log(`    ✅ พบ m3u8 ใน API response: ${m3u8Match[0]}`);
            clearTimeout(timer);
            done(m3u8Match[0]);
          }

          // Return a mock Response so the script can continue its decrypt pipeline
          const mockRes = {
            ok: realRes.ok, status: realRes.status, statusText: realRes.statusText || "",
            headers: { get: (h) => realRes.headers?.get?.(h) || null, has: () => false },
            text: () => Promise.resolve(body),
            json: () => { try { return Promise.resolve(JSON.parse(body)); } catch { return Promise.resolve({}); } },
            arrayBuffer: () => Promise.resolve(Buffer.from(body, "binary").buffer),
            clone: function() { return { ...mockRes, text: () => Promise.resolve(body) }; },
          };
          return mockRes;
        } catch (e) {
          if (debug) console.log(`    📡 Fetch error: ${e.message}`);
          return { ok: false, status: 0, text: () => Promise.resolve(""), json: () => Promise.resolve({}) };
        }
      },
      XMLHttpRequest: class {
        open(m, u) { this._url = u; this._method = m; }
        send() {
          if (debug) console.log(`    📡 VM XHR: ${this._url}`);
        }
        setRequestHeader() {}
        addEventListener() {}
      },
      // Plyr & Hls mocks (video player libraries)
      Hls: class {
        static isSupported() { return true; }
        constructor() { this.levels = []; this._events = {}; }
        loadSource(url) {
          console.log(`    ✅ HLS loadSource: ${url}`);
          clearTimeout(timer);
          done(url);
        }
        attachMedia() {}
        on(ev, fn) { this._events[ev] = fn; }
        destroy() {}
      },
      Plyr: class {
        constructor() { this.elements = { container: mockEl() }; this.source = null; }
        on() {} off() {} destroy() {} play() { return Promise.resolve(); }
      },
    };
    mockWindow.self = mockWindow;
    mockWindow.top = mockWindow;
    mockWindow.parent = mockWindow;
    mockWindow.window = mockWindow;
    mockWindow.globalThis = mockWindow;

    // Create vm context
    const ctx = vm.createContext(mockWindow);

    // Suppress unhandled promise rejections from VM (player script errors)
    const suppressUnhandled = (reason) => {
      if (debug) console.log(`    ⚠️ VM unhandled rejection: ${reason}`);
    };
    process.on("unhandledRejection", suppressUnhandled);

    try {
      // Run the player script
      vm.runInContext(playerJs, ctx, { timeout: 8000, filename: "player.js" });
    } catch (e) {
      if (debug) console.log(`    ⚠️ VM execution error: ${e.message}`);
    }

    // Give async operations time to complete
    fallbackTimer = setTimeout(() => {
      process.removeListener("unhandledRejection", suppressUnhandled);
      done(null);
    }, 8000);
  });
}

// ───── Fetch surrit.store embed and find stream URL ─────
async function getStreamFromEmbed(embedUrl, debug = false) {
  console.log(`\n🎬 กำลัง fetch embed: ${embedUrl}`);
  const html = await fetchText(embedUrl, {
    Referer: SITE_BASE + "/",
    Origin: SITE_BASE,
    "Sec-Fetch-Dest": "iframe",
    "Sec-Fetch-Mode": "navigate",
    "Sec-Fetch-Site": "cross-site",
  });

  if (debug) {
    const debugEmbed = path.resolve(__dirname, "_debug_embed.html");
    fs.writeFileSync(debugEmbed, html, "utf-8");
    console.log(`  💾 Embed HTML saved: ${debugEmbed} (${html.length} chars)`);
  }

  // Quick wins: direct m3u8 or wowstream URL in embed HTML
  const directStream =
    html.match(/https?:\/\/[^"'\s]*wowstream\.cloud[^"'\s]*\.m3u8[^"'\s]*/i)?.[0] ||
    html.match(/https?:\/\/[^"'\s]+\.m3u8[^"'\s]*/i)?.[0];
  if (directStream) {
    console.log(`  ✅ พบ stream URL ใน HTML: ${directStream}`);
    return directStream;
  }

  // Look for UUID (surrit.com pattern)
  const uuidMatch = html.match(/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i);
  if (uuidMatch) {
    console.log(`  ✅ พบ UUID: ${uuidMatch[1]}`);
    return `https://surrit.com/${uuidMatch[1]}/playlist.m3u8`;
  }

  // Parse embed page for player script
  const $e = cheerio.load(html);
  const embedScripts = $e("script[src]").map((_, el) => $e(el).attr("src")).get();
  const playerScriptPath = embedScripts.find(s => s.includes("player") && s.includes("script"))
    || embedScripts.find(s => s.includes("script") && s.includes("assets"));

  if (playerScriptPath) {
    const playerUrl = playerScriptPath.startsWith("http")
      ? playerScriptPath
      : `https://surrit.store${playerScriptPath}`;
    console.log(`\n  🔍 กำลัง fetch player script: ${playerUrl}`);
    try {
      const playerJs = await fetchText(playerUrl, { Referer: embedUrl });
      console.log(`    ขนาด: ${(playerJs.length / 1024).toFixed(0)} KB`);

      if (debug) {
        const debugPlayer = path.resolve(__dirname, "_debug_player.js");
        fs.writeFileSync(debugPlayer, playerJs, "utf-8");
        console.log(`    💾 Player JS saved: ${debugPlayer}`);
      }

      // Run the player script in vm with intercepted fetch/HLS
      const streamUrl = await runPlayerInVm(playerJs, embedUrl, debug);
      if (streamUrl) return streamUrl;

    } catch (e) {
      console.log(`    ⚠️ Failed: ${e.message}`);
    }
  } else {
    console.log(`  ⚠️ ไม่พบ player script ใน embed HTML`);
    if (debug) {
      console.log(`  📝 Scripts found: ${embedScripts.join(", ")}`);
    }
  }

  return null;
}

// ───── Read/Write index.txt ─────
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

// ───── Update index.txt (flat stations format) ─────
function updateIndex(code, cover, streamUrl, pageUrl, extraMeta) {
  const index = readIndex();
  // Extract base code (without title suffix) for matching
  const existing = index.stations.findIndex((s) => extractCode(s.name) === code);
  let entry = { url: streamUrl, name: code, image: cover, referer: pageUrl };
  if (extraMeta) {
    entry = enrichStation(entry, extraMeta.javxx, extraMeta.javdb);
  }
  if (existing >= 0) {
    // Preserve existing meta if not overwriting
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

// ───── Extract code from display name (e.g. "SKMJ-408 Title here" → "SKMJ-408") ─────
function extractCode(displayName) {
  // JAV codes: optional numeric prefix + LETTERS-DIGITS (e.g. "110FSET-249" → "FSET-249")
  const m = displayName.match(/\d*([A-Z]+-\d+)/i);
  return m ? m[1].toUpperCase() : displayName.toUpperCase();
}

// ───── Update metadata for existing entries ─────
async function runUpdateMeta() {
  const index = readIndex();
  if (!index.stations.length) {
    console.error("❌ ไม่มีรายการใน index.txt");
    process.exit(1);
  }

  // Filter targets
  let targets = index.stations;
  if (targetCode) {
    targets = targets.filter((s) => extractCode(s.name) === targetCode);
    if (!targets.length) {
      console.error(`❌ ไม่พบรหัส ${targetCode} ใน index.txt`);
      process.exit(1);
    }
  }

  const forceAll = updateMetaMode === "all";
  let updated = 0;
  let skipped = 0;
  let failed = 0;

  for (let i = 0; i < targets.length; i++) {
    const station = targets[i];
    const code = extractCode(station.name);
    const idx = index.stations.findIndex((s) => s === station);

    // Skip if already has metadata (unless force all)
    if (!forceAll && station.meta) {
      console.log(`⏭️  [${i + 1}/${targets.length}] ${code} — มี metadata แล้ว, ข้าม`);
      skipped++;
      continue;
    }

    console.log(`\n━━━ [${i + 1}/${targets.length}] ${code} ━━━`);

    try {
      // Fetch actresses from javxx page (using referer URL)
      let javxxMeta = null;
      if (station.referer) {
        try {
          console.log(`📡 Fetch javxx page: ${station.referer}`);
          const html = await fetchText(station.referer);
          const $ = cheerio.load(html);

          // Parse metadata: find smallest element with label AND actual value
          function findFieldValue(valueRegex) {
            let best = null, bestLen = Infinity;
            $("*").each((_, el) => {
              const text = $(el).text().trim();
              const m = text.match(valueRegex);
              if (m && m[1]?.trim() && text.length < bestLen) {
                best = m[1].trim(); bestLen = text.length;
              }
            });
            return best;
          }

          const actresses = [];
          const actressVal = findFieldValue(/(?:นักแสดงหญิง|นักแสดง)\s*[:：]\s*(.+)/i);
          if (actressVal) {
            actressVal.split(/[,、，]/).forEach(n => {
              const name = n.trim();
              if (name && name.length > 1) actresses.push(name);
            });
          }

          const releaseDate = findFieldValue(/วันที่วางจำหน่าย\s*[:：]\s*(\d{4}-\d{2}-\d{2})/i) || "";

          const genres = [];
          const genreVal = findFieldValue(/หมวดหมู่\s*[:：]\s*(.+)/i);
          if (genreVal) {
            genreVal.split(/[,、，]/).forEach(c => {
              const cat = c.trim();
              if (cat && cat.length > 1) genres.push(cat);
            });
          }

          javxxMeta = { actresses, release_date: releaseDate, genres };
          console.log(`  ✅ นักแสดงหญิง: ${actresses.length ? actresses.join(", ") : "(ไม่พบ)"}`);
          if (releaseDate) console.log(`  ✅ วันที่วางจำหน่าย: ${releaseDate}`);
          if (genres.length) console.log(`  ✅ หมวดหมู่: ${genres.join(", ")}`);
        } catch (e) {
          console.log(`  ⚠️  javxx error: ${e.message}`);
        }
      }

      // Enrich and update (no JavDB needed — javxx has actresses)
      const enriched = enrichStation(station, javxxMeta, null);
      if (javxxMeta?.actresses?.length || javxxMeta?.release_date || javxxMeta?.genres?.length || enriched.badge) {
        index.stations[idx] = enriched;
        updated++;
        console.log(`  ✅ อัปเดต: "${enriched.name}"${enriched.badge ? ` [${enriched.badge}]` : ""}`);
      } else {
        // Still update name cleanup even without actresses
        index.stations[idx] = enriched;
        updated++;
        console.log(`  ✅ อัปเดต: "${enriched.name}" (ไม่พบ actresses)`);
      }

      // Rate limit: wait between requests
      if (i < targets.length - 1) await sleep(1500);
    } catch (e) {
      console.log(`  ❌ Error: ${e.message}`);
      failed++;
    }
  }

  writeIndex(index);
  console.log(`\n━━━ สรุป ━━━`);
  console.log(`  ✅ อัปเดต: ${updated}`);
  console.log(`  ⏭️  ข้าม: ${skipped}`);
  console.log(`  ❌ ล้มเหลว: ${failed}`);
  process.exit(0);
}

// ───── Main ─────
async function main() {
  // Handle --update-meta mode
  if (updateMeta) {
    await runUpdateMeta();
    return;
  }

  try {
    // Step 1: Parse the video page
    const { code, cover, dataUrls, appScript, html, actresses, release_date, genres } = await parseVideoPage(pageUrl);

    if (!code) {
      console.error("❌ ไม่พบข้อมูลวิดีโอ ตรวจสอบ URL อีกครั้ง");
      process.exit(1);
    }

    // Step 2: If stream URL provided directly, skip decrypt entirely
    const parts = [];

    if (streamUrlOverride) {
      console.log(`\n📺 ใช้ stream URL ที่ระบุ: ${streamUrlOverride}`);
      parts.push({ name: "Full", url: streamUrlOverride });
    } else {
      // Step 2b: Get decrypt function from app bundle
      let decryptFn = null;
      if (appScript) {
        decryptFn = await getDecryptFunction(appScript);
      }

      // Step 3: Decrypt data-urls → get embed URLs → resolve stream
      for (let i = 0; i < dataUrls.length; i++) {
        const { encrypted, label } = dataUrls[i];
        console.log(`\n🔐 Part ${i + 1} (${label}): ${encrypted.substring(0, 50)}...`);

        let embedUrl = null;

        if (decryptFn) {
          try {
            let result = decryptFn(encrypted);
            let decrypted = typeof result === "string" ? result : null;

            if (decrypted) {
              console.log(`  ✅ Decrypted: ${decrypted.substring(0, 120)}`);
              const embedMatch = decrypted.match(/https?:\/\/surrit\.store\/[^\s"']*/);
              if (embedMatch) {
                embedUrl = embedMatch[0];
              } else if (decrypted.startsWith("http")) {
                embedUrl = decrypted.split(/[\s"']/)[0];
              }
            }
          } catch (e) {
            console.log(`  ⚠️  decrypt error: ${e.message}`);
          }
        }

        if (embedUrl) {
          const streamUrl = await getStreamFromEmbed(embedUrl, debugMode);
          if (streamUrl) {
            parts.push({
              name: dataUrls.length > 1 ? `Part ${i + 1}` : "Full",
              url: streamUrl,
            });
          }
        } else {
          console.log(`  ❌ ไม่สามารถ decrypt ได้`);
        }

        if (i < dataUrls.length - 1) await sleep(500);
      }
    }

    // Fallback: Check for direct surrit reference in page HTML
    if (parts.length === 0) {
      console.log(`\n📺 Fallback: ค้นหา surrit ใน HTML...`);
      const surritMatch = html.match(/surrit\.store\/e\/([A-Za-z0-9_-]+)/);
      if (surritMatch) {
        const embedUrl = `https://surrit.store/e/${surritMatch[1]}`;
        const streamUrl = await getStreamFromEmbed(embedUrl);
        if (streamUrl) parts.push({ name: "Full", url: streamUrl });
      }

      // Also check for direct m3u8 or wowstream in page
      const directM3u8 = html.match(/https?:\/\/[^"'\s]*(?:wowstream\.cloud|surrit\.com)[^"'\s]*\.m3u8[^"'\s]*/i);
      if (directM3u8) parts.push({ name: "Full", url: directM3u8[0] });
    }

    if (parts.length === 0) {
      console.error("\n❌ ไม่สามารถหา stream URL ได้");
      console.error("   ลองเปิดหน้าเว็บใน browser แล้ว copy m3u8 URL จาก Network tab");
      console.error("   แล้วใช้ --stream-url=<m3u8_url>");
      console.error("   หรือ --debug เพื่อดู embed HTML / player JS");
      process.exit(1);
    }

    console.log(`\n✅ พบ ${parts.length} stream(s)`);
    parts.forEach((p, i) => console.log(`  [${i}] ${p.name}: ${p.url}`));

    // Step 4: Use metadata from javxx (actresses already parsed above)
    console.log(`\n📋 Metadata จาก javxx...`);
    if (actresses.length) console.log(`  นักแสดงหญิง: ${actresses.join(", ")}`);
    if (release_date) console.log(`  วันที่วางจำหน่าย: ${release_date}`);
    if (genres.length) console.log(`  หมวดหมู่: ${genres.join(", ")}`);
    const javxxMeta = { actresses, release_date, genres };

    // Step 5: Save to index.txt (flat stations format — ไม่แยกไฟล์)
    if (!fs.existsSync(PLAYLIST_DIR)) fs.mkdirSync(PLAYLIST_DIR, { recursive: true });

    // ใช้ stream แรก (ปกติมีแค่ 1 part)
    const streamUrl = parts[0].url;
    const hasMeta = actresses.length || release_date || genres.length;
    const extraMeta = hasMeta ? { javxx: javxxMeta, javdb: null } : null;

    updateIndex(code, cover, streamUrl, pageUrl, extraMeta);
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

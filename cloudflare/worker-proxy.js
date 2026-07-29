// Cloudflare Worker — HLS Proxy
// Deploy: https://dash.cloudflare.com
// Worker name: shy-haze-2452
// Live URL: https://shy-haze-2452.natajrak-p.workers.dev/
//
// Usage:
//   https://shy-haze-2452.natajrak-p.workers.dev/?url={encoded_url}&referer={encoded_referer}
//
// Example (kurokamii / akuma-player):
//   https://shy-haze-2452.natajrak-p.workers.dev/?url=https%3A%2F%2Ffiles.akuma-player.xyz%2Fview%2F{uuid}&referer=https%3A%2F%2Fakuma-player.xyz
//
// Features:
//   - CORS bypass (fetch server-side จาก CF edge)
//   - m3u8 URL rewrite: absolute / protocol-relative (//) / relative path (/) + URI="..." attrs
//     ยกเว้น DIRECT_HOSTS (CDN ที่เปิด CORS + ไฟล์ GB-scale) → ปล่อย URL ตรง ไม่ห่อ worker
//   - Binary passthrough สำหรับ TS segments
//   - รองรับ Referer + Origin header spoofing
//   - **Range simulation** (206 Partial Content) — fetch ก้อนเต็มแล้ว slice ส่งเฉพาะช่วง
//   - **CF edge cache** (cacheTtl=86400) ลด upstream fetch ซ้ำๆ
//   - **Streaming pass-through** สำหรับ binary GET ที่ไม่มี Range (first-byte ถึง client ทันที ไม่ต้องรอ buffer ทั้งก้อน)
//   - **Playlist pre-warm** — เมื่อ m3u8 ถูก fetch, fire-and-forget โหลด 40 segments แรกเข้า CF cache ล่วงหน้า
//   - **Resolver endpoints** /resolve/<name>?url= — รับ ep page URL คืน fresh signed stream URL
//     (สำหรับเว็บที่ stream URL หมดอายุเร็ว เช่น anifume — เก็บ ep URL ใน playlist แทน stream URL,
//      client เรียก resolver ก่อน play เพื่อได้ signature ใหม่ ต่อรอบ)

const PRE_WARM_SEGMENT_LIMIT = 40; // ภายใต้ subrequest limit ของ CF Workers Free tier (50/invocation)

// CDN hosts ที่เปิด CORS (ACAO: *) อยู่แล้ว และเสิร์ฟวิดีโอเป็นไฟล์เดียวทั้งเรื่องระดับ GB
// ผ่าน EXT-X-BYTERANGE (เช่น akuma-cdn ไฟล์ 4GB+) — ห้ามห่อผ่าน worker:
//   1. Range simulation ของ worker ต้อง buffer ก้อนเต็ม → ชน memory limit 128MB → 503
//   2. pre-warm จะพยายามโหลดไฟล์เต็มซ้ำๆ (URL เดิมทุกบรรทัดใน playlist แบบ BYTERANGE)
// ให้ browser ยิง Range ตรงไป CDN เอง (CORS ผ่านอยู่แล้ว) — key/manifest ยังผ่าน worker ตามเดิม
const DIRECT_HOSTS = /(^|\.)akuma-cdn\.xyz$/i;

/** JSON response helper สำหรับ resolver endpoints */
function jsonResponse(body, status = 200, cacheSec = 0) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Access-Control-Allow-Origin": "*",
      "Cache-Control": cacheSec > 0 ? `public, max-age=${cacheSec}` : "no-cache",
    },
  });
}

// ─── Resolvers: ep page URL → fresh signed stream URL ───
// คืน { stream: string } | { error: string }

// Retry on transient 403/429/5xx (CF Worker IPs ถูก rate-limit สุ่มที่ anifume + อื่นๆ)
const RESOLVER_RETRY_STATUSES = new Set([403, 408, 425, 429, 500, 502, 503, 504]);
const RESOLVER_MAX_ATTEMPTS = 4;
const RESOLVER_RETRY_DELAYS_MS = [200, 600, 1200]; // ก่อน attempt 2, 3, 4

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function fetchWithRetry(url, options, label = "request") {
  let lastErr;
  for (let attempt = 1; attempt <= RESOLVER_MAX_ATTEMPTS; attempt++) {
    try {
      const r = await fetch(url, options);
      if (r.ok) return r;
      if (!RESOLVER_RETRY_STATUSES.has(r.status)) {
        throw new Error(`${label} HTTP ${r.status}`);
      }
      lastErr = new Error(`${label} HTTP ${r.status}`);
    } catch (e) {
      lastErr = e;
    }
    if (attempt < RESOLVER_MAX_ATTEMPTS) {
      await sleep(RESOLVER_RETRY_DELAYS_MS[attempt - 1] || 1500);
    }
  }
  throw lastErr || new Error(`${label} failed after ${RESOLVER_MAX_ATTEMPTS} attempts`);
}

// Like fetchWithRetry but for proxy passthrough — returns the last Response (or
// a synthesized 502) instead of throwing, so 4xx/5xx still pass through to client.
async function fetchProxyWithRetry(url, options) {
  let lastResp = null;
  let lastErr  = null;
  for (let attempt = 1; attempt <= RESOLVER_MAX_ATTEMPTS; attempt++) {
    try {
      const r = await fetch(url, options);
      // Success or non-retryable status → return immediately (pass 404/416/etc through)
      if (r.ok || !RESOLVER_RETRY_STATUSES.has(r.status)) return r;
      lastResp = r;
    } catch (e) {
      lastErr = e;
    }
    if (attempt < RESOLVER_MAX_ATTEMPTS) {
      await sleep(RESOLVER_RETRY_DELAYS_MS[attempt - 1] || 1500);
    }
  }
  // All attempts exhausted — return last retryable response if any
  if (lastResp) return lastResp;
  return new Response(`Upstream fetch failed: ${lastErr?.message || "unknown"}`, {
    status: 502,
    headers: { "Access-Control-Allow-Origin": "*", "Content-Type": "text/plain" },
  });
}

// Sites backed by akuma-stream (kurokamii + anime-hdzero, as of Dec 2025) share this resolver.
//   - Old (akuma-player.xyz): cur.player_url = /play/{uuid} → stable files.akuma-player.xyz/view/{uuid}
//   - New (app.akuma-stream.com): cur.player_url = /watch/{uuid} → page has
//     /api/manifest/{uuid}/master.m3u8?token=... (HMAC-signed, expires)
// Flow: take the watch URL → fetch → extract signed m3u8 path → wrap in our CF proxy
// (so the browser doesn't deal with CORS / referer for akuma-stream).
async function resolveAkumaStream(playerUrl, { workerOrigin }) {
  const headers = {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120 Safari/537.36",
    "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    "Referer": "https://app.akuma-stream.com/",
  };
  const resp = await fetchWithRetry(playerUrl, { headers, redirect: "follow" }, "akuma-stream player");
  const html = await resp.text();
  const m = html.match(/src\s*=\s*["']?(\/api\/manifest\/[^"']+\.m3u8\?[^"'\s]+)/i);
  if (!m) throw new Error("ไม่พบ manifest URL ใน watch page");
  const origin = new URL(playerUrl).origin;
  const m3u8 = origin + m[1];
  const wrapped = `${workerOrigin}/?url=${encodeURIComponent(m3u8)}&referer=${encodeURIComponent(origin + "/")}`;
  return { stream: wrapped };
}

const RESOLVERS = {
  kurokamii: resolveAkumaStream,
  "anime-hdzero": resolveAkumaStream,
  // anifume sits behind Cloudflare and rejects "naked" Worker requests with 403 unless we
  // send a full browser-shaped header set (Sec-Fetch-*, sec-ch-ua-*, Accept-Language, etc.).
  async anifume(epUrl) {
    const epHeaders = {
      "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
      "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8",
      "Accept-Language": "th-TH,th;q=0.9,en-US;q=0.8,en;q=0.7",
      "Accept-Encoding": "gzip, deflate, br",
      "Referer": "https://anifume.com/",
      "sec-ch-ua": '"Chromium";v="131", "Not_A Brand";v="24"',
      "sec-ch-ua-mobile": "?0",
      "sec-ch-ua-platform": '"Windows"',
      "Sec-Fetch-Dest": "document",
      "Sec-Fetch-Mode": "navigate",
      "Sec-Fetch-Site": "same-origin",
      "Sec-Fetch-User": "?1",
      "Upgrade-Insecure-Requests": "1",
    };
    const epResp = await fetchWithRetry(epUrl, { headers: epHeaders, redirect: "follow" }, "ep page");
    const epHtml = await epResp.text();
    const iframeMatch = epHtml.match(/<iframe[^>]+src="(https?:\/\/[^"]*anifume\.com\/player[^"]*)"/i);
    if (!iframeMatch) throw new Error("ไม่พบ iframe player ใน ep page");
    const iframeUrl = iframeMatch[1];

    const playerResp = await fetchWithRetry(
      iframeUrl,
      { headers: { ...epHeaders, "Referer": epUrl }, redirect: "follow" },
      "iframe",
    );
    const playerHtml = await playerResp.text();
    const fileMatch = playerHtml.match(/"file"\s*:\s*"([^"]+)"/);
    if (!fileMatch) throw new Error('ไม่พบ "file" ใน iframe');
    return { stream: fileMatch[1].replace(/\\\//g, "/") };
  },
};

export default {
  async fetch(request, _env, ctx) {
    const url = new URL(request.url);
    const { searchParams } = url;

    if (request.method === "OPTIONS") {
      return new Response(null, {
        headers: {
          "Access-Control-Allow-Origin": "*",
          "Access-Control-Allow-Headers": "*",
          "Access-Control-Allow-Methods": "GET, HEAD, OPTIONS",
        },
      });
    }

    // ─── Resolver routes: /resolve/<name>?url=<ep_url> ───
    // ตัวอย่าง: /resolve/anifume?url=https%3A%2F%2Fanifume.com%2F29047%2FAccel-World-01
    const resolverMatch = url.pathname.match(/^\/resolve\/([a-z0-9-]+)$/i);
    if (resolverMatch) {
      const name = resolverMatch[1].toLowerCase();
      const epUrl = searchParams.get("url");
      const fn = RESOLVERS[name];
      if (!fn) return jsonResponse({ error: `unknown resolver: ${name}` }, 400);
      if (!epUrl) return jsonResponse({ error: "missing ?url=" }, 400);
      try {
        const workerOrigin = new URL(request.url).origin;
        const result = await fn(epUrl, { workerOrigin });
        return jsonResponse(result, 200, /*cacheSec=*/ 1800);
      } catch (e) {
        return jsonResponse({ error: String(e.message || e) }, 502);
      }
    }

    const targetUrl = searchParams.get("url");
    const referer   = searchParams.get("referer") || "";

    if (!targetUrl) {
      return new Response("Missing ?url=", { status: 400 });
    }

    const upstreamHeaders = {
      "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120 Safari/537.36",
      "Referer": referer,
      "Accept": "*/*",
    };
    if (referer) {
      try { upstreamHeaders["Origin"] = new URL(referer).origin; } catch (_) {}
    }

    // CF edge cache: ลด upstream fetch ซ้ำๆ ตอน AVPlayer ทำ Range scrubbing
    // Retry on transient 403/429/5xx — สำคัญสำหรับ CF-on-CF traffic ที่ถูก rate-limit สุ่ม
    // (เช่น akuma-stream / maimeorder ที่ดูว่า request มาจาก CF Worker → ตอบ 503)
    // ใช้ fetchProxyWithRetry → pass-through 4xx ที่ไม่ใช่ retryable ทันที, retry 5xx/429/403
    //
    // **HLS playlist (.m3u8/.txt) ไม่ cache** — เพราะ:
    //  1. ขนาดเล็ก (< 1KB) cache ไม่คุ้ม
    //  2. ถ้า upstream chunked response transient ส่งกลับ empty → CF cache ค้าง empty ทั้ง 24 ชม.
    //     ทำให้ตอนนั้นเล่นไม่ได้เลย (เคยเกิดกับ gg-player.xyz/cdn/hls/.../master.txt)
    // Segments (.ts/.m4s) ยัง cache ปกติเพราะใหญ่ + ไม่มีปัญหาเดิม
    const isHlsPlaylist = /\.(m3u8|txt)(\?|$)/i.test(targetUrl);
    const resp = await fetchProxyWithRetry(targetUrl, {
      headers: upstreamHeaders,
      redirect: "follow",
      cf: isHlsPlaylist ? {} : { cacheTtl: 86400, cacheEverything: true },
    });
    const contentType   = resp.headers.get("content-type") || "";
    const upstreamLen   = resp.headers.get("content-length");
    const workerOrigin  = new URL(request.url).origin;

    // ─── Peek first chunk to detect HLS without consuming full body ───
    // ใช้ tee เพื่อให้ branch หนึ่งอ่าน first chunk, อีก branch ยังเป็น stream เต็มให้ส่งต่อ
    const reader = resp.body.getReader();
    const { value: firstChunk, done: firstDone } = await reader.read();

    if (!firstChunk) {
      // Empty body (e.g. 204) — pass through
      return new Response(null, {
        status: resp.status,
        headers: {
          "Access-Control-Allow-Origin": "*",
          "Cache-Control": "no-cache",
        },
      });
    }

    const peek  = new TextDecoder().decode(firstChunk.slice(0, Math.min(16, firstChunk.length))).trimStart();
    const isHls = peek.startsWith("#EXTM3U") || peek.startsWith("#EXT-X-");
    // CDN บางแห่ง (เช่น cdn2.maimeorder.com) detect CF Worker IP แล้วห่อ m3u8
    // ใน JSON `{"p":"base64(m3u8)"}` เพื่อ break direct proxy. ต้อง unwrap ฝั่ง worker.
    const isJsonWrappedHls = peek.startsWith('{"p":"');

    const requestRange = request.headers.get("Range");
    const isHead       = request.method === "HEAD";
    // ต้องอ่านทั้งหมดถ้า: เป็น m3u8 (ต้อง rewrite), JSON wrapped (ต้อง decode), Range, หรือ HEAD
    const needFullBuffer = isHls || isJsonWrappedHls || requestRange != null || isHead;

    // ─── Path A: ต้อง buffer ทั้งก้อน (HLS / Range / HEAD) ───
    if (needFullBuffer) {
      const chunks = [firstChunk];
      let total    = firstChunk.length;
      if (!firstDone) {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          chunks.push(value);
          total += value.length;
        }
      }
      const merged = new Uint8Array(total);
      let off = 0;
      for (const c of chunks) { merged.set(c, off); off += c.length; }
      const buffer = merged.buffer;

      // ─── HLS playlist (incl. JSON-wrapped): rewrite URLs + pre-warm cache ───
      if (isHls || isJsonWrappedHls) {
        let body = new TextDecoder("utf-8").decode(buffer);

        // Unwrap JSON `{"p":"base64(m3u8)"}` (CDN anti-scrape protection)
        if (isJsonWrappedHls) {
          try {
            const wrapped = JSON.parse(body);
            if (!wrapped || typeof wrapped.p !== "string") throw new Error("missing wrapped.p");
            const decodedBytes = Uint8Array.from(atob(wrapped.p), (c) => c.charCodeAt(0));
            body = new TextDecoder("utf-8").decode(decodedBytes);
          } catch (e) {
            return new Response(`JSON unwrap failed: ${e.message}`, {
              status: 502,
              headers: { "Access-Control-Allow-Origin": "*" },
            });
          }
          if (!body.trimStart().startsWith("#EXTM3U")) {
            return new Response("unwrapped body is not m3u8", {
              status: 502,
              headers: { "Access-Control-Allow-Origin": "*" },
            });
          }
        }

        const targetParsed = new URL(targetUrl);
        const baseOrigin   = targetParsed.origin;
        const baseDir      = targetUrl.substring(0, targetUrl.lastIndexOf("/") + 1);

        const toAbs = (uri) => {
          if (/^https?:\/\//.test(uri))  return uri;
          if (uri.startsWith("//"))      return "https:" + uri;
          if (uri.startsWith("/"))       return baseOrigin + uri;
          return baseDir + uri;
        };
        const isDirectHost = (abs) => {
          try { return DIRECT_HOSTS.test(new URL(abs).hostname); } catch (_) { return false; }
        };
        const rewriteUri = (uri) => {
          const abs = toAbs(uri);
          if (isDirectHost(abs)) return abs;
          const enc = encodeURIComponent(abs);
          const ref = encodeURIComponent(referer);
          return `${workerOrigin}/?url=${enc}&referer=${ref}`;
        };

        // เก็บ absolute upstream URLs สำหรับ pre-warm (ยกเว้น direct hosts)
        const upstreamUrls = [];
        const collectForWarm = (abs) => {
          if (!isDirectHost(abs)) upstreamUrls.push(abs);
        };

        body = body.split("\n").map(line => {
          const t = line.trim();
          if (!t) return line;
          // Comment-tag lines ที่อาจมี URI="..." (EXT-X-MAP/KEY/MEDIA/I-FRAME-STREAM-INF/SESSION-DATA/SESSION-KEY/PART)
          if (t.startsWith("#")) {
            if (/URI="[^"]+"/.test(t)) {
              return line.replace(/URI="([^"]+)"/g, (_, uri) => {
                collectForWarm(toAbs(uri));
                return `URI="${rewriteUri(uri)}"`;
              });
            }
            return line;
          }
          // Plain URI line (segment or sub-playlist)
          collectForWarm(toAbs(t));
          return rewriteUri(t);
        }).join("\n");

        // Pre-warm: fire-and-forget โหลด segments แรกเข้า CF cache
        // ใช้ ctx.waitUntil เพื่อให้ background tasks ทำงานต่อหลัง response ถูกส่งไปแล้ว
        if (ctx && typeof ctx.waitUntil === "function" && upstreamUrls.length > 0) {
          const toWarm = upstreamUrls.slice(0, PRE_WARM_SEGMENT_LIMIT);
          ctx.waitUntil(Promise.all(
            toWarm.map(u =>
              fetch(u, {
                headers: upstreamHeaders,
                redirect: "follow",
                cf: { cacheTtl: 86400, cacheEverything: true },
              })
                .then(r => r.arrayBuffer())  // consume body to ensure CF caches it
                .catch(() => {})              // ignore individual failures
            )
          ));
        }

        return new Response(body, {
          status: 200,
          headers: {
            "Content-Type": "application/vnd.apple.mpegurl",
            "Access-Control-Allow-Origin": "*",
            "Cache-Control": "no-cache",
          },
        });
      }

      // ─── Binary: HEAD or Range ───
      const totalLength = buffer.byteLength;
      const bytes       = new Uint8Array(buffer);
      const resolvedType = detectMediaType(bytes, contentType);
      const respHeaders = {
        "Content-Type": resolvedType,
        "Access-Control-Allow-Origin": "*",
        "Accept-Ranges": "bytes",
        "Cache-Control": "public, max-age=86400",
      };

      if (isHead) {
        respHeaders["Content-Length"] = String(totalLength);
        return new Response(null, { status: 200, headers: respHeaders });
      }

      // GET with Range: slice
      const m = /^bytes=(\d*)-(\d*)$/.exec(requestRange.trim());
      if (m) {
        const start = m[1] === "" ? 0 : parseInt(m[1], 10);
        const end   = m[2] === "" ? totalLength - 1 : Math.min(parseInt(m[2], 10), totalLength - 1);
        if (Number.isFinite(start) && Number.isFinite(end) && start <= end && start < totalLength) {
          const slice = buffer.slice(start, end + 1);
          respHeaders["Content-Range"]  = `bytes ${start}-${end}/${totalLength}`;
          respHeaders["Content-Length"] = String(slice.byteLength);
          return new Response(slice, { status: 206, headers: respHeaders });
        }
        respHeaders["Content-Range"] = `bytes */${totalLength}`;
        return new Response(null, { status: 416, headers: respHeaders });
      }
      // Range header รูปแบบไม่ตรง spec → fall through ส่งก้อนเต็ม
      respHeaders["Content-Length"] = String(totalLength);
      return new Response(buffer, { status: 200, headers: respHeaders });
    }

    // ─── Path B: Streaming pass-through (Binary GET, ไม่มี Range) ───
    // First-byte ถึง client ทันทีโดยไม่ต้องรอ buffer ทั้งก้อน
    const resolvedType = detectMediaType(firstChunk, contentType);
    const streamHeaders = {
      "Content-Type": resolvedType,
      "Access-Control-Allow-Origin": "*",
      "Accept-Ranges": "bytes",
      "Cache-Control": "public, max-age=86400",
    };
    if (upstreamLen) streamHeaders["Content-Length"] = upstreamLen;

    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(firstChunk);
        if (firstDone) controller.close();
      },
      async pull(controller) {
        try {
          const { done, value } = await reader.read();
          if (done) controller.close();
          else      controller.enqueue(value);
        } catch (err) {
          controller.error(err);
        }
      },
      cancel(reason) {
        try { reader.cancel(reason); } catch (_) {}
      },
    });

    return new Response(stream, {
      status: 200,
      headers: streamHeaders,
    });
  },
};

// Detect TS/media segments disguised with fake extensions (.jpg, .html, .png, etc.)
// TS sync byte = 0x47 (G), repeats every 188 bytes
// fMP4 starts with ftyp/moof/moov box
function detectMediaType(bytes, fallbackContentType) {
  if (bytes && bytes.length > 188 && bytes[0] === 0x47 && bytes[188] === 0x47) {
    return "video/mp2t";
  }
  if (bytes && bytes.length > 8) {
    const boxType = new TextDecoder().decode(bytes.slice(4, 8));
    if (boxType === "ftyp" || boxType === "moof" || boxType === "moov") {
      return "video/mp4";
    }
  }
  return fallbackContentType || "application/octet-stream";
}

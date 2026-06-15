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

const RESOLVERS = {
  async anifume(epUrl) {
    const epHeaders = {
      "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120 Safari/537.36",
      "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      "Referer": "https://anifume.com/",
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
        const result = await fn(epUrl);
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
    const resp = await fetch(targetUrl, {
      headers: upstreamHeaders,
      redirect: "follow",
      cf: { cacheTtl: 86400, cacheEverything: true },
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

    const requestRange = request.headers.get("Range");
    const isHead       = request.method === "HEAD";
    // ต้องอ่านทั้งหมดถ้า: เป็น m3u8 (ต้อง rewrite), เป็น Range request (ต้อง slice), หรือเป็น HEAD (ต้องรู้ size)
    const needFullBuffer = isHls || requestRange != null || isHead;

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

      // ─── HLS playlist: rewrite URLs + pre-warm cache ───
      if (isHls) {
        let body = new TextDecoder("utf-8").decode(buffer);
        const targetParsed = new URL(targetUrl);
        const baseOrigin   = targetParsed.origin;
        const baseDir      = targetUrl.substring(0, targetUrl.lastIndexOf("/") + 1);

        const toAbs = (uri) => {
          if (/^https?:\/\//.test(uri))  return uri;
          if (uri.startsWith("//"))      return "https:" + uri;
          if (uri.startsWith("/"))       return baseOrigin + uri;
          return baseDir + uri;
        };
        const rewriteUri = (uri) => {
          const abs = toAbs(uri);
          const enc = encodeURIComponent(abs);
          const ref = encodeURIComponent(referer);
          return `${workerOrigin}/?url=${enc}&referer=${ref}`;
        };

        // เก็บ absolute upstream URLs สำหรับ pre-warm
        const upstreamUrls = [];

        body = body.split("\n").map(line => {
          const t = line.trim();
          if (!t) return line;
          // Comment-tag lines ที่อาจมี URI="..." (EXT-X-MAP/KEY/MEDIA/I-FRAME-STREAM-INF/SESSION-DATA/SESSION-KEY/PART)
          if (t.startsWith("#")) {
            if (/URI="[^"]+"/.test(t)) {
              return line.replace(/URI="([^"]+)"/g, (_, uri) => {
                upstreamUrls.push(toAbs(uri));
                return `URI="${rewriteUri(uri)}"`;
              });
            }
            return line;
          }
          // Plain URI line (segment or sub-playlist)
          upstreamUrls.push(toAbs(t));
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

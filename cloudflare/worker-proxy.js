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
//   - m3u8 URL rewrite: absolute / protocol-relative (//) / relative path (/)
//   - Binary passthrough สำหรับ TS segments
//   - รองรับ Referer + Origin header spoofing
//   - Retry on transient 403/429/5xx (เช่น CDN rate-limit ที่ตอบสุ่ม)
//   - Edge cache สำหรับ 2xx responses (ลด hammer CDN)

const MAX_RETRIES   = 3;          // รวม initial → ยิงสูงสุด 3 ครั้ง
const RETRY_DELAYS  = [120, 350]; // ms ระหว่าง retry
const RETRYABLE     = new Set([403, 408, 425, 429, 500, 502, 503, 504]);
const CACHE_TTL     = 300;        // วินาที — cache 2xx ที่ edge

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function fetchWithRetry(targetUrl, headers) {
  let last;
  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    try {
      const r = await fetch(targetUrl, { headers, redirect: "follow" });
      if (!RETRYABLE.has(r.status)) return r;
      last = r;
    } catch (e) {
      last = e;
    }
    if (attempt < MAX_RETRIES - 1) {
      await sleep(RETRY_DELAYS[attempt] || 500);
    }
  }
  if (last instanceof Response) return last;
  throw last;
}

export default {
  async fetch(request) {
    const { searchParams } = new URL(request.url);
    const targetUrl = searchParams.get("url");
    const referer   = searchParams.get("referer") || "";

    if (!targetUrl) {
      return new Response("Missing ?url=", { status: 400 });
    }

    if (request.method === "OPTIONS") {
      return new Response(null, {
        headers: {
          "Access-Control-Allow-Origin": "*",
          "Access-Control-Allow-Headers": "*",
        },
      });
    }

    // Edge cache lookup
    const cache    = caches.default;
    const cacheKey = new Request(request.url, { method: "GET" });
    const cached   = await cache.match(cacheKey);
    if (cached) return cached;

    const headers = {
      "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120 Safari/537.36",
      "Referer": referer,
      "Accept": "*/*",
    };
    if (referer) {
      try { headers["Origin"] = new URL(referer).origin; } catch (_) {}
    }

    const resp = await fetchWithRetry(targetUrl, headers);
    const contentType = resp.headers.get("content-type") || "";

    const buffer = await resp.arrayBuffer();
    const bytes  = new Uint8Array(buffer);

    const peek  = new TextDecoder().decode(bytes.slice(0, 16)).trimStart();
    const isHls = peek.startsWith("#EXTM3U") || peek.startsWith("#EXT-X-");

    const workerOrigin = new URL(request.url).origin;

    if (isHls) {
      let body = new TextDecoder("utf-8").decode(buffer);
      const targetParsed = new URL(targetUrl);
      const baseOrigin   = targetParsed.origin;
      const baseDir      = targetUrl.substring(0, targetUrl.lastIndexOf("/") + 1);

      body = body.split("\n").map(line => {
        const t = line.trim();
        if (!t || t.startsWith("#")) return line;

        let abs;
        if (/^https?:\/\//.test(t))  abs = t;
        else if (t.startsWith("//")) abs = "https:" + t;
        else if (t.startsWith("/"))  abs = baseOrigin + t;
        else                         abs = baseDir + t;

        const enc = encodeURIComponent(abs);
        const ref = encodeURIComponent(referer);
        return `${workerOrigin}/?url=${enc}&referer=${ref}`;
      }).join("\n");

      const out = new Response(body, {
        headers: {
          "Content-Type": "application/vnd.apple.mpegurl",
          "Access-Control-Allow-Origin": "*",
          "Cache-Control": `public, max-age=${CACHE_TTL}`,
        },
      });
      if (resp.ok) await cache.put(cacheKey, out.clone());
      return out;
    }

    // Detect TS/media segments disguised with fake extensions (.jpg, .html, .png, etc.)
    // TS sync byte = 0x47 (G), repeats every 188 bytes
    // fMP4 starts with ftyp or moof box
    let resolvedType = contentType || "application/octet-stream";
    if (bytes.length > 188) {
      if (bytes[0] === 0x47 && bytes[188] === 0x47) {
        // MPEG-TS stream
        resolvedType = "video/mp2t";
      } else if (bytes.length > 8) {
        const boxType = new TextDecoder().decode(bytes.slice(4, 8));
        if (boxType === "ftyp" || boxType === "moof" || boxType === "moov") {
          resolvedType = "video/mp4";
        }
      }
    }

    const out = new Response(buffer, {
      status: resp.status,
      headers: {
        "Content-Type": resolvedType,
        "Access-Control-Allow-Origin": "*",
        "Cache-Control": resp.ok ? `public, max-age=${CACHE_TTL * 12}` : "no-cache",
      },
    });
    if (resp.ok) await cache.put(cacheKey, out.clone());
    return out;
  },
};


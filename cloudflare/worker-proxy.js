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

const PRE_WARM_SEGMENT_LIMIT = 40; // ภายใต้ subrequest limit ของ CF Workers Free tier (50/invocation)

export default {
  async fetch(request, _env, ctx) {
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
          "Access-Control-Allow-Methods": "GET, HEAD, OPTIONS",
        },
      });
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

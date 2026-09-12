export const config = { runtime: "edge" };

const BROWSER_UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

export default async function handler(request) {
  const url = new URL(request.url);

  if (request.method === "OPTIONS") {
    return new Response(null, {
      headers: {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "GET,HEAD,OPTIONS",
        "Access-Control-Allow-Headers": "*",
        "Access-Control-Max-Age": "86400",
      },
    });
  }

  const target = url.searchParams.get("url");
  const referer = url.searchParams.get("referer") || "";
  if (!target) {
    return new Response(
      "BKL Play HLS proxy — GET /api/hls-proxy?url=<encoded_target>&referer=<encoded_referer>",
      { status: 400, headers: { "Content-Type": "text/plain" } },
    );
  }

  const looksLikeM3u8 = /\.(m3u8|txt)(\?|$)/i.test(target);

  const headers = {
    "User-Agent": BROWSER_UA,
    Accept: "*/*",
    "Accept-Encoding": "identity",
  };
  if (referer) headers["Referer"] = referer;

  const clientRange = request.headers.get("range");
  if (clientRange && !looksLikeM3u8) headers["Range"] = clientRange;

  let upstream;
  try {
    upstream = await fetch(target, { headers, redirect: "follow" });
  } catch (e) {
    return new Response(`Proxy fetch error: ${e.message}`, { status: 502 });
  }

  const contentType = upstream.headers.get("content-type") || "";
  const reader = upstream.body ? upstream.body.getReader() : null;
  let first;
  try {
    first = await readHead(reader, 32);
  } catch (e) {
    return new Response(`Proxy read error: ${e.message}`, {
      status: 502,
      headers: { "Access-Control-Allow-Origin": "*" },
    });
  }
  const firstChunk = first.value;
  const peek = new TextDecoder()
    .decode(firstChunk.subarray(0, 32))
    .replace(/^\uFEFF/, "")
    .trimStart();
  const isM3u8 = peek.startsWith("#EXTM3U");

  if (isM3u8) {
    const body = await readAllText(reader, firstChunk, first.done);
    const proxyBase = url.origin + url.pathname;
    const baseUrl = new URL(target);

    const rewritten = body.split("\n").map((line) => {
      const trimmed = line.trim();
      if (!trimmed) return line;

      if (trimmed.startsWith("#")) {
        return line.replace(/URI="([^"]+)"/g, (_m, u) => {
          try {
            const abs = new URL(u, baseUrl).toString();
            return `URI="${proxyBase}?url=${encodeURIComponent(abs)}&referer=${encodeURIComponent(referer)}"`;
          } catch {
            return _m;
          }
        });
      }

      try {
        const abs = new URL(trimmed, baseUrl).toString();
        return `${proxyBase}?url=${encodeURIComponent(abs)}&referer=${encodeURIComponent(referer)}`;
      } catch {
        return line;
      }
    }).join("\n");

    return new Response(rewritten, {
      status: upstream.status,
      headers: {
        "Content-Type": contentType || "application/vnd.apple.mpegurl",
        "Access-Control-Allow-Origin": "*",
        "Cache-Control": "no-store",
      },
    });
  }

  const outHeaders = new Headers();
  for (const [k, v] of upstream.headers) {
    if (/^(access-control-|content-encoding|transfer-encoding|connection)/i.test(k)) continue;
    outHeaders.set(k, v);
  }
  if (upstream.headers.get("content-encoding")) outHeaders.delete("content-length");
  outHeaders.set("Access-Control-Allow-Origin", "*");
  outHeaders.set("Access-Control-Allow-Headers", "*");
  outHeaders.set(
    "Access-Control-Expose-Headers",
    "Content-Length, Content-Range, Accept-Ranges",
  );

  return new Response(prependChunk(reader, firstChunk, first.done), {
    status: upstream.status,
    statusText: upstream.statusText,
    headers: outHeaders,
  });
}

/**
 * อ่าน chunk ต้นๆ สะสมจนได้อย่างน้อย minBytes (หรือจบ body) เพื่อ peek หา #EXTM3U
 * โดยไม่ต้อง buffer ทั้งไฟล์ — segment วิดีโอยังส่งต่อแบบ streaming ได้
 */
async function readHead(reader, minBytes) {
  const parts = [];
  let size = 0;
  let done = !reader;
  while (!done && size < minBytes) {
    const r = await reader.read();
    done = r.done;
    if (r.value?.length) {
      parts.push(r.value);
      size += r.value.length;
    }
  }
  if (parts.length === 1) return { value: parts[0], done };
  const value = new Uint8Array(size);
  let offset = 0;
  for (const part of parts) {
    value.set(part, offset);
    offset += part.length;
  }
  return { value, done };
}

/**
 * อ่าน body ที่เหลือต่อจาก chunk แรกที่ peek ไปแล้ว แล้ว decode เป็นข้อความทั้งก้อน
 */
async function readAllText(reader, firstChunk, done) {
  const decoder = new TextDecoder();
  let text = decoder.decode(firstChunk, { stream: true });
  while (!done) {
    const r = await reader.read();
    done = r.done;
    if (r.value) text += decoder.decode(r.value, { stream: true });
  }
  return text + decoder.decode();
}

/**
 * สร้าง stream ใหม่ที่ส่ง chunk แรก (ที่ถูก peek ไป) ก่อน แล้วต่อด้วย body ที่เหลือแบบ streaming
 */
function prependChunk(reader, firstChunk, done) {
  if (!reader) return null;
  let sentFirst = false;
  return new ReadableStream({
    async pull(controller) {
      if (!sentFirst) {
        sentFirst = true;
        if (firstChunk.length) controller.enqueue(firstChunk);
        if (done) controller.close();
        return;
      }
      const r = await reader.read();
      if (r.done) controller.close();
      else controller.enqueue(r.value);
    },
    cancel(reason) {
      return reader.cancel(reason);
    },
  });
}

/**
 * Deno Deploy HLS proxy — non-CF alternative
 *
 * ทำไมต้องมีอีกตัว?
 *   Worker `shy-haze-2452` (CF) โดน CF WAF block เวลา proxy ไปยัง target ที่ hosted บน CF
 *   เช่น cold-winter-118.space (javplayer.cc backend) → CF-on-CF anti-abuse block
 *   Deno Deploy อยู่คนละ network → ไม่ trigger block
 *
 * วิธี deploy:
 *   1. เข้า https://dash.deno.com/new
 *   2. เลือก "Deploy from a Playground" (หรือ "New Project" → Playground)
 *   3. copy code ทั้งไฟล์นี้ paste ลง editor
 *   4. Save & Deploy
 *   5. copy URL ที่ deploy (เช่น https://iptv-proxy-xxx.deno.dev/)
 *
 * Query params (เหมือน worker-proxy.js):
 *   ?url=<encoded_target>&referer=<encoded_referer>
 *
 * รองรับ:
 *   - HLS m3u8 rewrite (URLs ใน playlist ถูกห่อกลับ proxy ทุก layer)
 *   - Passthrough สำหรับ .ts segments / .jpg / etc.
 */

const BROWSER_UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

Deno.serve(async (req: Request) => {
  const url = new URL(req.url);

  if (req.method === "OPTIONS") {
    return new Response(null, {
      headers: {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "GET,HEAD,OPTIONS",
        "Access-Control-Allow-Headers": "*",
        "Access-Control-Max-Age": "86400",
      },
    });
  }

  if (url.pathname === "/" && !url.searchParams.get("url")) {
    return new Response(
      "Deno HLS proxy — GET /?url=<encoded_target>&referer=<encoded_referer>",
      { status: 200, headers: { "Content-Type": "text/plain" } },
    );
  }

  const target = url.searchParams.get("url");
  const referer = url.searchParams.get("referer") || "";
  if (!target) return new Response("Missing ?url=", { status: 400 });

  const headers: Record<string, string> = {
    "User-Agent": BROWSER_UA,
    Accept: "*/*",
  };
  if (referer) headers["Referer"] = referer;

  let upstream: Response;
  try {
    upstream = await fetch(target, { headers, redirect: "follow" });
  } catch (e) {
    return new Response(`Proxy fetch error: ${(e as Error).message}`, { status: 502 });
  }

  const contentType = upstream.headers.get("content-type") || "";
  const isM3u8 =
    /\.(m3u8|txt)(\?|$)/i.test(target) ||
    contentType.includes("mpegurl") ||
    contentType.includes("x-mpegURL");

  if (isM3u8) {
    const body = await upstream.text();
    const proxyBase = `${url.origin}/`;
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
    if (/^(access-control-|content-encoding|content-length|transfer-encoding|connection)/i.test(k)) continue;
    outHeaders.set(k, v);
  }
  outHeaders.set("Access-Control-Allow-Origin", "*");
  outHeaders.set("Access-Control-Allow-Headers", "*");

  return new Response(upstream.body, {
    status: upstream.status,
    headers: outHeaders,
  });
});

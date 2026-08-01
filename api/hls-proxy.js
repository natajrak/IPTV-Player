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
  const isM3u8 =
    /\.(m3u8|txt)(\?|$)/i.test(target) ||
    contentType.includes("mpegurl") ||
    contentType.includes("x-mpegURL");

  if (isM3u8) {
    const body = await upstream.text();
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

  return new Response(upstream.body, {
    status: upstream.status,
    statusText: upstream.statusText,
    headers: outHeaders,
  });
}

const CACHE_NAME = "bkl-play-v47";
const PLAYLIST_CACHE = "bkl-playlists-v1";
const APP_SHELL = [
  "./",
  "./index.html",
  "./css/style.css",
  "./js/app.tv.js",
  "./js/hls.min.js",
  "./images/logo/logo.png",
  "./images/logo/logo-dark.png",
  "./images/apple-touch-icon.png",
  "./images/favicon-16x16.png",
  "./images/favicon-32x32.png",
  "./images/android-chrome-192x192.png",
  "./images/android-chrome-512x512.png",
  "./images/covers/cover-anime.png",
  "./images/covers/cover-anime-series.png",
  "./images/covers/cover-anime-movie.png",
  "./images/covers/cover-movie.png",
  "./images/covers/cover-series.png",
  "../playlist/main.txt",
];

// Cross-origin hosts ที่จะ cache แบบ stale-while-revalidate — ลด GitHub Raw 429
const PLAYLIST_HOSTS = new Set(["raw.githubusercontent.com"]);
const PLAYLIST_MAX_AGE_MS = 3600 * 1000; // 1 ชม. → หลังหมดอายุจะ revalidate

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(APP_SHELL)).then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(
        keys
          .filter((key) => key !== CACHE_NAME && key !== PLAYLIST_CACHE)
          .map((key) => caches.delete(key))
      )
    ).then(() => self.clients.claim())
  );
});

// Stale-while-revalidate: return cached (แม้ expired) + background refresh
// - Cache hit fresh (< PLAYLIST_MAX_AGE_MS) → return cache, ไม่ยิง network
// - Cache hit expired → return cache ทันที + background revalidate
// - Cache miss → fetch + cache
async function playlistSWR(req) {
  const cache = await caches.open(PLAYLIST_CACHE);
  const cached = await cache.match(req);
  const now = Date.now();

  const revalidate = () =>
    fetch(req)
      .then((res) => {
        if (res && res.status === 200) {
          const clone = res.clone();
          // เก็บ timestamp ลง header เพื่อเช็คอายุคราวหน้า
          const headers = new Headers(clone.headers);
          headers.set("x-swr-cached-at", String(now));
          clone.blob().then((body) => {
            cache.put(req, new Response(body, {
              status: clone.status,
              statusText: clone.statusText,
              headers,
            }));
          });
        }
        return res;
      })
      .catch(() => null);

  if (cached) {
    const cachedAt = parseInt(cached.headers.get("x-swr-cached-at") || "0", 10);
    const isFresh = now - cachedAt < PLAYLIST_MAX_AGE_MS;
    if (!isFresh) revalidate(); // fire-and-forget
    return cached;
  }

  // Cache miss → fetch (ถ้าล้มเหลว ให้ propagate error ไปที่ client)
  const res = await revalidate();
  if (res) return res;
  return new Response("Offline & no cache", { status: 503 });
}

self.addEventListener("fetch", (event) => {
  const req = event.request;
  const url = new URL(req.url);

  if (req.method !== "GET") return;

  // Cross-origin: cache เฉพาะ playlist hosts ที่ระบุ (GitHub Raw)
  if (url.origin !== self.location.origin) {
    if (PLAYLIST_HOSTS.has(url.hostname)) {
      event.respondWith(playlistSWR(req));
    }
    return;
  }

  if (req.mode === "navigate") {
    event.respondWith(
      fetch(req)
        .then((res) => {
          const resClone = res.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put("./index.html", resClone));
          return res;
        })
        .catch(() => caches.match("./index.html"))
    );
    return;
  }

  // Network-first for app shell assets so GitHub Pages updates are picked up quickly.
  if (url.pathname.endsWith("/index.html") || url.pathname.endsWith("/js/app.tv.js") || url.pathname.endsWith("/css/style.css")) {
    event.respondWith(
      fetch(req)
        .then((res) => {
          if (res && res.status === 200) {
            const clone = res.clone();
            caches.open(CACHE_NAME).then((cache) => cache.put(req, clone));
          }
          return res;
        })
        .catch(() => caches.match(req))
    );
    return;
  }

  event.respondWith(
    caches.match(req).then((cached) => {
      if (cached) return cached;
      return fetch(req).then((res) => {
        if (!res || res.status !== 200 || res.type !== "basic") return res;
        const resClone = res.clone();
        caches.open(CACHE_NAME).then((cache) => cache.put(req, resClone));
        return res;
      });
    })
  );
});

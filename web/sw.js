const CACHE_NAME = "bkl-play-v76";
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

/** Cross-origin hosts ที่ cache playlist แบบ network-first (GitHub Raw) */
const PLAYLIST_HOSTS = new Set(["raw.githubusercontent.com"]);
const PLAYLIST_NETWORK_TIMEOUT_MS = 8000;

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

/**
 * Network-first: ดึงใหม่ทุกครั้ง (no-cache → revalidate HTTP cache ด้วย ETag) แล้วเก็บทับ cache
 * ล้มเหลว / ไม่ใช่ 2xx (เช่น 429) / เกิน timeout → ใช้ cache เดิม; ไม่มี cache → รอผล network
 */
async function playlistNetworkFirst(req) {
  const cache = await caches.open(PLAYLIST_CACHE);
  const network = fetch(req, { cache: "no-cache" })
    .then((res) => {
      if (res.status === 200) cache.put(req, res.clone()).catch(() => {});
      return res;
    })
    .catch(() => null);
  const cached = await cache.match(req);
  if (!cached) return (await network) || new Response("Offline & no cache", { status: 503 });

  let timer;
  const timeout = new Promise((resolve) => {
    timer = setTimeout(resolve, PLAYLIST_NETWORK_TIMEOUT_MS, null);
  });
  const res = await Promise.race([network, timeout]);
  clearTimeout(timer);
  return res && res.ok ? res : cached;
}

self.addEventListener("fetch", (event) => {
  const req = event.request;
  const url = new URL(req.url);

  if (req.method !== "GET") return;

  // Cross-origin: cache เฉพาะ playlist hosts ที่ระบุ (GitHub Raw)
  if (url.origin !== self.location.origin) {
    if (PLAYLIST_HOSTS.has(url.hostname)) {
      event.respondWith(playlistNetworkFirst(req));
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

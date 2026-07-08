/* scripts/movie-lookup/public/sw.js
 * TBSI Movie Lookup — app-shell service worker.
 *
 * Caches the app shell (the .html pages + manifest + icons) for instant/offline
 * load. It deliberately does NOT cache /api/* — live search/detail needs the
 * network, and stale API data would be misleading.
 *
 * PUSHING UPDATES ON A NEW DEPLOY:
 *   Bump CACHE_VERSION below (v1 -> v2 -> ...). On the user's next visit the
 *   browser fetches this file (served no-cache), sees it changed, installs the
 *   new worker which precaches the new shell and calls skipWaiting(); on
 *   activate we delete every old cache and call clients.claim(). Result: the new
 *   shell takes over immediately — no stuck old cache. Navigations are also
 *   network-first, so even without a version bump a fresh deploy's HTML shows as
 *   soon as the device is online (cache is the offline fallback only).
 */
const CACHE_VERSION = "v9";
const CACHE = "tbsi-lookup-" + CACHE_VERSION;
const SHELL = [
  "/",
  "/index.html",
  "/movie.html",
  "/person.html",
  "/compare.html",
  "/watchlist.html",
  "/releases.html",
  "/manifest.webmanifest",
  "/icon-192.png",
  "/icon-512.png",
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

function putInCache(req, res) {
  if (res && res.ok) {
    caches.open(CACHE).then((c) => c.put(req, res)).catch(() => {});
  }
}

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;

  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return; // image CDNs etc. -> straight to network
  if (url.pathname.startsWith("/api/")) return;    // live data -> never cache
  if (url.pathname === "/healthz") return;

  // Navigations: network-first (fresh deploy shows immediately), cache fallback offline.
  if (req.mode === "navigate") {
    event.respondWith(
      fetch(req)
        .then((res) => {
          putInCache(req, res.clone());
          return res;
        })
        .catch(() => caches.match(req).then((m) => m || caches.match("/")))
    );
    return;
  }

  // Shell assets (manifest, icons): stale-while-revalidate.
  event.respondWith(
    caches.match(req).then((cached) => {
      const network = fetch(req)
        .then((res) => {
          putInCache(req, res.clone());
          return res;
        })
        .catch(() => cached);
      return cached || network;
    })
  );
});

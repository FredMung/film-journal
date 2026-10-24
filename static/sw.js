// Film Journal service worker: keeps the app openable with no signal.
// Data never goes through here — the page queues writes in IndexedDB itself.

const SHELL = "fj-shell-v1";
const PHOTOS = "fj-photos-v1";
const SHELL_URLS = ["/", "/static/app.js", "/static/app.css", "/manifest.webmanifest",
                    "/static/icon-180.png", "/static/icon-512.png"];
const NETWORK_TIMEOUT_MS = 3000;

self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(SHELL).then((c) => c.addAll(SHELL_URLS)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", (event) => {
  event.waitUntil((async () => {
    for (const key of await caches.keys()) if (![SHELL, PHOTOS].includes(key)) await caches.delete(key);
    await self.clients.claim();
  })());
});

/** Try the Pi first so updates arrive; fall back to the cached copy if it's slow or unreachable. */
async function networkFirst(request, cacheKey) {
  const cache = await caches.open(SHELL);
  const network = fetch(request).then((res) => {
    if (res.ok) cache.put(cacheKey, res.clone());
    return res;
  });
  const timeout = new Promise((resolve) => setTimeout(resolve, NETWORK_TIMEOUT_MS));
  try {
    const res = await Promise.race([network, timeout]);
    if (res) return res;
  } catch { /* offline */ }
  const cached = await cache.match(cacheKey);
  return cached || network;   // nothing cached yet: wait for the network after all
}

/** Snapshot files never change (new photo = new filename), so cache-first. */
async function cacheFirst(request) {
  const cache = await caches.open(PHOTOS);
  const cached = await cache.match(request);
  if (cached) return cached;
  const res = await fetch(request);
  if (res.ok) cache.put(request, res.clone());
  return res;
}

self.addEventListener("fetch", (event) => {
  const req = event.request;
  const url = new URL(req.url);
  if (req.method !== "GET" || url.origin !== location.origin) return;
  if (url.pathname.startsWith("/api/")) return;
  if (url.pathname.startsWith("/photos/")) return event.respondWith(cacheFirst(req));
  if (req.mode === "navigate") return event.respondWith(networkFirst(req, "/"));
  // Static files are requested with ?v=N; cache them under their bare path.
  const bare = url.pathname;
  if (SHELL_URLS.includes(bare)) event.respondWith(networkFirst(req, bare));
});

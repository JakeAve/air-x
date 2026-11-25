// Precaches the whole app so it opens with no network. build.ts stamps the
// cache name with a hash of dist/, so any change ships a new cache and the old
// one is dropped on activate. Only caches named PREFIX are ours: airgap shares
// this origin.
const PREFIX = "air-x-";
const CACHE = `${PREFIX}__VERSION__`;
const ASSETS = [
  "./",
  "./diag.js",
  "./codec-worker.js",
  "./capture-worklet.js",
  "./styles.css",
  "./fonts/open-sans.woff2",
  "./favicon.svg",
  "./manifest.webmanifest",
  // Renamed with each libcimbar update; build.ts fails on a missing one.
  "./cimbar/cimbar_js.2026-11-18T0531.js",
  "./cimbar/cimbar_js.2026-11-18T0531.wasm",
  "./cimbar/recv-worker.2026-11-18T0531.js",
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    // no-cache: Pages lets the HTTP cache keep a file 10 minutes, which would
    // put a stale one in a new cache.
    caches.open(CACHE).then((cache) =>
      cache.addAll(ASSETS.map((url) => new Request(url, { cache: "no-cache" })))
    ),
  );
});

// A new build waits until the page says no transfer is running: taking over
// earlier would hand an old page new workers it loads later.
self.addEventListener("message", (event) => {
  if (event.data === "skip-waiting") self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(
        keys.filter((key) => key.startsWith(PREFIX) && key !== CACHE).map((
          key,
        ) => caches.delete(key)),
      )
    ).then(() => self.clients.claim()),
  );
});

self.addEventListener("fetch", (event) => {
  if (event.request.method !== "GET") return;
  event.respondWith(
    caches.match(event.request, { ignoreSearch: true }).then((hit) =>
      hit ?? fetch(event.request)
    ),
  );
});

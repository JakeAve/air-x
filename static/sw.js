// Precaches the whole app so it opens with no network. build.ts stamps the
// cache name with a hash of dist/, so any change ships a new cache and the old
// one is dropped on activate.
const CACHE = "air-x-__VERSION__";
const ASSETS = [
  "./",
  "./diag.js",
  "./codec-worker.js",
  "./capture-worklet.js",
  "./styles.css",
  "./fonts/open-sans.woff2",
  "./favicon.svg",
  "./manifest.webmanifest",
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE).then((cache) => cache.addAll(ASSETS)).then(() =>
      self.skipWaiting()
    ),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(
        keys.filter((key) => key !== CACHE).map((key) => caches.delete(key)),
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

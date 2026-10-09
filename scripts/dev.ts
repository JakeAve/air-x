// Serves dist/ locally and rebuilds when src/ or static/ change. Phones only
// expose the microphone to secure origins, so when .certs/cert.pem and
// .certs/key.pem exist (see README) the server speaks HTTPS.
//
// A phone's log is out of reach, so every HTML page is served with
// DEV_LOG_SCRIPT appended: it posts each new line of the page's #log, plus
// uncaught errors, to /__log, which prints them here tagged with the device's
// address. None of it is in dist/, so none of it ships.
//
// The real service worker is cache-first, so a device that ever cached this
// origin would keep running an old build. /sw.js is served as DEV_SW instead:
// it drops every cache, unregisters, and reloads pages that were cached.
import { serveDir } from "@std/http";
import { join } from "@std/path";
import { build } from "./build.ts";

const ROOT = new URL("..", import.meta.url).pathname;
const DIST = join(ROOT, "dist");
const PORT = Number(Deno.env.get("PORT") ?? 8444);
const CERT_DIR = join(ROOT, ".certs");

const LOG_PATH = "/__log";
const LOG_MAX_CHARS = 16_384;
const DEV_LOG_SCRIPT = `<script>
(() => {
  const send = (text) =>
    fetch("${LOG_PATH}", { method: "POST", body: text, keepalive: true }).catch(() => {});
  addEventListener("error", (e) => send("error: " + e.message + " at " + e.filename + ":" + e.lineno));
  addEventListener("unhandledrejection", (e) => send("unhandled rejection: " + e.reason));
  send("page open: " + navigator.userAgent);
  const el = document.getElementById("log");
  if (!el) return;
  let sent = 0;
  new MutationObserver(() => {
    const text = el.textContent;
    if (text.length < sent) sent = 0;
    if (text.length > sent) send(text.slice(sent));
    sent = text.length;
  }).observe(el, { childList: true, characterData: true, subtree: true });
})();
</script>`;

const DEV_SW = `
self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (event) => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.map((key) => caches.delete(key)));
    await self.registration.unregister();
    if (!keys.length) return;
    for (const client of await self.clients.matchAll({ type: "window" })) {
      client.navigate(client.url);
    }
  })());
});
`;

async function handle(req: Request, info: Deno.ServeHandlerInfo) {
  const { pathname } = new URL(req.url);
  if (pathname !== LOG_PATH) {
    const from = (info.remoteAddr as Deno.NetAddr).hostname;
    console.log(`[${from}] ${req.method} ${pathname}`);
  }
  if (pathname === LOG_PATH && req.method === "POST") {
    const from = (info.remoteAddr as Deno.NetAddr).hostname;
    const text = (await req.text()).slice(0, LOG_MAX_CHARS);
    for (const line of text.split("\n")) {
      if (line) console.log(`[${from}] ${line}`);
    }
    return new Response(null, { status: 204 });
  }
  if (pathname === "/sw.js") {
    return new Response(DEV_SW, {
      headers: {
        "content-type": "text/javascript",
        "cache-control": "no-store",
      },
    });
  }
  const res = await serveDir(req, { fsRoot: DIST, quiet: true });
  if (
    res.status !== 200 || !res.headers.get("content-type")?.includes("html")
  ) return res;
  const html = (await res.text()).replace(
    "</body>",
    DEV_LOG_SCRIPT + "</body>",
  );
  return new Response(html, {
    headers: {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
    },
  });
}

async function tlsOptions(): Promise<
  { cert: string; key: string } | undefined
> {
  try {
    return {
      cert: await Deno.readTextFile(join(CERT_DIR, "cert.pem")),
      key: await Deno.readTextFile(join(CERT_DIR, "key.pem")),
    };
  } catch {
    return undefined;
  }
}

let building = Promise.resolve();
let pending = false;

function scheduleBuild() {
  if (pending) return;
  pending = true;
  building = building.then(async () => {
    await new Promise((resolve) => setTimeout(resolve, 100));
    pending = false;
    try {
      await build();
      console.log("rebuilt");
    } catch (err) {
      console.error(err);
    }
  });
}

await build();

const tls = await tlsOptions();
const server = Deno.serve(
  { port: PORT, hostname: "0.0.0.0", ...tls, onListen: () => {} },
  handle,
);
console.log(
  `serving dist/ over ${tls ? "https" : "http"} on port ${server.addr.port}`,
);

const watcher = Deno.watchFs([join(ROOT, "src"), join(ROOT, "static")]);
for await (const _event of watcher) {
  scheduleBuild();
}

// Serves dist/ locally and rebuilds when src/ or static/ change. Phones only
// expose the microphone to secure origins, so when .certs/cert.pem and
// .certs/key.pem exist (see README) the server speaks HTTPS.
import { serveDir } from "@std/http";
import { join } from "@std/path";
import { build } from "./build.ts";

const ROOT = new URL("..", import.meta.url).pathname;
const DIST = join(ROOT, "dist");
const PORT = Number(Deno.env.get("PORT") ?? 8444);
const CERT_DIR = join(ROOT, ".certs");

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
  (req) => serveDir(req, { fsRoot: DIST, quiet: true }),
);
console.log(
  `serving dist/ over ${tls ? "https" : "http"} on port ${server.addr.port}`,
);

const watcher = Deno.watchFs([join(ROOT, "src"), join(ROOT, "static")]);
for await (const _event of watcher) {
  scheduleBuild();
}

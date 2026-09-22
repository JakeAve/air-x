// Builds the static site into dist/: copies static/ and bundles the page, the
// codec worker, and the capture worklet for the browser.
import { copy, emptyDir, walk } from "@std/fs";
import { join, relative } from "@std/path";

const ROOT = new URL("..", import.meta.url).pathname;
const DIST = join(ROOT, "dist");

async function bundle(entry: string, out: string) {
  const cmd = new Deno.Command(Deno.execPath(), {
    args: [
      "bundle",
      "--platform",
      "browser",
      "--minify",
      "--sourcemap",
      "linked",
      "-o",
      out,
      entry,
    ],
    cwd: ROOT,
    stdout: "inherit",
    stderr: "inherit",
  });
  const { success } = await cmd.output();
  if (!success) throw new Error(`bundle failed for ${entry}`);
}

const ENTRIES: [entry: string, out: string][] = [
  ["src/diag.ts", "diag.js"],
  ["src/codecWorker.ts", "codec-worker.js"],
  ["src/captureWorklet.ts", "capture-worklet.js"],
];

export async function build() {
  await emptyDir(DIST);
  await copy(join(ROOT, "static"), DIST, { overwrite: true });
  for (const [entry, out] of ENTRIES) await bundle(entry, join(DIST, out));
  await copy(join(DIST, "diag.html"), join(DIST, "index.html"));
  await stampServiceWorker();
}

/** Writes a content hash of dist/ into sw.js so a new build is a new cache. */
async function stampServiceWorker() {
  const sw = join(DIST, "sw.js");
  let listing = "";
  for await (const entry of walk(DIST, { includeDirs: false })) {
    if (entry.path === sw) continue;
    listing += `${relative(DIST, entry.path)}:${await hex(
      await Deno.readFile(entry.path),
    )}\n`;
  }
  const version = (await hex(new TextEncoder().encode(listing))).slice(0, 16);
  await Deno.writeTextFile(
    sw,
    (await Deno.readTextFile(sw)).replace("__VERSION__", version),
  );
}

async function hex(bytes: Uint8Array<ArrayBuffer>): Promise<string> {
  const hash = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  return Array.from(hash, (b) => b.toString(16).padStart(2, "0")).join("");
}

if (import.meta.main) {
  await build();
}

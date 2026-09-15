// Builds the static site into dist/: copies static/ and bundles the page, the
// codec worker, and the capture worklet for the browser.
import { copy, emptyDir } from "@std/fs";
import { join } from "@std/path";

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
}

if (import.meta.main) {
  await build();
}

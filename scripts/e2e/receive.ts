// Drives the diag page in headless Chromium twice: once with a fake
// microphone fed from fixtures.ts (sound-only receive), once with a fake
// camera (QR-only receive), so both paths to a rendered item run without
// hardware. Expects `deno task build` to have run.
// Set CHROMIUM_PATH to use a Chromium outside Playwright's own cache.
import { serveDir } from "@std/http";
import { join } from "@std/path";
import { chromium } from "playwright";
import { FIXTURE_FILE_NAME, FIXTURE_TEXT, writeFixtures } from "./fixtures.ts";

const ROOT = new URL("../..", import.meta.url).pathname;
const DIST = join(ROOT, "dist");

const fixtures = await writeFixtures(
  await Deno.makeTempDir({ prefix: "air-x-e2e-" }),
);

const server = Deno.serve(
  { port: 0, onListen() {} },
  (req) => serveDir(req, { fsRoot: DIST, quiet: true }),
);
const PORT = server.addr.port;

const failures: string[] = [];

async function receive(
  label: string,
  deviceArgs: string[],
  permissions: string[],
  expected: string,
): Promise<void> {
  const browser = await chromium.launch({
    executablePath: Deno.env.get("CHROMIUM_PATH"),
    args: [
      "--use-fake-device-for-media-stream",
      "--use-fake-ui-for-media-stream",
      "--autoplay-policy=no-user-gesture-required",
      ...deviceArgs,
    ],
  });
  try {
    const context = await browser.newContext({ permissions });
    const page = await context.newPage();
    page.on(
      "pageerror",
      (err) => failures.push(`${label}: page error: ${err.message}`),
    );
    page.on("console", (msg) => {
      if (msg.type() === "error") {
        failures.push(`${label}: console error: ${msg.text()}`);
      }
    });

    await page.goto(`http://localhost:${PORT}/diag.html`);
    const start = performance.now();
    await page.click("#listen");
    try {
      await page.waitForFunction(
        (expected) =>
          document.querySelector("#received-items")?.textContent?.includes(
            expected,
          ) ?? false,
        expected,
        { timeout: 60_000 },
      );
      const elapsed = ((performance.now() - start) / 1000).toFixed(1);
      console.log(`${label} receive: ${elapsed} s`);
    } catch (err) {
      failures.push(`${label}: item not heard within 60 s (${err})`);
    }
  } finally {
    await browser.close();
  }
}

try {
  await receive(
    "sound",
    [`--use-file-for-fake-audio-capture=${fixtures.wav}`],
    ["microphone"],
    FIXTURE_TEXT,
  );
  await receive(
    "qr",
    [`--use-file-for-fake-video-capture=${fixtures.y4m}`],
    ["microphone", "camera"],
    FIXTURE_FILE_NAME,
  );
} finally {
  await server.shutdown();
}

if (failures.length) {
  console.error("e2e failures:\n" + failures.join("\n"));
  Deno.exit(1);
}
console.log("e2e ok");

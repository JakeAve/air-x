// Renders static/og.png (1200x630 social card), static/apple-touch-icon.png,
// and the manifest icons from the site's own font and tokens. Run by hand after a brand change:
//   deno run -A scripts/og.ts
import { chromium } from "playwright";
import { toFileUrl } from "@std/path";

const STATIC = new URL("../static/", import.meta.url).pathname;
const font = toFileUrl(STATIC + "fonts/open-sans.woff2").href;
const mark = await Deno.readTextFile(STATIC + "favicon.svg");

const card = `<!DOCTYPE html><meta charset="utf-8"><style>
  @font-face { font-family: "Open Sans"; font-weight: 300 800; src: url("${font}") format("woff2"); }
  * { margin: 0; box-sizing: border-box; }
  body { width: 1200px; height: 630px; background: #000; color: #fff;
    font: 300 1rem/1.5 "Open Sans", sans-serif; padding: 96px;
    display: grid; align-content: center; gap: 32px; }
  .app { font-size: 28px; font-weight: 600; letter-spacing: 0.16em; text-transform: uppercase; }
  h1 { font-size: 168px; font-weight: 300; line-height: 0.95; letter-spacing: -0.025em; }
  p { font-size: 40px; color: #c2c2c2; max-width: 800px; }
  svg { position: absolute; top: 96px; right: 96px; width: 160px; height: 160px; }
</style>
${mark}
<span class="app">Air X</span>
<h1>air x</h1>
<p>Pass text and files to the device next to you by sound or QR code. No server, no account.</p>`;

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1200, height: 630 } });
await page.setContent(card);
await page.waitForFunction(() => document.fonts.ready.then(() => true));
await page.screenshot({ path: STATIC + "og.png" });

for (
  const [size, file] of [
    [180, "apple-touch-icon.png"],
    [192, "icon-192.png"],
    [512, "icon-512.png"],
  ] as const
) {
  await page.setViewportSize({ width: size, height: size });
  await page.setContent(
    `<!DOCTYPE html><style>*{margin:0}svg{width:${size}px;height:${size}px;display:block}</style>${mark}`,
  );
  await page.screenshot({ path: STATIC + file });
}
await browser.close();

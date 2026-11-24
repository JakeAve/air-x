# Air X

Send contacts, text, images, and files to a nearby device by sound (ggwave or
libquiet) or QR code, no server. Sibling of
[airgap](https://github.com/JakeAve/airgap), which uses the same transports for
games. Deno 2 + TypeScript, plain HTML and CSS.

## Stack

- **Runtime / tooling:** Deno 2.x only. No Node, no npm scripts, no framework.
- **Language:** TypeScript. `src/lib/` uses no DOM and no `Deno.*`, only globals
  present in both browsers and Deno (`crypto.subtle`, `TextEncoder`) plus
  `fflate`.
- **Tests:** `deno test`, colocated `*.test.ts`, seeded PRNGs so every run is
  identical.
- **Imports:** `@std/assert`, `@std/fs`, `@std/path`, `@std/http`, `ggwave`,
  `qr` (encode from `qr`, decode from `qr/decode.js`), `fflate` (deflate with a
  preset dictionary, which `CompressionStream` cannot do), and `@/` for
  `./src/`.

## Commands

```bash
deno task dev     # build to dist/, serve on PORT (default 8444), rebuild on change
deno task build   # build to dist/
deno task e2e     # build, then headless-Chromium receive test: sound-only via fake mic (ggwave, then quiet; the first also checks the item is saved to the library and survives a reload), then QR-only via fake camera (needs Playwright's Chromium: `deno run -A npm:playwright install chromium`)
```

`dev` serves HTTPS with a certificate it makes with mkcert for the machine's
current addresses, kept in the main checkout's `.certs/` and shared by every
worktree; without mkcert or a certificate it serves http. It prints the
addresses to open, serves mkcert's root certificate at `/rootCA.pem` for phones
to install, and prints every device's page log, errors, and requests tagged with
the device's address (injected at serve time, nothing in `dist/`). `/sw.js` is
replaced by a worker that clears caches, so dev never serves a stale build.

**Local development is always tested on a phone.** Mic, camera, speaker, and
touch only behave for real there, so a desktop browser is never the check. For
any change a page can show:

1. Run `PORT=<port> deno task dev` in the background from your worktree, on a
   free port from 8450 up (`lsof -i :<port>` is empty), one port per worktree.
   Not `preview_start`: launch.json's `dev` serves whatever folder the session
   is in on 8444, usually the main checkout, not your worktree.
2. Give Jake the "from a phone" address it prints, with the port.
3. Read the device's lines from the server's output instead of asking what the
   screen says.

No line when they load the page means the phone is not reaching the server.
`rejected N` with `sound 0, qr 0` means the two devices run different builds; a
fresh port is a clean origin. README, "Testing on phones", has the rest.

## Layout

- `scripts/build.ts` — copies `static/` to `dist/`, bundles `src/diag.ts`,
  `src/codecWorker.ts`, `src/captureWorklet.ts`, copies `diag.html` to
  `index.html`, and stamps `sw.js` with a content hash of `dist/` so every build
  is a new cache. `scripts/dev.ts` serves it.
- `scripts/e2e/` — `fixtures.ts` builds a WAV and a y4m of real fountain-coded
  transfers for Chromium's fake microphone and fake camera; `receive.ts` serves
  `dist/`, runs a ggwave sound-only receive, a quiet sound-only receive, and a
  QR-only receive headless, and checks the diag page renders each item.
- `static/` — `diag.html`, `styles.css`, `fonts/open-sans.woff2` (variable
  weight, OFL), and the brand assets: `favicon.svg` (mango square, black
  exchange arrows), `apple-touch-icon.png`, `icon-192.png`, `icon-512.png`, and
  `og.png` (1200x630 social card). The PNGs are rendered from the SVG and the
  site font by `deno run -A scripts/og.ts`; re-run it after a brand change.
  Every asset path is relative except the absolute `og:image` and canonical
  URLs, which point at the Pages site. The accent is an animated gradient
  (`--accent-grad`); `scripts/grad-editor.local.js`, gitignored, is a panel for
  tuning it that `dev` inlines when present. Visual rules live in
  `.claude/skills/air-x-style/SKILL.md`; read it before touching markup or CSS.
- `src/diag.ts` — the page: screens picked by the hash (`#home`, `#send`,
  `#receive`, `#library`, `#library/<hash>`; leaving a screen aborts its
  transfer). Send text and files by sound or camera (the Send by radio defaults
  to sound for bundles up to 2048 bytes, else camera, until picked by hand) with
  a live time estimate of both; receive from camera and mic at once, with a
  share bar per transfer; log, including acks on both ends. One button per
  screen flips between Send/Listen and Stop. A camera send shows the code
  full-window with its own Stop button. Tuning inputs sit under Advanced,
  including a camera codec select (QR only). Defaults: 4 packets per code, 5
  fps, ECC medium, adapt rate on; camera on, scan max edge 1280, ack every 80
  symbols (0 never acks); silence 12 s.
- `src/adapters/` — the only browser-API code besides the entries: `pageLink.ts`
  (`openDevices`: one codec worker shared by both transports; `cameraCodecs`:
  the registry of camera codecs by name, each an `encoder` and a `decoder()`
  factory, which the page's codec select and receive path read),
  `soundTransport.ts` (`SoundTransport`, a `PacketChannel`), `qrTransport.ts`
  (`QrTransport`, a `PacketSource` and `PacketDisplay`), `camera.ts`,
  `screen.ts` (draws a code on a canvas), `codecWorker.ts`, `microphone.ts`,
  `speaker.ts`, `library.ts` (IndexedDB library: `record`, `listItems`,
  `getItem`, `removeItem`, `putItem`; dedupes and evicts on save),
  `clipboard.ts` (`copyBlob`: text as text, images redrawn as PNG; `openType`:
  markup and SVG open as plain text).
- `src/libraryView.ts` — the library screens, imported by `diag.ts`: the home
  tile's newest title, `#library` (rows by day, Undo after a delete, count and
  disclosure), and `#library/<hash>` (preview, events, Copy/Share/Save/Delete).
  `leaveLibrary` revokes its object URLs on every screen change. Also `size` and
  `seconds`, shared with `diag.ts`.
- `src/codecWorker.ts` — worker hosting ggwave and libquiet, so the page bundle
  carries neither. Page code imports `PACKET_SECONDS` from `protocol.ts`, not
  `ggwave.ts`.
- `vendor/quiet/` — libquiet's 2016 emscripten asm.js build from quiet-js,
  wrapped as an ESM factory, plus its memory initializer inlined as `mem.ts`.
  Excluded from fmt and lint. No wasm; it runs as plain JS.
- `src/captureWorklet.ts` — AudioWorklet forwarding mic samples in 1024-sample
  blocks.

## `src/lib/`

The protocol layer. Spec: the main checkout's
`.claude/plans/2026-09-14-transfer-protocol/spec.md` (gitignored).

- `protocol.ts` — wire constants: version, packet sizes, `MAX_K`,
  `COMPACT_MAX_K`, `dataBytes(packetBytes, k)` (a transfer's block size), and
  `PACKET_SECONDS` per sound protocol.
- `crc16.ts` — CRC-16/CCITT-FALSE over the packet.
- `packet.ts` — codec for 64- or 128-byte packets, compact or wide header by
  `k`; rejects bad CRC, version, or type, and a wide packet whose `k` fits the
  compact header.
- `bundle.ts` — items to one byte string: deflate-raw against `DICTIONARY` plus
  truncated SHA-256. Inflates in 4 KB steps of input so the 64 MiB cap trips
  before a bomb allocates.
- `dictionary.ts` — the preset deflate dictionary, hand-written: vCard,
  iCalendar, and Wi-Fi boilerplate, URL prefixes, common English and Spanish
  words, MIME types, and the manifest JSON itself. It is why a one-line message
  fits one packet. Changing a byte changes every bundle on the wire: bump
  `PROTOCOL_VERSION` and refresh the golden in `bundle.test.ts`.
- `fountain/symbols.ts` — `blockCount`, and `blockSet`: which blocks a symbol id
  XORs for `k <= DENSE_MAX_K` (systematic below K, dense random rows above).
- `fountain/raptor.ts` — the code for `k > DENSE_MAX_K`: a binary systematic
  Raptor code after RFC 6330. `makeCode` gives the parameters (padded K', S LDPC
  rows, H dense HDPC rows, W LT columns, P permanently inactive columns),
  `ltRow` a symbol's intermediate columns, and `Solver` does inactivation
  decoding (peel, inactivate on a stall, Gauss-Jordan on the inactive columns,
  back substitution), keeping its state when short of rank so each later symbol
  is one dense row. The encoder solves once for intermediates whose rows 0..K-1
  are the source blocks. Decodes from about K + 2 packets under any loss.
- `fountain/seeds.ts` — generated by `deno run -A scripts/raptor-seeds.ts`: per
  padded size, the smallest seed whose square source system is invertible.
  Regenerate after any change to `raptor.ts` rows. `scripts/fountain-bench.ts`
  prints overhead and timing under loss.
- `fountain/encoder.ts` — `Encoder`: an endless stream of packets for a bundle;
  `next()` wraps to symbol 0 after the layout's last symbol id.
- `fountain/decoder.ts` — `Decoder`: for `k <= DENSE_MAX_K` peeling, then
  Gaussian elimination over GF(2) when peeling stalls; above, source symbols
  land at once and `raptor.ts`'s `Solver` runs once K symbols are in. Returns
  the zero-padded bundle.
- `abort.ts` — `sleep` and `aborted` on an `AbortSignal`.
- `library.ts` — pure logic for the on-device library: `hashBytes`, `merge`
  (dedupe by hash, events oldest first), `evictions` under `LIBRARY_CAP`, and
  `title`.
- `channel.ts` — `PacketSource` (`onPacket`), `PacketChannel` (adds
  `send(packets, signal)`), `PacketDisplay` (`show`, `clear`).
- `receiver.ts` — `Receiver`: one decoder per interleaved transfer, evicts stale
  ones.
- `cameraCodec.ts` — `CameraEncoder`
  (`start(bundle, transferId, rate, signal,
  onFrame)` returns a
  `CameraSending` with `setRate`, `resend`, `fresh`, `done`; `seconds` estimates
  a send) and `qrEncoder`: QR codes of `packetsPerCode` 128-byte packets at
  `fps`. `OVERHEAD` is the 10 % repair the estimate assumes.
- `transferDecoder.ts` — `TransferDecoder`, what `receiveBundle` takes from a
  camera codec: `onHeard`, `onComplete`, `ack` (the figures for one ack),
  `status`, `forget`, `close`. `packetDecoder` is the fountain-packet one over a
  `PacketSource`; `countFrom` says whether units count toward `ackEvery` from
  the first symbol or the first repair symbol.
- `symbolStream.ts` — `SymbolStream`: queued resend blocks first, then fresh
  symbols from an `Encoder`; `sendBundle` uses it for sound, `qrEncoder` for QR.
- `session.ts` — `sendBundle` (`sound` or `camera: { encoder, rate, adapt }`,
  never both: sound bursts of `listenEvery` then a listen window, or the camera
  encoder's frames at its `rate`, until DONE is heard; Ack packets heard on
  `listen` queue their blocks, and each burst or frame sends queued blocks
  before fresh symbols) and `receiveBundle` (sound plus any `camera` decoders, a
  transfer belonging to the decoder that first reports it; sends DONE by sound,
  two copies back to back). Silence rules count sound only: once complete, DONE
  goes out at once if no sound from the transfer was heard within `silenceMs`,
  else after `silenceMs` of sound silence or on a `DataListen`. After DONE,
  sound from that transfer means the sender missed it, so silence re-sends DONE;
  camera decoders are data only and never trigger a re-send. Silence with no
  sound heard since DONE finishes. With `ackEvery` set, the receiver sends an
  `Ack` by sound every `ackEvery` new symbols (resends included), with DONE's
  timing and `turnaroundMs`; counting starts at a transfer's first symbol from a
  decoder, or its first repair symbol when it comes by sound. Every ack reports
  the highest symbol id and the count of fresh units heard; its runs are
  optional (a codec may name no blocks) and a packet decoder names them only
  once a repair symbol was heard. Each ack is a snapshot, so a lost resend is
  simply named again, and the sender ignores blocks already queued. A bundle
  that finishes inside the period never acks. Acks heard from other receivers
  count as neither symbols nor sound from the transfer. With `camera.adapt`,
  every ack carries the share of fresh ids the receiver heard since its last
  ack, counted from just below the first id it saw, so a receiver that starts
  looking late is not read as loss; the sender passes it to its `RatePolicy` as
  a `RateSample` and uses the rate it returns. Once an ack has been heard,
  `silentAfter` fresh symbols with no ack give a `silent` sample; before the
  first ack, no one may be looking yet, so silence means nothing.
- `rate.ts` — the decision engine, apart from the plumbing: `RatePolicy` is a
  function from a `RateSample` to the next `CameraRate` (`fps`, and an optional
  `packetsPerCode`, 1 when left out). `ladderPolicy` is the one in use; its
  ladder (2 to 9 packets per code, 5 to 10 fps) and thresholds are
  `LADDER_DEFAULTS`, guesses to be tuned on phones. `SILENT_AFTER` is 240. The
  receiver needs no rate: a code says how many packets it holds.
- `qr/` — `qrEncoder.ts` (128-byte packets into one byte-mode code, `QrEcc`;
  four at medium ECC are version 19, carrying 480 data bytes), `qrDecoder.ts`
  (RGBA frame to packets), `bytesAsText.ts`, `rasterize.ts` (`QR_COLORS`, test
  images).
- `sound/` — ggwave wrapper (`ggwave.ts`), libquiet wrapper (`quiet.ts`: three
  profiles with `frame_length` set to one packet, so a frame is a packet or
  nothing; output is scaled so `volume` maps to peak amplitude like ggwave),
  `SoundEncoder` (picks the modem by protocol name), `SoundDecoder` (feeds every
  block to ggwave and all three quiet decoders, so a receiver needs no protocol
  choice), and the codec worker's message types.

Wire facts (multi-byte fields big-endian):

- Packet, 64 bytes by sound and 128 by QR: first byte
  `version 4b | wide 1b | type 3b`, then compact
  `transferId u16 | k u8 | symbolId u16 | data 56B | crc16` or wide
  `transferId u16 | k u24 | symbolId u24 | data 53B | crc16` (data is 120 and
  117 bytes in a QR packet). A packet is wide exactly when `k > COMPACT_MAX_K`
  (255), so `Done` (k 0) is compact and an `Ack` uses its transfer's layout.
  `blockCount` takes the count at the compact data size if that is at most 255,
  else the count at the wide size. A compact transfer's symbol ids stop at
  65535; a sender that reaches the last id starts again at 0. Types: `Data`,
  `DataListen`, `Done`, `Ack` (`symbolId` is the highest id heard; data is 12
  runs of `start u24 | length u8`, then fresh symbols heard as a u24, then the
  share heard since the last ack as 1 + percent in a u8, 0 when unknown; older
  builds send 0, so no version bump).
- Bundle:
  `u32 length | deflate-raw(u32 manifestLength | manifest JSON | item bytes...) | sha256[0..8]`.
  `length` counts compressed bytes plus hash, so block padding past it is
  ignored. Deflate uses the preset dictionary in `dictionary.ts` on both ends;
  the manifest JSON is in it, so a short text message costs about 25 bytes on
  the wire instead of 87. Incompressible items come out as stored blocks (5
  bytes per 64 KiB), so there is no per-item codec choice.
- Repair symbols for `k <= DENSE_MAX_K` (128) are dense: each block is included
  with probability 1/2, one mulberry32 draw per block in order, falling back to
  one block if empty.
- Larger k is `raptor.ts`: K pads to K' (129, then each next is
  `prev + ceil(prev / 32)`), padding blocks are zero and never sent, symbol id
  `i < K` is source block `i` and a repair id `j` is row `j - K + K'`. Rows
  depend on (K', seed), not the transfer id.
- `blockSet`, `makeCode`, `ltRow`, the LDPC and HDPC rows, and `SEEDS` must
  never change output without a `PROTOCOL_VERSION` bump: sender and receiver
  derive them independently, and `symbols.test.ts` and `raptor.test.ts` pin
  golden values. Integer arithmetic only: engines may differ in the last bit of
  `Math.log`/`Math.sqrt`.
- `MAX_BUNDLE_BYTES` (16 MiB) caps `Encoder`'s input and the decoder ignores any
  packet whose `k` implies a bigger bundle; `MAX_INFLATED_BYTES` (64 MiB) caps
  `decodeBundle`'s decompression output.

## Hardware facts

- iOS needs a user gesture before an AudioContext runs or the mic opens.
- The mic opens once and stays rolling: `getUserMedia` is too slow between legs.
- A device cannot hear its peer while its own speaker plays.
- Ultrasound on iOS closes the mic around a send, or playback stays in call
  mode.
- The receiver waits `turnaroundMs` before each DONE: after an ultrasound burst
  the sender's mic takes hundreds of ms to reopen and would miss it.
- The camera, like the mic, is opened by `watch()` and left rolling for a leg;
  the diag page closes it as soon as a transfer completes (DONE goes on by
  sound) or the receive ends.
- It is a PWA: `static/manifest.webmanifest` plus `static/sw.js`, a plain-JS
  service worker that precaches every asset (cache-first, network fallback) so
  the app opens offline. `src/diag.ts` registers it. Airgap's cache gotcha
  applies: a change only reaches a device on its second open after the deploy,
  and the build's hash stamp is what makes it reach at all. Never edit
  `dist/sw.js` by hand.

## Workflow

`main` is protected: no direct pushes, no force pushes. Every change lands
through a PR.

Always work in a git worktree under `.worktrees/`, never in the main checkout:

```bash
git fetch origin main
git worktree add .worktrees/<branch> -b <branch> origin/main
```

Branches are `feat/<thing>` or `fix/<thing>`. Open a PR with a real title when
the task is done. Once it merges, `git worktree remove .worktrees/<branch>`,
delete the branch, and `git pull` in the main checkout.

Run `deno task setup` in a fresh clone to install the hooks. Worktrees share the
repo's git config, so they get the hooks automatically. Pre-commit and pre-push
run `deno task check` and `deno task test`.

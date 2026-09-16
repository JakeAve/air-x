# Air X

Send contacts, text, images, and files to a nearby device by sound (ggwave or
libquiet) or QR code, no server. Sibling of
[airgap](https://github.com/JakeAve/airgap), which uses the same transports for
games. Deno 2 + TypeScript, plain HTML and CSS.

## Stack

- **Runtime / tooling:** Deno 2.x only. No Node, no npm scripts, no framework.
- **Language:** TypeScript. `src/lib/` uses no DOM and no `Deno.*`, only globals
  present in both browsers and Deno (`CompressionStream`, `crypto.subtle`,
  `TextEncoder`).
- **Tests:** `deno test`, colocated `*.test.ts`, seeded PRNGs so every run is
  identical.
- **Imports:** `@std/assert`, `@std/fs`, `@std/path`, `@std/http`, `ggwave`,
  `qr` (encode from `qr`, decode from `qr/decode.js`), and `@/` for `./src/`.

## Commands

```bash
deno task dev     # build to dist/, serve on PORT (default 8444), rebuild on change
deno task build   # build to dist/
deno task e2e     # build, then headless-Chromium receive test: sound-only via fake mic (ggwave, then quiet), then QR-only via fake camera (needs Playwright's Chromium: `deno run -A npm:playwright install chromium`)
```

`dev` serves HTTPS when `.certs/cert.pem` and `.certs/key.pem` exist (README).

## Layout

- `scripts/build.ts` — copies `static/` to `dist/` and bundles `src/diag.ts`,
  `src/codecWorker.ts`, `src/captureWorklet.ts`. `scripts/dev.ts` serves it.
- `scripts/e2e/` — `fixtures.ts` builds a WAV and a y4m of real fountain-coded
  transfers for Chromium's fake microphone and fake camera; `receive.ts` serves
  `dist/`, runs a ggwave sound-only receive, a quiet sound-only receive, and a
  QR-only receive headless, and checks the diag page renders each item.
- `static/` — `diag.html`, `styles.css`, and `fonts/open-sans.woff2` (variable
  weight, OFL). Every asset path is relative. Visual rules live in
  `.claude/skills/air-x-style/SKILL.md`; read it before touching markup or CSS.
- `src/diag.ts` — the page: three screens picked by the hash (`#home`, `#send`,
  `#receive`; leaving a screen aborts its transfer). Send text and files by QR,
  sound, or both (the Send by radio defaults to both for bundles up to 2048
  bytes, else QR, until picked by hand) with a live time estimate; receive from
  camera and mic at once; log. One button per screen flips between Send/Listen
  and Stop. Tuning inputs sit under Advanced. Defaults: 8 packets per code, 5
  fps, ECC medium; camera on, scan max edge 1280; silence 12 s.
- `src/adapters/` — the only browser-API code besides the entries: `pageLink.ts`
  (`openDevices`: one codec worker shared by both transports),
  `soundTransport.ts` (`SoundTransport`, a `PacketChannel`), `qrTransport.ts`
  (`QrTransport`, a `PacketSource` and `PacketDisplay`), `camera.ts`,
  `screen.ts` (draws a code on a canvas), `codecWorker.ts`, `microphone.ts`,
  `speaker.ts`.
- `src/codecWorker.ts` — worker hosting ggwave and libquiet, so the page bundle
  carries neither. Page code imports `PACKET_SECONDS` from `protocol.ts`, not
  `ggwave.ts`.
- `vendor/quiet/` — libquiet's 2016 emscripten asm.js build from quiet-js,
  wrapped as an ESM factory, plus its memory initializer inlined as `mem.ts`.
  Excluded from fmt and lint. No wasm; it runs as plain JS.
- `src/captureWorklet.ts` — AudioWorklet forwarding mic samples in 1024-sample
  blocks.

## `src/lib/`

The protocol layer. Spec: `docs/specs/2026-09-14-transfer-protocol.md` (local,
gitignored).

- `protocol.ts` — wire constants: version, packet sizes, `MAX_K`, and
  `PACKET_SECONDS` per sound protocol.
- `crc16.ts` — CRC-16/CCITT-FALSE over the packet.
- `packet.ts` — 64-byte packet codec; rejects bad CRC, version, or type.
- `bundle.ts` — items to one byte string: deflate-raw plus truncated SHA-256.
- `fountain/symbols.ts` — `blockCount`, and `blockSet`: which blocks a symbol id
  XORs (systematic below K; above it, dense random rows for `k <= DENSE_MAX_K`,
  robust soliton LT otherwise).
- `fountain/encoder.ts` — `Encoder`: an endless stream of packets for a bundle.
- `fountain/decoder.ts` — `Decoder`: peeling, then Gaussian elimination over
  GF(2) when peeling stalls; returns the zero-padded bundle.
- `abort.ts` — `sleep` and `aborted` on an `AbortSignal`.
- `channel.ts` — `PacketSource` (`onPacket`), `PacketChannel` (adds
  `send(packets, signal)`), `PacketDisplay` (`show`, `clear`).
- `receiver.ts` — `Receiver`: one decoder per interleaved transfer, evicts stale
  ones.
- `session.ts` — `sendBundle` (sound bursts of `listenEvery` then a listen
  window, and QR codes of `packetsPerCode` at `fps`, from one encoder until DONE
  is heard) and `receiveBundle` (sound plus any `sources`; sends DONE by sound).
  Silence rules count sound only: once complete, DONE goes out at once if no
  sound from the transfer was heard within `silenceMs`, else after `silenceMs`
  of sound silence or on a `DataListen`. After DONE, packets of that transfer
  (QR included) mean the sender missed it, so silence re-sends DONE; silence
  with nothing heard since DONE finishes.
- `qr/` — `qrEncoder.ts` (packets into one byte-mode code, `QrEcc`),
  `qrDecoder.ts` (RGBA frame to packets), `bytesAsText.ts`, `rasterize.ts`
  (`QR_COLORS`, test images).
- `sound/` — ggwave wrapper (`ggwave.ts`), libquiet wrapper (`quiet.ts`: three
  profiles with `frame_length` set to one packet, so a frame is a packet or
  nothing; output is scaled so `volume` maps to peak amplitude like ggwave),
  `SoundEncoder` (picks the modem by protocol name), `SoundDecoder` (feeds every
  block to ggwave and all three quiet decoders, so a receiver needs no protocol
  choice), and the codec worker's message types.

Wire facts (multi-byte fields big-endian):

- Packet, 64 bytes:
  `version 4b | type 4b | transferId 16b | k 24b | symbolId 24b | data 53B | crc16`.
  Types: `Data`, `DataListen`, `Done`.
- Bundle:
  `u32 length | deflate-raw(u32 manifestLength | manifest JSON | item bytes...) | sha256[0..8]`.
  `length` counts compressed bytes plus hash, so block padding past it is
  ignored.
- Repair symbols for `k <= DENSE_MAX_K` (128) are dense: each block is included
  with probability 1/2, one mulberry32 draw per block in order, falling back to
  one block if empty. Larger k uses robust soliton degrees.
- `blockSet(transferId, symbolId, k)` must never change output without a
  `PROTOCOL_VERSION` bump: sender and receiver derive block sets independently,
  and `symbols.test.ts` pins golden values. It avoids `Math.log`/`Math.sqrt`
  because engines may differ in the last bit.
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
  the diag page closes it when a receive ends.
- Airgap's service-worker cache gotcha does not apply: there is no service
  worker.

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

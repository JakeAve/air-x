# Air X

Send contacts, text, images, and files to a nearby device by ggwave sound or QR
code, no server. Sibling of [airgap](https://github.com/JakeAve/airgap), which
uses the same transports for games. Deno 2 + TypeScript, plain HTML and CSS.

## Stack

- **Runtime / tooling:** Deno 2.x only. No Node, no npm scripts, no framework.
- **Language:** TypeScript. `src/lib/` uses no DOM and no `Deno.*`, only globals
  present in both browsers and Deno (`CompressionStream`, `crypto.subtle`,
  `TextEncoder`).
- **Tests:** `deno test`, colocated `*.test.ts`, seeded PRNGs so every run is
  identical.
- **Imports:** `@std/assert`, `@std/fs`, `@std/path`, `@std/http`, `ggwave`, and
  `@/` for `./src/`.

## Commands

```bash
deno task dev     # build to dist/, serve on PORT (default 8444), rebuild on change
deno task build   # build to dist/
```

`dev` serves HTTPS when `.certs/cert.pem` and `.certs/key.pem` exist (README).

## Layout

- `scripts/build.ts` — copies `static/` to `dist/` and bundles `src/diag.ts`,
  `src/codecWorker.ts`, `src/captureWorklet.ts`. `scripts/dev.ts` serves it.
- `static/` — `diag.html` and `styles.css`. Every asset path is relative.
- `src/diag.ts` — diag page: send text and files by sound, receive, log.
- `src/adapters/` — the only browser-API code besides the entries:
  `pageSound.ts` (`openSound`), `soundTransport.ts` (`SoundTransport`, a
  `PacketChannel`), `codecWorker.ts`, `microphone.ts`, `speaker.ts`.
- `src/codecWorker.ts` — worker hosting ggwave, so the page bundle carries no
  WASM. Page code imports `PACKET_SECONDS` from `protocol.ts`, not `ggwave.ts`.
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
- `channel.ts` — `PacketChannel`: `send(packets, signal)` and `onPacket`.
- `receiver.ts` — `Receiver`: one decoder per interleaved transfer, evicts stale
  ones.
- `session.ts` — `sendBundle` (bursts of `listenEvery`, then a listen window,
  until DONE) and `receiveBundle` (sends DONE, finishes after `silenceMs`).
- `sound/` — ggwave wrapper (`ggwave.ts`), `SoundEncoder`, `SoundDecoder`, and
  the codec worker's message types.

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

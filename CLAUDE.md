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
- **Imports:** `@std/assert`, and `@/` for `./src/`.

## `src/lib/`

The protocol layer. Spec: `docs/specs/2026-09-14-transfer-protocol.md` (local,
gitignored).

- `protocol.ts` — wire constants: version, packet sizes, `MAX_K`.
- `crc16.ts` — CRC-16/CCITT-FALSE over the packet.
- `packet.ts` — 64-byte packet codec; rejects bad CRC, version, or type.
- `bundle.ts` — items to one byte string: deflate-raw plus truncated SHA-256.
- `fountain/symbols.ts` — `blockCount`, and `blockSet`: which blocks a symbol id
  XORs (systematic below K, robust soliton LT above).
- `fountain/encoder.ts` — `Encoder`: an endless stream of packets for a bundle.
- `fountain/decoder.ts` — `Decoder`: peeling, then Gaussian elimination over
  GF(2) when peeling stalls; returns the zero-padded bundle.

Wire facts (multi-byte fields big-endian):

- Packet, 64 bytes:
  `version 4b | type 4b | transferId 16b | k 24b | symbolId 24b | data 53B | crc16`.
  Types: `Data`, `DataListen`, `Done`.
- Bundle:
  `u32 length | deflate-raw(u32 manifestLength | manifest JSON | item bytes...) | sha256[0..8]`.
  `length` counts compressed bytes plus hash, so block padding past it is
  ignored.
- `blockSet(transferId, symbolId, k)` must never change output without a
  `PROTOCOL_VERSION` bump: sender and receiver derive block sets independently,
  and `symbols.test.ts` pins golden values. It avoids `Math.log`/`Math.sqrt`
  because engines may differ in the last bit.

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

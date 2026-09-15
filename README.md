# Air X

Air exchange: send contacts, text, images, and files to the person right next to
you, with no server, no account, and no network. Two devices pass data directly
by sound ([ggwave](https://github.com/ggerganov/ggwave)) or by QR code. The two
channels are interchangeable, so a noisy room or a broken camera never blocks a
transfer.

A sibling of [airgap](https://github.com/JakeAve/airgap), which uses the same
transports for two-player games. Built with Deno, TypeScript, and plain HTML and
CSS.

## Setup

Requires [Deno](https://deno.com) 2.x.

```bash
deno task setup   # installs the git hooks (run once after cloning)
```

## Commands

```bash
deno task check   # fmt check + lint + type check
deno task test    # unit tests
```

`deno task test` covers the protocol layer in `src/lib/`: packet and bundle
codecs, and the fountain code under simulated packet loss.

The pre-commit and pre-push hooks run `check` and `test`.

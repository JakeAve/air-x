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
deno task dev     # builds to dist/ and serves it on port 8444, rebuilding on change
```

## Commands

```bash
deno task check   # fmt check + lint + type check
deno task test    # unit tests
deno task build   # production build to dist/
```

`deno task test` covers the protocol layer in `src/lib/`: packet and bundle
codecs, and the fountain code under simulated packet loss.

The pre-commit and pre-push hooks run `check` and `test`.

## Testing on phones

Open `https://<host>:8444/diag.html` on two devices: type text or pick files on
one and press Send, press Listen on the other. The page logs loss, rejected
packets, and when DONE is sent and heard. Browsers only allow the microphone on
secure origins, so for local testing over Wi-Fi the dev server needs a
certificate. With [mkcert](https://github.com/FiloSottile/mkcert):

```bash
mkdir -p .certs
mkcert -cert-file .certs/cert.pem -key-file .certs/key.pem localhost 192.168.1.10
deno task dev   # now serves https on port 8444
```

Replace the IP with your machine's LAN address. On each phone, install and trust
mkcert's root CA, `rootCA.pem` from the directory `mkcert -CAROOT` prints.

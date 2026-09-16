# Air X

Air exchange: send contacts, text, images, and files to the person right next to
you, with no server, no account, and no network. Two devices pass data directly
by sound ([ggwave](https://github.com/ggerganov/ggwave) or
[libquiet](https://github.com/quiet/quiet-js)) or by QR code. The two channels
are interchangeable, so a noisy room or a broken camera never blocks a transfer.

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
deno task e2e     # headless receive test: sound in, item out
```

`deno task test` covers the protocol layer in `src/lib/`: packet and bundle
codecs, and the fountain code under simulated packet loss.

`deno task e2e` builds the site, feeds a transfer's packets to headless
Chromium's fake microphone, and checks the diag page receives the item. It needs
Playwright's Chromium installed once:

```bash
deno run -A npm:playwright install chromium
```

The pre-commit and pre-push hooks run `check` and `test`.

## Testing on phones

Open `https://<host>:8444/diag.html` on two devices. Tap Send on one, type text
or pick files, and press Send; tap Receive on the other and press Listen. Send
by picks QR, sound, or both (it defaults to both for bundles up to 2 KB, else
QR) and the line under it estimates how long each channel would take. Tuning
inputs live under Advanced on each screen, and Start over in the top strip
returns to the first screen. The log at the bottom records loss, rejected
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

### QR between two phones

1. On the receiver, leave Scan QR with camera on and press Listen. The rear
   camera opens; use Flip camera under the preview if it shows your face.
2. On the sender, turn screen brightness all the way up, type something, and
   press Send. The code fills the screen.
3. Point the receiver's rear camera at the sender's screen, close enough that
   the code fills most of the preview, and hold steady.
4. The receiver shows blocks resolved, and under the preview the codes found per
   frames scanned and new packets per second. If few frames yield a code, lower
   packets per code (smaller, coarser codes) or codes per second (each code
   stays up longer) under the sender's Advanced, or raise scan max edge under
   the receiver's. If nearly every frame decodes, raise packets per code or
   codes per second for throughput.

DONE always goes back by sound, so keep both phones' volume up even when sending
by QR only.

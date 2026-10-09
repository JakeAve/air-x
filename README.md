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
deno task dev     # builds to dist/ and serves it on port 8444, rebuilding on change (see Testing on phones)
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

Browsers only allow the microphone and camera on secure origins, so the dev
server serves HTTPS with a certificate it makes itself. The one thing to install
is [mkcert](https://github.com/FiloSottile/mkcert) (`brew install mkcert`, or
see its README for other systems).

```bash
deno task dev
```

It prints the addresses to open, one per network this machine is on:

```
serving dist/ on this machine: https://localhost:8444
from a phone on this network: https://<this machine's address>:8444
```

The certificate covers whatever addresses the machine has at start and is remade
when they change, so nothing here is tied to one network. It is kept in the main
checkout's `.certs/` (gitignored) and shared by every git worktree.

Each device has to trust mkcert's root certificate once:

- **This machine:** `mkcert -install` (asks for your password).
- **iPhone or iPad:** open `https://<address>:8444/rootCA.pem` in Safari, go
  past the warning, and allow the profile download. Install it under Settings >
  General > VPN & Device Management, then switch it on under Settings > General
  > About > Certificate Trust Settings.
- **Android:** open the same address, download the file, and install it under
  Settings > Security > Encryption & credentials > Install a certificate > CA
  certificate.

The root certificate is public; its key never leaves `mkcert -CAROOT`.

Then open the printed address on two devices. Tap Send on one, type text or pick
files, and press Send; tap Receive on the other and press Receive. Send by picks
QR or sound (it defaults to sound for bundles up to 2 KB, else QR) and the line
under it estimates how long each would take. Tuning inputs live under Advanced
on each screen, and Start over in the top strip returns to the first screen.

### Reading a phone's log

The dev server prints every device's page log, uncaught errors, and requests in
its own terminal, each line tagged with the device's address, so nothing has to
be read off a phone screen:

```
[192.168.1.23] GET /
[192.168.1.23] page open: Mozilla/5.0 (iPhone; ...
[192.168.1.23] 03:17:44.403 receive: transfer 38217 complete after 46.8 s, ...
```

This is added by the dev server as it serves each page. None of it is in
`dist/`, so none of it ships.

### When it does not work

- **No line from the device when it loads the page.** It is not reaching this
  server: check it is on the same network and using an address the server
  printed, with `https://`.
- **"Cannot establish a secure connection", or a warning that will not go
  away.** The device does not trust the root certificate yet (above), or the
  machine's address changed while the server was running: restart it.
- **Receive ends with `rejected N` and `sound 0, qr 0`.** The two devices run
  different builds, so one rejects the other's packets. Reload both from this
  server. A device that keeps an old build has it cached: run the server on
  another port, which is a clean origin, with `PORT=8450 deno task dev`.
- **The port is taken.** Same: `PORT=8450 deno task dev`.

### QR between two phones

1. On the receiver, leave Scan QR with camera on and press Receive. The rear
   camera opens; use Flip camera under the preview if it shows your face.
2. On the sender, turn screen brightness all the way up, type something, and
   press Send. The code fills the screen.
3. Point the receiver's rear camera at the sender's screen, close enough that
   the code fills most of the preview, and hold steady.
4. The receiver shows blocks resolved, and under the preview the codes found per
   frames scanned and new packets per second.

The receiver chirps an ack every "ack every" symbols (under its Advanced; 0
turns acks off) saying how much it heard and, late in the transfer, which blocks
it still misses. With "Adapt rate to acks" on under the sender's Advanced, the
sender uses those to raise or lower packets per code and codes per second by
itself, and logs each change as `send: rate now ...`. Turn it off to hold the
rate you set. DONE and acks always go back by sound, so keep both phones' volume
up even when sending by QR.

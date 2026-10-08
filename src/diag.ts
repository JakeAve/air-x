import { openDevices } from "@/adapters/pageLink.ts";
import type { QrTransport } from "@/adapters/qrTransport.ts";
import type { SoundTransport } from "@/adapters/soundTransport.ts";
import { encodeBundle, type Item } from "@/lib/bundle.ts";
import { blockCount } from "@/lib/fountain/symbols.ts";
import { receiveBundle, sendBundle } from "@/lib/session.ts";
import { PACKET_SECONDS } from "@/lib/protocol.ts";
import type { QrEcc } from "@/lib/qr/qrEncoder.ts";
import type { SoundProtocol } from "@/lib/sound/ggwave.ts";

const SILENCE_MS = 12_000;
const SOUND_DEFAULT_MAX_BYTES = 2048;
/** Packets the sender expects to need: k plus 10 % repair. */
const OVERHEAD = 1.1;

function $<T extends HTMLElement>(id: string): T {
  return document.getElementById(id) as T;
}

const main = $<HTMLElement>("main");
const sendForm = $<HTMLDivElement>("send-form");
const sendRun = $<HTMLDivElement>("send-run");
const sendTitle = $<HTMLHeadingElement>("send-title");
const sendText = $<HTMLTextAreaElement>("send-text");
const sendFiles = $<HTMLInputElement>("send-files");
const sendEstimate = $<HTMLParagraphElement>("send-estimate");
const packetsPerCodeInput = $<HTMLInputElement>("packets-per-code");
const fpsInput = $<HTMLInputElement>("fps");
const eccSelect = $<HTMLSelectElement>("ecc");
const protocolSelect = $<HTMLSelectElement>("protocol");
const listenEveryInput = $<HTMLInputElement>("listen-every");
const windowMsInput = $<HTMLInputElement>("window-ms");
const qrCanvas = $<HTMLCanvasElement>("qr-canvas");
const sendButton = $<HTMLButtonElement>("send");
const receiveForm = $<HTMLDivElement>("receive-form");
const receiveRun = $<HTMLDivElement>("receive-run");
const receiveTitle = $<HTMLHeadingElement>("receive-title");
const cameraToggle = $<HTMLInputElement>("camera");
const flipButton = $<HTMLButtonElement>("flip");
const preview = $<HTMLVideoElement>("preview");
const scanMaxEdgeInput = $<HTMLInputElement>("scan-max-edge");
const turnaroundMsInput = $<HTMLInputElement>("turnaround-ms");
const ackAfterMsInput = $<HTMLInputElement>("ack-after-ms");
const listenButton = $<HTMLButtonElement>("listen");
const receivedItems = $<HTMLUListElement>("received-items");
const logEl = $<HTMLPreElement>("log");

function log(line: string) {
  const time = new Date().toISOString().slice(11, 23);
  logEl.textContent += `${time} ${line}\n`;
}

function show(id: string, value: string | number) {
  $(id).textContent = String(value);
}

function seconds(ms: number): string {
  return `${(ms / 1000).toFixed(1)} s`;
}

function about(s: number): string {
  if (s < 1) return "under 1 s";
  if (s < 90) return `about ${Math.round(s)} s`;
  if (s < 5400) return `about ${Math.round(s / 60)} min`;
  return `about ${(s / 3600).toFixed(1)} h`;
}

function size(bytes: number): string {
  return bytes < 1024 ? `${bytes} B` : `${(bytes / 1024).toFixed(1)} KB`;
}

function positive(input: HTMLInputElement, fallback: number): number {
  return Math.max(0, Number(input.value) || 0) || fallback;
}

// Packet grids: one cell per block (receive) or per expected packet (send).
// Past MAX_CELLS each cell stands for a run of ceil(n / MAX_CELLS).
// Cell states: 0 unlit, 1 mango frame (pending / partial), 2 mango, 3 white.
const MAX_CELLS = 512;

// Columns for `cells` tiles spread over a `w` by `h` box: about as wide as
// tall for that box, preferring a count that fills the last row, and unless
// the tiles `cover` the box with their spacing, never so few that square
// tiles would overflow its height (32 columns max).
function columns(cells: number, w: number, h: number, cover: boolean) {
  if (cells <= 8) return Math.max(1, cells);
  const target = Math.sqrt(cells * w / Math.max(1, h));
  const fits = (c: number) =>
    cover || c === 32 || Math.ceil(cells / c) * (w / c) <= h;
  let best = 0;
  let bestScore = Infinity;
  for (let c = Math.ceil(target * 0.7); c <= 32; c++) {
    if (!fits(c)) continue;
    if (c > Math.ceil(target * 1.25) && best) break;
    const empty = (c - cells % c) % c;
    const score = empty * 100 + Math.abs(c - target);
    if (score < bestScore) [best, bestScore] = [c, score];
  }
  return best || 32;
}

// Standing alone the tiles are squares the columns size, bounded by the box.
// With `cover` (over the camera) each tile is 80% of its slot and the spacing
// spreads the field over the whole box.
function gridReset(id: string, n: number, w: number, h: number, cover = false) {
  const el = $(id);
  el.hidden = false;
  const per = Math.ceil(n / MAX_CELLS);
  const cells = Math.ceil(n / per);
  el.dataset.per = String(per);
  const cols = columns(cells, w, h, cover);
  el.style.setProperty("--cols", String(cols));
  el.style.setProperty("--cell-gap", cols <= 16 ? "0.25rem" : "0.125rem");
  if (cover) {
    const rows = Math.ceil(cells / cols);
    const px = Math.min(w / cols, h / rows) * 0.8;
    const rem = parseFloat(getComputedStyle(document.documentElement).fontSize);
    el.style.setProperty("--cell", `${(px / rem).toFixed(3)}rem`);
  }
  el.replaceChildren(
    ...Array.from({ length: cells }, () => document.createElement("i")),
  );
}

function gridMark(id: string, index: number, state: number) {
  const el = $(id);
  const cell = Math.floor(index / Number(el.dataset.per || 1));
  while (el.children.length <= cell) el.append(document.createElement("i"));
  (el.children[cell] as HTMLElement).dataset.s = String(state);
}

function gridPaint(id: string, states: Uint8Array) {
  const el = $(id);
  const per = Number(el.dataset.per || 1);
  for (let c = 0; c < el.children.length; c++) {
    let min = 2, max = 0;
    for (let b = c * per; b < Math.min(states.length, (c + 1) * per); b++) {
      if (states[b] < min) min = states[b];
      if (states[b] > max) max = states[b];
    }
    (el.children[c] as HTMLElement).dataset.s = String(
      min === 2 ? 2 : max ? 1 : 0,
    );
  }
}

// Screens: the hash picks one; leaving a screen stops whatever it was doing.
const SCREENS = ["home", "send", "receive"];
let running: AbortController | undefined;

function showScreen() {
  const name = location.hash.slice(1);
  const screen = SCREENS.includes(name) ? name : "home";
  running?.abort();
  main.dataset.screen = screen;
  for (const id of SCREENS) $(`screen-${id}`).hidden = id !== screen;
}
addEventListener("hashchange", showScreen);
showScreen();

const protocol = () => protocolSelect.value as SoundProtocol;

const turnaroundMs = () => Math.max(0, Number(turnaroundMsInput.value) || 0);

const sendBy = () =>
  (document.querySelector('input[name="send-by"]:checked') as HTMLInputElement)
    .value as "qr" | "sound";

let windowEdited = false;
let turnaroundEdited = false;
function defaults() {
  if (!turnaroundEdited) {
    turnaroundMsInput.value = protocol().includes("ultrasound") ? "1000" : "50";
  }
  if (!windowEdited) {
    windowMsInput.value = String(
      turnaroundMs() + PACKET_SECONDS[protocol()] * 1000 + 500,
    );
  }
}
defaults();
windowMsInput.addEventListener("input", () => windowEdited = true);
turnaroundMsInput.addEventListener("input", () => {
  turnaroundEdited = true;
  defaults();
});
protocolSelect.addEventListener("change", () => {
  defaults();
  if (devices) devices.sound.protocol = protocol();
});
scanMaxEdgeInput.addEventListener("change", () => {
  if (devices) devices.qr.scanMaxEdge = positive(scanMaxEdgeInput, 1280);
});

type Devices = { sound: SoundTransport; qr: QrTransport };
let devices: Devices | undefined;
let opening: Promise<Devices> | undefined;

function getDevices(): Promise<Devices> {
  opening ??= openDevices(qrCanvas, preview).then(
    ({ sound, qr, sampleRate }) => {
      sound.log = log;
      sound.protocol = protocol();
      qr.scanMaxEdge = positive(scanMaxEdgeInput, 1280);
      devices = { sound, qr };
      log(`audio context at ${sampleRate} Hz`);
      return devices;
    },
    (err) => {
      opening = undefined;
      throw err;
    },
  );
  return opening;
}

function ticker(id: string, start: number, suffix = ""): () => void {
  const tick = () => show(id, seconds(performance.now() - start) + suffix);
  const timer = setInterval(tick, 250);
  tick();
  return () => {
    clearInterval(timer);
    tick();
  };
}

/** Packets per second each channel manages with the current settings. */
function rates() {
  const packetsPerCode = Math.max(
    1,
    Math.round(positive(packetsPerCodeInput, 8)),
  );
  const fps = positive(fpsInput, 5);
  const listenEvery = Math.max(1, Math.round(positive(listenEveryInput, 8)));
  const windowMs = Math.max(0, Number(windowMsInput.value) || 0);
  const gapMs = devices?.sound.gapMs ?? 150;
  const soundPerSecond = listenEvery * 1000 /
    (listenEvery * (PACKET_SECONDS[protocol()] * 1000 + gapMs) + windowMs);
  return {
    packetsPerCode,
    fps,
    listenEvery,
    windowMs,
    qrPerSecond: packetsPerCode * fps,
    soundPerSecond,
  };
}

async function collectItems(): Promise<Item[]> {
  const items: Item[] = [];
  if (sendText.value) {
    items.push({
      name: "message.txt",
      type: "text/plain",
      bytes: new TextEncoder().encode(sendText.value),
    });
  }
  for (const file of sendFiles.files ?? []) {
    items.push({
      name: file.name,
      type: file.type || "application/octet-stream",
      bytes: new Uint8Array(await file.arrayBuffer()),
    });
  }
  return items;
}

let sendByEdited = false;
let sizing = 0;
let sizeTimer: ReturnType<typeof setTimeout> | undefined;
for (const radio of document.querySelectorAll('input[name="send-by"]')) {
  radio.addEventListener("change", () => sendByEdited = true);
}

function itemsChanged() {
  clearTimeout(sizeTimer);
  sizeTimer = setTimeout(async () => {
    const run = ++sizing;
    const items = await collectItems();
    const bytes = items.length ? (await encodeBundle(items)).length : 0;
    if (run !== sizing) return;
    if (!bytes) {
      sendEstimate.textContent = "Nothing to send yet";
      return;
    }
    if (!sendByEdited) {
      const pick = bytes <= SOUND_DEFAULT_MAX_BYTES ? "sound" : "qr";
      (document.querySelector(
        `input[name="send-by"][value="${pick}"]`,
      ) as HTMLInputElement).checked = true;
    }
    const n = Math.ceil(OVERHEAD * blockCount(bytes));
    const { qrPerSecond, soundPerSecond } = rates();
    sendEstimate.textContent = `${size(bytes)} · ${
      about(n / qrPerSecond)
    } by QR · ${about(n / soundPerSecond)} by sound`;
  }, 300);
}
sendForm.addEventListener("input", itemsChanged);

sendButton.addEventListener("click", async () => {
  if (running) {
    running.abort();
    return;
  }
  // openDevices first, synchronously: iOS only lets an AudioContext made inside the gesture run.
  const opened = getDevices();
  const controller = new AbortController();
  running = controller;
  let stopTicker: (() => void) | undefined;
  let result: "done" | "stopped" | undefined;
  try {
    const [{ sound, qr }, items] = await Promise.all([opened, collectItems()]);
    if (!items.length) {
      log("send: nothing to send");
      return;
    }
    const by = sendBy();
    try {
      await sound.listen();
    } catch (err) {
      log(`send: microphone unavailable, DONE will not be heard (${err})`);
    }
    sound.protocol = protocol();
    qr.ecc = eccSelect.value as QrEcc;
    const bundle = await encodeBundle(items);
    const {
      packetsPerCode,
      fps,
      listenEvery,
      windowMs,
      qrPerSecond,
      soundPerSecond,
    } = rates();
    const perSecond = by === "qr" ? qrPerSecond : soundPerSecond;
    const n = Math.ceil(OVERHEAD * blockCount(bundle.length));
    sendTitle.textContent = "sending";
    sendForm.hidden = true;
    sendRun.hidden = false;
    qrCanvas.hidden = by !== "qr";
    gridReset("send-grid", n, $("send-grid").clientWidth, innerHeight / 2);
    show("send-count", `0 of ${n} packets`);
    sendButton.textContent = "Stop";
    sendButton.classList.remove("primary");
    const start = performance.now();
    stopTicker = ticker(
      "send-time",
      start,
      ` of ${about(n / perSecond)}`,
    );
    log(
      `send: ${items.length} item(s), ${bundle.length} bytes` +
        (by === "qr"
          ? `, qr ${packetsPerCode}/code @ ${fps} fps ${qr.ecc}`
          : `, sound ${sound.protocol} listenEvery ${listenEvery} window ${windowMs} ms`),
    );
    let announced = false;
    // Past the first n packets the grid empties and refills once per pass.
    let pass = 0;
    let ackedSoFar = 0;
    result = await sendBundle(bundle, {
      listen: sound,
      sound: by === "sound"
        ? { channel: sound, listenEvery, windowMs }
        : undefined,
      qr: by === "qr" ? { display: qr, packetsPerCode, fps } : undefined,
      signal: controller.signal,
      onProgress: (
        { transferId, k, soundSent, qrSent, via, symbolIds, acked },
      ) => {
        const sent = soundSent + qrSent;
        if (acked > ackedSoFar) {
          log(`send: ack heard: ${acked - ackedSoFar} blocks`);
          ackedSoFar = acked;
        }
        for (const id of symbolIds) {
          if (Math.floor(id / n) > pass) {
            pass = Math.floor(id / n);
            for (const cell of $("send-grid").children) {
              (cell as HTMLElement).dataset.s = "0";
            }
          }
          gridMark("send-grid", id % n, via === "qr" ? 2 : 3);
        }
        show(
          "send-count",
          pass ? `${n} packets · pass ${pass + 1}` : `${sent} of ${n} packets`,
        );
        if (!announced) {
          announced = true;
          log(`send: transfer ${transferId}, k ${k}`);
        }
      },
    });
    const elapsed = seconds(performance.now() - start);
    log(
      result === "done"
        ? `send: DONE heard after ${elapsed}`
        : `send: stopped after ${elapsed}`,
    );
    if (result === "done") {
      stopTicker();
      stopTicker = undefined;
      $("send-grid").hidden = true;
      show("send-time", `${elapsed} · DONE heard`);
    }
  } catch (err) {
    log(`send failed: ${err}`);
  } finally {
    stopTicker?.();
    running = undefined;
    qrCanvas.hidden = true;
    sendRun.hidden = result !== "done";
    sendForm.hidden = false;
    sendTitle.textContent = result === "done" ? "sent" : "send";
    sendButton.textContent = "Send";
    sendButton.classList.add("primary");
  }
});

let objectUrls: string[] = [];

function renderItem(item: Item) {
  const li = document.createElement("li");
  const blob = new Blob([item.bytes as Uint8Array<ArrayBuffer>], {
    type: item.type,
  });
  const url = URL.createObjectURL(blob);
  objectUrls.push(url);
  const meta = document.createElement("div");
  meta.className = "meta";
  const name = document.createElement("span");
  name.textContent = `${item.name} · ${item.type} · ${size(item.bytes.length)}`;
  const link = document.createElement("a");
  link.href = url;
  link.download = item.name;
  link.textContent = "Download";
  meta.append(name, link);
  li.append(meta);
  if (item.type.startsWith("text/")) {
    const text = document.createElement("pre");
    text.textContent = new TextDecoder().decode(item.bytes);
    li.append(text);
  }
  receivedItems.append(li);
}

let scanningQr = false;

async function watchCamera(qr: QrTransport) {
  try {
    await qr.watch();
    log(`camera: watching (${qr.facing})`);
  } catch (err) {
    log(`camera failed: ${err}`);
  }
  preview.hidden = flipButton.hidden = !qr.watching;
}

function closeCamera() {
  devices?.qr.stopWatching();
  preview.hidden = flipButton.hidden = true;
}

cameraToggle.addEventListener("change", () => {
  if (!devices) return;
  if (!cameraToggle.checked) {
    closeCamera();
  } else if (scanningQr) {
    watchCamera(devices.qr);
  }
});

flipButton.addEventListener("click", async () => {
  const opened = getDevices();
  flipButton.disabled = true;
  try {
    const { qr } = await opened;
    await qr.flip();
    log(`camera: facing ${qr.facing}`);
  } catch (err) {
    log(`flip failed: ${err}`);
  } finally {
    flipButton.disabled = false;
  }
});

listenButton.addEventListener("click", async () => {
  if (running) {
    running.abort();
    return;
  }
  // openDevices first, synchronously: iOS only lets an AudioContext made inside the gesture run.
  const opened = getDevices();
  const controller = new AbortController();
  running = controller;
  let stopTicker: (() => void) | undefined;
  let received = false;
  receiveTitle.textContent = "listening";
  receiveForm.hidden = true;
  receiveRun.hidden = false;
  listenButton.textContent = "Stop";
  listenButton.classList.remove("primary");
  gridReset("rx-grid", 0, 1, 1);
  show("rx-count", "waiting for a transfer");
  try {
    const { sound, qr } = await opened;
    scanningQr = cameraToggle.checked;
    await Promise.all([sound.listen(), scanningQr && watchCamera(qr)]);
    for (const url of objectUrls) URL.revokeObjectURL(url);
    objectUrls = [];
    receivedItems.replaceChildren();
    Object.assign(qr.stats, { frames: 0, codes: 0, packets: 0 });
    const start = performance.now();
    stopTicker = ticker("rx-time", start);
    const turnaround = turnaroundMs();
    const ackAfter = Math.max(0, Number(ackAfterMsInput.value) || 0);
    log(
      `receive: listening, camera ${
        scanningQr ? "on" : "off"
      }, turnaround ${turnaround} ms, ack after ${ackAfter || "never"}${
        ackAfter ? " ms" : ""
      }`,
    );
    let counts = "sound 0, qr 0, rejected 0";
    let shown: number | undefined;
    const done = await receiveBundle({
      sound,
      sources: scanningQr ? [qr] : undefined,
      silenceMs: SILENCE_MS,
      turnaroundMs: turnaround,
      ackAfterMs: ackAfter || undefined,
      onAck: (transferId, runs) => {
        const blocks = runs.reduce((sum, r) => sum + r.length, 0);
        log(
          `receive: transfer ${transferId} ack: ${blocks} blocks in ${runs.length} runs`,
        );
      },
      signal: controller.signal,
      onProgress: (
        {
          soundHeard,
          sourceHeard: qrHeard,
          rejected,
          transfers,
        },
      ) => {
        counts = `sound ${soundHeard}, qr ${qrHeard}, rejected ${rejected}`;
        const t = transfers.reduce(
          (best, t) => t.resolved > best.resolved ? t : best,
          transfers[0],
        );
        if (t) {
          if (t.transferId !== shown) {
            shown = t.transferId;
            if (preview.hidden) {
              gridReset(
                "rx-grid",
                t.k,
                $("rx-grid").clientWidth,
                innerHeight / 2,
              );
            } else {
              gridReset(
                "rx-grid",
                t.k,
                preview.clientWidth,
                preview.clientHeight,
                true,
              );
            }
          }
          gridPaint("rx-grid", t.states());
          show("rx-count", `${t.resolved} of ${t.k} blocks`);
        }
      },
      onComplete: ({ transferId, items }) => {
        received = true;
        $("rx-grid").hidden = true;
        log(
          `receive: transfer ${transferId} complete after ${
            seconds(performance.now() - start)
          }, ${items.length} item(s), ${counts}`,
        );
        items.forEach(renderItem);
      },
      onDone: (transferId) => {
        stopTicker?.();
        stopTicker = undefined;
        show("rx-time", `${seconds(performance.now() - start)} · DONE sent`);
        log(
          `receive: DONE sent for ${transferId} after ${
            seconds(performance.now() - start)
          }`,
        );
      },
    });
    log(
      done
        ? `receive: finished transfer ${done.transferId}, ${counts}`
        : `receive: stopped with nothing received, ${counts}`,
    );
  } catch (err) {
    log(`receive failed: ${err}`);
  } finally {
    stopTicker?.();
    running = undefined;
    scanningQr = false;
    closeCamera();
    receiveRun.hidden = !received;
    receiveForm.hidden = false;
    receiveTitle.textContent = received ? "received" : "receive";
    listenButton.textContent = "Listen";
    listenButton.classList.add("primary");
  }
});

// Installs the app for offline use; the page works without it.
navigator.serviceWorker?.register("./sw.js");

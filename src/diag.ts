import { cameraCodecs, openDevices } from "@/adapters/pageLink.ts";
import type { QrTransport } from "@/adapters/qrTransport.ts";
import type { SoundTransport } from "@/adapters/soundTransport.ts";
import { encodeBundle, type Item } from "@/lib/bundle.ts";
import { OVERHEAD } from "@/lib/cameraCodec.ts";
import { blockCount } from "@/lib/fountain/symbols.ts";
import { ackShare, decodeAck, decodePacket, PacketType } from "@/lib/packet.ts";
import { receiveBundle, sendBundle } from "@/lib/session.ts";
import { PACKET_SECONDS, SOUND_PACKET_BYTES } from "@/lib/protocol.ts";
import { type CameraRate, ladderPolicy, SILENT_AFTER } from "@/lib/rate.ts";
import type { QrEcc } from "@/lib/qr/qrEncoder.ts";
import type { SoundProtocol } from "@/lib/sound/ggwave.ts";

const SILENCE_MS = 12_000;
/** How often a receive logs what its camera scan has seen. */
const SCAN_REPORT_MS = 5_000;
const SOUND_DEFAULT_MAX_BYTES = 2048;

function $<T extends HTMLElement>(id: string): T {
  return document.getElementById(id) as T;
}

const main = $<HTMLElement>("main");
const sendForm = $<HTMLDivElement>("send-form");
const sendRun = $<HTMLDivElement>("send-run");
const sendTitle = $<HTMLHeadingElement>("send-title");
const sendText = $<HTMLTextAreaElement>("send-text");
const sendFiles = $<HTMLInputElement>("send-files");
const sendFilesClear = $<HTMLButtonElement>("send-files-clear");
const sendItems = $<HTMLUListElement>("send-items");
const sendEstimate = $<HTMLParagraphElement>("send-estimate");
const packetsPerCodeInput = $<HTMLInputElement>("packets-per-code");
const fpsInput = $<HTMLInputElement>("fps");
const eccSelect = $<HTMLSelectElement>("ecc");
const adaptRateToggle = $<HTMLInputElement>("adapt-rate");
const protocolSelect = $<HTMLSelectElement>("protocol");
const listenEveryInput = $<HTMLInputElement>("listen-every");
const windowMsInput = $<HTMLInputElement>("window-ms");
const qrCanvas = $<HTMLCanvasElement>("qr-canvas");
const cameraFrame = $<HTMLDivElement>("camera-frame");
const cameraLine = $<HTMLParagraphElement>("camera-line");
const cameraStop = $<HTMLButtonElement>("camera-stop");
const cameraCodecSelect = $<HTMLSelectElement>("camera-codec");
const sendButton = $<HTMLButtonElement>("send");
const receiveForm = $<HTMLDivElement>("receive-form");
const receiveRun = $<HTMLDivElement>("receive-run");
const receiveTitle = $<HTMLHeadingElement>("receive-title");
const cameraToggle = $<HTMLInputElement>("camera");
const flipButton = $<HTMLButtonElement>("flip");
const preview = $<HTMLVideoElement>("preview");
const scanMaxEdgeInput = $<HTMLInputElement>("scan-max-edge");
const turnaroundMsInput = $<HTMLInputElement>("turnaround-ms");
const ackEveryInput = $<HTMLInputElement>("ack-every");
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

function percent(share: number | undefined): string {
  return share === undefined ? "–" : `${Math.round(share * 100)}%`;
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
// tall for that box, preferring a count that fills the last row, and never so
// few that square tiles would overflow its height (32 columns max).
function columns(cells: number, w: number, h: number) {
  if (cells <= 8) return Math.max(1, cells);
  const target = Math.sqrt(cells * w / Math.max(1, h));
  const fits = (c: number) => c === 32 || Math.ceil(cells / c) * (w / c) <= h;
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

// The tiles are squares the columns size, bounded by the box.
function gridReset(id: string, n: number, w: number, h: number) {
  const el = $(id);
  el.hidden = false;
  const per = Math.ceil(n / MAX_CELLS);
  const cells = Math.ceil(n / per);
  el.dataset.per = String(per);
  const cols = columns(cells, w, h);
  el.style.setProperty("--cols", String(cols));
  el.style.setProperty("--cell-gap", cols <= 16 ? "0.25rem" : "0.125rem");
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
    .value as "camera" | "sound";

type CodecName = keyof ReturnType<typeof cameraCodecs>;
const cameraCodec = () => cameraCodecSelect.value as CodecName;
// Encoders for the estimate before a gesture has opened the devices.
const idleCodecs = cameraCodecs({
  onPacket: () => () => {},
  show() {},
  clear() {},
});

function showCodecFields() {
  for (const el of document.querySelectorAll<HTMLElement>("[data-codec]")) {
    el.hidden = el.dataset.codec !== cameraCodec();
  }
}
showCodecFields();
cameraCodecSelect.addEventListener("change", showCodecFields);

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

type Devices = {
  sound: SoundTransport;
  qr: QrTransport;
  codecs: ReturnType<typeof cameraCodecs>;
};
let devices: Devices | undefined;
let opening: Promise<Devices> | undefined;

function getDevices(): Promise<Devices> {
  opening ??= openDevices(qrCanvas, preview).then(
    ({ sound, qr, codecs, sampleRate }) => {
      sound.log = log;
      sound.protocol = protocol();
      qr.scanMaxEdge = positive(scanMaxEdgeInput, 1280);
      devices = { sound, qr, codecs };
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
    Math.round(positive(packetsPerCodeInput, 4)),
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
    cameraRate: { packetsPerCode, fps },
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
  for (const file of picked) {
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

// The cards are the list: a fresh pick replaces it, and each card can remove its file.
let picked: File[] = [];
let sendUrls: string[] = [];
const EXCERPT_BYTES = 280;

function setPicked(files: File[]) {
  picked = files;
  if (!files.length) sendFiles.value = "";
  sendFilesClear.hidden = !files.length;
  for (const url of sendUrls) URL.revokeObjectURL(url);
  sendUrls = [];
  sendItems.replaceChildren(...files.map(fileCard));
  itemsChanged();
}

function fileCard(file: File) {
  const type = file.type || "application/octet-stream";
  const { li, meta } = itemCard(file.name, type, file.size);
  let url: string | undefined;
  if (type.startsWith("image/")) {
    url = URL.createObjectURL(file);
    sendUrls.push(url);
    li.append(thumbnail(url));
  } else if (type.startsWith("text/")) {
    const pre = document.createElement("pre");
    li.append(pre);
    file.slice(0, EXCERPT_BYTES).text().then((text) =>
      pre.textContent = file.size > EXCERPT_BYTES ? `${text}…` : text
    );
  }
  const remove = document.createElement("a");
  remove.href = "#";
  remove.role = "button";
  setIcon(remove, "Remove");
  remove.addEventListener("click", (event) => {
    event.preventDefault();
    if (url) URL.revokeObjectURL(url);
    li.remove();
    picked = picked.filter((f) => f !== file);
    if (!picked.length) setPicked([]);
    else itemsChanged();
  });
  meta.append(remove);
  return li;
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
      const pick = bytes <= SOUND_DEFAULT_MAX_BYTES ? "sound" : "camera";
      (document.querySelector(
        `input[name="send-by"][value="${pick}"]`,
      ) as HTMLInputElement).checked = true;
    }
    const soundN = Math.ceil(OVERHEAD * blockCount(bytes, SOUND_PACKET_BYTES));
    const { cameraRate, soundPerSecond } = rates();
    sendEstimate.textContent = `${size(bytes)} · ${
      about(idleCodecs[cameraCodec()].encoder.seconds(bytes, cameraRate))
    } by camera · ${about(soundN / soundPerSecond)} by sound`;
  }, 300);
}
sendForm.addEventListener("input", itemsChanged);
sendFiles.addEventListener(
  "change",
  () => setPicked([...sendFiles.files ?? []]),
);
sendFilesClear.addEventListener("click", () => setPicked([]));
cameraStop.addEventListener("click", () => running?.abort());

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
  let stopAckLog: (() => void) | undefined;
  let result: "done" | "stopped" | undefined;
  try {
    const [{ sound, qr, codecs }, items] = await Promise.all([
      opened,
      collectItems(),
    ]);
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
    const { listenEvery, windowMs, cameraRate, soundPerSecond } = rates();
    const codec = cameraCodec();
    const encoder = codecs[codec].encoder;
    const n = Math.ceil(
      OVERHEAD * blockCount(bundle.length, SOUND_PACKET_BYTES),
    );
    sendTitle.textContent = "sending";
    sendForm.hidden = true;
    sendRun.hidden = false;
    cameraFrame.hidden = by !== "camera";
    $("send-grid").hidden = by !== "sound";
    if (by === "sound") {
      gridReset("send-grid", n, $("send-grid").clientWidth, innerHeight / 2);
      show("send-count", `0 of ${n} packets`);
    } else {
      show("send-count", "–");
      cameraLine.textContent = "heard – · 0.0 KB/s";
    }
    sendButton.textContent = "Stop";
    sendButton.classList.remove("primary");
    const start = performance.now();
    stopTicker = ticker(
      "send-time",
      start,
      ` of ${
        about(
          by === "camera"
            ? encoder.seconds(bundle.length, cameraRate)
            : n / soundPerSecond,
        )
      }`,
    );
    log(
      `send: ${items.length} item(s), ${bundle.length} bytes` +
        (by === "camera"
          ? `, camera ${encoder.name} ${cameraRate.packetsPerCode}/code @ ${cameraRate.fps} fps ${qr.ecc}${
            adaptRateToggle.checked ? ", adaptive" : ""
          }`
          : `, sound ${sound.protocol} listenEvery ${listenEvery} window ${windowMs} ms`),
    );
    let transfer: number | undefined;
    stopAckLog = sound.onPacket((bytes) => {
      const packet = decodePacket(bytes);
      if (packet?.type !== PacketType.Ack || packet.transferId !== transfer) {
        return;
      }
      const runs = decodeAck(packet.data);
      const share = ackShare(packet.data);
      log(
        `send: ack heard: ${
          runs.reduce((sum, r) => sum + r.length, 0)
        } blocks in ${runs.length} runs, heard ${percent(share)}`,
      );
    });
    // Past the first n packets the grid empties and refills once per pass.
    let pass = 0;
    let rateNow: CameraRate = cameraRate;
    const line = (share: number | undefined, freshBytes: number) =>
      `heard ${percent(share)} · ${
        (freshBytes / 1024 /
          Math.max(0.001, (performance.now() - start) / 1000))
          .toFixed(1)
      } KB/s`;
    let lastLine = "";
    result = await sendBundle(bundle, {
      listen: sound,
      sound: by === "sound"
        ? { channel: sound, listenEvery, windowMs }
        : undefined,
      camera: by === "camera"
        ? {
          encoder,
          rate: cameraRate,
          adapt: adaptRateToggle.checked
            ? { policy: ladderPolicy(), silentAfter: SILENT_AFTER }
            : undefined,
        }
        : undefined,
      signal: controller.signal,
      onProgress: (
        { transferId, k, soundSent, via, symbolIds, rate, share, freshBytes },
      ) => {
        if (transfer === undefined) {
          transfer = transferId;
          log(
            `send: transfer ${transferId}${k === undefined ? "" : `, k ${k}`}`,
          );
        }
        if (via === "camera") {
          if (
            rate &&
            (rate.packetsPerCode !== rateNow.packetsPerCode ||
              rate.fps !== rateNow.fps)
          ) {
            rateNow = rate;
            log(`send: rate now ${rate.packetsPerCode}/code @ ${rate.fps} fps`);
          }
          lastLine = line(share, freshBytes);
          cameraLine.textContent = lastLine;
          return;
        }
        for (const id of symbolIds) {
          if (Math.floor(id / n) > pass) {
            pass = Math.floor(id / n);
            for (const cell of $("send-grid").children) {
              (cell as HTMLElement).dataset.s = "0";
            }
          }
          gridMark("send-grid", id % n, 3);
        }
        show(
          "send-count",
          pass
            ? `${n} packets · pass ${pass + 1}`
            : `${soundSent} of ${n} packets`,
        );
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
      if (by === "camera") show("send-count", lastLine);
      show("send-time", `${elapsed} · DONE heard`);
    }
  } catch (err) {
    log(`send failed: ${err}`);
  } finally {
    stopTicker?.();
    stopAckLog?.();
    running = undefined;
    cameraFrame.hidden = true;
    sendRun.hidden = result !== "done";
    sendForm.hidden = false;
    sendTitle.textContent = result === "done" ? "sent" : "send";
    sendButton.textContent = "Send";
    sendButton.classList.add("primary");
  }
});

let objectUrls: string[] = [];

function itemCard(name: string, type: string, bytes: number) {
  const li = document.createElement("li");
  const meta = document.createElement("div");
  meta.className = "meta";
  const label = document.createElement("span");
  label.textContent = `${name} · ${type} · ${size(bytes)}`;
  meta.append(label);
  li.append(meta);
  return { li, meta };
}

function thumbnail(url: string) {
  const img = document.createElement("img");
  img.src = url;
  img.alt = "";
  return img;
}

function renderItem(item: Item) {
  const blob = new Blob([item.bytes as Uint8Array<ArrayBuffer>], {
    type: item.type,
  });
  const url = URL.createObjectURL(blob);
  objectUrls.push(url);
  const { li, meta } = itemCard(item.name, item.type, item.bytes.length);
  const link = document.createElement("a");
  link.href = url;
  link.download = item.name;
  setIcon(link, "Download");
  const isText = item.type.startsWith("text/");
  if (isText || item.type.startsWith("image/")) {
    meta.append(copyLink(blob, isText));
  }
  const viewType = openType(item.type);
  if (viewType) meta.append(openLink(item.bytes, viewType));
  meta.append(link);
  if (item.type.startsWith("image/")) li.append(thumbnail(url));
  else if (/^(video|audio)\//.test(item.type)) {
    const player = document.createElement(
      item.type.startsWith("video/") ? "video" : "audio",
    );
    player.src = url;
    player.controls = true;
    player.preload = "metadata";
    player.setAttribute("playsinline", "");
    li.append(player);
  }
  if (isText) {
    const text = document.createElement("pre");
    text.textContent = new TextDecoder().decode(item.bytes);
    li.append(text);
  }
  receivedItems.append(li);
}

// A blob URL opens with this page's origin, so the sender's markup or SVG opens
// as plain text, never as a page that could run script here.
function openType(type: string) {
  if (/^(image\/(?!svg)|video\/|audio\/)|^application\/pdf$/.test(type)) {
    return type;
  }
  if (/^text\/|svg|xml|json/.test(type)) return "text/plain;charset=utf-8";
}

function openLink(bytes: Uint8Array, type: string) {
  const url = URL.createObjectURL(
    new Blob([bytes as Uint8Array<ArrayBuffer>], { type }),
  );
  objectUrls.push(url);
  const open = document.createElement("a");
  open.href = url;
  open.target = "_blank";
  open.rel = "noopener";
  setIcon(open, "Open");
  return open;
}

// The clipboard takes text, and images only as PNG, so other images are redrawn as PNG.
function copyLink(blob: Blob, isText: boolean) {
  const copy = document.createElement("a");
  copy.href = "#";
  copy.role = "button";
  setIcon(copy, "Copy");
  copy.addEventListener("click", async (event) => {
    event.preventDefault();
    try {
      // iOS only allows the write inside the tap, so the PNG goes in as a promise.
      await navigator.clipboard.write([
        new ClipboardItem(
          isText ? { "text/plain": blob.text() } : { "image/png": png(blob) },
        ),
      ]);
      setIcon(copy, "Copied");
    } catch (err) {
      log(`copy failed: ${err}`);
      setIcon(copy, "Copy failed");
    }
    setTimeout(() => setIcon(copy, "Copy"), 2000);
  });
  return copy;
}

const ICONS = {
  Copy: "M8 8h12v12H8zM16 8V4H4v12h4",
  Copied: "M5 12l5 5 9-10",
  "Copy failed": "M6 6l12 12M18 6L6 18",
  Download: "M12 4v11M7 10l5 5 5-5M5 20h14",
  Open: "M14 4h6v6M20 4l-9 9M18 14v6H4V6h6",
  Remove: "M6 6l12 12M18 6L6 18",
};

// Icons on a 24 grid like the tiles'; the label is what a screen reader says.
function setIcon(link: HTMLAnchorElement, label: keyof typeof ICONS) {
  link.ariaLabel = label;
  link.title = label;
  link.innerHTML = `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="${
    ICONS[label]
  }"/></svg>`;
}

async function png(blob: Blob) {
  if (blob.type === "image/png") return blob;
  const bitmap = await createImageBitmap(blob);
  const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
  canvas.getContext("2d")!.drawImage(bitmap, 0, 0);
  return canvas.convertToBlob();
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
  const shares = new Map<number, HTMLProgressElement>();
  $("rx-shares").replaceChildren();
  show("rx-count", "waiting for a transfer");
  let scanReport: ReturnType<typeof setInterval> | undefined;
  let decoders: ReturnType<Devices["codecs"][CodecName]["decoder"]>[] = [];
  try {
    const { sound, qr, codecs } = await opened;
    scanningQr = cameraToggle.checked;
    await Promise.all([sound.listen(), scanningQr && watchCamera(qr)]);
    for (const url of objectUrls) URL.revokeObjectURL(url);
    objectUrls = [];
    receivedItems.replaceChildren();
    Object.assign(qr.stats, { frames: 0, codes: 0, packets: 0 });
    if (scanningQr) {
      scanReport = setInterval(() => {
        const { frames, codes, packets } = qr.stats;
        log(
          `receive: camera ${preview.videoWidth}x${preview.videoHeight}, scanned ${frames} frames, ${codes} with a code, ${packets} packets`,
        );
      }, SCAN_REPORT_MS);
    }
    const start = performance.now();
    stopTicker = ticker("rx-time", start);
    const turnaround = turnaroundMs();
    const ackEvery = Math.max(0, Math.round(Number(ackEveryInput.value) || 0));
    log(
      `receive: listening, camera ${
        scanningQr ? "on" : "off"
      }, turnaround ${turnaround} ms, ack every ${
        ackEvery ? `${ackEvery} symbols` : "never"
      }`,
    );
    let shown: number | undefined;
    // ponytail: every codec decodes the one camera; fan-out comes with a second codec.
    decoders = scanningQr ? Object.values(codecs).map((c) => c.decoder()) : [];
    let soundStats = { heard: 0, rejected: 0 };
    const counts = () => {
      const heard = Object.keys(codecs).map((name) =>
        `${name} ${decoders.find((d) => d.name === name)?.stats.heard ?? 0}`
      );
      const rejected = decoders.reduce(
        (sum, d) => sum + d.stats.rejected,
        soundStats.rejected,
      );
      return `sound ${soundStats.heard}, ${
        heard.join(", ")
      }, rejected ${rejected}`;
    };
    const done = await receiveBundle({
      sound,
      camera: decoders.length ? decoders : undefined,
      silenceMs: SILENCE_MS,
      turnaroundMs: turnaround,
      ackEvery: ackEvery || undefined,
      onAck: (transferId, runs, share) => {
        const blocks = runs.reduce((sum, r) => sum + r.length, 0);
        log(
          `receive: transfer ${transferId} ack: ${blocks} blocks in ${runs.length} runs, heard ${
            percent(share)
          }`,
        );
      },
      signal: controller.signal,
      onProgress: ({ sound: heard, transfers }) => {
        soundStats = heard;
        for (const { transferId, progress, via } of transfers) {
          let bar = shares.get(transferId);
          if (!bar) {
            bar = document.createElement("progress");
            bar.max = 1;
            bar.title = `Transfer ${transferId} by ${via}`;
            shares.set(transferId, bar);
            $("rx-shares").append(bar);
          }
          bar.value = progress;
        }
        const t = transfers.reduce(
          (best, t) => t.progress > best.progress ? t : best,
          transfers[0],
        );
        if (t?.k !== undefined && t.states) {
          if (t.transferId !== shown) {
            shown = t.transferId;
            gridReset(
              "rx-grid",
              t.k,
              $("rx-grid").clientWidth,
              innerHeight / 2,
            );
          }
          gridPaint("rx-grid", t.states());
          show("rx-count", `${Math.round(t.progress * t.k)} of ${t.k} blocks`);
        }
      },
      onComplete: ({ transferId, items }) => {
        received = true;
        $("rx-grid").hidden = true;
        const bar = shares.get(transferId);
        if (bar) bar.value = 1;
        log(
          `receive: transfer ${transferId} complete after ${
            seconds(performance.now() - start)
          }, ${items.length} item(s), ${counts()}`,
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
        ? `receive: finished transfer ${done.transferId}, ${counts()}`
        : `receive: stopped with nothing received, ${counts()}`,
    );
  } catch (err) {
    log(`receive failed: ${err}`);
  } finally {
    stopTicker?.();
    clearInterval(scanReport);
    running = undefined;
    for (const d of decoders) d.close();
    scanningQr = false;
    closeCamera();
    receiveRun.hidden = !received;
    receiveForm.hidden = false;
    receiveTitle.textContent = received ? "received" : "receive";
    listenButton.textContent = "Receive";
    listenButton.classList.add("primary");
  }
});

// Installs the app for offline use; the page works without it.
navigator.serviceWorker?.register("./sw.js");

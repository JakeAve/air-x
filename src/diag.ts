import { openDevices } from "@/adapters/pageLink.ts";
import type { QrTransport } from "@/adapters/qrTransport.ts";
import type { SoundTransport } from "@/adapters/soundTransport.ts";
import { encodeBundle, type Item } from "@/lib/bundle.ts";
import { receiveBundle, sendBundle } from "@/lib/session.ts";
import { PACKET_SECONDS } from "@/lib/protocol.ts";
import type { QrEcc } from "@/lib/qr/qrEncoder.ts";
import type { SoundProtocol } from "@/lib/sound/ggwave.ts";

const SILENCE_MS = 12_000;
const SOUND_DEFAULT_MAX_BYTES = 2048;
const RATE_WINDOW_MS = 5000;

function $<T extends HTMLElement>(id: string): T {
  return document.getElementById(id) as T;
}

const sendText = $<HTMLTextAreaElement>("send-text");
const sendFiles = $<HTMLInputElement>("send-files");
const qrToggle = $<HTMLInputElement>("qr-on");
const packetsPerCodeInput = $<HTMLInputElement>("packets-per-code");
const fpsInput = $<HTMLInputElement>("fps");
const eccSelect = $<HTMLSelectElement>("ecc");
const soundToggle = $<HTMLInputElement>("sound-on");
const protocolSelect = $<HTMLSelectElement>("protocol");
const listenEveryInput = $<HTMLInputElement>("listen-every");
const windowMsInput = $<HTMLInputElement>("window-ms");
const qrCanvas = $<HTMLCanvasElement>("qr-canvas");
const cameraToggle = $<HTMLInputElement>("camera");
const flipButton = $<HTMLButtonElement>("flip");
const preview = $<HTMLVideoElement>("preview");
const scanMaxEdgeInput = $<HTMLInputElement>("scan-max-edge");
const turnaroundMsInput = $<HTMLInputElement>("turnaround-ms");
const sendButton = $<HTMLButtonElement>("send");
const sendStopButton = $<HTMLButtonElement>("send-stop");
const listenButton = $<HTMLButtonElement>("listen");
const listenStopButton = $<HTMLButtonElement>("listen-stop");
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

function positive(input: HTMLInputElement, fallback: number): number {
  return Math.max(0, Number(input.value) || 0) || fallback;
}

const protocol = () => protocolSelect.value as SoundProtocol;

const turnaroundMs = () => Math.max(0, Number(turnaroundMsInput.value) || 0);

let windowEdited = false;
let turnaroundEdited = false;
function defaults() {
  if (!turnaroundEdited) {
    turnaroundMsInput.value = protocol().startsWith("ultrasound")
      ? "1000"
      : "50";
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

function ticker(id: string, start: number): () => void {
  const timer = setInterval(
    () => show(id, seconds(performance.now() - start)),
    250,
  );
  return () => {
    clearInterval(timer);
    show(id, seconds(performance.now() - start));
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

let soundEdited = false;
let sizing = 0;
let sizeTimer: ReturnType<typeof setTimeout> | undefined;
soundToggle.addEventListener("change", () => soundEdited = true);

function itemsChanged() {
  clearTimeout(sizeTimer);
  sizeTimer = setTimeout(async () => {
    const run = ++sizing;
    const items = await collectItems();
    const bytes = items.length ? (await encodeBundle(items)).length : 0;
    if (run !== sizing) return;
    show("send-size", bytes ? `${bytes} B` : "–");
    if (!soundEdited) soundToggle.checked = bytes <= SOUND_DEFAULT_MAX_BYTES;
  }, 300);
}
sendText.addEventListener("input", itemsChanged);
sendFiles.addEventListener("change", itemsChanged);

sendButton.addEventListener("click", async () => {
  // openDevices first, synchronously: iOS only lets an AudioContext made inside the gesture run.
  const opened = getDevices();
  sendButton.disabled = true;
  const controller = new AbortController();
  const onStop = () => controller.abort();
  sendStopButton.addEventListener("click", onStop, { once: true });
  sendStopButton.disabled = false;
  let stopTicker: (() => void) | undefined;
  try {
    const [{ sound, qr }, items] = await Promise.all([opened, collectItems()]);
    if (!items.length) {
      log("send: nothing to send");
      return;
    }
    const useQr = qrToggle.checked;
    const useSound = soundToggle.checked;
    if (!useQr && !useSound) {
      log("send: nothing to send by");
      return;
    }
    try {
      await sound.listen();
    } catch (err) {
      log(`send: microphone unavailable, DONE will not be heard (${err})`);
    }
    sound.protocol = protocol();
    qr.ecc = eccSelect.value as QrEcc;
    const bundle = await encodeBundle(items);
    const listenEvery = Math.max(1, Math.round(positive(listenEveryInput, 8)));
    const windowMs = Math.max(0, Number(windowMsInput.value) || 0);
    const packetsPerCode = Math.max(
      1,
      Math.round(positive(packetsPerCodeInput, 8)),
    );
    const fps = positive(fpsInput, 5);
    show("send-size", `${bundle.length} B`);
    qrCanvas.hidden = !useQr;
    const start = performance.now();
    stopTicker = ticker("send-elapsed", start);
    log(
      `send: ${items.length} item(s), ${bundle.length} bytes` +
        (useQr ? `, qr ${packetsPerCode}/code @ ${fps} fps ${qr.ecc}` : "") +
        (useSound
          ? `, sound ${sound.protocol} listenEvery ${listenEvery} window ${windowMs} ms`
          : ""),
    );
    const soundPerSecond = useSound
      ? listenEvery * 1000 /
        (listenEvery * (PACKET_SECONDS[sound.protocol] * 1000 + sound.gapMs) +
          windowMs)
      : 0;
    const perSecond = (useQr ? packetsPerCode * fps : 0) + soundPerSecond;
    let estimated = false;
    const result = await sendBundle(bundle, {
      listen: sound,
      sound: useSound ? { channel: sound, listenEvery, windowMs } : undefined,
      qr: useQr ? { display: qr, packetsPerCode, fps } : undefined,
      signal: controller.signal,
      onProgress: ({ transferId, k, soundSent, qrSent, codes }) => {
        show("send-transfer", transferId);
        show("send-k", k);
        show("send-sound-sent", soundSent);
        show("send-qr-sent", qrSent);
        show("send-codes", codes);
        if (!estimated) {
          estimated = true;
          const n = Math.ceil(1.1 * k);
          show(
            "send-estimate",
            `${n} packets ≈ ${seconds(n / perSecond * 1000)}`,
          );
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
  } catch (err) {
    log(`send failed: ${err}`);
  } finally {
    stopTicker?.();
    qrCanvas.hidden = true;
    sendStopButton.removeEventListener("click", onStop);
    sendStopButton.disabled = true;
    sendButton.disabled = false;
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
  const meta = document.createElement("span");
  meta.textContent = `${item.name} · ${item.type} · ${item.bytes.length} B`;
  const link = document.createElement("a");
  link.href = url;
  link.download = item.name;
  link.textContent = "Download";
  li.append(meta, link);
  if (item.type.startsWith("text/")) {
    const preview = document.createElement("pre");
    preview.textContent = new TextDecoder().decode(item.bytes);
    li.append(preview);
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
  preview.hidden = !qr.watching;
}

cameraToggle.addEventListener("change", () => {
  if (!devices) return;
  if (!cameraToggle.checked) {
    devices.qr.stopWatching();
    preview.hidden = true;
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
  // openDevices first, synchronously: iOS only lets an AudioContext made inside the gesture run.
  const opened = getDevices();
  listenButton.disabled = true;
  const controller = new AbortController();
  const onStop = () => controller.abort();
  listenStopButton.addEventListener("click", onStop, { once: true });
  listenStopButton.disabled = false;
  let stopTicker: (() => void) | undefined;
  let stopPolling: (() => void) | undefined;
  try {
    const { sound, qr } = await opened;
    scanningQr = cameraToggle.checked;
    await Promise.all([sound.listen(), scanningQr && watchCamera(qr)]);
    for (const url of objectUrls) URL.revokeObjectURL(url);
    objectUrls = [];
    receivedItems.replaceChildren();
    Object.assign(qr.stats, { frames: 0, codes: 0, packets: 0 });
    const start = performance.now();
    stopTicker = ticker("rx-elapsed", start);
    let sourceNew = 0;
    const samples: [time: number, sourceNew: number][] = [];
    const poll = setInterval(() => {
      const now = performance.now();
      samples.push([now, sourceNew]);
      while (now - samples[0][0] > RATE_WINDOW_MS) samples.shift();
      const [then, newThen] = samples[0];
      const rate = now > then ? (sourceNew - newThen) * 1000 / (now - then) : 0;
      show("rx-qr-rate", `${rate.toFixed(1)}/s`);
      show("rx-codes", `${qr.stats.codes} / ${qr.stats.frames}`);
    }, 500);
    stopPolling = () => clearInterval(poll);
    const turnaround = turnaroundMs();
    log(
      `receive: listening, camera ${
        scanningQr ? "on" : "off"
      }, turnaround ${turnaround} ms`,
    );
    let counts = "sound 0, qr 0, rejected 0";
    const received = await receiveBundle({
      sound,
      sources: scanningQr ? [qr] : undefined,
      silenceMs: SILENCE_MS,
      turnaroundMs: turnaround,
      signal: controller.signal,
      onProgress: (
        {
          soundHeard,
          sourceHeard: qrHeard,
          sourceNew: qrNew,
          rejected,
          transfers,
        },
      ) => {
        sourceNew = qrNew;
        counts = `sound ${soundHeard}, qr ${qrHeard}, rejected ${rejected}`;
        show("rx-sound-heard", soundHeard);
        show("rx-qr-heard", qrHeard);
        show("rx-rejected", rejected);
        show(
          "rx-transfers",
          transfers.map((t) => `${t.transferId} ${t.resolved}/${t.k}`).join(
            ", ",
          ) || "–",
        );
      },
      onComplete: ({ transferId, items }) => {
        log(
          `receive: transfer ${transferId} complete after ${
            seconds(performance.now() - start)
          }, ${items.length} item(s), ${counts}`,
        );
        items.forEach(renderItem);
      },
      onDone: (transferId) =>
        log(
          `receive: DONE sent for ${transferId} after ${
            seconds(performance.now() - start)
          }`,
        ),
    });
    log(
      received
        ? `receive: finished transfer ${received.transferId}, ${counts}`
        : `receive: stopped with nothing received, ${counts}`,
    );
  } catch (err) {
    log(`receive failed: ${err}`);
  } finally {
    stopTicker?.();
    stopPolling?.();
    scanningQr = false;
    devices?.qr.stopWatching();
    preview.hidden = true;
    listenStopButton.removeEventListener("click", onStop);
    listenStopButton.disabled = true;
    listenButton.disabled = false;
  }
});

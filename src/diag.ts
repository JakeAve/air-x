import { openSound } from "@/adapters/pageSound.ts";
import type { SoundTransport } from "@/adapters/soundTransport.ts";
import { encodeBundle, type Item } from "@/lib/bundle.ts";
import { receiveBundle, sendBundle } from "@/lib/session.ts";
import { PACKET_SECONDS } from "@/lib/protocol.ts";
import type { SoundProtocol } from "@/lib/sound/ggwave.ts";

const SILENCE_MS = 12_000;

function $<T extends HTMLElement>(id: string): T {
  return document.getElementById(id) as T;
}

const sendText = $<HTMLTextAreaElement>("send-text");
const sendFiles = $<HTMLInputElement>("send-files");
const protocolSelect = $<HTMLSelectElement>("protocol");
const listenEveryInput = $<HTMLInputElement>("listen-every");
const windowMsInput = $<HTMLInputElement>("window-ms");
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
  if (sound) sound.protocol = protocol();
});

let sound: SoundTransport | undefined;
let opening: Promise<SoundTransport> | undefined;

function getSound(): Promise<SoundTransport> {
  opening ??= openSound().then(
    ({ sound: s, sampleRate }) => {
      s.log = log;
      s.protocol = protocol();
      sound = s;
      log(`audio context at ${sampleRate} Hz`);
      return s;
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

sendButton.addEventListener("click", async () => {
  sendButton.disabled = true;
  const controller = new AbortController();
  const onStop = () => controller.abort();
  sendStopButton.addEventListener("click", onStop, { once: true });
  sendStopButton.disabled = false;
  let stopTicker: (() => void) | undefined;
  try {
    // getSound first, synchronously: iOS only lets an AudioContext made inside the gesture run.
    const [s, items] = await Promise.all([getSound(), collectItems()]);
    if (!items.length) {
      log("send: nothing to send");
      return;
    }
    await s.listen();
    s.protocol = protocol();
    const bundle = await encodeBundle(items);
    const listenEvery = Math.max(1, Number(listenEveryInput.value) || 8);
    const windowMs = Math.max(0, Number(windowMsInput.value) || 0);
    const start = performance.now();
    stopTicker = ticker("send-elapsed", start);
    log(
      `send: ${items.length} item(s), ${bundle.length} bytes, ${s.protocol}, listenEvery ${listenEvery}, window ${windowMs} ms`,
    );
    let estimated = false;
    const result = await sendBundle(s, bundle, {
      listenEvery,
      windowMs,
      signal: controller.signal,
      onProgress: ({ transferId, k, sent }) => {
        show("send-transfer", transferId);
        show("send-k", k);
        show("send-sent", sent);
        if (!estimated) {
          estimated = true;
          const n = Math.ceil(1.1 * k);
          const ms = n * (PACKET_SECONDS[s.protocol] * 1000 + s.gapMs) +
            Math.ceil(n / listenEvery) * windowMs;
          show("send-estimate", `${n} packets ≈ ${seconds(ms)}`);
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

listenButton.addEventListener("click", async () => {
  listenButton.disabled = true;
  const controller = new AbortController();
  const onStop = () => controller.abort();
  listenStopButton.addEventListener("click", onStop, { once: true });
  listenStopButton.disabled = false;
  let stopTicker: (() => void) | undefined;
  try {
    const s = await getSound();
    await s.listen();
    for (const url of objectUrls) URL.revokeObjectURL(url);
    objectUrls = [];
    receivedItems.replaceChildren();
    const start = performance.now();
    stopTicker = ticker("rx-elapsed", start);
    const turnaround = turnaroundMs();
    log(`receive: listening, turnaround ${turnaround} ms`);
    let counts = "heard 0, rejected 0";
    const received = await receiveBundle(s, {
      silenceMs: SILENCE_MS,
      turnaroundMs: turnaround,
      signal: controller.signal,
      onProgress: ({ heard, rejected, transfers }) => {
        counts = `heard ${heard}, rejected ${rejected}`;
        show("rx-heard", heard);
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
    listenStopButton.removeEventListener("click", onStop);
    listenStopButton.disabled = true;
    listenButton.disabled = false;
  }
});

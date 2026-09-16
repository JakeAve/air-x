/// <reference lib="webworker" />
import type { FromWorker, ToWorker } from "@/lib/sound/codecWorkerProtocol.ts";
import { SoundEncoder } from "@/lib/sound/soundEncoder.ts";
import { SoundDecoder } from "@/lib/sound/soundDecoder.ts";
import { decodeQrPackets } from "@/lib/qr/qrDecoder.ts";

declare const self: DedicatedWorkerGlobalScope;

let encoder: SoundEncoder | undefined;
let decoder: SoundDecoder | undefined;
const pending: ToWorker[] = [];

function post(message: FromWorker, transfer: Transferable[] = []) {
  self.postMessage(message, transfer);
}

async function init(sampleRate: number) {
  encoder = await SoundEncoder.create({ sampleRate });
  decoder = await SoundDecoder.create({ sampleRate });
  post({ type: "ready" });
  for (const message of pending.splice(0)) handle(message);
}

function handle(message: ToWorker) {
  switch (message.type) {
    case "init":
      init(message.sampleRate).catch((err) =>
        post({ type: "error", message: String(err) })
      );
      return;
    case "encodeSound": {
      if (!encoder) return void pending.push(message);
      encoder.protocol = message.protocol;
      const samples = encoder.encode(message.packet);
      post({ type: "encoded", id: message.id, samples }, [samples.buffer]);
      return;
    }
    case "sound": {
      if (!decoder) return;
      const packets = decoder.push(message.samples);
      if (packets.length) post({ type: "soundPackets", packets });
      return;
    }
    case "qr": {
      const packets = decodeQrPackets(message);
      post({ type: "qrPackets", id: message.id, packets });
      return;
    }
  }
}

self.onmessage = (event: MessageEvent<ToWorker>) => {
  try {
    handle(event.data);
  } catch (err) {
    post({ type: "error", message: String(err) });
  }
};

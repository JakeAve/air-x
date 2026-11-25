import { CodecWorker } from "./codecWorker.ts";
import { SoundTransport } from "./soundTransport.ts";
import { QrTransport } from "./qrTransport.ts";
import { cimbarDecoder, cimbarEncoder, cimbarSeconds } from "./cimbar.ts";
import { type CameraEncoder, qrEncoder, qrSeconds } from "@/lib/cameraCodec.ts";
import type { CameraRate } from "@/lib/rate.ts";
import type { PacketDisplay, PacketSource } from "@/lib/channel.ts";
import {
  packetDecoder,
  type PacketStats,
  type TransferDecoder,
} from "@/lib/transferDecoder.ts";

export interface CameraCodec {
  encoder: CameraEncoder;
  decoder: () => TransferDecoder & { readonly stats?: PacketStats };
}

/** Each camera codec's send estimate, usable before any device is open. */
export const cameraSeconds: Record<
  CameraCodecName,
  (bytes: number, rate: CameraRate) => number
> = { cimbar: cimbarSeconds, qr: qrSeconds };

/** The codec select's options, first the default. */
export type CameraCodecName = "cimbar" | "qr";

/** Every camera codec the page offers, by the name the codec select uses. */
export function cameraCodecs(
  qr: PacketSource & PacketDisplay,
  cimbarCanvas: HTMLCanvasElement,
  video: HTMLVideoElement,
): Record<CameraCodecName, CameraCodec> {
  return {
    cimbar: {
      encoder: cimbarEncoder(cimbarCanvas),
      decoder: () => cimbarDecoder(cimbarCanvas, video),
    },
    qr: {
      encoder: qrEncoder(qr),
      decoder: () => packetDecoder(qr, { name: "qr", countFrom: "first" }),
    },
  };
}

/** Builds one worker shared by both transports. Call from a user gesture so iOS lets the audio context run. */
export async function openDevices(
  canvas: HTMLCanvasElement,
  cimbarCanvas: HTMLCanvasElement,
  video: HTMLVideoElement,
): Promise<{
  sound: SoundTransport;
  qr: QrTransport;
  codecs: ReturnType<typeof cameraCodecs>;
  sampleRate: number;
}> {
  const context = new AudioContext({ sampleRate: 48_000 });
  const worker = await CodecWorker.create(
    "./codec-worker.js",
    context.sampleRate,
  );
  const sound = new SoundTransport(context, worker, "./capture-worklet.js");
  const qr = new QrTransport(canvas, video, worker);
  return {
    sound,
    qr,
    codecs: cameraCodecs(qr, cimbarCanvas, video),
    sampleRate: context.sampleRate,
  };
}

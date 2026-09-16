import { CodecWorker } from "./codecWorker.ts";
import { SoundTransport } from "./soundTransport.ts";
import { QrTransport } from "./qrTransport.ts";

/** Builds one worker shared by both transports. Call from a user gesture so iOS lets the audio context run. */
export async function openDevices(
  canvas: HTMLCanvasElement,
  video: HTMLVideoElement,
): Promise<{ sound: SoundTransport; qr: QrTransport; sampleRate: number }> {
  const context = new AudioContext({ sampleRate: 48_000 });
  const worker = await CodecWorker.create(
    "./codec-worker.js",
    context.sampleRate,
  );
  const sound = new SoundTransport(context, worker, "./capture-worklet.js");
  const qr = new QrTransport(canvas, video, worker);
  return { sound, qr, sampleRate: context.sampleRate };
}

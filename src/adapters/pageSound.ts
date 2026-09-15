import { CodecWorker } from "./codecWorker.ts";
import { SoundTransport } from "./soundTransport.ts";

/** Builds the worker and the sound transport. Call from a user gesture so iOS lets the audio context run. */
export async function openSound(): Promise<
  { sound: SoundTransport; sampleRate: number }
> {
  const context = new AudioContext({ sampleRate: 48_000 });
  const worker = await CodecWorker.create(
    "./codec-worker.js",
    context.sampleRate,
  );
  const sound = new SoundTransport(context, worker, "./capture-worklet.js");
  return { sound, sampleRate: context.sampleRate };
}

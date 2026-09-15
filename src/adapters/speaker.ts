import { abortError } from "@/lib/abort.ts";

export class Speaker {
  #context: AudioContext;

  constructor(context: AudioContext) {
    this.#context = context;
  }

  /** Plays samples recorded at the context's rate; resolves when they finish or the signal aborts. */
  play(samples: Float32Array<ArrayBuffer>, signal: AbortSignal): Promise<void> {
    if (signal.aborted) return Promise.reject(abortError());
    const buffer = this.#context.createBuffer(
      1,
      samples.length,
      this.#context.sampleRate,
    );
    buffer.copyToChannel(samples, 0);
    const source = this.#context.createBufferSource();
    source.buffer = buffer;
    source.connect(this.#context.destination);
    return new Promise((resolve, reject) => {
      const onAbort = () => {
        source.stop();
        reject(abortError());
      };
      source.onended = () => {
        signal.removeEventListener("abort", onAbort);
        source.disconnect();
        resolve();
      };
      signal.addEventListener("abort", onAbort, { once: true });
      source.start();
    });
  }
}

import type { FromWorker, ToWorker } from "@/lib/sound/codecWorkerProtocol.ts";
import type { SoundProtocol } from "@/lib/sound/ggwave.ts";
import type { RgbaImage } from "@/lib/qr/qrDecoder.ts";

type PacketsListener = (packets: Uint8Array[]) => void;

/** Page-side handle on the codec worker. */
export class CodecWorker {
  #worker: Worker;
  #nextId = 0;
  #encodes = new Map<number, (samples: Float32Array<ArrayBuffer>) => void>();
  #qrScans = new Map<number, (packets: Uint8Array[]) => void>();
  #soundListeners = new Set<PacketsListener>();
  #ready: Promise<void>;

  private constructor(url: string, sampleRate: number) {
    this.#worker = new Worker(url, { type: "module" });
    this.#ready = new Promise((resolve, reject) => {
      this.#worker.onmessage = (event: MessageEvent<FromWorker>) => {
        const m = event.data;
        switch (m.type) {
          case "ready":
            resolve();
            return;
          case "encoded":
            this.#encodes.get(m.id)?.(m.samples);
            this.#encodes.delete(m.id);
            return;
          case "soundPackets":
            for (const l of this.#soundListeners) l(m.packets);
            return;
          case "qrPackets":
            this.#qrScans.get(m.id)?.(m.packets);
            this.#qrScans.delete(m.id);
            return;
          case "error":
            console.error("codec worker:", m.message);
            reject(new Error(m.message));
            return;
        }
      };
      this.#worker.onerror = (event) => reject(new Error(event.message));
    });
    this.#send({ type: "init", sampleRate });
  }

  static async create(url: string, sampleRate: number): Promise<CodecWorker> {
    const w = new CodecWorker(url, sampleRate);
    await w.#ready;
    return w;
  }

  #send(message: ToWorker, transfer: Transferable[] = []) {
    this.#worker.postMessage(message, transfer);
  }

  encodeSound(
    packet: Uint8Array,
    protocol: SoundProtocol,
  ): Promise<Float32Array<ArrayBuffer>> {
    const id = this.#nextId++;
    return new Promise((resolve) => {
      this.#encodes.set(id, resolve);
      this.#send({ type: "encodeSound", id, packet, protocol });
    });
  }

  /** Samples are transferred, so the caller must not reuse the buffer. */
  pushSound(samples: Float32Array<ArrayBuffer>): void {
    this.#send({ type: "sound", samples }, [samples.buffer]);
  }

  /** The image's pixels are transferred, so the caller must not reuse them. */
  scanQr(image: RgbaImage): Promise<Uint8Array[]> {
    const id = this.#nextId++;
    return new Promise((resolve) => {
      this.#qrScans.set(id, resolve);
      const { width, height, data } = image;
      const transfer = data.buffer instanceof ArrayBuffer ? [data.buffer] : [];
      this.#send({ type: "qr", id, width, height, data }, transfer);
    });
  }

  onSoundPackets(listener: PacketsListener): () => void {
    this.#soundListeners.add(listener);
    return () => this.#soundListeners.delete(listener);
  }

  terminate(): void {
    this.#worker.terminate();
  }
}

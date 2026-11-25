import type { PacketDisplay, PacketSource } from "@/lib/channel.ts";
import { encodeQrPackets, type QrEcc } from "@/lib/qr/qrEncoder.ts";
import type { CodecWorker } from "./codecWorker.ts";
import { clearCanvas, drawQr } from "./screen.ts";
import { Camera, type Facing } from "./camera.ts";

type PacketListener = (bytes: Uint8Array) => void;

export class QrTransport implements PacketSource, PacketDisplay {
  #canvas: HTMLCanvasElement;
  #video: HTMLVideoElement;
  #worker: CodecWorker;
  #camera: Camera | undefined;
  #watching: AbortController | undefined;
  #opening: Promise<void> | undefined;
  #wantsCamera = false;
  #listeners = new Set<PacketListener>();
  ecc: QrEcc = "medium";
  facing: Facing = "environment";
  /** Longer side of each scanned frame; dense codes need the pixels. */
  scanMaxEdge = 1280;
  readonly stats = { frames: 0, codes: 0, packets: 0 };

  constructor(
    canvas: HTMLCanvasElement,
    video: HTMLVideoElement,
    worker: CodecWorker,
  ) {
    this.#canvas = canvas;
    this.#video = video;
    this.#worker = worker;
  }

  show(packets: Uint8Array[]): void {
    drawQr(encodeQrPackets(packets, this.ecc), this.#canvas);
  }

  clear(): void {
    clearCanvas(this.#canvas);
  }

  /**
   * Opens the camera and starts decoding. Idempotent. Like the microphone, it
   * is opened once and left rolling, because `getUserMedia` is far too slow to
   * run between legs of an exchange. Must be called from a user gesture on iOS.
   */
  async watch(): Promise<void> {
    if (this.#camera) return;
    this.#wantsCamera = true;
    this.#opening ??= this.#open();
    await this.#opening;
  }

  async #open(): Promise<void> {
    try {
      // A fresh element per stream: Safari can draw a stream in a reused
      // <video> at a stale, smaller size, ignoring object-fit.
      const fresh = this.#video.cloneNode() as HTMLVideoElement;
      this.#video.replaceWith(fresh);
      this.#video = fresh;
      // 4K: the one camera feeds every codec, and cimbar reads 4K best.
      const camera = await Camera.open(fresh, this.facing, true);
      if (!this.#wantsCamera || this.#camera) {
        camera.close();
        return;
      }
      const stop = new AbortController();
      this.#camera = camera;
      this.#watching = stop;
      camera.scan(
        async (image) => {
          const packets = await this.#worker.scanQr(image);
          this.stats.frames++;
          if (packets.length) this.stats.codes++;
          for (const packet of packets) {
            this.stats.packets++;
            for (const listener of this.#listeners) listener(packet);
          }
        },
        stop.signal,
        this.scanMaxEdge,
      ).catch(() => {});
    } finally {
      this.#opening = undefined;
    }
  }

  stopWatching(): void {
    this.#wantsCamera = false;
    this.#watching?.abort();
    this.#camera?.close();
    this.#watching = undefined;
    this.#camera = undefined;
  }

  /** Swaps front and rear. Reopening costs a `getUserMedia`, so do it between legs; listeners survive it. */
  async flip(): Promise<void> {
    this.facing = this.facing === "user" ? "environment" : "user";
    if (!this.watching) return;
    this.stopWatching();
    await this.watch();
  }

  /** The element the camera plays into; replaced on every open. */
  get video(): HTMLVideoElement {
    return this.#video;
  }

  get watching(): boolean {
    return this.#camera !== undefined;
  }

  /** Independent of `watch()`: packets arrive whenever the camera is rolling. */
  onPacket(listener: PacketListener): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }
}

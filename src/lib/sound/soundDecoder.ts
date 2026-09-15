import { SOUND_SAMPLES_PER_BLOCK } from "@/lib/protocol.ts";
import {
  type GgwaveInstance,
  type GgwaveModule,
  loadGgwave,
  packetParameters,
} from "./ggwave.ts";

/**
 * ggwave reports a completed packet again one transmit slot later while it is
 * still inside the analysis window: up to 9 blocks on the normal protocols. A
 * looped fastest packet repeats every 16 blocks with the default gap, so an
 * identical packet inside this window is the same transmission, not a repeat.
 */
const DUPLICATE_WINDOW_BLOCKS = 12;

/**
 * Feeds 48 kHz mono samples to ggwave and yields decoded packets. ggwave only
 * consumes whole blocks of SOUND_SAMPLES_PER_BLOCK samples and silently drops
 * anything shorter, so pushes of any size are buffered into blocks here.
 */
export class SoundDecoder {
  #g: GgwaveModule;
  #instance: GgwaveInstance;
  #block = new Float32Array(SOUND_SAMPLES_PER_BLOCK);
  #filled = 0;
  #blockCount = 0;
  #lastPacket: Uint8Array | null = null;
  #lastPacketBlock = 0;

  private constructor(g: GgwaveModule, sampleRate?: number) {
    this.#g = g;
    this.#instance = g.init(packetParameters(g, sampleRate));
    const ids = g.ProtocolId;
    for (
      const id of [
        ids.GGWAVE_PROTOCOL_DT_NORMAL,
        ids.GGWAVE_PROTOCOL_DT_FAST,
        ids.GGWAVE_PROTOCOL_DT_FASTEST,
      ]
    ) {
      g.rxToggleProtocol(id, 0);
    }
  }

  /** `sampleRate` is the rate of the samples that will be pushed. */
  static async create(
    options: { sampleRate?: number } = {},
  ): Promise<SoundDecoder> {
    return new SoundDecoder(await loadGgwave(), options.sampleRate);
  }

  push(samples: Float32Array): Uint8Array[] {
    const packets: Uint8Array[] = [];
    let offset = 0;
    while (offset < samples.length) {
      const take = Math.min(
        SOUND_SAMPLES_PER_BLOCK - this.#filled,
        samples.length - offset,
      );
      this.#block.set(samples.subarray(offset, offset + take), this.#filled);
      this.#filled += take;
      offset += take;
      if (this.#filled === SOUND_SAMPLES_PER_BLOCK) {
        this.#filled = 0;
        this.#blockCount++;
        const packet = this.#decodeBlock();
        if (packet && !this.#isEcho(packet)) {
          packets.push(packet);
          this.#lastPacket = packet;
          this.#lastPacketBlock = this.#blockCount;
        }
      }
    }
    return packets;
  }

  #isEcho(packet: Uint8Array): boolean {
    return this.#lastPacket !== null &&
      this.#blockCount - this.#lastPacketBlock <= DUPLICATE_WINDOW_BLOCKS &&
      this.#lastPacket.every((b, i) => b === packet[i]);
  }

  #decodeBlock(): Uint8Array | null {
    const bytes = new Uint8Array(
      this.#block.buffer,
      this.#block.byteOffset,
      this.#block.byteLength,
    );
    const result = this.#g.decode(this.#instance, bytes);
    return result.length > 0 ? new Uint8Array(result) : null;
  }

  dispose(): void {
    this.#g.free(this.#instance);
  }
}

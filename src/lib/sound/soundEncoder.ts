import { PACKET_BYTES, SOUND_SAMPLE_RATE } from "@/lib/protocol.ts";
import type { QuietModule } from "../../../types/quiet.d.ts";
import {
  type GgwaveInstance,
  type GgwaveModule,
  loadGgwave,
  packetParameters,
  protocolId,
  type SoundProtocol,
} from "./ggwave.ts";
import {
  isQuietProtocol,
  loadQuiet,
  QuietEncoder,
  type QuietProtocol,
} from "./quiet.ts";

export interface SoundEncoderOptions {
  protocol?: SoundProtocol;
  /** ggwave volume, 0..100. */
  volume?: number;
  /** Rate the returned samples are meant to be played at. */
  sampleRate?: number;
}

/** Turns one packet into 48 kHz mono float samples. Pure; playback lives in the speaker adapter. */
export class SoundEncoder {
  #g: GgwaveModule;
  #instance: GgwaveInstance;
  #protocol: SoundProtocol;
  #volume: number;
  #sampleRate: number;
  #quiet: QuietModule;
  #quietEncoders = new Map<QuietProtocol, QuietEncoder>();

  private constructor(
    g: GgwaveModule,
    quiet: QuietModule,
    options: SoundEncoderOptions,
  ) {
    this.#g = g;
    this.#quiet = quiet;
    this.#sampleRate = options.sampleRate ?? SOUND_SAMPLE_RATE;
    this.#instance = g.init(packetParameters(g, this.#sampleRate));
    this.#protocol = options.protocol ?? "fastest";
    this.#volume = options.volume ?? 50;
  }

  static async create(
    options: SoundEncoderOptions = {},
  ): Promise<SoundEncoder> {
    const [g, quiet] = await Promise.all([loadGgwave(), loadQuiet()]);
    return new SoundEncoder(g, quiet, options);
  }

  get protocol(): SoundProtocol {
    return this.#protocol;
  }

  set protocol(value: SoundProtocol) {
    this.#protocol = value;
  }

  encode(packet: Uint8Array): Float32Array<ArrayBuffer> {
    if (packet.length !== PACKET_BYTES) {
      throw new RangeError(
        `packet must be ${PACKET_BYTES} bytes, got ${packet.length}`,
      );
    }
    if (isQuietProtocol(this.#protocol)) {
      let encoder = this.#quietEncoders.get(this.#protocol);
      if (!encoder) {
        encoder = new QuietEncoder(
          this.#quiet,
          this.#protocol,
          this.#sampleRate,
        );
        this.#quietEncoders.set(this.#protocol, encoder);
      }
      // ggwave at volume 50 peaks near 0.5, so volume maps to peak the same way.
      return encoder.encode(packet, this.#volume / 100);
    }
    const raw = this.#g.encode(
      this.#instance,
      packet,
      protocolId(this.#g, this.#protocol),
      this.#volume,
    );
    const samples = new Float32Array(
      raw.byteLength / Float32Array.BYTES_PER_ELEMENT,
    );
    samples.set(new Float32Array(raw.buffer, raw.byteOffset, samples.length));
    return samples;
  }

  dispose(): void {
    this.#g.free(this.#instance);
    for (const encoder of this.#quietEncoders.values()) encoder.dispose();
  }
}

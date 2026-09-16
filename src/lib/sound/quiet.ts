// libquiet modems: GMSK and OFDM profiles that move a packet in 0.15 to 0.8 s
// against ggwave's 1.9 s, at the cost of noise margin. One frame carries one
// packet, so a frame either decodes whole or not at all.
// @ts-types="../../../types/quiet.d.ts"
import createQuiet from "../../../vendor/quiet/quiet-emscripten.js";
import type {
  Pointer,
  QuietModule,
  QuietModuleOptions,
} from "../../../types/quiet.d.ts";
import { QUIET_MEM } from "../../../vendor/quiet/mem.ts";
import { PACKET_BYTES, SOUND_SAMPLES_PER_BLOCK } from "@/lib/protocol.ts";

export type QuietProtocol =
  | "quiet-audible"
  | "quiet-audible-7k"
  | "quiet-ultrasound-3600";

export const QUIET_PROTOCOLS: QuietProtocol[] = [
  "quiet-audible",
  "quiet-audible-7k",
  "quiet-ultrasound-3600",
];

export function isQuietProtocol(protocol: string): protocol is QuietProtocol {
  return protocol.startsWith("quiet-");
}

const common = {
  encoder_filters: { dc_filter_alpha: 0.01 },
  resampler: {
    delay: 13,
    bandwidth: 0.45,
    attenuation: 60,
    filter_bank_size: 64,
  },
  frame_length: PACKET_BYTES,
};

/** quiet-js's `audible`, `audible-7k-channel-0`, and `ultrasonic-3600`, with frame_length set to one packet. */
const PROFILES = JSON.stringify({
  "quiet-audible": {
    ...common,
    checksum_scheme: "crc32",
    inner_fec_scheme: "v27",
    outer_fec_scheme: "none",
    mod_scheme: "gmsk",
    modulation: { center_frequency: 4200, gain: 0.15 },
    interpolation: {
      shape: "kaiser",
      samples_per_symbol: 10,
      symbol_delay: 4,
      excess_bandwidth: 0.35,
    },
  },
  "quiet-audible-7k": {
    ...common,
    mod_scheme: "arb16opt",
    checksum_scheme: "crc32",
    inner_fec_scheme: "v29",
    outer_fec_scheme: "rs8",
    modulation: { center_frequency: 9200, gain: 0.01 },
    interpolation: {
      shape: "kaiser",
      samples_per_symbol: 6,
      symbol_delay: 4,
      excess_bandwidth: 0.31,
    },
    ofdm: {
      num_subcarriers: 48,
      cyclic_prefix_length: 8,
      taper_length: 4,
      left_band: 0,
      right_band: 0,
    },
  },
  "quiet-ultrasound-3600": {
    ...common,
    ofdm: {
      num_subcarriers: 64,
      cyclic_prefix_length: 20,
      taper_length: 8,
      left_band: 4,
      right_band: 13,
    },
    mod_scheme: "V29",
    checksum_scheme: "crc8",
    inner_fec_scheme: "v27",
    outer_fec_scheme: "none",
    modulation: { center_frequency: 18500, gain: 0.01 },
    interpolation: {
      shape: "kaiser",
      samples_per_symbol: 7,
      symbol_delay: 4,
      excess_bandwidth: 0.33,
    },
  },
});

let modulePromise: Promise<QuietModule> | undefined;

/** The asm.js module is loaded once and shared by every encoder and decoder. */
export function loadQuiet(): Promise<QuietModule> {
  modulePromise ??= new Promise((resolve) => {
    // emscripten fills in the object it is given, and may finish initializing
    // before createQuiet returns, so resolve with that same object.
    const options: QuietModuleOptions = {
      print: () => {},
      printErr: () => {},
      locateFile: (path) => path,
      readBinary: () => QUIET_MEM,
      readAsync: (_path, onload) => onload(QUIET_MEM.buffer as ArrayBuffer),
      onRuntimeInitialized: () => resolve(options as QuietModule),
    };
    createQuiet(options);
  });
  return modulePromise;
}

function profileOptions(
  m: QuietModule,
  kind: "encoder" | "decoder",
  protocol: QuietProtocol,
): Pointer {
  const opt = m.ccall(`quiet_${kind}_profile_str`, "number", [
    "array",
    "array",
  ], [m.intArrayFromString(PROFILES), m.intArrayFromString(protocol)]);
  if (!opt) throw new Error(`quiet: no profile ${protocol}`);
  return opt;
}

export class QuietEncoder {
  #m: QuietModule;
  #encoder: Pointer;
  #buffer: Pointer;

  constructor(m: QuietModule, protocol: QuietProtocol, sampleRate: number) {
    this.#m = m;
    const opt = profileOptions(m, "encoder", protocol);
    this.#encoder = m.ccall("quiet_encoder_create", "number", [
      "number",
      "number",
    ], [opt, sampleRate]);
    m._free(opt);
    this.#buffer = m._malloc(4 * SOUND_SAMPLES_PER_BLOCK);
  }

  /** Samples for one packet, scaled so the loudest sample is `peak`. */
  encode(packet: Uint8Array, peak: number): Float32Array<ArrayBuffer> {
    const m = this.#m;
    const sent = m.ccall("quiet_encoder_send", "number", [
      "number",
      "array",
      "number",
    ], [this.#encoder, packet, packet.length]);
    if (sent < 0) throw new Error("quiet: encoder rejected the packet");
    const chunks: Float32Array[] = [];
    while (true) {
      const written = m.ccall("quiet_encoder_emit", "number", [
        "number",
        "number",
        "number",
      ], [this.#encoder, this.#buffer, SOUND_SAMPLES_PER_BLOCK]);
      if (written <= 0) break;
      const start = this.#buffer / 4;
      chunks.push(m.HEAPF32.slice(start, start + written));
      if (written < SOUND_SAMPLES_PER_BLOCK) break;
    }
    const samples = new Float32Array(
      chunks.reduce((n, c) => n + c.length, 0),
    );
    let offset = 0;
    let loudest = 0;
    for (const chunk of chunks) {
      samples.set(chunk, offset);
      offset += chunk.length;
      for (const s of chunk) loudest = Math.max(loudest, Math.abs(s));
    }
    if (loudest > 0) {
      const scale = peak / loudest;
      for (let i = 0; i < samples.length; i++) samples[i] *= scale;
    }
    return samples;
  }

  dispose(): void {
    this.#m.ccall("quiet_encoder_destroy", null, ["number"], [this.#encoder]);
    this.#m._free(this.#buffer);
  }
}

export class QuietDecoder {
  #m: QuietModule;
  #decoder: Pointer;
  #samples: Pointer;
  #capacity = SOUND_SAMPLES_PER_BLOCK;
  #frame: Pointer;

  constructor(m: QuietModule, protocol: QuietProtocol, sampleRate: number) {
    this.#m = m;
    const opt = profileOptions(m, "decoder", protocol);
    this.#decoder = m.ccall("quiet_decoder_create", "number", [
      "number",
      "number",
    ], [opt, sampleRate]);
    m._free(opt);
    this.#samples = m._malloc(4 * this.#capacity);
    this.#frame = m._malloc(2 * PACKET_BYTES);
  }

  /** Feeds samples and returns every whole packet that decoded. */
  push(samples: Float32Array): Uint8Array[] {
    const m = this.#m;
    if (samples.length > this.#capacity) {
      m._free(this.#samples);
      this.#capacity = samples.length;
      this.#samples = m._malloc(4 * this.#capacity);
    }
    m.HEAPF32.set(samples, this.#samples / 4);
    m.ccall("quiet_decoder_consume", "number", [
      "number",
      "number",
      "number",
    ], [this.#decoder, this.#samples, samples.length]);
    const packets: Uint8Array[] = [];
    while (true) {
      const read = m.ccall("quiet_decoder_recv", "number", [
        "number",
        "number",
        "number",
      ], [this.#decoder, this.#frame, 2 * PACKET_BYTES]);
      if (read < 0) break;
      if (read !== PACKET_BYTES) continue;
      packets.push(m.HEAPU8.slice(this.#frame, this.#frame + PACKET_BYTES));
    }
    return packets;
  }

  dispose(): void {
    this.#m.ccall("quiet_decoder_destroy", null, ["number"], [this.#decoder]);
    this.#m._free(this.#samples);
    this.#m._free(this.#frame);
  }
}

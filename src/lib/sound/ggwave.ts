// @ts-types="../../../types/ggwave.d.ts"
import ggwaveFactory from "ggwave";
import type {
  GgwaveInstance,
  GgwaveModule,
  GgwaveParameters,
  GgwaveProtocolId,
} from "../../../types/ggwave.d.ts";
import {
  PACKET_BYTES,
  SOUND_SAMPLE_RATE,
  SOUND_SAMPLES_PER_BLOCK,
} from "@/lib/protocol.ts";

export type { GgwaveInstance, GgwaveModule, GgwaveProtocolId };

export type SoundProtocol =
  | "fastest"
  | "fast"
  | "normal"
  | "ultrasound-fastest"
  | "ultrasound-fast"
  | "ultrasound-normal";

let modulePromise: Promise<GgwaveModule> | undefined;

/** The WASM module is loaded once and shared by every encoder and decoder. */
export function loadGgwave(): Promise<GgwaveModule> {
  modulePromise ??= ggwaveFactory({ print: () => {} }).then((g) => {
    g.disableLog();
    return g;
  });
  return modulePromise;
}

/**
 * `deviceSampleRate` is the AudioContext rate samples arrive at and leave in;
 * ggwave resamples to its internal rate itself.
 */
export function packetParameters(
  g: GgwaveModule,
  deviceSampleRate = SOUND_SAMPLE_RATE,
): GgwaveParameters {
  return {
    ...g.getDefaultParameters(),
    payloadLength: PACKET_BYTES,
    sampleRateInp: deviceSampleRate,
    sampleRateOut: deviceSampleRate,
    sampleRate: SOUND_SAMPLE_RATE,
    samplesPerFrame: SOUND_SAMPLES_PER_BLOCK,
    sampleFormatInp: g.SampleFormat.GGWAVE_SAMPLE_FORMAT_F32,
    sampleFormatOut: g.SampleFormat.GGWAVE_SAMPLE_FORMAT_F32,
  };
}

export function protocolId(
  g: GgwaveModule,
  protocol: SoundProtocol,
): GgwaveProtocolId {
  switch (protocol) {
    case "fastest":
      return g.ProtocolId.GGWAVE_PROTOCOL_AUDIBLE_FASTEST;
    case "fast":
      return g.ProtocolId.GGWAVE_PROTOCOL_AUDIBLE_FAST;
    case "normal":
      return g.ProtocolId.GGWAVE_PROTOCOL_AUDIBLE_NORMAL;
    case "ultrasound-fastest":
      return g.ProtocolId.GGWAVE_PROTOCOL_ULTRASOUND_FASTEST;
    case "ultrasound-fast":
      return g.ProtocolId.GGWAVE_PROTOCOL_ULTRASOUND_FAST;
    case "ultrasound-normal":
      return g.ProtocolId.GGWAVE_PROTOCOL_ULTRASOUND_NORMAL;
  }
}

/**
 * Seconds to transmit one 64-byte packet, measured with SoundEncoder at
 * volume 50. Pins encode duration so a ggwave upgrade that changes timing is
 * caught by sound.test.ts instead of silently drifting.
 */
export const PACKET_SECONDS: Record<SoundProtocol, number> = {
  "fastest": 1.92,
  "fast": 3.84,
  "normal": 5.76,
  "ultrasound-fastest": 1.92,
  "ultrasound-fast": 3.84,
  "ultrasound-normal": 5.76,
};

import type { SoundProtocol } from "./sound/ggwave.ts";

export const PROTOCOL_VERSION = 1;

/** Packet layout: version 4b | type 4b | transferId 16b | k 24b | symbolId 24b | data | crc16. */
export const PACKET_BYTES = 64;
export const PACKET_HEADER_BYTES = 9;
export const PACKET_CRC_BYTES = 2;
export const DATA_BYTES = PACKET_BYTES - PACKET_HEADER_BYTES - PACKET_CRC_BYTES;

/** Up to this many blocks, repair symbols are dense random rows instead of LT. */
export const DENSE_MAX_K = 128;

export const MAX_K = 2 ** 24 - 1;
export const MAX_SYMBOL_ID = 2 ** 24 - 1;

/** A decoder ignores any packet whose k implies a bundle bigger than this. */
export const MAX_BUNDLE_BYTES = 16 * 1024 * 1024;

/** decodeBundle aborts decompression once the output would exceed this. */
export const MAX_INFLATED_BYTES = 64 * 1024 * 1024;

export const SOUND_SAMPLE_RATE = 48_000;
export const SOUND_SAMPLES_PER_BLOCK = 1024;

/**
 * Seconds to transmit one 64-byte packet, measured with SoundEncoder at
 * volume 50. Pins encode duration so a ggwave upgrade that changes timing is
 * caught by sound.test.ts instead of silently drifting. Lives here rather than in ggwave.ts so pages can import it without bundling
 * the WASM.
 */
export const PACKET_SECONDS: Record<SoundProtocol, number> = {
  "fastest": 1.92,
  "fast": 3.84,
  "normal": 5.76,
  "ultrasound-fastest": 1.92,
  "ultrasound-fast": 3.84,
  "ultrasound-normal": 5.76,
  "quiet-audible": 0.58,
  "quiet-audible-7k": 0.146,
  "quiet-ultrasound-3600": 0.27,
};

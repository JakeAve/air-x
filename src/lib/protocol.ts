import type { SoundProtocol } from "./sound/ggwave.ts";

export const PROTOCOL_VERSION = 4;

/**
 * Packet layout: version 4b | wide 1b | type 3b, then
 * compact: transferId 16b | k 8b | symbolId 16b | data | crc16, or
 * wide: transferId 16b | k 24b | symbolId 24b | data | crc16.
 * A packet is wide exactly when its k is above COMPACT_MAX_K.
 */
export const SOUND_PACKET_BYTES = 64;
export const QR_PACKET_BYTES = 128;
export const PACKET_HEADER_BYTES = 9;
export const COMPACT_HEADER_BYTES = 6;
export const PACKET_CRC_BYTES = 2;

/** Data bytes in a packet of `packetBytes` for a transfer of `k` blocks. */
export function dataBytes(packetBytes: number, k: number): number {
  const header = k <= COMPACT_MAX_K
    ? COMPACT_HEADER_BYTES
    : PACKET_HEADER_BYTES;
  return packetBytes - header - PACKET_CRC_BYTES;
}

/** Up to this many blocks, repair symbols are dense random rows instead of LT. */
export const DENSE_MAX_K = 128;

/** Ack data: up to ACK_RUNS runs of `start u24 | length u8`, zero padded, then a u24 count of fresh symbols heard. */
export const ACK_RUNS = 12;
export const ACK_RUN_BYTES = 4;
export const ACK_MAX_RUN = 255;

export const MAX_K = 2 ** 24 - 1;
export const MAX_SYMBOL_ID = 2 ** 24 - 1;

/** A transfer of at most this many blocks uses the compact header. */
export const COMPACT_MAX_K = 255;
export const COMPACT_MAX_SYMBOL_ID = 65535;

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

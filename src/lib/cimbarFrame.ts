/**
 * libcimbar's fountain header, the first 6 bytes of every chunk of a decoded
 * frame (FountainMetadata.h, v0.6.9): `encodeId u7 | size bit 24`, then
 * `size u24`, then `blockId u16`, all big-endian. `encodeId` is the sender's
 * choice, so it carries our transfer id.
 */
export function cimbarHeader(
  frame: Uint8Array,
): { encodeId: number; size: number; blockId: number } {
  return {
    encodeId: frame[0] & 0x7f,
    size: ((frame[0] & 0x80) << 17) | (frame[1] << 16) | (frame[2] << 8) |
      frame[3],
    blockId: (frame[4] << 8) | frame[5],
  };
}

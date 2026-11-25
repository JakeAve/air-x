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

/**
 * Chunks in a mode B frame, 7500 bytes in 625-byte chunks (measured), so
 * consecutive frames' first block ids step by 12. At the end of the source
 * blocks one step is 13.
 */
export const CIMBAR_CHUNKS = 12;

/**
 * One transfer's frames read by a cimbar receiver, counted in chunks, and the
 * share of the sender's frames read between acks: frames read above the last
 * ack's highest id over the ids they span. The sender restarts its block ids
 * at 0 after about 8 times the blocks the file needs; frames from then on are
 * at or below that highest id, so acks carry no share and the rate holds.
 */
export class CimbarTally {
  /** The highest chunk id read. */
  highest = -1;
  readonly #frames = new Set<number>();
  /** `highest` as of the last ack, or just below the first frame read. */
  #base?: number;

  /** A frame by its first block id; returns its fresh chunks, 0 for a repeat. */
  read(blockId: number): number {
    this.#base ??= blockId - 1;
    this.highest = Math.max(this.highest, blockId + CIMBAR_CHUNKS - 1);
    if (this.#frames.has(blockId)) return 0;
    this.#frames.add(blockId);
    return CIMBAR_CHUNKS;
  }

  /** The figures for an ack sent now. */
  ack(): { highest: number; heard: number; share?: number } {
    const from = this.#base ?? this.highest;
    this.#base = this.highest;
    const span = this.highest - from;
    // Counted at ack time, not as frames land: workers can answer out of order.
    let read = 0;
    for (const id of this.#frames) if (id > from) read++;
    return {
      // A compact Ack's symbol id is a u16; block ids wrap there too.
      // ponytail: past the wrap (bundles over about 5 MB) the share is lost.
      highest: Math.min(this.highest, 0xffff),
      heard: this.#frames.size * CIMBAR_CHUNKS,
      share: span > 0 ? read * CIMBAR_CHUNKS / span : undefined,
    };
  }
}

// Fountain symbol selection: source symbols, and dense random rows up to
// DENSE_MAX_K (raptor.ts above). Wire behavior: sender and receiver must derive
// identical block sets from (transferId, symbolId, k) forever, on every engine.
import { COMPACT_MAX_K, dataBytes, DENSE_MAX_K } from "../protocol.ts";

export function blockCount(byteLength: number, packetBytes: number): number {
  const compact = Math.ceil(byteLength / dataBytes(packetBytes, 0));
  if (compact <= COMPACT_MAX_K) return Math.max(1, compact);
  return Math.ceil(byteLength / dataBytes(packetBytes, COMPACT_MAX_K + 1));
}

export function blockSet(
  transferId: number,
  symbolId: number,
  k: number,
): number[] {
  if (symbolId < k) return [symbolId];

  if (k <= DENSE_MAX_K) {
    const random = mulberry32(
      Math.imul(transferId + 1, 0x9e3779b1) ^ symbolId,
    );
    const blocks: number[] = [];
    for (let b = 0; b < k; b++) if (random() < 0.5) blocks.push(b);
    return blocks.length ? blocks : [Math.floor(random() * k)];
  }
  throw new RangeError(`k ${k} is above DENSE_MAX_K: see raptor.ts`);
}

function mulberry32(seed: number): () => number {
  let a = seed | 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

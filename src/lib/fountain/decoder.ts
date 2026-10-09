import { type Packet, PacketType, type Run } from "../packet.ts";
import { ACK_MAX_RUN, MAX_BUNDLE_BYTES } from "../protocol.ts";
import { blockSet } from "./symbols.ts";

// Bounds one elimination to about 512² bit operations; above it peeling alone
// carries the transfer until enough blocks resolve.
const MAX_ELIMINATION_BLOCKS = 512;

interface PendingSymbol {
  blocks: Set<number>;
  data: Uint8Array;
}

export class Decoder {
  #transferId: number | undefined;
  #k: number | undefined;
  /** Block size, the data length of the first accepted packet. */
  #dataBytes = 0;
  #resolved = 0;
  #blocks = new Uint8Array(0);
  #isResolved = new Uint8Array(0);
  #seen = new Set<number>();
  // Every pending symbol references only unresolved blocks, indexed by each.
  #pendingByBlock: Set<PendingSymbol>[] = [];
  #pending = new Set<PendingSymbol>();
  // Each symbol lowers the unknowns left after elimination by at most one, so
  // after a failed elimination wait that many new symbols before retrying.
  #eliminateAfter = 0;

  get transferId(): number | undefined {
    return this.#transferId;
  }

  get k(): number | undefined {
    return this.#k;
  }

  get resolved(): number {
    return this.#resolved;
  }

  /** Per block: 0 unseen, 1 covered by a pending symbol, 2 resolved. */
  states(): Uint8Array {
    const out = new Uint8Array(this.#k ?? 0);
    for (let b = 0; b < out.length; b++) {
      out[b] = this.#isResolved[b] ? 2 : this.#pendingByBlock[b].size ? 1 : 0;
    }
    return out;
  }

  /**
   * Runs of unresolved blocks in block order, each at most `ACK_MAX_RUN` long.
   * Pending coverage does not count: a block only a pending symbol touches is
   * still missing. Empty before `k` is known.
   */
  missingRuns(maxRuns: number): Run[] {
    const runs: Run[] = [];
    const k = this.#k ?? 0;
    for (let b = 0; b < k; b++) {
      if (this.#isResolved[b]) continue;
      const last = runs[runs.length - 1];
      if (last && last.start + last.length === b && last.length < ACK_MAX_RUN) {
        last.length++;
      } else if (runs.length < maxRuns) {
        runs.push({ start: b, length: 1 });
      } else {
        break;
      }
    }
    return runs;
  }

  push(packet: Packet): Uint8Array | undefined {
    if (this.#k !== undefined && this.#resolved === this.#k) {
      return this.#blocks;
    }
    if (packet.type === PacketType.Done || packet.type === PacketType.Ack) {
      return undefined;
    }

    if (this.#k === undefined) {
      if (packet.k < 1 || packet.k * packet.data.length > MAX_BUNDLE_BYTES) {
        return undefined;
      }
      this.#transferId = packet.transferId;
      this.#k = packet.k;
      this.#dataBytes = packet.data.length;
      this.#blocks = new Uint8Array(packet.k * this.#dataBytes);
      this.#isResolved = new Uint8Array(packet.k);
      this.#pendingByBlock = Array.from({ length: packet.k }, () => new Set());
    }
    if (
      packet.transferId !== this.#transferId || packet.k !== this.#k ||
      packet.data.length !== this.#dataBytes
    ) {
      return undefined;
    }
    if (this.#seen.has(packet.symbolId)) return undefined;
    this.#seen.add(packet.symbolId);

    const data = packet.data.slice();
    const blocks = new Set<number>();
    for (const block of blockSet(packet.transferId, packet.symbolId, this.#k)) {
      if (this.#isResolved[block]) this.#xorBlock(data, block);
      else blocks.add(block);
    }

    if (blocks.size === 0) return undefined;
    if (blocks.size === 1) {
      this.#resolve([...blocks][0], data);
    } else {
      const symbol = { blocks, data };
      this.#pending.add(symbol);
      for (const block of blocks) this.#pendingByBlock[block].add(symbol);
    }

    const unresolved = this.#k - this.#resolved;
    if (
      --this.#eliminateAfter <= 0 && unresolved > 0 &&
      unresolved <= MAX_ELIMINATION_BLOCKS && this.#pending.size >= unresolved
    ) {
      this.#eliminate();
    }

    return this.#resolved === this.#k ? this.#blocks : undefined;
  }

  #resolve(block: number, data: Uint8Array): void {
    const queue: [number, Uint8Array][] = [[block, data]];
    for (let entry; (entry = queue.pop());) {
      const [b, d] = entry;
      if (this.#isResolved[b]) continue;
      this.#blocks.set(d, b * this.#dataBytes);
      this.#isResolved[b] = 1;
      this.#resolved++;

      for (const symbol of this.#pendingByBlock[b]) {
        symbol.blocks.delete(b);
        this.#xorBlock(symbol.data, b);
        if (symbol.blocks.size === 1) {
          const [last] = symbol.blocks;
          this.#pendingByBlock[last].delete(symbol);
          this.#pending.delete(symbol);
          queue.push([last, symbol.data]);
        }
      }
      this.#pendingByBlock[b].clear();
    }
  }

  // Gauss-Jordan over GF(2) on the pending symbols, restricted to unresolved
  // blocks. Rows that reduce to a single block go back through #resolve.
  #eliminate(): void {
    const k = this.#k!;
    const columns = new Int32Array(k).fill(-1);
    const unresolved: number[] = [];
    for (let b = 0; b < k; b++) {
      if (!this.#isResolved[b]) columns[b] = unresolved.push(b) - 1;
    }
    const n = unresolved.length;
    const words = (n + 31) >>> 5;
    const symbols = [...this.#pending];
    const m = symbols.length;
    const bits = new Uint32Array(m * words);
    const data = new Uint8Array(m * this.#dataBytes);
    symbols.forEach((symbol, row) => {
      for (const b of symbol.blocks) {
        const col = columns[b];
        bits[row * words + (col >>> 5)] |= 1 << (col & 31);
      }
      data.set(symbol.data, row * this.#dataBytes);
    });

    const rows = Array.from({ length: m }, (_, i) => i);
    const pivots: number[] = [];
    for (let col = 0; col < n && pivots.length < m; col++) {
      const word = col >>> 5;
      const bit = 1 << (col & 31);
      const rank = pivots.length;
      let p = rank;
      while (p < m && !(bits[rows[p] * words + word] & bit)) p++;
      if (p === m) continue;
      [rows[rank], rows[p]] = [rows[p], rows[rank]];
      const pivot = rows[rank];
      for (let i = 0; i < m; i++) {
        const row = rows[i];
        if (row === pivot || !(bits[row * words + word] & bit)) continue;
        for (let w = 0; w < words; w++) {
          bits[row * words + w] ^= bits[pivot * words + w];
        }
        for (let j = 0; j < this.#dataBytes; j++) {
          data[row * this.#dataBytes + j] ^= data[pivot * this.#dataBytes + j];
        }
      }
      pivots.push(col);
    }

    this.#eliminateAfter = n - pivots.length;
    pivots.forEach((col, i) => {
      const row = rows[i];
      let weight = 0;
      for (let w = 0; w < words; w++) weight += popcount(bits[row * words + w]);
      if (weight === 1) {
        this.#resolve(
          unresolved[col],
          data.slice(row * this.#dataBytes, (row + 1) * this.#dataBytes),
        );
      }
    });
  }

  #xorBlock(data: Uint8Array, block: number): void {
    const offset = block * this.#dataBytes;
    for (let i = 0; i < this.#dataBytes; i++) {
      data[i] ^= this.#blocks[offset + i];
    }
  }
}

function popcount(x: number): number {
  x -= (x >>> 1) & 0x55555555;
  x = (x & 0x33333333) + ((x >>> 2) & 0x33333333);
  return (((x + (x >>> 4)) & 0x0f0f0f0f) * 0x01010101) >>> 24;
}

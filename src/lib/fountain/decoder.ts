import { type Packet, PacketType } from "../packet.ts";
import { DATA_BYTES } from "../protocol.ts";
import { blockSet } from "./symbols.ts";

interface PendingSymbol {
  blocks: Set<number>;
  data: Uint8Array;
}

export class Decoder {
  #transferId: number | undefined;
  #k: number | undefined;
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

  push(packet: Packet): Uint8Array | undefined {
    if (this.#k !== undefined && this.#resolved === this.#k) {
      return this.#blocks;
    }
    if (packet.type === PacketType.Done) return undefined;

    if (this.#k === undefined) {
      this.#transferId = packet.transferId;
      this.#k = packet.k;
      this.#blocks = new Uint8Array(packet.k * DATA_BYTES);
      this.#isResolved = new Uint8Array(packet.k);
      this.#pendingByBlock = Array.from({ length: packet.k }, () => new Set());
    }
    if (packet.transferId !== this.#transferId || packet.k !== this.#k) {
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
      this.#pending.size >= unresolved
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
      this.#blocks.set(d, b * DATA_BYTES);
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
    const data = new Uint8Array(m * DATA_BYTES);
    symbols.forEach((symbol, row) => {
      for (const b of symbol.blocks) {
        const col = columns[b];
        bits[row * words + (col >>> 5)] |= 1 << (col & 31);
      }
      data.set(symbol.data, row * DATA_BYTES);
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
        for (let j = 0; j < DATA_BYTES; j++) {
          data[row * DATA_BYTES + j] ^= data[pivot * DATA_BYTES + j];
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
          data.slice(row * DATA_BYTES, (row + 1) * DATA_BYTES),
        );
      }
    });
  }

  #xorBlock(data: Uint8Array, block: number): void {
    const offset = block * DATA_BYTES;
    for (let i = 0; i < DATA_BYTES; i++) data[i] ^= this.#blocks[offset + i];
  }
}

function popcount(x: number): number {
  x -= (x >>> 1) & 0x55555555;
  x = (x & 0x33333333) + ((x >>> 2) & 0x33333333);
  return (((x + (x >>> 4)) & 0x0f0f0f0f) * 0x01010101) >>> 24;
}

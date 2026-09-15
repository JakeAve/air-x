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

    if (blocks.size === 1) {
      this.#resolve([...blocks][0], data);
    } else if (blocks.size > 1) {
      const symbol = { blocks, data };
      for (const block of blocks) this.#pendingByBlock[block].add(symbol);
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
          queue.push([last, symbol.data]);
        }
      }
      this.#pendingByBlock[b].clear();
    }
  }

  #xorBlock(data: Uint8Array, block: number): void {
    const offset = block * DATA_BYTES;
    for (let i = 0; i < DATA_BYTES; i++) data[i] ^= this.#blocks[offset + i];
  }
}

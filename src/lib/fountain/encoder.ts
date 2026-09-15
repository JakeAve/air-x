import { type Packet, PacketType } from "../packet.ts";
import { DATA_BYTES, MAX_K, MAX_SYMBOL_ID } from "../protocol.ts";
import { blockCount, blockSet } from "./symbols.ts";

export class Encoder {
  readonly k: number;
  readonly #transferId: number;
  readonly #blocks: Uint8Array;
  private nextSymbolId = 0;

  constructor(bundle: Uint8Array, transferId: number) {
    this.k = blockCount(bundle.length);
    if (this.k > MAX_K) {
      throw new RangeError(`bundle needs ${this.k} blocks, max is ${MAX_K}`);
    }
    this.#transferId = transferId;
    this.#blocks = new Uint8Array(this.k * DATA_BYTES);
    this.#blocks.set(bundle);
  }

  next(type: PacketType = PacketType.Data): Packet {
    if (this.nextSymbolId > MAX_SYMBOL_ID) {
      throw new RangeError(`symbol ids exhausted past ${MAX_SYMBOL_ID}`);
    }
    const symbolId = this.nextSymbolId++;
    const data = new Uint8Array(DATA_BYTES);
    for (const block of blockSet(this.#transferId, symbolId, this.k)) {
      const offset = block * DATA_BYTES;
      for (let i = 0; i < DATA_BYTES; i++) {
        data[i] ^= this.#blocks[offset + i];
      }
    }
    return { type, transferId: this.#transferId, k: this.k, symbolId, data };
  }
}

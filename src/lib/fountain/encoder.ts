import { type Packet, PacketType } from "../packet.ts";
import {
  COMPACT_MAX_K,
  COMPACT_MAX_SYMBOL_ID,
  dataBytes,
  MAX_BUNDLE_BYTES,
  MAX_SYMBOL_ID,
} from "../protocol.ts";
import { blockCount, blockSet } from "./symbols.ts";

export class Encoder {
  readonly k: number;
  readonly dataBytes: number;
  readonly #transferId: number;
  readonly #blocks: Uint8Array;
  private nextSymbolId = 0;

  constructor(bundle: Uint8Array, transferId: number, packetBytes: number) {
    if (bundle.length > MAX_BUNDLE_BYTES) {
      throw new RangeError(
        `bundle is ${bundle.length} bytes, max is ${MAX_BUNDLE_BYTES}`,
      );
    }
    this.k = blockCount(bundle.length, packetBytes);
    this.dataBytes = dataBytes(packetBytes, this.k);
    this.#transferId = transferId;
    this.#blocks = new Uint8Array(this.k * this.dataBytes);
    this.#blocks.set(bundle);
  }

  next(type: PacketType = PacketType.Data): Packet {
    const packet = this.symbol(this.nextSymbolId, type);
    this.nextSymbolId++;
    return packet;
  }

  symbol(symbolId: number, type: PacketType = PacketType.Data): Packet {
    const max = this.k <= COMPACT_MAX_K ? COMPACT_MAX_SYMBOL_ID : MAX_SYMBOL_ID;
    if (!Number.isInteger(symbolId) || symbolId < 0 || symbolId > max) {
      throw new RangeError(
        `symbol id ${symbolId} is not an integer in 0..${max}`,
      );
    }
    const data = new Uint8Array(this.dataBytes);
    for (const block of blockSet(this.#transferId, symbolId, this.k)) {
      const offset = block * this.dataBytes;
      for (let i = 0; i < this.dataBytes; i++) {
        data[i] ^= this.#blocks[offset + i];
      }
    }
    return { type, transferId: this.#transferId, k: this.k, symbolId, data };
  }
}

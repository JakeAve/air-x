import { type Packet, PacketType } from "../packet.ts";
import {
  COMPACT_MAX_K,
  COMPACT_MAX_SYMBOL_ID,
  dataBytes,
  DENSE_MAX_K,
  MAX_BUNDLE_BYTES,
  MAX_SYMBOL_ID,
} from "../protocol.ts";
import {
  type Code,
  makeCode,
  symbolData,
  symbolSolver,
  wordStride,
} from "./raptor.ts";
import { blockCount, blockSet } from "./symbols.ts";

export class Encoder {
  readonly k: number;
  readonly dataBytes: number;
  readonly #transferId: number;
  readonly #blocks: Uint8Array;
  readonly #raptor?: { code: Code; intermediates: Uint32Array };
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
    if (this.k > DENSE_MAX_K) {
      const code = makeCode(this.k);
      const stride = wordStride(this.dataBytes);
      const blocks = new Uint32Array(this.k * stride);
      const bytes = new Uint8Array(blocks.buffer);
      for (let b = 0; b < this.k; b++) {
        bytes.set(
          this.#blocks.subarray(b * this.dataBytes, (b + 1) * this.dataBytes),
          b * stride * 4,
        );
      }
      const isis = Array.from({ length: code.kPad }, (_, i) => i);
      const index = Int32Array.from(isis, (i) => (i < this.k ? i : -1));
      const intermediates = symbolSolver(code, isis, { blocks, index, stride })
        .intermediates();
      if (!intermediates) throw new Error(`no seed solves k ${this.k}`);
      this.#raptor = { code, intermediates };
    }
  }

  next(type: PacketType = PacketType.Data): Packet {
    const packet = this.symbol(this.nextSymbolId, type);
    // ponytail: after a wrap session.ts's ack bookkeeping stops producing rate samples; accepted, a transfer still running after that many symbols is not being received.
    this.nextSymbolId = this.nextSymbolId === this.#maxSymbolId
      ? 0
      : this.nextSymbolId + 1;
    return packet;
  }

  get #maxSymbolId(): number {
    return this.k <= COMPACT_MAX_K ? COMPACT_MAX_SYMBOL_ID : MAX_SYMBOL_ID;
  }

  symbol(symbolId: number, type: PacketType = PacketType.Data): Packet {
    const max = this.#maxSymbolId;
    if (!Number.isInteger(symbolId) || symbolId < 0 || symbolId > max) {
      throw new RangeError(
        `symbol id ${symbolId} is not an integer in 0..${max}`,
      );
    }
    const data = new Uint8Array(this.dataBytes);
    if (this.#raptor && symbolId >= this.k) {
      const { code, intermediates } = this.#raptor;
      symbolData(
        code,
        intermediates,
        wordStride(this.dataBytes),
        symbolId - this.k + code.kPad,
        data,
      );
    } else {
      for (const block of blockSet(this.#transferId, symbolId, this.k)) {
        const offset = block * this.dataBytes;
        for (let i = 0; i < this.dataBytes; i++) {
          data[i] ^= this.#blocks[offset + i];
        }
      }
    }
    return { type, transferId: this.#transferId, k: this.k, symbolId, data };
  }
}

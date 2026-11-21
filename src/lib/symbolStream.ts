import { Encoder } from "./fountain/encoder.ts";
import { type Packet, PacketType, type Run } from "./packet.ts";

/** Queued (resend) blocks first, then fresh symbols. */
export class SymbolStream {
  readonly k: number;
  /** Fresh symbols sent, which is also the next fresh symbol id. */
  fresh = 0;
  readonly #encoder: Encoder;
  readonly #wanted: number[] = [];
  readonly #queued = new Set<number>();

  constructor(bundle: Uint8Array, transferId: number, packetBytes: number) {
    this.#encoder = new Encoder(bundle, transferId, packetBytes);
    this.k = this.#encoder.k;
  }

  /** The last packet gets `lastType`, the rest are `Data`. */
  next(count: number, lastType: PacketType): Packet[] {
    return Array.from({ length: count }, (_, i) => {
      const type = i === count - 1 ? lastType : PacketType.Data;
      const id = this.#wanted.shift();
      if (id === undefined) {
        this.fresh++;
        return this.#encoder.next(type);
      }
      this.#queued.delete(id);
      return this.#encoder.symbol(id, type);
    });
  }

  /** Queues block ids from ack runs; returns how many were new. */
  resend(runs: Run[]): number {
    let added = 0;
    for (const { start, length } of runs) {
      for (let id = start; id < start + length && id < this.k; id++) {
        if (this.#queued.has(id)) continue;
        this.#queued.add(id);
        this.#wanted.push(id);
        added++;
      }
    }
    return added;
  }
}

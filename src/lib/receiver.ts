import { type Packet, PacketType } from "./packet.ts";
import { Decoder } from "./fountain/decoder.ts";

export interface TransferProgress {
  transferId: number;
  k: number;
  resolved: number;
}

export interface Completed {
  transferId: number;
  bundle: Uint8Array;
}

interface Entry {
  decoder: Decoder;
  lastHeard: number;
  completed: boolean;
}

const DEFAULT_STALE_MS = 30_000;
const DEFAULT_MAX_TRANSFERS = 4;

export class Receiver {
  readonly #staleMs: number;
  readonly #maxTransfers: number;
  readonly #transfers = new Map<number, Entry>();

  constructor(options?: { staleMs?: number; maxTransfers?: number }) {
    this.#staleMs = options?.staleMs ?? DEFAULT_STALE_MS;
    this.#maxTransfers = options?.maxTransfers ?? DEFAULT_MAX_TRANSFERS;
  }

  push(packet: Packet, now: number): Completed | undefined {
    if (packet.type === PacketType.Done) return undefined;

    this.#evictStale(now);

    let entry = this.#transfers.get(packet.transferId);
    if (entry?.completed) return undefined;

    if (!entry) {
      const decoder = new Decoder();
      const bundle = decoder.push(packet);
      if (decoder.k === undefined) return undefined;

      if (this.#transfers.size >= this.#maxTransfers) this.#evictLru();
      entry = { decoder, lastHeard: now, completed: false };
      this.#transfers.set(packet.transferId, entry);

      if (bundle) {
        entry.completed = true;
        return { transferId: packet.transferId, bundle };
      }
      return undefined;
    }

    entry.lastHeard = now;
    const bundle = entry.decoder.push(packet);
    if (bundle) {
      entry.completed = true;
      return { transferId: packet.transferId, bundle };
    }
    return undefined;
  }

  forget(transferId: number): void {
    this.#transfers.delete(transferId);
  }

  progress(): TransferProgress[] {
    return [...this.#transfers.entries()].map(([transferId, entry]) => ({
      transferId,
      k: entry.decoder.k!,
      resolved: entry.decoder.resolved,
    }));
  }

  #evictStale(now: number): void {
    for (const [transferId, entry] of this.#transfers) {
      if (now - entry.lastHeard > this.#staleMs) {
        this.#transfers.delete(transferId);
      }
    }
  }

  #evictLru(): void {
    let oldestId: number | undefined;
    let oldestHeard = Infinity;
    for (const [transferId, entry] of this.#transfers) {
      if (entry.lastHeard < oldestHeard) {
        oldestHeard = entry.lastHeard;
        oldestId = transferId;
      }
    }
    if (oldestId !== undefined) this.#transfers.delete(oldestId);
  }
}

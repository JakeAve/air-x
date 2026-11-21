import type { PacketSource } from "./channel.ts";
import { decodePacket, PacketType, type Run } from "./packet.ts";
import { Receiver } from "./receiver.ts";

/** What one heard unit told a transfer. */
export interface TransferHeard {
  transferId: number;
  /** New units (symbols, frames) in this report; 0 is a repeat. */
  fresh: number;
  /** Whether these units count toward `ackEvery` yet. */
  counting: boolean;
  /** Set by a sound decoder on a `DataListen`. */
  listen?: boolean;
}

/** The figures for one ack. */
export interface AckReport {
  /** The transfer's block count, for the Ack packet's layout; 0 without blocks. */
  k: number;
  /** The highest unit id heard. */
  highest: number;
  /** Fresh units heard. */
  heard: number;
  /** Fresh ids heard since the last ack, 0 to 1; undefined with none. */
  share?: number;
  runs: Run[];
}

export interface TransferStatus {
  transferId: number;
  /** 0 to 1. */
  progress: number;
  k?: number;
  states?(): Uint8Array;
}

export interface TransferDecoder {
  readonly name: string;
  /**
   * Every unit of a transfer heard. When a unit completes a transfer,
   * `onComplete` fires first, then `onHeard` for that unit.
   */
  onHeard(listener: (h: TransferHeard) => void): () => void;
  onComplete(
    listener: (transferId: number, bundle: Uint8Array) => void,
  ): () => void;
  /** The figures for an ack sent now; they become the base for the next `share`. */
  ack(transferId: number, maxRuns: number): AckReport | undefined;
  status(): TransferStatus[];
  /** Drops a transfer's decoding, e.g. after its bundle failed to decode. */
  forget(transferId: number): void;
  close(): void;
}

export interface PacketStats {
  /** Packets decoded, of any type. */
  heard: number;
  /** Symbols never heard before. */
  fresh: number;
  /** Byte strings that are not a packet. */
  rejected: number;
}

interface Tally {
  highest: number;
  heard: number;
}

/**
 * Fountain-coded packets from `source`. `countFrom: "first"` counts every
 * symbol toward acks; `"repair"` counts from a transfer's first repair symbol,
 * as a sound receiver hears a sender's whole first pass anyway.
 */
export function packetDecoder(
  source: PacketSource,
  options: { name: string; countFrom: "first" | "repair" },
): TransferDecoder & { readonly stats: PacketStats } {
  const receiver = new Receiver();
  const stats: PacketStats = { heard: 0, fresh: 0, rejected: 0 };
  const heardListeners = new Set<(h: TransferHeard) => void>();
  const completeListeners = new Set<
    (transferId: number, bundle: Uint8Array) => void
  >();
  const seenSymbols = new Set<number>();
  /** Per transfer: the highest symbol id heard, and how many arrived above the highest before them. Fresh symbols go out in id order and resends are always lower, so `heard` counts fresh ones. */
  const fresh = new Map<number, Tally>();
  /** Per transfer: `fresh` as of the last ack, or just below the first id heard, so a share needs no knowledge of when the sender began. */
  const base = new Map<number, Tally>();
  /** Transfers with a repair symbol heard: their missing blocks were all sent once. */
  const repairing = new Set<number>();

  const unsubscribe = source.onPacket((bytes) => {
    const packet = decodePacket(bytes);
    if (!packet) {
      stats.rejected++;
      return;
    }
    stats.heard++;
    // Another receiver's ack is not a symbol; DONE is not one either.
    if (packet.type === PacketType.Ack || packet.type === PacketType.Done) {
      return;
    }
    const { transferId, symbolId } = packet;
    const key = transferId * 2 ** 24 + symbolId;
    const isNew = !seenSymbols.has(key);
    seenSymbols.add(key);
    if (isNew) stats.fresh++;
    if (!fresh.has(transferId)) {
      base.set(transferId, { highest: symbolId - 1, heard: 0 });
    }
    const seen = fresh.get(transferId) ?? { highest: -1, heard: 0 };
    if (symbolId > seen.highest) {
      seen.highest = symbolId;
      seen.heard++;
    }
    fresh.set(transferId, seen);
    if (symbolId >= packet.k) repairing.add(transferId);

    const completed = receiver.push(packet, Date.now());
    if (completed) {
      for (const l of completeListeners) l(transferId, completed.bundle);
    }
    const heard: TransferHeard = {
      transferId,
      fresh: isNew ? 1 : 0,
      counting: options.countFrom === "first" || repairing.has(transferId),
    };
    if (packet.type === PacketType.DataListen) heard.listen = true;
    for (const l of heardListeners) l(heard);
  });

  const listen = <T>(set: Set<T>, l: T) => {
    set.add(l);
    return () => void set.delete(l);
  };

  return {
    name: options.name,
    stats,
    onHeard: (l) => listen(heardListeners, l),
    onComplete: (l) => listen(completeListeners, l),
    ack(transferId, maxRuns) {
      const transfer = receiver.progress().find((t) =>
        t.transferId === transferId
      );
      if (!transfer) return undefined;
      const { highest, heard } = fresh.get(transferId)!;
      const from = base.get(transferId)!;
      const span = highest - from.highest;
      base.set(transferId, { highest, heard });
      return {
        k: transfer.k,
        highest,
        heard,
        share: span > 0 ? (heard - from.heard) / span : undefined,
        runs: repairing.has(transferId) ? transfer.missing(maxRuns) : [],
      };
    },
    status: () =>
      receiver.progress().map((t) => ({
        transferId: t.transferId,
        progress: t.resolved / t.k,
        k: t.k,
        states: t.states,
      })),
    forget: (transferId) => receiver.forget(transferId),
    close() {
      unsubscribe();
      heardListeners.clear();
      completeListeners.clear();
    },
  };
}

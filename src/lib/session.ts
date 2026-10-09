import { anySignal, sleep } from "./abort.ts";
import { BundleError, decodeBundle, type Item } from "./bundle.ts";
import type { PacketChannel, PacketDisplay, PacketSource } from "./channel.ts";
import { Encoder } from "./fountain/encoder.ts";
import {
  ackHeard,
  decodeAck,
  decodePacket,
  encodeAck,
  encodePacket,
  type Packet,
  PacketType,
  type Run,
} from "./packet.ts";
import {
  ACK_RUNS,
  dataBytes,
  QR_PACKET_BYTES,
  SOUND_PACKET_BYTES,
} from "./protocol.ts";
import type { QrRate, RatePolicy } from "./rate.ts";
import { type Completed, Receiver, type TransferProgress } from "./receiver.ts";

export interface SendProgress {
  transferId: number;
  k: number;
  soundSent: number;
  qrSent: number;
  codes: number;
  /** The batch that just went out. */
  via: "sound" | "qr";
  symbolIds: number[];
  /** Blocks queued for resend from acks so far. */
  acked: number;
  /** The rate of a QR batch. */
  rate?: QrRate;
}

export interface SoundSend {
  channel: PacketChannel;
  listenEvery: number;
  windowMs: number;
}

export interface QrSend {
  display: PacketDisplay;
  /** With `adapt`, only where the rate starts. */
  packetsPerCode: number;
  fps: number;
  /**
   * Lets `policy` change the rate as the receiver's acks come in. It gets one
   * sample per ack whose stretch of fresh symbols all went out at the current
   * rate (the first ack, and one spanning a rate change, only set the
   * baseline), and one with `heard` undefined each time `silentAfter` fresh
   * symbols go out with no ack.
   */
  adapt?: { policy: RatePolicy; silentAfter: number };
}

export interface SendOptions {
  /** Where DONE and acks are heard. */
  listen: PacketSource;
  /** Exactly one of `sound` and `qr`. */
  sound?: SoundSend;
  qr?: QrSend;
  signal: AbortSignal;
  onProgress?: (p: SendProgress) => void;
}

export async function sendBundle(
  bundle: Uint8Array,
  options: SendOptions,
): Promise<"done" | "stopped"> {
  const { listen, sound, qr, signal, onProgress } = options;
  if (!sound && !qr) throw new RangeError("sendBundle needs sound or qr");
  if (sound && qr) {
    throw new RangeError("sendBundle takes sound or qr, not both");
  }
  const transferId = crypto.getRandomValues(new Uint16Array(1))[0];
  const encoder = new Encoder(
    bundle,
    transferId,
    qr ? QR_PACKET_BYTES : SOUND_PACKET_BYTES,
  );
  const heardDone = new AbortController();
  const stop = anySignal(signal, heardDone.signal);
  let soundSent = 0;
  let qrSent = 0;
  let codes = 0;
  let acked = 0;
  const wanted: number[] = [];
  const queued = new Set<number>();
  let rate: QrRate = {
    packetsPerCode: qr?.packetsPerCode ?? 0,
    fps: qr?.fps ?? 0,
  };
  /** Fresh symbols sent, which is also the next fresh symbol id. */
  let fresh = 0;
  /** First fresh id sent at `rate`. */
  let rateSince = 0;
  /** Fresh count when the receiver was last heard from, or last given up on. */
  let quietSince = 0;
  // ponytail: one baseline, so two receivers acking in turn give samples that
  // mix their counts; keep one per receiver if acks ever say who sent them.
  let reported: { highest: number; heard: number } | undefined;
  const retune = (sent: number, heard: number | undefined) => {
    const next = qr!.adapt!.policy({ rate, sent, heard });
    quietSince = fresh;
    if (next.packetsPerCode === rate.packetsPerCode && next.fps === rate.fps) {
      return;
    }
    rate = next;
    rateSince = fresh;
  };
  const progress = (via: "sound" | "qr", symbolIds: number[]) =>
    onProgress?.({
      transferId,
      k: encoder.k,
      soundSent,
      qrSent,
      codes,
      via,
      symbolIds,
      acked,
      rate: via === "qr" ? rate : undefined,
    });

  /** Queued blocks first, then fresh symbols; the last packet gets `lastType`. */
  const batch = (count: number, lastType: PacketType): Packet[] =>
    Array.from({ length: count }, (_, i) => {
      const type = i === count - 1 ? lastType : PacketType.Data;
      const id = wanted.shift();
      if (id === undefined) {
        fresh++;
        return encoder.next(type);
      }
      queued.delete(id);
      return encoder.symbol(id, type);
    });

  const unsubscribe = listen.onPacket((bytes) => {
    if (stop.aborted) return;
    const packet = decodePacket(bytes);
    if (packet?.transferId !== transferId) return;
    if (packet.type === PacketType.Done) heardDone.abort();
    if (packet.type !== PacketType.Ack) return;
    const last = reported;
    if (qr?.adapt && (!last || packet.symbolId > last.highest)) {
      reported = { highest: packet.symbolId, heard: ackHeard(packet.data) };
      quietSince = fresh;
      if (last && last.highest + 1 >= rateSince) {
        const sent = reported.highest - last.highest;
        const heard = reported.heard - last.heard;
        retune(sent, Math.max(0, Math.min(sent, heard)));
      }
    }
    for (const { start, length } of decodeAck(packet.data)) {
      for (let id = start; id < start + length && id < encoder.k; id++) {
        if (queued.has(id)) continue;
        queued.add(id);
        wanted.push(id);
        acked++;
      }
    }
  });

  try {
    while (!stop.aborted) {
      if (sound) {
        const { channel, listenEvery, windowMs } = sound;
        const symbols = batch(listenEvery, PacketType.DataListen);
        await channel.send(symbols.map(encodePacket), stop);
        if (stop.aborted) break;
        soundSent += symbols.length;
        progress("sound", symbols.map((s) => s.symbolId));
        await sleep(windowMs, stop);
      } else if (qr) {
        const symbols = batch(rate.packetsPerCode, PacketType.Data);
        qr.display.show(symbols.map(encodePacket));
        qrSent += symbols.length;
        codes++;
        progress("qr", symbols.map((s) => s.symbolId));
        if (qr.adapt && fresh - quietSince >= qr.adapt.silentAfter) {
          retune(fresh - quietSince, undefined);
        }
        await sleep(1000 / rate.fps, stop);
      }
    }
  } catch (err) {
    if (!stop.aborted) throw err;
  } finally {
    unsubscribe();
    qr?.display.clear();
  }
  return heardDone.signal.aborted ? "done" : "stopped";
}

export interface ReceiveProgress {
  heard: number;
  soundHeard: number;
  sourceHeard: number;
  sourceNew: number;
  rejected: number;
  /** Acks sent. */
  acked: number;
  transfers: TransferProgress[];
}

export interface Received {
  transferId: number;
  items: Item[];
}

export interface ReceiveOptions {
  /** DONE goes out here; silence and DataListen rules count only this channel. */
  sound: PacketChannel;
  sources?: PacketSource[];
  silenceMs: number;
  /** Wait before each DONE or ack, so it lands after the sender's microphone is rolling again. */
  turnaroundMs?: number;
  /**
   * Ack every this many new symbols heard, resends included; undefined never
   * acks. Counting starts at a transfer's first symbol from a source, or at
   * its first repair symbol when it comes by sound. Every ack reports the
   * fresh symbols heard, for a sender adapting its rate; it names missing
   * blocks only once a repair symbol was heard (the first pass is over). A
   * bundle that finishes inside the period never acks.
   */
  ackEvery?: number;
  signal: AbortSignal;
  onProgress?: (p: ReceiveProgress) => void;
  onComplete?: (r: Received) => void;
  onDone?: (transferId: number) => void;
  onAck?: (transferId: number, runs: Run[]) => void;
}

export function receiveBundle(
  options: ReceiveOptions,
): Promise<Received | undefined> {
  const {
    sound,
    sources = [],
    silenceMs,
    turnaroundMs = 0,
    ackEvery,
    signal,
    onProgress,
    onComplete,
    onDone,
    onAck,
  } = options;

  return new Promise((resolve, reject) => {
    const receiver = new Receiver();
    let soundHeard = 0;
    let sourceHeard = 0;
    let sourceNew = 0;
    let rejected = 0;
    let acked = 0;
    const seenSymbols = new Set<number>();
    let received: Received | undefined;
    let doneSent = false;
    let heardSinceDone = false;
    let sending = false;
    let finished = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let completions = Promise.resolve();
    const lastSound = new Map<number, number>();
    /** Per transfer, once counting began: new symbols since then or since the last ack. */
    const heardSince = new Map<number, number>();
    /** Per transfer: the highest symbol id heard, and how many arrived above the highest before them. Fresh symbols go out in id order and resends are always lower, so `heard` counts fresh ones. */
    const fresh = new Map<number, { highest: number; heard: number }>();
    /** Transfers with a repair symbol heard: their missing blocks were all sent once. */
    const repairing = new Set<number>();
    /** Transfer whose ack waits for the next DataListen. */
    let ackPending: number | undefined;
    /** Completion's DONE-or-silence step, held while an ack is in flight. */
    let afterAck: (() => void) | undefined;

    const armSilence = () => {
      if (finished || sending) return;
      clearTimeout(timer);
      timer = setTimeout(
        () => doneSent && !heardSinceDone ? finish() : sendDone(),
        silenceMs,
      );
    };

    const sendDone = async () => {
      if (finished || sending) return;
      sending = true;
      clearTimeout(timer);
      const { transferId } = received!;
      try {
        if (turnaroundMs > 0) {
          await sleep(turnaroundMs, signal);
          if (finished) return;
        }
        await sound.send([
          encodePacket({
            type: PacketType.Done,
            transferId,
            k: 0,
            symbolId: 0,
            data: new Uint8Array(dataBytes(SOUND_PACKET_BYTES, 0)),
          }),
        ], signal);
        if (finished) return;
        doneSent = true;
        heardSinceDone = false;
        onDone?.(transferId);
      } catch (err) {
        if (!signal.aborted) finish(err);
      } finally {
        sending = false;
      }
      armSilence();
    };

    /** Ack now if the sender is not chirping, else at its next DataListen. */
    const tryAck = (transferId: number) => {
      if (finished || received) return;
      const soundAt = lastSound.get(transferId);
      if (soundAt === undefined || Date.now() - soundAt >= silenceMs) {
        sendAck(transferId);
      } else {
        ackPending = transferId;
      }
    };

    const sendAck = async (transferId: number) => {
      if (finished || sending || received) return;
      sending = true;
      ackPending = undefined;
      try {
        if (turnaroundMs > 0) {
          await sleep(turnaroundMs, signal);
          if (finished || received) return;
        }
        const transfer = receiver.progress().find((t) =>
          t.transferId === transferId
        );
        if (!transfer) return;
        const runs = repairing.has(transferId)
          ? transfer.missing(ACK_RUNS)
          : [];
        const { highest, heard } = fresh.get(transferId)!;
        await sound.send([
          encodePacket({
            type: PacketType.Ack,
            transferId,
            k: transfer.k,
            symbolId: highest,
            data: encodeAck(
              runs,
              heard,
              dataBytes(SOUND_PACKET_BYTES, transfer.k),
            ),
          }),
        ], signal);
        if (finished) return;
        acked++;
        heardSince.set(transferId, 0);
        onAck?.(transferId, runs);
      } catch (err) {
        if (!signal.aborted) finish(err);
      } finally {
        sending = false;
        // A transfer that completed meanwhile had its DONE blocked by `sending`.
        if (!finished) {
          const next = afterAck;
          afterAck = undefined;
          if (next) next();
        }
      }
    };

    const complete = async (completed: Completed, soundListen: boolean) => {
      if (received) return;
      let items: Item[];
      try {
        items = await decodeBundle(completed.bundle);
      } catch (err) {
        if (!(err instanceof BundleError)) throw err;
        receiver.forget(completed.transferId);
        return;
      }
      if (finished) return;
      received = { transferId: completed.transferId, items };
      const soundAt = lastSound.get(completed.transferId);
      lastSound.clear();
      onComplete?.(received);
      const kick = () =>
        soundListen || soundAt === undefined ||
          Date.now() - soundAt >= silenceMs
          ? sendDone()
          : armSilence();
      if (sending) afterAck = kick;
      else kick();
    };

    const hearSymbol = (packet: Packet, fromSound: boolean) => {
      let isNew = false;
      if (packet.type !== PacketType.Done) {
        const key = packet.transferId * 2 ** 24 + packet.symbolId;
        isNew = !seenSymbols.has(key);
        seenSymbols.add(key);
        if (!fromSound && isNew) sourceNew++;
        const seen = fresh.get(packet.transferId) ?? { highest: -1, heard: 0 };
        if (packet.symbolId > seen.highest) {
          seen.highest = packet.symbolId;
          seen.heard++;
        }
        fresh.set(packet.transferId, seen);
        if (packet.symbolId >= packet.k) repairing.add(packet.transferId);
      }
      const soundListen = fromSound && packet.type === PacketType.DataListen;
      if (fromSound && !received && packet.type !== PacketType.Done) {
        lastSound.set(packet.transferId, Date.now());
      }
      const completed = receiver.push(packet, Date.now());
      if (completed) {
        completions = completions
          .then(() => complete(completed, soundListen))
          .catch(finish);
      } else if (
        received?.transferId === packet.transferId &&
        packet.type !== PacketType.Done
      ) {
        if (doneSent) heardSinceDone = true;
        if (soundListen) sendDone();
        else if (fromSound) armSilence();
      } else if (
        ackEvery !== undefined && !received && packet.type !== PacketType.Done
      ) {
        const { transferId } = packet;
        const counting = heardSince.has(transferId) ||
          packet.symbolId >= packet.k || !fromSound;
        if (isNew && counting) {
          const heard = (heardSince.get(transferId) ?? 0) + 1;
          heardSince.set(transferId, heard);
          if (heard >= ackEvery) tryAck(transferId);
        }
        if (soundListen && ackPending === transferId) sendAck(transferId);
      }
    };

    const hear = (bytes: Uint8Array, fromSound: boolean) => {
      if (finished) return;
      const packet = decodePacket(bytes);
      if (!packet) {
        rejected++;
      } else {
        if (fromSound) soundHeard++;
        else sourceHeard++;
        // Another receiver's ack is neither a symbol nor sound from the sender.
        if (packet.type !== PacketType.Ack) hearSymbol(packet, fromSound);
      }
      onProgress?.({
        heard: soundHeard + sourceHeard,
        soundHeard,
        sourceHeard,
        sourceNew,
        rejected,
        acked,
        transfers: receiver.progress(),
      });
    };

    const unsubscribes = [
      sound.onPacket((bytes) => hear(bytes, true)),
      ...sources.map((source) =>
        source.onPacket((bytes) => hear(bytes, false))
      ),
    ];

    const finish = (err?: unknown) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      for (const unsubscribe of unsubscribes) unsubscribe();
      signal.removeEventListener("abort", onAbort);
      if (err === undefined) resolve(received);
      else reject(err);
    };
    const onAbort = () => finish();

    if (signal.aborted) finish();
    else signal.addEventListener("abort", onAbort, { once: true });
  });
}

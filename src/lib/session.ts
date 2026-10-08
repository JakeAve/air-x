import { anySignal, sleep } from "./abort.ts";
import { BundleError, decodeBundle, type Item } from "./bundle.ts";
import type { PacketChannel, PacketDisplay, PacketSource } from "./channel.ts";
import { Encoder } from "./fountain/encoder.ts";
import {
  decodeAck,
  decodePacket,
  encodeAck,
  encodePacket,
  type Packet,
  PacketType,
  type Run,
} from "./packet.ts";
import { ACK_RUNS, DATA_BYTES } from "./protocol.ts";
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
}

export interface SoundSend {
  channel: PacketChannel;
  listenEvery: number;
  windowMs: number;
}

export interface QrSend {
  display: PacketDisplay;
  packetsPerCode: number;
  fps: number;
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
  const encoder = new Encoder(bundle, transferId);
  const heardDone = new AbortController();
  const stop = anySignal(signal, heardDone.signal);
  let soundSent = 0;
  let qrSent = 0;
  let codes = 0;
  let acked = 0;
  const wanted: number[] = [];
  const queued = new Set<number>();
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
    });

  /** Queued blocks first, then fresh symbols; the last packet gets `lastType`. */
  const batch = (count: number, lastType: PacketType): Packet[] =>
    Array.from({ length: count }, (_, i) => {
      const type = i === count - 1 ? lastType : PacketType.Data;
      const id = wanted.shift();
      if (id === undefined) return encoder.next(type);
      queued.delete(id);
      return encoder.symbol(id, type);
    });

  const unsubscribe = listen.onPacket((bytes) => {
    if (stop.aborted) return;
    const packet = decodePacket(bytes);
    if (packet?.transferId !== transferId) return;
    if (packet.type === PacketType.Done) heardDone.abort();
    if (packet.type !== PacketType.Ack) return;
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
        const symbols = batch(qr.packetsPerCode, PacketType.Data);
        qr.display.show(symbols.map(encodePacket));
        qrSent += symbols.length;
        codes++;
        progress("qr", symbols.map((s) => s.symbolId));
        await sleep(1000 / qr.fps, stop);
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
  /** Ack the missing blocks once the sender's first pass is over and none has resolved for this long; undefined never acks. */
  ackAfterMs?: number;
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
    ackAfterMs,
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
    let ackTimer: ReturnType<typeof setTimeout> | undefined;
    let completions = Promise.resolve();
    const lastSound = new Map<number, number>();
    /** Transfers with a symbol id at or past k heard: the sender's first pass is over. */
    const pastK = new Set<number>();
    let lastIncomplete: number | undefined;
    /** Stalled transfer whose ack waits for the next DataListen. */
    let ackPending: number | undefined;
    /** Completion's DONE-or-silence step, held while an ack is in flight. */
    let afterAck: (() => void) | undefined;
    const resolvedOf = (transferId: number) =>
      receiver.progress().find((t) => t.transferId === transferId)?.resolved ??
        0;

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
            data: new Uint8Array(DATA_BYTES),
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

    const armAck = () => {
      if (ackAfterMs === undefined || finished || received) return;
      ackPending = undefined;
      clearTimeout(ackTimer);
      ackTimer = setTimeout(() => {
        const transferId = lastIncomplete;
        if (received || transferId === undefined || !pastK.has(transferId)) {
          return;
        }
        const soundAt = lastSound.get(transferId);
        if (soundAt === undefined || Date.now() - soundAt >= silenceMs) {
          sendAck(transferId);
        } else {
          ackPending = transferId;
        }
      }, ackAfterMs);
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
        const runs = transfer?.missing(ACK_RUNS) ?? [];
        if (!transfer || runs.length === 0) return;
        await sound.send([
          encodePacket({
            type: PacketType.Ack,
            transferId,
            k: transfer.k,
            symbolId: transfer.resolved,
            data: encodeAck(runs),
          }),
        ], signal);
        if (finished) return;
        acked++;
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
          else if (!received) armAck();
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
      if (packet.type !== PacketType.Done) {
        const key = packet.transferId * 2 ** 24 + packet.symbolId;
        const isNew = !seenSymbols.has(key);
        seenSymbols.add(key);
        if (!fromSound && isNew) sourceNew++;
      }
      const soundListen = fromSound && packet.type === PacketType.DataListen;
      if (fromSound && !received && packet.type !== PacketType.Done) {
        lastSound.set(packet.transferId, Date.now());
      }
      const before = resolvedOf(packet.transferId);
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
        ackAfterMs !== undefined && !received &&
        packet.type !== PacketType.Done
      ) {
        lastIncomplete = packet.transferId;
        const firstPastK = packet.symbolId >= packet.k &&
          !pastK.has(packet.transferId);
        if (firstPastK) pastK.add(packet.transferId);
        if (firstPastK || resolvedOf(packet.transferId) > before) armAck();
        else if (soundListen && ackPending === packet.transferId) {
          sendAck(packet.transferId);
        }
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
      clearTimeout(ackTimer);
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

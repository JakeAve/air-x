import { anySignal, sleep } from "./abort.ts";
import { BundleError, decodeBundle, type Item } from "./bundle.ts";
import type { PacketChannel, PacketDisplay, PacketSource } from "./channel.ts";
import { Encoder } from "./fountain/encoder.ts";
import { decodePacket, encodePacket, PacketType } from "./packet.ts";
import { DATA_BYTES } from "./protocol.ts";
import { type Completed, Receiver, type TransferProgress } from "./receiver.ts";

export interface SendProgress {
  transferId: number;
  k: number;
  soundSent: number;
  qrSent: number;
  codes: number;
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
  /** Where DONE is heard. */
  listen: PacketSource;
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
  const transferId = crypto.getRandomValues(new Uint16Array(1))[0];
  const encoder = new Encoder(bundle, transferId);
  const heardDone = new AbortController();
  const failed = new AbortController();
  const stop = anySignal(signal, heardDone.signal, failed.signal);
  let soundSent = 0;
  let qrSent = 0;
  let codes = 0;
  const progress = () =>
    onProgress?.({ transferId, k: encoder.k, soundSent, qrSent, codes });

  const loop = async (body: () => Promise<void>, cleanup?: () => void) => {
    try {
      while (!stop.aborted) await body();
    } catch (err) {
      if (!stop.aborted) {
        failed.abort();
        throw err;
      }
    } finally {
      cleanup?.();
    }
  };

  const unsubscribe = listen.onPacket((bytes) => {
    if (stop.aborted) return;
    const packet = decodePacket(bytes);
    if (packet?.type === PacketType.Done && packet.transferId === transferId) {
      heardDone.abort();
    }
  });

  try {
    await Promise.all([
      sound && loop(async () => {
        const { channel, listenEvery, windowMs } = sound;
        const packets = Array.from(
          { length: listenEvery },
          (_, i) =>
            encodePacket(encoder.next(
              i === listenEvery - 1 ? PacketType.DataListen : PacketType.Data,
            )),
        );
        await channel.send(packets, stop);
        if (stop.aborted) return;
        soundSent += packets.length;
        progress();
        await sleep(windowMs, stop);
      }),
      qr && loop(async () => {
        const packets = Array.from(
          { length: qr.packetsPerCode },
          () => encodePacket(encoder.next(PacketType.Data)),
        );
        qr.display.show(packets);
        qrSent += packets.length;
        codes++;
        progress();
        await sleep(1000 / qr.fps, stop);
      }, () => qr.display.clear()),
    ]);
  } finally {
    unsubscribe();
  }
  return heardDone.signal.aborted ? "done" : "stopped";
}

export interface ReceiveProgress {
  heard: number;
  soundHeard: number;
  sourceHeard: number;
  sourceNew: number;
  rejected: number;
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
  /** Wait before each DONE, so it lands after the sender's microphone is rolling again. */
  turnaroundMs?: number;
  signal: AbortSignal;
  onProgress?: (p: ReceiveProgress) => void;
  onComplete?: (r: Received) => void;
  onDone?: (transferId: number) => void;
}

export function receiveBundle(
  options: ReceiveOptions,
): Promise<Received | undefined> {
  const {
    sound,
    sources = [],
    silenceMs,
    turnaroundMs = 0,
    signal,
    onProgress,
    onComplete,
    onDone,
  } = options;

  return new Promise((resolve, reject) => {
    const receiver = new Receiver();
    let soundHeard = 0;
    let sourceHeard = 0;
    let sourceNew = 0;
    let rejected = 0;
    const seenSymbols = new Set<number>();
    let received: Received | undefined;
    let doneSent = false;
    let heardSinceDone = false;
    let sending = false;
    let finished = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let completions = Promise.resolve();
    const lastSound = new Map<number, number>();

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
      if (
        soundListen || soundAt === undefined ||
        Date.now() - soundAt >= silenceMs
      ) {
        sendDone();
      } else {
        armSilence();
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
        if (packet.type !== PacketType.Done) {
          const key = packet.transferId * 2 ** 24 + packet.symbolId;
          const isNew = !seenSymbols.has(key);
          seenSymbols.add(key);
          if (!fromSound && isNew) sourceNew++;
        }
        const soundListen = fromSound &&
          packet.type === PacketType.DataListen;
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
        }
      }
      onProgress?.({
        heard: soundHeard + sourceHeard,
        soundHeard,
        sourceHeard,
        sourceNew,
        rejected,
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

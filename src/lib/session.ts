import { anySignal, sleep } from "./abort.ts";
import { BundleError, decodeBundle, type Item } from "./bundle.ts";
import type { PacketChannel } from "./channel.ts";
import { Encoder } from "./fountain/encoder.ts";
import { decodePacket, encodePacket, PacketType } from "./packet.ts";
import { DATA_BYTES } from "./protocol.ts";
import { type Completed, Receiver, type TransferProgress } from "./receiver.ts";

export interface SendProgress {
  transferId: number;
  k: number;
  sent: number;
}

export interface SendOptions {
  listenEvery: number;
  windowMs: number;
  signal: AbortSignal;
  onProgress?: (p: SendProgress) => void;
}

export async function sendBundle(
  channel: PacketChannel,
  bundle: Uint8Array,
  options: SendOptions,
): Promise<"done" | "stopped"> {
  const { listenEvery, windowMs, signal, onProgress } = options;
  const transferId = crypto.getRandomValues(new Uint16Array(1))[0];
  const encoder = new Encoder(bundle, transferId);
  const heardDone = new AbortController();
  const stop = anySignal(signal, heardDone.signal);

  const unsubscribe = channel.onPacket((bytes) => {
    if (stop.aborted) return;
    const packet = decodePacket(bytes);
    if (packet?.type === PacketType.Done && packet.transferId === transferId) {
      heardDone.abort();
    }
  });

  let sent = 0;
  try {
    while (!stop.aborted) {
      const packets = Array.from(
        { length: listenEvery },
        (_, i) =>
          encodePacket(encoder.next(
            i === listenEvery - 1 ? PacketType.DataListen : PacketType.Data,
          )),
      );
      await channel.send(packets, stop);
      if (stop.aborted) break;
      sent += packets.length;
      onProgress?.({ transferId, k: encoder.k, sent });
      await sleep(windowMs, stop);
    }
  } catch (err) {
    if (!stop.aborted) throw err;
  } finally {
    unsubscribe();
  }
  return heardDone.signal.aborted ? "done" : "stopped";
}

export interface ReceiveProgress {
  heard: number;
  rejected: number;
  transfers: TransferProgress[];
}

export interface Received {
  transferId: number;
  items: Item[];
}

export interface ReceiveOptions {
  silenceMs: number;
  /** Wait before each DONE, so it lands after the sender's microphone is rolling again. */
  turnaroundMs?: number;
  signal: AbortSignal;
  onProgress?: (p: ReceiveProgress) => void;
  onComplete?: (r: Received) => void;
  onDone?: (transferId: number) => void;
}

export function receiveBundle(
  channel: PacketChannel,
  options: ReceiveOptions,
): Promise<Received | undefined> {
  const {
    silenceMs,
    turnaroundMs = 0,
    signal,
    onProgress,
    onComplete,
    onDone,
  } = options;

  return new Promise((resolve, reject) => {
    const receiver = new Receiver();
    let heard = 0;
    let rejected = 0;
    let received: Received | undefined;
    let doneSent = false;
    let sending = false;
    let finished = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let completions = Promise.resolve();

    const armSilence = () => {
      if (finished || sending) return;
      clearTimeout(timer);
      timer = setTimeout(() => doneSent ? finish() : sendDone(), silenceMs);
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
        await channel.send([
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
        onDone?.(transferId);
      } catch (err) {
        if (!signal.aborted) finish(err);
      } finally {
        sending = false;
      }
      armSilence();
    };

    const complete = async (completed: Completed, listening: boolean) => {
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
      onComplete?.(received);
      if (listening) sendDone();
      else armSilence();
    };

    const unsubscribe = channel.onPacket((bytes) => {
      if (finished) return;
      const packet = decodePacket(bytes);
      if (!packet) {
        rejected++;
      } else {
        heard++;
        const listening = packet.type === PacketType.DataListen;
        const completed = receiver.push(packet, Date.now());
        if (completed) {
          completions = completions
            .then(() => complete(completed, listening))
            .catch(finish);
        } else if (
          received?.transferId === packet.transferId &&
          packet.type !== PacketType.Done
        ) {
          if (listening) sendDone();
          else armSilence();
        }
      }
      onProgress?.({ heard, rejected, transfers: receiver.progress() });
    });

    const finish = (err?: unknown) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      unsubscribe();
      signal.removeEventListener("abort", onAbort);
      if (err === undefined) resolve(received);
      else reject(err);
    };
    const onAbort = () => finish();

    if (signal.aborted) finish();
    else signal.addEventListener("abort", onAbort, { once: true });
  });
}

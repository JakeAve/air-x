import { anySignal, sleep } from "./abort.ts";
import { BundleError, decodeBundle, type Item } from "./bundle.ts";
import type { CameraEncoder, CameraSending } from "./cameraCodec.ts";
import type { PacketChannel, PacketSource } from "./channel.ts";
import {
  ackShare,
  decodeAck,
  decodePacket,
  encodeAck,
  encodePacket,
  PacketType,
  type Run,
} from "./packet.ts";
import { ACK_RUNS, dataBytes, SOUND_PACKET_BYTES } from "./protocol.ts";
import type { CameraRate, RatePolicy, RateSample } from "./rate.ts";
import { SymbolStream } from "./symbolStream.ts";
import {
  packetDecoder,
  type PacketStats,
  type TransferDecoder,
  type TransferHeard,
  type TransferStatus,
} from "./transferDecoder.ts";

export interface SendProgress {
  transferId: number;
  /** The sound transfer's block count; a camera codec's units need not be blocks. */
  k?: number;
  soundSent: number;
  cameraFrames: number;
  /** Fresh units the camera codec sent. */
  cameraFresh: number;
  /** Fresh bytes sent on the live path. */
  freshBytes: number;
  /** The batch or frame that just went out. */
  via: "sound" | "camera";
  symbolIds: number[];
  /** Blocks queued for resend from acks so far. */
  acked: number;
  /** The last ack's share heard. */
  share?: number;
  /** The rate of a camera frame. */
  rate?: CameraRate;
}

export interface SoundSend {
  channel: PacketChannel;
  listenEvery: number;
  windowMs: number;
}

export interface CameraSend {
  encoder: CameraEncoder;
  /** With `adapt`, only where the rate starts. */
  rate: CameraRate;
  /**
   * Lets `policy` change the rate as the receiver's acks come in: one sample
   * per ack, from the share heard the receiver measured itself,
   * and a silent one each time `silentAfter` fresh units go out with no ack,
   * once some ack was heard (before that, no one may be looking yet).
   */
  adapt?: { policy: RatePolicy; silentAfter: number };
}

export interface SendOptions {
  /** Where DONE and acks are heard. */
  listen: PacketSource;
  /** Exactly one of `sound` and `camera`. */
  sound?: SoundSend;
  camera?: CameraSend;
  signal: AbortSignal;
  onProgress?: (p: SendProgress) => void;
}

export async function sendBundle(
  bundle: Uint8Array,
  options: SendOptions,
): Promise<"done" | "stopped"> {
  const { listen, sound, camera, signal, onProgress } = options;
  if (!sound && !camera) {
    throw new RangeError("sendBundle needs sound or camera");
  }
  if (sound && camera) {
    throw new RangeError("sendBundle takes sound or camera, not both");
  }
  const transferId = crypto.getRandomValues(new Uint16Array(1))[0];
  const heardDone = new AbortController();
  const stop = anySignal(signal, heardDone.signal);
  const stream = sound
    ? new SymbolStream(bundle, transferId, SOUND_PACKET_BYTES)
    : undefined;
  let soundSent = 0;
  let cameraFrames = 0;
  let cameraFresh = 0;
  let freshBytes = 0;
  let acked = 0;
  let share: number | undefined;
  let rate = camera?.rate;
  let sending: CameraSending | undefined;
  /** Fresh count when the receiver was last heard from, or last given up on. */
  let quietSince = 0;
  /** Silence means nothing until a receiver has acked: it may not be looking yet. */
  let everAcked = false;
  const retune = (sample: Omit<RateSample, "rate">) => {
    rate = camera!.adapt!.policy({ rate: rate!, ...sample });
    quietSince = sending!.fresh;
    sending!.setRate(rate);
  };
  const progress = (
    via: "sound" | "camera",
    symbolIds: number[],
    frameRate?: CameraRate,
  ) =>
    onProgress?.({
      transferId,
      k: stream?.k,
      soundSent,
      cameraFrames,
      cameraFresh,
      freshBytes,
      via,
      symbolIds,
      acked,
      share,
      rate: frameRate,
    });

  const unsubscribe = listen.onPacket((bytes) => {
    if (stop.aborted) return;
    const packet = decodePacket(bytes);
    if (packet?.transferId !== transferId) return;
    if (packet.type === PacketType.Done) heardDone.abort();
    if (packet.type !== PacketType.Ack) return;
    const heard = ackShare(packet.data);
    if (heard !== undefined) share = heard;
    if (camera?.adapt && sending) {
      // ponytail: the receiver's stretch since its last ack can straddle a
      // rate change by the ack's flight time; ignored.
      quietSince = sending.fresh;
      everAcked = true;
      if (heard !== undefined) retune({ heard });
    }
    acked += (stream ?? sending)?.resend(decodeAck(packet.data)) ?? 0;
  });

  try {
    if (sound && stream) {
      const { channel, listenEvery, windowMs } = sound;
      const blockBytes = dataBytes(SOUND_PACKET_BYTES, stream.k);
      while (!stop.aborted) {
        const symbols = stream.next(listenEvery, PacketType.DataListen);
        await channel.send(symbols.map(encodePacket), stop);
        if (stop.aborted) break;
        soundSent += symbols.length;
        freshBytes = stream.fresh * blockBytes;
        progress("sound", symbols.map((s) => s.symbolId));
        await sleep(windowMs, stop);
      }
    } else if (camera) {
      sending = camera.encoder.start(bundle, transferId, rate!, stop, (f) => {
        cameraFrames = f.frames;
        cameraFresh = f.fresh;
        freshBytes = f.freshBytes;
        progress("camera", f.symbolIds ?? [], f.rate);
        if (
          camera.adapt && everAcked &&
          f.fresh - quietSince >= camera.adapt.silentAfter
        ) {
          retune({ silent: true });
        }
      });
      await sending.done;
    }
  } catch (err) {
    if (!stop.aborted) throw err;
  } finally {
    unsubscribe();
  }
  return heardDone.signal.aborted ? "done" : "stopped";
}

export interface ReceiveProgress {
  /** Acks sent. */
  acked: number;
  sound: PacketStats;
  /** `via`: the name of the decoder the transfer belongs to. */
  transfers: (TransferStatus & { via: string })[];
}

export interface Received {
  transferId: number;
  items: Item[];
}

export interface ReceiveOptions {
  /** DONE goes out here; silence and DataListen rules count only this channel. */
  sound: PacketChannel;
  /** A transfer belongs to the decoder that first reports it. */
  camera?: TransferDecoder[];
  silenceMs: number;
  /** Wait before each DONE or ack, so it lands after the sender's microphone is rolling again. */
  turnaroundMs?: number;
  /**
   * Ack every this many new units heard, resends included; undefined never
   * acks. Each decoder says when its units start counting: by sound, at a
   * transfer's first repair symbol. Every ack reports the fresh units heard,
   * for a sender adapting its rate; a packet decoder names missing blocks only
   * once a repair symbol was heard (the first pass is over). A bundle that
   * finishes inside the period never acks.
   */
  ackEvery?: number;
  signal: AbortSignal;
  onProgress?: (p: ReceiveProgress) => void;
  onComplete?: (r: Received) => void;
  onDone?: (transferId: number) => void;
  /** `share`: fresh ids heard since the last ack, 0 to 1, undefined with none. */
  onAck?: (transferId: number, runs: Run[], share?: number) => void;
}

export function receiveBundle(
  options: ReceiveOptions,
): Promise<Received | undefined> {
  const {
    sound,
    camera = [],
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
    const soundDecoder = packetDecoder(sound, {
      name: "sound",
      countFrom: "repair",
    });
    const decoders: TransferDecoder[] = [soundDecoder, ...camera];
    /** The decoder each transfer belongs to: the first that reported it. */
    const owner = new Map<number, TransferDecoder>();
    let acked = 0;
    let received: Received | undefined;
    let doneSent = false;
    let heardSinceDone = false;
    let sending = false;
    let finished = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let completions = Promise.resolve();
    const lastSound = new Map<number, number>();
    /** Per transfer, once counting began: new units since then or since the last ack. */
    const heardSince = new Map<number, number>();
    /** Transfer whose ack waits for the next DataListen. */
    let ackPending: number | undefined;
    /** Completion's DONE-or-silence step, held while an ack is in flight. */
    let afterAck: (() => void) | undefined;
    /** The transfer just completed, waiting for its completing unit's report. */
    let completing:
      | { decoder: TransferDecoder; transferId: number; listen: boolean }
      | undefined;

    const claim = (decoder: TransferDecoder, transferId: number) => {
      const o = owner.get(transferId);
      if (o && o !== decoder) return false;
      owner.set(transferId, decoder);
      return true;
    };

    const progress = () =>
      onProgress?.({
        acked,
        sound: { ...soundDecoder.stats },
        transfers: decoders.flatMap((d) =>
          d.status()
            .filter((t) => (owner.get(t.transferId) ?? d) === d)
            .map((t) => ({ ...t, via: d.name }))
        ),
      });

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
        const report = owner.get(transferId)?.ack(transferId, ACK_RUNS);
        if (!report) return;
        const { k, highest, heard, share, runs } = report;
        await sound.send([
          encodePacket({
            type: PacketType.Ack,
            transferId,
            k,
            symbolId: highest,
            data: encodeAck(
              runs,
              heard,
              dataBytes(SOUND_PACKET_BYTES, k),
              share,
            ),
          }),
        ], signal);
        if (finished) return;
        acked++;
        heardSince.set(transferId, 0);
        onAck?.(transferId, runs, share);
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

    const complete = async (
      decoder: TransferDecoder,
      transferId: number,
      bundle: Uint8Array,
      at: { listen: boolean },
    ) => {
      if (received) return;
      let items: Item[];
      try {
        items = await decodeBundle(bundle);
      } catch (err) {
        if (!(err instanceof BundleError)) throw err;
        decoder.forget(transferId);
        return;
      }
      if (finished) return;
      received = { transferId, items };
      const soundAt = lastSound.get(transferId);
      lastSound.clear();
      onComplete?.(received);
      const kick = () =>
        at.listen || soundAt === undefined ||
          Date.now() - soundAt >= silenceMs
          ? sendDone()
          : armSilence();
      if (sending) afterAck = kick;
      else kick();
    };

    const onCompleted = (decoder: TransferDecoder) =>
    (
      transferId: number,
      bundle: Uint8Array,
    ) => {
      if (finished || !claim(decoder, transferId)) return;
      const c = { decoder, transferId, listen: false };
      completing = c;
      completions = completions
        .then(() => complete(decoder, transferId, bundle, c))
        .catch(finish);
    };

    const onHeard = (decoder: TransferDecoder) => (h: TransferHeard) => {
      if (finished) return;
      const { transferId } = h;
      const fromSound = decoder === soundDecoder;
      const soundListen = fromSound && h.listen === true;
      if (fromSound && !received) lastSound.set(transferId, Date.now());
      if (
        completing?.decoder === decoder && completing.transferId === transferId
      ) {
        completing.listen = soundListen;
        completing = undefined;
      } else if (received?.transferId === transferId) {
        if (doneSent) heardSinceDone = true;
        if (soundListen) sendDone();
        else if (fromSound) armSilence();
      } else if (
        ackEvery !== undefined && !received && claim(decoder, transferId)
      ) {
        if (h.fresh > 0 && h.counting) {
          const heard = (heardSince.get(transferId) ?? 0) + h.fresh;
          heardSince.set(transferId, heard);
          if (heard >= ackEvery) tryAck(transferId);
        }
        if (soundListen && ackPending === transferId) sendAck(transferId);
      }
      // Sound progress goes out on every packet, below; camera's here.
      if (!fromSound) progress();
    };

    const unsubscribes = [
      ...decoders.flatMap((d) => [
        d.onComplete(onCompleted(d)),
        d.onHeard(onHeard(d)),
      ]),
      // After the decoder's own listener, so rejected bytes show too.
      sound.onPacket(() => finished || progress()),
    ];

    const finish = (err?: unknown) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      for (const unsubscribe of unsubscribes) unsubscribe();
      soundDecoder.close();
      signal.removeEventListener("abort", onAbort);
      if (err === undefined) resolve(received);
      else reject(err);
    };
    const onAbort = () => finish();

    if (signal.aborted) finish();
    else signal.addEventListener("abort", onAbort, { once: true });
  });
}

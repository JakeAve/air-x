import { assert, assertEquals, assertRejects } from "@std/assert";
import { sleep } from "./abort.ts";
import { encodeBundle, type Item } from "./bundle.ts";
import type { PacketChannel, PacketDisplay, PacketSource } from "./channel.ts";
import { Encoder } from "./fountain/encoder.ts";
import {
  dataBytes,
  DENSE_MAX_K,
  QR_PACKET_BYTES,
  SOUND_PACKET_BYTES,
} from "./protocol.ts";
import { blockCount } from "./fountain/symbols.ts";

const DATA_BYTES = dataBytes(SOUND_PACKET_BYTES, 0);
import {
  ackHeard,
  ackShare,
  decodeAck,
  decodePacket,
  encodeAck,
  encodePacket,
  PacketType,
  type Run,
} from "./packet.ts";
import type { CameraRate, RateSample } from "./rate.ts";
import {
  type AckReport,
  packetDecoder,
  type TransferDecoder,
  type TransferHeard,
} from "./transferDecoder.ts";
import { type CameraEncoder, qrEncoder } from "./cameraCodec.ts";
import {
  receiveBundle,
  type Received,
  type ReceiveProgress,
  sendBundle,
  type SendProgress,
} from "./session.ts";

const AIRTIME_MS = 3;
const LISTEN_EVERY = 8;
const WINDOW_MS = 40;
const SILENCE_MS = 200;

function seededRandom(seed: number) {
  let s = seed;
  return () => (s = (s * 1103515245 + 12345) % 2147483648) / 2147483648;
}

/** Half-duplex shared air: a party hears nothing while its own send runs. */
class Air {
  readonly #parties = new Set<Party>();
  readonly #random: () => number;
  readonly #loss: number;
  readonly #drop: (bytes: Uint8Array) => boolean;

  constructor(options: {
    seed: number;
    loss?: number;
    drop?: (bytes: Uint8Array) => boolean;
  }) {
    this.#random = seededRandom(options.seed);
    this.#loss = options.loss ?? 0;
    this.#drop = options.drop ?? (() => false);
  }

  /** `deafMs`: after its last packet, the party keeps its microphone closed this long before `send` resolves. */
  party(deafMs = 0): PacketChannel {
    const party = new Party(this, deafMs);
    this.#parties.add(party);
    return party;
  }

  deliver(from: Party, bytes: Uint8Array): void {
    if (this.#drop(bytes)) return;
    for (const party of this.#parties) {
      if (party === from || party.sending) continue;
      if (this.#random() < this.#loss) continue;
      party.hear(bytes);
    }
  }
}

class Party implements PacketChannel {
  sending = false;
  readonly #air: Air;
  readonly #deafMs: number;
  readonly #listeners = new Set<(bytes: Uint8Array) => void>();

  constructor(air: Air, deafMs: number) {
    this.#air = air;
    this.#deafMs = deafMs;
  }

  async send(packets: Uint8Array[], signal: AbortSignal): Promise<void> {
    this.sending = true;
    try {
      for (const packet of packets) {
        await sleep(AIRTIME_MS, signal);
        this.#air.deliver(this, packet);
      }
      if (this.#deafMs > 0) await sleep(this.#deafMs, signal);
    } finally {
      this.sending = false;
    }
  }

  onPacket(listener: (bytes: Uint8Array) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  hear(bytes: Uint8Array): void {
    for (const listener of this.#listeners) listener(bytes);
  }
}

/** A screen and camera: each shown code reaches listeners whole, unless its frame is missed. */
class Display implements PacketDisplay, PacketSource {
  cleared = false;
  shown = 0;
  readonly #random: () => number;
  readonly #loss: number;
  readonly #dropCodes: number[];
  readonly #listeners = new Set<(bytes: Uint8Array) => void>();

  /** `dropCodes`: zero-based indexes of shown codes the camera misses. */
  constructor(options: { seed: number; loss?: number; dropCodes?: number[] }) {
    this.#random = seededRandom(options.seed);
    this.#loss = options.loss ?? 0;
    this.#dropCodes = options.dropCodes ?? [];
  }

  show(packets: Uint8Array[]): void {
    this.cleared = false;
    const index = this.shown++;
    if (this.#dropCodes.includes(index)) return;
    if (this.#random() < this.#loss) return;
    for (const packet of packets) {
      for (const listener of this.#listeners) listener(packet);
    }
  }

  clear(): void {
    this.cleared = true;
  }

  onPacket(listener: (bytes: Uint8Array) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }
}

/** Wraps a source so every packet reaches listeners twice, like a code held on screen across frames. */
class DoublingSource implements PacketSource {
  readonly #inner: PacketSource;

  constructor(inner: PacketSource) {
    this.#inner = inner;
  }

  onPacket(listener: (bytes: Uint8Array) => void): () => void {
    return this.#inner.onPacket((bytes) => {
      listener(bytes);
      listener(bytes);
    });
  }
}

function testItems(noiseBytes = 400): Item[] {
  const random = seededRandom(42);
  const bytes = new Uint8Array(noiseBytes);
  for (let i = 0; i < bytes.length; i++) bytes[i] = Math.floor(random() * 256);
  return [
    {
      name: "note.txt",
      type: "text/plain",
      bytes: new TextEncoder().encode("hola"),
    },
    { name: "noise.bin", type: "application/octet-stream", bytes },
  ];
}

function qrDecoder(source: PacketSource) {
  return packetDecoder(source, { name: "qr", countFrom: "first" });
}

function sound(channel: PacketChannel, listenEvery: number, windowMs: number) {
  return { listen: channel, sound: { channel, listenEvery, windowMs } };
}

/** A QR transfer's block count. */
function qrK(bundle: Uint8Array): number {
  return blockCount(bundle.length, QR_PACKET_BYTES);
}

/** QR packets sent, at most: fresh symbols plus blocks queued for resend. */
function sentQr(p: SendProgress): number {
  return p.cameraFresh + p.acked;
}

function isDone(bytes: Uint8Array): boolean {
  return decodePacket(bytes)?.type === PacketType.Done;
}

Deno.test("completes over 20% loss and the sender hears DONE", async () => {
  const items = testItems();
  const bundle = await encodeBundle(items);
  const air = new Air({ seed: 1, loss: 0.2 });
  const stopReceiver = new AbortController();
  const stopSender = new AbortController();
  let dones = 0;

  const received = receiveBundle({
    sound: air.party(),
    silenceMs: SILENCE_MS,
    signal: stopReceiver.signal,
    onDone: () => dones++,
  });
  const sent = await sendBundle(bundle, {
    ...sound(air.party(), LISTEN_EVERY, WINDOW_MS),
    signal: stopSender.signal,
  });

  assertEquals(sent, "done");
  const result = await received;
  assertEquals(result?.items, items);
  assert(dones >= 1);
});

Deno.test("a lost DONE is re-sent on the next DataListen", async () => {
  const items = testItems();
  const bundle = await encodeBundle(items);
  let dropped = 0;
  const air = new Air({
    seed: 2,
    drop: (bytes) => isDone(bytes) && dropped++ < 2,
  });
  const stopReceiver = new AbortController();
  let dones = 0;
  let completed: Received | undefined;

  const received = receiveBundle({
    sound: air.party(),
    silenceMs: 5_000,
    signal: stopReceiver.signal,
    onComplete: (r) => completed = r,
    onDone: () => dones++,
  });
  const sent = await sendBundle(bundle, {
    ...sound(air.party(), LISTEN_EVERY, WINDOW_MS),
    signal: new AbortController().signal,
  });

  assertEquals(sent, "done");
  // Both copies of the first DONE were dropped, so a third copy went out.
  assert(dropped >= 3);
  stopReceiver.abort();
  const result = await received;
  assertEquals(result, completed);
  assertEquals(result?.items, items);
});

Deno.test("a sender stopped after completion lets the receiver finish on silence", async () => {
  const items = testItems();
  const bundle = await encodeBundle(items);
  const air = new Air({ seed: 3 });
  const stopSender = new AbortController();
  let dones = 0;

  const received = receiveBundle({
    sound: air.party(),
    silenceMs: SILENCE_MS,
    signal: new AbortController().signal,
    onComplete: () => stopSender.abort(),
    onDone: () => dones++,
  });
  const sent = await sendBundle(bundle, {
    ...sound(air.party(), 1000, WINDOW_MS),
    signal: stopSender.signal,
  });

  assertEquals(sent, "stopped");
  const result = await received;
  assertEquals(result?.items, items);
  assertEquals(dones, 1);
});

Deno.test("abort stops the sender and an incomplete receiver", async () => {
  const bundle = await encodeBundle(testItems());
  const air = new Air({ seed: 4 });
  const stopSender = new AbortController();
  const stopReceiver = new AbortController();

  const sent = sendBundle(bundle, {
    ...sound(air.party(), LISTEN_EVERY, WINDOW_MS),
    signal: stopSender.signal,
  });
  const received = receiveBundle({
    sound: new Air({ seed: 5 }).party(),
    silenceMs: SILENCE_MS,
    signal: stopReceiver.signal,
  });
  await sleep(50, new AbortController().signal);
  stopSender.abort();
  stopReceiver.abort();

  assertEquals(await sent, "stopped");
  assertEquals(await received, undefined);
});

Deno.test("foreign transfers and corrupt bytes are counted and ignored", async () => {
  const items = testItems();
  const bundle = await encodeBundle(items);
  const air = new Air({ seed: 6 });
  const never = new AbortController().signal;
  let last: ReceiveProgress | undefined;

  const received = receiveBundle({
    sound: air.party(),
    silenceMs: SILENCE_MS,
    signal: never,
    onProgress: (p) => last = p,
  });

  const foreign = new Encoder(bundle, 0, SOUND_PACKET_BYTES).next();
  const corrupt = encodePacket(
    new Encoder(bundle, 1, SOUND_PACKET_BYTES).next(),
  );
  corrupt[20] ^= 0xff;
  await air.party().send(
    [encodePacket(foreign), corrupt, new Uint8Array(10)],
    never,
  );
  assertEquals(last?.sound.heard, 1);
  assertEquals(last?.sound.rejected, 2);
  assertEquals(last?.transfers.map((t) => t.transferId), [0]);

  const sent = await sendBundle(bundle, {
    ...sound(air.party(), LISTEN_EVERY, WINDOW_MS),
    signal: never,
  });

  assertEquals(sent, "done");
  const result = await received;
  assert(result);
  assertEquals(result.items, items);
  assertEquals(last?.sound.rejected, 2);
});

Deno.test("a receiver turnaround longer than the sender's deaf time lets DONE land", async () => {
  const items = testItems();
  const bundle = await encodeBundle(items);
  const air = new Air({ seed: 7 });
  const stopReceiver = new AbortController();
  const stopSender = new AbortController();
  const giveUp = setTimeout(() => stopSender.abort(), 5_000);

  const received = receiveBundle({
    sound: air.party(),
    silenceMs: 5_000,
    turnaroundMs: 60,
    signal: stopReceiver.signal,
  });
  const sent = await sendBundle(bundle, {
    ...sound(air.party(30), LISTEN_EVERY, 150),
    signal: stopSender.signal,
  });
  clearTimeout(giveUp);
  stopReceiver.abort();

  assertEquals(sent, "done");
  assertEquals((await received)?.items, items);
});

Deno.test("sendBundle needs sound or camera", async () => {
  await assertRejects(
    () =>
      sendBundle(new Uint8Array(1), {
        listen: new Air({ seed: 0 }).party(),
        signal: new AbortController().signal,
      }),
    RangeError,
  );
});

Deno.test("a QR-only transfer completes over lost codes and DONE goes out at once", async () => {
  const items = testItems();
  const bundle = await encodeBundle(items);
  const air = new Air({ seed: 8 });
  const display = new Display({ seed: 8, loss: 0.3 });
  const stopReceiver = new AbortController();
  const start = Date.now();

  const received = receiveBundle({
    sound: air.party(),
    camera: [qrDecoder(display)],
    silenceMs: 60_000,
    signal: stopReceiver.signal,
  });
  const sent = await sendBundle(bundle, {
    listen: air.party(),
    camera: {
      encoder: qrEncoder(display),
      rate: { packetsPerCode: 4, fps: 100 },
    },
    signal: new AbortController().signal,
  });

  assertEquals(sent, "done");
  assert(Date.now() - start < 2_000);
  assert(display.cleared);
  stopReceiver.abort();
  assertEquals((await received)?.items, items);
});

Deno.test("sendBundle takes sound or camera, not both", async () => {
  const air = new Air({ seed: 0 });
  const channel = air.party();
  await assertRejects(
    () =>
      sendBundle(new Uint8Array(1), {
        ...sound(channel, LISTEN_EVERY, WINDOW_MS),
        camera: {
          encoder: qrEncoder(new Display({ seed: 0 })),
          rate: { packetsPerCode: 1, fps: 1 },
        },
        signal: new AbortController().signal,
      }),
    RangeError,
  );
});

Deno.test("an Ack queues its blocks ahead of fresh symbols", async () => {
  const bundle = await encodeBundle(testItems(2_000));
  const air = new Air({ seed: 12 });
  const listen = air.party();
  const stop = new AbortController();
  const events: SendProgress[] = [];
  let acked = false;

  const sent = sendBundle(bundle, {
    listen,
    camera: {
      encoder: qrEncoder(new Display({ seed: 12 })),
      rate: { packetsPerCode: 4, fps: 100 },
    },
    signal: stop.signal,
    onProgress: (p) => {
      events.push(p);
      if (acked) return stop.abort();
      acked = true;
      (listen as Party).hear(encodePacket({
        type: PacketType.Ack,
        transferId: p.transferId,
        k: qrK(bundle),
        symbolId: 0,
        data: encodeAck([{ start: 2, length: 3 }], 0, DATA_BYTES),
      }));
    },
  });

  assertEquals(await sent, "stopped");
  assert(qrK(bundle) > 5);
  assertEquals(events[1].symbolIds.slice(0, 3), [2, 3, 4]);
  assertEquals(events[1].symbolIds[3], 4);
  assertEquals(events[1].acked, 3);
});

Deno.test("a source that delivers each code twice counts fresh once per symbol", async () => {
  const items = testItems();
  const bundle = await encodeBundle(items);
  const air = new Air({ seed: 11 });
  const display = new Display({ seed: 11 });
  const doubling = new DoublingSource(display);
  const stopReceiver = new AbortController();
  const qr = qrDecoder(doubling);

  const received = receiveBundle({
    sound: air.party(),
    camera: [qr],
    silenceMs: 60_000,
    signal: stopReceiver.signal,
  });
  const sent = await sendBundle(bundle, {
    listen: air.party(),
    camera: {
      encoder: qrEncoder(display),
      rate: { packetsPerCode: 4, fps: 100 },
    },
    signal: new AbortController().signal,
  });

  assertEquals(sent, "done");
  stopReceiver.abort();
  await received;
  assert(qr.stats.fresh > 0);
  assertEquals(qr.stats.heard, qr.stats.fresh * 2);
});

Deno.test("a QR-only transfer whose first DONE copy is lost still stops the sender", async () => {
  const items = testItems();
  const bundle = await encodeBundle(items);
  let dropped = 0;
  const air = new Air({
    seed: 10,
    drop: (bytes) => isDone(bytes) && dropped++ === 0,
  });
  const display = new Display({ seed: 10, loss: 0.3 });
  let dones = 0;

  const received = receiveBundle({
    sound: air.party(),
    camera: [qrDecoder(display)],
    silenceMs: SILENCE_MS,
    signal: new AbortController().signal,
    onDone: () => dones++,
  });
  const sent = await sendBundle(bundle, {
    listen: air.party(),
    camera: {
      encoder: qrEncoder(display),
      rate: { packetsPerCode: 4, fps: 50 },
    },
    signal: new AbortController().signal,
  });

  assertEquals(sent, "done");
  assertEquals((await received)?.items, items);
  assertEquals(dones, 1);
});

Deno.test("QR codes after DONE do not re-send it: the receiver finishes on sound silence", async () => {
  const items = testItems();
  const bundle = await encodeBundle(items);
  const air = new Air({ seed: 10, drop: isDone });
  const display = new Display({ seed: 10, loss: 0.3 });
  const stopSender = new AbortController();
  let dones = 0;

  const received = receiveBundle({
    sound: air.party(),
    camera: [qrDecoder(display)],
    silenceMs: SILENCE_MS,
    signal: new AbortController().signal,
    onDone: () => dones++,
  });
  const sent = sendBundle(bundle, {
    listen: air.party(),
    camera: {
      encoder: qrEncoder(display),
      rate: { packetsPerCode: 4, fps: 50 },
    },
    signal: stopSender.signal,
  });

  assertEquals((await received)?.items, items);
  assertEquals(dones, 1);
  stopSender.abort();
  assertEquals(await sent, "stopped");
});

Deno.test("a QR receiver acks the blocks of dropped codes and the sender resends them", async () => {
  const items = testItems(2_000);
  const bundle = await encodeBundle(items);
  const air = new Air({ seed: 13 });
  const packetsPerCode = 4;
  const display = new Display({ seed: 13, dropCodes: [3, 7] });
  const stopReceiver = new AbortController();
  const acks: Run[][] = [];
  let last: SendProgress | undefined;

  const received = receiveBundle({
    sound: air.party(),
    camera: [qrDecoder(display)],
    silenceMs: 60_000,
    ackEvery: 4,
    signal: stopReceiver.signal,
    onAck: (_, runs) => acks.push(runs),
  });
  const sent = await sendBundle(bundle, {
    listen: air.party(),
    camera: { encoder: qrEncoder(display), rate: { packetsPerCode, fps: 20 } },
    signal: new AbortController().signal,
    onProgress: (p) => last = p,
  });

  assertEquals(sent, "done");
  stopReceiver.abort();
  assertEquals((await received)?.items, items);
  assert(last);
  assertEquals(qrK(bundle), 18);
  assert(acks.length >= 1);
  // Acks before the first repair symbol name no blocks. A repair symbol may
  // peel a dropped block by luck before the ack, so the first ack with runs
  // names some of code 3's blocks, and nothing outside the drops.
  const blocks = (code: number) =>
    Array.from({ length: packetsPerCode }, (_, i) => code * packetsPerCode + i);
  const dropped = new Set([...blocks(3), ...blocks(7)]);
  const ackedBlocks = acks.find((runs) => runs.length)!.flatMap((
    { start, length },
  ) => Array.from({ length }, (_, i) => start + i));
  assert(ackedBlocks.every((b) => dropped.has(b)));
  assert(blocks(3).some((b) => ackedBlocks.includes(b)));
  assert(sentQr(last!) < qrK(bundle) + 2 * packetsPerCode + 8);
});

Deno.test("an LT-sized QR transfer with many dropped codes finishes in few symbols past k thanks to periodic acks", async () => {
  const items = testItems(26_000);
  const bundle = await encodeBundle(items);
  const air = new Air({ seed: 21 });
  const packetsPerCode = 4;
  const dropCodes = Array.from({ length: 10 }, (_, i) => 3 + i * 9);
  const display = new Display({ seed: 21, dropCodes });
  const stopReceiver = new AbortController();
  let acks = 0;
  let last: SendProgress | undefined;

  const received = receiveBundle({
    sound: air.party(),
    camera: [qrDecoder(display)],
    silenceMs: 60_000,
    ackEvery: 16,
    signal: stopReceiver.signal,
    onAck: () => acks++,
  });
  const sent = await sendBundle(bundle, {
    listen: air.party(),
    camera: { encoder: qrEncoder(display), rate: { packetsPerCode, fps: 50 } },
    signal: new AbortController().signal,
    onProgress: (p) => last = p,
  });

  assertEquals(sent, "done");
  stopReceiver.abort();
  assertEquals((await received)?.items, items);
  const k = qrK(bundle);
  assert(k > DENSE_MAX_K, `k ${k}`);
  assert(acks >= 1);
  // 40 blocks were dropped; LT repair alone needs a few hundred symbols here.
  assert(sentQr(last!) < k + 100, `${sentQr(last!)} of k ${k}`);
});

Deno.test("dense repair finishes inside the ack period, so no ack goes out", async () => {
  const items = testItems(2_000);
  const bundle = await encodeBundle(items);
  const air = new Air({ seed: 13 });
  const display = new Display({ seed: 13, dropCodes: [3, 7] });
  const stopReceiver = new AbortController();
  let last: ReceiveProgress | undefined;

  const received = receiveBundle({
    sound: air.party(),
    camera: [qrDecoder(display)],
    silenceMs: 60_000,
    ackEvery: 80,
    signal: stopReceiver.signal,
    onProgress: (p) => last = p,
  });
  const sent = await sendBundle(bundle, {
    listen: air.party(),
    camera: {
      encoder: qrEncoder(display),
      rate: { packetsPerCode: 4, fps: 20 },
    },
    signal: new AbortController().signal,
  });

  assertEquals(sent, "done");
  stopReceiver.abort();
  assertEquals((await received)?.items, items);
  assertEquals(last!.acked, 0);
});

Deno.test("a QR transfer that completes during an ack's turnaround still gets DONE", async () => {
  const items = testItems(2_000);
  const bundle = await encodeBundle(items);
  const air = new Air({ seed: 15 });
  // Codes land every 10 ms: the first past-k code fills the period and starts
  // the ack, and the next codes complete the transfer inside the 30 ms
  // turnaround sleep.
  const display = new Display({ seed: 15, dropCodes: [3] });
  const stopReceiver = new AbortController();
  const stopSender = new AbortController();
  const giveUp = setTimeout(() => stopSender.abort(), 3_000);

  const received = receiveBundle({
    sound: air.party(),
    camera: [qrDecoder(display)],
    silenceMs: 60_000,
    turnaroundMs: 30,
    ackEvery: 1,
    signal: stopReceiver.signal,
  });
  const sent = await sendBundle(bundle, {
    listen: air.party(),
    camera: {
      encoder: qrEncoder(display),
      rate: { packetsPerCode: 4, fps: 100 },
    },
    signal: stopSender.signal,
  });
  clearTimeout(giveUp);

  assertEquals(sent, "done");
  stopReceiver.abort();
  assertEquals((await received)?.items, items);
});

Deno.test("a sound receiver acks on the period and completes", async () => {
  const items = testItems(4_000);
  const bundle = await encodeBundle(items);
  const air = new Air({ seed: 14, loss: 0.2 });
  let last: ReceiveProgress | undefined;

  const received = receiveBundle({
    sound: air.party(),
    silenceMs: SILENCE_MS,
    ackEvery: 4,
    signal: new AbortController().signal,
    onProgress: (p) => last = p,
  });
  const sent = await sendBundle(bundle, {
    ...sound(air.party(), LISTEN_EVERY, WINDOW_MS),
    signal: new AbortController().signal,
  });

  assertEquals(sent, "done");
  assertEquals((await received)?.items, items);
  assert(last!.acked >= 1);
});

Deno.test("without ackEvery a receiver never acks", async () => {
  const items = testItems(4_000);
  const bundle = await encodeBundle(items);
  const air = new Air({ seed: 14, loss: 0.2 });
  let last: ReceiveProgress | undefined;

  const received = receiveBundle({
    sound: air.party(),
    silenceMs: SILENCE_MS,
    signal: new AbortController().signal,
    onProgress: (p) => last = p,
  });
  const sent = await sendBundle(bundle, {
    ...sound(air.party(), LISTEN_EVERY, WINDOW_MS),
    signal: new AbortController().signal,
  });

  assertEquals(sent, "done");
  assertEquals((await received)?.items, items);
  assertEquals(last!.acked, 0);
});

Deno.test("a QR receiver's acks report the highest id and fresh symbols heard, naming no blocks before a repair symbol", async () => {
  const bundle = await encodeBundle(testItems(2_000));
  const air = new Air({ seed: 16 });
  const display = new Display({ seed: 16, dropCodes: [1] });
  const stop = new AbortController();
  const acks: { highest: number; heard: number; runs: Run[] }[] = [];
  const shares: (number | undefined)[] = [];
  const listen = air.party();
  listen.onPacket((bytes) => {
    const packet = decodePacket(bytes)!;
    if (packet.type !== PacketType.Ack) return;
    acks.push({
      highest: packet.symbolId,
      heard: ackHeard(packet.data),
      runs: decodeAck(packet.data),
    });
    shares.push(ackShare(packet.data));
    if (acks.length === 2) stop.abort();
  });

  const received = receiveBundle({
    sound: air.party(),
    camera: [qrDecoder(display)],
    silenceMs: 60_000,
    ackEvery: 4,
    signal: stop.signal,
  });
  await sendBundle(bundle, {
    listen,
    camera: {
      encoder: qrEncoder(display),
      rate: { packetsPerCode: 4, fps: 20 },
    },
    signal: stop.signal,
  });
  await received;

  assertEquals(acks, [
    { highest: 3, heard: 4, runs: [] },
    { highest: 11, heard: 8, runs: [] },
  ]);
  // Ids 0..3 all heard; 4..11 lost code 1, so 4 of 8.
  assertEquals(shares, [1, 0.5]);
});

Deno.test("a receiver that starts looking late measures its share from the first id it saw", async () => {
  const bundle = await encodeBundle(testItems(2_000));
  const air = new Air({ seed: 16 });
  const display = new Display({ seed: 16, dropCodes: [0, 1, 2] });
  const stop = new AbortController();
  const shares: (number | undefined)[] = [];
  const listen = air.party();
  listen.onPacket((bytes) => {
    const packet = decodePacket(bytes)!;
    if (packet.type !== PacketType.Ack) return;
    shares.push(ackShare(packet.data));
    stop.abort();
  });

  const received = receiveBundle({
    sound: air.party(),
    camera: [qrDecoder(display)],
    silenceMs: 60_000,
    ackEvery: 4,
    signal: stop.signal,
  });
  await sendBundle(bundle, {
    listen,
    camera: {
      encoder: qrEncoder(display),
      rate: { packetsPerCode: 4, fps: 20 },
    },
    signal: stop.signal,
  });
  await received;

  // Codes 0..2 went unseen; ids 12..15 all heard is a full share, not 4 of 16.
  assertEquals(shares, [1]);
});

/** Runs a QR send, answering the i-th code with an ack carrying `acks[i]`, and stops after `codes` codes. */
async function adaptiveSend(
  codes: number,
  acks: Record<number, { share?: number }>,
  silentAfter: number,
  policy: (sample: RateSample) => CameraRate,
) {
  const bundle = await encodeBundle(testItems(4_000));
  const listen = new Air({ seed: 17 }).party();
  const stop = new AbortController();
  const samples: RateSample[] = [];
  const sizes: number[] = [];

  await sendBundle(bundle, {
    listen,
    camera: {
      encoder: qrEncoder(new Display({ seed: 17 })),
      rate: { packetsPerCode: 4, fps: 100 },
      adapt: {
        silentAfter,
        policy: (sample) => {
          samples.push(sample);
          return policy(sample);
        },
      },
    },
    signal: stop.signal,
    onProgress: (p) => {
      assertEquals(p.rate?.packetsPerCode, p.symbolIds.length);
      const ack = acks[sizes.length];
      sizes.push(p.symbolIds.length);
      if (sizes.length === codes) return stop.abort();
      if (!ack) return;
      (listen as Party).hear(encodePacket({
        type: PacketType.Ack,
        transferId: p.transferId,
        k: qrK(bundle),
        symbolId: 0,
        data: encodeAck([], 0, DATA_BYTES, ack.share),
      }));
    },
  });
  return { samples, sizes };
}

Deno.test("an adaptive QR sender takes each ack's own figures as one sample", async () => {
  const at = (packetsPerCode: number) => ({ packetsPerCode, fps: 100 });
  const { samples, sizes } = await adaptiveSend(
    4,
    // A full share, a poor one, then an ack with no figures (no sample).
    { 0: { share: 1 }, 1: { share: 0.25 }, 2: {} },
    1_000,
    ({ heard }) => at(heard === 1 ? 8 : 2),
  );

  assertEquals(samples, [
    { rate: at(4), heard: 1 },
    { rate: at(8), heard: 0.25 },
  ]);
  assertEquals(sizes, [4, 8, 2, 2]);
});

Deno.test("an adaptive QR sender reports silence only after an ack, and an ack restarts the count", async () => {
  const at = (packetsPerCode: number) => ({ packetsPerCode, fps: 100 });
  const { samples, sizes } = await adaptiveSend(
    6,
    // An empty ack after code 0 (no sample); silence 8 fresh later; then a
    // full share after code 4.
    { 0: {}, 4: { share: 1 } },
    8,
    () => at(2),
  );

  assertEquals(samples, [
    { rate: at(4), silent: true },
    { rate: at(2), heard: 1 },
  ]);
  assertEquals(sizes, [4, 4, 4, 2, 2, 2]);
});

Deno.test("an adaptive QR sender ignores silence before any ack: no one may be looking yet", async () => {
  const { samples, sizes } = await adaptiveSend(6, {}, 8, () => {
    throw new Error("no sample expected");
  });

  assertEquals(samples, []);
  assertEquals(sizes, [4, 4, 4, 4, 4, 4]);
});

/**
 * A cimbar-like codec: frames are opaque (a transfer id and a frame number),
 * name no blocks, and the decoder completes after `need` distinct frames. The
 * bundle rides along out of band, so `decodeBundle` still sees real bytes.
 */
class ShareOnlyLink {
  readonly #random: () => number;
  readonly #loss: number;
  readonly #need: number;
  readonly #bundles = new Map<number, Uint8Array>();
  readonly #listeners = new Set<(transferId: number, frame: number) => void>();
  /** Every report `ack` returned, for checking against the wire. */
  readonly reports: AckReport[] = [];

  constructor(options: { seed: number; loss: number; need: number }) {
    this.#random = seededRandom(options.seed);
    this.#loss = options.loss;
    this.#need = options.need;
  }

  encoder(): CameraEncoder {
    return {
      name: "share-only",
      start: (bundle, transferId, rate, signal, onFrame) => {
        this.#bundles.set(transferId, bundle);
        let frames = 0;
        const run = async () => {
          await null;
          try {
            while (!signal.aborted) {
              const shown = rate;
              const frame = frames++;
              if (this.#random() >= this.#loss) {
                for (const l of this.#listeners) l(transferId, frame);
              }
              onFrame?.({ frames, fresh: frames, freshBytes: 0, rate: shown });
              await sleep(1000 / rate.fps, signal);
            }
          } catch (err) {
            if (!signal.aborted) throw err;
          }
        };
        return {
          setRate: (next) => rate = next,
          resend: () => 0,
          get fresh() {
            return frames;
          },
          done: run(),
        };
      },
      seconds: (_, rate) => this.#need / rate.fps,
    };
  }

  decoder(): TransferDecoder {
    const heardListeners = new Set<(h: TransferHeard) => void>();
    const completeListeners = new Set<
      (transferId: number, bundle: Uint8Array, unit?: TransferHeard) => void
    >();
    const seen = new Map<number, Set<number>>();
    const highest = new Map<number, number>();
    /** Per transfer, as of the last ack: highest frame and distinct count. */
    const base = new Map<number, { highest: number; heard: number }>();
    const listen = <T>(set: Set<T>, l: T) => {
      set.add(l);
      return () => void set.delete(l);
    };
    const onFrame = (transferId: number, frame: number) => {
      let frames = seen.get(transferId);
      if (!frames) {
        frames = new Set();
        seen.set(transferId, frames);
        base.set(transferId, { highest: frame - 1, heard: 0 });
      }
      const fresh = frames.has(frame) ? 0 : 1;
      frames.add(frame);
      highest.set(transferId, Math.max(highest.get(transferId) ?? -1, frame));
      const unit: TransferHeard = { transferId, fresh, counting: true };
      if (fresh && frames.size === this.#need) {
        const bundle = this.#bundles.get(transferId)!;
        for (const l of completeListeners) l(transferId, bundle, unit);
      } else {
        for (const l of heardListeners) l(unit);
      }
    };
    this.#listeners.add(onFrame);
    return {
      name: "share-only",
      onHeard: (l) => listen(heardListeners, l),
      onComplete: (l) => listen(completeListeners, l),
      ack: (transferId) => {
        const frames = seen.get(transferId);
        if (!frames) return undefined;
        const top = highest.get(transferId)!;
        const from = base.get(transferId)!;
        const span = top - from.highest;
        base.set(transferId, { highest: top, heard: frames.size });
        const report: AckReport = {
          k: 0,
          highest: top,
          heard: frames.size,
          share: span > 0 ? (frames.size - from.heard) / span : undefined,
          runs: [],
        };
        this.reports.push(report);
        return report;
      },
      status: () =>
        [...seen].map(([transferId, frames]) => ({
          transferId,
          progress: Math.min(1, frames.size / this.#need),
        })),
      forget: (transferId) => void seen.delete(transferId),
      close: () => void this.#listeners.delete(onFrame),
    };
  }
}

Deno.test("a share-only camera codec completes and the sender hears DONE", async () => {
  const items = testItems();
  const bundle = await encodeBundle(items);
  const air = new Air({ seed: 20 });
  const link = new ShareOnlyLink({ seed: 20, loss: 0.3, need: 12 });
  const stopReceiver = new AbortController();

  const received = receiveBundle({
    sound: air.party(),
    camera: [link.decoder()],
    silenceMs: 60_000,
    signal: stopReceiver.signal,
  });
  const sent = await sendBundle(bundle, {
    listen: air.party(),
    camera: { encoder: link.encoder(), rate: { fps: 100 } },
    signal: new AbortController().signal,
  });

  assertEquals(sent, "done");
  stopReceiver.abort();
  assertEquals((await received)?.items, items);
});

Deno.test("a share-only camera codec's acks carry its share and no runs, and the policy gets each as a sample", async () => {
  const items = testItems();
  const bundle = await encodeBundle(items);
  const air = new Air({ seed: 21 });
  const link = new ShareOnlyLink({ seed: 21, loss: 0.3, need: 40 });
  const stopReceiver = new AbortController();
  const wire: { k: number; runs: Run[]; share?: number }[] = [];
  const samples: RateSample[] = [];
  const heardAcks: typeof wire = [];
  const listen = air.party();
  listen.onPacket((bytes) => {
    const packet = decodePacket(bytes)!;
    if (packet.type !== PacketType.Ack) return;
    wire.push({
      k: packet.k,
      runs: decodeAck(packet.data),
      share: ackShare(packet.data),
    });
  });

  const received = receiveBundle({
    sound: air.party(),
    camera: [link.decoder()],
    silenceMs: 60_000,
    ackEvery: 8,
    signal: stopReceiver.signal,
  });
  const sent = await sendBundle(bundle, {
    listen,
    camera: {
      encoder: link.encoder(),
      rate: { fps: 100 },
      adapt: {
        silentAfter: 1_000,
        policy: (sample) => {
          samples.push(sample);
          return sample.rate;
        },
      },
    },
    signal: new AbortController().signal,
    onAck: (runs, share) => heardAcks.push({ k: 0, runs, share }),
  });

  assertEquals(sent, "done");
  stopReceiver.abort();
  assertEquals((await received)?.items, items);
  assert(link.reports.length >= 3);
  // Lossy frames: some share below 1, every share a real figure.
  assert(link.reports.some((r) => r.share! < 1));
  const percent = (s?: number) => Math.round(s! * 100) / 100;
  assertEquals(
    wire,
    link.reports.map((r) => ({ k: 0, runs: [], share: percent(r.share) })),
  );
  assertEquals(heardAcks, wire);
  assertEquals(
    samples,
    link.reports.map((r) => ({ rate: { fps: 100 }, heard: percent(r.share) })),
  );
});

Deno.test("a share-only camera transfer whose first DONE copy is lost still stops the sender", async () => {
  const items = testItems();
  const bundle = await encodeBundle(items);
  let dropped = 0;
  const air = new Air({
    seed: 22,
    drop: (bytes) => isDone(bytes) && dropped++ === 0,
  });
  const link = new ShareOnlyLink({ seed: 22, loss: 0.3, need: 12 });
  const dones: number[] = [];
  const start = Date.now();

  const received = receiveBundle({
    sound: air.party(),
    camera: [link.decoder()],
    silenceMs: SILENCE_MS,
    signal: new AbortController().signal,
    onDone: () => dones.push(Date.now() - start),
  });
  const sent = await sendBundle(bundle, {
    listen: air.party(),
    camera: { encoder: link.encoder(), rate: { fps: 50 } },
    signal: new AbortController().signal,
  });

  assertEquals(sent, "done");
  assertEquals((await received)?.items, items);
  assertEquals(dones.length, 1);
});

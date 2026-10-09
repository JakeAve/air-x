import { assert, assertEquals, assertRejects } from "@std/assert";
import { sleep } from "./abort.ts";
import { encodeBundle, type Item } from "./bundle.ts";
import type { PacketChannel, PacketDisplay, PacketSource } from "./channel.ts";
import { Encoder } from "./fountain/encoder.ts";
import { dataBytes, DENSE_MAX_K, SOUND_PACKET_BYTES } from "./protocol.ts";

const DATA_BYTES = dataBytes(SOUND_PACKET_BYTES, 0);
import {
  ackHeard,
  decodeAck,
  decodePacket,
  encodeAck,
  encodePacket,
  PacketType,
  type Run,
} from "./packet.ts";
import type { QrRate, RateSample } from "./rate.ts";
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

function sound(channel: PacketChannel, listenEvery: number, windowMs: number) {
  return { listen: channel, sound: { channel, listenEvery, windowMs } };
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
    drop: (bytes) => isDone(bytes) && dropped++ === 0,
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
  assertEquals(dones, 2);
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
  assertEquals(last?.heard, 1);
  assertEquals(last?.rejected, 2);
  assertEquals(last?.transfers.map((t) => t.transferId), [0]);

  const sent = await sendBundle(bundle, {
    ...sound(air.party(), LISTEN_EVERY, WINDOW_MS),
    signal: never,
  });

  assertEquals(sent, "done");
  const result = await received;
  assert(result);
  assertEquals(result.items, items);
  assertEquals(last?.rejected, 2);
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

Deno.test("sendBundle needs sound or qr", async () => {
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
    sources: [display],
    silenceMs: 60_000,
    signal: stopReceiver.signal,
  });
  const sent = await sendBundle(bundle, {
    listen: air.party(),
    qr: { display, packetsPerCode: 4, fps: 100 },
    signal: new AbortController().signal,
  });

  assertEquals(sent, "done");
  assert(Date.now() - start < 2_000);
  assert(display.cleared);
  stopReceiver.abort();
  assertEquals((await received)?.items, items);
});

Deno.test("sendBundle takes sound or qr, not both", async () => {
  const air = new Air({ seed: 0 });
  const channel = air.party();
  await assertRejects(
    () =>
      sendBundle(new Uint8Array(1), {
        ...sound(channel, LISTEN_EVERY, WINDOW_MS),
        qr: { display: new Display({ seed: 0 }), packetsPerCode: 1, fps: 1 },
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
    qr: { display: new Display({ seed: 12 }), packetsPerCode: 4, fps: 100 },
    signal: stop.signal,
    onProgress: (p) => {
      events.push(p);
      if (acked) return stop.abort();
      acked = true;
      (listen as Party).hear(encodePacket({
        type: PacketType.Ack,
        transferId: p.transferId,
        k: p.k,
        symbolId: 0,
        data: encodeAck([{ start: 2, length: 3 }], 0, DATA_BYTES),
      }));
    },
  });

  assertEquals(await sent, "stopped");
  assert(events[0].k > 5);
  assertEquals(events[1].symbolIds.slice(0, 3), [2, 3, 4]);
  assertEquals(events[1].symbolIds[3], 4);
  assertEquals(events[1].acked, 3);
});

Deno.test("a source that delivers each code twice counts sourceNew once per symbol", async () => {
  const items = testItems();
  const bundle = await encodeBundle(items);
  const air = new Air({ seed: 11 });
  const display = new Display({ seed: 11 });
  const doubling = new DoublingSource(display);
  const stopReceiver = new AbortController();
  let last: ReceiveProgress | undefined;

  const received = receiveBundle({
    sound: air.party(),
    sources: [doubling],
    silenceMs: 60_000,
    signal: stopReceiver.signal,
    onProgress: (p) => last = p,
  });
  const sent = await sendBundle(bundle, {
    listen: air.party(),
    qr: { display, packetsPerCode: 4, fps: 100 },
    signal: new AbortController().signal,
  });

  assertEquals(sent, "done");
  stopReceiver.abort();
  await received;
  assert(last);
  assert(last!.sourceNew > 0);
  assertEquals(last!.sourceHeard, last!.sourceNew * 2);
});

Deno.test("a QR-only transfer whose DONE is lost gets DONE again after silence, then finishes", async () => {
  const items = testItems();
  const bundle = await encodeBundle(items);
  let dropped = 0;
  const air = new Air({
    seed: 10,
    drop: (bytes) => isDone(bytes) && dropped++ === 0,
  });
  const display = new Display({ seed: 10, loss: 0.3 });
  const dones: number[] = [];
  const start = Date.now();

  const received = receiveBundle({
    sound: air.party(),
    sources: [display],
    silenceMs: SILENCE_MS,
    signal: new AbortController().signal,
    onDone: () => dones.push(Date.now() - start),
  });
  const sent = await sendBundle(bundle, {
    listen: air.party(),
    qr: { display, packetsPerCode: 4, fps: 50 },
    signal: new AbortController().signal,
  });

  assertEquals(sent, "done");
  assertEquals((await received)?.items, items);
  assertEquals(dones.length, 2);
  assert(dones[1] - dones[0] >= SILENCE_MS);
  assert(Date.now() - start - dones[1] >= SILENCE_MS);
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
    sources: [display],
    silenceMs: 60_000,
    ackEvery: 4,
    signal: stopReceiver.signal,
    onAck: (_, runs) => acks.push(runs),
  });
  const sent = await sendBundle(bundle, {
    listen: air.party(),
    qr: { display, packetsPerCode, fps: 20 },
    signal: new AbortController().signal,
    onProgress: (p) => last = p,
  });

  assertEquals(sent, "done");
  stopReceiver.abort();
  assertEquals((await received)?.items, items);
  assert(last);
  assertEquals(last!.k, 41);
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
  assert(last!.qrSent < last!.k + 2 * packetsPerCode + 8);
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
    sources: [display],
    silenceMs: 60_000,
    ackEvery: 16,
    signal: stopReceiver.signal,
    onAck: () => acks++,
  });
  const sent = await sendBundle(bundle, {
    listen: air.party(),
    qr: { display, packetsPerCode, fps: 50 },
    signal: new AbortController().signal,
    onProgress: (p) => last = p,
  });

  assertEquals(sent, "done");
  stopReceiver.abort();
  assertEquals((await received)?.items, items);
  assert(last!.k > DENSE_MAX_K, `k ${last!.k}`);
  assert(acks >= 1);
  // 40 blocks were dropped; LT repair alone needs a few hundred symbols here.
  assert(last!.qrSent < last!.k + 100, `${last!.qrSent} of k ${last!.k}`);
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
    sources: [display],
    silenceMs: 60_000,
    ackEvery: 160,
    signal: stopReceiver.signal,
    onProgress: (p) => last = p,
  });
  const sent = await sendBundle(bundle, {
    listen: air.party(),
    qr: { display, packetsPerCode: 4, fps: 20 },
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
    sources: [display],
    silenceMs: 60_000,
    turnaroundMs: 30,
    ackEvery: 1,
    signal: stopReceiver.signal,
  });
  const sent = await sendBundle(bundle, {
    listen: air.party(),
    qr: { display, packetsPerCode: 4, fps: 100 },
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
  const listen = air.party();
  listen.onPacket((bytes) => {
    const packet = decodePacket(bytes)!;
    if (packet.type !== PacketType.Ack) return;
    acks.push({
      highest: packet.symbolId,
      heard: ackHeard(packet.data),
      runs: decodeAck(packet.data),
    });
    if (acks.length === 2) stop.abort();
  });

  const received = receiveBundle({
    sound: air.party(),
    sources: [display],
    silenceMs: 60_000,
    ackEvery: 4,
    signal: stop.signal,
  });
  await sendBundle(bundle, {
    listen,
    qr: { display, packetsPerCode: 4, fps: 20 },
    signal: stop.signal,
  });
  await received;

  assertEquals(acks, [
    { highest: 3, heard: 4, runs: [] },
    { highest: 11, heard: 8, runs: [] },
  ]);
});

/** Runs a QR send, answering the i-th code with `acks[i]` as [highest, heard], and stops after `codes` codes. */
async function adaptiveSend(
  codes: number,
  acks: Record<number, [number, number]>,
  silentAfter: number,
  policy: (sample: RateSample) => QrRate,
) {
  const bundle = await encodeBundle(testItems(4_000));
  const listen = new Air({ seed: 17 }).party();
  const stop = new AbortController();
  const samples: RateSample[] = [];
  const sizes: number[] = [];

  await sendBundle(bundle, {
    listen,
    qr: {
      display: new Display({ seed: 17 }),
      packetsPerCode: 4,
      fps: 100,
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
        k: p.k,
        symbolId: ack[0],
        data: encodeAck([], ack[1], DATA_BYTES),
      }));
    },
  });
  return { samples, sizes };
}

Deno.test("an adaptive QR sender samples each stretch between acks and takes the policy's rate, up and down", async () => {
  const at = (packetsPerCode: number) => ({ packetsPerCode, fps: 100 });
  const { samples, sizes } = await adaptiveSend(
    5,
    // Baseline, all 4 heard, 1 of 8 heard, then a stale ack that is ignored.
    { 0: [3, 4], 1: [7, 8], 2: [15, 9], 3: [11, 99] },
    1_000,
    ({ sent, heard }) => at(heard === sent ? 8 : 2),
  );

  assertEquals(samples, [
    { rate: at(4), sent: 4, heard: 4 },
    { rate: at(8), sent: 8, heard: 1 },
  ]);
  assertEquals(sizes, [4, 4, 8, 2, 2]);
});

Deno.test("an adaptive QR sender reports silence, and an ack spanning the rate change only sets the baseline", async () => {
  const at = (packetsPerCode: number) => ({ packetsPerCode, fps: 100 });
  const { samples, sizes } = await adaptiveSend(
    6,
    // Baseline; silence after 8 more symbols drops the rate at id 12; the ack
    // at 13 covers ids 4..13 at two rates, the one at 15 covers 14..15.
    { 0: [3, 4], 3: [13, 6], 4: [15, 8] },
    8,
    () => at(2),
  );

  assertEquals(samples, [
    { rate: at(4), sent: 8, heard: undefined },
    { rate: at(2), sent: 2, heard: 2 },
  ]);
  assertEquals(sizes, [4, 4, 4, 2, 2, 2]);
});

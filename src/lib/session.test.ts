import { assert, assertEquals, assertRejects } from "@std/assert";
import { sleep } from "./abort.ts";
import { encodeBundle, type Item } from "./bundle.ts";
import type { PacketChannel, PacketDisplay, PacketSource } from "./channel.ts";
import { Encoder } from "./fountain/encoder.ts";
import {
  decodePacket,
  encodeAck,
  encodePacket,
  PacketType,
  type Run,
} from "./packet.ts";
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

  const foreign = new Encoder(bundle, 0).next();
  const corrupt = encodePacket(new Encoder(bundle, 1).next());
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
        data: encodeAck([{ start: 2, length: 3 }]),
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
    ackAfterMs: 20,
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
  // A repair symbol may peel a dropped block by luck before the ack, so the
  // first ack names some of code 3's blocks, and nothing outside the drops.
  const blocks = (code: number) =>
    Array.from({ length: packetsPerCode }, (_, i) => code * packetsPerCode + i);
  const dropped = new Set([...blocks(3), ...blocks(7)]);
  const ackedBlocks = acks[0].flatMap(({ start, length }) =>
    Array.from({ length }, (_, i) => start + i)
  );
  assert(ackedBlocks.every((b) => dropped.has(b)));
  assert(blocks(3).some((b) => ackedBlocks.includes(b)));
  assert(last!.qrSent < last!.k + 2 * packetsPerCode + 8);
});

Deno.test("a QR transfer that completes during an ack's turnaround still gets DONE", async () => {
  const items = testItems(2_000);
  const bundle = await encodeBundle(items);
  const air = new Air({ seed: 15 });
  // Codes land every 10 ms: the first past-k code arms the ack, its timer
  // fires before the next code, and that code completes the transfer inside
  // the 30 ms turnaround sleep.
  const display = new Display({ seed: 15, dropCodes: [3] });
  const stopReceiver = new AbortController();
  const stopSender = new AbortController();
  const giveUp = setTimeout(() => stopSender.abort(), 3_000);

  const received = receiveBundle({
    sound: air.party(),
    sources: [display],
    silenceMs: 60_000,
    turnaroundMs: 30,
    ackAfterMs: 5,
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

Deno.test("a sound receiver acks after a stall and completes", async () => {
  const items = testItems(4_000);
  const bundle = await encodeBundle(items);
  const air = new Air({ seed: 14, loss: 0.2 });
  let last: ReceiveProgress | undefined;

  const received = receiveBundle({
    sound: air.party(),
    silenceMs: SILENCE_MS,
    ackAfterMs: 10,
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

Deno.test("without ackAfterMs a receiver never acks", async () => {
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

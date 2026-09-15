import { assert, assertEquals, assertRejects } from "@std/assert";
import { sleep } from "./abort.ts";
import { encodeBundle, type Item } from "./bundle.ts";
import type { PacketChannel, PacketDisplay, PacketSource } from "./channel.ts";
import { Encoder } from "./fountain/encoder.ts";
import { decodePacket, encodePacket, PacketType } from "./packet.ts";
import {
  receiveBundle,
  type Received,
  type ReceiveProgress,
  sendBundle,
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
  readonly #random: () => number;
  readonly #loss: number;
  readonly #listeners = new Set<(bytes: Uint8Array) => void>();

  constructor(options: { seed: number; loss?: number }) {
    this.#random = seededRandom(options.seed);
    this.#loss = options.loss ?? 0;
  }

  show(packets: Uint8Array[]): void {
    this.cleared = false;
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

Deno.test("sound and QR together use fewer sound packets than sound alone", async () => {
  const items = testItems(2_000);
  const bundle = await encodeBundle(items);

  const soundPackets = async (withQr: boolean) => {
    const air = new Air({ seed: 9, loss: 0.2 });
    const display = new Display({ seed: 9, loss: 0.3 });
    let soundSent = 0;
    const received = receiveBundle({
      sound: air.party(),
      sources: [display],
      silenceMs: SILENCE_MS,
      signal: new AbortController().signal,
    });
    const sent = await sendBundle(bundle, {
      ...sound(air.party(), LISTEN_EVERY, WINDOW_MS),
      qr: withQr ? { display, packetsPerCode: 2, fps: 50 } : undefined,
      signal: new AbortController().signal,
      onProgress: (p) => soundSent = p.soundSent,
    });
    assertEquals(sent, "done");
    assertEquals((await received)?.items, items);
    return soundSent;
  };

  const alone = await soundPackets(false);
  const together = await soundPackets(true);
  assert(together < alone, `${together} >= ${alone}`);
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

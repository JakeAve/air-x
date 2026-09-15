import { assert, assertEquals } from "@std/assert";
import { sleep } from "./abort.ts";
import { encodeBundle, type Item } from "./bundle.ts";
import type { PacketChannel } from "./channel.ts";
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

function testItems(): Item[] {
  const random = seededRandom(42);
  const bytes = new Uint8Array(400);
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

  const received = receiveBundle(air.party(), {
    silenceMs: SILENCE_MS,
    signal: stopReceiver.signal,
    onDone: () => dones++,
  });
  const sent = await sendBundle(air.party(), bundle, {
    listenEvery: LISTEN_EVERY,
    windowMs: WINDOW_MS,
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

  const received = receiveBundle(air.party(), {
    silenceMs: 5_000,
    signal: stopReceiver.signal,
    onComplete: (r) => completed = r,
    onDone: () => dones++,
  });
  const sent = await sendBundle(air.party(), bundle, {
    listenEvery: LISTEN_EVERY,
    windowMs: WINDOW_MS,
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

  const received = receiveBundle(air.party(), {
    silenceMs: SILENCE_MS,
    signal: new AbortController().signal,
    onComplete: () => stopSender.abort(),
    onDone: () => dones++,
  });
  const sent = await sendBundle(air.party(), bundle, {
    listenEvery: 1000,
    windowMs: WINDOW_MS,
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

  const sent = sendBundle(air.party(), bundle, {
    listenEvery: LISTEN_EVERY,
    windowMs: WINDOW_MS,
    signal: stopSender.signal,
  });
  const received = receiveBundle(new Air({ seed: 5 }).party(), {
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

  const received = receiveBundle(air.party(), {
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

  const sent = await sendBundle(air.party(), bundle, {
    listenEvery: LISTEN_EVERY,
    windowMs: WINDOW_MS,
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

  const received = receiveBundle(air.party(), {
    silenceMs: 5_000,
    turnaroundMs: 60,
    signal: stopReceiver.signal,
  });
  const sent = await sendBundle(air.party(30), bundle, {
    listenEvery: LISTEN_EVERY,
    windowMs: 150,
    signal: stopSender.signal,
  });
  clearTimeout(giveUp);
  stopReceiver.abort();

  assertEquals(sent, "done");
  assertEquals((await received)?.items, items);
});

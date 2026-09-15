import { assertEquals } from "@std/assert";
import { Encoder } from "./fountain/encoder.ts";
import { DATA_BYTES, MAX_BUNDLE_BYTES } from "./protocol.ts";
import { type Packet, PacketType } from "./packet.ts";
import { Receiver } from "./receiver.ts";

function seededRandom(seed: number) {
  let s = seed;
  return () => (s = (s * 1103515245 + 12345) % 2147483648) / 2147483648;
}

function randomBytes(random: () => number, length: number): Uint8Array {
  const bytes = new Uint8Array(length);
  for (let i = 0; i < bytes.length; i++) bytes[i] = Math.floor(random() * 256);
  return bytes;
}

function padded(bundle: Uint8Array, k: number): Uint8Array {
  const out = new Uint8Array(k * DATA_BYTES);
  out.set(bundle);
  return out;
}

Deno.test("decodes two interleaved transfers independently", () => {
  const random = seededRandom(1);
  const bundleA = randomBytes(random, 5 * DATA_BYTES);
  const bundleB = randomBytes(random, 3 * DATA_BYTES);
  const encoderA = new Encoder(bundleA, 1);
  const encoderB = new Encoder(bundleB, 2);
  const receiver = new Receiver();

  const completed = new Map<number, Uint8Array>();
  for (let i = 0; i < 30; i++) {
    for (const packet of [encoderA.next(), encoderB.next()]) {
      const result = receiver.push(packet, i);
      if (result) completed.set(result.transferId, result.bundle);
    }
  }

  assertEquals(completed.get(1), padded(bundleA, 5));
  assertEquals(completed.get(2), padded(bundleB, 3));
});

Deno.test("a stray packet that fails to lock does not block the real transfer", () => {
  const random = seededRandom(2);
  const bundle = randomBytes(random, 3 * DATA_BYTES);
  const encoder = new Encoder(bundle, 7);
  const real = encoder.next();
  const receiver = new Receiver();

  assertEquals(receiver.push({ ...real, k: 0 }, 0), undefined);
  assertEquals(receiver.progress(), []);

  const oversizeK = Math.floor(MAX_BUNDLE_BYTES / DATA_BYTES) + 1;
  assertEquals(receiver.push({ ...real, k: oversizeK }, 0), undefined);
  assertEquals(receiver.progress(), []);

  let result;
  for (let i = 0; i < 3 * 3 + 20; i++) {
    result = receiver.push(encoder.next(), i);
    if (result) break;
  }
  assertEquals(result, { transferId: 7, bundle: padded(bundle, 3) });
});

Deno.test("evicts the least recently heard transfer when stale", () => {
  const random = seededRandom(3);
  const receiver = new Receiver({ staleMs: 100, maxTransfers: 4 });
  const bundle = randomBytes(random, 2 * DATA_BYTES);
  const encoder = new Encoder(bundle, 9);

  receiver.push(encoder.next(), 0);
  assertEquals(receiver.progress().map((p) => p.transferId), [9]);

  receiver.push(encoder.next(), 50);
  assertEquals(receiver.progress().map((p) => p.transferId), [9]);

  receiver.push(new Encoder(randomBytes(random, DATA_BYTES), 99).next(), 151);
  assertEquals(receiver.progress().map((p) => p.transferId), [99]);
});

Deno.test("evicts the least recently heard transfer past maxTransfers", () => {
  const random = seededRandom(4);
  const receiver = new Receiver({ maxTransfers: 2 });

  const first = new Encoder(randomBytes(random, DATA_BYTES), 1).next();
  const second = new Encoder(randomBytes(random, DATA_BYTES), 2).next();
  const third = new Encoder(randomBytes(random, DATA_BYTES), 3).next();

  receiver.push(first, 0);
  receiver.push(second, 1);
  assertEquals(receiver.progress().map((p) => p.transferId).sort(), [1, 2]);

  receiver.push(third, 2);
  assertEquals(receiver.progress().map((p) => p.transferId).sort(), [2, 3]);
});

Deno.test("reports a completed bundle exactly once", () => {
  const random = seededRandom(5);
  const bundle = randomBytes(random, 2 * DATA_BYTES);
  const encoder = new Encoder(bundle, 4);
  const receiver = new Receiver();

  const results: Array<ReturnType<Receiver["push"]>> = [];
  for (let i = 0; i < 10; i++) {
    results.push(receiver.push(encoder.next(), i));
  }

  const completions = results.filter((r) => r !== undefined);
  assertEquals(completions.length, 1);
  assertEquals(completions[0], { transferId: 4, bundle: padded(bundle, 2) });
});

Deno.test("Done packets are ignored", () => {
  const random = seededRandom(6);
  const bundle = randomBytes(random, DATA_BYTES);
  const encoder = new Encoder(bundle, 8);
  const receiver = new Receiver();

  const done: Packet = { ...encoder.next(), type: PacketType.Done };
  assertEquals(receiver.push(done, 0), undefined);
  assertEquals(receiver.progress(), []);
});

Deno.test("forget clears the decoder so a fresh transfer can restart", () => {
  const random = seededRandom(7);
  const bundle = randomBytes(random, 2 * DATA_BYTES);
  const encoder = new Encoder(bundle, 6);
  const receiver = new Receiver();

  let result;
  for (let i = 0; i < 10; i++) {
    result = receiver.push(encoder.next(), i);
    if (result) break;
  }
  assertEquals(result, { transferId: 6, bundle: padded(bundle, 2) });

  assertEquals(receiver.push(encoder.next(), 10), undefined);

  receiver.forget(6);
  assertEquals(receiver.progress(), []);

  const restarted = new Encoder(bundle, 6);
  let restartedResult;
  for (let i = 0; i < 10; i++) {
    restartedResult = receiver.push(restarted.next(), i);
    if (restartedResult) break;
  }
  assertEquals(restartedResult, { transferId: 6, bundle: padded(bundle, 2) });
});

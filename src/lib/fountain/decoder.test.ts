import { assert, assertEquals } from "@std/assert";
import { decodeBundle, encodeBundle } from "../bundle.ts";
import { type Packet, PacketType } from "../packet.ts";
import { DATA_BYTES, MAX_BUNDLE_BYTES } from "../protocol.ts";
import { Decoder } from "./decoder.ts";
import { Encoder } from "./encoder.ts";

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

function feed(decoder: Decoder, packets: Iterable<Packet>): Uint8Array {
  for (const packet of packets) {
    const result = decoder.push(packet);
    if (result) return result;
  }
  throw new Error(`incomplete: ${decoder.resolved}/${decoder.k} resolved`);
}

function* stream(encoder: Encoder, count: number): Generator<Packet> {
  for (let i = 0; i < count; i++) yield encoder.next();
}

function* lossy(
  packets: Iterable<Packet>,
  random: () => number,
  loss: number,
): Generator<Packet> {
  for (const packet of packets) if (random() >= loss) yield packet;
}

for (const k of [1, 10, 50]) {
  const budget = 3 * k + 20;

  Deno.test(`k=${k}: no loss decodes from the source symbols`, () => {
    const bundle = randomBytes(seededRandom(k), k * DATA_BYTES - 7);
    const encoder = new Encoder(bundle, 11);
    const decoder = new Decoder();
    assertEquals(feed(decoder, stream(encoder, k)), padded(bundle, k));
    assertEquals(decoder.transferId, 11);
    assertEquals(decoder.k, k);
    assertEquals(decoder.resolved, k);
  });

  Deno.test(`k=${k}: shuffled order decodes`, () => {
    const random = seededRandom(k + 100);
    const bundle = randomBytes(random, k * DATA_BYTES);
    const packets = [...stream(new Encoder(bundle, 12), budget)];
    for (let i = packets.length - 1; i > 0; i--) {
      const j = Math.floor(random() * (i + 1));
      [packets[i], packets[j]] = [packets[j], packets[i]];
    }
    assertEquals(feed(new Decoder(), packets), padded(bundle, k));
  });

  Deno.test(`k=${k}: joining at symbol 3k decodes from repair symbols`, () => {
    const bundle = randomBytes(seededRandom(k + 200), k * DATA_BYTES);
    const encoder = new Encoder(bundle, 13);
    for (let i = 0; i < 3 * k; i++) encoder.next();
    assertEquals(
      feed(new Decoder(), stream(encoder, budget)),
      padded(bundle, k),
    );
  });

  Deno.test(`k=${k}: 20% random loss decodes`, () => {
    const random = seededRandom(k + 300);
    const bundle = randomBytes(random, k * DATA_BYTES);
    const packets = lossy(stream(new Encoder(bundle, 14), budget), random, 0.2);
    assertEquals(feed(new Decoder(), packets), padded(bundle, k));
  });
}

Deno.test("ignores foreign transfers, Done packets, and mismatched k", () => {
  const random = seededRandom(400);
  const bundle = randomBytes(random, 20 * DATA_BYTES);
  const ours = new Encoder(bundle, 1);
  const foreign = new Encoder(randomBytes(random, 20 * DATA_BYTES), 2);
  const decoder = new Decoder();

  function* interleaved(): Generator<Packet> {
    for (let i = 0; i < 80; i++) {
      const packet = ours.next(PacketType.DataListen);
      yield packet;
      yield { ...packet, type: PacketType.Done, symbolId: packet.symbolId + 1 };
      yield { ...packet, k: 21, symbolId: packet.symbolId + 1 };
      yield foreign.next();
    }
  }

  assertEquals(feed(decoder, interleaved()), padded(bundle, 20));
  assertEquals(decoder.transferId, 1);
});

Deno.test("locks onto the first data packet, not a Done", () => {
  const decoder = new Decoder();
  const done = new Encoder(new Uint8Array(1), 9).next(PacketType.Done);
  assertEquals(decoder.push(done), undefined);
  assertEquals(decoder.transferId, undefined);
  assertEquals(decoder.k, undefined);
});

Deno.test("ignores a k=0 or oversize-k packet, then locks onto a real transfer", () => {
  const bundle = randomBytes(seededRandom(800), 3 * DATA_BYTES);
  const encoder = new Encoder(bundle, 42);
  const decoder = new Decoder();
  const real = encoder.next();

  assertEquals(decoder.push({ ...real, k: 0 }), undefined);
  assertEquals(decoder.k, undefined);

  const oversizeK = Math.floor(MAX_BUNDLE_BYTES / DATA_BYTES) + 1;
  assertEquals(decoder.push({ ...real, k: oversizeK }), undefined);
  assertEquals(decoder.k, undefined);

  assertEquals(decoder.push(real), undefined);
  assertEquals(decoder.k, 3);
  assertEquals(feed(decoder, stream(encoder, 3 * 3 + 20)), padded(bundle, 3));
});

Deno.test("a duplicate symbol is ignored", () => {
  const bundle = randomBytes(seededRandom(500), 2 * DATA_BYTES);
  const encoder = new Encoder(bundle, 3);
  const decoder = new Decoder();
  const first = encoder.next();
  decoder.push(first);
  decoder.push({ ...first, data: new Uint8Array(DATA_BYTES) });
  assertEquals(decoder.resolved, 1);
  assertEquals(decoder.push(encoder.next()), padded(bundle, 2));
});

Deno.test("keeps returning the bytes after completion", () => {
  const bundle = randomBytes(seededRandom(600), 3 * DATA_BYTES);
  const encoder = new Encoder(bundle, 4);
  const decoder = new Decoder();
  feed(decoder, stream(encoder, 3));
  assertEquals(decoder.push(encoder.next()), padded(bundle, 3));
});

Deno.test("Encoder to Decoder to decodeBundle recovers the items", async () => {
  const random = seededRandom(700);
  const items = [
    { name: "note.txt", type: "text/plain", bytes: randomBytes(random, 900) },
    {
      name: "a.bin",
      type: "application/octet-stream",
      bytes: new Uint8Array(0),
    },
  ];
  const bundle = await encodeBundle(items);
  const encoder = new Encoder(bundle, 321);
  for (let i = 0; i < encoder.k; i++) encoder.next();
  const packets = lossy(stream(encoder, 3 * encoder.k + 20), random, 0.2);
  const bytes = feed(new Decoder(), packets);
  assert(bytes.length === encoder.k * DATA_BYTES);
  assertEquals(await decodeBundle(bytes), items);
});

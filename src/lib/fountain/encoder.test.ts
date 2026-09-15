import { assertEquals, assertThrows } from "@std/assert";
import { encodePacket, PacketType } from "../packet.ts";
import { DATA_BYTES, MAX_BUNDLE_BYTES, MAX_SYMBOL_ID } from "../protocol.ts";
import { Encoder } from "./encoder.ts";
import { blockSet } from "./symbols.ts";

function seededBytes(seed: number, length: number): Uint8Array {
  let s = seed;
  const bytes = new Uint8Array(length);
  for (let i = 0; i < length; i++) {
    s = (s * 1103515245 + 12345) % 2147483648;
    bytes[i] = s >> 16;
  }
  return bytes;
}

Deno.test("source packets carry the zero-padded bundle in order", () => {
  const bundle = seededBytes(1, 3 * DATA_BYTES + 5);
  const encoder = new Encoder(bundle, 77);
  assertEquals(encoder.k, 4);

  const padded = new Uint8Array(4 * DATA_BYTES);
  padded.set(bundle);
  for (let i = 0; i < 4; i++) {
    const packet = encoder.next();
    assertEquals(packet.type, PacketType.Data);
    assertEquals(packet.transferId, 77);
    assertEquals(packet.k, 4);
    assertEquals(packet.symbolId, i);
    assertEquals(
      packet.data,
      padded.slice(i * DATA_BYTES, (i + 1) * DATA_BYTES),
    );
  }
});

Deno.test("repair packets are the XOR of their block set", () => {
  const bundle = seededBytes(2, 20 * DATA_BYTES);
  const encoder = new Encoder(bundle, 5);
  for (let i = 0; i < 20; i++) encoder.next();
  for (let symbolId = 20; symbolId < 220; symbolId++) {
    const packet = encoder.next(PacketType.DataListen);
    assertEquals(packet.symbolId, symbolId);
    assertEquals(packet.type, PacketType.DataListen);
    const expected = new Uint8Array(DATA_BYTES);
    for (const block of blockSet(5, symbolId, 20)) {
      for (let j = 0; j < DATA_BYTES; j++) {
        expected[j] ^= bundle[block * DATA_BYTES + j];
      }
    }
    assertEquals(packet.data, expected);
    encodePacket(packet);
  }
});

Deno.test("with one block every symbol is that block", () => {
  const bundle = seededBytes(3, 10);
  const block = new Uint8Array(DATA_BYTES);
  block.set(bundle);
  const encoder = new Encoder(bundle, 1);
  assertEquals(encoder.k, 1);
  for (let i = 0; i < 100; i++) assertEquals(encoder.next().data, block);
});

Deno.test("an empty bundle is one zero block", () => {
  const encoder = new Encoder(new Uint8Array(0), 1);
  assertEquals(encoder.k, 1);
  assertEquals(encoder.next().data, new Uint8Array(DATA_BYTES));
});

Deno.test("next throws past MAX_SYMBOL_ID", () => {
  const encoder = new Encoder(new Uint8Array(1), 1);
  (encoder as unknown as { nextSymbolId: number }).nextSymbolId = MAX_SYMBOL_ID;
  assertEquals(encoder.next().symbolId, MAX_SYMBOL_ID);
  assertThrows(() => encoder.next(), RangeError);
});

Deno.test("a bundle over MAX_BUNDLE_BYTES throws", () => {
  const huge = { length: MAX_BUNDLE_BYTES + 1 } as Uint8Array;
  assertThrows(() => new Encoder(huge, 1), RangeError);
});

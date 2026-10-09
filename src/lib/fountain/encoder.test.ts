import { assertEquals, assertThrows } from "@std/assert";
import { encodePacket, PacketType } from "../packet.ts";
import {
  COMPACT_MAX_SYMBOL_ID,
  dataBytes,
  MAX_BUNDLE_BYTES,
  MAX_SYMBOL_ID,
  SOUND_PACKET_BYTES,
} from "../protocol.ts";

const DATA_BYTES = dataBytes(SOUND_PACKET_BYTES, 0);
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
  const encoder = new Encoder(bundle, 77, SOUND_PACKET_BYTES);
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
  const encoder = new Encoder(bundle, 5, SOUND_PACKET_BYTES);
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
  const encoder = new Encoder(bundle, 1, SOUND_PACKET_BYTES);
  assertEquals(encoder.k, 1);
  for (let i = 0; i < 100; i++) assertEquals(encoder.next().data, block);
});

Deno.test("an empty bundle is one zero block", () => {
  const encoder = new Encoder(new Uint8Array(0), 1, SOUND_PACKET_BYTES);
  assertEquals(encoder.k, 1);
  assertEquals(encoder.next().data, new Uint8Array(DATA_BYTES));
});

Deno.test("next throws past the transfer's highest symbol id", () => {
  for (
    const [bytes, max] of [[1, COMPACT_MAX_SYMBOL_ID], [
      256 * DATA_BYTES,
      MAX_SYMBOL_ID,
    ]]
  ) {
    const encoder = new Encoder(new Uint8Array(bytes), 1, SOUND_PACKET_BYTES);
    (encoder as unknown as { nextSymbolId: number }).nextSymbolId = max;
    assertEquals(encoder.next().symbolId, max);
    assertThrows(() => encoder.next(), RangeError);
  }
});

Deno.test("a 56-byte bundle is one sound packet, a 57-byte bundle is two", () => {
  const one = new Encoder(new Uint8Array(56), 1, SOUND_PACKET_BYTES);
  assertEquals([one.k, one.dataBytes], [1, 56]);
  assertEquals(encodePacket(one.next()).length, SOUND_PACKET_BYTES);
  const two = new Encoder(new Uint8Array(57), 1, SOUND_PACKET_BYTES);
  assertEquals([two.k, two.dataBytes], [2, 56]);
  const wide = new Encoder(new Uint8Array(255 * 56 + 1), 1, SOUND_PACKET_BYTES);
  assertEquals([wide.k, wide.dataBytes], [270, 53]);
  assertEquals(encodePacket(wide.next()).length, SOUND_PACKET_BYTES);
});

Deno.test("symbol hands out any id without moving next", () => {
  const bundle = seededBytes(4, 3 * DATA_BYTES + 5);
  const padded = new Uint8Array(4 * DATA_BYTES);
  padded.set(bundle);
  const encoder = new Encoder(bundle, 9, SOUND_PACKET_BYTES);
  for (let i = 3; i >= 0; i--) {
    const packet = encoder.symbol(i, PacketType.DataListen);
    assertEquals(packet.symbolId, i);
    assertEquals(packet.type, PacketType.DataListen);
    assertEquals(
      packet.data,
      padded.slice(i * DATA_BYTES, (i + 1) * DATA_BYTES),
    );
  }
  assertEquals(
    encoder.symbol(50).data,
    new Encoder(bundle, 9, SOUND_PACKET_BYTES).symbol(50).data,
  );
  assertEquals(encoder.next().symbolId, 0);
  assertEquals(encoder.next().symbolId, 1);
});

Deno.test("symbol throws on an id out of range", () => {
  const encoder = new Encoder(new Uint8Array(1), 1, SOUND_PACKET_BYTES);
  assertEquals(
    encoder.symbol(COMPACT_MAX_SYMBOL_ID).symbolId,
    COMPACT_MAX_SYMBOL_ID,
  );
  for (const id of [COMPACT_MAX_SYMBOL_ID + 1, -1, 1.5, NaN]) {
    assertThrows(() => encoder.symbol(id), RangeError);
  }
});

Deno.test("a bundle over MAX_BUNDLE_BYTES throws", () => {
  const huge = { length: MAX_BUNDLE_BYTES + 1 } as Uint8Array;
  assertThrows(() => new Encoder(huge, 1, SOUND_PACKET_BYTES), RangeError);
});

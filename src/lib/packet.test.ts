import { assertEquals, assertThrows } from "@std/assert";
import {
  decodeAck,
  decodePacket,
  encodeAck,
  encodePacket,
  Packet,
  PacketType,
} from "./packet.ts";
import { DATA_BYTES, MAX_K, MAX_SYMBOL_ID, PACKET_BYTES } from "./protocol.ts";

function seededRandom(seed: number) {
  let s = seed;
  return () => (s = (s * 1103515245 + 12345) % 2147483648) / 2147483648;
}

function randomData(random: () => number): Uint8Array {
  const data = new Uint8Array(DATA_BYTES);
  for (let i = 0; i < data.length; i++) data[i] = Math.floor(random() * 256);
  return data;
}

Deno.test("a packet round trips through encode and decode", () => {
  const random = seededRandom(1);
  for (let i = 0; i < 20; i++) {
    const packet: Packet = {
      type: PacketType.Data,
      transferId: Math.floor(random() * 65536),
      k: Math.floor(random() * (MAX_K + 1)),
      symbolId: Math.floor(random() * (MAX_SYMBOL_ID + 1)),
      data: randomData(random),
    };
    const bytes = encodePacket(packet);
    assertEquals(bytes.length, PACKET_BYTES);
    assertEquals(decodePacket(bytes), packet);
  }
});

Deno.test("every packet type round trips", () => {
  const random = seededRandom(2);
  for (
    const type of [
      PacketType.Data,
      PacketType.DataListen,
      PacketType.Done,
      PacketType.Ack,
    ]
  ) {
    const packet: Packet = {
      type,
      transferId: 1,
      k: 10,
      symbolId: 3,
      data: randomData(random),
    };
    assertEquals(decodePacket(encodePacket(packet)), packet);
  }
});

Deno.test("a corrupted byte fails the crc and decodes to undefined", () => {
  const random = seededRandom(3);
  const packet: Packet = {
    type: PacketType.Data,
    transferId: 42,
    k: 5,
    symbolId: 1,
    data: randomData(random),
  };
  const bytes = encodePacket(packet);
  for (let i = 0; i < bytes.length; i++) {
    const corrupted = bytes.slice();
    corrupted[i] ^= 0xff;
    assertEquals(decodePacket(corrupted), undefined);
  }
});

Deno.test("a wrong version decodes to undefined", () => {
  const random = seededRandom(4);
  const packet: Packet = {
    type: PacketType.Data,
    transferId: 1,
    k: 1,
    symbolId: 1,
    data: randomData(random),
  };
  const bytes = encodePacket(packet);
  bytes[0] = (2 << 4) | packet.type;
  assertEquals(decodePacket(bytes), undefined);
});

Deno.test("an unknown type nibble decodes to undefined", () => {
  const random = seededRandom(5);
  const packet: Packet = {
    type: PacketType.Data,
    transferId: 1,
    k: 1,
    symbolId: 1,
    data: randomData(random),
  };
  const bytes = encodePacket(packet);
  bytes[0] = (bytes[0] & 0xf0) | 0x0f;
  assertEquals(decodePacket(bytes), undefined);
});

Deno.test("a wrong length decodes to undefined", () => {
  assertEquals(decodePacket(new Uint8Array(PACKET_BYTES - 1)), undefined);
  assertEquals(decodePacket(new Uint8Array(PACKET_BYTES + 1)), undefined);
  assertEquals(decodePacket(new Uint8Array(0)), undefined);
});

Deno.test("encodePacket throws RangeError on out-of-range fields", () => {
  const base: Packet = {
    type: PacketType.Data,
    transferId: 0,
    k: 0,
    symbolId: 0,
    data: new Uint8Array(DATA_BYTES),
  };
  assertThrows(() => encodePacket({ ...base, transferId: 65536 }), RangeError);
  assertThrows(() => encodePacket({ ...base, transferId: -1 }), RangeError);
  assertThrows(() => encodePacket({ ...base, k: MAX_K + 1 }), RangeError);
  assertThrows(
    () => encodePacket({ ...base, symbolId: MAX_SYMBOL_ID + 1 }),
    RangeError,
  );
});

Deno.test("encodePacket throws RangeError when data length is wrong", () => {
  const base: Packet = {
    type: PacketType.Data,
    transferId: 0,
    k: 0,
    symbolId: 0,
    data: new Uint8Array(DATA_BYTES),
  };
  assertThrows(
    () => encodePacket({ ...base, data: new Uint8Array(DATA_BYTES - 1) }),
    RangeError,
  );
  assertThrows(
    () => encodePacket({ ...base, data: new Uint8Array(DATA_BYTES + 1) }),
    RangeError,
  );
});

Deno.test("an ack pins its exact bytes and round trips through a packet", () => {
  const runs = [{ start: 0x010203, length: 4 }, { start: 7, length: 255 }];
  const data = encodeAck(runs);
  assertEquals(data.length, DATA_BYTES);
  assertEquals(
    [...data.subarray(0, 9)],
    [1, 2, 3, 4, 0, 0, 7, 255, 0],
  );
  const packet: Packet = {
    type: PacketType.Ack,
    transferId: 9,
    k: 100,
    symbolId: 50,
    data,
  };
  const back = decodePacket(encodePacket(packet))!;
  assertEquals(back, packet);
  assertEquals(decodeAck(back.data), runs);
});

Deno.test("decodeAck of all zeros is empty, and encodeAck rejects bad runs", () => {
  assertEquals(decodeAck(new Uint8Array(DATA_BYTES)), []);
  assertEquals(decodeAck(encodeAck([])), []);
  const full = Array.from({ length: 13 }, (_, i) => ({ start: i, length: 1 }));
  assertEquals(decodeAck(encodeAck(full)), full);
  assertThrows(() => encodeAck([...full, { start: 0, length: 1 }]), RangeError);
  assertThrows(() => encodeAck([{ start: 0, length: 0 }]), RangeError);
  assertThrows(() => encodeAck([{ start: 0, length: 256 }]), RangeError);
  assertThrows(() => encodeAck([{ start: MAX_K + 1, length: 1 }]), RangeError);
});

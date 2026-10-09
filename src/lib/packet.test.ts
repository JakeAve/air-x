import { assertEquals, assertThrows } from "@std/assert";
import { crc16 } from "./crc16.ts";
import {
  ackHeard,
  decodeAck,
  decodePacket,
  encodeAck,
  encodePacket,
  Packet,
  PacketType,
} from "./packet.ts";
import {
  COMPACT_MAX_K,
  COMPACT_MAX_SYMBOL_ID,
  dataBytes,
  MAX_K,
  MAX_SYMBOL_ID,
  PROTOCOL_VERSION,
  SOUND_PACKET_BYTES,
} from "./protocol.ts";

const DATA_BYTES = dataBytes(SOUND_PACKET_BYTES, 0);

function seededRandom(seed: number) {
  let s = seed;
  return () => (s = (s * 1103515245 + 12345) % 2147483648) / 2147483648;
}

/** Rewrites the trailing CRC so a hand-edited packet fails on the edit alone. */
function withCrc(bytes: Uint8Array): Uint8Array {
  const crc = crc16(bytes.subarray(0, bytes.length - 2));
  bytes[bytes.length - 2] = crc >> 8;
  bytes[bytes.length - 1] = crc & 0xff;
  return bytes;
}

function randomData(random: () => number, length = DATA_BYTES): Uint8Array {
  const data = new Uint8Array(length);
  for (let i = 0; i < data.length; i++) data[i] = Math.floor(random() * 256);
  return data;
}

Deno.test("a packet round trips through encode and decode", () => {
  const random = seededRandom(1);
  for (let i = 0; i < 20; i++) {
    const k = Math.floor(random() * (MAX_K + 1));
    const packet: Packet = {
      type: PacketType.Data,
      transferId: Math.floor(random() * 65536),
      k,
      symbolId: Math.floor(random() * (MAX_SYMBOL_ID + 1)),
      data: randomData(random, dataBytes(SOUND_PACKET_BYTES, k)),
    };
    const bytes = encodePacket(packet);
    assertEquals(bytes.length, SOUND_PACKET_BYTES);
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
  bytes[0] = (((PROTOCOL_VERSION + 1) & 0xf) << 4) | packet.type;
  assertEquals(decodePacket(withCrc(bytes)), undefined);
});

Deno.test("an unknown type decodes to undefined", () => {
  const random = seededRandom(5);
  const packet: Packet = {
    type: PacketType.Data,
    transferId: 1,
    k: 1,
    symbolId: 1,
    data: randomData(random),
  };
  const bytes = encodePacket(packet);
  for (const type of [4, 5, 6, 7]) {
    bytes[0] = (bytes[0] & 0xf8) | type;
    assertEquals(decodePacket(withCrc(bytes)), undefined);
  }
});

Deno.test("a wrong length decodes to undefined", () => {
  assertEquals(decodePacket(new Uint8Array(SOUND_PACKET_BYTES - 1)), undefined);
  assertEquals(decodePacket(new Uint8Array(SOUND_PACKET_BYTES + 1)), undefined);
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
    () => encodePacket({ ...base, symbolId: COMPACT_MAX_SYMBOL_ID + 1 }),
    RangeError,
  );
  const wide = { ...base, k: 256, data: new Uint8Array(DATA_BYTES - 3) };
  encodePacket({ ...wide, symbolId: MAX_SYMBOL_ID });
  assertThrows(
    () => encodePacket({ ...wide, symbolId: MAX_SYMBOL_ID + 1 }),
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
  const data = encodeAck(runs, 0x0a0b0c, DATA_BYTES);
  assertEquals(data.length, DATA_BYTES);
  assertEquals(
    [...data.subarray(0, 9)],
    [1, 2, 3, 4, 0, 0, 7, 255, 0],
  );
  assertEquals([...data.subarray(48)], [0x0a, 0x0b, 0x0c, 0, 0, 0, 0, 0]);
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
  assertEquals(ackHeard(back.data), 0x0a0b0c);
});

Deno.test("decodeAck of all zeros is empty, and encodeAck rejects bad runs", () => {
  assertEquals(decodeAck(new Uint8Array(DATA_BYTES)), []);
  assertEquals(decodeAck(encodeAck([], 0, DATA_BYTES)), []);
  const full = Array.from({ length: 12 }, (_, i) => ({ start: i, length: 1 }));
  assertEquals(decodeAck(encodeAck(full, 0xffffff, DATA_BYTES)), full);
  assertEquals(ackHeard(encodeAck(full, 0xffffff, DATA_BYTES)), 0xffffff);
  assertThrows(
    () => encodeAck([...full, { start: 0, length: 1 }], 0, DATA_BYTES),
    RangeError,
  );
  assertThrows(
    () => encodeAck([{ start: 0, length: 0 }], 0, DATA_BYTES),
    RangeError,
  );
  assertThrows(
    () => encodeAck([{ start: 0, length: 256 }], 0, DATA_BYTES),
    RangeError,
  );
  assertThrows(
    () => encodeAck([{ start: MAX_K + 1, length: 1 }], 0, DATA_BYTES),
    RangeError,
  );
});

Deno.test("compact packet round-trips at 64 and 128 bytes", () => {
  for (const length of [64, 128]) {
    const packet: Packet = {
      type: PacketType.DataListen,
      transferId: 0x0102,
      k: COMPACT_MAX_K,
      symbolId: COMPACT_MAX_SYMBOL_ID,
      data: new Uint8Array(length - 8).map((_, i) => i),
    };
    const bytes = encodePacket(packet);
    assertEquals(bytes.length, length);
    assertEquals([...bytes.subarray(0, 8)], [0x41, 1, 2, 255, 255, 255, 0, 1]);
    assertEquals(decodePacket(bytes), packet);
  }
});

Deno.test("wide packet round-trips at k 256", () => {
  for (const length of [64, 128]) {
    const packet: Packet = {
      type: PacketType.Ack,
      transferId: 0x0102,
      k: 256,
      symbolId: 0x030405,
      data: new Uint8Array(length - 11).map((_, i) => i),
    };
    const bytes = encodePacket(packet);
    assertEquals(bytes.length, length);
    assertEquals(
      [...bytes.subarray(0, 11)],
      [0x4b, 1, 2, 0, 1, 0, 3, 4, 5, 0, 1],
    );
    assertEquals(decodePacket(bytes), packet);
  }
});

Deno.test("rejects a wide packet with k 255", () => {
  const bytes = encodePacket({
    type: PacketType.Data,
    transferId: 1,
    k: 256,
    symbolId: 2,
    data: new Uint8Array(DATA_BYTES - 3),
  });
  bytes[4] = 0;
  bytes[5] = 255;
  assertEquals(decodePacket(withCrc(bytes)), undefined);
  bytes[4] = 1;
  bytes[5] = 0;
  assertEquals(decodePacket(withCrc(bytes))?.k, 256);
});

Deno.test("a Done packet with k 0 is compact", () => {
  const bytes = encodePacket({
    type: PacketType.Done,
    transferId: 0xabcd,
    k: 0,
    symbolId: 0,
    data: new Uint8Array(DATA_BYTES),
  });
  assertEquals([...bytes.subarray(0, 6)], [0x42, 0xab, 0xcd, 0, 0, 0]);
  assertEquals(decodePacket(bytes)?.type, PacketType.Done);
});

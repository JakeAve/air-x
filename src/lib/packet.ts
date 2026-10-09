import { crc16 } from "./crc16.ts";
import {
  ACK_MAX_RUN,
  ACK_RUN_BYTES,
  ACK_RUNS,
  COMPACT_HEADER_BYTES,
  COMPACT_MAX_K,
  COMPACT_MAX_SYMBOL_ID,
  MAX_K,
  MAX_SYMBOL_ID,
  PACKET_CRC_BYTES,
  PACKET_HEADER_BYTES,
  PROTOCOL_VERSION,
} from "./protocol.ts";

export enum PacketType {
  Data = 0,
  DataListen = 1,
  Done = 2,
  /** Receiver to sender: data holds runs of missing blocks and the fresh symbols heard, symbolId the highest id heard. */
  Ack = 3,
}

const PACKET_TYPES = [
  PacketType.Data,
  PacketType.DataListen,
  PacketType.Done,
  PacketType.Ack,
];

const MAX_TRANSFER_ID = 2 ** 16 - 1;
const PACKET_LENGTHS = [64, 128];
/** First-byte flag: the wide header, used exactly when k is above COMPACT_MAX_K. */
const WIDE = 0b1000;

export interface Packet {
  type: PacketType;
  transferId: number;
  k: number;
  symbolId: number;
  data: Uint8Array;
}

function assertRange(value: number, max: number, name: string): void {
  if (!Number.isInteger(value) || value < 0 || value > max) {
    throw new RangeError(`${name} ${value} out of range 0..${max}`);
  }
}

export function encodePacket(packet: Packet): Uint8Array {
  assertRange(packet.type, 0b111, "type");
  assertRange(packet.transferId, MAX_TRANSFER_ID, "transferId");
  assertRange(packet.k, MAX_K, "k");
  const wide = packet.k > COMPACT_MAX_K;
  assertRange(
    packet.symbolId,
    wide ? MAX_SYMBOL_ID : COMPACT_MAX_SYMBOL_ID,
    "symbolId",
  );
  const header = wide ? PACKET_HEADER_BYTES : COMPACT_HEADER_BYTES;
  const length = header + packet.data.length + PACKET_CRC_BYTES;
  if (!PACKET_LENGTHS.includes(length)) {
    throw new RangeError(
      `packet must be ${PACKET_LENGTHS.join(" or ")} bytes, got ${length}`,
    );
  }

  const bytes = new Uint8Array(length);
  bytes[0] = (PROTOCOL_VERSION << 4) | (wide ? WIDE : 0) | packet.type;
  bytes[1] = (packet.transferId >> 8) & 0xff;
  bytes[2] = packet.transferId & 0xff;
  if (wide) {
    bytes[3] = (packet.k >> 16) & 0xff;
    bytes[4] = (packet.k >> 8) & 0xff;
    bytes[5] = packet.k & 0xff;
    bytes[6] = (packet.symbolId >> 16) & 0xff;
    bytes[7] = (packet.symbolId >> 8) & 0xff;
    bytes[8] = packet.symbolId & 0xff;
  } else {
    bytes[3] = packet.k;
    bytes[4] = (packet.symbolId >> 8) & 0xff;
    bytes[5] = packet.symbolId & 0xff;
  }
  bytes.set(packet.data, header);

  const crc = crc16(bytes.subarray(0, length - PACKET_CRC_BYTES));
  bytes[length - 2] = (crc >> 8) & 0xff;
  bytes[length - 1] = crc & 0xff;

  return bytes;
}

export function decodePacket(bytes: Uint8Array): Packet | undefined {
  const length = bytes.length;
  if (!PACKET_LENGTHS.includes(length)) return undefined;

  const expectedCrc = crc16(bytes.subarray(0, length - PACKET_CRC_BYTES));
  const actualCrc = (bytes[length - 2] << 8) | bytes[length - 1];
  if (actualCrc !== expectedCrc) return undefined;

  const version = bytes[0] >> 4;
  if (version !== PROTOCOL_VERSION) return undefined;

  const type = bytes[0] & 0b111;
  if (!PACKET_TYPES.includes(type)) return undefined;

  const transferId = (bytes[1] << 8) | bytes[2];
  if (!(bytes[0] & WIDE)) {
    return {
      type,
      transferId,
      k: bytes[3],
      symbolId: (bytes[4] << 8) | bytes[5],
      data: bytes.slice(COMPACT_HEADER_BYTES, length - PACKET_CRC_BYTES),
    };
  }
  const k = (bytes[3] << 16) | (bytes[4] << 8) | bytes[5];
  if (k <= COMPACT_MAX_K) return undefined;
  return {
    type,
    transferId,
    k,
    symbolId: (bytes[6] << 16) | (bytes[7] << 8) | bytes[8],
    data: bytes.slice(PACKET_HEADER_BYTES, length - PACKET_CRC_BYTES),
  };
}

export interface Run {
  start: number;
  length: number;
}

const ACK_HEARD_OFFSET = ACK_RUNS * ACK_RUN_BYTES;

/** Packs runs as `start u24 | length u8` each, zero padding ending the list, then `heard` as a u24. `length` is the data size of the packet carrying it. */
export function encodeAck(
  runs: Run[],
  heard: number,
  length: number,
): Uint8Array {
  if (runs.length > ACK_RUNS) {
    throw new RangeError(`${runs.length} runs, at most ${ACK_RUNS}`);
  }
  assertRange(heard, MAX_SYMBOL_ID, "heard");
  const data = new Uint8Array(length);
  data[ACK_HEARD_OFFSET] = (heard >> 16) & 0xff;
  data[ACK_HEARD_OFFSET + 1] = (heard >> 8) & 0xff;
  data[ACK_HEARD_OFFSET + 2] = heard & 0xff;
  runs.forEach(({ start, length }, i) => {
    assertRange(start, MAX_K, "start");
    if (length < 1) throw new RangeError(`length ${length} out of range`);
    assertRange(length, ACK_MAX_RUN, "length");
    const o = i * ACK_RUN_BYTES;
    data[o] = (start >> 16) & 0xff;
    data[o + 1] = (start >> 8) & 0xff;
    data[o + 2] = start & 0xff;
    data[o + 3] = length;
  });
  return data;
}

/** The fresh-symbol count an ack carries after its runs. */
export function ackHeard(data: Uint8Array): number {
  return (data[ACK_HEARD_OFFSET] << 16) | (data[ACK_HEARD_OFFSET + 1] << 8) |
    data[ACK_HEARD_OFFSET + 2];
}

export function decodeAck(data: Uint8Array): Run[] {
  const runs: Run[] = [];
  for (let i = 0; i < ACK_RUNS; i++) {
    const o = i * ACK_RUN_BYTES;
    const length = data[o + 3];
    if (!length) break;
    runs.push({
      start: (data[o] << 16) | (data[o + 1] << 8) | data[o + 2],
      length,
    });
  }
  return runs;
}

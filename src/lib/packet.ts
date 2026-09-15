import { crc16 } from "./crc16.ts";
import {
  DATA_BYTES,
  MAX_K,
  MAX_SYMBOL_ID,
  PACKET_BYTES,
  PACKET_CRC_BYTES,
  PACKET_HEADER_BYTES,
  PROTOCOL_VERSION,
} from "./protocol.ts";

export enum PacketType {
  Data = 0,
  DataListen = 1,
  Done = 2,
}

const PACKET_TYPES = [PacketType.Data, PacketType.DataListen, PacketType.Done];

const MAX_TRANSFER_ID = 2 ** 16 - 1;

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
  assertRange(packet.type, 0b1111, "type");
  assertRange(packet.transferId, MAX_TRANSFER_ID, "transferId");
  assertRange(packet.k, MAX_K, "k");
  assertRange(packet.symbolId, MAX_SYMBOL_ID, "symbolId");
  if (packet.data.length !== DATA_BYTES) {
    throw new RangeError(
      `data must be ${DATA_BYTES} bytes, got ${packet.data.length}`,
    );
  }

  const bytes = new Uint8Array(PACKET_BYTES);
  bytes[0] = (PROTOCOL_VERSION << 4) | packet.type;
  bytes[1] = (packet.transferId >> 8) & 0xff;
  bytes[2] = packet.transferId & 0xff;
  bytes[3] = (packet.k >> 16) & 0xff;
  bytes[4] = (packet.k >> 8) & 0xff;
  bytes[5] = packet.k & 0xff;
  bytes[6] = (packet.symbolId >> 16) & 0xff;
  bytes[7] = (packet.symbolId >> 8) & 0xff;
  bytes[8] = packet.symbolId & 0xff;
  bytes.set(packet.data, PACKET_HEADER_BYTES);

  const crc = crc16(bytes.subarray(0, PACKET_BYTES - PACKET_CRC_BYTES));
  bytes[PACKET_BYTES - 2] = (crc >> 8) & 0xff;
  bytes[PACKET_BYTES - 1] = crc & 0xff;

  return bytes;
}

export function decodePacket(bytes: Uint8Array): Packet | undefined {
  if (bytes.length !== PACKET_BYTES) return undefined;

  const expectedCrc = crc16(bytes.subarray(0, PACKET_BYTES - PACKET_CRC_BYTES));
  const actualCrc = (bytes[PACKET_BYTES - 2] << 8) | bytes[PACKET_BYTES - 1];
  if (actualCrc !== expectedCrc) return undefined;

  const version = bytes[0] >> 4;
  if (version !== PROTOCOL_VERSION) return undefined;

  const type = bytes[0] & 0x0f;
  if (!PACKET_TYPES.includes(type)) return undefined;

  return {
    type,
    transferId: (bytes[1] << 8) | bytes[2],
    k: (bytes[3] << 16) | (bytes[4] << 8) | bytes[5],
    symbolId: (bytes[6] << 16) | (bytes[7] << 8) | bytes[8],
    data: bytes.slice(PACKET_HEADER_BYTES, PACKET_HEADER_BYTES + DATA_BYTES),
  };
}

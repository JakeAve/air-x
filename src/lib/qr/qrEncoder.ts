import encodeQR from "qr";
import { PACKET_BYTES } from "../protocol.ts";
import { bytesToText, textToBytes } from "./bytesAsText.ts";

/** Module grid, `matrix[y][x]` true for a dark module. No quiet zone. */
export type QrMatrix = boolean[][];

/** low: 7%, medium: 15%, quartile: 25%, high: 30% error correction. */
export type QrEcc = "low" | "medium" | "quartile" | "high";

/** Packs every packet's bytes into one code. */
export function encodeQrPackets(
  packets: Uint8Array[],
  ecc: QrEcc = "medium",
): QrMatrix {
  if (packets.length === 0) {
    throw new RangeError(`expected at least 1 packet, got 0`);
  }
  const bytes = new Uint8Array(packets.length * PACKET_BYTES);
  packets.forEach((packet, i) => {
    if (packet.length !== PACKET_BYTES) {
      throw new RangeError(
        `packet ${i} must be ${PACKET_BYTES} bytes, got ${packet.length}`,
      );
    }
    bytes.set(packet, i * PACKET_BYTES);
  });
  return encodeQR(bytesToText(bytes), "raw", {
    ecc,
    encoding: "byte",
    textEncoder: textToBytes,
  });
}

import decodeQR from "qr/decode.js";
import { QR_PACKET_BYTES } from "../protocol.ts";
import { bytesToText, textToBytes } from "./bytesAsText.ts";

/** RGBA pixels, the same shape as a DOM ImageData. */
export interface RgbaImage {
  width: number;
  height: number;
  data: Uint8ClampedArray;
}

/** Returns the packets found in the image, or an empty array when no code of ours is visible. */
export function decodeQrPackets(image: RgbaImage): Uint8Array[] {
  let text: string;
  try {
    text = decodeQR(image, { textDecoder: bytesToText });
  } catch {
    return [];
  }
  const bytes = textToBytes(text);
  if (bytes.length === 0 || bytes.length % QR_PACKET_BYTES !== 0) return [];
  const packets: Uint8Array[] = [];
  for (let i = 0; i < bytes.length; i += QR_PACKET_BYTES) {
    packets.push(bytes.slice(i, i + QR_PACKET_BYTES));
  }
  return packets;
}

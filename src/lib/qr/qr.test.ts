import { assertEquals, assertThrows } from "@std/assert";
import encodeQR from "qr";
import { encodeQrPackets, type QrEcc } from "./qrEncoder.ts";
import { decodeQrPackets } from "./qrDecoder.ts";
import { rasterize } from "./rasterize.ts";
import { bytesToText, textToBytes } from "./bytesAsText.ts";
import { Encoder } from "../fountain/encoder.ts";
import { encodePacket } from "../packet.ts";
import { DATA_BYTES } from "../protocol.ts";

function packets(n: number, transferId = 1): Uint8Array[] {
  const bundle = new Uint8Array(DATA_BYTES * n).map((_, i) =>
    (i * 131 + 7) & 0xff
  );
  const encoder = new Encoder(bundle, transferId);
  return Array.from({ length: n }, () => encodePacket(encoder.next()));
}

Deno.test("bytes map to text and back without loss", () => {
  const all = new Uint8Array(256).map((_, i) => i);
  assertEquals(textToBytes(bytesToText(all)), all);
  assertEquals(bytesToText(all).length, 256);
});

const ns = [1, 4, 8, 12, 16];
const eccs: QrEcc[] = ["low", "medium"];

for (const ecc of eccs) {
  for (const n of ns) {
    Deno.test(`${n} packets round trip through one QR code at ${ecc} ecc`, () => {
      const original = packets(n);
      const matrix = encodeQrPackets(original, ecc);
      const decoded = decodeQrPackets(rasterize(matrix, 4));
      assertEquals(decoded, original);
    });
  }
}

Deno.test("8 packets at medium ecc fit version 19 (93 modules)", () => {
  const matrix = encodeQrPackets(packets(8), "medium");
  assertEquals(matrix.length, 93);
});

Deno.test("a code not carrying whole packets decodes to nothing", () => {
  const matrix = encodeQR("hello", "raw");
  assertEquals(decodeQrPackets(rasterize(matrix, 4)), []);
});

Deno.test("an image with no code decodes to nothing", () => {
  const blank = {
    width: 64,
    height: 64,
    data: new Uint8ClampedArray(64 * 64 * 4).fill(255),
  };
  assertEquals(decodeQrPackets(blank), []);
});

Deno.test("encodeQrPackets rejects an empty list", () => {
  assertThrows(() => encodeQrPackets([]), RangeError);
});

Deno.test("encodeQrPackets rejects a mis-sized packet", () => {
  assertThrows(() => encodeQrPackets([new Uint8Array(3)]), RangeError);
});

import { assertEquals } from "@std/assert";
import { crc16 } from "./crc16.ts";

Deno.test("crc16 matches the CRC-16/CCITT-FALSE check value", () => {
  assertEquals(crc16(new TextEncoder().encode("123456789")), 0x29b1);
});

Deno.test("crc16 of empty input is the initial value", () => {
  assertEquals(crc16(new Uint8Array()), 0xffff);
});

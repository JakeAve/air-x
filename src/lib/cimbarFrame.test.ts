import { assertEquals } from "@std/assert";
import { cimbarHeader } from "./cimbarFrame.ts";

Deno.test("reads libcimbar's header the way FountainMetadata writes it", () => {
  // to_uint8_arr(encode_id 109, size 0x1_23_45_67, block_id 0x0203)
  const size = 0x1234567;
  const frame = Uint8Array.of(
    (109 & 0x7f) | ((size >> 17) & 0x80),
    (size >> 16) & 0xff,
    (size >> 8) & 0xff,
    size & 0xff,
    0x02,
    0x03,
    0xaa, // the chunk's data follows
  );
  assertEquals(cimbarHeader(frame), {
    encodeId: 109,
    size,
    blockId: 0x0203,
  });
});

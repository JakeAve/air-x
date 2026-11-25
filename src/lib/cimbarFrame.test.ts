import { assertEquals } from "@std/assert";
import { CIMBAR_CHUNKS, cimbarHeader, CimbarTally } from "./cimbarFrame.ts";

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

const frame = (i: number) => i * CIMBAR_CHUNKS;

Deno.test("a cimbar tally's share is the frames read between acks over the frames they span", () => {
  const tally = new CimbarTally();
  // Started looking at frame 3; read 3, 4, 6, out of order, and 4 twice.
  assertEquals(tally.read(frame(3)), CIMBAR_CHUNKS);
  assertEquals(tally.read(frame(6)), CIMBAR_CHUNKS);
  assertEquals(tally.read(frame(4)), CIMBAR_CHUNKS);
  assertEquals(tally.read(frame(4)), 0);
  assertEquals(tally.ack(), {
    highest: frame(7) - 1,
    heard: 3 * CIMBAR_CHUNKS,
    share: 3 / 4,
  });
  // Then 1 of frames 7 to 10.
  tally.read(frame(10));
  assertEquals(tally.ack().share, 1 / 4);
});

Deno.test("a cimbar tally gives no share with nothing new above the last ack, as after the sender restarts its ids", () => {
  const tally = new CimbarTally();
  tally.read(frame(40));
  tally.ack();
  assertEquals(tally.read(frame(0)), CIMBAR_CHUNKS);
  assertEquals(tally.ack(), {
    highest: frame(41) - 1,
    heard: 2 * CIMBAR_CHUNKS,
    share: undefined,
  });
});

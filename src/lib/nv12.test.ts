import { assertEquals } from "@std/assert";
import { nv12ToRgba } from "./nv12.ts";

/** A width x height NV12 frame of one color. */
function solid(width: number, height: number, y: number, u: number, v: number) {
  const src = new Uint8Array(width * height * 3 / 2).fill(y, 0, width * height);
  for (let i = width * height; i < src.length; i += 2) {
    src[i] = u;
    src[i + 1] = v;
  }
  return src;
}

Deno.test("gray stays gray, and a 4K frame shrinks to 1920 by every second pixel", () => {
  const { pixels, width, height } = nv12ToRgba(
    solid(3840, 2160, 100, 128, 128),
    3840,
    2160,
    1920,
  );
  assertEquals([width, height], [1920, 1080]);
  assertEquals(pixels.length, 1920 * 1080 * 4);
  assertEquals(Array.from(pixels.subarray(0, 4)), [100, 100, 100, 255]);
});

Deno.test("red and blue come out where BT.601 puts them, clamped", () => {
  // Pure red in BT.601 full range is about Y 76, U 85, V 255.
  const red = nv12ToRgba(solid(4, 2, 76, 85, 255), 4, 2, 4).pixels;
  assertEquals(Array.from(red.subarray(0, 4)), [254, 0, 0, 255]);
  // Pure blue is about Y 29, U 255, V 107.
  const blue = nv12ToRgba(solid(4, 2, 29, 255, 107), 4, 2, 4).pixels;
  assertEquals(Array.from(blue.subarray(0, 4)), [0, 1, 254, 255]);
});

Deno.test("frames already under the edge are kept at full size", () => {
  const { width, height } = nv12ToRgba(
    solid(1920, 1080, 0, 128, 128),
    1920,
    1080,
    1920,
  );
  assertEquals([width, height], [1920, 1080]);
});

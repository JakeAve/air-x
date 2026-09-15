import { assert, assertEquals } from "@std/assert";
import { DATA_BYTES } from "../protocol.ts";
import { blockCount, blockSet } from "./symbols.ts";

Deno.test("blockCount rounds up and is at least 1", () => {
  assertEquals(blockCount(0), 1);
  assertEquals(blockCount(1), 1);
  assertEquals(blockCount(DATA_BYTES), 1);
  assertEquals(blockCount(DATA_BYTES + 1), 2);
  assertEquals(blockCount(10 * DATA_BYTES), 10);
});

Deno.test("source symbols are their own block", () => {
  for (const k of [1, 7, 1000]) {
    for (let symbolId = 0; symbolId < Math.min(k, 20); symbolId++) {
      assertEquals(blockSet(123, symbolId, k), [symbolId]);
    }
  }
});

Deno.test("blockSet is pinned wire behavior", () => {
  const golden: [number, number, number, number[]][] = [
    [0, 1, 1, [0]],
    [1, 10, 10, [0]],
    [1, 10, 11, [0, 8]],
    [42, 10, 25, [0, 4]],
    [513, 100, 150, [74, 85]],
    [65535, 1000, 4096, [38, 84, 299, 431, 640, 691, 806]],
    [7, 50000, 123456, [27084, 46332]],
  ];
  for (const [transferId, k, symbolId, blocks] of golden) {
    assertEquals(blockSet(transferId, symbolId, k), blocks);
  }
});

Deno.test("repair block sets are sorted, distinct, and in range", () => {
  for (const k of [1, 2, 3, 10, 257]) {
    for (let symbolId = k; symbolId < k + 500; symbolId++) {
      const blocks = blockSet(9, symbolId, k);
      assert(blocks.length >= 1 && blocks.length <= k);
      for (let i = 0; i < blocks.length; i++) {
        assert(blocks[i] >= 0 && blocks[i] < k);
        if (i > 0) assert(blocks[i] > blocks[i - 1]);
      }
    }
  }
});

Deno.test("block sets differ across transfers", () => {
  const sets = (transferId: number) =>
    JSON.stringify(
      Array.from({ length: 50 }, (_, i) => blockSet(transferId, 100 + i, 100)),
    );
  assert(sets(1) !== sets(2));
});

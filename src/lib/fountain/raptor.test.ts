import { assert, assertEquals } from "@std/assert";
import {
  dataBytes,
  MAX_BUNDLE_BYTES,
  SOUND_PACKET_BYTES,
} from "../protocol.ts";
import { Decoder } from "./decoder.ts";
import { Encoder } from "./encoder.ts";
import { invertible, ltRow, makeCode, padIndex, padSize } from "./raptor.ts";
import { SEEDS } from "./seeds.ts";

Deno.test("padded sizes step by 1/32 and index back", () => {
  assertEquals([0, 1, 2, 10, 100].map(padSize), [129, 134, 139, 182, 3119]);
  for (let i = 0; i < 50; i++) {
    assertEquals(padIndex(padSize(i)), i);
    assertEquals(padIndex(padSize(i) + 1), i + 1);
  }
});

Deno.test("code parameters are pinned wire behavior", () => {
  assertEquals(makeCode(1000, 0), {
    k: 1000,
    kPad: 1020,
    seed: 0,
    s: 59,
    h: 13,
    w: 1039,
    p: 53,
    p1: 53,
    l: 1092,
  });
  assertEquals(makeCode(316552, 0), {
    k: 316552,
    kPad: 316643,
    seed: 0,
    s: 3967,
    h: 21,
    w: 320041,
    p: 590,
    p1: 593,
    l: 320631,
  });
});

Deno.test("ltRow is pinned wire behavior", () => {
  const golden: [number, number, number, number[]][] = [
    [129, 0, 0, [3, 18, 33, 48, 63, 78, 93, 108, 140, 145]],
    [129, 3, 500, [24, 74, 124, 154, 138, 145]],
    [1000, 1, 999, [631, 700, 1047, 1048]],
    [50000, 2, 123456, [37205, 5400, 25722, 46044, 52175, 52166]],
    [140000, 0, 16777215, [25257, 116405, 63720, 11035, 143915, 144021]],
  ];
  for (const [k, seed, isi, row] of golden) {
    assertEquals([...ltRow(makeCode(k, seed), isi)], row);
  }
});

Deno.test("ltRow columns are distinct and in range", () => {
  const code = makeCode(5000, 0);
  for (let isi = 0; isi < 2000; isi++) {
    const row = [...ltRow(code, isi)];
    assertEquals(new Set(row).size, row.length);
    for (const c of row) assert(c >= 0 && c < code.l);
  }
});

Deno.test("each seed is the smallest that makes its source system invertible", () => {
  for (let i = 0; i < 40; i++) {
    const kPad = padSize(i);
    assert(invertible(kPad, SEEDS[i]), `size ${kPad}`);
    for (let seed = 0; seed < SEEDS[i]; seed++) {
      assert(!invertible(kPad, seed), `size ${kPad} seed ${seed}`);
    }
  }
});

Deno.test("the seed table covers the largest k", () => {
  const maxK = Math.ceil(MAX_BUNDLE_BYTES / dataBytes(SOUND_PACKET_BYTES, 256));
  assert(padSize(SEEDS.length - 1) >= maxK);
  assert(padSize(SEEDS.length - 2) < maxK);
});

Deno.test("repair symbols alone decode within a few of k", () => {
  for (const k of [129, 300, 1500]) {
    const bundle = new Uint8Array(k * dataBytes(SOUND_PACKET_BYTES, k))
      .map((_, i) => (i * 2654435761) >>> 24);
    const encoder = new Encoder(bundle, 3, SOUND_PACKET_BYTES);
    assertEquals(encoder.k, k);
    const decoder = new Decoder();
    let result: Uint8Array | undefined;
    let received = 0;
    for (let id = k; !result && id < 2 * k + 20; id++) {
      received++;
      result = decoder.push(encoder.symbol(id));
    }
    assertEquals(result, bundle);
    assert(received <= k + 12, `k=${k}: ${received}`);
  }
});

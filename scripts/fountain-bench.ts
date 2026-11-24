// Decode overhead and time of the fountain code under random loss, over a
// fixed seed set. `deno run -A scripts/fountain-bench.ts [k...]`
import { Decoder } from "@/lib/fountain/decoder.ts";
import { Encoder } from "@/lib/fountain/encoder.ts";
import { dataBytes, QR_PACKET_BYTES } from "@/lib/protocol.ts";

const TRIALS: Record<number, number> = { 200: 20, 1000: 10, 5000: 5, 50000: 3 };
const ks = Deno.args.length ? Deno.args.map(Number) : [200, 1000, 5000, 50000];

function mulberry32(seed: number): () => number {
  let a = seed | 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

console.log(
  "| k | loss | mean / k | worst / k | mean extra | worst extra | encode ms | decode ms |",
);
console.log("|--:|--:|--:|--:|--:|--:|--:|--:|");
for (const k of ks) {
  const trials = TRIALS[k] ?? 3;
  for (const loss of [0, 0.1, 0.3]) {
    let total = 0;
    let worst = 0;
    let encodeMs = 0;
    let decodeMs = 0;
    for (let seed = 0; seed < trials; seed++) {
      const random = mulberry32(seed * 7919 + k);
      const bundle = new Uint8Array(k * dataBytes(QR_PACKET_BYTES, k)).map(() =>
        random() * 256
      );
      let t = performance.now();
      const encoder = new Encoder(bundle, seed, QR_PACKET_BYTES);
      if (encoder.k !== k) throw new Error(`k ${encoder.k}`);
      encodeMs += performance.now() - t;
      const decoder = new Decoder();
      let received = 0;
      let result: Uint8Array | undefined;
      let spent = 0;
      while (!result) {
        if (received > 3 * k + 100) throw new Error(`k=${k} seed ${seed}`);
        const packet = encoder.next();
        if (random() < loss) continue;
        received++;
        t = performance.now();
        result = decoder.push(packet);
        spent += performance.now() - t;
      }
      decodeMs += spent;
      for (let i = 0; i < bundle.length; i++) {
        if (result[i] !== bundle[i]) {
          throw new Error(`k=${k} seed ${seed}: wrong`);
        }
      }
      total += received;
      worst = Math.max(worst, received);
    }
    const f = (n: number) => (n / k).toFixed(3);
    console.log(
      `| ${k} | ${loss * 100}% | ${f(total / trials)} | ${f(worst)} | ${
        (total / trials - k).toFixed(1)
      } | ${worst - k} | ${(encodeMs / trials).toFixed(0)} | ${
        (decodeMs / trials).toFixed(0)
      } |`,
    );
  }
}

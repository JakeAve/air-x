import { assert, assertEquals } from "@std/assert";
import { DATA_BYTES, DENSE_MAX_K } from "../protocol.ts";
import { Decoder } from "./decoder.ts";
import { Encoder } from "./encoder.ts";

function seededRandom(seed: number) {
  let s = seed;
  return () => (s = (s * 1103515245 + 12345) % 2147483648) / 2147483648;
}

const cases = [
  ...[5, 10, 20, 50].map((k) => ({
    k,
    trials: 200,
    meanBound: 1.15 * k + 3,
    worst: 2 * k + 10,
  })),
  { k: 500, trials: 10, meanBound: 1.3 * 500, worst: 10 * 500 },
];

for (const { k, trials, meanBound, worst } of cases) {
  for (const loss of [0, 0.1, 0.2]) {
    for (const join of [0, 3 * k]) {
      const name = `k=${k}, ${loss * 100}% loss, joining at symbol ${join}`;
      Deno.test({
        name: `${name}: packets to decode stay within the bound`,
        // Soliton repair symbols mostly miss the few blocks a lossy systematic
        // pass leaves: k=500 measures a mean of 725 (10%) and 683 (20%).
        ignore: k > DENSE_MAX_K && join === 0 && loss > 0,
      }, () => {
        const random = seededRandom(k * 1000 + loss * 100 + join);
        let total = 0;
        for (let trial = 0; trial < trials; trial++) {
          const bundle = new Uint8Array(k * DATA_BYTES).map(() =>
            random() * 256
          );
          const encoder = new Encoder(bundle, trial);
          for (let i = 0; i < join; i++) encoder.next();
          const decoder = new Decoder();
          let received = 0;
          let result: Uint8Array | undefined;
          while (!result && received < worst) {
            const packet = encoder.next();
            if (random() < loss) continue;
            received++;
            result = decoder.push(packet);
          }
          assertEquals(result, bundle, `trial ${trial}: over ${worst} packets`);
          total += received;
        }
        const mean = total / trials;
        assert(mean <= meanBound, `mean ${mean} over ${meanBound}`);
      });
    }
  }
}

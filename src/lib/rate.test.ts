import { assertEquals } from "@std/assert";
import { ladderPolicy, type QrRate } from "./rate.ts";

const ladder: QrRate[] = [
  { packetsPerCode: 2, fps: 5 },
  { packetsPerCode: 4, fps: 5 },
  { packetsPerCode: 8, fps: 5 },
];
const options = { ladder, raiseAt: 0.9, lowerBelow: 0.5, retryAfter: 3 };

Deno.test("the ladder steps up on a good sample, down on a bad one, and holds in between", () => {
  const policy = ladderPolicy(options);
  assertEquals(policy({ rate: ladder[1], sent: 100, heard: 90 }), ladder[2]);
  assertEquals(policy({ rate: ladder[1], sent: 100, heard: 89 }), ladder[1]);
  assertEquals(policy({ rate: ladder[1], sent: 100, heard: 50 }), ladder[1]);
  assertEquals(policy({ rate: ladder[1], sent: 100, heard: 49 }), ladder[0]);
});

Deno.test("silence steps down, and the ends of the ladder hold", () => {
  const policy = ladderPolicy(options);
  assertEquals(
    policy({ rate: ladder[2], sent: 100, heard: undefined }),
    ladder[1],
  );
  assertEquals(policy({ rate: ladder[0], sent: 100, heard: 0 }), ladder[0]);
  assertEquals(
    ladderPolicy(options)({ rate: ladder[2], sent: 100, heard: 100 }),
    ladder[2],
  );
});

Deno.test("a rate off the ladder moves to the nearest step in the direction taken", () => {
  const off = { packetsPerCode: 5, fps: 5 };
  assertEquals(
    ladderPolicy(options)({ rate: off, sent: 10, heard: 10 }),
    ladder[2],
  );
  assertEquals(
    ladderPolicy(options)({ rate: off, sent: 10, heard: 0 }),
    ladder[1],
  );
});

Deno.test("a rate that failed is not retried until retryAfter samples later", () => {
  const policy = ladderPolicy(options);
  const good = (rate: QrRate) => policy({ rate, sent: 100, heard: 100 });
  assertEquals(policy({ rate: ladder[2], sent: 100, heard: 0 }), ladder[1]);
  assertEquals(good(ladder[1]), ladder[1]);
  assertEquals(good(ladder[1]), ladder[1]);
  assertEquals(good(ladder[1]), ladder[2]);
});

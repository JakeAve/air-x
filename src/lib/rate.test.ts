import { assertEquals } from "@std/assert";
import { type CameraRate, ladderPolicy } from "./rate.ts";

const ladder: CameraRate[] = [
  { packetsPerCode: 2, fps: 5 },
  { packetsPerCode: 4, fps: 5 },
  { packetsPerCode: 8, fps: 5 },
];
const options = { ladder, raiseAt: 0.9, lowerBelow: 0.5, retryAfter: 3 };

Deno.test("the ladder steps up on a good sample, down on a bad one, and holds in between", () => {
  const policy = ladderPolicy(options);
  assertEquals(policy({ rate: ladder[1], heard: 0.9 }), ladder[2]);
  assertEquals(policy({ rate: ladder[1], heard: 0.89 }), ladder[1]);
  assertEquals(policy({ rate: ladder[1], heard: 0.5 }), ladder[1]);
  assertEquals(policy({ rate: ladder[1], heard: 0.49 }), ladder[0]);
});

Deno.test("silence steps down, and the ends of the ladder hold", () => {
  const policy = ladderPolicy(options);
  assertEquals(
    policy({ rate: ladder[2], silent: true }),
    ladder[1],
  );
  assertEquals(policy({ rate: ladder[0], heard: 0 }), ladder[0]);
  assertEquals(
    ladderPolicy(options)({ rate: ladder[2], heard: 1 }),
    ladder[2],
  );
});

Deno.test("a rate off the ladder moves to the nearest step in the direction taken", () => {
  const off = { packetsPerCode: 5, fps: 5 };
  assertEquals(
    ladderPolicy(options)({ rate: off, heard: 1 }),
    ladder[2],
  );
  assertEquals(
    ladderPolicy(options)({ rate: off, heard: 0 }),
    ladder[1],
  );
});

Deno.test("a rate that failed is not retried until retryAfter samples later", () => {
  const policy = ladderPolicy(options);
  const good = (rate: CameraRate) => policy({ rate, heard: 1 });
  assertEquals(policy({ rate: ladder[2], heard: 0 }), ladder[1]);
  assertEquals(good(ladder[1]), ladder[1]);
  assertEquals(good(ladder[1]), ladder[1]);
  assertEquals(good(ladder[1]), ladder[2]);
});

Deno.test("an ack with no share holds the rate", () => {
  assertEquals(ladderPolicy(options)({ rate: ladder[1] }), ladder[1]);
});

Deno.test("an fps-only ladder steps up and down", () => {
  const policy = ladderPolicy({
    ladder: [{ fps: 5 }, { fps: 8 }, { fps: 12 }],
  });
  assertEquals(policy({ rate: { fps: 5 }, heard: 1 }), { fps: 8 });
  assertEquals(policy({ rate: { fps: 8 }, heard: 0.2 }), { fps: 5 });
});

import { assert, assertAlmostEquals, assertEquals } from "@std/assert";
import { type CameraFrame, OVERHEAD, qrEncoder } from "./cameraCodec.ts";
import { blockCount } from "./fountain/symbols.ts";
import { decodePacket } from "./packet.ts";
import { QR_PACKET_BYTES } from "./protocol.ts";

class Screen {
  codes: number[][] = [];
  cleared = false;
  show(packets: Uint8Array[]) {
    this.codes.push(packets.map((p) => decodePacket(p)!.symbolId));
  }
  clear() {
    this.cleared = true;
  }
}

const bundle = new Uint8Array(3_000).map((_, i) => i * 7);

Deno.test("qrEncoder shows codes of packetsPerCode packets at fps, queued blocks first", async () => {
  const screen = new Screen();
  const stop = new AbortController();
  const frames: CameraFrame[] = [];
  const start = Date.now();
  const sending = qrEncoder(screen).start(
    bundle,
    7,
    { packetsPerCode: 3, fps: 50 },
    stop.signal,
    (f) => {
      frames.push(f);
      if (f.frames === 1) {
        assertEquals(sending.resend([{ start: 1, length: 2 }]), 2);
      }
      if (f.frames === 5) stop.abort();
    },
  );
  await sending.done;

  assertEquals(screen.codes[0], [0, 1, 2]);
  assertEquals(screen.codes[1], [1, 2, 3]);
  assertEquals(screen.codes.length, 5);
  assert(Date.now() - start >= 4 * 20 - 5);
  assertEquals(frames.map((f) => f.fresh), [3, 4, 7, 10, 13]);
  assertEquals(frames[1].symbolIds, [1, 2, 3]);
  assertEquals(sending.fresh, 13);
  assert(screen.cleared);
});

Deno.test("qrEncoder estimates seconds as OVERHEAD times k over packets per second", () => {
  const k = blockCount(bundle.length, QR_PACKET_BYTES);
  assertAlmostEquals(
    qrEncoder(new Screen()).seconds(bundle.length, {
      packetsPerCode: 4,
      fps: 5,
    }),
    Math.ceil(OVERHEAD * k) / 20,
  );
});

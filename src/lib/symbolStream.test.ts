import { assertEquals } from "@std/assert";
import { PacketType } from "./packet.ts";
import { SymbolStream } from "./symbolStream.ts";

const bundle = Uint8Array.from({ length: 400 }, (_, i) => (i * 37 + 5) & 255);
const make = () => new SymbolStream(bundle, 7, 64);

Deno.test("queued blocks come before fresh symbols", () => {
  const s = make();
  assertEquals(s.resend([{ start: 2, length: 2 }]), 2);
  const ids = s.next(4, PacketType.Data).map((p) => p.symbolId);
  assertEquals(ids, [2, 3, 0, 1]);
  assertEquals(s.fresh, 2);
});

Deno.test("repeat resend queues nothing; served ids can be queued again", () => {
  const s = make();
  assertEquals(s.resend([{ start: 1, length: 1 }]), 1);
  assertEquals(s.resend([{ start: 1, length: 1 }]), 0);
  s.next(1, PacketType.Data);
  assertEquals(s.resend([{ start: 1, length: 1 }]), 1);
});

Deno.test("ids >= k are skipped", () => {
  const s = make();
  assertEquals(s.resend([{ start: s.k - 1, length: 5 }]), 1);
  assertEquals(s.resend([{ start: s.k, length: 3 }]), 0);
});

Deno.test("lastType lands on the last packet only", () => {
  const types = make().next(3, PacketType.DataListen).map((p) => p.type);
  assertEquals(types, [
    PacketType.Data,
    PacketType.Data,
    PacketType.DataListen,
  ]);
});

import { assert, assertEquals } from "@std/assert";
import type { PacketSource } from "./channel.ts";
import { Encoder } from "./fountain/encoder.ts";
import { encodePacket, PacketType } from "./packet.ts";
import { QR_PACKET_BYTES } from "./protocol.ts";
import { packetDecoder, type TransferHeard } from "./transferDecoder.ts";

class Source implements PacketSource {
  readonly #listeners = new Set<(bytes: Uint8Array) => void>();
  onPacket(l: (bytes: Uint8Array) => void) {
    this.#listeners.add(l);
    return () => void this.#listeners.delete(l);
  }
  emit(bytes: Uint8Array) {
    for (const l of this.#listeners) l(bytes);
  }
}

function setup(countFrom: "first" | "repair") {
  const bundle = new Uint8Array(40 * 117).map((_, i) => i * 7);
  const encoder = new Encoder(bundle, 9, QR_PACKET_BYTES);
  const source = new Source();
  const decoder = packetDecoder(source, { name: "t", countFrom });
  const heard: TransferHeard[] = [];
  decoder.onHeard((h) => heard.push(h));
  const send = (id: number, type = PacketType.Data) =>
    source.emit(encodePacket(encoder.symbol(id, type)));
  return { encoder, source, decoder, heard, send };
}

Deno.test("a late start measures its share from just below the first id seen", () => {
  const { decoder, send } = setup("first");
  // Starts looking at id 20, then misses 25 and 27.
  for (const id of [20, 21, 22, 23, 24, 26, 28, 29]) send(id);
  const first = decoder.ack(9, 12)!;
  assertEquals(first.highest, 29);
  assertEquals(first.heard, 8);
  assertEquals(first.share, 8 / 10);
  // The next share counts from this ack.
  for (const id of [30, 32]) send(id);
  assertEquals(decoder.ack(9, 12)!.share, 2 / 3);
  assertEquals(decoder.ack(9, 12)!.share, undefined);
});

Deno.test("no runs before a repair symbol; runs after one", () => {
  const { encoder, decoder, send } = setup("first");
  for (let id = 0; id < encoder.k; id += 2) send(id);
  const before = decoder.ack(9, 12)!;
  assertEquals(before.k, encoder.k);
  assertEquals(before.runs, []);
  send(encoder.k + 1);
  assert(decoder.ack(9, 12)!.runs.length > 0);
});

Deno.test("repeats are not fresh; acks and DONE are not heard; repair counting starts at k", () => {
  const { encoder, source, decoder, heard, send } = setup("repair");
  send(0);
  send(0);
  send(1, PacketType.DataListen);
  source.emit(encodePacket(encoder.symbol(2, PacketType.Ack)));
  source.emit(encodePacket(encoder.symbol(3, PacketType.Done)));
  source.emit(new Uint8Array(10));
  send(encoder.k);
  send(2);
  assertEquals(
    heard.map(({ fresh, counting, listen }) => [fresh, counting, !!listen]),
    [[1, false, false], [0, false, false], [1, false, true], [1, true, false], [
      1,
      true,
      false,
    ]],
  );
  assertEquals(decoder.stats, { heard: 7, fresh: 4, rejected: 1 });
  assertEquals(decoder.status().map((t) => t.transferId), [9]);
});

Deno.test("completion carries the completing unit's report, which onHeard does not get", () => {
  const { encoder, decoder, heard, send } = setup("first");
  const units: (TransferHeard | undefined)[] = [];
  decoder.onComplete((_, __, unit) => units.push(unit));
  for (let id = 0; id < encoder.k - 1; id++) send(id);
  send(encoder.k - 1, PacketType.DataListen);
  assertEquals(units, [{
    transferId: 9,
    fresh: 1,
    counting: true,
    listen: true,
  }]);
  assertEquals(heard.length, encoder.k - 1);
});

import { assertEquals, assertNotEquals } from "@std/assert";
import {
  evictions,
  hashBytes,
  LIBRARY_CAP,
  type LibraryEvent,
  type LibraryItem,
  merge,
  title,
} from "./library.ts";

const enc = new TextEncoder();
const ev = (at: number, direction: LibraryEvent["direction"] = "sent") => ({
  direction,
  at,
  via: "qr" as const,
  ms: 100,
});

Deno.test("hashBytes is lowercase hex SHA-256", async () => {
  assertEquals(
    await hashBytes(enc.encode("abc")),
    "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
  );
});

Deno.test("same bytes sent five times give one item with five events", async () => {
  const bytes = enc.encode("hello");
  const hash = await hashBytes(bytes);
  let item: LibraryItem | undefined;
  for (let i = 0; i < 5; i++) {
    item = merge(
      item,
      { hash, name: "a.txt", type: "text/plain", bytes },
      ev(i),
    );
  }
  assertEquals(item!.events.length, 5);
  assertEquals(item!.size, 5);
  assertEquals(item!.last, 4);
});

Deno.test("received then sent is one item, events oldest first, existing untouched", () => {
  const bytes = enc.encode("x");
  const asset = { hash: "h", name: "old", type: "text/plain", bytes };
  const a = merge(undefined, asset, ev(20, "received"));
  const b = merge(a, { ...asset, name: "new" }, ev(10));
  assertEquals(a.events.length, 1);
  assertEquals(b.name, "new");
  assertEquals(b.events.map((e) => e.at), [10, 20]);
  assertEquals(b.last, 20);
  assertEquals(b.blob, a.blob);
});

Deno.test("a reused blob keeps its type, only the name updates", () => {
  const bytes = enc.encode("x");
  const a = merge(
    undefined,
    { hash: "h", name: "a.txt", type: "text/plain", bytes },
    ev(1),
  );
  const b = merge(
    a,
    { hash: "h", name: "b.bin", type: "application/octet-stream", bytes },
    ev(2),
  );
  assertEquals(b.name, "b.bin");
  assertEquals(b.type, "text/plain");
  assertEquals(b.blob.type, "text/plain");
});

Deno.test("evictions drop oldest first, never keep, stop under cap", () => {
  const items = [
    { hash: "a", size: 10, last: 1 },
    { hash: "b", size: 10, last: 2 },
    { hash: "c", size: 10, last: 3 },
  ];
  assertEquals(evictions(items, "z", 30), []);
  assertEquals(evictions(items, "z", 15), ["a", "b"]);
  assertEquals(evictions(items, "a", 15), ["b", "c"]);
  assertNotEquals(LIBRARY_CAP, 0);
});

Deno.test("title: text first line, vCard FN, file name", () => {
  assertEquals(
    title("n.txt", "text/plain", enc.encode("\n  hi there \nmore")),
    "hi there",
  );
  const v = enc.encode(
    "BEGIN:VCARD\r\nVERSION:3.0\r\nFN:Ada Lovelace\r\nEND:VCARD",
  );
  assertEquals(title("c.vcf", "text/vcard", v), "Ada Lovelace");
  assertEquals(title("c.vcf", "application/octet-stream", v), "Ada Lovelace");
  assertEquals(title("pic.png", "image/png", new Uint8Array([1])), "pic.png");
});

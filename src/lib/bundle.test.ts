import { assertEquals, assertRejects } from "@std/assert";
import { BundleError, decodeBundle, encodeBundle, Item } from "./bundle.ts";

function seededRandom(seed: number) {
  let s = seed;
  return () => (s = (s * 1103515245 + 12345) % 2147483648) / 2147483648;
}

function randomBytes(random: () => number, length: number): Uint8Array {
  const bytes = new Uint8Array(length);
  for (let i = 0; i < bytes.length; i++) bytes[i] = Math.floor(random() * 256);
  return bytes;
}

const VCARD = new TextEncoder().encode(
  "BEGIN:VCARD\nVERSION:3.0\nFN:Jake Avery\nEND:VCARD\n",
);

async function buildRawBundle(
  manifest: unknown,
  itemBytes: Uint8Array,
): Promise<Uint8Array> {
  const manifestBytes = new TextEncoder().encode(JSON.stringify(manifest));
  const inner = new Uint8Array(4 + manifestBytes.length + itemBytes.length);
  new DataView(inner.buffer).setUint32(0, manifestBytes.length);
  inner.set(manifestBytes, 4);
  inner.set(itemBytes, 4 + manifestBytes.length);

  const compressedStream = new Blob([inner as Uint8Array<ArrayBuffer>])
    .stream().pipeThrough(new CompressionStream("deflate-raw"));
  const compressed = new Uint8Array(
    await new Response(compressedStream).arrayBuffer(),
  );
  const hash = new Uint8Array(
    await crypto.subtle.digest(
      "SHA-256",
      compressed as Uint8Array<ArrayBuffer>,
    ),
  ).slice(0, 8);

  const out = new Uint8Array(4 + compressed.length + hash.length);
  new DataView(out.buffer).setUint32(0, compressed.length + hash.length);
  out.set(compressed, 4);
  out.set(hash, 4 + compressed.length);
  return out;
}

Deno.test("an empty item list round trips", async () => {
  const items: Item[] = [];
  const bytes = await encodeBundle(items);
  assertEquals(await decodeBundle(bytes), items);
});

Deno.test("a vcard item round trips", async () => {
  const items: Item[] = [
    { name: "jake.vcf", type: "text/vcard", bytes: VCARD },
  ];
  const bytes = await encodeBundle(items);
  assertEquals(await decodeBundle(bytes), items);
});

Deno.test("a 1 MB random file round trips", async () => {
  const random = seededRandom(1);
  const items: Item[] = [
    {
      name: "photo.bin",
      type: "application/octet-stream",
      bytes: randomBytes(random, 1024 * 1024),
    },
  ];
  const bytes = await encodeBundle(items);
  assertEquals(await decodeBundle(bytes), items);
});

Deno.test("several items round trip", async () => {
  const random = seededRandom(2);
  const items: Item[] = [
    { name: "jake.vcf", type: "text/vcard", bytes: VCARD },
    {
      name: "note.txt",
      type: "text/plain",
      bytes: new TextEncoder().encode("hello"),
    },
    {
      name: "data.bin",
      type: "application/octet-stream",
      bytes: randomBytes(random, 4096),
    },
  ];
  const bytes = await encodeBundle(items);
  assertEquals(await decodeBundle(bytes), items);
});

Deno.test("trailing zero padding after length is ignored", async () => {
  const items: Item[] = [
    {
      name: "note.txt",
      type: "text/plain",
      bytes: new TextEncoder().encode("hi"),
    },
  ];
  const bytes = await encodeBundle(items);
  const padded = new Uint8Array(bytes.length + 64);
  padded.set(bytes, 0);
  assertEquals(await decodeBundle(padded), items);
});

Deno.test("a flipped byte fails the hash check", async () => {
  const items: Item[] = [
    { name: "jake.vcf", type: "text/vcard", bytes: VCARD },
  ];
  const bytes = await encodeBundle(items);
  const corrupted = bytes.slice();
  corrupted[8] ^= 0xff;
  await assertRejects(() => decodeBundle(corrupted), BundleError);
});

Deno.test("a bad length throws BundleError", async () => {
  const items: Item[] = [
    { name: "jake.vcf", type: "text/vcard", bytes: VCARD },
  ];
  const bytes = await encodeBundle(items);
  const corrupted = bytes.slice();
  new DataView(corrupted.buffer).setUint32(0, 0xffffffff);
  await assertRejects(() => decodeBundle(corrupted), BundleError);

  await assertRejects(() => decodeBundle(new Uint8Array(2)), BundleError);
});

Deno.test("a manifest size mismatch throws BundleError", async () => {
  const manifest = { items: [{ name: "a", type: "text/plain", size: 999 }] };
  const bytes = await buildRawBundle(manifest, new TextEncoder().encode("hi"));
  await assertRejects(() => decodeBundle(bytes), BundleError);
});

Deno.test("a decompression bomb is rejected", async () => {
  const bomb = new Uint8Array(65 * 1024 * 1024);
  const manifest = {
    items: [{ name: "z", type: "application/octet-stream", size: bomb.length }],
  };
  const bytes = await buildRawBundle(manifest, bomb);
  await assertRejects(() => decodeBundle(bytes), BundleError);
});

Deno.test("a null manifest entry throws BundleError", async () => {
  const bytes = await buildRawBundle({ items: [null] }, new Uint8Array(0));
  await assertRejects(() => decodeBundle(bytes), BundleError);
});

Deno.test("a manifest entry with a non-string name throws BundleError", async () => {
  const manifest = { items: [{ name: 5, type: "text/plain", size: 0 }] };
  const bytes = await buildRawBundle(manifest, new Uint8Array(0));
  await assertRejects(() => decodeBundle(bytes), BundleError);
});

Deno.test("garbage bytes fail decompression as BundleError", async () => {
  const compressed = randomBytes(seededRandom(3), 32);
  const hash = new Uint8Array(
    await crypto.subtle.digest(
      "SHA-256",
      compressed as Uint8Array<ArrayBuffer>,
    ),
  ).slice(0, 8);
  const out = new Uint8Array(4 + compressed.length + hash.length);
  new DataView(out.buffer).setUint32(0, compressed.length + hash.length);
  out.set(compressed, 4);
  out.set(hash, 4 + compressed.length);
  await assertRejects(() => decodeBundle(out), BundleError);
});

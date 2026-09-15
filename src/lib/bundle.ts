// Bundle wire format: u32 length | deflate-raw(u32 manifestLength | manifest
// JSON | item bytes...) | sha256[0..8]. `length` counts the compressed bytes
// plus the hash, so a fountain decoder's zero padding past it is ignored.
import { MAX_INFLATED_BYTES } from "./protocol.ts";

export interface Item {
  name: string;
  type: string;
  bytes: Uint8Array;
}

interface Manifest {
  items: { name: string; type: string; size: number }[];
}

export class BundleError extends Error {
  override readonly name = "BundleError";
}

const LENGTH_BYTES = 4;
const HASH_BYTES = 8;

function writeU32BE(value: number): Uint8Array {
  const out = new Uint8Array(LENGTH_BYTES);
  new DataView(out.buffer).setUint32(0, value);
  return out;
}

function readU32BE(bytes: Uint8Array, offset: number): number {
  return new DataView(bytes.buffer, bytes.byteOffset + offset, LENGTH_BYTES)
    .getUint32(0);
}

function asArrayBuffer(bytes: Uint8Array): Uint8Array<ArrayBuffer> {
  return bytes as Uint8Array<ArrayBuffer>;
}

async function deflateRaw(bytes: Uint8Array): Promise<Uint8Array> {
  const stream = new Blob([asArrayBuffer(bytes)]).stream().pipeThrough(
    new CompressionStream("deflate-raw"),
  );
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

async function inflateRaw(bytes: Uint8Array): Promise<Uint8Array> {
  const stream = new Blob([asArrayBuffer(bytes)]).stream().pipeThrough(
    new DecompressionStream("deflate-raw"),
  );
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.length;
    if (total > MAX_INFLATED_BYTES) {
      await reader.cancel();
      throw new BundleError(
        `bundle inflates past ${MAX_INFLATED_BYTES} bytes`,
      );
    }
    chunks.push(value);
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.length;
  }
  return out;
}

async function sha256Prefix(bytes: Uint8Array): Promise<Uint8Array> {
  const digest = await crypto.subtle.digest("SHA-256", asArrayBuffer(bytes));
  return new Uint8Array(digest).slice(0, HASH_BYTES);
}

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

export async function encodeBundle(items: Item[]): Promise<Uint8Array> {
  const manifest: Manifest = {
    items: items.map((item) => ({
      name: item.name,
      type: item.type,
      size: item.bytes.length,
    })),
  };
  const manifestBytes = new TextEncoder().encode(JSON.stringify(manifest));
  const totalItemBytes = items.reduce((n, item) => n + item.bytes.length, 0);

  const inner = new Uint8Array(
    LENGTH_BYTES + manifestBytes.length + totalItemBytes,
  );
  inner.set(writeU32BE(manifestBytes.length), 0);
  inner.set(manifestBytes, LENGTH_BYTES);
  let offset = LENGTH_BYTES + manifestBytes.length;
  for (const item of items) {
    inner.set(item.bytes, offset);
    offset += item.bytes.length;
  }

  const compressed = await deflateRaw(inner);
  const hash = await sha256Prefix(compressed);

  const out = new Uint8Array(LENGTH_BYTES + compressed.length + hash.length);
  out.set(writeU32BE(compressed.length + hash.length), 0);
  out.set(compressed, LENGTH_BYTES);
  out.set(hash, LENGTH_BYTES + compressed.length);
  return out;
}

export async function decodeBundle(bytes: Uint8Array): Promise<Item[]> {
  if (bytes.length < LENGTH_BYTES) {
    throw new BundleError(`bundle too short: ${bytes.length} bytes`);
  }
  const length = readU32BE(bytes, 0);
  if (length < HASH_BYTES || bytes.length < LENGTH_BYTES + length) {
    throw new BundleError(
      `bad length ${length} for a ${bytes.length} byte bundle`,
    );
  }

  const compressed = bytes.subarray(
    LENGTH_BYTES,
    LENGTH_BYTES + length - HASH_BYTES,
  );
  const hash = bytes.subarray(
    LENGTH_BYTES + length - HASH_BYTES,
    LENGTH_BYTES + length,
  );
  if (!bytesEqual(await sha256Prefix(compressed), hash)) {
    throw new BundleError("bundle hash mismatch");
  }

  let inner: Uint8Array;
  try {
    inner = await inflateRaw(compressed);
  } catch (cause) {
    throw new BundleError("failed to decompress bundle", { cause });
  }

  if (inner.length < LENGTH_BYTES) {
    throw new BundleError("bundle manifest missing");
  }
  const manifestLength = readU32BE(inner, 0);
  if (inner.length < LENGTH_BYTES + manifestLength) {
    throw new BundleError("bad manifest length");
  }
  const manifestBytes = inner.subarray(
    LENGTH_BYTES,
    LENGTH_BYTES + manifestLength,
  );

  let manifest: Manifest;
  try {
    manifest = JSON.parse(new TextDecoder().decode(manifestBytes)) as Manifest;
  } catch (cause) {
    throw new BundleError("failed to parse bundle manifest", { cause });
  }
  if (!manifest || !Array.isArray(manifest.items)) {
    throw new BundleError("malformed bundle manifest");
  }

  const items: Item[] = [];
  let offset = LENGTH_BYTES + manifestLength;
  for (const meta of manifest.items) {
    if (
      typeof meta !== "object" || meta === null ||
      typeof meta.name !== "string" || typeof meta.type !== "string" ||
      !Number.isInteger(meta.size) || meta.size < 0
    ) {
      throw new BundleError("malformed bundle manifest entry");
    }
    const end = offset + meta.size;
    if (end > inner.length) {
      throw new BundleError(`item "${meta.name}" size mismatch`);
    }
    items.push({
      name: meta.name,
      type: meta.type,
      bytes: inner.slice(offset, end),
    });
    offset = end;
  }
  if (offset !== inner.length) {
    throw new BundleError("bundle has trailing item bytes");
  }

  return items;
}

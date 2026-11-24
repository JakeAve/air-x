// Pure logic for the on-device library: dedupe by content hash, event history,
// eviction under a byte cap, and a display title. Storage lives elsewhere.

export type LibraryEvent = {
  direction: "sent" | "received";
  at: number;
  via: "sound" | "qr";
  ms: number;
};

export type LibraryItem = {
  hash: string;
  name: string;
  type: string;
  size: number;
  blob: Blob;
  events: LibraryEvent[];
  last: number;
};

export const LIBRARY_CAP = 250 * 1024 * 1024;

export async function hashBytes(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    bytes as Uint8Array<ArrayBuffer>,
  );
  return [...new Uint8Array(digest)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

export function merge(
  existing: LibraryItem | undefined,
  asset: { hash: string; name: string; type: string; bytes: Uint8Array },
  event: LibraryEvent,
): LibraryItem {
  const events = [...(existing?.events ?? []), event].sort((a, b) =>
    a.at - b.at
  );
  return {
    hash: asset.hash,
    name: asset.name,
    // A reused blob keeps its MIME, so the type must match it.
    type: existing?.type ?? asset.type,
    size: existing?.size ?? asset.bytes.length,
    blob: existing?.blob ??
      new Blob([asset.bytes as Uint8Array<ArrayBuffer>], { type: asset.type }),
    events,
    last: events[events.length - 1].at,
  };
}

export function evictions(
  items: Pick<LibraryItem, "hash" | "size" | "last">[],
  keep: string,
  cap = LIBRARY_CAP,
): string[] {
  let total = items.reduce((sum, i) => sum + i.size, 0);
  const out: string[] = [];
  for (const i of [...items].sort((a, b) => a.last - b.last)) {
    if (total <= cap) break;
    if (i.hash === keep) continue;
    out.push(i.hash);
    total -= i.size;
  }
  return out;
}

export function title(name: string, type: string, bytes: Uint8Array): string {
  const vcard = type === "text/vcard" || type === "text/x-vcard" ||
    name.toLowerCase().endsWith(".vcf");
  if (!vcard && !type.startsWith("text/")) return name;
  const text = new TextDecoder().decode(bytes);
  if (vcard) {
    const fn = text.match(/^FN[^:\r\n]*:(.*)$/mi)?.[1].trim();
    return fn || name;
  }
  return text.split(/\r?\n/).map((l) => l.trim()).find(Boolean) ?? name;
}

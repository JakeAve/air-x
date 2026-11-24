import {
  evictions,
  hashBytes,
  LIBRARY_CAP,
  type LibraryEvent,
  type LibraryItem,
  merge,
} from "@/lib/library.ts";

const STORE = "items";

let db: Promise<IDBDatabase> | undefined;

function open(): Promise<IDBDatabase> {
  return db ??= new Promise((resolve, reject) => {
    const req = indexedDB.open("air-x", 1);
    req.onupgradeneeded = () => {
      req.result.createObjectStore(STORE, { keyPath: "hash" })
        .createIndex("last", "last");
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => {
      db = undefined;
      reject(req.error);
    };
  });
}

function wrap<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function done(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });
}

async function store(mode: IDBTransactionMode) {
  const tx = (await open()).transaction(STORE, mode);
  return { tx, items: tx.objectStore(STORE) };
}

let persisted = false;

/** Saves each item (deduped by content hash) and evicts the oldest over the cap. */
export async function record(
  items: { name: string; type: string; bytes: Uint8Array }[],
  event: LibraryEvent,
): Promise<void> {
  // Hash first: a transaction auto-commits across awaits on non-IDB promises.
  const assets = await Promise.all(
    items.map(async (i) => ({ ...i, hash: await hashBytes(i.bytes) })),
  );
  const { tx, items: os } = await store("readwrite");
  const finished = done(tx);
  const saved = new Map<string, number>();
  for (const asset of assets) {
    const merged = merge(await wrap(os.get(asset.hash)), asset, event);
    saved.set(merged.hash, merged.size);
    os.put(merged);
  }
  const all = (await wrap(os.getAll())) as LibraryItem[];
  const mine = [...saved.values()].reduce((a, b) => a + b, 0);
  const others = all.filter((i) => !saved.has(i.hash));
  for (const hash of evictions(others, "", LIBRARY_CAP - mine)) {
    os.delete(hash);
  }
  await finished;
  if (!persisted) {
    persisted = true;
    console.log("library: persist", await navigator.storage?.persist?.());
  }
}

export async function listItems(): Promise<LibraryItem[]> {
  const { items } = await store("readonly");
  const all = (await wrap(items.getAll())) as LibraryItem[];
  return all.sort((a, b) => b.last - a.last);
}

export async function getItem(hash: string): Promise<LibraryItem | undefined> {
  const { items } = await store("readonly");
  return await wrap(items.get(hash));
}

export async function removeItem(
  hash: string,
): Promise<LibraryItem | undefined> {
  const { tx, items } = await store("readwrite");
  const finished = done(tx);
  const item = (await wrap(items.get(hash))) as LibraryItem | undefined;
  items.delete(hash);
  await finished;
  return item;
}

export async function putItem(item: LibraryItem): Promise<void> {
  const { tx, items } = await store("readwrite");
  items.put(item);
  await done(tx);
}

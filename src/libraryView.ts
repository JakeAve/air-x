// The library screens: the home tile's newest title, the #library list, and the
// #library/<hash> item screen. Records come from adapters/library.ts.
import { copyBlob, openType } from "@/adapters/clipboard.ts";
import { getItem, listItems, putItem, removeItem } from "@/adapters/library.ts";
import { type LibraryEvent, type LibraryItem, title } from "@/lib/library.ts";

export function size(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

export function seconds(ms: number): string {
  return `${(ms / 1000).toFixed(1)} s`;
}

function $<T extends HTMLElement>(id: string): T {
  return document.getElementById(id) as T;
}

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className?: string,
  text?: string,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

const SVG = (d: string) =>
  `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="${d}"/></svg>`;
const ARROW = {
  sent: "M4 12h14M13 6l6 6-6 6",
  received: "M12 4v14M6 13l6 6 6-6",
};
const FILE_ICON = "M6 3h8l4 4v14H6zM14 3v4h4";
const COPY = "M8 8h12v12H8zM16 8V4H4v12h4";
const COPIED = "M5 12l5 5 9-10";
const COPY_FAILED = "M6 6l12 12M18 6L6 18";

let urls: string[] = [];
let held: LibraryItem | undefined;
let keepHeld = false;
let generation = 0;

function objectUrl(blob: Blob) {
  const url = URL.createObjectURL(blob);
  urls.push(url);
  return url;
}

function revoke() {
  for (const url of urls) URL.revokeObjectURL(url);
  urls = [];
}

/** Every screen change: drop this view's object URLs, stale renders, and the
 * held item, except across the hop from a delete to the list. */
export function leaveLibrary() {
  generation++;
  revoke();
  if (!keepHeld) held = undefined;
  keepHeld = false;
}

const isVcard = (item: LibraryItem) =>
  /vcard/.test(item.type) || /\.vcf$/i.test(item.name);
const isText = (item: LibraryItem) =>
  item.type.startsWith("text/") || isVcard(item);

// ponytail: a title and the row's first words come from the first 4 KB, not the whole text.
const PEEK_BYTES = 4096;

const PREVIEW_BYTES = 64 * 1024;

async function peek(item: LibraryItem): Promise<Uint8Array> {
  return isText(item)
    ? new Uint8Array(await item.blob.slice(0, PEEK_BYTES).arrayBuffer())
    : new Uint8Array();
}

const itemTitle = (item: LibraryItem, bytes: Uint8Array) =>
  title(item.name, item.type, bytes);

function startOfDay(at: number) {
  const d = new Date(at);
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
}

function date(at: number) {
  const d = new Date(at);
  return d.toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: d.getFullYear() === new Date().getFullYear() ? undefined : "numeric",
  });
}

function time(at: number) {
  return new Date(at).toLocaleTimeString("en-US", {
    hour: "numeric",
    minute: "2-digit",
  }).toLowerCase();
}

function day(at: number) {
  const days = Math.round((startOfDay(Date.now()) - startOfDay(at)) / 864e5);
  return days === 0 ? "Today" : days === 1 ? "Yesterday" : date(at);
}

const VIA: Record<LibraryEvent["via"], string> = {
  sound: "Sound",
  qr: "QR code",
  cimbar: "Cimbar",
};
const verb = (e: LibraryEvent) => e.direction === "sent" ? "Sent" : "Received";

function initials(name: string) {
  return name.split(/\s+/).filter(Boolean).slice(0, 2)
    .map((w) => [...w][0].toUpperCase()).join("");
}

function shortType(item: LibraryItem) {
  if (isVcard(item)) return "Contact";
  if (item.type.startsWith("text/plain")) return "Text";
  const ext = item.name.match(/\.([a-z0-9]{1,8})$/i)?.[1];
  return (ext ?? item.type.split("/").pop() ?? "File").toUpperCase();
}

export async function renderHomeTile(): Promise<void> {
  const gen = generation;
  const [newest] = await listItems();
  const bytes = newest && await peek(newest);
  if (gen !== generation) return;
  const latest = $("home-latest");
  latest.textContent = newest ? itemTitle(newest, bytes!) : "";
  latest.hidden = !newest;
}

function thumb(item: LibraryItem, bytes: Uint8Array, name: string) {
  const box = el("span", "thumb");
  if (item.type.startsWith("image/")) {
    const img = el("img");
    img.src = objectUrl(item.blob);
    img.alt = "";
    box.append(img);
  } else if (isVcard(item)) {
    box.append(el("span", "initials", initials(name)));
  } else if (isText(item)) {
    box.append(
      el("span", "words", new TextDecoder().decode(bytes).slice(0, 120)),
    );
  } else {
    box.innerHTML = SVG(FILE_ICON);
  }
  return box;
}

function row(item: LibraryItem, bytes: Uint8Array) {
  const name = itemTitle(item, bytes);
  const latest = item.events[item.events.length - 1];
  const a = el("a", "entry bare");
  a.href = `#library/${item.hash}`;
  const text = el("span", "entry-text");
  const when = el("span", "when");
  when.innerHTML = SVG(ARROW[latest.direction]);
  when.append(
    `${verb(latest)} ${
      day(latest.at) === "Today" ? time(latest.at) : date(latest.at)
    }`,
  );
  text.append(el("span", "name", name), when);
  a.append(thumb(item, bytes, name), text);
  return a;
}

export async function renderLibrary(): Promise<void> {
  const gen = generation;
  const items = await listItems();
  const peeks = await Promise.all(items.map(peek));
  if (gen !== generation) return;
  revoke();
  $("library-undo").hidden = !held;
  const groups = new Map<string, HTMLLIElement[]>();
  items.forEach((item, i) => {
    const key = day(item.last);
    const li = el("li");
    li.append(row(item, peeks[i]));
    groups.set(key, [...groups.get(key) ?? [], li]);
  });
  $("library-list").replaceChildren(
    ...[...groups].map(([key, rows]) => {
      const group = el("div", "stack");
      const ul = el("ul", "entries");
      ul.append(...rows);
      group.append(el("h2", "day", key), ul);
      return group;
    }),
  );
  const total = items.reduce((sum, i) => sum + i.size, 0);
  $("library-list").hidden = $("library-count").hidden = !items.length;
  $("library-empty").hidden = !!items.length;
  $("library-count").textContent = `${items.length} ${
    items.length === 1 ? "item" : "items"
  } · ${size(total)} on this device`;
}

$("library-undo-button").addEventListener("click", async () => {
  const item = held;
  held = undefined;
  // ponytail: an undo can briefly overshoot LIBRARY_CAP; the next save evicts.
  if (item) await putItem(item);
  await renderLibrary();
});

// An opener on a blob URL, typed by openType so markup and SVG open as text.
function opener(item: LibraryItem, child: HTMLElement) {
  const type = openType(item.type);
  if (!type) return child;
  const a = el("a", "bare");
  a.href = objectUrl(new Blob([item.blob], { type }));
  a.target = "_blank";
  a.rel = "noopener";
  a.append(child);
  return a;
}

const FIELDS: Record<string, string> = {
  TEL: "Phone",
  EMAIL: "Email",
  ADR: "Address",
  ORG: "Organization",
  TITLE: "Title",
  URL: "Website",
  BDAY: "Birthday",
  NOTE: "Note",
};

const unescape = (s: string) =>
  s.replace(/\\n/gi, "\n").replace(/\\([,;\\])/g, "$1").trim();

function facts(rows: [string, string][]) {
  const dl = el("dl", "facts");
  for (const [label, value] of rows) {
    dl.append(el("dt", "", label), el("dd", "", value));
  }
  return dl;
}

function contact(name: string, text: string) {
  const rows: [string, string][] = [];
  // Unfold continuation lines, then keep the fields a person reads.
  for (const line of text.replace(/\r?\n[ \t]/g, "").split(/\r?\n/)) {
    const m = line.match(/^(?:[^.:;]+\.)?([a-z-]+)[^:]*:(.*)$/i);
    const label = m && FIELDS[m[1].toUpperCase()];
    if (!label) continue;
    const value = m[2].split(/(?<!\\);/).map(unescape).filter(Boolean)
      .join(", ");
    if (value) rows.push([label, value]);
  }
  const div = el("div", "stack");
  div.append(el("h2", "", name), facts(rows));
  return div;
}

function preview(item: LibraryItem, text: string): HTMLElement {
  const type = item.type;
  if (isVcard(item)) {
    return contact(itemTitle(item, new TextEncoder().encode(text)), text);
  }
  if (type.startsWith("text/")) return el("pre", "", text);
  if (type.startsWith("image/")) {
    const img = el("img");
    img.src = objectUrl(item.blob);
    img.alt = item.name;
    return opener(item, img);
  }
  if (/^(video|audio)\//.test(type)) {
    const player = el(type.startsWith("video/") ? "video" : "audio");
    player.src = objectUrl(item.blob);
    player.controls = true;
    player.preload = "metadata";
    player.setAttribute("playsinline", "");
    return player;
  }
  const file = el("div", "file");
  file.innerHTML = SVG(FILE_ICON);
  file.append(el("span", "", item.name));
  return opener(item, file);
}

function eventRow(e: LibraryEvent): [string, string] {
  return [
    verb(e),
    `${day(e.at)}, ${time(e.at)} · ${VIA[e.via]} · ${seconds(e.ms)}`,
  ];
}

export async function renderItemScreen(hash: string): Promise<void> {
  const gen = generation;
  const item = await getItem(hash);
  const text = item && isText(item)
    ? await item.blob.slice(0, PREVIEW_BYTES).text()
    : "";
  if (gen !== generation) return;
  if (!item) {
    location.replace("#library");
    return;
  }
  revoke();
  $("item-preview").replaceChildren(preview(item, text));
  if (isText(item) && item.size > PREVIEW_BYTES) {
    $("item-preview").append(el("p", "muted", "Showing the first 64 KB"));
  }

  const events = [...item.events].reverse().map(eventRow);
  const meta: HTMLElement[] = [facts(events.slice(0, 3))];
  if (events.length > 3) {
    const more = el("details");
    more.append(
      el("summary", "", `${events.length - 3} more`),
      facts(events.slice(3)),
    );
    meta.push(more);
  }
  meta.push(facts([["Type", `${shortType(item)} · ${size(item.size)}`]]));
  $("item-facts").replaceChildren(...meta);

  const file = new File([item.blob], item.name, { type: item.type });
  const copy = $<HTMLButtonElement>("item-copy");
  const copyPath = copy.querySelector("path")!;
  copy.hidden = !/^(text|image)\//.test(item.type);
  copy.onclick = () => {
    const flash = (d: string) => {
      copyPath.setAttribute("d", d);
      setTimeout(() => copyPath.setAttribute("d", COPY), 2000);
    };
    copyBlob(item.blob).then(() => flash(COPIED), (err) => {
      console.error("copy failed", err);
      flash(COPY_FAILED);
    });
  };
  const share = $<HTMLButtonElement>("item-share");
  share.hidden = !navigator.canShare?.({ files: [file] });
  share.onclick = () =>
    navigator.share({ files: [file] }).catch((err) => {
      if (err?.name !== "AbortError") console.error("share failed", err);
    });
  const save = $<HTMLAnchorElement>("item-save");
  save.href = objectUrl(item.blob);
  save.download = item.name;
  $<HTMLButtonElement>("item-delete").onclick = async () => {
    try {
      held = await removeItem(hash);
    } catch (err) {
      console.error("library: delete failed", err);
      return;
    }
    keepHeld = true;
    location.hash = "#library";
  };
}

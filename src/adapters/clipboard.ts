// The clipboard takes text, and images only as PNG, so other images are redrawn as PNG.
// iOS only allows the write inside the tap, so call this synchronously from the
// handler: the content goes in as a promise.
export function copyBlob(blob: Blob): Promise<void> {
  return navigator.clipboard.write([
    new ClipboardItem(
      blob.type.startsWith("text/")
        ? { "text/plain": blob.text() }
        : { "image/png": png(blob) },
    ),
  ]);
}

async function png(blob: Blob) {
  if (blob.type === "image/png") return blob;
  const bitmap = await createImageBitmap(blob);
  const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
  canvas.getContext("2d")!.drawImage(bitmap, 0, 0);
  return canvas.convertToBlob();
}

// A blob URL opens with this page's origin, so the sender's markup or SVG opens
// as plain text, never as a page that could run script here.
export function openType(type: string) {
  if (/^(image\/(?!svg)|video\/|audio\/)|^application\/pdf$/.test(type)) {
    return type;
  }
  if (/^text\/|svg|xml|json/.test(type)) return "text/plain;charset=utf-8";
}

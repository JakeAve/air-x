// The qr package speaks strings; these hooks map each byte to one char so
// arbitrary bytes travel in QR byte mode without UTF-8 expansion.

export function bytesToText(bytes: Uint8Array): string {
  let text = "";
  for (let i = 0; i < bytes.length; i += 8192) {
    text += String.fromCharCode(...bytes.subarray(i, i + 8192));
  }
  return text;
}

export function textToBytes(text: string): Uint8Array {
  return Uint8Array.from(text, (c) => c.charCodeAt(0));
}

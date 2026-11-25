/**
 * NV12 (a full Y plane, then interleaved U and V at half size) to RGBA,
 * shrunk by a whole factor until the longer edge fits `maxEdge`; every k-th
 * pixel, no filtering. BT.601 full range. Built for cimbar: on real iPhone
 * frames its NV12 input missed codes that the same pixels as RGBA read, and
 * at 4K its corner finder misses what it reads at half size.
 */
export function nv12ToRgba(
  src: Uint8Array,
  width: number,
  height: number,
  maxEdge: number,
): { pixels: Uint8Array; width: number; height: number } {
  const k = Math.max(1, Math.ceil(Math.max(width, height) / maxEdge));
  const w = Math.floor(width / k);
  const h = Math.floor(height / k);
  const out = new Uint8ClampedArray(w * h * 4); // clamps the conversion for free
  const uvBase = width * height;
  let i = 0;
  for (let y = 0; y < h; y++) {
    const sy = y * k;
    const yRow = sy * width;
    const uvRow = uvBase + (sy >> 1) * width;
    for (let x = 0; x < w; x++) {
      const sx = x * k;
      const luma = src[yRow + sx];
      const uv = uvRow + (sx & ~1);
      const u = src[uv] - 128;
      const v = src[uv + 1] - 128;
      out[i++] = luma + ((359 * v) >> 8); // 1.402 V
      out[i++] = luma - ((88 * u + 183 * v) >> 8); // 0.344 U + 0.714 V
      out[i++] = luma + ((454 * u) >> 8); // 1.772 U
      out[i++] = 255;
    }
  }
  return { pixels: new Uint8Array(out.buffer), width: w, height: h };
}

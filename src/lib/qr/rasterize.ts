import type { QrMatrix } from "./qrEncoder.ts";
import type { RgbaImage } from "./qrDecoder.ts";

export const QR_COLORS = { module: "#000000", background: "#ffffff" };

function rgb(hex: string): [number, number, number] {
  const n = parseInt(hex.slice(1), 16);
  return [(n >> 16) & 0xff, (n >> 8) & 0xff, n & 0xff];
}

/** Draws a matrix as RGBA pixels in `QR_COLORS` with a quiet zone. */
export function rasterize(
  matrix: QrMatrix,
  scale = 4,
  quietModules = 4,
): RgbaImage {
  const modules = matrix.length;
  const size = (modules + quietModules * 2) * scale;
  const module = rgb(QR_COLORS.module);
  const background = rgb(QR_COLORS.background);
  const data = new Uint8ClampedArray(size * size * 4);
  for (let i = 0; i < data.length; i += 4) {
    data.set(background, i);
    data[i + 3] = 255;
  }
  for (let y = 0; y < modules; y++) {
    for (let x = 0; x < modules; x++) {
      if (!matrix[y][x]) continue;
      for (let dy = 0; dy < scale; dy++) {
        const row = ((y + quietModules) * scale + dy) * size;
        for (let dx = 0; dx < scale; dx++) {
          data.set(module, (row + (x + quietModules) * scale + dx) * 4);
        }
      }
    }
  }
  return { width: size, height: size, data };
}

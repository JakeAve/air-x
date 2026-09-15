import type { QrMatrix } from "@/lib/qr/qrEncoder.ts";
import { QR_COLORS } from "@/lib/qr/rasterize.ts";

const QUIET_MODULES = 4;
const MODULE_PX = 8;

/** Draws whole-pixel modules with a quiet zone; CSS scales the canvas to fit. */
export function drawQr(matrix: QrMatrix, canvas: HTMLCanvasElement): void {
  const modules = matrix.length;
  const size = (modules + QUIET_MODULES * 2) * MODULE_PX;
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("canvas 2d context unavailable");
  ctx.imageSmoothingEnabled = false;
  ctx.fillStyle = QR_COLORS.background;
  ctx.fillRect(0, 0, size, size);
  ctx.fillStyle = QR_COLORS.module;
  for (let y = 0; y < modules; y++) {
    for (let x = 0; x < modules; x++) {
      if (!matrix[y][x]) continue;
      ctx.fillRect(
        (x + QUIET_MODULES) * MODULE_PX,
        (y + QUIET_MODULES) * MODULE_PX,
        MODULE_PX,
        MODULE_PX,
      );
    }
  }
}

export function clearCanvas(canvas: HTMLCanvasElement): void {
  canvas.getContext("2d")?.clearRect(0, 0, canvas.width, canvas.height);
}

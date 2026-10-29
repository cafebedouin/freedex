// A QR code on a canvas, from the pinned `qrcode-generator` (no dependencies, no network). Error correction L is the
// level that carries the most: 2,953 bytes at version 40, which is where EIP-20's 2,900-character figure comes from.
// Drawn on white whatever the page's colour scheme, so a phone camera reads it.
import qrcode from "qrcode-generator";

export function drawQr(canvas: HTMLCanvasElement, text: string, maxPx = 420): boolean {
  const qr = qrcode(0, "L");
  qr.addData(text, "Byte");
  qr.make();
  const n = qr.getModuleCount();
  const quiet = 4;
  const cell = Math.max(2, Math.floor(maxPx / (n + 2 * quiet)));
  const size = cell * (n + 2 * quiet);
  canvas.width = size;
  canvas.height = size;
  canvas.title = `${n}×${n} modules`;
  const ctx = typeof canvas.getContext === "function" ? canvas.getContext("2d") : null;
  if (!ctx) return false; // a test DOM without canvas drawing
  ctx.fillStyle = "#fff";
  ctx.fillRect(0, 0, size, size);
  ctx.fillStyle = "#000";
  for (let r = 0; r < n; r++)
    for (let c = 0; c < n; c++) if (qr.isDark(r, c)) ctx.fillRect((c + quiet) * cell, (r + quiet) * cell, cell, cell);
  return true;
}

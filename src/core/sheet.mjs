/* Contact-sheet composer — render sprites side by side on a checkerboard so a
   human (or a vision model) can judge consistency at a glance. The single most
   used tool in our own pipeline: every defect we caught by eye was caught on
   one of these sheets, never in the game itself. */
import { writePng, resizeNearest, crop as cropImg } from "./png.mjs";

/** rows: [{ label, frames: [im, ...] }]
    opts: zoom (default 4), pad, crop {x, y, w, h} applied to every cell,
          background: "checker" | "light" | "dark" */
export function composeSheet(rows, opts = {}) {
  const zoom = opts.zoom ?? 4;
  const pad = opts.pad ?? 4;
  const cols = Math.max(...rows.map((r) => r.frames.length));
  const cellW = (opts.crop?.w ?? Math.max(...rows.flatMap((r) => r.frames.map((f) => f.w))));
  const cellH = (opts.crop?.h ?? Math.max(...rows.flatMap((r) => r.frames.map((f) => f.h))));
  const CW = cellW * zoom + pad, CH = cellH * zoom + pad;
  const W = CW * cols + pad, H = CH * rows.length + pad;
  const sheet = { w: W, h: H, data: Buffer.alloc(W * H * 4) };

  for (let y = 0; y < H; y++)
    for (let x = 0; x < W; x++) {
      const o = (y * W + x) * 4;
      let v;
      if (opts.background === "light") v = 240;
      else if (opts.background === "dark") v = 44;
      else v = ((x >> 4) + (y >> 4)) % 2 ? 214 : 238;
      sheet.data[o] = v; sheet.data[o + 1] = v; sheet.data[o + 2] = v; sheet.data[o + 3] = 255;
    }

  rows.forEach((row, ri) => row.frames.forEach((frame, ci) => {
    let cell = frame;
    if (opts.crop) cell = cropImg(cell, opts.crop.x ?? 0, opts.crop.y ?? 0, cellW, cellH);
    const big = resizeNearest(cell, cell.w * zoom, cell.h * zoom);
    const ox = ci * CW + pad, oy = ri * CH + pad;
    for (let y = 0; y < big.h; y++)
      for (let x = 0; x < big.w; x++) {
        const s = (y * big.w + x) * 4;
        const a = big.data[s + 3];
        if (a < 8) continue;
        const t = ((oy + y) * W + ox + x) * 4;
        const ia = a / 255, ib = 1 - ia;
        for (let c = 0; c < 3; c++) sheet.data[t + c] = Math.round(big.data[s + c] * ia + sheet.data[t + c] * ib);
      }
  }));
  return { image: sheet, png: writePng(sheet), cols, rows: rows.length };
}

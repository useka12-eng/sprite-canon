/* Unified image loading: single PNG, animated GIF, or PNG spritesheet.
   Everything downstream works on a frame list, so tools don't care which
   container the art came in.

   Spritesheet rule: EVERY cell becomes a frame, including fully transparent
   ones. An earlier version skipped empty cells — and then saveFrames repacked
   the survivors from the top-left, silently shifting every later sprite one
   cell forward. Game code indexes sheets by cell position; compacting is
   asset corruption. Empty frames are harmless everywhere else (measure
   returns null for them, repaint is a no-op), so we keep them. */
import fs from "node:fs";
import { readPng, writePng, crop } from "./png.mjs";
import { decodeGif, encodeGif } from "./gif.mjs";

/** Load a file into frames.
    opts.cellW/cellH: slice a PNG spritesheet on a uniform grid, row-major,
    one frame per cell (empty cells included — see header note). Without
    them a PNG is one frame. */
export function loadFrames(file, opts = {}) {
  const buf = fs.readFileSync(file);
  if (buf.length > 5 && buf.toString("ascii", 0, 3) === "GIF") {
    return { kind: "gif", frames: decodeGif(buf) };
  }
  const im = readPng(buf);
  if (opts.cellW && opts.cellH) {
    const frames = [];
    for (let cy = 0; cy + opts.cellH <= im.h; cy += opts.cellH)
      for (let cx = 0; cx + opts.cellW <= im.w; cx += opts.cellW)
        frames.push(crop(im, cx, cy, opts.cellW, opts.cellH));
    return { kind: "sheet", frames, cellW: opts.cellW, cellH: opts.cellH, sheetW: im.w, sheetH: im.h };
  }
  return { kind: "png", frames: [im] };
}

/** Save frames back in the same container shape they were loaded from.
    For sheets, frame i goes back to cell i — positions are preserved. */
export function saveFrames(file, loaded) {
  if (loaded.kind === "gif") {
    fs.writeFileSync(file, encodeGif(loaded.frames));
    return;
  }
  if (loaded.kind === "sheet") {
    const { cellW, cellH, sheetW, sheetH } = loaded;
    const out = { w: sheetW, h: sheetH, data: Buffer.alloc(sheetW * sheetH * 4) };
    let i = 0;
    for (let cy = 0; cy + cellH <= sheetH; cy += cellH)
      for (let cx = 0; cx + cellW <= sheetW; cx += cellW) {
        if (i >= loaded.frames.length) break;
        const f = loaded.frames[i++];
        for (let y = 0; y < cellH; y++)
          f.data.copy(out.data, ((cy + y) * sheetW + cx) * 4, y * cellW * 4, (y + 1) * cellW * 4);
      }
    fs.writeFileSync(file, writePng(out));
    return;
  }
  fs.writeFileSync(file, writePng(loaded.frames[0]));
}

/* Deterministic region repaint — the alternative to "regenerate and pray".

   Given a region (from the canon) and a colour ramp (dark → light), every
   pixel of that region is remapped onto the ramp by luminance. Shading
   survives, silhouettes never change, and running it twice gives the same
   answer — which AI regeneration never does.

   Hard-won rules baked in:
   1. FIXED luminance range. The source luminance range is taken from the
      region definition (recorded when the region was learned), never
      re-measured per image. Per-image normalisation makes the same source
      colour land on different ramp steps depending on how much of the region
      is visible in that particular frame — a hat we shipped was bright from
      behind and dark from the front until we fixed this.
   2. Protected regions win. Pixels matching a protected region (face, eyes,
      outline) are never painted, even if they also match the target region.
   3. Optional mask source. When repainting a recoloured VARIANT of a sprite,
      match regions on the ORIGINAL (maskFrom) and apply paint to the variant:
      palette-swapped variants keep identical pixel layout, so the original's
      cleaner colours make a better mask. */
import { hexToRgb, lum } from "./colors.mjs";
import { compileRegion, compileRegions, protectedRegions, computeLumRange } from "./canon.mjs";

/** Build a Uint8Array mask (1 = paint) for `regionName` over `maskSrc`. */
export function regionMask(maskSrc, canon, regionName, opts = {}) {
  const def = canon.regions[regionName];
  if (!def) throw new Error(`unknown region "${regionName}" — define it in sprite-canon.json`);
  const match = compileRegion(def);
  const guards = protectedRegions(canon)
    .filter((n) => n !== regionName)
    .map((n) => compileRegion(canon.regions[n]));
  const [rowFrom, rowTo] = opts.rows ?? [0, maskSrc.h - 1];
  const mask = new Uint8Array(maskSrc.w * maskSrc.h);
  for (let y = Math.max(0, rowFrom); y <= Math.min(maskSrc.h - 1, rowTo); y++)
    for (let x = 0; x < maskSrc.w; x++) {
      const i = y * maskSrc.w + x, o = i * 4;
      if (maskSrc.data[o + 3] < 128) continue;
      const r = maskSrc.data[o], g = maskSrc.data[o + 1], b = maskSrc.data[o + 2];
      if (guards.some((gd) => gd(r, g, b))) continue;
      if (match(r, g, b)) mask[i] = 1;
    }
  return mask;
}

/** Repaint masked pixels of `im` (in place) onto `ramp` (hex[], dark→light). */
export function applyRamp(im, mask, ramp, lumRange) {
  const rgb = ramp.map(hexToRgb);
  const [lo, hi] = lumRange;
  const span = Math.max(1, hi - lo);
  for (let i = 0; i < mask.length; i++) {
    if (!mask[i]) continue;
    const o = i * 4;
    let t = (lum(im.data[o], im.data[o + 1], im.data[o + 2]) - lo) / span;
    t = Math.max(0, Math.min(1, t));
    const f = t * (rgb.length - 1);
    const a = Math.min(rgb.length - 1, Math.floor(f));
    const b = Math.min(rgb.length - 1, a + 1);
    const m = f - a;
    for (let c = 0; c < 3; c++) im.data[o + c] = Math.round(rgb[a][c] * (1 - m) + rgb[b][c] * m);
  }
}

/** Repaint one frame. Returns a new frame; the input is not modified.
    maskFrom: optional frame (same layout) to derive the mask from. */
export function repaintFrame(frame, canon, regionName, ramp, opts = {}) {
  const out = { w: frame.w, h: frame.h, data: Buffer.from(frame.data), delay: frame.delay };
  const src = opts.maskFrom ?? frame;
  if (src.w !== frame.w || src.h !== frame.h)
    throw new Error("maskFrom dimensions must match the target frame");
  const mask = regionMask(src, canon, regionName, opts);
  const def = canon.regions[regionName];
  const range = def.lumRange ?? computeLumRange(def);
  if (!range) throw new Error(`region "${regionName}" has no colour list and no lumRange — cannot derive a fixed range`);
  applyRamp(out, mask, ramp, range);
  return out;
}

/** Count pixels per region — useful to sanity-check region definitions. */
export function regionCensus(frame, canon) {
  const matchers = compileRegions(canon);
  const counts = Object.fromEntries(Object.keys(matchers).map((n) => [n, 0]));
  let opaque = 0, unmatched = 0;
  for (let i = 0; i < frame.w * frame.h; i++) {
    const o = i * 4;
    if (frame.data[o + 3] < 128) continue;
    opaque++;
    let hit = false;
    for (const [name, match] of Object.entries(matchers))
      if (match(frame.data[o], frame.data[o + 1], frame.data[o + 2])) { counts[name]++; hit = true; }
    if (!hit) unmatched++;
  }
  return { opaque, unmatched, counts };
}

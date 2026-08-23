/* Palette and region learning — how a project registers its canon without
   hand-typing hex lists.

   learnPalette: collect every colour used across sample images, keep the ones
   that appear often enough to be deliberate (single-count colours are usually
   anti-aliasing noise or mistakes — exactly what you want the canon to reject).

   learnRegion: sample colours at user-provided points (or whole images) and
   record the colour list + its luminance range. Point-sampling is the honest
   路: automatic clustering guesses wrong on 32px sprites where "skin" and
   "wood" share hues; a human clicking 5 pixels once beats a wrong guess that
   silently corrupts every later repaint. */
import { loadFrames } from "./loader.mjs";
import { rgbToHex, lum, hexToRgb } from "./colors.mjs";

/* ---------- Palette projection ----------
   Snap every opaque pixel to its nearest canon-palette colour. This is the
   deterministic tone-unifier for GENERATED art: prompts cannot force a model
   onto your palette, but projection can — identity and silhouette stay, hue
   family becomes exactly the canon's. Also reports how far pixels had to move
   (meanShift): a candidate whose colours moved a long way was never in your
   tone family to begin with, which makes meanShift a usable accept/reject
   score for generation candidates. */
export function projectToPalette(im, paletteHexes, opts = {}) {
  const alphaMin = opts.alphaThreshold ?? 128;
  const pal = paletteHexes.map(hexToRgb);
  const out = { w: im.w, h: im.h, data: Buffer.from(im.data), delay: im.delay };
  const cache = new Map();
  let moved = 0, total = 0, shiftSum = 0;
  for (let i = 0; i < im.w * im.h; i++) {
    const o = i * 4;
    if (im.data[o + 3] < alphaMin) continue;
    total++;
    const r = im.data[o], g = im.data[o + 1], b = im.data[o + 2];
    const k = (r << 16) | (g << 8) | b;
    let best = cache.get(k);
    if (best === undefined) {
      let bi = 0, bd = Infinity;
      for (let p = 0; p < pal.length; p++) {
        const d = (pal[p][0] - r) ** 2 + (pal[p][1] - g) ** 2 + (pal[p][2] - b) ** 2;
        if (d < bd) { bd = d; bi = p; }
      }
      best = bi;
      cache.set(k, best);
    }
    const [nr, ng, nb] = pal[best];
    if (nr !== r || ng !== g || nb !== b) {
      moved++;
      shiftSum += Math.sqrt((nr - r) ** 2 + (ng - g) ** 2 + (nb - b) ** 2);
      out.data[o] = nr; out.data[o + 1] = ng; out.data[o + 2] = nb;
    }
  }
  return {
    frame: out,
    stats: {
      totalOpaque: total,
      movedPixels: moved,
      meanShift: total ? Math.round((shiftSum / total) * 10) / 10 : 0,
    },
  };
}

/** Count colours across files. Returns [{ hex, count }] sorted by count. */
export function collectColors(files, opts = {}) {
  const alphaMin = opts.alphaThreshold ?? 128;
  const counts = new Map();
  for (const file of files) {
    const { frames } = loadFrames(file, opts);
    for (const f of frames)
      for (let i = 0; i < f.w * f.h; i++) {
        const o = i * 4;
        if (f.data[o + 3] < alphaMin) continue;
        const hex = rgbToHex(f.data[o], f.data[o + 1], f.data[o + 2]);
        counts.set(hex, (counts.get(hex) || 0) + 1);
      }
  }
  return [...counts.entries()].map(([hex, count]) => ({ hex, count }))
    .sort((a, b) => b.count - a.count);
}

/** Learn a palette: colours appearing at least minCount times (default 4). */
export function learnPalette(files, opts = {}) {
  const minCount = opts.minCount ?? 4;
  const all = collectColors(files, opts);
  const kept = all.filter((c) => c.count >= minCount).map((c) => c.hex);
  return { colors: kept, dropped: all.length - kept.length, totalSeen: all.length };
}

/** Learn a region from sample points: [{ file, points: [[x, y], ...] }].
    Colours at those points (plus optional near-neighbours) become the region.
    spread: also absorb colours within this per-channel distance found in the
    same files — catches the shading steps around the sampled pixels. */
export function learnRegionFromPoints(samples, opts = {}) {
  const seeds = new Set();
  for (const s of samples) {
    const { frames } = loadFrames(s.file, opts);
    const f = frames[s.frame ?? 0];
    for (const [x, y] of s.points) {
      if (x < 0 || y < 0 || x >= f.w || y >= f.h) throw new Error(`point ${x},${y} outside ${s.file}`);
      const o = (y * f.w + x) * 4;
      if (f.data[o + 3] < 128) throw new Error(`point ${x},${y} in ${s.file} is transparent`);
      seeds.add(rgbToHex(f.data[o], f.data[o + 1], f.data[o + 2]));
    }
  }
  const spread = opts.spread ?? 0;
  const colors = new Set(seeds);
  if (spread > 0) {
    const seedRgb = [...seeds].map(hexToRgb);
    for (const s of samples) {
      const { frames } = loadFrames(s.file, opts);
      for (const f of frames)
        for (let i = 0; i < f.w * f.h; i++) {
          const o = i * 4;
          if (f.data[o + 3] < 128) continue;
          const r = f.data[o], g = f.data[o + 1], b = f.data[o + 2];
          if (seedRgb.some((p) => Math.abs(p[0] - r) <= spread && Math.abs(p[1] - g) <= spread && Math.abs(p[2] - b) <= spread))
            colors.add(rgbToHex(r, g, b));
        }
    }
  }
  const list = [...colors];
  const ls = list.map((h) => lum(...hexToRgb(h)));
  return {
    colors: list.sort((a, b) => lum(...hexToRgb(a)) - lum(...hexToRgb(b))),
    lumRange: [Math.round(Math.min(...ls)), Math.round(Math.max(...ls))],
  };
}

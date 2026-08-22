/* Numeric verification — the check suite that replaces eyeballing.

   You cannot eyeball 96 outfit×hat combinations across 9 directions; we tried,
   and a panel of 15 reviewers then found three systematic defects our eyes had
   missed. Each check here exists because a real defect shipped without it.

   Checks (each returns { name, pass, value, limit, details }):
   - palette      every opaque pixel is on the canon palette
   - jitter       landmarks stay put across animation frames
   - groupSpread  mean luminance of a region agrees across a file group
                  (e.g. the 8 directions of one character — catches "bright
                  from behind, dark from the front")
   - protected    vs a base file: pixels of protected regions are untouched
   - leftover     vs a base file: inside the changed area, no pixel of the
                  source region survives unpainted (catches green specks on a
                  repainted hood)
   - scale        alpha-bbox heights match the canon's relative size table
                  (catches "the house is smaller than the hero") */
import { compileRegion, compileRegions } from "./canon.mjs";
import { hexToRgb, lum, rgbToHex } from "./colors.mjs";
import { measureAnimation } from "./measure.mjs";

const check = (name, pass, value, limit, details) => ({ name, pass, value, limit, ...(details ? { details } : {}) });

/** Every opaque pixel within tolerance of some canon palette colour. */
export function checkPalette(frames, canon) {
  const tol = canon.checks.paletteTolerance;
  const pal = (canon.palette?.colors ?? []).map(hexToRgb);
  if (!pal.length) return check("palette", true, 0, 0, "no palette in canon — skipped");
  const bad = new Map();
  let total = 0;
  for (const f of frames)
    for (let i = 0; i < f.w * f.h; i++) {
      const o = i * 4;
      if (f.data[o + 3] < 128) continue;
      total++;
      const r = f.data[o], g = f.data[o + 1], b = f.data[o + 2];
      const ok = pal.some((p) => Math.abs(p[0] - r) <= tol && Math.abs(p[1] - g) <= tol && Math.abs(p[2] - b) <= tol);
      if (!ok) {
        const k = rgbToHex(r, g, b);
        bad.set(k, (bad.get(k) || 0) + 1);
      }
    }
  const offenders = [...bad.entries()].sort((a, b) => b[1] - a[1]).slice(0, 12)
    .map(([hex, n]) => `${hex}×${n}`);
  const badCount = [...bad.values()].reduce((a, b) => a + b, 0);
  return check("palette", badCount === 0, badCount, 0,
    badCount ? `off-palette pixels (top: ${offenders.join(" ")})` : `${total}px all on palette`);
}

/** Landmarks stay put across frames of one animation. */
export function checkJitter(frames, canon, opts = {}) {
  const limit = opts.maxJitter ?? canon.checks.maxJitter;
  const { jitter } = measureAnimation(frames, canon, opts);
  const worst = [];
  const flat = { top: jitter.top, height: jitter.height, centerX: jitter.centerX };
  for (const [k, v] of Object.entries(jitter.regionTop ?? {})) flat[`regionTop.${k}`] = v;
  let max = 0, maxKey = "";
  for (const [k, v] of Object.entries(flat)) {
    if (v == null) continue;
    if (v > max) { max = v; maxKey = k; }
    if (v > limit) worst.push(`${k}=${v}`);
  }
  return check("jitter", max <= limit, max, limit,
    worst.length ? `unstable: ${worst.join(" ")}` : `worst landmark ${maxKey}=${max}`);
}

/** Mean luminance of one region agrees across a group of files.
    items: [{ label, frames }] */
export function checkGroupSpread(items, canon, regionName, opts = {}) {
  const limit = opts.maxGroupSpread ?? canon.checks.maxGroupSpread;
  const def = canon.regions[regionName];
  if (!def) throw new Error(`unknown region "${regionName}"`);
  const match = compileRegion(def);
  const means = [];
  for (const it of items) {
    let sum = 0, n = 0;
    for (const f of it.frames)
      for (let i = 0; i < f.w * f.h; i++) {
        const o = i * 4;
        if (f.data[o + 3] < 128) continue;
        if (!match(f.data[o], f.data[o + 1], f.data[o + 2])) continue;
        sum += lum(f.data[o], f.data[o + 1], f.data[o + 2]); n++;
      }
    if (n) means.push({ label: it.label, mean: Math.round(sum / n) });
  }
  if (means.length < 2) return check("groupSpread", true, 0, limit, "fewer than 2 files contain the region");
  const vals = means.map((m) => m.mean);
  const spread = Math.max(...vals) - Math.min(...vals);
  return check("groupSpread", spread <= limit, spread, limit,
    means.map((m) => `${m.label}=${m.mean}`).join(" "));
}

/** vs base: protected-region pixels must be byte-identical. */
export function checkProtected(frames, baseFrames, canon) {
  const guards = Object.entries(canon.regions)
    .filter(([, d]) => d.protected)
    .map(([n, d]) => [n, compileRegion(d)]);
  if (!guards.length) return check("protected", true, 0, 0, "no protected regions in canon — skipped");
  let bad = 0;
  const byRegion = {};
  for (let fi = 0; fi < frames.length; fi++) {
    const f = frames[fi], b = baseFrames[Math.min(fi, baseFrames.length - 1)];
    if (f.w !== b.w || f.h !== b.h) return check("protected", false, -1, 0, "frame size differs from base");
    for (let i = 0; i < f.w * f.h; i++) {
      const o = i * 4;
      if (b.data[o + 3] < 128) continue;
      /* alpha counts as a change too — erasing a protected pixel's alpha while
         leaving its RGB bytes is still destroying the face */
      const changed = f.data[o] !== b.data[o] || f.data[o + 1] !== b.data[o + 1] || f.data[o + 2] !== b.data[o + 2]
        || (f.data[o + 3] < 128);
      if (!changed) continue;
      for (const [name, g] of guards)
        if (g(b.data[o], b.data[o + 1], b.data[o + 2])) { bad++; byRegion[name] = (byRegion[name] || 0) + 1; }
    }
  }
  return check("protected", bad === 0, bad, 0,
    bad ? Object.entries(byRegion).map(([n, c]) => `${n}=${c}px`).join(" ") : "all protected pixels intact");
}

/** vs base: inside the changed area, no source-region pixel left unpainted. */
export function checkLeftover(frames, baseFrames, canon, regionName) {
  const def = canon.regions[regionName];
  if (!def) throw new Error(`unknown region "${regionName}"`);
  const match = compileRegion(def);
  let leftover = 0;
  for (let fi = 0; fi < frames.length; fi++) {
    const f = frames[fi], b = baseFrames[Math.min(fi, baseFrames.length - 1)];
    /* the changed band = [first, last] rows containing at least one changed
       pixel — bounded on BOTH sides, so a repaint restricted to the boots
       doesn't flag untouched region pixels up at the hat as leftovers */
    let yMin = 1e9, yMax = -1;
    for (let i = 0; i < f.w * f.h; i++) {
      const o = i * 4;
      if (b.data[o + 3] < 128) continue;
      if (f.data[o] !== b.data[o] || f.data[o + 1] !== b.data[o + 1] || f.data[o + 2] !== b.data[o + 2]) {
        const y = Math.floor(i / f.w);
        if (y < yMin) yMin = y;
        if (y > yMax) yMax = y;
      }
    }
    if (yMax < 0) continue;
    for (let i = 0; i < f.w * f.h; i++) {
      const y = Math.floor(i / f.w);
      if (y < yMin || y > yMax) continue;
      const o = i * 4;
      if (b.data[o + 3] < 128) continue;
      const same = f.data[o] === b.data[o] && f.data[o + 1] === b.data[o + 1] && f.data[o + 2] === b.data[o + 2];
      if (same && match(b.data[o], b.data[o + 1], b.data[o + 2])) leftover++;
    }
  }
  return check("leftover", leftover === 0, leftover, 0,
    leftover ? `${leftover}px of "${regionName}" survived inside the repainted area` : "no leftovers");
}

/** Alpha-bbox heights vs the canon's relative size table.
    items: [{ label, frames, name }] where name keys canon.scale.heights. */
export function checkScale(items, canon, opts = {}) {
  const table = canon.scale?.heights;
  if (!table) return check("scale", true, 0, 0, "no scale table in canon — add canon.scale.heights (e.g. {\"hero\":1,\"house\":3.4}) to sprite-canon.json — skipped");
  if (!items.length)
    return check("scale", false, -1, 0, "no files matched scaleNames — keys must be file basenames like \"hero.png\"");
  const tolerance = opts.scaleTolerance ?? 0.12;      // 12% relative error allowed
  const ref = items.find((it) => table[it.name] === 1) ?? items[0];
  const heightOf = (it) => {
    const hs = it.frames.map((f) => {
      let y0 = 1e9, y1 = -1;
      for (let i = 0; i < f.w * f.h; i++)
        if (f.data[i * 4 + 3] > (canon.checks.alphaThreshold ?? 40)) {
          const y = Math.floor(i / f.w);
          if (y < y0) y0 = y; if (y > y1) y1 = y;
        }
      return y1 < 0 ? 0 : y1 - y0 + 1;
    });
    return Math.max(...hs);
  };
  const refH = heightOf(ref) / (table[ref.name] ?? 1);
  const rows = [];
  let worst = 0;
  for (const it of items) {
    const expected = table[it.name];
    if (expected == null) { rows.push(`${it.label}: not in scale table`); continue; }
    const actual = heightOf(it) / refH;
    const err = Math.abs(actual - expected) / expected;
    if (err > worst) worst = err;
    rows.push(`${it.label}: ${actual.toFixed(2)}× (canon ${expected}×${err > tolerance ? " ✗" : ""})`);
  }
  return check("scale", worst <= tolerance, Math.round(worst * 100) / 100, tolerance, rows.join(" · "));
}

export function summarize(checks) {
  return { pass: checks.every((c) => c.pass), checks };
}

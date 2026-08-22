/* The canon (sprite-canon.json) — a project's single source of truth for
   "what makes our assets look like ONE game".

   Why this file exists: on a real project we found that every consistency bug
   traced back to a rule that lived only in someone's head — the palette, which
   colours are "skin", how big a house is relative to the hero. The canon makes
   those rules data, so tools can check and fix against them.

   Schema (all sections optional except version):
   {
     "version": 1,
     "name": "my-game",
     "palette":  { "colors": ["1e3219", ...], "tolerance": 0 },
     "regions": {
       "skin":    { "colors": ["ecb7a0", ...], "protected": true },
       "outline": { "light": [0, 0.165], "protected": true },
       "cloth":   { "colors": [...], "hue": [60, 178], "sat": [0.08, 1],
                    "lumRange": [28, 118] }
     },
     "scale":  { "unit": "hero", "heights": { "hero": 1.0, "house": 3.4 } },
     "checks": { "maxJitter": 2, "maxGroupSpread": 48, "alphaThreshold": 40 }
   }

   Region matching: a pixel belongs to a region if its exact colour is in
   `colors`, OR it passes every HSL rule present (`hue` in degrees, `sat`/`light`
   as 0..1 ranges). Rules catch anti-aliased art where exact hex lists fail.

   `lumRange` is the FIXED luminance range used when repainting the region.
   Fixed, not per-image: normalising per image makes the same source colour map
   to different output colours depending on how much of the region is visible —
   we shipped a hat that was bright from behind and dark from the front before
   learning this. It is recorded automatically when a region is learned.

   `protected` regions are never repainted and verified untouched. */
import fs from "node:fs";
import path from "node:path";
import { hexToRgb, lum, hsl } from "./colors.mjs";

export const CANON_FILE = "sprite-canon.json";

export const DEFAULT_CHECKS = {
  maxJitter: 2,           // px a landmark may move between frames of one animation
  maxGroupSpread: 48,     // max mean-luminance spread across files of one group
  alphaThreshold: 40,     // alpha above this counts as "content"
  paletteTolerance: 0,    // max per-channel difference to still count as on-palette
};

/** Find sprite-canon.json in dir or any parent. Returns absolute path or null. */
export function findCanon(startDir) {
  let dir = path.resolve(startDir);
  for (;;) {
    const p = path.join(dir, CANON_FILE);
    if (fs.existsSync(p)) return p;
    const up = path.dirname(dir);
    if (up === dir) return null;
    dir = up;
  }
}

export function loadCanon(canonPath) {
  const c = JSON.parse(fs.readFileSync(canonPath, "utf8"));
  c.checks = { ...DEFAULT_CHECKS, ...(c.checks || {}) };
  c.regions = c.regions || {};
  c._dir = path.dirname(path.resolve(canonPath));
  return c;
}

export function saveCanon(canonPath, canon) {
  const { _dir, ...clean } = canon;
  fs.writeFileSync(canonPath, JSON.stringify(clean, null, 2) + "\n");
}

/** Compile a region definition into a fast per-pixel matcher. */
export function compileRegion(def) {
  const set = def.colors ? new Set(def.colors.map((h) => {
    const [r, g, b] = hexToRgb(h);
    return (r << 16) | (g << 8) | b;
  })) : null;
  const hasRule = def.hue || def.sat || def.light;
  return (r, g, b) => {
    if (set && set.has((r << 16) | (g << 8) | b)) return true;
    if (!hasRule) return false;
    const [H, S, L] = hsl(r, g, b);
    if (def.hue && (H < def.hue[0] || H > def.hue[1])) return false;
    if (def.sat && (S < def.sat[0] || S > def.sat[1])) return false;
    if (def.light && (L < def.light[0] || L > def.light[1])) return false;
    return true;
  };
}

/** Compile all regions; returns { name: matcher }. */
export function compileRegions(canon) {
  const out = {};
  for (const [name, def] of Object.entries(canon.regions)) out[name] = compileRegion(def);
  return out;
}

/** Names of regions marked protected. */
export const protectedRegions = (canon) =>
  Object.entries(canon.regions).filter(([, d]) => d.protected).map(([n]) => n);

/** Record a region's luminance range from its colour list (for fixed-range repaint). */
export function computeLumRange(def) {
  if (!def.colors || !def.colors.length) return null;
  const ls = def.colors.map((h) => lum(...hexToRgb(h)));
  return [Math.round(Math.min(...ls)), Math.round(Math.max(...ls))];
}

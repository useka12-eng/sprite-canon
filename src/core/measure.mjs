/* Per-frame anatomical measurement.

   Why measure instead of eyeball: sprite defects that matter in motion —
   an accessory jumping 8px between frames, a head that sits 3px lower facing
   east — are invisible in a single still and obvious in numbers. Every
   placement decision downstream (attach points, verify thresholds) reads
   these measurements instead of hard-coding pixel positions.

   Landmarks per frame:
     bbox                 tight alpha bounding box
     top / bottom         first / last content row
     widestRow/Width      the widest content row
     narrowest in band    the "waist": narrowest row in the middle band —
                          for humanoids this is the neck
     capWidth/capCx       max width within the rows just below the top —
                          for humanoids this is the head (the very top row is
                          a poor width proxy: it's usually a 2px tuft)
     regionTop[name]      first row containing each canon region (e.g. where
                          the face starts — the row a hat brim must stay above)

   jitter: max-min of each landmark across frames of one animation. */
import { alphaBBox } from "./png.mjs";
import { compileRegions } from "./canon.mjs";

export function rowProfile(im, alphaThreshold = 40) {
  const rows = [];
  for (let y = 0; y < im.h; y++) {
    let x0 = 1e9, x1 = -1;
    for (let x = 0; x < im.w; x++)
      if (im.data[(y * im.w + x) * 4 + 3] > alphaThreshold) { if (x < x0) x0 = x; if (x > x1) x1 = x; }
    rows[y] = x1 < 0 ? null : { x0, x1, w: x1 - x0 + 1, cx: (x0 + x1) / 2 };
  }
  return rows;
}

export function measureFrame(im, canon = null, opts = {}) {
  const thr = opts.alphaThreshold ?? canon?.checks?.alphaThreshold ?? 40;
  const rows = rowProfile(im, thr);
  const bbox = alphaBBox(im, thr);
  if (!bbox) return null;
  const top = bbox.y0, bottom = bbox.y1;

  let widestRow = top, widestWidth = 0;
  for (let y = top; y <= bottom; y++)
    if (rows[y] && rows[y].w > widestWidth) { widestWidth = rows[y].w; widestRow = y; }

  /* Cap (head for humanoids): widest row within [top+capFrom, top+capTo]. */
  const capFrom = opts.capFrom ?? 4, capTo = opts.capTo ?? 11;
  let capWidth = rows[top]?.w ?? 0, capCx = rows[top]?.cx ?? bbox.x0 + bbox.w / 2;
  for (let y = top + capFrom; y <= Math.min(bottom, top + capTo); y++)
    if (rows[y] && rows[y].w > capWidth) { capWidth = rows[y].w; capCx = rows[y].cx; }

  /* Waist/neck: narrowest row in the middle band. */
  const h = bottom - top + 1;
  const bandFrom = top + Math.round(h * (opts.waistBand?.[0] ?? 0.25));
  const bandTo = top + Math.round(h * (opts.waistBand?.[1] ?? 0.6));
  let waistRow = null, waistWidth = 1e9;
  for (let y = bandFrom; y <= Math.min(bottom, bandTo); y++)
    if (rows[y] && rows[y].w < waistWidth) { waistWidth = rows[y].w; waistRow = y; }

  const m = {
    bbox, top, bottom, height: h,
    widestRow, widestWidth, capWidth, capCx: Math.round(capCx * 10) / 10,
    waistRow, waistWidth: waistRow == null ? null : waistWidth,
  };

  if (canon && Object.keys(canon.regions).length) {
    const matchers = compileRegions(canon);
    const regionTop = {}, regionCount = {};
    for (const name of Object.keys(matchers)) { regionTop[name] = null; regionCount[name] = 0; }
    for (let y = top; y <= bottom; y++)
      for (let x = 0; x < im.w; x++) {
        const o = (y * im.w + x) * 4;
        if (im.data[o + 3] < 128) continue;
        for (const [name, match] of Object.entries(matchers)) {
          if (!match(im.data[o], im.data[o + 1], im.data[o + 2])) continue;
          if (regionTop[name] == null) regionTop[name] = y;
          regionCount[name]++;
        }
      }
    m.regionTop = regionTop;
    m.regionCount = regionCount;
  }
  return m;
}

/** Measure all frames + cross-frame jitter of the stable landmarks. */
export function measureAnimation(frames, canon = null, opts = {}) {
  const perFrame = frames.map((f) => measureFrame(f, canon, opts));
  const present = perFrame.filter(Boolean);
  const jitterOf = (get) => {
    const vs = present.map(get).filter((v) => v != null);
    return vs.length > 1 ? Math.max(...vs) - Math.min(...vs) : 0;
  };
  const jitter = {
    top: jitterOf((m) => m.top),
    height: jitterOf((m) => m.height),
    centerX: Math.round(jitterOf((m) => m.bbox.x0 + m.bbox.w / 2) * 10) / 10,
    capWidth: jitterOf((m) => m.capWidth),
  };
  if (present[0]?.regionTop) {
    jitter.regionTop = {};
    for (const name of Object.keys(present[0].regionTop))
      jitter.regionTop[name] = jitterOf((m) => m.regionTop?.[name]);
  }
  return { frames: perFrame, jitter };
}

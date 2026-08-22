/* Dependency-free GIF codec for pixel-art animation work.
   decodeGif(buf)  -> [{ w, h, data: RGBA Buffer, delay }]   (delay in 1/100 s)
   encodeGif(frames, { loop }) -> Buffer
   patchPalettes(buf, map)     -> Buffer  (lossless colour-table substitution)

   Encoder notes, learned the hard way:
   - "Changed pixels only" delta frames (disposal 1) CANNOT erase painted->transparent
     transitions, and walk cycles erase every frame. So we use one shared bounding
     rectangle across ALL frames with disposal 2 (restore to background). A sprite
     usually covers under a third of its canvas, so output still shrinks ~30%.
   - The encoder is verified lossless for opaque pixels up to 255 colours;
     beyond that, colours snap to the nearest palette entry. */

export function decodeGif(buf) {
  let p = 6;
  const W = buf.readUInt16LE(p); p += 2;
  const H = buf.readUInt16LE(p); p += 2;
  const flags = buf[p]; p += 3;
  let gct = null;
  if (flags & 0x80) { const n = 2 << (flags & 7); gct = buf.subarray(p, p + n * 3); p += n * 3; }
  const frames = [];
  let transparent = -1, delay = 10, dispose = 0;
  /* GIF89a disposal applies AFTER a frame is displayed, to THAT frame's rect.
     (An earlier version cleared the incoming frame's own rect before drawing
     it — which happens to be correct only when every frame shares one rect,
     i.e. for this package's own encoder output, and ghosts on optimised GIFs
     whose rects differ per frame.) */
  let pending = null;                                  // { dispose, rect, snapshot } of the frame just displayed
  const canvas = Buffer.alloc(W * H * 4);
  const clearRect = (r) => {
    for (let y = 0; y < r.h; y++) for (let x = 0; x < r.w; x++) {
      const o = ((r.y + y) * W + r.x + x) * 4;
      canvas[o] = canvas[o + 1] = canvas[o + 2] = canvas[o + 3] = 0;
    }
  };
  while (p < buf.length) {
    const b = buf[p];
    if (b === 0x21) {                                  // extension
      const label = buf[p + 1]; p += 2;
      if (label === 0xf9) {
        dispose = (buf[p + 1] >> 2) & 7;
        delay = buf.readUInt16LE(p + 2) || 10;
        transparent = (buf[p + 1] & 1) ? buf[p + 4] : -1;
      }
      while (buf[p] !== 0) p += buf[p] + 1;
      p++;
    } else if (b === 0x2c) {                           // image descriptor
      /* dispose of the PREVIOUS frame now, before drawing this one */
      if (pending) {
        if (pending.dispose === 2) clearRect(pending.rect);
        else if (pending.dispose === 3 && pending.snapshot) pending.snapshot.copy(canvas);
        pending = null;
      }
      const ix = buf.readUInt16LE(p + 1), iy = buf.readUInt16LE(p + 3);
      const iw = buf.readUInt16LE(p + 5), ih = buf.readUInt16LE(p + 7);
      const lf = buf[p + 9]; p += 10;
      let ct = gct;
      if (lf & 0x80) { const n = 2 << (lf & 7); ct = buf.subarray(p, p + n * 3); p += n * 3; }
      const interlaced = !!(lf & 0x40);
      const minCode = buf[p++];
      const chunks = [];
      while (buf[p] !== 0) { const len = buf[p]; chunks.push(buf.subarray(p + 1, p + 1 + len)); p += len + 1; }
      p++;
      const idx = lzwDecode(minCode, Buffer.concat(chunks), iw * ih);
      const snapshot = dispose === 3 ? Buffer.from(canvas) : null;
      const rows = [];
      if (interlaced) { let r = 0; for (const [s, st] of [[0, 8], [4, 8], [2, 4], [1, 2]]) for (let y = s; y < ih; y += st) rows[y] = r++; }
      for (let y = 0; y < ih; y++) {
        const sy = interlaced ? rows[y] : y;
        for (let x = 0; x < iw; x++) {
          const v = idx[sy * iw + x];
          if (v === transparent) continue;
          const o = ((iy + y) * W + ix + x) * 4;
          canvas[o] = ct[v * 3]; canvas[o + 1] = ct[v * 3 + 1]; canvas[o + 2] = ct[v * 3 + 2]; canvas[o + 3] = 255;
        }
      }
      frames.push({ w: W, h: H, data: Buffer.from(canvas), delay });
      pending = { dispose, rect: { x: ix, y: iy, w: iw, h: ih }, snapshot };
      dispose = 0; transparent = -1;
    } else break;
  }
  return frames;
}

function lzwDecode(minCode, data, pixelCount) {
  const out = new Uint8Array(pixelCount);
  const clear = 1 << minCode, eoi = clear + 1;
  let codeSize = minCode + 1, next = eoi + 1, dict = [], bit = 0, prev = -1, oi = 0;
  const reset = () => { dict = []; for (let i = 0; i < clear; i++) dict[i] = [i]; dict[clear] = []; dict[eoi] = []; next = eoi + 1; codeSize = minCode + 1; prev = -1; };
  reset();
  const read = () => { let v = 0; for (let i = 0; i < codeSize; i++) { const b = data[bit >> 3]; if (b === undefined) return eoi; v |= ((b >> (bit & 7)) & 1) << i; bit++; } return v; };
  for (;;) {
    const code = read();
    if (code === eoi) break;
    if (code === clear) { reset(); continue; }
    let entry;
    if (code < next && dict[code]) entry = dict[code];
    else if (prev >= 0) entry = dict[prev].concat(dict[prev][0]);
    else break;
    for (const v of entry) if (oi < pixelCount) out[oi++] = v;
    if (prev >= 0 && next < 4096) { dict[next++] = dict[prev].concat(entry[0]); if (next === (1 << codeSize) && codeSize < 12) codeSize++; }
    prev = code;
    if (oi >= pixelCount) break;
  }
  return out;
}

export function encodeGif(frames, opt = {}) {
  const W = frames[0].w, H = frames[0].h;
  const seen = new Map();
  for (const f of frames) for (let i = 0; i < W * H; i++) {
    if (f.data[i * 4 + 3] < 128) continue;
    const k = (f.data[i * 4] << 16) | (f.data[i * 4 + 1] << 8) | f.data[i * 4 + 2];
    seen.set(k, (seen.get(k) || 0) + 1);
  }
  let colors = [...seen.entries()].sort((a, b) => b[1] - a[1]).map((e) => e[0]);
  const MAX = 255;                                   // one slot reserved for transparency
  if (colors.length > MAX) colors = colors.slice(0, MAX);
  const pal = colors.map((c) => [(c >> 16) & 255, (c >> 8) & 255, c & 255]);
  const TR = pal.length;
  pal.push([0, 0, 0]);
  let bits = 1; while ((1 << bits) < pal.length) bits++;
  const size = 1 << bits;
  const nearest = new Map();
  const lookup = (r, g, b) => {
    const k = (r << 16) | (g << 8) | b;
    let v = nearest.get(k);
    if (v !== undefined) return v;
    let best = 0, bd = 1e9;
    for (let i = 0; i < pal.length - 1; i++) {
      const d = (pal[i][0] - r) ** 2 + (pal[i][1] - g) ** 2 + (pal[i][2] - b) ** 2;
      if (d < bd) { bd = d; best = i; }
    }
    nearest.set(k, best);
    return best;
  };

  const out = [];
  out.push(Buffer.from("GIF89a"));
  const head = Buffer.alloc(7);
  head.writeUInt16LE(W, 0); head.writeUInt16LE(H, 2);
  head[4] = 0x80 | ((bits - 1) & 7); head[5] = 0; head[6] = 0;
  out.push(head);
  const ct = Buffer.alloc(size * 3);
  pal.forEach((c, i) => { ct[i * 3] = c[0]; ct[i * 3 + 1] = c[1]; ct[i * 3 + 2] = c[2]; });
  out.push(ct);
  const loopExt = Buffer.from([0x21, 0xff, 0x0b, ...Buffer.from("NETSCAPE2.0"), 0x03, 0x01, 0x00, 0x00, 0x00]);
  loopExt.writeUInt16LE(opt.loop === undefined ? 0 : opt.loop, 16);
  out.push(loopExt);

  const idxOf = frames.map((f) => {
    const a = new Uint8Array(W * H);
    for (let i = 0; i < W * H; i++) a[i] = f.data[i * 4 + 3] < 128 ? TR : lookup(f.data[i * 4], f.data[i * 4 + 1], f.data[i * 4 + 2]);
    return a;
  });
  /* Shared content rectangle across all frames (see header note). */
  let bx0 = W, by0 = H, bx1 = -1, by1 = -1;
  for (const a of idxOf) for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    if (a[y * W + x] === TR) continue;
    if (x < bx0) bx0 = x; if (x > bx1) bx1 = x;
    if (y < by0) by0 = y; if (y > by1) by1 = y;
  }
  if (bx1 < 0) { bx0 = by0 = 0; bx1 = by1 = 0; }
  const rw = bx1 - bx0 + 1, rh = by1 - by0 + 1;
  for (let fi = 0; fi < frames.length; fi++) {
    const cur = idxOf[fi];
    const gce = Buffer.from([0x21, 0xf9, 0x04, (2 << 2) | 0x01, 0, 0, TR, 0]);
    gce.writeUInt16LE(Math.max(2, Math.round(frames[fi].delay ?? 10)), 4);
    out.push(gce);
    const desc = Buffer.alloc(10);
    desc[0] = 0x2c; desc.writeUInt16LE(bx0, 1); desc.writeUInt16LE(by0, 3);
    desc.writeUInt16LE(rw, 5); desc.writeUInt16LE(rh, 7); desc[9] = 0;
    out.push(desc);
    const sub = new Uint8Array(rw * rh);
    for (let y = 0; y < rh; y++) for (let x = 0; x < rw; x++) sub[y * rw + x] = cur[(by0 + y) * W + (bx0 + x)];
    out.push(lzwEncode(sub, Math.max(2, bits)));
  }
  out.push(Buffer.from([0x3b]));
  return Buffer.concat(out);
}

function lzwEncode(idx, minCode) {
  const clear = 1 << minCode, eoi = clear + 1;
  let codeSize = minCode + 1, next = eoi + 1;
  let dict = new Map();
  const reset = () => { dict = new Map(); next = eoi + 1; codeSize = minCode + 1; };
  reset();
  const bits = [];
  let cur = 0, nb = 0;
  const write = (code) => { cur |= code << nb; nb += codeSize; while (nb >= 8) { bits.push(cur & 255); cur >>= 8; nb -= 8; } };
  write(clear);
  let prefix = idx[0];
  for (let i = 1; i < idx.length; i++) {
    const k = prefix * 4096 + idx[i];
    const found = dict.get(k);
    if (found !== undefined) { prefix = found; continue; }
    write(prefix);
    if (next < 4096) { dict.set(k, next++); if (next - 1 === (1 << codeSize) && codeSize < 12) codeSize++; }
    else { write(clear); reset(); }
    prefix = idx[i];
  }
  write(prefix);
  write(eoi);
  if (nb > 0) bits.push(cur & 255);
  const chunks = [Buffer.from([minCode])];
  for (let i = 0; i < bits.length; i += 255) {
    const s = bits.slice(i, i + 255);
    chunks.push(Buffer.from([s.length]), Buffer.from(s));
  }
  chunks.push(Buffer.from([0]));
  return Buffer.concat(chunks);
}

/* ---------- Lossless palette patching ----------
   A palette GIF stores colours only in its colour tables; the LZW-compressed frame
   data holds palette indices. Substituting RGB entries in every table re-dresses the
   whole animation without touching a single frame byte — zero generation loss, and
   every frame changes in perfect sync. This is how "outfit swapping" should be done
   on indexed sprites, instead of regenerating with AI and praying for consistency.

   Traps (all hit in production):
   - The global table is NOT enough: frames after the first usually carry their own
     local tables. Patch every table.
   - Index positions differ between tables, so matching must be done by RGB value,
     not by index.
   map: { "rrggbb": "rrggbb", ... }  (lowercase hex, no #)
   Returns { buffer, replaced } where replaced counts ACTUAL table-entry
   substitutions per source colour. A colorMap entry with zero hits means the
   source hex isn't in the file (typo, 1-bit-off colour) — callers must be
   able to see that instead of a fake success. */
export function patchPalettes(buf, map) {
  const out = Buffer.from(buf);
  const norm = new Map(Object.entries(map).map(([a, b]) => [a.toLowerCase().replace("#", ""), b.toLowerCase().replace("#", "")]));
  const replaced = Object.fromEntries([...norm.keys()].map((k) => [k, 0]));
  const patchTable = (offset, n) => {
    for (let i = 0; i < n; i++) {
      const o = offset + i * 3;
      const hex = [out[o], out[o + 1], out[o + 2]].map((v) => v.toString(16).padStart(2, "0")).join("");
      const to = norm.get(hex);
      if (!to) continue;
      out[o] = parseInt(to.slice(0, 2), 16);
      out[o + 1] = parseInt(to.slice(2, 4), 16);
      out[o + 2] = parseInt(to.slice(4, 6), 16);
      replaced[hex]++;
    }
  };
  let p = 6 + 4;
  const flags = out[p]; p += 3;
  if (flags & 0x80) { const n = 2 << (flags & 7); patchTable(p, n); p += n * 3; }
  while (p < out.length) {
    const b = out[p];
    if (b === 0x21) { p += 2; while (out[p] !== 0) p += out[p] + 1; p++; }
    else if (b === 0x2c) {
      const lf = out[p + 9]; p += 10;
      if (lf & 0x80) { const n = 2 << (lf & 7); patchTable(p, n); p += n * 3; }
      p++;                                             // LZW min code size
      while (out[p] !== 0) p += out[p] + 1;
      p++;
    } else break;
  }
  return { buffer: out, replaced };
}

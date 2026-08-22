/* Minimal dependency-free PNG codec (Node zlib only).
   Supports: 8-bit, colorType 6 (RGBA) / 2 (RGB) / 3 (palette + tRNS), non-interlaced.
   Battle-tested in a shipping pixel-art pipeline before extraction into this package. */
import zlib from "node:zlib";

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();
function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/** Decode a PNG buffer into { w, h, data: RGBA Buffer }. */
export function readPng(buffer) {
  if (buffer.readUInt32BE(0) !== 0x89504e47) throw new Error("not a PNG");
  let pos = 8;
  let w = 0, h = 0, bitDepth = 0, colorType = 0, interlace = 0;
  const idat = [];
  let plte = null, trns = null;
  while (pos < buffer.length) {
    const len = buffer.readUInt32BE(pos);
    const type = buffer.toString("ascii", pos + 4, pos + 8);
    const data = buffer.subarray(pos + 8, pos + 8 + len);
    if (type === "IHDR") {
      w = data.readUInt32BE(0); h = data.readUInt32BE(4);
      bitDepth = data[8]; colorType = data[9]; interlace = data[12];
    } else if (type === "IDAT") idat.push(data);
    else if (type === "PLTE") plte = data;
    else if (type === "tRNS") trns = data;
    else if (type === "IEND") break;
    pos += 12 + len;
  }
  if (bitDepth !== 8) throw new Error(`unsupported bitDepth ${bitDepth}`);
  if (interlace !== 0) throw new Error("interlaced PNG not supported");
  const bpp = colorType === 6 ? 4 : colorType === 2 ? 3 : colorType === 3 ? 1 : 0;
  if (!bpp) throw new Error(`unsupported colorType ${colorType}`);

  const raw = zlib.inflateSync(Buffer.concat(idat));
  const stride = w * bpp;
  const out = Buffer.alloc(w * h * 4);
  const prev = Buffer.alloc(stride);
  const cur = Buffer.alloc(stride);
  let rp = 0;
  const paeth = (a, b, c) => {
    const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
    return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
  };
  for (let y = 0; y < h; y++) {
    const filter = raw[rp++];
    raw.copy(cur, 0, rp, rp + stride); rp += stride;
    for (let i = 0; i < stride; i++) {
      const a = i >= bpp ? cur[i - bpp] : 0;
      const b = prev[i];
      const c = i >= bpp ? prev[i - bpp] : 0;
      if (filter === 1) cur[i] = (cur[i] + a) & 0xff;
      else if (filter === 2) cur[i] = (cur[i] + b) & 0xff;
      else if (filter === 3) cur[i] = (cur[i] + ((a + b) >> 1)) & 0xff;
      else if (filter === 4) cur[i] = (cur[i] + paeth(a, b, c)) & 0xff;
    }
    for (let x = 0; x < w; x++) {
      const o = (y * w + x) * 4;
      if (colorType === 6) {
        out[o] = cur[x * 4]; out[o + 1] = cur[x * 4 + 1]; out[o + 2] = cur[x * 4 + 2]; out[o + 3] = cur[x * 4 + 3];
      } else if (colorType === 2) {
        out[o] = cur[x * 3]; out[o + 1] = cur[x * 3 + 1]; out[o + 2] = cur[x * 3 + 2]; out[o + 3] = 255;
      } else {
        const idx = cur[x];
        out[o] = plte[idx * 3]; out[o + 1] = plte[idx * 3 + 1]; out[o + 2] = plte[idx * 3 + 2];
        out[o + 3] = trns && idx < trns.length ? trns[idx] : 255;
      }
    }
    cur.copy(prev);
  }
  return { w, h, data: out };
}

/** Encode { w, h, data: RGBA Buffer } into a PNG buffer. */
export function writePng({ w, h, data }) {
  const chunk = (type, payload) => {
    const buf = Buffer.alloc(12 + payload.length);
    buf.writeUInt32BE(payload.length, 0);
    buf.write(type, 4, "ascii");
    payload.copy(buf, 8);
    buf.writeUInt32BE(crc32(buf.subarray(4, 8 + payload.length)), 8 + payload.length);
    return buf;
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  const raw = Buffer.alloc((w * 4 + 1) * h);
  for (let y = 0; y < h; y++) {
    raw[y * (w * 4 + 1)] = 0;
    data.copy(raw, y * (w * 4 + 1) + 1, y * w * 4, (y + 1) * w * 4);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", zlib.deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

/** Nearest-neighbour resize — the only correct scaling for pixel art. */
export function resizeNearest(src, dw, dh) {
  const out = Buffer.alloc(dw * dh * 4);
  for (let y = 0; y < dh; y++) {
    const sy = Math.min(src.h - 1, Math.floor((y * src.h) / dh));
    for (let x = 0; x < dw; x++) {
      const sx = Math.min(src.w - 1, Math.floor((x * src.w) / dw));
      const so = (sy * src.w + sx) * 4, o = (y * dw + x) * 4;
      out[o] = src.data[so]; out[o + 1] = src.data[so + 1];
      out[o + 2] = src.data[so + 2]; out[o + 3] = src.data[so + 3];
    }
  }
  return { w: dw, h: dh, data: out };
}

/** Crop a rectangle (clamped; out-of-range area stays transparent). */
export function crop(src, x0, y0, w, h) {
  const out = { w, h, data: Buffer.alloc(w * h * 4) };
  for (let y = 0; y < h; y++) {
    const sy = y0 + y;
    if (sy < 0 || sy >= src.h) continue;
    for (let x = 0; x < w; x++) {
      const sx = x0 + x;
      if (sx < 0 || sx >= src.w) continue;
      const s = (sy * src.w + sx) * 4, t = (y * w + x) * 4;
      for (let c = 0; c < 4; c++) out.data[t + c] = src.data[s + c];
    }
  }
  return out;
}

/** Alpha-composite src over dst at (dx, dy), in place. */
export function blit(dst, src, dx, dy) {
  for (let y = 0; y < src.h; y++) {
    const ty = dy + y;
    if (ty < 0 || ty >= dst.h) continue;
    for (let x = 0; x < src.w; x++) {
      const tx = dx + x;
      if (tx < 0 || tx >= dst.w) continue;
      const s = (y * src.w + x) * 4, a = src.data[s + 3];
      if (!a) continue;
      const t = (ty * dst.w + tx) * 4;
      const ia = a / 255, ib = 1 - ia;
      for (let c = 0; c < 3; c++) dst.data[t + c] = Math.round(src.data[s + c] * ia + dst.data[t + c] * ib);
      dst.data[t + 3] = Math.max(dst.data[t + 3], a);
    }
  }
}

/** Tight bounding box of pixels with alpha above threshold; null if empty. */
export function alphaBBox(im, threshold = 40) {
  let x0 = 1e9, x1 = -1, y0 = 1e9, y1 = -1;
  for (let y = 0; y < im.h; y++)
    for (let x = 0; x < im.w; x++)
      if (im.data[(y * im.w + x) * 4 + 3] > threshold) {
        if (x < x0) x0 = x; if (x > x1) x1 = x;
        if (y < y0) y0 = y; if (y > y1) y1 = y;
      }
  return x1 < 0 ? null : { x0, y0, x1, y1, w: x1 - x0 + 1, h: y1 - y0 + 1 };
}

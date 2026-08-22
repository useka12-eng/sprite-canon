/* Core engine tests. Each test guards a lesson from production — if one of
   these fails, a bug we already shipped once is back. */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

import { readPng, writePng } from "../src/core/png.mjs";
import { decodeGif, encodeGif, patchPalettes } from "../src/core/gif.mjs";
import { loadFrames, saveFrames } from "../src/core/loader.mjs";
import { measureAnimation, measureFrame } from "../src/core/measure.mjs";
import { repaintFrame, regionCensus } from "../src/core/repaint.mjs";
import { checkPalette, checkJitter, checkProtected, checkLeftover, checkGroupSpread } from "../src/core/verify.mjs";
import { learnPalette, learnRegionFromPoints } from "../src/core/palette.mjs";
import { composeSheet } from "../src/core/sheet.mjs";
import { walkerFrame, walkerFrames, walkerGif, walkerPng, COLORS, walkerPalette } from "./fixtures.mjs";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "sprite-canon-"));
const T = (n) => path.join(tmp, n);

const CANON = {
  version: 1, name: "test",
  palette: { colors: walkerPalette() },
  regions: {
    outline: { light: [0, 0.1], protected: true },
    skin: { colors: [COLORS.skinA, COLORS.skinB], protected: true },
    eye: { colors: [COLORS.eye], protected: true },
    shirt: { colors: [COLORS.shirtDark, COLORS.shirtMid, COLORS.shirtLight], lumRange: [60, 160] },
    pants: { colors: [COLORS.pants] },
  },
  checks: { maxJitter: 2, maxGroupSpread: 48, alphaThreshold: 40, paletteTolerance: 0 },
};

/* ---------- codecs ---------- */
test("PNG round-trip is lossless", () => {
  const f = walkerFrame(0);
  const back = readPng(writePng(f));
  assert.equal(back.w, f.w);
  assert.deepEqual(back.data, f.data);
});

test("GIF round-trip is lossless for opaque pixels", () => {
  const frames = walkerFrames();
  const back = decodeGif(encodeGif(frames));
  assert.equal(back.length, frames.length);
  for (let i = 0; i < frames.length; i++) {
    for (let j = 0; j < 32 * 32; j++) {
      const a = frames[i].data, b = back[i].data, o = j * 4;
      assert.equal(a[o + 3] >= 128, b[o + 3] >= 128, `frame ${i} px ${j} alpha`);
      if (a[o + 3] < 128) continue;
      assert.deepEqual([b[o], b[o + 1], b[o + 2]], [a[o], a[o + 1], a[o + 2]], `frame ${i} px ${j}`);
    }
  }
});

test("GIF palette patch recolours every frame without touching indices", () => {
  const buf = walkerGif();
  const patched = patchPalettes(buf, { [COLORS.shirtMid]: "a04040" });
  assert.equal(patched.length, buf.length, "lossless patch must not change file size");
  const frames = decodeGif(patched);
  for (const f of frames) {
    let red = 0, green = 0;
    for (let i = 0; i < 32 * 32; i++) {
      const o = i * 4;
      if (f.data[o + 3] < 128) continue;
      const hex = [f.data[o], f.data[o + 1], f.data[o + 2]].map((v) => v.toString(16).padStart(2, "0")).join("");
      if (hex === "a04040") red++;
      if (hex === COLORS.shirtMid) green++;
    }
    assert.ok(red > 0, "patched colour appears");
    assert.equal(green, 0, "original colour fully replaced");
  }
});

/* ---------- loader ---------- */
test("spritesheet slicing skips empty cells and round-trips", () => {
  const sheet = { w: 64, h: 32, data: Buffer.alloc(64 * 32 * 4) };
  const f = walkerFrame(0);
  for (let y = 0; y < 32; y++) f.data.copy(sheet.data, (y * 64) * 4, y * 32 * 4, (y + 1) * 32 * 4);
  fs.writeFileSync(T("sheet.png"), writePng(sheet));
  const loaded = loadFrames(T("sheet.png"), { cellW: 32, cellH: 32 });
  assert.equal(loaded.frames.length, 1, "empty right cell skipped");
  saveFrames(T("sheet2.png"), loaded);
  const again = loadFrames(T("sheet2.png"), { cellW: 32, cellH: 32 });
  assert.deepEqual(again.frames[0].data, loaded.frames[0].data);
});

/* ---------- measure ---------- */
test("measure finds anatomy and arm-only jitter stays under threshold", () => {
  const { frames, jitter } = measureAnimation(walkerFrames(), CANON);
  assert.equal(frames[0].top, 3);
  assert.equal(frames[0].regionTop.skin, 4);
  assert.equal(frames[0].regionTop.eye, 8);
  assert.equal(jitter.top, 0, "head must not move");
  assert.ok(jitter.height <= 2, "arm swing is small");
});

/* ---------- repaint ---------- */
test("repaint is deterministic, keeps shading order, never touches protected", () => {
  const f = walkerFrame(0);
  const ramp = ["202060", "4040a0", "8080e0"];
  const a = repaintFrame(f, CANON, "shirt", ramp);
  const b = repaintFrame(f, CANON, "shirt", ramp);
  assert.deepEqual(a.data, b.data, "same input, same output");
  /* protected pixels byte-identical */
  const prot = checkProtected([a], [f], CANON);
  assert.ok(prot.pass, `protected intact: ${prot.details}`);
  /* no shirt colour left */
  const left = checkLeftover([a], [f], CANON, "shirt");
  assert.ok(left.pass, `no leftovers: ${left.details}`);
  /* shading order preserved: dark row must stay darker than light row */
  const lumAt = (im, x, y) => { const o = (y * im.w + x) * 4; return 0.299 * im.data[o] + 0.587 * im.data[o + 1] + 0.114 * im.data[o + 2]; };
  assert.ok(lumAt(a, 15, 18) < lumAt(a, 15, 12), "shirtDark row stays darker than shirtLight row");
});

test("fixed-range repaint gives the same output colour regardless of visible mix", () => {
  /* Frame A: full shirt. Frame B: same shirt but only the dark shade visible.
     With per-frame normalisation B's dark pixels would map to the ramp TOP —
     the exact "bright from behind" bug. Fixed range must keep them dark. */
  const full = walkerFrame(0);
  const darkOnly = walkerFrame(0);
  for (let i = 0; i < 32 * 32; i++) {
    const o = i * 4;
    const hex = [darkOnly.data[o], darkOnly.data[o + 1], darkOnly.data[o + 2]].map((v) => v.toString(16).padStart(2, "0")).join("");
    if (hex === COLORS.shirtMid || hex === COLORS.shirtLight) {
      /* overwrite mid/light shirt with dark shade */
      darkOnly.data[o] = 0x28; darkOnly.data[o + 1] = 0x70; darkOnly.data[o + 2] = 0x28;
    }
  }
  const ramp = ["202060", "8080e0"];
  const a = repaintFrame(full, CANON, "shirt", ramp);
  const b = repaintFrame(darkOnly, CANON, "shirt", ramp);
  const hexAt = (im, x, y) => { const o = (y * im.w + x) * 4; return [im.data[o], im.data[o + 1], im.data[o + 2]].map((v) => v.toString(16).padStart(2, "0")).join(""); };
  /* row 18 was shirtDark in BOTH frames → must repaint identically */
  assert.equal(hexAt(a, 15, 18), hexAt(b, 15, 18), "same source colour, same output colour, regardless of frame content");
});

/* ---------- verify ---------- */
test("palette check catches an off-palette pixel", () => {
  const f = walkerFrame(0);
  const bad = { w: f.w, h: f.h, data: Buffer.from(f.data) };
  const o = (15 * 32 + 15) * 4;
  bad.data[o] = 255; bad.data[o + 1] = 0; bad.data[o + 2] = 255;
  assert.ok(checkPalette([f], CANON).pass);
  const r = checkPalette([bad], CANON);
  assert.ok(!r.pass);
  assert.equal(r.value, 1);
});

test("jitter check catches a hat that jumps between frames", () => {
  const frames = walkerFrames();
  /* paint a 'hat' 3px above the head in frame 2 only → top row jumps 3px */
  const stamp = (f, y) => { for (let x = 12; x <= 19; x++) { const o = (y * 32 + x) * 4; f.data[o] = 0x60; f.data[o + 1] = 0x40; f.data[o + 2] = 0x20; f.data[o + 3] = 255; } };
  stamp(frames[2], 0);
  const r = checkJitter(frames, CANON);
  assert.ok(!r.pass, "moving top row must fail");
  assert.ok(r.value >= 3);
});

test("group spread catches 'bright from behind'", () => {
  const front = walkerFrame(0);
  const back = walkerFrame(0);
  /* brighten every shirt pixel in the 'back' view */
  for (let i = 0; i < 32 * 32; i++) {
    const o = i * 4;
    const hex = [back.data[o], back.data[o + 1], back.data[o + 2]].map((v) => v.toString(16).padStart(2, "0")).join("");
    if ([COLORS.shirtDark, COLORS.shirtMid].includes(hex)) { back.data[o] = 0x70; back.data[o + 1] = 0xc8; back.data[o + 2] = 0x70; }
  }
  const r = checkGroupSpread(
    [{ label: "front", frames: [front] }, { label: "back", frames: [back] }],
    CANON, "shirt", { maxGroupSpread: 30 });
  assert.ok(!r.pass, `spread must fail: ${r.details}`);
  assert.ok(r.value >= 40, `synthetic spread is ~42, got ${r.value}`);
});

test("protected check catches a repaint that hit the face", () => {
  const f = walkerFrame(0);
  const bad = { w: f.w, h: f.h, data: Buffer.from(f.data) };
  const o = (8 * 32 + 14) * 4;                        // an eye pixel
  bad.data[o] = 0; bad.data[o + 1] = 0; bad.data[o + 2] = 0;
  const r = checkProtected([bad], [f], CANON);
  assert.ok(!r.pass);
  assert.match(r.details, /eye/);
});

/* ---------- learning ---------- */
test("palette learning drops rare colours", () => {
  fs.writeFileSync(T("w.png"), walkerPng());
  const { colors } = learnPalette([T("w.png")], { minCount: 3 });
  assert.ok(colors.includes(COLORS.shirtMid));
  assert.ok(!colors.includes(COLORS.eye), "2 eye pixels < minCount 3");
});

test("region learning from points records colours and lum range", () => {
  fs.writeFileSync(T("w2.png"), walkerPng());
  const r = learnRegionFromPoints([{ file: T("w2.png"), points: [[15, 12], [15, 15], [15, 18]] }]);
  assert.deepEqual(new Set(r.colors), new Set([COLORS.shirtLight, COLORS.shirtMid, COLORS.shirtDark]));
  assert.ok(r.lumRange[0] < r.lumRange[1]);
});

/* ---------- sheet ---------- */
test("sheet composes and encodes", () => {
  const { png, cols } = composeSheet(
    [{ label: "walk", frames: walkerFrames() }],
    { zoom: 2 });
  assert.equal(cols, 4);
  const im = readPng(png);
  assert.ok(im.w > 32 * 2 * 4);
});

/* ---------- census ---------- */
test("region census accounts for every opaque pixel", () => {
  const { opaque, unmatched, counts } = regionCensus(walkerFrame(0), CANON);
  assert.equal(unmatched, 0, "walker canon covers all colours");
  const sum = Object.values(counts).reduce((a, b) => a + b, 0);
  assert.ok(sum >= opaque, "regions may overlap but must cover everything");
});

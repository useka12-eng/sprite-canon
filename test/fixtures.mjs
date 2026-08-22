/* Synthetic test sprite: a 32×32 "walker" with clearly separated regions,
   4 frames with a moving arm. Region colours are deliberate:
     outline #101010, skin #e8b090, eye #3060a0, shirt #40a040 (3 shades),
     pants #604020. Enough structure to exercise measure/verify/repaint
   without shipping any real game art. */
import { writePng } from "../src/core/png.mjs";
import { encodeGif } from "../src/core/gif.mjs";

export const COLORS = {
  outline: "101010",
  skinA: "e8b090", skinB: "d09878",
  eye: "3060a0",
  shirtDark: "287028", shirtMid: "40a040", shirtLight: "70c870",
  pants: "604020",
};

const put = (im, x, y, hex) => {
  if (x < 0 || y < 0 || x >= im.w || y >= im.h) return;
  const o = (y * im.w + x) * 4;
  im.data[o] = parseInt(hex.slice(0, 2), 16);
  im.data[o + 1] = parseInt(hex.slice(2, 4), 16);
  im.data[o + 2] = parseInt(hex.slice(4, 6), 16);
  im.data[o + 3] = 255;
};
const rect = (im, x0, y0, x1, y1, hex) => { for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) put(im, x, y, hex); };

/** One walker frame; armPhase shifts the left arm down by 0..2 px. */
export function walkerFrame(armPhase = 0) {
  const im = { w: 32, h: 32, data: Buffer.alloc(32 * 32 * 4) };
  rect(im, 12, 3, 19, 3, COLORS.outline);              // head top outline
  rect(im, 12, 4, 19, 10, COLORS.skinA);               // head
  rect(im, 13, 5, 18, 6, COLORS.skinB);                // forehead shading
  put(im, 14, 8, COLORS.eye); put(im, 17, 8, COLORS.eye);
  rect(im, 11, 4, 11, 10, COLORS.outline);             // head side outlines
  rect(im, 20, 4, 20, 10, COLORS.outline);
  rect(im, 13, 11, 18, 11, COLORS.skinB);              // neck
  rect(im, 10, 12, 21, 19, COLORS.shirtMid);           // torso
  rect(im, 10, 12, 21, 13, COLORS.shirtLight);
  rect(im, 10, 18, 21, 19, COLORS.shirtDark);
  rect(im, 9, 12, 9, 19, COLORS.outline);              // torso outlines
  rect(im, 22, 12, 22, 19, COLORS.outline);
  rect(im, 7, 13 + armPhase, 8, 17 + armPhase, COLORS.skinA);   // left arm (moves)
  rect(im, 23, 13, 24, 17, COLORS.skinA);              // right arm (static)
  rect(im, 12, 20, 15, 27, COLORS.pants);              // legs
  rect(im, 16, 20, 19, 27, COLORS.pants);
  rect(im, 12, 28, 15, 28, COLORS.outline);            // feet outline
  rect(im, 16, 28, 19, 28, COLORS.outline);
  return im;
}

export const walkerFrames = () => [0, 1, 2, 1].map((p) => {
  const f = walkerFrame(p);
  f.delay = 10;
  return f;
});

export const walkerPng = () => writePng(walkerFrame(0));
export const walkerGif = () => encodeGif(walkerFrames());

/** All deliberate colours of the walker (the "palette"). */
export const walkerPalette = () => Object.values(COLORS);

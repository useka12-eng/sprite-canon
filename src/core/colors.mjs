/* Colour utilities shared across the toolkit. */

export const hexToRgb = (h) => {
  const s = h.replace("#", "");
  return [parseInt(s.slice(0, 2), 16), parseInt(s.slice(2, 4), 16), parseInt(s.slice(4, 6), 16)];
};
export const rgbToHex = (r, g, b) => [r, g, b].map((v) => v.toString(16).padStart(2, "0")).join("");
export const lum = (r, g, b) => 0.299 * r + 0.587 * g + 0.114 * b;

export function hsl(r, g, b) {
  const R = r / 255, G = g / 255, B = b / 255;
  const mx = Math.max(R, G, B), mn = Math.min(R, G, B), d = mx - mn, L = (mx + mn) / 2;
  let H = 0, S = 0;
  if (d) {
    S = L > 0.5 ? d / (2 - mx - mn) : d / (mx + mn);
    H = mx === R ? ((G - B) / d + (G < B ? 6 : 0)) : mx === G ? (B - R) / d + 2 : (R - G) / d + 4;
    H *= 60;
  }
  return [H, S, L];
}

/** Squared RGB distance — cheap and adequate for pixel-art palettes. */
export const dist2 = (a, b) => (a[0] - b[0]) ** 2 + (a[1] - b[1]) ** 2 + (a[2] - b[2]) ** 2;

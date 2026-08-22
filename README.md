# sprite-canon

**MCP server that keeps AI-generated game sprites looking like ONE game.**

AI generators are great at making a pretty sprite and terrible at making it match the last one. Ask for the same character twice and the palette drifts, the outfit mutates, the new hat floats 3 pixels above the head — each asset is fine alone, and the game looks wrong assembled. Regenerating "until it matches" doesn't converge; it burns money and you can't diff the result.

sprite-canon takes the opposite approach, extracted from a real game project that generated ~4,000 frames and learned every lesson the hard way:

1. **Your consistency rules become data** — a `sprite-canon.json` ("the canon") holding the palette, named colour regions (skin, outfit, outline…), relative scale, and check thresholds. Committed next to your assets.
2. **Verification is numeric, not visual.** You cannot eyeball 96 outfit variants × 8 directions × 4 frames. `sprite_verify` returns hard pass/fail numbers for the defects that actually ship: off-palette pixels, accessories that jitter between frames, a region that's bright from behind and dark from the front, a repaint that touched the face.
3. **Fixes are deterministic pixel operations, not regeneration.** Repainting a region onto a new colour ramp preserves shading and silhouettes, never touches protected regions, and produces the same output every time. An outfit variant is one tool call, not a prompt lottery.

## Install

```bash
npm install
```

Register with Claude Code (project `.mcp.json`) or any MCP client:

```json
{
  "mcpServers": {
    "sprite-canon": {
      "command": "node",
      "args": ["/path/to/sprite-canon/src/mcp/server.mjs"]
    }
  }
}
```

Requires Node 18+. No native dependencies — the PNG/GIF codecs are self-contained.

## Tools

| Tool | What it does |
|---|---|
| `canon_init` | Create the canon; learn the palette from sample images (colours used ≥ N times — rarer ones are usually anti-aliasing noise) |
| `canon_learn` | Define a region by sampling a few pixels, listing colours, or an HSL rule. Records the region's luminance range. Mark face/outline `protected` |
| `canon_info` | Show the resolved canon + census a file against it (unmatched pixels = gaps in your region definitions) |
| `colors_inspect` | List colours actually used, by frequency and luminance — raw material for canon decisions |
| `sprite_measure` | Per-frame anatomy (bbox, cap/head width, waist row, first row of each region) + cross-frame jitter |
| `sprite_verify` | Numeric checks: `palette`, `jitter`, `spread`, `protected`, `leftover`, `scale` |
| `sprite_repaint` | Deterministically recolour a region onto a dark→light ramp; protected regions are untouchable |
| `sprite_sheet` | Zoomed contact sheet returned inline as an image — judge consistency on sheets, not in-game |
| `gif_patch` | Lossless GIF ops: palette substitution across **all** colour tables (zero generation loss), retiming |

Inputs can be PNGs, animated GIFs, or PNG spritesheets (`cellW`/`cellH`).

## The workflow

```text
canon_init      → learn the palette from your existing good assets
canon_learn     → sample skin / outfit / outline once; mark face + outline protected
sprite_measure  → read the numbers before placing anything ("where do the eyes start?")
sprite_repaint  → make variants deterministically (outfits, teams, seasons)
sprite_verify   → prove it: face untouched, nothing left over, no jitter, on palette
sprite_sheet    → look at the result as a sheet, zoomed, before it enters the game
```

## Lessons this tool encodes

These are not hypothetical — each one shipped as a real defect first:

- **Measure, don't assume proportions.** A hat brim placed at "52% of head height" landed exactly on the eyes: on a 20px head the eyes are 7–9px from the top, so *every* fixed ratio hits them. `sprite_measure` reports where the face actually starts, per frame.
- **Repaint with a fixed luminance range.** Normalising per image maps the same source colour to different outputs depending on how much of the region is visible — our hat was bright from behind, dark from the front. The canon records each region's range once; repaint always uses it.
- **Protect regions structurally.** "Be careful around the face" fails at scale. `protected: true` means repaint *cannot* touch it and verify *proves* it didn't.
- **Patch GIF palettes, don't re-encode.** An indexed GIF's colours live in its colour tables — global *and* per-frame local ones (patching only the global table is the classic half-fix). Substituting table entries re-dresses every frame in perfect sync with zero loss.
- **Region definitions have gaps; census them.** 12 stray pixels of the old colour surviving a repaint is invisible to the eye and obvious to `leftover`. When it fires, `canon_info`'s census shows which colours your regions don't cover.

## The scale table

`sprite_verify`'s `scale` check reads `canon.scale.heights` — relative sizes in units of a reference asset (the entry equal to `1`). No tool writes this section yet; add it to `sprite-canon.json` by hand:

```json
"scale": { "heights": { "hero": 1, "house": 3.4, "chicken": 0.45 } }
```

Then verify with `scaleNames` mapping file basenames to those keys. This catches the classic "the house is smaller than the hero" a week before your players do.

## Practical notes

- **Always pass `canonPath`** (or a file the canon sits above). A stdio MCP server's working directory belongs to the *client*, not your project, so the tools refuse to guess from cwd.
- Codec limits: PNG must be 8-bit, non-interlaced, RGB/RGBA/palette (the common pixel-art cases; 16-bit or interlaced files are rejected with a clear error). The GIF encoder is exact up to 255 opaque colours per file — beyond that, nearest-palette snapping.
- `sprite_sheet` returns the image inline up to ~800 KB; larger sheets return the file path only.
- Spritesheets round-trip cell-for-cell: empty cells stay empty, nothing is compacted.

## What this is not

- Not a generator. Pair it with whatever makes your art (PixelLab, Aseprite, Gemini, hand pixels); sprite-canon is the layer that keeps the results coherent.
- Not an atlas packer / collision tool — [sprite-tools](https://github.com/trebeljahr/sprite-tools) covers that well.
- Not magic: you spend ~10 minutes once per project teaching it your canon. That investment is exactly what makes every later check and fix trustworthy.

## Development

```bash
npm test          # unit + end-to-end MCP tests (22)
```

The test suite includes regression tests for every bug an adversarial multi-agent review found in v0.1 — sheet cell compaction, GIF disposal semantics, fake-success responses, silent zero-check passes. If one fails, a bug that already existed once is back.

MIT

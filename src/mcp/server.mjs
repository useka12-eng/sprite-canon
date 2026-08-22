#!/usr/bin/env node
/* sprite-canon MCP server.

   The pitch in one line: AI generators make pretty sprites that don't match
   each other; this server makes a project's consistency rules DATA (the canon)
   and gives agents tools to measure, verify and deterministically fix sprites
   against it — instead of regenerating and hoping.

   Every design choice here was paid for on a real game (a Stardew-like with
   ~4,000 generated frames): fixed-range repaint, protected regions, numeric
   verification with hard thresholds, contact sheets for review. See README. */
import fs from "node:fs";
import path from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

import { loadFrames, saveFrames } from "../core/loader.mjs";
import { writePng } from "../core/png.mjs";
import { encodeGif, patchPalettes } from "../core/gif.mjs";
import {
  CANON_FILE, findCanon, loadCanon, saveCanon, computeLumRange, DEFAULT_CHECKS,
} from "../core/canon.mjs";
import { learnPalette, learnRegionFromPoints, collectColors } from "../core/palette.mjs";
import { measureAnimation } from "../core/measure.mjs";
import { repaintFrame, regionCensus } from "../core/repaint.mjs";
import {
  checkPalette, checkJitter, checkGroupSpread, checkProtected, checkLeftover, checkScale, summarize,
} from "../core/verify.mjs";
import { composeSheet } from "../core/sheet.mjs";

const server = new McpServer({ name: "sprite-canon", version: "0.1.0" });

/* ---------- helpers ---------- */
const ok = (obj) => ({ content: [{ type: "text", text: JSON.stringify(obj, null, 2) }] });
const fail = (msg) => ({ content: [{ type: "text", text: JSON.stringify({ error: msg }) }], isError: true });

function resolveCanon(canonPath, fileHint) {
  /* No process.cwd() fallback: a stdio MCP server's cwd belongs to the CLIENT
     (Claude Desktop launches servers from "/" on macOS and its install dir on
     Windows), so cwd-relative discovery would either always fail or silently
     pick up an unrelated project's canon higher in the tree. */
  if (!canonPath && !fileHint)
    throw new Error(`pass canonPath — without a target file there is nothing to search from (the MCP server's working directory is not your project)`);
  const p = canonPath ?? findCanon(path.dirname(path.resolve(fileHint)));
  if (!p) throw new Error(`no ${CANON_FILE} found — run canon_init first (searched upward from ${fileHint})`);
  return { path: p, canon: loadCanon(p) };
}

function expandFiles(files) {
  const out = [];
  for (const f of files) {
    const st = fs.existsSync(f) && fs.statSync(f);
    if (!st) throw new Error(`not found: ${f}`);
    if (st.isDirectory()) {
      /* sorted — readdir order is filesystem-dependent, and positional
         pairing of two directory listings must not depend on it */
      for (const e of fs.readdirSync(f).sort())
        if (/\.(png|gif)$/i.test(e)) out.push(path.join(f, e));
    } else out.push(f);
  }
  return out;
}

const cellOpts = { cellW: z.number().int().positive().optional().describe("spritesheet cell width (PNG sheets only)"), cellH: z.number().int().positive().optional().describe("spritesheet cell height (PNG sheets only)") };
const canonOpt = { canonPath: z.string().optional().describe("path to sprite-canon.json (default: search upward from the target file)") };

/* ---------- canon_init ---------- */
server.registerTool("canon_init", {
  description:
    "Create sprite-canon.json for a project: the single source of truth for palette, regions, scale and check thresholds. " +
    "Learns the palette from sample images (colours used at least minCount times; rarer colours are usually anti-aliasing noise). " +
    "Run once per project, then commit the file.",
  inputSchema: {
    dir: z.string().describe("project directory to create sprite-canon.json in"),
    name: z.string().optional().describe("project name"),
    sampleFiles: z.array(z.string()).optional().describe("PNG/GIF files or directories to learn the palette from"),
    minCount: z.number().int().optional().describe("min occurrences for a colour to enter the palette (default 4)"),
    updatePalette: z.boolean().optional().describe("relearn just the palette of an EXISTING canon from sampleFiles (regions/scale/checks untouched)"),
    ...cellOpts,
  },
}, async (a) => {
  try {
    const p = path.join(a.dir, CANON_FILE);
    if (fs.existsSync(p) && !a.updatePalette)
      return fail(`${p} already exists — pass updatePalette=true to relearn just the palette, or edit the file directly`);
    const canon = fs.existsSync(p)
      ? loadCanon(p)
      : { version: 1, name: a.name ?? path.basename(path.resolve(a.dir)), regions: {}, checks: { ...DEFAULT_CHECKS } };
    let learned = null;
    if (a.sampleFiles?.length) {
      learned = learnPalette(expandFiles(a.sampleFiles), { minCount: a.minCount, cellW: a.cellW, cellH: a.cellH });
      canon.palette = { colors: learned.colors };
    } else if (a.updatePalette) {
      return fail("updatePalette=true needs sampleFiles to learn from");
    }
    saveCanon(p, canon);
    return ok({
      created: p,
      palette: learned ? { colors: learned.colors.length, droppedRareColors: learned.dropped } : "none — rerun canon_init with sampleFiles and updatePalette=true to add one",
      next: "define regions with canon_learn (sample a few pixels per region), mark face/outline regions protected",
    });
  } catch (e) { return fail(e.message); }
});

/* ---------- canon_learn ---------- */
server.registerTool("canon_learn", {
  description:
    "Define or update a named region in the canon (e.g. skin, hair, outfit, outline). " +
    "Give a few [x,y] points on sample images; the sampled colours (optionally expanded by `absorb`) become the region. " +
    "The region's luminance range is recorded — repaint uses that FIXED range so the same source colour always maps to the same output colour in every frame and direction. " +
    "Mark regions like face/eyes/outline as protected: repaint will never touch them and verify will fail if anything else does. " +
    "Instead of points you may pass explicit `colors`, or an HSL rule (hue/sat/light ranges) for anti-aliased art — an HSL-only region additionally needs `lumRange` if you ever want to repaint it. " +
    "Updates MERGE additively into an existing region; pass replace=true to redefine it from scratch (the only way to remove a mis-sampled colour).",
  inputSchema: {
    region: z.string().describe("region name, e.g. 'skin' / 'outline' / 'cloak'"),
    samples: z.array(z.object({
      file: z.string(),
      frame: z.number().int().optional().describe("frame index for GIF/sheet (default 0)"),
      points: z.array(z.tuple([z.number().int(), z.number().int()])).describe("[x,y] pixel positions"),
    })).optional(),
    colors: z.array(z.string()).optional().describe("explicit hex colours instead of samples"),
    hue: z.tuple([z.number(), z.number()]).optional().describe("HSL rule: hue range in degrees"),
    sat: z.tuple([z.number(), z.number()]).optional().describe("HSL rule: saturation range 0..1"),
    light: z.tuple([z.number(), z.number()]).optional().describe("HSL rule: lightness range 0..1"),
    lumRange: z.tuple([z.number(), z.number()]).optional().describe("fixed luminance range (0-255) for repainting — required for HSL-only regions, auto-computed for colour lists"),
    absorb: z.number().int().optional().describe("also absorb colours within this per-channel distance of sampled ones (default 0)"),
    replace: z.boolean().optional().describe("redefine the region from scratch instead of merging (default false)"),
    protected: z.boolean().optional().describe("mark as protected (never repainted, verified untouched)"),
    ...canonOpt, ...cellOpts,
  },
}, async (a) => {
  try {
    const { path: p, canon } = resolveCanon(a.canonPath, a.samples?.[0]?.file);
    const def = a.replace ? {} : (canon.regions[a.region] ?? {});
    if (a.samples?.length) {
      const learned = learnRegionFromPoints(a.samples, { spread: a.absorb, cellW: a.cellW, cellH: a.cellH });
      def.colors = [...new Set([...(def.colors ?? []), ...learned.colors])];
      def.lumRange = computeLumRange(def);
    }
    if (a.colors) { def.colors = [...new Set([...(def.colors ?? []), ...a.colors.map((c) => c.replace("#", "").toLowerCase())])]; def.lumRange = computeLumRange(def); }
    if (a.hue) def.hue = a.hue;
    if (a.sat) def.sat = a.sat;
    if (a.light) def.light = a.light;
    if (a.lumRange) def.lumRange = a.lumRange;
    if (a.protected !== undefined) def.protected = a.protected;
    if (!def.colors && !def.hue && !def.sat && !def.light)
      return fail("give samples, colors, or an HSL rule");
    canon.regions[a.region] = def;
    saveCanon(p, canon);
    return ok({
      canon: p, region: a.region, merged: !a.replace && !!canon.regions[a.region],
      colors: def.colors?.length ?? 0, lumRange: def.lumRange ?? null,
      rule: { hue: def.hue, sat: def.sat, light: def.light },
      protected: !!def.protected,
      ...(def.lumRange == null && !def.colors ? { warning: "HSL-only region without lumRange — sprite_repaint will refuse it until you set lumRange" } : {}),
    });
  } catch (e) { return fail(e.message); }
});

/* ---------- sprite_measure ---------- */
server.registerTool("sprite_measure", {
  description:
    "Measure a sprite's anatomy per frame and its cross-frame jitter: bounding box, top row, widest row, cap (head) width, waist (neck) row, and — with canon regions — the first row of each region (e.g. where the face starts). " +
    "Use before placing anything relative to a sprite: measured rows beat guessed proportions. Real bug this catches: a hat brim placed at '52% of head height' landed exactly on the eyes, because eye rows vary per frame — measure, don't assume.",
  inputSchema: {
    file: z.string().describe("PNG / GIF / spritesheet"),
    ...canonOpt, ...cellOpts,
  },
}, async (a) => {
  try {
    let canon = null;
    try { canon = resolveCanon(a.canonPath, a.file).canon; } catch { /* measuring without a canon is fine */ }
    const { frames } = loadFrames(a.file, a);
    const m = measureAnimation(frames, canon);
    /* canonUsed tells the caller whether missing regionTop fields mean
       "no such region in this sprite" or "no canon was loaded at all" */
    return ok({ file: a.file, frameCount: frames.length, canonUsed: !!canon, ...m });
  } catch (e) { return fail(e.message); }
});

/* ---------- sprite_verify ---------- */
server.registerTool("sprite_verify", {
  description:
    "Run numeric consistency checks and get hard pass/fail numbers — the replacement for eyeballing hundreds of frames. " +
    "Checks: 'palette' (every pixel on the canon palette), 'jitter' (landmarks stay put across frames), 'spread' (a region's mean luminance agrees across a file group — catches 'bright from behind, dark from the front'), " +
    "'protected' (vs baseFile: face/outline pixels untouched), 'leftover' (vs baseFile: no source-region pixel survived inside a repainted area), 'scale' (relative sizes match the canon table). " +
    "Files may be directories (all PNG/GIF inside).",
  inputSchema: {
    files: z.array(z.string()).describe("files or directories to verify"),
    checks: z.array(z.enum(["palette", "jitter", "spread", "protected", "leftover", "scale"])).optional()
      .describe("which checks to run (default: palette + jitter)"),
    baseFiles: z.array(z.string()).optional().describe("originals for 'protected'/'leftover'. Paired to files by identical filename (case-insensitive) when names line up, otherwise by list position (equal lengths required). Each result echoes which base it was compared against."),
    region: z.string().optional().describe("region name for 'spread'/'leftover'"),
    scaleNames: z.record(z.string(), z.string()).optional().describe("for 'scale': map of filename -> name in canon.scale.heights"),
    ...canonOpt, ...cellOpts,
  },
}, async (a) => {
  try {
    const files = expandFiles(a.files);
    if (!files.length) return fail("no files");
    const { canon } = resolveCanon(a.canonPath, files[0]);
    const wanted = a.checks ?? ["palette", "jitter"];
    const loadedAll = files.map((f) => ({ file: f, label: path.basename(f), frames: loadFrames(f, a).frames }));

    /* Base pairing. By FILENAME first (case-insensitive — Windows/macOS
       filesystems ignore case) whenever every file has exactly one matching
       base; positional only as a fallback for equal-length lists with
       non-matching names (variant files are usually renamed). The pairing is
       echoed in each file's result so a wrong pairing is visible, not silent. */
    let baseFor = () => null;
    if (a.baseFiles) {
      const bases = expandFiles(a.baseFiles);
      const byName = new Map();
      for (const f of bases) {
        const k = path.basename(f).toLowerCase();
        byName.set(k, byName.has(k) ? null : f);       // null = ambiguous duplicate
      }
      const allNamed = files.every((f) => byName.get(path.basename(f).toLowerCase()));
      if (allNamed) baseFor = (file) => byName.get(path.basename(file).toLowerCase());
      else if (bases.length === files.length) {
        const byIndex = new Map(files.map((f, i) => [f, bases[i]]));
        baseFor = (file) => byIndex.get(file);
      }
    }

    const results = [];
    const perFile = [];
    let checksRun = 0;
    for (const it of loadedAll) {
      const fileChecks = [];
      let pairedBase = null;
      if (wanted.includes("palette")) fileChecks.push(checkPalette(it.frames, canon));
      if (wanted.includes("jitter")) {
        if (it.frames.length > 1) fileChecks.push(checkJitter(it.frames, canon));
        else fileChecks.push({ name: "jitter", pass: true, skipped: true, value: 0, limit: 0, details: "single frame — nothing to jitter, skipped" });
      }
      if ((wanted.includes("protected") || wanted.includes("leftover"))) {
        const basePath = baseFor(it.file);
        if (!basePath) {
          fileChecks.push({ name: "pairing", pass: false, value: -1, limit: 0, details: `no base file paired with ${it.label} — pairing is by identical filename (case-insensitive), or by position when both lists have equal length` });
        } else {
          pairedBase = path.basename(basePath);
          const baseFrames = loadFrames(basePath, a).frames;
          if (wanted.includes("protected")) fileChecks.push(checkProtected(it.frames, baseFrames, canon));
          if (wanted.includes("leftover")) {
            if (!a.region) return fail("'leftover' needs `region`");
            fileChecks.push(checkLeftover(it.frames, baseFrames, canon, a.region));
          }
        }
      }
      checksRun += fileChecks.filter((c) => !c.skipped).length;
      if (fileChecks.length) perFile.push({ file: it.label, ...(pairedBase ? { base: pairedBase } : {}), ...summarize(fileChecks) });
    }
    if (wanted.includes("spread")) {
      if (!a.region) return fail("'spread' needs `region`");
      results.push(checkGroupSpread(loadedAll, canon, a.region));
      checksRun++;
    }
    if (wanted.includes("scale")) {
      if (!a.scaleNames) return fail("'scale' needs `scaleNames`");
      /* accept full paths or basenames as keys, case-insensitively */
      const nameOf = new Map(Object.entries(a.scaleNames).map(([k, v]) => [path.basename(k).toLowerCase(), v]));
      const items = loadedAll
        .filter((it) => nameOf.get(it.label.toLowerCase()))
        .map((it) => ({ ...it, name: nameOf.get(it.label.toLowerCase()) }));
      results.push(checkScale(items, canon));
      checksRun++;
    }
    /* "everything passed" must never mean "nothing ran" */
    if (checksRun === 0)
      return ok({ pass: false, files: perFile, group: results, warning: "no checks actually ran — nothing was verified (e.g. 'jitter' on single-frame files)" });
    const pass = perFile.every((f) => f.pass) && results.every((c) => c.pass);
    return ok({ pass, checksRun, files: perFile, group: results });
  } catch (e) { return fail(e.message); }
});

/* ---------- sprite_repaint ---------- */
server.registerTool("sprite_repaint", {
  description:
    "Deterministically recolour a canon region onto a colour ramp (dark→light hex list) — the alternative to regenerating with AI and losing consistency. " +
    "Shading survives (luminance maps onto the ramp using the region's FIXED recorded range), silhouettes never change, protected regions are never touched, and the same input always gives the same output. " +
    "Use maskFromFile when repainting an already-recoloured variant: regions are matched on the original (identical pixel layout), paint is applied to the variant. " +
    "Writes to outFile (never overwrites the input unless outFile equals it).",
  inputSchema: {
    file: z.string(),
    region: z.string().describe("canon region to repaint"),
    ramp: z.array(z.string()).min(2).describe("hex colours dark→light, e.g. ['4a3418','7a5628','a8813c','cfae6b']"),
    outFile: z.string(),
    maskFromFile: z.string().optional().describe("match the region on this file instead (same pixel layout)"),
    rows: z.tuple([z.number().int(), z.number().int()]).optional().describe("restrict painting to this row range [from,to]"),
    ...canonOpt, ...cellOpts,
  },
}, async (a) => {
  try {
    const { canon } = resolveCanon(a.canonPath, a.file);
    const loaded = loadFrames(a.file, a);
    const maskLoaded = a.maskFromFile ? loadFrames(a.maskFromFile, a) : null;
    if (maskLoaded && maskLoaded.frames.length !== loaded.frames.length)
      return fail(`maskFromFile has ${maskLoaded.frames.length} frames but target has ${loaded.frames.length}`);
    const ramp = a.ramp.map((c) => c.replace("#", "").toLowerCase());
    loaded.frames = loaded.frames.map((f, i) =>
      repaintFrame(f, canon, a.region, ramp, {
        maskFrom: maskLoaded?.frames[i],
        rows: a.rows,
      }));
    fs.mkdirSync(path.dirname(path.resolve(a.outFile)), { recursive: true });
    saveFrames(a.outFile, loaded);
    const census = regionCensus(loaded.frames[0], canon);
    return ok({
      wrote: a.outFile, frames: loaded.frames.length, region: a.region,
      note: "run sprite_verify with checks ['protected','leftover'] against the original to prove the repaint is clean",
      firstFrameRegionCensus: census.counts,
    });
  } catch (e) { return fail(e.message); }
});

/* ---------- sprite_sheet ---------- */
server.registerTool("sprite_sheet", {
  description:
    "Compose a zoomed contact sheet (PNG on a checkerboard) from sprites — one row per file, one column per frame — and return it as an image so you can LOOK at what you just made. " +
    "Judge consistency on sheets, not in-game: every visual defect we ever caught was caught on a sheet. Use crop to zoom into the area under suspicion (e.g. just the head).",
  inputSchema: {
    files: z.array(z.string()).describe("files or directories; each file becomes a row"),
    outFile: z.string().describe("where to write the sheet PNG"),
    zoom: z.number().int().min(1).max(20).optional().describe("pixel zoom (default 4)"),
    maxFrames: z.number().int().optional().describe("max frames per row (default 8)"),
    crop: z.object({ x: z.number().int(), y: z.number().int(), w: z.number().int(), h: z.number().int() }).optional()
      .describe("crop every cell to this rect before zooming"),
    returnImage: z.boolean().optional().describe("also return the sheet inline as an image (default true; sheets over ~800KB are returned as path only)"),
    ...cellOpts,
  },
}, async (a) => {
  try {
    const files = expandFiles(a.files);
    if (!files.length) return fail("no files");
    const maxFrames = a.maxFrames ?? 8;
    const rows = files.map((f) => ({
      label: path.basename(f),
      frames: loadFrames(f, a).frames.slice(0, maxFrames),
    }));
    const { png } = composeSheet(rows, { zoom: a.zoom ?? 4, crop: a.crop });
    fs.mkdirSync(path.dirname(path.resolve(a.outFile)), { recursive: true });
    fs.writeFileSync(a.outFile, png);
    const content = [{ type: "text", text: JSON.stringify({ wrote: a.outFile, rows: rows.map((r) => r.label), bytes: png.length }) }];
    if ((a.returnImage ?? true) && png.length < 800 * 1024)
      content.push({ type: "image", data: png.toString("base64"), mimeType: "image/png" });
    return { content };
  } catch (e) { return fail(e.message); }
});

/* ---------- gif_patch ---------- */
server.registerTool("gif_patch", {
  description:
    "Operations on animated GIFs. " +
    "'palette' swaps colours in every colour table (global AND per-frame local — patching only the global table is a classic half-fix) without touching frame data: zero generation loss, every frame changes in perfect sync — the correct way to re-dress an indexed sprite. The response reports how many table entries each source colour actually matched; 0 means that hex isn't in the file (use colors_inspect to find the exact hexes). " +
    "'retime' re-times all frames to msPerFrame. GIF delays are quantised to 10ms steps with a 20ms minimum; pixels survive a decode/re-encode that is exact up to 255 opaque colours (beyond that, nearest-palette snapping). Real bug this fixes: an animation authored at 1.8s being cut off by game code that frees the sprite after 0.62s — retime the GIF instead of dropping frames.",
  inputSchema: {
    file: z.string(),
    outFile: z.string(),
    action: z.enum(["palette", "retime"]),
    colorMap: z.record(z.string(), z.string()).optional().describe("for 'palette': { fromHex: toHex, ... }"),
    msPerFrame: z.number().optional().describe("for 'retime': delay per frame in ms (quantised to 10ms steps, min 20ms)"),
  },
}, async (a) => {
  try {
    const buf = fs.readFileSync(a.file);
    if (buf.toString("ascii", 0, 3) !== "GIF") return fail("not a GIF");
    fs.mkdirSync(path.dirname(path.resolve(a.outFile)), { recursive: true });
    if (a.action === "palette") {
      if (!a.colorMap) return fail("'palette' needs colorMap");
      const { buffer, replaced } = patchPalettes(buf, a.colorMap);
      fs.writeFileSync(a.outFile, buffer);
      const misses = Object.entries(replaced).filter(([, n]) => n === 0).map(([h]) => h);
      return ok({
        wrote: a.outFile, replaced,
        ...(misses.length ? { warning: `no colour table contains: ${misses.join(", ")} — nothing changed for those. Use colors_inspect on the file to find the exact hexes.` } : { note: "frame data untouched — lossless" }),
      });
    }
    if (a.msPerFrame == null) return fail("'retime' needs msPerFrame");
    const { frames } = loadFrames(a.file);
    const delay = Math.max(2, Math.round(a.msPerFrame / 10));
    frames.forEach((f) => { f.delay = delay; });
    fs.writeFileSync(a.outFile, encodeGif(frames));
    return ok({ wrote: a.outFile, frames: frames.length, totalMs: frames.length * delay * 10 });
  } catch (e) { return fail(e.message); }
});

/* ---------- canon_info ---------- */
server.registerTool("canon_info", {
  description:
    "Show the resolved canon (palette size, regions with their rules and protection flags, scale table, thresholds) and optionally census a file against it — how many pixels each region matches, and how many match nothing (unmatched pixels mean your region definitions have gaps). " +
    "Pass canonPath or censusFile — without either there is nowhere to search from (the server's working directory is the client's, not your project's).",
  inputSchema: {
    ...canonOpt,
    censusFile: z.string().optional().describe("count region membership of this file's first frame (also used as the search origin for the canon)"),
    listColors: z.boolean().optional().describe("include the full palette hex list"),
    ...cellOpts,
  },
}, async (a) => {
  try {
    const { path: p, canon } = resolveCanon(a.canonPath, a.censusFile);
    const out = {
      canon: p,
      name: canon.name,
      palette: canon.palette ? { colors: canon.palette.colors.length, ...(a.listColors ? { list: canon.palette.colors } : {}) } : null,
      regions: Object.fromEntries(Object.entries(canon.regions).map(([n, d]) => [n, {
        colors: d.colors?.length ?? 0, lumRange: d.lumRange ?? null,
        rule: (d.hue || d.sat || d.light) ? { hue: d.hue, sat: d.sat, light: d.light } : null,
        protected: !!d.protected,
      }])),
      scale: canon.scale ?? null,
      checks: canon.checks,
    };
    if (a.censusFile) {
      const { frames } = loadFrames(a.censusFile, a);
      out.census = regionCensus(frames[0], canon);
    }
    return ok(out);
  } catch (e) { return fail(e.message); }
});

/* ---------- colors_inspect ---------- */
server.registerTool("colors_inspect", {
  description:
    "List the colours actually used in files, sorted by frequency, with luminance — the raw material for canon_init/canon_learn decisions. Use it to spot near-duplicate colours, anti-aliasing noise, and which hexes belong to which visual part before defining regions.",
  inputSchema: {
    files: z.array(z.string()),
    top: z.number().int().optional().describe("how many colours to list (default 40)"),
    ...cellOpts,
  },
}, async (a) => {
  try {
    const files = expandFiles(a.files);
    const all = collectColors(files, a);
    const { lum } = await import("../core/colors.mjs");
    const { hexToRgb } = await import("../core/colors.mjs");
    return ok({
      files: files.length,
      distinctColors: all.length,
      colors: all.slice(0, a.top ?? 40).map((c) => ({ ...c, lum: Math.round(lum(...hexToRgb(c.hex))) })),
    });
  } catch (e) { return fail(e.message); }
});

await server.connect(new StdioServerTransport());

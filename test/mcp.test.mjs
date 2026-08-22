/* End-to-end MCP test: spawn the real server over stdio with the SDK client
   and walk the full workflow a game project would use:
   init canon → learn regions → measure → repaint → verify → sheet → gif patch. */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { walkerPng, walkerGif, COLORS } from "./fixtures.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SERVER = path.join(__dirname, "..", "src", "mcp", "server.mjs");

let client, dir;
const j = (res) => {
  assert.ok(!res.isError, `tool error: ${res.content?.[0]?.text}`);
  return JSON.parse(res.content.find((c) => c.type === "text").text);
};
const call = (name, args) => client.callTool({ name, arguments: args });

before(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "sc-mcp-"));
  fs.writeFileSync(path.join(dir, "walker.png"), walkerPng());
  fs.writeFileSync(path.join(dir, "walk.gif"), walkerGif());
  client = new Client({ name: "test", version: "0.0.0" });
  await client.connect(new StdioClientTransport({ command: process.execPath, args: [SERVER] }));
});
after(async () => { await client.close(); });

test("tools are listed", async () => {
  const { tools } = await client.listTools();
  const names = tools.map((t) => t.name).sort();
  assert.deepEqual(names, [
    "canon_info", "canon_init", "canon_learn", "colors_inspect",
    "gif_patch", "sprite_measure", "sprite_repaint", "sprite_sheet", "sprite_verify",
  ]);
});

test("full workflow", async () => {
  /* 1. init with learned palette */
  const init = j(await call("canon_init", { dir, name: "walker-game", sampleFiles: [path.join(dir, "walker.png")], minCount: 2 }));
  assert.ok(fs.existsSync(path.join(dir, "sprite-canon.json")));
  assert.ok(init.palette.colors >= 6);

  /* 2. learn regions: shirt by points, protected face by colours, outline by rule */
  j(await call("canon_learn", {
    region: "shirt", canonPath: path.join(dir, "sprite-canon.json"),
    samples: [{ file: path.join(dir, "walker.png"), points: [[15, 12], [15, 15], [15, 18]] }],
  }));
  j(await call("canon_learn", {
    region: "skin", canonPath: path.join(dir, "sprite-canon.json"),
    colors: [COLORS.skinA, COLORS.skinB], protected: true,
  }));
  j(await call("canon_learn", {
    region: "eye", canonPath: path.join(dir, "sprite-canon.json"),
    colors: [COLORS.eye], protected: true,
  }));
  j(await call("canon_learn", {
    region: "outline", canonPath: path.join(dir, "sprite-canon.json"),
    light: [0, 0.1], protected: true,
  }));
  const info = j(await call("canon_info", { canonPath: path.join(dir, "sprite-canon.json"), censusFile: path.join(dir, "walker.png") }));
  assert.equal(info.regions.shirt.colors, 3);
  assert.ok(info.regions.skin.protected);
  assert.ok(info.census.counts.shirt > 50);

  /* 3. measure the GIF */
  const m = j(await call("sprite_measure", { file: path.join(dir, "walk.gif"), canonPath: path.join(dir, "sprite-canon.json") }));
  assert.equal(m.frameCount, 4);
  assert.equal(m.jitter.top, 0);
  assert.equal(m.frames[0].regionTop.eye, 8);

  /* 4. repaint shirt to blue on the GIF */
  const out = path.join(dir, "walk-blue.gif");
  const rp = j(await call("sprite_repaint", {
    file: path.join(dir, "walk.gif"), region: "shirt",
    ramp: ["202060", "4040a0", "8080e0"], outFile: out,
    canonPath: path.join(dir, "sprite-canon.json"),
  }));
  assert.equal(rp.frames, 4);

  /* 5. verify the repaint: protected intact, no leftovers, jitter unchanged */
  const v = j(await call("sprite_verify", {
    files: [out], baseFiles: [path.join(dir, "walk.gif")],
    checks: ["jitter", "protected", "leftover"], region: "shirt",
    canonPath: path.join(dir, "sprite-canon.json"),
  }));
  assert.ok(v.pass, JSON.stringify(v, null, 2));

  /* 6. palette check must FAIL on the blue variant (blue is not in the canon) */
  const vp = j(await call("sprite_verify", {
    files: [out], checks: ["palette"], canonPath: path.join(dir, "sprite-canon.json"),
  }));
  assert.ok(!vp.pass, "blue ramp is off-palette — check must catch it");

  /* 7. sheet returns an inline image */
  const sheetRes = await call("sprite_sheet", {
    files: [path.join(dir, "walk.gif"), out],
    outFile: path.join(dir, "sheet.png"), zoom: 3,
  });
  assert.ok(!sheetRes.isError);
  assert.ok(sheetRes.content.some((c) => c.type === "image"), "sheet returned inline");
  assert.ok(fs.existsSync(path.join(dir, "sheet.png")));

  /* 8. lossless gif palette patch — response reports REAL substitution counts */
  const gp = j(await call("gif_patch", {
    file: path.join(dir, "walk.gif"), outFile: path.join(dir, "walk-red.gif"),
    action: "palette", colorMap: { [COLORS.shirtMid]: "a04040" },
  }));
  assert.ok(gp.replaced[COLORS.shirtMid] >= 1);
  assert.equal(fs.statSync(path.join(dir, "walk-red.gif")).size, fs.statSync(path.join(dir, "walk.gif")).size);
  /* a typo'd hex must warn, not fake success */
  const gpMiss = j(await call("gif_patch", {
    file: path.join(dir, "walk.gif"), outFile: path.join(dir, "walk-x.gif"),
    action: "palette", colorMap: { deadbe: "a04040" },
  }));
  assert.equal(gpMiss.replaced.deadbe, 0);
  assert.match(gpMiss.warning, /colors_inspect/);

  /* 9. retime */
  const rt = j(await call("gif_patch", {
    file: path.join(dir, "walk.gif"), outFile: path.join(dir, "walk-80.gif"),
    action: "retime", msPerFrame: 80,
  }));
  assert.equal(rt.totalMs, 320);
});

test("colors_inspect lists frequencies", async () => {
  const r = j(await call("colors_inspect", { files: [path.join(dir, "walker.png")], top: 5 }));
  assert.ok(r.distinctColors >= 8);
  assert.ok(r.colors[0].count > r.colors[4].count);
});

test("verify refuses to claim pass when no check actually ran", async () => {
  const res = j(await call("sprite_verify", {
    files: [path.join(dir, "walker.png")], checks: ["jitter"],   // single frame → jitter has nothing to do
    canonPath: path.join(dir, "sprite-canon.json"),
  }));
  assert.equal(res.pass, false);
  assert.match(res.warning, /no checks actually ran/);
});

test("base pairing is by filename when names align, and is echoed in the result", async () => {
  /* same filename in two dirs → by-name pairing regardless of order */
  const oDir = path.join(dir, "orig"), vDir = path.join(dir, "vari");
  fs.mkdirSync(oDir, { recursive: true }); fs.mkdirSync(vDir, { recursive: true });
  fs.writeFileSync(path.join(oDir, "walker.png"), walkerPng());
  fs.writeFileSync(path.join(vDir, "walker.png"), walkerPng());
  const res = j(await call("sprite_verify", {
    files: [vDir], baseFiles: [oDir], checks: ["protected"],
    canonPath: path.join(dir, "sprite-canon.json"),
  }));
  assert.ok(res.pass, JSON.stringify(res));
  assert.equal(res.files[0].base, "walker.png", "pairing is visible in the result");
});

test("helpful error when canon is missing", async () => {
  const orphan = fs.mkdtempSync(path.join(os.tmpdir(), "sc-none-"));
  fs.writeFileSync(path.join(orphan, "x.png"), walkerPng());
  const res = await call("sprite_verify", { files: [path.join(orphan, "x.png")] });
  assert.ok(res.isError);
  assert.match(res.content[0].text, /canon_init/);
});

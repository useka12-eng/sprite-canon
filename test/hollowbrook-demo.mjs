/* Real-world demo: run sprite-canon against an actual game's assets
   (Hollowbrook — the project this toolkit was extracted from).
   Not part of the test suite (game assets aren't shipped with the package);
   run manually:  node test/hollowbrook-demo.mjs <path-to-hollowbrook>  */
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SERVER = path.join(__dirname, "..", "src", "mcp", "server.mjs");
const HB = process.argv[2] ?? path.join(__dirname, "..", "..", "hollowbrook");
const CH = path.join(HB, "admin", "gallery", "characters");
if (!fs.existsSync(CH)) { console.error("hollowbrook assets not found at " + HB); process.exit(1); }

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sc-demo-"));
const client = new Client({ name: "demo", version: "0.0.0" });
await client.connect(new StdioClientTransport({ command: process.execPath, args: [SERVER] }));
const call = async (name, args) => {
  const res = await client.callTool({ name, arguments: args });
  const text = res.content.find((c) => c.type === "text")?.text;
  if (res.isError) throw new Error(`${name}: ${text}`);
  return JSON.parse(text);
};

const canonPath = path.join(dir, "sprite-canon.json");
const walks = ["s", "se", "e", "ne", "n", "nw", "w", "sw"].map((d) => path.join(CH, `hero-female-walk-${d}.gif`));

/* 1. canon from the hero's own sprites */
const init = await call("canon_init", { dir, name: "hollowbrook", sampleFiles: walks, minCount: 4 });
console.log("[1] canon_init:", init.palette);

/* 2. regions — the same canon Hollowbrook uses, registered through the public API */
const REGIONS = {
  cloth: { colors: ["1e3219", "203618", "21361a", "1e371b", "233d1f", "213d1c", "243e1c", "30432a", "36432b", "36452b", "334928", "304b2a", "314c2b", "325129", "32512b", "34512f", "35512b", "35562a", "36562a", "355728", "385e38", "495e39", "416436", "49623d", "3c6832", "4d662f", "406a2d", "3d6c2f", "54683f", "436f2c", "4f6c3c", "4e7040", "526f43", "427632", "51753f", "547645", "567545", "557942", "567944", "567a45", "537c42", "557c48", "577d45", "4f8240", "598248", "528646", "5e8d3d", "688d2b", "72a356"] },
  skin: { colors: ["ecb7a0", "e3b29f", "eab79f", "dfaf9c", "ebb79e", "cf957f", "93684f", "af836a", "ebb8a6", "fac7ae", "e1bb9c", "9b6f5b", "deb79b", "d2a083", "bc8066", "976959", "af7055", "9e6a4b", "f5bd8f", "b97666", "d09b86", "f4d1bd", "cb947b", "f0a868", "d2946c", "cc9278", "db9086", "bf824b", "aa5e41", "a68465", "7f4e2f", "e8a383", "d9a77b"], protected: true },
  eye: { colors: ["355d75", "31788d", "4b737b", "3c527c", "384a7e", "577a85", "516f74", "0c5e7e", "5b788c", "294862", "345d76", "547991", "54777f", "3d616c", "7da4a8", "2891b2", "526271", "4987b4", "3e637f", "38a6b4", "435361", "00496c", "a7ccde", "313f4f"], protected: true },
  outline: { light: [0, 0.165], protected: true },
};
for (const [region, def] of Object.entries(REGIONS))
  await call("canon_learn", { region, canonPath, ...def });
const info = await call("canon_info", { canonPath, censusFile: walks[0] });
console.log("[2] census of walk-s:", info.census.counts, "unmatched:", info.census.unmatched);

/* 3. measure the hero — the numbers game code should read instead of guessing */
const m = await call("sprite_measure", { file: walks[0], canonPath });
console.log("[3] measure walk-s: top=%d capWidth=%d faceTop=%d jitter=%o",
  m.frames[0].top, m.frames[0].capWidth, m.frames[0].regionTop.skin, m.jitter);

/* 4. repaint the hood red — a brand-new outfit variant in one deterministic call */
const out = path.join(dir, "walk-s-red.gif");
await call("sprite_repaint", {
  file: walks[0], region: "cloth", canonPath,
  ramp: ["3a1515", "7a2828", "b04040", "d87070"], outFile: out,
});

/* 5. prove the repaint clean: face untouched, no green left behind.
   First attempt FAILS on purpose — and that failure is the product working:
   the outline rule (light ≤ 0.165) also swallows the hood's darkest shade
   21361a, so 12 pixels stay green. Exactly the class of defect that shipped
   unnoticed for weeks when we relied on eyes. */
const v1 = await call("sprite_verify", {
  files: [out], baseFiles: [walks[0]],
  checks: ["protected", "leftover"], region: "cloth", canonPath,
});
console.log("[5a] first verify:", v1.pass ? "PASS" : "FAIL (expected)",
  JSON.stringify(v1.files[0].checks.map((c) => `${c.name}:${c.pass ? "ok" : c.details}`)));

/* fix the canon (narrow the outline rule below the darkest hood shade) and redo */
await call("canon_learn", { region: "outline", canonPath, light: [0, 0.15], protected: true });
await call("sprite_repaint", {
  file: walks[0], region: "cloth", canonPath,
  ramp: ["3a1515", "7a2828", "b04040", "d87070"], outFile: out,
});
const v2 = await call("sprite_verify", {
  files: [out], baseFiles: [walks[0]],
  checks: ["protected", "leftover"], region: "cloth", canonPath,
});
console.log("[5b] after canon fix:", v2.pass ? "PASS" : "FAIL",
  JSON.stringify(v2.files[0].checks.map((c) => `${c.name}:${c.pass ? "ok" : c.details}`)));
if (!v2.pass) process.exit(1);

/* 6. direction-consistency check on the real 8-direction walk set */
const spread = await call("sprite_verify", { files: walks, checks: ["spread"], region: "cloth", canonPath });
console.log("[6] hood colour spread across 8 directions:", spread.group[0].value, "(limit", spread.group[0].limit + ")", spread.group[0].pass ? "PASS" : "FAIL");

/* 7. contact sheet of original vs red variant */
const sheet = await client.callTool({
  name: "sprite_sheet",
  arguments: { files: [walks[0], out], outFile: path.join(dir, "demo-sheet.png"), zoom: 5 },
});
console.log("[7] sheet:", JSON.parse(sheet.content.find((c) => c.type === "text").text).wrote,
  "inline image:", sheet.content.some((c) => c.type === "image"));

await client.close();
console.log("\ndemo dir:", dir);

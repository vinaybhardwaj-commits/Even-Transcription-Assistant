// Fails when fixtures, tests, sources or dist contain strings that look like real ids. All data here must be synthetic.
import { ensureMockup } from "./ensure-fixtures.mjs";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
ensureMockup();
const DIRS = ["fixtures", "test", "src", "dist", "scripts"];
const SELF = "scripts/check-no-real-data.mjs";
const RULES = [
  ["26-char base32 consult uid", /\b[a-z2-7]{26}\b/i],
  ["room_ id other than room_syn*", /\broom_(?!syn)(?=[A-Za-z0-9]*\d)[A-Za-z0-9]{6,}/],
  ["doc_/enc_ id not prefixed syn", /\b(?:doc|enc)_(?!syn)[A-Za-z0-9]{6,}/],
  // 13 digits starting 17/18 is an epoch-ms timestamp (fixture times); phones and Aadhaar do not look like that
  ["10+ digit run", /(?<!\d)(?!1[78]\d{11}(?!\d))\d{10,}/],
  ["email address", /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+\.[A-Za-z0-9.-]+/],
];

function* walk(d) {
  for (const n of readdirSync(d)) { const p = join(d, n); if (n === "node_modules") continue; statSync(p).isDirectory() ? yield* walk(p) : yield p; }
}
const hits = [];
export function scanText(text) { return RULES.filter(([, re]) => re.test(text)).map(([name]) => name); }
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  let files = 0;
  for (const dir of DIRS) {
    let it; try { it = [...walk(join(root, dir))]; } catch { continue; }
    for (const f of it) {
      const rel = relative(root, f); if (rel === SELF || !/\.(js|mjs|json|html|css|txt|md)$/.test(f)) continue;
      files++;
      const lines = readFileSync(f, "utf8").split("\n");
      lines.forEach((l, i) => { for (const [name, re] of RULES) { const m = l.match(re); if (m) hits.push(`${rel}:${i + 1}: ${name}: ${m[0].slice(0, 6)}...`); } });
    }
  }
  if (hits.length) { console.error(hits.join("\n")); console.error(`check-no-real-data: ${hits.length} hit(s)`); process.exit(1); }
  console.log(`check-no-real-data: ok (${files} files)`);
}

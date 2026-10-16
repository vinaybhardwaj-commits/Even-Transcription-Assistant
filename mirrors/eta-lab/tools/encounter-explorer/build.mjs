// Concatenates src/*.js into one classic script inside src/template.html.
// Run: node build.mjs   ->  dist/encounter-explorer.html: the LIVE page, adapter-catalog over scribe_catalog (+ capabilities.json, TOOLS.txt)
//                           dist/encounter-explorer-current.html: adapter-current over the older tools (+ capabilities.current.json, TOOLS.current.txt), not handed over
//                           dist/encounter-explorer-mockup.html: synthetic data inline, no mcp (+ capabilities.mockup.json)
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { ensureMockup } from "./scripts/ensure-fixtures.mjs";
import { TOOLS } from "./src/adapter-current.js";
import { CATALOG_ACTIONS, CATALOG_TOOLS } from "./src/adapter-catalog.js";

const root = dirname(fileURLToPath(import.meta.url));
ensureMockup();
const rd = p => readFileSync(join(root, p), "utf8");
const ORDER = ["types", "util", "links", "c4", "pulse", "days", "adapter", "mcp-call", "adapter-current", "adapter-catalog", "audio-synth", "adapter-fixture", "dom", "layers", "ui", "main"];

function strip(src) {
  return src
    .replace(/^import\s[^;]*;\s*$/gm, "")
    .replace(/^export\s*\{[^}]*\};?\s*$/gm, "")
    .replace(/^export\s+(async\s+function|function|const|let|class)\b/gm, "$1");
}

/** kind: "current" | "catalog" | "mockup" (true/false are kept as mockup/current) */
export function buildPage(kind) {
  kind = kind === true ? "mockup" : kind === false || kind === undefined ? "current" : kind;
  const data = kind === "mockup" ? rd("fixtures/synthetic/mockup.json").trim() : "null";
  const prelude = `const ADAPTER = ${JSON.stringify(kind)};\nconst FIXTURE_DATA = ${data.replace(/<\/(script)/gi, "<\\/$1")};\n`;
  const body = ORDER.map(n => "// ---- " + n + "\n" + strip(rd(`src/${n}.js`))).join("\n");
  const script = `"use strict";\n(() => {\n${prelude}${body}\n})();`;
  if (/<\/script/i.test(script)) throw new Error("script contains </script");
  return rd("src/template.html").replace("/*STYLE*/", () => rd("src/style.css")).replace("/*SCRIPT*/", () => script);
}

/** The live page is the catalog page: ONE tool, scribe_catalog, and only these actions. */
export const CAPABILITIES = {
  mcp: { servers: [{ server: "Scribe MCP", tools: CATALOG_TOOLS }] },
  sample: {}, db: {}, user: { scopes: ["profile"] },
};
export const TOOLS_TXT = CATALOG_ACTIONS.map(a => "scribe_catalog " + a).join("\n") + "\n";
/** The older current-tools page: kept for reference only, not handed over. */
export const CAPABILITIES_CURRENT = {
  mcp: { servers: [{ server: "Scribe MCP", tools: TOOLS }] },
  sample: {}, db: {}, user: { scopes: ["profile"] },
};
export const CAPABILITIES_MOCKUP = { sample: {}, db: {}, user: { scopes: ["profile"] } };

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  mkdirSync(join(root, "dist"), { recursive: true });
  const w = (n, v) => writeFileSync(join(root, "dist", n), v);
  w("encounter-explorer.html", buildPage("catalog"));
  w("capabilities.json", JSON.stringify(CAPABILITIES) + "\n");
  w("TOOLS.txt", TOOLS_TXT);
  w("encounter-explorer-current.html", buildPage("current"));
  w("capabilities.current.json", JSON.stringify(CAPABILITIES_CURRENT) + "\n");
  w("TOOLS.current.txt", TOOLS.join("\n") + "\n");
  w("encounter-explorer-mockup.html", buildPage("mockup"));
  w("capabilities.mockup.json", JSON.stringify(CAPABILITIES_MOCKUP) + "\n");
  console.log("built live (catalog) + current + mockup");
}

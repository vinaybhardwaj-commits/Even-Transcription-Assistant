#!/usr/bin/env node
/**
 * Static scan for the SILENT-FAILURE anti-pattern that caused B18/B19:
 * empty catch blocks and empty `.catch(()=>{})` handlers in critical-path
 * source, where an error is swallowed with no logging/handling/recovery.
 * Reports file:line. Exit 1 if any are found in the SCAN_DIRS set.
 *
 * Intentionally NARROW: only truly-EMPTY handlers (whitespace-only body) are
 * flagged. A catch block that logs or contains an explanatory comment is a
 * deliberate, documented swallow and is allowed. Run: node scripts/check-silent-failures.mjs
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

const SCAN_DIRS = ["lib", "components/recording", "components", "app"];
const EMPTY_CATCH = /catch\s*(\([^)]*\))?\s*\{\s*\}/g;          // catch {} / catch (e) {}
const EMPTY_CATCH_ARROW = /\.catch\(\s*\(\s*\)\s*=>\s*\{\s*\}\s*\)/g; // .catch(()=>{})
const findings = [];

function walk(dir) {
  let entries;
  try { entries = readdirSync(dir); } catch { return; }
  for (const name of entries) {
    const p = join(dir, name);
    let st; try { st = statSync(p); } catch { continue; }
    if (st.isDirectory()) { if (name !== "node_modules" && name !== ".next") walk(p); continue; }
    if (!/\.(ts|tsx|mjs|js)$/.test(name)) continue;
    const src = readFileSync(p, "utf8");
    const lines = src.split("\n");
    lines.forEach((line, i) => {
      if (EMPTY_CATCH.test(line) || EMPTY_CATCH_ARROW.test(line)) findings.push(`${p}:${i + 1}  ${line.trim().slice(0, 100)}`);
      EMPTY_CATCH.lastIndex = 0; EMPTY_CATCH_ARROW.lastIndex = 0;
    });
  }
}

for (const d of SCAN_DIRS) walk(d);
if (findings.length === 0) { console.log("OK — no empty catch/.catch handlers in critical paths"); process.exit(0); }
console.log(`Found ${findings.length} silent-failure handler(s) — add logging/handling or an explicit /* intentional */ comment:`);
for (const f of findings) console.log("  " + f);
process.exit(1);

#!/usr/bin/env node
/**
 * scripts/sync-number-words.mjs — regenerate lib/stt/number-words.json from its two inputs.
 *
 *   lib/stt/number-words.base.json   the 772-word en/hi/kn lexicon exactly as the router generated it (never edited)
 *   $NUMBER_WORDS_SHARED             the shared Indic lexicon, default ~/dev/eta-lab/shared/number-words-indic-v1.json
 *                                    ({"version","languages","entries":{ta,te,ml,mr,bn,gu:[...]},"notes"})
 *
 * Output = sorted union of the two, with count and lexicon_sha256 (sha256 of the sorted words joined by "\n",
 * first 16 hex — the same hash rule the router's eta_number_words.py header uses). The runtime reads ONLY the
 * committed lib/stt/number-words.json; nothing outside the repo is read at runtime.
 *
 * Usage:  node scripts/sync-number-words.mjs            write lib/stt/number-words.json
 *         node scripts/sync-number-words.mjs --check    exit 1 if the committed JSON differs from a fresh merge
 * Exit 0 = ok, 1 = drift (--check) or invalid shared file, 2 = an input is missing.
 */
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const BASE = join(ROOT, "lib/stt/number-words.base.json");
const OUT = join(ROOT, "lib/stt/number-words.json");
const SHARED = process.env.NUMBER_WORDS_SHARED || join(homedir(), "dev/eta-lab/shared/number-words-indic-v1.json");
const CHECK = process.argv.includes("--check");

const die = (code, msg) => {
  console.error(`sync-number-words: ${msg}`);
  process.exit(code);
};

if (!existsSync(BASE)) die(2, `base lexicon missing: ${BASE}`);
if (!existsSync(SHARED)) die(2, `shared lexicon missing: ${SHARED} (set NUMBER_WORDS_SHARED)`);

const base = JSON.parse(readFileSync(BASE, "utf8"));
const shared = JSON.parse(readFileSync(SHARED, "utf8"));

const hash = (words) => createHash("sha256").update([...words].sort().join("\n")).digest("hex").slice(0, 16);

// Validate the shared file before it can reach the runtime list.
const added = {};
const merged = new Set(base.words);
if (!shared.entries || typeof shared.entries !== "object") die(1, "shared file has no entries object");
for (const [lang, list] of Object.entries(shared.entries)) {
  if (!Array.isArray(list) || list.length === 0) die(1, `${lang}: entries must be a non-empty array`);
  let n = 0;
  for (const w of list) {
    if (typeof w !== "string" || w.length === 0) die(1, `${lang}: empty or non-string entry`);
    if (w !== w.normalize("NFC")) die(1, `${lang}: not NFC: ${JSON.stringify(w)}`);
    if (w !== w.trim() || /\s/u.test(w)) die(1, `${lang}: whitespace in entry ${JSON.stringify(w)} (matcher is single-token)`);
    if (/[A-Za-z]/.test(w)) die(1, `${lang}: Latin letter in entry ${JSON.stringify(w)} (native script only)`);
    if (!merged.has(w)) n += 1;
    merged.add(w);
  }
  added[lang] = n;
}

const words = [...merged].sort();
const out = {
  source: `${base.source} + shared/number-words-indic-v1.json (${Object.keys(shared.entries).join(" ")})`,
  router_main_sha: base.router_main_sha,
  lexicon_sha256: hash(words),
  count: words.length,
  base_count: base.words.length,
  base_lexicon_sha256: base.lexicon_sha256,
  shared_version: shared.version,
  shared_new_words: added,
  words,
};

// Same layout as the router's generated file: one value per line, no indentation, no trailing newline.
const text = JSON.stringify(out, null, 1).replace(/^ +/gmu, "");

if (CHECK) {
  const current = existsSync(OUT) ? readFileSync(OUT, "utf8") : "";
  if (current === text) {
    console.log(`sync-number-words: in step — ${words.length} words, lexicon ${out.lexicon_sha256}`);
    process.exit(0);
  }
  die(1, `DRIFT — ${OUT} differs from a fresh merge; run: node scripts/sync-number-words.mjs`);
}
writeFileSync(OUT, text);
console.log(`sync-number-words: wrote ${OUT} — ${words.length} words (${base.words.length} base + ${words.length - base.words.length} new: ${JSON.stringify(added)}), lexicon ${out.lexicon_sha256}`);

#!/usr/bin/env node
/**
 * scripts/reasoning-governance-check.mjs — the governed-layer HARD GATE (Reasoning
 * Observability Stage 4; WARN-only in Stage 1). Run: `npm run reasoning:governance`.
 *
 * READS SOURCE AS TEXT (mirrors scripts/architecture-check.mjs — declarative config,
 * main-guarded, exported for tests). EXIT 1 on any model call that bypasses the governed
 * envelope (lib/trace.ts tracedChat/governedChat over lib/llm.ts routing) — Stage 4
 * migrated every direct site, so the expected count is ZERO and any new one fails CI.
 *
 * Division of teeth (the PRD's four hard-fail conditions):
 *   · direct model call outside the governed layer  → THIS script, exit 1.
 *   · prompt changed without a version bump / hash mismatch → the `reasoning registry is
 *     current` CI staleness gate (the registry re-derives every sha256 from source; any
 *     text change diffs the committed artifact), plus tracedChat resolving hashes from the
 *     registry at call time (a stamped hash can never disagree with the registry by
 *     construction).
 *   · unregistered reasoning asset → the registry generator's inclusion rule + the
 *     manifest coverage test (lib/__tests__/reasoning-registry.test.ts, both directions).
 *
 * concordance_runs (INFO): folded into `traces` in Stage 4 — every verdict/interview run
 * creates a first-class trace via the governed layer; the table remains as the feature's
 * own result store, no longer a BLIND parallel store. This script asserts the fold holds
 * (lib/concordance.ts must route through the governed layer) and lists the refs as info.
 * Scope: lib/ + app/ (runtime surface); scripts/ are offline harnesses, __tests__ fixtures.
 */

import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ROOT, walk } from './lib/import-scan.mjs';

// ── declarative config ───────────────────────────────────────────────────────────────────────────
/** The governed layer: the ONLY files allowed to touch a model client directly.
 *  lib/bedrock.ts joined on 7 Aug 2026 — it owns the AWS transport the same way lib/llm.ts owns
 *  the two OpenAI-SDK ones, and it must be allowed to define the calls the pattern below bans. */
export const GOVERNED_FILES = new Set(['lib/trace.ts', 'lib/llm.ts', 'lib/bedrock.ts']);

/** A direct model CALL (import lines don't match — each pattern requires the call paren). */
export const DIRECT_CALL_PATTERNS = [
  { id: 'chat.completions.create', rx: /\.chat\.completions\.create\s*\(/ },
  { id: 'chatWithFallback', rx: /\bchatWithFallback\s*\(/ },
  { id: 'getGeminiChatClient', rx: /\bgetGeminiChatClient\s*\(/ },
  // Bedrock S1 (7 Aug 2026). The S1 kickoff's constraint 5 — "bedrockConverse is called only
  // through the governed layer; do not add any new call site in this slice" — is a build rule
  // until it is a gate. This makes it a gate, so S2's runner cannot reach the transport except
  // through governedChat, and PHI cannot reach AWS down a path de-identification never gated.
  { id: 'bedrockConverse/bedrockGenerate', rx: /\bbedrock(Converse|Generate)\s*\(/ },
];

/** Run stores parallel to `traces` — folded (mirrored) stores are INFO, not failures. */
export const PARALLEL_STORE_PATTERNS = [
  { id: 'concordance_runs', rx: /\bconcordance_runs\b/, foldedBy: 'lib/concordance.ts' },
];

/** Per-file scan (exported so tests can feed synthetic sources). */
export function scanSource(file, text) {
  const sites = [];
  const stores = [];
  const governed = GOVERNED_FILES.has(file);
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i++) {
    if (!governed) {
      for (const p of DIRECT_CALL_PATTERNS) {
        if (p.rx.test(lines[i])) sites.push({ file, line: i + 1, pattern: p.id });
      }
    }
    for (const p of PARALLEL_STORE_PATTERNS) {
      if (p.rx.test(lines[i])) stores.push({ file, line: i + 1, pattern: p.id });
    }
  }
  return { sites, stores };
}

// ── the repo scan (exported for lib/__tests__) ───────────────────────────────────────────────────
export function scanUngoverned() {
  const files = walk(join(ROOT, 'lib'))
    .concat(walk(join(ROOT, 'app')))
    .filter((f) => /\.(ts|tsx)$/.test(f) && !f.includes('__tests__'));

  const sites = [];
  const stores = [];
  for (const file of files) {
    const r = scanSource(file, readFileSync(join(ROOT, file), 'utf8'));
    sites.push(...r.sites);
    stores.push(...r.stores);
  }

  // Fold assertions: each parallel store's folding module must route via the governed layer.
  const foldViolations = [];
  for (const p of PARALLEL_STORE_PATTERNS) {
    if (!p.foldedBy) continue;
    let text = '';
    try { text = readFileSync(join(ROOT, p.foldedBy), 'utf8'); } catch { /* missing file → violation below */ }
    if (!/\b(governedChat|tracedChat)\b/.test(text)) {
      foldViolations.push(`${p.id}: ${p.foldedBy} no longer routes through the governed layer (governedChat/tracedChat) — the ${p.id} store would be blind again`);
    }
  }
  return { sites, stores, foldViolations };
}

// ── run (main-guarded) ───────────────────────────────────────────────────────────────────────────
const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const { sites, stores, foldViolations } = scanUngoverned();

  console.log(`reasoning governance — HARD GATE (Stage 4): no direct model calls outside the governed layer\n`);
  console.log(`ungoverned model calls (bypass tracedChat/governedChat): ${sites.length}`);
  for (const s of sites) console.log(`  FAIL ${s.file}:${s.line} — direct ${s.pattern}`);
  console.log(`\nparallel run stores: ${stores.length} references (INFO — folded into traces since Stage 4)`);
  for (const s of stores) console.log(`  info ${s.file}:${s.line} — ${s.pattern}`);
  for (const v of foldViolations) console.error(`  FAIL ${v}`);

  if (sites.length || foldViolations.length) {
    console.error(`\nreasoning:governance — RED: ${sites.length + foldViolations.length} violation(s). Route the call through governedChat/tracedChat (lib/trace.ts) with a promptRef.`);
    process.exit(1);
  }
  console.log(`\nreasoning:governance — GREEN: 0 ungoverned model calls; parallel stores folded.`);
  process.exit(0);
}

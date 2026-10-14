#!/usr/bin/env node
/**
 * scripts/reasoning-registry-gen.mjs — generates data/reasoning-registry/prompts.generated.json
 * (Reasoning Observability Stage 0). Run: `npm run reasoning:registry`. The registry is
 * GENERATED FROM CODE, never hand-authored (PRD D2, generated-not-authored): standing prompt
 * consts are extracted verbatim from lib/**​/*.ts (tests excluded), hashed (sha256 of the exact
 * template-literal text, ${…} slots preserved verbatim — they are instruction scaffold, not
 * data), and joined with the rubric sources. Human metadata (owner / approver / maturity /
 * linked rubric) does NOT live here — it lives in the hand-authored sidecar
 * lib/reasoning/manifest.ts and is merged at read time by lib/reasoning/registry-core.ts.
 * CI regenerates and `git diff --exit-code`s the output (mirrors the architecture map gate),
 * so the committed registry cannot drift from the prompts actually in the code.
 *
 * DETERMINISM CONTRACT (same as architecture-map-gen): every collection is sorted by a stable
 * key and nothing time- or environment-dependent is emitted — no timestamps, no git SHA — so
 * re-running is a byte-for-byte no-op. (The one-off research extraction this productizes,
 * CDMSS-REASONING-CONFIG-EXPORT-14-JUL-2026, carried `generated`/`source_commit` fields; they
 * are deliberately dropped here because a commit stamp would make the artifact stale on every
 * commit and break the staleness gate.)
 *
 * READ-ONLY over the reasoning cores: this script never modifies a prompt, only extracts.
 */

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, resolve, dirname, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { ROOT, walk } from './lib/import-scan.mjs';

const OUT_PATH = 'data/reasoning-registry/prompts.generated.json';
export const REGISTRY_SCHEMA = 'prompt-registry/0.1 (research export)';

// ── inclusion rule (PRD §6, normative) ─────────────────────────────────────────────────────────
// A standing prompt const is a top-level `const` (exported or not) bound to a template literal
// whose name (a) ends in `_SYSTEM`, (b) is exactly `SYSTEM`, or (c) carries one of the
// reasoning-role tokens. (SYSTEM_VARIANTS in multi-query.ts is deliberately outside this rule —
// it neither ends in _SYSTEM nor carries a token — matching the ratified extraction.)
function isPromptConstName(name) {
  return name.endsWith('_SYSTEM') || name === 'SYSTEM'
    || /(JUDGE|RUBRIC|PROMPT|CRITIQUE|REVISE)/.test(name);
}

// User-message builders: the assembly functions that wrap these prompts. Named, not extracted —
// their output is per-run data, so only the fn/file/feature triple is registered.
const BUILDER_RE = /(?:^|\n)(?:export\s+)?(?:async\s+)?function\s+(build[A-Za-z0-9]*(?:User|Prompt))\s*\(/g;

// ── filename → feature map (labels consistent with lib/observability-meta.ts) ──────────────────
const FEATURE_OF = {
  'lib/ccb-brief-core.ts': { feature: 'Care brief (CCB)', group: 'Care coordination' },
  'lib/clinical-state/extract.ts': { feature: 'ClinicalState extraction', group: 'Longitudinal spine' },
  'lib/clinical-state/extraction-eval-core.ts': { feature: 'ClinicalState extraction eval', group: 'Eval' },
  'lib/coach.ts': { feature: 'Coach', group: 'Learn' },
  'lib/concordance-core.ts': { feature: 'Concordance (lab results)', group: 'Reference' },
  'lib/ddx-hypothesis.ts': { feature: 'Differential (DDx)', group: 'Decision support' },
  'lib/doc-audit-core.ts': { feature: 'Right Care · Record audit', group: 'Right Care' },
  'lib/doc-audit.ts': { feature: 'Right Care · Record audit (identity)', group: 'Right Care' },
  'lib/even-concept.ts': { feature: 'Right Care · Concept coder', group: 'Right Care' },
  'lib/expand.ts': { feature: 'Ask · query rewrite', group: 'Decision support' },
  'lib/investigations.ts': { feature: 'Ask/DDx input normaliser', group: 'Decision support' },
  'lib/learning-core.ts': { feature: 'Learning (label canonicalize)', group: 'System' },
  'lib/lvc-core.ts': { feature: 'Right Care · Order check (flags)', group: 'Right Care' },
  'lib/lvc-value-core.ts': { feature: 'Right Care · Order check (value)', group: 'Right Care' },
  'lib/opd-longitudinal-core.ts': { feature: 'OPD audit · longitudinal', group: 'OPD Audit' },
  'lib/opd-note-audit-core.ts': { feature: 'OPD note audit', group: 'OPD Audit' },
  'lib/pathway-core.ts': { feature: 'Right Care · Care pathway', group: 'Right Care' },
  'lib/prognosis-core.ts': { feature: 'Right Care · Foreseeability', group: 'Right Care' },
  'lib/rerank.ts': { feature: 'Ask · reranker judge', group: 'Decision support' },
  'lib/right-care-ground-eval-core.ts': { feature: 'Right Care ground eval (pairwise judge)', group: 'Eval' },
};
function featureOf(file) {
  return FEATURE_OF[file]
    ?? { feature: basename(file).replace(/\.tsx?$/, ''), group: 'System' };   // honest fallback, never throws
}

// ── embedded rubrics (declarative; the extraction cannot mechanically split a rubric out of a
// prompt string, so the linkage is declared here and cross-checked against the extracted set) ──
const EMBEDDED_RUBRICS = [
  { id: 'PDQI-9 reasoning rubric', embedded_in: 'opd-note-audit-core.ts/OPD_AUDIT_SYSTEM' },
  { id: 'cannot-miss discipline', embedded_in: 'ddx-hypothesis.ts/HYPO_SYSTEM' },
  { id: '0–10 scoring rubric', embedded_in: 'rerank.ts/JUDGE_SYSTEM' },
  { id: 'evidence-hierarchy', embedded_in: 'pathway-core.ts/ENRICH_SYSTEM' },
  { id: 'applicability discipline', embedded_in: 'lvc-core.ts/JUDGE_SYSTEM' },
];

// ── template-literal extraction (raw text between the outer backticks, verbatim) ───────────────
// Tracks ${…} nesting so backticks inside interpolation expressions don't end the literal.
function extractTemplate(text, open) {
  const stack = ['tpl'];                       // 'tpl' | number (brace depth of a ${…} expr)
  let i = open + 1;
  const start = i;
  while (i < text.length) {
    const mode = stack[stack.length - 1];
    const c = text[i];
    if (mode === 'tpl') {
      if (c === '\\') { i += 2; continue; }
      if (c === '`') { stack.pop(); if (stack.length === 0) return { raw: text.slice(start, i), end: i }; i++; continue; }
      if (c === '$' && text[i + 1] === '{') { stack.push(1); i += 2; continue; }
      i++;
    } else {
      if (c === '`') { stack.push('tpl'); i++; continue; }
      if (c === "'" || c === '"') {              // skip quoted strings inside the expression
        const q = c; i++;
        while (i < text.length && text[i] !== q) { if (text[i] === '\\') i++; i++; }
        i++; continue;
      }
      if (c === '{') { stack[stack.length - 1] = mode + 1; i++; continue; }
      if (c === '}') {
        if (mode === 1) stack.pop(); else stack[stack.length - 1] = mode - 1;
        i++; continue;
      }
      i++;
    }
  }
  throw new Error(`unterminated template literal at offset ${open}`);
}

const CONST_RE = /(?:^|\n)(?:export\s+)?const\s+([A-Z][A-Z0-9_]*)\s*(?::\s*string\s*)?=\s*`/g;
const VERSION_HINT_RE = /(?:^|\n)export\s+const\s+([A-Za-z0-9_]*_VERSION)\s*=\s*'([^']+)'/;

const sha256 = (s) => createHash('sha256').update(s, 'utf8').digest('hex');

// ── build (pure — exported so the determinism test can call it without writing) ────────────────
export function buildRegistryJson() {
  const files = walk(join(ROOT, 'lib'))
    .filter((f) => /\.ts$/.test(f) && !f.includes('__tests__/'));

  const prompts = [];
  const builders = [];
  for (const file of files) {
    const text = readFileSync(join(ROOT, file), 'utf8');

    // version hint: the FIRST exported `*_VERSION` const with a plain string-literal
    // initializer in the file (matches the ratified extraction; derived/array forms skipped)
    const vh = text.match(VERSION_HINT_RE);
    const versionHint = vh ? `${vh[1]}=${vh[2]}` : 'unversioned (git-tracked)';

    const stem = basename(file).replace(/\.ts$/, '');
    const { feature, group } = featureOf(file);

    CONST_RE.lastIndex = 0;
    let m;
    while ((m = CONST_RE.exec(text)) !== null) {
      const name = m[1];
      if (!isPromptConstName(name)) continue;
      const { raw } = extractTemplate(text, m.index + m[0].length - 1);
      const hash = sha256(raw);
      prompts.push({
        id: `${stem}/${name}`,
        const: name,
        feature,
        group,
        file,
        kind: 'system',
        version_hint: versionHint,
        sha256: hash,
        sha12: hash.slice(0, 12),
        chars: raw.length,
        lines: raw.split('\n').length,
        text: raw,
      });
    }

    BUILDER_RE.lastIndex = 0;
    while ((m = BUILDER_RE.exec(text)) !== null) {
      builders.push({ fn: m[1], file, feature });
    }
  }

  prompts.sort((a, b) => a.id.localeCompare(b.id));
  builders.sort((a, b) => a.file.localeCompare(b.file) || a.fn.localeCompare(b.fn));

  // duplicate-id guard: two files with the same stem would collide silently otherwise
  const seen = new Set();
  for (const p of prompts) {
    if (seen.has(p.id)) throw new Error(`duplicate prompt id ${p.id} — two lib files share a stem`);
    seen.add(p.id);
  }

  // ── rubrics: the one external JSON rubric (facts read from the file itself) + the declared
  // embedded rubrics, each cross-checked against the extracted prompt set ──────────────────────
  const nabhRaw = readFileSync(join(ROOT, 'data/nabh-rubric.json'), 'utf8');
  const nabh = JSON.parse(nabhRaw);
  const rubrics = [{
    id: 'nabh/6e',
    kind: 'external-json',
    source: 'data/nabh-rubric.json',
    feature: 'Right Care · Record audit',
    version: nabh._meta?.source ?? 'unversioned',
    sha256: sha256(nabhRaw),
    keys: Object.keys(nabh).filter((k) => k !== '_meta').sort(),
    meta: nabh._meta ?? null,
  }];

  // Lab-package composition (Phase C §7.2) — the SECOND external, hashable JSON reference file,
  // registered exactly as nabh/6e is. It is factual context injected into the low-value-care judge
  // (lvc-core/buildLabPackageBlock), not a rubric that decides anything, hence `kind` says so.
  // GENERATED from db13 by scripts/generate-lab-packages.ts; an empty file is valid and inert.
  const lpRaw = readFileSync(join(ROOT, 'data/lab-packages.json'), 'utf8');
  const lp = JSON.parse(lpRaw);
  rubrics.push({
    id: 'lab-packages/1',
    kind: 'external-json',
    source: 'data/lab-packages.json',
    feature: 'Right Care · Order check (low-value care judge context)',
    version: Array.isArray(lp) && lp.length ? `${lp.length} packages` : 'empty — generator not yet run',
    sha256: sha256(lpRaw),
    keys: Array.isArray(lp) ? lp.map((p) => p?.package).filter(Boolean).sort() : [],
    meta: { generated_from: 'db13:individuals-prescriptions__further_investigation', authored: false },
  });
  for (const r of EMBEDDED_RUBRICS) {
    const [hostFile, hostConst] = r.embedded_in.split('/');
    const hostId = `${hostFile.replace(/\.ts$/, '')}/${hostConst}`;
    if (!seen.has(hostId)) {
      throw new Error(`embedded rubric "${r.id}" points at ${r.embedded_in}, but no such prompt const was extracted — update EMBEDDED_RUBRICS`);
    }
    rubrics.push({
      id: r.id,
      kind: 'embedded-in-prompt',
      embedded_in: r.embedded_in,
      version: 'not separated from prompt (today)',
      text: null,
    });
  }

  const payload = {
    export: 'cdmss-reasoning-config / prompts+rubrics',
    schema: REGISTRY_SCHEMA,
    source_repo: 'github.com/vinaybhardwaj-commits/Even-CDMSS',
    scope_note: 'Reasoning configuration ONLY — standing prompt system-instructions and rubrics. Contains NO clinical data, NO patient text, NO run outputs, NO retrieved passages, NO PHI. Every entry carries a sha256 content hash for reproducibility. Text may contain ${...} template slots (variable inputs), which are part of the instruction scaffold, not data.',
    coverage_note: 'Standing prompt consts + rubrics extracted from lib/. A few prompts are assembled inline inside route handlers (ask, topics, calculators/tooltip) rather than as named consts and are not captured here — this is exactly the gap the prompt registry closes.',
    counts: {
      prompts: prompts.length,
      rubrics: rubrics.length,
      user_message_builders: builders.length,
      features: new Set(prompts.map((p) => p.feature)).size,
    },
    prompts,
    rubrics,
    user_message_builders: builders,
  };
  return JSON.stringify(payload, null, 2) + '\n';
}

// ── write (main-guarded so tests can import buildRegistryJson without side effects) ────────────
const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const json = buildRegistryJson();
  mkdirSync(dirname(join(ROOT, OUT_PATH)), { recursive: true });
  writeFileSync(join(ROOT, OUT_PATH), json);
  const { counts } = JSON.parse(json);
  console.log(`reasoning:registry — wrote ${OUT_PATH} (${json.length} bytes; ${counts.prompts} prompts · ${counts.rubrics} rubrics · ${counts.user_message_builders} builders · ${counts.features} features).`);
}

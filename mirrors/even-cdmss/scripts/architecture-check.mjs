#!/usr/bin/env node
/**
 * scripts/architecture-check.mjs — the CDMSS import-boundary checker (Architecture Governance
 * Slice 1, Part B). Run: `npm run architecture:check` (node --import tsx, matching the scripts
 * idiom — tsx is unused at runtime but keeps the invocation uniform).
 *
 * READS SOURCE AS TEXT — never executes app code. Scans import/export-from/require/dynamic-import
 * statements in the guarded modules and exits non-zero on any violation, printing
 * `file:line — rule N — <what crossed>`.
 *
 * RULES ARE DECLARATIVE CONFIG (below): each rule is { id, name, sourceGlobs, forbid, valueOnly }.
 *   sourceGlobs — which files the rule guards ('**' spans directories, '*' within a segment).
 *   forbid      — RegExps tested against the NORMALISED import path (alias `@/` → repo root;
 *                 relative specifiers resolved against the importing file; extension stripped).
 *   valueOnly   — true ⇒ `import type { … }` and all-`type` specifier imports are ALLOWED;
 *                 only VALUE imports violate (rule 3's type-sharing line). false ⇒ any import form.
 * Adding a rule later is a one-entry change. See docs/architecture/INVENTORY.md for the map.
 *
 * Stage 1 (System Map): the scan mechanics live in scripts/lib/import-scan.mjs (shared with the
 * map generator — one scan implementation); RULES + evaluation stay here. A COVERAGE rule rides
 * along: every top-level lib/ subsystem must be in MODULE_MANIFESTS or UNREGISTERED. Execution
 * is main-guarded so the generator can import RULES without running the check.
 */

import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ROOT, globToRegExp, walk, extractImports, normaliseSpec, listSubsystems, isRegistered } from './lib/import-scan.mjs';
import { MODULE_MANIFESTS, UNREGISTERED } from '../lib/architecture/manifests.ts';

// ── the four boundary rules (Slice 1) ────────────────────────────────────────────────────────────
export const RULES = [
  {
    id: 1,
    name: 'pure clinical cores must not reach up into the app',
    sourceGlobs: ['lib/clinical-state/**', 'lib/member-state/**', 'lib/opd-note-score-core.ts', 'lib/opd-longitudinal-core.ts'],
    forbid: [/^(app|components)\//],
    valueOnly: false,
  },
  {
    id: 2,
    name: 'advisory must not import score arithmetic (finding types/identity from opd-note-audit-core ARE allowed)',
    sourceGlobs: ['lib/opd-longitudinal*', 'lib/opd-triage-core.ts'],
    forbid: [/(^|\/)opd-note-score-core$/],
    valueOnly: false,
  },
  {
    id: 3,
    name: 'the spine runs no audit/score logic (VALUE imports; `import type` is allowed)',
    sourceGlobs: ['lib/member-state/**', 'lib/clinical-state/**'],
    forbid: [
      /(^|\/)opd-note-score-core$/,
      /(^|\/)opd-note-audit(-core)?$/,
      /(^|\/)opd-longitudinal[^/]*$/,
      /(^|\/)formulary[^/]*$/,
    ],
    valueOnly: true,
  },
  {
    id: 4,
    name: 'the spine must not couple to a prediction layer',
    sourceGlobs: ['lib/member-state/**', 'lib/clinical-state/**'],
    forbid: [/prediction/],
    valueOnly: false,
  },
  {
    id: 5,
    // Inquiry K1 (both directions in ONE valueOnly rule): lib/inquiry/** must not value-import a
    // scored core, and the scored cores must never value-import lib/inquiry/**. `import type` is
    // allowed on both sides (which also keeps intra-inquiry type-only imports and the scored
    // cores' existing type-only cross-imports legal — see the module headers in lib/inquiry/).
    name: 'inquiry (advisory) and the scored cores never value-import each other',
    sourceGlobs: ['lib/inquiry/**', 'lib/opd-note-audit-core.ts', 'lib/opd-note-score-core.ts', 'lib/doc-audit-core.ts', 'lib/formulary-match-core.ts'],
    forbid: [
      /(^|\/)opd-note-audit-core$/,
      /(^|\/)opd-note-score-core$/,
      /(^|\/)doc-audit-core$/,
      /(^|\/)formulary-match-core$/,
      /(^|\/)inquiry\//,
    ],
    valueOnly: true,
  },
  {
    id: 6,
    // IPD tripwire (IPD Discharge Audit M1): the frozen spine must never grow a value-import of
    // the IPD audit module — guards the v2 admission-evidence adapter boundary before it exists.
    // (The reverse direction — ipd-audit reading the spine's contract — is deliberately allowed.)
    name: 'the spine must not value-import the IPD audit module',
    sourceGlobs: ['lib/member-state/**', 'lib/clinical-state/**'],
    forbid: [/(^|\/)ipd-audit\//],
    valueOnly: true,
  },
  {
    id: 7,
    // EpisodeState tripwire (EpisodeState #4 SL1): EpisodeState is a NEW frozen-adjacent projection.
    // The frozen spine must never grow an import of it — mirrors rule 6, guarding the boundary
    // BEFORE any adapter exists. EpisodeState may read the frozen cores' contracts/types only
    // (the reverse direction is deliberately allowed), so the guard is one-way: spine → episode.
    name: 'the frozen spine must not import EpisodeState',
    sourceGlobs: ['lib/member-state/**', 'lib/clinical-state/**'],
    forbid: [/(^|\/)episode-state\//],
    valueOnly: true,
  },
  {
    id: 8,
    // Admission-adapter tripwire (MemberState adapter #5 SL1): the admission adapter COMPOSES the
    // frozen spine from outside (it calls assembleEvidence + reads the spine's types). The frozen
    // spine must NEVER import the adapter back — that would fold the compose-outside primitive into
    // the V-ratified core and break the freeze. One-way, mirrors rule 7.
    name: 'the frozen spine must not import the admission adapter',
    sourceGlobs: ['lib/member-state/**', 'lib/clinical-state/**'],
    forbid: [/(^|\/)member-state-adapters\//],
    valueOnly: true,
  },
];

// ── run (main-guarded: `npm run architecture:check` executes; importing RULES does not) ──────────
const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const allFiles = walk(join(ROOT, 'lib')).concat(walk(join(ROOT, 'scripts')));
  const violations = [];
  const evaluated = [];

  for (const rule of RULES) {
    const matchers = rule.sourceGlobs.map(globToRegExp);
    const files = allFiles.filter((f) => matchers.some((rx) => rx.test(f)));
    let ruleViolations = 0;
    for (const file of files) {
      const text = readFileSync(join(ROOT, file), 'utf8');
      for (const imp of extractImports(text)) {
        const { path: target, external } = normaliseSpec(imp.spec, file);
        // externals only matter for rules that pattern-match bare names (rule 4's /prediction/)
        const testable = external ? rule.forbid.filter((rx) => rx.source.includes('prediction')) : rule.forbid;
        if (rule.valueOnly && imp.typeOnly) continue;             // rule 3's `import type` allowance
        for (const rx of testable) {
          if (rx.test(target)) {
            ruleViolations++;
            violations.push(`${file}:${imp.line} — rule ${rule.id} — ${rule.valueOnly ? 'value ' : ''}import of '${imp.spec}' crosses "${rule.name}"`);
          }
        }
      }
    }
    evaluated.push({ id: rule.id, name: rule.name, files: files.length, violations: ruleViolations });
  }

  for (const r of evaluated) {
    const status = r.violations === 0 ? 'GREEN' : `RED (${r.violations})`;
    console.log(`rule ${r.id} · ${status} · ${r.files} files scanned · ${r.name}`);
  }

  // ── coverage rule (Stage 1): every lib/ subsystem has a manifest or is explicitly unregistered.
  // "Subsystem" is defined in listSubsystems (import-scan.mjs). Also fails on a STALE
  // UNREGISTERED entry (listed but manifest-covered, or naming no current subsystem) so the
  // honest-gap list can't rot in either direction.
  const ruleGlobs = RULES.flatMap((r) => r.sourceGlobs);
  const subsystems = listSubsystems({ manifests: MODULE_MANIFESTS, ruleGlobs });
  const coverageViolations = [];
  for (const s of subsystems) {
    const registered = isRegistered(s, MODULE_MANIFESTS);
    const listed = UNREGISTERED.includes(s.id);
    if (!registered && !listed) coverageViolations.push(`unregistered subsystem: ${s.id} — add a manifest or list it in UNREGISTERED`);
    if (registered && listed) coverageViolations.push(`stale UNREGISTERED entry: ${s.id} is manifest-covered — remove it from UNREGISTERED`);
  }
  for (const u of UNREGISTERED) {
    if (!subsystems.some((s) => s.id === u)) coverageViolations.push(`stale UNREGISTERED entry: ${u} names no current lib/ subsystem`);
  }
  const registeredCount = subsystems.filter((s) => isRegistered(s, MODULE_MANIFESTS)).length;
  const covStatus = coverageViolations.length === 0 ? 'GREEN' : `RED (${coverageViolations.length})`;
  console.log(`coverage · ${covStatus} · ${subsystems.length} subsystems · ${registeredCount} registered, ${subsystems.length - registeredCount} explicitly unregistered`);
  violations.push(...coverageViolations);

  if (violations.length) {
    console.error('\nBOUNDARY VIOLATIONS:');
    for (const v of violations) console.error(`  ${v}`);
    process.exit(1);
  }
  console.log(`\narchitecture:check — all ${RULES.length} rules + coverage green.`);
}

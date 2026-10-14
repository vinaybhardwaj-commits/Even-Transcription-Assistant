/**
 * scripts/lib/import-scan.mjs — the ONE import-scan implementation (System Map Stage 1, Part 1).
 * Extracted VERBATIM from scripts/architecture-check.mjs so the boundary checker and the
 * architecture-map generator can never diverge on what "an import" is. The checker's RULES
 * array and rule evaluation stay in architecture-check.mjs; this module is mechanics only.
 *
 * Exports: ROOT · globToRegExp · walk · extractImports · normaliseSpec  (the Slice-1 scan)
 *          listSubsystems · VERSION_EXPORT_RE                            (Stage-1 additions)
 */

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, dirname, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// This file lives one level deeper than architecture-check.mjs, hence '../..'.
export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

// ── glob → RegExp ('**' spans segments, '*' within one) ─────────────────────────────────────────
export function globToRegExp(glob) {
  let re = '';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === '*') {
      if (glob[i + 1] === '*') { re += '.*'; i++; } else re += '[^/]*';
    } else if ('.+^${}()|[]\\'.includes(c)) re += `\\${c}`;
    else re += c;
  }
  return new RegExp(`^${re}$`);
}

// ── repo walk (source files only; skip node_modules/.next/tests' fixtures stay in scope) ─────────
export function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name === '.next' || name === '.git') continue;
    const p = join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) walk(p, out);
    else if (/\.(ts|tsx|mts|js|mjs)$/.test(name)) out.push(relative(ROOT, p));
  }
  return out;
}

// ── import extraction (text-level, multiline-tolerant) ───────────────────────────────────────────
// Captures: static `import … from '…'`, bare `import '…'`, `export … from '…'`,
// dynamic `import('…')`, and `require('…')`. Records whether the form is type-only.
const IMPORT_RE = /\bimport\s+type\s+[^'"]*?from\s*['"]([^'"]+)['"]|\bimport\s+([^'"]*?)\s*from\s*['"]([^'"]+)['"]|\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)|\bexport\s+type\s+[^'"]*?from\s*['"]([^'"]+)['"]|\bexport\s+[^'"]*?from\s*['"]([^'"]+)['"]|\brequire\s*\(\s*['"]([^'"]+)['"]\s*\)|\bimport\s*['"]([^'"]+)['"]/g;

export function extractImports(text) {
  const found = [];
  for (const m of text.matchAll(IMPORT_RE)) {
    const spec = m[1] ?? m[3] ?? m[4] ?? m[5] ?? m[6] ?? m[7] ?? m[8];
    if (!spec) continue;
    let typeOnly = false;
    if (m[1] !== undefined || m[5] !== undefined) typeOnly = true;           // import type / export type … from
    else if (m[3] !== undefined) {
      // `import <clause> from '…'` — type-only when EVERY named specifier carries `type`
      const clause = (m[2] || '').trim();
      const inner = clause.startsWith('{') ? clause.replace(/^\{|\}$/g, '') : null;
      if (inner !== null && inner.trim().length > 0) {
        typeOnly = inner.split(',').map((s) => s.trim()).filter(Boolean)
          .every((s) => /^type\s/.test(s));
      }
    }
    const line = text.slice(0, m.index).split('\n').length;
    found.push({ spec, typeOnly, line });
  }
  return found;
}

// ── specifier → normalised repo-relative module path (no extension) ──────────────────────────────
export function normaliseSpec(spec, fromFile) {
  let p = null;
  if (spec.startsWith('@/')) p = spec.slice(2);
  else if (spec.startsWith('.')) p = relative(ROOT, resolve(ROOT, dirname(fromFile), spec));
  else return { path: spec, external: true };                  // bare package — external
  return { path: p.replace(/\.(ts|tsx|mts|js|mjs)$/, ''), external: false };
}

// ═════════════════════════════════════════════════════════ Stage-1 additions (System Map) ═══════

// THE PRECISE VERSION-REGISTRY INCLUSION RULE (V, 13 Jul 2026): a version constant is an
// exported const whose UPPER_SNAKE name carries the `_VERSION` token — `*_VERSION` or
// `*_VERSIONS_*` (OPD_ENGINE_VERSIONS_CURRENT) — DECLARED in lib/. Nothing else. Deliberately
// NOT a free-text scan for 'family/N.N' strings: that catches noise ('pubmed/123'), test
// fixtures, and stale versions sitting beside the live one. Whatever this deterministic scan
// yields IS the registry; the CI staleness diff locks it.
export const VERSION_EXPORT_RE =
  /^export const ([A-Z0-9_]*_VERSIONS?(?:_[A-Z0-9_]+)?)(?:\s*:[^=]*)?\s*=\s*(.+?);/gm;

/**
 * listSubsystems({ manifests, ruleGlobs }) — the ONE "what counts as a lib/ subsystem" definition
 * (documented here; the coverage rule in architecture-check.mjs and the generator's coverage
 * block both call this, so the number can't fork).
 *
 * A top-level lib/ SUBSYSTEM is:
 *   (a) every directory directly under lib/ except __tests__ (tests aren't architecture) —
 *       id = the directory name;
 *   (b) every top-level lib/*.ts file that is matched by any checker-rule sourceGlob
 *       (rule-governed files), OR claimed by any manifest's `paths`, OR that declares a
 *       version constant per VERSION_EXPORT_RE above (a self-declared versioned subsystem) —
 *       id = the basename without extension.
 * Deliberately NOT a subsystem: loose top-level lib/*.ts helpers with none of those markers
 * (a ~100-entry allowlist of stores/wrappers would fail the sparseness rule and help no
 * decision). They still appear in the map's EDGES — nothing is hidden from the graph; they
 * just don't count toward manifest coverage yet. A new lib/ DIRECTORY, any file a rule starts
 * guarding, and any file that grows a version constant all enter coverage automatically.
 *
 * Returns { id, kind: 'dir'|'file', path }[] sorted by id.
 */
export function listSubsystems({ manifests, ruleGlobs }) {
  const subsystems = new Map();
  const manifestMatchers = manifests.flatMap((m) => m.paths.map(globToRegExp));
  const ruleMatchers = ruleGlobs.map(globToRegExp);

  for (const name of readdirSync(join(ROOT, 'lib'))) {
    const p = join(ROOT, 'lib', name);
    if (statSync(p).isDirectory()) {
      if (name === '__tests__') continue;
      subsystems.set(name, { id: name, kind: 'dir', path: `lib/${name}` });
      continue;
    }
    if (!/\.ts$/.test(name) || /\.test\.ts$/.test(name)) continue;
    const rel = `lib/${name}`;
    const id = name.replace(/\.ts$/, '');
    const governed = ruleMatchers.some((rx) => rx.test(rel));
    const claimed = manifestMatchers.some((rx) => rx.test(rel) || rx.test(rel.replace(/\.ts$/, '')));
    let versioned = false;
    if (!governed && !claimed) {
      const text = readFileSync(p, 'utf8');
      versioned = VERSION_EXPORT_RE.test(text);
      VERSION_EXPORT_RE.lastIndex = 0;                          // /g regex — reset between files
    }
    if (governed || claimed || versioned) subsystems.set(id, { id, kind: 'file', path: rel });
  }
  return [...subsystems.values()].sort((a, b) => a.id.localeCompare(b.id));
}

/** Is a subsystem (from listSubsystems) covered by some manifest's paths? Dirs match when a
 *  glob reaches inside them (`lib/x/**` covers dir `x`); files match with or without `.ts`. */
export function isRegistered(subsystem, manifests) {
  const candidates = subsystem.kind === 'dir'
    ? [subsystem.path, `${subsystem.path}/x`]
    : [subsystem.path, subsystem.path.replace(/\.ts$/, '')];
  return manifests.some((m) => m.paths.some((g) => {
    const rx = globToRegExp(g);
    return candidates.some((c) => rx.test(c));
  }));
}

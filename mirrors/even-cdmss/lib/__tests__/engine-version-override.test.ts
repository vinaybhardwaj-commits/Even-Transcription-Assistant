/**
 *   node --test --import tsx lib/__tests__/engine-version-override.test.ts
 *
 * Phase 3a part two — the A-8 backfill override.
 *
 * WHY the phase-0 backfill could not run: `updateOpdAudit` ends
 * `WHERE uid = $1 AND engine_version = $19`, where $19 is the FRESH audit's engineVersion. Against
 * a stored 0.81.15 row a 0.81.16 audit matched nothing and returned 'skipped' — SILENTLY.
 *
 * ⚠️ THE INVARIANT THIS FILE EXISTS TO PROTECT: engine_version stays in that WHERE clause and NEVER
 * enters the SET list. A re-scored 0.81.15 row keeps its 0.81.15 label and gains the corrected
 * score. If a re-score ever INSERTED a second row instead, those notes would be counted TWICE in
 * every doctor aggregate — the key is UNIQUE (uid, engine_version) and doctor reads have no
 * per-uid dedup. In-place update is not a preference; it is the only correct behaviour.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { OPD_ENGINE_VERSION } from '../opd-note-audit-core.ts';

const AUDIT = readFileSync('lib/opd-note-audit.ts', 'utf8');
const STORE = readFileSync('lib/opd-audit-store.ts', 'utf8');
const ROUTE = readFileSync('app/api/admin/opd-dosing-backfill/route.ts', 'utf8');

// ═════════════════════════════════════════════════════════════════════════════════════════════
// 1 · The override
// ═════════════════════════════════════════════════════════════════════════════════════════════

test('§4.7: opts.engineVersion threads through on the PRODUCTION path, verbatim per the kickoff', () => {
  assert.ok(AUDIT.includes(`  const engineVersion = mini
    ? opdMiniEngine(opts.engineTag)
    : (opts.engineVersion ?? OPD_ENGINE_VERSION);`));
});

test('§4.8: absent opts.engineVersion, the production path still yields OPD_ENGINE_VERSION', () => {
  // `?? OPD_ENGINE_VERSION` is the whole guarantee — existing callers are byte-identical.
  assert.ok(AUDIT.includes('(opts.engineVersion ?? OPD_ENGINE_VERSION)'));
  assert.equal(OPD_ENGINE_VERSION, 'opd-note-audit/0.81.21', 'the determinism-trio build bumped it — 3a itself bumped nothing');
});

test('the MINI path is untouched by the override — and always writes -<tag> (D1, 2 Aug 2026)', () => {
  assert.ok(AUDIT.includes('? opdMiniEngine(opts.engineTag)'),
    'no engineVersion in the mini branch; prodTag was DELETED, so a mini row can never carry the prod label');
  assert.ok(!AUDIT.includes('prodTag'), 'the option is gone repo-wide');
});

test('AuditOpdOpts declares engineVersion as an optional string', () => {
  assert.ok(AUDIT.includes('  engineVersion?: string;'));
});

// ═════════════════════════════════════════════════════════════════════════════════════════════
// 2 · THE INVARIANT — engine_version in the WHERE, never in the SET
// ═════════════════════════════════════════════════════════════════════════════════════════════

test('§4.10 THE INVARIANT: updateOpdAudit keys engine_version in WHERE and never SETs it', () => {
  const start = STORE.indexOf('UPDATE opd_note_audits SET');
  const whereIdx = STORE.indexOf('WHERE uid = $1 AND engine_version = $19', start);
  assert.ok(start > 0 && whereIdx > start, 'the UPDATE and its WHERE are locatable');
  const setList = STORE.slice(start, whereIdx);
  assert.ok(!/engine_version\s*=/.test(setList),
    'engine_version must NEVER appear in the SET list — a re-scored row keeps its own label');
  // …and the WHERE is exactly the documented one.
  assert.ok(STORE.includes('WHERE uid = $1 AND engine_version = $19'));
});

test('the re-score path is an UPDATE, never an INSERT — no second row, no double counting', () => {
  const fn = STORE.slice(STORE.indexOf('export async function updateOpdAudit'), STORE.indexOf('/** uids already audited'));
  assert.ok(fn.includes('UPDATE opd_note_audits SET'));
  assert.ok(!/INSERT INTO opd_note_audits/.test(fn), 'updateOpdAudit must not insert');
  assert.ok(fn.includes("return rows.length ? 'updated' : 'skipped';"), 'unchanged contract');
});

test('the doctor read really has no per-uid dedup — which is WHY the invariant matters', () => {
  const doctor = readFileSync('lib/opd-audit-doctor.ts', 'utf8');
  const fn = doctor.slice(doctor.indexOf('export async function fetchDoctorAuditRows'), doctor.indexOf('// ─────', doctor.indexOf('export async function fetchDoctorAuditRows')));
  assert.ok(!/DISTINCT ON \(uid\)/.test(fn), 'a second row per uid WOULD be counted twice here');
});

// ═════════════════════════════════════════════════════════════════════════════════════════════
// 3 · The backfill route
// ═════════════════════════════════════════════════════════════════════════════════════════════

test('§4.9: ?engine= defaults to OPD_ENGINE_VERSION when absent', () => {
  assert.ok(ROUTE.includes("const sourceEngine = (p.get('engine') || '').trim() || OPD_ENGINE_VERSION;"));
});

test('the SELECT targets the SOURCE version as a BOUND parameter — unknown ⇒ zero rows, never a throw', () => {
  assert.ok(ROUTE.includes(`      \`SELECT uid, findings, pdqi9, suggestions, sources, missing_fields, completeness_pct
       FROM opd_note_audits WHERE engine_version = $1 ORDER BY note_date DESC LIMIT \${limit}\`,
      [sourceEngine],`));
  // never interpolated into the SQL text
  assert.ok(!/engine_version = '\$\{/.test(ROUTE), 'the version is a bound param, not string-interpolated');
});

test('the same version threads into the audit call, so the UPDATE finds its row', () => {
  assert.ok(ROUTE.includes('auditOpdNote(note, { trace: false, reuse, engineVersion: sourceEngine })'));
  assert.ok(ROUTE.includes('engine_version: sourceEngine,'), 'and the report names the version it actually touched');
});

test('?apply=1 remains the ONLY write switch — read-only without it', () => {
  assert.ok(ROUTE.includes("const apply = p.get('apply') === '1';"));
  const applyIdx = ROUTE.indexOf("const apply = p.get('apply') === '1';");
  const updIdx = ROUTE.indexOf('updateOpdAudit', applyIdx);   // the CALL, not the import
  assert.ok(updIdx > applyIdx, 'the write happens after the switch is read');
  assert.ok(/if \(apply\)/.test(ROUTE), 'and is gated on it');
});

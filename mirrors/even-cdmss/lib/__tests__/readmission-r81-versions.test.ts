/**
 *   node --experimental-strip-types --test lib/__tests__/readmission-r81-versions.test.ts
 * R8.1 finding versions (CDMSS-READMISSIONS-R8.1-FINDING-VERSIONS PRD v1.0): the closed
 * capture-reason set, replay-run and model validation, the overwrite-snapshot decision
 * (including the idempotency trap — same trace = same reading = no second snapshot), the
 * replay snapshot shape, and SOURCE PINS on lib/readmission/store.ts: the snapshot INSERT
 * and the UPDATE travel in ONE statement, and the two ratified badge-predicate copies are
 * untouched (the r1-card test's exact-count rule, re-asserted here from the R8.1 side).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  buildReplaySnapshot, isDedupKeyShape, needsOverwriteSnapshot, parseReplayModel, validateRuns,
  CAPTURE_REASONS, REPLAY_DEFAULT_MODEL, REPLAY_EVIDENCE_NOTE, REPLAY_MAX_RUNS, VERSIONS_RULE_VERSION,
  type ReplayReadingInput,
} from '../readmission-versions-core.ts';
import type { ReadmissionFinding } from '../readmission-reconcile-core.ts';

// ── the closed sets ───────────────────────────────────────────────────────────────

test('capture reasons are exactly overwrite and replay — no others, ever', () => {
  assert.deepEqual([...CAPTURE_REASONS], ['overwrite', 'replay']);
  assert.equal(VERSIONS_RULE_VERSION, 'readmit-versions/1');
  assert.equal(REPLAY_MAX_RUNS, 3);
});

// ── replay validation (PRD: runs 1..3; reject 0 and above 3 with a 400) ───────────

test('runs: 1..3 pass; 0, 4, negatives, fractions and non-numbers are refused; absent defaults to 1', () => {
  for (const n of [1, 2, 3]) assert.deepEqual(validateRuns(n), { ok: true, runs: n });
  assert.deepEqual(validateRuns(undefined), { ok: true, runs: 1 });
  assert.deepEqual(validateRuns(null), { ok: true, runs: 1 });
  for (const bad of [0, 4, 100, -1, 1.5, '2', true, {}]) {
    const r = validateRuns(bad);
    assert.equal(r.ok, false, `runs=${JSON.stringify(bad)} must be refused`);
  }
});

test('model (O3): defaults to Opus 4.6 on Bedrock; any bedrock:<id> passes; non-Bedrock names are refused, never downgraded', () => {
  assert.deepEqual(parseReplayModel(undefined), { ok: true, model: REPLAY_DEFAULT_MODEL, modelId: 'global.anthropic.claude-opus-4-6-v1' });
  assert.deepEqual(parseReplayModel(''), { ok: true, model: REPLAY_DEFAULT_MODEL, modelId: 'global.anthropic.claude-opus-4-6-v1' });
  const named = parseReplayModel('bedrock:global.anthropic.claude-opus-4-6-v1');
  assert.equal(named.ok, true);
  for (const bad of ['vertex:gemini-2.5-pro', 'gemini-2.5-pro', 'bedrock:', 'bedrock: has spaces', 42]) {
    assert.equal(parseReplayModel(bad).ok, false, `model=${JSON.stringify(bad)} must be refused`);
  }
});

test('dedup-key shape matches the refresh route’s rule', () => {
  assert.equal(isDedupKeyShape('IP-1315|IP-1390'), true);
  assert.equal(isDedupKeyShape('IP-1|form:abc_1.2'), true);
  assert.equal(isDedupKeyShape('ab'), false);
  assert.equal(isDedupKeyShape('has space'), false);
  assert.equal(isDedupKeyShape('x'.repeat(201)), false);
});

// ── the overwrite decision, with the idempotency trap ─────────────────────────────

test('snapshot on overwrite ONLY when a row exists and is audited; nothing audited = nothing worth keeping', () => {
  assert.equal(needsOverwriteSnapshot(null, 'tr-new'), false);
  assert.equal(needsOverwriteSnapshot(undefined, 'tr-new'), false);
  assert.equal(needsOverwriteSnapshot({ audit_status: 'detected', trace_id: null }, 'tr-new'), false);
  assert.equal(needsOverwriteSnapshot({ audit_status: 'not_auditable', trace_id: 'tr-old' }, 'tr-new'), false);
  assert.equal(needsOverwriteSnapshot({ audit_status: 'excluded', trace_id: 'tr-old' }, 'tr-new'), false);
  assert.equal(needsOverwriteSnapshot({ audit_status: 'audited', trace_id: 'tr-old' }, 'tr-new'), true);
});

test('a second identical save (same trace) writes no second snapshot of the same reading; a null trace on either side snapshots — a duplicate is recoverable, a gap is not', () => {
  assert.equal(needsOverwriteSnapshot({ audit_status: 'audited', trace_id: 'tr-1' }, 'tr-1'), false);   // the trap
  assert.equal(needsOverwriteSnapshot({ audit_status: 'audited', trace_id: null }, 'tr-1'), true);
  assert.equal(needsOverwriteSnapshot({ audit_status: 'audited', trace_id: 'tr-1' }, null), true);
  assert.equal(needsOverwriteSnapshot({ audit_status: 'audited', trace_id: null }, null), true);
  assert.equal(needsOverwriteSnapshot({ audit_status: 'audited', trace_id: '' }, ''), true);            // '' is not an identity
});

// ── the replay snapshot shape ─────────────────────────────────────────────────────

const finding = {
  planned: { verdict: 'planned' },
  sameCondition: { verdict: 'same' },
  avoidable: { verdict: 'justified' },
  omissions: [{ what: 'x' }],
  templateCoverage: { ot: { count: 1, status: 'present' }, pac: { count: 0, status: 'absent' }, progress: { count: 3, status: 'present' } },
} as unknown as ReadmissionFinding;

const input: ReplayReadingInput = {
  dedupKey: 'IP-1315|IP-1390', engineVersion: 'readmission/0.2', finding,
  preventableInjury: 'not_suggested', negligence: 'not_suggested', judgementRuleVersion: 'readmit-judgement/1',
  model: 'global.anthropic.claude-opus-4-6-v1', provider: 'bedrock', traceId: 'tr-9',
  requestedModel: 'bedrock:global.anthropic.claude-opus-4-6-v1', modelMismatch: false,
  runIndex: 2, runsTotal: 3, ms: 41000, tokensIn: 900, tokensOut: 300, usd: 0.02, promoted: false,
};

test('buildReplaySnapshot: reason replay; scalars lifted from the new reading; audit_status and audited_at NULL (a replay reading was never a stored row); template_coverage lifted; the whole reading rides in row_snapshot', () => {
  const s = buildReplaySnapshot(input);
  assert.equal(s.captureReason, 'replay');
  assert.equal(s.dedupKey, 'IP-1315|IP-1390');
  assert.equal(s.engineVersion, 'readmission/0.2');
  assert.equal(s.planned, 'planned');
  assert.equal(s.sameCondition, 'same');
  assert.equal(s.avoidable, 'justified');
  assert.equal(s.preventableInjury, 'not_suggested');
  assert.equal(s.auditStatus, null);
  assert.equal(s.auditedAt, null);
  assert.equal(s.model, 'global.anthropic.claude-opus-4-6-v1');
  assert.equal(s.traceId, 'tr-9');
  assert.deepEqual(s.templateCoverage, finding.templateCoverage);
  assert.equal(s.rowSnapshot.capture_reason, 'replay');
  assert.equal(s.rowSnapshot.finding, finding);
  assert.equal(s.rowSnapshot.negligence, 'not_suggested');
  assert.equal(s.rowSnapshot.n_omissions, 1);
  assert.deepEqual(s.rowSnapshot.replay, {
    requested_model: 'bedrock:global.anthropic.claude-opus-4-6-v1', model_mismatch: false,
    run_index: 2, runs_total: 3, ms: 41000, tokens_in: 900, tokens_out: 300, usd: 0.02,
  });
});

test('the honesty note names db13 and template_coverage — the reader is told the evidence may differ', () => {
  assert.match(REPLAY_EVIDENCE_NOTE, /db13/);
  assert.match(REPLAY_EVIDENCE_NOTE, /template_coverage/);
});

// ── source pins on store.ts (the highest-risk edit) ───────────────────────────────

const store = readFileSync(join(process.cwd(), 'lib/readmission/store.ts'), 'utf8');

test('the snapshot INSERT and the overwrite UPDATE travel in ONE statement (one transaction on the Neon HTTP driver), and the CTE snapshots only an audited row', () => {
  // exactly one mention of the versions table in store.ts — the CTE inside saveAuditResult
  assert.equal((store.match(/readmission_finding_versions/g) ?? []).length, 1);
  // exactly one 'overwrite' capture literal
  assert.equal((store.match(/'overwrite'/g) ?? []).length, 1);
  // the INSERT sits in a WITH … followed (same template literal, no intervening backtick)
  // by the interpolated UPDATE — the two cannot be separated by a crash
  assert.match(store, /WITH cur AS \(\s*SELECT \* FROM readmission_findings[^`]*INSERT INTO readmission_finding_versions[^`]*RETURNING id[^`]*\)\s*\$\{updateSql\}/);
  // the CTE keeps only an audited reading, and to_jsonb(c) stores the whole row it read
  assert.match(store, /WHERE c\.audit_status = 'audited'\s*\n\s*AND \(c\.trace_id IS NULL OR \$15::text IS NULL OR c\.trace_id <> \$15::text\)/);
  assert.match(store, /to_jsonb\(c\)/);
});

test('the two ratified badge-predicate copies are byte-identical and still exactly two (the r1-card pin, asserted from the R8.1 side too)', () => {
  assert.equal((store.match(/audit_status = 'audited'\s*\n?\s*AND avoidable IN \('avoidable','needs_adjudication'\)/g) ?? []).length, 2);
});

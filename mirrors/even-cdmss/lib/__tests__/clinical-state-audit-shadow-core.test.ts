import { test } from 'node:test';
import assert from 'node:assert/strict';
import { auditShadowReport, lossyKeys } from '../clinical-state/audit-shadow-core.ts';

// Realistic persisted OpdFinding rows (opd_note_audits.findings jsonb). FULL carries every
// field the engine emits; MIN is the minimal shape; both must round-trip byte-lossless.
const FULL = {
  subject: 'Interaction: warfarin + ibuprofen',
  verdict: 'low-value',
  confidence: 0.82,
  domain: 'prescribing_safety',
  rationale: 'NSAID with warfarin raises bleeding risk',
  evidence: ['BNF interactions'],
  estimates: [],
  citation_ids: [12, 45],
  source: 'deterministic',
  informational: false,
  signal_type: 'drug_interaction',
  finding_ref: 'a1b2c3',
  rule_ref: null,
  lvc_category: 'other',
};
const MIN = {
  subject: 'Off-formulary items',
  verdict: 'context-dependent',
  confidence: 0.5,
  domain: 'appropriateness',
  rationale: '',
  evidence: [],
  estimates: [],
  citation_ids: [],
  source: 'llm',
};

test('auditShadowReport: full + minimal findings round-trip byte-lossless', () => {
  const r = auditShadowReport([FULL, MIN]);
  assert.equal(r.roundtrip_ok, true);
  assert.equal(r.n_findings, 2);
  assert.equal(r.n_lossless, 2);
  assert.deepEqual(r.lossy_fields, {});
  assert.equal(r.counts.positives, 2); // both findings map onto the note_audit ClinicalState
});

test('auditShadowReport: empty findings → vacuously ok, zero counts', () => {
  const r = auditShadowReport([]);
  assert.equal(r.roundtrip_ok, true);
  assert.equal(r.n_findings, 0);
  assert.equal(r.counts.positives, 0);
});

// ── The byte-identical persist proof (Deliverable 2 acceptance) ──
// The shadow is read-only: auditShadowReport operates on a JSON clone and never touches the
// array it is handed. Since the persisted jsonb is JSON.stringify(findings), an unchanged
// findings array ⇒ byte-identical persisted output whether the flag is on (block runs) or off
// (block skipped). This proves it at the unit level without a DB.
test('flag-OFF byte-identical: the shadow never mutates the persisted findings array', () => {
  const persisted = [structuredClone(FULL), structuredClone(MIN)];
  const before = JSON.stringify(persisted);
  auditShadowReport(persisted);                 // simulate the flag-ON path
  assert.equal(JSON.stringify(persisted), before);
  assert.deepEqual(persisted, [FULL, MIN]);     // deep value identity preserved
});

// ── Lossy detection (the shakedown signal) ──
test('auditShadowReport: flags a lossy finding (missing verdict/domain gain empty-string keys)', () => {
  const noVerdict = { subject: 'x', confidence: 1, rationale: '', evidence: [], estimates: [], citation_ids: [], source: 'llm' };
  const r = auditShadowReport([noVerdict]);
  assert.equal(r.roundtrip_ok, false);
  assert.equal(r.n_lossless, 0);
  // the adapter reconstructs verdict:'' and domain:'' where the row had neither
  assert.equal(r.lossy_fields.verdict, 1);
  assert.equal(r.lossy_fields.domain, 1);
});

test('lossyKeys: detects dropped, added, and value-changed keys; empty on identity', () => {
  assert.deepEqual(lossyKeys({ a: 1, b: 2 }, { a: 1 }), ['b']);       // dropped
  assert.deepEqual(lossyKeys({ a: 1 }, { a: 1, c: 3 }), ['c']);       // added
  assert.deepEqual(lossyKeys({ a: 1 }, { a: 2 }), ['a']);             // value changed
  assert.deepEqual(lossyKeys({ a: [1, 2] }, { a: [1, 2] }), []);      // deep-equal value, no diff
  assert.deepEqual(lossyKeys(FULL, FULL), []);
});

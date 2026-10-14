/**
 *   node --experimental-strip-types --test lib/__tests__/readmission-judgements.test.ts
 * R1 advisory judgements (CDMSS-READMISSIONS-R1-PRD v1.1 §4). The three Khan-family
 * fixtures are mandatory: the first exists to KILL the collapse where a procedure noun
 * in an omission claim was read as an intra-op event. Pure core: no DB, no model.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  deriveJudgements, JUDGEMENT_RULE_VERSION, CLINICAL_HARM_STEMS, PERI_OP_EVENT_PATTERNS,
  type JudgementInput,
} from '../readmission-reconcile-core.ts';

const om = (claim: string, danger: 'high' | 'moderate' | 'low') => ({ claim, danger });

const unplannedSame = (over: Partial<JudgementInput> = {}): JudgementInput => ({
  planned: { verdict: 'unplanned' },
  sameCondition: { verdict: 'same' },
  omissions: [],
  corroborationTrack: 'lab_corroborated',
  stabilityAssessment: 'contradicted',
  ...over,
});

test('rule version is pinned', () => {
  assert.equal(JUDGEMENT_RULE_VERSION, 'readmit-judgement/1');
});

// ── Khan fixture 1: the collapse this rule exists to prevent ─────────────────────

test('Khan 1 — "surgical site infection … wound discharge" at moderate: injury SUSPECTED, negligence UNKNOWN', () => {
  const claim = 'surgical site infection — late culture, wound discharge';
  const j = deriveJudgements(unplannedSame({ omissions: [om(claim, 'moderate')] }));
  assert.equal(j.preventableInjury, 'suspected');   // `wound` + `infect` are clinical-harm stems
  assert.equal(j.negligence, 'unknown');            // no intra-op / peri-op EVENT pattern
  // The point of the test: the word `surgical` in the claim does NOT satisfy negligence rule 3.
  assert.equal(PERI_OP_EVENT_PATTERNS.some((rx) => rx.test(claim)), false);
  assert.equal(PERI_OP_EVENT_PATTERNS.some((rx) => rx.test('surgical')), false);
  assert.equal(PERI_OP_EVENT_PATTERNS.some((rx) => rx.test('surgery')), false);
  assert.equal(PERI_OP_EVENT_PATTERNS.some((rx) => rx.test('implant')), false);
});

test('Khan 2 — "anastomotic leak evident intra-op, not recorded" on an unplanned same-condition return: negligence SUSPECTED', () => {
  const j = deriveJudgements(unplannedSame({
    omissions: [om('anastomotic leak evident intra-op, not recorded in discharge', 'moderate')],
  }));
  assert.equal(j.negligence, 'suspected');
  assert.equal(j.preventableInjury, 'suspected');   // `intra-?op` is also a harm stem
});

test('Khan 3 — the same omission with sameCondition = different: negligence UNKNOWN', () => {
  const j = deriveJudgements(unplannedSame({
    sameCondition: { verdict: 'different' },
    omissions: [om('anastomotic leak evident intra-op, not recorded in discharge', 'moderate')],
  }));
  assert.equal(j.negligence, 'unknown');
});

// ── the rest of §4, rule by rule ─────────────────────────────────────────────────

test('negligence rule 2 — absent or unknown sameCondition still qualifies; planned never does', () => {
  const o = [om('retained swab noted at re-look', 'moderate')];
  assert.equal(deriveJudgements(unplannedSame({ sameCondition: null, omissions: o })).negligence, 'suspected');
  assert.equal(deriveJudgements(unplannedSame({ sameCondition: { verdict: 'unknown' }, omissions: o })).negligence, 'suspected');
  assert.equal(deriveJudgements(unplannedSame({ planned: { verdict: 'planned' }, omissions: o })).negligence, 'unknown');
  assert.equal(deriveJudgements(unplannedSame({ planned: { verdict: 'unknown' }, omissions: o })).negligence, 'unknown');
  assert.equal(deriveJudgements(unplannedSame({ planned: null, omissions: o })).negligence, 'unknown');
});

test('negligence rule 3 — every peri-op event pattern fires; discharge-instruction language never does', () => {
  for (const claim of [
    'intraoperative bleed not documented', 'operative finding of adhesions omitted', 'calcar fracture at impaction',
    'cerclage wire placed, not in summary', 'wrong-site marking discrepancy', 'wrong site block recorded',
  ]) {
    assert.equal(deriveJudgements(unplannedSame({ omissions: [om(claim, 'low')] })).negligence, 'suspected', claim);
  }
  for (const claim of [
    'follow-up date not written', 'wound care instructions absent from discharge advice',
    'implant card not handed over', 'surgery date missing from summary', 'red-flag advice not documented',
  ]) {
    assert.equal(deriveJudgements(unplannedSame({ omissions: [om(claim, 'moderate')] })).negligence, 'unknown', claim);
  }
});

test('preventable injury — rule order: any high fires; moderate needs a harm stem; a moderate documentation gap is unknown', () => {
  assert.equal(deriveJudgements(unplannedSame({ omissions: [om('follow-up date not written', 'high')] })).preventableInjury, 'suspected');
  assert.equal(deriveJudgements(unplannedSame({ omissions: [om('follow-up date not written', 'moderate')] })).preventableInjury, 'unknown');
  assert.equal(deriveJudgements(unplannedSame({ omissions: [om('discharged unstable — K 2.9', 'moderate')] })).preventableInjury, 'suspected');
  assert.equal(deriveJudgements(unplannedSame({ omissions: [om('post-op SSI', 'moderate')] })).preventableInjury, 'suspected');
  assert.equal(deriveJudgements(unplannedSame({ omissions: [om('classification of the wound', 'moderate')] })).preventableInjury, 'suspected');
  // `\bSSI\b` is a whole word: "mission" / "assist" do not fire it.
  assert.equal(deriveJudgements(unplannedSame({ omissions: [om('permission for transfer not documented', 'moderate')] })).preventableInjury, 'unknown');
  // A LOW-danger harm-stem omission is not rule 2 (moderate only) → unknown.
  assert.equal(deriveJudgements(unplannedSame({ omissions: [om('minor wound ooze', 'low')] })).preventableInjury, 'unknown');
  assert.equal(CLINICAL_HARM_STEMS.length, 9);
});

test('rule 3 baseline — zero omissions AND lab-corroborated AND stability corroborated → not_suggested for both; anything less → unknown', () => {
  const clean = unplannedSame({ omissions: [], corroborationTrack: 'lab_corroborated', stabilityAssessment: 'corroborated' });
  assert.deepEqual(deriveJudgements(clean), { preventableInjury: 'not_suggested', negligence: 'not_suggested' });
  // Prose-only or unverifiable never earns "not suggested" — absence of labs is not confirmation.
  assert.deepEqual(deriveJudgements({ ...clean, corroborationTrack: 'prose_only' }), { preventableInjury: 'unknown', negligence: 'unknown' });
  assert.deepEqual(deriveJudgements({ ...clean, stabilityAssessment: 'unverifiable' }), { preventableInjury: 'unknown', negligence: 'unknown' });
  // The baseline does not depend on planned/sameCondition.
  assert.equal(deriveJudgements({ ...clean, planned: { verdict: 'planned' }, sameCondition: { verdict: 'different' } }).negligence, 'not_suggested');
});

test('tolerates a bare / partial / null blob (older engine rows in the backfill) — unknown, never a throw', () => {
  assert.deepEqual(deriveJudgements(null), { preventableInjury: 'unknown', negligence: 'unknown' });
  assert.deepEqual(deriveJudgements({}), { preventableInjury: 'unknown', negligence: 'unknown' });
  assert.deepEqual(deriveJudgements({ omissions: [{}] as never }), { preventableInjury: 'unknown', negligence: 'unknown' });
  assert.deepEqual(deriveJudgements({ omissions: 'not-an-array' as never }), { preventableInjury: 'unknown', negligence: 'unknown' });
});

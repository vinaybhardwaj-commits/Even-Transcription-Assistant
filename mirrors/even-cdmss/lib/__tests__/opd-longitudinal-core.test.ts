// lib/__tests__/opd-longitudinal-core.test.ts — Stage 3 Longitudinal OPD Audit pure-core tests
// (opd-longitudinal/0.1). Covers: the D2 knowability cut (boundary/self-exclusion/fold-parity/empty),
// L1 repeat-test (interval matching + unknown-analyte no-finding + normalization), L2 med-reconciliation
// (reported-stop re-prescription, active-duplicate continuation, no-false-match), L3-det missed-followup
// (unaddressed / ordered / mentioned), the context-block serializer (order, caps, truncation, deid),
// the LLM grounding gate, finding stamping + suppression pass-through, and the zero-drift non-mutation
// guard. Pure — no DB, no LLM, no network.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { MemberStateSnapshot } from '../member-state/schema';
import type { DeidOpdCase, OpdKeys } from '../opd-ingest-core';
import { presentMemberState } from '../member-state/present-core';
import { applySuppressions, type Suppression } from '../audit-suppression-core';
import {
  buildLongitudinalInput, RETEST_INTERVAL_DAYS, LONGITUDINAL_SIGNAL_TYPES,
  detectRepeatTests, detectMedReconciliation, detectMissedFollowups, runDeterministicBattery,
  serializeContextBlock, parseLongitudinalLlm, stampLongitudinal, confidenceFor, emptyLongitudinalBlock,
  buildLongitudinalUser, type LongitudinalNoteInput,
} from '../opd-longitudinal-core';

// ── fixtures ──────────────────────────────────────────────────────────────────────────────────────
const prov = (field = 'lab') => ({ sourceField: field, rawText: 'x', extractionMethod: 'reported', confidence: 1 });
const nc = (raw: string) => ({ raw, relation: 'exact' as const, normalizerVersion: 'member-norm/0.1' });

function makeSnap(): MemberStateSnapshot {
  return ({
    version: 'member-state/1.1', normalizationVersion: 'member-norm/0.1', reconciliationVersion: 'member-reconcile/0.2',
    computedAt: '2026-07-10T00:00:00Z', asOf: '2026-06-21', sourceWatermarks: { db13: '2026-07-10' },
    problems: [
      { normalizedConcept: nc('Type 2 Diabetes Mellitus'), latestDocumentedStatus: 'documented_active', latestStatusAt: '2026-06-21', firstDocumentedAt: '2026-05-09', lastDocumentedAt: '2026-06-21', course: 'recurrent', currentStatusConfidence: 0.9, occurrences: [{ encounterRef: 'presc-a', date: '2026-05-09', status: 'documented_active', provenance: prov('dx') }, { encounterRef: 'presc-b', date: '2026-06-21', status: 'documented_active', provenance: prov('dx') }] },
      { normalizedConcept: nc('Primary hypothyroidism'), latestDocumentedStatus: 'documented_active', latestStatusAt: '2026-06-19', firstDocumentedAt: '2026-01-10', lastDocumentedAt: '2026-06-19', course: 'persistent', currentStatusConfidence: 0.8, occurrences: [{ encounterRef: 'presc-a', date: '2026-06-19', status: 'documented_active', provenance: prov('dx') }] },
    ],
    medications: [
      { normalizedConcept: nc('Metformin'), status: 'stopped', firstSeen: '2026-05-09', lastSeen: '2026-06-21', occurrences: [{ encounterRef: 'presc-a', date: '2026-05-09', dose: '500 mg', provenance: prov('med') }, { encounterRef: 'cc-1', date: '2026-06-21', stopReason: 'patient_reported', provenance: prov('care_call') }] },
      { normalizedConcept: nc('Thyroxine'), status: 'prescribed', firstSeen: '2026-01-10', lastSeen: '2026-06-19', occurrences: [{ encounterRef: 'presc-a', date: '2026-06-19', dose: '50 mcg', provenance: prov('med') }] },
    ],
    allergies: [],
    investigations: [
      { normalizedAnalyte: nc('TSH'), unit: 'uiu/ml', series: [{ encounterRef: 'bk-4A19', date: '2026-06-21', value: '3.1', unit: 'uiu/ml', abnormal: 'NORMAL', provenance: prov() }] },
      { normalizedAnalyte: nc('HbA1c'), unit: '%', series: [{ encounterRef: 'bk-99', date: '2025-12-22', value: '8.2', unit: '%', abnormal: 'HIGH', provenance: prov() }] },
      { normalizedAnalyte: nc('Vitamin D'), unit: 'ng/ml', series: [{ encounterRef: 'bk-12', date: '2025-12-10', value: '8', unit: 'ng/ml', abnormal: 'LOW', provenance: prov() }] },
    ],
    conflicts: [], followUps: [], sourceEncounterRefs: ['presc-a', 'presc-b', 'bk-4A19', 'bk-12'],
  }) as unknown as MemberStateSnapshot;
}

function makeInput(over: Partial<LongitudinalNoteInput> = {}): LongitudinalNoteInput {
  return {
    uid: 'presc-c', doctorUid: 'doc-1', noteDate: '2026-07-10', engineVersion: 'opd-note-audit/0.81.7',
    investigations: ['TSH', 'HbA1c', 'CBC'],
    medications: [{ generic: 'Metformin' }, { generic: 'Thyroxine' }],
    icdCodes: ['J10'], impressions: ['Acute viral fever'], isTeleconsult: false, isReferralHandoff: false,
    caseDigest: 'Presenting complaints: fever x3d\nMedications (2)\nInvestigations ordered: TSH; HbA1c; CBC',
    ...over,
  };
}

// ── D2 cut — the applyAsOfCut cases moved to lib/__tests__/as-of-core.test.ts with the function
//    (Architecture Governance Slice 1, Part A). ──────────────────────────────────────────────────

// ── L1 — repeat test ──────────────────────────────────────────────────────────────────────────────
test('L1: TSH re-ordered within 42-day interval → one repeat_test finding citing the prior value', () => {
  const out = detectRepeatTests(makeInput(), makeSnap());
  assert.equal(out.length, 1);
  assert.equal(out[0].signal_type, 'longitudinal_repeat_test');
  assert.match(out[0].subject, /TSH/);
  assert.match(out[0].evidence[0], /3\.1/);
  assert.match(out[0].evidence[0], /bk-4A19/);
  assert.match(out[0].evidence[0], /42d/);
  assert.equal(out[0].informational, true);
  assert.equal(out[0].source, 'deterministic');
});

test('L1: HbA1c prior is OUTSIDE its 90-day interval → no finding', () => {
  const out = detectRepeatTests(makeInput({ investigations: ['HbA1c'] }), makeSnap());
  assert.equal(out.length, 0);
});

test('L1: an unmatched analyte (CBC — no canonical id) yields NO finding', () => {
  const out = detectRepeatTests(makeInput({ investigations: ['CBC', 'Complete Blood Count'] }), makeSnap());
  assert.equal(out.length, 0);
});

test('L1: analyte normalization matches note ↔ state (Vitamin D synonym within 90d)', () => {
  const snap = makeSnap();
  // move the vit-D reading to 30 days before the visit so it is inside the 90-day interval
  (snap.investigations[2].series[0] as { date: string }).date = '2026-06-10';
  const out = detectRepeatTests(makeInput({ investigations: ['25-OH Vitamin D'] }), snap);
  assert.equal(out.length, 1);
  assert.equal(out[0].signal_type, 'longitudinal_repeat_test');
});

test('L1: the retest table keys on canonical analyte ids (house defaults)', () => {
  assert.equal(RETEST_INTERVAL_DAYS.tsh, 42);
  assert.equal(RETEST_INTERVAL_DAYS.hba1c, 90);
  assert.equal(RETEST_INTERVAL_DAYS.vitamin_d_25oh, 90);
  assert.equal(RETEST_INTERVAL_DAYS.ldl_cholesterol, 365);
});

// ── L2 — medication reconciliation ─────────────────────────────────────────────────────────────────
test('L2: re-prescription of a patient-reported-stopped drug → med_reconciliation citing the stop', () => {
  const out = detectMedReconciliation(makeInput({ medications: [{ generic: 'Metformin' }] }), makeSnap());
  assert.equal(out.length, 1);
  assert.equal(out[0].signal_type, 'longitudinal_med_reconciliation');
  assert.match(out[0].subject, /reported stop/i);
  assert.match(out[0].evidence[0], /patient-reported stop/i);
  assert.equal(out[0].domain, 'prescribing_safety');
});

test('L2: continuation of an active prior prescription → med_reconciliation (duplicate continuation)', () => {
  const out = detectMedReconciliation(makeInput({ medications: [{ generic: 'Thyroxine' }] }), makeSnap());
  assert.equal(out.length, 1);
  assert.match(out[0].subject, /continued/i);
});

test('L2: no false match — a drug not in the prior state produces nothing', () => {
  const out = detectMedReconciliation(makeInput({ medications: [{ generic: 'Amoxicillin' }] }), makeSnap());
  assert.equal(out.length, 0);
});

test('L2: both cases fire together for a mixed note', () => {
  const out = detectMedReconciliation(makeInput(), makeSnap());
  assert.equal(out.length, 2);
  assert.equal(new Set(out.map((f) => f.signal_type)).size, 1);   // both the same coarse type
});

// ── L3-det — missed follow-up ──────────────────────────────────────────────────────────────────────
test('L3-det: a severe open care gap not re-ordered / not mentioned → missed_followup', () => {
  const view = presentMemberState(makeSnap());
  const out = detectMissedFollowups(makeInput(), view);
  const vit = out.filter((f) => /vitamin/i.test(f.subject));
  assert.equal(vit.length, 1);
  assert.equal(vit[0].signal_type, 'longitudinal_missed_followup');
  assert.match(vit[0].evidence[0], /open as-of visit/i);
});

test('L3-det: ORDERING the analyte in the note suppresses the finding (addressed)', () => {
  const view = presentMemberState(makeSnap());
  const out = detectMissedFollowups(makeInput({ investigations: ['Vitamin D', 'TSH'] }), view);
  assert.equal(out.filter((f) => /vitamin/i.test(f.subject)).length, 0);
});

test('L3-det: MENTIONING the analyte in the impression suppresses the finding', () => {
  const view = presentMemberState(makeSnap());
  const out = detectMissedFollowups(makeInput({ impressions: ['Vitamin D deficiency — on replacement'] }), view);
  assert.equal(out.filter((f) => /vitamin/i.test(f.subject)).length, 0);
});

test('battery: the full deterministic pass yields L1 + L2×2 + L3 on the fixture', () => {
  const snap = makeSnap();
  const view = presentMemberState(snap);
  const out = runDeterministicBattery(makeInput(), snap, view);
  const byType = out.reduce<Record<string, number>>((m, f) => { m[f.signal_type!] = (m[f.signal_type!] || 0) + 1; return m; }, {});
  assert.equal(byType.longitudinal_repeat_test, 1);
  assert.equal(byType.longitudinal_med_reconciliation, 2);
  assert.equal(byType.longitudinal_missed_followup, 1);
});

// ── serializer ─────────────────────────────────────────────────────────────────────────────────────
test('serializer: emits the priority-ordered sections and stays under the char budget', () => {
  const snap = makeSnap();
  const ctx = serializeContextBlock(snap, presentMemberState(snap));
  assert.match(ctx.text, /AS-OF MEMBER STATE/);
  assert.match(ctx.text, /Active \/ documented problems/);
  assert.match(ctx.text, /Active medications/);
  assert.ok(ctx.text.length <= 7000);
  assert.equal(ctx.encounters, 4);
});

test('serializer: validMonths grounds only real encounter months', () => {
  const snap = makeSnap();
  const ctx = serializeContextBlock(snap, presentMemberState(snap));
  assert.ok(ctx.validMonths.has('2026-06'));    // TSH / DM occurrences
  assert.ok(!ctx.validMonths.has('2026-07'));   // the visit month itself is never in prior evidence
});

test('serializer: truncates tail-first when over budget (header survives, last section dropped)', () => {
  const snap = makeSnap();
  // the serializer caps each section at ≤8 items, so inflate via very LONG problem labels — 8 problems of
  // ~1,300 chars each blows the ~7,000-char budget inside the problems section, dropping every tail section.
  const longLabel = 'Chronic multi-system condition '.repeat(45);
  const many = Array.from({ length: 8 }, (_, i) => ({
    normalizedConcept: nc(`${longLabel} #${i}`),
    latestDocumentedStatus: 'documented_active', latestStatusAt: '2026-06-01', firstDocumentedAt: '2026-01-01', lastDocumentedAt: '2026-06-01',
    course: 'persistent', currentStatusConfidence: 0.5, occurrences: [{ encounterRef: `e${i}`, date: '2026-06-01', status: 'documented_active', provenance: prov('dx') }],
  }));
  (snap as unknown as { problems: unknown[] }).problems = many;
  const ctx = serializeContextBlock(snap, presentMemberState(snap));
  assert.ok(ctx.text.length <= 7000);
  assert.match(ctx.text, /AS-OF MEMBER STATE/);            // header (highest priority) survives
  assert.ok(!/Last encounters:/.test(ctx.text));           // lowest-priority tail dropped
});

test('serializer: de-identified — no uid / member identifier can leak (serializer takes none)', () => {
  const snap = makeSnap();
  const ctx = serializeContextBlock(snap, presentMemberState(snap));
  assert.ok(!ctx.text.includes('presc-'));   // encounter join keys are never serialized into the LLM block
});

test('buildLongitudinalUser: notes the teleconsult fairness guard in the payload', () => {
  const snap = makeSnap();
  const ctx = serializeContextBlock(snap, presentMemberState(snap));
  const tele = buildLongitudinalUser(ctx, makeInput({ isTeleconsult: true }));
  assert.match(tele, /TELECONSULT/);
  const ref = buildLongitudinalUser(ctx, makeInput({ isTeleconsult: false, isReferralHandoff: true }));
  assert.match(ref, /REFERRAL \/ HANDOFF/);
});

// ── LLM grounding gate ───────────────────────────────────────────────────────────────────────────
test('LLM parse: a grounded finding is kept and mapped to the right signal type', () => {
  const valid = new Set(['2026-06']);
  const out = parseLongitudinalLlm(JSON.stringify({ findings: [
    { signal_type: 'longitudinal_contradiction', subject: 'no known comorbidities', rationale: 'record shows active DM', cited_dates: ['2026-06-21'], confidence: 0.8 },
  ] }), valid);
  assert.equal(out.length, 1);
  assert.equal(out[0].signal_type, 'longitudinal_contradiction');
  assert.equal(out[0].source, 'llm');
  assert.match(out[0].subject, /contradicts the record/i);
});

test('LLM parse: an UNGROUNDED finding (cited date not in context) is dropped (no hindsight)', () => {
  const out = parseLongitudinalLlm(JSON.stringify({ findings: [
    { signal_type: 'longitudinal_continuity', subject: 'x', rationale: 'y', cited_dates: ['2030-01-01'] },
  ] }), new Set(['2026-06']));
  assert.equal(out.length, 0);
});

test('LLM parse: continuity is the default type; malformed JSON → []', () => {
  const out = parseLongitudinalLlm(JSON.stringify({ findings: [
    { subject: 'trajectory not referenced', rationale: 'fourth visit', cited_dates: ['2026-06-19'] },
  ] }), new Set(['2026-06']));
  assert.equal(out[0].signal_type, 'longitudinal_continuity');
  assert.deepEqual(parseLongitudinalLlm('not json at all', new Set(['2026-06'])), []);
});

// ── stamping + suppression + misc ───────────────────────────────────────────────────────────────────
test('stampLongitudinal: assigns a finding_ref but PRESERVES the explicit longitudinal signal_type', () => {
  const snap = makeSnap();
  const det = runDeterministicBattery(makeInput(), snap, presentMemberState(snap));
  const stamped = stampLongitudinal(det);
  for (const f of stamped) {
    assert.ok(f.finding_ref && f.finding_ref.length >= 6);
    assert.ok(LONGITUDINAL_SIGNAL_TYPES.includes(f.signal_type as never));
  }
  // deterministic: re-stamping reproduces the same refs
  const again = stampLongitudinal(det);
  assert.deepEqual(stamped.map((f) => f.finding_ref), again.map((f) => f.finding_ref));
});

test('suppression pass-through: an active suppression drops a longitudinal type like any finding', () => {
  const snap = makeSnap();
  const stamped = stampLongitudinal(runDeterministicBattery(makeInput(), snap, presentMemberState(snap)));
  const supp: Suppression = { signal_type: 'longitudinal_repeat_test', discriminator: null, match_kind: 'type_only', scope: 'all', doctor_uid: null, action: 'drop', active: true };
  const kept = applySuppressions(stamped, 'doc-1', [supp]).findings;
  assert.equal(kept.filter((f) => f.signal_type === 'longitudinal_repeat_test').length, 0);
  assert.ok(kept.length < stamped.length);
});

test('confidenceFor: 0 → none, 1-2 → thin, ≥3 → established', () => {
  assert.equal(confidenceFor(0), 'none');
  assert.equal(confidenceFor(2), 'thin');
  assert.equal(confidenceFor(3), 'established');
});

test('emptyLongitudinalBlock: carries the honest excluded_reason and zero findings', () => {
  const b = emptyLongitudinalBlock('2026-07-10', 0, 'none', 'no_prior_history');
  assert.equal(b.version, 'opd-longitudinal/0.1');
  assert.equal(b.contextMeta.excluded_reason, 'no_prior_history');
  assert.equal(b.findings.length, 0);
});

test('buildLongitudinalInput: null without uid/date; a clean projection that never mutates the case', () => {
  const oc = ({ investigations: ['TSH'], medications: [{ generic: 'Metformin', brand: 'Glyciphage' }], diagnosisCodes: ['E11'], impressionCodes: [], impressions: ['DM'], isTeleconsult: true, isReferralHandoff: false }) as unknown as DeidOpdCase;
  const keys = ({ uid: 'presc-c', doctorUid: 'doc-1', noteDate: '2026-07-10T05:00:00Z' }) as unknown as OpdKeys;
  const input = buildLongitudinalInput(oc, keys, 'opd-note-audit/0.81.7', 'digest');
  assert.ok(input);
  assert.equal(input!.noteDate, '2026-07-10');
  assert.equal(input!.isTeleconsult, true);
  assert.deepEqual(input!.investigations, ['TSH']);
  assert.equal(buildLongitudinalInput(oc, ({ uid: '', noteDate: '' }) as unknown as OpdKeys, 'v', 'd'), null);
  assert.deepEqual(oc.investigations, ['TSH']);   // input unchanged
});

// ── zero-drift guard (non-mutation): the pass can never alter shared state the base audit reads ──────
function deepFreeze<T>(o: T): T {
  if (o && typeof o === 'object') { for (const v of Object.values(o)) deepFreeze(v); Object.freeze(o); }
  return o;
}
test('zero-drift: the battery + serializer + stamp never mutate the snapshot or note input', () => {
  const snap = makeSnap();
  const view = presentMemberState(snap);        // built BEFORE freezing (derived view is the pass input)
  const input = makeInput();
  deepFreeze(snap); deepFreeze(input); deepFreeze(view);
  assert.doesNotThrow(() => {
    const det = runDeterministicBattery(input, snap, view);
    serializeContextBlock(snap, view);
    stampLongitudinal(det);
  });
});

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildLongitudinalGates } from '@/lib/opd-longitudinal-lane-core';
import { LONGITUDINAL_SIGNAL_TYPES, buildLabelLane, promotionGate, isRoutable, type TriageFinding } from '@/lib/opd-triage-core';

test('buildLongitudinalGates seeds all 5 longitudinal types at 0/0', () => {
  const g = buildLongitudinalGates([]);
  assert.equal(Object.keys(g).length, 5);
  for (const t of LONGITUDINAL_SIGNAL_TYPES) {
    assert.deepEqual(g[t], { labelled: 0, fpRate: 0 });
  }
});

test('overlays signal-health decided → labelled and fp_rate → fpRate for longitudinal types', () => {
  const g = buildLongitudinalGates([
    { signal_type: 'longitudinal_repeat_test', decided: 51, fp_rate: 0.14 },
    { signal_type: 'longitudinal_continuity', decided: 52, fp_rate: 0.31 },
  ]);
  assert.deepEqual(g.longitudinal_repeat_test, { labelled: 51, fpRate: 0.14 });
  assert.deepEqual(g.longitudinal_continuity, { labelled: 52, fpRate: 0.31 });
  // untouched types stay seeded
  assert.deepEqual(g.longitudinal_contradiction, { labelled: 0, fpRate: 0 });
});

test('ignores non-longitudinal (routable) signal types from signal-health', () => {
  const g = buildLongitudinalGates([
    { signal_type: 'drug_interaction', decided: 900, fp_rate: 0.5 },
    { signal_type: 'longitudinal_med_reconciliation', decided: 10, fp_rate: 0.2 },
  ]);
  assert.equal(g.drug_interaction, undefined);
  assert.deepEqual(g.longitudinal_med_reconciliation, { labelled: 10, fpRate: 0.2 });
});

test('clamps out-of-range / non-finite fp_rate and negative decided', () => {
  const g = buildLongitudinalGates([
    { signal_type: 'longitudinal_missed_followup', decided: -5, fp_rate: 1.9 },
    { signal_type: 'longitudinal_contradiction', decided: 3.9, fp_rate: NaN },
  ]);
  assert.deepEqual(g.longitudinal_missed_followup, { labelled: 0, fpRate: 1 });
  assert.deepEqual(g.longitudinal_contradiction, { labelled: 3, fpRate: 0 });   // floor(3.9)=3, NaN→0
});

test('gates feed buildLabelLane → promotion status matches promotionGate directly', () => {
  const gates = buildLongitudinalGates([
    { signal_type: 'longitudinal_repeat_test', decided: 51, fp_rate: 0.14 },   // eligible
    { signal_type: 'longitudinal_continuity', decided: 52, fp_rate: 0.31 },    // failing
    { signal_type: 'longitudinal_contradiction', decided: 8, fp_rate: 0.12 },  // collecting
  ]);
  const mk = (signal_type: string, i: number): TriageFinding => ({
    audit_id: `a${i}`, doctor_uid: 'doc1', note_date: '2026-07-10',
    subject: `${signal_type}: x`, rationale: 'r', verdict: 'context-dependent',
    domain: 'appropriateness', signal_type, finding_ref: `ref-${signal_type}-${i}`,
    informational: true, citation_ids: [],
  });
  const findings: TriageFinding[] = [
    mk('longitudinal_repeat_test', 1), mk('longitudinal_continuity', 2), mk('longitudinal_contradiction', 3),
  ];
  const { types } = buildLabelLane(findings, [], { gates });
  const byType = new Map(types.map((t) => [t.signal_type, t]));
  assert.equal(byType.get('longitudinal_repeat_test')!.gate!.status, promotionGate(51, 0.14).status);
  assert.equal(byType.get('longitudinal_repeat_test')!.gate!.status, 'eligible');
  assert.equal(byType.get('longitudinal_continuity')!.gate!.status, 'failing');
  assert.equal(byType.get('longitudinal_contradiction')!.gate!.status, 'collecting');
});

test('lane only contains non-routable longitudinal types (routable dropped)', () => {
  const gates = buildLongitudinalGates([]);
  const findings: TriageFinding[] = [
    { audit_id: 'a1', doctor_uid: 'd', note_date: '2026-07-10', subject: 'drug_interaction: x', rationale: 'r',
      verdict: 'low-value', domain: 'prescribing_safety', signal_type: 'drug_interaction', finding_ref: 'r1',
      informational: false, citation_ids: [] },
    { audit_id: 'a2', doctor_uid: 'd', note_date: '2026-07-10', subject: 'longitudinal_repeat_test: x', rationale: 'r',
      verdict: 'context-dependent', domain: 'appropriateness', signal_type: 'longitudinal_repeat_test', finding_ref: 'r2',
      informational: true, citation_ids: [] },
  ];
  const { types } = buildLabelLane(findings, [], { gates });
  assert.equal(types.length, 1);
  assert.equal(types[0].signal_type, 'longitudinal_repeat_test');
  assert.equal(isRoutable('drug_interaction'), true);
  assert.equal(isRoutable('longitudinal_repeat_test'), false);
});

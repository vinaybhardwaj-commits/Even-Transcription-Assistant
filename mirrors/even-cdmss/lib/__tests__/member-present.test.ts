import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  MEMBER_PRESENT_VERSION, classifyProblemTier, flagAbnormalLabs, computeCareGaps,
  computePictureConfidence, buildVitalsView, buildAttentionFlags, resolveProblemLabel,
  type VitalsRead, type ModalityMix,
} from '../member-state/present-augment';
import type {
  LongitudinalProblem, LongitudinalMedication, LongitudinalInvestigation, MemberStateSnapshot,
  ProblemCourse, NormalizedConcept,
} from '../member-state/schema';
import type { Provenance } from '../clinical-state/schema';
import { canonicalAnalyte, bandValue } from '../member-state/lab-reference-ranges';

const NOW = '2026-07-12T00:00:00.000Z';
const prov = (): Provenance => ({ sourceField: 'dx', rawText: 'x', extractionMethod: 'reported', confidence: 0.9, trust: 'structured_db' });
const nc = (raw: string, id: string | null = null): NormalizedConcept => ({ raw, relation: 'exact', normalizerVersion: 'member-norm/0.1', normalizedConceptId: id });

function prob(raw: string, last: string, opts: { occ?: number; course?: ProblemCourse; first?: string } = {}): LongitudinalProblem {
  const occ = opts.occ ?? 1;
  const occurrences = Array.from({ length: occ }, (_, i) => ({ encounterRef: `e${i}`, date: last, status: 'documented_active' as const, provenance: prov() }));
  return {
    normalizedConcept: nc(raw), latestDocumentedStatus: 'documented_active', latestStatusAt: last,
    firstDocumentedAt: opts.first ?? last, lastDocumentedAt: last,
    course: opts.course ?? 'single_episode', currentStatusConfidence: 0.5, occurrences,
  };
}
function invest(raw: string, unit: string | null, pts: { date: string; value: string; abnormal?: string | null }[]): LongitudinalInvestigation {
  return { normalizedAnalyte: nc(raw), unit, series: pts.map((p, i) => ({ encounterRef: `e${i}`, date: p.date, value: p.value, unit, abnormal: p.abnormal ?? null, provenance: prov() })) };
}
function medi(raw: string): LongitudinalMedication {
  return { normalizedConcept: nc(raw), status: 'prescribed', firstSeen: '2024-01-01', lastSeen: '2024-01-01', occurrences: [{ encounterRef: 'e0', date: '2024-01-01', provenance: prov() }] };
}

// ── versions ──
test('version', () => { assert.equal(MEMBER_PRESENT_VERSION, 'member-present/0.2'); });

// ── resolveProblemLabel (Decision D) ──
test('resolveProblemLabel: map hit, source-text preference, unknown → neutral', () => {
  assert.deepEqual(resolveProblemLabel({ raw: 'N77.1' }), { label: 'Bacterial vaginosis', code: 'N77.1', unmapped: false });
  assert.equal(resolveProblemLabel({ raw: 'E55.9' }).label, 'Vitamin D deficiency');
  // raw is already human display text → preferred verbatim (not treated as a code)
  const human = resolveProblemLabel({ raw: 'Bacterial vaginosis' });
  assert.equal(human.label, 'Bacterial vaginosis');
  assert.equal(human.unmapped, false);
  // unknown but code-shaped → code + neutral, unmapped flagged (never blank, never a guess).
  // (Sentinel moved off X99.9 when the 98k icd-master landed: X99 is a real master category,
  // so X99.9 now correctly labels via the exact-category fallback. A10 has no master row.)
  const unk = resolveProblemLabel({ raw: 'A10.9' });
  assert.equal(unk.unmapped, true);
  assert.match(unk.label, /A10\.9/);
  assert.equal(unk.code, 'A10.9');
});

// ── classifyProblemTier (Decision E) ──
test('classifyProblemTier: active/background/historical (recency, recurrence, incidental)', () => {
  assert.equal(classifyProblemTier(prob('N77.1', '2026-02-01'), NOW), 'active');       // 5mo → active
  assert.equal(classifyProblemTier(prob('Z31.61', '2025-03-15'), NOW), 'active');      // ~16mo ≤18 → active
  assert.equal(classifyProblemTier(prob('E55.9', '2023-12-01'), NOW), 'background');   // ~31mo, not incidental
  assert.equal(classifyProblemTier(prob('Z01.89', '2023-12-01'), NOW), 'historical');  // >18mo, exam/screening incidental
  assert.equal(classifyProblemTier(prob('L82.1', '2024-12-01'), NOW), 'historical');   // ~19mo, cosmetic-derm incidental
  assert.equal(classifyProblemTier(prob('N77.1', '2020-01-01', { occ: 3 }), NOW), 'active'); // recurrence ≥2 → active
});

// ── flagAbnormalLabs (Decision F — unit-aware, sex-specific, trend) ──
test('flagAbnormalLabs: banding, unit-mismatch = no flag, sex-specific, trend', () => {
  const vitD = flagAbnormalLabs([invest('Vitamin D (25-OH)', 'ng/mL', [{ date: '2023-12-01', value: '8.0' }])], null);
  assert.equal(vitD.surfaced.length, 1);
  assert.equal(vitD.surfaced[0].band, 'critical');
  assert.equal(vitD.surfaced[0].abnormal, true);

  const b12 = flagAbnormalLabs([invest('Vitamin B12', 'pg/mL', [{ date: '2023-12-01', value: '193' }])], null);
  assert.equal(b12.surfaced[0].band, 'low');

  // UNIT MISMATCH → not banded → single normal-by-default reading is NOT surfaced (counted normal)
  const mismatch = flagAbnormalLabs([invest('Vitamin D (25-OH)', 'nmol/L', [{ date: '2023-12-01', value: '8.0' }])], null);
  assert.equal(mismatch.surfaced.length, 0);
  assert.equal(mismatch.normalCount, 1);

  // in-range single reading → normalCount, not surfaced
  const norm = flagAbnormalLabs([invest('HbA1c', '%', [{ date: '2026-01-01', value: '5.1' }])], null);
  assert.equal(norm.surfaced.length, 0);
  assert.equal(norm.normalCount, 1);

  // multi-reading in-range → surfaced as a TREND (not abnormal)
  const trend = flagAbnormalLabs([invest('HbA1c', '%', [{ date: '2025-01-01', value: '5.1' }, { date: '2026-01-01', value: '5.3' }])], null);
  assert.equal(trend.surfaced.length, 1);
  assert.equal(trend.surfaced[0].abnormal, false);
  assert.equal(trend.surfaced[0].surfacedReason, 'trend');

  // sex-specific: Hb 12.5 g/dL → low for M (13–17), normal (not surfaced) for unknown-sex (neutral 12–17)
  const hbM = flagAbnormalLabs([invest('Haemoglobin', 'g/dL', [{ date: '2026-01-01', value: '12.5' }])], 'M');
  assert.equal(hbM.surfaced[0].band, 'low');
  const hbNull = flagAbnormalLabs([invest('Haemoglobin', 'g/dL', [{ date: '2026-01-01', value: '12.5' }])], null);
  assert.equal(hbNull.surfaced.length, 0);
});

// ── computeCareGaps (Decision G) ──
test('computeCareGaps: abnormal-not-rechecked > 6mo; recent excluded; normal excluded', () => {
  const meds = [medi('Cholecalciferol (Vitamin D)')];
  const old = computeCareGaps([invest('Vitamin D (25-OH)', 'ng/mL', [{ date: '2023-12-01', value: '8.0' }])], meds, NOW);
  assert.equal(old.length, 1);
  assert.equal(old[0].onTreatment, true);
  assert.equal(old[0].severity, 'safety');       // critical band → escalation-worthy

  const recent = computeCareGaps([invest('Vitamin D (25-OH)', 'ng/mL', [{ date: '2026-06-01', value: '8.0' }])], meds, NOW);
  assert.equal(recent.length, 0);                 // < 6mo → not yet a gap

  const normal = computeCareGaps([invest('Vitamin D (25-OH)', 'ng/mL', [{ date: '2023-12-01', value: '42' }])], meds, NOW);
  assert.equal(normal.length, 0);                 // latest in range → no gap
});

// ── computePictureConfidence (Decision H, §2.5) ──
// D-B: both fixtures are DOCUMENTED members (documented === total) — their assess_mode really is
// recorded, so they keep classifying exactly as before. The undocumented case is its own fixture.
const REMOTE_MODALITY: ModalityMix = { total: 8, counts: { NOT_POSSIBLE_IN_ONLINE_CONSULTATION: 1 }, documented: 8, inPerson: 0, remoteOrUndocumented: 8, majority: 'remote', lastAssessMode: 'NOT_POSSIBLE_IN_ONLINE_CONSULTATION', lastAssessAt: '2026-02-01' };
const INPERSON_MODALITY: ModalityMix = { total: 3, counts: { IN_PERSON: 3 }, documented: 3, inPerson: 3, remoteOrUndocumented: 0, majority: 'in_person', lastAssessMode: 'IN_PERSON', lastAssessAt: '2026-07-12' };

test('computePictureConfidence: Ravali-like → THIN; in-person recent → GOOD', () => {
  const thin = computePictureConfidence({
    lastContact: '2026-02-01', vitalsEver: false, modalityMix: REMOTE_MODALITY,
    lastLab: '2023-12-01', problems: Array.from({ length: 8 }, () => ({ course: 'single_episode', occurrences: 1 })),
    encounters: { opd: 8, ipd: 0 },
  }, NOW);
  assert.equal(thin.level, 'THIN');
  assert.equal(thin.factors.find((f) => f.key === 'vitals')!.dot, 'r');
  assert.equal(thin.factors.find((f) => f.key === 'modality')!.dot, 'r');
  assert.equal(thin.factors.find((f) => f.key === 'labs')!.dot, 'r');

  const good = computePictureConfidence({
    lastContact: '2026-07-10', vitalsEver: true, modalityMix: INPERSON_MODALITY,
    lastLab: '2026-06-01', problems: [{ course: 'persistent', occurrences: 3 }, { course: 'recurrent', occurrences: 2 }],
    encounters: { opd: 3, ipd: 0 },
  }, NOW);
  assert.equal(good.level, 'GOOD');
  assert.equal(good.factors.find((f) => f.key === 'contact')!.dot, 'g');
  assert.equal(good.factors.find((f) => f.key === 'vitals')!.dot, 'g');
});

// ── buildVitalsView (Decision I) ──
test('buildVitalsView: numbers + EWS surfaced when present; honest absence otherwise', () => {
  const v: VitalsRead = {
    createdAt: '2026-07-01', bp: '180/94', bpTag: 'HIGH', pulse: '76', pulseTag: 'NORMAL',
    spo2: '98', spo2Tag: 'NORMAL', temp: '98.1', tempTag: 'NORMAL', rr: '19',
    ews: 4, ewsTag: 'HIGH RISK', ewsDesc: 'Advise clinical review.',
  };
  const view = buildVitalsView(v, INPERSON_MODALITY);
  assert.equal(view.hasVitals, true);
  assert.equal(view.measuredAt, '2026-07-01');
  assert.equal(view.ews!.score, 4);
  assert.equal(view.ews!.high, true);
  assert.equal(view.items.find((i) => i.label === 'Blood pressure')!.flag, true);
  assert.equal(view.items.find((i) => i.label === 'Pulse')!.flag, false);

  const absent = buildVitalsView(null, REMOTE_MODALITY);
  assert.equal(absent.hasVitals, false);
  assert.equal(absent.items.length, 0);
  assert.match(absent.absentNote!, /No vitals on record/);
  assert.match(absent.modalityNote!, /not possible in online consultation/i);
});

// ── buildAttentionFlags (deterministic) ──
test('buildAttentionFlags: medication conflict + critical lab surface as flags', () => {
  const snap = { conflicts: [
    { id: 'c1', domain: 'medication', type: 'status_conflict', severity: 'review', resolutionStatus: 'open',
      assertions: [{ encounterRef: 'e1', date: '2026-02-01', detail: 'Folinext D: prescribed vs reported stopped' }] },
  ] } as unknown as MemberStateSnapshot;
  const labs = flagAbnormalLabs([invest('Vitamin D (25-OH)', 'ng/mL', [{ date: '2023-12-01', value: '8.0' }])], null).surfaced;
  const gaps = computeCareGaps([invest('Vitamin D (25-OH)', 'ng/mL', [{ date: '2023-12-01', value: '8.0' }])], [medi('Cholecalciferol')], NOW);
  const flags = buildAttentionFlags(snap, labs, gaps);
  assert.ok(flags.some((f) => f.kind === 'med_conflict'));
  assert.ok(flags.some((f) => f.kind === 'abnormal_lab' && f.severity === 'safety'));
  assert.equal(flags[0].severity, 'safety');   // safety-first ordering
});

// ── PATCH: abnormal-lab completeness (real db strings) ──
test('patch/1: canonicalAnalyte tolerant match — real Vit D db name → severe band', () => {
  // exact-lookup MISS on the parenthetical db name, tolerant retry strips "(...)" → maps.
  assert.equal(canonicalAnalyte('Vitamin D (25 OH Cholecalciferol)'), 'vitamin_d_25oh');
  assert.equal(canonicalAnalyte('Vitamin D (25-OH)'), 'vitamin_d_25oh');   // exact alias still works
  const banded = bandValue('vitamin_d_25oh', 8.01, 'ng/mL', null);
  assert.equal(banded!.band, 'critical');
});

test('patch/1: real Vit D (8.01 ng/mL) surfaces in labs, gaps AND attention', () => {
  const meds = [medi('Cholecalciferol (Vitamin D)')];
  const iv = [invest('Vitamin D (25 OH Cholecalciferol)', 'ng/mL', [{ date: '2023-12-01', value: '8.01', abnormal: 'ABNORMAL' }])];
  const labs = flagAbnormalLabs(iv, null);
  const vd = labs.surfaced.find((l) => /vitamin d/i.test(l.analyte))!;
  assert.equal(vd.band, 'critical');
  assert.equal(vd.abnormal, true);

  const gaps = computeCareGaps(iv, meds, NOW);
  assert.equal(gaps.length, 1);
  assert.equal(gaps[0].onTreatment, true);
  assert.equal(gaps[0].severity, 'safety');

  const snap = { conflicts: [] } as unknown as MemberStateSnapshot;
  const flags = buildAttentionFlags(snap, labs.surfaced, gaps);
  assert.ok(flags.some((f) => f.kind === 'abnormal_lab' && f.severity === 'safety' && /vitamin d/i.test(f.text)));
});

test('patch/2: safety-net item is SURFACED (labs) but NOT PROMOTED (no gap, no attention flag)', () => {
  const iv = [invest('Non-HDL Cholesterol', 'mg/dL', [{ date: '2023-12-01', value: '160', abnormal: 'ABNORMAL' }])];
  const labs = flagAbnormalLabs(iv, null);
  // still surfaced in the labs list (nothing hidden)
  assert.equal(labs.surfaced.length, 1);
  assert.equal(labs.surfaced[0].band, 'abnormal');
  assert.equal(labs.surfaced[0].abnormal, true);
  assert.equal(labs.surfaced[0].refText, 'flagged by lab');   // NO invented severity
  // patch 2: source-flagged-only, no range → NOT a care gap, NOT an attention flag
  assert.equal(computeCareGaps(iv, [], NOW).length, 0);
  const snap = { conflicts: [] } as unknown as MemberStateSnapshot;
  const flags = buildAttentionFlags(snap, labs.surfaced, computeCareGaps(iv, [], NOW));
  assert.equal(flags.filter((f) => f.kind === 'abnormal_lab').length, 0);
});

test('patch/2: latest source-NORMAL + no range → NOT surfaced (nothing over-flagged)', () => {
  const iv = [invest('Some Unmapped Panel', 'mg/dL', [{ date: '2023-12-01', value: '5', abnormal: 'NORMAL' }])];
  const labs = flagAbnormalLabs(iv, null);
  assert.equal(labs.surfaced.length, 0);
  assert.equal(labs.normalCount, 1);
});

test('patch/3: trend de-clutter — stable repeats collapse, differing values surface', () => {
  const stable = flagAbnormalLabs([invest('SGPT', 'U/L', [{ date: '2025-01-01', value: '30' }, { date: '2026-01-01', value: '30' }])], null);
  assert.equal(stable.surfaced.length, 0);
  assert.equal(stable.normalCount, 1);

  const differ = flagAbnormalLabs([invest('SGPT', 'U/L', [{ date: '2025-01-01', value: '30' }, { date: '2026-01-01', value: '34' }])], null);
  assert.equal(differ.surfaced.length, 1);
  assert.equal(differ.surfaced[0].surfacedReason, 'trend');
  assert.equal(differ.surfaced[0].abnormal, false);
});

// ── determinism ──
test('determinism: fns twice → deep-equal', () => {
  const p = prob('Z31.61', '2025-03-15');
  assert.equal(classifyProblemTier(p, NOW), classifyProblemTier(p, NOW));
  const iv = [invest('Vitamin B12', 'pg/mL', [{ date: '2023-12-01', value: '193' }])];
  assert.deepEqual(flagAbnormalLabs(iv, null), flagAbnormalLabs(iv, null));
  const ci = { lastContact: '2026-02-01', vitalsEver: false, modalityMix: REMOTE_MODALITY, lastLab: '2023-12-01', problems: [{ course: 'single_episode', occurrences: 1 }], encounters: { opd: 8, ipd: 0 } };
  assert.deepEqual(computePictureConfidence(ci, NOW), computePictureConfidence(ci, NOW));
});

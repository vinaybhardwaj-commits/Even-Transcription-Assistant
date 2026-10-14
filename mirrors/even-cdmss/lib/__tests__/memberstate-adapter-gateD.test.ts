// lib/__tests__/memberstate-adapter-gateD.test.ts — MemberState adapter (#5) SL2: the
// no-regression proof (Gate D). Runs the FROZEN spine (buildMemberState) over the entire
// member-bank/1.0 gold flag-off (baseline) vs flag-on (admission composed), and over a controlled
// reconcile-touching fixture, and asserts:
//   1. NO REGRESSION — for every ratified gold case, flag-on == flag-off, byte-identical. (No gold
//      member has a composable admission — synthetic ids — so the composition path leaves every
//      ratified verdict untouched.)
//   2. ADDITIVE-ONLY — when an admission IS composed (the fixture), every pre-existing occurrence is
//      preserved unchanged and EVERY delta is admission-anchored: the delta set is a strict
//      superset, never a mutation of a ratified verdict.
// Measurement only — no core edit. `git diff lib/member-state/**` empty is asserted in the report.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { GOLD_SEED } from '../member-state/validation/gold-seed';
import { buildMemberState } from '../member-state/aggregate-core';
import { assembleEvidence } from '../member-state/assemble-core';
import { assembleEvidenceWithAdmission, dischargeToEncounter } from '../member-state-adapters/discharge-evidence';
import type { EpisodeState } from '../episode-state/schema';
import type { MemberStateSnapshot, MemberEvidence } from '../member-state/schema';
import type { MemberEvidenceWithAdmission } from '../member-state-adapters/discharge-evidence';

const T = '2026-07-01T00:00:00.000Z';
const J = (x: unknown) => JSON.stringify(x);

// The compose→aggregate type-boundary bridge. The frozen buildMemberState takes MemberEvidence
// (kind ∈ opd|lab|care_call); the composed evidence carries the widened kind:'admission' encounter.
// The spine's aggregation is KIND-AGNOSTIC — buildProblems/buildMedications/… iterate every
// encounter regardless of kind — so the admission encounter flows through structurally at runtime
// (verified). This cast bridges the type boundary a future SL3 caller formalizes; no core edit.
const spineInput = (e: MemberEvidenceWithAdmission): MemberEvidence => e as unknown as MemberEvidence;

function withFlag<R>(on: boolean, fn: () => R): R {
  const prev = process.env.MEMBERSTATE_ADMISSION_ADAPTER;
  if (on) process.env.MEMBERSTATE_ADMISSION_ADAPTER = '1'; else delete process.env.MEMBERSTATE_ADMISSION_ADAPTER;
  try { return fn(); } finally {
    if (prev === undefined) delete process.env.MEMBERSTATE_ADMISSION_ADAPTER; else process.env.MEMBERSTATE_ADMISSION_ADAPTER = prev;
  }
}

// ── (1) NO REGRESSION across the whole member-bank/1.0 gold ──
test('Gate D · no regression: every ratified gold case is byte-identical flag-on vs flag-off', () => {
  let identical = 0; const moved: string[] = [];
  for (const gc of GOLD_SEED) {
    const off = buildMemberState(gc.evidence, T);
    // these synthetic gold members have NO persisted admission ⇒ the composition path adds nothing;
    // the null-episode compose is the frozen path exactly (proven byte-identical in SL1).
    const on = withFlag(true, () => buildMemberState({ ...gc.evidence, encounters: [...gc.evidence.encounters] }, T));
    if (J(off) === J(on)) identical++; else moved.push(gc.evidence.memberRef);
  }
  assert.equal(moved.length, 0, `ratified verdicts moved for: ${moved.join(', ')}`);
  assert.equal(identical, GOLD_SEED.length);
  assert.ok(GOLD_SEED.length >= 12, 'the whole gold is exercised');
});

// ── the additive-superset checker: every baseline occurrence preserved; every delta admission-anchored ──
const keyOf = (e: Record<string, unknown>): string => {
  const nc = e.normalizedConcept as { raw?: string } | undefined;
  const sub = e.substance as { raw?: string } | undefined;
  return String(nc?.raw ?? sub?.raw ?? e.analyteRaw ?? '');
};
function additiveViolations(off: MemberStateSnapshot, on: MemberStateSnapshot, admRef: string): string[] {
  const viol: string[] = [];
  for (const dim of ['problems', 'medications', 'allergies', 'investigations'] as const) {
    const offE = off[dim] as unknown as Record<string, unknown>[];
    const onE = on[dim] as unknown as Record<string, unknown>[];
    const onByKey = new Map(onE.map((e) => [keyOf(e), e]));
    const offKeys = new Set(offE.map(keyOf));
    for (const oe of offE) {
      const one = onByKey.get(keyOf(oe));
      if (!one) { viol.push(`${dim}:${keyOf(oe)} REMOVED`); continue; }
      const offOcc = (oe.occurrences as { encounterRef: string }[] | undefined) ?? [];
      const onOcc = (one.occurrences as { encounterRef: string }[] | undefined) ?? [];
      // every baseline (non-admission) occurrence must survive byte-identical
      for (const o of offOcc) {
        const m = onOcc.find((x) => x.encounterRef === o.encounterRef);
        if (!m || J(m) !== J(o)) viol.push(`${dim}:${keyOf(oe)} baseline occ ${o.encounterRef} CHANGED/MISSING`);
      }
      // any EXTRA occurrence must be admission-anchored
      for (const o of onOcc) if (!offOcc.find((x) => x.encounterRef === o.encounterRef) && o.encounterRef !== admRef) {
        viol.push(`${dim}:${keyOf(oe)} extra occ ${o.encounterRef} NOT admission-anchored`);
      }
    }
    // any NEW entry must be entirely admission-anchored
    for (const one of onE) if (!offKeys.has(keyOf(one))) {
      const occ = (one.occurrences as { encounterRef: string }[] | undefined) ?? [];
      if (!occ.length || !occ.every((o) => o.encounterRef === admRef)) viol.push(`${dim}:${keyOf(one)} NEW entry not admission-anchored`);
    }
  }
  // no ratified conflict removed
  for (const c of off.conflicts) if (!on.conflicts.find((x) => x.id === c.id)) viol.push(`conflict ${c.id} REMOVED`);
  return viol;
}

// ── the reconcile-touching fixture: an OPD member (from rows) + its own admission ──
const fact = (value: string, sf: string, m: 'deterministic' | 'reported' = 'deterministic') =>
  ({ value, provenance: { sourceField: sf, rawText: value, extractionMethod: m, confidence: 1, startOffset: 0, endOffset: value.length } });
const INPUT = {
  memberRef: 'FIX-1', generatedAt: T, sourceWatermarks: { prescriptions: '2026-05-30' },
  prescriptionRows: [
    { uid: 'p1', visit_date: '2024-06-01', diagnosis_icd_codes: ['E11'], medications: [{ brand_name: 'atorvastatin', generic_name: 'atorvastatin' }] },
    { uid: 'p2', visit_date: '2025-06-01', diagnosis_icd_codes: ['E11'], medications: [{ brand_name: 'atorvastatin', generic_name: 'atorvastatin' }] },
  ],
  labRows: [] as Record<string, unknown>[],
};
const EPISODE: EpisodeState = {
  version: 'episode-state/0.2', episodeRef: 'IP-FIX', demographics: { age: 60, sex: 'M', sexRaw: 'male' },
  pre: { presentingComplaints: [], priorConditions: [], homeMedications: [] },
  intra: {
    admission: { speciality: null, ward: null, admissionType: null, careSetting: null, dischargeType: null,
      lengthOfStayDays: null, admitDate: fact('2025-09-01', 'kx.admitDate', 'reported'), dischargeDate: fact('2025-09-05', 'kx.dischargeDate', 'reported') },
    diagnosis: fact('I10', 'extract.diagnosis'),                       // NEW problem (not in the OPD history)
    procedures: [],
    medications: [fact('atorvastatin', 'extract.medications'), fact('aspirin', 'extract.medications')],  // atorvastatin OVERLAPS OPD; aspirin NEW
    investigations: [], treatments: [], courseSummary: fact('x', 'extract.courseSummary'), billing: { netTotal: null },
  },
  post: { dischargeMedications: [], followUpPlan: [], warningSigns: [] },
};

test('Gate D · additive-only: composing an admission preserves every baseline occurrence, all deltas admission-anchored', () => {
  const off = buildMemberState(assembleEvidence(INPUT), T);
  const on = withFlag(true, () => buildMemberState(spineInput(assembleEvidenceWithAdmission(INPUT, EPISODE)), T));
  const admRef = dischargeToEncounter(EPISODE).encounterRef;   // 'IP-FIX'

  // the load-bearing assertion — the delta is a strict superset, never a mutation
  assert.deepEqual(additiveViolations(off, on, admRef), [], 'a pre-existing verdict was mutated (Gate D FAIL)');

  // and it actually TOUCHED the med-rec machinery (not a vacuous no-op fixture):
  const atorOff = off.medications.find((m) => m.normalizedConcept.raw === 'atorvastatin')!;
  const atorOn = on.medications.find((m) => m.normalizedConcept.raw === 'atorvastatin')!;
  assert.equal(atorOff.occurrences.length, 2, 'baseline atorvastatin has 2 OPD occurrences');
  assert.equal(atorOn.occurrences.length, 3, 'the admission adds exactly one occurrence (reconciled)');
  assert.deepEqual(atorOn.occurrences.slice(0, 2), atorOff.occurrences, 'the 2 OPD occurrences are byte-identical');
  assert.equal(atorOn.occurrences[2].encounterRef, admRef, 'the added occurrence is admission-anchored');

  // new admission-anchored entries appear; pre-existing ratified ones are untouched
  assert.ok(on.medications.some((m) => m.normalizedConcept.raw === 'aspirin'), 'aspirin (new) appears');
  assert.ok(!off.medications.some((m) => m.normalizedConcept.raw === 'aspirin'), 'aspirin is not in the baseline');
  assert.ok(on.problems.some((p) => p.normalizedConcept.raw === 'I10'), 'I10 (admission diagnosis) appears as a new problem');

  // E11 (not re-documented by the admission): its EVIDENCE (occurrences) is byte-identical — no
  // baseline fact is mutated. But its DERIVED longitudinal status shifts documented_active →
  // uncertain_current_status, because the admission is a newer encounter that OMITS E11 and the
  // spine's omission invariant (member-bank/1.0 case S4) marks an omitted-at-latest problem as
  // uncertain. This is designed spine reasoning, NOT an occurrence mutation — and it is the reason
  // v1 is scoped to MEDICATION reconciliation only (problem-continuity-under-admission is v1.1,
  // needing its own ratification). Surfaced explicitly here, never hidden.
  const e11off = off.problems.find((p) => p.normalizedConcept.raw === 'E11')!;
  const e11on = on.problems.find((p) => p.normalizedConcept.raw === 'E11')!;
  assert.deepEqual(e11on.occurrences, e11off.occurrences, 'E11 occurrences (evidence facts) are byte-identical — nothing mutated');
  const e11onR = e11on as unknown as Record<string, unknown>;
  const e11offR = e11off as unknown as Record<string, unknown>;
  const problemDeltaFields = Object.keys(e11onR).filter((k) => J(e11onR[k]) !== J(e11offR[k])).sort();
  assert.deepEqual(problemDeltaFields, ['currentStatusConfidence', 'latestDocumentedStatus'],
    'the problem delta is confined to DERIVED status inferences (omission invariant), not occurrences');
  assert.equal(e11on.latestDocumentedStatus, 'uncertain_current_status', 'the omission invariant fires as designed');

  // additive summary fields advance, never regress: asOf forward, sourceEncounterRefs a superset
  assert.ok(on.asOf >= off.asOf, 'asOf advances (admission is newer)');
  assert.ok(off.sourceEncounterRefs.every((r) => on.sourceEncounterRefs.includes(r)), 'no source encounter dropped');
  assert.ok(on.sourceEncounterRefs.includes(admRef), 'the admission encounter is added to the sources');
});

test('Gate D · flag-off: the fixture is byte-identical to the frozen spine (composition does not fire)', () => {
  const off = buildMemberState(assembleEvidence(INPUT), T);
  const flagOff = withFlag(false, () => buildMemberState(spineInput(assembleEvidenceWithAdmission(INPUT, EPISODE)), T));
  assert.equal(J(flagOff), J(off), 'flag off ⇒ the admission is never composed; identical to frozen');
});

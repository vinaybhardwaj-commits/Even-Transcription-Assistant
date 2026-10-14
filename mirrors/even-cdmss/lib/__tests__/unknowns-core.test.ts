// Inquiry K1 — unknowns-core (PRD §15): every kind derives from fixtures; determinism;
// sourceRefs always present; snapshot-absent degradation; stable ordering.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { deriveUnknowns, type UnknownItem } from '../inquiry/unknowns-core';
import { emptyClinicalState, type ClinicalState } from '../clinical-state/schema';
import type { MemberStateSnapshot } from '../member-state/schema';
import type { DeidOpdCase } from '../opd-ingest-core';

const NOW = '2026-07-15T00:00:00.000Z';

function mkCase(over: Partial<DeidOpdCase> = {}): DeidOpdCase {
  return {
    consultType: null, reasonForConsult: null, presentingComplaints: [], diagnosisCodes: [], impressionCodes: [],
    impressions: [], history: [], comorbidities: [], medications: [], investigations: [], advice: [], examination: [],
    allergies: 'nil', followUpType: null, followUpDateSet: false, ...over,
  };
}

function mkClinicalState(over: Partial<ClinicalState> = {}): ClinicalState {
  return { ...emptyClinicalState('ask'), ...over };
}

const PROV = { sourceField: 'x', rawText: 'x', extractionMethod: 'deterministic' as const, confidence: 1 };

function mkSnapshot(over: Partial<MemberStateSnapshot> = {}): MemberStateSnapshot {
  return {
    version: 'member-state/1.1', normalizationVersion: 'member-normalize/0.2', reconciliationVersion: 'member-reconcile/0.3',
    computedAt: NOW, asOf: '2026-07-01', sourceWatermarks: {},
    problems: [], medications: [], allergies: [], investigations: [], conflicts: [], followUps: [], sourceEncounterRefs: [],
    ...over,
  } as MemberStateSnapshot;
}

const kindsOf = (items: UnknownItem[]) => new Set(items.map((i) => i.kind));

test('unknown_finding + missing_critical + instability_input derive from a ClinicalState', () => {
  const cs = mkClinicalState({
    unknowns: [{ id: 'cf-1', concept: 'chest pain radiation', status: 'unknown', provenance: { ...PROV, rawText: 'radiation not asked' } }],
    missingCriticalData: ['smoking status'],
  });
  const items = deriveUnknowns({ episode: mkCase(), clinicalState: cs, snapshot: null, now: NOW });
  const kinds = kindsOf(items);
  assert.ok(kinds.has('unknown_finding'));
  assert.ok(kinds.has('missing_critical'));
  assert.ok(kinds.has('instability_input'));   // emptyClinicalState carries 5 missing vitals channels
  const uf = items.find((i) => i.kind === 'unknown_finding')!;
  assert.equal(uf.subject, 'chest pain radiation');
  assert.equal(uf.detail, 'radiation not asked');
  assert.deepEqual(uf.sourceRefs, ['cf-1']);
  assert.equal(uf.stateRef.kind, 'episode');
  assert.equal(uf.stateRef.version, 'clinical-state/1.2');
});

test('med_contradiction derives from an open medication conflict (member stateRef)', () => {
  const snap = mkSnapshot({
    conflicts: [{
      id: 'dx-1', domain: 'medication', type: 'status_conflict', severity: 'review', resolutionStatus: 'open',
      assertions: [
        { encounterRef: 'e1', date: '2026-01-01', detail: 'Atorvastatin: prescribed' },
        { encounterRef: 'e2', date: '2026-06-01', detail: 'Atorvastatin: stopped' },
      ],
    }],
  });
  const items = deriveUnknowns({ episode: mkCase(), snapshot: snap, now: NOW });
  const mc = items.find((i) => i.kind === 'med_contradiction')!;
  assert.ok(mc);
  assert.equal(mc.subject, 'Atorvastatin');
  assert.ok(mc.sourceRefs.includes('dx-1'));
  assert.equal(mc.stateRef.kind, 'member');
  assert.equal(mc.stateRef.version, 'member-state/1.1');
  assert.equal(mc.criticality, 'review');
});

test('med_contradiction: conflict on an episode HIGH-ALERT med is safety-critical', () => {
  const snap = mkSnapshot({
    conflicts: [{
      id: 'dx-2', domain: 'medication', type: 'status_conflict', severity: 'review', resolutionStatus: 'open',
      assertions: [{ encounterRef: 'e1', date: '2026-06-01', detail: 'Insulin glargine: stopped' }],
    }],
  });
  const episode = mkCase({ medications: [{ generic: 'Insulin glargine', highAlert: true }] });
  const mc = deriveUnknowns({ episode, snapshot: snap, now: NOW }).find((i) => i.kind === 'med_contradiction')!;
  assert.equal(mc.criticality, 'safety');
});

test('med_contradiction also derives from reconciled status stopped/not_taking/unknown without a conflict row', () => {
  const snap = mkSnapshot({
    medications: [{
      normalizedConcept: { raw: 'Metformin', relation: 'exact', normalizerVersion: 'member-normalize/0.2' },
      status: 'unknown', firstSeen: '2026-01-01', lastSeen: '2026-06-01',
      occurrences: [{ encounterRef: 'e9', date: '2026-06-01', provenance: PROV }],
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any],
  });
  const mc = deriveUnknowns({ episode: mkCase(), snapshot: snap, now: NOW }).find((i) => i.kind === 'med_contradiction')!;
  assert.ok(mc);
  assert.equal(mc.subject, 'Metformin');
  assert.ok(mc.sourceRefs.length >= 1);
});

test('new_medication (B5): derives ONLY for meds absent from a NON-EMPTY snapshot med list', () => {
  const episode = mkCase({
    medications: [
      { generic: 'Dapagliflozin', brand: 'Forxiga', strength: '10mg' },
      { generic: 'Metformin', brand: 'Glycomet', strength: '500mg' },
    ],
  });
  const snap = mkSnapshot({
    medications: [{
      normalizedConcept: { raw: 'Metformin', relation: 'exact', normalizerVersion: 'member-normalize/0.2' },
      status: 'prescribed', firstSeen: '2026-01-01', lastSeen: '2026-06-15',
      occurrences: [{ encounterRef: 'e1', date: '2026-06-15', provenance: PROV }],
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any],
  });
  const items = deriveUnknowns({ episode, snapshot: snap, now: NOW });
  const nm = items.filter((i) => i.kind === 'new_medication');
  assert.equal(nm.length, 1, 'only the med absent from prior records flags');
  // subject is the buildAskSet med LABEL — the candidate id must merge with the baseline med ask
  assert.equal(nm[0].subject, 'Dapagliflozin (Forxiga 10mg)');
  assert.equal(nm[0].detail, 'doctor started Dapagliflozin (Forxiga 10mg) — not in prior records');
  assert.equal(nm[0].criticality, 'review');
  assert.deepEqual(nm[0].sourceRefs, ['episode:medication:dapagliflozin-forxiga-10mg']);
  assert.equal(nm[0].stateRef.kind, 'member');
  // EMPTY snapshot med list ⇒ cannot tell "new" from "unknown" ⇒ nothing derives
  const empty = deriveUnknowns({ episode, snapshot: mkSnapshot(), now: NOW });
  assert.equal(empty.some((i) => i.kind === 'new_medication'), false);
  // snapshot absent ⇒ member-derived kinds absent (D14)
  const absent = deriveUnknowns({ episode, snapshot: null, now: NOW });
  assert.equal(absent.some((i) => i.kind === 'new_medication'), false);
});

test('new_medication (B5): a high-alert episode med is skipped (it wins rank 0 anyway)', () => {
  const episode = mkCase({ medications: [{ generic: 'Insulin glargine', brand: 'Lantus', highAlert: true }] });
  const snap = mkSnapshot({
    medications: [{
      normalizedConcept: { raw: 'Metformin', relation: 'exact', normalizerVersion: 'member-normalize/0.2' },
      status: 'prescribed', firstSeen: '2026-01-01', lastSeen: '2026-06-15',
      occurrences: [{ encounterRef: 'e1', date: '2026-06-15', provenance: PROV }],
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any],
  });
  const items = deriveUnknowns({ episode, snapshot: snap, now: NOW });
  assert.equal(items.some((i) => i.kind === 'new_medication'), false);
});

test('care_gap derives from a stale mapped-range abnormal (detail verbatim, severity mapped)', () => {
  const snap = mkSnapshot({
    investigations: [{
      normalizedAnalyte: { raw: 'Vitamin D', relation: 'exact', normalizerVersion: 'member-normalize/0.2' },
      unit: 'ng/ml',
      series: [{ encounterRef: 'lab1', date: '2025-06-01', value: '8', unit: 'ng/ml', abnormal: 'LOW', provenance: PROV }],
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any],
  });
  const cg = deriveUnknowns({ episode: mkCase(), snapshot: snap, now: NOW }).find((i) => i.kind === 'care_gap')!;
  assert.ok(cg, 'care_gap derived');
  assert.equal(cg.subject, 'Vitamin D');
  assert.match(cg.detail, /abnormal \(8\)/);
  assert.equal(cg.criticality, 'safety');           // 8 ng/ml is band 'critical' → severity safety
  assert.deepEqual(cg.sourceRefs, ['vitamin_d_25oh']);
});

test('followup_open derives from advice keywords; suppressed when a committed follow-up matches', () => {
  const episode = mkCase({ advice: ['Repeat HbA1c after 3 months'] });
  const open = deriveUnknowns({ episode, snapshot: null, now: NOW });
  assert.ok(open.some((i) => i.kind === 'followup_open' && /HbA1c/.test(i.subject)));

  const snap = mkSnapshot({
    followUps: [{ id: 'fu1', subject: 'Repeat HbA1c after 3 months', action: 'committed', provenance: { ...PROV, extractionMethod: 'reported' } }],
  });
  const closed = deriveUnknowns({ episode, snapshot: snap, now: NOW });
  assert.equal(closed.some((i) => i.kind === 'followup_open'), false);
});

test('allergy_unconfirmed only when the note allergy field is blank', () => {
  const blank = deriveUnknowns({ episode: mkCase({ allergies: null }), snapshot: null, now: NOW });
  const a = blank.find((i) => i.kind === 'allergy_unconfirmed')!;
  assert.ok(a);
  assert.deepEqual(a.sourceRefs, ['note:allergies']);
  const filled = deriveUnknowns({ episode: mkCase({ allergies: 'penicillin' }), snapshot: null, now: NOW });
  assert.equal(filled.some((i) => i.kind === 'allergy_unconfirmed'), false);
});

test('snapshot absent ⇒ member-derived kinds simply absent (episode-only degradation, D14)', () => {
  const items = deriveUnknowns({ episode: mkCase({ allergies: null, advice: ['review in 2 weeks'] }), snapshot: null, now: NOW });
  const kinds = kindsOf(items);
  assert.equal(kinds.has('med_contradiction'), false);
  assert.equal(kinds.has('care_gap'), false);
  assert.ok(kinds.has('allergy_unconfirmed'));
  assert.ok(kinds.has('followup_open'));
});

test('determinism: identical inputs ⇒ deep-equal output (double run)', () => {
  const episode = mkCase({ allergies: null, advice: ['Repeat TSH after 6 weeks'] });
  const snap = mkSnapshot({
    conflicts: [{
      id: 'dx-1', domain: 'medication', type: 'status_conflict', severity: 'review', resolutionStatus: 'open',
      assertions: [{ encounterRef: 'e1', date: '2026-06-01', detail: 'Thyroxine: stopped' }],
    }],
  });
  const a = deriveUnknowns({ episode, snapshot: snap, now: NOW });
  const b = deriveUnknowns({ episode, snapshot: snap, now: NOW });
  assert.deepEqual(a, b);
});

test('every UnknownItem carries ≥1 sourceRef and a stateRef', () => {
  const cs = mkClinicalState({ missingCriticalData: ['duration of fever'] });
  const snap = mkSnapshot({
    conflicts: [{
      id: 'dx-1', domain: 'medication', type: 'status_conflict', severity: 'review', resolutionStatus: 'open',
      assertions: [{ encounterRef: 'e1', date: '2026-06-01', detail: 'Amlodipine: not_taking' }],
    }],
  });
  const items = deriveUnknowns({ episode: mkCase({ allergies: null }), clinicalState: cs, snapshot: snap, now: NOW });
  assert.ok(items.length >= 3);
  for (const i of items) {
    assert.ok(i.sourceRefs.length >= 1, `${i.id} has a sourceRef`);
    assert.ok(i.stateRef && (i.stateRef.kind === 'member' || i.stateRef.kind === 'episode'), `${i.id} has a stateRef`);
    assert.ok(i.id.startsWith(`unk-${i.kind}:`), `${i.id} deterministic id shape`);
  }
});

test('stable ordering: safety before review before info, then kind, then subject', () => {
  const cs = mkClinicalState({ missingCriticalData: ['b-subject', 'a-subject'] });
  const snap = mkSnapshot({
    investigations: [{
      normalizedAnalyte: { raw: 'Vitamin D', relation: 'exact', normalizerVersion: 'member-normalize/0.2' },
      unit: 'ng/ml',
      series: [{ encounterRef: 'lab1', date: '2025-06-01', value: '8', unit: 'ng/ml', abnormal: 'LOW', provenance: PROV }],
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any],
  });
  const items = deriveUnknowns({ episode: mkCase(), clinicalState: cs, snapshot: snap, now: NOW });
  const crits = items.map((i) => i.criticality);
  const rank = (c: string) => (c === 'safety' ? 0 : c === 'review' ? 1 : 2);
  for (let i = 1; i < crits.length; i++) assert.ok(rank(crits[i - 1]) <= rank(crits[i]), 'criticality non-decreasing');
  const mc = items.filter((i) => i.kind === 'missing_critical').map((i) => i.subject);
  assert.deepEqual(mc, ['a-subject', 'b-subject']);   // subject-alphabetical within kind
});

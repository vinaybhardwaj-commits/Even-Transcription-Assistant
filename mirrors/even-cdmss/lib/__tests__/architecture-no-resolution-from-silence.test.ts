// Architecture Governance Slice 1 — clinical-semantics test #1 (ratified invariant).
// NO RESOLUTION FROM SILENCE: a problem documented in an earlier encounter and merely ABSENT
// (not documented-resolved) in a later one must never flip to resolved. Only an explicit
// documented-resolved occurrence (explicitStatus / patient-reported complaint status) flips it.
// Target: lib/member-state/aggregate-core.ts status logic (invariant 1).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildMemberState } from '../member-state/aggregate-core';
import type { MemberEvidence, EncounterEvidence } from '../member-state/schema';

const prov = (field = 'dx') => ({ sourceField: field, rawText: 'x', extractionMethod: 'reported', confidence: 0.9 } as never);

function enc(ref: string, date: string, over: Partial<EncounterEvidence> = {}): EncounterEvidence {
  return { encounterRef: ref, date, kind: 'opd', problems: [], medicationAssertions: [], allergyAssertions: [], investigations: [], ...over };
}
function evidence(encounters: EncounterEvidence[]): MemberEvidence {
  return { memberRef: 'ind-1', encounters, sourceWatermarks: { db13: '2026-07-13' }, generatedAt: '2026-07-13T00:00:00Z' };
}
const problemNamed = (snap: ReturnType<typeof buildMemberState>, raw: string) =>
  snap.problems.find((p) => p.normalizedConcept.raw === raw);

test('semantics #1: silence in a later encounter NEVER resolves a problem (→ uncertain, not resolved)', () => {
  const snap = buildMemberState(evidence([
    enc('e1', '2026-06-01', { problems: [{ conceptRaw: 'Migraine', icdCode: null, explicitStatus: null, provenance: prov() }] }),
    enc('e2', '2026-07-01', { problems: [{ conceptRaw: 'Gastritis', icdCode: null, explicitStatus: null, provenance: prov() }] }),  // Migraine merely absent
  ]), '2026-07-13T00:00:00Z');
  const migraine = problemNamed(snap, 'Migraine');
  assert.ok(migraine, 'problem retained');
  assert.notEqual(migraine!.latestDocumentedStatus, 'documented_resolved');           // the invariant
  assert.equal(migraine!.latestDocumentedStatus, 'uncertain_current_status');          // silence → uncertain
});

test('semantics #1: only an EXPLICIT documented-resolved occurrence flips the status', () => {
  const snap = buildMemberState(evidence([
    enc('e1', '2026-06-01', { problems: [{ conceptRaw: 'Migraine', icdCode: null, explicitStatus: null, provenance: prov() }] }),
    enc('e2', '2026-07-01', { problems: [{ conceptRaw: 'Migraine', icdCode: null, explicitStatus: 'resolved', provenance: prov() }] }),
  ]), '2026-07-13T00:00:00Z');
  assert.equal(problemNamed(snap, 'Migraine')!.latestDocumentedStatus, 'documented_resolved');
});

test('semantics #1: a problem documented ON the as-of day stays active — never inferred beyond the evidence', () => {
  const snap = buildMemberState(evidence([
    enc('e1', '2026-07-01', { problems: [{ conceptRaw: 'Migraine', icdCode: null, explicitStatus: null, provenance: prov() }] }),
  ]), '2026-07-13T00:00:00Z');
  assert.equal(problemNamed(snap, 'Migraine')!.latestDocumentedStatus, 'documented_active');
});

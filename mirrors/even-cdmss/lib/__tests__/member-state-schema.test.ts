import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  emptyMemberStateSnapshot, validateMemberStateSnapshot,
  MEMBER_STATE_VERSION, NORMALIZATION_VERSION, RECONCILIATION_VERSION,
} from '../member-state/schema';
import { buildMemberState } from '../member-state/aggregate-core';
import type { MemberEvidence } from '../member-state/schema';
import type { Provenance } from '../clinical-state/schema';

test('version constants are the Stage-0 pinned triple', () => {
  assert.equal(MEMBER_STATE_VERSION, 'member-state/1.1');
  assert.equal(NORMALIZATION_VERSION, 'member-norm/0.1');
  assert.equal(RECONCILIATION_VERSION, 'member-reconcile/0.2');
});

test('emptyMemberStateSnapshot: passed-in computedAt/asOf, empty arrays, passes zod', () => {
  const s = emptyMemberStateSnapshot('2026-07-11T00:00:00Z', '2026-06-01');
  assert.equal(s.version, 'member-state/1.1');
  assert.equal(s.computedAt, '2026-07-11T00:00:00Z');
  assert.equal(s.asOf, '2026-06-01');
  assert.deepEqual([s.problems, s.medications, s.allergies, s.investigations, s.conflicts], [[], [], [], [], []]);
  assert.doesNotThrow(() => validateMemberStateSnapshot(s));
});

test('a built snapshot validates against the zod schema', () => {
  const prov: Provenance = { sourceField: 'dx', rawText: 'x', extractionMethod: 'reported', confidence: 0.9 };
  const ev: MemberEvidence = {
    memberRef: 'M1', sourceWatermarks: { db13: '2026-07-11' }, generatedAt: '2026-07-11',
    encounters: [{
      encounterRef: 'e1', date: '2026-01-01', kind: 'opd',
      problems: [{ conceptRaw: 'hypertension', icdCode: null, explicitStatus: null, provenance: prov }],
      medicationAssertions: [], allergyAssertions: [], investigations: [],
    }],
  };
  assert.doesNotThrow(() => validateMemberStateSnapshot(buildMemberState(ev, '2026-07-11T00:00:00Z')));
});

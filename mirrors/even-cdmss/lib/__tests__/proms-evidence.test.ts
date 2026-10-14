import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promResponsesToEncounter, type PromScore } from '../proms/proms-evidence';

const s = (instrumentId: string, administeredAt: string, score: number | null, scale = 'house'): PromScore =>
  ({ instrumentId, window: 'w2', administeredAt, score, scale, escalations: [] });

test('promResponsesToEncounter: scored instruments → one dated care_call encounter with investigation points', () => {
  const enc = promResponsesToEncounter([s('hs-procto', '2026-07-12', 7), s('pain_nrs', '2026-07-12', 4, 'NRS-11')]);
  assert.equal(enc.kind, 'care_call');
  assert.equal(enc.date, '2026-07-12');
  assert.equal(enc.problems.length, 0);
  assert.equal(enc.medicationAssertions.length, 0);
  assert.equal(enc.investigations.length, 2);
  const procto = enc.investigations.find((i) => i.analyteRaw === 'prom:hs-procto')!;
  assert.equal(procto.value, '7');
  assert.equal(procto.unit, 'house');
  assert.equal(procto.provenance.extractionMethod, 'reported');
  assert.equal(procto.provenance.trust, 'patient_reported');
  assert.equal(procto.provenance.reporter, 'patient_via_care_manager');
});

test('promResponsesToEncounter: unscored (null) instruments are dropped from the fold', () => {
  const enc = promResponsesToEncounter([s('whodas12', '2026-07-12', null, 'WHODAS-12 simple sum'), s('hs-procto', '2026-07-12', 7)]);
  assert.equal(enc.investigations.length, 1);
  assert.equal(enc.investigations[0].analyteRaw, 'prom:hs-procto');
});

test('promResponsesToEncounter: empty / all-null → empty investigations, no date (fold filters it)', () => {
  const empty = promResponsesToEncounter([]);
  assert.equal(empty.investigations.length, 0);
  assert.equal(empty.date, '');
  const allNull = promResponsesToEncounter([s('whodas12', '2026-07-12', null)]);
  assert.equal(allNull.investigations.length, 0);
});

test('promResponsesToEncounter: deterministic (twice → deep-equal)', () => {
  const scored = [s('hs-procto', '2026-07-12', 7), s('pain_nrs', '2026-07-12', 4)];
  assert.deepEqual(promResponsesToEncounter(scored), promResponsesToEncounter(scored));
});

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { clinicalStateResultField, toClinicalStateUiView } from '../clinical-state/ui-view.ts';
import { emptyClinicalState, mkFindingId, type ClinicalState } from '../clinical-state/schema.ts';

function fixture(): ClinicalState {
  const s = emptyClinicalState('ddx');
  s.demographics = { age: 70, ageBand: '70-79', sex: 'M', sexRaw: 'male' };
  s.instability = { unstable: true, reasons: ['SBP 82 < 90', 'HR 134 > 130'], assessment: 'unstable', assessedInputs: ['BP', 'HR'], missingInputs: ['SpO₂', 'RR', 'T'] };
  s.positives.push({
    id: mkFindingId('abdominal pain', 'complaint', 'present'),
    concept: 'abdominal pain', status: 'present',
    provenance: { sourceField: 'complaint', rawText: 'Abdominal pain', extractionMethod: 'deterministic', confidence: 0.95 },
  });
  s.negatives.push({
    id: mkFindingId('fever', 'history', 'absent'),
    concept: 'fever', status: 'absent',
    provenance: { sourceField: 'history', rawText: 'No fever', extractionMethod: 'deterministic', confidence: 0.9 },
  });
  s.unknowns.push({
    id: mkFindingId('chest pain', 'checklist', 'unknown'),
    concept: 'chest pain', status: 'unknown',
    provenance: { sourceField: 'checklist', rawText: 'chest pain', extractionMethod: 'deterministic', confidence: 0.5 },
  });
  return s;
}

// ── The 1c neutrality contract: flag OFF ⇒ nothing added to the response ──

test('clinicalStateResultField: flag OFF returns {} — result payload byte-identical', () => {
  const state = fixture();
  assert.deepEqual(clinicalStateResultField(state, 0, false), {});
  // spread into a representative result data object → byte-identical to not spreading
  const base = { summary: 's', cannot_miss: [{ diagnosis: 'ACS' }], most_likely: [], other: [] };
  const off = { ...base, ...clinicalStateResultField(state, 3, false) };
  assert.equal(JSON.stringify(off), JSON.stringify(base));
});

test('clinicalStateResultField: null/undefined state returns {} even when enabled', () => {
  assert.deepEqual(clinicalStateResultField(null, 0, true), {});
  assert.deepEqual(clinicalStateResultField(undefined, 0, true), {});
});

test('clinicalStateResultField: flag ON attaches the trimmed view', () => {
  const state = fixture();
  const field = clinicalStateResultField(state, 2, true);
  assert.ok(field.clinicalState, 'clinicalState present when enabled');
  const v = field.clinicalState!;
  assert.equal(v.version, 'clinical-state/1.2');
  assert.equal(v.positives.length, 1);
  assert.equal(v.negatives.length, 1);
  assert.equal(v.unknowns.length, 1);
  assert.equal(v.instability.unstable, true);
  assert.deepEqual(v.instability.reasons, ['SBP 82 < 90', 'HR 134 > 130']);
  assert.equal(v.rejectedSpans, 2);
  assert.equal(v.counts.positives, 1);
  assert.equal(v.counts.negatives, 1);
  assert.equal(v.demographics.age, 70);
});

test('toClinicalStateUiView: counts mirror stateCounts; provenance preserved for hover', () => {
  const v = toClinicalStateUiView(fixture(), 0);
  assert.equal(v.counts.positives, 1);
  assert.equal(v.positives[0].provenance.rawText, 'Abdominal pain');
  assert.equal(v.positives[0].provenance.extractionMethod, 'deterministic');
  assert.equal(v.rejectedSpans, 0);
});

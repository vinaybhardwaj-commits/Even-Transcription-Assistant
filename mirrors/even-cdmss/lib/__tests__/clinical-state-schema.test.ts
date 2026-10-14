import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  CLINICAL_STATE_VERSION, emptyClinicalState, validateClinicalState,
  zClinicalFinding, mkFindingId, stateCounts, type ClinicalFinding,
} from '../clinical-state/schema';
import { formatClinicalState } from '../clinical-state/format';

const FINDING: ClinicalFinding = {
  id: 'cf-1',
  concept: 'fever',
  status: 'present',
  provenance: { sourceField: 'history', rawText: 'fever for 3 days', extractionMethod: 'deterministic', confidence: 0.9 },
};

test('emptyClinicalState validates and carries the version literal', () => {
  const s = emptyClinicalState('ddx');
  assert.equal(s.version, CLINICAL_STATE_VERSION);
  assert.equal(s.version, 'clinical-state/1.2');
  assert.deepEqual(validateClinicalState(s), s);
});

test('a populated state validates: findings, audit ext, timeline, adminFacts', () => {
  const s = emptyClinicalState('doc_audit');
  s.positives.push({
    ...FINDING,
    ext: { kind: 'audit', verdict: 'low-value', domain: 'prescribing_safety', citationIds: [1, 2], informational: false },
  });
  s.negatives.push({ ...FINDING, id: 'cf-2', concept: 'chest pain', status: 'absent' });
  s.timeline.push({ date: '2026-07-01', kind: 'opd', title: 'Medicine', subtitle: null, refUid: null });
  s.investigations.push({ test: 'Hb', value: '9.1', unit: 'g/dL', flag: 'low', category: 'lab', note: 'anemia' });
  s.adminFacts = { lengthOfStayDays: 3, admissionType: 'elective', careSetting: 'ward' };
  s.surfaceExtras = { courseSummary: 'uneventful stay' };
  assert.deepEqual(validateClinicalState(s), s);
});

test('validation rejects a bad finding status, a missing provenance, an unknown ext kind', () => {
  assert.throws(() => zClinicalFinding.parse({ ...FINDING, status: 'maybe' }));
  const { provenance: _drop, ...noProv } = FINDING;
  assert.throws(() => zClinicalFinding.parse(noProv));
  assert.throws(() => zClinicalFinding.parse({ ...FINDING, ext: { kind: 'astrology' } }));
  assert.throws(() => validateClinicalState({ ...emptyClinicalState('ddx'), version: 'clinical-state/0.9' }));
});

test('mkFindingId is deterministic and status-sensitive', () => {
  assert.equal(mkFindingId('fever', 'history', 'present'), mkFindingId('Fever', 'history', 'present'));
  assert.notEqual(mkFindingId('fever', 'history', 'present'), mkFindingId('fever', 'history', 'absent'));
});

test('stateCounts mirrors the arrays', () => {
  const s = emptyClinicalState('ddx');
  s.positives.push(FINDING);
  s.missingCriticalData.push('fever');
  const c = stateCounts(s);
  assert.equal(c.positives, 1);
  assert.equal(c.negatives, 0);
  assert.equal(c.missingCriticalData, 1);
});

test('formatClinicalState renders every populated section, skips empty ones', () => {
  const s = emptyClinicalState('ddx');
  s.demographics = { age: 62, sex: 'M', ageBand: '60-69', sexRaw: 'M' };
  s.positives.push({ ...FINDING, temporality: { duration: 'for 3 days' } });
  s.negatives.push({ ...FINDING, id: 'cf-2', concept: 'chest pain', status: 'absent' });
  s.unknowns.push({ ...FINDING, id: 'cf-3', concept: 'weight loss', status: 'unknown' });
  s.investigations.push({ test: 'Hb', value: '9.1', unit: 'g/dL', flag: 'low', category: 'lab', note: null });
  s.instability = { unstable: true, reasons: ['SBP 82 < 90'], assessment: 'unstable', assessedInputs: ['BP'], missingInputs: ['HR', 'SpO₂', 'RR', 'T'] };
  const out = formatClinicalState(s);
  assert.match(out, /Patient: 62y \/ M/);
  assert.match(out, /Findings \(stated\): fever \(for 3 days\)/);
  assert.match(out, /Explicitly negative: chest pain/);
  assert.match(out, /Not mentioned \(do not assume either way\): weight loss/);
  assert.match(out, /\[LOW\] Hb 9\.1 g\/dL/);
  assert.match(out, /UNSTABLE: SBP 82 < 90/);
  assert.doesNotMatch(out, /Risk factors|Medications|Stay:/);
});

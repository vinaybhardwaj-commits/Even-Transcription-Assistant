// Architecture Governance Slice 1 — clinical-semantics test #3 (BEHAVIOURAL, not an import rule).
// AUDIT FINDINGS NEVER BECOME ClinicalState/MemberState PATIENT FACTS: feeding an
// AuditFinding/OpdFinding-shaped object through the assembly path must mint NO patient-fact
// assertion — no MedicationAssertion, no problem, no investigation is fabricated from a
// finding's subject/verdict/rationale. This test FAILS if a future change maps finding
// fields (subject → concept, etc.) into the patient record.
// Target: lib/clinical-state/from-prescription.ts + lib/member-state/assemble-core.ts →
// buildMemberState (the ClinicalState→MemberState build path).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { medicationLineToAssertion } from '../clinical-state/from-prescription';
import { assembleEvidence } from '../member-state/assemble-core';
import { buildMemberState } from '../member-state/aggregate-core';

// An OpdFinding/AuditFinding-shaped object — exactly what the audit engine emits.
const AUDIT_FINDING = {
  subject: 'Unindicated antibiotic for viral URTI',
  verdict: 'low-value',
  confidence: 0.8,
  domain: 'appropriateness',
  rationale: 'no bacterial indication documented',
  evidence: ['Azithromycin 500mg OD x3d'],
  estimates: [],
  citation_ids: [1, 2],
  signal_type: 'low_value_care',
  finding_ref: 'f-123',
  source: 'llm',
};

test('semantics #3: a finding-shaped object mints NO MedicationAssertion', () => {
  // No brand_name/generic_name → the mapper must refuse, not improvise from subject/rationale.
  assert.equal(medicationLineToAssertion(AUDIT_FINDING as never), null);
});

test('semantics #3: a finding-shaped row through assemble→build mints no problem/medication/investigation', () => {
  // Give the row enough shape to form an encounter (uid + date) — the tripwire is whether any
  // FINDING field (subject/verdict/rationale/evidence) leaks into the patient facts.
  const row = { uid: 'presc-x', visit_date: '2026-07-01', ...AUDIT_FINDING };
  const evidence = assembleEvidence({
    memberRef: 'ind-1', generatedAt: '2026-07-13T00:00:00Z', sourceWatermarks: { db13: '2026-07-13' },
    prescriptionRows: [row], labRows: [],
  });
  for (const e of evidence.encounters) {
    assert.equal(e.problems.length, 0, 'no problem minted from a finding');
    assert.equal(e.medicationAssertions.length, 0, 'no medication minted from a finding');
    assert.equal(e.investigations.length, 0, 'no investigation minted from a finding');
  }
  if (evidence.encounters.length) {
    const snap = buildMemberState(evidence, '2026-07-13T00:00:00Z');
    assert.equal(snap.problems.length, 0);
    assert.equal(snap.medications.length, 0);
    assert.equal(snap.investigations.length, 0);
    const dump = JSON.stringify(snap);
    assert.ok(!dump.includes(AUDIT_FINDING.subject), 'finding subject never appears in the patient record');
    assert.ok(!dump.includes('low-value'), 'finding verdict never appears in the patient record');
  }
});

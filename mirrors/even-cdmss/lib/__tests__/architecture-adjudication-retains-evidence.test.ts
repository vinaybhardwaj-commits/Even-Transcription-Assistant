// Architecture Governance Slice 1 — clinical-semantics test #4 (ratified invariant).
// ADJUDICATED CONFLICTS RETAIN ORIGINAL EVIDENCE: when a finding is adjudicated (suppressed /
// downgraded via the human-approved suppression ledger — the in-repo adjudication write path's
// pure core, applied at persist time by applySuppressions), the original evidence/citations/
// rationale are preserved, never overwritten. Adjudication decisions live in SEPARATE ledger
// tables (opd_feedback_adjudications / triage decisions); the finding row itself is only ever
// spread ({...f}), so every original field must survive.
// Target: lib/audit-suppression-core.ts (the pure seam of lib/opd-audit-store.ts's persist path).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applySuppressions, type Suppression } from '../audit-suppression-core';

const FINDING = {
  finding_ref: 'f-abc', signal_type: 'ddi', subject: 'NSAID + anticoagulant co-prescription',
  verdict: 'low-value', confidence: 0.9, domain: 'prescribing_safety',
  rationale: 'bleeding-risk interaction', evidence: ['Aspirin 75mg', 'Warfarin 5mg'],
  citation_ids: [4, 7], sources: [{ url: 'pubmed/123', preview: 'bleeding risk' }],
};
const suppression = (action: 'drop' | 'downgrade'): Suppression => ({
  id: 1, signal_type: 'ddi', match: 'type_only', subject_pattern: null,
  scope: 'all', doctor_uid: null, action, active: true,
} as never);

test('semantics #4: a DOWNGRADE adjudication preserves every original evidence field', () => {
  const input = [structuredClone(FINDING)];
  const out = applySuppressions(input as never[], 'doc-1', [suppression('downgrade')]);
  assert.equal(out.findings.length, 1);
  const kept = out.findings[0] as unknown as typeof FINDING & { informational: boolean };
  assert.equal(kept.informational, true);                       // the adjudication's only effect
  // original evidence/citations/rationale survive byte-for-byte
  assert.deepEqual(kept.evidence, FINDING.evidence);
  assert.deepEqual(kept.citation_ids, FINDING.citation_ids);
  assert.deepEqual(kept.sources, FINDING.sources);
  assert.equal(kept.rationale, FINDING.rationale);
  assert.equal(kept.subject, FINDING.subject);
  assert.equal(kept.verdict, FINDING.verdict);
  assert.equal(kept.confidence, FINDING.confidence);
});

test('semantics #4: a DROP adjudication still records the original finding_ref in the ledger (auditability)', () => {
  const out = applySuppressions([structuredClone(FINDING)] as never[], 'doc-1', [suppression('drop')]);
  assert.equal(out.findings.length, 0);
  assert.deepEqual(out.suppressed, [{ finding_ref: 'f-abc', signal_type: 'ddi', action: 'drop' }]);
});

test('semantics #4: adjudication never MUTATES the original finding object', () => {
  const original = structuredClone(FINDING);
  const input = [original];
  applySuppressions(input as never[], 'doc-1', [suppression('downgrade')]);
  assert.deepEqual(original, FINDING);                          // untouched — {...f} spread, no in-place write
});

/**
 *   node --experimental-strip-types --test lib/__tests__/self-healing-core.test.ts
 * Pure cores: Tier-0 signal-health + Tier-1 suppression matcher & dual-label safety.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computeSignalHealth, type HealthDecision } from '../signal-health-core.ts';
import {
  findingMatchesSuppression, applySuppressions, previewCollateral,
  type Suppression, type ValidLabelInstance,
} from '../audit-suppression-core.ts';

const D = (o: Partial<HealthDecision> & { doctor_uid?: string }): HealthDecision & { doctor_uid?: string } => ({
  signal_type: 'incomplete_dosing', validity: 'valid_signal', bug_type: null, routed: false, reason: null,
  created_at: '2026-07-03T00:00:00Z', ...o,
});

test('computeSignalHealth: FP rate, latest-per-doctor, top reasons, healable', () => {
  const decisions = [
    D({ doctor_uid: 'a', validity: 'audit_bug', bug_type: 'structural_bug', reason: 'strength in name' }),
    D({ doctor_uid: 'b', validity: 'audit_bug', bug_type: 'structural_bug', reason: 'strength in name' }),
    D({ doctor_uid: 'c', validity: 'valid_signal', routed: true }),
    // an older decision for doctor a that must be superseded by the newer audit_bug above
    D({ doctor_uid: 'a', validity: 'valid_signal', created_at: '2026-07-01T00:00:00Z' }),
  ];
  const [h] = computeSignalHealth(decisions);
  assert.equal(h.signal_type, 'incomplete_dosing');
  assert.equal(h.decided, 3);                       // latest-per-doctor: a,b,c
  assert.equal(h.audit_bug, 2);
  assert.equal(h.valid, 1);
  assert.ok(Math.abs(h.fp_rate - 2 / 3) < 1e-9);
  assert.equal(h.structural_bug, 2);
  assert.equal(h.healable, true);
  assert.equal(h.top_reasons[0].reason, 'strength in name');
  assert.equal(h.top_reasons[0].n, 2);
});

test('computeSignalHealth: ranks noisiest (audit_bug × rate) first', () => {
  const noisy = Array.from({ length: 6 }, (_, i) => D({ signal_type: 'unverified_brand', doctor_uid: 'u' + i, validity: 'audit_bug', bug_type: 'structural_bug' }));
  const clean = [D({ signal_type: 'drug_interaction', doctor_uid: 'x', validity: 'valid_signal' })];
  const out = computeSignalHealth([...clean, ...noisy]);
  assert.equal(out[0].signal_type, 'unverified_brand');
});

// ── suppression matcher ───────────────────────────────────────────────────────
const supp = (o: Partial<Suppression>): Suppression => ({
  signal_type: 'unverified_brand', discriminator: null, match_kind: 'type_only', scope: 'all',
  doctor_uid: null, action: 'downgrade', active: true, ...o,
});

test('findingMatchesSuppression: type/scope/discriminator/active gates', () => {
  const f = { signal_type: 'unverified_brand', subject: 'Unverified brand: Mystery Tonic' };
  assert.equal(findingMatchesSuppression(f, 'docA', supp({})), true);                                  // type_only
  assert.equal(findingMatchesSuppression(f, 'docA', supp({ signal_type: 'drug_interaction' })), false); // wrong type
  assert.equal(findingMatchesSuppression(f, 'docA', supp({ active: false })), false);                   // inactive
  assert.equal(findingMatchesSuppression(f, 'docA', supp({ match_kind: 'subject_contains', discriminator: 'mystery tonic' })), true);
  assert.equal(findingMatchesSuppression(f, 'docA', supp({ match_kind: 'subject_contains', discriminator: 'aspirin' })), false);
  assert.equal(findingMatchesSuppression(f, 'docA', supp({ scope: 'doctor', doctor_uid: 'docB' })), false); // other doctor
  assert.equal(findingMatchesSuppression(f, 'docB', supp({ scope: 'doctor', doctor_uid: 'docB' })), true);
});

test('applySuppressions: drop removes, downgrade sets informational, no active = no-op', () => {
  const findings = [
    { signal_type: 'unverified_brand', subject: 'Unverified brand: X', finding_ref: 'r1' },
    { signal_type: 'drug_interaction', subject: 'Interaction: A + B', finding_ref: 'r2' },
  ];
  const dropped = applySuppressions(findings, 'docA', [supp({ action: 'drop' })]);
  assert.equal(dropped.findings.length, 1);
  assert.equal(dropped.findings[0].signal_type, 'drug_interaction');
  assert.equal(dropped.suppressed[0].action, 'drop');

  const down = applySuppressions(findings, 'docA', [supp({ action: 'downgrade' })]);
  assert.equal(down.findings.length, 2);
  const ub = down.findings.find((f) => f.signal_type === 'unverified_brand')!;
  assert.equal((ub as { informational?: boolean }).informational, true);

  const noop = applySuppressions(findings, 'docA', [supp({ active: false })]);
  assert.equal(noop.findings.length, 2);
  assert.equal(noop.suppressed.length, 0);
});

test('previewCollateral: dual-label invariant — refuses to remove a validated signal', () => {
  const validSet: ValidLabelInstance[] = [
    { doctor_uid: 'docA', signal_type: 'unverified_brand', subject: 'Unverified brand: RealDrug' },
    { doctor_uid: 'docB', signal_type: 'unverified_brand', subject: 'Unverified brand: Cosmetic Cream' },
  ];
  // a broad type_only suppression would remove BOTH validated signals → unsafe
  const broad = previewCollateral(supp({}), validSet);
  assert.equal(broad.safe, false);
  assert.equal(broad.collateral, 2);
  // a narrow discriminator that hits none of the validated subjects → safe
  const narrow = previewCollateral(supp({ match_kind: 'subject_contains', discriminator: 'nutraceutical blend' }), validSet);
  assert.equal(narrow.safe, true);
  assert.equal(narrow.collateral, 0);
  // narrow hitting one validated subject → unsafe
  const hitsOne = previewCollateral(supp({ match_kind: 'subject_contains', discriminator: 'cosmetic cream' }), validSet);
  assert.equal(hitsOne.safe, false);
  assert.equal(hitsOne.collateral, 1);
});

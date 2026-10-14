// Quieting (demote) core — PRD CDMSS-QUIETING-DEMOTE-SYSTEM. The severity floor is enforced twice
// (store-side write refusal + engine-side skip) and BOTH halves are asserted here; the §8.1 paired
// before/after scoring test proves a demoted finding contributes exactly zero through the existing
// informational mechanism, with rule_ref…every other field untouched.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  applyDemotes, applySuppressions, ruleViolatesSeverityFloor, findingMatchesSuppression,
  isSafetySignalType, SAFETY_SIGNAL_TYPES, type Suppression, type SuppressibleFinding,
} from '../audit-suppression-core';
import { computeOpdScore } from '../opd-note-score-core';

const demoteRule = (over: Partial<Suppression> = {}): Suppression => ({
  id: 'rule-1', signal_type: 'low_value_care', discriminator: 'gi_ppi_prokinetic',
  match_kind: 'lvc_category', scope: 'all', doctor_uid: null, action: 'demote',
  active: true, status: 'active', ...over,
});
const lvcFinding = (over: Partial<SuppressibleFinding & { verdict: string; confidence: number; domain: string }> = {}) => ({
  subject: 'Perioperative PPI without indication', signal_type: 'low_value_care',
  finding_ref: 'abc123', lvc_category: 'gi_ppi_prokinetic',
  verdict: 'low-value', confidence: 0.8, domain: 'appropriateness', ...over,
});

test('applyDemotes: match → informational + quieted_by; stored fields untouched; non-match untouched', () => {
  const f = lvcFinding();
  const other = lvcFinding({ subject: 'Unindicated vitamin D test', lvc_category: 'unindicated_investigation', finding_ref: 'def456' });
  const { findings, quieted } = applyDemotes([f, other], null, [demoteRule()]);
  assert.equal(findings.length, 2);                       // never dropped — stored intact
  const q = findings[0] as Record<string, unknown>;
  assert.equal(q.informational, true);
  assert.equal(q.quieted_by, 'rule-1');
  assert.equal(q.verdict, 'low-value');                   // verdict/confidence/domain untouched
  assert.equal(q.confidence, 0.8);
  assert.equal(q.domain, 'appropriateness');
  assert.equal(q.lvc_category, 'gi_ppi_prokinetic');      // category untouched
  assert.deepEqual(findings[1], other);                   // non-matching finding is the SAME object
  assert.equal(quieted.length, 1);
  assert.equal(quieted[0].rule_id, 'rule-1');
});

test('applyDemotes: lvc_category is exact + case-insensitive; subject_contains reuses the matcher', () => {
  const byCat = demoteRule({ discriminator: 'GI_PPI_Prokinetic' });
  assert.equal((applyDemotes([lvcFinding()], null, [byCat]).quieted).length, 1);
  const bySubj = demoteRule({ match_kind: 'subject_contains', discriminator: 'perioperative ppi' });
  assert.equal((applyDemotes([lvcFinding()], null, [bySubj]).quieted).length, 1);
  // exact means exact — a category that merely contains the discriminator does not match
  const partial = demoteRule({ discriminator: 'gi_ppi' });
  assert.equal((applyDemotes([lvcFinding()], null, [partial]).quieted).length, 0);
  // a category rule with no discriminator can never match (never a whole-type wildcard by accident)
  const noDisc = demoteRule({ discriminator: null });
  assert.equal((applyDemotes([lvcFinding()], null, [noDisc]).quieted).length, 0);
});

test('applyDemotes: proposed / retired / inactive rules quiet NOTHING (a proposal scores nothing)', () => {
  for (const over of [{ status: 'proposed' as const, active: false }, { status: 'retired' as const, active: false }, { active: false }]) {
    const { quieted } = applyDemotes([lvcFinding()], null, [demoteRule(over)]);
    assert.equal(quieted.length, 0, JSON.stringify(over));
  }
});

test('applyDemotes: already-informational findings are left alone (never re-badged as quieted)', () => {
  const info = lvcFinding({ informational: true } as never);
  const { findings, quieted } = applyDemotes([info], null, [demoteRule()]);
  assert.equal(quieted.length, 0);
  assert.equal((findings[0] as Record<string, unknown>).quieted_by, undefined);
});

test('severity floor, store half: a rule on ANY deterministic safety signal type is refused, for EVERY action', () => {
  // V ruling 26 Jul 2026 — the floor was demote-only, which was a hole rather than a design: a drop
  // or downgrade removes a safety finding just as effectively. This test previously asserted
  // `{ action: 'downgrade', signal_type: 'drug_interaction' } === false` — i.e. it encoded the gap.
  for (const t of SAFETY_SIGNAL_TYPES) {
    for (const action of ['drop', 'downgrade', 'demote'] as const) {
      assert.equal(ruleViolatesSeverityFloor({ action, signal_type: t }), true, `${action}/${t}`);
    }
    assert.equal(isSafetySignalType(t), true, t);
  }
  // …and false for every action on a non-safety type — the floor must not become a blanket veto.
  for (const action of ['drop', 'downgrade', 'demote'] as const) {
    assert.equal(ruleViolatesSeverityFloor({ action, signal_type: 'low_value_care' }), false, action);
  }
});

test('severity floor, engine half (drop/downgrade): a drop rule can NEVER remove a banned_fdc finding', () => {
  // banned_fdc is a CDSCO Section-26A legal prohibition — the sharpest case for the floor.
  const fdc = lvcFinding({ subject: 'Banned fixed-dose combination: nimesulide + paracetamol', signal_type: 'banned_fdc', lvc_category: undefined });
  const hostileDrop: Suppression = { id: 'r-drop', signal_type: 'banned_fdc', discriminator: null, match_kind: 'type_only', scope: 'all', doctor_uid: null, action: 'drop', active: true };
  const { findings, suppressed } = applySuppressions([fdc], null, [hostileDrop]);
  assert.equal(findings.length, 1);                       // kept — not dropped
  assert.equal(suppressed.length, 0);                     // and not recorded as suppressed
  assert.equal((findings[0] as Record<string, unknown>).informational, undefined);
});

test('severity floor, engine half (drop/downgrade): a downgrade rule can NEVER informational-ise a high-alert finding', () => {
  const ha = lvcFinding({ subject: 'High-alert medication: insulin', signal_type: 'high_alert_medication', lvc_category: undefined });
  const hostileDowngrade: Suppression = { id: 'r-dg', signal_type: 'high_alert_medication', discriminator: null, match_kind: 'type_only', scope: 'all', doctor_uid: null, action: 'downgrade', active: true };
  const { findings, suppressed } = applySuppressions([ha], null, [hostileDowngrade]);
  assert.equal(findings.length, 1);
  assert.equal(suppressed.length, 0);
  assert.equal((findings[0] as Record<string, unknown>).informational, undefined);   // NOT set
});

test('severity floor does not over-reach: a drop rule on a NON-safety type still drops (regression guard)', () => {
  const drop: Suppression = { id: 'r-ok', signal_type: 'low_value_care', discriminator: null, match_kind: 'type_only', scope: 'all', doctor_uid: null, action: 'drop', active: true };
  const { findings, suppressed } = applySuppressions([lvcFinding()], null, [drop]);
  assert.equal(findings.length, 0);                       // still removed — the floor is narrow
  assert.equal(suppressed.length, 1);
  assert.equal(suppressed[0].action, 'drop');
});

test('zero-delta: applySuppressions with no rules returns the input findings unchanged', () => {
  const fixture = [lvcFinding(), lvcFinding({ signal_type: 'banned_fdc', finding_ref: 'zzz' })];
  const { findings, suppressed } = applySuppressions(fixture, null, []);
  assert.deepEqual(findings, fixture);                    // same contents, same order
  assert.equal(findings[0], fixture[0]);                  // and the SAME objects — no cloning
  assert.equal(suppressed.length, 0);
});

test('severity floor, engine half: safety findings are skipped even when a rule somehow matches them', () => {
  const ddi = lvcFinding({ subject: 'Interaction: warfarin + aspirin', signal_type: 'drug_interaction', lvc_category: undefined });
  // a whole-type demote rule aimed straight at the safety type (must never exist, but belt-and-braces)
  const hostile = demoteRule({ signal_type: 'drug_interaction', match_kind: 'subject_contains', discriminator: 'warfarin' });
  const { findings, quieted } = applyDemotes([ddi], null, [hostile]);
  assert.equal(quieted.length, 0);
  assert.equal((findings[0] as Record<string, unknown>).informational, undefined);
  assert.equal((findings[0] as Record<string, unknown>).quieted_by, undefined);
});

test('demote rules never flow through applySuppressions semantics (quieting is its own seam)', () => {
  // applySuppressions treats anything non-drop as downgrade — which is why the store EXCLUDES
  // action='demote' from loadActiveSuppressions. Assert the pure matcher still matches so the
  // exclusion (not a matching gap) is what keeps the paths separate.
  assert.equal(findingMatchesSuppression(lvcFinding(), null, demoteRule()), true);
  const { findings } = applySuppressions([lvcFinding()], null, []);
  assert.equal(findings.length, 1);
});

// ── PRD acceptance §8.1 — the paired before/after scoring test ────────────────
test('§8.1 paired scoring: same note, rule active vs not — demoted finding contributes exactly zero', () => {
  const fixture = [
    lvcFinding(),                                                                    // will be quieted
    lvcFinding({ subject: 'Unindicated CT brain', lvc_category: 'imaging', finding_ref: 'img1', verdict: 'low-value' }),
    { subject: 'Guideline-concordant antibiotics', signal_type: 'appropriateness_high_value', finding_ref: 'hv1', verdict: 'high-value', confidence: 0.9, domain: 'appropriateness' },
  ];
  const scoreOf = (fs: typeof fixture) => computeOpdScore({
    // exactly the engine's exclusion: findings.filter(f => !f.informational) → verdict/confidence/domain
    findings: fs.filter((f) => !(f as { informational?: boolean }).informational)
      .map((f) => ({ verdict: f.verdict, confidence: f.confidence, domain: f.domain })) as never,
    completenessCoverage: 0.8, pdqi9: null, patientCentred: { present: 2, total: 4 },
  });

  const before = scoreOf(applyDemotes(fixture, null, []).findings as typeof fixture);          // no rules
  const after = scoreOf(applyDemotes(fixture, null, [demoteRule()]).findings as typeof fixture); // rule active
  const withoutTheFinding = scoreOf(fixture.slice(1));                                          // finding hard-removed

  // the demoted finding's entire score contribution is gone…
  assert.notEqual(after.headline, before.headline);
  // …and "quieted" is IDENTICAL to "not scored at all" — zero residual contribution
  assert.equal(after.headline, withoutTheFinding.headline);
  assert.deepEqual(after.domains, withoutTheFinding.domains);
  // un-quieted arm is byte-stable: applyDemotes with no rules returns the same findings
  assert.deepEqual(applyDemotes(fixture, null, []).findings, fixture);
});

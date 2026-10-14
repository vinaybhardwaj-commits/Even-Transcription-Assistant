// Severity tiers (U1-A) — the ratified table implemented exactly (CDMSS-SEVERITY-TIER-TABLE
// v1.0 RATIFIED 1 Aug 2026). Bare node:test, pure-core import, table-driven.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tierFor, bucketByTier, escalationMatch, dedupeTwins, type TierableFinding } from '../severity-tier-core';

const f = (over: Partial<TierableFinding> = {}): TierableFinding => ({
  signal_type: 'low_value_care', verdict: 'low-value', domain: 'appropriateness',
  confidence: 0.7, subject: 'Some finding: x', rationale: 'r', ...over,
});

// ── the ratified lookup, exact (§2) ──────────────────────────────────────────
const TIER2 = ['drug_interaction', 'dose_ceiling_exceeded', 'dose_ceiling_sos', 'banned_fdc', 'lasa_pair',
  'duplicate_prescription', 'schedule_x', 'low_value_care', 'appropriateness_review', 'appropriateness_low_value',
  'prescribing_review', 'prescribing_low_value', 'longitudinal_missed_followup', 'longitudinal_med_reconciliation',
  'longitudinal_repeat_test', 'longitudinal_continuity', 'longitudinal_contradiction'];
const TIER3 = ['unverified_brand', 'off_formulary', 'coding_completeness', 'high_alert_medication', 'duplicate_molecule',
  'muscle_relaxant_indication', 'vitamin_d_repletion_duration', 'pregnancy_risk_verify', 'screening_context',
  'metadata_accuracy', 'contradicted_medication_present', 'contradicted_drug_class_absent', 'contradicted_indication_present',
  'contradicted_ratified_rule', 'contradicted_route', 'contradicted_investigation_absent', 'contradicted_history',
  'incoherent_with_suggestion', 'pretest_niche'];

test('every ratified tier-2 kind maps to tier 2, not unlisted', () => {
  for (const k of TIER2) {
    const r = tierFor(f({ signal_type: k, verdict: 'context-dependent' }));
    assert.equal(r.tier, 2, k);
    assert.equal(r.unlistedKind, false, k);
  }
});

test('every ratified tier-3 kind maps to tier 3 — log only', () => {
  for (const k of TIER3) {
    const r = tierFor(f({ signal_type: k, verdict: 'context-dependent' }));
    assert.equal(r.tier, 3, k);
    assert.equal(r.unlistedKind, false, k);
  }
});

test('banned_fdc is ratified TIER 2 (not higher) and pregnancy_risk_verify is ratified TIER 3', () => {
  assert.equal(tierFor(f({ signal_type: 'banned_fdc' })).tier, 2);
  assert.equal(tierFor(f({ signal_type: 'pregnancy_risk_verify', verdict: 'uncertain' })).tier, 3);
});

// ── O1c — unknown kinds: tier 2, counted, never dropped ──────────────────────
test('O1c: a model-invented kind lands in tier 2 and is flagged unlisted', () => {
  for (const k of ['paracetamol', 'matilda_forte_capsule', 'thyronorm_dose_adjustment', '', undefined]) {
    const r = tierFor(f({ signal_type: k as string | undefined, verdict: 'context-dependent' }));
    assert.equal(r.tier, 2, String(k));
    assert.equal(r.unlistedKind, true, String(k));
  }
});

// ── O1b + §4 — praise keys on the verdict, excluded from the tier list ───────
test('praise: *_high_value kinds and any high-value verdict (antibiotic_stewardship praise) are excluded and counted', () => {
  assert.equal(tierFor(f({ signal_type: 'appropriateness_high_value', verdict: 'high-value' })).tier, 'praise');
  assert.equal(tierFor(f({ signal_type: 'prescribing_high_value', verdict: 'high-value' })).tier, 'praise');
  assert.equal(tierFor(f({ signal_type: 'antibiotic_stewardship', verdict: 'high-value' })).tier, 'praise');
});

test('antibiotic_stewardship VIOLATION (low-value — antibiotic for a viral URTI) is tier 2', () => {
  assert.equal(tierFor(f({ signal_type: 'antibiotic_stewardship', verdict: 'low-value' })).tier, 2);
  assert.equal(tierFor(f({ signal_type: 'antibiotic_stewardship', verdict: 'context-dependent' })).tier, 2);
});

// ── §4 — incomplete_dosing keys on WHICH FIELD is missing ────────────────────
test('incomplete_dosing: missing strength / duration alone → tier 3 (ratified rows: findings 20, 24, 37, 41 + chronic continuation)', () => {
  assert.equal(tierFor(f({ signal_type: 'incomplete_dosing', verdict: 'context-dependent',
    rationale: 'Missing dose/strength — incomplete prescription (strength read from the drug name where possible).' })).tier, 3);
  assert.equal(tierFor(f({ signal_type: 'incomplete_dosing', verdict: 'context-dependent',
    rationale: 'Missing duration — incomplete prescription (strength read from the drug name where possible).' })).tier, 3);
  assert.equal(tierFor(f({ signal_type: 'incomplete_dosing', verdict: 'context-dependent',
    rationale: 'Missing dose/strength, duration — incomplete prescription.' })).tier, 3);
});

test('incomplete_dosing: a missing frequency or route changes what the patient does → tier 2; unparseable → tier 2', () => {
  assert.equal(tierFor(f({ signal_type: 'incomplete_dosing', verdict: 'context-dependent',
    rationale: 'Missing frequency — incomplete prescription.' })).tier, 2);
  assert.equal(tierFor(f({ signal_type: 'incomplete_dosing', verdict: 'context-dependent',
    rationale: 'Missing route, duration — incomplete prescription.' })).tier, 2);
  assert.equal(tierFor(f({ signal_type: 'incomplete_dosing', verdict: 'context-dependent',
    rationale: 'a rationale that carries no missing-field list' })).tier, 2);
});

// ── §3 — the escalation list: two seeds, deterministic, never the model ──────
test('E-1 (finding 36): a time-critical cardiac pattern in the finding text promotes to tier 1 — from any kind', () => {
  const r = tierFor(f({ subject: 'Suboptimal referral routing: exertional chest pain sent to general OPD review', verdict: 'low-value' }));
  assert.equal(r.tier, 1);
  assert.equal(r.escalatedBy, 'E-1');
  for (const t of ['possible Acute Coronary Syndrome not routed to emergency care', 'unstable angina managed as gastritis', 'rule out myocardial infarction']) {
    assert.equal(escalationMatch(f({ rationale: t })), 'E-1', t);
  }
});

test('E-2 (finding 49): persistent swelling ≥ 4 weeks with no follow-through promotes; with follow-through it does not', () => {
  const seed = f({
    subject: 'Incomplete clinical assessment for referral',
    rationale: 'Persistent left cervical swelling documented for 6 weeks; no investigation ordered and no follow-up planned in this note.',
    verdict: 'context-dependent',
  });
  const r = tierFor(seed);
  assert.equal(r.tier, 1);
  assert.equal(r.escalatedBy, 'E-2');
  // a negated mention ("no investigation ordered") must NOT count as follow-through — asserted by the seed above.
  // WITH follow-through in the same finding, E-2 stands down:
  assert.equal(escalationMatch(f({
    rationale: 'Persistent cervical swelling for 6 weeks; ultrasound ordered and follow-up scheduled next week.',
  })), undefined);
  // under 4 weeks → not E-2
  assert.equal(escalationMatch(f({ rationale: 'Unexplained swelling for 2 weeks, review advised.' })), undefined);
  // no duration documented → not E-2
  assert.equal(escalationMatch(f({ rationale: 'Persistent swelling of the ankle after a sprain.' })), undefined);
});

test('praise never escalates: a high-value finding praising an appropriate ACS referral stays praise', () => {
  const r = tierFor(f({ verdict: 'high-value', signal_type: 'appropriateness_high_value',
    rationale: 'Exertional chest pain appropriately routed for acute coronary syndrome work-up — exemplary.' }));
  assert.equal(r.tier, 'praise');
});

// ── bucketByTier — the surface helper ────────────────────────────────────────
test('bucketByTier: buckets are disjoint, complete, and count unlisted kinds', () => {
  const findings = [
    f({ signal_type: 'drug_interaction' }),                                          // 2
    f({ signal_type: 'unverified_brand', verdict: 'context-dependent' }),            // 3
    f({ signal_type: 'appropriateness_high_value', verdict: 'high-value' }),         // praise
    f({ signal_type: 'model_invented_kind', verdict: 'context-dependent' }),         // 2, unlisted
    f({ subject: 'possible ACS missed', verdict: 'low-value' }),                     // 1 via E-1
  ];
  const b = bucketByTier(findings);
  assert.equal(b.tier1.length, 1);
  assert.equal(b.tier2.length, 2);
  assert.equal(b.tier3.length, 1);
  assert.equal(b.praise.length, 1);
  assert.equal(b.unlisted, 1);
  assert.equal(b.tier1.length + b.tier2.length + b.tier3.length + b.praise.length, findings.length);
});

// ── C17 — twins collapse; two findings on one note do not (§1.4) ─────────────
test('dedupeTwins: same (finding_ref, doctor_uid, day) collapses with an occurrence count; different notes same day still collapse; different days do not', () => {
  const rows = [
    { finding: 'a1', findingRef: 'ref-1', doctorUid: 'dr-9', noteDate: '2026-07-30T10:00:00Z' },
    { finding: 'a2', findingRef: 'ref-1', doctorUid: 'dr-9', noteDate: '2026-07-30T10:03:00Z' },   // the twin, 3 min later
    { finding: 'b', findingRef: 'ref-1', doctorUid: 'dr-9', noteDate: '2026-07-31T09:00:00Z' },    // next day — separate
    { finding: 'c', findingRef: 'ref-2', doctorUid: 'dr-9', noteDate: '2026-07-30T10:00:00Z' },    // different finding on the same note — NOT a duplicate
  ];
  const out = dedupeTwins(rows);
  assert.equal(out.length, 3);
  assert.deepEqual(out.map((r) => [r.finding, r.occurrences]), [['a1', 2], ['b', 1], ['c', 1]]);
});

test('dedupeTwins: unkeyable rows (no ref / no doctor / no date) never merge', () => {
  const out = dedupeTwins([
    { finding: 'x', findingRef: null, doctorUid: 'dr', noteDate: '2026-07-30' },
    { finding: 'y', findingRef: null, doctorUid: 'dr', noteDate: '2026-07-30' },
  ]);
  assert.equal(out.length, 2);
});

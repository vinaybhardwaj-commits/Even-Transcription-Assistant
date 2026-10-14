/**
 *   node --experimental-strip-types --test lib/__tests__/scoring-policy-core.test.ts
 *
 * The pure scoring-policy core. PRD §10.
 *
 * THE HIGHEST-VALUE TEST IN THIS FILE is `all-Standard reproduces legacy EXACTLY` — the invariant
 * PRD §2.5 makes the ship/no-ship gate. Everything else is supporting.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  TIER_POINTS, DEFAULT_TIER, asTier, pointsFor, normalisedWeights, equalWeights, diffVectors,
  vectorsEqual, validateVector, weightsVersionString, canonicalVectorJson,
  DISCHARGE_SUMMARY_FIELDS, OPD_RX_FIELDS, OPD_LABEL_TO_KEY, OPD_NEAR_DUPLICATES,
  labelToOpdKey, weightedKeysFor, fieldsFor, type WeightVector,
} from '../scoring-policy/weights.ts';
import {
  weightedCompleteness, legacyCompleteness, roundPctLikeLegacy, asStatus, creditFor, bySection,
  DISCHARGE_SUMMARY_COND_KEYS, type StoredItem,
} from '../scoring-policy/completeness.ts';
import {
  bandFor, recomputeOpdIndex, recomputeIpdIndex, OPD_WEIGHTS, IPD_WEIGHTS, scoredUnderLabel,
} from '../scoring-policy/recompute.ts';
import {
  previewImpact, missingPrevalence, systemicDefectWarnings, systemicDefectMessage, scoreRow,
  SYSTEMIC_DEFECT_THRESHOLD, type CohortRow,
} from '../scoring-policy/preview.ts';
import { DS_FIXTURES, legacyPctReference } from './fixtures/scoring-policy-rows.ts';

const DS_KEYS = weightedKeysFor('discharge_summary');
const COND = { condKeys: DISCHARGE_SUMMARY_COND_KEYS };

// ═════════════════════════════════════════════════════════════════════════════════════════════
// THE INVARIANT (PRD §2.5) — all-Standard must reproduce legacy EXACTLY on real stored shapes
// ═════════════════════════════════════════════════════════════════════════════════════════════

test('THE INVARIANT: all-Standard weighting reproduces legacy completeness EXACTLY', () => {
  const v1 = equalWeights(DS_KEYS);                 // v1 as migration 0026 seeds it
  let exact = 0;
  const failures: string[] = [];
  for (const f of DS_FIXTURES) {
    // `legacyPctReference` is an INDEPENDENT re-implementation of lib/doc-audit-core.ts's
    // assembleCompleteness + lib/ipd-audit/assemble.ts's ×100 — written from that source, not
    // from the module under test — so this is a real comparison, not a tautology.
    const legacy = legacyPctReference(f.items);
    const weighted = weightedCompleteness(f.items, v1, COND).pct;
    if (legacy === weighted) exact += 1;
    else failures.push(`${f.id}: legacy ${legacy} vs weighted ${weighted} (${f.why})`);
  }
  assert.deepEqual(failures, [], 'every fixture row must reproduce exactly');
  assert.equal(exact, DS_FIXTURES.length, `${exact}/${DS_FIXTURES.length} reproduced`);
});

test('THE INVARIANT holds for the null vector too (PRD §8.1 fallback = legacy behaviour)', () => {
  for (const f of DS_FIXTURES) {
    assert.equal(weightedCompleteness(f.items, null, COND).pct, legacyPctReference(f.items), f.id);
  }
});

test('THE INVARIANT holds at all-Minor as well (PRD §8.4: mathematically identical to all-Standard)', () => {
  const allMinor: WeightVector = {};
  for (const k of DS_KEYS) allMinor[k] = 'minor';
  for (const f of DS_FIXTURES) {
    assert.equal(weightedCompleteness(f.items, allMinor, COND).pct, legacyPctReference(f.items), f.id);
  }
});

test('the fixture set actually exercises the hard cases (guards against a vacuous invariant)', () => {
  const hasRoundingTie = DS_FIXTURES.filter((f) => f.why.includes('tie')).length;
  const hasNa = DS_FIXTURES.filter((f) => f.items.some((i) => i.status === 'na' && i.key !== 'cause_of_death')).length;
  const hasPartial = DS_FIXTURES.filter((f) => f.items.some((i) => i.status === 'partial')).length;
  const hasCondApplies = DS_FIXTURES.filter((f) => f.items.some((i) => i.key === 'cause_of_death' && i.status !== 'na')).length;
  assert.ok(hasRoundingTie >= 5, `PRD §10 requires >=5 rounding-tie cases, have ${hasRoundingTie}`);
  assert.ok(hasNa >= 1, 'must include a non-conditional `na` — the na-policy divergence case');
  assert.ok(hasPartial >= 3, 'partial=0.5 must be exercised');
  assert.ok(hasCondApplies >= 1, 'must include a row where cause_of_death APPLIES (mandatoryTotal 21)');
  assert.ok(DS_FIXTURES.length >= 12, 'fixture set too small to be meaningful');
});

test('the na-policy divergence is REAL and this build takes the legacy branch (flagged deviation)', () => {
  // 20 fields: 1 na, 10 present, 9 missing — the worked example in completeness.ts's header.
  const items: StoredItem[] = [
    { key: 'procedures_performed', label: 'Procedures performed', section: 'course', status: 'na' },
    ...Array.from({ length: 10 }, (_, i) => ({ key: `p${i}`, label: `p${i}`, section: 'clinical', status: 'present' })),
    ...Array.from({ length: 9 }, (_, i) => ({ key: `m${i}`, label: `m${i}`, section: 'clinical', status: 'missing' })),
  ];
  const legacyExact = weightedCompleteness(items, null, { ...COND, naPolicy: 'legacy-exact' }).pct;
  const naExcluded = weightedCompleteness(items, null, { ...COND, naPolicy: 'na-excluded' }).pct;
  assert.equal(legacyExact, 55, 'na credited 1.0 and kept in the denominator: 11/20');
  assert.equal(naExcluded, 53, "the kickoff's literal prose: 10/19");
  assert.notEqual(legacyExact, naExcluded, 'the two rules genuinely disagree — this is not cosmetic');
  // The DEFAULT must be the one that reproduces stored data.
  assert.equal(weightedCompleteness(items, null, COND).pct, legacyExact);
});

test('a CONDITIONAL na leaves both sides under BOTH policies (mandatoryTotal 20 vs 21, PRD §2.9)', () => {
  const base: StoredItem[] = Array.from({ length: 20 }, (_, i) => ({ key: `f${i}`, label: `f${i}`, section: 's', status: i < 10 ? 'present' : 'missing' }));
  const withNaCod = [...base, { key: 'cause_of_death', label: 'Cause of death', section: 'outcome', status: 'na' }];
  const withCodMissing = [...base, { key: 'cause_of_death', label: 'Cause of death', section: 'outcome', status: 'missing' }];
  assert.equal(weightedCompleteness(withNaCod, null, COND).applicable, 20, 'na cond ⇒ 20');
  assert.equal(weightedCompleteness(withCodMissing, null, COND).applicable, 21, 'applicable cond ⇒ 21');
  assert.equal(weightedCompleteness(withNaCod, null, { ...COND, naPolicy: 'na-excluded' }).applicable, 20);
});

// ═════════════════════════════════════════════════════════════════════════════════════════════
// Weighting behaviour
// ═════════════════════════════════════════════════════════════════════════════════════════════

test('tier points are exactly Critical 8 · Important 4 · Standard 2 · Minor 1, and none is zero', () => {
  assert.deepEqual(TIER_POINTS, { critical: 8, important: 4, standard: 2, minor: 1 });
  assert.equal(DEFAULT_TIER, 'standard');
  for (const p of Object.values(TIER_POINTS)) assert.ok(p > 0, 'NO ZERO WEIGHTS EVER (PRD §2.4)');
});

test('normalised weights sum to 100.0 ± 0.05 for every combination (PRD §10)', () => {
  const keys = DS_KEYS;
  const tiers = ['critical', 'important', 'standard', 'minor'] as const;
  for (let seed = 0; seed < 60; seed++) {
    const v: WeightVector = {};
    keys.forEach((k, i) => { v[k] = tiers[(seed * 7 + i * 3) % 4]; });
    const sum = Object.values(normalisedWeights(v, keys)).reduce((a, b) => a + b, 0);
    assert.ok(Math.abs(sum - 100) < 0.05, `seed ${seed}: sum ${sum}`);
  }
  // all-one-tier cases too
  for (const t of tiers) {
    const v: WeightVector = {}; keys.forEach((k) => { v[k] = t; });
    assert.ok(Math.abs(Object.values(normalisedWeights(v, keys)).reduce((a, b) => a + b, 0) - 100) < 0.05, t);
  }
  assert.deepEqual(normalisedWeights({}, []), {}, 'empty key list ⇒ {} not a divide-by-zero');
});

test('weighting actually MOVES the score when tiers differ (the change is not a no-op)', () => {
  const items: StoredItem[] = [
    { key: 'date_discharge', label: 'Date of discharge', section: 'identifiers', status: 'missing' },
    { key: 'patient_name', label: 'Patient name', section: 'identifiers', status: 'present' },
    { key: 'uhid', label: 'UHID', section: 'identifiers', status: 'present' },
    { key: 'diagnosis', label: 'Diagnosis', section: 'clinical', status: 'present' },
  ];
  const equal = weightedCompleteness(items, null, COND).pct;
  assert.equal(equal, 75, '3 of 4 present');
  const critical: WeightVector = { date_discharge: 'critical' };
  assert.equal(weightedCompleteness(items, critical, COND).pct, 43, '8-point miss against 3×2: 6/14');
  const minor: WeightVector = { date_discharge: 'minor' };
  assert.equal(weightedCompleteness(items, minor, COND).pct, 86, '1-point miss against 3×2: 6/7');
});

test('partial is exactly 0.5, and na is not partial', () => {
  assert.equal(creditFor('present'), 1);
  assert.equal(creditFor('partial'), 0.5);
  assert.equal(creditFor('missing'), 0);
  const two: StoredItem[] = [
    { key: 'a', label: 'a', section: 's', status: 'present' },
    { key: 'b', label: 'b', section: 's', status: 'partial' },
  ];
  assert.equal(weightedCompleteness(two, null, COND).pct, 75, '(1 + 0.5) / 2');
});

test('all-na document returns 100 without dividing by zero (PRD §8.5)', () => {
  const items: StoredItem[] = [
    { key: 'cause_of_death', label: 'Cause of death', section: 'outcome', status: 'na' },
  ];
  const r = weightedCompleteness(items, null, COND);
  assert.equal(r.pct, 100);
  assert.equal(r.applicable, 0);
  assert.equal(r.weightSum, 0);
  // and with the na-excluded policy, where EVERY field drops out
  const all = [{ key: 'x', label: 'x', section: 's', status: 'na' }];
  assert.equal(weightedCompleteness(all, null, { ...COND, naPolicy: 'na-excluded' }).pct, 100);
});

test('unknown key defaults to Standard; empty/garbage vector falls back to equal weights (PRD §8.2)', () => {
  assert.equal(asTier('nonsense'), 'standard');
  assert.equal(asTier(undefined), 'standard');
  assert.equal(asTier(null), 'standard');
  assert.equal(pointsFor({ a: 'critical' }, 'b'), TIER_POINTS.standard, 'unmentioned key ⇒ Standard');
  const items: StoredItem[] = [
    { key: 'known', label: 'k', section: 's', status: 'present' },
    { key: 'never_seen_before', label: 'n', section: 's', status: 'missing' },
  ];
  assert.equal(weightedCompleteness(items, { known: 'standard' }, COND).pct, 50, 'unknown key weighted Standard');
});

test('malformed input never throws and never produces a wrong-looking score', () => {
  assert.doesNotThrow(() => weightedCompleteness(null, null, COND));
  assert.doesNotThrow(() => weightedCompleteness(undefined, null, COND));
  assert.doesNotThrow(() => weightedCompleteness([] as StoredItem[], null, COND));
  assert.doesNotThrow(() => weightedCompleteness([{ key: '' }] as StoredItem[], null, COND));
  assert.doesNotThrow(() => weightedCompleteness([null, undefined] as unknown as StoredItem[], null, COND));
  assert.equal(weightedCompleteness([], null, COND).pct, 100, 'no items ⇒ nothing missing ⇒ 100');
  // an unrecognised status reads as `missing`, matching legacy's absent-reading default
  assert.equal(asStatus('weird'), 'missing');
  assert.equal(asStatus(undefined), 'missing');
  assert.equal(weightedCompleteness([{ key: 'a', status: 'weird' }] as StoredItem[], null, COND).pct, 0);
});

test('rounding is half-up, applied via legacy\'s DOUBLE round', () => {
  assert.equal(roundPctLikeLegacy(0.875), 88, 'half-up, not banker\'s');
  assert.equal(roundPctLikeLegacy(0.885), 89);
  assert.equal(roundPctLikeLegacy(0.5), 50);
  assert.equal(roundPctLikeLegacy(0), 0);
  assert.equal(roundPctLikeLegacy(1), 100);
  assert.equal(roundPctLikeLegacy(NaN), 0, 'never NaN out into a stored score');
  // 7/8 = 0.875 → the classic tie. Legacy's chain: round(87.5)/100 = 0.88 → round(88) = 88.
  const items: StoredItem[] = Array.from({ length: 8 }, (_, i) => ({ key: `k${i}`, label: `k${i}`, section: 's', status: i < 7 ? 'present' : 'missing' }));
  assert.equal(weightedCompleteness(items, null, COND).pct, 88);
});

test('missingMandatory lists applicable missing fields by label (the unweighted gap count)', () => {
  const items: StoredItem[] = [
    { key: 'a', label: 'Alpha', section: 's', status: 'missing' },
    { key: 'b', label: 'Beta', section: 's', status: 'present' },
    { key: 'cause_of_death', label: 'Cause of death', section: 'outcome', status: 'na' },
  ];
  assert.deepEqual(weightedCompleteness(items, null, COND).missingMandatory, ['Alpha']);
});

test('legacyCompleteness (the independent path) agrees with the null-vector weighted path', () => {
  for (const f of DS_FIXTURES) {
    assert.equal(legacyCompleteness(f.items, COND), weightedCompleteness(f.items, null, COND).pct, f.id);
  }
});

// ═════════════════════════════════════════════════════════════════════════════════════════════
// Index recompute
// ═════════════════════════════════════════════════════════════════════════════════════════════

test('the re-stated domain weights match the closed cores VERBATIM (drift guard)', () => {
  // The cores are on the UNTOUCHED list and cannot be imported here (they pull in lib/db via
  // lib/doc-audit-core types), so they are compared AS SOURCE TEXT. If someone edits a core weight
  // this fails, which is the whole point.
  const opdSrc = readFileSync('lib/opd-note-score-core.ts', 'utf8');
  assert.ok(opdSrc.includes('documentation: 0.25, note_quality: 0.25, appropriateness: 0.20, prescribing_safety: 0.20, patient_centred: 0.10'),
    'OPD_DEFAULT_WEIGHTS changed in the core — update OPD_WEIGHTS');
  const ipdSrc = readFileSync('lib/value-score-core.ts', 'utf8');
  assert.ok(ipdSrc.includes('appropriateness: 0.30, efficiency: 0.20, safety: 0.20, cost: 0.15, documentation: 0.10, patient_centred: 0.05'),
    'DEFAULT_WEIGHTS changed in the core — update IPD_WEIGHTS');
  assert.deepEqual(OPD_WEIGHTS, { documentation: 0.25, note_quality: 0.25, appropriateness: 0.20, prescribing_safety: 0.20, patient_centred: 0.10 });
  assert.deepEqual(IPD_WEIGHTS, { appropriateness: 0.30, efficiency: 0.20, safety: 0.20, cost: 0.15, documentation: 0.10, patient_centred: 0.05 });
  assert.equal(Object.values(IPD_WEIGHTS).reduce((a, b) => a + b, 0).toFixed(2), '1.00');
  assert.equal(Object.values(OPD_WEIGHTS).reduce((a, b) => a + b, 0).toFixed(2), '1.00');
});

test('OPD index reproduces the core formula on a worked case', () => {
  // .25×80 + .25×60 + .20×70 + .20×90 + .10×50 = 20+15+14+18+5 = 72
  const r = recomputeOpdIndex({ note_quality: 60, appropriateness: 70, prescribing_safety: 90, patient_centred: 50 }, 80);
  assert.equal(r.index, 72);
  assert.equal(r.band, 'B');
});

test('PDQI-9 absent ⇒ note_quality drops and the divisor is 0.75 (PRD §2.6)', () => {
  // (.25×80 + .20×70 + .20×90 + .10×50) / .75 = (20+14+18+5)/.75 = 57/.75 = 76
  const r = recomputeOpdIndex({ note_quality: null, appropriateness: 70, prescribing_safety: 90, patient_centred: 50 }, 80);
  assert.equal(r.index, 76);
  // undefined behaves identically to null
  assert.equal(recomputeOpdIndex({ appropriateness: 70, prescribing_safety: 90, patient_centred: 50 }, 80).index, 76);
});

test('Care-Value Index reproduces the six-domain formula', () => {
  // .30×70 + .20×80 + .20×90 + .15×60 + .10×50 + .05×40 = 21+16+18+9+5+2 = 71
  const r = recomputeIpdIndex({ appropriateness: 70, efficiency: 80, safety: 90, cost: 60, patient_centred: 40 }, 50);
  assert.equal(r.index, 71);
  assert.equal(r.band, 'B');
});

test('substituting a new documentation score moves the index and can re-band', () => {
  const stored = { appropriateness: 70, efficiency: 80, safety: 90, cost: 60, patient_centred: 40 };
  const before = recomputeIpdIndex(stored, 50);
  const after = recomputeIpdIndex(stored, 0);
  assert.equal(after.index, before.index - 5, 'documentation weight is 0.10 ⇒ 50 points × .10 = 5');
  assert.equal(recomputeIpdIndex(stored, null).index, recomputeIpdIndex(stored, undefined).index);
});

test('band boundaries at 39/40, 54/55, 69/70, 84/85', () => {
  assert.equal(bandFor(85), 'A'); assert.equal(bandFor(84), 'B');
  assert.equal(bandFor(70), 'B'); assert.equal(bandFor(69), 'C');
  assert.equal(bandFor(55), 'C'); assert.equal(bandFor(54), 'D');
  assert.equal(bandFor(40), 'D'); assert.equal(bandFor(39), 'E');
  assert.equal(bandFor(100), 'A'); assert.equal(bandFor(0), 'E');
  assert.equal(bandFor(NaN), 'E', 'never throws on a bad score');
});

test('no domain scores at all ⇒ index 0, not NaN', () => {
  assert.equal(recomputeIpdIndex({}, null).index, 0);
  assert.equal(recomputeOpdIndex({}, null).index, 0);
});

test('the weights-version label is exact (PRD §2.8, §8.3)', () => {
  assert.equal(weightsVersionString('discharge_summary', 3), 'nabh-weights/discharge_summary/3');
  assert.equal(weightsVersionString('opd_rx', 1), 'nabh-weights/opd_rx/1');
  assert.equal(scoredUnderLabel('nabh-weights/discharge_summary/3'), 'Scored under nabh-weights/discharge_summary/3');
  assert.equal(scoredUnderLabel(null), null, 'no version ⇒ no claim');
});

// ═════════════════════════════════════════════════════════════════════════════════════════════
// Preview
// ═════════════════════════════════════════════════════════════════════════════════════════════

const COHORT: CohortRow[] = DS_FIXTURES.slice(0, 8).map((f, i) => ({
  id: f.id,
  items: f.items,
  kind: 'ipd' as const,
  domains: { appropriateness: 70 + i, efficiency: 80, safety: 90, cost: 60, patient_centred: 40 },
}));

test('preview: an unchanged candidate moves nothing', () => {
  const r = previewImpact(COHORT, null, null, COND);
  assert.equal(r.deltaMeanCompleteness, 0);
  assert.equal(r.deltaSd, 0);
  assert.equal(r.changingBand, 0);
  assert.deepEqual(r.movers, []);
  assert.equal(r.now.n, COHORT.length);
});

test('preview: making a widely-missing field Critical moves the mean and reports movers', () => {
  const r = previewImpact(COHORT, null, { date_discharge: 'critical' }, COND);
  assert.ok(r.movers.length > 0, 'someone must move');
  assert.ok(r.movers.length <= 3, 'at most the three largest');
  for (let i = 1; i < r.movers.length; i++) {
    assert.ok(Math.abs(r.movers[i - 1].delta) >= Math.abs(r.movers[i].delta), 'movers sorted by |delta| desc');
  }
  const hist = Object.values(r.after.bandHistogram).reduce((a, b) => a + b, 0);
  assert.equal(hist, COHORT.length, 'every row lands in exactly one band');
});

test('preview: empty cohort yields zeroed stats, no throw (the OPD empty state)', () => {
  const r = previewImpact([], null, { a: 'critical' }, COND);
  assert.equal(r.now.n, 0);
  assert.equal(r.after.meanCompleteness, 0);
  assert.equal(r.after.sdCompleteness, 0);
  assert.deepEqual(r.movers, []);
  assert.doesNotThrow(() => previewImpact(null as unknown as CohortRow[], null, null, COND));
});

test('preview: SD is population SD and a single row has SD 0', () => {
  const one = [COHORT[0]];
  assert.equal(previewImpact(one, null, null, COND).now.sdCompleteness, 0);
});

test('missingPrevalence excludes `na` from the base, and reports a percentage', () => {
  const rows: CohortRow[] = [
    { id: '1', kind: 'ipd', domains: {}, items: [{ key: 'x', label: 'x', section: 's', status: 'missing' }] },
    { id: '2', kind: 'ipd', domains: {}, items: [{ key: 'x', label: 'x', section: 's', status: 'present' }] },
    { id: '3', kind: 'ipd', domains: {}, items: [{ key: 'x', label: 'x', section: 's', status: 'na' }] },
  ];
  const p = missingPrevalence(rows);
  assert.deepEqual(p.x, { missing: 1, applicable: 2, pct: 50 }, 'the na row is not in the denominator');
});

test('systemic-defect warning fires only above 50% missing AND only at Critical; it never blocks', () => {
  const prevalence = { date_discharge: { pct: 78 }, uhid: { pct: 2 }, edge: { pct: 50 } };
  const label = (k: string) => k.toUpperCase();
  assert.deepEqual(systemicDefectWarnings({ date_discharge: 'critical' }, prevalence, label),
    [{ key: 'date_discharge', label: 'DATE_DISCHARGE', missingPct: 78 }]);
  assert.deepEqual(systemicDefectWarnings({ date_discharge: 'important' }, prevalence, label), [], 'Important does not fire');
  assert.deepEqual(systemicDefectWarnings({ uhid: 'critical' }, prevalence, label), [], 'rare misses do not fire');
  assert.deepEqual(systemicDefectWarnings({ edge: 'critical' }, prevalence, label), [], 'strictly > 50, not >=');
  assert.equal(SYSTEMIC_DEFECT_THRESHOLD, 50);
  assert.deepEqual(systemicDefectWarnings(null, prevalence, label), []);
});

test('the systemic-defect copy is verbatim per PRD §5.3', () => {
  assert.equal(systemicDefectMessage('Date of discharge', 4.2),
    'Date of discharge is missing from most summaries already. Weighting it heavily fails almost every doctor at once instead of telling them apart — this is a discharge template problem, not a scoring one. Spread is now 4.2.');
});

test('scoreRow routes IPD and OPD to different index formulas', () => {
  // Documentation carries 0.10 on IPD but 0.25 on OPD, so a documentation-only change must move the
  // OPD index further. Asserting the SENSITIVITY rather than a one-off inequality: two formulas can
  // coincide at a single point by arithmetic accident, but not in their response to the same delta.
  const items100: StoredItem[] = [{ key: 'a', label: 'a', section: 's', status: 'present' }];
  const items0: StoredItem[] = [{ key: 'a', label: 'a', section: 's', status: 'missing' }];
  const domains = { appropriateness: 70, efficiency: 80, safety: 90, cost: 60, patient_centred: 40, note_quality: 60, prescribing_safety: 90 };
  const ipdSwing = scoreRow({ id: '1', items: items100, kind: 'ipd', domains }, null, COND).index
    - scoreRow({ id: '1', items: items0, kind: 'ipd', domains }, null, COND).index;
  const opdSwing = scoreRow({ id: '1', items: items100, kind: 'opd', domains }, null, COND).index
    - scoreRow({ id: '1', items: items0, kind: 'opd', domains }, null, COND).index;
  assert.equal(ipdSwing, 10, '100 documentation points × 0.10');
  assert.equal(opdSwing, 25, '100 documentation points × 0.25');
  assert.ok(opdSwing > ipdSwing, 'documentation matters more to the OPD index — the two ladders differ');
});

// ═════════════════════════════════════════════════════════════════════════════════════════════
// Field catalogues + the OPD label→key mapping
// ═════════════════════════════════════════════════════════════════════════════════════════════

/** data/nabh-rubric.json shape: { <section>: { label, standard, fields: [...] }, _meta: {...} }. */
function rubricFields(): { key: string; label: string; section: string; cond?: string }[] {
  const rubric = JSON.parse(readFileSync('data/nabh-rubric.json', 'utf8')) as Record<string, { fields?: unknown }>;
  return (rubric.discharge_summary?.fields ?? []) as { key: string; label: string; section: string; cond?: string }[];
}

test('the 21 discharge_summary fields match data/nabh-rubric.json EXACTLY (key, label, section)', () => {
  const fields = rubricFields();
  assert.equal(DISCHARGE_SUMMARY_FIELDS.length, 21);
  assert.equal(fields.length, 21);
  const mine = new Map(DISCHARGE_SUMMARY_FIELDS.map((f) => [f.key, f]));
  for (const rf of fields) {
    const f = mine.get(rf.key);
    assert.ok(f, `rubric key ${rf.key} missing from the catalogue`);
    assert.equal(f!.label, rf.label, `label drift on ${rf.key}`);
    assert.equal(f!.section, rf.section, `section drift on ${rf.key}`);
  }
  // the six sections of PRD §2.9
  assert.deepEqual([...new Set(DISCHARGE_SUMMARY_FIELDS.map((f) => f.section))],
    ['identifiers', 'clinical', 'course', 'followup', 'outcome', 'signoff']);
});

test('cause_of_death is the ONE conditional key, read from the rubric', () => {
  const cond = rubricFields().filter((f) => f.cond).map((f) => f.key);
  assert.deepEqual(cond, ['cause_of_death'], 'if this changes, DISCHARGE_SUMMARY_COND_KEYS must too');
  assert.deepEqual([...DISCHARGE_SUMMARY_COND_KEYS], cond);
});

test('the OPD label→key mapping covers every live-observed label (companion spec §4.7)', () => {
  // All 17 labels from the companion spec's live table, VERBATIM.
  const observed = [
    'Complete medication dosing', 'Follow-up specified', 'Examination recorded', 'Advice / plan',
    'Presenting complaint', 'Relevant history', 'Allergy status documented',
    'Vitals for the presentation (e.g. temperature for fever)', 'Advice / instructions',
    'Diagnosis / impression', 'Obstetric exam / vitals (weight + fetal SFH / FHR / presentation)',
    'Investigations ordered / reviewed or nil', 'Gravidity & parity', 'LMP and / or EDD',
    'Obstetric exam / vitals (weight)', 'Presenting complaint / symptoms', 'Gestational age / POG',
  ];
  const unresolved = observed.filter((l) => labelToOpdKey(l) == null);
  assert.deepEqual(unresolved, [], 'every observed label must resolve to a key');
  assert.equal(new Set(observed.map((l) => labelToOpdKey(l))).size, 16,
    'the two obstetric-vitals label variants are ONE key (a dynamic template label), so 17 labels → 16 keys');
});

test('the OPD engine\'s ACTUAL emitted keys are all in the catalogue (no orphan can appear)', () => {
  // Read the engine source and pull out every `key: '...'` inside a completeness item literal.
  const src = readFileSync('lib/opd-note-audit-core.ts', 'utf8');
  const emitted = new Set<string>();
  for (const m of src.matchAll(/\{\s*key:\s*'([a-z_]+)',\s*label:/g)) emitted.add(m[1]);
  assert.ok(emitted.size >= 12, `expected the engine's item keys, found ${emitted.size}`);
  const known = new Set(OPD_RX_FIELDS.map((f) => f.key));
  const orphans = [...emitted].filter((k) => !known.has(k));
  assert.deepEqual(orphans, [], 'the engine emits a key the catalogue does not know');
});

test('the OPD structured emission is ADDITIVE: status/section added, present/mandatory preserved', async () => {
  // Imported dynamically: lib/opd-note-audit-core.ts pulls in db-bound modules, so this runs under
  // tsx (npm test) and is skipped by a bare --experimental-strip-types invocation of this file.
  const { withOpdFieldStatus } = await import('../opd-note-audit-core.ts');
  const before = [
    { key: 'presenting_complaint', label: 'Presenting complaint', present: true, mandatory: true },
    { key: 'examination', label: 'Examination recorded', present: false, mandatory: true },
    { key: 'follow_up', label: 'Follow-up specified', present: false, mandatory: true },
    { key: 'ga_pog', label: 'Gestational age / POG', present: true, mandatory: true },
  ];
  const after = withOpdFieldStatus(before);
  // nothing existing is lost or altered
  after.forEach((a, i) => {
    assert.equal(a.key, before[i].key);
    assert.equal(a.label, before[i].label);
    assert.equal(a.present, before[i].present, 'the legacy boolean is untouched');
    assert.equal(a.mandatory, before[i].mandatory);
  });
  // status is DERIVED from present, so the two can never disagree
  assert.deepEqual(after.map((a) => a.status), ['present', 'missing', 'missing', 'present']);
  for (const a of after) assert.equal(a.status === 'present', a.present, 'status must track present');
  // section routes continuity vs documentation vs obstetric
  assert.deepEqual(after.map((a) => a.section), ['documentation', 'documentation', 'continuity', 'obstetric']);
  // idempotent — stamping twice changes nothing
  assert.deepEqual(withOpdFieldStatus(after), after);
  // an unknown key still gets a status, and defaults to documentation (visible, not dropped)
  const odd = withOpdFieldStatus([{ key: 'brand_new_check', label: 'x', present: false, mandatory: true }]);
  assert.equal(odd[0].status, 'missing');
  assert.equal(odd[0].section, 'documentation');
});

test('the OPD engine emits the structured shape from BOTH completeness paths (GP and obstetric)', () => {
  const src = readFileSync('lib/opd-note-audit-core.ts', 'utf8');
  const stamped = (src.match(/items: withOpdFieldStatus\(items\)/g) || []).length;
  assert.equal(stamped, 2, 'both opdCompleteness and opdCompletenessObstetric must stamp');
  // and the legacy fields are still on the interface — this is ADDITIVE, not a replacement
  assert.ok(/present: boolean;/.test(src) && /mandatory: boolean;/.test(src));
  assert.ok(/missing: string\[\];/.test(src), 'missing_fields is NOT replaced');
});

// ═════════════════════════════════════════════════════════════════════════════════════════════
// PHASE A.1 — persisted OPD items + the migration runner (kickoff §12.1a)
// ═════════════════════════════════════════════════════════════════════════════════════════════

test('A.1 THE FALLBACK RULE: a NULL completeness_items row keeps its stored scores, untouched', async () => {
  const { applyOpdScoringPolicy } = await import('../opd-audit-store.ts');
  // Every one of the 25,130 historical rows looks like this.
  const historical = {
    id: 'h1', completeness_items: null,
    completeness_pct: 67, note_quality_index: 58, band: 'C',
    score_documentation: 67, score_note_quality: 40, score_appropriateness: 80,
    score_prescribing_safety: 70, score_patient_centred: 50,
  };
  const [out] = await applyOpdScoringPolicy([historical]);
  assert.equal(out.weights_not_applicable, true, 'nothing to re-weight');
  // THE THREE THAT MATTER: stored values survive verbatim.
  assert.equal(out.completeness_pct, 67, 'must NOT become 100 (empty-array semantics)');
  assert.equal(out.note_quality_index, 58);
  assert.equal(out.band, 'C');
  // and the mirrors are present for a surface that wants to show both
  assert.equal(out.stored_completeness_pct, 67);
  assert.equal(out.stored_band, 'C');
});

test('A.1 a missing array is never read as 100 NOR as 0 — both directions', async () => {
  const { applyOpdScoringPolicy } = await import('../opd-audit-store.ts');
  const { weightedCompleteness } = await import('../scoring-policy/completeness.ts');
  // The trap: the pure core scores an EMPTY item list as 100 (correct for an all-`na` document).
  assert.equal(weightedCompleteness([], null, {}).pct, 100, 'the trap this guard exists for');
  for (const raw of [null, undefined, '[]', '', 'not json', '{}', [], 0]) {
    const [out] = await applyOpdScoringPolicy([{
      id: 'x', completeness_items: raw, completeness_pct: 42, note_quality_index: 55, band: 'C',
    }]);
    assert.equal(out.completeness_pct, 42, `raw=${JSON.stringify(raw)} must keep the stored value`);
    assert.notEqual(out.completeness_pct, 100, 'never silently promoted');
    assert.notEqual(out.completeness_pct, 0, 'never read as all-fields-missing');
    assert.equal(out.weights_not_applicable, true);
  }
});

test('A.1 a row WITH items is weighted, and weights_not_applicable flips to false', async () => {
  const { applyOpdScoringPolicy } = await import('../opd-audit-store.ts');
  const items = [
    { key: 'presenting_complaint', label: 'Presenting complaint', status: 'present', section: 'documentation' },
    { key: 'diagnosis', label: 'Diagnosis / impression', status: 'present', section: 'documentation' },
    { key: 'examination', label: 'Examination recorded', status: 'missing', section: 'documentation' },
    { key: 'medication_dosing', label: 'Complete medication dosing', status: 'present', section: 'documentation' },
  ];
  const [out] = await applyOpdScoringPolicy([{
    id: 'n1', completeness_items: items,
    completeness_pct: 99, note_quality_index: 99, band: 'A',   // deliberately wrong stored values
    score_note_quality: 40, score_appropriateness: 80, score_prescribing_safety: 70, score_patient_centred: 50,
  }]);
  assert.equal(out.weights_not_applicable, false);
  assert.equal(out.completeness_pct, 75, '3 of 4 present under v1 all-Standard');
  assert.equal(out.score_documentation, 75, 'the documentation domain IS completeness');
  assert.notEqual(out.note_quality_index, 99, 'the index is rebuilt, not passed through');
  assert.equal(out.stored_completeness_pct, 99, 'the stored value is still available');
  // accepts the jsonb as a STRING too (driver-dependent)
  const [asStr] = await applyOpdScoringPolicy([{ id: 'n2', completeness_items: JSON.stringify(items), completeness_pct: 1 }]);
  assert.equal(asStr.completeness_pct, 75);
});

test('A.1 continuity items are EXCLUDED from the OPD denominator (reproduces the engine\'s coverage)', async () => {
  const { applyOpdScoringPolicy } = await import('../opd-audit-store.ts');
  // The engine computes coverage over docItems only — advice/follow-up are Continuity. If they
  // leaked into the denominator this row would read 3/5 = 60 instead of 3/3 = 100.
  const items = [
    { key: 'presenting_complaint', status: 'present' },
    { key: 'diagnosis', status: 'present' },
    { key: 'medication_dosing', status: 'present' },
    { key: 'advice_given', status: 'missing' },
    { key: 'follow_up', status: 'missing' },
  ];
  const [out] = await applyOpdScoringPolicy([{ id: 'c1', completeness_items: items, completeness_pct: 0 }]);
  assert.equal(out.completeness_pct, 100, 'continuity misses must not lower documentation completeness');
});

test('A.1 applyOpdScoringPolicy never throws and handles an empty batch', async () => {
  const { applyOpdScoringPolicy } = await import('../opd-audit-store.ts');
  assert.deepEqual(await applyOpdScoringPolicy([]), []);
  assert.deepEqual(await applyOpdScoringPolicy(null as unknown as Record<string, unknown>[]), []);
  await assert.doesNotReject(() => applyOpdScoringPolicy([{ id: 'weird' }]));
  const [odd] = await applyOpdScoringPolicy([{ id: 'weird' }]);
  assert.equal(odd.weights_not_applicable, true);
  assert.equal(odd.stored_completeness_pct, null);
});

test('A.1 parseOpdCompletenessItems drops malformed entries rather than throwing', async () => {
  const { parseOpdCompletenessItems } = await import('../opd-audit-store.ts');
  assert.deepEqual(parseOpdCompletenessItems(null), []);
  assert.deepEqual(parseOpdCompletenessItems('nonsense'), []);
  assert.deepEqual(parseOpdCompletenessItems({ key: 'x' }), [], 'an object is not an array');
  assert.equal(parseOpdCompletenessItems([{ key: 'a' }, null, { nokey: 1 }, { key: 'b' }]).length, 2);
});

test('A.1 the OPD write path persists the array, guarded by a column probe', () => {
  const src = readFileSync('lib/opd-audit-store.ts', 'utf8');
  // both writers persist it
  assert.ok(/completeness_items/.test(src));
  assert.equal((src.match(/completenessItemsColumnExists\(\)/g) || []).length, 3,
    'declared once + probed in saveOpdAudit and updateOpdAudit');
  assert.equal((src.match(/completenessItemsJson\(audit\)/g) || []).length, 2, 'both writers serialise it');
  // deploy-before-migrate tolerance: the column is only named when it exists
  assert.ok(/withItems \? ', completeness_items' : ''/.test(src), 'INSERT column list is conditional');
  assert.ok(/EXCLUDED\.completeness_items/.test(src), 'force-mode overwrite carries it too');
  // NULL, not [], when the engine produced nothing — the distinction the read path depends on
  assert.ok(/if \(!Array\.isArray\(items\) \|\| items\.length === 0\) return null;/.test(src));
});

test('A.1 the migration runner exists, is admin-guarded, and every statement is idempotent', () => {
  const src = readFileSync('app/api/admin/migrate-scoring-policy/route.ts', 'utf8');
  assert.ok(/export async function POST/.test(src), 'POST, matching every other migrate-* route');
  assert.ok(/runtime = 'nodejs'/.test(src));
  assert.ok(/requireAdmin\(req\)/.test(src) && /isAdminUnlocked\(\)/.test(src), 'token OR session');
  assert.ok(/const steps: Record<string, string> = \{\}/.test(src), 'per-step report');
  // IDEMPOTENCE: no bare CREATE/ALTER anywhere
  const creates = src.match(/CREATE (?:UNIQUE )?(?:TABLE|INDEX)(?! IF NOT EXISTS)/g) || [];
  assert.deepEqual(creates, [], 'every CREATE must be IF NOT EXISTS');
  const alters = src.match(/ADD COLUMN(?! IF NOT EXISTS)/g) || [];
  assert.deepEqual(alters, [], 'every ADD COLUMN must be IF NOT EXISTS');
  assert.ok(/WHERE NOT EXISTS \(SELECT 1 FROM scoring_policy_versions/.test(src), 'the seed is guarded');
  assert.ok(/already_present/.test(src), 're-running reports the seed as already present');
  // it applies BOTH migrations in one call
  assert.ok(/scoring_policy_versions/.test(src) && /scoring_policy_drafts/.test(src), '0026');
  assert.ok(/ALTER TABLE opd_note_audits ADD COLUMN IF NOT EXISTS completeness_items jsonb/.test(src), '0027');
  // and proves what landed rather than asserting it
  assert.ok(/information_schema\.columns/.test(src), 'verification read-back');
});

test('A.1 the runner\'s inlined DDL matches the two .sql files it stands in for', () => {
  const route = readFileSync('app/api/admin/migrate-scoring-policy/route.ts', 'utf8');
  const m26 = readFileSync('migrations/0026_scoring_policy.sql', 'utf8');
  const m27 = readFileSync('migrations/0027_opd_completeness_items.sql', 'utf8');
  // the objects created must be the same set, in both places
  for (const obj of ['scoring_policy_versions', 'scoring_policy_drafts', 'scoring_policy_versions_one_active']) {
    assert.ok(m26.includes(obj), `${obj} in 0026`);
    assert.ok(route.includes(obj), `${obj} in the runner`);
  }
  assert.ok(m27.includes('completeness_items jsonb') && route.includes('completeness_items jsonb'));
  // the seed rationale is verbatim in both
  const RATIONALE = 'Initial — equal weight across all fields, reproduces legacy scoring.';
  assert.ok(m26.includes(RATIONALE) && route.includes(RATIONALE));
  // and the seeded key sets agree with the catalogue
  for (const k of weightedKeysFor('discharge_summary')) assert.ok(route.includes(`${k}: 'standard'`) || route.includes(`"${k}":"standard"`), `DS ${k}`);
  for (const k of weightedKeysFor('opd_rx')) assert.ok(route.includes(`${k}: 'standard'`), `OPD ${k}`);
});

test('A.1 no backfill: nothing in the build writes completeness_items to historical rows', () => {
  const route = readFileSync('app/api/admin/migrate-scoring-policy/route.ts', 'utf8');
  assert.ok(!/UPDATE opd_note_audits SET completeness_items/i.test(route), 'decision §1.5 — no backfill');
  const m27 = readFileSync('migrations/0027_opd_completeness_items.sql', 'utf8');
  assert.ok(!/UPDATE opd_note_audits/i.test(m27), 'the migration adds a column and stops');
});

test('the three continuity fields are EXCLUDED from the OPD weight vector (kickoff normative list)', () => {
  const weighted = weightedKeysFor('opd_rx');
  for (const k of ['advice_given', 'advice_instructions', 'follow_up']) {
    assert.ok(!weighted.includes(k), `${k} must not be weightable — it is Continuity, not Documentation`);
  }
  assert.equal(weighted.length, 13, '16 catalogued keys minus the 3 continuity ones');
  // and they ARE still catalogued, so the screen can show them as excluded rather than hide them
  const all = OPD_RX_FIELDS.map((f) => f.key);
  for (const k of ['advice_given', 'advice_instructions', 'follow_up']) assert.ok(all.includes(k));
});

test('the near-duplicate pairs are kept SEPARATE and flagged, not merged', () => {
  assert.equal(OPD_NEAR_DUPLICATES.length, 2);
  for (const { keep, duplicate } of OPD_NEAR_DUPLICATES) {
    const a = OPD_RX_FIELDS.find((f) => f.key === keep);
    const b = OPD_RX_FIELDS.find((f) => f.key === duplicate);
    assert.ok(a && b, `${keep}/${duplicate} both present`);
    assert.equal(b!.nearDuplicateOf, keep, 'the duplicate points at its twin');
    assert.notEqual(a!.label, b!.label, 'distinct labels');
  }
  assert.notEqual(labelToOpdKey('Presenting complaint'), labelToOpdKey('Presenting complaint / symptoms'));
  assert.notEqual(labelToOpdKey('Advice / plan'), labelToOpdKey('Advice / instructions'));
});

test('labelToOpdKey: dynamic obstetric labels match by prefix; unknown returns null (never guesses)', () => {
  assert.equal(labelToOpdKey('Obstetric exam / vitals (weight)'), 'obstetric_vitals');
  assert.equal(labelToOpdKey('Obstetric exam / vitals (weight + fetal SFH/FHR/presentation)'), 'obstetric_vitals');
  assert.equal(labelToOpdKey('Obstetric exam / vitals (weight · BP recorded)'), 'obstetric_vitals');
  assert.equal(labelToOpdKey('Something nobody has ever emitted'), null);
  assert.equal(labelToOpdKey(''), null);
  assert.equal(labelToOpdKey(null as unknown as string), null);
  // whitespace-normalised match
  assert.equal(labelToOpdKey('  Relevant   history  '), 'relevant_history');
});

test('every catalogued OPD label round-trips through the mapping', () => {
  for (const f of OPD_RX_FIELDS) {
    if (f.key === 'obstetric_vitals') { assert.equal(labelToOpdKey(f.label), 'obstetric_vitals'); continue; }
    assert.equal(labelToOpdKey(f.label), f.key, `${f.label} → ${f.key}`);
  }
  assert.equal(Object.keys(OPD_LABEL_TO_KEY).length, 17, 'incl. two punctuation variants');
});

test('fieldsFor / weightedKeysFor route by note type and never return an empty key space', () => {
  assert.equal(fieldsFor('discharge_summary').length, 21);
  assert.equal(fieldsFor('opd_rx').length, 16);
  assert.equal(fieldsFor('nonsense').length, 21, 'unknown note type ⇒ the IPD catalogue, not empty');
  assert.equal(weightedKeysFor('discharge_summary').length, 21, 'all 21 IPD fields are weightable');
});

// ═════════════════════════════════════════════════════════════════════════════════════════════
// Vector plumbing
// ═════════════════════════════════════════════════════════════════════════════════════════════

test('diffVectors reports only real changes, with old → new tiers', () => {
  const a: WeightVector = { x: 'standard', y: 'critical' };
  const b: WeightVector = { x: 'minor', y: 'critical' };
  assert.deepEqual(diffVectors(a, b, ['x', 'y']), [{ key: 'x', from: 'standard', to: 'minor' }]);
  assert.deepEqual(diffVectors(a, a, ['x', 'y']), []);
  // an absent key reads as Standard on both sides, so it is not a change
  assert.deepEqual(diffVectors({}, { z: 'standard' }, ['z']), []);
  assert.deepEqual(diffVectors({}, { z: 'critical' }, ['z']), [{ key: 'z', from: 'standard', to: 'critical' }]);
});

test('vectorsEqual treats absent as Standard (so a seeded v1 equals an empty draft)', () => {
  assert.ok(vectorsEqual({}, equalWeights(['a', 'b']), ['a', 'b']));
  assert.ok(!vectorsEqual({ a: 'critical' }, {}, ['a']));
});

test('validateVector rejects non-objects but coerces unknown tiers rather than failing', () => {
  assert.equal(validateVector(null, ['a']).ok, false);
  assert.equal(validateVector('x', ['a']).ok, false);
  assert.equal(validateVector([], ['a']).ok, false);
  const r = validateVector({ a: 'nonsense', b: 'critical' }, ['a', 'b']);
  assert.ok(r.ok);
  assert.deepEqual(r.ok && r.vector, { a: 'standard', b: 'critical' });
  // a body stuffed with junk keys is rejected rather than silently absorbed
  const junk: Record<string, string> = {};
  for (let i = 0; i < 30; i++) junk[`junk${i}`] = 'critical';
  assert.equal(validateVector(junk, ['a']).ok, false);
});

test('canonicalVectorJson is stable regardless of key insertion order', () => {
  const a = canonicalVectorJson({ b: 'minor', a: 'critical' }, ['a', 'b']);
  const b = canonicalVectorJson({ a: 'critical', b: 'minor' }, ['b', 'a']);
  assert.equal(a, b);
  assert.equal(a, '[["a","critical"],["b","minor"]]');
});

test('bySection groups and preserves first-seen order', () => {
  const items: StoredItem[] = [
    { key: 'a', section: 'identifiers', status: 'present' },
    { key: 'b', section: 'clinical', status: 'present' },
    { key: 'c', section: 'identifiers', status: 'missing' },
  ];
  const g = bySection(items);
  assert.deepEqual(g.map((x) => x.section), ['identifiers', 'clinical']);
  assert.equal(g[0].items.length, 2);
  assert.deepEqual(bySection(null), []);
  assert.equal(bySection([{ key: 'x', status: 'present' }] as StoredItem[])[0].section, 'other', 'sectionless ⇒ other');
});

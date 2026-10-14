// lib/__tests__/right-care-check-gold.test.ts — the deterministic score-against-gold path
// (harness-gold kickoff, 13-Jul-2026): the committed right-care-check-gold/1.0 artifact
// validates and cross-references the live catalog, and the pure scorer/aggregate produce
// known numbers from synthetic fired sets. Run: npm test.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  RIGHT_CARE_CHECK_GOLD_VERSION, loadCheckGold, scoreCheckAgainstGold, aggregateCheckGold,
  RIGHT_CARE_CHECK_GOLD_2_VERSION, loadCheckGold2, splitCheckGold2, checkGold2CatalogGaps,
} from '../right-care-ground-eval-core';
import GOLD from '../../data/right-care-eval/check-gold-1.0.json';
import GOLD2 from '../../data/right-care-eval/check-gold-2.0.json';
import SEED from '../../data/choosing-wisely-seed.json';

test('the committed gold artifact is frozen, ratified, and catalog-consistent', () => {
  const g = loadCheckGold(GOLD);
  assert.equal(g.version, RIGHT_CARE_CHECK_GOLD_VERSION);
  assert.equal(g.cases.length, 36);
  const positives = g.cases.filter((c) => c.polarity === 'positive');
  const nearMisses = g.cases.filter((c) => c.polarity === 'near_miss');
  assert.equal(positives.length, 18);
  assert.equal(nearMisses.length, 18);
  assert.equal(new Set(g.cases.map((c) => c.sourceRec)).size, 18, '18 distinct target recs');
  // every gold target must be a REAL catalog rec — otherwise the case could never fire
  const catalogIds = new Set((SEED as { recommendations: Array<{ id: string }> }).recommendations.map((r) => r.id));
  for (const c of g.cases) {
    for (const id of [...c.gold.mustFire, ...c.gold.mustNotFire]) {
      assert.ok(catalogIds.has(id), `${c.id} targets ${id}, which is not in the CW seed catalog`);
    }
  }
});

test('loadCheckGold rejects drift: wrong version, unratified, polarity/target mismatch', () => {
  const base = JSON.parse(JSON.stringify(GOLD)) as { version: string; status: string; cases: Array<Record<string, unknown>> };
  assert.throws(() => loadCheckGold({ ...base, version: 'right-care-check-gold/2.0' }));
  assert.throws(() => loadCheckGold({ ...base, status: 'draft' }));
  const broken = JSON.parse(JSON.stringify(GOLD));
  broken.cases[0].gold = { mustFire: [], mustNotFire: [] };   // positive with no target
  assert.throws(() => loadCheckGold(broken), /empty mustFire/);
  const dup = JSON.parse(JSON.stringify(GOLD));
  dup.cases[1].id = dup.cases[0].id;
  assert.throws(() => loadCheckGold(dup), /duplicate/);
});

// ── check-gold/2.0 (15-Jul-2026 kickoff) — the committed ratified artifact pins in CI, and
// the loader/split/gap tests below use SYNTHETIC structural fixtures only; the clinical
// artifact is delivered by V (pre-bound against the seed catalog), never authored here. ─────

test('the committed 2.0 artifact is frozen, ratified, family-split, and catalog-consistent', () => {
  const g = loadCheckGold2(GOLD2);
  assert.equal(g.version, RIGHT_CARE_CHECK_GOLD_2_VERSION);
  assert.equal(g.cases.length, 23);
  const fam = (f: string) => g.cases.filter((c) => c.family === f).length;
  assert.equal(fam('P'), 8);
  assert.equal(fam('N'), 7);
  assert.equal(fam('C'), 4);
  assert.equal(fam('L'), 4);
  const { floor, annex } = splitCheckGold2(g.cases);
  assert.equal(floor.length, 19, 'scored floor = P + N + C');
  assert.equal(annex.length, 4, 'annex = L, never folded into the floor');
  // every BOUND target must be a real catalog rec; unbound sides are legitimate catalog gaps
  const catalogIds = new Set((SEED as { recommendations: Array<{ id: string }> }).recommendations.map((r) => r.id));
  for (const c of g.cases) {
    for (const id of [...c.gold.mustFire, ...c.gold.mustNotFire]) {
      assert.ok(catalogIds.has(id), `${c.id} binds ${id}, which is not in the CW seed catalog`);
    }
  }
});

const g2Case = (over: Record<string, unknown> = {}) => ({
  id: 'T-P-01', mode: 'check', family: 'P', polarity: 'positive',
  expected: 'synthetic ratified verdict for loader shape tests',
  clinicalTarget: 'synthetic target description',
  sourceRecHint: 'synthetic-hint',
  patient: { age: 50, sex: 'F' },
  scenario: 'synthetic scenario for loader shape tests only',
  proposedActions: ['synthetic action'],
  gold: { mustFire: [], mustNotFire: [] },
  ...over,
});
const g2 = (cases: Array<Record<string, unknown>>) => ({
  version: RIGHT_CARE_CHECK_GOLD_2_VERSION, status: 'ratified', cases,
});

test('loadCheckGold2: accepts the delivered shape — empty targets legal, L carries annex/memberHistory', () => {
  const loaded = loadCheckGold2(g2([
    g2Case(),                                                                           // unbound positive = legal (pre-binding / catalog gap)
    g2Case({ id: 'T-N-01', family: 'N', polarity: 'near_miss', gold: { mustFire: [], mustNotFire: ['x-1'] } }),
    g2Case({ id: 'T-C-01', family: 'C', gold: { mustFire: ['x-2'], mustNotFire: [] }, sourceRec: 'x-2' }),
    g2Case({ id: 'T-L-01', family: 'L', annex: true, memberHistory: { priorTests: ['synthetic'] } }),
  ]));
  assert.equal(loaded.version, RIGHT_CARE_CHECK_GOLD_2_VERSION);
  assert.equal(loaded.cases.length, 4);
});

test('loadCheckGold2 rejects drift: version, status, dup ids, missing verdict fields, annex misuse', () => {
  assert.throws(() => loadCheckGold2({ ...g2([g2Case()]), version: RIGHT_CARE_CHECK_GOLD_VERSION }));
  assert.throws(() => loadCheckGold2({ ...g2([g2Case()]), status: 'draft' }));
  assert.throws(() => loadCheckGold2(g2([g2Case(), g2Case()])), /duplicate/);
  assert.throws(() => loadCheckGold2(g2([g2Case({ expected: undefined })])));
  assert.throws(() => loadCheckGold2(g2([g2Case({ clinicalTarget: undefined })])));
  assert.throws(() => loadCheckGold2(g2([g2Case({ family: undefined })])));
  // annex/memberHistory are L-only; an L case must be marked annex:true
  assert.throws(() => loadCheckGold2(g2([g2Case({ annex: true })])), /annex/);
  assert.throws(() => loadCheckGold2(g2([g2Case({ memberHistory: {} })])), /annex/);
  assert.throws(() => loadCheckGold2(g2([g2Case({ id: 'T-L-02', family: 'L' })])), /annex:true/);
});

test('splitCheckGold2: P/N/C form the scored floor, L is the annex — never folded together', () => {
  const loaded = loadCheckGold2(g2([
    g2Case(),
    g2Case({ id: 'T-N-01', family: 'N', polarity: 'near_miss' }),
    g2Case({ id: 'T-C-01', family: 'C' }),
    g2Case({ id: 'T-L-01', family: 'L', annex: true }),
  ]));
  const { floor, annex } = splitCheckGold2(loaded.cases);
  assert.deepEqual(floor.map((c) => c.id), ['T-P-01', 'T-N-01', 'T-C-01']);
  assert.deepEqual(annex.map((c) => c.id), ['T-L-01']);
});

test('checkGold2CatalogGaps: unbound polarity-side targets are flagged, bound ones are not', () => {
  const loaded = loadCheckGold2(g2([
    g2Case(),                                                                           // positive, mustFire empty → gap
    g2Case({ id: 'T-P-02', gold: { mustFire: ['x-1'], mustNotFire: [] }, sourceRec: 'x-1' }),  // bound → no gap
    g2Case({ id: 'T-N-01', family: 'N', polarity: 'near_miss' }),                       // near-miss, mustNotFire empty → gap
    g2Case({ id: 'T-N-02', family: 'N', polarity: 'near_miss', gold: { mustFire: [], mustNotFire: ['x-2'] } }),
  ]));
  const gaps = checkGold2CatalogGaps(loaded.cases);
  assert.deepEqual(gaps.map((x) => x.id), ['T-P-01', 'T-N-01']);
  assert.deepEqual(gaps.map((x) => x.polarity), ['positive', 'near_miss']);
});

test('scoreCheckAgainstGold: per-target-rec, deterministic, ignores non-target firings', () => {
  // fired=[X] vs mustFire=[X] → hit
  assert.deepEqual(scoreCheckAgainstGold(['X'], { mustFire: ['X'], mustNotFire: [] }),
    { recallHits: ['X'], recallMisses: [], falsePositives: [] });
  // fired=[X] vs mustNotFire=[X] → one false-positive
  assert.deepEqual(scoreCheckAgainstGold(['X'], { mustFire: [], mustNotFire: ['X'] }),
    { recallHits: [], recallMisses: [], falsePositives: ['X'] });
  // fired=[] vs mustFire=[X] → one recall miss
  assert.deepEqual(scoreCheckAgainstGold([], { mustFire: ['X'], mustNotFire: [] }),
    { recallHits: [], recallMisses: ['X'], falsePositives: [] });
  // NON-TARGET firings are neither hits nor FPs (per-target-rec, not exact-set-match)
  assert.deepEqual(scoreCheckAgainstGold(['other-1', 'other-2', 'X'], { mustFire: ['X'], mustNotFire: [] }),
    { recallHits: ['X'], recallMisses: [], falsePositives: [] });
  assert.deepEqual(scoreCheckAgainstGold(['other-1'], { mustFire: [], mustNotFire: ['X'] }),
    { recallHits: [], recallMisses: [], falsePositives: [] });
  // determinism: same inputs → identical output
  const a = scoreCheckAgainstGold(['X', 'Y'], { mustFire: ['X'], mustNotFire: ['Y'] });
  const b = scoreCheckAgainstGold(['X', 'Y'], { mustFire: ['X'], mustNotFire: ['Y'] });
  assert.deepEqual(a, b);
});

test('aggregateCheckGold: hand-computed recall / specificity / precision / F1', () => {
  // 3 positives (2 hit, 1 miss) + 2 near-misses (1 clean, 1 violated)
  const rows = [
    { score: scoreCheckAgainstGold(['A'], { mustFire: ['A'], mustNotFire: [] }), mustNotFireTargets: 0 },
    { score: scoreCheckAgainstGold(['B'], { mustFire: ['B'], mustNotFire: [] }), mustNotFireTargets: 0 },
    { score: scoreCheckAgainstGold([], { mustFire: ['C'], mustNotFire: [] }), mustNotFireTargets: 0 },
    { score: scoreCheckAgainstGold([], { mustFire: [], mustNotFire: ['D'] }), mustNotFireTargets: 1 },
    { score: scoreCheckAgainstGold(['E'], { mustFire: [], mustNotFire: ['E'] }), mustNotFireTargets: 1 },
  ];
  const m = aggregateCheckGold(rows);
  assert.equal(m.nCases, 5);
  assert.equal(m.nMustFire, 3);
  assert.equal(m.nMustNotFire, 2);
  assert.equal(m.hits, 2);
  assert.equal(m.misses, 1);
  assert.equal(m.falsePositives, 1);
  assert.equal(m.recall, 2 / 3);
  assert.equal(m.specificity, 1 - 1 / 2);
  assert.equal(m.precision, 2 / 3);                                   // 2 / (2 + 1)
  assert.equal(m.f1, (2 * (2 / 3) * (2 / 3)) / ((2 / 3) + (2 / 3)));  // = 2/3
  // nothing fired on-target anywhere → precision/F1 null, recall 0
  const empty = aggregateCheckGold([
    { score: scoreCheckAgainstGold([], { mustFire: ['A'], mustNotFire: [] }), mustNotFireTargets: 0 },
  ]);
  assert.equal(empty.precision, null);
  assert.equal(empty.f1, null);
  assert.equal(empty.recall, 0);
});

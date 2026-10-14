import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  groupAdhocForReview, suggestSetName, PROMOTION_THRESHOLD, type AdhocSetRecord,
} from '../proms/adhoc-review-core';
import { validateAdhocSelection } from '../proms/adhoc-core';
import { compileItemBank } from '../proms/item-bank-core';

// ── fixtures ──────────────────────────────────────────────────────────────────────────────────────
const rec = (over: Partial<AdhocSetRecord>): AdhocSetRecord => ({
  id: over.id ?? 'x', procedureContext: 'procedureContext' in over ? (over.procedureContext ?? null) : 'Parotidectomy',
  itemIds: over.itemIds ?? ['w1', 'w3'], generatedItemIds: over.generatedItemIds, cmRef: over.cmRef, status: over.status ?? 'frozen',
});
/** N frozen sets for a procedure with a given selection + distinct CMs. */
const setsFor = (procedure: string, sel: string[], n: number, cmPrefix = 'cm'): AdhocSetRecord[] =>
  Array.from({ length: n }, (_, i) => rec({ id: `${procedure}-${i}`, procedureContext: procedure, itemIds: sel, cmRef: `${cmPrefix}${i}` }));

// ── constants ──
test('promotion threshold is 5', () => { assert.equal(PROMOTION_THRESHOLD, 5); });

// ── candidate vs collecting ──
test('a selection recurring ≥ threshold → promotion candidate', () => {
  const out = groupAdhocForReview(setsFor('Parotidectomy', ['w1', 'w3', 'p2'], 5));
  assert.equal(out.length, 1);
  assert.equal(out[0].status, 'candidate');
  assert.equal(out[0].recurrenceCount, 5);
  assert.equal(out[0].distinctCms, 5);
  assert.deepEqual(out[0].dominantSelection, ['p2', 'w1', 'w3']);   // canonicalized (sorted)
});

test('below threshold → collecting', () => {
  const out = groupAdhocForReview(setsFor('Splenectomy', ['g1', 'g2'], 2));
  assert.equal(out[0].status, 'collecting');
  assert.equal(out[0].recurrenceCount, 2);
});

test('threshold override is honoured', () => {
  const out = groupAdhocForReview(setsFor('Splenectomy', ['g1'], 2), 2);
  assert.equal(out[0].status, 'candidate');
});

// ── dominant selection + counts ──
test('dominant selection wins over a minority variant; edited count tracks divergence from generated', () => {
  const records = [
    ...setsFor('Parotidectomy', ['w1', 'w3'], 5),                                   // 5 dominant
    rec({ id: 'variant', procedureContext: 'Parotidectomy', itemIds: ['w1'], cmRef: 'cm9', generatedItemIds: ['w1', 'w3'] }), // 1 edited variant
  ];
  const out = groupAdhocForReview(records);
  assert.equal(out[0].totalSets, 6);
  assert.equal(out[0].recurrenceCount, 5);            // the dominant selection, not the total
  assert.deepEqual(out[0].dominantSelection, ['w1', 'w3']);
  assert.equal(out[0].editedCount, 1);                // the one whose itemIds != generatedItemIds
  assert.equal(out[0].distinctCms, 6);
});

test('selection order and duplicates do not split a recurring set', () => {
  const records = [
    rec({ id: 'a', itemIds: ['w1', 'w3'], cmRef: 'c1' }),
    rec({ id: 'b', itemIds: ['w3', 'w1'], cmRef: 'c2' }),        // reordered
    rec({ id: 'c', itemIds: ['w1', 'w1', 'w3'], cmRef: 'c3' }),  // duplicated
    rec({ id: 'd', itemIds: ['w3', 'w1'], cmRef: 'c4' }),
    rec({ id: 'e', itemIds: ['w1', 'w3'], cmRef: 'c5' }),
  ];
  const out = groupAdhocForReview(records);
  assert.equal(out[0].recurrenceCount, 5);   // all five collapse to one canonical selection
  assert.equal(out[0].status, 'candidate');
});

// ── grouping hygiene ──
test('records with no procedure context are skipped', () => {
  const out = groupAdhocForReview([rec({ procedureContext: null }), rec({ procedureContext: '   ' })]);
  assert.deepEqual(out, []);
});

test('procedure grouping is case/whitespace-insensitive', () => {
  const out = groupAdhocForReview([
    rec({ id: '1', procedureContext: 'Parotidectomy', cmRef: 'a' }),
    rec({ id: '2', procedureContext: '  parotidectomy ', cmRef: 'b' }),
  ]);
  assert.equal(out.length, 1);
  assert.equal(out[0].totalSets, 2);
});

// ── ordering + determinism ──
test('candidates sort before collecting; ties by recurrence desc', () => {
  const out = groupAdhocForReview([
    ...setsFor('LowRecur', ['a'], 2),
    ...setsFor('BigCandidate', ['b'], 7),
    ...setsFor('SmallCandidate', ['c'], 5),
  ]);
  assert.deepEqual(out.map((c) => c.procedureLabel), ['BigCandidate', 'SmallCandidate', 'LowRecur']);
});

test('grouping is deterministic (twice → deep-equal)', () => {
  const records = [...setsFor('P', ['w1', 'w3'], 5), ...setsFor('Q', ['g1'], 3)];
  assert.deepEqual(groupAdhocForReview(records), groupAdhocForReview(records));
});

test('empty input → empty queue', () => { assert.deepEqual(groupAdhocForReview([]), []); });

// ── suggested set name ──
test('suggestSetName maps a procedure to hs-<word>', () => {
  assert.equal(suggestSetName('Parotidectomy'), 'hs-parotidectom');       // 13 chars → sliced to 12
  assert.equal(suggestSetName('Laparoscopic splenectomy'), 'hs-laparoscopic');  // first word, 12 chars
  assert.equal(suggestSetName(''), 'hs-set');
});

// ── the promotion selection is always bank-valid (round-trips through the safety gate) ──
test('a dominant selection of real bank ids survives validateAdhocSelection', () => {
  const bank = compileItemBank();
  const realIds = bank.slice(0, 4).map((b) => b.id);
  const out = groupAdhocForReview(setsFor('SomeProc', realIds, 5));
  const revalidated = validateAdhocSelection(out[0].dominantSelection, bank);
  assert.equal(revalidated.items.length, realIds.length);
});

/**
 *   node --experimental-strip-types --test lib/__tests__/ccb-worklist-core.test.ts
 *
 * The /care/briefs flagged-list core: the parameterized query text (moved, not improved), the
 * signal precedence it encodes, and the bounded race that stops a slow Metabase from stalling
 * the page's TTFB.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { flaggedListSql, pickSignal, boundedRace, type Flagged } from '../ccb-worklist-core.ts';

// ── T1 · flaggedListSql: the normative fragments ────────────────────────────────
test('flaggedListSql keeps every normative fragment of the page query', () => {
  const s = flaggedListSql();
  assert.ok(s.includes('DISTINCT ON (individual_uid)'), 'one row per member');
  assert.ok(s.includes('pitch_allowed = true'), 'commercial wall respected');
  assert.ok(s.includes('individual_uid IS NOT NULL'));
  assert.ok(s.includes('LIMIT 30'));
  assert.ok(s.includes("to_char(note_date AT TIME ZONE 'Asia/Kolkata','YYYY-MM-DD')"), 'IST day');
  assert.ok(s.includes('FROM ccb_briefs'));
});

test('flaggedListSql preserves both ORDER BY clauses exactly', () => {
  const s = flaggedListSql();
  // inner: pick the best-grounded episode per member
  assert.ok(s.includes('ORDER BY individual_uid, citation_coverage_pct DESC NULLS LAST, created_at DESC'));
  // outer: rank members for the care manager
  assert.ok(s.includes('ORDER BY citation_coverage_pct DESC NULLS LAST, note_date_ist DESC'));
});

test('flaggedListSql mirrors the jsonb_typeof guards on both coalesce branches', () => {
  const s = flaggedListSql();
  assert.equal((s.match(/jsonb_typeof\(envelope->'clinical'\)='array'/g) || []).length, 2);
  assert.ok(s.includes("jsonb_typeof(envelope->'commercial'->'gated_on')='array'"));
  assert.ok(s.includes("f->>'kind' IN ('surgical_indication','speciality')"));
});

test('flaggedListSql takes the engine version as $1 and never interpolates it', () => {
  const s = flaggedListSql();
  assert.ok(s.includes('engine_version = $1'));
  assert.ok(!s.includes('care-brief/0.1'), 'engine version must not be baked into the text');
  assert.ok(!/\$\{/.test(s), 'no template interpolation anywhere in the query');
});

test('flaggedListSql is a constant — no argument can change the text', () => {
  assert.equal(flaggedListSql(), flaggedListSql());
});

// ── T1 · pickSignal: precedence + malformed-shape guards ────────────────────────
const gated = {
  clinical: [
    { id: 'c1', kind: 'symptom', claim: 'knee pain for 8 months' },
    { id: 'c2', kind: 'surgical_indication', claim: 'TKR indicated' },
  ],
  commercial: { gated_on: ['c1'] },
};

test('pickSignal: a gated_on claim beats the surgical_indication fallback', () => {
  assert.equal(pickSignal(gated), 'knee pain for 8 months');
});

test('pickSignal: falls back to surgical_indication when nothing is gated', () => {
  assert.equal(pickSignal({ ...gated, commercial: { gated_on: [] } }), 'TKR indicated');
});

test('pickSignal: falls back to speciality when no surgical_indication exists', () => {
  const e = { clinical: [{ id: 'c1', kind: 'speciality', claim: 'orthopaedics referral' }], commercial: {} };
  assert.equal(pickSignal(e), 'orthopaedics referral');
});

test('pickSignal: gated_on picks the FIRST matching finding in array order', () => {
  const e = {
    clinical: [
      { id: 'a', kind: 'symptom', claim: 'first' },
      { id: 'b', kind: 'symptom', claim: 'second' },
    ],
    commercial: { gated_on: ['b', 'a'] }, // gated_on order is irrelevant; clinical order wins
  };
  assert.equal(pickSignal(e), 'first');
});

test('pickSignal: a gated hit with a null claim coalesces to branch 2, not to the next gated hit', () => {
  // Mirrors SQL: `(SELECT f->>'claim' ... LIMIT 1)` returns the FIRST gated row's claim (NULL),
  // so coalesce moves to branch 2 rather than trying the second gated row.
  const e = {
    clinical: [
      { id: 'a', kind: 'symptom', claim: null },
      { id: 'b', kind: 'symptom', claim: 'second gated' },
      { id: 'c', kind: 'surgical_indication', claim: 'fallback claim' },
    ],
    commercial: { gated_on: ['a', 'b'] },
  };
  assert.equal(pickSignal(e), 'fallback claim');
});

test('pickSignal: no qualifying finding returns null', () => {
  assert.equal(pickSignal({ clinical: [{ id: 'c1', kind: 'symptom', claim: 'x' }], commercial: {} }), null);
});

test('pickSignal: malformed and non-array envelope shapes degrade to null, never throw', () => {
  for (const bad of [
    null, undefined, 0, '', 'clinical', [], [{ claim: 'x' }],
    {},
    { clinical: null },
    { clinical: 'not-an-array' },
    { clinical: {} },
    { clinical: [] },
    { clinical: [null, 3, 'str'] },
    { clinical: [{ id: 'c1', kind: 'surgical_indication' }] },              // claim absent → null
    { clinical: [{ id: 'c1', kind: 'surgical_indication', claim: {} }] },   // claim is an object → null
    { clinical: [{ kind: 'symptom', claim: 'x' }], commercial: { gated_on: 'nope' } },
    { clinical: [{ kind: 'symptom', claim: 'x' }], commercial: null },
    { clinical: [{ kind: 'symptom', claim: 'x' }], commercial: [] },
  ]) {
    assert.doesNotThrow(() => pickSignal(bad));
    assert.equal(pickSignal(bad), null, `expected null for ${JSON.stringify(bad)}`);
  }
});

test('pickSignal: non-string gated_on entries are ignored, not coerced', () => {
  const e = {
    clinical: [{ id: '1', kind: 'surgical_indication', claim: 'the claim' }],
    commercial: { gated_on: [1, null, {}] },
  };
  assert.equal(pickSignal(e), 'the claim'); // falls through to branch 2
});

// ── T2 · boundedRace ────────────────────────────────────────────────────────────
test('boundedRace returns the fallback when the inner promise never resolves', async () => {
  const never = new Promise<string>(() => {});
  const t0 = Date.now();
  assert.equal(await boundedRace(never, 30, 'fallback'), 'fallback');
  assert.ok(Date.now() - t0 >= 25, 'waited for the timeout');
});

test('boundedRace passes a fast result straight through', async () => {
  assert.equal(await boundedRace(Promise.resolve('fast'), 1000, 'fallback'), 'fast');
});

test('boundedRace resolves the fallback when the inner promise rejects — never rejects', async () => {
  await assert.doesNotReject(async () => {
    assert.equal(await boundedRace(Promise.reject(new Error('metabase down')), 1000, 'fallback'), 'fallback');
  });
});

test('boundedRace resolves the fallback on a synchronous throw inside the promise', async () => {
  const p = (async () => { throw new Error('boom'); })();
  assert.equal(await boundedRace(p, 1000, 'fallback'), 'fallback');
});

test('boundedRace does not hold the event loop open after a fast win', async () => {
  // A 60s timer left pending would stall `node --test` exit for a minute.
  const t0 = Date.now();
  await boundedRace(Promise.resolve(1), 60_000, 0);
  assert.ok(Date.now() - t0 < 500);
});

test('boundedRace preserves falsy results rather than substituting the fallback', async () => {
  assert.equal(await boundedRace(Promise.resolve(0), 1000, 99), 0);
  assert.equal(await boundedRace(Promise.resolve(''), 1000, 'fb'), '');
});

// ── T2 · the page-level guarantee this exists to encode ─────────────────────────
test('identity failure ⇒ the page still renders, with {} identities (uhid-only labels)', async () => {
  type Identities = Record<string, { name: string }>;
  const rows: Pick<Flagged, 'individual_uid' | 'uhid'>[] = [
    { individual_uid: 'abc', uhid: 'UH-1' },
  ];

  for (const failure of [
    Promise.reject(new Error('metabase 500')) as Promise<Identities>,
    new Promise<Identities>(() => {}), // hang — the symptom V reported
  ]) {
    const identities = await boundedRace<Identities>(failure, 30, {});
    assert.deepEqual(identities, {});
    // The page's label expression degrades to the uhid, and never throws on a missing identity.
    const label = identities[rows[0].individual_uid]?.name || 'Member';
    assert.equal(label, 'Member');
    assert.equal(rows[0].uhid, 'UH-1');
  }
});

test('a healthy identity lookup still labels the row', async () => {
  const identities = await boundedRace(Promise.resolve({ abc: { name: 'A. Member' } }), 1000, {} as Record<string, { name: string }>);
  assert.equal(identities['abc']?.name, 'A. Member');
});

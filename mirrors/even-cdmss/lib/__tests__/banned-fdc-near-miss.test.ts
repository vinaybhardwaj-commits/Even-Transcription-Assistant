// Unit B — banned-FDC near-miss counter (DETERMINISM-TRIO PRD v1.0 §3, D-3, engine 0.81.21).
//
// A near-miss is a product one molecule OVER a prohibited combination (S ⊋ E) or one molecule SHORT
// of it (S ⊊ E, |E| − |S| = 1). It is a MEASUREMENT of whether exact-set matching is too strict:
// informational, confidence 0, never scoring, ratified tier 3. The exact match is the real finding
// and is never also counted here.
//
// Fixtures use PLACEHOLDER molecule names (mol-a/mol-b/…) — the standing rule inherited from
// cdsco-banned-fdc-core.test.ts: no real banned-drug data may originate from a builder, in tests
// or anywhere else.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  bannedFdcNearMisses, bannedFdcFindings, BANNED_FDC_NEAR_MISS_CAP, type BannedFdcTable,
} from '../cdsco-banned-fdc-core';
import { stampFindingIdentity, OPD_SIGNAL_TYPES, opdSignalType } from '../opd-note-audit-core';
import { tierFor } from '../severity-tier-core';
import type { OpdMed } from '../opd-ingest-core';

const med = (over: Partial<OpdMed> = {}): OpdMed => ({ brand: 'BrandX', ...over } as OpdMed);
const TABLE: BannedFdcTable = {
  version: 'cdsco-banned-fdc/near-miss-test',
  entries: [
    { id: 'test-entry-1', molecules: ['mol-a', 'mol-b'], notification_date: '2026-06-11', gazette_ref: 'S.O. TEST(E)' },
    { id: 'test-entry-2', molecules: ['mol-c', 'mol-d', 'mol-e'], notification_date: '2026-06-11', gazette_ref: 'S.O. TEST2(E)' },
  ],
};
/** Five entries, each a distinct 3-molecule combination, to exercise the cap. */
const WIDE_TABLE: BannedFdcTable = {
  version: 'cdsco-banned-fdc/near-miss-cap-test',
  entries: ['p', 'q', 'r', 's', 't'].map((k, i) => ({
    id: `wide-${k}`, molecules: ['mol-a', 'mol-b', `mol-${k}`],
    notification_date: '2026-06-11', gazette_ref: `S.O. WIDE${i}(E)`,
  })),
};

test('superset fires: the banned pair plus one extra molecule', () => {
  const out = bannedFdcNearMisses([med({ resolvedGeneric: 'Mol-A + Mol-B + Mol-Z' })], TABLE);
  assert.equal(out.length, 1);
  const f = out[0];
  // the subject carries the ENTRY composition, never the product — stable across re-audits
  assert.equal(f.subject, 'Near-match to a banned combination: mol-a + mol-b');
  assert.match(f.rationale, /shares mol-a, mol-b/);
  assert.match(f.rationale, /extra: mol-z/);
  assert.match(f.rationale, /S\.O\. TEST\(E\), 2026-06-11/);
  assert.match(f.rationale, /This is not the prohibited combination\. Informational only — it does not affect any score\. Logged to measure whether exact-match checking is too strict\.$/);
});

test('subset-missing-one fires: two of a banned three', () => {
  const out = bannedFdcNearMisses([med({ resolvedGeneric: 'mol-c + mol-d' })], TABLE);
  assert.equal(out.length, 1);
  assert.equal(out[0].subject, 'Near-match to a banned combination: mol-c + mol-d + mol-e');
  assert.match(out[0].rationale, /missing: mol-e/);
});

test('an exact match does NOT also near-miss — and neither does the entry it matched', () => {
  // the exact-match product itself
  assert.deepEqual(bannedFdcNearMisses([med({ resolvedGeneric: 'mol-a + mol-b' })], TABLE), []);
  assert.equal(bannedFdcFindings([med({ resolvedGeneric: 'mol-a + mol-b' })], TABLE).length, 1);
  // the banned product AND a superset of it on the same note: the ban is reported once (by the
  // exact-match check) and the same entry is not ALSO reported as a near-match.
  const both = [med({ resolvedGeneric: 'mol-a + mol-b' }), med({ brand: 'BrandY', resolvedGeneric: 'mol-a + mol-b + mol-z' })];
  assert.deepEqual(bannedFdcNearMisses(both, TABLE), []);
  assert.equal(bannedFdcFindings(both, TABLE).length, 1);
});

test('missing TWO molecules is silent (|E| − |S| = 1 only)', () => {
  // a 4-molecule entry, product carries 2 of them
  const t: BannedFdcTable = { version: 't', entries: [
    { id: 'e4', molecules: ['mol-a', 'mol-b', 'mol-c', 'mol-d'], notification_date: '2026-06-11', gazette_ref: 'S.O. T4(E)' }] };
  assert.deepEqual(bannedFdcNearMisses([med({ resolvedGeneric: 'mol-a + mol-b' })], t), []);
  // …and 3 of the 4 DOES fire, so the silence above is the rule and not an accident
  assert.equal(bannedFdcNearMisses([med({ resolvedGeneric: 'mol-a + mol-b + mol-c' })], t).length, 1);
});

test('a single-molecule product is silent — |S| ≥ 2, inherited from the exact-match check', () => {
  // mol-a alone is one molecule short of {mol-a, mol-b}; admitting it would near-miss every
  // two-molecule entry containing that molecule, which is exactly the noise this bound prevents.
  assert.deepEqual(bannedFdcNearMisses([med({ resolvedGeneric: 'mol-a' })], TABLE), []);
  assert.deepEqual(bannedFdcNearMisses([med({ resolvedGeneric: 'mol-c' })], TABLE), []);
});

test('overlap without containment is silent (neither superset nor subset)', () => {
  // {mol-a, mol-z}: shares mol-a with entry 1 but is not a subset of it (mol-z is not in the entry)
  assert.deepEqual(bannedFdcNearMisses([med({ resolvedGeneric: 'mol-a + mol-z' })], TABLE), []);
  // {mol-c, mol-d, mol-z}: same size as entry 2 but not equal to it
  assert.deepEqual(bannedFdcNearMisses([med({ resolvedGeneric: 'mol-c + mol-d + mol-z' })], TABLE), []);
});

test('cap: at most 3 near-miss findings per note, in ENTRY order', () => {
  assert.equal(BANNED_FDC_NEAR_MISS_CAP, 3);
  // {mol-a, mol-b} is one molecule short of all FIVE wide entries
  const out = bannedFdcNearMisses([med({ resolvedGeneric: 'mol-a + mol-b' })], WIDE_TABLE);
  assert.equal(out.length, 3);
  assert.deepEqual(out.map((f) => f.subject), [
    'Near-match to a banned combination: mol-a + mol-b + mol-p',
    'Near-match to a banned combination: mol-a + mol-b + mol-q',
    'Near-match to a banned combination: mol-a + mol-b + mol-r',
  ]);
  // the cap follows the RULEBOOK, so reordering the medications cannot change which three surface
  const meds = [med({ resolvedGeneric: 'mol-a + mol-b' }), med({ brand: 'BrandY', resolvedGeneric: 'mol-a + mol-b + mol-t + mol-z' })];
  assert.deepEqual(
    bannedFdcNearMisses(meds, WIDE_TABLE).map((f) => f.subject),
    bannedFdcNearMisses([...meds].reverse(), WIDE_TABLE).map((f) => f.subject),
  );
});

test('one finding per ENTRY even when several products near-miss it', () => {
  const out = bannedFdcNearMisses([
    med({ resolvedGeneric: 'mol-a + mol-b + mol-y' }),
    med({ brand: 'BrandY', resolvedGeneric: 'mol-a + mol-b + mol-z' }),
  ], TABLE);
  assert.equal(out.length, 1);
});

test('malformed / empty tables and meds are silent — never throw (§7 posture, inherited)', () => {
  const bad = [
    undefined, null, {}, { entries: null }, { entries: [] },
    { entries: [{ id: '', molecules: ['mol-a', 'mol-b'] }] },       // no id
    { entries: [{ id: 'x', molecules: ['mol-a'] }] },               // single-molecule "combination"
    { entries: [{ id: 'x', molecules: null }] },
    { entries: [{ id: 'x' }] },
  ];
  for (const t of bad) {
    assert.deepEqual(bannedFdcNearMisses([med({ resolvedGeneric: 'mol-a + mol-b + mol-z' })], t as unknown as BannedFdcTable), [], JSON.stringify(t));
  }
  assert.deepEqual(bannedFdcNearMisses([], TABLE), []);
  assert.deepEqual(bannedFdcNearMisses(null as unknown as OpdMed[], TABLE), []);
  // an unresolvable brand has no molecule set → no finding (the accepted miss)
  assert.deepEqual(bannedFdcNearMisses([med()], TABLE), []);
});

test('the finding is non-scoring by construction: informational + confidence 0 + uncertain', () => {
  const f = bannedFdcNearMisses([med({ resolvedGeneric: 'mol-a + mol-b + mol-z' })], TABLE)[0];
  assert.equal(f.informational, true);
  assert.equal(f.confidence, 0);
  assert.equal(f.verdict, 'uncertain');
  assert.equal(f.domain, 'prescribing_safety');
  assert.equal(f.source, 'deterministic');
  assert.deepEqual([f.evidence, f.estimates, f.citation_ids], [[], [], []]);
});

test('signal_type resolves to banned_fdc_near_miss (and does not collide with banned_fdc)', () => {
  const near = stampFindingIdentity(bannedFdcNearMisses([med({ resolvedGeneric: 'mol-a + mol-b + mol-z' })], TABLE));
  const exact = stampFindingIdentity(bannedFdcFindings([med({ resolvedGeneric: 'mol-a + mol-b' })], TABLE));
  assert.equal(near[0].signal_type, 'banned_fdc_near_miss');
  assert.equal(exact[0].signal_type, 'banned_fdc');
  assert.equal(OPD_SIGNAL_TYPES.banned_fdc_near_miss, 'Near-match to a banned combination');
  // the pure derivation agrees (legacy rows re-derive the same type)
  assert.equal(opdSignalType(near[0].subject, 'prescribing_safety', { verdict: 'uncertain' }), 'banned_fdc_near_miss');
  // finding_ref keys on the ENTRY composition, so it survives a different product triggering it
  const other = stampFindingIdentity(bannedFdcNearMisses([med({ brand: 'BrandZ', resolvedGeneric: 'mol-a + mol-b + mol-q' })], TABLE));
  assert.equal(near[0].finding_ref, other[0].finding_ref);
});

test('tier resolves to 3 — log only, never an action row (D-3)', () => {
  const f = stampFindingIdentity(bannedFdcNearMisses([med({ resolvedGeneric: 'mol-a + mol-b + mol-z' })], TABLE))[0];
  const t = tierFor(f);
  assert.equal(t.tier, 3);
  assert.equal(t.unlistedKind, false);
  assert.match(t.reason, /ratified tier 3/);
});

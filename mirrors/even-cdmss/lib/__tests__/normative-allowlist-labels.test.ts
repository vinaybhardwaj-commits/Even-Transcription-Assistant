// lib/__tests__/normative-allowlist-labels.test.ts — R-11 normative-leg allowlist + source labels
// for the Even/ICMR guidelines. The two sources ship INERT (still quarantined labq:), so adding
// their activated lab: keys must be a no-op until corpus_manage activate. Pure — no DB.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_NORMATIVE_SOURCES, resolveNormativeSources, buildFilterClauses, renderFilterSql,
} from '../retrieve.ts';
import { sourceLabel, sourceUrl, SOURCE_DISPLAY_LABELS, type Source } from '../citations-core.ts';

const EVEN_LAB = 'lab:guidelines-even-protocols';
const ICMR_LAB = 'lab:guidelines-icmr-amr-2019';

// ── allowlist: choosing-wisely kept, two lab: keys ADDED in order ──
test('DEFAULT_NORMATIVE_SOURCES = choosing-wisely + the two activated guideline keys, in order', () => {
  assert.deepEqual(DEFAULT_NORMATIVE_SOURCES, ['choosing-wisely', EVEN_LAB, ICMR_LAB]);
  assert.deepEqual(resolveNormativeSources(undefined, undefined), ['choosing-wisely', EVEN_LAB, ICMR_LAB]);
  assert.equal(DEFAULT_NORMATIVE_SOURCES[0], 'choosing-wisely', 'choosing-wisely stays exactly as-is');
});

// ── INERTNESS proof: the added keys are the ACTIVATED (lab:) form, so while the sources are still
//    quarantined (labq:) they match ZERO rows — retrieval is byte-identical to the old allowlist ──
test('the added keys target ACTIVATED sources (lab:), never quarantined (labq:) — inert until activation', () => {
  for (const k of [EVEN_LAB, ICMR_LAB]) {
    assert.ok(k.startsWith('lab:'), `${k} must be the activated form`);
    assert.ok(!k.startsWith('labq:'), `${k} must NOT name quarantined content`);
  }
  // the normative leg builds `source = ANY($n)`; with the new allowlist the clause SHAPE is unchanged
  // and the bound array simply gains two keys that match no current (labq:) row — same selected set.
  const oldF = buildFilterClauses({ restrictSources: ['choosing-wisely'] });
  const newF = buildFilterClauses({ restrictSources: DEFAULT_NORMATIVE_SOURCES });
  assert.deepEqual(oldF.clauses, newF.clauses, 'same clause shape (source = ANY($FP_0))');
  assert.equal(renderFilterSql(newF.clauses, 3), 'text IS NOT NULL AND (visible IS NOT FALSE OR source = ANY($3)) AND source = ANY($3)');
  assert.deepEqual(newF.params, [['choosing-wisely', EVEN_LAB, ICMR_LAB]], 'bound array carries the activated keys');
  // no key in the allowlist is a labq: source, so ANY(...) cannot select quarantined guideline rows
  assert.ok(DEFAULT_NORMATIVE_SOURCES.every((s) => !s.startsWith('labq:')));
});

// ── labels: activated lab: keys → crisp names; everything else UNCHANGED (book-driven) ──
const mkSource = (over: Partial<Source>): Source => ({
  n: 1, id: 1, source: '', book: 'Fallback Book', chapter: null, page_start: null, page_end: null,
  item_number: null, similarity: null, url: null, preview: '', ...over,
});

test('sourceLabel renders "Even Guidelines" / "ICMR Guidelines" for the activated sources', () => {
  assert.equal(SOURCE_DISPLAY_LABELS[EVEN_LAB], 'Even Guidelines');
  assert.equal(SOURCE_DISPLAY_LABELS[ICMR_LAB], 'ICMR Guidelines');
  const even = sourceLabel(mkSource({ source: EVEN_LAB, book: 'Even Clinical Protocols — Even Guidelines 2026', item_number: 'even-protocol#diabetes-mellitus' }));
  assert.ok(even.startsWith('Even Guidelines'), even);
  assert.ok(!even.includes('Even Clinical Protocols'), 'the crisp label replaces the long book name');
  const icmr = sourceLabel(mkSource({ source: ICMR_LAB, book: 'ICMR Treatment Guidelines for Antimicrobial Use 2019 — Guidelines', item_number: 'icmr-amr-2019#p45' }));
  assert.ok(icmr.startsWith('ICMR Guidelines'), icmr);
});

test('labels are INERT while quarantined: a labq: chunk falls back to book (unchanged today)', () => {
  // no chunk carries the lab: key until activation; today they are labq: → not in the map → book
  const q = sourceLabel(mkSource({ source: 'labq:guidelines-even-protocols', book: 'Even Clinical Protocols — Even Guidelines 2026' }));
  assert.ok(q.startsWith('Even Clinical Protocols'), 'quarantined chunk still labelled by book — no premature rename');
});

test('choosing-wisely and every other source are byte-identical (book-driven, no override)', () => {
  assert.ok(!('choosing-wisely' in SOURCE_DISPLAY_LABELS), 'choosing-wisely is left untouched');
  const cw = sourceLabel(mkSource({ source: 'choosing-wisely', book: 'CW-AAFP', chapter: 'low back pain' }));
  assert.equal(cw, 'CW-AAFP · low back pain', 'CW label is exactly today\'s book-driven output');
  // unknown source ⇒ book (fail-safe, no throw)
  assert.equal(sourceLabel(mkSource({ source: 'statpearls', book: 'StatPearls' })), 'StatPearls');
  // missing source ⇒ book (fail-safe)
  assert.equal(sourceLabel(mkSource({ source: '' as unknown as string, book: 'Some Book' })), 'Some Book');
});

// ── no fake identifiers: the internal anchors never mint a URL ──
test('the guideline anchors resolve to NO url (category/internal authority, not deterministic)', () => {
  assert.equal(sourceUrl(EVEN_LAB, 'even-protocol#diabetes-mellitus'), null);
  assert.equal(sourceUrl(ICMR_LAB, 'icmr-amr-2019#p45'), null);
});

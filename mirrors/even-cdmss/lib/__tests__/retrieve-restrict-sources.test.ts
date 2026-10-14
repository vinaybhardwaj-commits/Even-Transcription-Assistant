// lib/__tests__/retrieve-restrict-sources.test.ts — lab-only multi-source restrict (normative-source
// leg measurement enabler). Pure — no DB. Test 1 is the production regression guard.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildFilterClauses, renderFilterSql } from '../retrieve.ts';

const BASE_CLAUSES = ['text IS NOT NULL', 'visible IS NOT FALSE', "source NOT LIKE 'labq:%'"];

// ── Test 1 — omitted ⇒ filter clauses byte-identical to today (regression guard) ──
test('restrictSources omitted ⇒ default clauses + no params (byte-identical)', () => {
  const { clauses, params } = buildFilterClauses({});
  assert.deepEqual(clauses, BASE_CLAUSES);
  assert.deepEqual(params, []);
  const expected = "text IS NOT NULL AND visible IS NOT FALSE AND source NOT LIKE 'labq:%'";
  assert.equal(renderFilterSql(clauses, 3), expected);
  assert.equal(renderFilterSql(clauses, 2), expected);
});

// ── Test 2 — both legs filter source = ANY($n), bound param, not interpolated ──
test('restrictSources: [choosing-wisely] ⇒ both legs source = ANY, bound array param', () => {
  const { clauses, params } = buildFilterClauses({ restrictSources: ['choosing-wisely'] });
  assert.deepEqual(clauses, [
    'text IS NOT NULL',
    '(visible IS NOT FALSE OR source = ANY($FP_0))',
    'source = ANY($FP_0)',
  ]);
  // the sources are a BOUND array param (one array at slot 0), never interpolated into the SQL
  assert.deepEqual(params, [['choosing-wisely']]);
  for (const c of clauses) assert.ok(!c.includes('choosing-wisely'), `source interpolated into clause: ${c}`);
  // vector leg $FP_0 → $3 ; BM25 leg $FP_0 → $2 (one array param, reused across both relaxed clauses)
  assert.equal(
    renderFilterSql(clauses, 3),
    'text IS NOT NULL AND (visible IS NOT FALSE OR source = ANY($3)) AND source = ANY($3)',
  );
  assert.equal(
    renderFilterSql(clauses, 2),
    'text IS NOT NULL AND (visible IS NOT FALSE OR source = ANY($2)) AND source = ANY($2)',
  );
});

// ── Test 3 — a NAMED labq: source is admitted (visible relaxed); an UN-named labq: is excluded ──
test('a named labq: source is admitted through the quarantine guard; un-named stays excluded', () => {
  const { clauses, params } = buildFilterClauses({ restrictSources: ['choosing-wisely', 'labq:guidelines-lvc-22jul'] });
  // the named labq: source is in the bound array — source = ANY(...) includes it, and the visible
  // guard is relaxed by `OR source = ANY(...)`, so a visible=false quarantined chunk is admitted.
  assert.deepEqual(params, [['choosing-wisely', 'labq:guidelines-lvc-22jul']]);
  assert.equal(clauses[1], '(visible IS NOT FALSE OR source = ANY($FP_0))');
  assert.equal(clauses[2], 'source = ANY($FP_0)');
  // The un-named-labq: exclusion is STRUCTURAL: clauses[2] restricts to EXACTLY the array, and the
  // default `source NOT LIKE 'labq:%'` wildcard guard is gone — so a labq: source NOT listed can
  // never match (it isn't in the array), while no blanket wildcard admits it either.
  assert.ok(!clauses.some((c) => c.includes("NOT LIKE 'labq:%'")), 'the blanket labq wildcard guard must be replaced, not retained');
  assert.equal((params[0] as string[]).includes('labq:some-other-batch'), false);
});

// ── Test 4 — empty / all-blank array ⇒ fail-safe to today's behaviour, never empty-everything ──
test('empty or all-blank restrictSources falls back to the default filter (no restriction)', () => {
  for (const empty of [[], ['', '   '], undefined]) {
    const { clauses, params } = buildFilterClauses({ restrictSources: empty as string[] | undefined });
    assert.deepEqual(clauses, BASE_CLAUSES, `empty restrict should be today's clauses (${JSON.stringify(empty)})`);
    assert.deepEqual(params, []);
  }
  // and it must NOT produce a match-nothing filter like `source = ANY(ARRAY[])`
  const { clauses } = buildFilterClauses({ restrictSources: [] });
  assert.ok(!clauses.some((c) => c.includes('ANY(')), 'empty array must not emit an ANY() clause');
});

// ── restrictSources coexists with structural filters and supersedes the single-source filter ──
test('restrictSources stacks with book/chunk filters and supersedes the single-source filter', () => {
  const { clauses, params } = buildFilterClauses({
    restrictSources: ['choosing-wisely'], source: 'ignored-single', bookFilter: 'MKSAP 19', chunkType: 'explanation',
  });
  assert.deepEqual(clauses, [
    'text IS NOT NULL',
    '(visible IS NOT FALSE OR source = ANY($FP_0))',
    'source = ANY($FP_0)',
    'book = $FP_1',
    'chunk_type = $FP_2',
  ]);
  // the single `source` filter is dropped (would conflict with the ANY-restrict); its value is absent
  assert.deepEqual(params, [['choosing-wisely'], 'MKSAP 19', 'explanation']);
});

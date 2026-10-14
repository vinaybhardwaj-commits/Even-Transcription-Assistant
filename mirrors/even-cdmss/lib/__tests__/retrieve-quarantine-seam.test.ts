// lib/__tests__/retrieve-quarantine-seam.test.ts — the lab-retrieve-seam PRD §7 guards for the
// retrieve() side: default-path SQL invariance (test 1), relaxed-path shape (test 2), label
// sanitisation (test 3), and topK clamp (test 6). Pure — no DB. Tests 1 and 3 are load-bearing.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildFilterClauses, renderFilterSql, clampLabRetrieveTopK } from '../retrieve.ts';
import { labLabel } from '../lab-core.ts';

const BASE_CLAUSES = ['text IS NOT NULL', 'visible IS NOT FALSE', "source NOT LIKE 'labq:%'"];

// ── Test 1 — default-path SQL invariance (the regression guard for every production caller) ──
test('default path: filter clause array is byte-identical to production, no params', () => {
  const { clauses, params } = buildFilterClauses({});
  assert.deepEqual(clauses, BASE_CLAUSES);
  assert.deepEqual(params, []);
  // …and the rendered per-leg SQL is exactly today's (no placeholders to remap on either leg).
  const expected = "text IS NOT NULL AND visible IS NOT FALSE AND source NOT LIKE 'labq:%'";
  assert.equal(renderFilterSql(clauses, 3), expected); // vector leg
  assert.equal(renderFilterSql(clauses, 2), expected); // BM25 leg
});

test('default path with structural filters keeps the base guards and remaps $FP offsets per leg', () => {
  const { clauses, params } = buildFilterClauses({ bookFilter: 'MKSAP 19', chunkType: 'explanation' });
  assert.deepEqual(clauses, [...BASE_CLAUSES, 'book = $FP_0', 'chunk_type = $FP_1']);
  assert.deepEqual(params, ['MKSAP 19', 'explanation']);
  assert.equal(
    renderFilterSql(clauses, 3),
    "text IS NOT NULL AND visible IS NOT FALSE AND source NOT LIKE 'labq:%' AND book = $3 AND chunk_type = $4",
  );
  assert.equal(
    renderFilterSql(clauses, 2),
    "text IS NOT NULL AND visible IS NOT FALSE AND source NOT LIKE 'labq:%' AND book = $2 AND chunk_type = $3",
  );
});

// ── Test 2 — relaxed-path shape: BOTH guards gain the OR arm on BOTH legs, bound not interpolated ──
test('relaxed path: both quarantine guards gain a bound OR arm on both legs', () => {
  const label = 'guidelines-lvc-22jul';
  const { clauses, params } = buildFilterClauses({ includeQuarantined: label });
  assert.deepEqual(clauses, [
    'text IS NOT NULL',
    '(visible IS NOT FALSE OR source = $FP_0)',
    "(source NOT LIKE 'labq:%' OR source = $FP_0)",
  ]);
  // the label is a BOUND parameter (as labq:<slug>), and never appears literally in the clauses.
  assert.deepEqual(params, [`labq:${label}`]);
  for (const c of clauses) assert.ok(!c.includes(label), `label was interpolated into a clause: ${c}`);

  // vector leg: $FP_0 → $3 ; BM25 leg: $FP_0 → $2 (one param, reused in both relaxed clauses).
  assert.equal(
    renderFilterSql(clauses, 3),
    "text IS NOT NULL AND (visible IS NOT FALSE OR source = $3) AND (source NOT LIKE 'labq:%' OR source = $3)",
  );
  assert.equal(
    renderFilterSql(clauses, 2),
    "text IS NOT NULL AND (visible IS NOT FALSE OR source = $2) AND (source NOT LIKE 'labq:%' OR source = $2)",
  );
});

test('relaxed path ordering: the quarantine label takes $FP_0, structural filters follow', () => {
  const { clauses, params } = buildFilterClauses({ includeQuarantined: 'g', bookFilter: 'MKSAP 19' });
  assert.deepEqual(clauses, [
    'text IS NOT NULL',
    '(visible IS NOT FALSE OR source = $FP_0)',
    "(source NOT LIKE 'labq:%' OR source = $FP_0)",
    'book = $FP_1',
  ]);
  assert.deepEqual(params, ['labq:g', 'MKSAP 19']);
});

// ── Test 3 — label sanitisation: a hostile label cannot widen the filter beyond one batch ──
test('hostile labels are slugged by labLabel and cannot widen the filter', () => {
  for (const hostile of ["'; DROP TABLE --", 'labq:%', '%', 'a/b; SELECT']) {
    const { clauses, params } = buildFilterClauses({ includeQuarantined: hostile });
    // exactly one bound param, of the form labq:<safe-slug>, with no wildcard or SQL metacharacters.
    assert.equal(params.length, 1);
    const src = params[0] as string;
    assert.equal(src, `labq:${labLabel(hostile)}`);
    assert.match(src, /^labq:[a-z0-9_-]+$/);
    assert.ok(!src.includes('%'), `wildcard survived: ${src}`);
    // the relaxed clauses still reference ONLY the bound placeholder, never the raw text.
    assert.equal(clauses[1], '(visible IS NOT FALSE OR source = $FP_0)');
    assert.equal(clauses[2], "(source NOT LIKE 'labq:%' OR source = $FP_0)");
  }
  // `labq:%` cannot degrade into the bare wildcard guard: it slugs to a concrete label.
  assert.equal((buildFilterClauses({ includeQuarantined: 'labq:%' }).params[0] as string), 'labq:labq');
  // `%` (which would match everything) collapses to the default slug, not a wildcard.
  assert.equal((buildFilterClauses({ includeQuarantined: '%' }).params[0] as string), 'labq:default');
});

test('empty/whitespace includeQuarantined is treated as omitted (byte-identical default path)', () => {
  for (const empty of ['', '   ', undefined]) {
    const { clauses, params } = buildFilterClauses({ includeQuarantined: empty as string | undefined });
    assert.deepEqual(clauses, BASE_CLAUSES);
    assert.deepEqual(params, []);
  }
});

// ── Test 6 — topK clamp (tool handler helper) ──
test('clampLabRetrieveTopK clamps to [1,20], default 8', () => {
  assert.equal(clampLabRetrieveTopK(undefined), 8);
  assert.equal(clampLabRetrieveTopK(0), 8);
  assert.equal(clampLabRetrieveTopK(-3), 8);
  assert.equal(clampLabRetrieveTopK(1), 1);
  assert.equal(clampLabRetrieveTopK(8), 8);
  assert.equal(clampLabRetrieveTopK(20), 20);
  assert.equal(clampLabRetrieveTopK(21), 20);
  assert.equal(clampLabRetrieveTopK(1000), 20);
  assert.equal(clampLabRetrieveTopK('12'), 12);
  assert.equal(clampLabRetrieveTopK(NaN), 8);
});

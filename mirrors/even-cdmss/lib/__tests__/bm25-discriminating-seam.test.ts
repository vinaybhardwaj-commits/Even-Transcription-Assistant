// lib/__tests__/bm25-discriminating-seam.test.ts — CDMSS-BM25-MEASUREMENT-SEAM-PRD §2.4 (R-2 Stage 1).
// Pure unit tests for the lab-only discriminating BM25 leg — no DB. Test 1 is the production
// regression guard (default BM25 SQL byte-identical to today).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  defaultBm25Sql, discriminatingBm25Sql, parseTsqueryLexemes, selectDiscriminatingLexemes,
  orJoinLexemes, dfEstimateSql, plaintoLexemesSql, BM25_DISCRIMINATING_CAP,
} from '../retrieve.ts';

const FILTER = "text IS NOT NULL AND visible IS NOT FALSE AND source NOT LIKE 'labq:%'";

// ── Test 1 — bm25Mode omitted ⇒ default BM25 SQL byte-identical to today (production regression guard) ──
test('default BM25 SQL is byte-identical to the shipped plainto-AND leg', () => {
  const expected =
    "\n    SELECT id, ROW_NUMBER() OVER (ORDER BY ts_rank_cd(text_tsv, plainto_tsquery('english', $1)) DESC) AS rank" +
    "\n    FROM mksap_chunks" +
    "\n    WHERE text_tsv @@ plainto_tsquery('english', $1)" +
    `\n      AND ${FILTER}` +
    "\n    ORDER BY ts_rank_cd(text_tsv, plainto_tsquery('english', $1)) DESC" +
    "\n    LIMIT 40" +
    "\n  ";
  assert.equal(defaultBm25Sql(FILTER, 40), expected);
  // it must remain plainto-AND: no discriminating machinery leaks into the default path
  const sql = defaultBm25Sql(FILTER, 40);
  assert.ok(sql.includes("plainto_tsquery('english', $1)"));
  assert.ok(!sql.includes('WITH cand'), 'no capped CTE in the default leg');
  assert.ok(!sql.includes(' | '), 'no OR-join in the default leg');
  assert.ok(!sql.includes("@@ to_tsquery("), 'the default leg uses plainto_tsquery, not to_tsquery');
});

// ── Test 2 — discriminating mode drops DF>dfMax terms and OR-joins the rest ──
test('discriminating selection drops common terms (DF > dfMax) and OR-joins the rare ones', () => {
  // measured planner estimates for the montelukast question (rare terms floor at ~11,204)
  const terms = [
    { lexeme: 'antihistamin', df: 11204 }, { lexeme: 'montelukast', df: 11204 },
    { lexeme: 'co-prescrib', df: 6 },      // low DF but hyphenated ⇒ dropped for tsquery safety
    { lexeme: 'co', df: 50570 }, { lexeme: 'prescrib', df: 52736 }, { lexeme: 'viral', df: 52138 },
    { lexeme: 'upper', df: 57666 }, { lexeme: 'respiratori', df: 106891 }, { lexeme: 'tract', df: 46685 },
    { lexeme: 'infect', df: 292437 }, { lexeme: 'adult', df: 162241 },
  ];
  const kept = selectDiscriminatingLexemes(terms, 30000);
  assert.deepEqual(kept, ['antihistamin', 'montelukast']);   // co-prescrib dropped (non-alphanumeric)
  assert.equal(orJoinLexemes(kept), 'antihistamin | montelukast');
});

test('parseTsqueryLexemes extracts bare lexemes from a plainto ::text', () => {
  assert.deepEqual(
    parseTsqueryLexemes("'antihistamin' & 'montelukast' & 'co-prescrib'"),
    ['antihistamin', 'montelukast', 'co-prescrib'],
  );
  assert.deepEqual(parseTsqueryLexemes(''), []);
});

// ── Test 3 — the discriminating leg cannot emit an uncapped scan ──
test('discriminating BM25 SQL always caps the candidate set before ranking', () => {
  const sql = discriminatingBm25Sql(FILTER, 40, BM25_DISCRIMINATING_CAP);
  assert.ok(sql.includes(`LIMIT ${BM25_DISCRIMINATING_CAP}`), 'the CTE cap must be present');
  assert.ok(sql.includes('WITH cand AS'), 'ranking must run over the pre-capped CTE, not the full table');
  // the cap sits on the candidate CTE (before ROW_NUMBER/ts_rank_cd), and the outer LIMIT is the pool
  assert.ok(sql.indexOf(`LIMIT ${BM25_DISCRIMINATING_CAP}`) < sql.indexOf('ROW_NUMBER'));
  assert.ok(sql.includes("to_tsquery('english', $1)"));
});

// ── Test 4 — a query of only-common terms ⇒ empty leg (no OR string), never a timeout/throw ──
test('only-common-terms yields no discriminating lexemes ⇒ empty tsquery ⇒ BM25 leg is skipped', () => {
  const allCommon = [
    { lexeme: 'co', df: 50570 }, { lexeme: 'viral', df: 52138 }, { lexeme: 'adult', df: 162241 },
  ];
  const kept = selectDiscriminatingLexemes(allCommon, 30000);
  assert.deepEqual(kept, []);
  assert.equal(orJoinLexemes(kept), '');   // '' ⇒ retrieve() disables the BM25 leg (bm25Enabled=false)
});

// ── Test 5 — DF is computed by a BOUNDED mechanism (planner estimate), not a full-table COUNT ──
test('the DF-estimate SQL is the bounded planner EXPLAIN, never a COUNT over the corpus', () => {
  const sql = dfEstimateSql();
  assert.ok(sql.startsWith('EXPLAIN (FORMAT JSON)'), 'DF must come from the planner, not execution');
  assert.ok(!/count\s*\(/i.test(sql), 'no COUNT(*) over 2.2M rows (D6)');
  assert.ok(!/TABLESAMPLE/i.test(sql), 'no per-term sampled scan (measured ~11s/term, non-viable)');
  assert.ok(sql.includes("to_tsquery('english', $1)"));
  assert.equal(plaintoLexemesSql(), "SELECT plainto_tsquery('english', $1)::text AS q");
});

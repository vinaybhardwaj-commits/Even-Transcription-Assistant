// lib/__tests__/lab-corpus-visibility.test.ts — the lab-retrieve-seam PRD §7 D5 defence-in-depth:
// quarantine INSERT sets visible=false (test 5) and activation flips visible=true (test 4).
// Asserts on the exported SQL strings — no live DB needed.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CORPUS_QUARANTINE_INSERT_SQL, CORPUS_ACTIVATE_SQL } from '../lab.ts';

// ── Test 5 — quarantine insert sets visible = false ──
test('quarantine INSERT carries visible in the columns and false in the values', () => {
  const sql = CORPUS_QUARANTINE_INSERT_SQL.replace(/\s+/g, ' ').trim();
  // F13 appended six provenance columns; the visible=false guarantee this test exists for is
  // unchanged, and so is the original column order. Counts move 11 → 17.
  assert.match(sql, /INSERT INTO mksap_chunks \(source, book, chapter, section, item_number, chunk_type, text, text_hash, embedding, token_count, visible, citation_url, citation_doi, citation_pmid, source_release_year, license_status, provenance\)/);
  // the literal false still sits in position 11 of the value list — quarantine is still invisible
  assert.match(sql, /VALUES \(\$1, \$2, \$3, \$4, \$5, \$6, \$7, \$8, \$9::vector, \$10, false, \$11, \$12, \$13, \$14, \$15, \$16\)/);
  // dedup semantics preserved
  assert.match(sql, /ON CONFLICT \(book, text_hash\) DO NOTHING RETURNING id/);
  // column count === value count (17 each: 16 placeholders + the literal false)
  const cols = sql.match(/INSERT INTO mksap_chunks \(([^)]*)\)/)![1].split(',').length;
  const vals = sql.match(/VALUES \(([^)]*)\)/)![1].split(',').length;
  assert.equal(cols, 17);
  assert.equal(vals, 17);
});

// ── Test 4 — activation sets both source and visible = true ──
test('activation UPDATE sets both source and visible = true', () => {
  assert.equal(
    CORPUS_ACTIVATE_SQL,
    'UPDATE mksap_chunks SET source = $1, visible = true WHERE source = $2 RETURNING id',
  );
});

/**
 *   node --experimental-strip-types --test lib/__tests__/sql-guard-core.test.ts
 * Pure: read-only SQL guard for the Lab MCP audit_query tool.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { guardReadOnlySql } from '../sql-guard-core.ts';

test('allows SELECT / WITH and auto-adds LIMIT', () => {
  const a = guardReadOnlySql('SELECT count(*) FROM opd_note_audits');
  assert.ok(a.ok); if (a.ok) assert.match(a.sql, /LIMIT 500$/);
  const b = guardReadOnlySql('WITH x AS (SELECT 1) SELECT * FROM x');
  assert.ok(b.ok);
  // the word "comment" as an identifier must NOT be blocked (it's not a forbidden token)
  assert.equal(guardReadOnlySql('SELECT 1 AS comment FROM opd_note_audits').ok, true);
  // the de-identified summary views are allowed
  assert.equal(guardReadOnlySql('SELECT feature, status FROM v_trace_summary').ok, true);
  assert.equal(guardReadOnlySql('SELECT mode, n_findings FROM v_appropriateness_summary').ok, true);
  // existing LIMIT under the ceiling is preserved (not doubled)
  const c = guardReadOnlySql('SELECT * FROM opd_note_audits LIMIT 50');
  assert.ok(c.ok); if (c.ok) assert.equal((c.sql.match(/limit/gi) || []).length, 1);
});

test('rejects writes, DDL, multiple statements, non-SELECT, over-cap LIMIT, system fns', () => {
  for (const q of [
    'UPDATE opd_note_audits SET band=\'A\'',
    'DELETE FROM opd_note_audits',
    'DROP TABLE opd_note_audits',
    'SELECT 1; DROP TABLE opd_note_audits',
    'SELECT * INTO evil FROM opd_note_audits',
    'INSERT INTO opd_note_audits VALUES (1)',
    'TRUNCATE opd_note_audits',
    'CREATE TABLE x (a int)',
    'SELECT pg_read_file(\'/etc/passwd\')',
    'SELECT current_setting(\'x\')',
    'VACUUM',
    'EXPLAIN SELECT 1',              // not SELECT/WITH
  ]) {
    assert.equal(guardReadOnlySql(q).ok, false, q);
  }
  const over = guardReadOnlySql('SELECT * FROM opd_note_audits LIMIT 5000');
  assert.equal(over.ok, false);
  assert.equal(guardReadOnlySql('').ok, false);
});

test('blocks PHI-bearing relations anywhere in the query', () => {
  for (const q of [
    'SELECT input FROM traces',
    'SELECT payload FROM trace_events',
    'SELECT input, output FROM appropriateness_runs',
    'SELECT * FROM ccb_briefs',
    'SELECT * FROM care_track_assignments',
    'SELECT comment FROM opd_audit_feedback',
    // hidden in a subquery
    "SELECT count(*) FROM opd_note_audits WHERE doctor_uid IN (SELECT user_id FROM traces)",
    // hidden in a comma-join
    'SELECT a.band FROM opd_note_audits a, trace_events b',
    // hidden in a CTE
    'WITH t AS (SELECT * FROM traces) SELECT * FROM t',
  ]) {
    assert.equal(guardReadOnlySql(q).ok, false, q);
  }
  // the summary views (which reference the blocked tables in their DEFINITION, not the
  // query text) must still pass — their names avoid the blocked tokens
  assert.equal(guardReadOnlySql('SELECT * FROM v_trace_summary').ok, true);
});

test('honors a smaller caller cap', () => {
  const a = guardReadOnlySql('SELECT 1', 100);
  assert.ok(a.ok); if (a.ok) assert.match(a.sql, /LIMIT 100$/);
  assert.equal(guardReadOnlySql('SELECT 1 LIMIT 300', 100).ok, false); // 300 > caller cap 100
});

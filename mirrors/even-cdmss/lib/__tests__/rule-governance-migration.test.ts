/**
 * lib/__tests__/rule-governance-migration.test.ts — R3-A: migration 0039's SHAPE.
 *
 * The .sql file is DOCUMENTATION; the executable DDL is the string constants in
 * lib/rule-governance-store.ts, because migrations/ is not bundled into the Vercel serverless
 * function (kickoff §6 trap 6). This test is what stops the two forking silently — it is the same
 * job lib/__tests__/lvc-ratified-wording.test.ts does for 0034.
 *
 * It also pins the two structural rulings the schema exists to express: `lvc_rule_versions` has NO
 * valid_to column (S2) and NO foreign key to lvc_recommendations (§3.1), and every governance row
 * carries the full mandatory evidence tuple (§3.4).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  ACTIVATION_EVENTS_TABLE_DDL, BOOTSTRAP_SNAPSHOT_SQL, definitionHashSql, PROPOSE_PATTERN_SQL,
  RULE_GOVERNANCE_DDL, PATTERN_MAP_TABLE_DDL, VALIDITY_VIEW_DDL, VERSIONS_TABLE_DDL,
} from '../rule-governance-store.ts';
import { DEFINITION_HASH_FIELDS } from '../rule-governance-core.ts';

const MIGRATION = readFileSync(new URL('../../migrations/0039_rule_governance.sql', import.meta.url), 'utf8');

/** The .sql file with its `--` comment lines removed, split on statement terminators. */
function statementsOf(sql: string): string[] {
  return sql
    .split('\n').filter((l) => !/^\s*--/.test(l)).join('\n')
    .split(/;\s*(?:\n|$)/)
    .map((s) => s.replace(/\s+/g, ' ').trim())
    .filter(Boolean);
}
const norm = (s: string) => s.replace(/\s+/g, ' ').trim();

// ══ trap 6: the .sql file and the inlined DDL agree ═════════════════════════════════════════════

test('the reference .sql and the executable constants are the SAME statements, in the same order', () => {
  assert.deepEqual(statementsOf(MIGRATION), RULE_GOVERNANCE_DDL.map(norm));
});

test('the migration ships all four objects and nothing else', () => {
  assert.equal(RULE_GOVERNANCE_DDL.length, 7, 'four objects + three indexes');
  assert.equal(statementsOf(MIGRATION).length, 7);
});

test('the .sql file names itself as documentation and the route as the executable path', () => {
  assert.match(MIGRATION, /REFERENCE COPY, DOCUMENTATION ONLY/);
  assert.match(MIGRATION, /GET \/api\/admin\/migrate-rule-governance/);
  assert.match(MIGRATION, /IT DOES NOT RUN ITSELF/);
});

// ══ S2: the immutable version row ═══════════════════════════════════════════════════════════════

test('lvc_rule_versions has NO valid_to column — the window is derived (S2, acceptance 2)', () => {
  assert.doesNotMatch(VERSIONS_TABLE_DDL, /valid_to/);
  assert.doesNotMatch(VERSIONS_TABLE_DDL, /valid_from/);
  assert.doesNotMatch(MIGRATION, /valid_to\s+timestamptz/);
});

test('lvc_rule_versions has NO foreign key to the registry (§3.1, the 0023:49-51 precedent)', () => {
  assert.doesNotMatch(VERSIONS_TABLE_DDL, /REFERENCES/i);
  assert.match(VERSIONS_TABLE_DDL, /PRIMARY KEY \(rule_ref, version\)/);
});

test('the version row freezes exactly the five executable-definition fields', () => {
  for (const f of DEFINITION_HASH_FIELDS) {
    assert.match(VERSIONS_TABLE_DDL, new RegExp(`^\\s*${f}\\s`, 'm'), `${f} must be frozen on the row`);
  }
  assert.match(VERSIONS_TABLE_DDL, /definition_hash\s+text NOT NULL/);
});

test('origin is constrained to the two legitimate values; bootstrap is never a ratification', () => {
  assert.match(VERSIONS_TABLE_DDL, /origin\s+text NOT NULL CHECK \(origin IN \('bootstrap_snapshot','proposal'\)\)/);
});

// ══ S2: the append-only event stream and the derived view ═══════════════════════════════════════

test('the event table constrains `event` to activate | retire and carries effective_at', () => {
  assert.match(ACTIVATION_EVENTS_TABLE_DDL, /event\s+text NOT NULL CHECK \(event IN \('activate','retire'\)\)/);
  assert.match(ACTIVATION_EVENTS_TABLE_DDL, /effective_at\s+timestamptz NOT NULL/);
});

test('the view derives the window with lead() over the per-RULE stream, activate rows only', () => {
  assert.match(VALIDITY_VIEW_DDL, /lead\(e\.effective_at\) OVER \(PARTITION BY e\.rule_ref ORDER BY e\.effective_at, e\.id\)/);
  assert.match(VALIDITY_VIEW_DDL, /WHERE w\.event = 'activate'/);
  // partitioning by version would mean a retire of v1 never closes v1 when v2 is activated
  assert.doesNotMatch(VALIDITY_VIEW_DDL, /PARTITION BY e\.rule_ref, e\.version/);
});

// ══ §3.4: the evidence tuple is mandatory on every governance row ═══════════════════════════════

const MANDATORY = ['ratified_by', 'rationale', 'sample_size', 'reviewed_n', 'sample_seed'];

test('all three governance tables carry the mandatory evidence tuple, NOT NULL', () => {
  for (const [name, ddl] of [
    ['lvc_rule_versions', VERSIONS_TABLE_DDL],
    ['lvc_rule_activation_events', ACTIVATION_EVENTS_TABLE_DDL],
    ['rule_pattern_map', PATTERN_MAP_TABLE_DDL],
  ] as const) {
    for (const col of MANDATORY) {
      assert.match(ddl, new RegExp(`${col}\\s+(text|int)\\s+NOT NULL`), `${name}.${col} must be NOT NULL`);
    }
    assert.match(ddl, /n_not_belonging\s+int(?!\s+NOT NULL)/, `${name}.n_not_belonging is optional`);
  }
});

test('rule_pattern_map uses lvp_pattern_id (O1) and stores the frozen snapshot NOT NULL', () => {
  assert.match(PATTERN_MAP_TABLE_DDL, /lvp_pattern_id\s+text NOT NULL/);
  assert.doesNotMatch(PATTERN_MAP_TABLE_DDL, /^\s*pattern_id\s/m, 'a bare pattern_id beside rule_ref would be ambiguous');
  assert.match(PATTERN_MAP_TABLE_DDL, /evidence_snapshot jsonb NOT NULL/);
});

// ══ the definition hash: one expression, both write paths ═══════════════════════════════════════

test('definitionHashSql refuses a field list that is not the canonical five', () => {
  assert.throws(() => definitionHashSql(['a']), /expects 5 expressions/);
  assert.match(definitionHashSql(['a', 'b', 'c', 'd', 'e']),
    /^md5\(coalesce\(a::text, ''\) \|\| chr\(31\) \|\| coalesce\(b::text, ''\)/);
});

test('both write paths hash the SAME five fields in the SAME order, keywords as jsonb', () => {
  for (const sql of [PROPOSE_PATTERN_SQL, BOOTSTRAP_SNAPSHOT_SQL]) {
    const m = /md5\(([^)]*(?:\)[^)]*)*?)\)\s*,/.exec(sql);
    assert.ok(m, 'the hash expression must be present');
    assert.equal((sql.match(/chr\(31\)/g) ?? []).length, DEFINITION_HASH_FIELDS.length - 1,
      'four separators for five fields');
  }
  assert.match(PROPOSE_PATTERN_SQL, /coalesce\(\$6::jsonb::text, ''\)/);
  assert.match(BOOTSTRAP_SNAPSHOT_SQL, /coalesce\(to_jsonb\(r\.keywords\)::text, ''\)/);
});

// ══ the two write statements, structurally ══════════════════════════════════════════════════════

test('the propose statement writes proposal + version + map, and nothing else', () => {
  const targets = [...PROPOSE_PATTERN_SQL.matchAll(/INSERT INTO (\w+)/g)].map((m) => m[1]).sort();
  assert.deepEqual(targets, ['lvc_recommendation_proposals', 'lvc_rule_versions', 'rule_pattern_map']);
  assert.match(PROPOSE_PATTERN_SQL, /^WITH prop AS \(/, 'one data-modifying-CTE statement (O2)');
  assert.match(PROPOSE_PATTERN_SQL, /WHERE NOT EXISTS/, 'a re-POST of the same pending statement writes nothing');
  assert.match(PROPOSE_PATTERN_SQL, /'proposal', 'informational'/, 'S4: the disposition is a literal');
});

test('the bootstrap statement writes version rows only, and reads the registry read-only', () => {
  const targets = [...BOOTSTRAP_SNAPSHOT_SQL.matchAll(/INSERT INTO (\w+)/g)].map((m) => m[1]);
  assert.deepEqual(targets, ['lvc_rule_versions']);
  assert.match(BOOTSTRAP_SNAPSHOT_SQL, /FROM lvc_recommendations r/);
  assert.match(BOOTSTRAP_SNAPSHOT_SQL, /'bootstrap_snapshot', 'informational'/);
  assert.match(BOOTSTRAP_SNAPSHOT_SQL, /WHERE NOT EXISTS/, 'a second run is a no-op, not a key clash');
});

// ══ R3-A2 — the hardened shape (§1) ═════════════════════════════════════════════════════════════
//
// ⚠️ ASSERTED ON THE .sql AND ON THE CONSTANTS SEPARATELY, then on their agreement. The parity test
// at the top of this file already proves the two are the same statements; these pins prove the
// hardening is actually IN them, so a parity test passing over two identically-unhardened copies
// cannot read as success.

test('R3A2: the event table carries a caller-supplied UNIQUE event_ref uuid', () => {
  for (const [name, sql] of [['reference .sql', MIGRATION], ['inlined DDL', ACTIVATION_EVENTS_TABLE_DDL]] as const) {
    assert.match(sql, /event_ref\s+uuid NOT NULL UNIQUE/, `${name}: event_ref must be a unique uuid`);
  }
  // The idempotency key is the CALLER's, so it can never be defaulted here — a key the writer
  // invents is a new key on every retry, which is the opposite of idempotence.
  assert.doesNotMatch(ACTIVATION_EVENTS_TABLE_DDL, /event_ref[^,]*DEFAULT/);
});

test('R3A2: the event table has a COMPOSITE foreign key to the version it names', () => {
  assert.match(ACTIVATION_EVENTS_TABLE_DDL,
    /FOREIGN KEY \(rule_ref, version\) REFERENCES lvc_rule_versions \(rule_ref, version\)/);
  assert.match(MIGRATION,
    /FOREIGN KEY \(rule_ref, version\) REFERENCES lvc_rule_versions \(rule_ref, version\)/);
  // It must be composite, not two separate references: a rule_ref-only key would admit an event
  // naming a version of that rule that does not exist.
  assert.doesNotMatch(ACTIVATION_EVENTS_TABLE_DDL, /REFERENCES lvc_rule_versions \(rule_ref\)/);
});

test('R3A2: versions are POSITIVE on both tables', () => {
  assert.match(VERSIONS_TABLE_DDL, /CHECK \(version > 0\)/);
  assert.match(ACTIVATION_EVENTS_TABLE_DDL, /CHECK \(version > 0\)/);
  // Not `>= 0`: versions start at 1, and a version 0 would sort ahead of every real one in the
  // (rule_ref, version DESC) index.
  assert.doesNotMatch(MIGRATION, /CHECK \(version >= 0\)/);
});

test('R3A2: the evidence constraints are on ALL THREE governance tables, not only the new one', () => {
  // §1's last bullet. The tuple can arrive by any of the three write paths, so the guarantee has to
  // be on each table — putting it only on the newest one would leave the older two unprotected
  // while looking hardened.
  const tables: Array<[string, string]> = [
    ['lvc_rule_versions', VERSIONS_TABLE_DDL],
    ['lvc_rule_activation_events', ACTIVATION_EVENTS_TABLE_DDL],
    ['rule_pattern_map', PATTERN_MAP_TABLE_DDL],
  ];
  for (const [name, ddl] of tables) {
    assert.match(ddl, new RegExp(`CONSTRAINT ${name}_ratifier_named`), `${name}: named ratifier`);
    assert.match(ddl, /btrim\(ratified_by\) <> ''/, `${name}: no empty ratifier`);
    assert.match(ddl, /NOT IN \('admin'/, `${name}: 'admin' is a role, not a person`);
    assert.match(ddl, /btrim\(rationale\) <> ''/, `${name}: nonblank rationale`);
    assert.match(ddl, /btrim\(sample_seed\) <> ''/, `${name}: nonblank seed`);
    assert.match(ddl, /sample_size >= 0 AND reviewed_n >= 0/, `${name}: nonnegative counts`);
    assert.match(ddl, /CHECK \(reviewed_n <= sample_size\)/, `${name}: reviewed_n <= sample_size`);
    assert.match(ddl, /n_not_belonging >= 0 AND n_not_belonging <= reviewed_n/,
      `${name}: n_not_belonging <= reviewed_n`);
    // …and the whole thing appears in the reference copy too.
    assert.ok(MIGRATION.includes(`CONSTRAINT ${name}_reviewed_le_sample`), `${name}: in the .sql`);
  }
});

test('R3A2: n_not_belonging stays NULLABLE — "where meaningful" survives the hardening', () => {
  // §3.4: null is honest, 0 is a claim. The new bound must not have quietly made it mandatory.
  for (const ddl of [VERSIONS_TABLE_DDL, ACTIVATION_EVENTS_TABLE_DDL, PATTERN_MAP_TABLE_DDL]) {
    assert.doesNotMatch(ddl, /n_not_belonging\s+int\s+NOT NULL/);
    assert.match(ddl, /n_not_belonging IS NULL\s*\n?\s*OR/, 'the bound must admit NULL');
  }
});

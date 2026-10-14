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
  // ⚠️ D2 §1.3 — CLAIM FIRST. The statement used to open `WITH prop AS (`; the identity claim on
  // lvp_pattern_id now leads, and every downstream CTE selects FROM the one above it, so a
  // concurrent loser writes zero rows everywhere. Still ONE data-modifying CTE (O2).
  assert.match(PROPOSE_PATTERN_SQL, /^WITH claim AS \(/, 'one data-modifying-CTE statement (O2), claim first');
  const at = (tbl: string) => PROPOSE_PATTERN_SQL.indexOf(`INSERT INTO ${tbl}`);
  assert.ok(at('rule_pattern_map') < at('lvc_recommendation_proposals'), 'the claim precedes the proposal');
  assert.ok(at('lvc_recommendation_proposals') < at('lvc_rule_versions'), 'the proposal precedes the version');
  // Each downstream CTE is CHAINED to the one above it — that chaining is what makes a losing
  // claim write zero rows, and a test that only checked the order would miss its removal.
  assert.match(PROPOSE_PATTERN_SQL, /'proposed', \$7::text\n\s*FROM claim/, 'the proposal selects FROM claim');
  assert.match(PROPOSE_PATTERN_SQL, /FROM prop\n\s*RETURNING rule_ref/, 'the version selects FROM prop');
  assert.match(PROPOSE_PATTERN_SQL, /ON CONFLICT \(lvp_pattern_id\) DO NOTHING/, 'the claim is atomic');
  // …and the old authoritative dedup rule — exact wrapper-statement equality — is GONE (§1.2).
  assert.doesNotMatch(PROPOSE_PATTERN_SQL, /lower\(p\.statement\)/,
    'wrapper-statement equality compared boilerplate against boilerplate and is no longer the rule');
  // ⚠️ REPLACED, NOT DROPPED. The old form of this pin required `WHERE NOT EXISTS (… lower(
  // p.statement) = lower($1))` — the wrapper-equality guard §1.2 removes. The PROPERTY it was
  // reaching for survives and is now stronger: a re-POST writes nothing because the identity claim
  // conflicts, which keys on the PATTERN rather than on prose two different patterns share.
  assert.doesNotMatch(PROPOSE_PATTERN_SQL, /WHERE NOT EXISTS/,
    'the statement-equality guard is gone; idempotency is the ON CONFLICT claim above');
  assert.match(PROPOSE_PATTERN_SQL, /'proposal', 'informational'/, 'S4: the disposition is a literal');
});

test('the bootstrap statement writes version rows only, and reads the registry read-only', () => {
  const targets = [...BOOTSTRAP_SNAPSHOT_SQL.matchAll(/INSERT INTO (\w+)/g)].map((m) => m[1]);
  assert.deepEqual(targets, ['lvc_rule_versions']);
  assert.match(BOOTSTRAP_SNAPSHOT_SQL, /FROM lvc_recommendations r/);
  assert.match(BOOTSTRAP_SNAPSHOT_SQL, /'bootstrap_snapshot', 'informational'/);
  assert.match(BOOTSTRAP_SNAPSHOT_SQL, /WHERE NOT EXISTS/, 'a second run is a no-op, not a key clash');
});

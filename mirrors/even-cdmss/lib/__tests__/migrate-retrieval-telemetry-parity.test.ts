// lib/__tests__/migrate-retrieval-telemetry-parity.test.ts
// On-path kickoff D1/D2/D3, PRD v2.1 §4.2. Kickoff tests 8, 9, 65, 66, 69.
//
// WHAT THIS GATES. There is no migration runner here — migrations/*.sql is read by nothing, and the
// route is what runs. Two artefacts describing one schema drift silently, and the one that drifts
// is always the documentation, because nothing executes it. This test makes the .sql file a
// LIABILITY if it is wrong rather than a comfort: it compares the route's REAL emitted statements
// against the hand-typed mirror, statement for statement and CHECK value for CHECK value, in both
// directions.
//
// Why compare output rather than source text: D2 forbids hand-typing a CHECK value list, so the
// route GENERATES them from the exported constants — and a generated statement cannot be verified
// by reading the route's source, because the values are not in it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  retrievalTelemetryDdl, RETRIEVAL_ROLE_NOT_NULL_SQL, RETRIEVAL_PERSISTENCE_STATES,
  RETRIEVAL_ROLES, OUTCOME_REQUIRED_STATES, OUTCOME_EITHER_STATES, TELEMETRY_TABLES,
} from '../retrieval-telemetry-core';

const read = (p: string) => readFileSync(join(process.cwd(), p), 'utf8');
const SQL_FILE = 'migrations/0035_opd_audit_retrieval_telemetry.sql';
const ROUTE_FILE = 'app/api/admin/migrate-retrieval-telemetry/route.ts';

/**
 * Split SQL into statements, respecting single-quoted strings.
 *
 * A naive split on ';' is WRONG here and would have passed by accident until someone noticed: the
 * COMMENT ON TABLE bodies contain semicolons ("Retention 90 days from started_at; the purge is
 * operator-scheduled"), and a naive splitter would tear each comment into two half-statements that
 * happen to compare equal to nothing on either side.
 */
function splitStatements(src: string): string[] {
  const out: string[] = [];
  let cur = '';
  let inString = false;
  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    if (inString) {
      cur += ch;
      if (ch === "'") inString = src[i + 1] === "'" ? (cur += src[++i], true) : false;
      continue;
    }
    if (ch === "'") { inString = true; cur += ch; continue; }
    if (ch === '-' && src[i + 1] === '-') {            // line comment, outside a string
      while (i < src.length && src[i] !== '\n') i++;
      cur += ' ';
      continue;
    }
    if (ch === ';') { out.push(cur); cur = ''; continue; }
    cur += ch;
  }
  out.push(cur);
  return out.map(norm).filter((s) => s.length > 0);
}

const norm = (s: string) => s.replace(/\s+/g, ' ').trim();

const routeStatements = () => retrievalTelemetryDdl().map((s) => norm(s.sql));
const fileStatements = () => splitStatements(read(SQL_FILE));

// ════════════════════════════════════════════════════════════════════════════════════════════════
// TEST 8 — THE ROUTE AND THE .sql AGREE, STATEMENT FOR STATEMENT, IN BOTH DIRECTIONS
// ════════════════════════════════════════════════════════════════════════════════════════════════

test('every statement the route runs is in the .sql, and every statement in the .sql is run', () => {
  const fromRoute = routeStatements();
  const fromFile = fileStatements();

  // ⚠️ ORDERED, ELEMENT BY ELEMENT (v9 §6.5). This compared the two sides as SETS in both directions
  // plus an equal count, which cannot see a mirror that carries the right statements in the wrong
  // order — and order is the whole subject of a migration file. The set comparison is kept below it
  // because it names WHICH statement is missing, which an index mismatch does not.
  for (const s of fromRoute) {
    assert.ok(fromFile.includes(s), `the .sql mirror is missing a statement the route runs:\n  ${s.slice(0, 160)}`);
  }
  for (const s of fromFile) {
    assert.ok(fromRoute.includes(s), `the .sql mirror carries a statement the route does NOT run:\n  ${s.slice(0, 160)}`);
  }
  // and they are the same COUNT, so a duplicated line on either side is caught too
  assert.equal(fromFile.length, fromRoute.length, 'same number of statements on both sides');
  for (let i = 0; i < fromRoute.length; i++) {
    assert.equal(fromFile[i], fromRoute[i],
      `statement ${i} differs in ORDER or content:\n  route: ${(fromRoute[i] ?? '<none>').slice(0, 160)}\n  .sql : ${(fromFile[i] ?? '<none>').slice(0, 160)}`);
  }
  // ⚠️ FLOOR RE-POINTED, 25 → 20. The count fell from 31 to 23 when v9 §6.1 collapsed ten constraint
  // statements into two. The floor is a vacuity guard on the splitter, not a schema assertion, so it
  // sits below the real number rather than pinning it.
  assert.ok(fromRoute.length >= 20, 'sanity: the splitter actually found statements');
});

test('the parity comparison cannot pass vacuously', () => {
  // If either side yields nothing, the two loops above are both empty and the test is a lie.
  assert.ok(routeStatements().length > 0, 'the route emits statements');
  assert.ok(fileStatements().length > 0, 'the .sql yields statements');
  // and the splitter respects quoting — the three COMMENT bodies survive whole, semicolons and all
  const comments = fileStatements().filter((s) => s.startsWith('COMMENT ON TABLE'));
  assert.equal(comments.length, 3, 'three comments, not six halves');
  for (const c of comments) assert.ok(c.includes('operator-scheduled'), 'each comment survived its own semicolon');
});

test('every CHECK value in the route is in the .sql, and the reverse', () => {
  const routeChecks = routeStatements().filter((s) => s.includes('CHECK ('));
  const fileChecks = fileStatements().filter((s) => s.includes('CHECK ('));
  assert.equal(routeChecks.length, fileChecks.length);
  const values = (ss: string[]) => new Set(ss.flatMap((s) => [...s.matchAll(/'([a-z0-9_]+)'/g)].map((m) => m[1])));
  const rv = values(routeChecks);
  const fv = values(fileChecks);
  assert.deepEqual([...rv].sort(), [...fv].sort(), 'CHECK value for CHECK value');
  // and the values are the CONSTANTS, not a hand-typed near-miss of them
  for (const s of RETRIEVAL_PERSISTENCE_STATES) assert.ok(rv.has(s), `state ${s} reaches the CHECK`);
  for (const r of RETRIEVAL_ROLES) assert.ok(rv.has(r), `role ${r} reaches the CHECK`);
});

test('the value lists are GENERATED, never hand-typed into the route', () => {
  const routeSrc = read(ROUTE_FILE);
  // If a value list were spelled out in the route we would see the state names in its source.
  for (const s of ['persisted_partial', 'no_persistence_intended', 'lab_multi_query']) {
    assert.equal(routeSrc.includes(`'${s}'`), false, `${s} must come from the constant, not from the route's source`);
  }
  assert.ok(routeSrc.includes('retrievalTelemetryDdl()'), 'the route applies the generated statements');
});

// ════════════════════════════════════════════════════════════════════════════════════════════════
// TEST 69 / D2 — THE ROLE CHECK, AND THE ONE PERMITTED DIFFERENCE
// ════════════════════════════════════════════════════════════════════════════════════════════════

test('the retrieval_role CHECK is generated from RETRIEVAL_ROLES and rejects an unknown role', () => {
  // ⚠️ RE-ANCHORED (v9 §6.1, §8). The role CHECK is no longer a statement of its own: it is one
  // subcommand of the collapsed `retrieval_checks` ALTER. Counting quotation marks across the whole
  // statement would now count three constraints' values and prove nothing. The anchor becomes the
  // role CHECK's own parenthesised value list, extracted from the statement — so the assertion still
  // proves exactly what it proved: FIVE role literals, no extras.
  const stmt = routeStatements().find((s) => s.includes('opd_audit_retrieval_telemetry_role_chk CHECK'));
  assert.ok(stmt, 'the role CHECK exists');
  const m = stmt.match(/ADD CONSTRAINT opd_audit_retrieval_telemetry_role_chk CHECK \(retrieval_role IN \(([^)]*)\)\)/);
  assert.ok(m, 'the role CHECK keeps its generated IN-list form');
  const roleCheck = m[1];
  for (const r of RETRIEVAL_ROLES) assert.ok(roleCheck.includes(`'${r}'`), `${r} admitted`);
  for (const notARole of ['reconciler', 'primary_channel', 'lvc', 'unknown_route']) {
    assert.equal(roleCheck.includes(`'${notARole}'`), false, `${notARole} is not a role and must be rejected`);
  }
  assert.equal((roleCheck.match(/'/g) || []).length / 2, RETRIEVAL_ROLES.length, 'exactly the five, no extras');
  // And the extraction is not vacuous: a value from a NEIGHBOURING constraint in the same statement
  // must not appear in it. `persistence_skipped` is a state, never a role.
  assert.equal(roleCheck.includes('persistence_skipped'), false, 'the clause was isolated, not the whole ALTER');
  assert.ok(stmt.includes(`'persistence_skipped'`), '…and that neighbour really is in the same statement');
});

test('the conditional NOT NULL is the ONE allowed difference, and the .sql states the rule', () => {
  // It is NOT a statement in the mirror, because a .sql file cannot branch...
  assert.equal(fileStatements().some((s) => s.includes('SET NOT NULL')), false,
    'a mirror that carried it would document a migration step that does not unconditionally happen');
  // ...but the rule IS stated there, in prose, so the file is not silently incomplete.
  const raw = read(SQL_FILE);
  assert.ok(raw.includes(RETRIEVAL_ROLE_NOT_NULL_SQL), 'the exact statement appears as documentation');
  assert.ok(/skipped, table not empty/.test(raw), 'and so does what happens when it is skipped');
  // and the route really does branch on emptiness, reporting which way it went
  const routeSrc = read(ROUTE_FILE);
  assert.ok(routeSrc.includes("steps.retrieval_role_not_null = 'applied, table empty'"));
  assert.ok(routeSrc.includes("steps.retrieval_role_not_null = 'skipped, table not empty'"));
  assert.equal(/DO \$\$|DO \$/.test(routeSrc), false, 'an explicit step, not a DO block — the decision must be visible in `steps`');
});

// ════════════════════════════════════════════════════════════════════════════════════════════════
// TEST 65 — RE-RUNNABILITY
// ════════════════════════════════════════════════════════════════════════════════════════════════

test('every statement is idempotent, and each ADD CONSTRAINT is preceded by its own DROP', () => {
  const stmts = routeStatements();
  for (const s of stmts) {
    if (s.startsWith('CREATE TABLE')) assert.ok(s.includes('IF NOT EXISTS'), s.slice(0, 60));
    if (s.startsWith('CREATE INDEX')) assert.ok(s.includes('IF NOT EXISTS'), s.slice(0, 60));
    if (s.includes('ADD COLUMN')) assert.ok(!/ADD COLUMN (?!IF NOT EXISTS)/.test(s), 'every added column is guarded');
  }
  // Applying the route twice must leave the same constraints and must not error, which is exactly
  // what the DROP-before-ADD ordering buys. Assert the ORDER, not merely the presence.
  //
  // ⚠️ RE-POINTED (v9 §6.1, §8). This searched for a DROP statement at a lower INDEX than its ADD
  // statement. The three constraints now live in one collapsed ALTER, so both live at the same
  // index and an index comparison cannot express the requirement. It becomes a comparison of
  // POSITION WITHIN that statement.
  //
  // ⚠️ AND THE ORDER IS NOT WHAT MAKES IT WORK. PostgreSQL sorts an ALTER TABLE's subcommands into
  // ordered passes in which drops precede adds, so the statement would be correct even written the
  // other way round. It is written drops-first anyway, and pinned here, because a reader must not
  // need that knowledge to believe the migration is re-runnable. Do not relax this to presence.
  const combined = stmts.filter((s) => /^ALTER TABLE \w+ DROP CONSTRAINT IF EXISTS/.test(s));
  assert.equal(combined.length, 2, 'one collapsed constraint statement per table, and only two tables have any');
  for (const s of combined) {
    assert.equal((s.match(/;/g) || []).length, 0, 'one statement');
    const drops = [...s.matchAll(/DROP CONSTRAINT IF EXISTS (\w+)/g)].map((m) => m[1]);
    const adds = [...s.matchAll(/ADD CONSTRAINT (\w+) CHECK/g)].map((m) => m[1]);
    assert.deepEqual(adds, drops, 'every constraint added is first dropped, and nothing else is dropped');
    for (const name of adds) {
      assert.ok(s.indexOf(`DROP CONSTRAINT IF EXISTS ${name}`) < s.indexOf(`ADD CONSTRAINT ${name}`),
        `${name}: the DROP is written first, or a reader has to know about ALTER TABLE passes`);
    }
  }
  // The three named constraints of the dangerous table are all in ONE statement, which is the point:
  // its CREATE TABLE carries no inline CHECK, so a failure between a drop and an add left it bare.
  const retrieval = combined.find((s) => s.startsWith('ALTER TABLE opd_audit_retrieval_telemetry '));
  assert.ok(retrieval);
  for (const name of ['persistence_state_chk', 'role_chk', 'outcome_chk']) {
    assert.ok(retrieval.includes(`DROP CONSTRAINT IF EXISTS opd_audit_retrieval_telemetry_${name}`), `${name} DROP`);
    assert.ok(retrieval.includes(`ADD CONSTRAINT opd_audit_retrieval_telemetry_${name}`), `${name} ADD`);
  }
  // No standalone constraint DROP survives anywhere in the list (v9 §6.1).
  assert.equal(stmts.filter((s) => /^ALTER TABLE \w+ DROP CONSTRAINT IF EXISTS [\w]+$/.test(s)).length, 0,
    'a lone DROP is exactly the window this commit closed');
});

test('the index count in the .sql is the real total', () => {
  // RE-POINTED: this assertion lived in retrieval-telemetry-core.test.ts and expected 6 against the
  // original file. The guard it stands for is "every index is IF NOT EXISTS", which is unchanged;
  // the number moves because the build adds two to the retrieval table and six across the two new
  // tables. Both sides are counted so the mirror cannot quietly drop one.
  const inFile = (read(SQL_FILE).match(/CREATE INDEX IF NOT EXISTS/g) || []).length;
  const inRoute = routeStatements().filter((s) => s.startsWith('CREATE INDEX')).length;
  assert.equal(inFile, 14, '8 on the retrieval table, 3 on invocations, 3 on failures');
  assert.equal(inRoute, 14);
  assert.equal((read(SQL_FILE).match(/CREATE INDEX(?! IF NOT EXISTS)/g) || []).length, 0, 'every index is guarded');
});

// ════════════════════════════════════════════════════════════════════════════════════════════════
// TEST 66 — THE THREE TABLE COMMENTS DIFFER, AND EACH SAYS WHAT ITS TABLE HOLDS
// ════════════════════════════════════════════════════════════════════════════════════════════════

test('each table comment is written for its own table, not pasted three times', () => {
  const comments = new Map<string, string>();
  for (const s of routeStatements()) {
    const m = s.match(/^COMMENT ON TABLE (\w+) IS '(.*)'$/);
    if (m) comments.set(m[1], m[2]);
  }
  assert.equal(comments.size, 3, 'one per table');
  for (const t of TELEMETRY_TABLES) assert.ok(comments.has(t), `${t} is documented`);
  assert.equal(new Set(comments.values()).size, 3, 'three DIFFERENT texts');

  // Only the retrieval table carries a patient identifier, and only it may name one.
  assert.ok(comments.get('opd_audit_retrieval_telemetry')!.includes('uid is a re-identification key'));
  for (const t of ['opd_retrieval_invocations', 'opd_retrieval_telemetry_failures']) {
    assert.ok(comments.get(t)!.includes('NO PATIENT IDENTIFIER'), `${t} says it has none`);
    // The forbidden thing is CLAIMING to carry one. §4.2's own wording for these two is that they
    // are "join keys to a uid-bearing table", so the word may appear — asserting it never does
    // would forbid the explanation the PRD asks for. What must not appear is the claim itself.
    assert.equal(comments.get(t)!.includes('uid is a re-identification key'), false,
      `${t} must not claim a uid column it does not have`);
    assert.equal(/\buid\b(?!-bearing)/.test(comments.get(t)!), false,
      `${t} may only mention uid as the table it joins to`);
  }
  // The retention ANCHOR differs, because the failure table has no started_at.
  assert.ok(comments.get('opd_audit_retrieval_telemetry')!.includes('90 days from started_at'));
  assert.ok(comments.get('opd_retrieval_invocations')!.includes('90 days from started_at'));
  assert.ok(comments.get('opd_retrieval_telemetry_failures')!.includes('90 days from observed_at'));
  assert.equal(comments.get('opd_retrieval_telemetry_failures')!.includes('from started_at'), false,
    'the failure table has no started_at — a pasted comment would say it did');
  // All three state the purge is owed and unimplemented (§4.2).
  for (const c of comments.values()) {
    assert.ok(c.includes('operator-scheduled') && c.includes('NOT implemented here'));
    assert.ok(c.includes('Observation only'));
  }
});

// ════════════════════════════════════════════════════════════════════════════════════════════════
// TEST 9 — THE STOP RULE
// ════════════════════════════════════════════════════════════════════════════════════════════════

test('the route halts, changes nothing and reports counts when the table exists with rows', () => {
  const src = read(ROUTE_FILE);
  const stopRule = src.slice(src.indexOf('THE STOP RULE'), src.indexOf('THE SCHEMA'));
  assert.notEqual(stopRule, '', 'the stop rule exists');
  assert.ok(/to_regclass\('public\.opd_audit_retrieval_telemetry'\)/.test(stopRule), 'existence is checked first');
  assert.ok(/count\(\*\)::int AS n FROM opd_audit_retrieval_telemetry/.test(stopRule), 'then the row count');
  assert.ok(/GROUP BY persistence_state/.test(stopRule), 'and the state histogram it returns');
  assert.ok(/halted: 'table_not_empty'/.test(stopRule) || /halted: 'table_not_empty'/.test(src));
  assert.ok(/status: 409/.test(stopRule), 'and it is a refusal, not a success with a warning');
  // It must RETURN before any DDL runs — a stop rule that reports after mutating is not a stop rule.
  assert.ok(stopRule.indexOf('return NextResponse.json') < stopRule.length);
  assert.ok(src.indexOf('halted: \'table_not_empty\'') < src.indexOf('for (const stmt of retrievalTelemetryDdl())'),
    'the halt precedes every schema statement');
});

test('the outcome CHECK partitions the states, and the .sql says so where it cannot branch', () => {
  const outcome = routeStatements().find((s) => s.includes('opd_audit_retrieval_telemetry_outcome_chk CHECK'));
  assert.ok(outcome);
  for (const s of OUTCOME_REQUIRED_STATES) assert.ok(outcome.includes(`'${s}'`));
  for (const s of OUTCOME_EITHER_STATES) assert.ok(outcome.includes(`'${s}'`));
  assert.ok(outcome.includes("persistence_state = 'started' AND retrieval_outcome IS NULL"));
  // `started` + 9 + 4 = 14, checked by set arithmetic in retrieval-telemetry-core.test.ts, not here.
  assert.equal(1 + OUTCOME_REQUIRED_STATES.length + OUTCOME_EITHER_STATES.length, RETRIEVAL_PERSISTENCE_STATES.length);
});

test('the mirror names the route, and the route names the mirror', () => {
  assert.ok(read(SQL_FILE).includes('app/api/admin/migrate-retrieval-telemetry/route.ts'),
    'a reader who opens the .sql learns immediately that it is not what runs');
  assert.ok(read(ROUTE_FILE).includes('migrations/0035_opd_audit_retrieval_telemetry.sql'));
  assert.ok(/THIS FILE IS DOCUMENTATION\. IT IS NOT APPLIED BY ANYTHING\./.test(read(SQL_FILE)));
});

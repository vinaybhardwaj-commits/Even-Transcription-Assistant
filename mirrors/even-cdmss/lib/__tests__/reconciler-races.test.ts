/**
 * lib/__tests__/reconciler-races.test.ts — kickoff tests 55, 58, 59 and 64.
 *
 * ⚠️ WHAT IS EXERCISED AND WHAT IS PINNED, CORRECTED. This header used to say the route was "pinned
 * by source and by its two exported statements". It has no exported statements — Next rejects extra
 * route exports, so `RECONCILER_SELECT_SQL`, `RECONCILER_UPDATE_SQL` and `REREAD_SQL` are three
 * module-private constants — and reading them out of the source was never sufficient. One line
 * defeats a source pin while leaving all three constants byte-identical:
 *
 *     await sql(RECONCILER_UPDATE_SQL.replace('AND row_revision = $2', 'AND $2::int IS NOT NULL'), …)
 *
 * So the exported `GET` is now DRIVEN, against a fake table stateful enough to decide from the
 * observed SQL, the bound parameters and the row's current revision and state whether an update
 * lands. The source pins are kept — they are cheap and they name the intent — but they are not what
 * proves the compare-and-set.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { lstatSync } from 'node:fs';
import { NextRequest } from 'next/server';
import { installDbStub, decodeCall, UnsupportedStubTransportError, type DbStub } from './telemetry-db-stub';
import { GET } from '../../app/api/admin/retrieval-telemetry-reconcile/route';
import {
  reconcilerStateFor, isAllowedTransition, RETRIEVAL_PERSISTENCE_STATES, TERMINAL_PERSISTENCE_STATES,
  NON_TERMINAL_PERSISTENCE_STATES, ALLOWED_TRANSITIONS,
} from '../retrieval-telemetry-core';
import {
  WORKER_MAX_DURATION_SECONDS, RECONCILER_GRACE_SECONDS, RECONCILER_STALE_AFTER_SECONDS,
} from '../opd-audit-runtime-config';

const RECONCILER = readFileSync('app/api/admin/retrieval-telemetry-reconcile/route.ts', 'utf8');
const WORKER_ROUTE = readFileSync('app/api/opd-audit/worker/route.ts', 'utf8');
const VERCEL = JSON.parse(readFileSync('vercel.json', 'utf8')) as { crons: Array<{ path: string; schedule: string }> };

// ════════════════════════════════════════════════════════════════════════════════════════════════
// 55 — the mapping, the race, the reread, and the terminal-row rule
// ════════════════════════════════════════════════════════════════════════════════════════════════

test('55 — every failure-phase to reconciler-state mapping, all four rows of D13\'s table', () => {
  const D13: Array<[('started' | 'retrieval_complete'), string[], string]> = [
    ['started', ['retrieval_terminal'], 'telemetry_persistence_failed'],
    ['started', [], 'aborted'],
    ['retrieval_complete', ['persistence_link'], 'telemetry_persistence_failed'],
    ['retrieval_complete', [], 'persistence_unknown'],
  ];
  for (const [from, phases, to] of D13) {
    assert.equal(reconcilerStateFor(from, phases), to, `${from} + [${phases}]`);
  }
  // "Where several failures exist, the latest phase RELEVANT TO THE CURRENT ROW STATE controls."
  // A `persistence_link` failure on a `started` row is not relevant: that row never got that far.
  assert.equal(reconcilerStateFor('started', ['persistence_link', 'work_declaration']), 'aborted');
  assert.equal(reconcilerStateFor('retrieval_complete', ['retrieval_terminal']), 'persistence_unknown');
  // A `work_declaration` failure produces no retrieval row at all, so it maps to nothing here.
  assert.equal(reconcilerStateFor('started', ['work_declaration']), 'aborted');
});

test('55 — the selection is bounded, non-terminal only, and oldest first', () => {
  assert.match(RECONCILER, /WHERE persistence_state IN \('started', 'retrieval_complete'\)/);
  assert.match(RECONCILER, /AND started_at < \$1/);
  assert.match(RECONCILER, /ORDER BY started_at\n\s+LIMIT \$2/);
  // A bounded pass that hides its truncation reads as "everything was covered".
  assert.ok(RECONCILER.includes('more_may_remain: stale.length === limit'));
});

test('55 — the update is a compare-and-set on the expected revision, and cannot move a terminal row', () => {
  assert.match(RECONCILER, /SET persistence_state = \$3, persistence_settled_at = \$4, row_revision = row_revision \+ 1/);
  assert.match(RECONCILER, /WHERE retrieval_run_id = \$1\n\s+AND row_revision = \$2/);
  // Belt to the revision's braces: the statement itself refuses a terminal row.
  assert.match(RECONCILER, /AND persistence_state IN \('started', 'retrieval_complete'\)\n\s+RETURNING row_revision/);
  // And the code refuses one before it even gets there — a successful terminal state always wins.
  assert.ok(RECONCILER.includes("if (isTerminalState(from)) return { runId: row.retrieval_run_id, result: 'won_by_a_later_write', from };"));
});

test('55 — a revision mismatch causes ONE reread and reclassification, never a blind retry', () => {
  // The reread re-derives the state from what the row BECAME…
  assert.ok(RECONCILER.includes('return reconcileRow(fresh[0], at, true);'));
  // …and the second attempt cannot recurse again.
  assert.ok(RECONCILER.includes("if (reread) {"));
  assert.match(RECONCILER, /if \(reread\) \{[\s\S]{0,260}return \{ runId: row\.retrieval_run_id, result: 'won_by_a_later_write', from \};/);
  // ⚠️ THIS COUNTS RECURSIVE CALL SITES AND NOTHING MORE. It used to be introduced as "a blind retry
  // would look like a loop on the same row object", which is false of the shape that actually
  // matters: a fifty-iteration spin loop before the `if (reread)` block, with the pinned recursion
  // left in place as dead code, satisfies every regex in this test. What refuses that is the exact
  // write and reread COUNT per path, asserted at run time by `runPass`.
  assert.equal((RECONCILER.match(/reconcileRow\(/g) || []).length, 3, 'the definition, the entry call, and the one reread');
});

test('55 — every state the reconciler can assign is a legal transition from where it assigns it', () => {
  for (const from of ['started', 'retrieval_complete'] as const) {
    for (const phases of [[], ['retrieval_terminal'], ['persistence_link']]) {
      const to = reconcilerStateFor(from, phases);
      assert.ok(isAllowedTransition(from, to), `${from} -> ${to}`);
      assert.ok((RETRIEVAL_PERSISTENCE_STATES as readonly string[]).includes(to));
      assert.ok((TERMINAL_PERSISTENCE_STATES as readonly string[]).includes(to), 'and it is terminal — the pass ENDS the ambiguity');
    }
  }
  // The route checks this itself rather than trusting the mapping, and records a refusal instead of
  // forcing one: the transition table is the only authority.
  assert.ok(RECONCILER.includes("if (!isAllowedTransition(from, to)) {"));
});

test('55 — the reconciler owns an invocation of its own kind, and closes it', () => {
  assert.ok(RECONCILER.includes("const ctx = telemetryContextFor('reconciler', req.headers);"));
  assert.ok(RECONCILER.includes("await startInvocation(ctx, 'reconciler');"), 'kind = reconciler, never retrieval');
  // Both exits close it: a pass that threw still ran, and its invocation should not read as killed.
  assert.equal((RECONCILER.match(/await closeInvocation\(ctx,/g) || []).length, 2);
  // It must NOT join (uid, engine_version) to find an audit — two executions for one note are two
  // rows by design, and that join would link a run to another run's audit. Checked against the
  // CODE with comments stripped, because the prohibition is also written down in one of them.
  const code = RECONCILER.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  assert.equal(/engine_version/.test(code), false, 'no statement mentions engine_version');
  assert.equal(/\bJOIN\b/i.test(code), false, 'and none joins anything at all');
  assert.equal(/\buid\b/.test(code), false, 'nor selects a patient identifier it has no use for');
});

// ════════════════════════════════════════════════════════════════════════════════════════════════
// 55, AT RUN TIME — the whole statement, the counts, the cutoff, and the refusal branch
// ════════════════════════════════════════════════════════════════════════════════════════════════
//
// ⚠️ TEN KILLS SURVIVED THE PREVIOUS VERSION OF THIS SECTION, all sixteen cases green under every
// one. The two that matter most: `AND row_revision = $2 OR TRUE` — which parses as
// `(id AND rev) OR (nonterminal)` and rewrites EVERY non-terminal row in the table in one pass —
// and a predicate parked in a `--` comment behind `AND TRUE`. Both leave a substring search happy.
// Others weakened the guard only on the reread path, moved the transition refusal to after the
// UPDATE, or replaced the pinned recursion with a fifty-iteration spin loop.
//
// So a substring is never what decides anything here. The COMPLETE normalized statement is compared
// against a value hard-coded below, and the statement counts are pinned per path.
//
// ⚠️ NON-GLOBAL REGULAR EXPRESSIONS, DELIBERATELY. The stub calls `RegExp.test()` repeatedly against
// the same objects, and `/g` or `/y` would carry `lastIndex` between calls.

const STALE_SELECT = /SELECT retrieval_run_id[\s\S]*WHERE persistence_state IN/;
const REREAD_SELECT = /SELECT retrieval_run_id[\s\S]*WHERE retrieval_run_id = \$1/;
/** Broad on purpose: ANY statement mentioning the telemetry table. The two selects are routed after
 *  this one and win, so what reaches this route is every other way of touching the table — including
 *  a write inside a CTE, or one spelled `update` in lower case, which an anchored
 *  `/^\s*UPDATE opd_audit_retrieval_telemetry\b/` would never see. */
const TOUCHES_TELEMETRY_TABLE = /opd_audit_retrieval_telemetry/i;
const INVOCATION_WRITE = /opd_retrieval_invocations/;
const FAILURE_PHASES = /SELECT failed_phase/;

/**
 * ⚠️ HARD-CODED, AND NOT DERIVED FROM `route.ts` OR `RECONCILER_UPDATE_SQL`. A pin that reads the
 * thing it is checking asserts only that the file agrees with itself; every one of the ten kills
 * left the module constant byte-identical.
 */
const PINNED_TELEMETRY_UPDATE = [
  'UPDATE opd_audit_retrieval_telemetry',
  'SET persistence_state = $3, persistence_settled_at = $4, row_revision = row_revision + 1',
  'WHERE retrieval_run_id = $1',
  'AND row_revision = $2',
  "AND persistence_state IN ('started', 'retrieval_complete')",
  'RETURNING row_revision',
].join(' ');

/**
 * Decode Postgres Unicode identifiers so `U&"opd_audit_retrieval_telemetr\0079"` is seen as the
 * table it names. The six-digit `\+XXXXXX` form is decoded first; the four-digit form second.
 */
function decodeUnicodeIdentifiers(q: string): string {
  return q.replace(/U&"((?:[^"]|"")*)"/gi, (_m, body: string) => body
    .replace(/\\\+([0-9a-fA-F]{6})/g, (_x, hex: string) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/\\([0-9a-fA-F]{4})/g, (_x, hex: string) => String.fromCodePoint(parseInt(hex, 16))));
}

/**
 * ⚠️ ANY STATEMENT THAT NAMES THE TABLE, WHATEVER VERB IT CARRIES. This used to require the literal
 * name AND an `update|insert|delete|merge` word, which is two ways to be invisible at once: a
 * `SELECT opd_settle_stale_retrieval_row($1, $2, $3)` has neither and settled every refused row, and
 * a Unicode identifier has neither the literal name nor, necessarily, a recognisable verb.
 */
const namesTelemetryTable = (q: string): boolean =>
  TOUCHES_TELEMETRY_TABLE.test(decodeUnicodeIdentifiers(q).replace(/"/g, ''));

/** Kept as the write predicate for the counts; the classification above is what decides validity. */
const writesTelemetryTable = (q: string): boolean =>
  namesTelemetryTable(q) && /\b(update|insert|delete|merge)\b/i.test(q);

/**
 * Every statement shape this route is known to issue. ⚠️ UNRECOGNIZED MEANS FAILED. The stub returns
 * `[]` for a statement no route matches, which reads to the caller exactly like a legitimate empty
 * result — so a statement nobody modelled was, until now, silently allowed.
 */
const KNOWN_STATEMENTS: ReadonlyArray<readonly [string, RegExp]> = [
  ['invocation write', /opd_retrieval_invocations/],
  ['failure phases', /SELECT failed_phase/],
  ['stale select', /SELECT retrieval_run_id[\s\S]*WHERE persistence_state IN/],
  ['reread select', /SELECT retrieval_run_id[\s\S]*WHERE retrieval_run_id = \$1/],
  ['telemetry write', /^\s*UPDATE opd_audit_retrieval_telemetry\b/],
];
const unrecognizedStatements = (db: DbStub) =>
  db.calls.filter((c) => !KNOWN_STATEMENTS.some(([, re]) => re.test(c.query)));

/** Every statement this request sent that WRITES the telemetry table, in order. */
const telemetryWrites = (db: DbStub) => db.calls.filter((c) => writesTelemetryTable(c.query));

interface SqlVerdict { pinned: boolean; why: string }

/**
 * Collapse whitespace and compare the WHOLE statement. Comment markers and statement separators are
 * refused outright: `--` and `/*` are how a predicate is made inert while staying present as text,
 * and `;` is how a second statement rides along inside one string.
 */
function checkSql(q: string): SqlVerdict {
  if (/[\0;]|--|\/\*|\*\//.test(q)) return { pinned: false, why: `comment marker, NUL or ';' in: ${q}` };
  const normalized = q.replace(/\s+/g, ' ').trim();
  return normalized === PINNED_TELEMETRY_UPDATE
    ? { pinned: true, why: '' }
    : { pinned: false, why: `not the pinned statement:\n  got      ${normalized}\n  expected ${PINNED_TELEMETRY_UPDATE}` };
}

interface FakeRow { id: string; role: string; state: string; revision: number }
const wire = (r: FakeRow) => ({
  retrieval_run_id: r.id, retrieval_role: r.role, persistence_state: r.state, row_revision: r.revision,
});

/**
 * THE FAKE TABLE'S CONTRACT, IN TWO STEPS AND NO MORE.
 *
 *   1. VALIDATE that the statement the route issued is the one pinned statement, complete.
 *   2. MODEL THAT KNOWN STATEMENT'S semantics — compare-and-set on `row_revision`, refuse a terminal
 *      state — from the bound parameters and the live row.
 *
 * It does NOT interpret arbitrary SQL and must not pretend to. A statement that fails step 1 is
 * recorded and lands nothing; the test asserts afterwards that no such statement was issued.
 *
 * ⚠️ NOTHING HERE THROWS. `route.ts:192` catches and returns `{ ok: false }` with status 500, so an
 * assertion raised inside this callback would become a 500 and the case could still pass. Every
 * runtime case asserts status 200 and `ok: true` for that reason.
 *
 * `race` is the concurrent writer, applied immediately before the Nth write is evaluated.
 */
function installFakeTable(
  db: DbStub,
  selected: FakeRow[],
  races: Array<{ beforeUpdate: number; becomes: FakeRow }> = [],
) {
  const live = new Map(selected.map((r) => [r.id, { ...r }]));
  const log: Array<{ params: unknown[]; landed: boolean; verdict: SqlVerdict }> = [];

  db.on(INVOCATION_WRITE, []);
  db.on(FAILURE_PHASES, []);                       // no failure evidence in any case here
  db.on(TOUCHES_TELEMETRY_TABLE, (c) => {
    for (const r of races) if (log.length + 1 === r.beforeUpdate) live.set(r.becomes.id, { ...r.becomes });
    const verdict = checkSql(c.query);
    const [runId, boundRevision, state] = c.params as [string, string, string];
    const row = live.get(runId);
    const landed = verdict.pinned
      && !!row
      && Number(boundRevision) === row.revision
      && (NON_TERMINAL_PERSISTENCE_STATES as readonly string[]).includes(row.state);
    log.push({ params: c.params, landed, verdict });
    if (!landed || !row) return [];
    row.state = state;
    row.revision += 1;
    return [{ row_revision: row.revision }];
  });
  // Routed AFTER the broad rule, so these two win for themselves and everything else falls through.
  db.on(STALE_SELECT, selected.map(wire));         // a snapshot, as a real SELECT would be
  db.on(REREAD_SELECT, (c) => {
    const r = live.get(String(c.params[0]));
    return r ? [wire(r)] : [];
  });
  return { live, log };
}

const cronRequest = (query = '') => new NextRequest(
  `https://cdmss.invalid/api/admin/retrieval-telemetry-reconcile${query}`,
  { headers: { 'x-vercel-cron': '1' } },
);

/** The route's JSON body, typed only as far as these tests read it. */
interface ReconcileBody {
  ok: boolean;
  selected: number;
  limit: number;
  cutoff: string;
  grace_seconds: number;
  more_may_remain: boolean;
  tally: Record<string, number>;
  verdicts: Array<{ runId: string; result: string; from?: string; to?: string; reread?: boolean }>;
}

/**
 * Run the pass and check everything every case must check: a 200, `ok: true`, that every write to
 * the telemetry table was the pinned statement, and the exact statement counts for this path.
 */
async function runPass(
  db: DbStub,
  log: Array<{ params: unknown[]; landed: boolean; verdict: SqlVerdict }>,
  expect: { writes: number; rereads: number },
  query = '',
): Promise<ReconcileBody> {
  const res = await GET(cronRequest(query));
  // ⚠️ FIRST, ALWAYS. A 500 here means something threw inside the request, and the body would carry
  // the reason rather than a result.
  assert.equal(res.status, 200);
  const body = await res.json() as ReconcileBody;
  assert.equal(body.ok, true);
  for (const entry of log) assert.ok(entry.verdict.pinned, entry.verdict.why);
  // ⚠️ NOTHING THE ROUTE SENT MAY BE UNACCOUNTED FOR. A statement no shape recognises is a failure,
  // not a no-op — that is how `SELECT opd_settle_stale_retrieval_row(…)` settled refused rows while
  // every case stayed green.
  assert.deepEqual(
    unrecognizedStatements(db).map((c) => c.query.replace(/\s+/g, ' ').trim().slice(0, 120)), [],
    'the route issued a statement no known shape recognises',
  );
  // And every statement that NAMES the table, whatever verb it carries, must be the pinned write.
  for (const c of db.calls.filter((x) => namesTelemetryTable(x.query))) {
    if (/SELECT retrieval_run_id/.test(c.query)) continue;   // the two reads are pinned separately
    assert.ok(checkSql(c.query).pinned, checkSql(c.query).why);
  }
  // Counted from the CLASSIFIER, not from an anchored regex: a write inside a CTE is still a write.
  assert.equal(telemetryWrites(db).length, expect.writes, 'telemetry writes');
  assert.equal(log.length, expect.writes, 'every telemetry write reached the fake table');
  assert.equal(db.matching(REREAD_SELECT).length, expect.rereads, 'rereads');
  return body;
}

test('55 runtime — an ordinary one-row pass: one pinned write, no reread', async () => {
  const db = installDbStub();
  const { log } = installFakeTable(db, [{ id: 'r1', role: 'primary', state: 'started', revision: 3 }]);
  const body = await runPass(db, log, { writes: 1, rereads: 0 });
  assert.equal(body.selected, 1);
  assert.equal(db.matching(STALE_SELECT).length, 1, 'the stale-row SELECT ran');
  assert.equal(log[0].landed, true);
});

test('55 runtime — the statement the route ACTUALLY SENT is the pinned one, complete', async () => {
  const db = installDbStub();
  const { log } = installFakeTable(db, [{ id: 'r1', role: 'primary', state: 'started', revision: 3 }]);
  await runPass(db, log, { writes: 1, rereads: 0 });
  // Said once more explicitly, because this is the assertion the whole section exists for: not that
  // two substrings are present, but that nothing else is.
  assert.equal(
    telemetryWrites(db)[0].query.replace(/\s+/g, ' ').trim(), PINNED_TELEMETRY_UPDATE,
    'the SET list, the WHERE clause and the RETURNING clause are all pinned, not just two predicates',
  );
});

test('55 runtime — each row\'s write binds ITS OWN revision', async () => {
  const db = installDbStub();
  const { log } = installFakeTable(db, [
    { id: 'r-a', role: 'primary', state: 'started', revision: 41 },
    { id: 'r-b', role: 'normative_channel', state: 'retrieval_complete', revision: 97 },
  ]);
  await runPass(db, log, { writes: 2, rereads: 0 });
  // Wire form: the driver renders every bound parameter to text before it leaves the process.
  assert.deepEqual(log.map((u) => [u.params[0], u.params[1]]), [['r-a', '41'], ['r-b', '97']]);
  assert.deepEqual(log.map((u) => u.landed), [true, true]);
});

test('55 runtime — THE STALE DECISION DOES NOT LAND: reread, reclassify, write the FRESH state', async () => {
  const db = installDbStub();
  // Selected as `started` at 7. A concurrent writer completes the retrieval before the write runs.
  const { log } = installFakeTable(
    db,
    [{ id: 'r1', role: 'primary', state: 'started', revision: 7 }],
    [{ beforeUpdate: 1, becomes: { id: 'r1', role: 'primary', state: 'retrieval_complete', revision: 8 } }],
  );
  const body = await runPass(db, log, { writes: 2, rereads: 1 });

  // The first carries the decision made from the row as SELECTED — and must not land.
  assert.deepEqual(log[0].params.slice(0, 3), ['r1', '7', 'aborted']);
  assert.equal(log[0].landed, false, 'the stale decision was written anyway');
  // The second is RECLASSIFIED from the fresh row: `retrieval_complete` with no failure evidence is
  // `persistence_unknown`, not the `aborted` this pass first decided on. Its statement is pinned by
  // `runPass` too — the reread path was where two of the ten kills weakened the guard.
  assert.deepEqual(log[1].params.slice(0, 3), ['r1', '8', 'persistence_unknown']);
  assert.equal(log[1].landed, true);
  assert.deepEqual(body.verdicts, [{
    runId: 'r1', result: 'reconciled', from: 'retrieval_complete', to: 'persistence_unknown', reread: true,
  }]);
});

test('55 runtime — a TERMINAL row wins, and no second write is issued', async () => {
  const db = installDbStub();
  const { log } = installFakeTable(
    db,
    [{ id: 'r1', role: 'primary', state: 'started', revision: 7 }],
    [{ beforeUpdate: 1, becomes: { id: 'r1', role: 'primary', state: 'persisted_complete', revision: 8 } }],
  );
  const body = await runPass(db, log, { writes: 1, rereads: 1 });
  assert.equal(log[0].landed, false);
  assert.deepEqual(body.verdicts, [{ runId: 'r1', result: 'won_by_a_later_write', from: 'persisted_complete' }]);
});

test('55 runtime — the CUTOFF is the request time minus the preregistered grace', async () => {
  // ⚠️ A SOURCE PIN ON THE CONSTANT'S NAME IS SATISFIED BY THE IMPORT LINE. `const cutoff = at;`
  // removes the grace entirely and keeps `grace_seconds: 2600` in the response, so the wire value
  // and the echoed value still agree with each other. Only a wall-clock bound catches it.
  const db = installDbStub();
  const { log } = installFakeTable(db, [{ id: 'r1', role: 'primary', state: 'started', revision: 3 }]);
  const before = Date.now();
  const body = await runPass(db, log, { writes: 1, rereads: 0 });
  const after = Date.now();

  const [select] = db.matching(STALE_SELECT);
  assert.equal(db.matching(STALE_SELECT).length, 1, 'one stale-row select');
  const bound = Date.parse(String(select.params[0]));
  assert.ok(Number.isFinite(bound), `the bound cutoff is not a timestamp: ${String(select.params[0])}`);
  assert.equal(String(select.params[0]), body.cutoff, 'the wire value and the echoed value agree');
  assert.equal(body.grace_seconds, 2600);
  const grace = 2_600_000;
  assert.ok(
    before - grace <= bound && bound <= after - grace,
    `cutoff ${new Date(bound).toISOString()} is not within [${new Date(before - grace).toISOString()}, `
    + `${new Date(after - grace).toISOString()}] — the grace is not being subtracted`,
  );
});

test('55 runtime — a FORBIDDEN transition is refused, and nothing is written', async () => {
  // ⚠️ FAULT INJECTION, BECAUSE NO VALID ROW REACHES THIS BRANCH. `ALLOWED_TRANSITIONS` permits all
  // four states the reconciler can assign, so the refusal is unreachable with the real table — and
  // an unreachable defensive branch is exactly where "move the check to after the UPDATE" hides.
  const started = ALLOWED_TRANSITIONS.started;
  const mutable = ALLOWED_TRANSITIONS as Record<string, readonly string[]>;
  mutable.started = started.filter((t) => t !== 'aborted');
  try {
    const db = installDbStub();
    const { live, log } = installFakeTable(db, [{ id: 'r1', role: 'primary', state: 'started', revision: 5 }]);
    const body = await runPass(db, log, { writes: 0, rereads: 0 });
    assert.deepEqual(body.verdicts, [{
      runId: 'r1', result: 'transition_not_allowed', from: 'started', to: 'aborted',
    }]);
    // The row is untouched — which is the half that a refusal moved to AFTER the write would fail.
    assert.deepEqual(live.get('r1'), { id: 'r1', role: 'primary', state: 'started', revision: 5 });
  } finally {
    mutable.started = started;
  }
});

// ⚠️ THE ROUTE ARTIFACT PIN IS NOT IN THIS FILE, AND MUST NOT BE MOVED BACK INTO IT.
// It lives in `reconciler-route-artifact.test.ts`, which imports four node builtins and nothing
// else. THIS file imports the route at module scope, which EXECUTES it — so a hash read from here
// is read by a process the measured artifact got to configure first. Five attacks survived exactly
// that ordering. The split is the fix; tidying it away would undo all of it.

// ════════════════════════════════════════════════════════════════════════════════════════════════
// THE TRANSPORT — the stub must refuse what it cannot model
// ════════════════════════════════════════════════════════════════════════════════════════════════

test('the stub fails CLOSED on every body it does not model', () => {
  // A neon batch. This is what A9 rode in on: no `query`, so the old unchecked cast produced
  // `undefined`, and every classifier tested the string "undefined" and matched nothing.
  assert.throws(
    () => decodeCall(JSON.stringify({ queries: [{ query: 'UPDATE opd_audit_retrieval_telemetry SET x = 1', params: [] }] })),
    UnsupportedStubTransportError,
  );
  assert.throws(() => decodeCall('not json at all'), UnsupportedStubTransportError);
  assert.throws(() => decodeCall(JSON.stringify(['an', 'array'])), UnsupportedStubTransportError);
  assert.throws(() => decodeCall(JSON.stringify('a bare string')), UnsupportedStubTransportError);
  assert.throws(() => decodeCall(JSON.stringify(42)), UnsupportedStubTransportError);
  assert.throws(() => decodeCall(JSON.stringify({ query: 7, params: [] })), UnsupportedStubTransportError);
  assert.throws(() => decodeCall(JSON.stringify({ query: 'SELECT 1', params: 'nope' })), UnsupportedStubTransportError);
  assert.throws(() => decodeCall(JSON.stringify({ params: [] })), UnsupportedStubTransportError);
  // …and the one shape it does model still decodes.
  assert.deepEqual(decodeCall(JSON.stringify({ query: 'SELECT 1', params: ['a'] })), { query: 'SELECT 1', params: ['a'] });
});

// ════════════════════════════════════════════════════════════════════════════════════════════════
// BEHAVIOUR — what the artifact pin cannot say, kept so a deliberate change fails LEGIBLY
// ════════════════════════════════════════════════════════════════════════════════════════════════
//
// A hash says the file has not changed. It says nothing about what the file DOES, and a future
// change that updates the baseline would sail past it. These are the diagnostics.

/** The stale-row selection, complete and hard-coded, as the update is. */
const PINNED_STALE_SELECT = [
  'SELECT retrieval_run_id, retrieval_role, persistence_state, row_revision',
  'FROM opd_audit_retrieval_telemetry',
  "WHERE persistence_state IN ('started', 'retrieval_complete')",
  'AND started_at < $1',
  'ORDER BY started_at',
  'LIMIT $2',
].join(' ');

test('55 behaviour — the SELECT sent at run time is the complete pinned selection', () => {
  const db = installDbStub();
  const { log } = installFakeTable(db, [{ id: 'r1', role: 'primary', state: 'started', revision: 3 }]);
  return runPass(db, log, { writes: 1, rereads: 0 }).then(() => {
    // ⚠️ THE STATEMENT, NOT ONLY THE BOUND CUTOFF. `RECONCILER_SELECT_SQL.replace('AND started_at <
    // $1', 'AND ($1 IS NOT NULL)')` leaves the constant byte-identical and the bound parameter
    // unchanged — the grace is computed and passed, and simply no longer filters anything.
    const [select] = db.matching(STALE_SELECT);
    assert.equal(select.query.replace(/\s+/g, ' ').trim(), PINNED_STALE_SELECT);
    assert.match(select.query, /AND started_at < \$1/);
  });
});

test('55 behaviour — the first write binds the revision the SELECTION returned', async () => {
  // ⚠️ NOT WHATEVER THE ROW SAYS NOW. Re-reading the revision immediately before the write and
  // binding that leaves the pinned statement byte-identical and makes the compare-and-set vacuous:
  // it would then always match. The row is moved to revision 8 before the write is evaluated, and
  // the write must still bind 7 — the value the pass decided on.
  const db = installDbStub();
  const { log } = installFakeTable(
    db,
    [{ id: 'r1', role: 'primary', state: 'started', revision: 7 }],
    [{ beforeUpdate: 1, becomes: { id: 'r1', role: 'primary', state: 'started', revision: 8 } }],
  );
  await runPass(db, log, { writes: 2, rereads: 1 });
  assert.equal(log[0].params[1], '7', 'the first write bound a revision it re-read rather than the one it selected');
  assert.equal(log[0].landed, false);
});

test('55 behaviour — a transport error on the write is a 500, never a fabricated verdict', async () => {
  // ⚠️ A PER-ROW `catch` PUSHING `{ result: 'reconciled' }` RETURNS 200 AND `ok: true` WITH NOTHING
  // WRITTEN. Every other case here asserts 200, so none of them could ever have seen it.
  const db = installDbStub();
  db.on(INVOCATION_WRITE, []);
  db.on(FAILURE_PHASES, []);
  db.on(TOUCHES_TELEMETRY_TABLE, new Error('connection reset'));
  db.on(STALE_SELECT, [{
    retrieval_run_id: 'r1', retrieval_role: 'primary', persistence_state: 'started', row_revision: 3,
  }]);

  const res = await GET(cronRequest());
  assert.equal(res.status, 500, 'a failed write reported success');
  const body = await res.json() as { ok: boolean; verdicts?: unknown[] };
  assert.equal(body.ok, false);
  assert.equal(body.verdicts, undefined, 'no verdict is invented for a row that was never written');
});

test('55 behaviour — a SECOND conflict on the reread path stops after two writes and one reread', async () => {
  // The reread is allowed once. A blind revision walk — sixty-four attempts hunting for one that
  // lands — reaches no branch any other case exercises, and the counts are what refuse it.
  const db = installDbStub();
  const { log } = installFakeTable(
    db,
    [{ id: 'r1', role: 'primary', state: 'started', revision: 7 }],
    [
      { beforeUpdate: 1, becomes: { id: 'r1', role: 'primary', state: 'retrieval_complete', revision: 8 } },
      { beforeUpdate: 2, becomes: { id: 'r1', role: 'primary', state: 'retrieval_complete', revision: 9 } },
    ],
  );
  const body = await runPass(db, log, { writes: 2, rereads: 1 });
  assert.deepEqual(log.map((u) => u.landed), [false, false], 'neither write landed');
  assert.deepEqual(body.verdicts, [{ runId: 'r1', result: 'won_by_a_later_write', from: 'retrieval_complete' }]);
});

test('55 summary — a slice of TERMINAL rows tallies no reconciliations at all', async () => {
  // ⚠️ `tally` WAS ASSERTED NOWHERE, and `more_may_remain` only as a substring of the route source —
  // which a shim keeps pristine. Relabelling every verdict `reconciled` therefore reported three
  // reconciliations over three rows nothing was written to, and no case looked.
  const db = installDbStub();
  const { log } = installFakeTable(db, [
    { id: 'r-a', role: 'primary', state: 'persisted_complete', revision: 4 },
    { id: 'r-b', role: 'primary', state: 'aborted', revision: 9 },
  ]);
  const body = await runPass(db, log, { writes: 0, rereads: 0 });
  assert.deepEqual(body.tally, { won_by_a_later_write: 2 });
  assert.deepEqual(Object.keys(body.tally).filter((k) => k.startsWith('reconciled')), [],
    'a terminal row cannot be reconciled, and must not be counted as one');
  assert.equal(body.verdicts.every((v) => v.result === 'won_by_a_later_write'), true);
  assert.equal(body.selected, 2);
});

test('55 summary — more_may_remain is TRUE on a full slice and FALSE on a short one', async () => {
  // A full slice means there is more behind it. Hard-coding it false reads as "everything was
  // covered", which is the one thing a bounded pass must never imply.
  const full = installDbStub();
  const a = installFakeTable(full, [{ id: 'r1', role: 'primary', state: 'started', revision: 3 }]);
  const fullBody = await runPass(full, a.log, { writes: 1, rereads: 0 }, '?limit=1');
  assert.equal(fullBody.limit, 1);
  assert.equal(fullBody.selected, 1);
  assert.equal(fullBody.more_may_remain, true, 'selected === limit, so the slice was truncated');

  const short = installDbStub();
  const b = installFakeTable(short, [{ id: 'r1', role: 'primary', state: 'started', revision: 3 }]);
  const shortBody = await runPass(short, b.log, { writes: 1, rereads: 0 });
  assert.equal(shortBody.limit, 500);
  assert.equal(shortBody.more_may_remain, false);
});

test('55 behaviour — an unauthenticated request is 401 and touches the database not at all', async () => {
  // ⚠️ `authed()` SHORT-CIRCUITED TO `true` PASSED EVERY CASE, because every case sent the cron
  // header. This route rewrites rows; unauthenticated reachability is the whole exposure.
  const db = installDbStub();
  installFakeTable(db, [{ id: 'r1', role: 'primary', state: 'started', revision: 3 }]);
  const res = await GET(new NextRequest('https://cdmss.invalid/api/admin/retrieval-telemetry-reconcile'));
  assert.equal(res.status, 401);
  assert.deepEqual(await res.json(), { error: 'unauthorized' });
  assert.equal(db.calls.length, 0, 'an unauthenticated request reached the database');
});

// ════════════════════════════════════════════════════════════════════════════════════════════════
// 58 — the shared duration constant and the worker route literal agree
// ════════════════════════════════════════════════════════════════════════════════════════════════

test('58 — WORKER_MAX_DURATION_SECONDS equals the worker route\'s own maxDuration literal', () => {
  // The constant is new; the route literal is what production has always run on. A grace derived
  // from a number that silently moved is worse than no reconciler.
  const m = /^export const maxDuration = (\d+);$/m.exec(WORKER_ROUTE);
  assert.ok(m, 'the worker route still declares maxDuration as a top-level literal');
  assert.equal(Number(m[1]), WORKER_MAX_DURATION_SECONDS);
  // The grace itself, recorded here so a change to it changes a test as well as a report.
  assert.equal(RECONCILER_GRACE_SECONDS, 1800);
  assert.equal(RECONCILER_STALE_AFTER_SECONDS, WORKER_MAX_DURATION_SECONDS + RECONCILER_GRACE_SECONDS);
  assert.equal(RECONCILER_STALE_AFTER_SECONDS, 2600);
  // ⚠️ NOT READ FROM THE ENVIRONMENT. A preregistered value that can be changed by setting a
  // variable is not preregistered.
  const cfg = readFileSync('lib/opd-audit-runtime-config.ts', 'utf8');
  assert.equal(/process\.env/.test(cfg), false, 'the runtime config reads no environment variable');
  assert.ok(RECONCILER.includes('RECONCILER_STALE_AFTER_SECONDS'), 'and the route uses the constant, not a number');
});

// ════════════════════════════════════════════════════════════════════════════════════════════════
// 59 — the reconciler cron does not overlap the worker window
// ════════════════════════════════════════════════════════════════════════════════════════════════

/** The hours a `m h * * *`-style cron fires on. Only the shapes this file's crons actually use. */
function hoursOf(schedule: string): number[] {
  const hourField = schedule.split(/\s+/)[1];
  if (hourField === '*') return Array.from({ length: 24 }, (_, i) => i);
  const out = new Set<number>();
  for (const part of hourField.split(',')) {
    const m = /^(\d+)(?:-(\d+))?$/.exec(part);
    assert.ok(m, `unhandled hour field: ${hourField}`);
    const from = Number(m[1]);
    const to = m[2] === undefined ? from : Number(m[2]);
    for (let h = from; h <= to; h += 1) out.add(h);
  }
  return [...out];
}

test('59 — the reconciler fires at 10:01 UTC, outside every hour the OPD worker runs', () => {
  const reconciler = VERCEL.crons.find((c) => c.path === '/api/admin/retrieval-telemetry-reconcile');
  assert.ok(reconciler, 'the reconciler cron exists');
  assert.equal(reconciler.schedule, '1 10 * * *');

  const worker = VERCEL.crons.find((c) => c.path === '/api/opd-audit/worker');
  assert.ok(worker, 'the OPD worker cron exists');
  const workerHours = hoursOf(worker.schedule);
  const reconcilerHours = hoursOf(reconciler.schedule);
  for (const h of reconcilerHours) {
    assert.equal(workerHours.includes(h), false, `hour ${h} is inside the worker window ${worker.schedule}`);
  }
  // ⚠️ THE WINDOW WRAPS MIDNIGHT (18-23,0-2), so the distance is CIRCULAR. Subtracting the last
  // hour from the first would report -13 and read as an overlap that is not there.
  const circular = (a: number, b: number) => Math.min(Math.abs(a - b), 24 - Math.abs(a - b));
  const gapHours = Math.min(...workerHours.map((h) => circular(h, reconcilerHours[0])));
  assert.ok(gapHours >= 1, `only ${gapHours}h from the nearest worker hour to the reconciler`);
  assert.equal(gapHours, 8, 'eight hours clear on either side of the window');

  // Off the even minute, deliberately: minute 0 and every even minute already carry crons.
  const minute = Number(reconciler.schedule.split(/\s+/)[0]);
  assert.equal(minute % 2, 1, 'an odd minute keeps it clear of the */2 backfill ticks');
});

// ════════════════════════════════════════════════════════════════════════════════════════════════
// 64 — the two cron-count tests read 17, and NOTHING ELSE in either file changed
// ════════════════════════════════════════════════════════════════════════════════════════════════

const CRON_COUNT_FILES = [
  'lib/__tests__/provider-switch-unit-d.test.ts',
  'lib/__tests__/ipd-worker-batch-and-model.test.ts',
] as const;

test('64 — both files assert 17, and neither still asserts 16', () => {
  assert.equal(VERCEL.crons.length, 17);
  for (const f of CRON_COUNT_FILES) {
    const src = readFileSync(f, 'utf8');
    assert.match(src, /crons\.length, 17/, `${f} reads 17`);
    assert.equal(/crons\.length, 16/.test(src), false, `${f} has no stale 16`);
  }
});

/**
 * The BYTE COMPARISON of the untouched regions kickoff v11 line 1178 asks for, and which the
 * previous version of this test did not do — replacing line 273 of `provider-switch-unit-d.test.ts`
 * with `assert.ok(true);` left every case here green.
 *
 * The method: undo the ONE authorised edit in memory, then hash the whole file and compare against
 * what it hashed to at `177adc9`. Nothing about the file except that line may differ, and the hash
 * covers every byte of it. The baselines are stored HERE, outside the two files being hashed, and
 * are not derived from the current source at run time — a hash computed from the thing it is meant
 * to check is a tautology, and git is not consulted from a test.
 *
 * ⚠️ WHAT A CONTENT HASH CANNOT SEE, and what is done about it. `chmod 777` on either file, and
 * replacing either with a symlink to byte-identical content, both passed every case in the previous
 * version of this test — and there were no "commit-shape checks" anywhere in the repository to catch
 * them, which is what that sentence used to claim. A rename IS caught here, because the read throws.
 * The `lstat` gate below closes the other two before either file is read.
 *
 * ⚠️ AND WHAT REMAINS OUTSIDE THE CONTRACT, DELIBERATELY: mtime, uid, gid, ACLs and extended
 * attributes. Git preserves none of them, so a test that asserted them would fail on a fresh clone.
 *
 * ── RE-BASELINE PROCEDURE (addendum v1 item 1b, 13 Aug 2026) ────────────────────────────────────
 * When a legitimate change to either hashed file makes this case fail, this is the whole procedure.
 * It is written here because the failure message names no fix, and an undocumented pin is one a
 * later reader re-baselines by guesswork or deletes.
 *
 *   1. Confirm the cron-count edit is the only intended change to the file.
 *   2. Take the file AS IT NOW STANDS, replace the authorised line with its historical form in
 *      memory, and hash the result with SHA-256.
 *   3. Replace `sha256At177adc9`, and `line` if the line number moved.
 *   4. State the change and the reason in the build report.
 *
 * ⚠️ AND RENAME THE CONSTANT WHEN THAT HAPPENS. After any edit other than the cron count, the name
 * `sha256At177adc9` stops being true: the baseline is then the file at the LATER commit with one
 * line reverted, not the file at `177adc9`. A name that quietly stops describing its value is how a
 * pin turns into decoration.
 */
const CRON_BASELINE = [
  {
    file: 'lib/__tests__/provider-switch-unit-d.test.ts',
    line: 270,
    current: '  assert.equal(cfg.crons.length, 17);',
    historical: '  assert.equal(cfg.crons.length, 16);',
    sha256At177adc9: '07119f83d03b98614e55b886b812bb8b0d30515bdfa6086b98d7e14e90b3ce66',
  },
  {
    file: 'lib/__tests__/ipd-worker-batch-and-model.test.ts',
    line: 57,
    current: "  assert.equal(VERCEL.crons.length, 17, '14 + the restored IPD worker + the readmission worker + the retrieval-telemetry reconciler');",
    historical: "  assert.equal(VERCEL.crons.length, 16, '14 + the restored IPD worker + the readmission worker');",
    sha256At177adc9: '05c935ca7ed81be95b26bb5703317769670d5ec4c0ca49660098b8a6d34ec78a',
  },
] as const;

test('64 — undo the one authorised line and each file hashes to exactly what it did at 177adc9', () => {
  for (const b of CRON_BASELINE) {
    // ⚠️ BEFORE A SINGLE BYTE IS READ. A symlink to identical content, or a second hard link, gives
    // the same hash and is not the same file. `lstat`, not `stat`, so the symlink is seen rather
    // than followed.
    //
    // ⚠️ AND NO MODE ASSERTION, DELIBERATELY (addendum v1 item 1, 13 Aug 2026). Git records exactly
    // one permission bit — the executable bit — so a tree entry for a regular file is `100644` or
    // `100755` and the group and other bits are never stored at all. A permission change that leaves
    // the executable bit alone (`chmod 640`, `chmod 664`) therefore changes neither the blob nor the
    // tree entry, and is not a change to the committed object. A change that DOES flip that bit is
    // reported by `git status` on its own, without a test. What used to stand here asserted mode
    // 644, which protected nothing about the artifact and failed on any checkout whose umask
    // differed from the author's.
    const st = lstatSync(b.file);
    assert.equal(st.isSymbolicLink(), false, `${b.file} is a symlink`);
    assert.equal(st.isFile(), true, `${b.file} is not a regular file`);
    assert.equal(st.nlink, 1, `${b.file} has ${st.nlink} hard links`);

    const lines = readFileSync(b.file, 'utf8').split('\n');
    assert.equal(
      lines.filter((l) => l === b.current).length, 1,
      `${b.file}: the authorised line must occur exactly once, verbatim`,
    );
    assert.equal(
      lines.filter((l) => l === b.historical).length, 0,
      `${b.file}: the historical line must not still be present`,
    );
    const at = lines.indexOf(b.current);
    assert.equal(at + 1, b.line, `${b.file}: the authorised line is at line ${b.line}`);
    lines[at] = b.historical;
    assert.equal(
      createHash('sha256').update(lines.join('\n'), 'utf8').digest('hex'), b.sha256At177adc9,
      `${b.file}: something OTHER than the cron count changed`,
    );
  }
});

test('64 — provider-switch-unit-d\'s sql-guard assertion is untouched, and is nowhere near line 270', () => {
  const lines = readFileSync('lib/__tests__/provider-switch-unit-d.test.ts', 'utf8').split('\n');
  // The kickoff says line 255 holds this and line 1073 says 257. The TREE says 255 is the test
  // title and 257 is the assertion; both are re-read here rather than restated.
  assert.match(lines[254], /^test\('lib\/sql-guard-core\.ts was NOT edited by this build'/);
  assert.match(lines[256], /assert\.ok\(guard\.includes\('const BLOCKED_RELATIONS = /);
  assert.ok(
    lines[256].includes('traces|trace_events|appropriateness_runs|ccb_briefs|care_track_assignments|opd_audit_feedback'),
    'the blocked-relation literal is byte-identical',
  );
});

/**
 * lib/__tests__/retrieval-invocation-store.test.ts — kickoff tests 28, 29, 30 and 62, and the two
 * declaration defects they surfaced.
 *
 * ⚠️ DEFECT ONE: `declared_retrievals` COUNTED WHAT WAS ASKED FOR. The insert ends
 * `ON CONFLICT (retrieval_run_id) DO NOTHING` and carried no `RETURNING`, so the increment bound
 * `runs.length` — the number of rows the caller WANTED. D11 says the opposite: "declared_retrievals
 * counts newly inserted run ids only". Unreachable while both callers passed fresh UUIDs; live the
 * moment an adoption path exists, and it inflates the denominator every coverage percentage
 * divides by.
 *
 * ⚠️ DEFECT TWO: A FAILED DECLARATION WROTE NO EVIDENCE. `declareRetrievals` had no try, so a throw
 * propagated and left nothing behind. `work_declaration` is in the failure-phase union and in the
 * migration's CHECK, and no code path ever wrote one. D13 is explicit that this failure produces no
 * retrieval row and that "its evidence lives only in the failure table" — so with no writer, a
 * failed declaration was invisible everywhere.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { installDbStub, classedError, type DbStub } from './telemetry-db-stub';
import { declareRetrievals, type DeclareInput } from '../retrieval-telemetry-store';
import { startInvocation, closeInvocation, bumpTelemetryWriteFailure } from '../retrieval-invocation-store';
import type { TelemetryRequestContext } from '../retrieval-telemetry-core';

const INSERT_RUNS = /INSERT INTO opd_audit_retrieval_telemetry/;
const INSERT_INVOCATION = /INSERT INTO opd_retrieval_invocations/;
const BUMP_DECLARED = /SET declared_retrievals = declared_retrievals \+ \$2/;
const BUMP_FAILURES = /SET telemetry_write_failures = telemetry_write_failures \+ 1/;
const INSERT_FAILURE = /INSERT INTO opd_retrieval_telemetry_failures/;

const ctx: TelemetryRequestContext = {
  invocationId: 'inv-1', route: 'opd_audit_worker', routeClass: 'worker',
  deploymentSha: 'sha-1', vercelRequestId: 'req-1', startedAt: '2026-08-12T00:00:00.000Z',
  routingFlags: {},
};

const inputs = (...ids: string[]): DeclareInput[] =>
  ids.map((runId) => ({ role: 'primary' as const, runId, uid: 'u-1', engineVersion: '0.81.21' }));

/** Every declared run lands. The shape a healthy declaration has. */
function allLand(db: DbStub): void {
  db.on(INSERT_RUNS, (c) => {
    // One id per 14-column group, in bound order.
    const ids: unknown[] = [];
    for (let i = 0; i < c.params.length; i += 14) ids.push(c.params[i]);
    return ids.map((retrieval_run_id) => ({ retrieval_run_id: String(retrieval_run_id) }));
  });
}

// ════════════════════════════════════════════════════════════════════════════════════════════════
// 28 — the multi-row declaration insert shape
// ════════════════════════════════════════════════════════════════════════════════════════════════

test('28 — ONE multi-row insert, app_source bound explicitly, no stamper involved', async () => {
  const db = installDbStub();
  allLand(db);
  await declareRetrievals(ctx, inputs('r1', 'r2', 'r3'), 'will_persist');

  const [insert] = db.matching(INSERT_RUNS);
  assert.equal(db.matching(INSERT_RUNS).length, 1, 'one statement for three notes, not three');
  assert.equal(insert.params.length, 42, '14 columns × 3 rows');
  assert.match(insert.query, /VALUES \(\$1, \$2, .*\$14\), \(\$15,/s, 'a real multi-row VALUES list');
  assert.match(insert.query, /ON CONFLICT \(retrieval_run_id\) DO NOTHING/);
  // ⚠️ THE STAMPER IS NOT INVOLVED, AND MUST NOT BE (D10). `injectAppSource` rewrites a single
  // VALUES group and bails on a nested paren; a multi-row declaration must not depend on a regex.
  // The proof is that app_source is a COLUMN IN THE STATEMENT with a bound position of its own.
  assert.match(insert.query, /app_source/);
  assert.equal((insert.query.match(/app_source/g) || []).length, 1, 'named once — not appended a second time');
});

test('62 — app_source binds APP_SOURCE when set, and \'standalone\' when absent, never null', async () => {
  const before = process.env.APP_SOURCE;
  try {
    for (const [set, expected] of [['portal', 'portal'], [undefined, 'standalone']] as const) {
      if (set === undefined) delete process.env.APP_SOURCE; else process.env.APP_SOURCE = set;
      const db = installDbStub();
      allLand(db);
      await declareRetrievals(ctx, inputs('r1'), 'will_persist');
      // Position 5 of the 14: retrieval_run_id, retrieval_role, route, invocation_id, app_source.
      assert.equal(db.matching(INSERT_RUNS)[0].params[4], expected, `APP_SOURCE=${String(set)}`);
      assert.notEqual(db.matching(INSERT_RUNS)[0].params[4], null,
        'a bound undefined reaches Postgres as NULL and FAILS a NOT NULL column — the default is not a rescue');
    }
  } finally {
    if (before === undefined) delete process.env.APP_SOURCE; else process.env.APP_SOURCE = before;
  }
});

test('the three A/A experiment columns are BOUND, so opd_art_experiment_idx is populable', async () => {
  const db = installDbStub();
  allLand(db);
  await declareRetrievals(ctx, [{
    role: 'primary', runId: 'r1', uid: 'u-1', engineVersion: '0.81.21',
    experimentRunId: 'exp-9', pairId: 'pair-4', replicate: 'b',
  }], 'will_persist');
  const [insert] = db.matching(INSERT_RUNS);
  assert.match(insert.query, /experiment_run_id, pair_id, replicate/);
  assert.deepEqual(insert.params.slice(11, 14), ['exp-9', 'pair-4', 'b']);
  // Absent is null, never undefined: an undefined bound value is a NULL to Postgres either way, but
  // only one of the two is written down as a decision.
  const db2 = installDbStub();
  allLand(db2);
  await declareRetrievals(ctx, inputs('r2'), 'will_persist');
  assert.deepEqual(db2.matching(INSERT_RUNS)[0].params.slice(11, 14), [null, null, null]);
});

// ════════════════════════════════════════════════════════════════════════════════════════════════
// D11 — declared_retrievals counts what LANDED
// ════════════════════════════════════════════════════════════════════════════════════════════════

test('declared_retrievals counts the rows that LANDED, not the rows that were asked for', async () => {
  const db = installDbStub();
  // Three declared; one of them was already declared by somebody else, so ON CONFLICT swallows it.
  db.on(INSERT_RUNS, [{ retrieval_run_id: 'r1' }, { retrieval_run_id: 'r3' }]);
  await declareRetrievals(ctx, inputs('r1', 'r2', 'r3'), 'will_persist');

  assert.match(db.matching(INSERT_RUNS)[0].query, /RETURNING retrieval_run_id/,
    'the statement asks which rows landed — without this the count cannot be known');
  const [bump] = db.matching(BUMP_DECLARED);
  assert.equal(bump.params[1], '2', 'two landed, so the denominator moves by two');
});

test('a declaration that lands nothing bumps nothing at all', async () => {
  const db = installDbStub();
  db.on(INSERT_RUNS, []);
  await declareRetrievals(ctx, inputs('r1'), 'will_persist');
  assert.equal(db.matching(BUMP_DECLARED).length, 0, 'an adopted run was already counted by its declarer');
});

test('an empty run list writes nothing and returns an empty handle', async () => {
  const db = installDbStub();
  const handle = await declareRetrievals(ctx, [], 'never_persists');
  assert.deepEqual(handle, { invocationId: 'inv-1', runs: [], persistenceIntent: 'never_persists' });
  assert.equal(db.calls.length, 0);
});

// ════════════════════════════════════════════════════════════════════════════════════════════════
// 29 — a failed declaration writes one failure row per generated run
// ════════════════════════════════════════════════════════════════════════════════════════════════

test('29 — a failed batch declaration writes ONE work_declaration failure row per generated run', async () => {
  const db = installDbStub();
  db.on(INSERT_RUNS, classedError('NeonDbError'));
  db.on(INSERT_FAILURE, []);

  await assert.rejects(
    () => declareRetrievals(ctx, inputs('r1', 'r2'), 'will_persist'),
    /NeonDbError/,
    'the throw still propagates — the worker declaration is fail-closed (D10)',
  );

  const failures = db.matching(INSERT_FAILURE);
  assert.equal(failures.length, 2, 'one row per run the batch was going to declare');
  for (const [i, id] of ['r1', 'r2'].entries()) {
    // (invocation_id, retrieval_run_id, retrieval_role, failed_phase, intended_state, observed_at, error_class)
    assert.equal(failures[i].params[0], 'inv-1');
    assert.equal(failures[i].params[1], id);
    assert.equal(failures[i].params[2], 'primary');
    assert.equal(failures[i].params[3], 'work_declaration');
    assert.equal(failures[i].params[4], 'started');
    assert.equal(failures[i].params[6], 'NeonDbError', 'a CLASS name, never a message');
  }
  assert.equal(db.matching(BUMP_DECLARED).length, 0, 'and nothing is counted as declared');
});

test('29 — a run-scoped failure phase with no run id is refused before it reaches the CHECK', async () => {
  const db = installDbStub();
  db.on(INSERT_FAILURE, []);
  const { recordTelemetryFailure } = await import('../retrieval-telemetry-failure-store');
  const ok = await recordTelemetryFailure({
    invocationId: 'inv-1', retrievalRunId: null, retrievalRole: null,
    failedPhase: 'work_declaration', intendedState: 'started',
    errorClass: 'X', observedAt: ctx.startedAt,
  });
  assert.equal(ok, false, 'refused locally, so it reads as a call error and not a database problem');
  assert.equal(db.matching(INSERT_FAILURE).length, 0, 'nothing is sent');
});

test('29 — when the failure store ITSELF fails, the invocation counter is the last evidence', async () => {
  const db = installDbStub();
  db.on(INSERT_RUNS, classedError('NeonDbError'));
  db.on(INSERT_FAILURE, classedError('AlsoDown'));
  db.on(BUMP_FAILURES, []);
  await assert.rejects(() => declareRetrievals(ctx, inputs('r1'), 'will_persist'));
  assert.equal(db.matching(BUMP_FAILURES).length, 1);
  assert.deepEqual(db.matching(BUMP_FAILURES)[0].params, ['inv-1']);
});

// ════════════════════════════════════════════════════════════════════════════════════════════════
// 30 — the invocation row is fail-open
// ════════════════════════════════════════════════════════════════════════════════════════════════

test('30 — an invocation insert failure is fail-open, and leaves evidence', async () => {
  const db = installDbStub();
  db.on(INSERT_INVOCATION, classedError('NeonDbError'));
  db.on(INSERT_FAILURE, []);
  await startInvocation(ctx);   // must not throw: the retrieval proceeds uninstrumented
  const failures = db.matching(INSERT_FAILURE);
  assert.equal(failures.length, 1);
  assert.equal(failures[0].params[3], 'invocation_start');
  assert.equal(failures[0].params[1], null, 'no run is implicated — the phase is not run-scoped');
});

test('30 — the invocation row is inserted once, with its kind and route class', async () => {
  const db = installDbStub();
  db.on(INSERT_INVOCATION, []);
  await startInvocation(ctx);
  const [ins] = db.matching(INSERT_INVOCATION);
  assert.match(ins.query, /ON CONFLICT \(invocation_id\) DO NOTHING/);
  assert.deepEqual(ins.params.slice(0, 4), ['inv-1', 'retrieval', 'opd_audit_worker', 'worker']);
});

test('closeInvocation is fail-open too, and records a closure failure', async () => {
  const db = installDbStub();
  db.on(/UPDATE opd_retrieval_invocations\n\s+SET ended_at/, classedError('NeonDbError'));
  db.on(INSERT_FAILURE, []);
  await closeInvocation(ctx, '2026-08-12T00:10:00.000Z');
  assert.equal(db.matching(INSERT_FAILURE)[0].params[3], 'closure');
});

test('the write-failure counter never throws, even when its own UPDATE fails', async () => {
  const db = installDbStub();
  db.on(BUMP_FAILURES, classedError('NeonDbError'));
  await bumpTelemetryWriteFailure('inv-1');   // a log line, and nothing else (D12)
  assert.equal(db.matching(BUMP_FAILURES).length, 1);
});

/**
 * lib/__tests__/retrieval-settlement.test.ts — kickoff tests 15, 33 and 51, and the regression for
 * the defect that made every one of them worth writing.
 *
 * ⚠️ THE DEFECT. `settleRetrievalTelemetry` computed one state for the whole handle and mapped
 * `settled`, `noop` AND `rejected` to `{ status: 'settled' }`. `applyTerminalState` returns
 * `rejected` from five places — no row, stale revision, already terminal, disallowed transition and
 * a zero-row update — so five real failures were reported to the caller as success. The worst of
 * them was structural, not incidental: a run still at revision 0 (its terminal write never landed)
 * was given the ordinary outcome state, which D12's transition table forbids from `started`, so the
 * row stayed `started` for ever while its owner was told it had settled. D9 asks for the opposite:
 * such a run is NOT linked, and is settled FROM THE FAILURE EVIDENCE.
 *
 * These tests exercise the real module against a stubbed transport (see telemetry-db-stub.ts), so
 * the statements and the bound parameters they assert are the ones that would reach Postgres.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { installDbStub, classedError, type DbStub } from './telemetry-db-stub';
import {
  settleRetrievalTelemetry, outcomeForSaveResult,
} from '../retrieval-settlement';
import {
  writeRetrievalTerminal, SETTLEMENT_REJECTIONS,
  type LifecycleHandle,
} from '../retrieval-telemetry-store';
import { createTelemetryCapture, buildRetrievalPayload } from '../retrieval-capture';
import type { OperationalTelemetry } from '../retrieval-telemetry-core';
import {
  SETTLEMENT_OUTCOMES, stateForSettlement, isAllowedTransition,
  type SettlementOutcome,
} from '../retrieval-telemetry-core';

const SELECT_ROW = /SELECT persistence_state, row_revision, audit_id/;
const UPDATE_ROW = /UPDATE opd_audit_retrieval_telemetry\n\s+SET persistence_state/;
const SELECT_PHASES = /SELECT failed_phase/;
const INSERT_FAILURE = /INSERT INTO opd_retrieval_telemetry_failures/;

const AT = '2026-08-12T00:00:00.000Z';
const AUDIT = '11111111-1111-1111-1111-111111111111';

function handleOf(runs: LifecycleHandle['runs']): LifecycleHandle {
  return { invocationId: 'inv-1', runs, persistenceIntent: 'will_persist' };
}

/** The row the SELECT returns, and an UPDATE that lands. The shape every happy path needs. */
function happyRow(db: DbStub, state: string, revision: number): void {
  db.on(SELECT_ROW, [{ persistence_state: state, row_revision: revision, audit_id: null }]);
  db.on(UPDATE_ROW, (c) => [{ row_revision: (c.params[1] as number) + 1 }]);
}

// ════════════════════════════════════════════════════════════════════════════════════════════════
// 51 — the mapper, exhaustively against D9's table
// ════════════════════════════════════════════════════════════════════════════════════════════════

test('51 — every settlement outcome has a state, and the mapping is D9\'s table exactly', () => {
  // Hand-typed here on purpose: this is the copy of D9 the code is checked AGAINST. Deriving it
  // from SETTLEMENT_STATE would assert that the module agrees with itself.
  const D9: Record<SettlementOutcome, string> = {
    persisted_clean: 'persisted_complete',
    persisted_dirty: 'persisted_partial',
    losing_conflict: 'completed_unpersisted',
    persistence_skipped: 'persistence_skipped',
    persistence_refused: 'persistence_refused',
    audit_persistence_failed: 'audit_persistence_failed',
    audit_generation_failed: 'audit_generation_failed',
    no_persistence_intended: 'no_persistence_intended',
    retrieval_not_run: 'retrieval_not_run',
  };
  assert.deepEqual([...SETTLEMENT_OUTCOMES].sort(), Object.keys(D9).sort());
  for (const [outcome, state] of Object.entries(D9) as [SettlementOutcome, string][]) {
    assert.equal(stateForSettlement(outcome), state, `${outcome} settles ${state}`);
  }
  // D9 as amended (addendum v1 item 2, 13 Aug 2026): aborted, persistence_unknown and
  // telemetry_persistence_failed are produced only through `reconcilerStateFor`. This table never
  // names them, which is what is asserted here; settlement may still reach two of them by calling
  // that function for a revision-0 run.
  const produced = new Set(Object.values(D9));
  for (const reconcilerOnly of ['aborted', 'persistence_unknown', 'telemetry_persistence_failed']) {
    assert.equal(produced.has(reconcilerOnly), false, `${reconcilerOnly} is not a settlement outcome`);
  }
});

test('51 — saveOpdAudit\'s four return values each map to their D9 outcome, including skipped', () => {
  assert.equal(outcomeForSaveResult('inserted'), 'persisted_clean');
  assert.equal(outcomeForSaveResult('updated'), 'persisted_clean');
  // A losing ON CONFLICT race is not a failure — D9 sends it to completed_unpersisted.
  assert.equal(outcomeForSaveResult('exists'), 'losing_conflict');
  // Reachable: it is the no-uid branch, and it is a decision rather than a lost write.
  assert.equal(outcomeForSaveResult('skipped'), 'persistence_skipped');
});

test('51 — settlement writes ONCE per run, and the write carries the mapped state and the audit id', async () => {
  const db = installDbStub();
  happyRow(db, 'retrieval_complete', 1);
  const results = await settleRetrievalTelemetry(
    handleOf([{ role: 'primary', runId: 'r1', expectedRevision: 1 }]),
    { outcome: 'persisted_clean', auditId: AUDIT, settledAt: AT },
  );
  assert.deepEqual(results, [{ role: 'primary', runId: 'r1', status: 'settled' }]);
  const updates = db.matching(UPDATE_ROW);
  // Exactly once, asserted directly (D9). An idempotent no-op would hide a double settlement.
  assert.equal(updates.length, 1, 'one UPDATE for one run');
  // ⚠️ THE WIRE FORM, NOT THE JS FORM. The driver renders every bound parameter to text before it
  // leaves the process, so the revision arrives as '1'. Asserting what actually goes over the wire
  // is the point of stubbing the transport rather than the store.
  assert.deepEqual(updates[0].params, ['r1', '1', 'persisted_complete', AUDIT, AT]);
});

// ════════════════════════════════════════════════════════════════════════════════════════════════
// 15 — a recorded retrieval failure does not make a persisted row partial
// ════════════════════════════════════════════════════════════════════════════════════════════════

test('15 — a retrieval_failure with a persisted audit settles persisted_complete, not partial', async () => {
  const db = installDbStub();
  happyRow(db, 'retrieval_complete', 1);
  // The outcome is the OWNER's, and the owner saw a clean save. D17: "A recorded retrieval_failure
  // does not prevent this." Nothing about the retrieval's own outcome column enters this decision.
  const results = await settleRetrievalTelemetry(
    handleOf([{ role: 'primary', runId: 'r1', expectedRevision: 1 }]),
    { outcome: 'persisted_clean', auditId: AUDIT, settledAt: AT },
  );
  assert.equal(results[0].status, 'settled');
  assert.equal(db.matching(UPDATE_ROW)[0].params[2], 'persisted_complete');
});

// ════════════════════════════════════════════════════════════════════════════════════════════════
// 33 — partial settlement, and the revision-0 rule
// ════════════════════════════════════════════════════════════════════════════════════════════════

test('33 — primary settles, normative fails: one settled, one failed, one failure row, nothing thrown', async () => {
  const db = installDbStub();
  db.on(SELECT_ROW, (c) => (c.params[0] === 'r-norm'
    ? classedError('NeonDbError')
    : [{ persistence_state: 'retrieval_complete', row_revision: 1, audit_id: null }]));
  db.on(UPDATE_ROW, (c) => [{ row_revision: (c.params[1] as number) + 1 }]);
  db.on(INSERT_FAILURE, []);

  const results = await settleRetrievalTelemetry(
    handleOf([
      { role: 'primary', runId: 'r-prim', expectedRevision: 1 },
      { role: 'normative_channel', runId: 'r-norm', expectedRevision: 1 },
    ]),
    { outcome: 'persisted_clean', auditId: AUDIT, settledAt: AT },
  );

  assert.equal(results.length, 2);
  assert.deepEqual(results[0], { role: 'primary', runId: 'r-prim', status: 'settled' });
  assert.equal(results[1].status, 'failed');
  assert.equal(results[1].errorClass, 'NeonDbError');
  // ⚠️ ONE role's telemetry problem does not restate the OTHER role's known outcome as unknown.
  const failures = db.matching(INSERT_FAILURE);
  assert.equal(failures.length, 1, 'one persistence_link failure row, for the failed run only');
  assert.equal(failures[0].params[1], 'r-norm');
  assert.equal(failures[0].params[3], 'persistence_link');
});

test('33 — a role still at revision 0 is NOT linked: audit id null, and the state is not the outcome\'s', async () => {
  const db = installDbStub();
  db.on(SELECT_ROW, [{ persistence_state: 'started', row_revision: 0, audit_id: null }]);
  db.on(UPDATE_ROW, [{ row_revision: 1 }]);
  // No failure evidence: nothing was ever heard from this run.
  db.on(SELECT_PHASES, []);

  const results = await settleRetrievalTelemetry(
    handleOf([{ role: 'normative_channel', runId: 'r0', expectedRevision: 0 }]),
    { outcome: 'persisted_clean', auditId: AUDIT, settledAt: AT },
  );

  assert.equal(results[0].status, 'settled');
  const [update] = db.matching(UPDATE_ROW);
  assert.equal(update.params[3], null, 'the audit id is NOT attached to a run that wrote no manifest');
  assert.notEqual(update.params[2], 'persisted_complete', 'and the outcome state is not applied');
});

// ════════════════════════════════════════════════════════════════════════════════════════════════
// THE REGRESSION — D9's second clause: "settled from the failure evidence"
// ════════════════════════════════════════════════════════════════════════════════════════════════

test('revision 0 with retrieval_terminal evidence settles telemetry_persistence_failed', async () => {
  const db = installDbStub();
  db.on(SELECT_ROW, [{ persistence_state: 'started', row_revision: 0, audit_id: null }]);
  db.on(UPDATE_ROW, [{ row_revision: 1 }]);
  db.on(SELECT_PHASES, [{ failed_phase: 'retrieval_terminal' }]);

  const results = await settleRetrievalTelemetry(
    handleOf([{ role: 'primary', runId: 'r0', expectedRevision: 0 }]),
    { outcome: 'persisted_clean', auditId: AUDIT, settledAt: AT },
  );

  assert.deepEqual(results, [{ role: 'primary', runId: 'r0', status: 'settled' }]);
  // The write was ATTEMPTED and failed — that is a different remediation from never having heard
  // again, and D13 gives the two different states.
  assert.equal(db.matching(UPDATE_ROW)[0].params[2], 'telemetry_persistence_failed');
  assert.equal(db.matching(SELECT_PHASES).length, 1, 'the failure evidence is actually read');
});

test('revision 0 with NO evidence settles aborted', async () => {
  const db = installDbStub();
  db.on(SELECT_ROW, [{ persistence_state: 'started', row_revision: 0, audit_id: null }]);
  db.on(UPDATE_ROW, [{ row_revision: 1 }]);
  db.on(SELECT_PHASES, []);
  await settleRetrievalTelemetry(
    handleOf([{ role: 'primary', runId: 'r0', expectedRevision: 0 }]),
    // ⚠️ WAS `persisted_dirty` (v9 §4.1, §8). That value can no longer ARRIVE as a base outcome —
    // it is derived inside settlement by `upgradeForDefects` — and this test's subject is
    // revision-0 behaviour, not the outcome it happens to carry. `persisted_clean` reaches the same
    // branch: it is equally illegal from `started`, so `stateForUnwrittenRun` still decides, and
    // with no failure evidence the answer is still `aborted`.
    { outcome: 'persisted_clean', auditId: AUDIT, settledAt: AT },
  );
  assert.equal(db.matching(UPDATE_ROW)[0].params[2], 'aborted');
});

test('revision 0 KEEPS an outcome a never-retrieved run can honestly carry', async () => {
  // D9's owner matrix: "throw after adoption -> audit_generation_failed", "throw before adoption ->
  // retrieval_not_run". Both are legal from `started`, so the owner's own outcome is the truth and
  // the failure evidence is not consulted at all.
  for (const [outcome, state] of [
    ['audit_generation_failed', 'audit_generation_failed'],
    ['retrieval_not_run', 'retrieval_not_run'],
  ] as const) {
    const db = installDbStub();
    db.on(SELECT_ROW, [{ persistence_state: 'started', row_revision: 0, audit_id: null }]);
    db.on(UPDATE_ROW, [{ row_revision: 1 }]);
    db.on(SELECT_PHASES, [{ failed_phase: 'retrieval_terminal' }]);
    await settleRetrievalTelemetry(
      handleOf([{ role: 'primary', runId: 'r0', expectedRevision: 0 }]),
      { outcome, auditId: AUDIT, settledAt: AT },
    );
    assert.equal(db.matching(UPDATE_ROW)[0].params[2], state);
    assert.equal(db.matching(SELECT_PHASES).length, 0, `${outcome} needs no failure evidence`);
    assert.ok(isAllowedTransition('started', state), `${state} is reachable from started`);
  }
});

test('a REJECTED write is reported as rejected, never as settled, and leaves durable evidence', async () => {
  // Each of the five rejection classes, one at a time. Every one of these used to return `settled`.
  const cases: Array<{ label: string; rejection: string; arrange: (db: DbStub) => void; revision?: number }> = [
    {
      label: 'no row', rejection: 'no_row',
      arrange: (db) => { db.on(SELECT_ROW, []); },
    },
    {
      label: 'stale handle', rejection: 'stale_revision',
      arrange: (db) => { db.on(SELECT_ROW, [{ persistence_state: 'retrieval_complete', row_revision: 4, audit_id: null }]); },
      revision: 1,
    },
    {
      label: 'already terminal', rejection: 'already_terminal',
      arrange: (db) => { db.on(SELECT_ROW, [{ persistence_state: 'persisted_complete', row_revision: 2, audit_id: null }]); },
      revision: 2,
    },
    {
      label: 'disallowed transition', rejection: 'disallowed_transition',
      // `started -> persisted_complete` is not in D12's table. This is the shape the old code hit
      // on every revision-0 run, and reported as success.
      arrange: (db) => { db.on(SELECT_ROW, [{ persistence_state: 'started', row_revision: 2, audit_id: null }]); },
      revision: 2,
    },
    {
      label: 'lost update', rejection: 'lost_update',
      arrange: (db) => {
        db.on(SELECT_ROW, [{ persistence_state: 'retrieval_complete', row_revision: 1, audit_id: null }]);
        db.on(UPDATE_ROW, []);   // somebody moved the row between the SELECT and the UPDATE
      },
      revision: 1,
    },
  ];

  for (const c of cases) {
    const db = installDbStub();
    db.on(INSERT_FAILURE, []);
    c.arrange(db);
    const results = await settleRetrievalTelemetry(
      handleOf([{ role: 'primary', runId: 'r1', expectedRevision: c.revision ?? 1 }]),
      { outcome: 'persisted_clean', auditId: AUDIT, settledAt: AT },
    );
    assert.equal(results[0].status, 'rejected', `${c.label}: not reported as settled`);
    assert.equal(results[0].rejection, c.rejection, `${c.label}: named`);
    const failures = db.matching(INSERT_FAILURE);
    assert.equal(failures.length, 1, `${c.label}: durable evidence, not only a log line`);
    assert.equal(failures[0].params[3], 'persistence_link');
    assert.equal(failures[0].params[6], `settlement_rejected_${c.rejection}`);
  }
});

test('an identical-content retry stays SETTLED and burns no revision', async () => {
  const db = installDbStub();
  db.on(SELECT_ROW, [{ persistence_state: 'persisted_complete', row_revision: 2, audit_id: AUDIT }]);
  const results = await settleRetrievalTelemetry(
    handleOf([{ role: 'primary', runId: 'r1', expectedRevision: 2 }]),
    { outcome: 'persisted_clean', auditId: AUDIT, settledAt: AT },
  );
  // A retry of a write that already landed is not a second event, and it is not a rejection either:
  // D12 puts the no-op check FIRST, before the revision and transition checks, for exactly this.
  assert.deepEqual(results, [{ role: 'primary', runId: 'r1', status: 'settled' }]);
  assert.equal(db.matching(UPDATE_ROW).length, 0, 'no UPDATE, so no revision burned');
});


// ════════════════════════════════════════════════════════════════════════════════════════════════
// v9 §4.2 — ONE RUN PER ROLE, on any handle that settles or writes
// ════════════════════════════════════════════════════════════════════════════════════════════════

/**
 * ⚠️ THE DEFECT. `LifecycleHandle.runs` is a plain array with no uniqueness rule, and two functions
 * assume uniqueness while disagreeing about it: `writeRetrievalTerminal` takes the FIRST match by
 * `find`, `advance` updates EVERY match by `map`. With two `primary` runs on one handle, one row is
 * written and BOTH revisions advance — so the second write is then measured against a revision
 * nothing set for it, and nothing reports any of it.
 *
 * ⚠️ AND THE GUARD IS NOT AT DECLARATION. `declareNoteRuns` legitimately declares one `primary` run
 * per note in a batch, so a 30-note batch is a handle with 30 `primary` runs. A declare-time guard
 * would stop the worker. The guard belongs to the two functions that assume uniqueness.
 */
const dupHandle = (): LifecycleHandle => ({
  invocationId: 'inv-dup',
  runs: [
    { role: 'primary', runId: 'r-a', expectedRevision: 1 },
    { role: 'primary', runId: 'r-b', expectedRevision: 1 },
  ],
  persistenceIntent: 'will_persist',
});

test('v9 §4.2 — settlement REFUSES a duplicate role and reports it, rather than settling it twice', async () => {
  const db = installDbStub();
  happyRow(db, 'retrieval_complete', 1);
  db.on(INSERT_FAILURE, []);

  const results = await settleRetrievalTelemetry(dupHandle(), {
    outcome: 'persisted_clean', auditId: AUDIT, settledAt: AT,
  });

  assert.equal(results.length, 2, 'both runs are reported — the duplicate is not dropped silently');
  assert.deepEqual(results[0], { role: 'primary', runId: 'r-a', status: 'settled' });
  assert.deepEqual(results[1], {
    role: 'primary', runId: 'r-b', status: 'rejected', rejection: 'duplicate_role_on_handle',
  });
  // ⚠️ ONE row written, not two. That is the harm: the same row would have been settled twice.
  assert.equal(db.matching(UPDATE_ROW).length, 1, 'the duplicate never reached applyTerminalState');
});

test('v9 §4.2 — `status` stays at D12\'s three values; the new class rides in `rejection`', async () => {
  const db = installDbStub();
  happyRow(db, 'retrieval_complete', 1);
  const results = await settleRetrievalTelemetry(dupHandle(), {
    outcome: 'persisted_clean', auditId: AUDIT, settledAt: AT,
  });
  for (const r of results) {
    assert.ok(['settled', 'failed', 'rejected'].includes(r.status), `status ${r.status} is outside D12's union`);
  }
  assert.equal(results[1].rejection, 'duplicate_role_on_handle');
});

test('v9 §4.2 — the vocabulary has SIX classes, and the sixth needs no migration', () => {
  assert.equal(SETTLEMENT_REJECTIONS.length, 6);
  assert.deepEqual([...SETTLEMENT_REJECTIONS], [
    'no_row', 'stale_revision', 'already_terminal', 'disallowed_transition', 'lost_update',
    'duplicate_role_on_handle',
  ]);
  // A rejection class is a return value plus a free-text `error_class`, and `error_class` carries no
  // CHECK in either artefact — so adding one is not a schema change. Asserted, not assumed.
  const core = readFileSync('lib/retrieval-telemetry-core.ts', 'utf8');
  const sqlFile = readFileSync('migrations/0035_opd_audit_retrieval_telemetry.sql', 'utf8');
  for (const [name, src] of [['generated DDL', core], ['migration 0035', sqlFile]] as const) {
    assert.match(src, /error_class TEXT NOT NULL/, `${name} declares error_class`);
    assert.equal(/error_class[^,)]*CHECK/i.test(src), false, `${name} puts a CHECK on error_class`);
  }
});

test('v9 §4.2 — a duplicate role at the TERMINAL WRITE throws, as an undeclared role already does', async () => {
  installDbStub();
  const operational: OperationalTelemetry = {
    route: 'opd_audit_worker', route_class: 'worker', retrieval_role: 'primary',
    invocation_id: 'inv-dup', trace_id: null, deployment_sha: null,
    started_at: AT, completed_at: AT, routing_flags: {},
    active_backfill_run_id: null, active_backfill_target: null, active_backfill_state: null,
    active_lab_experiment_id: null,
  };
  const input = {
    payload: buildRetrievalPayload(createTelemetryCapture('primary'), { hmacKey: 'k', scorerContext: '' }),
    operational, traceId: null, completedAt: AT,
  };
  // Writing the FIRST match while `advance` moves every match is the silent version of this.
  await assert.rejects(
    () => writeRetrievalTerminal(dupHandle(), 'primary', input),
    /2 declared runs for role primary/,
  );
  // …and the existing throw for a role with no declared run is unchanged.
  await assert.rejects(
    () => writeRetrievalTerminal(
      { invocationId: 'i', runs: [], persistenceIntent: 'will_persist' }, 'primary', input,
    ),
    /no declared run for role primary/,
  );
});

test('v9 §4.2 — a handle with one run per role is untouched by the guard', async () => {
  const db = installDbStub();
  happyRow(db, 'retrieval_complete', 1);
  const results = await settleRetrievalTelemetry(
    handleOf([
      { role: 'primary', runId: 'r-prim', expectedRevision: 1 },
      { role: 'normative_channel', runId: 'r-norm', expectedRevision: 1 },
    ]),
    { outcome: 'persisted_clean', auditId: AUDIT, settledAt: AT },
  );
  assert.deepEqual(results.map((r) => r.status), ['settled', 'settled']);
  assert.equal(db.matching(UPDATE_ROW).length, 2, 'two roles, two rows, no refusal');
});

// ════════════════════════════════════════════════════════════════════════════════════════════════
// v9 §4.1 — `persisted_dirty` cannot ARRIVE as a base outcome
// ════════════════════════════════════════════════════════════════════════════════════════════════

test('v9 §4.1 — the base outcome type excludes persisted_dirty, and the mappers cannot produce it', () => {
  // The type is the guard, so the proof is a source pin plus the behavioural fact that the two
  // mappers only ever return base values. `persisted_dirty` is DERIVED, per run, by
  // `upgradeForDefects` from that run's own role's verdict — it must never arrive pre-derived.
  const src = readFileSync('lib/retrieval-settlement.ts', 'utf8');
  assert.match(src, /outcome: Exclude<SettlementOutcome, 'persisted_dirty'>;/);
  for (const r of ['inserted', 'updated', 'exists', 'skipped'] as const) {
    assert.notEqual(outcomeForSaveResult(r), 'persisted_dirty');
  }
});

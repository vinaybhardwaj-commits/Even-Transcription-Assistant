/**
 * lib/__tests__/rejected-terminal-and-backfill-target.test.ts — addendum v7 sections 7 and 8.
 *
 * Two manifest-affecting corrections of pass 0: the definition of `active_backfill_target`, and
 * durable evidence for a terminal compare-and-set that matched no row.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { installDbStub } from './telemetry-db-stub';
import { declareRetrievals, writeRetrievalTerminal } from '../retrieval-telemetry-store';
import { createTelemetryCapture, buildRetrievalPayload } from '../retrieval-capture';
import {
  TELEMETRY_FAILURE_PHASES, RUN_SCOPED_FAILURE_PHASES, reconcilerStateFor, validateManifest,
  type TelemetryRequestContext, type OperationalTelemetry,
} from '../retrieval-telemetry-core';

const AT = '2026-08-15T00:00:00.000Z';
const INSERT_RUNS = /INSERT INTO opd_audit_retrieval_telemetry/;
const UPDATE_TERMINAL = /SET persistence_state = 'retrieval_complete'/;
const SELECT_ROW = /SELECT persistence_state, row_revision, audit_id/;
const INSERT_FAILURE = /INSERT INTO opd_retrieval_telemetry_failures/;

const ctx: TelemetryRequestContext = {
  invocationId: 'inv-v7', route: 'opd_audit_worker', routeClass: 'worker',
  deploymentSha: 'sha', vercelRequestId: null, startedAt: AT, routingFlags: {},
};
const operational = (): OperationalTelemetry => ({
  route: 'opd_audit_worker', route_class: 'worker', retrieval_role: 'primary',
  invocation_id: 'inv-v7', trace_id: null, deployment_sha: 'sha',
  started_at: AT, completed_at: AT, routing_flags: {},
  active_backfill_run_id: null, active_backfill_target: null, active_backfill_state: null,
  active_lab_experiment_id: null,
});

/** Declare one primary run, then drive its terminal write into a REJECTION (zero rows updated). */
async function drivenRejection(observedState: string | null) {
  const db = installDbStub();
  db.on(INSERT_RUNS, [{ retrieval_run_id: 'r-1' }]);
  db.on(UPDATE_TERMINAL, []);                       // ⚠️ zero rows — the compare-and-set matched nothing
  db.on(SELECT_ROW, observedState === null ? [] : [{ persistence_state: observedState, row_revision: 7, audit_id: null }]);
  db.on(INSERT_FAILURE, []);

  const handle = await declareRetrievals(ctx, [{ role: 'primary', runId: 'r-1', uid: 'u', engineVersion: 'e' }], 'will_persist');
  const after = await writeRetrievalTerminal(handle, 'primary', {
    payload: buildRetrievalPayload(createTelemetryCapture('primary'), { hmacKey: 'k', scorerContext: '' }),
    operational: operational(), traceId: null, completedAt: AT,
  });
  return { db, handle, after };
}

// ════════════════════════════════════════════════════════════════════════════════════════════════
// v7 §8 — the rejected terminal write
// ════════════════════════════════════════════════════════════════════════════════════════════════

test('v7 §8 — a rejected terminal write now leaves DURABLE evidence, not just a console.warn', async () => {
  // Before this, zero rows updated was not an exception, so the failure-evidence path never fired
  // and the manifest, counters and defect list computed for the write were silently discarded.
  const { db } = await drivenRejection('started');
  const failures = db.matching(INSERT_FAILURE);
  assert.equal(failures.length, 1, 'exactly one evidence row for the rejection');
  // params, in the INSERT's own order (lib/retrieval-telemetry-failure-store.ts:52-55):
  //   $1 invocation_id, $2 retrieval_run_id, $3 retrieval_role, $4 failed_phase,
  //   $5 intended_state, $6 observed_at, $7 error_class
  assert.equal(failures[0].params[1], 'r-1');
  assert.equal(failures[0].params[2], 'primary');
  assert.equal(failures[0].params[3], 'retrieval_terminal_rejected');
});

test('v7 §8 — the reread distinguishes an already-terminal row from a moved revision', async () => {
  // The two things that produce zero rows are different events, and only a read can tell them apart.
  const terminal = await drivenRejection('persisted_complete');
  const tFail = terminal.db.matching(INSERT_FAILURE)[0];
  assert.equal(tFail.params[6], 'row_already_terminal');

  const moved = await drivenRejection('started');
  const mFail = moved.db.matching(INSERT_FAILURE)[0];
  assert.equal(mFail.params[6], 'revision_or_state_moved');
});

test('v7 §8 — an existing terminal row is NEVER downgraded, and that is structural', async () => {
  const { db } = await drivenRejection('persisted_complete');
  // The rejection path issues a SELECT and an INSERT of evidence. It issues NO update of the row,
  // so preservation is a property of the code shape rather than a rule someone has to remember.
  const updates = db.calls.filter((c) => /UPDATE opd_audit_retrieval_telemetry/.test(c.query));
  assert.equal(updates.length, 1, 'only the original compare-and-set, which matched nothing');
  assert.match(updates[0].query, /persistence_state = 'started'/, 'and it was guarded on started');
});

test('v7 §8 — the handle is returned unadvanced, and nothing is retried', async () => {
  const { handle, after, db } = await drivenRejection('started');
  assert.deepEqual(after, handle, 'the handle does not advance on a rejection');
  // D12's prohibition stands: a blind retry is how an old invocation overwrites a newer terminal
  // result. The reread is a READ, and there is exactly one terminal UPDATE attempt.
  assert.equal(db.matching(UPDATE_TERMINAL).length, 1, 'one attempt, never retried');
});

test('v7 §8 — a failed reread still records the evidence, because the reread is diagnostic', async () => {
  // Fail-safe (constraint 2): losing the diagnostic read must not lose the durable evidence.
  const db = installDbStub();
  db.on(INSERT_RUNS, [{ retrieval_run_id: 'r-2' }]);
  db.on(UPDATE_TERMINAL, []);
  db.on(SELECT_ROW, new Error('reread exploded'));
  db.on(INSERT_FAILURE, []);
  const handle = await declareRetrievals(ctx, [{ role: 'primary', runId: 'r-2', uid: 'u', engineVersion: 'e' }], 'will_persist');
  const after = await writeRetrievalTerminal(handle, 'primary', {
    payload: buildRetrievalPayload(createTelemetryCapture('primary'), { hmacKey: 'k', scorerContext: '' }),
    operational: operational(), traceId: null, completedAt: AT,
  });
  assert.deepEqual(after, handle, 'still no throw, still no advance');
  assert.equal(db.matching(INSERT_FAILURE).length, 1, 'the evidence survived the failed reread');
});

test('v7 §8 — the new phase is run-scoped and in the vocabulary, and the reconciler deliberately ignores it', () => {
  assert.ok((TELEMETRY_FAILURE_PHASES as readonly string[]).includes('retrieval_terminal_rejected'));
  assert.ok((RUN_SCOPED_FAILURE_PHASES as readonly string[]).includes('retrieval_terminal_rejected'),
    'it names a specific run, so the CHECK requires a run id and role');

  // ⚠️ DELIBERATELY NOT MAPPED. `reconcilerStateFor` tests membership of `retrieval_terminal`
  // EXACTLY, so a row carrying only the new sibling phase reconciles as `aborted` — the
  // no-evidence answer. That is the prior settled decision (decisions §8): record the event so it
  // becomes countable, and decide the state mapping when C0 shows how often each case occurs.
  assert.equal(reconcilerStateFor('started', ['retrieval_terminal_rejected']), 'aborted');
  assert.equal(reconcilerStateFor('started', ['retrieval_terminal']), 'telemetry_persistence_failed');
  assert.equal(
    reconcilerStateFor('started', ['retrieval_terminal_rejected', 'retrieval_terminal']),
    'telemetry_persistence_failed',
    'a real terminal failure still wins when both are present',
  );
});

test('v7 §8 — the generated CHECK and the mirrored .sql agree on the new phase', () => {
  // `migrations/0035` is DOCUMENTATION — nothing reads it at run time, and the parity test holds it
  // to the generated DDL. Both had to move together.
  const sqlFile = readFileSync('migrations/0035_opd_audit_retrieval_telemetry.sql', 'utf8');
  assert.match(sqlFile, /opd_rtf_phase_chk CHECK \(failed_phase IN \([^)]*'retrieval_terminal_rejected'/);
  assert.match(sqlFile, /opd_rtf_run_chk[\s\S]{0,200}'retrieval_terminal_rejected'/);
});

// ════════════════════════════════════════════════════════════════════════════════════════════════
// v7 §7 — active_backfill_target
// ════════════════════════════════════════════════════════════════════════════════════════════════

test('v7 §7 — the field is present-and-null when there is no active run, and that validates clean', () => {
  // Null here is a MEASUREMENT, paired with `active_backfill_state`: PRD §7 needs active
  // provider-backfill intervals and says an idle cron tick is not an interval.
  const payload = buildRetrievalPayload(createTelemetryCapture('primary'), { hmacKey: 'k', scorerContext: '' });
  const codes = validateManifest({
    ...payload,
    operational: { ...operational(), active_backfill_target: null, active_backfill_state: 'idle' },
  });
  assert.equal(codes.filter((c) => /active_backfill/.test(c)).length, 0, `unexpected: ${codes}`);
});

test('v7 §7 — an ABSENT field is a defect, which is what makes the null a claim rather than a gap', () => {
  const payload = buildRetrievalPayload(createTelemetryCapture('primary'), { hmacKey: 'k', scorerContext: '' });
  const op = { ...operational() } as Record<string, unknown>;
  delete op.active_backfill_target;
  const codes = validateManifest({ ...payload, operational: op });
  assert.ok(codes.includes('active_backfill_target_field_absent'),
    'omitted and null are different claims, and the validator enforces the difference');
});

test('v7 §7 — the definition is recorded, and BackfillRun still has no `target` field', () => {
  // v7 §7 says to stop and report if a `target` field exists, because the definition assumes it
  // does not. Re-verified here so a later addition fails loudly rather than silently changing what
  // the column means.
  const core = readFileSync('lib/retrieval-telemetry-core.ts', 'utf8');
  assert.match(core, /THE ACTIVE BACKFILL RUN'S `model`\. Null when there is no active run/);

  // ⚠️ THE TYPE LIVES IN `backfill-runs-core.ts`, not `backfill-runs.ts`, which merely imports it.
  const runs = readFileSync('lib/backfill-runs-core.ts', 'utf8');
  const iface = runs.slice(runs.indexOf('export interface BackfillRun'));
  const body = iface.slice(0, iface.indexOf('\n}'));
  assert.equal(/\btarget\b\s*[?:]/.test(body), false, 'BackfillRun must still have no `target` field');
  assert.match(body, /\bmodel\b\s*[?:]/, 'and it does have the `model` this column actually carries');
});

test('v7 §7 — the writer maps no-active-run to null on all three fields', () => {
  // The write site is `lib/opd-note-audit.ts`, which is outside this pass's file contract — and it
  // already documented the definition correctly. Pinned by source so the behaviour cannot drift
  // away from the definition now recorded at the type.
  const audit = readFileSync('lib/opd-note-audit.ts', 'utf8');
  assert.match(audit, /: \{ runId: null, target: null, state: 'idle' \}/, 'no active run ⇒ nulls plus idle');
  assert.match(audit, /return run\s*\n\s*\? \{ runId: String\(run\.id\), target: run\.model \?\? null, state: 'active' \}/,
    'an active run ⇒ the run MODEL, which is the definition v7 §7 settles');
});

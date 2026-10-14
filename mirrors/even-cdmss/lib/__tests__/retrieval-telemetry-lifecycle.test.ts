/**
 * lib/__tests__/retrieval-telemetry-lifecycle.test.ts — kickoff tests 19, 20, 31, 32, 34, 52 and 53,
 * plus pass 4a's proofs 23 and 24.
 *
 * The handle's whole reason for existing is that the audit write and the telemetry link are NOT
 * transactional and cannot be: `lib/db.ts` exports `sql` as a Proxy with only an `apply` trap, so
 * the driver's own `transaction` is unreachable — and even if it were, it could not span the
 * application logic between the two. What replaces atomicity is what is tested here: idempotent
 * updates, an explicit revision guard, and per-role independence.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { installDbStub, classedError, run as lifecycleRun } from './telemetry-db-stub';
import {
  declareRetrievals, writeRetrievalTerminal, applyTerminalState,
  attachRetrievalTelemetry, readRetrievalTelemetry, RETRIEVAL_TELEMETRY_PROPERTY,
  type LifecycleHandle,
} from '../retrieval-telemetry-store';
import { createTelemetryCapture, buildRetrievalPayload } from '../retrieval-capture';
import {
  telemetryHmac,
  type TelemetryRequestContext, type OperationalTelemetry,
} from '../retrieval-telemetry-core';
import { assembleAuditContext, retrievalTerminalsSeam, type AuditOpdOpts } from '../opd-note-audit.ts';
import type { CiteHit } from '../citations-core.ts';

const INSERT_RUNS = /INSERT INTO opd_audit_retrieval_telemetry/;
const UPDATE_TERMINAL = /SET persistence_state = 'retrieval_complete'/;
const SELECT_ROW = /SELECT persistence_state, row_revision, audit_id/;
const UPDATE_SETTLE = /SET persistence_state = \$3, audit_id = \$4/;
const INSERT_FAILURE = /INSERT INTO opd_retrieval_telemetry_failures/;
const BUMP_FAILURES = /SET telemetry_write_failures = telemetry_write_failures \+ 1/;

const AT = '2026-08-12T00:00:00.000Z';
const ctx: TelemetryRequestContext = {
  invocationId: 'inv-1', route: 'opd_audit_worker', routeClass: 'worker',
  deploymentSha: 'sha', vercelRequestId: null, startedAt: AT, routingFlags: {},
};

const operational = (role: 'primary' | 'normative_channel'): OperationalTelemetry => ({
  route: 'opd_audit_worker', route_class: 'worker', retrieval_role: role,
  invocation_id: 'inv-1', trace_id: null, deployment_sha: 'sha',
  started_at: AT, completed_at: AT, routing_flags: {},
  active_backfill_run_id: null, active_backfill_target: null, active_backfill_state: null,
  active_lab_experiment_id: null,
});

const payloadFor = (role: 'primary' | 'normative_channel') =>
  buildRetrievalPayload(createTelemetryCapture(role), { hmacKey: 'k', scorerContext: role === 'primary' ? '' : null });

// ════════════════════════════════════════════════════════════════════════════════════════════════
// 19 — a predeclared id is ADOPTED, never reallocated
// ════════════════════════════════════════════════════════════════════════════════════════════════

test('19 — the predeclared run id is the one every later write targets, and no second row is inserted', async () => {
  const db = installDbStub();
  db.on(INSERT_RUNS, [{ retrieval_run_id: 'pre-1' }]);
  db.on(UPDATE_TERMINAL, [{ row_revision: 1 }]);

  const handle = await declareRetrievals(ctx, [{ role: 'primary', runId: 'pre-1', uid: 'u', engineVersion: 'e' }], 'will_persist');
  const after = await writeRetrievalTerminal(handle, 'primary', {
    payload: payloadFor('primary'), operational: operational('primary'), traceId: null, completedAt: AT,
  });

  assert.equal(db.matching(INSERT_RUNS).length, 1, 'one insert, not two');
  assert.equal(db.matching(UPDATE_TERMINAL)[0].params[0], 'pre-1', 'the terminal write targets the declared id');
  assert.equal(after.runs[0].runId, 'pre-1', 'and the handle still carries it');
  // The insert is idempotent, which is what makes adoption safe when a worker declared first.
  assert.match(db.matching(INSERT_RUNS)[0].query, /ON CONFLICT \(retrieval_run_id\) DO NOTHING/);
});

// ════════════════════════════════════════════════════════════════════════════════════════════════
// 20 — revisions
// ════════════════════════════════════════════════════════════════════════════════════════════════

test('20 — declare returns 0, the terminal write returns 1, and a stale handle is REJECTED', async () => {
  const db = installDbStub();
  db.on(INSERT_RUNS, [{ retrieval_run_id: 'r1' }]);
  db.on(UPDATE_TERMINAL, [{ row_revision: 1 }]);

  const declared = await declareRetrievals(ctx, [{ role: 'primary', runId: 'r1', uid: null, engineVersion: null }], 'will_persist');
  assert.equal(declared.runs[0].expectedRevision, 0);

  const advanced = await writeRetrievalTerminal(declared, 'primary', {
    payload: payloadFor('primary'), operational: operational('primary'), traceId: null, completedAt: AT,
  });
  assert.equal(advanced.runs[0].expectedRevision, 1);
  // ⚠️ NOTHING MUTATED IN PLACE. The old handle still reads 0, which is exactly what makes it stale.
  assert.equal(declared.runs[0].expectedRevision, 0);
  assert.notEqual(declared, advanced);

  // Settling with the STALE handle is rejected, and is reported as rejected.
  db.on(SELECT_ROW, [{ persistence_state: 'retrieval_complete', row_revision: 1, audit_id: null }]);
  db.on(INSERT_FAILURE, []);
  const r = await applyTerminalState(declared, declared.runs[0], { state: 'persisted_complete', auditId: 'a', settledAt: AT });
  assert.equal(r.status, 'rejected');
  assert.equal(r.rejection, 'stale_revision');
  assert.equal(db.matching(UPDATE_SETTLE).length, 0, 'and nothing was written');
});

test('20 — revisions advance PER ROLE: a normative write cannot invalidate the primary\'s handle', async () => {
  const db = installDbStub();
  db.on(INSERT_RUNS, [{ retrieval_run_id: 'r-prim' }, { retrieval_run_id: 'r-norm' }]);
  db.on(UPDATE_TERMINAL, [{ row_revision: 1 }]);

  let handle = await declareRetrievals(ctx, [
    { role: 'primary', runId: 'r-prim', uid: null, engineVersion: null },
    { role: 'normative_channel', runId: 'r-norm', uid: null, engineVersion: null },
  ], 'will_persist');

  handle = await writeRetrievalTerminal(handle, 'normative_channel', {
    payload: payloadFor('normative_channel'), operational: operational('normative_channel'), traceId: null, completedAt: AT,
  });
  assert.equal(handle.runs.find((r) => r.role === 'normative_channel')!.expectedRevision, 1);
  assert.equal(handle.runs.find((r) => r.role === 'primary')!.expectedRevision, 0, 'the primary did not move');

  handle = await writeRetrievalTerminal(handle, 'primary', {
    payload: payloadFor('primary'), operational: operational('primary'), traceId: null, completedAt: AT,
  });
  assert.deepEqual(handle.runs.map((r) => r.expectedRevision), [1, 1]);
});

test('20 — a terminal write that matches nothing is NOT retried, and does not advance the handle', async () => {
  const db = installDbStub();
  db.on(UPDATE_TERMINAL, []);   // revision or state moved under us
  const handle: LifecycleHandle = {
    invocationId: 'inv-1', runs: [{ role: 'primary', runId: 'r1', expectedRevision: 0 }], persistenceIntent: 'will_persist',
  };
  const after = await writeRetrievalTerminal(handle, 'primary', {
    payload: payloadFor('primary'), operational: operational('primary'), traceId: null, completedAt: AT,
  });
  assert.equal(after.runs[0].expectedRevision, 0, 'the handle is unchanged, so the caller is not told a lie');
  assert.equal(db.matching(UPDATE_TERMINAL).length, 1, 'ONE attempt — a blind retry is how an old invocation overwrites a newer result');
});

// ════════════════════════════════════════════════════════════════════════════════════════════════
// 31 — reuse-only work writes nothing at all
// ════════════════════════════════════════════════════════════════════════════════════════════════

test('31 — the reuse guard returns BEFORE any telemetry statement exists', () => {
  const src = readFileSync('lib/opd-note-audit.ts', 'utf8');
  const reuseReturn = src.indexOf('return { keys, scorecard, completeness, findings, suggestions: opts.reuse.suggestions');
  const telemetryBlock = src.indexOf('// ══ RETRIEVAL TELEMETRY, STEPS 3-6 OF D11');
  assert.ok(reuseReturn > 0 && telemetryBlock > 0);
  assert.ok(reuseReturn < telemetryBlock,
    'D11 step 1 is the reuse guard: no invocation row, no retrieval rows, no handle');
  // An empty run list is the second half of the same guarantee, and it is exercised, not pinned:
  // see retrieval-invocation-store.test.ts, "an empty run list writes nothing".
});

// ════════════════════════════════════════════════════════════════════════════════════════════════
// 32 — the handle is non-enumerable
// ════════════════════════════════════════════════════════════════════════════════════════════════

test('32 — the attached handle is absent from JSON.stringify, from the keys, and from a spread', () => {
  const audit = { keys: { uid: 'u' }, scorecard: { headline: 90 } };
  const handle: LifecycleHandle = {
    invocationId: 'inv-1', runs: [{ role: 'primary', runId: 'r1', expectedRevision: 1 }], persistenceIntent: 'will_persist',
  };
  const attached = attachRetrievalTelemetry(audit, { handle, manifestDefectsByRole: {} });

  assert.equal(attached, audit, 'attached in place — the audit is not replaced by a wrapper');
  // ⚠️ JSON.stringify IS WHAT REACHES THE STORE, THE LAB AND EVERY LOG LINE. An invocation id
  // appearing there would put run ids in places §4.2 never authorised.
  assert.equal(JSON.stringify(attached).includes('inv-1'), false);
  assert.equal(JSON.stringify(attached).includes(RETRIEVAL_TELEMETRY_PROPERTY), false);
  assert.deepEqual(Object.keys(attached), ['keys', 'scorecard']);
  assert.equal(RETRIEVAL_TELEMETRY_PROPERTY in { ...attached }, false, 'a spread drops it too');
  // …and it is still readable by the owner that needs it.
  assert.equal(readRetrievalTelemetry(attached)?.handle, handle);
  assert.equal(readRetrievalTelemetry({}), null);
  assert.equal(readRetrievalTelemetry(null), null);
});

// ════════════════════════════════════════════════════════════════════════════════════════════════
// 34 — when even the failure store fails
// ════════════════════════════════════════════════════════════════════════════════════════════════

test('34 — terminal write fails, failure row fails: the invocation counter is the only evidence left', async () => {
  const db = installDbStub();
  db.on(UPDATE_TERMINAL, classedError('NeonDbError'));
  db.on(INSERT_FAILURE, classedError('AlsoDown'));
  db.on(BUMP_FAILURES, []);
  const handle: LifecycleHandle = {
    invocationId: 'inv-1', runs: [{ role: 'primary', runId: 'r1', expectedRevision: 0 }], persistenceIntent: 'will_persist',
  };
  // Nothing propagates: an audit is never failed because its telemetry could not be recorded.
  const after = await writeRetrievalTerminal(handle, 'primary', {
    payload: payloadFor('primary'), operational: operational('primary'), traceId: null, completedAt: AT,
  });
  assert.equal(after, handle, 'the caller keeps the handle it had');
  assert.equal(db.matching(BUMP_FAILURES).length, 1);
  assert.deepEqual(db.matching(BUMP_FAILURES)[0].params, ['inv-1']);
});

test('34 — and when the counter ALSO fails: a log line, nothing else, still no propagation', async () => {
  const db = installDbStub();
  db.on(UPDATE_TERMINAL, classedError('NeonDbError'));
  db.on(INSERT_FAILURE, classedError('AlsoDown'));
  db.on(BUMP_FAILURES, classedError('DownToo'));
  const handle: LifecycleHandle = {
    invocationId: 'inv-1', runs: [{ role: 'primary', runId: 'r1', expectedRevision: 0 }], persistenceIntent: 'will_persist',
  };
  await writeRetrievalTerminal(handle, 'primary', {
    payload: payloadFor('primary'), operational: operational('primary'), traceId: null, completedAt: AT,
  });
  assert.equal(db.matching(BUMP_FAILURES).length, 1, 'attempted once, and its own failure went nowhere');
});

test('34 — NO MODULE-LEVEL COUNTER EXISTS ANYWHERE, asserted by source search', () => {
  // §4.1 forbids mutable process-global state, and a per-process number would not survive the
  // invocation anyway — the whole point of this counter is that it is readable AFTER the invocation
  // that failed is gone. The column is the record, or there is none.
  for (const f of [
    'lib/retrieval-telemetry-store.ts', 'lib/retrieval-invocation-store.ts',
    'lib/retrieval-telemetry-failure-store.ts', 'lib/retrieval-settlement.ts',
  ]) {
    const src = readFileSync(f, 'utf8');
    const moduleLevel = src.split('\n').filter((l) => /^(let|var) /.test(l));
    assert.deepEqual(moduleLevel, [], `${f} declares module-level mutable state: ${moduleLevel.join(' | ')}`);
  }
  // And the column has exactly one writer, which is what makes it readable as a count.
  const inv = readFileSync('lib/retrieval-invocation-store.ts', 'utf8');
  assert.equal((inv.match(/telemetry_write_failures = telemetry_write_failures \+ 1/g) || []).length, 1);
});

// ════════════════════════════════════════════════════════════════════════════════════════════════
// 52 and 53 — the owner matrix, and the callback
// ════════════════════════════════════════════════════════════════════════════════════════════════

/** Every file D9's matrix names, and the outcome each of its paths must settle. Source-read: these
 *  are route handlers with no harness to invoke, which is stated rather than glossed.
 *
 *  ⚠️ FOUR LITERALS CHANGED IN PASS 0B, AND THE REASON IS THE POINT OF THAT PASS. The owners used
 *  to pass a FLAT defect list into `outcomeForOwnedSave(result, defects)`, and that list was
 *  "whichever role was dirtiest" — so one role's defect marked the other role's row partial. The
 *  owners now pass a ROLE-KEYED MAP to `settleOwned`, and the clean-to-dirty upgrade happens per
 *  run inside `settleRetrievalTelemetry`, where each run can see its own manifest's verdict.
 *
 *  So `outcomeForOwnedSave(s, defects), auditId` became `outcomeForOwnedSave(s), auditId,
 *  defectsByRole`. THE OWNER SET IS UNCHANGED and every path still settles exactly once — this pin
 *  still proves what it was written to prove, against the call form that now carries the verdict.
 *  Decisions §3 predicted this cost and asked for the reason in writing; this is it. */
const OWNERS: Array<[string, string[]]> = [
  ['app/api/opd-audit/worker/route.ts', [
    'outcomeForOwnedSave(s), auditId, defectsByRole',   // inserted / updated
    'outcomeForOwnedSave(status), null, defectsByRole',  // exists / skipped
    "settleOwned(handle, 'persistence_refused')",        // DEC-2
    "published ? 'audit_generation_failed' : 'retrieval_not_run'",
  ]],
  ['app/api/opd-audit/run/route.ts', [
    "settleOwned(handle, 'audit_persistence_failed')",   // the force arm's own .catch
    "settleOwned(handle, 'no_persistence_intended')",    // no save asked for, and the POST arm
    "published ? 'audit_generation_failed' : 'retrieval_not_run'",
  ]],
  ['app/api/admin/opd-audit-mini-backfill/route.ts', [
    'outcomeForOwnedSave(st), auditId, defectsByRole',
    "'persistence_refused'",
    "published ? 'audit_generation_failed' : 'retrieval_not_run'",
  ]],
  ['lib/lab-batch.ts', ["settleOwned(handle, 'no_persistence_intended')"]],
  ['lib/mcp-tools.ts', [
    "settleOwned(handle, 'no_persistence_intended')",    // mini_analyze, and lab_retrieve
    'outcomeForOwnedSave(status), auditId, defectsByRole',   // backfill_control, as the worker
  ]],
  ['lib/lvc.ts', ['settleRetrievalTelemetry(']],         // defaultRecall — no audit
  ['scripts/bedrock-opd-note-probe.mjs', [
    "settleOwned(handle, 'audit_persistence_failed')",   // its OWN save failure
    "settleOwned(handle, 'no_persistence_intended')",    // the dry arm
  ]],
  ['scripts/metamorphic-llm-report.mjs', ["settleOwned(handle, 'no_persistence_intended')"]],
];

test('52 — every owner in the D9 matrix settles, including both scripts and both MCP paths', () => {
  for (const [file, needles] of OWNERS) {
    const src = readFileSync(file, 'utf8');
    for (const n of needles) {
      assert.ok(src.includes(n), `${file} does not settle: ${n}`);
    }
  }
});

test('53 — the callback carries the audit id, and its failure never changes the save result', () => {
  const store = readFileSync('lib/opd-audit-store.ts', 'utf8');
  // It fires only on the two results that produced a row — `exists` and `skipped` never reach it.
  assert.match(store, /if \(opts\.onPersisted && rows\[0\]\.id\) \{/);
  assert.ok(store.includes("await opts.onPersisted({ status: landed, auditId: String(rows[0].id) })"));
  // ⚠️ A CALLBACK EXCEPTION IS SWALLOWED AND THE RESULT PRESERVED (constraint 1). The `.catch` is
  // on the call, and `return landed` is after it and unconditional.
  assert.match(store, /\.catch\(\(e\) => console\.warn\('\[opd-audit\] onPersisted threw; the save stands'/);
  const call = store.indexOf('opts.onPersisted({');
  assert.ok(store.indexOf('return landed;', call) > call, 'the result is returned after, whatever the callback did');
  // saveOpdAudit NEVER receives the handle: the closure holds it, and this file imports no
  // telemetry module at all.
  assert.equal(/retrieval-telemetry|retrieval-settlement|LifecycleHandle/.test(store), false,
    'a clinical write acquires no telemetry import');
});

// ════════════════════════════════════════════════════════════════════════════════════════════════
// THE CANARY-GATE HAZARD — A CHARACTERIZATION TEST, NOT A FIX
// ════════════════════════════════════════════════════════════════════════════════════════════════
//
// ⚠️ READ THIS BEFORE CHANGING EITHER CASE BELOW. These two cases pin CURRENT BEHAVIOUR, not
// desired behaviour. They exist because `CDMSS-RERANK-TELEMETRY-DECISIONS-13-AUG-2026.md` section 3,
// hazard 1 identifies a real hole and says a test must cover it before the canary:
//
//   · a two-role handle is built at `lib/opd-note-audit.ts:1528-1533` — `primary` plus
//     `normative_channel` — and the two roles' terminal writes are independent;
//   · if `primary`'s terminal write is REJECTED (revision mismatch, or the row moved off `started`)
//     while `normative_channel`'s lands, primary stays at revision 0 and is NEVER LINKED to the
//     audit, because `stateForUnwrittenRun` refuses to apply an outcome a revision-0 row cannot
//     carry, and normative_channel IS linked;
//   · PRD line 280 makes that a Stage 0b canary gate: "Exactly one linked terminal retrieval run
//     with role `primary`. Exactly one with role `normative_channel` when that channel was
//     declared."
//
// So an audit that PERSISTED CORRECTLY ends the run with zero linked `primary` runs and one linked
// `normative_channel` run, and fails the gate. The audit is fine. The telemetry is fine, in the
// sense that every row states the truth about itself. The GATE is what cannot express it.
//
// ⚠️ V HOLDS THIS DECISION. Whether to accept a hard gate failure on this path, or to authorise a
// behavioural correction, is not the build's call, and nothing here changes production behaviour.
// If a later pass corrects the behaviour, these cases SHOULD fail — that is what a characterization
// test is for, and the failure is the signal to come back and read this comment.

const SELECT_ROW_C = /SELECT persistence_state, row_revision, audit_id/;
// ⚠️ THE SETTLEMENT UPDATE SPECIFICALLY. A regex anchored on `UPDATE … SET persistence_state`
// alone also matches the TERMINAL write, whose $3 is `retrieval_outcome` and not a state — which is
// how the first version of this case read 'success' where it expected a persistence state. The
// settlement statement is the one that binds `audit_id = $4` (`lib/retrieval-telemetry-store.ts:464-469`).
const UPDATE_ROW_C = UPDATE_SETTLE;
const SELECT_PHASES_C = /SELECT failed_phase/;
const AUDIT_ID = '11111111-1111-1111-1111-111111111111';

/**
 * Drive one audit's two roles all the way through: declare both, let one terminal write land and
 * the other be rejected, then settle. Returns what each role's settlement UPDATE actually bound.
 */
async function runTwoRoleAudit(rejected: 'primary' | 'normative_channel') {
  const db = installDbStub();
  db.on(INSERT_RUNS, [{ retrieval_run_id: 'r-prim' }, { retrieval_run_id: 'r-norm' }]);
  // ⚠️ THE REJECTION IS MODELLED AS THE CODE MODELS IT: zero rows back from the compare-and-set.
  // `writeRetrievalTerminal` returns the handle UNCHANGED on that path (`lib/retrieval-telemetry-store.ts:328-334`),
  // so the role stays at expectedRevision 0.
  db.on(UPDATE_TERMINAL, (c) => (String(c.params[0]).includes(rejected === 'primary' ? 'prim' : 'norm')
    ? []
    : [{ row_revision: 1 }]));

  let handle: LifecycleHandle = await declareRetrievals(ctx, [
    { role: 'primary', runId: 'r-prim', uid: 'u', engineVersion: 'e' },
    { role: 'normative_channel', runId: 'r-norm', uid: 'u', engineVersion: 'e' },
  ], 'will_persist');

  for (const role of ['primary', 'normative_channel'] as const) {
    handle = await writeRetrievalTerminal(handle, role, {
      payload: payloadFor(role), operational: operational(role), traceId: null, completedAt: AT,
    });
  }

  // Settlement reads each row's real state. The landed role is at `retrieval_complete` revision 1;
  // the rejected one is still `started` at revision 0, with no failure evidence — nothing was ever
  // heard from its write, because the rejected branch records none (decisions §8).
  db.on(SELECT_ROW_C, (c) => (String(c.params[0]).includes(rejected === 'primary' ? 'prim' : 'norm')
    ? [{ persistence_state: 'started', row_revision: 0, audit_id: null }]
    : [{ persistence_state: 'retrieval_complete', row_revision: 1, audit_id: null }]));
  db.on(UPDATE_ROW_C, (c) => [{ row_revision: (c.params[1] as number) + 1 }]);
  db.on(SELECT_PHASES_C, []);

  const { settleRetrievalTelemetry } = await import('../retrieval-settlement');
  const results = await settleRetrievalTelemetry(handle, {
    outcome: 'persisted_clean', auditId: AUDIT_ID, settledAt: AT,
  });

  // Each settlement UPDATE binds ($1 runId, $2 expectedRevision, $3 state, $4 auditId).
  const bound = db.matching(UPDATE_ROW_C).map((c) => ({
    runId: String(c.params[0]), state: c.params[2], auditId: c.params[3],
  }));
  return { results, bound, db };
}

test('CANARY-GATE HAZARD — primary rejected, normative lands: the audit persisted and the Stage 0b primary-link gate fails', async () => {
  const { results, bound } = await runTwoRoleAudit('primary');

  // Both roles settle without throwing — constraint 1 holds, the audit is never failed for this.
  assert.equal(results.length, 2);
  for (const r of results) assert.equal(r.status, 'settled');

  const prim = bound.find((b) => b.runId === 'r-prim');
  const norm = bound.find((b) => b.runId === 'r-norm');
  assert.ok(prim && norm, 'both roles were settled');

  // ⚠️ THE HAZARD, STATED AS THE ROWS STATE IT.
  assert.equal(prim.auditId, null, 'primary is NOT linked: it never wrote a terminal manifest');
  assert.notEqual(prim.state, 'persisted_complete', 'and it does not carry the owner\'s outcome');
  assert.equal(prim.state, 'aborted', 'no failure evidence exists, so reconcilerStateFor says aborted');
  assert.equal(norm.auditId, AUDIT_ID, 'normative_channel IS linked to the audit that really persisted');
  assert.equal(norm.state, 'persisted_complete');

  // ⚠️ AND THE CONSEQUENCE, ASSERTED DIRECTLY. PRD line 280's gate counts LINKED terminal runs per
  // role. On this path that count is 0 for primary and 1 for normative_channel — on an audit that
  // persisted correctly. This is the assertion V is being asked to rule on.
  const linkedByRole = bound.filter((b) => b.auditId === AUDIT_ID).map((b) => b.runId);
  assert.deepEqual(linkedByRole, ['r-norm'], 'exactly the wrong one is linked');
  assert.equal(linkedByRole.length, 1, 'one linked run, and it is not primary — the gate expects primary');
});

test('CANARY-GATE HAZARD — the mirror: primary lands, normative rejected', async () => {
  const { results, bound } = await runTwoRoleAudit('normative_channel');

  assert.equal(results.length, 2);
  for (const r of results) assert.equal(r.status, 'settled');

  const prim = bound.find((b) => b.runId === 'r-prim');
  const norm = bound.find((b) => b.runId === 'r-norm');
  assert.ok(prim && norm);

  // The mirror is CORRECT under D9 as amended: each row states the truth about its own manifest,
  // and the gate's primary clause is satisfied. Recorded so the asymmetry between the two cases is
  // explicit — only one of them trips the gate, and it is not this one.
  assert.equal(prim.auditId, AUDIT_ID, 'primary is linked');
  assert.equal(prim.state, 'persisted_complete');
  assert.equal(norm.auditId, null, 'normative_channel is not linked, and says so');
  assert.equal(norm.state, 'aborted');
});

// ════════════════════════════════════════════════════════════════════════════════════════════════
// 23 and 24 — PASS 4a (Saul Rep 40 order D, Rep 41 risk order)
//
// ⚠️ NO NEW SEAM WAS BUILT, AND NONE WAS NEEDED. Pass 4a's kickoff §1 rules that 23 and 24 are the
// two proofs that fall out without fault injection, and that a coder who concludes otherwise must
// stop rather than build one. Both are reached with the seam that already exists
// (`retrievalTerminalsSeam`, lib/opd-note-audit.ts:821-831) plus the transport stub. Proofs 21 and
// 22 do need injection and are pass 4b, held on a seam-shape ruling.
// ════════════════════════════════════════════════════════════════════════════════════════════════

/** Literature and normative hits shaped as `retrieve()` returns them — the same fixtures
 *  retrieval-telemetry-validation.test.ts:706-715 uses for the 47.x execution proofs. */
const lit23 = (id: number): CiteHit => ({
  id, source: 'statpearls', book: 'StatPearls', chapter: `ch${id}`, section: null,
  page_start: null, page_end: null, item_number: null, chunk_type: 'narrative',
  similarity: 0.5, text: `literature excerpt ${id} about antihistamine montelukast evidence`,
});
const cw23 = (id: number): CiteHit => ({
  id, source: 'choosing-wisely', book: 'CW-AAFP', chapter: null, section: null,
  page_start: null, page_end: null, item_number: `cwus-${id}`, chunk_type: 'recommendation',
  similarity: 0.6, text: `Avoid prescribing antihistamine+montelukast for viral URTI (statement ${id})`,
});

const TELE_CTX_23: NonNullable<AuditOpdOpts['telemetry']> = {
  ctx: {
    invocationId: 'inv-23', route: 'opd_audit_worker', routeClass: 'worker', deploymentSha: null,
    vercelRequestId: null, startedAt: AT, routingFlags: {}, labExperimentId: null,
  },
  route: 'opd_audit_worker',
  persistenceIntent: 'will_persist',
};

/**
 * D11 steps 7 → 13, driven in production's own order, with the transport watched throughout.
 *
 * ⚠️ WHAT MAKES THIS AN OBSERVATION AND NOT CHOREOGRAPHY. The test chooses when to call
 * `assembleAuditContext`; it does not choose what `writeRetrievalTerminals` then writes. The
 * terminal write is the SAME function production calls at step 13, and the bytes it hashes are
 * whatever it is handed. So the two things recorded here are facts about production code: that
 * nothing reaches the transport before assembly returns (there is no statement in
 * `assembleAuditContext` to reach it, and the terminal write is the first one that does), and —
 * proof 23.2, which is the load-bearing half — that what the primary row carries is a function of
 * assembly's output and therefore could not have been computed at step 7.
 *
 * Returns the transport positions of each moment, so the order is asserted at the wire.
 */
async function observeTerminalOrder(hits: CiteHit[], normHits: CiteHit[]) {
  const KEY_ENV = 'CDMSS_TELEMETRY_HMAC_KEY';
  const before = process.env[KEY_ENV];
  process.env[KEY_ENV] = 'proof-23-key';
  try {
    const db = installDbStub();
    db.on(UPDATE_TERMINAL, [{ row_revision: 1 }]);

    // ── STEPS 7 AND 8 — both retrievals captured IN MEMORY. Production writes no terminal here. ──
    const primaryCapture = createTelemetryCapture('primary');
    primaryCapture.indexVersion = 'embedding|nomic-embed-text';
    const normativeCapture = createTelemetryCapture('normative_channel');
    normativeCapture.indexVersion = 'embedding|nomic-embed-text';
    const terminalsAfterRetrieval = db.matching(UPDATE_TERMINAL).length;

    // ── STEP 9 — the combined context. This is the moment the proof is about. ──
    const { citedContext } = assembleAuditContext(hits, normHits);
    const terminalsAtAssembly = db.matching(UPDATE_TERMINAL).length;
    const callsAtAssembly = db.calls.length;

    // ── STEPS 10-13 — the production function, unchanged and unwrapped. ──
    const handle: LifecycleHandle = {
      invocationId: 'inv-23',
      runs: [lifecycleRun('primary', 'run-23-primary'), lifecycleRun('normative_channel', 'run-23-normative')],
      persistenceIntent: 'will_persist',
    };
    await retrievalTerminalsSeam.writeRetrievalTerminals({
      tele: TELE_CTX_23, handle, publishHandle: () => {},
      traceId: null, startedAt: AT, citedContext, primaryCapture, normativeCapture,
    });

    const updates = db.matching(UPDATE_TERMINAL);
    const firstTerminalCallIndex = db.calls.findIndex((c) => UPDATE_TERMINAL.test(c.query));
    return {
      citedContext, updates, key: 'proof-23-key',
      terminalsAfterRetrieval, terminalsAtAssembly, callsAtAssembly, firstTerminalCallIndex,
    };
  } finally {
    if (before === undefined) delete process.env[KEY_ENV]; else process.env[KEY_ENV] = before;
  }
}

test('23.1 — OBSERVED AT EXECUTION: zero terminal writes have reached the transport when assembleAuditContext returns, and both arrive after it — never between primary retrieval and context assembly', async () => {
  const r = await observeTerminalOrder([lit23(1), lit23(2), lit23(3)], [cw23(101)]);

  // ⚠️ THE NEGATIVE THE PROOF STATEMENT NAMES. "Never immediately after primary retrieval" is this:
  // at the point primary and normative results exist in memory and nothing else has run, the
  // database has seen no terminal write at all.
  assert.equal(r.terminalsAfterRetrieval, 0, 'steps 7 and 8 write no terminal — the captures are in memory');
  assert.equal(r.terminalsAtAssembly, 0, 'and step 9 has still written none when it returns');

  // …and then both do arrive, at wire positions after the moment assembly returned.
  assert.equal(r.updates.length, 2, 'two terminal writes reached the transport — primary then normative');
  assert.ok(r.firstTerminalCallIndex >= r.callsAtAssembly,
    `the first terminal statement is at transport position ${r.firstTerminalCallIndex}, at or after assembly's ${r.callsAtAssembly}`);
  assert.equal(String(r.updates[0].params[0]), 'run-23-primary', 'the PRIMARY terminal is the first of the two');
  assert.equal(String(r.updates[1].params[0]), 'run-23-normative');
});

test('23.2 — OBSERVED AT EXECUTION, and this is the load-bearing half: the primary row carries the keyed HMAC of exactly assembleAuditContext\'s bytes, which is NOT the HMAC of the context that existed at step 7 — so the write cannot have happened there', async () => {
  const hits = [lit23(1), lit23(2), lit23(3)];
  const normHits = [cw23(101)];
  const r = await observeTerminalOrder(hits, normHits);

  // $20 is context_hmac (lib/retrieval-telemetry-store.ts:325), so params[19] at the wire.
  const primaryHmac = r.updates[0].params[19];
  assert.equal(primaryHmac, telemetryHmac(r.key, r.citedContext),
    'the primary row hashes the EXACT bytes assembleAuditContext returned');

  // ⚠️ THE STEP-7 COUNTERFACTUAL, COMPUTED RATHER THAN ASSERTED IN PROSE. At step 7 only the
  // primary hit set exists, so the only context assembleable there is assembleAuditContext(hits, []).
  // The row does not carry its HMAC. A terminal write issued immediately after primary retrieval
  // would necessarily have carried that value instead — which is precisely the comment at
  // lib/opd-note-audit.ts:1612-1615 ("a scorer-context HMAC written there would be a hash of
  // something the scorer never saw"), now shown by execution rather than read.
  const stepSevenContext = assembleAuditContext(hits, []).citedContext;
  assert.notEqual(r.citedContext, stepSevenContext, 'the two contexts genuinely differ — the fixture has a normative block');
  assert.notEqual(primaryHmac, telemetryHmac(r.key, stepSevenContext),
    'the row does NOT carry the step-7 context\'s HMAC');
  assert.notEqual(primaryHmac, telemetryHmac(r.key, hits.map((h) => h.text).join('\n')),
    'nor the raw passages — the RENDERED combined context is what the scorer sees');

  // The normative row carries null, so the combined-context claim lives on exactly one row.
  assert.equal(r.updates[1].params[19], null, 'NORMATIVE: null — it makes no claim about the scorer context');
});

test('23.3 — SUPPORTING SOURCE PIN ONLY (23.1 and 23.2 are the proof): in comment-stripped source, auditOpdNote retrieves, then assembles, then writes the terminals — and issues no terminal write in between', () => {
  // ⚠️ SUPPORTING, NEVER THE PROOF. Review 37's ruling on proof 47 governs: a source pin is
  // insufficient where execution is possible, and it is possible above. This exists so a future
  // reordering of the production caller fails something, since 23.1 and 23.2 drive the terminal
  // write directly and would not see the caller move.
  const src = readFileSync('lib/opd-note-audit.ts', 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n').filter((l) => !/^\s*\/\//.test(l)).join('\n');

  const retrieve = src.indexOf('const hits = await defaultRetrieve(query, mini, opts.evalNormativeLeg, opts.rerankBackend, primaryCapture);');
  const assemble = src.indexOf('const { sources, citedContext } = assembleAuditContext(hits, normHits);');
  const terminals = src.indexOf('manifestDefectsByRole = await writeRetrievalTerminals({');
  assert.ok(retrieve > 0 && assemble > 0 && terminals > 0, 'all three D11 landmarks are present');
  assert.ok(retrieve < assemble, 'step 7 precedes step 9');
  assert.ok(assemble < terminals, 'step 9 precedes steps 12-13');

  // Nothing writes a terminal between primary retrieval and context assembly.
  const between = src.slice(retrieve, assemble);
  assert.equal(/writeRetrievalTerminals?\s*\(/.test(between), false,
    'no terminal write is issued between primary retrieval and context assembly');
  // And exactly one terminal-write call site exists in the whole steps-7-to-13 region.
  const region = src.slice(retrieve, src.indexOf("if (traceId) await logEvent(traceId, 'opd_audit_sources'", retrieve));
  assert.equal((region.match(/writeRetrievalTerminals\(\{/g) ?? []).length, 1, 'exactly one terminal-write call site');
});

// ════════════════════════════════════════════════════════════════════════════════════════════════
// 24 — trace_id: null at declaration, written at the terminal write, null for BOTH trace:false callers
// ════════════════════════════════════════════════════════════════════════════════════════════════

const TRACE_SENTINEL = 'trace-24-4f3a2b1c';

/** One run declared and then terminal-written, with a distinctive traceId, so both statements for
 *  the SAME run are captured at the transport and can be compared against each other. */
async function declareThenTerminal(traceId: string | null) {
  const db = installDbStub();
  db.on(INSERT_RUNS, [{ retrieval_run_id: 'r24' }]);
  db.on(UPDATE_TERMINAL, [{ row_revision: 1 }]);
  const handle = await declareRetrievals(
    ctx, [{ role: 'primary', runId: 'r24', uid: 'u', engineVersion: 'e' }], 'will_persist');
  await writeRetrievalTerminal(handle, 'primary', {
    payload: payloadFor('primary'), operational: operational('primary'), traceId, completedAt: AT,
  });
  return { db, insert: db.matching(INSERT_RUNS)[0], update: db.matching(UPDATE_TERMINAL)[0] };
}

test('24.1 — the declaration INSERT binds FOURTEEN columns at the transport and trace_id is not among them: the column is never written at declaration, and is not written as null either — it is not in the statement at all', async () => {
  const { insert, update } = await declareThenTerminal(TRACE_SENTINEL);

  // ⚠️ READ OFF THE CAPTURED STATEMENT, NOT THE SOURCE FILE. `insert.query` and `insert.params` are
  // what the driver posted — the same bytes Postgres would have received.
  assert.equal(insert.params.length, 14, 'one declared run, fourteen bound values');
  const cols = insert.query
    .slice(insert.query.indexOf('(') + 1, insert.query.indexOf(')'))
    .split(',').map((c) => c.trim());
  assert.equal(cols.length, 14, 'and fourteen named columns');
  assert.equal(cols.includes('trace_id'), false, `trace_id is not a declared column: ${cols.join(', ')}`);
  assert.equal(/\btrace_id\b/.test(insert.query), false, 'the declaration statement does not name trace_id anywhere');
  // The placeholder list matches the parameter list exactly — no fifteenth value smuggled in.
  assert.deepEqual(
    (insert.query.match(/\$\d+/g) ?? []).map((p) => Number(p.slice(1))),
    Array.from({ length: 14 }, (_, i) => i + 1),
    'VALUES ($1 … $14), one placeholder per bound value');

  // ⚠️ THE PAIR, AT THE WIRE. The same run id's terminal write DOES carry the sentinel, and the
  // declaration carries it nowhere. That is proof 24's first two halves stated as one observation.
  assert.equal(insert.params.includes(TRACE_SENTINEL), false, 'the sentinel is bound by no declaration parameter');
  assert.equal(update.params.includes(TRACE_SENTINEL), true, 'and it IS bound by the terminal write');
  assert.equal(String(insert.params[0]), 'r24');
  assert.equal(String(update.params[0]), 'r24', 'both statements are about the same run');
});

test('24.2 — the terminal UPDATE writes trace_id at $6, and binds exactly what the caller was holding — the sentinel when there is a trace, null when there is not', async () => {
  const withTrace = await declareThenTerminal(TRACE_SENTINEL);
  assert.match(withTrace.update.query, /trace_id = \$6,/, '$6 is the trace_id assignment');
  assert.equal(withTrace.update.params[5], TRACE_SENTINEL, 'and $6 carries the traceId');

  // ⚠️ THE trace:false CONSEQUENCE, EXECUTED. `auditOpdNote` leaves `traceId` undefined when
  // `opts.trace === false` and hands `traceId ?? null` to the terminal write, so what those two
  // callers produce at this statement is a bound null — not a missing column, and not a string.
  const withoutTrace = await declareThenTerminal(null);
  assert.equal(withoutTrace.update.params[5], null, 'a null traceId is bound as null at $6');
  assert.match(withoutTrace.update.query, /trace_id = \$6,/, 'the same statement, whatever the value');
});

test('24.3 — both trace:false callers, and the mechanism that makes their rows null: lib/mcp-tools.ts and scripts/metamorphic-llm-report.mjs each audit with trace:false AND telemetry wired, and auditOpdNote turns that flag into a null traceId at the terminal write', () => {
  // ⚠️ SOURCE-READ, AND WHY. `scripts/metamorphic-llm-report.mjs` is a `.mjs` script that the test
  // glob (`lib/**/__tests__/*.test.ts`) does not collect and that cannot be driven in-process; test
  // 52 above reads it the same way for the same reason. The MCP tool is a `.ts` module but reaching
  // its `trace: false` branch needs a db13 note row, so it is read too. What is EXECUTED is the
  // consequence — 24.2's null bind — not the callers.
  for (const [file, needle] of [
    ['lib/mcp-tools.ts', "pipeline: 'mini', engineTag: 'lab', trace: false,"],
    ['scripts/metamorphic-llm-report.mjs', "pipeline: 'mini', engineTag: 'lab', trace: false,"],
  ] as const) {
    const src = readFileSync(file, 'utf8');
    assert.ok(src.includes(needle), `${file} does not audit with trace: false`);
    // Both are RETRIEVING, INSTRUMENTED callers — otherwise "trace_id stays null" would be a
    // statement about rows that do not exist. Each wires telemetry onto the same call.
    assert.match(src, /telemetry: \{ ctx/, `${file} does not wire telemetry, so it declares no row`);
    assert.match(src, /persistenceIntent: 'never_persists'/, `${file} is not a never-persists caller`);
  }
  // ⚠️ COMMENT-STRIPPED BEFORE COUNTING. lib/mcp-tools.ts:482 is a COMMENT that names `trace: false`
  // to explain the row it produces, so a raw count reads two call sites where there is one. The
  // tool's other arm (`text`) audits nothing — it is an ungrounded governedChat pass with no
  // retrieval and no telemetry — so one call site is the whole of D10's claim for this file.
  const mcpCode = readFileSync('lib/mcp-tools.ts', 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n').filter((l) => !/^\s*\/\//.test(l)).join('\n');
  assert.equal((mcpCode.match(/trace: false/g) ?? []).length, 1,
    'exactly one trace:false audit call in the MCP tools — the one D10 names');

  // ⚠️ AND THE FILE'S OTHER AUDIT CALL PROVES THE FLAG IS PER-CALL, NOT PER-FILE. lib/mcp-tools.ts
  // audits twice: `mini_analyze` (never_persists, trace:false — D10's caller) and
  // `backfill_control` (will_persist, acting as the worker), which OMITS `trace` and is therefore
  // traced. Proof 24's claim is about the first and must not be read as covering the second: a
  // `trace_id` on a backfill_control row is correct, not a defect.
  const callBlocks = [...mcpCode.matchAll(/auditOpdNote\(/g)]
    .map((m) => mcpCode.slice(m.index!, mcpCode.indexOf('});', m.index!)));
  assert.equal(callBlocks.length, 2, 'the file audits twice');
  const untraced = callBlocks.filter((b) => b.includes('trace: false'));
  assert.equal(untraced.length, 1, 'exactly one of the two opts out of tracing');
  assert.match(untraced[0], /persistenceIntent: 'never_persists'/, 'and it is the never-persists arm');
  assert.match(callBlocks.find((b) => !b.includes('trace: false'))!, /persistenceIntent: 'will_persist'/,
    'the traced one is the will-persist arm, and its rows carry a trace_id by design');

  // The mechanism, in comment-stripped source: the flag becomes `undefined`, and the terminal write
  // coalesces it to null. Nothing between the two can reintroduce a trace id.
  const audit = readFileSync('lib/opd-note-audit.ts', 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n').filter((l) => !/^\s*\/\//.test(l)).join('\n');
  assert.ok(audit.includes('const doTrace = opts.trace !== false;'), 'trace:false is what clears doTrace');
  assert.match(audit, /const traceId = doTrace\s*\?/, 'and traceId is conditional on it');
  assert.ok(audit.includes(': undefined;'), 'the false arm yields undefined');
  assert.ok(audit.includes('traceId: traceId ?? null,'), 'which the terminal write binds as null');
});

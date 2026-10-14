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
import {
  assembleAuditContext, auditOpdLifecycleTestSeam, auditOpdNote, LifecycleFaultInjected,
  retrievalTerminalsSeam,
  type AuditOpdOpts, type LifecycleFaultPoint,
} from '../opd-note-audit.ts';
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

  // RE-PINNED (pass 4 forward correction). The statement is a ternary whose FALSE arm is the
  // unchanged five-argument production call; this anchors that arm.
  const retrieve = src.indexOf(': await defaultRetrieve(query, mini, opts.evalNormativeLeg, opts.rerankBackend, primaryCapture);');
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

// ════════════════════════════════════════════════════════════════════════════════════════════════
// PASS 4B — PROOFS 21, 22 AND 23, EXECUTED THROUGH THE REAL `auditOpdNote`
//
// ⚠️ WHY THIS BLOCK EXISTS AND WHAT IT REPLACES. Pass 4a's proof-23 test called
// `assembleAuditContext` and then called the terminal seam itself. The test's own choreography
// guaranteed the ordering it claimed to prove; it never executed `auditOpdNote`, so it proved the
// test's sequence rather than production's. Rep 42 held 23 out of that pass for exactly this
// reason, and recorded the cause as an ORCHESTRATOR SPECIFICATION ERROR — the pass 4a kickoff
// asked for the insufficient thing. Every proof below drives the real audit function through the
// fault seam and reads the result at the database transport.
//
// The seam is Saul Rep 42's shape: a module-private Symbol carrying an immutable per-call plan,
// attached by a frozen exported wrapper that clones the options and calls the real function. No
// public fault field on `AuditOpdOpts`; no mutable exported or global collaborator.
// ════════════════════════════════════════════════════════════════════════════════════════════════

const AT_4B = '2026-08-12T00:00:00.000Z';

/** A note row shaped as the worker hands it over. Deterministic — nothing here reaches a provider. */
const ROW_4B: Record<string, unknown> = {
  uid: 'uid-4b-0001', consult_uid: 'consult-4b', doctor_uid: 'doctor-4b',
  note_text: 'Fever 3 days, sore throat. Dx: viral URTI. Rx: montelukast 10mg OD, cetirizine 10mg OD.',
  created_at: AT_4B,
};

const TELE_4B: NonNullable<AuditOpdOpts['telemetry']> = {
  ctx: {
    invocationId: 'inv-4b', route: 'opd_audit_worker', routeClass: 'worker', deploymentSha: null,
    vercelRequestId: null, startedAt: AT_4B, routingFlags: {}, labExperimentId: null,
  },
  route: 'opd_audit_worker',
  persistenceIntent: 'will_persist',
};

/** Rep 42's canonical five, in D11 order. No expansion point and no rerank point exists. */
const FAULT_POINTS: LifecycleFaultPoint[] = [
  'after_declaration', 'after_primary_retrieval', 'after_normative_retrieval',
  'during_context_assembly', 'during_generation',
];
/** The four that fire before the terminal writes; `during_generation` fires after both. */
const PRE_TERMINAL_FAULTS = FAULT_POINTS.slice(0, 4);

/** Revision pairs as `[primary, normative_channel]`, read off a published handle. */
const revs = (h: LifecycleHandle): [number, number] => [
  h.runs.find((r) => r.role === 'primary')!.expectedRevision,
  h.runs.find((r) => r.role === 'normative_channel')!.expectedRevision,
];

/**
 * Drive the REAL `auditOpdNote` to a chosen fault and record what the owner and the database saw.
 *
 * ⚠️ HOW A SWALLOWED FAULT IS SURFACED (kickoff §5.1). `lib/opd-note-audit.ts`'s outer catch
 * returns a deterministic-only audit for every non-eval throw, so an injected fault would not
 * reject out of the function and — worse — all five faults would produce the SAME det-only audit,
 * leaving a test unable to tell which point fired, or whether the fault fired at all rather than
 * the audit failing for an unrelated reason. That is precisely the "proves nothing" shape this pass
 * exists to avoid. So the proofs pass `evalModel`, the one flag the source rethrows on, and assert
 * the propagated error is the injected `LifecycleFaultInjected` instance carrying its own point.
 * Every fault fires BEFORE any generation work, so the flag's only live effect here is the rethrow;
 * `4B-SEAM.5` below drives the non-eval path separately and pins the swallow as unchanged.
 */
async function driveFault(faultAt: LifecycleFaultPoint, over: Partial<AuditOpdOpts> = {}) {
  const KEY_ENV = 'CDMSS_TELEMETRY_HMAC_KEY';
  const before = process.env[KEY_ENV];
  process.env[KEY_ENV] = 'proof-4b-key';
  try {
    const db = installDbStub();
    db.on(UPDATE_TERMINAL, [{ row_revision: 1 }]);

    const handles: LifecycleHandle[] = [];
    const defects: Array<Record<string, readonly string[] | undefined> | undefined> = [];
    const opts: AuditOpdOpts = {
      telemetry: TELE_4B,
      evalNormativeChannel: true,
      evalModel: 'pass4b-fault-surface',
      trace: false,
      onLifecycleHandleUpdated: (h, d) => { handles.push(h); defects.push(d); },
      ...over,
    };

    let thrown: unknown;
    let audit: unknown;
    try {
      audit = await auditOpdLifecycleTestSeam.run(ROW_4B, opts, {
        faultAt, primaryHits: PRIMARY_FIXTURE, normativeHits: NORMATIVE_FIXTURE,
      });
    } catch (e) { thrown = e; }

    const terminals = db.matching(UPDATE_TERMINAL);
    return {
      db, handles, defects, thrown, audit, terminals,
      declarations: db.matching(INSERT_RUNS),
      last: handles[handles.length - 1],
    };
  } finally {
    if (before === undefined) delete process.env[KEY_ENV]; else process.env[KEY_ENV] = before;
  }
}

// ══ the seam itself — §2's seven properties ════════════════════════════════════════════════════

test('4B-SEAM.1 — the wrapper is frozen, exposes only `run`, and AuditOpdOpts carries no fault field', () => {
  assert.equal(Object.isFrozen(auditOpdLifecycleTestSeam), true, 'frozen exported wrapper');
  assert.deepEqual(Object.keys(auditOpdLifecycleTestSeam), ['run']);
  // §2.4 — the public options type is unchanged. A fault field would be visible in source.
  const SRC = readFileSync(new URL('../opd-note-audit.ts', import.meta.url), 'utf8');
  const optsBlock = SRC.slice(SRC.indexOf('export interface AuditOpdOpts {'), SRC.indexOf('/** Engine tag for mini-pipeline rows'));
  // `\b` matters: `defaultGenerate`, `defaultRetrieve` and "Default `will_persist`" all contain
  // the letters, and none of them is a fault field.
  assert.doesNotMatch(optsBlock, /\bfault/i, 'AuditOpdOpts must not gain a fault field');
  assert.doesNotMatch(optsBlock, /lifecycleFaultPlan|LIFECYCLE_FAULT_PLAN/, 'nor the plan by any name');
  // §2.5 — no install/reset, no mutable module-level collaborator object.
  assert.doesNotMatch(SRC, /export (?:let|var) /, 'no mutable exported binding');
  assert.doesNotMatch(SRC, /installLifecycle|resetLifecycle|__setLifecycle/, 'no install or reset function');
  // §2.1 — the plan key is a module-private Symbol, never exported.
  assert.match(SRC, /const LIFECYCLE_FAULT_PLAN = Symbol\(/);
  assert.doesNotMatch(SRC, /export const LIFECYCLE_FAULT_PLAN/);
});

test('4B-SEAM.2 — the plan is attached NON-ENUMERABLE, NON-WRITABLE and NON-CONFIGURABLE, on a clone, and holds exactly three fields', async () => {
  const SRC = readFileSync(new URL('../opd-note-audit.ts', import.meta.url), 'utf8');
  // §2.2's three descriptor flags, pinned at the one site that attaches the plan.
  const attach = SRC.slice(SRC.indexOf('Object.defineProperty(planned, LIFECYCLE_FAULT_PLAN, {'));
  assert.match(attach.slice(0, 400), /enumerable: false, writable: false, configurable: false,/);
  assert.match(SRC, /const planned: AuditOpdOpts = \{ \.\.\.opts \};/, 'the options are CLONED, never mutated');
  // The plan carries exactly Rep 42's three fields, and each is frozen before attachment.
  assert.match(attach.slice(0, 400), /value: Object\.freeze\(\{\s*faultAt: plan\.faultAt,\s*primaryHits: Object\.freeze\(/);
  const planIface = SRC.slice(SRC.indexOf('export interface LifecycleFaultPlan {'), SRC.indexOf('/** Module-private.'));
  assert.deepEqual([...planIface.matchAll(/^\s*readonly (\w+)/gm)].map((m) => m[1]),
    ['faultAt', 'primaryHits', 'normativeHits'], 'exactly faultAt, primaryHits, normativeHits');

  // BEHAVIOURAL: the caller's own options object never gains the symbol, before or after the run.
  const callerOpts: AuditOpdOpts = { telemetry: TELE_4B, evalModel: 'pass4b-fault-surface', trace: false };
  assert.deepEqual(Object.getOwnPropertySymbols(callerOpts), []);
  installDbStub();
  await assert.rejects(
    () => auditOpdLifecycleTestSeam.run(ROW_4B, callerOpts, { faultAt: 'after_declaration', primaryHits: [lit23(1)], normativeHits: [cw23(101)] }),
    (e: unknown) => e instanceof LifecycleFaultInjected,
  );
  assert.deepEqual(Object.getOwnPropertySymbols(callerOpts), [], 'the caller\'s options are untouched after the run');
  assert.deepEqual(Object.keys(callerOpts), ['telemetry', 'evalModel', 'trace'], 'and gained no string key either');
});

// ⚠️ 4B-SEAM.3 REMOVED, SUPERSEDED. It was a SOURCE-ONLY check and Rep 43 §3.4 requires a
// BEHAVIOURAL plan-free equality against the pre-seam baseline. That is `4C-4`; the source pin
// survives as `4C-4b`, supporting evidence only.

test('4B-SEAM.4 — PARALLEL CALLS CARRY INDEPENDENT PLANS: two concurrent runs do not see each other\'s faults', async () => {
  const KEY_ENV = 'CDMSS_TELEMETRY_HMAC_KEY';
  const before = process.env[KEY_ENV];
  process.env[KEY_ENV] = 'proof-4b-key';
  try {
    const db = installDbStub();
    db.on(UPDATE_TERMINAL, [{ row_revision: 1 }]);
    const mk = (faultAt: LifecycleFaultPoint) => auditOpdLifecycleTestSeam.run(
      ROW_4B,
      { telemetry: TELE_4B, evalNormativeChannel: true, evalModel: 'pass4b-fault-surface', trace: false },
      { faultAt, primaryHits: [lit23(1)], normativeHits: [cw23(101)] },
    ).then(() => null, (e) => e);

    // Started together, resolved together — no install/reset step exists to serialise them.
    const [a, b] = await Promise.all([mk('after_declaration'), mk('during_context_assembly')]);
    assert.ok(a instanceof LifecycleFaultInjected);
    assert.ok(b instanceof LifecycleFaultInjected);
    assert.equal((a as LifecycleFaultInjected).faultAt, 'after_declaration', 'call A kept its own plan');
    assert.equal((b as LifecycleFaultInjected).faultAt, 'during_context_assembly', 'call B kept its own plan');
  } finally {
    if (before === undefined) delete process.env[KEY_ENV]; else process.env[KEY_ENV] = before;
  }
});

test('4B-SEAM.5 — without evalModel the outer catch still swallows: the det-only audit is returned and the handle arrives only by callback', async () => {
  // The production non-eval path, unchanged by the seam. This is why the proofs above pass
  // `evalModel` deliberately rather than by accident — see driveFault's doc block.
  const r = await driveFault('during_context_assembly', { evalModel: undefined });
  assert.equal(r.thrown, undefined, 'nothing propagates on the non-eval path');
  const audit = r.audit as { llmLegFailed?: boolean; sources: unknown[]; suggestions: unknown[] };
  assert.equal(audit.llmLegFailed, true, 'the det-only fallback, exactly as today');
  assert.deepEqual(audit.sources, [], 'no sources — the throw preceded assembly');
  assert.deepEqual(audit.suggestions, []);
  assert.ok(r.handles.length >= 1, 'and the owner still holds a handle, delivered by the callback');
});

// ══ PROOF 21 — handle publication survives every fault ═════════════════════════════════════════

test('21.1 — declaration publishes both roles at revisions [0,0], through the real auditOpdNote', async () => {
  const r = await driveFault('after_declaration');
  assert.ok(r.thrown instanceof LifecycleFaultInjected, 'the fault fired, and it is the injected one');
  assert.equal((r.thrown as LifecycleFaultInjected).faultAt, 'after_declaration');
  assert.equal(r.declarations.length, 1, 'the real declaration INSERT reached the transport');
  assert.equal(r.handles.length, 1, 'exactly one publication — the declaration\'s');
  assert.deepEqual(revs(r.handles[0]), [0, 0], 'declaration publication is [0,0]');
  assert.equal(r.terminals.length, 0, 'and no terminal write happened');
});

test('21.2 — the primary terminal publishes [1,0]: the primary advanced and the normative has not', async () => {
  const r = await driveFault('during_generation');
  const primaryPublication = r.handles[1];
  assert.ok(primaryPublication, 'a publication follows the primary terminal write');
  assert.deepEqual(revs(primaryPublication), [1, 0], 'primary terminal publication is [1,0]');
});

test('21.3 — the normative terminal publishes [1,1]', async () => {
  const r = await driveFault('during_generation');
  const normativePublication = r.handles[2];
  assert.ok(normativePublication, 'a publication follows the normative terminal write');
  assert.deepEqual(revs(normativePublication), [1, 1], 'normative terminal publication is [1,1]');
  assert.deepEqual(revs(r.handles[0]), [0, 0], 'and the three publications are [0,0] → [1,0] → [1,1]');
});

test('21.4 — EVERY injected throw leaves the owner holding the latest published handle, all five points', async () => {
  const expected: Record<LifecycleFaultPoint, [number, number]> = {
    after_declaration: [0, 0],
    after_primary_retrieval: [0, 0],
    after_normative_retrieval: [0, 0],
    during_context_assembly: [0, 0],
    during_generation: [1, 1],
  };
  for (const faultAt of FAULT_POINTS) {
    const r = await driveFault(faultAt);
    assert.ok(r.thrown instanceof LifecycleFaultInjected, `${faultAt}: the injected fault fired`);
    assert.equal((r.thrown as LifecycleFaultInjected).faultAt, faultAt, `${faultAt}: at the named point`);
    assert.ok(r.last, `${faultAt}: the owner holds a handle`);
    assert.deepEqual(revs(r.last), expected[faultAt], `${faultAt}: and it is the LATEST published`);
    // The owner's handle is the last one published, not merely some handle.
    assert.deepEqual(revs(r.last), revs(r.handles[r.handles.length - 1]));
  }
});

// ══ PROOF 22 — settlement, through the real settlement API ═════════════════════════════════════

/** Settle a driven fault with the REAL API, with the row's current state stubbed at the transport. */
async function settleAfter(faultAt: LifecycleFaultPoint, currentState: string) {
  const r = await driveFault(faultAt);
  const db = r.db;
  const callsBeforeSettlement = db.calls.length;
  db.on(SELECT_ROW, [{ persistence_state: currentState, row_revision: faultAt === 'during_generation' ? 1 : 0, audit_id: null }]);
  db.on(UPDATE_SETTLE, [{ retrieval_run_id: 'r', persistence_state: 'audit_generation_failed' }]);
  const { settleOwned } = await import('../retrieval-settlement');
  await settleOwned(r.last, 'audit_generation_failed', null, r.defects[r.defects.length - 1]);
  return { ...r, callsBeforeSettlement, settles: db.matching(UPDATE_SETTLE) };
}

test('22.1 — the FIRST FOUR faults settle started → audit_generation_failed, through the real settlement API', async () => {
  for (const faultAt of PRE_TERMINAL_FAULTS) {
    const s = await settleAfter(faultAt, 'started');
    // The precondition, for the same reason M2 gave in 22.2: assert the fault fired at THIS point.
    assert.ok(s.thrown instanceof LifecycleFaultInjected, `${faultAt}: the fault actually fired`);
    assert.equal((s.thrown as LifecycleFaultInjected).faultAt, faultAt, `${faultAt}: at the named point`);
    assert.ok(s.settles.length >= 1, `${faultAt}: the real settlement API wrote a terminal state`);
    for (const call of s.settles) {
      assert.equal(call.params[2], 'audit_generation_failed', `${faultAt}: settles to audit_generation_failed`);
    }
    // The row it settled from is the one the transport reported: `started`.
    const reads = s.db.matching(SELECT_ROW);
    assert.ok(reads.length >= 1, `${faultAt}: settlement read the row's current state`);
  }
});

test('22.2 — during_generation settles retrieval_complete → audit_generation_failed', async () => {
  const s = await settleAfter('during_generation', 'retrieval_complete');
  // ⚠️ THE PRECONDITION, ASSERTED. Mutation row M2 deleted the `during_generation` fault outright
  // and this test still passed: both terminals had been written and the settlement was still
  // correct, so every assertion below held while the thing being settled FROM had never happened.
  // A test that cannot tell whether its own fault fired proves the settlement mapping, which
  // retrieval-settlement.test.ts already owns, and nothing about the path through auditOpdNote.
  assert.ok(s.thrown instanceof LifecycleFaultInjected, 'the generation fault actually fired');
  assert.equal((s.thrown as LifecycleFaultInjected).faultAt, 'during_generation');
  assert.equal(s.terminals.length, 2, 'both terminals were written first, so the row IS retrieval_complete');
  assert.ok(s.settles.length >= 1);
  for (const call of s.settles) {
    assert.equal(call.params[2], 'audit_generation_failed', 'settles to audit_generation_failed');
  }
});

test('22.3 — the started cases retain a NULL retrieval outcome: no terminal write ever ran for them', async () => {
  for (const faultAt of PRE_TERMINAL_FAULTS) {
    const r = await driveFault(faultAt);
    assert.equal(r.terminals.length, 0,
      `${faultAt}: zero terminal writes, so the row's retrieval outcome was never written and stays null`);
    // And the handle the owner settles with says so too: nothing advanced past revision 0.
    assert.deepEqual(revs(r.last), [0, 0], `${faultAt}: no run is linkable`);
  }
  // The contrast case, so the assertion above is not vacuous.
  const gen = await driveFault('during_generation');
  assert.equal(gen.terminals.length, 2, 'during_generation DID write both, and is not a null-outcome case');
});

test('22.4 — NO AUDIT SAVE occurs before settlement, on any of the five faults', async () => {
  const AUDIT_SAVE = /INSERT INTO opd_note_audits|UPDATE opd_note_audits/i;
  for (const faultAt of FAULT_POINTS) {
    const s = await settleAfter(faultAt, faultAt === 'during_generation' ? 'retrieval_complete' : 'started');
    assert.ok(s.thrown instanceof LifecycleFaultInjected, `${faultAt}: the fault actually fired`);
    const beforeSettlement = s.db.calls.slice(0, s.callsBeforeSettlement);
    assert.equal(beforeSettlement.filter((c) => AUDIT_SAVE.test(c.query)).length, 0,
      `${faultAt}: no audit row was saved before settlement`);
    assert.equal(s.db.calls.filter((c) => AUDIT_SAVE.test(c.query)).length, 0,
      `${faultAt}: and none at all — a faulted audit has nothing to save`);
  }
});

// ══ PROOF 23 — ordering, established through the actual caller ═════════════════════════════════

test('23.4 — A CONTEXT-ASSEMBLY FAULT PRODUCES ZERO TERMINAL WRITES, driven through the real auditOpdNote', async () => {
  // This is the pass-4a proof done properly: the ordering is production's, not the test's. The
  // test chooses only WHERE to fault; auditOpdNote chooses what has happened by then.
  const r = await driveFault('during_context_assembly');
  assert.ok(r.thrown instanceof LifecycleFaultInjected);
  assert.equal((r.thrown as LifecycleFaultInjected).faultAt, 'during_context_assembly');
  assert.equal(r.terminals.length, 0, 'nothing reached the terminal UPDATE before assembly');
  assert.equal(r.declarations.length, 1, 'though the declaration certainly did — so the run got that far');
  assert.equal(r.handles.length, 1, 'and the only publication is the declaration\'s');
});

test('23.5 — A GENERATION FAULT OCCURS ONLY AFTER BOTH TERMINAL WRITES, in the transport\'s own order', async () => {
  const r = await driveFault('during_generation');
  assert.ok(r.thrown instanceof LifecycleFaultInjected);
  assert.equal(r.terminals.length, 2, 'both terminals were written before generation was reached');
  const firstTerminal = r.db.calls.findIndex((c) => UPDATE_TERMINAL.test(c.query));
  const declaration = r.db.calls.findIndex((c) => INSERT_RUNS.test(c.query));
  assert.ok(declaration >= 0 && declaration < firstTerminal, 'declaration precedes the terminals at the wire');
  assert.deepEqual(revs(r.handles[r.handles.length - 1]), [1, 1], 'and both publications happened');
});

test('23.6 — the primary payload HMAC is over the COMBINED assembled context, computed by the real run', async () => {
  const r = await driveFault('during_generation');
  // $20 is context_hmac (lib/retrieval-telemetry-store.ts:325), so params[19] at the wire — the
  // same position 23.2 reads, but here the write was issued by the real `auditOpdNote`.
  // ⚠️ BOTH LEGS ARE PLANNED FIXTURES (Rep 43 A1). Pass 4b let the real `defaultRetrieve` run and
  // depended on missing provider configuration returning nothing — an environmental accident. The
  // row now reports what the plan supplied, and the test asserts that before using it.
  const m = manifestOf(r.terminals[0]);
  assert.equal(m.retrieval_outcome, 'success', 'the primary leg is a CONTROLLED input now, not a provider accident');
  assert.deepEqual(m.ordered_final_candidate_ids, PRIMARY_FIXTURE.map((h) => h.id), 'and carries the planned candidates');
  const hits = PRIMARY_FIXTURE;
  const normHits = NORMATIVE_FIXTURE;
  const primaryHmac = m.scorer_context_hmac;
  const { citedContext } = assembleAuditContext(hits, normHits);
  assert.equal(primaryHmac, telemetryHmac('proof-4b-key', citedContext),
    'the row carries the HMAC of the COMBINED context — literature plus the normative block');
  // The step-7 counterfactual, computed. Only the primary hits exist there, so the only context
  // assembleable at that moment is assembleAuditContext(hits, []). The row does not carry it.
  const stepSeven = assembleAuditContext(hits, []).citedContext;
  assert.notEqual(citedContext, stepSeven, 'the two contexts genuinely differ — the normative block is in one');
  assert.notEqual(primaryHmac, telemetryHmac('proof-4b-key', stepSeven),
    'so the write cannot have happened at step 7, before the normative hits existed');
  assert.equal(manifestOf(r.terminals[1]).scorer_context_hmac, null, 'and the normative row makes no scorer-context claim');
});

// ════════════════════════════════════════════════════════════════════════════════════════════════
// PASS 4 FORWARD CORRECTION — Saul Rep 43 A1/A3. THE PRIMARY LEG IS NOW FIXTURED.
//
// Pass 4b fixtured only the normative leg and let the real `defaultRetrieve` run on the primary.
// Rep 43: "It is a material deviation, not a harmless reduction in production change." He is right,
// and the reasons are worth keeping: that call can reach expansion and embedding providers; the
// database stub does not contain the OpenAI SDK's captured transport, so the isolation claimed
// there did not hold; 23.6 depended on MISSING LOCAL PROVIDER CONFIGURATION producing
// `retrieval_failure`, which is an environmental accident and not a controlled input; and the
// primary hit set was empty in practice, so proof 23 never established that BOTH primary and
// normative material reach the combined-context HMAC — which is the substance of proof 23.
//
// The tests below are Rep 43's seven §3 requirements, each named.
// ════════════════════════════════════════════════════════════════════════════════════════════════

/** The role manifest the terminal UPDATE binds at $21, read BY NAME rather than by index. */
const manifestOf = (call: { params: unknown[] }) =>
  JSON.parse(String(call.params[20])) as {
    retrieval_outcome: string;
    fused_candidate_ids: number[];
    hydrated_candidate_ids: number[];
    ordered_final_candidate_ids: number[];
    scorer_context_hmac: string | null;
  };

/** Non-empty on BOTH legs — §3.1. Three literature excerpts and two normative statements. */
const PRIMARY_FIXTURE = [lit23(1), lit23(2), lit23(3)];
const NORMATIVE_FIXTURE = [cw23(101), cw23(102)];

/**
 * §3.4 — the pre-seam baseline, OBSERVED, not asserted in prose.
 *
 * Captured by running the plan-free `auditOpdNote` under the same deterministic collaborators in
 * the `t4a` worktree at `5994922` — the last commit before the seam existed — and again in this
 * worktree, and byte-comparing the two. They were identical. This constant is that observation,
 * embedded so the equality is CHECKED on every run rather than claimed once.
 *
 * To regenerate: run the plan-free audit under `installDbStub` in a `5994922` worktree and dump
 * `{ audit (traceId removed), handles, statements }`.
 */
const PRESEAM_BASELINE = {
    "audit": {
      "keys": {
        "uid": "uid-4b-0001",
        "consultUid": "consult-4b",
        "doctorUid": "doctor-4b",
        "kxEncounterId": null,
        "consultType": null,
        "prescriptionType": null,
        "noteDate": null,
        "prescriptionUrl": null
      },
      "scorecard": {
        "headline": 62,
        "band": "C",
        "domains": [
          {
            "domain": "documentation",
            "label": "Documentation completeness",
            "score": 25,
            "weight": 0.25,
            "n": 1,
            "basis": "NABH OPD completeness 25%"
          },
          {
            "domain": "note_quality",
            "label": "Note quality (PDQI-9)",
            "score": 0,
            "weight": 0,
            "n": 0,
            "basis": "PDQI-9 not assessed"
          },
          {
            "domain": "appropriateness",
            "label": "Diagnostic & test appropriateness",
            "score": 100,
            "weight": 0.2,
            "n": 0,
            "basis": "no low-value/inappropriate orders flagged"
          },
          {
            "domain": "prescribing_safety",
            "label": "Prescribing quality & safety",
            "score": 100,
            "weight": 0.2,
            "n": 0,
            "basis": "no prescribing or interaction issues flagged"
          },
          {
            "domain": "patient_centred",
            "label": "Continuity & patient-centredness",
            "score": 0,
            "weight": 0.1,
            "n": 2,
            "basis": "0/2 continuity fields present"
          }
        ],
        "pdqi9": [],
        "confidence": "low",
        "flags": [],
        "caveat": "Note-level quality proxy from the documented encounter — documentation, note quality (PDQI-9), appropriateness and prescribing safety AS DEMONSTRATED IN THE NOTE. Not an outcomes measure and not a clinician scorecard; read at the encounter / service-line level."
      },
      "completeness": {
        "items": [
          {
            "key": "presenting_complaint",
            "label": "Presenting complaint",
            "present": false,
            "mandatory": true,
            "status": "missing",
            "section": "documentation"
          },
          {
            "key": "diagnosis",
            "label": "Diagnosis / impression",
            "present": false,
            "mandatory": true,
            "status": "missing",
            "section": "documentation"
          },
          {
            "key": "medication_dosing",
            "label": "Complete medication dosing",
            "present": true,
            "mandatory": true,
            "status": "present",
            "section": "documentation"
          },
          {
            "key": "advice_given",
            "label": "Advice / plan",
            "present": false,
            "mandatory": true,
            "status": "missing",
            "section": "continuity"
          },
          {
            "key": "follow_up",
            "label": "Follow-up specified",
            "present": false,
            "mandatory": true,
            "status": "missing",
            "section": "continuity"
          },
          {
            "key": "examination",
            "label": "Examination recorded",
            "present": false,
            "mandatory": true,
            "status": "missing",
            "section": "documentation"
          }
        ],
        "coverage": 0.25,
        "missing": [
          "Presenting complaint",
          "Diagnosis / impression",
          "Advice / plan",
          "Follow-up specified",
          "Examination recorded"
        ],
        "patientCentred": {
          "present": 0,
          "total": 2
        }
      },
      "findings": [],
      "suggestions": [],
      "sources": [],
      "engineVersion": "opd-note-audit/0.81.21",
      "complexity": {
        "band": null,
        "inputs": null
      },
      "quietingGen": 0,
      "llmLegFailed": true
    },
    "handles": [
      [
        "primary@0",
        "normative_channel@0"
      ],
      [
        "primary@1",
        "normative_channel@0"
      ],
      [
        "primary@1",
        "normative_channel@1"
      ]
    ],
    "statements": [
      "SELECT id, signal_type, discriminator, match_kind, scope, doctor_uid, ",
      "SELECT id, keywords, category FROM lvc_recommendations WHERE status = ",
      "SELECT id, signal_type, discriminator, match_kind, scope, doctor_uid, ",
      "SELECT coalesce(max(gen), 0)::int AS gen FROM quieting_policy_log",
      "INSERT INTO opd_retrieval_invocations (invocation_id, kind, route, rou",
      "INSERT INTO opd_audit_retrieval_telemetry (retrieval_run_id, retrieval",
      "CREATE TABLE IF NOT EXISTS backfill_runs ( id BIGSERIAL PRIMARY KEY, w",
      "CREATE UNIQUE INDEX IF NOT EXISTS backfill_runs_one_active_idx ON back",
      "CREATE INDEX IF NOT EXISTS backfill_runs_worker_created_idx ON backfil",
      "SELECT id, worker, model, to_char(day_from, 'YYYY-MM-DD') AS day_from,",
      "UPDATE opd_audit_retrieval_telemetry SET persistence_state = 'retrieva",
      "UPDATE opd_audit_retrieval_telemetry SET persistence_state = 'retrieva",
      "SELECT doctor_uid, speciality FROM doctor_directory WHERE speciality I"
    ]
  } as const;

/** The plan-free run, under the same deterministic collaborators the baseline was taken with. */
async function planFreeRun() {
  const KEY_ENV = 'CDMSS_TELEMETRY_HMAC_KEY';
  const before = process.env[KEY_ENV];
  process.env[KEY_ENV] = 'baseline-key';
  try {
    const db = installDbStub();
    db.on(UPDATE_TERMINAL, [{ row_revision: 1 }]);
    const handles: string[][] = [];
    const audit = await auditOpdNote(ROW_4B, {
      telemetry: TELE_4B, evalNormativeChannel: true, trace: false,
      onLifecycleHandleUpdated: (h) => handles.push(h.runs.map((r) => `${r.role}@${r.expectedRevision}`)),
    });
    const stable = JSON.parse(JSON.stringify(audit));
    delete stable.traceId;
    return { audit: stable, handles, statements: db.calls.map((c) => c.query.replace(/\s+/g, ' ').slice(0, 70)) };
  } finally {
    if (before === undefined) delete process.env[KEY_ENV]; else process.env[KEY_ENV] = before;
  }
}

// ══ §3.1 — both fixtures are consumed ══════════════════════════════════════════════════════════

test('4C-1 (§3.1) — NON-EMPTY primary AND normative fixtures are both consumed, and both reach the combined context', async () => {
  const r = await driveFault('during_generation');
  assert.equal(r.terminals.length, 2, 'both terminals were written');

  // PRIMARY: the row reports the fixture, not an accident. $3 is the retrieval outcome and $12 the
  // fused candidate count — pass 4b saw `retrieval_failure` and 0 here, from missing local provider
  // configuration. It now reports what the plan supplied.
  const primary = manifestOf(r.terminals[0]);
  const normative = manifestOf(r.terminals[1]);
  assert.equal(primary.retrieval_outcome, 'success', 'the primary leg succeeded — a controlled input');
  assert.deepEqual(primary.ordered_final_candidate_ids, PRIMARY_FIXTURE.map((h) => h.id),
    'and the row carries EXACTLY the three planned primary candidates');
  assert.deepEqual(primary.fused_candidate_ids, PRIMARY_FIXTURE.map((h) => h.id));
  assert.deepEqual(primary.hydrated_candidate_ids, PRIMARY_FIXTURE.map((h) => h.id));
  assert.equal(normative.retrieval_outcome, 'success', 'the normative leg too');
  assert.deepEqual(normative.ordered_final_candidate_ids, NORMATIVE_FIXTURE.map((h) => h.id),
    'with both planned normative statements');

  // And the combined context genuinely contains material from EACH leg.
  const { citedContext } = assembleAuditContext(PRIMARY_FIXTURE, NORMATIVE_FIXTURE);
  for (const h of PRIMARY_FIXTURE) assert.ok(citedContext.includes(h.text), `primary excerpt ${h.id} is in the combined context`);
  for (const h of NORMATIVE_FIXTURE) assert.ok(citedContext.includes(h.text), `normative statement ${h.id} is in the combined context`);
  assert.equal(primary.scorer_context_hmac, telemetryHmac('proof-4b-key', citedContext),
    'and the primary row hashes exactly that combined context');
  assert.equal(normative.scorer_context_hmac, null, 'the normative row makes no scorer-context claim');
});

test('4C-2 (§3.2) — removing ONLY the primary contribution changes the proof-23 HMAC', async () => {
  // The counterfactual that pass 4b could not run, because its primary set was empty: strip the
  // primary material and keep the normative, and the row's HMAC must no longer match. Mutation row
  // M6 is the executable half of this requirement.
  const r = await driveFault('during_generation');
  const primaryHmac = manifestOf(r.terminals[0]).scorer_context_hmac;
  const withBoth = assembleAuditContext(PRIMARY_FIXTURE, NORMATIVE_FIXTURE).citedContext;
  const normativeOnly = assembleAuditContext([], NORMATIVE_FIXTURE).citedContext;
  assert.notEqual(withBoth, normativeOnly, 'the two contexts genuinely differ');
  assert.equal(primaryHmac, telemetryHmac('proof-4b-key', withBoth));
  assert.notEqual(primaryHmac, telemetryHmac('proof-4b-key', normativeOnly),
    'the row does NOT carry the normative-only HMAC, so the primary material demonstrably reached it');
});

// ══ §3.3 — a planned call touches nothing outside the database transport ═══════════════════════

test('4C-3 (§3.3) — a PLANNED call reaches no provider, socket, corpus database, embedding or reranker', async () => {
  const KEY_ENV = 'CDMSS_TELEMETRY_HMAC_KEY';
  const before = process.env[KEY_ENV];
  process.env[KEY_ENV] = 'proof-4b-key';
  const db = installDbStub();
  db.on(UPDATE_TERMINAL, [{ row_revision: 1 }]);
  // Wrap the stub's own fetch so EVERY outbound request is recorded, whoever makes it.
  const stubbed = globalThis.fetch;
  const urls: string[] = [];
  globalThis.fetch = ((input: unknown, init?: unknown) => {
    urls.push(typeof input === 'string' ? input : String((input as { url?: string })?.url ?? input));
    return (stubbed as (a: unknown, b?: unknown) => Promise<Response>)(input, init);
  }) as typeof fetch;
  try {
    await assert.rejects(
      () => auditOpdLifecycleTestSeam.run(ROW_4B,
        { telemetry: TELE_4B, evalNormativeChannel: true, evalModel: 'pass4b-fault-surface', trace: false },
        { faultAt: 'during_generation', primaryHits: PRIMARY_FIXTURE, normativeHits: NORMATIVE_FIXTURE }),
      (e: unknown) => e instanceof LifecycleFaultInjected,
    );
  } finally {
    globalThis.fetch = stubbed;
    if (before === undefined) delete process.env[KEY_ENV]; else process.env[KEY_ENV] = before;
  }
  assert.ok(urls.length > 0, 'the run did reach the database transport, so the guard is not vacuous');
  // Every request is the Neon transport the stub owns. Nothing else was contacted.
  const foreign = urls.filter((u) => !/neon|localhost:?\d*\/sql|\/sql$/i.test(u));
  assert.deepEqual(foreign, [], `a planned call reached ${foreign.length} non-database host(s): ${foreign.join(', ')}`);
  // Named negatives, so a future transport rename cannot quietly satisfy the filter above.
  for (const forbidden of [/openai/i, /ollama/i, /embed/i, /rerank/i, /cohere/i, /openrouter/i, /generativelanguage/i, /bedrock/i]) {
    assert.deepEqual(urls.filter((u) => forbidden.test(u)), [], `no request matching ${forbidden}`);
  }
});

// ══ §3.4 — behavioural plan-free equality with the pre-seam baseline ═══════════════════════════

/**
 * Statements whose PRESENCE depends on how warm this process's module-level caches are, not on
 * anything the seam does: the suppression and quieting caches, and the backfill store's
 * CREATE TABLE IF NOT EXISTS warm-up. A standalone run issues them; a run after other tests in the
 * same file does not. Excluding them compares the run, not the order the file happened to execute
 * in. Everything the seam could plausibly affect — the invocation, the declaration, both terminals,
 * the settlement reads and the specialty read — is retained.
 */
const CACHE_WARMUP = /lvc_recommendations|quieting_policy_log|signal_type, discriminator|CREATE (?:TABLE|UNIQUE INDEX|INDEX)/;
const runStatements = (xs: readonly string[]) => xs.filter((q) => !CACHE_WARMUP.test(q));

test('4C-4 (§3.4) — the direct PLAN-FREE path is BEHAVIOURALLY equal to the pre-seam baseline, not merely source-equal', async () => {
  const now = await planFreeRun();
  // The whole observable surface: the returned audit, the handle publications in order, and the
  // statement sequence that reached the transport.
  assert.deepEqual(now.handles, PRESEAM_BASELINE.handles, 'the same publications, in the same order');
  assert.deepEqual(runStatements(now.statements), runStatements(PRESEAM_BASELINE.statements),
    'the same statements, in the same order');
  assert.deepEqual(now.audit, PRESEAM_BASELINE.audit, 'and the same audit, field for field');
  // Not vacuous: the filter must not have removed the telemetry statements the seam sits among.
  const kept = runStatements(now.statements);
  assert.ok(kept.some((q) => /INSERT INTO opd_audit_retrieval_telemetry/.test(q)), 'the declaration is compared');
  assert.equal(kept.filter((q) => /UPDATE opd_audit_retrieval_telemetry/.test(q)).length, 2, 'both terminals are compared');
});

test('4C-4b (§3.4, supporting) — the source pin remains, as supporting evidence only', () => {
  const SRC = readFileSync(new URL('../opd-note-audit.ts', import.meta.url), 'utf8');
  assert.equal([...SRC.matchAll(/\[LIFECYCLE_FAULT_PLAN\]/g)].length, 1, 'exactly one private-symbol read');
  assert.match(SRC, /: await defaultRetrieve\(query, mini, opts\.evalNormativeLeg, opts\.rerankBackend, primaryCapture\);/,
    'the plan-free arm is the unchanged five-argument production call');
});

// ══ §3.5 — the null retrieval outcome, OBSERVED at declaration ═════════════════════════════════

test('4C-5 (§3.5) — the first four proof-22 cases OBSERVE the null retrieval outcome at declaration', async () => {
  for (const faultAt of PRE_TERMINAL_FAULTS) {
    const r = await driveFault(faultAt);
    assert.equal(r.declarations.length, 1, `${faultAt}: the declaration reached the transport`);
    const stmt = r.declarations[0].query.replace(/\s+/g, ' ');
    // OBSERVED AT THE DECLARATION ITSELF, not inferred from revisions or from missing terminals.
    // The INSERT names fourteen columns and no outcome column is among them, so the declared row's
    // retrieval outcome is null in the database from the moment it exists.
    const cols = /\(([^)]*)\) VALUES/.exec(stmt)![1].split(',').map((c) => c.trim());
    assert.equal(cols.length, 14, `${faultAt}: fourteen bound columns`);
    assert.equal(cols.includes('retrieval_outcome'), false, `${faultAt}: retrieval_outcome is NOT declared`);
    assert.deepEqual(cols.filter((c) => /outcome/i.test(c)), [], `${faultAt}: no outcome column of any name`);
    assert.equal(cols.includes('persistence_state'), true, `${faultAt}: and the state IS declared`);
    // No bound parameter carries an outcome value either.
    for (const p of r.declarations[0].params) {
      assert.notEqual(p, 'success', `${faultAt}: no bound parameter is an outcome`);
      assert.notEqual(p, 'retrieval_failure', `${faultAt}: nor a failure outcome`);
    }
  }
});

// ══ §3.6 and §3.7 ══════════════════════════════════════════════════════════════════════════════

test('4C-6 (§3.6) — production callers and AuditOpdOpts are unchanged by the correction', () => {
  const SRC = readFileSync(new URL('../opd-note-audit.ts', import.meta.url), 'utf8');
  const optsBlock = SRC.slice(SRC.indexOf('export interface AuditOpdOpts {'), SRC.indexOf('/** Engine tag for mini-pipeline rows'));
  assert.doesNotMatch(optsBlock, /\bfault/i, 'no fault field');
  assert.doesNotMatch(optsBlock, /lifecycleFaultPlan|LIFECYCLE_FAULT_PLAN/, 'nor the plan by any name');
  // The one production call site the correction touches keeps its five-argument shape, which
  // rerank-backend.test.ts (NOT in this pass's file list, and untouched) independently pins.
  assert.match(SRC, /defaultRetrieve\(query, mini, opts\.evalNormativeLeg, opts\.rerankBackend, primaryCapture\)/);
  assert.match(SRC, /const normHits = faultPlan/, 'and the normative site keeps its guarded ternary');
});

test('4C-7 (§3.7) — no mutable global state is introduced', async () => {
  const SRC = readFileSync(new URL('../opd-note-audit.ts', import.meta.url), 'utf8');
  assert.doesNotMatch(SRC, /export (?:let|var) /, 'no mutable exported binding');
  assert.doesNotMatch(SRC, /globalThis\.[A-Za-z_$]+\s*=/, 'the module assigns nothing onto globalThis');
  assert.doesNotMatch(SRC, /installLifecycle|resetLifecycle|__setLifecycle/, 'no install or reset function');
  // BEHAVIOURAL: a planned run leaves no residue a later run could observe. The plan-free run after
  // two planned ones is still byte-equal to the pre-seam baseline.
  await driveFault('after_declaration');
  await driveFault('during_generation');
  const after = await planFreeRun();
  assert.deepEqual(after.audit, PRESEAM_BASELINE.audit, 'the plan-free path is unchanged by prior planned runs');
  assert.deepEqual(after.handles, PRESEAM_BASELINE.handles);
});

// ════════════════════════════════════════════════════════════════════════════════════════════════
// PROOF 44 — THE BACKFILL SNAPSHOT, THROUGH THE REAL TERMINAL PATH (pass 5, Rep 43 A4)
//
// `readBackfillActivity()` answers "what else was this machine doing while this retrieval ran".
// The value matters because §2's evidence boundary forbids reporting a cron tick as a workload: an
// overlap analysis that cannot tell 360 route invocations from 360 backfills is reporting the same
// work twice. `idle` is therefore a MEASUREMENT, not an absence, and the three-null read failure is
// a third state distinct from both.
//
// Every case below drives the REAL `auditOpdNote` to `during_generation`, so both terminals are
// written by production's own `writeRetrievalTerminals` and the snapshot is read off the operational
// block the row actually carries.
// ════════════════════════════════════════════════════════════════════════════════════════════════

const ACTIVE_RUN_SQL = /SELECT [\s\S]*FROM backfill_runs WHERE worker = \$1 AND status = 'active'/;

/** The operational block the terminal UPDATE binds, inside the role manifest. */
const operationalOf = (call: { params: unknown[] }) =>
  (JSON.parse(String(call.params[20])) as {
    operational: {
      active_backfill_run_id: string | null;
      active_backfill_target: string | null;
      active_backfill_state: string | null;
      retrieval_role: string;
    };
  }).operational;

/** Drive the real audit to `during_generation` with `backfill_runs` answering as `answer` says. */
async function driveWithBackfill(answer: Record<string, unknown>[] | Error) {
  const KEY_ENV = 'CDMSS_TELEMETRY_HMAC_KEY';
  const before = process.env[KEY_ENV];
  process.env[KEY_ENV] = 'proof-44-key';
  try {
    const db = installDbStub();
    db.on(UPDATE_TERMINAL, [{ row_revision: 1 }]);
    db.on(ACTIVE_RUN_SQL, answer);
    await assert.rejects(
      () => auditOpdLifecycleTestSeam.run(ROW_4B,
        { telemetry: TELE_4B, evalNormativeChannel: true, evalModel: 'pass4b-fault-surface', trace: false },
        { faultAt: 'during_generation', primaryHits: PRIMARY_FIXTURE, normativeHits: NORMATIVE_FIXTURE }),
      (e: unknown) => e instanceof LifecycleFaultInjected,
    );
    const terminals = db.matching(UPDATE_TERMINAL);
    assert.equal(terminals.length, 2, 'both terminals were written through the real path');
    return { db, terminals, activeRunCalls: db.matching(ACTIVE_RUN_SQL) };
  } finally {
    if (before === undefined) delete process.env[KEY_ENV]; else process.env[KEY_ENV] = before;
  }
}

const ACTIVE_ROW = {
  id: 4471, worker: 'opd', model: 'bedrock:global.anthropic.claude-haiku-4-5-20251001-v1:0',
  status: 'active', day_from: '2026-08-01', day_to: '2026-08-20', created_at: '2026-08-20T00:00:00.000Z',
};

test('44.1 — ACTIVE: the row records the run ID, run.model as the target, and exactly `active`', async () => {
  const r = await driveWithBackfill([ACTIVE_ROW]);
  const op = operationalOf(r.terminals[0]);
  assert.equal(op.active_backfill_run_id, String(ACTIVE_ROW.id), 'the run ID, as a string');
  assert.equal(op.active_backfill_target, ACTIVE_ROW.model,
    'the TARGET is run.model — BackfillRun has no `target` field, and what a run targets is the model it grades against');
  assert.equal(op.active_backfill_state, 'active');
});

test('44.2 — IDLE: a null ID, a null target, and exactly `idle` — never an absent field', async () => {
  const r = await driveWithBackfill([]);
  const op = operationalOf(r.terminals[0]);
  assert.equal(op.active_backfill_run_id, null);
  assert.equal(op.active_backfill_target, null);
  assert.equal(op.active_backfill_state, 'idle',
    'idle is a MEASUREMENT: without it an overlap analysis cannot tell 360 route invocations from 360 backfills');
  assert.notEqual(op.active_backfill_state, null, 'and it is emphatically not the read-failure state');
});

test('44.3 — READ FAILURE REMAINS FAIL-OPEN and records THREE NULLS, distinct from idle', async () => {
  const r = await driveWithBackfill(classedError('backfill_runs unavailable'));
  const op = operationalOf(r.terminals[0]);
  assert.equal(op.active_backfill_run_id, null);
  assert.equal(op.active_backfill_target, null);
  assert.equal(op.active_backfill_state, null, 'a null STATE — "we do not know", which idle is not');
  // FAIL-OPEN, and the wrap is required rather than cautious: the audit completed to its fault and
  // both terminals were still written. A telemetry read must never cost a retrieval its row.
  assert.equal(r.terminals.length, 2, 'the terminal writes happened anyway');
});

test('44.4 — activeRun BINDS WORKER `opd`, not ipd and not a default', async () => {
  const r = await driveWithBackfill([ACTIVE_ROW]);
  assert.ok(r.activeRunCalls.length >= 1, 'the active-run query reached the transport');
  for (const call of r.activeRunCalls) {
    assert.equal(call.params[0], 'opd', 'worker is bound as opd — this is the OPD audit path');
    assert.notEqual(call.params[0], 'ipd', 'BackfillWorker is opd | ipd, and this path is never ipd');
  }
});

test('44.5 — BOTH ROLES receive the SAME backfill snapshot', async () => {
  const r = await driveWithBackfill([ACTIVE_ROW]);
  const primary = operationalOf(r.terminals[0]);
  const normative = operationalOf(r.terminals[1]);
  assert.equal(primary.retrieval_role, 'primary');
  assert.equal(normative.retrieval_role, 'normative_channel');
  assert.deepEqual(
    { id: normative.active_backfill_run_id, target: normative.active_backfill_target, state: normative.active_backfill_state },
    { id: primary.active_backfill_run_id, target: primary.active_backfill_target, state: primary.active_backfill_state },
    'one snapshot, read once, given to both roles — not two reads that could disagree',
  );
  // And it is read ONCE per audit, so the two roles cannot straddle a backfill starting mid-run.
  assert.equal(r.activeRunCalls.length, 1, 'exactly one active-run read for the whole audit');
});

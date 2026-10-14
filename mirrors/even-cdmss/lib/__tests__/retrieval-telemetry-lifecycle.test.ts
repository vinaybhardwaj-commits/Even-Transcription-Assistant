/**
 * lib/__tests__/retrieval-telemetry-lifecycle.test.ts — kickoff tests 19, 20, 31, 32, 34, 52 and 53.
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
import { installDbStub, classedError } from './telemetry-db-stub';
import {
  declareRetrievals, writeRetrievalTerminal, applyTerminalState,
  attachRetrievalTelemetry, readRetrievalTelemetry, RETRIEVAL_TELEMETRY_PROPERTY,
  type LifecycleHandle,
} from '../retrieval-telemetry-store';
import { createTelemetryCapture, buildRetrievalPayload } from '../retrieval-capture';
import type { TelemetryRequestContext, OperationalTelemetry } from '../retrieval-telemetry-core';

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

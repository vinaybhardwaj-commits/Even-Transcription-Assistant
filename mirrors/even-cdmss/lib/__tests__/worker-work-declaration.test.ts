/**
 * lib/__tests__/worker-work-declaration.test.ts — kickoff tests 25, 26 and 27.
 *
 * ⚠️ WHAT THESE TESTS CAN AND CANNOT PROVE, SAID UP FRONT. There is no Next request harness in this
 * repository and no database in this sandbox, so a route's HTTP behaviour is asserted by reading
 * its source. A source pin proves the code says a thing; it does not prove the thing happens at run
 * time. What IS exercised behaviourally is everything the route delegates to — `declareNoteRuns`,
 * `declareRetrievals`, the failure evidence and the settlement — in retrieval-invocation-store and
 * retrieval-settlement, against a stubbed transport.
 *
 * The three route behaviours pinned here are the ones D10 specifies and nothing else asserts:
 * the 503, the sweep's per-day truth, and the reshaped re-audit.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { installDbStub, classedError } from './telemetry-db-stub';
import { declareNoteRuns, TelemetryDeclarationError } from '../retrieval-telemetry-store';
import type { TelemetryRequestContext } from '../retrieval-telemetry-core';

const WORKER = readFileSync('app/api/opd-audit/worker/route.ts', 'utf8');
const MINI_BACKFILL = readFileSync('app/api/admin/opd-audit-mini-backfill/route.ts', 'utf8');

const INSERT_RUNS = /INSERT INTO opd_audit_retrieval_telemetry/;
const INSERT_FAILURE = /INSERT INTO opd_retrieval_telemetry_failures/;

const ctx: TelemetryRequestContext = {
  invocationId: 'inv-1', route: 'opd_audit_worker', routeClass: 'worker',
  deploymentSha: null, vercelRequestId: null, startedAt: '2026-08-12T00:00:00.000Z',
  routingFlags: {},
};

// ════════════════════════════════════════════════════════════════════════════════════════════════
// THE SHARED DECLARATION — exercised, not pinned
// ════════════════════════════════════════════════════════════════════════════════════════════════

test('the declaration is ONE statement over the whole note set, with ids index-aligned to it', async () => {
  const db = installDbStub();
  db.on(INSERT_RUNS, (c) => {
    const ids: Array<{ retrieval_run_id: string }> = [];
    for (let i = 0; i < c.params.length; i += 14) ids.push({ retrieval_run_id: String(c.params[i]) });
    return ids;
  });
  const rows = [{ uid: 'u-1' }, { uid: 'u-2' }, { uid: 'u-3' }];
  const ids = await declareNoteRuns(ctx, rows, '0.81.21');

  assert.equal(db.matching(INSERT_RUNS).length, 1, 'one round trip for three notes');
  assert.equal(ids.length, 3);
  assert.equal(new Set(ids).size, 3, 'three distinct run ids');
  // Index alignment is the contract every caller relies on to thread `predeclaredTelemetry`.
  const insert = db.matching(INSERT_RUNS)[0];
  assert.deepEqual([insert.params[0], insert.params[14], insert.params[28]], ids);
  assert.deepEqual([insert.params[9], insert.params[23], insert.params[37]], ['u-1', 'u-2', 'u-3']);
  assert.deepEqual([insert.params[10], insert.params[24], insert.params[38]], ['0.81.21', '0.81.21', '0.81.21']);
  assert.deepEqual([insert.params[7], insert.params[21], insert.params[35]], ['started', 'started', 'started']);
});

test('a note with no uid declares a NULL uid, never the string "undefined"', async () => {
  const db = installDbStub();
  db.on(INSERT_RUNS, [{ retrieval_run_id: 'x' }]);
  await declareNoteRuns(ctx, [{ notauid: 1 }], '0.81.21');
  assert.equal(db.matching(INSERT_RUNS)[0].params[9], null);
});

test('25 — a failed declaration throws TelemetryDeclarationError and leaves per-run evidence', async () => {
  const db = installDbStub();
  db.on(INSERT_RUNS, classedError('NeonDbError'));
  db.on(INSERT_FAILURE, []);
  await assert.rejects(
    () => declareNoteRuns(ctx, [{ uid: 'u-1' }, { uid: 'u-2' }], '0.81.21'),
    (e: unknown) => e instanceof TelemetryDeclarationError && /no note of this day was processed/.test((e as Error).message),
  );
  assert.equal(db.matching(INSERT_FAILURE).length, 2, 'one work_declaration row per note it was going to declare');
});

// ════════════════════════════════════════════════════════════════════════════════════════════════
// 25, 26, 27 — the three route shapes, by source
// ════════════════════════════════════════════════════════════════════════════════════════════════

test('25 — all three worker modes reach the SAME fail-closed declaration, and it answers 503', () => {
  // Single-day and sweep both go through processDay, which declares before mapLimit.
  assert.match(
    WORKER,
    /const runIds = await declareNoteRuns\(ctx, rows as Array<Record<string, unknown>>, OPD_ENGINE_VERSION\);\n\s+const results = await mapLimit\(rows, conc,/,
    'processDay declares IMMEDIATELY before mapLimit — no note is processed before the rows are durable',
  );
  // The re-audit arm has its own declaration, inside its own try.
  assert.ok(WORKER.includes('const runIds = await declareNoteRuns(ctx, present.map((f) => f.row), OPD_ENGINE_VERSION);'));
  // …and two catches turn it into 503: the re-audit's own, and the outer one for day + sweep.
  assert.equal(
    (WORKER.match(/e instanceof TelemetryDeclarationError/g) || []).length, 2,
    'the re-audit arm returns before the outer try, so it needs its own typed branch',
  );
  assert.equal((WORKER.match(/\{ status: 503 \}/g) || []).length, 2);
  // A 500 would say the work failed. It did not start.
  assert.ok(!/TelemetryDeclarationError[\s\S]{0,200}status: 500/.test(WORKER));
});

test('26 — the sweep 503 body says earlier days persisted', () => {
  assert.ok(
    WORKER.includes('Any EARLIER day in this sweep was audited and persisted before this point; "no notes processed" is true per day, not per request.'),
    'the body says what survived — an operator told otherwise goes looking for rows that are there',
  );
  // The sweep loops over days and calls processDay per day, so the throw comes from ONE day.
  assert.match(WORKER, /for \(const d of days\)[\s\S]{0,900}await processDay\(d, max, conc, exclude, intended, ctx\)/);
});

test('27 — re-audit fetches first, declares only what resolved, and preserves count and order', () => {
  // 1+2: fetch every uid OUTSIDE mapLimit, keep the ones that resolved, declare for those only.
  assert.ok(WORKER.includes('const fetched = await mapLimit(uids, conc, async (uid) => ({ uid, row: await fetchOpdNoteByUid(uid).catch(() => null) }));'));
  assert.ok(WORKER.includes('const present = fetched.filter((f): f is { uid: string; row: Record<string, unknown> } => !!f.row);'));
  // 3: steps 1 and 2 sit in a NEW OUTER try that returns 503.
  assert.match(WORKER, /try \{\n\s+const fetched = await mapLimit\(uids[\s\S]{0,700}\} catch \(e\) \{\n\s+if \(e instanceof TelemetryDeclarationError\)/);
  // 5: the unresolved uids keep their exact row, and `count` is still the input length.
  assert.ok(WORKER.includes("byUid.get(uid) ?? { uid, error: 'note not found in db13' }"));
  assert.ok(WORKER.includes('count: uids.length'));
  // …and results are rebuilt in the INPUT order, so ordering survives the reshape.
  assert.ok(WORKER.includes('const results = uids.map((uid) =>'));
  // ⚠️ The existing per-uid catch is unchanged: every throw is still a 200 row, not a 500.
  assert.ok(WORKER.includes("return { uid, error: String((e as Error).message) };"));
});

test('the run ids are never reallocated — every audit call ADOPTS the declared id', () => {
  // D10: "Reuse these exact ids, never allocate a replacement, never insert a second started row."
  assert.equal(
    (WORKER.match(/predeclaredTelemetry: \{ primary: \{ runId, expectedRevision: 0 \} \}/g) || []).length, 2,
    'both worker arms adopt',
  );
  assert.ok(MINI_BACKFILL.includes('predeclaredTelemetry: { primary: { runId: runIds[idx], expectedRevision: 0 } },'));
  // Neither route mints a run id of its own: the shared declaration is the only allocator.
  assert.equal(/randomUUID\(\)/.test(WORKER), false, 'the worker allocates no run id itself');
  assert.equal(/randomUUID\(\)/.test(MINI_BACKFILL), false, 'nor does the mini-backfill');
});

test('the mini-backfill declares the same way and refuses the tick the same way', () => {
  assert.ok(MINI_BACKFILL.includes('const runIds = await declareNoteRuns(ctx, rows as Array<Record<string, unknown>>, OPD_ENGINE_VERSION);'));
  assert.ok(MINI_BACKFILL.includes('e instanceof TelemetryDeclarationError'));
  // Its refusal errors the RUN rather than returning a status code — this path is a cron tick with
  // no HTTP caller waiting on it, and an errored run is resumable, which a 503 to nobody is not.
  assert.match(MINI_BACKFILL, /TelemetryDeclarationError\n\s+\? `503 \$\{e\.message\}`/);
});

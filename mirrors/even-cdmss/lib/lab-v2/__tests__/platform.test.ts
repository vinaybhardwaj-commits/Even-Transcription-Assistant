// LAB-MCP-V2 §15.4–15.11, §15.14–15.15 — the durable platform, against real Postgres
// (PGlite). No network. Every lease/budget invariant is exercised as SQL, not as a mock.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { freshDb, migrationFile, expireLease, ARM, FROZEN } from './helpers';
import { applyMigrations } from '../store';
import {
  claim, ensureBudget, finish, getBudget, getRun, heartbeat, itemsOf, moveReservationToUnknown,
  putObject, reap, requestCancel, reserve, retryRun, settleReservation, setWorkerPaused, submitRun,
  deriveRunState, appliedMigrations,
} from '../store';
import { Gateway } from '../gateway';
import { fixtureTransport, type Transport } from '../transport';
import { opdAdapter } from '../adapters/opd';
import { opdAuditPerAttemptMs } from '../../opd-note-audit';
import { tick } from '../worker';
import type { Adapter } from '../adapters/types';
import { LabError, MAX_ATTEMPTS } from '../contracts';

const DEADLINE = 24 * 60 * 60 * 1000;

async function seedRun(db: Awaited<ReturnType<typeof freshDb>>, n = 1, idem = 'idem-1') {
  const budget = await ensureBudget(db, 'research', 'default', 1_000_000);
  const items = Array.from({ length: n }, (_, i) => ({
    case_key: `case-${i}`, arm_hash: 'armhash', repetition: 1,
    payload: { engine: 'stub', frozen: {}, arm: ARM, budget_id: budget.id },
  }));
  const out = await submitRun(db, 'research', 'experiment_run', null, budget.id, idem, 'reqhash', DEADLINE, items);
  return { ...out, budget };
}

/** A trivial adapter so the queue can be exercised without running a clinical engine. */
const stubAdapter = (behaviour: 'ok' | 'fail' | 'hang' = 'ok'): Adapter => ({
  engine: 'opd_note_audit',
  stages: ['analysis'],
  engineVersion: () => 'stub/1.0',
  frozenInputs: [],
  perAttemptTimeoutMs: 1_000,
  async run(ctx) {
    if (behaviour === 'fail') throw new LabError('STORE_UNAVAILABLE', 'stub failure');
    if (behaviour === 'hang') await new Promise((r) => setTimeout(r, 50));
    await ctx.gateway.call('analysis', { messages: [] });
    return { result: { ok: true }, summary: { ok: true }, execution_status: 'succeeded', assessment_status: 'assessed' };
  },
});
const stubMap = (b: 'ok' | 'fail' | 'hang' = 'ok') => ({ stub: stubAdapter(b) });

// ── §15.14 migration ─────────────────────────────────────────────────────────────────
test('§15.14: applying 0001 twice is a no-op', async () => {
  const db = await freshDb();
  const again = await applyMigrations(db, [migrationFile()]);
  assert.deepEqual(again.applied, []);
  assert.deepEqual(again.skipped, ['0001_platform.sql']);
  assert.deepEqual(await appliedMigrations(db), ['0001_platform.sql']);
  await db.close();
});

test('§15.14: a changed checksum on an applied name is an error, never a re-apply', async () => {
  const db = await freshDb();
  const tampered = { ...migrationFile(), sql: '-- edited\nSELECT 1;', checksum: 'deadbeef' };
  await assert.rejects(() => applyMigrations(db, [tampered]), (e: LabError) => /was applied with checksum/.test(e.message));
  await db.close();
});

// ── §15.4 idempotency ────────────────────────────────────────────────────────────────
test('§15.4: the same idempotency key returns one run, deduplicated', async () => {
  const db = await freshDb();
  const a = await seedRun(db, 2, 'same-key');
  const b = await seedRun(db, 2, 'same-key');
  assert.equal(a.deduplicated, false);
  assert.equal(b.deduplicated, true);
  assert.equal(a.run.id, b.run.id);
  assert.equal((await itemsOf(db, a.run.id)).length, 2, 'items are not duplicated on the retry');
  await db.close();
});

test('§15.4: a different idempotency key returns a second run', async () => {
  const db = await freshDb();
  const a = await seedRun(db, 1, 'key-a');
  const b = await seedRun(db, 1, 'key-b');
  assert.notEqual(a.run.id, b.run.id);
  assert.equal(b.deduplicated, false);
  await db.close();
});

test('§4.1: the same object body is the same object (UNIQUE kind, hash)', async () => {
  const db = await freshDb();
  const one = await putObject(db, 'research', 'arm', ARM, 'deidentified', null);
  const two = await putObject(db, 'research', 'arm', { ...ARM }, 'deidentified', null);
  assert.equal(one.object.id, two.object.id);
  assert.equal(two.deduplicated, true);
  await db.close();
});

// ── §15.5 claim ──────────────────────────────────────────────────────────────────────
test('§15.5: two concurrent claims on one queued item yield exactly one winner', async () => {
  const db = await freshDb();
  await seedRun(db, 1);
  const [a, b] = await Promise.all([claim(db, 'w1'), claim(db, 'w2')]);
  const winners = [a, b].filter(Boolean);
  assert.equal(winners.length, 1, 'exactly one worker may hold the lease');
  assert.equal(winners[0]!.lease_token, 1);
  assert.equal(winners[0]!.attempts, 1);
  await db.close();
});

// ── §15.6 lease ──────────────────────────────────────────────────────────────────────
test('§15.6: an abandoned lease is reaped and requeued; the third abandonment expires it', async () => {
  const db = await freshDb();
  const { run } = await seedRun(db, 1);
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
    const item = await claim(db);
    assert.ok(item, `attempt ${attempt} should claim`);
    assert.equal(item!.attempts, attempt);
    await expireLease(db, item!.id);
    // Requeue delay is 60 s, so pull next_at back to make the next claim eligible.
    const reaped = await reap(db);
    assert.equal(reaped, 1);
    await db.query(`UPDATE lab_v2.items SET next_at = now() WHERE run_id = $1`, [run.id]);
  }
  const [item] = await itemsOf(db, run.id);
  assert.equal(item.state, 'expired', 'the third abandonment expires the item');
  // §9 — even an expired item carries all three statuses.
  assert.equal(item.execution_status, 'expired');
  assert.equal(item.assessment_status, 'not_reached');
  assert.equal(item.attribution_status, 'unknown');
  assert.equal(await claim(db), null, 'an expired item is never claimed again');
  await db.close();
});

// ── §15.7 lease token ────────────────────────────────────────────────────────────────
test('§15.7: a stale lease token cannot finish an item', async () => {
  const db = await freshDb();
  await seedRun(db, 1);
  const first = await claim(db, 'w1');
  await expireLease(db, first!.id);
  await reap(db);
  await db.query(`UPDATE lab_v2.items SET next_at = now()`);
  const second = await claim(db, 'w2');
  assert.equal(second!.lease_token, 2);

  const zombie = await finish(db, first!.id, first!.lease_token, {
    state: 'succeeded', result: { zombie: true }, error: null,
    execution_status: 'succeeded', assessment_status: 'assessed', attribution_status: 'verified', outcome: 'succeeded',
  });
  assert.equal(zombie, false, 'the stale token writes nothing');
  const [item] = await itemsOf(db, first!.run_id);
  assert.equal(item.state, 'running', 'the live attempt still owns the item');
  assert.equal(item.result, null);
  assert.equal(await heartbeat(db, first!.id, first!.lease_token), false, 'a stale token cannot heartbeat either');
  await db.close();
});

// ── §15.8 cancel ─────────────────────────────────────────────────────────────────────
test('§15.8: queued items cancel at once and a running item is left to its abort signal', async () => {
  const db = await freshDb();
  const { run } = await seedRun(db, 3);
  const running = await claim(db);
  const cancelled = await requestCancel(db, run.id);
  assert.equal(cancelled, 2, 'the two still-queued items cancel immediately');
  const items = await itemsOf(db, run.id);
  const stillRunning = items.filter((i) => i.state === 'running');
  assert.equal(stillRunning.length, 1);
  assert.equal(stillRunning[0].id, running!.id);
  for (const i of items.filter((x) => x.state === 'cancelled')) {
    assert.equal(i.execution_status, 'cancelled');
    assert.equal(i.assessment_status, 'not_reached');
  }
  await db.close();
});

test('§15.8: a response that arrives after cancellation is stored with late_response', async () => {
  const db = await freshDb();
  const { run } = await seedRun(db, 1);
  const item = await claim(db);
  await requestCancel(db, run.id);
  const wrote = await finish(db, item!.id, item!.lease_token, {
    state: 'cancelled', result: { late_response: true }, error: { category: 'cancelled' },
    execution_status: 'cancelled', assessment_status: 'not_reached', attribution_status: 'verified', outcome: 'cancelled',
  });
  assert.equal(wrote, true, 'money already spent is not discarded');
  const [stored] = await itemsOf(db, run.id);
  assert.equal((stored.result as { late_response: boolean }).late_response, true);
  assert.equal(await deriveRunState(db, run.id), 'cancelled');
  await db.close();
});

// ── §15.9 budget ─────────────────────────────────────────────────────────────────────
test('§15.9: a reservation is refused at the cap, atomically', async () => {
  const db = await freshDb();
  const budget = await ensureBudget(db, 'research', 'small', 100);
  assert.equal(await reserve(db, budget.id, 60), true);
  assert.equal(await reserve(db, budget.id, 60), false, 'the second reservation exceeds the cap');
  assert.equal(await reserve(db, budget.id, 40), true, 'exactly to the cap is allowed');
  const after = await getBudget(db, budget.id);
  assert.equal(Number(after!.reserved_microusd), 100);
  await db.close();
});

test('§15.9: settlement moves reserved → spent; a transport error moves it to unknown', async () => {
  const db = await freshDb();
  const budget = await ensureBudget(db, 'research', 'b', 1000);
  await reserve(db, budget.id, 500);
  await settleReservation(db, budget.id, 500, 120);
  let row = await getBudget(db, budget.id);
  assert.equal(Number(row!.reserved_microusd), 0);
  assert.equal(Number(row!.spent_microusd), 120);

  await reserve(db, budget.id, 300);
  await moveReservationToUnknown(db, budget.id, 300);
  row = await getBudget(db, budget.id);
  assert.equal(Number(row!.reserved_microusd), 0);
  assert.equal(Number(row!.unknown_microusd), 300, 'unknown money stays against the cap');
  // The invariant still holds with unknown counted in.
  assert.ok(Number(row!.spent_microusd) + Number(row!.reserved_microusd) + Number(row!.unknown_microusd) <= Number(row!.cap_microusd));
  await db.close();
});

test('§6.3: the gateway refuses at the cap and records the call as refused', async () => {
  const db = await freshDb();
  const { run, budget } = await seedRun(db, 1);
  const item = (await itemsOf(db, run.id))[0];
  const gw = new Gateway({
    db, itemId: item.id, leaseToken: 0, budgetId: budget.id, transport: fixtureTransport(),
    stages: { analysis: { provider: 'bedrock', model: 'global.anthropic.claude-haiku-4-5-20251001-v1:0', max_cost_microusd: 10_000_000 } },
  });
  await assert.rejects(() => gw.call('analysis', { messages: [] }), (e: LabError) => e.code === 'BUDGET_EXHAUSTED');
  const calls = await db.query<{ state: string }>(`SELECT state FROM lab_v2.calls WHERE item_id = $1`, [item.id]);
  assert.deepEqual(calls.map((c) => c.state), ['refused']);
  await db.close();
});

test('§6.3: a transport error with no usage leaves the money in unknown, not forgotten', async () => {
  const db = await freshDb();
  const { run, budget } = await seedRun(db, 1);
  const item = (await itemsOf(db, run.id))[0];
  const gw = new Gateway({
    db, itemId: item.id, leaseToken: 0, budgetId: budget.id, transport: fixtureTransport(),
    stages: { analysis: { provider: 'ollama', model: 'fixture-fail', max_cost_microusd: 5000 } },
  });
  await assert.rejects(() => gw.call('analysis', { messages: [] }));
  const row = await getBudget(db, budget.id);
  assert.equal(Number(row!.unknown_microusd), 5000);
  assert.equal(Number(row!.reserved_microusd), 0);
  assert.equal(gw.attributionStatus(), 'unknown');
  await db.close();
});

test('decision 16: settlement charges ACTUAL, so calls.actual_microusd and spent agree', async () => {
  const db = await freshDb();
  const { run, budget } = await seedRun(db, 1);
  const item = (await itemsOf(db, run.id))[0];
  // A deliberately small reservation against a call that really costs 1,000,000 microusd
  // (1M input tokens of Haiku 4.5 at $1/M). Before decision 16 this settled at min(actual,
  // max) = 5,000 and the budget under-reported a real overspend by 995,000 microusd.
  const gw = new Gateway({
    db, itemId: item.id, leaseToken: 0, budgetId: budget.id,
    transport: fixtureTransport({ inputTokens: 1_000_000, outputTokens: 0 }),
    stages: { analysis: { provider: 'bedrock', model: 'global.anthropic.claude-haiku-4-5-20251001-v1:0', max_cost_microusd: 5_000 } },
  });
  const out = await gw.call('analysis', { messages: [] });
  assert.equal(out.actualMicrousd, 1_000_000);

  const [call] = await db.query<{ actual_microusd: string; state: string }>(
    `SELECT actual_microusd, state FROM lab_v2.calls WHERE item_id = $1`, [item.id]);
  const after = await getBudget(db, budget.id);
  assert.equal(call.state, 'settled');
  // The two numbers that must agree, and the reason the clamp had to go.
  assert.equal(Number(call.actual_microusd), 1_000_000);
  assert.equal(Number(after!.spent_microusd), 1_000_000);
  assert.equal(Number(after!.reserved_microusd), 0, 'the reservation is released in full');
  await db.close();
});

test('decision 16: the cap is enforced at RESERVATION, which is what still bounds spend', async () => {
  const db = await freshDb();
  const budget = await ensureBudget(db, 'research', 'tight', 1_000);
  // The cap refuses the reservation, so no call is ever dispatched and nothing is spent.
  // Charging `actual` at settlement does not weaken the cap; it only stops the budget
  // lying about money that was already gone.
  assert.equal(await reserve(db, budget.id, 5_000), false);
  const row = await getBudget(db, budget.id);
  assert.equal(Number(row!.spent_microusd), 0);
  assert.equal(Number(row!.reserved_microusd), 0);
  await db.close();
});

// ── decision 22 — every stage call carries a ceiling ─────────────────────────────────
test('decision 22: the gateway applies the engine ceiling, and a stage override outranks it', async () => {
  const db = await freshDb();
  const { run, budget } = await seedRun(db, 1);
  const item = (await itemsOf(db, run.id))[0];

  const seen: (number | undefined)[] = [];
  const spy: Transport = async (req) => { seen.push(req.timeoutMs); return fixtureTransport()(req); };

  // No stage override → the engine's own per-attempt ceiling, supplied by the adapter.
  await new Gateway({
    db, itemId: item.id, leaseToken: 0, budgetId: budget.id, transport: spy,
    stages: { analysis: { provider: 'ollama', model: 'local-model', max_cost_microusd: 5_000 } },
    defaultTimeoutMs: opdAdapter.perAttemptTimeoutMs,
  }).call('analysis', { messages: [] });

  // A stage that names its own timeout_ms wins.
  await new Gateway({
    db, itemId: item.id, leaseToken: 0, budgetId: budget.id, transport: spy,
    stages: { analysis: { provider: 'ollama', model: 'local-model', max_cost_microusd: 5_000, options: { timeout_ms: 12_345 } } },
    defaultTimeoutMs: opdAdapter.perAttemptTimeoutMs,
  }).call('analysis', { messages: [] });

  assert.deepEqual(seen, [380_000, 12_345]);
  // The ceiling is the engine's, read from PROVIDER_BUDGETS — not a number the lab invented.
  assert.equal(opdAdapter.perAttemptTimeoutMs, opdAuditPerAttemptMs());
  await db.close();
});

// ── decision 11 — an arm may only price a stage the engine actually runs ─────────────
test('decision 11: experiment_create refuses an unlisted stage with STAGE_UNKNOWN', async () => {
  const db = await freshDb();
  const { callTool } = await import('../service');
  const deps = { db, principal: 'research' as const, protocolVersion: 'x', sdkVersion: 'y' };

  const dataset = await putObject(db, 'research', 'dataset', {
    engine: 'opd_note_audit', cases: [{ case_key: 'c1', member_key: null, frozen: FROZEN }],
    snapshot_policy: 'single_case_at_creation', exclusions: [], classification: 'deidentified',
    source_versions: {}, replay_exactness: 'mutable_source',
  }, 'deidentified', 'ds-stage');

  const armWith = (stages: Record<string, unknown>) => ({
    hypothesis: 'h', dataset_id: dataset.object.id, dataset_hash: dataset.object.hash,
    baseline_arm: { engine: 'opd_note_audit', stages }, arms: [], repeats: 1,
    endpoints: [], budget_name: 'default', purpose: 'research', idempotency_key: `k-${Object.keys(stages).join('-')}`,
  });

  // `verification` was in the original §4.2 and the engine never had a call site for it.
  await assert.rejects(
    () => callTool(deps, 'experiment_create', armWith({
      analysis: { provider: 'ollama', model: 'local-model', max_cost_microusd: 100 },
      verification: { provider: 'ollama', model: 'local-model', max_cost_microusd: 100 },
    })),
    (e: { code?: string }) => e.code === 'STAGE_UNKNOWN',
  );

  // The same arm with only the real stage is accepted.
  const ok = await callTool(deps, 'experiment_create', armWith({
    analysis: { provider: 'ollama', model: 'local-model', max_cost_microusd: 100 },
  })) as { experiment_id: string };
  assert.ok(ok.experiment_id, 'a one-stage arm is fine');
  await db.close();
});

test('decision 11: an unpriced stage is still BUDGET_UNBOUNDED, not STAGE_UNKNOWN', async () => {
  const db = await freshDb();
  const { callTool } = await import('../service');
  const dataset = await putObject(db, 'research', 'dataset', {
    engine: 'opd_note_audit', cases: [{ case_key: 'c1', member_key: null, frozen: FROZEN }],
    snapshot_policy: 'single_case_at_creation', exclusions: [], classification: 'deidentified',
    source_versions: {}, replay_exactness: 'mutable_source',
  }, 'deidentified', 'ds-unbounded');
  await assert.rejects(
    () => callTool({ db, principal: 'research', protocolVersion: 'x', sdkVersion: 'y' }, 'experiment_create', {
      hypothesis: 'h', dataset_id: dataset.object.id, dataset_hash: dataset.object.hash,
      baseline_arm: { engine: 'opd_note_audit', stages: {} }, arms: [], repeats: 1,
      endpoints: [], budget_name: 'default', purpose: 'research', idempotency_key: 'k-none',
    }),
    (e: { code?: string }) => e.code === 'BUDGET_UNBOUNDED',
  );
  await db.close();
});

// ── §15.10 attribution ───────────────────────────────────────────────────────────────
test('§15.10: a mismatched served model is invalid, and the result is still stored', async () => {
  const db = await freshDb();
  const { run, budget } = await seedRun(db, 1);
  const item = (await itemsOf(db, run.id))[0];
  const gw = new Gateway({
    db, itemId: item.id, leaseToken: 0, budgetId: budget.id, transport: fixtureTransport({ reply: 'answered anyway' }),
    stages: { analysis: { provider: 'ollama', model: 'fixture-mismatch', max_cost_microusd: 5000 } },
  });
  const out = await gw.call('analysis', { messages: [] });
  assert.equal(out.text, 'answered anyway', 'the result is NOT discarded');
  assert.equal(gw.attributionStatus(), 'invalid');
  const [call] = await db.query<{ state: string; served: { model: string } }>(`SELECT state, served FROM lab_v2.calls WHERE item_id = $1`, [item.id]);
  assert.equal(call.state, 'settled');
  assert.equal(call.served.model, 'some-other-model');
  await db.close();
});

test('§6.2: a matching served model is verified', async () => {
  const db = await freshDb();
  const { run, budget } = await seedRun(db, 1);
  const item = (await itemsOf(db, run.id))[0];
  const gw = new Gateway({
    db, itemId: item.id, leaseToken: 0, budgetId: budget.id, transport: fixtureTransport(),
    stages: { analysis: { provider: 'ollama', model: 'local-model', max_cost_microusd: 5000 } },
  });
  await gw.call('analysis', { messages: [] });
  assert.equal(gw.attributionStatus(), 'verified');
  await db.close();
});

// ── §15.11 statuses + §15.15 tick ────────────────────────────────────────────────────
test('§15.15: a tick finishes at most four items and sets all three statuses on each', async () => {
  const db = await freshDb();
  const budget = await ensureBudget(db, 'research', 'default', 10_000_000);
  const items = Array.from({ length: 6 }, (_, i) => ({
    case_key: `c${i}`, arm_hash: 'h', repetition: 1,
    payload: { engine: 'stub', frozen: {}, arm: { stages: { analysis: { provider: 'ollama', model: 'local-model', max_cost_microusd: 5000 } } }, budget_id: budget.id },
  }));
  const { run } = await submitRun(db, 'research', 'experiment_run', null, budget.id, 'tick-1', 'h', DEADLINE, items);
  const report = await tick({ db, transport: fixtureTransport(), adapters: stubMap('ok') });
  assert.equal(report.claimed, 4, 'the tick claims at most four');
  assert.equal(report.finished, 4);
  const finished = (await itemsOf(db, run.id)).filter((i) => i.state === 'succeeded');
  assert.equal(finished.length, 4);
  for (const i of finished) {
    // §15.11 — all three, on every finished item.
    assert.equal(i.execution_status, 'succeeded');
    assert.equal(i.assessment_status, 'assessed');
    assert.equal(i.attribution_status, 'verified');
  }
  // §5.1 precedence: nothing is running and two items are still queued, so rule 6 gives
  // `queued` — NOT `partial` (nothing failed) and not `running` (the tick has returned).
  assert.equal(await deriveRunState(db, run.id), 'queued');
  await db.close();
});

test('§15.15: a paused worker claims nothing', async () => {
  const db = await freshDb();
  await seedRun(db, 2);
  await setWorkerPaused(db, true);
  const report = await tick({ db, transport: fixtureTransport(), adapters: stubMap('ok') });
  assert.equal(report.claimed, 0);
  assert.equal(report.paused, true);
  await setWorkerPaused(db, false);
  assert.equal((await tick({ db, transport: fixtureTransport(), adapters: stubMap('ok') })).claimed, 2);
  await db.close();
});

test('§15.11: a failed item still carries all three statuses, with not_reached', async () => {
  const db = await freshDb();
  const { run } = await seedRun(db, 1);
  await tick({ db, transport: fixtureTransport(), adapters: stubMap('fail') });
  const [item] = await itemsOf(db, run.id);
  assert.equal(item.state, 'failed');
  assert.equal(item.execution_status, 'failed');
  assert.equal(item.assessment_status, 'not_reached');
  assert.ok(item.attribution_status !== null, 'attribution is set even when nothing was served');
  await db.close();
});

// ── §5.5 retry ───────────────────────────────────────────────────────────────────────
test('§5.5: run_retry re-queues failed items and never a succeeded one', async () => {
  const db = await freshDb();
  const { run } = await seedRun(db, 2);
  await tick({ db, transport: fixtureTransport(), adapters: stubMap('fail') });
  let items = await itemsOf(db, run.id);
  assert.equal(items.filter((i) => i.state === 'failed').length, 2);

  const requeued = await retryRun(db, run.id);
  assert.equal(requeued, 2);
  await tick({ db, transport: fixtureTransport(), adapters: stubMap('ok') });
  items = await itemsOf(db, run.id);
  assert.equal(items.filter((i) => i.state === 'succeeded').length, 2);

  assert.equal(await retryRun(db, run.id), 0, 'a succeeded item is never re-run');
  await db.close();
});

test('§5.1: run state is derived from its items in the PRD precedence order', async () => {
  const db = await freshDb();
  const { run } = await seedRun(db, 2);
  assert.equal(await deriveRunState(db, run.id), 'queued');
  await tick({ db, transport: fixtureTransport(), adapters: stubMap('ok') });
  assert.equal(await deriveRunState(db, run.id), 'succeeded');
  assert.ok((await getRun(db, run.id))!.state === 'succeeded', 'the derived state is cached on the run');
  await db.close();
});

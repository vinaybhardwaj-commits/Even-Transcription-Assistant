/**
 * LAB-MCP-V2 §17.6 — `reaudit_plan` and `reaudit_execute` (decisions 67 and 68).
 *
 * ⚠️ THE ONE TEST THAT MATTERS MOST IS THE SPY. Decision 67 says a repair writes through the
 * ENGINE'S OWN store writer and never an UPDATE of its own. The way to prove that is not to read
 * rows back — a second write path would produce rows too — it is to hand the adapter a writer and
 * assert that IT was called, with the row the pipeline built, and that no other write happened.
 * §17.6 says so explicitly: "asserted by spying on it, never by SQL".
 *
 * ⚠️ AND THE SECOND IS THAT THE DOOR IS NARROW. A repair adapter is not in `ALL_ADAPTERS`; the only
 * thing that reaches one is a run whose `operation` is 'reaudit', and `operation` is not a
 * caller-supplied field anywhere in this platform. Both halves are asserted below, because either
 * alone would be a claim rather than a guarantee.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { freshDb } from './helpers';
import { callTool } from '../service';
import { ensureBudget, getObject, itemsOf, putObject, submitRun } from '../store';
import { tick } from '../worker';
import { ALL_ADAPTERS } from '../adapters/types';
import { makeIpdEpisodeAdapter, makeIpdEpisodeRepairAdapter } from '../adapters/ipd-episode';
import {
  CANARY_DEFAULT, CANARY_MAX, ESTIMATED_MICROUSD_PER_CASE, REPAIR_WRITERS, reauditExecute,
  reauditPlan, snapshotHash,
} from '../tools/repair';
import type { EpisodeAuditRow, CheckpointWriteRow } from '../../ipd-episode/store';
import { freezeIpdCase } from '../sources/ipd';
import { recordIpdSteps } from '../adapters/ipd-episode';
import { FIXTURE_AUDIT_ID, runFixtureEpisode, storedCheckpointsFrom, storedExtractionRow, storedRowFrom } from './fixtures/ipd-stored';
import { FIXTURE_ENCOUNTER, fixtureDeps, fixtureLedger } from './fixtures/episode-fixture';
import { fixtureTransport } from '../transport';
import type { Db } from '../db';

const deps = (db: Db, principal: 'research' | 'operator' | 'reviewer' | 'release' = 'operator') =>
  ({ db, principal, protocolVersion: 'test', sdkVersion: 'test' }) as never;

const SALT = 'b3-test-salt';

async function frozenCase() {
  const { row, checkpoints } = await runFixtureEpisode();
  const previous = process.env.LAB_V2_MEMBER_SALT;
  process.env.LAB_V2_MEMBER_SALT = SALT;
  try {
    return await freezeIpdCase(FIXTURE_AUDIT_ID, {
      readAudit: async () => [storedRowFrom(row)],
      readCheckpoints: async () => storedCheckpointsFrom(checkpoints),
      readExtraction: async () => [storedExtractionRow()],
      recordSteps: recordIpdSteps,
    });
  } finally {
    if (previous === undefined) delete process.env.LAB_V2_MEMBER_SALT;
    else process.env.LAB_V2_MEMBER_SALT = previous;
  }
}

// ── decision 67: the write is production's, and this file has none of its own ────────────────

test('§17.6 decision 67: reaudit writes through the ENGINE’S OWN writer, with the row the pipeline built', async () => {
  const db = await freshDb();
  const ledger = fixtureLedger();
  const live = fixtureDeps(ledger);

  // THE SPY. Not a database read: the claim is about WHICH function ran.
  // ⚠️ The case is a POINTER now, not a frozen case — decision 75. Handing this adapter a replay
  // case is what landed the orphan production row, and b3-fix1.test.ts asserts the refusal.
  const calls: { row: EpisodeAuditRow; checkpoints: CheckpointWriteRow[] }[] = [];
  const adapter = makeIpdEpisodeRepairAdapter({
    fetchDischargeSummary: live.fetchDischargeSummary as never,
    fetchProgressNotes: live.fetchProgressNotes as never,
    fetchExtractionByIpUid: live.fetchExtractionByIpUid as never,
    assembleEpisode: live.assembleEpisode as never,
    recordSkip: live.recordSkip as never,
    clearSkip: live.clearSkip as never,
    checkpoint: live.checkpoint as never,
    writeAudit: async (row, checkpoints) => {
      calls.push({ row, checkpoints });
      return { status: 'inserted', auditId: 'new-row-0001', failedCheckpoints: 0 };
    },
  });

  const budget = await ensureBudget(db, 'operator', 'repair', 10_000_000);
  const stages = {
    checkpoint: { provider: 'ollama', model: 'local-model', max_cost_microusd: 5000 },
    divergence: { provider: 'ollama', model: 'local-model', max_cost_microusd: 5000 },
    fidelity: { provider: 'ollama', model: 'local-model', max_cost_microusd: 5000 },
  };
  const { run } = await submitRun(db, 'operator', 'reaudit', null, budget.id, 'spy', 'h', 86_400_000, [{
    case_key: 'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa', arm_hash: 'h', repetition: 1,
    payload: {
      engine: 'ipd_episode',
      frozen: { audit_id: 'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa', encounter_id: FIXTURE_ENCOUNTER },
      arm: { engine_version: 'ipd-episode-audit/0.2', stages },
      budget_id: budget.id,
    },
  }]);
  await tick({ db, transport: fixtureTransport({ reply: JSON.stringify({ findings: [] }) }), adapters: { ipd_episode: adapter } });

  assert.equal(calls.length, 1, 'the engine’s writer ran exactly once');
  const [w] = calls;
  // The row is the PIPELINE'S row, not something the repair assembled: every field it carries came
  // out of computeEpisodeAudit, and these are the ones a stored row is scored from.
  assert.equal(w.row.engineVersion, 'ipd-episode-audit/0.2');
  assert.equal(w.row.encounterId, FIXTURE_ENCOUNTER);
  assert.equal(w.row.scoringStatus, 'ok');
  assert.ok((w.row.findings as unknown[]).length > 0, 'findings, from the run that just happened');
  assert.equal(w.checkpoints.length, 3, 'and one checkpoint row per checkpoint, carrying the blinding proof');
  assert.ok(w.checkpoints.every((cp) => typeof cp.inputCutoffAt === 'string' && cp.inputEventCount >= 0));

  const [item] = await itemsOf(db, run.id);
  assert.equal(item.state, 'succeeded');
  assert.equal((item.result as { summary: { repair: { status: string } } }).summary.repair.status, 'inserted');
  await db.close();
});

test('§17.6 decision 67: the repair tool contains no SQL of its own — not one statement', () => {
  const src = readFileSync(join(process.cwd(), 'lib/lab-v2/tools/repair.ts'), 'utf8');
  const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  // ⚠️ A repair that wrote its own INSERT would be a second write path with its own column list
  // and its own idea of what `is_current` means, and the first time the two disagreed nobody
  // would know which row was true. There is ONE read here — the plan-continuation count — and it
  // reads lab_v2, never a production table.
  // Checked in SQL POSITIONS, not as bare words: `REPAIR_WRITERS` names both production tables in
  // prose, on purpose, so the plan can tell an operator which writer will run. What must not exist
  // is a statement that touches one.
  for (const table of ['ipd_episode_audits', 'opd_note_audits', 'ipd_episode_checkpoints']) {
    for (const verb of ['FROM', 'INTO', 'UPDATE', 'JOIN']) {
      assert.ok(!code.includes(`${verb} ${table}`), `tools/repair.ts must not contain ${verb} ${table}`);
    }
  }
  for (const token of ['INSERT INTO', 'DELETE FROM']) {
    assert.ok(!code.includes(token), `tools/repair.ts must not contain ${token}`);
  }
  // ONE query in the whole file, and it is the plan-continuation count over the v2 store.
  // `db.query<{ id: string }>(` — the generic goes between the name and the paren.
  assert.equal((code.match(/db\.query[<(]/g) ?? []).length, 1, 'exactly one statement lives here');
  const selects = [...code.matchAll(/SELECT\s+[\s\S]{0,80}?FROM\s+([a-z0-9_.]+)/g)].map((m) => m[1]);
  assert.deepEqual([...new Set(selects)], ['lab_v2.runs'], 'the only statement here reads the v2 store');
  // and the writers it names are the production ones, by file and function
  assert.match(REPAIR_WRITERS.ipd_episode, /lib\/ipd-episode\/store\.ts saveEpisodeAudit/);
  assert.match(REPAIR_WRITERS.opd_note_audit, /lib\/opd-audit-store\.ts saveOpdAudit/);
});

test('§17.6 decision 67: an ORDINARY lab run writes nothing, whatever else it does', async () => {
  const db = await freshDb();
  const c = await frozenCase();
  let wrote = 0;
  // The same engine, the same frozen case, the ordinary adapter: the store writer is a no-op.
  const adapter = makeIpdEpisodeAdapter();
  const budget = await ensureBudget(db, 'research', 'default', 10_000_000);
  const { run } = await submitRun(db, 'research', 'experiment_run', null, budget.id, 'ordinary', 'h', 86_400_000, [{
    case_key: c.case_key, arm_hash: 'h', repetition: 1,
    payload: { engine: 'ipd_episode', frozen: c.frozen, arm: { stages: {} }, budget_id: budget.id },
  }]);
  await tick({ db, transport: (async () => { wrote += 1; throw new Error('no'); }) as never, adapters: { ipd_episode: adapter } });
  const [item] = await itemsOf(db, run.id);
  assert.equal(item.state, 'succeeded');
  assert.equal((item.result as { summary: { repair?: unknown } }).summary.repair, undefined,
    'no repair section, because nothing was written');
  assert.equal(wrote, 0, 'and nothing reached a provider either');
  await db.close();
});

test('§17.6 decision 67: the writing adapters are NOT in the global registry', () => {
  // ⚠️ The whole authorisation argument rests on this. If a repair adapter were registered, any
  // run of that engine would write production rows.
  const registered = ALL_ADAPTERS();
  assert.ok(registered.ipd_episode, 'the ordinary IPD adapter is registered');
  assert.ok(registered.opd_note_audit);
  // The ordinary instances have no writer; the repair factories are separate exports that
  // worker.ts reaches only for a run whose operation is 'reaudit'.
  const worker = readFileSync(join(process.cwd(), 'lib/lab-v2/worker.ts'), 'utf8');
  assert.match(worker, /run\?\.operation === 'reaudit'/, 'the gate is on the RUN’s operation');
  assert.match(worker, /makeIpdEpisodeRepairAdapter/);
  assert.match(worker, /makeOpdRepairAdapter/);
  const types = readFileSync(join(process.cwd(), 'lib/lab-v2/adapters/types.ts'), 'utf8');
  assert.ok(!types.includes('RepairAdapter'), 'and no repair adapter is in allAdapters()');
});

test('§17.6 decision 67: `operation` is never a caller-supplied field, which is what makes the gate hold', () => {
  // The four literals, and nothing reads an operation out of a tool's arguments.
  const files = ['lib/lab-v2/service.ts', 'lib/lab-v2/tools/replay.ts', 'lib/lab-v2/tools/repair.ts'];
  const submits = files.flatMap((f) => [...readFileSync(join(process.cwd(), f), 'utf8')
    .matchAll(/submitRun\(\s*\n?\s*(?:db|deps\.db)[^)]*?,\s*'([a-z_]+)'/gs)].map((m) => m[1]));
  assert.ok(submits.length >= 3, `expected the submit sites to be found, saw ${submits.length}`);
  for (const op of submits) {
    assert.ok(['experiment_run', 'run_replay', 'run_retry', 'reaudit'].includes(op), `unexpected operation '${op}'`);
  }
  assert.ok(submits.includes('reaudit'), 'reaudit_execute is one of them');
  const repair = readFileSync(join(process.cwd(), 'lib/lab-v2/tools/repair.ts'), 'utf8');
  assert.ok(!/args\.operation|operation:\s*String\(/.test(repair), 'the operation is a literal, never an input');
});

// ── decision 68: the canary, the review, the stale plan ─────────────────────────────────────

/**
 * A resolver that needs no database: the canary tests are about the WINDOW, not about resolution.
 * §17.6 decision 75 replaced the freeze here with a pointer, so this is what execute now needs.
 */
const stubResolve = async (ids: readonly string[]) => ids.map((id) => ({
  audit_id: id, encounter_id: `ENC-${id.slice(0, 8)}`, ip_uid: `ENC-${id.slice(0, 8)}`,
  current_engine_version: 'v0.2', already_at_version: false,
}));

/** Twelve audit-row ids, so a plan is longer than one canary window. */
const IDS = Array.from({ length: 12 }, (_, i) => `1111111${i.toString(16)}-2222-4333-8444-55555555555${i.toString(16)}`);

test('§17.6: an OPD case already current at the target version is planned as a NO-OP, and says why', async () => {
  const db = await freshDb();
  const searchOpd = async () => [
    { uid: 'note-1', engine_version: 'opd-note-audit/0.81.21' },
    // ⚠️ Already at the version the repair would write. saveOpdAudit's conflict clause refuses to
    // overwrite a successful row, so repairing it writes nothing — decision 67's "never an UPDATE"
    // holding, not an error. The PLAN says so before an operator spends anything on it.
    { uid: 'note-2', engine_version: 'opd-note-audit/0.82' },
  ];
  // §17.6 decision 74 — qualification is asked of the UID, so the resolver answers it.
  const resolveOpd = async () => new Map([
    ['note-1', { current_engine_version: 'opd-note-audit/0.81.21', already_at_version: false }],
    ['note-2', { current_engine_version: 'opd-note-audit/0.82', already_at_version: true }],
  ]);
  const plan = await reauditPlan({ db, principal: 'operator', searchOpd, resolveOpd }, {
    engine: 'opd_note_audit', engine_version: 'opd-note-audit/0.82', filter: {}, limit: 10,
  } as never);
  assert.equal(plan.cases.length, 2);
  assert.equal(plan.expected_writes, 1, 'only the one that is not already current');
  assert.equal(plan.cases[0].qualifies, true);
  assert.equal(plan.cases[1].qualifies, false);
  assert.match(plan.cases[1].reason, /would return 'exists' and write nothing/);
  assert.equal(plan.writer, REPAIR_WRITERS.opd_note_audit);
  assert.equal(plan.estimated_budget_microusd, 1 * ESTIMATED_MICROUSD_PER_CASE.opd_note_audit);
  // The plan is a stored operation_plan object, so it can be quoted back and refused later.
  const stored = await getObject(db, plan.plan_id);
  assert.equal(stored?.kind, 'operation_plan');
  assert.equal((stored?.body as { kind?: string }).kind, 'reaudit_plan');
  await db.close();
});

test('§17.6 decision 68: reaudit_execute refuses without a plan', async () => {
  const db = await freshDb();
  const notAPlan = await putObject(db, 'operator', 'report', { kind: 'run_report' }, 'deidentified', null);
  await assert.rejects(
    () => reauditExecute({ db, principal: 'operator' }, { plan_id: notAPlan.object.id, idempotency_key: 'k' }),
    (e: { code?: string; message?: string }) => e.code === 'INVALID_INPUT' && /not a reaudit plan/.test(String(e.message)),
  );
  await assert.rejects(
    () => reauditExecute({ db, principal: 'operator' }, { plan_id: '00000000-0000-4000-8000-000000000000', idempotency_key: 'k' }),
    (e: { code?: string }) => e.code === 'NOT_FOUND',
  );
  await db.close();
});

test('§17.6 decision 68: it stops at N, and N defaults to 5 and caps at 20', async () => {
  const db = await freshDb();
  const plan = await reauditPlan({ db, principal: 'operator', resolveIpd: stubResolve }, {
    engine: 'ipd_episode', engine_version: 'v0.3', filter: { audit_ids: IDS }, limit: 12,
  } as never);
  assert.equal(plan.cases.length, 12);
  assert.equal(plan.expected_writes, 12);
  assert.deepEqual(plan.canary, { n: CANARY_DEFAULT, max: CANARY_MAX });
  assert.equal(plan.writer, REPAIR_WRITERS.ipd_episode);
  assert.equal(plan.estimated_budget_microusd, 12 * ESTIMATED_MICROUSD_PER_CASE.ipd_episode);

  const out = await reauditExecute({ db, principal: 'operator', resolveIpd: stubResolve }, {
    plan_id: plan.plan_id, idempotency_key: 'canary-1',
  }) as never as { window: { from: number; to: number; of: number }; remaining: number; cases: { outcome: string }[] };
  assert.deepEqual(out.window, { from: 0, to: 5, of: 12 }, 'the first five, and it stops');
  assert.equal(out.remaining, 7);
  assert.equal(out.cases.length, 5);
  await db.close();
});

test('§17.6 decision 68: a second call without the review flag is refused', async () => {
  const db = await freshDb();
  const plan = await reauditPlan({ db, principal: 'operator', resolveIpd: stubResolve }, {
    engine: 'ipd_episode', engine_version: 'v0.3', filter: { audit_ids: IDS }, limit: 12,
  } as never);
  await reauditExecute({ db, principal: 'operator', resolveIpd: stubResolve }, { plan_id: plan.plan_id, idempotency_key: 'c1' });
  await assert.rejects(
    () => reauditExecute({ db, principal: 'operator', resolveIpd: stubResolve }, { plan_id: plan.plan_id, idempotency_key: 'c2' }),
    (e: { code?: string; message?: string }) => e.code === 'INVALID_INPUT' && /already run its canary/.test(String(e.message)),
  );
  await db.close();
});

test('§17.6 decision 68: review_passed without a reason is refused, and the reason is stored as an event', async () => {
  const db = await freshDb();
  const plan = await reauditPlan({ db, principal: 'operator', resolveIpd: stubResolve }, {
    engine: 'ipd_episode', engine_version: 'v0.3', filter: { audit_ids: IDS }, limit: 12,
  } as never);
  await reauditExecute({ db, principal: 'operator', resolveIpd: stubResolve }, { plan_id: plan.plan_id, idempotency_key: 'c1' });

  await assert.rejects(
    () => reauditExecute({ db, principal: 'operator', resolveIpd: stubResolve }, { plan_id: plan.plan_id, idempotency_key: 'c2', review_passed: true }),
    (e: { code?: string; message?: string }) => e.code === 'INVALID_INPUT' && /review_reason/.test(String(e.message)),
  );
  await assert.rejects(
    () => reauditExecute({ db, principal: 'operator', resolveIpd: stubResolve }, { plan_id: plan.plan_id, idempotency_key: 'c2', review_passed: true, review_reason: '   ' }),
    (e: { code?: string }) => e.code === 'INVALID_INPUT',
  );

  const out = await reauditExecute({ db, principal: 'operator', resolveIpd: stubResolve }, {
    plan_id: plan.plan_id, idempotency_key: 'c2', review_passed: true,
    review_reason: 'read all five: findings match the notes, no new commission class',
  }) as never as { window: { from: number; to: number }; review_passed: boolean };
  assert.deepEqual(out.window, { from: 5, to: 10, of: 12 }, 'the continuation picks up where the canary stopped');
  assert.equal(out.review_passed, true);

  const events = await db.query<{ kind: string; body: unknown }>(
    `SELECT kind, body FROM lab_v2.events WHERE kind = 'reaudit_review'`, []);
  assert.equal(events.length, 1, 'exactly one review event');
  assert.match(String((events[0].body as { reason?: string }).reason), /read all five/);
  await db.close();
});

test('§17.6 decision 68: the review event is written BEFORE the work, so a failed repair still records the authorisation', async () => {
  const db = await freshDb();
  const plan = await reauditPlan({ db, principal: 'operator', resolveIpd: stubResolve }, {
    engine: 'ipd_episode', engine_version: 'v0.3', filter: { audit_ids: IDS.slice(0, 5) }, limit: 5,
  } as never);
  await reauditExecute({ db, principal: 'operator', resolveIpd: stubResolve }, { plan_id: plan.plan_id, idempotency_key: 'c1' });
  // Every case is already submitted, so the continuation cannot run — and the reason is on the
  // record anyway, because a human said it before anything was attempted.
  await assert.rejects(
    () => reauditExecute({ db, principal: 'operator', resolveIpd: stubResolve }, {
      plan_id: plan.plan_id, idempotency_key: 'c2', review_passed: true, review_reason: 'looked, all good',
    }),
    (e: { code?: string }) => e.code === 'INVALID_INPUT',
  );
  const events = await db.query<{ body: unknown }>(`SELECT body FROM lab_v2.events WHERE kind = 'reaudit_review'`, []);
  assert.equal(events.length, 1, 'the authorisation is recorded even though nothing ran');
  await db.close();
});

test('§17.6 decision 68: a plan whose source rows have moved is PLAN_STALE', async () => {
  const db = await freshDb();
  let version = 'opd-note-audit/0.81.21';
  const searchOpd = async () => [{ uid: 'note-1', engine_version: version }, { uid: 'note-2', engine_version: version }];
  const resolveOpd = async () => new Map([
    ['note-1', { current_engine_version: version, already_at_version: false }],
    ['note-2', { current_engine_version: version, already_at_version: false }],
  ]);
  const plan = await reauditPlan({ db, principal: 'operator', searchOpd, resolveOpd }, {
    engine: 'opd_note_audit', engine_version: 'opd-note-audit/0.82', filter: {}, limit: 10,
  } as never);
  assert.match(plan.source_snapshot_hash, /^[0-9a-f]{64}$/);

  // Unchanged: the plan still describes the world, and the repair proceeds.
  const ok = await reauditExecute({
    db, principal: 'operator', searchOpd, resolveOpd,
    freezeOpd: async (k: string) => ({ case_key: k, member_key: null, frozen: { note: {} } }),
  }, { plan_id: plan.plan_id, idempotency_key: 'fresh' }) as never as { window: { to: number } };
  assert.equal(ok.window.to, 2);

  // ⚠️ THE NIGHTLY SWEEP RE-AUDITED THEM IN BETWEEN. The plan's premise — "these rows are at
  // 0.81.21" — is now false, and a repair built on it would be repairing something else.
  version = 'opd-note-audit/0.82';
  await assert.rejects(
    () => reauditExecute({
      db, principal: 'operator', searchOpd, resolveOpd,
      freezeOpd: async (k: string) => ({ case_key: k, member_key: null, frozen: { note: {} } }),
    }, { plan_id: plan.plan_id, idempotency_key: 'stale', review_passed: true, review_reason: 'continuing' }),
    (e: { code?: string; message?: string }) => e.code === 'PLAN_STALE' && /re-run reaudit_plan/.test(String(e.message)),
  );
  await db.close();
});

test('§17.6 decision 68: the snapshot hash is over (case, current version) and is order-independent', () => {
  const a = [{ case_key: 'u1', current_engine_version: 'v1' }, { case_key: 'u2', current_engine_version: 'v1' }];
  const b = [{ case_key: 'u2', current_engine_version: 'v1' }, { case_key: 'u1', current_engine_version: 'v1' }];
  assert.equal(snapshotHash(a), snapshotHash(b), 'the order a filter returned rows in is not a change');
  const moved = [{ case_key: 'u1', current_engine_version: 'v2' }, { case_key: 'u2', current_engine_version: 'v1' }];
  assert.notEqual(snapshotHash(a), snapshotHash(moved), 'a row that was re-audited IS a change');
  const gone = [{ case_key: 'u1', current_engine_version: 'v1' }];
  assert.notEqual(snapshotHash(a), snapshotHash(gone));
});

// ── the surface ─────────────────────────────────────────────────────────────────────────────

test('§17.6: reaudit_execute is operator-only, and never reachable by a research key', async () => {
  const db = await freshDb();
  for (const principal of ['research', 'reviewer', 'release'] as const) {
    await assert.rejects(
      () => callTool(deps(db, principal), 'reaudit_execute', { plan_id: '00000000-0000-4000-8000-000000000000', idempotency_key: 'k' }),
      (e: { code?: string }) => e.code === 'SCOPE_DENIED', `${principal} must not repair`,
    );
  }
  // The operator gets past the scope check and fails on the plan, which is the right failure.
  await assert.rejects(
    () => callTool(deps(db, 'operator'), 'reaudit_execute', { plan_id: '00000000-0000-4000-8000-000000000000', idempotency_key: 'k' }),
    (e: { code?: string }) => e.code === 'NOT_FOUND',
  );
  await db.close();
});

test('§17.6: reaudit_execute returns a run and never waits for it', async () => {
  const db = await freshDb();
  const plan = await reauditPlan({ db, principal: 'operator', resolveIpd: stubResolve }, {
    engine: 'ipd_episode', engine_version: 'v0.3', filter: { audit_ids: IDS.slice(0, 2) }, limit: 2,
  } as never);
  const out = await reauditExecute({ db, principal: 'operator', resolveIpd: stubResolve }, {
    plan_id: plan.plan_id, idempotency_key: 'async-1',
  }) as never as { run_id: string; cases: { outcome: string }[] };
  const items = await itemsOf(db, out.run_id, 10, 0);
  // ⚠️ NEVER SYNCHRONOUS. The items are QUEUED; the cron does the work. A repair that ran inside
  // the tool call would have to finish inside a request box, and a twelve-case plan cannot.
  assert.ok(items.length > 0);
  assert.ok(items.every((i) => i.state === 'queued'), 'the cron has not run yet');
  assert.ok(out.cases.every((c) => c.outcome === 'queued'));
  await db.close();
});

test('§17.6: a case that cannot be resolved is a per-case failure, not the plan’s', async () => {
  const db = await freshDb();
  const ids = IDS.slice(0, 3);
  const plan = await reauditPlan({ db, principal: 'operator', resolveIpd: stubResolve }, {
    engine: 'ipd_episode', engine_version: 'v0.3', filter: { audit_ids: ids }, limit: 3,
  } as never);
  // The middle audit row has vanished since the plan was made — the resolver returns two of three.
  // §17.6 decision 75 moved the per-case failure from the freeze to the resolution; the SHAPE of
  // the outcome is unchanged, which is the property this test is about.
  const partial = async (want: readonly string[]) =>
    (await stubResolve(want)).filter((r) => r.audit_id !== ids[1]);
  const out = await reauditExecute({ db, principal: 'operator', resolveIpd: partial }, {
    plan_id: plan.plan_id, idempotency_key: 'partial',
  }) as never as { cases: { case_key: string; outcome: string; detail: string | null }[] };
  assert.deepEqual(out.cases.map((c) => c.outcome), ['queued', 'failed', 'queued']);
  assert.match(String(out.cases[1].detail), /CASE_NOT_FOUND/);
  await db.close();
});

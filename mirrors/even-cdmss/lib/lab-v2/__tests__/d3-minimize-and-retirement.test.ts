/**
 * LAB-MCP-V2 §17.11 round D3 — `failure_minimize` (item 6, decisions 131 and 142), decision 145's
 * two forced retrieval options, and decision 143's retirement seen from the v2 surface.
 *
 * ⚠️ THE BISECTION IS DRIVEN OVER A REAL QUEUE. `failure_minimize` submits a dataset, an experiment
 * and a run per step and turns the tick itself, so what is exercised here is the whole loop —
 * `putObject`, `submitRun`, `claim`, the gateway's reservation and settle, and the group match on
 * the way back out. The ENGINE is a stub, injected through `tick`'s own adapter seam, because the
 * question this tool answers is about which CASES fail and not about what any engine computes.
 *
 * ⚠️ AND ONE CASE IS BAD, ON PURPOSE. `c3` is the only case whose analyze call throws, so the
 * minimal set is knowable in advance and the bisection's path is a fact rather than a shape: four
 * cases, then the two halves, then the winning half's first element.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { freshDb, migrationFile } from './helpers';
import { embedded, type Db } from '../db';
import { LabError, armBodySchema, datasetBodySchema, experimentBodySchema } from '../contracts';
import { applyMigrations, ensureBudget, getBudget, itemsOf, putObject, submitRun } from '../store';
import { tick } from '../worker';
import { callTool } from '../service';
import { failureCluster } from '../tools/cluster';
import { failureMinimize, nextMove, MAX_MINIMIZE_CASES, MINIMIZE_CAVEAT } from '../tools/minimize';
import { exitLabExecution, withLabExecution } from '../../lab-execution-context';
import { makeRouteAdapter, assessStream, eventTypes } from '../adapters/types';
import { makeOpdAdapter } from '../adapters/opd';
import { Gateway } from '../gateway';
import { fixtureTransport } from '../transport';
import { FROZEN, ARM } from './helpers';
import type { Adapter } from '../adapters/types';
import type { RetrieveOptions, RetrieveResult } from '../../retrieve';

const BAD = 'c3';
/** A PRICED model, for the one test that needs money to actually move. */
const MODEL = 'global.anthropic.claude-opus-4-6-v1';
const CASES = ['c1', 'c2', 'c3', 'c4'];

const ARM_BODY = armBodySchema.parse({
  engine: 'opd_note_audit',
  engine_version: 'test/1.0',
  stages: { analysis: { provider: 'ollama', model: 'local-model', max_cost_microusd: 50_000 } },
});

/**
 * The stub engine. One gateway call at `analysis` per item — so `lab_v2.calls` carries a stage for
 * the group key to match on — and then a throw for the bad case, whose message is identical every
 * time so every occurrence lands in ONE `failure_cluster` group.
 */
function stubAdapter(bad: Set<string>, calls: string[], model = 'local-model'): Adapter {
  return {
    engine: 'opd_note_audit',
    stages: ['analysis'],
    engineVersion: () => 'test/1.0',
    frozenInputs: ['note'],
    perAttemptTimeoutMs: 10_000,
    async run(ctx) {
      calls.push(ctx.caseKey);
      await ctx.gateway.call('analysis', { model, messages: [{ role: 'user', content: ctx.caseKey }] });
      // A plain Error, which `worker.ts` files under category 'provider' — the shape a real engine
      // failure has, and the one `failure_cluster` groups on.
      if (bad.has(ctx.caseKey)) throw new Error('the analyze leg returned nothing parseable');
      return {
        result: { ok: true }, summary: { engine: 'opd_note_audit', ok: true },
        execution_status: 'succeeded', assessment_status: 'assessed',
      };
    },
  };
}

/** A source run in the shape `failure_minimize` reads: a dataset, an experiment, and failed items. */
async function seedFailedRun(db: Db, bad: Set<string>, armBody = ARM_BODY, model = 'local-model') {
  const budget = await ensureBudget(db, 'research', 'default', 20_000_000);
  const { object: arm } = await putObject(db, 'research', 'arm', armBody, 'deidentified', 'arm-1');
  const datasetBody = datasetBodySchema.parse({
    engine: 'opd_note_audit',
    cases: CASES.map((k) => ({ case_key: k, member_key: `mk-${k}`, frozen: { note: k } })),
    snapshot_policy: 'note_at_creation',
    exclusions: [],
    classification: 'deidentified',
    source_versions: { origin: 'test' },
    replay_exactness: 'mutable_source',
  });
  const { object: dataset } = await putObject(db, 'research', 'dataset', datasetBody, 'deidentified', 'ds-1');
  const { object: experiment } = await putObject(db, 'research', 'experiment', experimentBodySchema.parse({
    hypothesis: 'the source run', dataset_id: dataset.id, dataset_hash: dataset.hash,
    baseline_arm_id: arm.id, arm_ids: [arm.id], repeats: 1, endpoints: [],
    budget_name: 'default', purpose: 'research',
  }), 'deidentified', 'ex-1');
  const { run } = await submitRun(db, 'research', 'experiment_run', experiment.id, budget.id, 'src-1', 'h', 86_400_000,
    CASES.map((k) => ({
      case_key: k, arm_hash: arm.hash, repetition: 1,
      payload: { engine: 'opd_note_audit', frozen: { note: k }, arm: armBody, budget_id: budget.id, arm_id: arm.id },
    })));
  const calls: string[] = [];
  const adapters = { opd_note_audit: stubAdapter(bad, calls, model) };
  for (let p = 0; p < 10; p += 1) {
    const r = await tick({ db, transport: fixtureTransport(), adapters, maxItems: 4 });
    if (r.claimed === 0) break;
  }
  return { run, budget, arm, dataset, experiment, adapters };
}

// ═════════════════════════════════════════════════════════════════════════════════════
// failure_minimize — §17.11 decision 150, the resumable search
//
// ⚠️ THE TEST TURNS THE WORKER, NOT THE TOOL. Decision 150 took the inline drive out: a call
// submits a step and returns, and the queue settles it whenever the tick next runs. So every test
// below is a CALL SEQUENCE — call, tick, call, tick — which is exactly the sequence a real client
// makes across separate MCP requests. The adapter seam lives on `tick`, where the engine is, and
// no longer on the tool, which is why `callTool` can drive the whole thing.
// ═════════════════════════════════════════════════════════════════════════════════════

type Running = { minimize_id: string; state: 'running'; step: number; run_id: string | null; run_state: string; case_keys: string[]; spend_microusd: number; note: string };
type Report = {
  minimize_id: string; state: 'done' | 'stopped'; source_run_id: string; candidates: number;
  started_with: string[]; minimal_case_keys: string[]; reproducing_run_ids: string[];
  steps: { step: number; case_keys: string[]; run_id: string | null; run_state: string; reproduced: boolean; matching_items: number; estimated_microusd: number; spent_microusd: number; note: string | null }[];
  spend_microusd: number; budget_cap_microusd: number; stopped: string; caveat: string;
};
type MinimizeOut = Running | Report;

const call = (db: Db, principal: string, args: Record<string, unknown>) =>
  callTool({ db, principal, protocolVersion: 'p', sdkVersion: 's' } as never, 'failure_minimize', args) as Promise<MinimizeOut>;

/** Settle whatever is queued, the way the cron would. */
async function settle(db: Db, adapters: Record<string, Adapter>) {
  for (let p = 0; p < 20; p += 1) {
    const r = await tick({ db, transport: fixtureTransport(), adapters, maxItems: 8 });
    if (r.claimed === 0) break;
  }
}

/** Drive a search to its end, recording the shape of every response. */
async function drive(db: Db, adapters: Record<string, Adapter>, args: Record<string, unknown>, log: MinimizeOut[] = []) {
  for (let i = 0; i < 20; i += 1) {
    const out = await call(db, 'research', args);
    log.push(out);
    if (out.state !== 'running') return { out: out as Report, log };
    await settle(db, adapters);
  }
  throw new Error('the search did not finish');
}

test('§17.11 decision 150: the first call submits step 1 and returns running, and drives nothing', async () => {
  const db = await freshDb();
  const { run, adapters } = await seedFailedRun(db, new Set([BAD]));
  const cluster = await failureCluster(db, { window_hours: 24 }) as {
    groups: { key: { engine: string; stage: string; category: string; message_head: string }; items: number }[];
  };
  const group = cluster.groups.find((g) => g.key.category === 'provider')!;
  assert.equal(group.key.stage, 'analysis', 'the stage of the last model call');

  const first = await call(db, 'research', {
    group_key: group.key, run_id: run.id, budget_cap_microusd: 5_000_000, idempotency_key: 'min-1',
  }) as Running;
  assert.equal(first.state, 'running');
  assert.equal(first.step, 1);
  assert.ok(first.run_id, 'a run was submitted');
  assert.equal(first.run_state, 'queued');
  assert.deepEqual(first.case_keys, [BAD]);
  assert.equal(first.spend_microusd, 0);

  // ⚠️ NOTHING RAN. The old version would have executed the whole step inside this call; the run
  // is still queued, which is the entire point of decision 150.
  const items = await itemsOf(db, first.run_id!, 100, 0);
  assert.equal(items.length, 1);
  assert.equal(items[0].state, 'queued');

  // A repeat BEFORE settlement changes nothing and re-submits nothing.
  const again = await call(db, 'research', {
    group_key: group.key, run_id: run.id, budget_cap_microusd: 5_000_000, idempotency_key: 'min-1',
  }) as Running;
  assert.equal(again.state, 'running');
  assert.equal(again.run_id, first.run_id, 'the same run, not a second one');
  assert.equal(again.step, 1);
  const runCount = await db.query<{ c: string }>(`SELECT count(*)::text AS c FROM lab_v2.runs WHERE operation = 'failure_minimize'`);
  assert.equal(runCount[0].c, '1', 'a repeat before settlement submits nothing');

  // Now settle it and advance.
  await settle(db, adapters);
  const done = await call(db, 'research', {
    group_key: group.key, run_id: run.id, budget_cap_microusd: 5_000_000, idempotency_key: 'min-1',
  }) as Report;
  assert.equal(done.state, 'done');
  assert.equal(done.stopped, 'minimal');
  assert.deepEqual(done.minimal_case_keys, [BAD]);
  assert.equal(done.candidates, 1);
  assert.deepEqual(done.started_with, [BAD]);
  assert.equal(done.steps.length, 1, 'one candidate needs one step and no halving');
  assert.equal(done.steps[0].reproduced, true);
  assert.equal(done.steps[0].matching_items, 1);
  assert.equal(done.steps[0].run_state, 'failed');
  assert.equal(done.caveat, MINIMIZE_CAVEAT);
  await db.close();
});

test('§17.11 decision 150: four candidates halve to one across a call sequence, same path as the inline search', async () => {
  const db = await freshDb();
  // Every case fails, but only ONE keeps failing when re-run — the adapter is what decides, and it
  // is swapped between the source run and the minimisation. That is the shape a real minimisation
  // has: the source run recorded four failures and only one of them is reproducible.
  const { run } = await seedFailedRun(db, new Set(CASES));
  const cluster = await failureCluster(db, { window_hours: 24 }) as {
    groups: { key: { engine: string; stage: string; category: string; message_head: string }; items: number }[];
  };
  const group = cluster.groups.find((g) => g.key.category === 'provider')!;
  assert.equal(group.items, 4);

  const replayCalls: string[] = [];
  const adapters = { opd_note_audit: stubAdapter(new Set([BAD]), replayCalls) };
  const log: MinimizeOut[] = [];
  const { out } = await drive(db, adapters, {
    group_key: group.key, run_id: run.id, budget_cap_microusd: 5_000_000, idempotency_key: 'min-2',
  }, log);

  console.log('D3 BISECTION', JSON.stringify({
    calls: log.map((o) => (o.state === 'running'
      ? { state: o.state, step: o.step, cases: o.case_keys, run_state: o.run_state }
      : { state: o.state, stopped: o.stopped, minimal: o.minimal_case_keys })),
    steps: out.steps.map((s) => ({ step: s.step, cases: s.case_keys, reproduced: s.reproduced, matching: s.matching_items })),
    minimal: out.minimal_case_keys, stopped: out.stopped, spend: out.spend_microusd,
  }));

  assert.deepEqual(out.started_with, CASES);
  assert.deepEqual(out.minimal_case_keys, [BAD]);
  assert.equal(out.state, 'done');
  assert.equal(out.stopped, 'minimal');
  // ⚠️ THE PATH, NOT JUST THE ANSWER, AND IT IS THE PATH THE INLINE SEARCH TOOK. Four, then the
  // two halves, then the winning half's first. Decision 150 changed who turns the queue, and this
  // asserts it changed nothing about what the bisection decides.
  assert.deepEqual(out.steps.map((s) => s.case_keys), [
    ['c1', 'c2', 'c3', 'c4'],
    ['c1', 'c2'],
    ['c3', 'c4'],
    ['c3'],
  ]);
  assert.deepEqual(out.steps.map((s) => s.reproduced), [true, false, true, true]);
  assert.equal(out.reproducing_run_ids.length, 3);
  // Every step ran its own cases and nothing else — 4 + 2 + 2 + 1.
  assert.equal(replayCalls.length, 9);
  // The estimate is the arm's own ceiling times the cases in the step, never a guess at a price.
  assert.deepEqual(out.steps.map((s) => s.estimated_microusd), [200_000, 100_000, 100_000, 50_000]);
  // A step that succeeded for every case is reported as the succeeded run it is.
  // ⚠️ 'partial', NOT 'failed', for the mixed steps: `deriveRunState` calls a run failed only when
  // EVERY item failed. Step 1 is three successes and one failure, step 3 is one of each, and step 4
  // is the bad case alone. The state a step reports is the run's own, not a summary of the search.
  assert.deepEqual(out.steps.map((s) => s.run_state), ['partial', 'succeeded', 'partial', 'failed']);
  // Four steps, so five calls: one per step plus the one that reads the last step and finishes.
  assert.equal(log.length, 5);
  assert.deepEqual(log.map((o) => o.state), ['running', 'running', 'running', 'running', 'done']);
  await db.close();
});

test('§17.11 decision 150: a repeat after the search is done returns the same report and runs nothing', async () => {
  const db = await freshDb();
  const { run } = await seedFailedRun(db, new Set(CASES));
  const cluster = await failureCluster(db, { window_hours: 24 }) as {
    groups: { key: { engine: string; stage: string; category: string; message_head: string } }[];
  };
  const key = cluster.groups.find((g) => g.key.category === 'provider')!.key;
  const adapters = { opd_note_audit: stubAdapter(new Set([BAD]), []) };
  const args = { group_key: key, run_id: run.id, budget_cap_microusd: 5_000_000, idempotency_key: 'min-8' };

  const { out } = await drive(db, adapters, args);
  assert.equal(out.state, 'done');

  const runsBefore = await db.query<{ c: string }>(`SELECT count(*)::text AS c FROM lab_v2.runs WHERE operation = 'failure_minimize'`);
  const repeat = await call(db, 'research', args) as Report;
  const runsAfter = await db.query<{ c: string }>(`SELECT count(*)::text AS c FROM lab_v2.runs WHERE operation = 'failure_minimize'`);

  assert.deepEqual(repeat, out, 'a finished search is a fact, and a repeat restates it');
  assert.equal(runsAfter[0].c, runsBefore[0].c, 'and submits nothing');
  // Each advance wrote its own immutable version; the newest is the one a repeat reads.
  const versions = await db.query<{ c: string }>(`SELECT count(*)::text AS c FROM lab_v2.objects WHERE kind = 'minimize'`);
  assert.equal(versions[0].c, '5', 'four steps plus the finish, each an object of its own');
  await db.close();
});

test('§17.11 decision 131: the cap refuses a step BEFORE it runs, and says what it would have cost', async () => {
  const db = await freshDb();
  const { run } = await seedFailedRun(db, new Set(CASES));
  const cluster = await failureCluster(db, { window_hours: 24 }) as {
    groups: { key: { engine: string | null; stage: string | null; category: string | null; message_head: string | null } }[];
  };
  const key = cluster.groups.find((g) => g.key.category === 'provider')!.key;

  const out = await call(db, 'research', {
    group_key: key, run_id: run.id, budget_cap_microusd: 1_000, idempotency_key: 'min-3',
  }) as Report;
  // ⚠️ THE REFUSAL IS STILL SYNCHRONOUS. Decision 150 made the search resumable, not lazy: a cap
  // that cannot afford step 1 is known before anything is submitted, so the FIRST call is already
  // terminal and the caller is never told to come back for a refusal.
  assert.equal(out.state, 'stopped');
  assert.equal(out.stopped, 'budget_cap');
  assert.equal(out.steps.length, 1);
  assert.equal(out.steps[0].run_id, null, 'no run was submitted');
  assert.equal(out.steps[0].run_state, 'refused');
  assert.equal(out.steps[0].spent_microusd, 0);
  assert.match(String(out.steps[0].note), /refused before the step/);
  assert.match(String(out.steps[0].note), /worst case 200000 would exceed the cap of 1000/);
  // Nothing was created: a refused step is a refusal, not a half-run.
  const runs = await db.query<{ c: string }>(`SELECT count(*)::text AS c FROM lab_v2.runs WHERE operation = 'failure_minimize'`);
  assert.equal(runs[0].c, '0');
  await db.close();
});

test('§17.11 decision 150: the cap also refuses a LATER step, mid-search, and the partial answer is kept', async () => {
  const db = await freshDb();
  /**
   * ⚠️ A PRICED ARM, BECAUSE A MID-SEARCH REFUSAL IS UNREACHABLE WITHOUT ONE. Every step after the
   * first is HALF the size of its parent, so with a free arm — `ollama`, which §6.3 prices at zero
   * — nothing accumulates and a cap that afforded step 1 can always afford step 2. Money has to
   * actually move for the cap to bite in the middle, so this arm bills a real Bedrock rate:
   * 1000 in + 200 out at $5/$25 per M tokens is 10_000 microusd a call, against a declared
   * ceiling of 12_000.
   */
  const PRICED = armBodySchema.parse({
    engine: 'opd_note_audit',
    engine_version: 'test/1.0',
    stages: { analysis: { provider: 'bedrock', model: MODEL, max_cost_microusd: 12_000 } },
  });
  const { run } = await seedFailedRun(db, new Set(CASES), PRICED, MODEL);
  const cluster = await failureCluster(db, { window_hours: 24 }) as {
    groups: { key: { engine: string; stage: string; category: string; message_head: string } }[];
  };
  const key = cluster.groups.find((g) => g.key.category === 'provider')!.key;
  const adapters = { opd_note_audit: stubAdapter(new Set([BAD]), [], MODEL) };
  /**
   * The arithmetic, in the order it happens. The SOURCE run already spent 4 × 10_000 = 40_000
   * against this budget before the minimisation was asked for — the cap is a line under everything
   * committed, not a fresh allowance, which is the whole reason it is checked against the budget
   * and not against this search's own total. So: step 1's worst case is 4 × 12_000 = 48_000, and
   * 40_000 + 48_000 = 88_000 fits under 90_000. Step 1 then really spends 40_000, taking the
   * committed total to 80_000; step 2's worst case of 2 × 12_000 = 24_000 would make 104_000, and
   * that is over the line. The refusal arrives on the call that WOULD have submitted step 2 —
   * before it exists, never after the money is gone.
   */
  const { out, log } = await drive(db, adapters, {
    group_key: key, run_id: run.id, budget_cap_microusd: 90_000, idempotency_key: 'min-9',
  });
  assert.equal(out.state, 'stopped');
  assert.equal(out.stopped, 'budget_cap');
  assert.equal(out.steps.length, 2, 'step 1 ran, step 2 was refused');
  assert.equal(out.steps[0].reproduced, true);
  assert.equal(out.steps[0].spent_microusd, 40_000, 'the money the step actually moved');
  assert.equal(out.steps[1].run_id, null);
  assert.equal(out.steps[1].run_state, 'refused');
  assert.match(String(out.steps[1].note), /would exceed the cap of 90000/);
  assert.match(String(out.steps[1].note), /80000 microusd already committed/);
  assert.equal(out.spend_microusd, 40_000);
  // ⚠️ THE PARTIAL ANSWER IS KEPT, AND IT IS HONEST: the last set that DID reproduce. Not an empty
  // list, which would read as "nothing reproduced", and not a claim of minimality the search never
  // earned — `stopped: 'budget_cap'` is what says the search was cut short.
  assert.deepEqual(out.minimal_case_keys, CASES);
  assert.deepEqual(log.map((o) => o.state), ['running', 'stopped']);
  // Only step 1's run was ever created.
  const runs = await db.query<{ c: string }>(`SELECT count(*)::text AS c FROM lab_v2.runs WHERE operation = 'failure_minimize'`);
  assert.equal(runs[0].c, '1');
  await db.close();
});

test('§17.11 decision 150: a step that reproduces nothing ends the search on the first answer', async () => {
  const db = await freshDb();
  const { run } = await seedFailedRun(db, new Set(CASES));
  const cluster = await failureCluster(db, { window_hours: 24 }) as {
    groups: { key: { engine: string; stage: string; category: string; message_head: string } }[];
  };
  const key = cluster.groups.find((g) => g.key.category === 'provider')!.key;
  // Nothing fails on the re-run, so step 1 answers the question by itself.
  const { out, log } = await drive(db, { opd_note_audit: stubAdapter(new Set(), []) }, {
    group_key: key, run_id: run.id, budget_cap_microusd: 5_000_000, idempotency_key: 'min-10',
  });
  assert.equal(out.state, 'done');
  assert.equal(out.stopped, 'not_reproduced');
  assert.deepEqual(out.minimal_case_keys, [], 'no set reproduced it, and none is claimed');
  assert.equal(out.steps.length, 1);
  assert.equal(out.steps[0].run_state, 'succeeded');
  assert.equal(out.steps[0].matching_items, 0);
  assert.deepEqual(log.map((o) => o.state), ['running', 'done']);
  await db.close();
});

test('§17.11 decision 150: the bisection is a pure function of the steps already settled', () => {
  // ⚠️ THE REDUCER, ALONE. The position of the search is not stored — it is replayed from the
  // record — so this asserts the replay directly, over the same path the queue test drives.
  const started = ['c1', 'c2', 'c3', 'c4'];
  const step = (case_keys: string[], reproduced: boolean) => ({ case_keys, reproduced });
  assert.deepEqual(nextMove(started, []), { kind: 'run', case_keys: started });
  assert.deepEqual(nextMove(started, [step(started, true)]), { kind: 'run', case_keys: ['c1', 'c2'] });
  assert.deepEqual(nextMove(started, [step(started, true), step(['c1', 'c2'], false)]),
    { kind: 'run', case_keys: ['c3', 'c4'] });
  assert.deepEqual(nextMove(started, [step(started, true), step(['c1', 'c2'], false), step(['c3', 'c4'], true)]),
    { kind: 'run', case_keys: ['c3'] });
  assert.deepEqual(nextMove(started, [step(started, true), step(['c1', 'c2'], false), step(['c3', 'c4'], true), step(['c3'], true)]),
    { kind: 'end', minimal: ['c3'], reason: 'minimal' });
  // Step 1 not reproducing is the end, and the answer is an empty set rather than a guess.
  assert.deepEqual(nextMove(started, [step(started, false)]), { kind: 'end', minimal: [], reason: 'not_reproduced' });
  // Neither half alone reproduces: the pair is minimal for THIS search. See the caveat.
  assert.deepEqual(nextMove(['a', 'b'], [step(['a', 'b'], true), step(['a'], false), step(['b'], false)]),
    { kind: 'end', minimal: ['a', 'b'], reason: 'minimal' });
  // One candidate needs one step and no halving.
  assert.deepEqual(nextMove(['x'], [step(['x'], true)]), { kind: 'end', minimal: ['x'], reason: 'minimal' });
});

test('§17.11 decision 131: at most eight cases reach a first step', async () => {
  assert.equal(MAX_MINIMIZE_CASES, 8);
});

test('§17.11 item 6: a group with no items in that run, and a run with no experiment, are named refusals', async () => {
  const db = await freshDb();
  const { run } = await seedFailedRun(db, new Set([BAD]));
  await assert.rejects(
    () => failureMinimize({ db, principal: 'research' }, {
      group_key: { engine: 'opd_note_audit', stage: 'nonesuch', category: 'provider', message_head: 'x' },
      run_id: run.id, budget_cap_microusd: 1_000_000, idempotency_key: 'min-4',
    }),
    (e: LabError) => e.code === 'NOT_FOUND' && /same failure_cluster report/.test(e.message));

  // A run whose owner is someone else.
  await assert.rejects(
    () => failureMinimize({ db, principal: 'operator' }, {
      group_key: { engine: 'opd_note_audit', stage: 'analysis', category: 'provider', message_head: 'x' },
      run_id: run.id, budget_cap_microusd: 1_000_000, idempotency_key: 'min-5',
    }),
    (e: LabError) => e.code === 'OWNER_ONLY');
  await db.close();
});

test('§17.11 decision 109: failure_minimize is reachable through callTool', async () => {
  const db = await freshDb();
  const { run } = await seedFailedRun(db, new Set([BAD]));
  const cluster = await callTool({ db, principal: 'research', protocolVersion: 'p', sdkVersion: 's' } as never,
    'failure_cluster', { window_hours: 24, limit: 50 }) as {
      groups: { key: { engine: string; stage: string; category: string; message_head: string } }[];
    };
  const key = cluster.groups.find((g) => g.key.category === 'provider')!.key;
  // Through dispatch: the schema, the scope, the handler and the output validation — and decision
  // 150's output is a UNION, so this also proves the running branch validates on the way out.
  const out = await call(db, 'research',
    { group_key: key, run_id: run.id, budget_cap_microusd: 1_000, idempotency_key: 'min-6' }) as Report;
  // A cap of 1_000 refuses the first step, which is the cheapest reachable proof that dispatch,
  // schema validation and the handler all agree — and it spends nothing to get it.
  assert.equal(out.stopped, 'budget_cap');
  assert.ok(out.caveat.length > 50);
  // The reviewer key may not call it at all.
  await assert.rejects(
    () => callTool({ db, principal: 'reviewer', protocolVersion: 'p', sdkVersion: 's' } as never,
      'failure_minimize', { group_key: key, run_id: run.id, budget_cap_microusd: 1_000, idempotency_key: 'min-7' }),
    (e: LabError) => e.code === 'SCOPE_DENIED');
  await db.close();
});

// ═════════════════════════════════════════════════════════════════════════════════════
// Decision 145 — the two forced retrieval options
// ═════════════════════════════════════════════════════════════════════════════════════

type Seen = { query: string; opts: RetrieveOptions };
const EMPTY: RetrieveResult = { hits: [], expandedQuery: 'q', meta: { vector_pool: 0, bm25_pool: 0, fused: 0, reranked: false } } as never;

test('§17.11 decision 145: the shared route edge forces skipExpand and useReranker off', async () => {
  const db = await freshDb();
  const seen: Seen[] = [];
  const budget = await ensureBudget(db, 'research', 'default', 10_000_000);
  const { run } = await submitRun(db, 'research', 'experiment_run', null, budget.id, 'r145-1', 'h', 86_400_000, [
    { case_key: 'x', arm_hash: 'h', repetition: 1, payload: { engine: 'stub', frozen: { engine: 'ask', body: { question: 'q' } }, arm: { stages: {} }, budget_id: budget.id } },
  ]);
  /**
   * The route's own body, calling the retrieve edge the way an engine does: through the lab
   * execution context, with ITS OWN options — `useReranker: true` and expansion left on, which is
   * exactly what decision 133 measured escaping the fence.
   */
  const post = async () => {
    const ctx = (await import('../../lab-execution-context')).labExecution();
    await ctx!.retrieve!('a query', { topK: 8, useReranker: true, bm25: true } as never);
    return new Response(JSON.stringify({ ok: true }), { headers: { 'content-type': 'application/json' } });
  };
  const adapter = makeRouteAdapter({
    engine: 'ask', path: '/api/ask', file: 'app/api/ask/route.ts', post: post as never,
    summarise: (read) => ({ event_types: eventTypes(read) }), assess: assessStream,
  }, {
    retrieve: async (query: string, opts: RetrieveOptions) => { seen.push({ query, opts }); return EMPTY; },
  });
  await tick({ db, transport: fixtureTransport(), adapters: { stub: adapter } });

  assert.equal(seen.length, 1);
  assert.equal(seen[0].opts.skipExpand, true, 'expandQuery cannot fire');
  assert.equal(seen[0].opts.useReranker, false, 'the rerank judge cannot fire');
  // The caller's other options survive: only the two named by decision 145 are overridden.
  assert.equal((seen[0].opts as { topK?: number }).topK, 8);
  assert.equal((seen[0].opts as { bm25?: boolean }).bm25, true);

  const [item] = await itemsOf(db, run.id);
  const events = await db.query<{ kind: string; body: Record<string, unknown> }>(
    `SELECT kind, body FROM lab_v2.events WHERE aggregate = $1`, [item.id]);
  const read = events.find((e) => e.kind === 'retrieval_read');
  assert.ok(read, 'the read is logged');
  assert.equal(read!.body.forced_no_model, true, 'and the event says the options were forced');
  await db.close();
});

test('§17.11 decision 145: the OPD edge forces them too, and the frozen branch is untouched', async () => {
  const db = await freshDb();
  const budget = await ensureBudget(db, 'research', 'default', 10_000_000);
  const { run } = await submitRun(db, 'research', 'experiment_run', null, budget.id, 'r145-2', 'h', 86_400_000, [
    { case_key: 'test-note-0001', arm_hash: 'h', repetition: 1, payload: {} },
  ]);
  const [item] = await itemsOf(db, run.id);
  const gateway = new Gateway({
    db, itemId: item.id, leaseToken: 0, budgetId: budget.id,
    transport: fixtureTransport({ reply: JSON.stringify({ findings: [], pdqi9: {} }) }),
    stages: { analysis: { provider: 'ollama', model: 'local-model', max_cost_microusd: 100_000 } },
  });

  const seen: Seen[] = [];
  const events: { kind: string; body: Record<string, unknown> }[] = [];
  await makeOpdAdapter({
    retrieve: (async (query: string, opts: RetrieveOptions) => { seen.push({ query, opts }); return EMPTY; }) as never,
  }).run({
    runId: run.id, itemId: item.id, caseKey: 'test-note-0001',
    // ⚠️ NO `sources` ON THE FROZEN CASE, so the edge takes its LIVE branch — the frozen branch
    // returns the dataset's own chunks and never reaches the corpus, so there is nothing to force.
    frozen: FROZEN, arm: ARM, repetition: 1, gateway,
    event: (kind, body) => { events.push({ kind, body }); },
    checkpoint: async (_n, _h, produce) => produce(),
  });
  assert.ok(seen.length >= 1, 'the OPD engine retrieved');
  for (const s of seen) {
    assert.equal(s.opts.skipExpand, true);
    assert.equal(s.opts.useReranker, false);
  }
  const reads = events.filter((e) => e.kind === 'retrieval_read');
  assert.ok(reads.length >= 1);
  for (const r of reads) {
    assert.equal(r.body.frozen, false);
    assert.equal(r.body.forced_no_model, true);
  }
  await db.close();
});

test('§17.11 decision 145: the source text of both edges carries the two options', async () => {
  const { readFileSync } = await import('node:fs');
  const { join } = await import('node:path');
  const ROOT = process.cwd();
  for (const file of ['lib/lab-v2/adapters/types.ts', 'lib/lab-v2/adapters/opd.ts', 'lib/lab-v2/adapters/ipd-discharge.ts']) {
    const src = readFileSync(join(ROOT, file), 'utf8');
    assert.match(src, /skipExpand: true, useReranker: false/, `${file} does not force the two options`);
    assert.match(src, /forced_no_model: true/, `${file} does not record that it forced them`);
  }
  // ⚠️ AND THE THIRD PATH IS STILL OPEN AND STILL NAMED. Decision 133 accepts the embedding read;
  // this asserts nobody quietly claimed otherwise.
  const types = readFileSync(join(ROOT, 'lib/lab-v2/adapters/types.ts'), 'utf8');
  assert.match(types, /embedding/i, 'the accepted egress path is named where the options are forced');
});

// ═════════════════════════════════════════════════════════════════════════════════════
// Decision 143 — the retirement, from the v2 side
// ═════════════════════════════════════════════════════════════════════════════════════

test('§17.11 decision 143: system_capabilities carries the deprecation for every principal', async () => {
  const db = await freshDb();
  for (const principal of ['research', 'operator', 'reviewer', 'release'] as const) {
    const out = await callTool({ db, principal, protocolVersion: 'p', sdkVersion: 's' } as never,
      'system_capabilities', {}) as { deprecations: { tool: string; surface: string; replaced_by: string[]; since: string }[] };
    assert.deepEqual(out.deprecations, [{
      tool: 'lab_query', surface: 'v1', replaced_by: ['audit_search', 'corpus_search'], since: 'e5f53c55',
    }], `${principal} cannot see what was retired`);
  }
  // Both replacements exist on this surface and are visible to the research key.
  const research = await callTool({ db, principal: 'research', protocolVersion: 'p', sdkVersion: 's' } as never,
    'system_capabilities', {}) as { tools: { name: string }[] };
  const names = research.tools.map((t) => t.name);
  for (const t of ['audit_search', 'corpus_search']) assert.ok(names.includes(t), `${t} is the replacement and must exist`);
  await db.close();
});

test('§17.11: the three D3 tools are on the surface with their declared metadata', async () => {
  const db = await freshDb();
  const out = await callTool({ db, principal: 'operator', protocolVersion: 'p', sdkVersion: 's' } as never,
    'system_capabilities', {}) as { tools: { name: string; effect: string; cost_class: string; identifying_input: boolean; slice: string }[] };
  const byName = Object.fromEntries(out.tools.map((t) => [t.name, t]));
  assert.equal(byName.case_ask.effect, 'read');
  assert.equal(byName.case_ask.cost_class, 'free');
  assert.equal(byName.case_ask.identifying_input, true);
  assert.equal(byName.case_ask.slice, 'D-3');
  assert.equal(byName.case_timeline.identifying_input, true);
  assert.equal(byName.failure_minimize.effect, 'research_write');
  assert.equal(byName.failure_minimize.cost_class, 'metered');
  assert.equal(byName.failure_minimize.identifying_input, false, 'a group key and a run id name no person');
  await db.close();
});

test('§17.11: an unfenced import has not crept in — the case readers stay under lib/lab-v2', async () => {
  const { readFileSync } = await import('node:fs');
  const { join } = await import('node:path');
  const src = readFileSync(join(process.cwd(), 'lib/lab-v2/sources/case-readers.ts'), 'utf8');
  // Both reads go through the two doors this platform already has, and no third one is opened.
  assert.match(src, /import \{ boundedRead \} from '\.\/read'/);
  assert.match(src, /import \{ metabaseQuery \} from '\.\.\/\.\.\/metabase'/);
  assert.ok(!/from '\.\.\/\.\.\/db'/.test(src), 'the case readers never reach lib/db directly');
  // And nothing here writes.
  for (const word of ['INSERT', 'UPDATE', 'DELETE', 'CREATE', 'ALTER']) {
    assert.ok(!new RegExp(`\\b${word}\\b`).test(src.replace(/\/\*[\s\S]*?\*\//g, '')), `case-readers.ts contains ${word}`);
  }
});

// ═════════════════════════════════════════════════════════════════════════════════════
// Decision 149 — the retirement OVER THE WIRE
//
// ⚠️ WHY THIS SECTION EXISTS. Decision 143's dispatch arm was asserted through `callLabTool`,
// which is one layer BELOW the surface a client touches. `dispatchMcp`'s name gate sits above it
// and tested `LAB_TOOLS.some(...)` — a list `lab_query` had just been removed from — so every real
// call was refused `-32602 unknown tool: lab_query` before the arm could answer. The retirement
// was correct in the file and absent on the wire, and nothing caught it because `dispatchMcp` had
// no test of any kind. These tests drive the real handler with the real JSON-RPC request shape.
// ═════════════════════════════════════════════════════════════════════════════════════

/** The shape both routes send, after they have checked the key. */
const rpc = (id: number, method: string, params?: unknown) =>
  ({ jsonrpc: '2.0' as const, id, method, ...(params === undefined ? {} : { params }) });

test('§17.11 decision 149: the key gate both routes use accepts the key and nothing else', async () => {
  const { labKeyConfigured, labKeyMatches } = await import('../../mcp-server');
  const saved = process.env.LAB_API_KEY;
  process.env.LAB_API_KEY = 'test-lab-key-149';
  try {
    assert.equal(labKeyConfigured(), true);
    assert.equal(labKeyMatches('test-lab-key-149'), true, 'the presented key is the configured one');
    assert.equal(labKeyMatches('test-lab-key-14'), false, 'a shorter key is refused');
    assert.equal(labKeyMatches('test-lab-key-150'), false, 'a same-length wrong key is refused');
    assert.equal(labKeyMatches(null), false);
    assert.equal(labKeyMatches(''), false);
  } finally {
    if (saved === undefined) delete process.env.LAB_API_KEY; else process.env.LAB_API_KEY = saved;
  }
});

test('§17.11 decision 149: tools/call lab_query returns the RETIRED object as a result, not an error', async () => {
  const { dispatchMcp } = await import('../../mcp-server');
  const { V1_DEPRECATIONS } = await import('../contracts');
  const saved = process.env.LAB_API_KEY;
  process.env.LAB_API_KEY = 'test-lab-key-149';
  try {
    const reply = await dispatchMcp(rpc(1, 'tools/call', { name: 'lab_query', arguments: {} }));
    assert.equal(reply.status, 200);
    const body = reply.body as { jsonrpc: string; id: number; result?: { content: { text: string }[]; isError?: boolean }; error?: unknown };
    // ⚠️ A RESULT, NOT AN ERROR. This is the whole ruling: the JSON-RPC envelope carries `result`,
    // and the tool result is not flagged `isError`. Before decision 149 this was
    // `error: { code: -32602, message: 'unknown tool: lab_query' }`.
    assert.equal(body.error, undefined, `the gate refused a retired name: ${JSON.stringify(body.error)}`);
    assert.ok(body.result, 'a retirement is an answer');
    assert.notEqual(body.result.isError, true, 'and it is not an error result either');
    assert.equal(body.id, 1, 'the id is echoed');

    const payload = JSON.parse(body.result.content[0].text);
    assert.deepEqual(payload, {
      error: 'RETIRED',
      replaced_by: ['audit_search', 'corpus_search'],
      since: 'e5f53c55',
    });
    // The wire object and the v2 surface's deprecation are still the same fact. Decision 149 left
    // two literals standing on purpose; this is the pin that keeps them from drifting.
    const [dep] = V1_DEPRECATIONS;
    assert.equal(dep.tool, 'lab_query');
    assert.deepEqual([...dep.replaced_by], payload.replaced_by);
    assert.equal(dep.since, payload.since);
  } finally {
    if (saved === undefined) delete process.env.LAB_API_KEY; else process.env.LAB_API_KEY = saved;
  }
});

test('§17.11 decision 149: the gate still refuses a name that was never served', async () => {
  const { dispatchMcp } = await import('../../mcp-server');
  const reply = await dispatchMcp(rpc(2, 'tools/call', { name: 'lab_nonesuch', arguments: {} }));
  const body = reply.body as { error?: { code: number; message: string }; result?: unknown };
  assert.equal(body.result, undefined, 'an unknown name is not answered');
  assert.deepEqual(body.error, { code: -32602, message: 'unknown tool: lab_nonesuch' });
  // ⚠️ RETIREMENT IS NOT THE SAME FACT AS NEVER EXISTING, and decision 149 must not have blurred
  // the two: only the names on the retired list pass, not any name at all.
  const { RETIRED_TOOLS } = await import('../../mcp-tools');
  assert.deepEqual(RETIRED_TOOLS.map((t) => String(t.name)), ['lab_query']);
});

test('§17.11 decision 149: tools/list is unchanged — a retired name stays undiscoverable', async () => {
  const { dispatchMcp } = await import('../../mcp-server');
  const { LAB_TOOLS } = await import('../../mcp-tools');
  const reply = await dispatchMcp(rpc(3, 'tools/list'));
  const { tools } = (reply.body as { result: { tools: { name: string }[] } }).result;
  const names = tools.map((t) => String(t.name));
  assert.ok(!names.includes('lab_query'), 'a retired tool is not offered for discovery');
  assert.equal(names.length, LAB_TOOLS.length, 'the list is LAB_TOOLS and nothing else');
  assert.ok(names.includes('audit_query'), 'audit_query still reads every row lab_query listed');
});

test('§17.11 decision 149: the handshake no longer advertises the retired tool', async () => {
  const { dispatchMcp } = await import('../../mcp-server');
  const reply = await dispatchMcp(rpc(4, 'initialize'));
  const { instructions } = (reply.body as { result: { instructions: string } }).result;
  // A client reads this string on connect. Naming a tool here that tools/call answers RETIRED and
  // tools/list does not offer contradicted the retirement at the first message of the session.
  assert.ok(!instructions.includes('lab_query'), 'the instructions still name lab_query');
  assert.ok(instructions.includes('mini_analyze'), 'and the tools that DO exist are still named');
  assert.ok(instructions.includes('corpus_manage'), 'including the neighbour lab_query sat beside');
});

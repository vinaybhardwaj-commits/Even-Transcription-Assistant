/**
 * LAB-MCP-V2 §17.6 — decisions 58 and 65, and `report_export` full.
 *
 * ⚠️ DECISION 58 IS ABOUT A SILENT LOSS, so the test that matters is the one that used to pass.
 * `run_diff` paired on `case_key`, and a run with two arms has two items per case: the old map kept
 * the last one and reported a single row per case, naming neither arm. Nothing was wrong on the
 * screen; the wrong pair had simply been chosen. That is the shape asserted below.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { freshDb } from './helpers';
import { callTool } from '../service';
import { ATTRIBUTION_STATUSES } from '../contracts';
import { ensureBudget, itemsOf, getObject, putObject, submitRun } from '../store';
import { tick } from '../worker';
import { makeIpdEpisodeAdapter } from '../adapters/ipd-episode';
import { freezeIpdCase } from '../sources/ipd';
import { recordIpdSteps } from '../adapters/ipd-episode';
import { FIXTURE_AUDIT_ID, runFixtureEpisode, storedCheckpointsFrom, storedExtractionRow, storedRowFrom } from './fixtures/ipd-stored';
import type { Db } from '../db';

const deps = (db: Db, principal: 'research' | 'operator' = 'research') =>
  ({ db, principal, protocolVersion: 'test', sdkVersion: 'test' }) as never;

interface Seed { case_key: string; arm_hash: string; repetition: number; nqi: number; band: string; subjects: string[]; hash: string }

async function seedRun(db: Db, key: string, budgetId: string, rows: Seed[], operation = 'experiment_run') {
  const { run } = await submitRun(db, 'research', operation, null, budgetId, key, 'h', 86_400_000,
    rows.map((r) => ({ case_key: r.case_key, arm_hash: r.arm_hash, repetition: r.repetition, payload: {} })));
  const items = await itemsOf(db, run.id);
  for (const item of items) {
    const r = rows.find((x) => x.case_key === item.case_key && x.arm_hash === item.arm_hash && x.repetition === item.repetition)!;
    await db.query(
      `UPDATE lab_v2.items SET state = 'succeeded', execution_status = 'succeeded', assessment_status = 'assessed',
         attribution_status = 'verified', result = $2::jsonb WHERE id = $1`,
      [item.id, JSON.stringify({
        result_hash: r.hash,
        summary: { findings: r.subjects.length, n_low_value: 0, note_quality_index: r.nqi, band: r.band, finding_subjects: r.subjects },
      })]);
  }
  return run;
}

// ── decision 58 ─────────────────────────────────────────────────────────────────────────────

test('§17.6 decision 58: two arms on one case pair separately, and each row names its arm', async () => {
  const db = await freshDb();
  const budget = await ensureBudget(db, 'research', 'default', 1_000_000);
  // ⚠️ THE DEFECT, EXACTLY. One case, two arms, on BOTH sides. Under `case_key` alone each side
  // collapsed to one item and the diff compared an arbitrary arm with an arbitrary arm.
  const a = await seedRun(db, 'd58-a', budget.id, [
    { case_key: 'u1', arm_hash: 'armX', repetition: 1, nqi: 70, band: 'C', subjects: ['s1'], hash: 'hx1' },
    { case_key: 'u1', arm_hash: 'armY', repetition: 1, nqi: 90, band: 'A', subjects: ['s2'], hash: 'hy1' },
  ]);
  const b = await seedRun(db, 'd58-b', budget.id, [
    { case_key: 'u1', arm_hash: 'armX', repetition: 1, nqi: 72, band: 'B', subjects: ['s1'], hash: 'hx1' },
    { case_key: 'u1', arm_hash: 'armY', repetition: 1, nqi: 60, band: 'D', subjects: ['s3'], hash: 'hy2' },
  ]);
  const out = await callTool(deps(db), 'run_diff', { run_a: a.id, run_b: b.id }) as {
    paired: number; paired_on: string; arms_a: string[];
    cases: { case_key: string; arm_hash: string; repetition: number; note_quality_index_before: number; note_quality_index_after: number; result_hash_equal: boolean }[];
  };
  assert.equal(out.paired, 2, 'TWO rows: one per arm, not one per case');
  assert.equal(out.paired_on, 'case_key+arm_hash+repetition', 'the arms match, so the arm is in the key');
  assert.deepEqual(out.arms_a, ['armX', 'armY']);
  const byArm = new Map(out.cases.map((c) => [c.arm_hash, c]));
  // armX moved a little and kept its hash; armY moved a lot and did not. Under the old key one of
  // these two stories was reported and the other vanished.
  assert.equal(byArm.get('armX')!.note_quality_index_before, 70);
  assert.equal(byArm.get('armX')!.note_quality_index_after, 72);
  assert.equal(byArm.get('armX')!.result_hash_equal, true);
  assert.equal(byArm.get('armY')!.note_quality_index_before, 90);
  assert.equal(byArm.get('armY')!.note_quality_index_after, 60);
  assert.equal(byArm.get('armY')!.result_hash_equal, false);
  for (const c of out.cases) assert.equal(c.repetition, 1);
  await db.close();
});

test('§17.6 decision 58: repetitions of one case pair separately too', async () => {
  const db = await freshDb();
  const budget = await ensureBudget(db, 'research', 'default', 1_000_000);
  const a = await seedRun(db, 'd58-r-a', budget.id, [
    { case_key: 'u1', arm_hash: 'armX', repetition: 1, nqi: 70, band: 'C', subjects: [], hash: 'h1' },
    { case_key: 'u1', arm_hash: 'armX', repetition: 2, nqi: 71, band: 'C', subjects: [], hash: 'h2' },
  ]);
  const b = await seedRun(db, 'd58-r-b', budget.id, [
    { case_key: 'u1', arm_hash: 'armX', repetition: 1, nqi: 75, band: 'B', subjects: [], hash: 'h1' },
    { case_key: 'u1', arm_hash: 'armX', repetition: 2, nqi: 60, band: 'D', subjects: [], hash: 'h9' },
  ]);
  const out = await callTool(deps(db), 'run_diff', { run_a: a.id, run_b: b.id }) as {
    paired: number; cases: { repetition: number; result_hash_equal: boolean }[];
  };
  assert.equal(out.paired, 2);
  assert.deepEqual(out.cases.map((c) => c.repetition).sort(), [1, 2]);
  // ⚠️ Repetition 1 reproduced and repetition 2 did not. That IS the measurement a repeated run
  // exists to make, and pairing on the case alone threw one of the two away.
  const byRep = new Map(out.cases.map((c) => [c.repetition, c]));
  assert.equal(byRep.get(1)!.result_hash_equal, true);
  assert.equal(byRep.get(2)!.result_hash_equal, false);
  await db.close();
});

test('§17.6 decision 58: two runs on DIFFERENT arms still pair, and the output says on what', async () => {
  const db = await freshDb();
  const budget = await ensureBudget(db, 'research', 'default', 1_000_000);
  const a = await seedRun(db, 'd58-x', budget.id, [{ case_key: 'u1', arm_hash: 'armX', repetition: 1, nqi: 70, band: 'C', subjects: [], hash: 'h1' }]);
  const b = await seedRun(db, 'd58-y', budget.id, [{ case_key: 'u1', arm_hash: 'armY', repetition: 1, nqi: 80, band: 'B', subjects: [], hash: 'h2' }]);
  const out = await callTool(deps(db), 'run_diff', { run_a: a.id, run_b: b.id }) as {
    paired: number; paired_on: string; arms_a: string[]; arms_b: string[];
  };
  // ⚠️ THE COMMONEST USE OF THIS TOOL. Arm X against arm Y is exactly what a diff is for, and
  // pairing on the arm would have answered "0 paired". The arm stands aside and the tool SAYS SO.
  assert.equal(out.paired, 1);
  assert.equal(out.paired_on, 'case_key+repetition');
  assert.deepEqual(out.arms_a, ['armX']);
  assert.deepEqual(out.arms_b, ['armY']);
  await db.close();
});

test('§17.6 decision 58: a key that would collide is refused, never quietly resolved', async () => {
  const db = await freshDb();
  const budget = await ensureBudget(db, 'research', 'default', 1_000_000);
  // Two arms on the left, one unrelated arm on the right: nothing shared, so the arm leaves the
  // key — and then the left side has two items for (u1, rep 1). Refusing beats picking one.
  const a = await seedRun(db, 'd58-c-a', budget.id, [
    { case_key: 'u1', arm_hash: 'armX', repetition: 1, nqi: 70, band: 'C', subjects: [], hash: 'h1' },
    { case_key: 'u1', arm_hash: 'armY', repetition: 1, nqi: 90, band: 'A', subjects: [], hash: 'h2' },
  ]);
  const b = await seedRun(db, 'd58-c-b', budget.id, [{ case_key: 'u1', arm_hash: 'armZ', repetition: 1, nqi: 80, band: 'B', subjects: [], hash: 'h3' }]);
  await assert.rejects(
    () => callTool(deps(db), 'run_diff', { run_a: a.id, run_b: b.id }),
    (e: { code?: string; message?: string }) => e.code === 'INVALID_INPUT' && /under different arms/.test(String(e.message)),
  );
  await db.close();
});

// ── decision 65 ─────────────────────────────────────────────────────────────────────────────

test('§17.6 decision 65: `replayed` is the fourth attribution value', () => {
  // Rule 1a / decision 115: a FIFTH value, `not_applicable`, for an item that made no call at all.
  // The pin moves rather than loosens — the point of it is that this list is short and deliberate.
  assert.deepEqual([...ATTRIBUTION_STATUSES],
    ['verified', 'invalid', 'unknown', 'replayed', 'not_applicable']);
});

async function frozenCase() {
  const { row, checkpoints } = await runFixtureEpisode();
  const previous = process.env.LAB_V2_MEMBER_SALT;
  process.env.LAB_V2_MEMBER_SALT = 'b3-salt';
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

test('§17.6 decision 65: a frozen IPD item is `replayed`, and carries the models that answered', async () => {
  const db = await freshDb();
  const c = await frozenCase();
  const budget = await ensureBudget(db, 'research', 'default', 10_000_000);
  const { run } = await submitRun(db, 'research', 'experiment_run', null, budget.id, 'd65', 'h', 86_400_000, [{
    case_key: c.case_key, arm_hash: 'h', repetition: 1,
    payload: { engine: 'ipd_episode', frozen: c.frozen, arm: { stages: {} }, budget_id: budget.id },
  }]);
  await tick({ db, transport: (async () => { throw new Error('no provider'); }) as never, adapters: { ipd_episode: makeIpdEpisodeAdapter() } });
  const [item] = await itemsOf(db, run.id);
  assert.equal(item.state, 'succeeded');
  // ⚠️ NOT `unknown`. Nothing is unknown about this item: the models on the record are the models
  // that answered, and they answered earlier.
  assert.equal(item.attribution_status, 'replayed');
  const summary = (item.result as { summary: { served?: { model_checkpoint: string; model_judge: string } } }).summary;
  assert.equal(summary.served!.model_checkpoint, c.frozen.models.checkpoint);
  assert.equal(summary.served!.model_judge, c.frozen.models.judge);
  await db.close();
});

test('§17.6 decision 65: an adapter cannot claim `replayed` over a gateway verdict', async () => {
  const db = await freshDb();
  const budget = await ensureBudget(db, 'research', 'default', 10_000_000);
  const { run } = await submitRun(db, 'research', 'experiment_run', null, budget.id, 'd65-lie', 'h', 86_400_000, [{
    case_key: 'u1', arm_hash: 'h', repetition: 1,
    payload: {
      engine: 'liar', budget_id: budget.id,
      arm: { stages: { analysis: { provider: 'ollama', model: 'local-model', max_cost_microusd: 1000 } } },
    },
  }]);
  // An adapter that makes a real call AND declares `replayed`. The call is served by a DIFFERENT
  // model than the arm named, so the gateway says `invalid` — and that verdict must win.
  const liar = {
    engine: 'opd_note_audit' as const, stages: ['analysis'], engineVersion: () => 'x', frozenInputs: [],
    perAttemptTimeoutMs: 1000,
    async run(ctx: { gateway: { call: (s: string, p: Record<string, unknown>) => Promise<unknown> } }) {
      await ctx.gateway.call('analysis', { messages: [] });
      return {
        result: {}, summary: { attribution_status: 'replayed' },
        execution_status: 'succeeded' as const, assessment_status: 'assessed' as const,
      };
    },
  };
  await tick({
    db,
    transport: (async () => ({
      completion: {}, text: '{}', usage: { input_tokens: 1, output_tokens: 1 },
      served: { provider: 'ollama', model: 'a-different-model' },
    })) as never,
    adapters: { liar: liar as never },
  });
  const [item] = await itemsOf(db, run.id);
  assert.equal(item.attribution_status, 'invalid',
    'the gateway saw a call, so its verdict stands — a fourth status must not launder a real failure');
  await db.close();
});

// ── item 6: report_export, full ─────────────────────────────────────────────────────────────

test('§17.6 item 6: report_export attaches only the sections asked for, and names them', async () => {
  const db = await freshDb();
  const budget = await ensureBudget(db, 'research', 'default', 1_000_000);
  const run = await seedRun(db, 'rx-1', budget.id, [
    { case_key: 'u1', arm_hash: 'armX', repetition: 1, nqi: 70, band: 'C', subjects: ['s1'], hash: 'h1' },
  ]);
  const plain = await callTool(deps(db), 'report_export', { run_id: run.id }) as { artifact_id: string; sections: string[] };
  assert.deepEqual(plain.sections, ['run', 'experiment', 'dataset', 'arms', 'items', 'calls'],
    'an ordinary export is exactly what A2 exported');
  const body = (await getObject(db, plain.artifact_id))!.body as Record<string, unknown>;
  assert.equal(body.replay, undefined, 'nothing was asked for, so nothing was attached');
  assert.equal(body.coverage, undefined);

  const withReplay = await callTool(deps(db), 'report_export', { run_id: run.id, include: ['replay'] }) as { artifact_id: string; sections: string[] };
  assert.ok(withReplay.sections.includes('replay'));
  const b2 = (await getObject(db, withReplay.artifact_id))!.body as { replay: { case_key: string; arm_hash: string; repetition: number; attribution_status: string }[] };
  assert.equal(b2.replay.length, 1);
  // Decision 58's triple travels into the report too: an entry that named only its case would be
  // unidentifiable on a two-arm run.
  assert.equal(b2.replay[0].case_key, 'u1');
  assert.equal(b2.replay[0].arm_hash, 'armX');
  assert.equal(b2.replay[0].repetition, 1);
  await db.close();
});

test('§17.6 item 6: the repair section appears only on a reaudit run', async () => {
  const db = await freshDb();
  const budget = await ensureBudget(db, 'research', 'default', 1_000_000);
  const ordinary = await seedRun(db, 'rx-2', budget.id, [
    { case_key: 'u1', arm_hash: 'armX', repetition: 1, nqi: 70, band: 'C', subjects: [], hash: 'h1' },
  ]);
  const out = await callTool(deps(db), 'report_export', { run_id: ordinary.id, include: ['repair'] }) as { sections: string[] };
  assert.ok(!out.sections.includes('repair'), 'an experiment run has no repair to report');

  const plan = await putObject(db, 'operator', 'operation_plan', { kind: 'reaudit_plan', engine: 'ipd_episode', cases: [] }, 'deidentified', null);
  const { run } = await submitRun(db, 'operator', 'reaudit', null, budget.id, 'rx-3', 'h', 86_400_000, [{
    case_key: 'a1', arm_hash: 'h', repetition: 1, payload: { engine: 'ipd_episode', plan_id: plan.object.id, budget_id: budget.id },
  }]);
  const repaired = await callTool(deps(db, 'operator'), 'report_export', { run_id: run.id, include: ['repair'] }) as { artifact_id: string; sections: string[] };
  assert.ok(repaired.sections.includes('repair'));
  const body = (await getObject(db, repaired.artifact_id))!.body as { repair: { plan_id: string; plan: unknown; cases: unknown[] } };
  assert.equal(body.repair.plan_id, plan.object.id);
  assert.ok(body.repair.plan, 'the plan travels with the outcomes, so a reader need not fetch it');
  assert.equal(body.repair.cases.length, 1);
  await db.close();
});

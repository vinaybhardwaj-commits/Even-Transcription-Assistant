/**
 * LAB-MCP-V2 §17.4 — cohorts, frozen retrieval, steps, exact replay, reconcile, queue wait.
 *
 * The platform side of round B1, against real Postgres (PGlite). What is tested here is the
 * machinery a comparison rests on: that a member key is not an identifier, that a frozen dataset
 * reads nothing, that a replay makes no model call and costs nothing, and that money only leaves
 * `unknown` when a person says why.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { freshDb, ARM, FROZEN } from './helpers';
import { callTool } from '../service';
import { LabError } from '../contracts';
import { Gateway, dependencyHash } from '../gateway';
import { fixtureTransport } from '../transport';
import { routeBlobHash, type RouteRead } from '../adapters/types';
import { makeOpdAdapter } from '../adapters/opd';
import { summariseAsk } from '../adapters/ask';
import { summariseDdx } from '../adapters/ddx';
import { summariseAppropriateness } from '../adapters/appropriateness';
import { summarisePathway } from '../adapters/pathway';
import { summariseDocAudit } from '../adapters/doc-audit';
import { replayTransport } from '../tools/replay';
import { COHORT_MAX, freezeCohort, resolveCohortKeys } from '../sources/cohort';
import { memberKeyOf, memberSalt } from '../sources/opd';
import {
  ensureBudget, getBudget, getObject, itemsOf, openCall, putObject, queueWait, reconcileCall,
  stepsOf, submitRun, writeStep,
} from '../store';
import type { Db } from '../db';

const deps = (db: Db, principal: 'research' | 'operator' = 'research') =>
  ({ db, principal, protocolVersion: 'test', sdkVersion: 'test' }) as never;

/** The identifier the whole of decision 44 exists to keep out of the store. */
const RAW_MEMBER_ID = 'IND-90210-RAW-FIXTURE';

const EMPTY_RETRIEVAL = async () => ({ hits: [], expandedQuery: 'q' }) as never;

async function seedRun(db: Db, key: string, n = 1) {
  const budget = await ensureBudget(db, 'research', 'default', 10_000_000);
  const items = Array.from({ length: n }, (_, i) => ({
    case_key: `c${i}`, arm_hash: 'h', repetition: 1, payload: {},
  }));
  const { run } = await submitRun(db, 'research', 'experiment_run', null, budget.id, key, 'h', 86_400_000, items);
  return { run, budget };
}

// ── decision 44: the member key ──────────────────────────────────────────────────────
test('decision 44: member_key is a salted hash, never the raw id, and stable within a salt', () => {
  const key = memberKeyOf(RAW_MEMBER_ID, 'salt-A');
  assert.match(key, /^[0-9a-f]{64}$/, 'hex sha256');
  assert.notEqual(key, RAW_MEMBER_ID);
  assert.ok(!key.includes(RAW_MEMBER_ID));
  // Stable within a deployment, so a member's cases cluster together across datasets…
  assert.equal(key, memberKeyOf(RAW_MEMBER_ID, 'salt-A'));
  // …and useless outside it, which is the whole job of the salt.
  assert.notEqual(key, memberKeyOf(RAW_MEMBER_ID, 'salt-B'));
});

test('decision 44: no salt, no cohort — NOT_CONFIGURED, never an unsalted digest', async () => {
  const saved = process.env.LAB_V2_MEMBER_SALT;
  delete process.env.LAB_V2_MEMBER_SALT;
  try {
    assert.throws(() => memberSalt(), (e: { code?: string }) => e.code === 'NOT_CONFIGURED');
    const db = await freshDb();
    await assert.rejects(
      () => callTool(deps(db), 'dataset_create', {
        engine: 'opd_note_audit', cohort: { case_keys: ['u1'] }, idempotency_key: 'no-salt',
      }),
      (e: { code?: string }) => e.code === 'NOT_CONFIGURED',
    );
    await db.close();
  } finally { if (saved !== undefined) process.env.LAB_V2_MEMBER_SALT = saved; }
});

test('decision 44: the raw member id appears in NO stored object', async () => {
  const db = await freshDb();
  const key = memberKeyOf(RAW_MEMBER_ID, 'salt-A');
  // A dataset shaped exactly as a cohort freeze stores one.
  await putObject(db, 'research', 'dataset', {
    engine: 'opd_note_audit',
    cases: [{ case_key: 'u1', member_key: key, frozen: FROZEN }],
    snapshot_policy: 'cohort_at_creation', exclusions: [], classification: 'deidentified',
    source_versions: {}, replay_exactness: 'frozen',
  }, 'deidentified', 'grep-fixture');
  // Grep every stored object, not just the one written above: the claim is about the store.
  const rows = await db.query<{ body: unknown }>(`SELECT body FROM lab_v2.objects`);
  const blob = JSON.stringify(rows);
  assert.ok(!blob.includes(RAW_MEMBER_ID), 'the raw identifier reached storage');
  assert.ok(blob.includes(key), 'but the salted key did');
  await db.close();
});

// ── decision 41: frozen retrieval ────────────────────────────────────────────────────
test('decision 41: the OPD retrieve edge serves the frozen list and reads nothing', async () => {
  const db = await freshDb();
  const budget = await ensureBudget(db, 'research', 'default', 10_000_000);
  const { run } = await submitRun(db, 'research', 'experiment_run', null, budget.id, 'frozen-1', 'h', 86_400_000, [
    { case_key: 'test-note-0001', arm_hash: 'h', repetition: 1, payload: {} },
  ]);
  const item = (await itemsOf(db, run.id))[0];
  const gateway = new Gateway({
    db, itemId: item.id, leaseToken: 0, budgetId: budget.id,
    transport: fixtureTransport({ reply: JSON.stringify({ findings: [], pdqi9: {} }) }),
    stages: { analysis: { provider: 'ollama', model: 'local-model', max_cost_microusd: 100_000 } },
  });
  let liveReads = 0;
  const events: Record<string, unknown>[] = [];
  const frozen = {
    ...FROZEN,
    sources: [{
      id: 101, book: 'Tintinalli', chapter: 'Bronchitis', source: 'textbook',
      preview: 'Antibiotics are not indicated in uncomplicated acute bronchitis.', score: 0.81,
    }],
  };
  const outcome = await makeOpdAdapter({ retrieve: async () => { liveReads += 1; return EMPTY_RETRIEVAL(); } }).run({
    runId: run.id, itemId: item.id, caseKey: 'test-note-0001', frozen, arm: ARM, repetition: 1, gateway,
    event: (kind, body) => { events.push({ kind, ...body }); },
    checkpoint: async (_n, _h, p) => p(),
  });
  assert.equal(outcome.execution_status, 'succeeded');
  assert.equal(liveReads, 0, 'a frozen dataset must not read the corpus');
  const read = events.find((e) => e.kind === 'retrieval_read');
  assert.ok(read, 'the frozen serve is still logged as a retrieval_read');
  assert.equal(read!.frozen, true, 'and says which path it took');
  assert.equal(read!.chunks, 1, 'one frozen chunk served');
  await db.close();
});

test('decision 41: without a frozen list the Slice A path is unchanged and says frozen:false', async () => {
  const db = await freshDb();
  const budget = await ensureBudget(db, 'research', 'default', 10_000_000);
  const { run } = await submitRun(db, 'research', 'experiment_run', null, budget.id, 'frozen-2', 'h', 86_400_000, [
    { case_key: 'test-note-0001', arm_hash: 'h', repetition: 1, payload: {} },
  ]);
  const item = (await itemsOf(db, run.id))[0];
  const gateway = new Gateway({
    db, itemId: item.id, leaseToken: 0, budgetId: budget.id,
    transport: fixtureTransport({ reply: JSON.stringify({ findings: [], pdqi9: {} }) }),
    stages: { analysis: { provider: 'ollama', model: 'local-model', max_cost_microusd: 100_000 } },
  });
  let liveReads = 0;
  const events: Record<string, unknown>[] = [];
  await makeOpdAdapter({ retrieve: async () => { liveReads += 1; return EMPTY_RETRIEVAL(); } }).run({
    runId: run.id, itemId: item.id, caseKey: 'test-note-0001', frozen: FROZEN, arm: ARM, repetition: 1, gateway,
    event: (kind, body) => { events.push({ kind, ...body }); },
    checkpoint: async (_n, _h, p) => p(),
  });
  assert.ok(liveReads >= 1, 'a mutable_source dataset still reads the live corpus');
  assert.equal(events.find((e) => e.kind === 'retrieval_read')!.frozen, false);
  await db.close();
});

// ── the cohort ───────────────────────────────────────────────────────────────────────
test('§17.4: a cohort is capped at 200, and an empty one is refused rather than frozen', async () => {
  assert.equal(COHORT_MAX, 200);
  await assert.rejects(
    () => resolveCohortKeys({ case_keys: Array.from({ length: 201 }, (_, i) => `u${i}`) }, []),
    (e: { code?: string }) => e.code === 'INVALID_INPUT',
  );
  await assert.rejects(() => resolveCohortKeys({}, []), (e: { code?: string }) => e.code === 'INVALID_INPUT');
  // Exclusions that remove everything are the same failure, and must not silently freeze nothing.
  await assert.rejects(
    () => resolveCohortKeys({ case_keys: ['u1', 'u2'] }, ['u1', 'u2']),
    (e: { code?: string }) => e.code === 'INVALID_INPUT',
  );
});

test('§17.4: cohort keys are deduplicated and exclusions removed before any read', async () => {
  assert.deepEqual(await resolveCohortKeys({ case_keys: ['u1', 'u1', 'u2', 'u3'] }, ['u3']), ['u1', 'u2']);
});

test('§17.4: one case that cannot be frozen is an exclusion with a reason, not a failed cohort', async () => {
  const saved = process.env.LAB_V2_MEMBER_SALT;
  process.env.LAB_V2_MEMBER_SALT = 'test-salt';
  try {
    const out = await freezeCohort({ case_keys: ['good-1', 'bad-1', 'good-2'] }, [], async (key) => {
      if (key === 'bad-1') throw new LabError('NOT_FOUND', 'note not found in db13');
      return {
        case_key: key, member_key: memberKeyOf(RAW_MEMBER_ID, 'test-salt'),
        frozen: FROZEN as never, source_versions: {},
      };
    });
    assert.equal(out.requested, 3);
    assert.equal(out.cases.length, 2, 'the other two are frozen — one bad row is not the cohort');
    assert.deepEqual(out.excluded.map((e) => e.case_key), ['bad-1']);
    assert.match(out.excluded[0].reason, /NOT_FOUND: note not found in db13/, 'the reason is data, not a log line');
    // And a missing salt is the COHORT's failure, never 200 quiet exclusions.
    delete process.env.LAB_V2_MEMBER_SALT;
    await assert.rejects(
      () => freezeCohort({ case_keys: ['good-1'] }, [], async () => { throw new Error('unreachable'); }),
      (e: { code?: string }) => e.code === 'NOT_CONFIGURED',
    );
  } finally {
    if (saved === undefined) delete process.env.LAB_V2_MEMBER_SALT;
    else process.env.LAB_V2_MEMBER_SALT = saved;
  }
});

// ── decision 45: steps and exact replay ──────────────────────────────────────────────
test('decision 45: the gateway writes one steps row per stage, keyed by the request hash', async () => {
  const db = await freshDb();
  const { run, budget } = await seedRun(db, 'steps-1');
  const item = (await itemsOf(db, run.id))[0];
  const params = { messages: [{ role: 'user', content: 'hello' }], temperature: 0 };
  const gw = new Gateway({
    db, itemId: item.id, leaseToken: 0, budgetId: budget.id,
    transport: fixtureTransport({ reply: 'the reply' }),
    stages: { analysis: { provider: 'ollama', model: 'local-model', max_cost_microusd: 5_000 } },
  });
  await gw.call('analysis', params);

  const steps = await stepsOf(db, item.id);
  assert.equal(steps.size, 1, 'one stage, one step');
  const step = steps.get('analysis')!;
  assert.equal(step.dependency_hash, dependencyHash(params), 'the hash is of the request body');
  const artifact = await getObject(db, step.artifact_id);
  assert.equal((artifact!.body as { text: string }).text, 'the reply', 'the raw reply is what was stored');
  await db.close();
});

test('decision 45: the request hash is over the params alone, and key order does not move it', () => {
  const params = { messages: [{ role: 'user', content: 'x' }], temperature: 0 };
  // Canonical JSON sorts at every depth, so two spellings of one request are one hash.
  assert.equal(dependencyHash(params), dependencyHash({ temperature: 0, messages: [{ content: 'x', role: 'user' }] }));
  // A changed prompt, or a changed knob, is a changed request.
  assert.notEqual(dependencyHash(params), dependencyHash({ ...params, temperature: 0.2 }));
  assert.notEqual(dependencyHash(params), dependencyHash({ messages: [{ role: 'user', content: 'y' }], temperature: 0 }));
});

test('decision 45: the replay transport serves the stored reply and reaches no provider', async () => {
  const db = await freshDb();
  const { run } = await seedRun(db, 'replay-1');
  const item = (await itemsOf(db, run.id))[0];
  const params = { messages: [{ role: 'user', content: 'q' }] };
  await writeStep(db, item.id, 'analysis', dependencyHash(params), {
    completion: { c: 1 }, text: 'stored reply', served: { provider: 'ollama', model: 'm' },
  });

  let served = 0;
  const t = replayTransport(db, item.id, () => { served += 1; });
  const out = await t({ provider: 'ollama', model: 'local-model', params } as never);
  assert.equal(out.text, 'stored reply');
  assert.deepEqual(out.usage, { input_tokens: 0, output_tokens: 0 }, 'zero usage ⇒ zero cost');
  assert.equal(served, 1, 'the stored step answered it');
  await db.close();
});

test('decision 45: a changed request is REPLAY_DIVERGED, never a live call', async () => {
  const db = await freshDb();
  const { run } = await seedRun(db, 'replay-2');
  const item = (await itemsOf(db, run.id))[0];
  await writeStep(db, item.id, 'analysis', dependencyHash({ messages: [{ role: 'user', content: 'original' }] }), { text: 'r' });
  const t = replayTransport(db, item.id);
  await assert.rejects(
    () => t({ provider: 'ollama', model: 'local-model', params: { messages: [{ role: 'user', content: 'CHANGED PROMPT' }] } } as never),
    (e: { code?: string }) => e.code === 'REPLAY_DIVERGED',
  );
  await db.close();
});

test('decision 45: a replayed stage settles at zero — zero model calls, zero spend', async () => {
  const db = await freshDb();
  const { run, budget } = await seedRun(db, 'replay-3');
  const item = (await itemsOf(db, run.id))[0];
  const params = { messages: [{ role: 'user', content: 'q' }] };
  await writeStep(db, item.id, 'analysis', dependencyHash(params), {
    text: 'stored', served: { provider: 'bedrock', model: 'global.anthropic.claude-haiku-4-5-20251001-v1:0' },
  });
  const gw = new Gateway({
    db, itemId: item.id, leaseToken: 0, budgetId: budget.id,
    transport: replayTransport(db, item.id),
    stages: { analysis: { provider: 'bedrock', model: 'global.anthropic.claude-haiku-4-5-20251001-v1:0', max_cost_microusd: 50_000 } },
  });
  await gw.call('analysis', params);
  const after = await getBudget(db, budget.id);
  assert.equal(Number(after!.spent_microusd), 0, 'a replay must be free to be worth running often');
  assert.equal(Number(after!.reserved_microusd), 0, 'and must release its reservation');
  await db.close();
});

// ── decision 42: budget_reconcile ────────────────────────────────────────────────────
test('decision 42: reconcile moves the right amounts, with the reason stored on the call', async () => {
  const db = await freshDb();
  const { run, budget } = await seedRun(db, 'rec-1');
  const item = (await itemsOf(db, run.id))[0];
  const callId = await openCall(db, item.id, 0, 'analysis', budget.id, { provider: 'ollama', model: 'm' }, 9_000, 'v1', 'reserved');
  // Put the call and the budget in the state a transport error leaves behind.
  await db.query(`UPDATE lab_v2.calls SET state = 'unknown' WHERE id = $1`, [callId]);
  await db.query(`UPDATE lab_v2.budgets SET reserved_microusd = 0, unknown_microusd = 9000 WHERE id = $1`, [budget.id]);

  const out = await callTool(deps(db, 'operator'), 'budget_reconcile', {
    call_id: callId, actual_microusd: 7_500, reason: 'provider invoice line 44, measured after the fact',
  }) as { from_unknown_microusd: number; to_spent_microusd: number };
  assert.equal(out.from_unknown_microusd, 9_000, 'the reservation that was stranded');
  assert.equal(out.to_spent_microusd, 7_500, 'the amount actually charged');

  const after = await getBudget(db, budget.id);
  assert.equal(Number(after!.unknown_microusd), 0);
  assert.equal(Number(after!.spent_microusd), 7_500);
  const [call] = await db.query<{ state: string; served: { reconciled?: boolean; reconcile_reason?: string } }>(
    `SELECT state, served FROM lab_v2.calls WHERE id = $1`, [callId]);
  assert.equal(call.state, 'settled');
  assert.equal(call.served.reconciled, true);
  assert.match(call.served.reconcile_reason ?? '', /invoice line 44/, 'the reason is on the record, not in a log');
  await db.close();
});

test('decision 42: a reason is required, and only an unknown call can be reconciled', async () => {
  const db = await freshDb();
  const { run, budget } = await seedRun(db, 'rec-2');
  const item = (await itemsOf(db, run.id))[0];
  const callId = await openCall(db, item.id, 0, 'analysis', budget.id, { provider: 'ollama', model: 'm' }, 100, 'v1', 'reserved');
  // An empty reason is refused by the schema, before anything moves.
  await assert.rejects(
    () => callTool(deps(db, 'operator'), 'budget_reconcile', { call_id: callId, actual_microusd: 1, reason: '' }),
    (e: { code?: string }) => e.code === 'INVALID_INPUT',
  );
  // A call that is not `unknown` cannot be re-settled at a new number — a reconcile is not a rewrite.
  await assert.rejects(
    () => reconcileCall(db, callId, 1, 'because', 'operator'),
    (e: { code?: string; message?: string }) => e.code === 'INVALID_INPUT' && /not 'unknown'/.test(e.message ?? ''),
  );
  assert.equal(Number((await getBudget(db, budget.id))!.spent_microusd), 0, 'and nothing moved');
  await db.close();
});

// ── decision 43: queue wait ──────────────────────────────────────────────────────────
test('decision 43: queue wait is measured to the FIRST attempt, on seeded rows', async () => {
  const db = await freshDb();
  const { run } = await seedRun(db, 'qw-1', 10);
  const items = await itemsOf(db, run.id);
  // Ten items waiting 1 s … 10 s. The first also gets a LATER second attempt, which must not be
  // counted: this measures time-to-pickup, not time-to-retry.
  //
  // The submission instant is the RUN's created_at — decision 43 names `items.created_at`, which
  // migration 0001 never created; the run and its items are inserted in one transaction, so the
  // two are the same instant. Backdate it once, then place each attempt against it.
  await db.query(`UPDATE lab_v2.runs SET created_at = now() - make_interval(secs => 60) WHERE id = $1`, [run.id]);
  for (let i = 0; i < items.length; i += 1) {
    const waitS = i + 1;
    await db.query(
      `INSERT INTO lab_v2.attempts (item_id, lease_token, worker, started_at) VALUES ($1, 1, 'w', now() - make_interval(secs => $2))`,
      [items[i].id, 60 - waitS]);
  }
  await db.query(
    `INSERT INTO lab_v2.attempts (item_id, lease_token, worker, started_at) VALUES ($1, 2, 'w', now())`, [items[0].id]);

  const out = await queueWait(db, 24);
  assert.equal(out.n, 10, 'ten items, ten waits — the retry did not add an eleventh');
  assert.ok(Math.abs(out.p50! - 5_000) < 500, `p50 was ${out.p50}`);
  assert.ok(Math.abs(out.p95! - 9_000) < 500, `p95 was ${out.p95}`);

  const health = await callTool(deps(db, 'operator'), 'system_health', {}) as {
    queue_wait_ms: { last_24h: { n: number; p50: number | null }; last_7d: { n: number } };
  };
  assert.equal(health.queue_wait_ms.last_24h.n, 10, 'and system_health reports it');
  assert.equal(health.queue_wait_ms.last_7d.n, 10);
  await db.close();
});

test('decision 43: no attempts yet is n:0 with null percentiles, never a flattering 0 ms', async () => {
  const db = await freshDb();
  assert.deepEqual(await queueWait(db, 24), { p50: null, p95: null, n: 0 });
  await db.close();
});

// ── run_diff and experiment_compare ──────────────────────────────────────────────────
interface SeedRow { case_key: string; nqi: number; band: string; subjects: string[]; hash: string }

async function seedComparableRun(
  db: Db, key: string, budgetId: string, experimentId: string | null, armHash: string, rows: SeedRow[],
) {
  const { run } = await submitRun(db, 'research', 'experiment_run', experimentId, budgetId, key, 'h', 86_400_000,
    rows.map((r) => ({ case_key: r.case_key, arm_hash: armHash, repetition: 1, payload: {} })));
  const items = await itemsOf(db, run.id);
  const byKey = new Map(rows.map((r) => [r.case_key, r]));
  for (const item of items) {
    const r = byKey.get(item.case_key)!;
    await db.query(
      `UPDATE lab_v2.items SET state = 'succeeded', execution_status = 'succeeded', assessment_status = 'assessed',
         attribution_status = 'verified', result = $2::jsonb WHERE id = $1`,
      [item.id, JSON.stringify({
        result_hash: r.hash,
        summary: { findings: r.subjects.length, n_low_value: 1, note_quality_index: r.nqi, band: r.band, finding_subjects: r.subjects },
      })]);
  }
  return run;
}

test('§17.4: run_diff pairs on case key and reports subjects, band and hash equality', async () => {
  const db = await freshDb();
  const budget = await ensureBudget(db, 'research', 'default', 1_000_000);
  const a = await seedComparableRun(db, 'diff-a', budget.id, null, 'armA', [
    { case_key: 'u1', nqi: 70, band: 'C', subjects: ['s1', 's2'], hash: 'h1' },
    { case_key: 'u2', nqi: 80, band: 'B', subjects: ['s3'], hash: 'h2' },
  ]);
  const b = await seedComparableRun(db, 'diff-b', budget.id, null, 'armB', [
    { case_key: 'u1', nqi: 76, band: 'B', subjects: ['s1', 's9'], hash: 'h1' },
    { case_key: 'u3', nqi: 60, band: 'D', subjects: [], hash: 'h4' },
  ]);
  const out = await callTool(deps(db), 'run_diff', { run_a: a.id, run_b: b.id }) as {
    paired: number; paired_on: string; arms_a: string[]; arms_b: string[];
    only_in_a: { case_key: string; arm_hash: string; repetition: number }[];
    only_in_b: { case_key: string; arm_hash: string; repetition: number }[];
    cases: {
      case_key: string; arm_hash: string; repetition: number;
      subjects_added: string[]; subjects_removed: string[];
      band_before: string; band_after: string; result_hash_equal: boolean;
      note_quality_index_before: number; note_quality_index_after: number;
    }[];
  };
  assert.equal(out.paired, 1, 'only u1 is on both sides');
  // lab-v2 decision 58 (§17.6). These two runs carry DIFFERENT arms, so the arm cannot be part of
  // the key without pairing nothing — the tool says which key it used instead of choosing silently.
  assert.equal(out.paired_on, 'case_key+repetition');
  assert.deepEqual(out.arms_a, ['armA']);
  assert.deepEqual(out.arms_b, ['armB']);
  // An unpaired item is named by its whole key now, not by its case alone.
  assert.deepEqual(out.only_in_a, [{ case_key: 'u2', arm_hash: 'armA', repetition: 1 }]);
  assert.deepEqual(out.only_in_b, [{ case_key: 'u3', arm_hash: 'armB', repetition: 1 }]);
  const c = out.cases[0];
  assert.equal(c.case_key, 'u1');
  assert.equal(c.arm_hash, 'armA', 'the arm rides on every row');
  assert.equal(c.repetition, 1);
  assert.deepEqual(c.subjects_added, ['s9']);
  assert.deepEqual(c.subjects_removed, ['s2']);
  assert.equal(c.band_before, 'C');
  assert.equal(c.band_after, 'B');
  assert.equal(c.note_quality_index_before, 70);
  assert.equal(c.note_quality_index_after, 76);
  assert.equal(c.result_hash_equal, true, 'the same hash on both sides is a genuine no-change');
  await db.close();
});

test('§17.4: experiment_compare denominators sum, and the metric denominator is named', async () => {
  const db = await freshDb();
  const budget = await ensureBudget(db, 'research', 'default', 1_000_000);
  // Three cases, two members: u1 and u2 are the same member, so the bootstrap sees TWO clusters.
  const dataset = await putObject(db, 'research', 'dataset', {
    engine: 'opd_note_audit',
    cases: [
      { case_key: 'u1', member_key: 'mk1', frozen: FROZEN },
      { case_key: 'u2', member_key: 'mk1', frozen: FROZEN },
      { case_key: 'u3', member_key: 'mk2', frozen: FROZEN },
    ],
    snapshot_policy: 'cohort_at_creation', exclusions: [], classification: 'deidentified',
    source_versions: {}, replay_exactness: 'frozen',
  }, 'deidentified', 'cmp-ds');
  const armA = await putObject(db, 'research', 'arm', { ...ARM, engine_version: 'A' }, 'deidentified', 'cmp-arm-a');
  const armB = await putObject(db, 'research', 'arm', { ...ARM, engine_version: 'B' }, 'deidentified', 'cmp-arm-b');
  const experiment = await putObject(db, 'research', 'experiment', {
    hypothesis: 'B scores the same notes higher than A', dataset_id: dataset.object.id, dataset_hash: dataset.object.hash,
    baseline_arm_id: armA.object.id, arm_ids: [armA.object.id, armB.object.id],
    repeats: 1, endpoints: ['note_quality_index'], budget_name: 'default', purpose: 'research',
  }, 'deidentified', 'cmp-exp');

  const rows = (nqi: number[]): SeedRow[] => ['u1', 'u2', 'u3'].map((k, i) => ({
    case_key: k, nqi: nqi[i], band: 'B', subjects: ['s1'], hash: `h-${k}-${nqi[i]}`,
  }));
  await seedComparableRun(db, 'cmp-a', budget.id, experiment.object.id, armA.object.hash, rows([70, 72, 74]));
  await seedComparableRun(db, 'cmp-b', budget.id, experiment.object.id, armB.object.hash, rows([75, 77, 79]));

  const out = await callTool(deps(db), 'experiment_compare', { experiment_id: experiment.object.id }) as {
    metric_denominator: string; replay_exactness: string; artifact_id: string; caveat: string;
    arms: {
      is_baseline: boolean; paired: number;
      denominators: {
        attempted: number; succeeded: number; failed: number; cancelled: number; expired: number;
        assessable_verified: number; sums: boolean;
      };
      metrics: null | { delta_note_quality_index: { mean: number; clusters: number; n: number; seed: number; resamples: number } };
    }[];
  };
  assert.equal(out.metric_denominator, 'assessable_verified', '§9 — the metric denominator is named in the output');
  assert.equal(out.replay_exactness, 'frozen');
  assert.match(out.caveat, /One run is one sample/);

  for (const arm of out.arms) {
    const d = arm.denominators;
    assert.equal(d.attempted, d.succeeded + d.failed + d.cancelled + d.expired, 'the four buckets sum to attempted');
    assert.equal(d.sums, true, 'and the output says so, rather than leaving it to be recomputed');
    assert.equal(d.assessable_verified, 3);
  }
  const armOut = out.arms.find((x) => !x.is_baseline)!;
  assert.equal(armOut.paired, 3);
  assert.equal(armOut.metrics!.delta_note_quality_index.mean, 5, 'every case improved by exactly 5');
  assert.equal(armOut.metrics!.delta_note_quality_index.n, 3);
  assert.equal(armOut.metrics!.delta_note_quality_index.clusters, 2, 'clustered on member_key, not on case');
  assert.equal(armOut.metrics!.delta_note_quality_index.seed, 19052026);
  assert.equal(armOut.metrics!.delta_note_quality_index.resamples, 1000);
  assert.equal(out.arms.find((x) => x.is_baseline)!.metrics, null, 'the baseline is not compared with itself');

  // The comparison is stored, so a report cites an artifact rather than a chat message.
  const artifact = await getObject(db, out.artifact_id);
  assert.equal(artifact!.kind, 'report');
  assert.match(JSON.stringify(artifact!.body), /One run is one sample/);
  await db.close();
});

// ── decision 39: engine versions and summaries ───────────────────────────────────────
test('decision 39: each A3 engine reports a route-derived version, not a placeholder', async () => {
  const db = await freshDb();
  for (const engine of ['ask', 'ddx', 'appropriateness', 'pathway', 'doc_audit']) {
    const out = await callTool(deps(db), 'engine_describe', { engine }) as { engine_version: string };
    assert.match(out.engine_version, new RegExp(`^${engine}/route@[0-9a-f]{12}$`),
      `${engine}: the version is the route file's git blob hash`);
  }
  await db.close();
});

test('decision 39: the version IS git hash-object, and an unreadable source says so', () => {
  for (const file of ['app/api/ask/route.ts', 'app/api/pathway/skeleton/route.ts']) {
    const expected = execFileSync('git', ['hash-object', file], { encoding: 'utf8' }).trim();
    assert.equal(routeBlobHash(file), expected, `${file}: byte-identical to git hash-object`);
  }
  assert.equal(routeBlobHash('app/api/does-not-exist/route.ts'), 'unavailable',
    'an unreadable source reports that it does not know, rather than fabricating a hash');
});

test('decision 39: every A3 summary field is non-null on a successful read', () => {
  const read = (events: unknown[], json: unknown = null): RouteRead => ({ status: 200, events, json });

  const ask = summariseAsk(read([
    { type: 'progress', stage: 'retrieval' }, { type: 'sources', items: [{ n: 1 }, { n: 2 }] },
    { type: 'token', text: 'a' }, { type: 'token', text: 'b' }, { type: 'draft_complete' }, { type: 'done', ms: 42 },
  ]));
  assert.deepEqual(ask, {
    event_types: ['progress', 'sources', 'token', 'token', 'draft_complete', 'done'],
    events: 6, sources: 2, tokens: 2, draft_complete: true, ms: 42,
  });

  const ddx = summariseDdx(read([
    { type: 'sources', items: [{ n: 1 }] }, { type: 'critique' }, { type: 'done', ms: 7 },
  ]));
  assert.equal(ddx.sources, 1);
  assert.equal(ddx.critiqued, true);
  assert.equal(ddx.ms, 7);

  const appr = summariseAppropriateness(read([
    { type: 'progress', stage: 'a' }, { type: 'progress', stage: 'b' }, { type: 'done', ms: 9 },
  ]));
  assert.equal(appr.progress_stages, 2);
  assert.equal(appr.ms, 9);

  const pathway = summarisePathway(read([], { ok: true, skeleton: { steps: [1, 2, 3] } }));
  assert.deepEqual(pathway, { ok: true, steps: 3 });

  const doc = summariseDocAudit(read([
    { type: 'result', data: { ok: true, report: { sections: [] } } }, { type: 'done', ms: 11 },
  ]));
  assert.equal(doc.ok, true);
  assert.equal(doc.has_report, true);
  assert.equal(doc.ms, 11);

  // The claim of the round: no field of any of the five is null when the engine ran to `done`.
  for (const [engine, summary] of Object.entries({ ask, ddx, appr, pathway, doc })) {
    for (const [field, value] of Object.entries(summary)) {
      assert.notEqual(value, null, `${engine}.${field} is null on a successful run`);
    }
  }
});

/**
 * LAB-MCP-V2 §17.6 fix 1 — decisions 72, 74 and 75.
 *
 * ⚠️ WHAT THIS FILE IS ABOUT. On `7ffc9089` a live `reaudit_execute` from the operator key wrote a
 * DEFECTIVE PRODUCTION ROW: `ipd_episode_audits` `bcc093f0`, `encounter_id` `EPFROZEN…` — the B2
 * synthetic handle — `engine_version` 0.1 rather than the plan's 0.2, `member_id` null,
 * `is_current` true, and 81 findings replayed from stored 0.1 judge replies with zero model calls.
 * The real encounter's rows were untouched; the row was an orphan under an encounter that does not
 * exist. V deleted it by hand.
 *
 * Two independent mistakes made it, and both are tested here:
 *   · the plan qualified by AUDIT ROW, and chose a 0.1 row whose encounter already had a current
 *     0.2 row beside it — decision 74. The episode had nothing to repair.
 *   · `reaudit_execute` froze the case the way B2 freezes for REPLAY, so the adapter took frozen
 *     mode and replayed instead of running — decision 75.
 *
 * The first test below is the one that must have been red before the fix, and it is red for both
 * reasons at once: it asserts the writer received the REAL encounter id and the PLAN's version.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { freshDb } from './helpers';
import { callTool } from '../service';
import { LabError } from '../contracts';
import { ensureBudget, itemsOf, putObject, submitRun } from '../store';
import { tick } from '../worker';
import { fixtureTransport } from '../transport';
import { assertNotAReplayCase, makeIpdEpisodeRepairAdapter } from '../adapters/ipd-episode';
import { makeOpdRepairAdapter } from '../adapters/opd';
import { EPISODE_QUALIFY_SQL, OPD_QUALIFY_SQL, resolveEpisodesForRepair, resolveOpdForRepair } from '../sources/ipd';
import { reauditExecute, reauditPlan } from '../tools/repair';
import { coerceRankRows, retrievalCompare } from '../tools/retrieval-compare';
import { coverageReport } from '../tools/coverage';
import { driftReport } from '../tools/drift';
import { FIXTURE_ENCOUNTER, fixtureDeps, fixtureLedger } from './fixtures/episode-fixture';
import type { EpisodeAuditRow } from '../../ipd-episode/store';
import type { Db } from '../db';

const deps = (db: Db, principal: 'research' | 'operator' = 'operator') =>
  ({ db, principal, protocolVersion: 'test', sdkVersion: 'test' }) as never;

const SOURCE_AUDIT_ID = 'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa';
const PLAN_VERSION = 'ipd-episode-audit/0.2';
const SOURCE_VERSION = 'ipd-episode-audit/0.1';

// ─────────────────────────────────────────────────────────────────────────────────────
// DECISION 75 — a repair runs FRESH on the REAL episode
// ─────────────────────────────────────────────────────────────────────────────────────

test('§17.6 decision 75: the writer receives the REAL encounter id and the PLAN’s engine version', async () => {
  const db = await freshDb();
  const ledger = fixtureLedger();
  const live = fixtureDeps(ledger);

  // The spy. Everything else is the fixture episode, standing in for live db13.
  const wrote: EpisodeAuditRow[] = [];
  const assembledFor: string[] = [];
  const adapter = makeIpdEpisodeRepairAdapter({
    fetchDischargeSummary: live.fetchDischargeSummary as never,
    fetchProgressNotes: live.fetchProgressNotes as never,
    fetchExtractionByIpUid: live.fetchExtractionByIpUid as never,
    // ⚠️ THE PRODUCTION FETCHER, ON THE REAL ENCOUNTER. Decision 75 says assembly runs against the
    // real episode; recording what it was asked for is how that is checked.
    assembleEpisode: (async (a: { encounterId: string }) => {
      assembledFor.push(a.encounterId);
      return (live.assembleEpisode as never as (x: unknown) => Promise<unknown>)(a) as never;
    }) as never,
    recordSkip: live.recordSkip as never,
    clearSkip: live.clearSkip as never,
    checkpoint: live.checkpoint as never,
    writeAudit: async (row) => {
      wrote.push(row);
      return { status: 'inserted', auditId: 'new-0001', failedCheckpoints: 0 };
    },
  });

  const budget = await ensureBudget(db, 'operator', 'repair', 10_000_000);
  const { run } = await submitRun(db, 'operator', 'reaudit', null, budget.id, 'd75', 'h', 86_400_000, [{
    case_key: SOURCE_AUDIT_ID, arm_hash: 'h', repetition: 1,
    payload: {
      engine: 'ipd_episode',
      // THE POINTER. No steps, no real_course, no synthetic ref.
      frozen: { audit_id: SOURCE_AUDIT_ID, encounter_id: FIXTURE_ENCOUNTER, source_engine_version: SOURCE_VERSION },
      arm: {
        engine_version: PLAN_VERSION,
        stages: {
          checkpoint: { provider: 'ollama', model: 'local-model', max_cost_microusd: 5000 },
          divergence: { provider: 'ollama', model: 'local-model', max_cost_microusd: 5000 },
          fidelity: { provider: 'ollama', model: 'local-model', max_cost_microusd: 5000 },
        },
      },
      budget_id: budget.id,
    },
  }]);
  await tick({
    db,
    transport: fixtureTransport({ reply: JSON.stringify({ findings: [] }) }),
    adapters: { ipd_episode: adapter },
  });

  const [item] = await itemsOf(db, run.id);
  assert.equal(item.state, 'succeeded', `the repair failed: ${JSON.stringify(item.error)}`);
  assert.equal(wrote.length, 1, 'the engine’s writer ran exactly once');
  const row = wrote[0];

  // ⚠️ THE TWO ASSERTIONS THAT WERE RED BEFORE THE FIX.
  assert.equal(row.encounterId, FIXTURE_ENCOUNTER,
    'the row must carry the REAL encounter id, never the EPFROZEN handle');
  assert.ok(!String(row.encounterId).startsWith('EPFROZEN'));
  assert.equal(row.engineVersion, PLAN_VERSION,
    'the row must carry the PLAN’s engine version, never the source row’s');
  assert.notEqual(row.engineVersion, SOURCE_VERSION);

  // …and the rest of what the nightly worker writes.
  assert.equal(row.ipUid, FIXTURE_ENCOUNTER, 'ip_uid is the encounter, as the store’s header says');
  assert.equal(row.memberId, 'FX-MEMBER-0001', 'member_id comes off the live assembly, never null');
  assert.deepEqual(assembledFor, [FIXTURE_ENCOUNTER], 'assembly ran on the real episode, once');
  assert.equal(item.attribution_status, 'verified', 'a repair makes REAL calls: it is not a replay');

  const summary = (item.result as { summary: { repair: { encounter_id: string; engine_version: string; status: string } } }).summary;
  assert.equal(summary.repair.encounter_id, FIXTURE_ENCOUNTER);
  assert.equal(summary.repair.engine_version, PLAN_VERSION);
  assert.equal(summary.repair.status, 'inserted');
  await db.close();
});

test('§17.6 decision 75: a repair makes REAL model calls, priced through the gateway', async () => {
  const db = await freshDb();
  const ledger = fixtureLedger();
  const live = fixtureDeps(ledger);
  const adapter = makeIpdEpisodeRepairAdapter({
    fetchDischargeSummary: live.fetchDischargeSummary as never,
    fetchProgressNotes: live.fetchProgressNotes as never,
    fetchExtractionByIpUid: live.fetchExtractionByIpUid as never,
    assembleEpisode: live.assembleEpisode as never,
    recordSkip: live.recordSkip as never,
    clearSkip: live.clearSkip as never,
    checkpoint: live.checkpoint as never,
    writeAudit: async () => ({ status: 'inserted', auditId: 'x', failedCheckpoints: 0 }),
  });
  const budget = await ensureBudget(db, 'operator', 'repair', 10_000_000);
  const { run } = await submitRun(db, 'operator', 'reaudit', null, budget.id, 'd75-calls', 'h', 86_400_000, [{
    case_key: SOURCE_AUDIT_ID, arm_hash: 'h', repetition: 1,
    payload: {
      engine: 'ipd_episode',
      frozen: { audit_id: SOURCE_AUDIT_ID, encounter_id: FIXTURE_ENCOUNTER },
      arm: {
        engine_version: PLAN_VERSION,
        stages: {
          checkpoint: { provider: 'ollama', model: 'local-model', max_cost_microusd: 5000 },
          divergence: { provider: 'ollama', model: 'local-model', max_cost_microusd: 5000 },
          fidelity: { provider: 'ollama', model: 'local-model', max_cost_microusd: 5000 },
        },
      },
      budget_id: budget.id,
    },
  }]);
  await tick({ db, transport: fixtureTransport({ reply: JSON.stringify({ findings: [] }) }), adapters: { ipd_episode: adapter } });
  const [item] = await itemsOf(db, run.id);
  const calls = await db.query<{ stage: string; state: string }>(
    `SELECT stage, state FROM lab_v2.calls WHERE item_id = $1 ORDER BY created_at`, [item.id]);
  // ⚠️ THE DEFECT WAS ZERO MODEL CALLS. A repair that spends nothing has not re-audited anything.
  assert.deepEqual(calls.map((c) => c.stage), ['divergence', 'fidelity'],
    'both judge passes ran for real and were priced (the checkpoint is the injected fixture)');
  assert.ok(calls.every((c) => c.state === 'settled'));
  await db.close();
});

test('§17.6 decision 75: a REPLAY case is refused before any write, on its shape', () => {
  // Each of the four fingerprints on its own is enough. A flag would have to be set correctly by
  // the caller; a fingerprint is a fact about the object.
  for (const replayish of [
    { audit_id: 'a', encounter_id: 'E1', steps: { deadbeef: { stage: 'divergence' } } },
    { audit_id: 'a', encounter_id: 'E1', episode_ref: 'EPFROZEN3499AABBCCDD' },
    { audit_id: 'a', encounter_id: 'E1', real_course: [{ event_id: 'e1' }] },
    { audit_id: 'a', encounter_id: 'E1', checkpoints: { 'cp-d1': {} } },
  ]) {
    assert.throws(() => assertNotAReplayCase(replayish),
      (e: { code?: string }) => e.code === 'REPAIR_FROZEN_CASE', JSON.stringify(Object.keys(replayish)));
  }
  // The exact shape that landed the orphan row: the synthetic handle in the encounter field.
  assert.throws(() => assertNotAReplayCase({ audit_id: 'a', encounter_id: 'EPFROZEN3499AABBCCDD' }),
    (e: { code?: string; message?: string }) => e.code === 'REPAIR_FROZEN_CASE' && /EPFROZEN/.test(String(e.message)));
  // An EMPTY steps map is not a replay case — that is what a fresh case legitimately looks like.
  assert.doesNotThrow(() => assertNotAReplayCase({ audit_id: 'a', encounter_id: 'E1', steps: {} }));
  assert.doesNotThrow(() => assertNotAReplayCase({ audit_id: 'a', encounter_id: 'E1' }));
});

test('§17.6 decision 75: THE PRODUCTION DEFECT, REPRODUCED — a replay case is refused, never written', async () => {
  const db = await freshDb();
  /**
   * ⚠️ THIS IS THE EXACT SHAPE THAT LANDED `bcc093f0`. On `7ffc9089` this payload made the adapter
   * take FROZEN mode and the writer received `encounter_id EPFROZEN3499…` and `engine_version` 0.1
   * — the source row's, not the plan's 0.2. Run against the pre-fix code, this test fails with
   * `state 'succeeded'` where it expects `'failed'`, and `wroteWith` holds those two wrong values.
   * They are asserted by name so the red output says WHAT was wrong, not merely that something was.
   */
  const wroteWith: { encounterId: string; engineVersion: string }[] = [];
  let wrote = 0;
  const adapter = makeIpdEpisodeRepairAdapter({
    writeAudit: async (row) => {
      wrote += 1;
      wroteWith.push({ encounterId: String(row.encounterId), engineVersion: String(row.engineVersion) });
      return { status: 'inserted', auditId: 'x', failedCheckpoints: 0 };
    },
  });
  const budget = await ensureBudget(db, 'operator', 'repair', 1_000_000);
  const { run } = await submitRun(db, 'operator', 'reaudit', null, budget.id, 'd75-refuse', 'h', 86_400_000, [{
    case_key: SOURCE_AUDIT_ID, arm_hash: 'h', repetition: 1,
    payload: {
      engine: 'ipd_episode',
      // Exactly what round B3 put here: a B2 replay case.
      frozen: { audit_id: SOURCE_AUDIT_ID, episode_ref: 'EPFROZEN3499AABBCCDD', engine_version: SOURCE_VERSION, steps: { abc: {} }, real_course: [{}] },
      arm: { engine_version: PLAN_VERSION, stages: {} },
      budget_id: budget.id,
    },
  }]);
  await tick({ db, transport: (async () => { throw new Error('no'); }) as never, adapters: { ipd_episode: adapter } });
  const [item] = await itemsOf(db, run.id);
  assert.equal(item.state, 'failed',
    `the repair ran instead of refusing; the writer received ${JSON.stringify(wroteWith)}`);
  // Null-safe on purpose: on the pre-fix code the adapter neither refused NOR threw — it returned
  // a failed outcome with `items.error` null — and a TypeError here would hide what happened.
  assert.equal((item.error as { code?: string } | null)?.code ?? null, 'REPAIR_FROZEN_CASE',
    `expected a refusal; the item ended ${item.state} with error ${JSON.stringify(item.error)} and the writer received ${JSON.stringify(wroteWith)}`);
  assert.equal(wrote, 0, `nothing may reach the writer; it received ${JSON.stringify(wroteWith)}`);
  assert.deepEqual(wroteWith, [], 'no EPFROZEN handle and no source-row version was ever stamped');
  await db.close();
});

test('§17.6 decision 75: an arm with no engine version cannot repair', async () => {
  const db = await freshDb();
  let wrote = 0;
  const adapter = makeIpdEpisodeRepairAdapter({ writeAudit: async () => { wrote += 1; return { status: 'inserted', auditId: 'x', failedCheckpoints: 0 }; } });
  const budget = await ensureBudget(db, 'operator', 'repair', 1_000_000);
  const { run } = await submitRun(db, 'operator', 'reaudit', null, budget.id, 'd75-nover', 'h', 86_400_000, [{
    case_key: SOURCE_AUDIT_ID, arm_hash: 'h', repetition: 1,
    payload: { engine: 'ipd_episode', frozen: { audit_id: SOURCE_AUDIT_ID, encounter_id: FIXTURE_ENCOUNTER }, arm: { stages: {} }, budget_id: budget.id },
  }]);
  await tick({ db, transport: (async () => { throw new Error('no'); }) as never, adapters: { ipd_episode: adapter } });
  const [item] = await itemsOf(db, run.id);
  assert.equal(item.state, 'failed');
  assert.equal(wrote, 0, 'a version the plan did not name is not a version to stamp');
  await db.close();
});

test('§17.6 decision 75: reaudit_execute queues a POINTER, never a frozen case', async () => {
  const db = await freshDb();
  const refs = [
    { audit_id: SOURCE_AUDIT_ID, encounter_id: FIXTURE_ENCOUNTER, ip_uid: FIXTURE_ENCOUNTER, current_engine_version: SOURCE_VERSION, already_at_version: false },
  ];
  const resolveIpd = async () => refs;
  const plan = await reauditPlan({ db, principal: 'operator', resolveIpd }, {
    engine: 'ipd_episode', engine_version: PLAN_VERSION, filter: { audit_ids: [SOURCE_AUDIT_ID] }, limit: 5,
  } as never);
  const out = await reauditExecute({ db, principal: 'operator', resolveIpd }, {
    plan_id: plan.plan_id, idempotency_key: 'ptr',
  }) as never as { run_id: string };
  const [item] = await itemsOf(db, out.run_id, 10, 0);
  const frozen = (item.payload as { frozen: Record<string, unknown> }).frozen;
  assert.deepEqual(Object.keys(frozen).sort(), ['audit_id', 'encounter_id', 'source_engine_version']);
  assert.equal(frozen.encounter_id, FIXTURE_ENCOUNTER, 'the REAL encounter, resolved at execute time');
  assert.equal(frozen.audit_id, SOURCE_AUDIT_ID);
  // ⚠️ The four fingerprints, absent. This payload cannot make the adapter replay anything.
  assert.doesNotThrow(() => assertNotAReplayCase(frozen));
  // And the arm carries the version the row will be stamped with.
  assert.equal((item.payload as { arm: { engine_version: string } }).arm.engine_version, PLAN_VERSION);
  await db.close();
});

test('§17.6 decision 75: the OPD repair refuses a case with frozen retrieval sources', async () => {
  const db = await freshDb();
  const adapter = makeOpdRepairAdapter({ writeAudit: async () => 'inserted' });
  const budget = await ensureBudget(db, 'operator', 'repair', 1_000_000);
  const { run } = await submitRun(db, 'operator', 'reaudit', null, budget.id, 'd75-opd', 'h', 86_400_000, [{
    case_key: 'note-1', arm_hash: 'h', repetition: 1,
    payload: {
      engine: 'opd_note_audit',
      frozen: { note: {}, specialty: null, complexity: { band: null, inputs: null }, lvc_rules: [], suppressions: [], quieting_config: { rules: [], gen: 0 }, sources: [{ id: 1, book: null, chapter: null, source: null, preview: null, score: null }] },
      arm: { engine_version: 'opd-note-audit/0.82', stages: {} },
      budget_id: budget.id,
    },
  }]);
  await tick({ db, transport: (async () => { throw new Error('no'); }) as never, adapters: { opd_note_audit: adapter } });
  const [item] = await itemsOf(db, run.id);
  assert.equal(item.state, 'failed');
  assert.equal((item.error as { code?: string }).code, 'REPAIR_FROZEN_CASE');
  await db.close();
});

// ─────────────────────────────────────────────────────────────────────────────────────
// DECISION 74 — qualification is per EPISODE, not per audit row
// ─────────────────────────────────────────────────────────────────────────────────────

test('§17.6 decision 74: the qualification statement asks about the ENCOUNTER, not the row', () => {
  const sql = EPISODE_QUALIFY_SQL(['aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa'], PLAN_VERSION);
  assert.match(sql, /^SELECT/);
  // ⚠️ THE SUBQUERY IS KEYED ON encounter_id. Keyed on `a.id` it would ask the question round B3
  // asked — "is THIS row at the target?" — and repair an episode that has nothing to repair.
  assert.match(sql, /WHERE t\.encounter_id = a\.encounter_id AND t\.is_current/);
  assert.ok(!/t\.id = a\.id/.test(sql));
  assert.ok(!/\b(INSERT|UPDATE|DELETE|DROP|ALTER)\b/.test(sql));
  assert.equal((sql.match(/;/g) ?? []).length, 0);
  assert.throws(() => EPISODE_QUALIFY_SQL(['not-a-uuid'], PLAN_VERSION), (e: { code?: string }) => e.code === 'INVALID_INPUT');
  assert.throws(() => EPISODE_QUALIFY_SQL([], PLAN_VERSION), (e: { code?: string }) => e.code === 'INVALID_INPUT');

  const opd = OPD_QUALIFY_SQL(['note-1'], 'opd-note-audit/0.82');
  assert.match(opd, /WHERE t\.uid = o\.uid/);
  assert.throws(() => OPD_QUALIFY_SQL(["x' OR 1=1"], 'v'), (e: { code?: string }) => e.code === 'INVALID_INPUT');
});

test('§17.6 decision 74: an episode already at the target version does not qualify', async () => {
  const db = await freshDb();
  // ⚠️ THE PRODUCTION CASE, EXACTLY. A current 0.1 row whose encounter ALSO has a current 0.2 row.
  // Round B3 planned it as qualifying and repaired it. It has nothing to repair.
  const resolveIpd = async () => [
    { audit_id: SOURCE_AUDIT_ID, encounter_id: 'E-ALREADY', ip_uid: 'E-ALREADY', current_engine_version: SOURCE_VERSION, already_at_version: true },
    { audit_id: 'bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb', encounter_id: 'E-OLD', ip_uid: 'E-OLD', current_engine_version: SOURCE_VERSION, already_at_version: false },
  ];
  const plan = await reauditPlan({ db, principal: 'operator', resolveIpd }, {
    engine: 'ipd_episode', engine_version: PLAN_VERSION,
    filter: { audit_ids: [SOURCE_AUDIT_ID, 'bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb'] }, limit: 5,
  } as never);
  assert.equal(plan.cases.length, 2);
  assert.equal(plan.expected_writes, 1, 'only the episode that is not already at the target');
  const already = plan.cases.find((c) => c.case_key === SOURCE_AUDIT_ID)!;
  assert.equal(already.qualifies, false);
  assert.match(already.reason, /already_at_version/);
  await db.close();
});

test('§17.6 decision 74: OPD qualifies per uid, and ANY row at the target disqualifies', async () => {
  const db = await freshDb();
  const searchOpd = async () => [
    { uid: 'note-1', engine_version: 'opd-note-audit/0.81.21' },
    { uid: 'note-2', engine_version: 'opd-note-audit/0.81.21' },
  ];
  // note-1's uid carries a 0.82 row the filter did not return — the row-level check missed it.
  const resolveOpd = async () => new Map([
    ['note-1', { current_engine_version: 'opd-note-audit/0.81.21', already_at_version: true }],
    ['note-2', { current_engine_version: 'opd-note-audit/0.81.21', already_at_version: false }],
  ]);
  const plan = await reauditPlan({ db, principal: 'operator', searchOpd, resolveOpd }, {
    engine: 'opd_note_audit', engine_version: 'opd-note-audit/0.82', filter: {}, limit: 10,
  } as never);
  assert.equal(plan.expected_writes, 1);
  assert.match(plan.cases.find((c) => c.case_key === 'note-1')!.reason, /already_at_version/);
  assert.equal(plan.cases.find((c) => c.case_key === 'note-2')!.qualifies, true);
  await db.close();
});

test('§17.6 decision 74: a case that becomes current between plan and execute is skipped, not written', async () => {
  const db = await freshDb();
  let already = false;
  const resolveIpd = async () => [{
    audit_id: SOURCE_AUDIT_ID, encounter_id: FIXTURE_ENCOUNTER, ip_uid: FIXTURE_ENCOUNTER,
    current_engine_version: SOURCE_VERSION, already_at_version: already,
  }];
  const plan = await reauditPlan({ db, principal: 'operator', resolveIpd }, {
    engine: 'ipd_episode', engine_version: PLAN_VERSION, filter: { audit_ids: [SOURCE_AUDIT_ID] }, limit: 5,
  } as never);
  // A nightly sweep brings the episode to 0.2 in between. PLAN_STALE watches the rows the plan
  // NAMED; this second check watches the question the plan ASKED.
  already = true;
  await assert.rejects(
    () => reauditExecute({ db, principal: 'operator', resolveIpd }, { plan_id: plan.plan_id, idempotency_key: 'raced' }),
    (e: { code?: string; message?: string }) => e.code === 'INVALID_INPUT' && /already at/.test(String(e.message)),
  );
  await db.close();
});

test('§17.6 decision 74: the live statements resolve and qualify against injected rows', async () => {
  const refs = await resolveEpisodesForRepair([SOURCE_AUDIT_ID], PLAN_VERSION, async () => [{
    audit_id: SOURCE_AUDIT_ID, encounter_id: 'E1', ip_uid: 'E1',
    current_engine_version: SOURCE_VERSION, is_current: true, already_at_version: true,
  }]);
  assert.deepEqual(refs, [{
    audit_id: SOURCE_AUDIT_ID, encounter_id: 'E1', ip_uid: 'E1',
    current_engine_version: SOURCE_VERSION, already_at_version: true,
  }]);
  const opd = await resolveOpdForRepair(['u1'], 'v2', async () => [
    { uid: 'u1', current_engine_version: 'v1', already_at_version: false },
    // Two rows for one uid: the OR is what makes "ANY current row at the target" true.
    { uid: 'u1', current_engine_version: 'v2', already_at_version: true },
  ]);
  assert.equal(opd.get('u1')!.already_at_version, true);
});

// ─────────────────────────────────────────────────────────────────────────────────────
// DECISION 72 — a bigint arrives as a string, and a schema failure says so
// ─────────────────────────────────────────────────────────────────────────────────────

test('§17.6 decision 72: retrieval_compare survives bigint-as-string rows', async () => {
  // ⚠️ EXACTLY WHAT POSTGRES RETURNS. `ROW_NUMBER()` is bigint and the driver hands back a string;
  // the live tool failed its own output schema with "Expected number, received string".
  const read = async () => [
    { id: '101', rank: '1' },
    { id: '102', rank: '2' },
    { id: 103, rank: 3 },
  ];
  const out = await retrievalCompare({
    queries: ['acute abdomen'], k: 3,
    a: { bm25: true, embedding: false },
    b: { bm25: true, embedding: false },
  }, { embed: async () => [0], read: read as never });
  assert.deepEqual(out.per_query[0].ids_a, [101, 102, 103], 'numbers, not strings');
  for (const id of out.per_query[0].ids_a as number[]) assert.equal(typeof id, 'number');
  assert.equal(typeof out.totals.ms_a, 'number');
  // And it validates against its OWN schema, which is the failure this fixes.
  const { RETRIEVAL_COMPARE_SCHEMAS } = await import('../tools/retrieval-compare');
  const parsed = RETRIEVAL_COMPARE_SCHEMAS.retrieval_compare.output.safeParse(out);
  assert.equal(parsed.success, true, JSON.stringify(parsed.success ? null : parsed.error.issues.slice(0, 3)));
});

test('§17.6 decision 72: a row that will not parse is dropped, never carried as NaN', () => {
  assert.deepEqual(coerceRankRows([{ id: '7', rank: '1' }, { id: 'x', rank: '2' }, { id: '9', rank: null }]),
    [{ id: 7, rank: 1 }]);
  // NaN sorts unpredictably; a fusion carrying one would reorder silently rather than fail.
  assert.deepEqual(coerceRankRows([]), []);
});

test('§17.6 decision 72: coverage_report survives bigint-as-string counts', async () => {
  const read = async (source: string) => (source === 'ipd_episode_audits'
    ? [{ day: '2026-09-05', engine_version: 'v2', audited: '6' }]
    : [{ day: '2026-09-05', engine_version: 'v2', reason: 'no_extraction', n: '3' }]);
  const out = await coverageReport({ engine: 'ipd_episode', days: 7 }, { read });
  assert.equal(out.by_day[0].audited, 6);
  assert.equal(out.by_day[0].skipped, 3);
  assert.equal(out.by_day[0].qualifying, 6);
  const { COVERAGE_SCHEMAS } = await import('../tools/coverage');
  assert.equal(COVERAGE_SCHEMAS.coverage_report.output.safeParse(out).success, true);
});

test('§17.6 decision 72: drift_report survives bigint-as-string counts and numeric averages', async () => {
  const read = async (source: string) => (source === 'ipd_episode_checkpoints'
    ? [{ week: '2026-W36', engine_version: 'v2', checkpoints: '184', checkpoints_offtopic: '164' }]
    : [{ week: '2026-W36', engine_version: 'v2', n: '60', avg_n_findings: '65.63', p50_n_findings: '63', p90_n_findings: '84', n_scored: '58', avg_score: '97.24', p50_score: '97', band_none: '2', band_no_divergence: '50', band_divergence_found: '8' }]);
  const out = await driftReport({ engine: 'ipd_episode', weeks: 4 }, { read });
  assert.equal(out.by_week[0].n, 60);
  assert.equal(out.by_week[0].n_findings.avg, 65.63);
  assert.equal(out.by_week[0].retrieval!.offtopic_pct, 89);
  const { DRIFT_SCHEMAS } = await import('../tools/drift');
  assert.equal(DRIFT_SCHEMAS.drift_report.output.safeParse(out).success, true);
});

test('§17.6 decision 72: an output that fails its schema is OUTPUT_INVALID with the field path', async () => {
  const db = await freshDb();
  // A tool whose handler is fine and whose OUTPUT is wrong. `system_capabilities` is the smallest
  // one to break: a run_id that is not a uuid fails `run_status`'s output on a named field.
  await assert.rejects(
    () => callTool(deps(db, 'research'), 'run_status', { run_id: '00000000-0000-4000-8000-000000000000' }),
    (e: { code?: string }) => e.code === 'NOT_FOUND', 'a missing run is NOT_FOUND, not an output failure',
  );
  // The real assertion: the error code exists, is not STORE_UNAVAILABLE, and names the path.
  const err = new LabError('OUTPUT_INVALID', "'retrieval_compare' produced an output that does not match its own schema — per_query.0.ids_a.0: Expected number, received string");
  assert.equal(err.code, 'OUTPUT_INVALID');
  assert.notEqual(err.code, 'STORE_UNAVAILABLE' as string);
  assert.match(err.message, /per_query\.0\.ids_a\.0/);
  // ⚠️ AND THE SERVICE RAISES IT, not the store code. STORE_UNAVAILABLE would have sent an operator
  // to look at Neon, which was never the problem.
  const { readFileSync } = await import('node:fs');
  const svc = readFileSync(new URL('../service.ts', import.meta.url).pathname, 'utf8');
  const at = svc.indexOf('produced an output that does not match its own schema');
  assert.ok(at > 0, 'the message lives in the dispatcher');
  assert.ok(svc.slice(at - 600, at).includes("LabError('OUTPUT_INVALID'"), 'and it is raised as OUTPUT_INVALID');
  await db.close();
});

test('§17.6: a stored plan object still carries no encounter id', async () => {
  const db = await freshDb();
  // Decision 50 keeps the live db13 key out of a research case key; decision 75 needs it at RUN
  // time. The split is: the PLAN holds audit row ids, the ITEM payload holds the resolved
  // encounter. This asserts the first half, which is the half that gets stored and shared.
  const resolveIpd = async () => [{
    audit_id: SOURCE_AUDIT_ID, encounter_id: 'ENC-REAL-0001', ip_uid: 'ENC-REAL-0001',
    current_engine_version: SOURCE_VERSION, already_at_version: false,
  }];
  const plan = await reauditPlan({ db, principal: 'operator', resolveIpd }, {
    engine: 'ipd_episode', engine_version: PLAN_VERSION, filter: { audit_ids: [SOURCE_AUDIT_ID] }, limit: 5,
  } as never);
  const stored = await putObject(db, 'operator', 'report', { probe: plan }, 'deidentified', null);
  assert.ok(!JSON.stringify(plan).includes('ENC-REAL-0001'),
    'the plan names audit row ids; the encounter is resolved at execute time and lives on the item');
  assert.ok(stored.object.id);
  await db.close();
});

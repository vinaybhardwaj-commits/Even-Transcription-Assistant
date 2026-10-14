/**
 * LAB-MCP-V2 §17.11 round D3 — the `dataset_freeze` run and decision 147's phase deadlines
 * (items 1 and 2; decisions 138, 139, 144, 147; and 87, 99, 109 throughout).
 *
 * ⚠️ THE LIFECYCLE IS DRIVEN THROUGH `tick`, NOT THROUGH THE ADAPTER. Decision 144 is a claim about
 * the QUEUE — that `dataset_create` returns before any production read, that the tick routes a
 * `dataset_freeze` item to a map that is not `ALL_ADAPTERS`, that the source key is erased when the
 * item settles, and that the LAST item to settle assembles the dataset. Calling the adapter
 * directly would prove none of those. So every test below submits through `callTool` and turns the
 * crank.
 *
 * ⚠️ AND THE FREEZE ITSELF IS INJECTED. The real `freezeIpdDischargeDocument` reads production Neon
 * and db13, neither of which exists here; `d2c-ipd-discharge-replay.test.ts` already exercises it
 * end to end against PGlite. What this file is for is the machinery AROUND it, so the freeze is a
 * stub whose outcomes — a case, a refusal, a hang — are the three things the machinery has to
 * handle. Decision 147's deadlines are exercised against the REAL recording pass, below.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { freshDb } from './helpers';
import { DATASET_FREEZE_OPERATION, LabError, IDENTIFYING_PRINCIPALS_ENV, datasetBodySchema } from '../contracts';
import { getObject, getRun, itemsOf } from '../store';
import { tick } from '../worker';
import { callTool } from '../service';
import { identifyingKeys } from '../sources/requests';
import {
  FREEZE_ARM_HASH, exclusionKey, freezeItemKey, makeDatasetFreezeAdapter,
} from '../adapters/dataset-freeze';
import {
  RECORDING_PASS_DEADLINE_MS, RETRIEVAL_DEADLINE_MS, TRACE_READ_DEADLINE_MS,
  recordIpdDischargeSteps, withPhaseDeadline,
} from '../sources/ipd-discharge';
import { SOURCE_TIMEOUT_MS } from '../sources/read';
import type { Db } from '../db';
import type { Adapter } from '../adapters/types';

const SALT = 'd3-freeze-salt';
const DOC_A = 'DOCX-D3-A';
const DOC_B = 'DOCX-D3-B';
const DOC_C = 'DOCX-D3-C';

const deps = (db: Db, principal: 'research' | 'operator' = 'operator') =>
  ({ db, principal, protocolVersion: 'p', sdkVersion: 's' }) as never;

function withEnv<T>(vars: Record<string, string | undefined>, fn: () => Promise<T>): Promise<T> {
  const saved: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(vars)) { saved[k] = process.env[k]; if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  return (async () => { try { return await fn(); } finally { for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; } } })();
}

/**
 * A frozen case in the shape the real freeze returns, with no identifying key in the body — and no
 * document id ANYWHERE in it, including in the member_key, which is a salted hash in production.
 */
const memberKeyFor = (doc: string) => createHash('sha256').update(`${SALT}|${doc}`).digest('hex');
/** `sources/ipd-discharge.ts`'s own formula, so the "no document id in the object" check is real. */
const caseKeyFor = (doc: string) => `ipddoc:${createHash('sha256').update(`${SALT}|${doc}`).digest('hex').slice(0, 32)}`;
const frozenFor = (doc: string) => ({
  case_key: caseKeyFor(doc),
  member_key: memberKeyFor(doc),
  frozen: {
    engine: 'ipd_discharge',
    extracted: { docType: 'discharge_summary', diagnosis: 'Community-acquired pneumonia' },
    extraction_version: 'doc-extract/2',
    envelope: { speciality: 'General Medicine', dischargeType: 'routine', losDays: 4, dischargeDate: '2026-09-01' },
    billing: { netTotal: 41000, lineCount: 12 },
    steps: { ['a'.repeat(64)]: { stage: 'doc_audit_analyze', request_hash: 'a'.repeat(64), text: '{}', served: { model: 'm', provider: 'p' } } },
    retrieval: {},
    text_model: 'text-model-x',
  },
  source_versions: { origin: 'discharge_extracted_cases + db13', recorded_steps: 1, extraction_version: 'doc-extract/2' },
});

/** The three outcomes the machinery must handle, keyed by document. */
function freezeStub(seen: string[], outcomes: Record<string, 'ok' | LabError>) {
  return async (documentId: string) => {
    seen.push(documentId);
    const o = outcomes[documentId] ?? 'ok';
    if (o !== 'ok') throw o;
    return frozenFor(documentId);
  };
}

function freezeAdaptersWith(db: Db, freeze: ReturnType<typeof freezeStub>): Record<string, Adapter> {
  return { ipd_discharge: makeDatasetFreezeAdapter({ db, freeze }) };
}

/** Turn the crank until nothing is claimable. The live transport must never be reached. */
async function drain(db: Db, adapters: Record<string, Adapter>): Promise<number> {
  let claimed = 0;
  for (let pass = 0; pass < 20; pass += 1) {
    const r = await tick({
      db, adapters, maxItems: 4,
      transport: (async () => { throw new LabError('MODEL_UNSUPPORTED', 'a freeze must never reach a provider'); }) as never,
    });
    claimed += r.claimed;
    if (r.claimed === 0) break;
  }
  return claimed;
}

// ═════════════════════════════════════════════════════════════════════════════════════
// Decision 144 — the run
// ═════════════════════════════════════════════════════════════════════════════════════

test('§17.11 item 2: dataset_create ipd_discharge returns a freeze run before any read', async () => {
  const db = await freshDb();
  await withEnv({ [IDENTIFYING_PRINCIPALS_ENV]: 'operator', LAB_V2_MEMBER_SALT: SALT }, async () => {
    const out = await callTool(deps(db), 'dataset_create', {
      engine: 'ipd_discharge', cohort: { case_keys: [DOC_A, DOC_B, DOC_C] }, idempotency_key: 'f-1',
    }) as { freeze_run_id: string; state: string; requested: number; deduplicated: boolean; note: string };

    assert.equal(out.state, 'freezing');
    assert.equal(out.requested, 3);
    assert.equal(out.deduplicated, false);
    assert.match(out.note, /the last item to settle assembles the dataset/);

    const run = await getRun(db, out.freeze_run_id);
    assert.equal(run!.operation, DATASET_FREEZE_OPERATION);
    assert.equal(run!.state, 'queued', 'nothing has been read yet');

    /**
     * ⚠️ ONE ITEM PER KEY, THE KEY IN THE PAYLOAD AND NOWHERE ELSE. `items.case_key` is read back by
     * every observation tool, so it is a content hash; the documentId lives in the payload, which
     * is the run's private work, and is erased when the item settles.
     */
    const items = await itemsOf(db, run!.id);
    assert.equal(items.length, 3);
    for (const it of items) {
      assert.equal(it.arm_hash, FREEZE_ARM_HASH);
      const p = it.payload as { engine: string; source_key: string; source_key_hash: string };
      assert.equal(p.engine, 'ipd_discharge');
      assert.equal(it.case_key, freezeItemKey('ipd_discharge', p.source_key));
      assert.equal(it.case_key, p.source_key_hash);
      assert.ok(!it.case_key.includes(p.source_key), 'the key is hashed into case_key, not copied');
      assert.deepEqual(identifyingKeys({ case_key: it.case_key }), []);
    }
    assert.deepEqual(items.map((i) => (i.payload as { source_key: string }).source_key).sort(), [DOC_A, DOC_B, DOC_C]);

    // §5.2's own deduplication, unchanged: the same idempotency key returns the same run.
    const again = await callTool(deps(db), 'dataset_create', {
      engine: 'ipd_discharge', cohort: { case_keys: [DOC_A, DOC_B, DOC_C] }, idempotency_key: 'f-1',
    }) as { freeze_run_id: string; deduplicated: boolean };
    assert.equal(again.freeze_run_id, out.freeze_run_id);
    assert.equal(again.deduplicated, true);
  });
  await db.close();
});

test('§17.11 item 2: the run settles over ticks and the LAST item assembles the dataset', async () => {
  const db = await freshDb();
  const seen: string[] = [];
  await withEnv({ [IDENTIFYING_PRINCIPALS_ENV]: 'operator', LAB_V2_MEMBER_SALT: SALT }, async () => {
    const out = await callTool(deps(db), 'dataset_create', {
      engine: 'ipd_discharge', cohort: { case_keys: [DOC_A, DOC_B, DOC_C] }, idempotency_key: 'f-2',
    }) as { freeze_run_id: string };

    // One item at a time, so "the last to settle" is a real event rather than an artefact of a
    // single pass: three ticks, and the dataset appears on exactly one of them.
    const lifecycle: { pass: number; states: Record<string, number>; run_state: string }[] = [];
    const adapters = freezeAdaptersWith(db, freezeStub(seen, {}));
    for (let pass = 1; pass <= 3; pass += 1) {
      await tick({ db, adapters, maxItems: 1, transport: (async () => { throw new Error('never'); }) as never });
      const items = await itemsOf(db, out.freeze_run_id);
      const states: Record<string, number> = {};
      for (const i of items) states[i.state] = (states[i.state] ?? 0) + 1;
      lifecycle.push({ pass, states, run_state: (await getRun(db, out.freeze_run_id))!.state });
    }
    console.log('D3 FREEZE LIFECYCLE', JSON.stringify(lifecycle));
    assert.deepEqual(lifecycle[0].states, { queued: 2, succeeded: 1 });
    assert.equal(lifecycle[0].run_state, 'queued');
    assert.deepEqual(lifecycle[1].states, { queued: 1, succeeded: 2 });
    assert.deepEqual(lifecycle[2].states, { succeeded: 3 });
    assert.equal(lifecycle[2].run_state, 'succeeded');
    assert.deepEqual([...seen].sort(), [DOC_A, DOC_B, DOC_C]);

    const items = await itemsOf(db, out.freeze_run_id);
    // ⚠️ THE SOURCE KEY IS GONE FROM EVERY SETTLED ITEM.
    for (const it of items) {
      const p = it.payload as { source_key?: string; source_key_hash: string };
      assert.equal(p.source_key, undefined, 'the source key survived the settle');
      assert.ok(p.source_key_hash, 'and the hash did not');
    }

    // Exactly one item carries the assembly, and it is the last one to settle.
    const withDataset = items.filter((i) => (i.result as { summary?: { dataset_id?: string } })?.summary?.dataset_id);
    assert.equal(withDataset.length, 1, 'the dataset is assembled once, by one item');
    const summary = (withDataset[0].result as { summary: Record<string, unknown> }).summary;
    assert.equal(summary.frozen, 3);
    assert.equal(summary.excluded, 0);
    assert.equal(summary.requested, 3);

    const dataset = await getObject(db, String(summary.dataset_id));
    assert.ok(dataset, 'the dataset object exists');
    assert.equal(dataset!.hash, summary.hash);
    const body = datasetBodySchema.parse(dataset!.body);
    assert.equal(body.engine, 'ipd_discharge');
    assert.equal(body.replay_exactness, 'frozen');
    assert.equal(body.cases.length, 3);
    assert.deepEqual(body.cases.map((c) => c.case_key).sort(), [DOC_A, DOC_B, DOC_C].map(caseKeyFor).sort());
    // Decision 99, on what was actually stored: no identifying key, and no documentId anywhere.
    assert.deepEqual(identifyingKeys(body.cases.map((c) => c.frozen)), []);
    for (const d of [DOC_A, DOC_B, DOC_C]) {
      const text = JSON.stringify(body);
      assert.ok(!text.includes(d) && !text.toLowerCase().includes(d.toLowerCase()),
        `${d} reached the dataset object`);
    }
    assert.equal((body.source_versions as { freeze_run_id: string }).freeze_run_id, out.freeze_run_id);

    // `run_result` is how a client finds it, and its shape is unchanged.
    const res = await callTool(deps(db), 'run_result', { run_id: out.freeze_run_id, limit: 20, offset: 0 }) as {
      total: number; items: { summary: Record<string, unknown> | null; artifact: string | null; state: string }[];
    };
    assert.equal(res.total, 3);
    assert.equal(res.items.filter((i) => i.summary?.dataset_id).length, 1);
    assert.ok(res.items.every((i) => i.artifact), 'every frozen case is addressable as an artifact');

    // `dataset_preview` on the assembled id, unchanged.
    const preview = await callTool(deps(db), 'dataset_preview', { dataset_id: String(summary.dataset_id) }) as {
      engine: string; case_keys: string[]; replay_exactness: string;
    };
    assert.equal(preview.engine, 'ipd_discharge');
    assert.equal(preview.case_keys.length, 3);
    assert.equal(preview.replay_exactness, 'frozen');
  });
  await db.close();
});

test('§17.11 item 2: the tick routes a dataset_freeze item off runs.operation, not ALL_ADAPTERS', async () => {
  const db = await freshDb();
  await withEnv({ [IDENTIFYING_PRINCIPALS_ENV]: 'operator', LAB_V2_MEMBER_SALT: SALT }, async () => {
    const out = await callTool(deps(db), 'dataset_create', {
      engine: 'ipd_discharge', body: { documentId: DOC_A }, idempotency_key: 'f-route',
    }) as { freeze_run_id: string };

    /**
     * ⚠️ NO ADAPTER IS INJECTED. The tick has to find the freeze map on its own, off
     * `runs.operation` — the same mechanism decision 67 uses for the writing adapters — and the
     * proof is WHICH failure comes back. `ALL_ADAPTERS().ipd_discharge` is the ENGINE adapter: it
     * would report `bad_frozen_inputs` on a payload with no frozen case. The freeze adapter reads
     * the real production tables, which do not exist here, so it reports the read.
     */
    await tick({
      db, maxItems: 1,
      transport: (async () => { throw new Error('a freeze must never reach a provider'); }) as never,
    });
    const [item] = await itemsOf(db, out.freeze_run_id);
    assert.equal(item.state, 'failed');
    const summary = (item.result as { summary: { engine: string; reason: string } }).summary;
    assert.equal(summary.engine, 'ipd_discharge');
    assert.match(summary.reason, /^SOURCE_UNAVAILABLE/, 'the freeze adapter ran and could not read production');
    assert.ok(!/bad_frozen_inputs/.test(JSON.stringify(item.result)), 'the ENGINE adapter never saw this item');
    assert.ok(!summary.reason.includes(DOC_A), 'and the refusal does not echo the identifier');
    // The key is erased even on this path.
    assert.equal((item.payload as { source_key?: string }).source_key, undefined);

    // `run_status` on a freeze run: unchanged in shape, and it reports the queue honestly.
    const status = await callTool(deps(db), 'run_status', { run_id: out.freeze_run_id }) as {
      run_id: string; state: string; items_by_state: Record<string, number>;
      execution_status: Record<string, number>; reserved_microusd: number; spent_microusd: number;
    };
    assert.equal(status.run_id, out.freeze_run_id);
    assert.equal(status.state, 'failed');
    assert.deepEqual(status.items_by_state, { failed: 1 });
    assert.deepEqual(status.execution_status, { failed: 1 });
    assert.equal(status.spent_microusd, 0, 'a freeze prices no stage and spends nothing');
    assert.equal(status.reserved_microusd, 0);
  });
  await db.close();
});

test('§17.11 items 1 and 2: a case that cannot be frozen is an EXCLUSION naming the cause', async () => {
  const db = await freshDb();
  await withEnv({ [IDENTIFYING_PRINCIPALS_ENV]: 'operator', LAB_V2_MEMBER_SALT: SALT }, async () => {
    const out = await callTool(deps(db), 'dataset_create', {
      engine: 'ipd_discharge', cohort: { case_keys: [DOC_A, DOC_B] }, idempotency_key: 'f-3',
    }) as { freeze_run_id: string };

    /**
     * ⚠️ THE EXCLUSION TEXT IS DECISION 147's, VERBATIM. This is the shape the two documents of
     * decision 139 will produce: a phase name and the milliseconds it took to give up, where before
     * there was a hang and no error at all.
     */
    const overDeadline = new LabError('SOURCE_UNAVAILABLE',
      "the ipd_discharge freeze phase 'recording_pass' exceeded its 240000 ms deadline (elapsed 240001 ms)");
    const adapters = freezeAdaptersWith(db, freezeStub([], { [DOC_B]: overDeadline }));
    await drain(db, adapters);

    const items = await itemsOf(db, out.freeze_run_id);
    assert.deepEqual(items.map((i) => i.state).sort(), ['failed', 'succeeded']);
    assert.equal((await getRun(db, out.freeze_run_id))!.state, 'partial');
    // Even the failed item erased its key.
    for (const it of items) assert.equal((it.payload as { source_key?: string }).source_key, undefined);

    const withDataset = items.filter((i) => (i.result as { summary?: { dataset_id?: string } })?.summary?.dataset_id);
    assert.equal(withDataset.length, 1, 'a failed sibling does not stop the assembly');
    const summary = (withDataset[0].result as { summary: Record<string, unknown> }).summary;
    assert.equal(summary.frozen, 1);
    assert.equal(summary.excluded, 1);

    const body = datasetBodySchema.parse((await getObject(db, String(summary.dataset_id)))!.body);
    const reasons = (body.source_versions as { exclusion_reasons: { case_key: string; reason: string }[] }).exclusion_reasons;
    assert.equal(reasons.length, 1);
    assert.match(reasons[0].reason, /recording_pass/);
    assert.match(reasons[0].reason, /240001 ms/);
    // ⚠️ AND THE EXCLUSION IS KEYED BY A HASH, exactly as sliceDDataset's own exclusion path is.
    assert.equal(reasons[0].case_key, exclusionKey('ipd_discharge', DOC_B));
    assert.ok(!JSON.stringify(body).includes(DOC_B), 'the excluded document id is not stored');
    assert.deepEqual(body.exclusions, [exclusionKey('ipd_discharge', DOC_B)]);
  });
  await db.close();
});

test('§17.11 item 2: every case failing leaves no dataset and says so on the items', async () => {
  const db = await freshDb();
  await withEnv({ [IDENTIFYING_PRINCIPALS_ENV]: 'operator', LAB_V2_MEMBER_SALT: SALT }, async () => {
    const out = await callTool(deps(db), 'dataset_create', {
      engine: 'ipd_discharge', body: { documentId: DOC_A }, idempotency_key: 'f-4',
    }) as { freeze_run_id: string };
    const fault = new LabError('SOURCE_UNAVAILABLE', 'no stored extract at doc-extract/2 for that document');
    await drain(db, freezeAdaptersWith(db, freezeStub([], { [DOC_A]: fault })));

    const items = await itemsOf(db, out.freeze_run_id);
    assert.equal(items[0].state, 'failed');
    assert.equal((await getRun(db, out.freeze_run_id))!.state, 'failed');
    assert.equal((items[0].result as { summary: { dataset_id?: string } }).summary.dataset_id, undefined);
    assert.match(String((items[0].result as { summary: { reason: string } }).summary.reason), /no stored extract/);
    const objects = await db.query<{ c: string }>(`SELECT count(*)::text AS c FROM lab_v2.objects WHERE kind = 'dataset'`);
    assert.equal(objects[0].c, '0', 'a dataset of zero cases is not a research object');
  });
  await db.close();
});

test('§17.11 item 2: a re-claimed item whose key was erased fails by NAME, never silently', async () => {
  const db = await freshDb();
  await withEnv({ [IDENTIFYING_PRINCIPALS_ENV]: 'operator', LAB_V2_MEMBER_SALT: SALT }, async () => {
    const out = await callTool(deps(db), 'dataset_create', {
      engine: 'ipd_discharge', body: { documentId: DOC_A }, idempotency_key: 'f-5',
    }) as { freeze_run_id: string };
    const [item] = await itemsOf(db, out.freeze_run_id);
    // Erase it up front, then run: this is the shape of a `run_retry` on a settled freeze run.
    await db.query(`UPDATE lab_v2.items SET payload = payload - 'source_key' WHERE id = $1`, [item.id]);
    await drain(db, freezeAdaptersWith(db, freezeStub([], {})));
    const [after] = await itemsOf(db, out.freeze_run_id);
    assert.equal(after.state, 'failed');
    assert.match(String((after.result as { summary: { reason: string } }).summary.reason), /already settled once/);
    assert.match(String((after.result as { summary: { reason: string } }).summary.reason), /Re-freeze the document through dataset_create/);
  });
  await db.close();
});

test('§17.11 item 1: the freeze adapter emits a phase event per phase', async () => {
  const db = await freshDb();
  await withEnv({ [IDENTIFYING_PRINCIPALS_ENV]: 'operator', LAB_V2_MEMBER_SALT: SALT }, async () => {
    const out = await callTool(deps(db), 'dataset_create', {
      engine: 'ipd_discharge', body: { documentId: DOC_A }, idempotency_key: 'f-6',
    }) as { freeze_run_id: string };
    // A freeze that reports two phases of its own, the way the real recording pass does.
    const freeze = async (documentId: string, d?: { onPhase?: (p: string, s: string, ms: number) => void }) => {
      d?.onPhase?.('trace_read', 'started', 0);
      d?.onPhase?.('trace_read', 'done', 3);
      d?.onPhase?.('recording_pass', 'started', 0);
      d?.onPhase?.('recording_pass', 'done', 11);
      return frozenFor(documentId);
    };
    await drain(db, { ipd_discharge: makeDatasetFreezeAdapter({ db, freeze: freeze as never }) });
    const [item] = await itemsOf(db, out.freeze_run_id);
    const events = await db.query<{ kind: string; body: Record<string, unknown> }>(
      `SELECT kind, body FROM lab_v2.events WHERE aggregate = $1 ORDER BY id`, [item.id]);
    const phases = events.filter((e) => e.kind === 'freeze_phase').map((e) => `${e.body.phase}:${e.body.state}`);
    assert.deepEqual(phases, [
      'freeze:started', 'trace_read:started', 'trace_read:done',
      'recording_pass:started', 'recording_pass:done', 'freeze:frozen',
    ]);
    assert.ok(events.some((e) => e.kind === 'dataset_assembled'), 'the assembly emits its own event');
  });
  await db.close();
});

// ═════════════════════════════════════════════════════════════════════════════════════
// Decision 147 — the deadlines themselves, against the REAL recording pass
// ═════════════════════════════════════════════════════════════════════════════════════

test('§17.11 decision 147: the three deadlines are 15 s, 30 s and 240 s, and the first is boundedRead’s', () => {
  assert.equal(TRACE_READ_DEADLINE_MS, 15_000);
  // ⚠️ NOT MERELY EQUAL — THE SAME CONSTANT. Decision 147 names boundedRead for this phase; a copied
  // 15_000 could drift from decision 31's number without either side noticing.
  assert.equal(TRACE_READ_DEADLINE_MS, SOURCE_TIMEOUT_MS);
  assert.equal(RETRIEVAL_DEADLINE_MS, 30_000);
  assert.equal(RECORDING_PASS_DEADLINE_MS, 240_000);
  // 240 s is above LEASE_MS (120 s) and is covered by the heartbeat's renewals, not by one lease.
  assert.ok(RECORDING_PASS_DEADLINE_MS > 120_000);
});

test('§17.11 decision 147: a phase over its deadline is SOURCE_UNAVAILABLE naming the phase and the ms', async () => {
  const reported: string[] = [];
  await assert.rejects(
    () => withPhaseDeadline('recording_pass', 20, () => new Promise((r) => { setTimeout(r, 5_000).unref?.(); }),
      (p, s, ms) => reported.push(`${p}:${s}:${ms >= 0}`)),
    (e: LabError) => {
      assert.equal(e.code, 'SOURCE_UNAVAILABLE');
      assert.match(e.message, /freeze phase 'recording_pass' exceeded its 20 ms deadline \(elapsed \d+ ms\)/);
      return true;
    });
  assert.deepEqual(reported, ['recording_pass:started:true', 'recording_pass:over_deadline:true']);
  // A phase that finishes reports `done` and returns its value.
  const ok = await withPhaseDeadline('trace_read', 5_000, async () => 42, (p, s) => reported.push(`${p}:${s}`));
  assert.equal(ok, 42);
  assert.ok(reported.includes('trace_read:done'));
});

test('§17.11 decision 147: the trace read’s deadline fails the recording pass by name', async () => {
  await assert.rejects(
    () => recordIpdDischargeSteps({
      traceId: 'TR-HANGS',
      extracted: {} as never,
      run: () => new Promise(() => { /* the hang decision 139 could not measure */ }),
      deadlines: { traceReadMs: 25 },
    }),
    (e: LabError) => {
      assert.equal(e.code, 'SOURCE_UNAVAILABLE');
      assert.match(e.message, /freeze phase 'trace_read' exceeded its 25 ms deadline/);
      assert.match(e.message, /elapsed \d+ ms/);
      return true;
    });
});

test('§17.11 decision 147: a retrieval over its deadline is HELD and re-thrown, not swallowed', async () => {
  /**
   * ⚠️ THIS IS THE CASE THE HELD ERROR EXISTS FOR. `analyzeCase` catches everything at five sites
   * (`doc-audit.ts:718`, `:610`, `:625`, `:581`, `:316`), so a deadline thrown inside the retrieve
   * edge would be swallowed into an empty hit list and the pass would produce a case whose prompts
   * were built WITHOUT the corpus — a frozen case that looks fine and replays to nothing.
   */
  const rows = [
    { stage: 'doc_audit_analyze', seq: 1, content: '{"findings":[],"suggestions":[]}', model: 'm', provider: 'p' },
  ];
  await assert.rejects(
    () => recordIpdDischargeSteps({
      traceId: 'TR-SLOW-RETRIEVAL',
      extracted: {
        docType: 'discharge_summary', diagnosis: 'Community-acquired pneumonia',
        medications: [], investigations: [], treatments: [],
      } as never,
      run: async () => rows,
      retrieve: () => new Promise(() => { /* never resolves */ }),
      deadlines: { retrievalMs: 25 },
    }),
    (e: LabError) => {
      assert.equal(e.code, 'SOURCE_UNAVAILABLE');
      assert.match(e.message, /freeze phase 'retrieval' exceeded its 25 ms deadline/);
      return true;
    });
});

/**
 * LAB-MCP-V2 §17.9 round D2a — readmission exact replay from production's stored replies
 * (decisions 114, 115, 116; the ruling 120 that moved item 6's production read to V's hand).
 *
 * ⚠️ WHAT THIS FILE PROVES, AND WHAT IT CANNOT.
 *
 * It proves the MECHANISM end to end on a real Postgres: that `READMISSION_TRACE_SQL` reads what
 * `lib/trace.ts` writes, that the freeze records one step per leg the lane actually fires, that a
 * shortfall is refused with both counts in the message, that a frozen case replays to production's
 * own verdict with the transport wired to explode, and that a moved input is `REPLAY_DIVERGED` with
 * the stage named.
 *
 * It cannot prove that production's audited findings really do carry every leg's `llm_response`
 * row. That claim is arithmetic off the code path (the D2 survey says so in as many words) and
 * ruling 120 moved its measurement to V's hand in the production Neon console, because
 * `trace_events` is a blocked relation in `audit_query`. THE BUILD DOES NOT WAIT ON IT and does not
 * need to: a shortfall is refused at `dataset_create` with the lane, the expected count and the
 * found count, so an unmeasured assumption becomes a named exclusion rather than a silent gap.
 *
 * ⚠️ DECISION 87 THROUGHOUT. `trace_events` and its parent `traces` are created from the DDL at
 * `app/api/admin/migrate-v7/route.ts:30-39` and `:12-24`, and every statement this round writes is
 * exercised against them once. The single omission from the parent is
 * `user_id REFERENCES user_profiles(id)`, which would drag a third production table in to hold a
 * column nothing in this platform reads.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { embedded, type Db } from '../db';
import { freshDb } from './helpers';
import { LabError } from '../contracts';
import { identifyingKeys } from '../sources/requests';
import { dependencyHash } from '../gateway';
import { ensureBudget, itemsOf, submitRun } from '../store';
import { tick } from '../worker';
import { callTool } from '../service';
import {
  READMISSION_TRACE_SQL, expectedLegStages, freezeReadmissionFinding,
} from '../sources/readmission';
import { makeReadmissionAdapter } from '../adapters/readmission';
import { runReconSequence } from '../../readmission/run';
import { parsePassClaims } from '../../readmission-prompts';
import type { Adapter, AdapterContext, AdapterOutcome } from '../adapters/types';

const SALT = 'd2a-test-salt';

/** A claims reply the engine's own `parsePassClaims` accepts, and production's own JSON shape. */
const CLAIMS = JSON.stringify({
  planned: { verdict: 'unplanned', evidence: [] },
  same_condition: { verdict: 'same', evidence: [] },
  avoidable: { verdict: 'avoidable', evidence: [], rationale: 'index care incomplete' },
});

/** `ThreeSourceInputs` as `assembleForRow` really returns it — de-identified, no name, no id. */
const ASSEMBLED = {
  inputs: {
    catalog: {
      items: [
        { id: 'e1', source: 'index_summary', side: 'index', text: 'Discharged on oral antibiotics; no repeat imaging before discharge.' },
        { id: 'e2', source: 'readmit_summary', side: 'readmit', text: 'Represented with worsening consolidation on the same side.' },
        { id: 'e3', source: 'lab', side: 'index', text: 'CRP 84 mg/L', at: '2026-07-31T06:00:00+05:30', analyte: 'crp', abnormal: true },
      ],
    },
    labProfile: 'has_late_labs', labTier: 'tier1',
    labSourceProvenance: {
      tier: 'tier1', structuredLabCount: 3, window: { from: '2026-07-18', to: '2026-08-03' },
      windowStartInferred: false, caseLabCount: 5, indexCase: 'store', readmitCase: 'store',
      extractionVersion: 'doc-extract/0.4',
    },
    indexSentenceCount: 12, readmitSentenceCount: 9,
  },
  indexAdmitAt: '2026-07-28T10:00:00+05:30',
  indexDischargeAt: '2026-08-01T10:00:00+05:30',
  identity: { names: ['Real Name'], uhids: ['UH-000001'] },
} as never;

// ─────────────────────────────────────────────────────────────────────────────────────
// The fixture: production's two tables, from their own DDL
// ─────────────────────────────────────────────────────────────────────────────────────

async function productionDb(): Promise<Db> {
  const db = await embedded();
  await db.exec(`CREATE TABLE readmission_findings (
    dedup_key text PRIMARY KEY, finding_class text, index_encounter_id text, readmit_encounter_id text,
    form_uid text, uhid text, lane text, gap_days int, index_department text, readmit_department text,
    index_doctor text, readmit_doctor text, index_discharge_at timestamptz, readmit_admit_at timestamptz,
    cm_note text, form_is_planned boolean, form_same_condition boolean,
    audit_status text, engine_version text, finding jsonb, model text, provider text,
    promoted_to_full boolean, trace_id text)`);
  await db.exec(`CREATE TABLE traces (
    id BIGSERIAL PRIMARY KEY, trace_id TEXT NOT NULL UNIQUE, feature TEXT NOT NULL, input JSONB,
    started_at TIMESTAMPTZ DEFAULT NOW(), finished_at TIMESTAMPTZ, total_ms INT,
    status TEXT DEFAULT 'running', error_message TEXT, meta JSONB)`);
  await db.exec(`CREATE TABLE trace_events (
    id BIGSERIAL PRIMARY KEY,
    trace_id TEXT NOT NULL REFERENCES traces(trace_id) ON DELETE CASCADE,
    seq INT NOT NULL, ts TIMESTAMPTZ DEFAULT NOW(), kind TEXT NOT NULL, stage TEXT,
    payload JSONB, latency_ms INT)`);
  return db;
}

/**
 * One audit's trace, in the shape the D2 survey's Part 1 measured: TWO rows per leg — one
 * `llm_request` carrying `payload.messages`/`temperature`/`max_tokens` (`lib/trace.ts:351-372`)
 * and one `llm_response` carrying `payload.content`/`model`/`provider` (`:682-686`) — all on one
 * `trace_id`, in `seq` order, plus the R4 narrative pair that shares the trace and is not a leg.
 */
async function seedTrace(
  db: Db, traceId: string, stages: readonly string[],
  o: { reply?: (stage: string) => string; narrative?: boolean; drop?: readonly string[] } = {},
) {
  const reply = o.reply ?? (() => CLAIMS);
  await db.query(`INSERT INTO traces (trace_id, feature, status) VALUES ($1, 'readmit_audit', 'ok')
                  ON CONFLICT (trace_id) DO NOTHING`, [traceId]);
  let seq = 0;
  const put = async (kind: string, stage: string, payload: unknown) => {
    seq += 1;
    await db.query(
      `INSERT INTO trace_events (trace_id, seq, kind, stage, payload) VALUES ($1, $2, $3, $4, $5::jsonb)`,
      [traceId, seq, kind, stage, JSON.stringify(payload)]);
  };
  for (const stage of stages) {
    if ((o.drop ?? []).includes(stage)) continue;
    await put('llm_request', stage, {
      messages: [{ role: 'system', content: 's' }, { role: 'user', content: 'u' }],
      temperature: 0.1, max_tokens: 3000, model: 'gemini-2.5-pro', provider: 'vertex',
    });
    await put('llm_response', stage, {
      content: reply(stage), model: 'gemini-2.5-pro', provider: 'vertex',
      finish_reason: 'stop', usage: { input_tokens: 1200, output_tokens: 400 },
    });
  }
  if (o.narrative !== false) {
    await put('llm_request', 'readmit_narrative', { messages: [], temperature: 0.2, max_tokens: 1500 });
    await put('llm_response', 'readmit_narrative', {
      content: 'A narrative paragraph about the index admission.', model: 'opus-4.6', provider: 'bedrock',
    });
  }
}

interface LaneCase {
  name: string;
  dedup_key: string;
  lane: string;
  finding_class: string;
  promoted_to_full: boolean;
  /** §17.9's leg-count table, by lane class. */
  legs: readonly string[];
}

/**
 * ⚠️ THE FOUR LANE CLASSES, AND "FOUR STEPS" IS NEVER THE ANSWER FOR ANY OF THEM. The IPD
 * equivalent asserts exactly 2 (`adapters/ipd-episode.ts:560-563`) and that literal does not
 * transfer: a readmission finding fires one, two or three legs, decided by `finding_class` and
 * `lane` and, for lane `other`, by whether the condition pass promoted it (`run.ts:444-495`).
 */
const LANES: LaneCase[] = [
  { name: 'out_of_network', dedup_key: 'OON-1', lane: 'out_of_network', finding_class: 'out_of_network', promoted_to_full: false, legs: ['readmit_oon'] },
  { name: 'other, not promoted', dedup_key: 'OTH-1', lane: 'other', finding_class: 'even_even', promoted_to_full: false, legs: ['readmit_condition'] },
  { name: 'other, promoted to full', dedup_key: 'OTH-2', lane: 'other', finding_class: 'even_even', promoted_to_full: true, legs: ['readmit_condition', 'readmit_recon_a', 'readmit_recon_b'] },
  { name: 'every other lane', dedup_key: 'TB-1', lane: 'tight_bounce', finding_class: 'even_even', promoted_to_full: false, legs: ['readmit_recon_a', 'readmit_recon_b'] },
];

/**
 * ⚠️ `same_condition: 'same'` IS WHAT PROMOTES LANE `other` (decision 14, `run.ts:473`), so the
 * promoted case's condition leg must claim it and the unpromoted one must not. The reply is the
 * engine's own input, not a knob on the fixture: the lane's leg count is a CONSEQUENCE of it.
 */
const CONDITION_DIFFERENT = JSON.stringify({
  planned: { verdict: 'unplanned', evidence: [] },
  same_condition: { verdict: 'different', evidence: [] },
  avoidable: { verdict: 'justified', evidence: [], rationale: 'a new unrelated diagnosis' },
});

async function seedLane(db: Db, c: LaneCase, o: { drop?: readonly string[]; audit_status?: string; trace_id?: string | null } = {}) {
  const traceId = o.trace_id === undefined ? `TR-${c.dedup_key}` : o.trace_id;
  const row: Record<string, unknown> = {
    dedup_key: c.dedup_key, finding_class: c.finding_class, index_encounter_id: 'IPX-1',
    readmit_encounter_id: c.finding_class === 'out_of_network' ? null : 'IPX-2',
    form_uid: 'F-1', uhid: 'UH-000001', lane: c.lane, gap_days: 4,
    index_department: 'General Medicine', readmit_department: 'General Medicine',
    index_doctor: 'Dr A', readmit_doctor: 'Dr B',
    index_discharge_at: '2026-08-01T10:00:00+05:30', readmit_admit_at: '2026-08-05T09:00:00+05:30',
    cm_note: null, form_is_planned: false, form_same_condition: true,
    audit_status: o.audit_status ?? 'audited', engine_version: 'readmission/0.2',
    finding: JSON.stringify({ avoidable: { verdict: 'avoidable' } }), model: 'gemini-2.5-pro', provider: 'vertex',
    promoted_to_full: c.promoted_to_full, trace_id: traceId,
  };
  const cols = Object.keys(row);
  await db.query(
    `INSERT INTO readmission_findings (${cols.join(', ')}) VALUES (${cols.map((_c, i) => `$${i + 1}`).join(', ')})`,
    cols.map((k) => row[k]));
  if (traceId) {
    await seedTrace(db, traceId, c.legs, {
      drop: o.drop,
      reply: (stage) => (stage === 'readmit_condition' && !c.promoted_to_full ? CONDITION_DIFFERENT : CLAIMS),
    });
  }
  return row;
}

const runner = (db: Db) => (async (statement: string, params: unknown[]) => db.query(statement, params)) as never;

const freeze = (db: Db, key: string) => freezeReadmissionFinding(key, {
  run: runner(db), assemble: (async () => ASSEMBLED) as never, salt: SALT,
});

// ═════════════════════════════════════════════════════════════════════════════════════
// DECISION 87 — the inferred statement, against a real table
// ═════════════════════════════════════════════════════════════════════════════════════

test('§17.9 decision 114: the trace_events read is a bounded SELECT that writes nothing', () => {
  assert.match(READMISSION_TRACE_SQL, /^SELECT/);
  assert.match(READMISSION_TRACE_SQL, /WHERE trace_id = \$1/, 'the trace id is BOUND, never interpolated');
  assert.match(READMISSION_TRACE_SQL, /kind = 'llm_response'/);
  assert.match(READMISSION_TRACE_SQL, /stage <> 'readmit_narrative'/, 'decision 104: the narrative leg is not a step');
  assert.match(READMISSION_TRACE_SQL, /ORDER BY seq/);
  for (const verb of ['INSERT', 'UPDATE', 'DELETE', 'ALTER', 'DROP', 'TRUNCATE']) {
    assert.ok(!new RegExp(`\\b${verb}\\b`).test(READMISSION_TRACE_SQL), `the trace read contains ${verb}`);
  }
});

test('§17.9 decision 87: the trace read runs against a real trace_events table and finds the legs', async () => {
  const db = await productionDb();
  await seedLane(db, LANES[3]);
  const rows = await db.query<Record<string, unknown>>(READMISSION_TRACE_SQL, ['TR-TB-1']);

  // Two legs, one row each: the `llm_request` halves and the narrative pair are filtered out.
  assert.deepEqual(rows.map((r) => r.stage), ['readmit_recon_a', 'readmit_recon_b'], 'ordered by seq');
  assert.equal(rows[0].content, CLAIMS, 'payload->>content is the reply, whole');
  assert.equal(rows[0].model, 'gemini-2.5-pro');
  assert.equal(rows[0].provider, 'vertex');
  // ⚠️ THE NARRATIVE LEG SHARES THE TRACE and must not become a step. Its row exists.
  const all = await db.query<{ stage: string }>(
    `SELECT stage FROM trace_events WHERE trace_id = $1 AND kind = 'llm_response' ORDER BY seq`, ['TR-TB-1']);
  assert.deepEqual(all.map((r) => r.stage), ['readmit_recon_a', 'readmit_recon_b', 'readmit_narrative']);
  assert.deepEqual(await db.query(READMISSION_TRACE_SQL, ['TR-NOBODY']), []);
  await db.close();
});

// ═════════════════════════════════════════════════════════════════════════════════════
// The freeze — one step per leg, per lane class
// ═════════════════════════════════════════════════════════════════════════════════════

test('§17.9 decision 114: the freeze records one step per leg, and the count is the LANE’s', async () => {
  const counts: Record<string, number> = {};
  for (const c of LANES) {
    const db = await productionDb();
    await seedLane(db, c);
    const frozen = await freeze(db, c.dedup_key);
    const steps = Object.values(frozen.frozen.steps);

    counts[c.name] = steps.length;
    assert.equal(steps.length, c.legs.length, `${c.name}: ${c.legs.length} leg(s)`);
    assert.deepEqual(steps.map((s) => s.stage).sort(), [...c.legs].sort(), `${c.name}: the stages`);
    for (const [k, v] of Object.entries(frozen.frozen.steps)) {
      assert.match(k, /^[0-9a-f]{64}$/, `${c.name}: a step key is a 64-hex request hash`);
      assert.equal(v.request_hash, k, `${c.name}: the key IS the hash`);
      assert.deepEqual(v.served, { model: 'gemini-2.5-pro', provider: 'vertex' });
    }
    // Decision 99's walk covers the new keys, and nothing identifying rode in on the reply text.
    assert.deepEqual(identifyingKeys(frozen.frozen), [], `${c.name}: the walk`);
    assert.ok(!JSON.stringify(frozen.frozen).includes('UH-000001'), `${c.name}: no uhid`);
    assert.ok(!JSON.stringify(frozen.frozen).includes('Real Name'), `${c.name}: no name`);
    assert.equal(frozen.source_versions.recorded_steps, c.legs.length);
    // The trace_id is a handle on a production audit of one member, and is NOT stored.
    assert.ok(!JSON.stringify(frozen).includes(`TR-${c.dedup_key}`), `${c.name}: no trace_id stored`);
    await db.close();
  }
  // The table the round report carries. NEVER four.
  assert.deepEqual(counts, {
    'out_of_network': 1,
    'other, not promoted': 1,
    'other, promoted to full': 3,
    'every other lane': 2,
  });
  console.log('D2a STEPS PER LANE', JSON.stringify(counts));
});

test('§17.9 decision 114: `expectedLegStages` is the ENGINE’s branch, not a table restated', () => {
  for (const c of LANES) {
    assert.deepEqual([...expectedLegStages(c)], [...c.legs], c.name);
  }
});

test('§17.9 decision 114: a shortfall is REFUSED, with the lane and both counts in the message', async () => {
  const db = await productionDb();
  // A promoted lane-`other` finding whose recon B reply never landed: 3 expected, 2 found.
  await seedLane(db, LANES[2], { drop: ['readmit_recon_b'] });
  await assert.rejects(() => freeze(db, 'OTH-2'), (e: LabError) => {
    assert.equal(e.code, 'SOURCE_UNAVAILABLE');
    assert.match(e.message, /lane 'other'/, 'the lane');
    assert.match(e.message, /fires 3 recon leg\(s\)/, 'the expected count');
    assert.match(e.message, /replies for 2 of them/, 'the found count');
    assert.match(e.message, /readmit_condition, readmit_recon_a/, 'and which ones did arrive');
    assert.ok(!e.message.includes('OTH-2'), 'decision 99: the identifier is not echoed back');
    return true;
  });
  await db.close();
});

test('§17.9 decision 114: a finding with no trace is refused, and so is one that is not audited', async () => {
  const db = await productionDb();
  await seedLane(db, { ...LANES[3], dedup_key: 'TB-DETECTED' }, { audit_status: 'detected' });
  await seedLane(db, { ...LANES[3], dedup_key: 'TB-NOTRACE' }, { trace_id: null });
  await assert.rejects(() => freeze(db, 'TB-DETECTED'),
    (e: LabError) => e.code === 'SOURCE_UNAVAILABLE' && /audit_status 'detected'/.test(e.message));
  await assert.rejects(() => freeze(db, 'TB-NOTRACE'),
    (e: LabError) => e.code === 'SOURCE_UNAVAILABLE' && /carries no trace_id/.test(e.message));
  await db.close();
});

test('§17.9: a trace_events read fault is SOURCE_UNAVAILABLE, never a frozen case without steps', async () => {
  const db = await productionDb();
  await seedLane(db, LANES[3]);
  const broken = (async (statement: string, params: unknown[]) => {
    if (statement.includes('trace_events')) throw new Error('connection reset by peer');
    return db.query(statement, params);
  }) as never;
  await assert.rejects(
    () => freezeReadmissionFinding('TB-1', { run: broken, assemble: (async () => ASSEMBLED) as never, salt: SALT }),
    (e: LabError) => e.code === 'SOURCE_UNAVAILABLE' && /connection reset/.test(e.message));
  await db.close();
});

// ═════════════════════════════════════════════════════════════════════════════════════
// The replay — zero model calls, production's verdict, decision 116's attribution
// ═════════════════════════════════════════════════════════════════════════════════════

const ARM_STAGES = Object.fromEntries(
  ['readmit_oon', 'readmit_condition', 'readmit_recon_a', 'readmit_recon_b']
    .map((s) => [s, { provider: 'ollama', model: 'local-model', max_cost_microusd: 5_000 }]),
);

async function runFrozen(db: Db, frozen: Record<string, unknown>, key: string) {
  const budget = await ensureBudget(db, 'research', 'default', 10_000_000);
  const { run } = await submitRun(db, 'research', 'experiment_run', null, budget.id, key, 'armhash', 86_400_000, [
    {
      case_key: 'readmit:d2a', arm_hash: 'armhash', repetition: 1,
      payload: { engine: 'readmission', frozen, arm: { stages: ARM_STAGES }, budget_id: budget.id },
    },
  ]);
  // ⚠️ THE LIVE TRANSPORT IS WIRED TO THROW, which is what makes "zero model calls" STRUCTURAL
  // rather than observed: if the adapter ever reached a provider the item would fail loudly.
  await tick({
    db,
    transport: (async () => { throw new Error('an exact readmission replay must never reach a provider'); }) as never,
    adapters: { readmission: makeReadmissionAdapter() },
  });
  const [item] = await itemsOf(db, run.id);
  return { run, item, budget };
}

/** Production's own side of the A/B: the sequence, driven by a plain closure, as `vertexPass` is. */
async function verdictFromReplies(row: Record<string, unknown>, reply: (stage: string) => string) {
  const seq = await runReconSequence({
    row: row as never,
    inputs: (ASSEMBLED as { inputs: unknown }).inputs as never,
    indexDischargeAt: String(row.index_discharge_at ?? ''),
    pass: async (label) => parsePassClaims(reply(label)),
  });
  return seq.finding?.avoidable?.verdict ?? null;
}

test('§17.9 decisions 114/116: a frozen finding replays to production’s verdict with ZERO model calls', async () => {
  const prod = await productionDb();
  await seedLane(prod, LANES[3]);
  const frozen = await freeze(prod, 'TB-1');
  const expected = await verdictFromReplies(frozen.frozen.row, () => CLAIMS);
  await prod.close();

  const db = await freshDb();
  const { item, budget } = await runFrozen(db, frozen.frozen as unknown as Record<string, unknown>, 'd2a-replay');

  assert.equal(item.state, 'succeeded', `the item failed: ${JSON.stringify(item.error)}`);
  const summary = (item.result as { summary: Record<string, unknown> }).summary;
  assert.equal(summary.avoidable_verdict, expected, 'the replay is production’s verdict, not a new one');
  assert.equal(summary.replayed_stages, 2);
  assert.equal(summary.legs, 2);
  // DECISION 116 — declared by the adapter, honoured by worker.ts because the gateway saw no call.
  assert.equal(summary.attribution_status, 'replayed');
  assert.equal(item.attribution_status, 'replayed');
  assert.equal(item.execution_status, 'succeeded');
  assert.equal(item.assessment_status, 'assessed');

  // §6.3 — nothing reserved, nothing spent, because the gateway was never reached.
  const calls = await db.query<{ n: string }>(`SELECT count(*)::text AS n FROM lab_v2.calls WHERE item_id = $1`, [item.id]);
  assert.equal(calls[0].n, '0', 'an exact replay reserves nothing and spends nothing');
  const spent = await db.query<{ spent_microusd: string }>(`SELECT spent_microusd FROM lab_v2.budgets WHERE id = $1`, [budget.id]);
  assert.equal(Number(spent[0].spent_microusd), 0);
  await db.close();
});

test('§17.9 decision 114: an OLD frozen case — no steps — still runs FRESH, unchanged', async () => {
  const prod = await productionDb();
  await seedLane(prod, LANES[3]);
  const frozen = await freezeReadmissionFinding('TB-1', {
    run: runner(prod), assemble: (async () => ASSEMBLED) as never, salt: SALT,
    recordSteps: async () => ({}),
  });
  await prod.close();

  const stages: string[] = [];
  const ctx = {
    runId: 'r', itemId: 'i', caseKey: 'c', frozen: frozen.frozen as unknown as Record<string, unknown>,
    arm: {}, repetition: 0,
    gateway: {
      call: async (stage: string) => {
        stages.push(stage);
        return { completion: { choices: [{ message: { content: CLAIMS } }] }, text: CLAIMS, usage: {}, served: null };
      },
    },
    event: () => {},
    checkpoint: async <T,>(_n: string, _h: string, produce: () => Promise<T>) => produce(),
  } as unknown as AdapterContext;

  const out = await makeReadmissionAdapter().run(ctx);
  assert.deepEqual(stages, ['readmit_recon_a', 'readmit_recon_b'], 'the gateway, exactly as before D2a');
  assert.equal(out.execution_status, 'succeeded');
  assert.equal(out.summary.attribution_status, undefined, 'a fresh run declares nothing');
  assert.equal(out.summary.replayed_stages, undefined);
});

test('§17.9 decision 114: a moved frozen input is REPLAY_DIVERGED, and it NAMES the stage', async () => {
  const prod = await productionDb();
  await seedLane(prod, LANES[3]);
  const frozen = await freeze(prod, 'TB-1');
  await prod.close();

  /**
   * ⚠️ `gap_days` IS A PROMPT INPUT, not decoration: `buildFullReconPrompt` takes it in its facts
   * (`run.ts:477-484`) and `buildSecondAvoidablePrompt` takes it directly (`:488`). Moving it is
   * what db13 moving under an audited finding looks like — the rebuilt prompt differs from the one
   * production sent, so the stored hash is not the hash this replay asks for. Decision 114(a):
   * that is a MEASUREMENT of drift and it is reported, never smoothed into a fresh call.
   */
  const tampered = {
    ...(frozen.frozen as unknown as Record<string, unknown>),
    row: { ...frozen.frozen.row, gap_days: 19 },
  };

  const db = await freshDb();
  const { item } = await runFrozen(db, tampered, 'd2a-diverged');
  assert.equal(item.state, 'failed');
  assert.equal((item.error as { code?: string }).code, 'REPLAY_DIVERGED');
  const message = String((item.error as { message?: string }).message);
  assert.match(message, /stage 'readmit_recon_a'/, 'the stage is named');
  assert.match(message, /not among the 2 the case carries/, 'and how many the case does carry');
  await db.close();
});

test('§17.9 decision 114: the hash the freeze records is the hash the adapter asks for', async () => {
  const db = await productionDb();
  await seedLane(db, LANES[0]);
  const frozen = await freeze(db, 'OON-1');
  await db.close();

  // The adapter's params object, rebuilt here from the ONE leg an out-of-network finding fires.
  const asked: string[] = [];
  await runReconSequence({
    row: frozen.frozen.row as never,
    inputs: (ASSEMBLED as { inputs: unknown }).inputs as never,
    indexDischargeAt: frozen.frozen.index_discharge_at,
    pass: async (_label, prompt) => {
      asked.push(dependencyHash({
        messages: [
          { role: 'system', content: prompt.system },
          { role: 'user', content: prompt.user },
        ],
        temperature: 0.1,
        max_tokens: 3000,
      }));
      return parsePassClaims(CLAIMS);
    },
  });
  assert.deepEqual(asked, Object.keys(frozen.frozen.steps), 'the recorded key IS the replayed key');
});

// ═════════════════════════════════════════════════════════════════════════════════════
// DECISION 115 — not_applicable
// ═════════════════════════════════════════════════════════════════════════════════════

/** An adapter that answers the clinical question and makes NO model call. Preop, in miniature. */
function zeroCallAdapter(summary: Record<string, unknown> = {}): Adapter {
  return {
    engine: 'preop',
    stages: ['suggest'],
    engineVersion: () => 'zero/1.0',
    frozenInputs: [],
    perAttemptTimeoutMs: 1_000,
    async run(): Promise<AdapterOutcome> {
      return {
        result: { tiered: true },
        summary: { engine: 'preop', tier: 'AMBER', ...summary },
        execution_status: 'succeeded', assessment_status: 'assessed',
      };
    },
  };
}

/**
 * DECISION 121's contrast: an adapter that DOES dispatch one call at the priced stage. Whatever
 * the transport then does to it, a call went out, and the gateway's verdict about it stands.
 */
function oneCallAdapter(): Adapter {
  return {
    engine: 'preop',
    stages: ['suggest'],
    engineVersion: () => 'one/1.0',
    frozenInputs: [],
    perAttemptTimeoutMs: 1_000,
    async run(ctx: AdapterContext): Promise<AdapterOutcome> {
      await ctx.gateway.call('suggest', { messages: [{ role: 'user', content: 'hello' }] });
      return {
        result: { tiered: true },
        summary: { engine: 'preop', tier: 'AMBER' },
        execution_status: 'succeeded', assessment_status: 'assessed',
      };
    },
  };
}

const PRICED = { suggest: { provider: 'ollama', model: 'local-model', max_cost_microusd: 5_000 } };

async function runZeroCall(
  db: Db, adapter: Adapter, key: string,
  o: { transport?: unknown; stages?: Record<string, unknown> } = {},
) {
  const budget = await ensureBudget(db, 'research', 'default', 1_000_000);
  const { run } = await submitRun(db, 'research', 'experiment_run', null, budget.id, key, 'h', 86_400_000, [
    {
      case_key: 'z1', arm_hash: 'h', repetition: 1,
      payload: { engine: 'preop', frozen: {}, arm: { stages: o.stages ?? {} }, budget_id: budget.id },
    },
  ]);
  await tick({
    db,
    transport: (o.transport ?? (async () => { throw new Error('this item makes no model call'); })) as never,
    adapters: { preop: adapter },
  });
  const [item] = await itemsOf(db, run.id);
  return item;
}

test('§17.9 decision 115: an item that made no model call reports not_applicable, not unknown', async () => {
  const db = await freshDb();
  const item = await runZeroCall(db, zeroCallAdapter(), 'd115-none');
  assert.equal(item.state, 'succeeded');
  // ⚠️ `unknown` IS A VERDICT ABOUT A CALL — one was made and its receipt did not arrive. Nothing
  // was measured here because nothing was attempted, and the word now says which.
  assert.equal(item.attribution_status, 'not_applicable');
  assert.equal(item.assessment_status, 'assessed', 'the CLINICAL question still got an answer (§9)');
  await db.close();
});

test('§17.9 decision 115: a DECLARED replay still wins over not_applicable', async () => {
  const db = await freshDb();
  const item = await runZeroCall(db, zeroCallAdapter({ attribution_status: 'replayed' }), 'd115-replayed');
  assert.equal(item.attribution_status, 'replayed', 'decision 65 is untouched by the fifth value');
  await db.close();
});

/**
 * ⚠️⚠️ DECISION 121 — THE DEFECT D2a SHIPPED, AND THE THREE CASES THAT PIN THE FIX.
 *
 * `not_applicable` was set from `gatewayVerdict === 'unknown'`, and the gateway returns that word
 * for TWO different facts: "no call went out" and "one call went out and I could not attribute
 * it". Only the first is `not_applicable`. The second is a measurement that FAILED — money may
 * well have been spent — and calling it "not applicable" would retire a real attribution gap into
 * a word that reads like housekeeping. `Gateway.sawAnyCall()` separates them.
 */
test('§17.9 decision 121: one call settled with NO usage is `unknown`, never not_applicable', async () => {
  const db = await freshDb();
  // The transport answers, and reports no usage — so the cost is unknowable, the call is marked
  // `unknown` and its reservation moves to the unknown bucket (`gateway.ts:141-145`).
  const item = await runZeroCall(db, oneCallAdapter(), 'd121-nousage', {
    stages: PRICED,
    transport: async () => ({ completion: { choices: [] }, text: 'ok', served: { provider: 'ollama', model: 'local-model' }, usage: null }),
  });
  assert.equal(item.state, 'succeeded');
  assert.equal(item.attribution_status, 'unknown', 'a call WAS dispatched; the gateway’s verdict stands');
  // And the evidence that a call happened, so the assertion above is not about nothing.
  const calls = await db.query<{ n: string }>(`SELECT count(*)::text AS n FROM lab_v2.calls WHERE item_id = $1`, [item.id]);
  assert.equal(calls[0].n, '1');
  await db.close();
});

test('§17.9 decision 121: a transport that THREW is `unknown`, never not_applicable', async () => {
  const db = await freshDb();
  const item = await runZeroCall(db, oneCallAdapter(), 'd121-threw', {
    stages: PRICED,
    transport: async () => { throw new Error('provider timed out'); },
  });
  // The gateway moves the reservation to `unknown` and re-throws (`gateway.ts:131-138`), so the
  // item fails — but it fails having SPENT a call, which is not the same fact as never making one.
  assert.equal(item.state, 'failed');
  assert.equal(item.attribution_status, 'unknown');
  const calls = await db.query<{ n: string; state: string }>(
    `SELECT count(*)::text AS n, max(state) AS state FROM lab_v2.calls WHERE item_id = $1`, [item.id]);
  assert.equal(calls[0].n, '1', 'the intent row a killed call leaves behind');
  await db.close();
});

test('§17.9 decision 121: a FAILED item that never reached a call is still not_applicable', async () => {
  const db = await freshDb();
  const throwing: Adapter = {
    ...zeroCallAdapter(),
    async run(): Promise<AdapterOutcome> { throw new LabError('ENGINE_UNSUPPORTED', 'nothing to run'); },
  };
  const item = await runZeroCall(db, throwing, 'd121-failed-nocall');
  assert.equal(item.state, 'failed');
  // ⚠️ AND THIS IS THE HALF THAT MUST NOT REGRESS. Nothing was dispatched, so nothing went
  // unmeasured; the item failed for a reason that has no attribution question in it at all.
  assert.equal(item.attribution_status, 'not_applicable');
  const calls = await db.query<{ n: string }>(`SELECT count(*)::text AS n FROM lab_v2.calls WHERE item_id = $1`, [item.id]);
  assert.equal(calls[0].n, '0', 'no call, which is exactly why the word is not_applicable');
  await db.close();
});

test('§17.9 decision 121: sawAnyCall() is false before any call and true after one', async () => {
  const db = await freshDb();
  const budget = await ensureBudget(db, 'research', 'default', 1_000_000);
  // A real item, because `calls.item_id` is a foreign key and a call must be attributable to one.
  const { run } = await submitRun(db, 'research', 'experiment_run', null, budget.id, 'd121-unit', 'h', 86_400_000,
    [{ case_key: 'g1', arm_hash: 'h', repetition: 1, payload: {} }]);
  const [item] = await itemsOf(db, run.id);
  const { Gateway } = await import('../gateway');
  const gateway = new Gateway({
    db, itemId: item.id, leaseToken: item.lease_token, budgetId: budget.id,
    transport: (async () => ({ completion: null, text: '', served: null, usage: null })) as never,
    stages: PRICED as never,
  });
  // ⚠️ THE TWO ANSWERS THAT USED TO BE ONE WORD. Before any call both say the same thing; after a
  // call the gateway can still only say `unknown`, and `sawAnyCall()` is what tells them apart.
  assert.equal(gateway.sawAnyCall(), false);
  assert.equal(gateway.attributionStatus(), 'unknown');
  await assert.doesNotReject(() => gateway.call('suggest', { messages: [] }));
  assert.equal(gateway.sawAnyCall(), true);
  assert.equal(gateway.attributionStatus(), 'unknown', 'still unknown — and now demonstrably NOT "no call"');
  await db.close();
});

// ═════════════════════════════════════════════════════════════════════════════════════
// §17.9 item 5 — run_diff's four new fields, through service dispatch (decision 109)
// ═════════════════════════════════════════════════════════════════════════════════════

const deps = (db: Db) => ({ db, principal: 'research', protocolVersion: 'test', sdkVersion: 'test' }) as never;

async function seedSummaries(db: Db, budgetId: string, key: string, summaries: Record<string, unknown>[]) {
  const { run } = await submitRun(db, 'research', 'experiment_run', null, budgetId, key, 'h', 86_400_000,
    summaries.map((_s, i) => ({ case_key: `c${i + 1}`, arm_hash: 'armA', repetition: 1, payload: {} })));
  const items = await itemsOf(db, run.id);
  for (const [i, item] of items.entries()) {
    await db.query(
      `UPDATE lab_v2.items SET state = 'succeeded', execution_status = 'succeeded',
         assessment_status = 'assessed', attribution_status = 'replayed', result = $2::jsonb WHERE id = $1`,
      [item.id, JSON.stringify({ result_hash: `h${i}`, summary: summaries[i] })]);
  }
  return run;
}

test('§17.9 item 5: run_diff carries the verdict and the tier, and null for an engine with neither', async () => {
  const db = await freshDb();
  const budget = await ensureBudget(db, 'research', 'default', 1_000_000);
  const a = await seedSummaries(db, budget.id, 'd2a-diff-a', [
    { engine: 'readmission', avoidable_verdict: 'avoidable' },
    { engine: 'preop', tier: 'RED' },
    { engine: 'opd_note_audit', note_quality_index: 70, band: 'C', finding_subjects: [] },
  ]);
  const b = await seedSummaries(db, budget.id, 'd2a-diff-b', [
    { engine: 'readmission', avoidable_verdict: 'justified' },
    { engine: 'preop', tier: 'AMBER' },
    { engine: 'opd_note_audit', note_quality_index: 74, band: 'B', finding_subjects: [] },
  ]);

  const out = await callTool(deps(db), 'run_diff', { run_a: a.id, run_b: b.id }) as {
    paired: number;
    cases: {
      case_key: string;
      avoidable_verdict_before: string | null; avoidable_verdict_after: string | null;
      tier_before: string | null; tier_after: string | null;
      band_before: string | null; band_after: string | null;
    }[];
  };
  assert.equal(out.paired, 3);
  const by = Object.fromEntries(out.cases.map((c) => [c.case_key, c]));

  // ⚠️ THE QUESTION `run_diff` COULD NOT ANSWER BEFORE THIS ROUND. A readmission A/B reported the
  // three statuses and a hash inequality; it never said the verdict had moved.
  assert.equal(by.c1.avoidable_verdict_before, 'avoidable');
  assert.equal(by.c1.avoidable_verdict_after, 'justified');
  assert.equal(by.c1.tier_before, null, 'readmission has no tier');
  assert.equal(by.c2.tier_before, 'RED');
  assert.equal(by.c2.tier_after, 'AMBER');
  assert.equal(by.c2.avoidable_verdict_before, null, 'preop has no verdict');
  // ⚠️ AND AN OPD RUN IS NULL ON ALL FOUR, WHICH IS NOT "UNCHANGED". The engine has no verdict and
  // no tier; null says so, and the band it does have is untouched.
  assert.equal(by.c3.avoidable_verdict_before, null);
  assert.equal(by.c3.avoidable_verdict_after, null);
  assert.equal(by.c3.tier_before, null);
  assert.equal(by.c3.tier_after, null);
  assert.equal(by.c3.band_before, 'C');
  assert.equal(by.c3.band_after, 'B');
  await db.close();
});

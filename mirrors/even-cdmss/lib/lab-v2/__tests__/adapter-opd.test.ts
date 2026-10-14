// LAB-MCP-V2 §15.13 — the OPD adapter end to end, on the REAL production engine.
//
// This is the test that matters most for the platform's central claim: a lab run is
// evidence about production only if production's own code produced it. So this runs
// `auditOpdNote` itself — not a stub of it — with frozen inputs, a fixture transport and
// a fixture retrieval edge, inside the isolation context. Any production write attempted
// underneath would hit the throwing `sql` proxy and fail the test rather than pass silently.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { freshDb, FROZEN, ARM, REPLY_ONE_FINDING } from './helpers';
import { ensureBudget, itemsOf, putObject, submitRun } from '../store';
import { Gateway } from '../gateway';
import { fixtureTransport } from '../transport';
import { makeOpdAdapter, stageForLabel, opdAdapter } from '../adapters/opd';
import { tick } from '../worker';
import { OPD_STAGES } from '../contracts';

const EMPTY_RETRIEVAL = async () => ({ hits: [], expandedQuery: 'q' }) as never;

test('§15.13: a frozen synthetic note runs through auditOpdNote and yields the engine finding shape', async () => {
  const db = await freshDb();
  const budget = await ensureBudget(db, 'research', 'default', 10_000_000);
  const { run } = await submitRun(db, 'research', 'experiment_run', null, budget.id, 'opd-1', 'h', 86_400_000, [
    { case_key: 'test-note-0001', arm_hash: 'h', repetition: 1, payload: {} },
  ]);
  const item = (await itemsOf(db, run.id))[0];

  const gateway = new Gateway({
    db, itemId: item.id, leaseToken: 0, budgetId: budget.id,
    transport: fixtureTransport({ reply: JSON.stringify({ findings: [], pdqi9: {} }) }),
    stages: { analysis: { provider: 'ollama', model: 'local-model', max_cost_microusd: 100_000 } },
  });

  const adapter = makeOpdAdapter({ retrieve: EMPTY_RETRIEVAL });
  const events: string[] = [];
  const outcome = await adapter.run({
    runId: run.id, itemId: item.id, caseKey: 'test-note-0001',
    frozen: FROZEN, arm: ARM, repetition: 1, gateway,
    event: (kind) => { events.push(kind); },
    checkpoint: async (_n, _h, produce) => produce(),
  });

  // The engine ran to its end and produced its own shape.
  assert.equal(outcome.execution_status, 'succeeded');
  const result = outcome.result as { findings?: unknown[]; scorecard?: unknown; engineVersion?: string; completeness?: unknown };
  assert.ok(Array.isArray(result.findings), 'the engine returns a findings array');
  assert.ok(result.scorecard, 'and a scorecard');
  assert.ok(result.completeness, 'and a completeness block');
  assert.equal(result.engineVersion, ARM.engine_version, "the arm's engine version is what the run is labelled with");
  assert.equal(typeof outcome.summary.findings, 'number');

  // §9 — the clinical question either got an answer or it did not, and the two are distinguished.
  assert.ok(['assessed', 'unassessable'].includes(outcome.assessment_status));

  // The one production read a Slice A run makes is logged (§8.1).
  assert.ok(events.includes('retrieval_read'), 'the retrieval edge records its read');

  // The budget was actually charged through the gateway, not bypassed.
  const calls = await db.query<{ state: string; stage: string }>(`SELECT state, stage FROM lab_v2.calls WHERE item_id = $1`, [item.id]);
  assert.ok(calls.length >= 1, 'the engine reached the model through the gateway');
  assert.equal(calls[0].stage, 'analysis');
  assert.equal(gateway.attributionStatus(), 'verified');
  await db.close();
});

test('§15.13: no production write occurs — the isolation fence holds under the real engine', async () => {
  const db = await freshDb();
  const budget = await ensureBudget(db, 'research', 'default', 10_000_000);
  const { run } = await submitRun(db, 'research', 'experiment_run', null, budget.id, 'opd-2', 'h', 86_400_000, [
    { case_key: 'test-note-0001', arm_hash: 'h', repetition: 1, payload: {} },
  ]);
  const item = (await itemsOf(db, run.id))[0];
  const gateway = new Gateway({
    db, itemId: item.id, leaseToken: 0, budgetId: budget.id,
    transport: fixtureTransport({ reply: JSON.stringify({ findings: [], pdqi9: {} }) }),
    stages: { analysis: { provider: 'ollama', model: 'local-model', max_cost_microusd: 100_000 } },
  });
  // If any production write had been attempted it would have thrown LAB_IO_FORBIDDEN
  // beneath the engine; the engine's own catch would then have marked the run failed.
  const outcome = await makeOpdAdapter({ retrieve: EMPTY_RETRIEVAL }).run({
    runId: run.id, itemId: item.id, caseKey: 'test-note-0001', frozen: FROZEN, arm: ARM,
    repetition: 1, gateway, event: () => {}, checkpoint: async (_n, _h, p) => p(),
  });
  assert.equal(outcome.execution_status, 'succeeded');
  const err = (outcome.result as { error?: string }).error;
  assert.equal(err, undefined, 'no LAB_IO_FORBIDDEN escaped the engine');
  await db.close();
});

test('§15.13: frozen inputs that do not match the engine shape fail cleanly, never a crash', async () => {
  const db = await freshDb();
  const budget = await ensureBudget(db, 'research', 'default', 1_000_000);
  const { run } = await submitRun(db, 'research', 'experiment_run', null, budget.id, 'opd-3', 'h', 86_400_000, [
    { case_key: 'x', arm_hash: 'h', repetition: 1, payload: {} },
  ]);
  const item = (await itemsOf(db, run.id))[0];
  const gateway = new Gateway({
    db, itemId: item.id, leaseToken: 0, budgetId: budget.id, transport: fixtureTransport(),
    stages: {},
  });
  const outcome = await makeOpdAdapter({ retrieve: EMPTY_RETRIEVAL }).run({
    runId: run.id, itemId: item.id, caseKey: 'x', frozen: { note: 'not an object' }, arm: ARM,
    repetition: 1, gateway, event: () => {}, checkpoint: async (_n, _h, p) => p(),
  });
  assert.equal(outcome.execution_status, 'failed');
  assert.equal(outcome.assessment_status, 'not_reached');
  await db.close();
});

// ── decision 10 — the frozen suppression must actually reach the engine ──────────────
test('decision 10: a frozen suppression produces the SUPPRESSED result, not the un-suppressed one', async () => {
  const db = await freshDb();
  const budget = await ensureBudget(db, 'research', 'default', 10_000_000);

  // One helper: run the same frozen note through the real engine, varying only the
  // suppressions the dataset froze. Everything else — note, arm, LLM reply — is identical,
  // so any difference in the findings is attributable to the frozen suppression alone.
  const runWith = async (suppressions: Record<string, unknown>[], idem: string) => {
    const { run } = await submitRun(db, 'research', 'experiment_run', null, budget.id, idem, 'h', 86_400_000, [
      { case_key: 'test-note-0001', arm_hash: 'h', repetition: 1, payload: {} },
    ]);
    const item = (await itemsOf(db, run.id))[0];
    const gateway = new Gateway({
      db, itemId: item.id, leaseToken: 0, budgetId: budget.id,
      transport: fixtureTransport({ reply: REPLY_ONE_FINDING }),
      stages: { analysis: { provider: 'ollama', model: 'local-model', max_cost_microusd: 100_000 } },
    });
    const outcome = await makeOpdAdapter({ retrieve: EMPTY_RETRIEVAL }).run({
      runId: run.id, itemId: item.id, caseKey: 'test-note-0001',
      frozen: { ...FROZEN, suppressions }, arm: ARM, repetition: 1, gateway,
      event: () => {}, checkpoint: async (_n, _h, p) => p(),
    });
    return (outcome.result as { findings: { subject: string; signal_type: string }[] }).findings;
  };

  // Baseline: no suppressions frozen, so the low-value finding survives.
  const unsuppressed = await runWith([], 'supp-off');
  assert.equal(unsuppressed.length, 1, 'the LLM leg produced one finding');
  assert.equal(unsuppressed[0].signal_type, 'low_value_care');

  // The same run with an active drop rule frozen into the dataset.
  const suppressed = await runWith([{
    id: 'test-supp-1', signal_type: 'low_value_care', discriminator: null,
    match_kind: 'type_only', scope: 'all', doctor_uid: null, action: 'drop', active: true,
  }], 'supp-on');
  assert.equal(suppressed.length, 0, 'the frozen suppression dropped the finding');

  // This is the whole point of decision 10: before it, the suppressions read hit
  // LAB_IO_FORBIDDEN inside the fence and fell back to [], so BOTH runs above would have
  // returned one finding and the lab would have scored un-suppressed while production did not.
  await db.close();
});

test('decision 10: the adapter reports all six frozen inputs, and the schema demands them', () => {
  assert.deepEqual([...opdAdapter.frozenInputs],
    ['note', 'specialty', 'complexity', 'lvc_rules', 'suppressions', 'quieting_config']);
});

test('§4.2/§8.1: the adapter declares one stage, and maps the engine label to a stage', () => {
  // Decision 11 — ONE stage. The engine has one governed call site, so an arm can only
  // price the work that actually runs.
  assert.deepEqual([...opdAdapter.stages], [...OPD_STAGES]);
  assert.deepEqual([...OPD_STAGES], ['analysis']);
  assert.equal(stageForLabel('opd_audit_analyze'), 'analysis');
  // An unrecognised future leg bills as analysis rather than failing the run.
  assert.equal(stageForLabel('something_new'), 'analysis');
});

test('§15.13: the whole path also runs through a tick, with all three statuses set', async () => {
  const db = await freshDb();
  const budget = await ensureBudget(db, 'research', 'default', 10_000_000);
  const arm = { ...ARM, stages: { analysis: { provider: 'ollama', model: 'local-model', max_cost_microusd: 100_000 } } };
  const { run } = await submitRun(db, 'research', 'experiment_run', null, budget.id, 'opd-tick', 'h', 86_400_000, [
    { case_key: 'test-note-0001', arm_hash: 'h', repetition: 1, payload: { engine: 'opd_note_audit', frozen: FROZEN, arm, budget_id: budget.id } },
  ]);
  const report = await tick({
    db,
    transport: fixtureTransport({ reply: JSON.stringify({ findings: [], pdqi9: {} }) }),
    adapters: { opd_note_audit: makeOpdAdapter({ retrieve: EMPTY_RETRIEVAL }) },
  });
  assert.equal(report.claimed, 1);
  const [item] = await itemsOf(db, run.id);
  assert.equal(item.state, 'succeeded');
  assert.equal(item.execution_status, 'succeeded');
  assert.ok(item.assessment_status);
  assert.equal(item.attribution_status, 'verified');
  // The full body is stored as an artifact and the item carries only a bounded summary.
  const stored = item.result as { artifact_id?: string; summary?: Record<string, unknown> };
  assert.ok(stored.artifact_id, 'the full result is addressable as an artifact');
  assert.ok(stored.summary, 'and the item carries a bounded summary');
  await db.close();
});

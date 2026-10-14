// LAB-MCP-V2 §15.3 + §14.2 — the live MCP surface: scope-filtered tools/list under each
// of the four keys, SCOPE_DENIED on a hidden tool, and the Zod-3 → Standard Schema bridge.
//
// This drives the REAL SDK server through the REAL client over an in-process transport, so
// it proves the bridge actually satisfies @modelcontextprotocol/server 2.0.0 rather than
// merely type-checking against it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/client';
import { createMcpHandler } from '@modelcontextprotocol/server';
import { freshDb } from './helpers';
import { buildServer, serveMcpRequest, MCP_V2_PROTOCOL_VERSION, MCP_V2_SDK_VERSION } from '../../mcp-v2/server';
import { sdkSchema, toJsonSchema } from '../../mcp-v2/schema-bridge';
import { toolSchemas, PRINCIPALS, type Principal } from '../contracts';
import type { Db } from '../db';

/** An in-process client wired straight to the handler's fetch face. No socket. */
async function connect(db: Db, principal: Principal) {
  const handler = createMcpHandler(() => buildServer({ db, principal }));
  const client = new Client({ name: 'test-client', version: '1.0.0' });
  await client.connect({
    async start() {}, async close() {},
    async send(msg: unknown) {
      const res = await handler.fetch(new Request('https://cat.evenos.app/api/mcp/v2', {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
        body: JSON.stringify(msg),
      }));
      if (res.status === 202) return;
      const ct = res.headers.get('content-type') || '';
      const text = await res.text();
      if (ct.includes('event-stream')) {
        for (const line of text.split('\n')) {
          if (line.startsWith('data:')) (this as { onmessage?: (m: unknown) => void }).onmessage?.(JSON.parse(line.slice(5).trim()));
        }
      } else if (text) (this as { onmessage?: (m: unknown) => void }).onmessage?.(JSON.parse(text));
    },
  } as never);
  return { client, handler };
}

test('§15.3: tools/list is scope-filtered for each of the four principals', async () => {
  const db = await freshDb();
  const listed: Record<string, string[]> = {};
  for (const principal of PRINCIPALS) {
    const { client, handler } = await connect(db, principal);
    const { tools } = await client.listTools();
    listed[principal] = tools.map((t) => t.name).sort();
    await handler.close();
  }
  // Printed so the build report can quote the exact surface rather than paraphrase it.
  console.log('TOOLS/LIST BY KEY:', JSON.stringify(listed, null, 1));

  // §15.3 — the research key must not see worker_control.
  assert.ok(!listed.research.includes('worker_control'));
  // §3.1 gives research `production_read`, so the two production READS are visible to it.
  assert.ok(listed.research.includes('system_health'));
  assert.ok(listed.research.includes('worker_status'));
  // lab-v2 A2 (+9 observation) and B1 (+3 research-visible: run_diff, experiment_compare,
  // run_replay; budget_reconcile is production_write and is not).
  // lab-v2 decision 49 (§17.5) adds both of B2's: episode_checkpoint_inspect (research_read) and
  // episode_replay (research_write).
  // lab-v2 §17.6 adds four research-visible: coverage_report, drift_report, retrieval_compare,
  // reaudit_plan. reaudit_execute is production_write and is not.
  // lab-v2 §17.7 adds four research-visible: corpus_stage, corpus_validate, corpus_diff and
  // release_status. The three `release` tools and review_submit carry scopes research has not.
  // lab-v2 §17.7 C2 adds two: rule_propose (research_write) and rule_simulate (research_read).
  // lab-v2 §17.7 C3 adds one research-visible: failure_cluster. review_queue is `review` ALONE.
  // ⚠️ RULE 1a, §17.11 — D3 adds three research-visible: case_ask, case_timeline and
  // failure_minimize, all `research_write`. The reviewer and release counts below do NOT move,
  // which is the point of scoping them that way rather than on production_read.
  assert.equal(listed.research.length, 42);

  // The operator holds production_write, so it alone sees worker_control.
  assert.ok(listed.operator.includes('worker_control'));
  // ⚠️ RULE 1a, §17.8 DECISION 108. This asserted the operator could NOT see dataset_create, which
  // was true until decision 105 made it the only principal that may send an identifier — and then
  // it was the bug: no principal could run an identifying experiment. The assertion is inverted,
  // and the one it was really protecting is kept below and made explicit: `release` is the scope
  // the operator still does not hold.
  assert.ok(listed.operator.includes('dataset_create'));
  assert.ok(!listed.operator.includes('release_apply'), 'research_write is not the release scope');
  assert.ok(!listed.operator.includes('review_submit'), 'nor the review scope');
  // The operator adds budget_reconcile (production_write) on top of the reads it can see, and
  // decision 49's episode_checkpoint_inspect, which is a research READ the operator already holds.
  /**
   * ⚠️ RULE 1a, §17.8 DECISION 108 — 33 → 42, and the jump is NINE rather than the three the
   * decision names. `operator` gained `research_write`, so it now sees every research-write tool:
   * dataset_create, experiment_create and experiment_run (the three Slice D needs), and with them
   * run_cancel, run_retry, run_replay, episode_replay, corpus_stage and rule_propose.
   *
   * That is a real widening and it is reported rather than absorbed. It is not a privilege
   * escalation: `operator` already holds `production_write`, which is the stronger authority —
   * corpus_stage and rule_propose both stage into quarantine and neither can activate anything,
   * because activation is the `release` scope, which `operator` does not hold and does not gain.
   */
  // ⚠️ RULE 1a, §17.11 — 42 → 45, D3's three, which the operator sees through `research_write`.
  assert.equal(listed.operator.length, 45);
  // ⚠️ RULE 1a, §17.8 DECISION 108 — inverted for the same reason as dataset_create above. A
  // replay IS a research write and the operator now holds that scope; what it still does not hold
  // is `release`, which is what actually keeps it from changing what a clinician sees.
  assert.ok(listed.operator.includes('episode_replay'));

  // reviewer and release hold no research_write: no dataset or experiment creation.
  for (const p of ['reviewer', 'release'] as const) {
    assert.ok(!listed[p].includes('dataset_create'), `${p} must not create datasets`);
    assert.ok(!listed[p].includes('experiment_run'), `${p} must not run experiments`);
    assert.ok(!listed[p].includes('worker_control'));
  }
  // reviewer = 3 unrestricted + 2 production reads + 4 research reads, plus decision 49's
  // episode_checkpoint_inspect — a reviewer may read a checkpoint's arithmetic, never replay it.
  // §17.7 — the reads, release_status, and review_submit; C2 adds rule_simulate (research_read).
  // C3 adds BOTH: failure_cluster (research_read) and review_queue, whose `review` scope the
  // reviewer alone holds.
  // §17.11 pins this at 32 and it is unchanged: no D3 tool carries `review`, `research_read` or
  // `production_read`, so a reviewer sees none of them. Deliberate — decision 146's tools resolve
  // a person and a reviewer's job does not.
  assert.equal(listed.reviewer.length, 32);
  for (const p of ['reviewer', 'release'] as const) {
    assert.ok(!listed[p].includes('episode_replay'), `${p} must not replay a run`);
  }
  // release = 3 unrestricted + 2 production reads + source_freshness. Nothing carries `release`.
  // §17.6 — release holds production_read, so the three production reads join it.
  // §17.7 — the release key gains its four: prepare, apply, rollback and status.
  // §17.11 pins this at 13, likewise unchanged, and for the same reason.
  assert.equal(listed.release.length, 13);
  for (const t of ['case_ask', 'case_timeline', 'failure_minimize']) {
    assert.ok(listed.research.includes(t), `research must see ${t}`);
    assert.ok(listed.operator.includes(t), `the operator must see ${t}`);
    assert.ok(!listed.reviewer.includes(t), `a reviewer must not see ${t}`);
    assert.ok(!listed.release.includes(t), `the release key must not see ${t}`);
  }
  for (const t of ['release_prepare', 'release_apply', 'release_rollback']) {
    assert.ok(listed.release.includes(t), `the release key must see ${t}`);
    assert.ok(!listed.research.includes(t), `research must never ${t}`);
    assert.ok(!listed.operator.includes(t), `the operator key must never ${t}`);
    assert.ok(!listed.reviewer.includes(t), `a reviewer approves; it does not ship`);
  }
  // ⚠️ Decision 5, on the surface: the key that prepares and applies cannot review.
  assert.ok(!listed.release.includes('review_submit'), 'the release key must never review its own release');
  assert.ok(listed.reviewer.includes('review_submit'));
  assert.ok(!listed.release.includes('reaudit_execute'), 'release must never repair');
  await db.close();
});

test('§15.3: calling a hidden tool by name returns SCOPE_DENIED, not "unknown tool"', async () => {
  const db = await freshDb();
  const { client, handler } = await connect(db, 'research');
  // The tool is not registered on this instance, so the SDK itself rejects the name.
  // That protocol-level rejection is the outer fence; the inner one is asserted below.
  await assert.rejects(() => client.callTool({ name: 'worker_control', arguments: { action: 'pause' } }));

  // The authorisation check that actually decides is in the service layer, and it is
  // reached whether or not the tool was ever registered.
  const { callTool } = await import('../service');
  await assert.rejects(
    () => callTool({ db, principal: 'research', protocolVersion: 'x', sdkVersion: 'y' }, 'worker_control', { action: 'pause' }),
    (e: { code?: string }) => e.code === 'SCOPE_DENIED',
  );
  await handler.close();
  await db.close();
});

test('§8: a real tool call round-trips through the SDK with structured content', async () => {
  const db = await freshDb();
  const { client, handler } = await connect(db, 'research');
  const res = await client.callTool({ name: 'system_capabilities', arguments: {} });
  const body = JSON.parse((res.content as { text: string }[])[0].text);
  assert.equal(body.principal, 'research');
  assert.equal(body.protocol_version, MCP_V2_PROTOCOL_VERSION);
  assert.equal(body.sdk_version, MCP_V2_SDK_VERSION);
  assert.equal(body.tools.length, 42);   // lab-v2 §17.11 — D3's three, all research_write-scoped
  assert.ok(body.pricing_version.startsWith('lab-v2-pricing/'));
  /**
   * ⚠️ RULE 1a, §17.11 DECISION 143 — the first retirement this platform has performed, asserted on
   * the surface a client calls to find out what exists. A tool that vanishes from a list is
   * indistinguishable from one that was never there; this entry is what makes it distinguishable.
   */
  assert.deepEqual(body.deprecations, [{
    tool: 'lab_query', surface: 'v1',
    replaced_by: ['audit_search', 'corpus_search'],
    since: 'e5f53c55',
  }]);
  await handler.close();
  await db.close();
});

test('§8: an input that fails its schema is rejected at dispatch', async () => {
  const db = await freshDb();
  const { callTool } = await import('../service');
  await assert.rejects(
    () => callTool({ db, principal: 'research', protocolVersion: 'x', sdkVersion: 'y' }, 'engine_describe', { engine: 'not_an_engine' }),
    (e: { code?: string }) => e.code === 'INVALID_INPUT',
  );
  await db.close();
});

test('§13: a principal field in the arguments is IGNORED, never trusted', async () => {
  const db = await freshDb();
  const { callTool } = await import('../service');
  const out = await callTool(
    { db, principal: 'research', protocolVersion: 'x', sdkVersion: 'y' },
    'system_capabilities',
    { principal: 'operator', reviewer: 'someone' },
  ) as { principal: string };
  assert.equal(out.principal, 'research', 'the key decides the principal, not the payload');
  await db.close();
});

// ── decision 19 / §15.2 — a key in the query string is a 400 ─────────────────────────
test('decision 19: a key presented in the query string returns 400, not 401 and not a session', async () => {
  // V1 accepted `?key=`. V2 refuses the whole SHAPE: query strings land in access logs,
  // proxy logs and browser history, so a secret that travels there is already leaked. The
  // check runs FIRST — before the configured check and before any key comparison — so this
  // holds even on an unconfigured deployment, which is what this test relies on.
  const res = await serveMcpRequest(
    new Request('https://cat.evenos.app/api/mcp/v2?key=some-secret', { method: 'POST', body: '{}' }),
    null,
  );
  assert.equal(res.status, 400);
  const body = await res.json() as { error: string };
  assert.match(body.error, /query string not accepted/);
  // And the refusal must not leak which of the four keys, if any, it matched.
  assert.ok(!/research|operator|reviewer|release/.test(body.error));
});

test('decision 19: any query string is refused, not only one named `key`', async () => {
  const res = await serveMcpRequest(
    new Request('https://cat.evenos.app/api/mcp/v2?anything=1', { method: 'POST', body: '{}' }),
    'a-bearer-key',
  );
  assert.equal(res.status, 400);
});

test('§3.1: with no keys configured the endpoint is 503, and a bad key is 401', async () => {
  const saved: Record<string, string | undefined> = {};
  for (const k of ['LAB_API_KEY_RESEARCH', 'LAB_API_KEY_OPERATOR', 'LAB_API_KEY_REVIEWER', 'LAB_API_KEY_RELEASE']) {
    saved[k] = process.env[k]; delete process.env[k];
  }
  try {
    const res = await serveMcpRequest(new Request('https://cat.evenos.app/api/mcp/v2', { method: 'POST', body: '{}' }), 'anything');
    assert.equal(res.status, 503, 'dark until V sets the keys');
    assert.equal((await res.json() as { error: string }).error, 'lab v2 not configured');
  } finally {
    for (const [k, v] of Object.entries(saved)) if (v !== undefined) process.env[k] = v;
  }
});

// ── §14.2 the Zod bridge ─────────────────────────────────────────────────────────────
test('§14.2: the bridge supplies the jsonSchema half that zod 3 lacks', () => {
  const zod3 = toolSchemas.dataset_create.input;
  const std = (zod3 as unknown as { '~standard': Record<string, unknown> })['~standard'];
  // The measured gap this bridge exists to close: zod 3.25.76 has validate, not jsonSchema.
  assert.ok(std.validate, 'zod 3 does implement the validation half');
  assert.equal(std.jsonSchema, undefined, 'and does NOT implement the JSON Schema half');

  const bridged = sdkSchema(zod3) as unknown as { '~standard': { jsonSchema: { input: () => Record<string, unknown> } ; validate: (v: unknown) => unknown } };
  const json = bridged['~standard'].jsonSchema.input();
  assert.equal(json.type, 'object');
  // lab-v2 round A3 (decision 34/37): dataset_create gained `body`, and `case_key` became
  // optional — opd_note_audit freezes a uid, the five route engines freeze a request body. The
  // bridge assertion is about the BRIDGE, so it pins what the bridge must reproduce: every
  // declared property, and the two fields that are required whichever shape of case is used.
  // B1 (§17.4 item 1) adds cohort mode: `cohort` and `exclusions` join the shape.
  // lab-v2 decision 48 (§17.5) adds `episodes`, the ipd_episode selector — audit row ids, or every
  // current row at one engine version. It is OPTIONAL like the other three case shapes, and the
  // required pair is unchanged, which is the property this assertion is really about.
  assert.deepEqual(Object.keys(json.properties as object).sort(), ['body', 'case_key', 'cohort', 'engine', 'episodes', 'exclusions', 'idempotency_key']);
  assert.deepEqual((json.required as string[]).sort(), ['engine', 'idempotency_key']);
});

test('§14.2: the bridge delegates validation to zod rather than reimplementing it', () => {
  const bridged = sdkSchema(toolSchemas.run_result.input) as unknown as { '~standard': { validate: (v: unknown) => { issues?: unknown[] } } };
  assert.ok(bridged['~standard'].validate({ run_id: 'not-a-uuid' }).issues, 'a bad uuid is rejected');
  assert.equal(bridged['~standard'].validate({ run_id: '11111111-2222-3333-4444-555555555555' }).issues, undefined);
});

test('§14.2: optional and defaulted fields are not advertised as required', () => {
  const json = toJsonSchema(toolSchemas.run_result.input);
  assert.deepEqual(json.required, ['run_id'], 'limit and offset carry defaults, so they are optional');
});

/**
 * LAB-MCP-V2 §17.7 round C3 — `failure_cluster` (decisions 96, 97 round).
 *
 * ⚠️ DECISION 87 THROUGHOUT. Every fixture below is written by the PRODUCTION WRITERS — `submitRun`
 * creates the run and its items, `claim` opens the attempt, `openCall` writes the call row, and
 * `finish` writes `state`, the three statuses and the error object, exactly as `worker.ts` builds
 * it. Nothing here inserts an item or an error by hand, because the whole tool is a read of shapes
 * those writers produce and a fixture that invented the shape would test nothing.
 *
 * ⚠️ AND THE ERROR SHAPES ARE `worker.ts:216-232` VERBATIM. Five categories — `cancelled`, `budget`,
 * `model`, `isolation`, `provider` — and the `cancelled` branch is the odd one: it writes
 * `{category, message}` with NO `code`. A test pins the list against that file's source.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { embedded, type Db } from '../db';
import {
  applyMigrations, claim, ensureBudget, finish, openCall, submitRun,
} from '../store';
import {
  CLUSTER_BASIS, FAILED_ITEMS_SQL, MESSAGE_HEAD_CHARS, SCAN_CEILING, failureCluster, messageHead,
} from '../tools/cluster';
import { BY_NAME } from '../registry';

const ROOT = process.cwd();

function migrationFiles() {
  const dir = join(ROOT, 'migrations', 'lab-v2');
  return readdirSync(dir).filter((f) => f.endsWith('.sql')).sort().map((name) => {
    const sql = readFileSync(join(dir, name), 'utf8');
    return { name, sql, checksum: createHash('sha256').update(sql).digest('hex') };
  });
}

async function storeDb(): Promise<Db> {
  const db = await embedded();
  await applyMigrations(db, migrationFiles());
  return db;
}

interface Spec {
  case_key: string;
  engine?: string;
  stage?: string | null;
  error?: Record<string, unknown> | null;
  execution?: string;
  assessment?: string;
  attribution?: string;
}

/**
 * A run whose items are driven through the real claim → (call) → finish path.
 *
 * ⚠️ `claim` TAKES THE OLDEST QUEUED ITEM, so the specs are applied in `case_key` order rather than
 * assumed to line up: the fixture reads back which item it just claimed and looks up its spec.
 */
async function failedRun(db: Db, specs: Spec[], runKey = 'r1'): Promise<string> {
  const budget = await ensureBudget(db, 'research', 'c3', 1_000_000);
  const { run } = await submitRun(
    db, 'research', 'experiment_run', null, budget.id, runKey, 'h', 86_400_000,
    specs.map((sp) => ({
      case_key: sp.case_key, arm_hash: 'arm-a', repetition: 0,
      payload: { engine: sp.engine ?? 'opd_note_audit', frozen: {} },
    })),
  );
  const byCase = new Map(specs.map((sp) => [sp.case_key, sp]));
  for (let n = 0; n < specs.length; n += 1) {
    const item = await claim(db, `worker-${runKey}`);
    if (!item) break;
    const sp = byCase.get(item.case_key)!;
    if (sp.stage) {
      // The production writer for a call row — this is where `failure_cluster`'s "last stage" comes
      // from, and there is no stage on the item or in the error.
      await openCall(db, item.id, item.lease_token, sp.stage, budget.id, { model: 'm' }, 100, 'v1', 'reserved');
    }
    await finish(db, item.id, item.lease_token, {
      state: 'failed',
      result: null,
      error: sp.error === undefined ? { category: 'provider', code: 'PROVIDER_ERROR', message: 'the provider was unreachable' } : sp.error,
      execution_status: sp.execution ?? 'failed',
      assessment_status: sp.assessment ?? 'not_reached',
      attribution_status: sp.attribution ?? 'unknown',
      outcome: 'failed',
    });
  }
  return run.id;
}

const err = (category: string, message: string, code: string | null = 'X') =>
  ({ category, code, message });

// ─────────────────────────────────────────────────────────────────────────────────────
// The statement, and the shapes it is written against
// ─────────────────────────────────────────────────────────────────────────────────────

test('§17.7 C3: the one read is a bounded SELECT over lab_v2 only, and is not a write', () => {
  assert.match(FAILED_ITEMS_SQL, /^SELECT/);
  assert.ok(/\bLIMIT \$3\b/.test(FAILED_ITEMS_SQL), 'bounded by the scan ceiling, as a parameter');
  for (const verb of ['INSERT', 'UPDATE', 'DELETE', 'ALTER', 'DROP', 'TRUNCATE']) {
    assert.ok(!new RegExp(`\\b${verb}\\b`).test(FAILED_ITEMS_SQL), `the read contains ${verb}`);
  }
  // ⚠️ lab_v2 ONLY. This tool must never reach a production clinical table.
  const tables = [...FAILED_ITEMS_SQL.matchAll(/\b(?:FROM|JOIN)\s+([a-z0-9_.]+)/g)].map((m) => m[1]);
  assert.deepEqual([...new Set(tables)].sort(), ['lab_v2.attempts', 'lab_v2.calls', 'lab_v2.items', 'lab_v2.runs']);
  // The three statuses are a DISJUNCTION — §9 says they are independent.
  assert.match(FAILED_ITEMS_SQL, /execution_status = 'failed'\s*\n?\s*OR i\.assessment_status = 'unassessable'\s*\n?\s*OR i\.attribution_status = 'invalid'/);
});

test('§17.7 C3 grounding: the five error categories are worker.ts’s, and `cancelled` carries no code', () => {
  const worker = readFileSync(join(ROOT, 'lib/lab-v2/worker.ts'), 'utf8');
  for (const c of ['cancelled', 'budget', 'model', 'isolation', 'provider']) {
    assert.ok(worker.includes(`'${c}'`), `worker.ts no longer writes category ${c}`);
  }
  // The cancelled branch, verbatim — it is the one that writes no `code`, and a cluster key that
  // assumed a code was always present would have grouped every cancellation under undefined.
  assert.match(worker, /error = \{ category: 'cancelled', message: err\.message \};/);
  assert.match(worker, /message: String\(err\.message\)\.slice\(0, 500\)/, 'messages are capped at 500 characters');
  // ⚠️ AND `finish` IS THE ONLY WRITER OF items.error. `reap` sets state and the three statuses and
  // never touches error, so an expired item has none — which is why "no error object" is a total.
  const store = readFileSync(join(ROOT, 'lib/lab-v2/store.ts'), 'utf8');
  assert.equal((store.match(/SET state = \$3, result = \$4::jsonb, error = \$5::jsonb/g) ?? []).length, 1);
  assert.ok(!/state = 'expired'[\s\S]{0,200}error =/.test(store), 'reap must not write an error object');
});

test('§17.7 C3: the message head is the FIRST line, trimmed, and absence stays absent', () => {
  assert.equal(messageHead('provider timed out\n  at Foo (bar.ts:1)'), 'provider timed out');
  assert.equal(messageHead(null), null);
  assert.equal(messageHead('   '), null);
  assert.equal(messageHead('x'.repeat(400))!.length, MESSAGE_HEAD_CHARS);
});

// ─────────────────────────────────────────────────────────────────────────────────────
// The grouping — every fixture written by the production writers (decision 87)
// ─────────────────────────────────────────────────────────────────────────────────────

test('§17.7 C3: three failures sharing a category and first line are ONE group; a fourth is another', async () => {
  const db = await storeDb();
  await failedRun(db, [
    { case_key: 'a1', stage: 'analysis', error: err('provider', 'upstream 503 from the gateway\n  at call (x.ts:1)') },
    { case_key: 'a2', stage: 'analysis', error: err('provider', 'upstream 503 from the gateway\n  at call (y.ts:9)') },
    { case_key: 'a3', stage: 'analysis', error: err('provider', 'upstream 503 from the gateway') },
    { case_key: 'b1', stage: 'analysis', error: err('provider', 'request timed out after 60s') },
  ]);
  const out = await failureCluster(db, { window_hours: 24 });

  assert.equal(out.model_calls, 0);
  assert.equal(out.totals.items_considered, 4);
  assert.equal(out.totals.items_grouped, 4);
  assert.equal(out.totals.groups, 2);
  assert.equal(out.totals.runs, 1);
  assert.equal(out.groups[0].items, 3, 'ordered by count desc');
  assert.equal(out.groups[0].key.message_head, 'upstream 503 from the gateway',
    'the stack line differs on two of the three and must not split them');
  assert.equal(out.groups[0].key.category, 'provider');
  assert.equal(out.groups[0].key.stage, 'analysis');
  assert.equal(out.groups[0].key.engine, 'opd_note_audit');
  assert.equal(out.groups[0].runs, 1);
  assert.equal(out.groups[0].examples.length, 3, 'three examples, and no more');
  assert.deepEqual(out.groups[0].examples.map((e) => e.case_key).sort(), ['a1', 'a2', 'a3']);
  assert.equal(out.groups[1].items, 1);
  assert.equal(out.groups[1].key.message_head, 'request timed out after 60s');
  assert.ok(out.groups[0].first_seen && out.groups[0].last_seen);
  assert.ok(out.groups[0].first_seen! <= out.groups[0].last_seen!);
  assert.equal(out.basis, CLUSTER_BASIS);
});

test('§17.7 C3: an item with NO error object is counted in the totals and grouped under null', async () => {
  const db = await storeDb();
  await failedRun(db, [
    { case_key: 'a1', stage: 'analysis', error: err('provider', 'upstream 503') },
    // ⚠️ THE ADAPTER-RETURNED FAILURE. `opd.ts` returns execution_status 'failed' without throwing
    // when the frozen inputs do not parse, so `finish` writes a null error. This item is the one a
    // cluster report loses most easily.
    { case_key: 'a2', stage: 'analysis', error: null },
    { case_key: 'a3', stage: null, error: null },
  ]);
  const out = await failureCluster(db, { window_hours: 24 });
  assert.equal(out.totals.items_considered, 3);
  assert.equal(out.totals.items_grouped, 3, 'nothing is dropped');
  assert.equal(out.totals.items_without_error, 2);
  const nullGroups = out.groups.filter((g) => g.key.category === null);
  assert.equal(nullGroups.length, 2, 'null category, split by stage — one had a call, one did not');
  for (const g of nullGroups) assert.equal(g.key.message_head, null, 'null, never a stand-in label');
});

test('§17.7 C3: the last stage comes from lab_v2.calls, and is null when the item never called', async () => {
  const db = await storeDb();
  const budget = await ensureBudget(db, 'research', 'c3', 1_000_000);
  const { run } = await submitRun(db, 'research', 'experiment_run', null, budget.id, 'stages', 'h', 86_400_000,
    [{ case_key: 'z1', arm_hash: 'arm-a', repetition: 0, payload: { engine: 'opd_note_audit', frozen: {} } }]);
  const item = (await claim(db, 'w-stage'))!;
  // Two calls: the LAST one is the stage a reader wants — where it got to, not where it started.
  // ⚠️ The first is aged by a second before the second is written. `lab_v2.calls` has no sequence
  // column and `id` is a random uuid, so `created_at` is the only ordering there is; two calls in
  // the same instant would tie. In production a stage IS a model call and two are seconds apart, so
  // the fixture reproduces that rather than demanding a guarantee the table does not make.
  await openCall(db, item.id, item.lease_token, 'analysis', budget.id, { model: 'm' }, 100, 'v1', 'reserved');
  await db.query(`UPDATE lab_v2.calls SET created_at = created_at - interval '1 second' WHERE item_id = $1`, [item.id]);
  await openCall(db, item.id, item.lease_token, 'verification', budget.id, { model: 'm' }, 100, 'v1', 'reserved');
  await finish(db, item.id, item.lease_token, {
    state: 'failed', result: null, error: err('model', 'model not supported'),
    execution_status: 'failed', assessment_status: 'not_reached', attribution_status: 'unknown', outcome: 'failed',
  });
  assert.ok(run.id);

  const out = await failureCluster(db, { window_hours: 24 });
  assert.equal(out.groups[0].key.stage, 'verification');

  // And an item that never reached a provider has a null stage, not a guessed one.
  await failedRun(db, [{ case_key: 'z2', stage: null, error: err('isolation', 'LAB_IO_FORBIDDEN') }], 'nocall');
  const out2 = await failureCluster(db, { window_hours: 24 });
  const iso = out2.groups.find((g) => g.key.category === 'isolation')!;
  assert.equal(iso.key.stage, null);
});

test('§17.7 C3: the three statuses are an OR — an unassessable or invalid item is in scope', async () => {
  const db = await storeDb();
  await failedRun(db, [
    // Succeeded execution, but the engine declared the case unanswerable.
    { case_key: 'u1', stage: 'analysis', error: null, execution: 'succeeded', assessment: 'unassessable', attribution: 'verified' },
    // Succeeded and assessed, but the call cannot be attributed to a receipt.
    { case_key: 'v1', stage: 'analysis', error: null, execution: 'succeeded', assessment: 'assessed', attribution: 'invalid' },
    // Fully clean — must NOT appear.
    { case_key: 'ok', stage: 'analysis', error: null, execution: 'succeeded', assessment: 'assessed', attribution: 'verified' },
  ]);
  const out = await failureCluster(db, { window_hours: 24 });
  assert.equal(out.totals.items_considered, 2);
  const keys = out.groups.flatMap((g) => g.examples.map((e) => e.case_key)).sort();
  assert.deepEqual(keys, ['u1', 'v1']);
  const u = out.groups.flatMap((g) => g.examples).find((e) => e.case_key === 'u1')!;
  assert.equal(u.execution_status, 'succeeded', 'the three statuses travel with the example, never flattened');
  assert.equal(u.assessment_status, 'unassessable');
});

test('§17.7 C3: the window excludes an older item, and the engine filter narrows', async () => {
  const db = await storeDb();
  await failedRun(db, [{ case_key: 'old', stage: 'analysis', error: err('provider', 'ancient') }], 'old');
  // Age it by moving the attempt's end AND the run's creation — the two the window reads.
  await db.query(`UPDATE lab_v2.attempts SET ended_at = now() - interval '30 hours'`);
  await db.query(`UPDATE lab_v2.runs SET created_at = now() - interval '30 hours'`);
  await failedRun(db, [
    { case_key: 'new', stage: 'analysis', error: err('provider', 'recent') },
    { case_key: 'ipd', engine: 'ipd_episode', stage: 'judge', error: err('provider', 'recent') },
  ], 'new');

  const narrow = await failureCluster(db, { window_hours: 24 });
  assert.equal(narrow.totals.items_considered, 2, 'the 30-hour-old failure is out of a 24-hour window');
  const wide = await failureCluster(db, { window_hours: 168 });
  assert.equal(wide.totals.items_considered, 3, 'and in a 7-day one');

  const opd = await failureCluster(db, { window_hours: 168, engine: 'opd_note_audit' });
  assert.deepEqual([...new Set(opd.groups.map((g) => g.key.engine))], ['opd_note_audit']);
  assert.equal(opd.totals.items_considered, 2);
});

test('§17.7 C3: `limit` bounds the GROUPS returned, and the scan ceiling is reported', async () => {
  const db = await storeDb();
  await failedRun(db, [
    { case_key: 'g1', stage: 'analysis', error: err('provider', 'one') },
    { case_key: 'g2', stage: 'analysis', error: err('provider', 'two') },
    { case_key: 'g3', stage: 'analysis', error: err('provider', 'three') },
  ]);
  const out = await failureCluster(db, { window_hours: 24, limit: 2 });
  assert.equal(out.totals.groups, 3, 'three groups exist');
  assert.equal(out.totals.groups_returned, 2, 'two were returned');
  assert.equal(out.groups.length, 2);
  assert.equal(out.totals.items_grouped, 3, 'the totals describe everything scanned, not the page');
  assert.equal(out.totals.scan_ceiling, SCAN_CEILING);
  assert.equal(out.totals.truncated, false);
});

test('§17.7 C3: failure_cluster is registered research_read, read, free, slice C-3', () => {
  const spec = BY_NAME.failure_cluster;
  assert.ok(spec);
  assert.deepEqual([...spec.scopes], ['research_read']);
  assert.equal(spec.effect, 'read');
  assert.equal(spec.cost_class, 'free');
  assert.equal(spec.slice, 'C-3');
});

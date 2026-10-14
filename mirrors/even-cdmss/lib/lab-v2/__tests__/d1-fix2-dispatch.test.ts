/**
 * LAB-MCP-V2 §17.8 round D1 fix 2 — `dataset_create` for the two Slice D engines, decision 109.
 *
 * ⚠️ EVERY TEST HERE GOES THROUGH `callTool`, AND THAT IS THE WHOLE POINT OF THE FIX.
 *
 * D1 shipped `freezeReadmissionFinding` and `freezePreopEpisode` and wired NEITHER into the
 * service. `grep readmission lib/lab-v2/service.ts` returned nothing. D1's own tests called the two
 * freezes directly, so 4,649 tests were green while the only path a caller has did not exist — the
 * operator key got decision 34's refusal, from a line decision 105 had already superseded.
 *
 * Standing rule from decision 109, and the reason this file is separate from `d1-engines.test.ts`:
 * EVERY NEW TOOL PATH GETS AT LEAST ONE TEST THROUGH SERVICE DISPATCH, not only through its
 * functions. A green function is not a reachable feature.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { freshDb } from './helpers';
import { callTool } from '../service';
import { IDENTIFYING_PRINCIPALS_ENV, LabError } from '../contracts';
import { identifyingKeys } from '../sources/requests';
import { getObject } from '../store';
import { PSEUDONYM_PREFIX } from '../sources/preop';
import type { Db } from '../db';

const deps = (db: Db, principal: 'research' | 'operator' = 'operator') =>
  ({ db, principal, protocolVersion: 'test', sdkVersion: 'test' }) as never;

/** Decision 105's env, set for the duration of one test and restored after it. */
async function asIdentifyingOperator<T>(fn: () => Promise<T>): Promise<T> {
  const before = process.env[IDENTIFYING_PRINCIPALS_ENV];
  const salt = process.env.LAB_V2_MEMBER_SALT;
  process.env[IDENTIFYING_PRINCIPALS_ENV] = 'operator';
  process.env.LAB_V2_MEMBER_SALT = salt ?? 'd1-fix2-salt';
  try { return await fn(); } finally {
    if (before === undefined) delete process.env[IDENTIFYING_PRINCIPALS_ENV];
    else process.env[IDENTIFYING_PRINCIPALS_ENV] = before;
    if (salt === undefined) delete process.env.LAB_V2_MEMBER_SALT;
    else process.env.LAB_V2_MEMBER_SALT = salt;
  }
}

// ─────────────────────────────────────────────────────────────────────────────────────
// The two engines, through dispatch
// ─────────────────────────────────────────────────────────────────────────────────────

/**
 * ⚠️ THE FREEZES REACH PRODUCTION, so these two tests assert what dispatch does with what the
 * freeze RETURNS rather than mocking the service. With no `DATABASE_URL` the readmission read
 * fails and the preop episode is not found, and dispatch must turn each into a NAMED refusal that
 * carries no identifier — which is itself the decision 99 property on the error path, the one an
 * exclusion list would otherwise leak through.
 */
test('§17.8 decision 109: dataset_create for readmission is REACHABLE from the operator key', async () => {
  const db = await freshDb();
  await asIdentifyingOperator(async () => {
    let err: LabError | null = null;
    try {
      await callTool(deps(db), 'dataset_create', {
        engine: 'readmission', body: { dedup_key: 'RX-1|RX-2' }, idempotency_key: 'd109-r1',
      });
    } catch (e) { err = e as LabError; }

    assert.ok(err, 'the sandbox has no production database, so the freeze cannot succeed here');
    // ⚠️ AND THE POINT IS WHICH REFUSAL. Not decision 34's blanket, and not the decision 105 gate:
    // the operator PASSED both and reached the freeze, which is exactly what this fix restores.
    assert.ok(!/requires identifying input until Slice D/.test(err!.message), 'never decision 34’s text');
    assert.ok(!/data_scope/.test(err!.message), 'nor the decision 105 gate — the operator passed it');
    assert.equal(err!.code, 'SOURCE_UNAVAILABLE', 'it reached the freeze and the freeze had no database');
    // ⚠️ DECISION 99 ON THE ERROR PATH. The message names how many were excluded and never the
    // dedup_key that failed.
    assert.ok(!err!.message.includes('RX-1'), 'the identifier is not echoed back');
  });
  await db.close();
});

test('§17.8 decision 109: dataset_create for preop is REACHABLE, and the cohort form too', async () => {
  const db = await freshDb();
  await asIdentifyingOperator(async () => {
    for (const args of [
      { engine: 'preop', body: { episodeKey: 'SC-1' }, idempotency_key: 'd109-p1' },
      { engine: 'preop', cohort: { case_keys: ['SC-1', 'SC-2'] }, idempotency_key: 'd109-p2' },
    ]) {
      let err: LabError | null = null;
      try { await callTool(deps(db), 'dataset_create', args); } catch (e) { err = e as LabError; }
      assert.ok(err, 'no db13 in the sandbox');
      assert.ok(!/requires identifying input until Slice D/.test(err!.message));
      assert.equal(err!.code, 'SOURCE_UNAVAILABLE');
      assert.ok(!err!.message.includes('SC-1'), 'the episode key is not echoed back');
    }
    // Neither shape supplied is an INVALID_INPUT that names what is missing, not a crash.
    await assert.rejects(
      () => callTool(deps(db), 'dataset_create', { engine: 'preop', idempotency_key: 'd109-p3' }),
      (e: LabError) => e.code === 'INVALID_INPUT' && /episodeKey/.test(e.message));
    await assert.rejects(
      () => callTool(deps(db), 'dataset_create', { engine: 'readmission', idempotency_key: 'd109-r3' }),
      (e: LabError) => e.code === 'INVALID_INPUT' && /dedup_key/.test(e.message));
  });
  await db.close();
});

/**
 * The stored object, asserted on the shape dispatch actually assembles. The freeze is injected here
 * because the sandbox has no production database — but the ASSEMBLY, the decision 99 walk, the
 * schema parse and `putObject` are the service's own, which is the half that was missing.
 */
test('§17.8 decision 109: the stored dataset carries member_key BESIDE frozen, and no denylist key', async () => {
  const db = await freshDb();
  const { putObject } = await import('../store');
  const { datasetBodySchema } = await import('../contracts');

  // The exact shape `sliceDDataset` builds, from a frozen case the D1 freezes produce.
  const frozen = {
    engine: 'preop',
    sources: {
      fetchUpcomingEpisodes: { rows: [{ personRef: `${PSEUDONYM_PREFIX}aaaa`, personAltRef: `${PSEUDONYM_PREFIX}bbbb`, episodeRef: `${PSEUDONYM_PREFIX}cccc`, surgeryName: 'Total knee replacement' }], error: null },
      // ⚠️ DECISION 111 — the directory's `uid` is now `facilityRef`, matching the episode's
      // renamed `hospitalUid` so the join at run.ts:529 still lands. The VALUE is real: a facility
      // is not a person.
      fetchHospitalNames: { rows: [{ facilityRef: 'H-1', label: 'Even Hospital' }], error: null },
    },
    horizon_days: 60, now: '2026-09-07T00:00:00.000Z',
  };
  const body = datasetBodySchema.parse({
    engine: 'preop',
    cases: [{ case_key: 'preop:deadbeef', member_key: 'a'.repeat(64), frozen }],
    snapshot_policy: 'episode_at_creation', exclusions: [], classification: 'deidentified',
    source_versions: { origin: 'db13 via lib/preop/db13.ts' }, replay_exactness: 'frozen',
  });
  const { object } = await putObject(db, 'operator', 'dataset', body, 'deidentified', 'd109-stored');
  const stored = (await getObject(db, object.id))!.body as { cases: { case_key: string; member_key: string; frozen: unknown }[] };

  const c = stored.cases[0];
  // ⚠️ BESIDE, NEVER INSIDE. `member_key` is a sibling of `frozen`, which is what lets decision 99's
  // walk run over `frozen` alone — the one durable link to a person lives outside the body a replay
  // reads. (`member_key` is itself on the denylist, by the person-group's `key` suffix.)
  assert.match(c.member_key, /^[0-9a-f]{64}$/);
  assert.deepEqual(identifyingKeys(c.frozen), [], 'the frozen body carries no denylist key');
  assert.ok(!('member_key' in (c.frozen as Record<string, unknown>)));
  // Decision 106 — the three surrogates carry the px: prefix.
  const ep = (c.frozen as { sources: Record<string, { rows: Record<string, unknown>[] }> }).sources.fetchUpcomingEpisodes.rows[0];
  for (const k of ['personRef', 'personAltRef', 'episodeRef']) {
    assert.match(String(ep[k]), new RegExp(`^${PSEUDONYM_PREFIX}`), `${k} is a surrogate`);
  }
  assert.equal(ep.surgeryName, 'Total knee replacement', 'the clinical values are untouched');
  await db.close();
});

test('§17.8 decision 109: engine_describe names the frozen inputs dispatch actually freezes', async () => {
  const db = await freshDb();
  for (const [engine, expected] of [
    // Rule 1a / decision 114: `steps` is a frozen input of this engine now — the adapter reads it
    // to decide exact vs fresh (`adapters/readmission.ts`), exactly as `ipd-episode.ts:109` does —
    // so `engine_describe` names it or it under-reports what a dataset must carry.
    ['readmission', ['row', 'inputs', 'index_discharge_at', 'steps']],
    ['preop', ['sources', 'horizon_days', 'now']],
  ] as const) {
    const out = await callTool(deps(db), 'engine_describe', { engine }) as {
      supported: boolean; identifying_input: boolean; frozen_inputs: string[]; stages: { name: string }[];
    };
    assert.equal(out.supported, true);
    assert.equal(out.identifying_input, true);
    assert.deepEqual(out.frozen_inputs, [...expected], `${engine}'s frozen inputs`);
    assert.ok(out.stages.length > 0);
  }
  await db.close();
});

// ─────────────────────────────────────────────────────────────────────────────────────
// The refusal a principal without the attribute gets
// ─────────────────────────────────────────────────────────────────────────────────────

test('§17.8 decision 109: research is refused by decision 105, naming the principal and the env var', async () => {
  const db = await freshDb();
  await asIdentifyingOperator(async () => {
    let err: LabError | null = null;
    try {
      await callTool(deps(db, 'research'), 'dataset_create', {
        engine: 'readmission', body: { dedup_key: 'RX-1|RX-2' }, idempotency_key: 'd109-res',
      });
    } catch (e) { err = e as LabError; }
    assert.ok(err);
    assert.equal(err!.code, 'CLASSIFICATION_REQUIRED');
    // ⚠️ THE DECISION 105 TEXT, NOT DECISION 34's. The difference is what a reader does next: 34's
    // said "wait for Slice D", which is now false and unactionable; 105's names the principal, the
    // scope it needs and the env var that grants it.
    assert.ok(err!.message.includes("'research'"), 'names the principal');
    assert.ok(err!.message.includes(IDENTIFYING_PRINCIPALS_ENV), 'names the env var');
    assert.ok(err!.message.includes('readmission'), 'and the engine');
    assert.ok(/data_scope 'deidentified'/.test(err!.message));
    assert.ok(!/requires identifying input until Slice D/.test(err!.message), 'never decision 34’s text');
    // And it is refused BEFORE the handler, so the identifier is never read into a freeze.
    assert.ok(!err!.message.includes('SOURCE_UNAVAILABLE'));
  });
  await db.close();
});

test('§17.8 decision 109: decision 34’s refusal string appears nowhere in service.ts', () => {
  const src = readFileSync(join(process.cwd(), 'lib/lab-v2/service.ts'), 'utf8');
  assert.ok(!src.includes('requires identifying input until Slice D'),
    'the blanket refusal decision 105 superseded must be gone, comments included');
  // ⚠️ AND THE HANDLER MUST NOT HAVE GROWN A REPLACEMENT. `requiresIdentifyingInput` is still
  // imported and still used — by `callCarriesIdentifyingInput` (the decision 105 gate) and by
  // `engine_describe` (which REPORTS it) — but never again as a throw inside dataset_create.
  // ⚠️ COMMENTS STRIPPED, the same rule the decision 79 grep uses: this handler now carries a note
  // recording WHICH two lines were removed and why, and prose about a removed refusal is not a
  // refusal. What is scanned is code.
  const create = src.slice(src.indexOf('async dataset_create('), src.indexOf('async dataset_preview('))
    .replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  assert.ok(!create.includes('requiresIdentifyingInput'), 'dataset_create no longer decides on it');
  assert.ok(create.includes("engine === 'readmission' || engine === 'preop'"), 'and it has the two branches');
  // The two freezes are wired in — the thing whose absence was the second cause.
  assert.match(src, /import \{ freezeReadmissionFinding \} from '\.\/sources\/readmission'/);
  assert.match(src, /import \{ freezePreopEpisode \} from '\.\/sources\/preop'/);
});

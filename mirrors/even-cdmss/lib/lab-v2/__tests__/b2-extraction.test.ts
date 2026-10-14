/**
 * LAB-MCP-V2 §17.5 step 1 — decision 47's extraction, and the witness that it changed nothing.
 *
 * "The pipeline moves VERBATIM" is a claim about 581 lines of code. This file is the evidence for
 * it, in two independent forms:
 *
 *   BEHAVIOUR  `episode-preimage.json` was captured by running `lib/ipd-episode/run.ts` AS IT
 *              STOOD AT 2c5d03a7 — git blob d54549f91b5bf379ce872cded9fcd05da2347d71 — on the
 *              synthetic episode in `fixtures/episode-fixture.ts`, with its four data modules
 *              re-pointed at stubs and NOTHING else altered. The first test below runs the same
 *              episode through `computeEpisodeAudit` and demands the same answer: the same result,
 *              the same skip ledger, the same audit row, the same three checkpoint write rows, the
 *              same two model calls in the same order.
 *
 *   STRUCTURE  the tests after it pin what moved and what did not, so a future edit that quietly
 *              re-inlines a dependency, or drops one of the six exports decision 56 froze, fails
 *              here rather than in production.
 *
 * ⚠️ THE PREIMAGE IS NOT REGENERATED FROM `compute.ts`. If it were, this file would assert that
 * the code agrees with itself. It is a fossil of the pre-extraction engine and the only way to
 * make a failing comparison pass is to make `compute.ts` behave like `run.ts` did.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { withLabExecution } from '../../lab-execution-context';
import { computeEpisodeAudit, type EpisodeComputeDependencies } from '../../ipd-episode/compute';
import { FIXTURE_ENCOUNTER, fixtureDeps, fixtureLedger, stripTimings } from './fixtures/episode-fixture';

const src = (p: string) => readFileSync(join(process.cwd(), p), 'utf8');
const PREIMAGE = JSON.parse(src('lib/lab-v2/__tests__/fixtures/episode-preimage.json')) as {
  result: unknown; ledger: unknown; chatCalls: string[];
};

/** The two judge passes, answered without a provider. `{"findings": []}` is a LEGITIMATE result —
 *  a concordant admission — so this exercises the whole success path rather than a failure path. */
async function replayFixture() {
  const ledger = fixtureLedger();
  const chatCalls: string[] = [];
  const chat = async (label: string) => {
    chatCalls.push(label);
    return { choices: [{ finish_reason: 'stop', message: { content: '{"findings": []}' } }] };
  };
  const result = await withLabExecution(
    { chat, retrieve: async () => ({ hits: [], expandedQuery: '', meta: {} }), event: () => {} },
    () => computeEpisodeAudit(
      fixtureDeps(ledger) as unknown as EpisodeComputeDependencies,
      { encounterId: FIXTURE_ENCOUNTER, deadlineAt: null },
    ),
  );
  return { result, ledger, chatCalls };
}

test('decision 47: compute.ts answers the pre-extraction run.ts, field for field', async () => {
  const { result, ledger, chatCalls } = await replayFixture();
  assert.deepEqual(stripTimings(result), PREIMAGE.result,
    'the episode result differs from what run.ts returned at 2c5d03a7');
  assert.deepEqual(stripTimings(ledger), PREIMAGE.ledger,
    'the writes differ: a different skip, a different audit row, or different checkpoint rows');
  assert.deepEqual(chatCalls, PREIMAGE.chatCalls, 'the model calls differ in number or in order');
  // The comparison is worth something only if the fixture actually reached the end of the
  // pipeline. Assert that it did, so a future fixture that skips at stage 1 cannot pass vacuously.
  const l = ledger as ReturnType<typeof fixtureLedger>;
  assert.equal((result as { status?: string }).status, 'inserted');
  assert.equal(l.saved.length, 1, 'one audit row was written');
  assert.equal(l.saved[0].checkpoints.length, 3, 'three checkpoint rows carry the blinding proof');
  assert.deepEqual(l.skips.map((s) => s.reason), ['in_progress'], 'the in-progress marker, and no other skip');
  assert.deepEqual(l.cleared, [FIXTURE_ENCOUNTER], 'and it was cleared on success');
});

test('decision 47: the pipeline is in compute.ts and no longer in run.ts', () => {
  const compute = src('lib/ipd-episode/compute.ts');
  const run = src('lib/ipd-episode/run.ts');
  // The seven stages, by their landmarks.
  for (const landmark of [
    'await assembleEpisode({', 'await mapWithLimit(plan, CHECKPOINT_CONCURRENCY, buildCheckpoint)',
    'await runDiffPass({', 'await runFidelityPass({', 'await saveEpisodeAudit(',
    "reason: 'in_progress'", 'const diagnosticsNow =',
  ]) {
    assert.ok(compute.includes(landmark), `compute.ts must carry ${landmark}`);
    assert.ok(!run.includes(landmark), `run.ts must no longer carry ${landmark}`);
  }
  // The composition is a composition: one call, no stages of its own.
  assert.ok(run.includes('return computeEpisodeAudit(LIVE_DEPS, input);'));
  // comments stripped first — the file header names the function too, and a prose mention is not
  // a call site. Same stripping the IPD contract suite's own `code()` helper applies.
  const runCode = run.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  assert.equal((runCode.match(/computeEpisodeAudit\(/g) ?? []).length, 1, 'exactly one call site');
});

test('decision 47: EpisodeComputeDependencies is exactly the eight names, and run.ts supplies all eight', () => {
  const compute = src('lib/ipd-episode/compute.ts');
  const run = src('lib/ipd-episode/run.ts');
  const block = compute.slice(compute.indexOf('export interface EpisodeComputeDependencies'));
  const iface = block.slice(0, block.indexOf('\n}\n'));
  const EIGHT = [
    'fetchDischargeSummary', 'fetchProgressNotes', 'fetchExtractionByIpUid', 'assembleEpisode',
    'recordSkip', 'clearSkip', 'saveEpisodeAudit', 'checkpoint',
  ];
  for (const name of EIGHT) assert.ok(new RegExp(`^\\s{2}(/\\*\\*.*\\*/\\s*)?${name}[:?]`, 'm').test(iface), `${name} is a declared dependency`);
  assert.equal((iface.match(/^ {2}[a-zA-Z]+[:?]/gm) ?? []).length, EIGHT.length,
    'a ninth dependency is a second, unmetered way to reach production — see the header');
  // The live composition binds every one of them, and binds them to the real functions.
  const live = run.slice(run.indexOf('const LIVE_DEPS'), run.indexOf('export async function runEpisodeAudit'));
  for (const name of EIGHT.filter((n) => n !== 'checkpoint')) {
    assert.ok(new RegExp(`^\\s+${name},`, 'm').test(live), `LIVE_DEPS binds ${name} to the live function`);
  }
  assert.ok(live.includes('checkpoint: runCheckpoint,'), 'the checkpoint stage is the real runCheckpoint');
});

test('decision 56: run.ts keeps its whole public surface, so the worker route is untouched', () => {
  const run = src('lib/ipd-episode/run.ts');
  for (const sig of [
    'export async function runEpisodeAudit(input: RunEpisodeInput): Promise<RunEpisodeResult>',
    'export async function runEpisodeBatch(',
    'export const MAX_CANDIDATES_EXAMINED = 50;',
    'export function countsTowardMax(',
    "export const SELECTION_SKIP_REASONS = ['no_discharge_summary', 'no_notes', 'no_extraction'] as const;",
    "export type { RunEpisodeInput, RunEpisodeResult } from './compute';",
  ]) {
    assert.ok(run.includes(sig), `decision 56 froze this on run.ts: ${sig}`);
  }
  // The worker imports three of them by name. If the composition ever changed shape, this is
  // where it would be noticed — before the nightly sweep noticed it.
  const worker = src('app/api/ipd-episode/worker/route.ts');
  assert.ok(/import \{[^}]*runEpisodeAudit[^}]*\} from ['"][^'"]*ipd-episode\/run['"]/s.test(worker),
    'the worker still imports runEpisodeAudit from run.ts');
});

test('decision 47: compute.ts reaches no database of its own — every read is injected', () => {
  const compute = src('lib/ipd-episode/compute.ts');
  // The two value imports it keeps from the data modules are a CONSTANT and nothing else.
  assert.ok(compute.includes("import type { Db13Row } from './db13';"),
    'db13 is a type-only import — no reader is reachable from here');
  assert.ok(!/^import \{[^}]*\bfetchDischargeSummary\b/m.test(compute), 'no live db13 reader is imported');
  assert.ok(!/^import \{[^}]*\bsaveEpisodeAudit\b/m.test(compute), 'no live store writer is imported');
  assert.ok(!/^import \{[^}]*\brunCheckpoint\b/m.test(compute), 'no live checkpoint is imported');
  // and it never reaches production IO directly, which is what makes it runnable inside the fence
  for (const banned of ['metabaseQuery(', "from '../metabase'", "from '../db'", 'withLabExecution']) {
    assert.ok(!compute.includes(banned), `compute.ts must not reference ${banned}`);
  }
});

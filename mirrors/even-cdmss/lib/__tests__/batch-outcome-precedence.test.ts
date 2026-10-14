/**
 * lib/__tests__/batch-outcome-precedence.test.ts — PROOF 12, kickoff v11 line 1126.
 *
 *   > **`timeout` is a distinct batch outcome**, and the precedence in D15 holds when several
 *   > defects coexist.
 *
 * ⚠️ THE PRECEDENCE HAS NO SINGLE IMPLEMENTATION, AND THIS FILE ASSERTS IT THROUGH BEHAVIOUR.
 * `BATCH_OUTCOME_PRECEDENCE` in `lib/retrieval-telemetry-core.ts` is a VOCABULARY list, used once
 * to check that a batch's outcome is a known value — it orders nothing at run time. The ordering
 * lives in three separate statements of `lib/rerank.ts`, plus one helper:
 *
 *     the initialiser        `let outcome: BatchOutcome = 'success'`
 *     the parsed branch      missing > 0 ? missing_score_key : nonnumeric > 0 ? nonnumeric_score : success
 *     the catch branch       parseFailed ? parse_failure : terminalOutcomeFor(evidence)   ← turns here
 *     terminalOutcomeFor     last attempt 'timeout' ? timeout : terminal_failure
 *
 * ⚠️ NAMED, NOT NUMBERED (review 23 finding 4). Line numbers in this programme have already gone
 * stale twice; test 12.0 below locates each statement by searching for it.
 *
 * So every row below drives the real `rerankJudge` against a real socket and reads
 * `capture.batches[].outcome`. No resolver is extracted and `lib/rerank.ts` is not edited — that is
 * deferred by v12 §5, after the five proof passes.
 *
 * ⚠️ IMPORT ORDER IS LOAD-BEARING (review 22 item 8). `startJudgeServer` sets `OLLAMA_BASE_URL`,
 * `RERANK_JUDGE_MODEL` and the Gemini kill-switches, and `lib/llm.ts:41` builds its OpenAI client
 * with that base URL at MODULE EVALUATION. ESM evaluates every static import before the importing
 * module's body runs, so `rerank`, `llm` and `multi-query` are imported DYNAMICALLY, after the
 * server is listening. The same hazard is documented at `lib/__tests__/gemini-env-fixture.ts:4-11`.
 * A static `import { rerankJudge } from '../rerank'` at the top of this file would point the judge
 * at whatever `OLLAMA_BASE_URL` happened to hold — in CI, nothing.
 *
 * Proof 11 is in `attempt-taxonomy.test.ts`: it is pure, needs no server, and keeping it separate
 * keeps this file's import-ordering hazard out of it.
 */
import { test, mock, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
// ⚠️ THE ACTUAL INSTALLED SDK ERROR (v12 §3 item 2). Row 1 threw a hand-named look-alike, which is
// what hid the production defect corrected in this same pass.
import { APIConnectionTimeoutError } from 'openai';
import { startJudgeServer, type JudgeServer } from './judge-server-stub';
import type { TelemetryCapture } from '../retrieval-capture';

/** Two passages, so a response can carry one good key and one bad one — which is what rows 4 and 5
 *  need. Each carries a unique leading marker: the only thing that tells one batch from another. */
const CANDIDATES = [
  { id: 1, text: 'MRKA a clinical passage used only by this proof, numbered one.' },
  { id: 2, text: 'MRKB a clinical passage used only by this proof, numbered two.' },
];

type Booted = {
  judge: JudgeServer;
  rerankJudge: <T extends { id: number; text: string }>(
    q: string, c: T[], capture?: TelemetryCapture,
  ) => Promise<unknown>;
  createTelemetryCapture: (role: 'primary') => TelemetryCapture;
  llm: { chat: { completions: { create: (...a: unknown[]) => Promise<unknown> } } };
};

let booted: Booted | null = null;

/**
 * ⚠️ UNCONDITIONAL CLEANUP (v12 §3 item 4). A case that throws must not leak a listening socket or
 * a patched method into another file: `mock.method` patches a MODULE-LEVEL client that every later
 * import shares, and a leaked listener keeps the process alive. `after` runs whether the cases pass
 * or throw, and each case restores its own mock in a `finally` besides.
 */
after(async () => {
  mock.restoreAll();
  if (booted) { await booted.judge.close().catch(() => {}); booted = null; }
});

/**
 * Server first, dynamic imports second. Once per file.
 *
 * ⚠️ THE IMPORTS ARE GUARDED, AND THE GAP IS WHY (v13 §4 item 4, review 24). The server starts, three
 * dynamic imports run, and only then is `booted` assigned — so an import that THREW in that window
 * left a listening socket that the `after()` hook could never see, because `after` closes
 * `booted.judge` and `booted` was still null. The process then hangs on a live handle, and the
 * failure a reader sees is a timeout rather than the import error that caused it.
 *
 * The catch closes the server and rethrows the original error unchanged, so the real cause is what
 * surfaces.
 */
async function boot(): Promise<Booted> {
  if (booted) return booted;
  const judge = await startJudgeServer({ MRKA: 8, MRKB: 4 });
  try {
    const rerankMod = await import('../rerank');
    const captureMod = await import('../retrieval-capture');
    const llmMod = await import('../llm');
    booted = {
      judge,
      rerankJudge: rerankMod.rerankJudge as Booted['rerankJudge'],
      createTelemetryCapture: captureMod.createTelemetryCapture,
      llm: llmMod.llm as unknown as Booted['llm'],
    };
  } catch (e) {
    await judge.close().catch(() => {});
    throw e;
  }
  return booted;
}

/**
 * Run `fn` with the judge's raw response overridden, restoring it whether `fn` returns or throws.
 *
 * ⚠️ A `finally`, NOT THE NEXT LINE (v13 §4 item 5, review 24). Each case used to call
 * `setRawContent(null)` on the statement after the one that ran the batch, so a FAILING ASSERTION
 * between them left the responder configured — and the next case in the file, or the next file,
 * would silently receive this case's malformed body. A leaked responder makes one real failure look
 * like several unrelated ones.
 */
async function withRawContent<T>(judge: JudgeServer, body: string, fn: () => Promise<T>): Promise<T> {
  judge.setRawContent(() => body);
  try { return await fn(); } finally { judge.setRawContent(null); }
}

/** Run one judge call and return the single batch's captured record. */
async function runBatch(): Promise<{
  outcome: string; missingScoreKeys: number; nonnumericScoreKeys: number;
  finiteScoreKeys: number; expectedScoreKeys: number;
}> {
  const { rerankJudge, createTelemetryCapture } = await boot();
  const capture = createTelemetryCapture('primary');
  await rerankJudge('a clinical question', CANDIDATES, capture);
  assert.equal(capture.batches.length, 1, 'two candidates are one batch');
  const b = capture.batches[0] as unknown as {
    outcome: string; missingScoreKeys: number; nonnumericScoreKeys: number;
    finiteScoreKeys: number; expectedScoreKeys: number;
  };
  return b;
}

// ════════════════════════════════════════════════════════════════════════════════════════════════
// The executable matrix (review 22 item 9). Six rows, each executed, each reading
// `capture.batches[].outcome`. Rows 3 to 6 are served by the stub. Rows 1 and 2 cannot be — the stub
// has no failure hook and §5 forbids adding one — so each uses a deterministic method mock on the
// exported client. ORDER NO LONGER MATTERS: v12 §3 item 3 replaced row 2's closed server with a
// mock, so every case here is independently re-runnable.
// ════════════════════════════════════════════════════════════════════════════════════════════════

test('12.0 — the precedence list is a VOCABULARY, not an implementation', async () => {
  // Stated here so a reader does not go looking for the resolver this proof is asserting.
  const core = await import('../retrieval-telemetry-core');
  assert.deepEqual([...core.BATCH_OUTCOME_PRECEDENCE], [
    'timeout', 'terminal_failure', 'parse_failure', 'missing_score_key', 'nonnumeric_score', 'success',
  ]);
  const coreSrc = readFileSync('lib/retrieval-telemetry-core.ts', 'utf8');
  const uses = (coreSrc.match(/BATCH_OUTCOME_PRECEDENCE/g) || []).length;
  assert.equal(uses, 2, 'declared once, used once — as a membership check, never to order anything');

  // ⚠️ LOCATED BY SEARCH, NOT BY LINE INDEX (review 23 finding 4). The previous version indexed
  // `rerank[589]`, `[639]` and `[646]`; any edit above them would have broken this test while
  // proving nothing about the statements themselves. Each is now found wherever it sits, and the
  // ORDER of the two resolving statements is asserted by position, which is what actually matters.
  const rerank = readFileSync('lib/rerank.ts', 'utf8');
  const at = (re: RegExp, what: string): number => {
    const i = rerank.search(re);
    assert.notEqual(i, -1, `${what} is no longer in lib/rerank.ts — the precedence moved`);
    return i;
  };
  const init = at(/let outcome: BatchOutcome = 'success';/, 'the initialiser');
  const parsed = at(/outcome = missing > 0 \? 'missing_score_key' : nonnumeric > 0 \? 'nonnumeric_score' : 'success';/, 'the parsed branch');
  const caught = at(/outcome = parseFailed \? 'parse_failure' : terminalOutcomeFor\(evidence\);/, 'the catch branch');
  at(/function terminalOutcomeFor\(evidence: TransportEvidence \| null\): BatchOutcome \{/, 'terminalOutcomeFor');
  assert.ok(init < parsed && parsed < caught,
    'the initialiser precedes the parsed branch, which precedes the catch branch');
});

test('12.3 — ROW 3: a malformed completion is `parse_failure`', async () => {
  const { judge } = await boot();
  const b = await withRawContent(judge, 'this is not JSON at all', runBatch);
  assert.equal(b.outcome, 'parse_failure');
  // parse_failure PRESERVES its provider and usage — a completion arrived and cost tokens. It is
  // resolved on the same statement as terminal_failure — the catch branch — and wins there because
  // `parseFailed` was set inside the inner JSON.parse try.
  assert.equal(b.finiteScoreKeys, 0, 'nothing parsed, so nothing is finite');
});

test('12.4 — ROW 4: missing AND nonnumeric keys give `missing_score_key`, and BOTH counts survive', async () => {
  // ⚠️ THE COEXISTENCE ROW. Two defects in one response: key "0" is present but non-numeric, key
  // "1" is absent entirely. Precedence puts missing_score_key above nonnumeric_score, and D15
  // requires the independent counts to be preserved alongside the one outcome.
  const { judge } = await boot();
  const b = await withRawContent(judge, '{"0":"x"}', runBatch);
  assert.equal(b.outcome, 'missing_score_key', 'missing outranks nonnumeric');
  assert.equal(b.missingScoreKeys, 1, 'the absent key is counted');
  assert.equal(b.nonnumericScoreKeys, 1, 'AND the non-numeric one is counted, not swallowed');
  assert.equal(b.finiteScoreKeys, 0);
  assert.equal(b.expectedScoreKeys, 2);
});

test('12.5 — ROW 5: finite AND nonnumeric keys give `nonnumeric_score`', async () => {
  const { judge } = await boot();
  const b = await withRawContent(judge, '{"0":7,"1":"not-a-number"}', runBatch);
  assert.equal(b.outcome, 'nonnumeric_score');
  assert.equal(b.missingScoreKeys, 0, 'no key is absent, which is what separates this row from row 4');
  assert.equal(b.nonnumericScoreKeys, 1);
  assert.equal(b.finiteScoreKeys, 1);
});

test('12.6 — ROW 6: all finite keys give `success`', async () => {
  const { judge } = await boot();
  judge.setScores({ MRKA: 8, MRKB: 4 });
  const b = await runBatch();
  assert.equal(b.outcome, 'success');
  assert.equal(b.finiteScoreKeys, 2);
  assert.equal(b.missingScoreKeys, 0);
  assert.equal(b.nonnumericScoreKeys, 0);
});

test('12.1 — ROW 1: a REAL SDK TIMEOUT is `timeout`, not terminal_failure', async () => {
  // ⚠️ A TEST-LOCAL METHOD MOCK ON THE EXPORTED CLIENT (review 22 item 7). No wall clock, no
  // external host. The mock throws THE ACTUAL EXPORTED SDK ERROR (v12 §3 item 2) — pass 1 threw a
  // hand-named look-alike, and that fixture hid the production defect this pass corrects: the real
  // error's `name` is "Error", so the old `name`-only check never matched and this row's outcome
  // was `terminal_failure` in production while the test read `timeout`.
  //
  // The path: the throw reaches lib/llm.ts's local catch → `classifyLocalAttempt` → a `timeout`
  // attempt → it is the terminal attempt → `terminalOutcomeFor` resolves `timeout`.
  const { llm } = await boot();
  mock.method(llm.chat.completions, 'create', async () => {
    throw new APIConnectionTimeoutError({ message: 'Request timed out.' });
  });
  try {
    const b = await runBatch();
    assert.equal(b.outcome, 'timeout', 'a timeout must be its own outcome');
    assert.notEqual(b.outcome, 'terminal_failure');
    // The scores were never produced, so every expected key is counted missing — and the outcome is
    // still `timeout`, because the catch branch resolves before the missing-key branch can apply.
    assert.equal(b.missingScoreKeys, 2);
    assert.equal(b.finiteScoreKeys, 0);
  } finally {
    mock.restoreAll();
  }
});

test('12.2 — ROW 2: a generic exhausted transport is `terminal_failure`', async () => {
  // ⚠️ A METHOD MOCK, NOT A CLOSED SERVER (v12 §3 item 3). Pass 1 closed the loopback server to
  // force ECONNREFUSED, which made this the only case that could not be re-run, forced it to run
  // LAST, and left a server lifecycle inside a test file. A plain `Error` with no status and no
  // timeout identity reaches the same classification deterministically, and row order stops
  // mattering — this file's cases can now run in any order.
  //
  // This is the CONTRAST that makes row 1 mean something: same code path, same resolver line, and
  // the ONLY difference is what the transport declared about itself.
  const { llm } = await boot();
  mock.method(llm.chat.completions, 'create', async () => { throw new Error('socket hang up'); });
  try {
    const b = await runBatch();
    assert.equal(b.outcome, 'terminal_failure');
    assert.notEqual(b.outcome, 'timeout', 'an undeclared transport failure is not a timeout');
    assert.equal(b.finiteScoreKeys, 0);
  } finally {
    mock.restoreAll();
  }
});

test('12.7 — the outcomes the six rows ACTUALLY produced are six distinct committed values', async () => {
  // ⚠️ REWRITTEN (v12 §3 item 6, review 23 finding 3). This hard-coded the six strings and claimed
  // to aggregate what the rows executed — it read nothing they produced, so it would have passed
  // with every row deleted, and the pass 1 report repeated that overstatement to Saul.
  //
  // It now RE-EXECUTES each row's arrangement and collects the real outcomes. That makes it slower
  // and redundant with the rows above, deliberately: the guard it exists for — "six rows, six
  // different outcomes, not one value six times" — is a property of the SET, and no individual row
  // can assert it.
  const { llm, judge } = await boot();
  const produced: string[] = [];

  const withMock = async (thrown: unknown) => {
    mock.method(llm.chat.completions, 'create', async () => { throw thrown; });
    try { produced.push((await runBatch()).outcome); } finally { mock.restoreAll(); }
  };
  const withContent = async (body: string) => {
    produced.push((await withRawContent(judge, body, runBatch)).outcome);
  };

  await withMock(new APIConnectionTimeoutError({ message: 'timed out' }));   // row 1
  await withMock(new Error('socket hang up'));                              // row 2
  await withContent('this is not JSON at all');                             // row 3
  await withContent('{"0":"x"}');                                           // row 4
  await withContent('{"0":7,"1":"not-a-number"}');                          // row 5
  judge.setScores({ MRKA: 8, MRKB: 4 });
  produced.push((await runBatch()).outcome);                                // row 6

  assert.equal(produced.length, 6, 'six rows executed');
  assert.equal(new Set(produced).size, 6, 'six DIFFERENT outcomes, not one value six times');
  assert.deepEqual(produced, [
    'timeout', 'terminal_failure', 'parse_failure', 'missing_score_key', 'nonnumeric_score', 'success',
  ], 'and each row produced the outcome its own case asserts');

  // Every produced value is a committed one — the vocabulary check, now applied to real output.
  const core = await import('../retrieval-telemetry-core');
  for (const o of produced) {
    assert.ok((core.BATCH_OUTCOME_PRECEDENCE as readonly string[]).includes(o), `${o} is a committed outcome`);
  }
});

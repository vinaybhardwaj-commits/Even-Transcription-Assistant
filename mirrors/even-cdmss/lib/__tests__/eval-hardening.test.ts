/**
 *   node --test --import tsx lib/__tests__/eval-hardening.test.ts
 *
 * Eval hardening — close the parse-null hole, bound the poison note (PRD v1.1, 28 Jul 2026).
 *
 * TWO DEFECTS. (1) `openRouterGenerate` throws on EMPTY content, but non-empty content that fails
 * `parseOpdAnalysis` — or parses without pdqi9 — still persisted a row with note_quality weight 0:
 * the original defect one layer up (95.21 NQI unassessed vs 78.36 assessed, 25,103 rows).
 * (2) A note that fails deterministically was re-selected every tick forever; the batch never
 * reached finished:true and paid retrying was unbounded.
 *
 * The three assertions that decide whether this build is correct:
 *   · every thrown error on the eval path CARRIES THE ENVELOPE (O2 — v1.0 specified a tombstone
 *     payload that was unbuildable because lastEnvelope died with runMiniOpdToLab's stack frame);
 *   · deadline abandonments DO NOT touch the failure budget (O3 — p90 242s vs a 240s deadline means
 *     ~1 in 10 healthy notes is abandoned; counting them would tombstone good slow notes);
 *   · production (evalModel absent) is byte-identical.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  openRouterGenerate, readLlmEnvelope, withEnvelope, evalGuardMessage, deadlineErrorMessage,
  isDeadlineErrorMessage, OPENROUTER_MAX_TRIES, type LlmEnvelope, type EvalPathError,
} from '../opd-note-audit.ts';
import {
  EVAL_MAX_UID_FAILURES, LB_ATTEMPTS_KEY, parseAttemptsState, recordDrainFailure, tombstoneDue,
  type AttemptsState,
} from '../lab-batch.ts';

const SRC = readFileSync('lib/opd-note-audit.ts', 'utf8');
const BATCH = readFileSync('lib/lab-batch.ts', 'utf8');
const CORE = readFileSync('lib/lab-batch-core.ts', 'utf8');

async function withKey<T>(fn: () => Promise<T>): Promise<T> {
  const prev = process.env.OPENROUTER_API_KEY;
  process.env.OPENROUTER_API_KEY = 'test-key';
  try { return await fn(); } finally {
    if (prev === undefined) delete process.env.OPENROUTER_API_KEY; else process.env.OPENROUTER_API_KEY = prev;
  }
}

const okBody = (content: string) => new Response(JSON.stringify({
  choices: [{ message: { content }, finish_reason: 'stop', native_finish_reason: 'STOP' }],
  provider: 'Google', usage: { prompt_tokens: 100, completion_tokens: 200 },
}), { status: 200 });

const emptyBody = () => new Response(JSON.stringify({
  choices: [{ message: { content: '' }, finish_reason: 'length', native_finish_reason: 'MAX_TOKENS' }],
  provider: 'Google', usage: { prompt_tokens: 100, completion_tokens: 0 },
}), { status: 200 });

// ═════════════════════════════════════════════════════════════════════════════════════════════
// 1 · error_type (D6, Q3 overruled — ships now)
// ═════════════════════════════════════════════════════════════════════════════════════════════

test('error_type reads the response body error taxonomy — type beats code beats metadata', () => {
  assert.equal(readLlmEnvelope({ error: { type: 'insufficient_quota', code: 429 } }, 1, 0).error_type, 'insufficient_quota');
  assert.equal(readLlmEnvelope({ error: { code: 429, message: 'rate limited' } }, 1, 0).error_type, '429');
  assert.equal(readLlmEnvelope({ error: { metadata: { type: 'moderation' } } }, 1, 0).error_type, 'moderation');
  assert.equal(readLlmEnvelope({ error: { metadata: { raw: 'provider says no' } } }, 1, 0).error_type, 'provider says no');
  // Per-choice error object as fallback (a 200 whose failed choice carries its own error).
  assert.equal(readLlmEnvelope({ choices: [{ error: { code: 502 } }] }, 1, 0).error_type, '502');
});

test('error_type is null when absent, and envelope capture is still TOTAL on junk', () => {
  assert.equal(readLlmEnvelope({ choices: [{ finish_reason: 'stop' }] }, 1, 10).error_type, null);
  for (const junk of [null, undefined, 42, 'nope', [], { error: 'a string' }, { error: 17 }, { error: { metadata: null } }]) {
    const env = readLlmEnvelope(junk, 1, 0);   // must not throw, whatever the shape
    assert.ok(env.error_type === null || typeof env.error_type === 'string');
    assert.equal(env.attempt, 1);
  }
});

// ═════════════════════════════════════════════════════════════════════════════════════════════
// 2 · The envelope rides every thrown error (D5/O2 — the load-bearing plumbing)
// ═════════════════════════════════════════════════════════════════════════════════════════════

test('withEnvelope attaches both envelope and error_type; null-safe', () => {
  const env: LlmEnvelope = { finish_reason: 'error', native_finish_reason: null, provider: 'Google', usage: null, content_length: 0, attempt: 2, error_type: 'overloaded' };
  const e = withEnvelope(new Error('boom'), env) as EvalPathError;
  assert.equal(e.envelope, env);
  assert.equal(e.error_type, 'overloaded');
  const bare = withEnvelope(new Error('boom'), null) as EvalPathError;
  assert.equal(bare.envelope, null);
  assert.equal(bare.error_type, null);
});

test('3× EMPTY CONTENT: the final throw carries the last real envelope, not a truncated string', async () => {
  await withKey(async () => {
    const f = (async () => emptyBody()) as unknown as typeof fetch;
    await assert.rejects(
      openRouterGenerate('m', 's', 'u', f, async () => {}),
      (e: EvalPathError) => {
        assert.match(e.message, /EMPTY CONTENT/);
        assert.ok(e.envelope && typeof e.envelope === 'object', 'a real envelope OBJECT');
        assert.equal(e.envelope!.finish_reason, 'length');
        assert.equal(e.envelope!.attempt, OPENROUTER_MAX_TRIES, 'the attempt that actually failed last');
        return true;
      },
    );
  });
});

test('non-retryable HTTP: the envelope is read FROM THE ERROR BODY, taxonomy included', async () => {
  await withKey(async () => {
    const f = (async () => new Response(
      JSON.stringify({ error: { code: 400, message: 'bad request', metadata: { type: 'invalid_model' } } }),
      { status: 400 },
    )) as unknown as typeof fetch;
    await assert.rejects(
      openRouterGenerate('m', 's', 'u', f, async () => {}),
      (e: EvalPathError) => {
        assert.match(e.message, /OpenRouter HTTP 400/);
        assert.equal(e.error_type, '400', 'code from the body error object');
        assert.equal(e.envelope!.error_type, '400');
        return true;
      },
    );
  });
});

test('3× transport failure: envelope attached (empty is honest — nothing came off the wire)', async () => {
  await withKey(async () => {
    const f = (async () => { throw new Error('ECONNRESET'); }) as unknown as typeof fetch;
    await assert.rejects(
      openRouterGenerate('m', 's', 'u', f, async () => {}),
      (e: EvalPathError) => {
        assert.match(e.message, /transport error/);
        assert.ok('envelope' in e, 'the property must exist even when nothing was received');
        assert.equal(e.envelope!.content_length, 0);
        assert.equal(e.error_type, null);
        return true;
      },
    );
  });
});

test('deadline throws carry the envelope too — the tombstone must never lose the R2 evidence', async () => {
  await withKey(async () => {
    // One empty-content attempt captures an envelope; the backoff is then refused by the deadline.
    const f = (async () => emptyBody()) as unknown as typeof fetch;
    await assert.rejects(
      openRouterGenerate('m', 's', 'u', f, async () => {}, () => {}, Date.now() + 30),
      (e: EvalPathError) => {
        assert.ok(isDeadlineErrorMessage(e.message));
        assert.equal(e.envelope!.finish_reason, 'length', 'the LAST envelope seen rides the deadline throw');
        return true;
      },
    );
  });
});

test('the success path is untouched — no envelope property on a returned string', async () => {
  await withKey(async () => {
    const f = (async () => okBody('AUDIT-JSON')) as unknown as typeof fetch;
    assert.equal(await openRouterGenerate('m', 's', 'u', f), 'AUDIT-JSON');
  });
});

// ═════════════════════════════════════════════════════════════════════════════════════════════
// 3 · The parse guards (D1/D2) — exact messages, eval-only, no retry loop
// ═════════════════════════════════════════════════════════════════════════════════════════════

test('the guard messages are EXACTLY the §4 normative strings', () => {
  assert.equal(evalGuardMessage.parseNull(1234),
    'eval: parseOpdAnalysis returned null (content_length=1234) — retried next tick');
  assert.equal(evalGuardMessage.pdqi9Absent(),
    'eval: parsed response has no pdqi9 object — retried next tick');
  assert.equal(evalGuardMessage.pdqi9Partial(7),
    'eval: pdqi9 has 7/9 attributes, require 9 — retried next tick');
});

test('the guards sit at the CALL SITE, gated on opts.evalModel, in the §4 order', () => {
  const i = SRC.indexOf('let parsed = parseOpdAnalysis(raw, sources.length);');   // let since S0's bounded retry
  assert.ok(i > 0);
  const after = SRC.slice(i, i + 2600);
  const gate = after.indexOf('if (opts.evalModel) {');
  const g1 = after.indexOf('if (parsed === null) throw withEnvelope(new Error(evalGuardMessage.parseNull(raw.length)), evalEnv);');
  const g2 = after.indexOf('if (parsed.pdqi9 == null) throw withEnvelope(new Error(evalGuardMessage.pdqi9Absent()), evalEnv);');
  const g3 = after.indexOf('if (rated !== 9) throw withEnvelope(new Error(evalGuardMessage.pdqi9Partial(rated)), evalEnv);');
  assert.ok(gate > 0 && g1 > gate && g2 > g1 && g3 > g2, 'null → absent → partial, inside the eval gate');
  // No retry loop was added to "fix" the tick-level asymmetry (D1/O1).
  assert.ok(!/for\s*\(|while\s*\(/.test(after.slice(gate, g3)), 'tick-level retry is the mechanism — no loop here');
});

test('PRODUCTION IS BYTE-IDENTICAL: evalModel absent keeps the lenient parse exactly', () => {
  // The lenient reads production relies on are still on the shared path, after the gate.
  assert.ok(SRC.includes('const findings: OpdFinding[] = finalize([...det, ...(parsed?.findings ?? [])]);'));
  assert.ok(SRC.includes('pdqi9: parsed?.pdqi9 ?? null,'));
  assert.ok(SRC.includes("suggestions: parsed?.suggestions ?? [],"));
  // parseOpdAnalysis itself is untouched — still imported from the core, never redefined here.
  assert.ok(/import \{[\s\S]*?parseOpdAnalysis,[\s\S]*?\} from '\.\/opd-note-audit-core';/.test(SRC));
  assert.ok(!/function parseOpdAnalysis/.test(SRC), 'no local override of the lenient parser');
  // The envelope wrapper collapses to opts.onEnvelope when evalModel is absent.
  assert.ok(SRC.includes('? (e: LlmEnvelope) => { evalEnv = e; opts.onEnvelope?.(e); }\n      : opts.onEnvelope;'));
});

// ═════════════════════════════════════════════════════════════════════════════════════════════
// 4 · The failure budget (D3/D4) — deadline abandons are NOT failures
// ═════════════════════════════════════════════════════════════════════════════════════════════

test('parseAttemptsState: absent, malformed, or another experiment ⇒ EMPTY, never an error', () => {
  assert.deepEqual(parseAttemptsState(undefined, 'exp_a'), { experiment: 'exp_a', uids: {} });
  assert.deepEqual(parseAttemptsState('', 'exp_a'), { experiment: 'exp_a', uids: {} });
  assert.deepEqual(parseAttemptsState('not json{', 'exp_a'), { experiment: 'exp_a', uids: {} });
  assert.deepEqual(parseAttemptsState('[1,2,3]', 'exp_a'), { experiment: 'exp_a', uids: {} });
  // Experiment scoping IS the reset: another experiment's map reads as empty.
  const other = JSON.stringify({ experiment: 'exp_old', uids: { u1: { failures: 3, deadline_abandons: 0 } } });
  assert.deepEqual(parseAttemptsState(other, 'exp_new'), { experiment: 'exp_new', uids: {} });
});

test('parseAttemptsState round-trips a real map and sanitises junk counters', () => {
  const state: AttemptsState = { experiment: 'exp_a', uids: {} };
  recordDrainFailure(state, 'u1', withEnvelope(new Error('OpenRouter HTTP 400: nope'), {
    finish_reason: 'error', native_finish_reason: null, provider: 'Google', usage: null,
    content_length: 0, attempt: 1, error_type: 'invalid_model',
  }));
  const back = parseAttemptsState(JSON.stringify(state), 'exp_a');
  assert.equal(back.uids.u1.failures, 1);
  assert.equal(back.uids.u1.error_type, 'invalid_model');
  assert.equal(back.uids.u1.llm_envelope?.finish_reason, 'error');
  // Junk counters clamp to 0 rather than poisoning arithmetic.
  const junk = JSON.stringify({ experiment: 'exp_a', uids: { u2: { failures: -4, deadline_abandons: 'many' } } });
  assert.deepEqual(parseAttemptsState(junk, 'exp_a').uids.u2, { failures: 0, deadline_abandons: 0 });
});

test('THE D4 RULE: a deadline abandonment increments deadline_abandons and NEVER failures', () => {
  const state: AttemptsState = { experiment: 'exp_a', uids: {} };
  const deadlineErr = new Error(deadlineErrorMessage(2, 3, null));
  for (let i = 0; i < 100; i++) recordDrainFailure(state, 'slow', deadlineErr);
  assert.equal(state.uids.slow.deadline_abandons, 100);
  assert.equal(state.uids.slow.failures, 0, 'p90 is 242s against a 240s deadline — abandons are HEALTHY');
  assert.equal(tombstoneDue(state, 'slow'), false, 'a slow note must never tombstone on abandons alone');
});

test('terminal failures budget to the tombstone at exactly 3, evidence carried', () => {
  const state: AttemptsState = { experiment: 'exp_a', uids: {} };
  const guardErr = withEnvelope(new Error(evalGuardMessage.pdqi9Partial(4)), {
    finish_reason: 'stop', native_finish_reason: 'STOP', provider: 'Google', usage: null,
    content_length: 2048, attempt: 1, error_type: null,
  });
  recordDrainFailure(state, 'bad', guardErr);
  recordDrainFailure(state, 'bad', guardErr);
  assert.equal(tombstoneDue(state, 'bad'), false, 'two failures is not yet the budget');
  recordDrainFailure(state, 'bad', guardErr);
  assert.equal(state.uids.bad.failures, EVAL_MAX_UID_FAILURES);
  assert.equal(tombstoneDue(state, 'bad'), true);
  assert.equal(state.uids.bad.last_error, evalGuardMessage.pdqi9Partial(4));
  assert.equal(state.uids.bad.llm_envelope?.content_length, 2048, 'the tombstone gets a REAL envelope');
});

test('mixed history: abandons interleaved with failures — only the failures count', () => {
  const state: AttemptsState = { experiment: 'exp_a', uids: {} };
  const deadlineErr = new Error(deadlineErrorMessage(3, 3, null));
  const terminalErr = withEnvelope(new Error('OpenRouter HTTP 400: bad'), null);
  recordDrainFailure(state, 'u', deadlineErr);
  recordDrainFailure(state, 'u', terminalErr);
  recordDrainFailure(state, 'u', deadlineErr);
  recordDrainFailure(state, 'u', terminalErr);
  assert.deepEqual(
    { f: state.uids.u.failures, d: state.uids.u.deadline_abandons },
    { f: 2, d: 2 },
  );
  assert.equal(tombstoneDue(state, 'u'), false);
});

// ═════════════════════════════════════════════════════════════════════════════════════════════
// 5 · The tick wiring — eval-only, fail-safe, tombstones count as done
// ═════════════════════════════════════════════════════════════════════════════════════════════

// ⚠️ WIDENED 8 Aug 2026 (S2b C1): the gate is now every PAID branch, not the eval one alone. The
// defect D3 was written for — a poison note that writes no row, is never in doneUids, and is
// re-selected every tick FOREVER — is strictly worse on the Bedrock arm, where each retry is billed.
// The property this test defends is unchanged: the FREE MINI still gets null and touches nothing.
test('the budget is PAID-BRANCH ONLY and its read degrades to empty, never throws', () => {
  assert.ok(BATCH.includes('const attempts: AttemptsState | null = (plan.evalMode || !!bedrockModel)'));
  assert.ok(BATCH.includes(".catch(() => ({ experiment, uids: {} }))"), 'a failed read means no enforcement, not a lost tick');
  assert.ok(BATCH.includes(': null;'), 'mini gets null — it neither reads nor writes the map');
  // The map write is wrapped the same way.
  assert.ok(BATCH.includes('if (attempts) await setSetting(LB_ATTEMPTS_KEY, JSON.stringify(attempts)).catch(() => {});'));
  // The mini drain loop is still the verbatim serial loop.
  assert.ok(BATCH.includes(`      results = [];
      for (const uid of slice) results.push(await drainOne(uid));`));
});

test('doneUids has NO kind filter — a tombstone row makes the uid done, so the batch can finish', () => {
  const i = BATCH.indexOf('export async function doneUids');
  const fn = BATCH.slice(i, BATCH.indexOf('}', i));
  assert.ok(fn.includes('SELECT DISTINCT input_ref FROM lab_analyses WHERE experiment = $1 AND input_ref IS NOT NULL'));
  assert.ok(!/kind/.test(fn), 'filtering kind here would re-select tombstoned uids forever');
});

test('the tombstone is written INSTEAD of attempting, with the D5 payload, kind eval_failed', () => {
  assert.ok(BATCH.includes('if (attempts && tombstoneDue(attempts, uid)) {'));
  const i = BATCH.indexOf('if (attempts && tombstoneDue(attempts, uid)) {');
  const runIdx = BATCH.indexOf('await runMiniOpdToLab(uid, experiment, evalCfg)', i);
  const saveIdx = BATCH.indexOf("kind: 'eval_failed'", i);
  assert.ok(saveIdx > i && saveIdx < runIdx, 'the budget check must come BEFORE the attempt');
  assert.ok(BATCH.includes('failed: true, attempts: rec.failures, last_error: rec.last_error ?? null,'));
  assert.ok(BATCH.includes('llm_envelope: rec.llm_envelope ?? null, error_type: rec.error_type ?? null,'));
});

test('the summary gains tombstoned + failed_uids, inside the eval-only spread', () => {
  const spreadStart = BATCH.indexOf('...(plan.evalMode ? {');
  const spread = BATCH.slice(spreadStart, BATCH.indexOf('} : {}),', spreadStart));
  assert.ok(spread.includes('tombstoned:'), 'tombstoned must not leak into mini summaries');
  assert.ok(spread.includes('failed_uids:'));
  assert.ok(spread.includes('r.failures > 0'), 'failed_uids lists TERMINAL failures only — deadline stragglers are absent');
});

test('lab-batch-core is untouched: constants, drainPlan, locks all stand', () => {
  assert.ok(CORE.includes('export const LB_LOCK_TTL_MS = 900 * 1000;'));
  assert.ok(CORE.includes('export const EVAL_TICK_DEADLINE_MS = Number(process.env.EVAL_TICK_DEADLINE_MS) || 240_000;'));
  assert.ok(CORE.includes('sliceSize: Math.min(EVAL_TICK_MAX, concurrency)'));
  assert.ok(CORE.includes('export function labLockHeld(') && CORE.includes('export function ttlBreach('));
  assert.ok(!/lab_batch_attempts/.test(CORE), 'the new key deliberately lives in lab-batch.ts, not core');
});

test('the attempts key is the documented name and OPENROUTER_TIMEOUT_MS did not move', () => {
  assert.equal(LB_ATTEMPTS_KEY, 'lab_batch_attempts');
  // Addendum F v2 task 1: the constant's HOME moved to lib/openrouter-retry.ts (shared with the
  // production bridge transport); its value and env override are unchanged, and opd-note-audit.ts
  // re-exports it so every consumer of this module is untouched.
  assert.ok(readFileSync('lib/openrouter-retry.ts', 'utf8')
    .includes('export const OPENROUTER_TIMEOUT_MS = Number(process.env.OPENROUTER_TIMEOUT_MS) || 110_000;'));
  assert.ok(SRC.includes('export { OPENROUTER_MAX_TRIES, openRouterRetryable, openRouterBackoffMs, OPENROUTER_TIMEOUT_MS };'));
});

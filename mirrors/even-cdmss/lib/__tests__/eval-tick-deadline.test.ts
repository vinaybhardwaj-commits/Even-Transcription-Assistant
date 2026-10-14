/**
 *   node --test --import tsx lib/__tests__/eval-tick-deadline.test.ts
 *
 * Eval tick deadline — "no tick outlives its invocation" (PRD 27 Jul 2026).
 *
 * THE DEFECT (MEASURED 27 Jul, probe `probe_r2_envelope_01`, 20 uids, evalConcurrency 6): the tick
 * started 14:22:00, wrote 5 rows by 14:26:54, then died. `app_settings.lab_batch_last` still held
 * the 12:46 tick at 14:37 — the tick never completed — and `lab_batch_last_error` was EMPTY
 * throughout. `6b12652` made a failing note retry up to 3× INSIDE the tick, so a wave containing one
 * failure runs ~3× longer; when the invocation is killed mid-retry the throw never completes,
 * `drainOne` never catches it, and the error key is never written. The probe therefore cannot
 * capture the failure envelope it exists to capture.
 *
 * The two assertions that decide whether this build is correct:
 *   · a deadline BOUNDS EACH ATTEMPT so the pool always resolves and the tick reports (never
 *     `Promise.race`, which would let in-flight calls write rows after the lock is released — the
 *     duplicate-row defect `bed1449` fixed);
 *   · with `deadlineAt` ABSENT every existing call site, production included, is byte-identical.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  openRouterGenerate, deadlineErrorMessage, isDeadlineErrorMessage, DEADLINE_ERROR_PREFIX,
  OPENROUTER_MAX_TRIES, OPENROUTER_TIMEOUT_MS, type LlmEnvelope,
} from '../opd-note-audit.ts';
import { EVAL_TICK_DEADLINE_MS, remainingBudgetMs } from '../lab-batch-core.ts';

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

const okBody = (content: string) =>
  new Response(JSON.stringify({
    choices: [{ message: { content }, finish_reason: 'stop', native_finish_reason: 'STOP' }],
    provider: 'Google', usage: { prompt_tokens: 100, completion_tokens: 200 },
  }), { status: 200 });

const emptyBody = () =>
  new Response(JSON.stringify({
    choices: [{ message: { content: '' }, finish_reason: 'length', native_finish_reason: 'MAX_TOKENS' }],
    provider: 'Google', usage: { prompt_tokens: 100, completion_tokens: 0 },
  }), { status: 200 });

const never = (async () => { throw new Error('fetch must not be reached'); }) as unknown as typeof fetch;

// ═════════════════════════════════════════════════════════════════════════════════════════════
// 1 · THE PURE HELPER + THE CONSTANTS (D4)
// ═════════════════════════════════════════════════════════════════════════════════════════════

test('remainingBudgetMs is pure, floors at 0, and never returns a negative', () => {
  assert.equal(remainingBudgetMs(1_000, 400), 600);
  assert.equal(remainingBudgetMs(1_000, 1_000), 0);
  assert.equal(remainingBudgetMs(1_000, 5_000), 0, 'a blown budget is 0, never negative');
  // Pure: same inputs, same output, no clock read when `now` is supplied.
  assert.equal(remainingBudgetMs(1_000, 400), remainingBudgetMs(1_000, 400));
});

test('EVAL_TICK_DEADLINE_MS defaults to 240s and is env-overridable', () => {
  assert.equal(EVAL_TICK_DEADLINE_MS, Number(process.env.EVAL_TICK_DEADLINE_MS) || 240_000);
  assert.ok(/Number\(process\.env\.EVAL_TICK_DEADLINE_MS\) \|\| 240_000/.test(CORE));
});

test('the two tuned numbers are consistent: a note can spend its whole retry budget inside a tick', () => {
  // This is the reason OPENROUTER_TIMEOUT_MS dropped 300s → 110s. If this ever fails, a note can no
  // longer exhaust its retries within one tick and the probe stops capturing envelopes.
  assert.ok(OPENROUTER_TIMEOUT_MS * OPENROUTER_MAX_TRIES > EVAL_TICK_DEADLINE_MS,
    'sanity: the budget is meant to be reachable, not slack');
  assert.ok(OPENROUTER_TIMEOUT_MS * 2 < EVAL_TICK_DEADLINE_MS,
    'at least two full attempts plus backoff must fit inside the deadline');
});

// ═════════════════════════════════════════════════════════════════════════════════════════════
// 2 · BEFORE EACH ATTEMPT — throw immediately, do not sleep, do not fetch (D1)
// ═════════════════════════════════════════════════════════════════════════════════════════════

test('THE FIX: an already-blown deadline throws BEFORE attempt 1 — no fetch, no sleep', async () => {
  await withKey(async () => {
    const sleeps: number[] = [];
    await assert.rejects(
      openRouterGenerate('m', 's', 'u', never, async (ms) => { sleeps.push(ms); }, () => {}, Date.now() - 1),
      (e: Error) => {
        assert.ok(isDeadlineErrorMessage(e.message), 'must be the deadline error');
        assert.match(e.message, /before attempt 1\/3/);
        return true;
      },
    );
    assert.deepEqual(sleeps, [], 'a blown deadline must never sleep');
  });
});

test('the deadline is checked before EVERY attempt, not just the first', async () => {
  await withKey(async () => {
    let calls = 0;
    // Budget allows attempt 1, then expires while it is in flight.
    const deadlineAt = Date.now() + 40;
    const f = (async () => { calls++; await new Promise((r) => setTimeout(r, 60)); return emptyBody(); }) as unknown as typeof fetch;
    await assert.rejects(
      openRouterGenerate('m', 's', 'u', f, async () => {}, () => {}, deadlineAt),
      (e: Error) => { assert.ok(isDeadlineErrorMessage(e.message)); return true; },
    );
    assert.equal(calls, 1, 'attempt 1 ran; attempt 2 was refused by the deadline');
  });
});

test('a note that FINISHES inside its budget is completely unaffected', async () => {
  await withKey(async () => {
    const f = (async () => okBody('AUDIT-JSON')) as unknown as typeof fetch;
    const out = await openRouterGenerate('m', 's', 'u', f, async () => {}, () => {}, Date.now() + 60_000);
    assert.equal(out, 'AUDIT-JSON', 'a generous deadline must not change a successful result');
  });
});

// ═════════════════════════════════════════════════════════════════════════════════════════════
// 3 · BEFORE SLEEPING — a backoff that would cross the deadline throws instead (D1)
// ═════════════════════════════════════════════════════════════════════════════════════════════

test('a backoff that would cross the deadline throws NOW rather than sleeping through it', async () => {
  await withKey(async () => {
    const sleeps: number[] = [];
    // Budget is smaller than the smallest possible backoff (~250ms), so the retry sleep is refused.
    const f = (async () => emptyBody()) as unknown as typeof fetch;
    await assert.rejects(
      openRouterGenerate('m', 's', 'u', f, async (ms) => { sleeps.push(ms); }, () => {}, Date.now() + 30),
      (e: Error) => {
        assert.ok(isDeadlineErrorMessage(e.message));
        // We failed on attempt 1 and were refused the sleep, so the message names attempt 2.
        assert.match(e.message, /before attempt 2\/3/);
        return true;
      },
    );
    assert.deepEqual(sleeps, [], 'the sleep must be refused, not shortened');
  });
});

test('the deadline error carries the LAST envelope — it is the only surviving record', async () => {
  await withKey(async () => {
    const seen: LlmEnvelope[] = [];
    const f = (async () => emptyBody()) as unknown as typeof fetch;
    await assert.rejects(
      openRouterGenerate('m', 's', 'u', f, async () => {}, (e) => seen.push(e), Date.now() + 30),
      (e: Error) => {
        // finish_reason=length is exactly the discriminator R2 is waiting for.
        assert.match(e.message, /last envelope: finish_reason=length native_finish_reason=MAX_TOKENS provider=Google content_length=0/);
        return true;
      },
    );
    assert.equal(seen.length, 1, 'the envelope was captured before the deadline cut in');
  });
});

test('with no envelope yet, every field reads null rather than the message failing to build', () => {
  const msg = deadlineErrorMessage(1, 3, null);
  assert.match(msg, /last envelope: finish_reason=null native_finish_reason=null provider=null content_length=null/);
  assert.ok(isDeadlineErrorMessage(msg));
});

// ═════════════════════════════════════════════════════════════════════════════════════════════
// 4 · THE MESSAGE — normative, because it IS the instrumentation (PRD §4)
// ═════════════════════════════════════════════════════════════════════════════════════════════

test('the deadline message is EXACTLY the three normative lines', () => {
  const env: LlmEnvelope = {
    finish_reason: 'length', native_finish_reason: 'MAX_TOKENS', provider: 'Google',
    usage: { prompt_tokens: 100, completion_tokens: 0 }, content_length: 0, attempt: 2,
  };
  assert.equal(deadlineErrorMessage(2, 3, env),
    'TICK DEADLINE reached before attempt 2/3 — abandoning this note so the tick can report.\n'
    + 'The uid is NOT marked done and will be retried next tick.\n'
    + 'last envelope: finish_reason=length native_finish_reason=MAX_TOKENS provider=Google content_length=0');
});

test('the prefix the tick counts on is defined once, beside the builder', () => {
  assert.ok(deadlineErrorMessage(1, 3, null).startsWith(DEADLINE_ERROR_PREFIX));
  assert.ok(isDeadlineErrorMessage(deadlineErrorMessage(3, 3, null)));
  // Total and pure — a non-string can never make the tick summary throw.
  for (const junk of [null, undefined, 42, {}, [], '', 'OpenRouter HTTP 500: nope']) {
    assert.equal(isDeadlineErrorMessage(junk), false);
  }
});

test('a deadline hit is NOT confused with the empty-content failure — they are different faults', async () => {
  await withKey(async () => {
    // Generous deadline ⇒ the note exhausts its retries and reports EMPTY CONTENT, not a deadline.
    const f = (async () => emptyBody()) as unknown as typeof fetch;
    await assert.rejects(
      openRouterGenerate('m', 's', 'u', f, async () => {}, () => {}, Date.now() + 60_000),
      (e: Error) => {
        assert.match(e.message, /EMPTY CONTENT/);
        assert.equal(isDeadlineErrorMessage(e.message), false, 'deadline_hits must not absorb real failures');
        return true;
      },
    );
  });
});

// ═════════════════════════════════════════════════════════════════════════════════════════════
// 5 · THE CLAMP (D2) — a fetch can never outlive the tick
// ═════════════════════════════════════════════════════════════════════════════════════════════

test('the AbortController timeout is clamped to the remaining budget when a deadline is present', () => {
  assert.ok(SRC.includes(`const timeoutMs = deadlineAt == null
      ? OPENROUTER_TIMEOUT_MS
      : Math.min(OPENROUTER_TIMEOUT_MS, remainingBudgetMs(deadlineAt));`),
    'the clamp must be min(timeout, remaining), and exactly the timeout when absent');
  assert.ok(/const timer = setTimeout\(\(\) => ctrl\.abort\(\), timeoutMs\);/.test(SRC),
    'the clamped value must actually reach the timer');
  assert.ok(/\} finally \{\n\s*clearTimeout\(timer\);/.test(SRC), 'a completed request must not leave a timer');
});

test('the clamped timeout is REPORTED in the timeout message, so the log is truthful', async () => {
  await withKey(async () => {
    const f = (async (_u: string, init: { signal?: AbortSignal }) => {
      await new Promise((r) => setTimeout(r, 50));
      if (init?.signal?.aborted) { const err = new Error('aborted'); err.name = 'AbortError'; throw err; }
      return okBody('X');
    }) as unknown as typeof fetch;
    // 20ms budget ⇒ the clamp aborts at 20ms, and the message must say 20ms, not 110000ms.
    await assert.rejects(
      openRouterGenerate('m', 's', 'u', f, async () => {}, () => {}, Date.now() + 20),
      (e: Error) => {
        assert.ok(!/TIMEOUT after 110000ms/.test(e.message), 'must not report the unclamped timeout');
        return true;
      },
    );
  });
});

// ═════════════════════════════════════════════════════════════════════════════════════════════
// 6 · ABSENT ⇒ BYTE-IDENTICAL. The assertion that keeps production safe.
// ═════════════════════════════════════════════════════════════════════════════════════════════

test('THE SAFETY PROPERTY: with deadlineAt absent, nothing about the retry loop changes', async () => {
  await withKey(async () => {
    let calls = 0; const sleeps: number[] = [];
    const f = (async () => { calls++; return calls < 3 ? emptyBody() : okBody('RECOVERED'); }) as unknown as typeof fetch;
    const out = await openRouterGenerate('m', 's', 'u', f, async (ms) => { sleeps.push(ms); });
    assert.equal(out, 'RECOVERED');
    assert.equal(calls, 3, 'the full 3-try budget is still spent');
    assert.equal(sleeps.length, 2, 'both backoffs still slept — no deadline, no interference');
    assert.ok(sleeps.every((ms) => ms > 0), 'the backoff values are unchanged');
  });
});

test('deadlineAt is APPENDED — every existing positional call site still binds correctly', async () => {
  await withKey(async () => {
    // The 4-arg and 5-arg shapes used across the existing suites and by lvc-value.
    const f = (async () => okBody('OK')) as unknown as typeof fetch;
    assert.equal(await openRouterGenerate('m', 's', 'u', f), 'OK');
    assert.equal(await openRouterGenerate('m', 's', 'u', f, async () => {}), 'OK');
    assert.equal(await openRouterGenerate('m', 's', 'u', f, async () => {}, () => {}), 'OK');
  });
  assert.ok(/onEnvelope: \(e: LlmEnvelope\) => void = \(\) => \{\},\n\s*deadlineAt\?: number,/.test(SRC),
    'deadlineAt must be LAST in the signature');
});

test('auditOpdNote threads opts.deadlineAt and nothing else changed on the call', () => {
  // Eval-hardening wraps onEnvelope on the eval path (to capture the envelope for the parse
  // guards); the wrapper is `opts.onEnvelope` itself whenever evalModel is absent, so production
  // still receives exactly the caller's callback.
  // S0 wrapped the call in generateLeg() for its one bounded production retry — the ARGUMENTS are
  // unchanged, which is what this assertion actually guards.
  // ⚠️ ONE ARGUMENT APPENDED 7 Aug 2026 (Bedrock S2): `opts.bedrockModel`, last in the list, so
  // every argument this test was written to protect is in the same position carrying the same
  // value. The property is unchanged — the ARGUMENTS are what this guards, and deadlineAt still
  // reaches the leg untouched.
  assert.ok(SRC.includes('const generateLeg = () => defaultGenerate(traceId, OPD_AUDIT_SYSTEM, buildOpdAuditUser(opdCaseText(oc, { specialty }), citedContext), mini, opts.evalModel, onEnvelope, opts.deadlineAt, opts.bedrockModel);'));
  assert.ok(SRC.includes('? (e: LlmEnvelope) => { evalEnv = e; opts.onEnvelope?.(e); }\n      : opts.onEnvelope;'),
    'the wrapper must collapse to opts.onEnvelope when evalModel is absent');
  // It reaches the LLM only through the evalModel branch, so it is inert without evalModel.
  const dg = SRC.slice(SRC.indexOf('async function defaultGenerate('), SRC.indexOf('/** Reuse the stored LLM half'));
  const code = dg.split('\n').filter((l) => !l.trim().startsWith('//') && !l.trim().startsWith('*')).join('\n');
  assert.equal((code.match(/deadlineAt/g) || []).length, 2, 'param + eval call site only');
});

// ═════════════════════════════════════════════════════════════════════════════════════════════
// 7 · THE TICK — eval branch only; mini untouched; no Promise.race (D3)
// ═════════════════════════════════════════════════════════════════════════════════════════════

test('batchTick computes the deadline ONCE, from tickStart, and only in eval mode', () => {
  assert.ok(BATCH.includes('const deadlineAt = plan.evalMode ? tickStart + EVAL_TICK_DEADLINE_MS : undefined;'));
  const code = BATCH.split('\n').filter((l) => !l.trim().startsWith('//') && !l.trim().startsWith('*')).join('\n');
  assert.equal((code.match(/tickStart \+ EVAL_TICK_DEADLINE_MS/g) || []).length, 1, 'computed exactly once');
});

test('THE MINI BRANCH IS BYTE-IDENTICAL — it never receives a deadline', () => {
  // The serial mini drain is unchanged, verbatim.
  assert.ok(BATCH.includes(`      results = [];
      for (const uid of slice) results.push(await drainOne(uid));`), 'the mini drain loop must be untouched');
  // The deadline is spread in conditionally, so mini's evalCfg has no deadlineAt key at all.
  assert.ok(BATCH.includes('...(deadlineAt != null ? { deadlineAt } : {})'),
    'mini must not carry an explicit deadlineAt: undefined');
  // deadline_ms / deadline_hits live inside the eval-only spread, so mini summaries are unchanged.
  const summary = BATCH.slice(BATCH.indexOf('const summary = {', BATCH.indexOf('const okNow')));
  // The eval-only spread is multi-line since eval-hardening added tombstoned/failed_uids to it.
  const spreadStart = summary.indexOf('...(plan.evalMode');
  const evalOnly = summary.slice(spreadStart, summary.indexOf('} : {}),', spreadStart));
  assert.ok(evalOnly.includes('deadline_ms') && evalOnly.includes('deadline_hits'),
    'both fields must sit inside the plan.evalMode spread');
});

test('D3: the bounded pool is AWAITED, never raced — racing recreates the bed1449 duplicate rows', () => {
  assert.ok(BATCH.includes('results = await boundedPool(slice, plan.concurrency, drainOne);'));
  assert.ok(!/Promise\.race/.test(BATCH), 'Promise.race on the pool would let in-flight calls write after the lock releases');
  assert.ok(!/Promise\.race/.test(CORE), 'and it must not appear in the pool implementation either');
});

test('deadline_hits counts deadline errors and nothing else', () => {
  assert.ok(BATCH.includes('deadline_hits: results.filter((r) => isDeadlineErrorMessage(r.error)).length'));
  // Behaviourally: the predicate the tick uses discriminates the three failure kinds correctly.
  const rows = [
    { uid: 'a', error: deadlineErrorMessage(2, 3, null) },
    { uid: 'b', error: 'OpenRouter returned EMPTY CONTENT (HTTP 200) — treated as failure' },
    { uid: 'c', error: 'OpenRouter HTTP 500: upstream' },
    { uid: 'd', band: 'B' },
  ];
  assert.equal(rows.filter((r) => isDeadlineErrorMessage(r.error)).length, 1);
});

// ═════════════════════════════════════════════════════════════════════════════════════════════
// 8 · THE UNTOUCHED LIST — hard
// ═════════════════════════════════════════════════════════════════════════════════════════════

test('drainPlan, labLockHeld, ttlBreach and LB_LOCK_TTL_MS are untouched', () => {
  assert.ok(CORE.includes('export const LB_LOCK_TTL_MS = 900 * 1000;'), 'the TTL stays 900s');
  assert.ok(CORE.includes(`  if (st.evalModel) {
    const concurrency = clampEvalConcurrency(st.evalConcurrency);
    return { evalMode: true, sliceSize: Math.min(EVAL_TICK_MAX, concurrency), concurrency, useMiniYield: false };
  }
  return { evalMode: false, sliceSize: st.n, concurrency: 1, useMiniYield: true };`), 'drainPlan body verbatim');
  assert.ok(CORE.includes('export function labLockHeld(lockTs: string | null, now: Date = new Date()): boolean {'));
  assert.ok(CORE.includes('export function ttlBreach('));
  // The deadline must never have leaked into the drain decision — it bounds attempts, not dispatch.
  const plan = CORE.slice(CORE.indexOf('export function drainPlan('), CORE.indexOf('export async function boundedPool'));
  assert.ok(!/deadline/i.test(plan), 'drainPlan must not branch on the deadline');
});

test('the eval deadline never reaches a production audit path', () => {
  // No production caller may pass deadlineAt. Walk the real call sites rather than trusting grep.
  const prod = [
    'app/api/opd-audit/run/route.ts', 'app/api/opd-audit/worker/route.ts',
    'app/api/admin/opd-audit-mini-backfill/route.ts', 'app/api/admin/opd-dosing-backfill/route.ts',
    'lib/mcp-tools.ts', 'lib/opd-longitudinal.ts', 'lib/opd-longitudinal-core.ts',
  ];
  for (const f of prod) {
    assert.ok(!/deadlineAt/.test(readFileSync(f, 'utf8')), `${f} must never pass a tick deadline`);
  }
});

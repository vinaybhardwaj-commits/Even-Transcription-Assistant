/**
 * lib/__tests__/openrouter-retry.test.ts — the shared OpenRouter retry policy
 * (bridge-reliability addendum F v2 task 1).
 *
 * Two halves:
 *  1. POLICY IDENTITY — the constants/helpers the lab path (openRouterGenerate) has always used
 *     are now THE SAME BINDINGS as the production wrapper's: opd-note-audit.ts re-exports
 *     lib/openrouter-retry.ts. If someone re-declares a local copy, the identity check fails —
 *     that is the "five dedup postures" failure mode this module exists to prevent.
 *  2. WRAPPER BEHAVIOUR — openrouterCreateWithRetry gives the SDK transport the lab path's three
 *     properties: a bounded per-attempt deadline whose abort is RETRYABLE, bounded retries with
 *     backoff for transient failures, and the empty-200 class retryable on the same budget with
 *     the terminal throw being the MARKED error (ProviderResponseError) so call sites can refuse
 *     the Ollama fallback (§2.3).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import {
  OPENROUTER_MAX_TRIES, OPENROUTER_TIMEOUT_MS, openRouterRetryable, openRouterBackoffMs,
  openrouterCreateWithRetry,
} from '../openrouter-retry';
import * as audit from '../opd-note-audit';
import { isProviderResponseError } from '../provider-error-core';

const noSleep = async () => {};
const GOOD = { choices: [{ message: { content: '{"ok":true}' }, finish_reason: 'stop' }] };
const EMPTY_200 = { choices: [{ message: { content: '' }, finish_reason: 'error' }], provider: 'google-vertex' };

// ── 1 · policy identity ───────────────────────────────────────────────────────────────────────

test('the lab path and the production wrapper share ONE policy — identical bindings, not copies', () => {
  assert.equal(audit.OPENROUTER_MAX_TRIES, OPENROUTER_MAX_TRIES);
  assert.equal(audit.OPENROUTER_TIMEOUT_MS, OPENROUTER_TIMEOUT_MS);
  assert.equal(audit.openRouterRetryable, openRouterRetryable, 'same function object, not a re-implementation');
  assert.equal(audit.openRouterBackoffMs, openRouterBackoffMs, 'same function object, not a re-implementation');
});

test('policy values are unchanged by the move: 3 tries, 429/5xx retryable, 110s deadline, jittered backoff', () => {
  assert.equal(OPENROUTER_MAX_TRIES, 3);
  assert.equal(OPENROUTER_TIMEOUT_MS, 110_000);
  assert.ok(openRouterRetryable(429) && openRouterRetryable(500) && openRouterRetryable(503));
  assert.ok(!openRouterRetryable(400) && !openRouterRetryable(401) && !openRouterRetryable(404));
  assert.equal(openRouterBackoffMs(1, () => 0.5), 500);
  assert.equal(openRouterBackoffMs(2, () => 0.5), 1000);
});

// ── 2 · wrapper behaviour ─────────────────────────────────────────────────────────────────────

test('a clean completion returns on attempt 1 — one call, no sleep, no failure report', async () => {
  let calls = 0;
  const failures: unknown[] = [];
  const res = await openrouterCreateWithRetry(async () => { calls++; return GOOD; },
    { sleepFn: noSleep, onAttemptFailure: (f) => failures.push(f) });
  assert.equal(calls, 1);
  assert.deepEqual(res, GOOD);
  assert.equal(failures.length, 0);
});

test('every attempt carries OUR deadline and the SDK retries OFF — the budget must not multiply', async () => {
  const seen: Array<{ signal: AbortSignal; timeout: number; maxRetries: number }> = [];
  await openrouterCreateWithRetry(async (ro) => { seen.push(ro); return GOOD; }, { sleepFn: noSleep });
  assert.equal(seen.length, 1);
  assert.ok(seen[0].signal instanceof AbortSignal);
  assert.equal(seen[0].timeout, OPENROUTER_TIMEOUT_MS);
  assert.equal(seen[0].maxRetries, 0, 'SDK internal retries must be OFF — 3 tries means 3 wire calls, not 9');
});

test('a transport error (no HTTP status) is retryable; success on attempt 2 returns normally', async () => {
  let calls = 0;
  const res = await openrouterCreateWithRetry(async () => {
    calls++;
    if (calls === 1) throw new Error('socket hang up');
    return GOOD;
  }, { sleepFn: noSleep });
  assert.equal(calls, 2);
  assert.deepEqual(res, GOOD);
});

test('429/5xx retry on the bounded budget; the FINAL attempt rethrows the provider error', async () => {
  let calls = 0;
  const err = Object.assign(new Error('upstream overloaded'), { status: 503 });
  await assert.rejects(
    () => openrouterCreateWithRetry(async () => { calls++; throw err; }, { sleepFn: noSleep }),
    (e: Error) => e === err,
  );
  assert.equal(calls, OPENROUTER_MAX_TRIES, 'the whole budget is spent before giving up');
});

test('a non-transient status (4xx) throws IMMEDIATELY — the call site fallback path is unchanged for it', async () => {
  let calls = 0;
  const err = Object.assign(new Error('invalid request'), { status: 400 });
  await assert.rejects(() => openrouterCreateWithRetry(async () => { calls++; throw err; }, { sleepFn: noSleep }));
  assert.equal(calls, 1, 'no retry may be spent on a request that can never succeed');
});

test('an EMPTY 200 is a retryable failure, not a terminal one — d6efe39 made it visible, this makes it survivable', async () => {
  let calls = 0;
  const res = await openrouterCreateWithRetry(async () => {
    calls++;
    return calls < 3 ? EMPTY_200 : GOOD;
  }, { sleepFn: noSleep });
  assert.equal(calls, 3);
  assert.deepEqual(res, GOOD);
});

test('an empty 200 on the FINAL attempt throws the MARKED error so call sites refuse the Ollama fallback (§2.3)', async () => {
  let calls = 0;
  const failures: Array<{ kind: string; willRetry: boolean }> = [];
  await assert.rejects(
    () => openrouterCreateWithRetry(async () => { calls++; return EMPTY_200; },
      { model: 'google/gemini-2.5-pro', sleepFn: noSleep, onAttemptFailure: (f) => failures.push(f) }),
    (e: unknown) => isProviderResponseError(e),
  );
  assert.equal(calls, OPENROUTER_MAX_TRIES);
  assert.deepEqual(failures.map((f) => f.kind), ['bad_response', 'bad_response', 'bad_response']);
  assert.deepEqual(failures.map((f) => f.willRetry), [true, true, false]);
});

test('an abort error is retryable — an abort that was not retryable would make the deadline strictly worse than no deadline', async () => {
  // The wrapper's timer and controller are private, so the deadline itself cannot be fired from
  // here without a 110s wait. What CAN be pinned is the retry decision an abort produces: the SDK
  // surfaces it as a status-less error, and every status-less throw retries (transport class) —
  // the same decision the timeout path takes.
  let calls = 0;
  const failures: Array<{ kind: string }> = [];
  const res = await openrouterCreateWithRetry(async () => {
    calls++;
    if (calls === 1) throw Object.assign(new Error('Request was aborted.'), { name: 'APIUserAbortError' });
    return GOOD;
  }, { sleepFn: noSleep, onAttemptFailure: (f) => failures.push(f) });
  assert.equal(calls, 2);
  assert.deepEqual(res, GOOD);
  assert.equal(failures[0].kind, 'transport', 'a status-less abort retries on the transport class');
});

test('the onAttemptFailure hook can never be the thing that fails the call', async () => {
  let calls = 0;
  const res = await openrouterCreateWithRetry(async () => {
    calls++;
    if (calls === 1) throw new Error('flaky');
    return GOOD;
  }, { sleepFn: noSleep, onAttemptFailure: () => { throw new Error('observer bug'); } });
  assert.deepEqual(res, GOOD);
});

test('streams are the CALLER\'s exclusion, not the wrapper\'s — the governed call sites keep the bare create() for stream:true', () => {
  // Pinned at the source level: both governed files route ONLY non-streaming params through the
  // wrapper. (classifyProviderResponse has never judged streams, and an in-flight stream must not
  // be aborted by a wall-clock timer.)
  for (const f of ['lib/llm.ts', 'lib/trace.ts']) {
    const text = readFileSync(f, 'utf8');
    assert.ok(text.includes('(orParams as { stream?: boolean }).stream'),
      `${f}: the split keys on the outgoing params' stream flag`);
    assert.ok(text.includes('openrouterCreateWithRetry((ro) => client.chat.completions.create(orParams as any, ro)'),
      `${f}: non-streaming calls go through the shared retry wrapper`);
  }
});

/**
 *   node --test --import tsx lib/__tests__/openrouter-timeout.test.ts
 *
 * OPENROUTER-TIMEOUT-ROOT-CAUSE PRD v1.0 (2 Aug 2026) — the retry helper honours the caller.
 *
 * THE DEFECT: openrouterCreateWithRetry hard-coded OPENROUTER_TIMEOUT_MS (110 s) for BOTH the
 * AbortController deadline and the SDK timeout, discarding the caller's. The OPD audit runs
 * p50 267 s / p75 425 s and passes LLM_AUDIT_TIMEOUT_MS (600 s) through governedChat — so on the
 * OpenRouter bridge THE MEDIAN AUDIT COULD NEVER COMPLETE. From 30 July (bridge live) every
 * median-or-slower audit aborted three times and fell through to the local model: 126 notes graded
 * by qwen2.5:14b overnight, ZERO by Gemini.
 *
 * The fast tail still succeeded — a 79 s manual audit reached Gemini — which is why it read as
 * intermittent rather than broken.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  openrouterCreateWithRetry, OPENROUTER_TIMEOUT_MS, OPENROUTER_MAX_TRIES,
  openRouterRetryable, openRouterBackoffMs, type OpenrouterAttemptOpts,
} from '../openrouter-retry.ts';

/** A doAttempt that records the opts it was handed and resolves with a valid completion. */
function recorder(result: unknown = { choices: [{ message: { content: 'ok' } }] }) {
  const seen: OpenrouterAttemptOpts[] = [];
  const fn = async (o: OpenrouterAttemptOpts) => { seen.push(o); return result; };
  return { fn, seen };
}
/** Reads the AbortController deadline actually armed, by racing the signal rather than the clock. */
const noSleep = async () => {};

// ═════════════════════════════════════════════════════════════════════════════════════════════
// 1 · The ceiling actually applied
// ═════════════════════════════════════════════════════════════════════════════════════════════

test('NO timeoutMs → OPENROUTER_TIMEOUT_MS, byte-identical to before', async () => {
  const { fn, seen } = recorder();
  await openrouterCreateWithRetry(fn, { sleepFn: noSleep });
  assert.equal(seen.length, 1);
  assert.equal(seen[0].timeout, OPENROUTER_TIMEOUT_MS, 'the SDK timeout is the module default');
  assert.equal(seen[0].timeout, 110_000, 'and that default is still 110 s');
  assert.equal(seen[0].maxRetries, 0, 'SDK-internal retries stay off');
});

test('timeoutMs: 600_000 → the doAttempt timeout is 600 000, not 110 000', async () => {
  const { fn, seen } = recorder();
  await openrouterCreateWithRetry(fn, { timeoutMs: 600_000, sleepFn: noSleep });
  assert.equal(seen[0].timeout, 600_000, 'the audit ceiling reaches the provider call');
  assert.notEqual(seen[0].timeout, OPENROUTER_TIMEOUT_MS);
});

test('timeoutMs: 600_000 → the ABORTCONTROLLER deadline is 600 000 too, not just the SDK belt', async () => {
  // Both were hard-coded; fixing only one would still abort the call at 110 s. Rather than wait,
  // capture the delay the timer was armed with by intercepting setTimeout for the duration.
  const realSetTimeout = globalThis.setTimeout;
  const delays: number[] = [];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (globalThis as any).setTimeout = ((cb: () => void, ms?: number, ...rest: unknown[]) => {
    if (typeof ms === 'number') delays.push(ms);
    return realSetTimeout(cb, ms as number, ...(rest as []));
  }) as typeof setTimeout;
  try {
    const { fn } = recorder();
    await openrouterCreateWithRetry(fn, { timeoutMs: 600_000, sleepFn: noSleep });
    assert.ok(delays.includes(600_000), `the abort timer was armed with ${JSON.stringify(delays)}, expected 600000`);
    assert.ok(!delays.includes(110_000), 'and NOT with the old constant');
  } finally {
    globalThis.setTimeout = realSetTimeout;
  }
});

test('a junk timeoutMs degrades to the default — a deadline may never be switched off', async () => {
  for (const bad of [0, -1, NaN, Infinity, undefined]) {
    const { fn, seen } = recorder();
    await openrouterCreateWithRetry(fn, { timeoutMs: bad as number, sleepFn: noSleep });
    assert.equal(seen[0].timeout, OPENROUTER_TIMEOUT_MS, `timeoutMs=${String(bad)}`);
  }
});

test('the terminal error message reports the APPLIED timeout, not the constant', async () => {
  const abortOnly = async (o: OpenrouterAttemptOpts) => {
    // simulate the deadline firing: abort the signal, then throw as the SDK does
    (o.signal as AbortSignal & { dispatchEvent?: unknown });
    await new Promise<void>((r) => setTimeout(r, 0));
    const err = new Error('The user aborted a request.');
    // force ctrl.signal.aborted by aborting through the timer the helper armed
    throw err;
  };
  // Drive a real abort by giving a 1 ms ceiling and never resolving.
  const hang = (o: OpenrouterAttemptOpts) => new Promise((_res, rej) => {
    o.signal.addEventListener('abort', () => rej(new Error('The user aborted a request.')));
  });
  void abortOnly;
  await assert.rejects(
    () => openrouterCreateWithRetry(hang, { timeoutMs: 7, sleepFn: noSleep }),
    (e: Error) => {
      assert.match(e.message, /openrouter TIMEOUT after 7ms/, `got: ${e.message}`);
      assert.ok(!/110000/.test(e.message), 'must not report the constant it did not use');
      assert.match(e.message, new RegExp(`attempt ${OPENROUTER_MAX_TRIES}/${OPENROUTER_MAX_TRIES}`));
      return true;
    },
  );
});

// ═════════════════════════════════════════════════════════════════════════════════════════════
// 2 · What must NOT change
// ═════════════════════════════════════════════════════════════════════════════════════════════

test('OPENROUTER_MAX_TRIES is still 3 and OPENROUTER_TIMEOUT_MS still defaults to 110 000', () => {
  assert.equal(OPENROUTER_MAX_TRIES, 3);
  assert.equal(OPENROUTER_TIMEOUT_MS, 110_000);
  const src = readFileSync('lib/openrouter-retry.ts', 'utf8');
  assert.ok(src.includes('export const OPENROUTER_MAX_TRIES = 3;'));
  assert.ok(src.includes('export const OPENROUTER_TIMEOUT_MS = Number(process.env.OPENROUTER_TIMEOUT_MS) || 110_000;'));
});

test('retry CLASSIFICATION is unchanged: 429 and 5xx retry, 4xx does not', () => {
  assert.equal(openRouterRetryable(429), true);
  assert.equal(openRouterRetryable(500), true);
  assert.equal(openRouterRetryable(503), true);
  assert.equal(openRouterRetryable(400), false);
  assert.equal(openRouterRetryable(401), false);
  assert.equal(openRouterRetryable(404), false);
  assert.equal(openRouterRetryable(422), false);
});

test('a 4xx throws immediately — one attempt, no retry', async () => {
  let calls = 0;
  const http = async () => { calls++; const e = new Error('bad request') as Error & { status: number }; e.status = 400; throw e; };
  await assert.rejects(() => openrouterCreateWithRetry(http, { sleepFn: noSleep }));
  assert.equal(calls, 1, 'a non-transient status must not consume the retry budget');
});

test('a 429 retries the full budget', async () => {
  let calls = 0;
  const rate = async () => { calls++; const e = new Error('rate limited') as Error & { status: number }; e.status = 429; throw e; };
  await assert.rejects(() => openrouterCreateWithRetry(rate, { sleepFn: noSleep, rand: () => 0.5 }));
  assert.equal(calls, OPENROUTER_MAX_TRIES);
});

test('an ABORT retries — a deadline that ended the call must not end the budget', async () => {
  let calls = 0;
  const hang = (o: OpenrouterAttemptOpts) => { calls++; return new Promise((_r, rej) => {
    o.signal.addEventListener('abort', () => rej(new Error('The user aborted a request.')));
  }); };
  await assert.rejects(() => openrouterCreateWithRetry(hang, { timeoutMs: 5, sleepFn: noSleep }));
  assert.equal(calls, OPENROUTER_MAX_TRIES, 'aborts retry on the same bounded budget');
});

test('the backoff curve is untouched', () => {
  assert.equal(openRouterBackoffMs(1, () => 0.5), 500);
  assert.equal(openRouterBackoffMs(2, () => 0.5), 1000);
  assert.equal(openRouterBackoffMs(3, () => 0.5), 2000);
});

// ═════════════════════════════════════════════════════════════════════════════════════════════
// 3 · The plumbing and the boxes
// ═════════════════════════════════════════════════════════════════════════════════════════════

/**
 * ⚠️ EVERY call site of openrouterCreateWithRetry must forward BOTH the caller's ceiling and its
 * try count. This test used to slice `lib/llm.ts` ALONE — and that is exactly why the defect
 * survived: there are TWO call sites, and 3039c42 fixed only the one production does not use.
 *
 * `lib/trace.ts`'s tracedChat has its own inline OpenRouter branch (it does NOT delegate to
 * chatWithFallback), and BOTH production audit paths are traced — the OPD worker calls
 * auditOpdNote with no options and the IPD run calls analyzeCase with no `trace` option, so both
 * get a traceId and route through tracedChat. The fix credited to 3039c42 therefore never reached
 * either worker.
 *
 * ENUMERATING the sites rather than naming one is the point: a third call site added tomorrow
 * fails here instead of silently reintroducing a 110 s ceiling in front of a 380 s leg.
 */
const RETRY_CALL_SITES = ['lib/llm.ts', 'lib/trace.ts'] as const;

test('EVERY openrouterCreateWithRetry call site forwards the caller timeout AND maxTries', () => {
  for (const path of RETRY_CALL_SITES) {
    const src = readFileSync(path, 'utf8');
    const i = src.indexOf('await openrouterCreateWithRetry');
    assert.ok(i >= 0, `${path}: expected a call site here`);
    const branch = src.slice(i, src.indexOf("endProviderCall('openrouter');", i));
    assert.ok(/timeoutMs[,:]/.test(branch), `${path}: the per-attempt ceiling is dropped — this IS the defect`);
    assert.ok(/maxTries[,:]/.test(branch), `${path}: the try count is dropped`);
  }
});

/**
 * ⚠️ WIDENED IN UNIT V-a1 (3 Aug 2026): TWO SITES BECAME FOUR.
 *
 * This enumeration existed because 3039c42 fixed one OpenRouter site and missed its twin, and the
 * gap survived three days with both production audit paths on a 110 s ceiling. Unit V-a1 gives the
 * VERTEX chat branch the same shared loop in both files, so the same lesson now covers four sites:
 * lib/llm.ts and lib/trace.ts, each with an OpenRouter and a Vertex call.
 *
 * Per-site assertions live in lib/__tests__/vertex-retry-parity.test.ts, which enumerates all four
 * by name. This test guards the COUNT, so a fifth site cannot appear unnoticed.
 */
test('there are exactly FOUR provider call sites — a fifth must be enumerated', () => {
  const roots = ['lib/llm.ts', 'lib/trace.ts', 'lib/opd-note-audit.ts', 'lib/doc-audit.ts', 'lib/openrouter-retry.ts', 'lib/gemini-multimodal.ts'];
  let openrouterSites = 0;
  let vertexSites = 0;
  for (const p of roots) {
    const s = readFileSync(p, 'utf8');
    // `await createWithRetry(` is a SUFFIX of `await openrouterCreateWithRetry(`, so count the
    // wrapped form first and subtract it out rather than double-counting.
    const wrapped = (s.match(/await openrouterCreateWithRetry\(/g) ?? []).length;
    const all = (s.match(/await createWithRetry\(/g) ?? []).length;
    openrouterSites += wrapped;
    vertexSites += all;
  }
  assert.equal(openrouterSites, 2, 'lib/llm.ts and lib/trace.ts, one OpenRouter call each');
  assert.equal(vertexSites, 2, 'lib/llm.ts and lib/trace.ts, one Vertex call each');
  assert.equal(openrouterSites + vertexSites, 4,
    'a new call site must be enumerated in vertex-retry-parity.test.ts, or it can drop the caller\'s ' +
    'bounds unnoticed the way trace.ts did for three days after 3039c42');
  // The OpenRouter sites are still the two this file has always named.
  assert.deepEqual(RETRY_CALL_SITES.filter((p) => /await openrouterCreateWithRetry/.test(readFileSync(p, 'utf8'))),
    [...RETRY_CALL_SITES]);
});

test("chatWithFallback's OpenRouter branch passes the caller's timeout through", () => {
  const src = readFileSync('lib/llm.ts', 'utf8');
  const branch = src.slice(src.indexOf('await openrouterCreateWithRetry'), src.indexOf('endProviderCall(\'openrouter\');'));
  assert.ok(/\btimeoutMs,/.test(branch), 'the branch that previously dropped it now forwards it');
  // the Vertex/Ollama branches keep using reqOpts, untouched
  assert.ok(src.includes('const reqOpts = timeoutMs ? { timeout: timeoutMs } : undefined;'), 'reqOpts unchanged');
  // ⚠️ SHAPE CHANGED, GUARD DID NOT (rerank telemetry §4.4, 11 Aug 2026). The Ollama return is now
  // wrapped in `attachTransportAttribution(...)` so the traceless rerank path can report its served
  // provider. This test is about the CEILING, not the wrapper: what it must still prove is that the
  // Ollama path carries `reqOpts` — the per-request timeout — exactly as before. That is asserted
  // directly below, on the call itself, which is a tighter check than the old whole-line match.
  assert.ok(src.includes('await llm.chat.completions.create(params, reqOpts)'),
    'the Ollama path still carries the per-request ceiling (reqOpts), unchanged');
  // The negative is checked against CODE ONLY. `chatWithFallback`'s own doc comment says it is
  // "byte-identical to `llm.chat.completions.create(params)`" when no gemini model is given, and a
  // raw-source match would read that prose as a ceiling-dropping call site.
  const llmCode = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  assert.equal((llmCode.match(/llm\.chat\.completions\.create\(params, reqOpts\)/g) || []).length, 2,
    'both fallback call sites carry reqOpts');
  assert.equal(/llm\.chat\.completions\.create\(params\s*\)/.test(llmCode), false,
    'and no fallback call ever drops reqOpts');
});

test("tracedChat's OpenRouter branch — THE PRODUCTION PATH — passes both through", () => {
  const src = readFileSync('lib/trace.ts', 'utf8');
  const branch = src.slice(src.indexOf('await openrouterCreateWithRetry'), src.indexOf("endProviderCall('openrouter');"));
  // V-a2 (4 Aug 2026): the caller's ceiling still reaches the loop, now CLAMPED to what the leg
  // has left (tierCeilingMs) so a tier-2 hop runs on tier 1's remainder, never a fresh budget.
  assert.ok(branch.includes('timeoutMs: tierCeilingMs(opts?.timeoutMs, deadlineAt),'));
  assert.ok(branch.includes('maxTries: opts?.maxTries,'));
  // reqOpts still serves the branches that never had a retry loop.
  assert.ok(src.includes('const reqOpts = opts?.timeoutMs ? { timeout: opts.timeoutMs } : undefined;'));
});

test('the IPD worker box is 800 s, matching the OPD worker', () => {
  const ipd = readFileSync('app/api/ipd-audit/worker/route.ts', 'utf8');
  assert.ok(ipd.includes('export const maxDuration = 800;'), 'a 600 s call cannot live in a 300 s box');
  const opd = readFileSync('app/api/opd-audit/worker/route.ts', 'utf8');
  assert.ok(opd.includes('export const maxDuration = 800;'), 'the OPD worker is untouched and still 800');
});

test('this build did not disturb the OPD cron window', () => {
  // ⚠️ SUPERSEDED IN PART. This test used to assert the IPD worker cron was ABSENT (DEC-2, on the
  // premise that the route "produced nothing"). That premise was WRONG and was withdrawn the same
  // day: ipd_discharge_audits shows 19 audits on 2 Aug, 18 on 1 Aug, 37 on 31 Jul. The cron was
  // restored at a cadence that clears the box, and lib/__tests__/ipd-worker-batch-and-model.test.ts
  // now owns every assertion about it — including the coupling this file's defects were about
  // (a cron interval must exceed the route's maxDuration, or invocations overlap).
  //
  // What remains here is what this build is actually responsible for: it must not have touched the
  // OPD window, which is the one the timeout fix was shipped in time for.
  const cfg = JSON.parse(readFileSync('vercel.json', 'utf8')) as { crons: { path: string; schedule: string }[] };
  // ⚠️ The path lost its `?conc=4` on 3 Aug (Unit D, Task 11) so the route's re-sized defaults
  // apply; the SCHEDULE, which is what this build was responsible for not disturbing, is unchanged.
  assert.ok(cfg.crons.some((c) => c.path === '/api/opd-audit/worker' && c.schedule === '*/4 18-23,0-2 * * *'),
    'the OPD overnight window is not disturbed');
});

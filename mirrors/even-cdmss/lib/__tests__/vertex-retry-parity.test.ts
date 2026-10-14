/**
 *   node --test --import tsx lib/__tests__/vertex-retry-parity.test.ts
 *
 * UNIT V-a1 (PRD §5, 3 Aug 2026) — the Vertex path gets the discipline OpenRouter already had.
 *
 * WHY. Vertex is about to become primary, and read in source on 3 August it was materially less
 * developed than the path it is replacing:
 *
 *   capability                          OpenRouter chat   Vertex chat        Vertex doc_read
 *   per-attempt abort deadline          yes               no (SDK timeout)   NONE
 *   bounded retry with backoff          yes               no                 no
 *   429 / 5xx retryable                 yes               no                 no (returns null)
 *   a 200 that is not a completion      yes               NO                 no
 *
 * `lib/gemini-multimodal.ts` records what the missing deadline already cost: Record audit HUNG at
 * ">399s at 'Reading document', no trace, no fallback" instead of failing. An unbounded call that
 * has already hung once, on the path about to carry every audit.
 *
 * ⚠️ THIS UNIT IS INERT ON PRODUCTION TODAY. With GEMINI_VIA_OPENROUTER=1, `useOpenRouter` is true
 * for every Gemini call, so `useGemini` is always false and the Vertex branch never executes. These
 * tests pin code that does not currently run — deliberately, before it does.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  createWithRetry, openrouterCreateWithRetry,
  OPENROUTER_MAX_TRIES, OPENROUTER_TIMEOUT_MS,
  openRouterRetryable, openRouterBackoffMs,
  type RetryAttemptOpts, type RetryAttemptFailure,
} from '../openrouter-retry';
import { isProviderResponseError } from '../provider-error-core';
import { DOC_READ_TIMEOUT_MS } from '../doc-transport-core';

const GOOD = { choices: [{ message: { content: 'ok' } }] };
const EMPTY_200 = { choices: [] };
const noSleep = async () => {};
const transient = () => Object.assign(new Error('rate limited'), { status: 429 });

const TRACE = readFileSync('lib/trace.ts', 'utf8');
const LLM = readFileSync('lib/llm.ts', 'utf8');
const MM = readFileSync('lib/gemini-multimodal.ts', 'utf8');
const RETRY = readFileSync('lib/openrouter-retry.ts', 'utf8');

// ═════════════════════════════════════════════════════════════════════════════════════════════
// 1 · The loop is provider-neutral
// ═════════════════════════════════════════════════════════════════════════════════════════════

test('provider reaches the terminal error, the marked error, and every failure report', async () => {
  const failures: RetryAttemptFailure[] = [];
  const hang = (o: RetryAttemptOpts) => new Promise((_r, rej) => {
    o.signal.addEventListener('abort', () => rej(new Error('The user aborted a request.')));
  });
  await assert.rejects(
    () => createWithRetry(hang, { provider: 'vertex', timeoutMs: 5, maxTries: 1, sleepFn: noSleep, onAttemptFailure: (f) => failures.push(f) }),
    (e: Error) => {
      assert.match(e.message, /^vertex TIMEOUT after 5ms \(attempt 1\/1\)$/,
        `a vertex failure must not be reported as openrouter — got: ${e.message}`);
      return true;
    },
  );
  assert.deepEqual(failures.map((f) => f.provider), ['vertex']);
});

test('the marked empty-200 error names the provider that produced it', async () => {
  await assert.rejects(
    () => createWithRetry(async () => EMPTY_200, { provider: 'vertex', model: 'gemini-2.5-pro', maxTries: 1, sleepFn: noSleep }),
    (e: unknown) => {
      assert.ok(isProviderResponseError(e), 'still the MARKED class, so §2.3 call sites still refuse the fallback');
      assert.match((e as Error).message, /vertex/, 'and it says vertex');
      return true;
    },
  );
});

test('DEFAULT provider is openrouter — every pre-Unit-V call site is byte-identical', async () => {
  const hang = (o: RetryAttemptOpts) => new Promise((_r, rej) => {
    o.signal.addEventListener('abort', () => rej(new Error('aborted')));
  });
  await assert.rejects(
    () => createWithRetry(hang, { timeoutMs: 5, maxTries: 1, sleepFn: noSleep }),
    (e: Error) => { assert.match(e.message, /^openrouter TIMEOUT after 5ms/); return true; },
  );
});

// ═════════════════════════════════════════════════════════════════════════════════════════════
// 2 · classify — what makes the loop reusable
// ═════════════════════════════════════════════════════════════════════════════════════════════

test('a caller classifier REPLACES the OpenAI-shaped default', async () => {
  // The native Vertex :generateContent body is `candidates[0].content.parts`, so the default
  // classifier would call every VALID response defective. A caller supplies its own.
  const nativeBody = { candidates: [{ content: { parts: [{ text: 'hello' }] } }] };
  const nativeClassify = (r: unknown) => {
    const parts = (r as { candidates?: { content?: { parts?: { text?: string }[] } }[] })?.candidates?.[0]?.content?.parts ?? [];
    const text = parts.map((p) => p?.text || '').join('');
    return text ? null : { kind: 'empty_content' as const, finish_reason: null, native_finish_reason: null, content_length: 0, served_by: null, response_error: null, body: null };
  };
  // …with the DEFAULT classifier this body is defective and burns the whole budget…
  let defaultCalls = 0;
  await assert.rejects(() => createWithRetry(async () => { defaultCalls++; return nativeBody; },
    { provider: 'vertex', maxTries: 2, sleepFn: noSleep }));
  assert.equal(defaultCalls, 2, 'the OpenAI-shaped default rejects a valid native body — hence classify');
  // …and with the caller's, it returns on attempt 1.
  let nativeCalls = 0;
  const res = await createWithRetry(async () => { nativeCalls++; return nativeBody; },
    { provider: 'vertex', classify: nativeClassify, maxTries: 2, sleepFn: noSleep });
  assert.deepEqual(res, nativeBody);
  assert.equal(nativeCalls, 1);
});

test('classify: () => null opts out of body judgement entirely', async () => {
  const res = await createWithRetry(async () => EMPTY_200, { classify: () => null, maxTries: 1, sleepFn: noSleep });
  assert.deepEqual(res, EMPTY_200, 'pre-classification behaviour, exactly');
});

test('the default IS classifyProviderResponse — no call site loses validation by omission', async () => {
  assert.ok(RETRY.includes('const classify = cfg.classify ?? classifyProviderResponse;'));
  await assert.rejects(() => createWithRetry(async () => EMPTY_200, { maxTries: 1, sleepFn: noSleep }),
    (e: unknown) => isProviderResponseError(e));
});

// ═════════════════════════════════════════════════════════════════════════════════════════════
// 3 · Per-call defaults, and the degrade discipline
// ═════════════════════════════════════════════════════════════════════════════════════════════

test('defaultTimeoutMs / defaultMaxTries apply when the CALLER passes nothing', async () => {
  const seen: RetryAttemptOpts[] = [];
  let calls = 0;
  await assert.rejects(() => createWithRetry(async (o) => { seen.push(o); calls++; throw transient(); },
    { provider: 'vertex', defaultTimeoutMs: 42_000, defaultMaxTries: 2, sleepFn: noSleep, rand: () => 0.5 }));
  assert.equal(seen[0].timeout, 42_000, 'a non-OpenRouter caller need not inherit OpenRouter constants');
  assert.equal(calls, 2);
});

test('the CALLER still wins over the per-call default', async () => {
  const seen: RetryAttemptOpts[] = [];
  let calls = 0;
  await assert.rejects(() => createWithRetry(async (o) => { seen.push(o); calls++; throw transient(); },
    { defaultTimeoutMs: 42_000, defaultMaxTries: 3, timeoutMs: 7_000, maxTries: 1, sleepFn: noSleep }));
  assert.equal(seen[0].timeout, 7_000);
  assert.equal(calls, 1);
});

test('a junk DEFAULT degrades to the module constant — it can never disable a bound', async () => {
  for (const bad of [0, -1, NaN, undefined]) {
    const seen: RetryAttemptOpts[] = [];
    await createWithRetry(async (o) => { seen.push(o); return GOOD; },
      { defaultTimeoutMs: bad as number, defaultMaxTries: bad as number, sleepFn: noSleep });
    assert.equal(seen[0].timeout, OPENROUTER_TIMEOUT_MS, `defaultTimeoutMs=${String(bad)}`);
  }
  let calls = 0;
  await assert.rejects(() => createWithRetry(async () => { calls++; throw transient(); },
    { defaultMaxTries: 0, sleepFn: noSleep, rand: () => 0.5 }));
  assert.equal(calls, OPENROUTER_MAX_TRIES, 'a zero default must not mean zero attempts');
});

// ═════════════════════════════════════════════════════════════════════════════════════════════
// 4 · Nothing the lab depends on moved
// ═════════════════════════════════════════════════════════════════════════════════════════════

test('all four re-exported symbols still resolve at their current values', () => {
  // lib/opd-note-audit.ts imports AND re-exports these four; openRouterGenerate uses them, and
  // every lab call site and test resolves through that re-export. Breaking one breaks the lab.
  assert.equal(OPENROUTER_MAX_TRIES, 3);
  assert.equal(OPENROUTER_TIMEOUT_MS, 110_000);
  assert.equal(openRouterRetryable(429), true);
  assert.equal(openRouterRetryable(400), false);
  assert.equal(openRouterBackoffMs(2, () => 0.5), 1000);
  const audit = readFileSync('lib/opd-note-audit.ts', 'utf8');
  assert.ok(audit.includes("import { OPENROUTER_MAX_TRIES, openRouterRetryable, openRouterBackoffMs, OPENROUTER_TIMEOUT_MS } from './openrouter-retry';"));
  assert.ok(audit.includes('export { OPENROUTER_MAX_TRIES, openRouterRetryable, openRouterBackoffMs, OPENROUTER_TIMEOUT_MS };'));
});

test('openrouterCreateWithRetry is still exported and still a pure pass-through', async () => {
  assert.equal(typeof openrouterCreateWithRetry, 'function');
  assert.ok(RETRY.includes("return createWithRetry(doAttempt, { ...cfg, provider: 'openrouter' });"),
    'a thin wrapper, not a second implementation');
  const res = await openrouterCreateWithRetry(async () => GOOD, { sleepFn: noSleep });
  assert.deepEqual(res, GOOD);
});

// ═════════════════════════════════════════════════════════════════════════════════════════════
// 5 · ALL FOUR provider call sites — a fifth must fail this
// ═════════════════════════════════════════════════════════════════════════════════════════════

/**
 * Every place a chat call reaches a provider through the shared loop. Unit D taught the sibling
 * enumeration in openrouter-timeout.test.ts to check BOTH OpenRouter sites after 3039c42 fixed one
 * and missed the other for three days. Unit V-a1 doubles the count, and the lesson holds: a call
 * site that is not enumerated is a call site that can silently drop the caller's bounds.
 */
const PROVIDER_CALL_SITES = [
  { file: 'lib/llm.ts', provider: 'openrouter', fn: 'openrouterCreateWithRetry' },
  { file: 'lib/llm.ts', provider: 'vertex', fn: 'createWithRetry' },
  { file: 'lib/trace.ts', provider: 'openrouter', fn: 'openrouterCreateWithRetry' },
  { file: 'lib/trace.ts', provider: 'vertex', fn: 'createWithRetry' },
] as const;

test('there are exactly FOUR provider call sites — a fifth must be enumerated here', () => {
  const roots = ['lib/llm.ts', 'lib/trace.ts', 'lib/opd-note-audit.ts', 'lib/doc-audit.ts', 'lib/gemini-multimodal.ts'];
  let found = 0;
  for (const f of roots) {
    const s = readFileSync(f, 'utf8');
    // `await openrouterCreateWithRetry(` also matches `await createWithRetry(` as a suffix, so
    // count the bare-name occurrences and subtract the wrapped ones to avoid double-counting.
    const all = (s.match(/await createWithRetry\(/g) ?? []).length;
    const wrapped = (s.match(/await openrouterCreateWithRetry\(/g) ?? []).length;
    found += all + wrapped;
  }
  assert.equal(found, PROVIDER_CALL_SITES.length,
    'a new provider call site must be added to PROVIDER_CALL_SITES, or it can drop the caller\'s ' +
    'timeout and try count unnoticed — exactly what trace.ts did for three days after 3039c42');
});

test('EVERY provider call site forwards the caller timeout AND maxTries', () => {
  for (const site of PROVIDER_CALL_SITES) {
    const s = readFileSync(site.file, 'utf8');
    const marker = site.provider === 'openrouter' ? 'await openrouterCreateWithRetry(' : "provider: 'vertex',";
    const i = s.indexOf(marker);
    assert.ok(i > -1, `${site.file}: no ${site.provider} call site`);
    const branch = s.slice(i, s.indexOf("endProviderCall('", i));
    assert.ok(/timeoutMs[,:]/.test(branch), `${site.file} ${site.provider}: the per-attempt ceiling is dropped`);
    assert.ok(/maxTries[,:]/.test(branch), `${site.file} ${site.provider}: the try count is dropped`);
  }
});

test('the Vertex chat branch is wrapped in BOTH files, and identifies itself as vertex', () => {
  // V-a2: the Vertex arm lives inside the cloud-ladder loop, textually AFTER the OpenRouter arm
  // in both files — so slicing from its beginProviderCall to the end of the file must contain the
  // shared loop and must NOT contain the OpenRouter wrapper.
  for (const [name, s] of [['trace.ts', TRACE], ['llm.ts', LLM]] as const) {
    const gem = s.slice(s.indexOf("beginProviderCall('gemini');"));
    assert.ok(gem.includes('await createWithRetry('), `${name}: the Vertex call runs the shared loop`);
    assert.ok(gem.includes("provider: 'vertex',"), `${name}: reported as vertex`);
    assert.ok(gem.includes('[provider-retry] vertex '), `${name}: log prefix matches the OpenRouter one`);
    assert.ok(!gem.includes('openrouterCreateWithRetry'), `${name}: not through the OpenRouter wrapper`);
  }
});

test('THE REGION AND SERVICE IDENTITY SURVIVE — they are the Vertex path\'s whole advantage', () => {
  // Reason 4 for moving to Vertex: it names WHERE the call landed and WHICH identity made it.
  // The OpenRouter branch passes null for both, and a per-region quota denial reads identically to
  // a global IAM denial without them. Wrapping the call must not lose them.
  for (const [name, s] of [['trace.ts', TRACE], ['llm.ts', LLM]] as const) {
    assert.ok(s.includes('region: vertexRegion(), saIdentity: vertexSaEmail(),'),
      `${name}: the Vertex provider_error payload still names region and identity`);
  }
});

// ═════════════════════════════════════════════════════════════════════════════════════════════
// 6 · The stream_options self-heal is preserved, and does NOT consume a retry
// ═════════════════════════════════════════════════════════════════════════════════════════════

test('the self-heal lives INSIDE the attempt closure — healing must not spend the budget', () => {
  const i = TRACE.indexOf('result = await createWithRetry(async (ro) => {');
  assert.ok(i > -1, 'the Vertex attempt is a closure');
  const closure = TRACE.slice(i, TRACE.indexOf("provider: 'vertex',", i));
  assert.ok(closure.includes('if (wantUsage && gParams.stream_options) {'), 'the self-heal is still here');
  assert.ok(closure.includes('delete gParams.stream_options;'), 'and still strips the field');
  assert.ok(closure.includes('throw soErr;'), 'and still rethrows when it does not apply');
  // Two create() calls inside ONE attempt: the original and the healed retry.
  assert.equal((closure.match(/gemini\.chat\.completions\.create\(gParams as any, ro\)/g) ?? []).length, 2,
    'the heal retries within the attempt, so it costs no rung of the ladder');
});

test('the provider-call accounting still pairs', () => {
  for (const [name, s] of [['trace.ts', TRACE], ['llm.ts', LLM]] as const) {
    assert.ok(s.includes("beginProviderCall('gemini')"), `${name}: begin`);
    assert.ok(s.includes("endProviderCall('gemini')"), `${name}: end`);
  }
});

// ═════════════════════════════════════════════════════════════════════════════════════════════
// 7 · The document read is BOUNDED (V-4, bounding half only)
// ═════════════════════════════════════════════════════════════════════════════════════════════

test('the Vertex doc_read fetch finally has a signal — its absence is why Record audit HUNG', () => {
  const vertexFn = MM.slice(MM.indexOf('export async function generateFromDocument('));
  assert.ok(vertexFn.includes('const ctl = new AbortController();'), 'a controller');
  assert.ok(vertexFn.includes('setTimeout(() => ctl.abort(), DOC_READ_TIMEOUT_MS)'), 'armed at the shared bound');
  assert.ok(vertexFn.includes('signal: ctl.signal,'), 'THE SIGNAL ACTUALLY REACHES THE FETCH');
  assert.ok(vertexFn.includes('clearTimeout(timer);'), 'and is cleared on every exit');
  assert.equal(DOC_READ_TIMEOUT_MS, 180_000, 'unchanged — this unit adds no new number');
});

test('doc_read failures are STRUCTURED and name region + identity, and still return null', () => {
  const vertexFn = MM.slice(MM.indexOf('export async function generateFromDocument('));
  // The two bare console.warns are gone; both paths now emit the same payload shape as the chat path.
  assert.ok(!/console\.warn\(`\[multimodal\] vertex generateContent/.test(MM), 'the !res.ok warn is gone');
  assert.ok(!/console\.warn\('\[multimodal\] fetch failed'/.test(MM), 'the catch warn is gone');
  assert.ok(!/console\.warn\('\[multimodal\] token mint failed'/.test(MM), 'the token-mint warn is gone');
  assert.equal((vertexFn.match(/region: vertexRegion\(\), saIdentity: vertexSaEmail\(\),/g) ?? []).length, 3,
    'token mint, !res.ok and the catch all name where the call landed and who made it');
  assert.ok(vertexFn.includes("console.error('[provider-fallback] vertex document read"), 'loud, stable prefix');
  // ⚠️ THE CONTRACT DOES NOT CHANGE: null still means "unreadable" to the caller.
  assert.ok(vertexFn.includes('return null;'), 'still soft-fails to null');
});

test('⚠️ doc_read has NO RETRY in this unit, and that is ARITHMETIC — not caution', () => {
  const vertexFn = MM.slice(MM.indexOf('export async function generateFromDocument('));
  assert.ok(!vertexFn.includes('createWithRetry'), 'the read is bounded, not retried');
  // The PRD's V-4 checked a retry against the per-CALL budget. The route budget is per DOCUMENT:
  //   1 try   180,000 + 3 × 200,000 = 780,000  in 800,000  fits
  //   2 tries 360,750 + 3 × 200,000 = 960,750  in 800,000  OVER by 160,750
  // Proven here from the live table rather than restated, so a later budget change re-opens it.
  const { PROVIDER_BUDGETS, totalBudgetMs, backoffAllowanceMs } = require('../lab-provider-core');
  const docRead = PROVIDER_BUDGETS.openrouter.doc_read;
  const analyze = totalBudgetMs('openrouter', 'audit_ipd');
  const oneTry = docRead.perAttemptMs * 1 + backoffAllowanceMs(1) + analyze * 3;
  const twoTries = docRead.perAttemptMs * 2 + backoffAllowanceMs(2) + analyze * 3;
  assert.equal(oneTry, 780_000);
  assert.equal(twoTries, 960_750);
  assert.ok(oneTry <= 800_000, 'one try fits the IPD worker box');
  assert.ok(twoTries > 800_000, 'a second try does NOT — hence V-a2, after the budgets are re-derived');
});

// ═════════════════════════════════════════════════════════════════════════════════════════════
// 8 · THE FALLBACK LADDER IS UNTOUCHED — V-a2 must be a deliberate act
// ═════════════════════════════════════════════════════════════════════════════════════════════

test('the Ollama fallback is still PRESENT and still CALLED in both files', () => {
  // V-a2 (4 Aug 2026) IS the deliberate act the old wording of this test held the door for: the
  // AUDIT paths now pass `noLocalFallback: true` and take the throw instead. The fallback itself
  // must remain present and callable — it still serves /ask, /ddx, /topics, the cite gate and
  // every other caller that does not set the flag, and it is the ladder's terminal for them. If
  // this test ever fails as a SIDE EFFECT, something removed the fallback without meaning to.
  assert.ok(TRACE.includes("result = await runOllamaFallback(lastTier, servedModel, lastErr, () => llm.chat.completions.create(params, reqOpts));"),
    'trace.ts: the ladder terminal still calls the Ollama fallback');
  // ⚠️ SHAPE CHANGED, GUARD DID NOT (rerank telemetry §4.4, 11 Aug 2026). llm.ts's fallback returns
  // are now wrapped in `attachTransportAttribution(...)` — a non-enumerable evidence property on the
  // completion, so the TRACELESS rerank path can name the provider that actually served it. The
  // question this test asks is "is the fallback still present and still called", and the answer is
  // still yes: same `params`, same `reqOpts`, still awaited, still returned. Asserted on the call
  // rather than the whole line so the wrapper cannot hide a change to the call itself.
  assert.ok(LLM.includes('await llm.chat.completions.create(params, reqOpts)'),
    'llm.ts: the fallback returns are intact — same params, same reqOpts');
  assert.equal((LLM.match(/llm\.chat\.completions\.create\(params, reqOpts\)/g) || []).length, 2,
    'llm.ts: still exactly two fallback call sites — the no-cloud default path and the ladder terminal');
  // …and the flag is the ONLY thing that bypasses it (throw before the fallback, never silently).
  assert.ok(TRACE.includes('if (opts?.noLocalFallback) throw lastErr;'), 'trace.ts: flag ⇒ throw');
  assert.ok(LLM.includes('if (noLocalFallback) throw lastErr;'), 'llm.ts: flag ⇒ throw');
  // The catches still record the destination they actually take (next tier, ollama, or none).
  assert.ok(TRACE.includes("(opts?.noLocalFallback ? 'none' : 'ollama')"), 'trace.ts still records the destination');
  assert.ok(LLM.includes("(noLocalFallback ? 'none' : 'ollama')"), 'llm.ts still records the destination');
});

test('no PROVIDER_BUDGETS value moved in this unit', () => {
  const { PROVIDER_BUDGETS } = require('../lab-provider-core');
  assert.deepEqual(PROVIDER_BUDGETS.vertex, {
    audit: { perAttemptMs: 380_000, maxTries: 1 },
    audit_ipd: { perAttemptMs: 200_000, maxTries: 1 },
    utility: { perAttemptMs: 110_000, maxTries: 3 },
    doc_read: { perAttemptMs: 180_000, maxTries: 1 },
  }, 'the vertex row was already correct — maxTries:1 simply stops being vacuous now that Vertex has a loop');
});

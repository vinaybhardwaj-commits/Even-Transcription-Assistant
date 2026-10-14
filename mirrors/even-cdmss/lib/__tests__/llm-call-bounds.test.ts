/**
 * lib/__tests__/llm-call-bounds.test.ts — D-1 (Right Care reliability §3, 31 Jul 2026):
 * bound every provider call.
 *
 *   node --test --import tsx lib/__tests__/llm-call-bounds.test.ts
 *
 * Kickoff §Tests 1–5. The constants are module-level env reads, so the matrix runs against the
 * exported pure resolvers (the resolveEnvRerankBackend pattern, ratified in Addendum B) and the
 * client constructions are pinned at the source. Test 5 is FUNCTIONAL: a local HTTP server that
 * accepts and never responds proves the ceiling fires, surfaces as a normal Error, and that
 * maxRetries 0 means exactly one wire call.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { PROVIDER_BUDGETS } from '../lab-provider-core';
import { OPD_AUDIT_LEGS } from '../opd-note-audit';
import { createServer } from 'node:http';
import OpenAI from 'openai';
import {
  resolveLlmTimeoutMs, resolveLlmMaxRetries,
  LLM_CALL_TIMEOUT_MS, LLM_MAX_RETRIES, LLM_AUDIT_TIMEOUT_MS,
} from '../llm.ts';

// ── §T1 — defaults, asserted not assumed (env unset in the test run) ──
test('T1: defaults are 90000 / 0 / 600000', () => {
  assert.equal(process.env.LLM_CALL_TIMEOUT_MS, undefined, 'precondition: env unset in tests');
  assert.equal(process.env.LLM_MAX_RETRIES, undefined, 'precondition: env unset in tests');
  assert.equal(process.env.LLM_AUDIT_TIMEOUT_MS, undefined, 'precondition: env unset in tests');
  assert.equal(LLM_CALL_TIMEOUT_MS, 90_000);
  assert.equal(LLM_MAX_RETRIES, 0);
  assert.equal(LLM_AUDIT_TIMEOUT_MS, 600_000);
});

// ── §T2 — env-overridable; non-numeric falls back, never NaN ──
test('T2: resolvers honour numeric overrides and fall back on garbage', () => {
  assert.equal(resolveLlmTimeoutMs('120000', 90_000), 120_000);
  assert.equal(resolveLlmTimeoutMs('45000.9', 90_000), 45_000);
  for (const bad of [undefined, '', 'abc', '0', '-5', 'NaN']) {
    const r = resolveLlmTimeoutMs(bad, 90_000);
    assert.equal(r, 90_000, `timeout ${JSON.stringify(bad)} must fall back, got ${r}`);
    assert.ok(Number.isFinite(r), 'never NaN');
  }
  assert.equal(resolveLlmMaxRetries('2'), 2);
  assert.equal(resolveLlmMaxRetries('1.7'), 1);
  assert.equal(resolveLlmMaxRetries('0'), 0);
  for (const bad of [undefined, '', 'abc', '-1']) {
    const r = resolveLlmMaxRetries(bad);
    assert.equal(r, 0, `retries ${JSON.stringify(bad)} must fall back to 0, got ${r}`);
    assert.ok(Number.isFinite(r), 'never NaN');
  }
});

// ── §T3 — all three clients constructed with explicit timeout + maxRetries ──
test('T3: every new OpenAI(...) in lib/llm.ts carries timeout + maxRetries', () => {
  const src = readFileSync('lib/llm.ts', 'utf8');
  const constructions = src.match(/new OpenAI\(\{[^}]*\}\)/gs) ?? [];
  assert.equal(constructions.length, 3, 'exactly the three known clients (ollama, openrouter, vertex)');
  for (const c of constructions) {
    assert.ok(c.includes('timeout: LLM_CALL_TIMEOUT_MS'), `construction missing explicit timeout: ${c.slice(0, 80)}…`);
    assert.ok(c.includes('maxRetries: LLM_MAX_RETRIES'), `construction missing explicit maxRetries: ${c.slice(0, 80)}…`);
  }
});

// ── §T4 — THE REGRESSION GUARD: the audit's effective ceiling clears real latency, not 90 s ──
//
// ⚠️ THE SOURCE OF THAT CEILING CHANGED ON 3 AUGUST (DEC-B9), and its premise was disproven.
// This test used to require `timeoutMs: LLM_AUDIT_TIMEOUT_MS` at the call site and to justify it
// with "p75 is 425 s". BOTH have moved:
//   · The 425 s figure was carried between documents and never re-measured. MEASURED on
//     v_trace_summary, opd_note_audit successes 30 Jul–2 Aug: p50 52–93 s, p75 90–209 s,
//     p95 309–393 s. The ceiling must clear the real distribution, not the retracted one.
//   · Once tracedChat began forwarding the caller's ceiling into openrouterCreateWithRetry,
//     LLM_AUDIT_TIMEOUT_MS (600,000) and PROVIDER_BUDGETS.audit.perAttemptMs became the same slot.
//     600,000 × 2 legs is 1,200,000 in an 800,000 box, so V ruled the call site sends the BUDGET.
//
// THE PROPERTY THIS TEST DEFENDS IS UNCHANGED: the audit's effective ceiling must be an explicit
// audit-class value that comfortably clears measured latency, and must never fall back to the 90 s
// general client bound, which would break the engine.
test('T4: the audit call site passes an audit-class ceiling that clears measured latency', () => {
  const audit = readFileSync('lib/opd-note-audit.ts', 'utf8');
  const budget = PROVIDER_BUDGETS.openrouter.audit!;

  // The effective ceiling is the budget, named at the call site rather than restated.
  // Bedrock S2 (7 Aug): resolved one line earlier into `budget`, from the provider that will serve
  // the call. Still the budget, still named rather than restated — the property T4 guards.
  assert.match(audit, /const budget = opdAuditBudget\(/, 'the ceiling is resolved from the budget table');
  assert.match(audit, /governedChat\(traceId, 'opd_audit_analyze', params, \{[^}]*timeoutMs: budget\.perAttemptMs/s,
    'opd_audit_analyze must pass the audit budget as its ceiling (DEC-B9)');
  // ⚠️ COMPARE LIKE WITH LIKE. The budget is PER LEG; the measured percentiles are WHOLE-TRACE
  // (retrieval + up to OPD_AUDIT_LEGS legs + scoring). Asserting a per-leg ceiling against a
  // whole-trace p95 is exactly the category error Addendum A made when it sized doc_read against
  // p95 instead of the observed max. A leg's SHARE of the busiest measured day's p95 is the
  // honest upper bound to clear.
  const TRACE_P95_MS = 382_195;            // 2 Aug, n=869, opd_note_audit successes
  const legShareAtP95 = TRACE_P95_MS / OPD_AUDIT_LEGS;
  assert.ok(budget.perAttemptMs >= legShareAtP95 * 1.5,
    `the per-leg ceiling (${budget.perAttemptMs}) must clear a leg's share of the measured p95 ` +
    `(${Math.round(legShareAtP95)}) with margin`);
  // …and in fact it sits above the ENTIRE trace at p95, which is the sanity check in Addendum B §4.
  assert.ok(budget.perAttemptMs >= TRACE_P95_MS * 0.99, 'a per-leg ceiling at ~the whole-trace p95 is generous');
  assert.ok(budget.perAttemptMs > LLM_CALL_TIMEOUT_MS, 'and must exceed the general 90 s client bound');

  // LLM_AUDIT_TIMEOUT_MS is NOT deleted and NOT changed — it remains the env-overridable default
  // for any audit-class caller with no entry in the budget table. It is simply not this path's source.
  assert.equal(LLM_AUDIT_TIMEOUT_MS, 600_000, 'unchanged in value');
  assert.ok(LLM_AUDIT_TIMEOUT_MS > LLM_CALL_TIMEOUT_MS, 'and still an override over the general ceiling');

  // …and the plumbing actually applies it as per-request { timeout } on every non-wrapper branch.
  const trace = readFileSync('lib/trace.ts', 'utf8');
  assert.ok(trace.includes("const reqOpts = opts?.timeoutMs ? { timeout: opts.timeoutMs } : undefined;"),
    'tracedChat must build per-request options from timeoutMs');
  // ⚠️ 5 → 3 IN UNIT V-a1 (3 Aug 2026), and this is a TIGHTENING, not a loss.
  // The two Gemini calls (the stream_options self-heal twin) no longer take `reqOpts`: they now run
  // inside `createWithRetry`, which hands each attempt its OWN `{ signal, timeout, maxRetries: 0 }`
  // derived from the same `opts?.timeoutMs`. So the caller's ceiling still reaches Vertex — by a
  // STRICTER route than before, because it is now an AbortController deadline as well as an SDK
  // timeout, and the SDK's own silent retries are off.
  // ⚠️ 3 → 2 IN UNIT V-a2 (4 Aug 2026): the two per-branch fallback closures became ONE terminal
  // disposition after the cloud ladder. What remains on `reqOpts` is the Ollama main path and the
  // single ladder-terminal fallback closure — still every loop-less site, no more.
  assert.equal((trace.match(/completions\.create\((?:gParams|params)[^)]*, reqOpts\)/g) ?? []).length, 2,
    'tracedChat: ollama main + the ladder-terminal fallback closure — the loop-less sites');
  assert.equal((trace.match(/completions\.create\(gParams as any, ro\)/g) ?? []).length, 2,
    'and the gemini twin now takes the per-ATTEMPT opts from the shared retry loop');
  // ⚠️ Unit D (3 Aug 2026) added `opts?.maxTries` as a fifth argument, and V-a2 added
  // `opts?.noLocalFallback` sixth. The property this asserts is UNCHANGED — governedChat must
  // forward the caller's bounds on the traceless path — and it is joined by its twin below,
  // because the TRACED path is the one production actually uses and it was silently dropping both.
  assert.ok(trace.includes('return chatWithFallback(params, opts?.gemini, opts?.openrouter, opts?.timeoutMs, opts?.maxTries, opts?.noLocalFallback);'),
    'governedChat must forward the ceiling on the TRACELESS path too (the lab runs trace:false)');
  // V-a2: the forwarded ceiling is CLAMPED to the leg's remainder (tierCeilingMs) so a tier-2 hop
  // never runs on a fresh budget — the caller's number still bounds the whole leg.
  assert.ok(trace.includes('timeoutMs: tierCeilingMs(opts?.timeoutMs, deadlineAt),') && trace.includes('maxTries: opts?.maxTries,'),
    "tracedChat's OpenRouter branch must forward them too — it has its own retry loop and dropped "
    + 'both until 3 Aug, which is why the OPD fix credited to 3039c42 never reached the worker');
  const llmSrc = readFileSync('lib/llm.ts', 'utf8');
  // 4 → 3 in Unit V-a1 (the Gemini call moved inside createWithRetry), 3 → 2 in V-a2 (the two
  // fallback returns became the single ladder terminal). What is left on reqOpts is the no-cloud
  // default and the terminal fallback return — still every loop-less site.
  assert.equal((llmSrc.match(/completions\.create\((?:gParams|params)[^)]*, reqOpts\)/g) ?? []).length, 2,
    'chatWithFallback: no-cloud ollama + the ladder-terminal return — the loop-less sites');
  assert.ok(/createWithRetry\(\s*\/\/[^\n]*\n\s*\(ro\) => gemini\.chat\.completions\.create\(gParams as any, ro\)/.test(llmSrc),
    'and the gemini call takes the per-ATTEMPT opts from the shared retry loop');
});

// ── §T5 — a call exceeding its ceiling surfaces as a NORMAL error, once, and fast ──
test('T5: timeout fires as a catchable Error after exactly one wire call (maxRetries 0)', async () => {
  let hits = 0;
  const server = createServer((_req, _res) => { hits++; /* accept and never respond */ });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address() as { port: number };
  try {
    const client = new OpenAI({ baseURL: `http://127.0.0.1:${port}/v1`, apiKey: 'x', timeout: 300, maxRetries: 0 });
    const t0 = Date.now();
    let caught: unknown = null;
    try {
      await client.chat.completions.create({ model: 'm', messages: [{ role: 'user', content: 'q' }] });
    } catch (e) { caught = e; }
    const elapsed = Date.now() - t0;
    assert.ok(caught instanceof Error, 'the ceiling must surface as a normal Error (soft-fail catchable)');
    assert.match(`${(caught as Error).name} ${(caught as Error).message} ${(caught as Error).constructor.name}`,
      /timed out|timeout|abort/i, `expected a timeout-class error, got ${(caught as Error).constructor.name}: ${(caught as Error).message}`);
    assert.ok(elapsed < 5_000, `must fail fast (took ${elapsed}ms)`);
    assert.equal(hits, 1, 'maxRetries 0 ⇒ exactly one wire call — no blind SDK retries');
  } finally {
    server.close();
  }
});

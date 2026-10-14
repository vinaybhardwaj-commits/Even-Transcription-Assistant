/**
 *   node --test --import tsx lib/__tests__/truncation-not-retried.test.ts
 *
 * S1.3 (7 Aug 2026) — three defects found by the first successful live Bedrock run.
 *
 * The probe passed end to end (trace 58f729a7, draft leg verified bedrock, attribution.verified
 * true). Its CRITIQUE leg did not:
 *   · Converse returned HTTP 200 with `finish_reason=length` at ~2,900 characters — the leg's
 *     max_tokens was 800, sized years ago for a 7B local model;
 *   · the shared retry loop treated that like any other bad 200 and re-issued the identical
 *     request twice more, truncating identically each time — 54 s of one run spent re-proving a
 *     deterministic outcome;
 *   · and because the truncated JSON never parsed, the route's catch left the default critique,
 *     scoring ZERO issues at severity 'none'. The stored answer read as audited-and-clean. It had
 *     never been audited.
 *
 * Each of the three is pinned below. The third is the one that made the other two invisible.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  classifyProviderResponse, isRetryableDefect, ProviderResponseError, type ProviderResponseDefect,
} from '../provider-error-core';
import { createWithRetry } from '../openrouter-retry';
import { BEDROCK_MIN_MAX_TOKENS, toConverseInput } from '../bedrock-core';
import { reduceAskEvents, reduceDdxEvents } from '../lab-clinical-core';

const src = (p: string) => readFileSync(p, 'utf8');
const HAIKU = 'global.anthropic.claude-haiku-4-5-20251001-v1:0';

/** The live response shape, reconstructed: a completion that ran out of room. */
const truncated = (chars = 2900) => ({
  choices: [{ message: { content: 'x'.repeat(chars) }, finish_reason: 'length' }],
  usage: { prompt_tokens: 1200, completion_tokens: 800, total_tokens: 2000 },
});
const emptyTwoHundred = () => ({ choices: [{ message: { content: '' }, finish_reason: 'stop' }] });
const good = () => ({ choices: [{ message: { content: '{"needs_revision":false}' }, finish_reason: 'stop' }] });

// ═════════════════════════════════════════════════════════════════════════════════════════════
// 1 · Truncation is terminal
// ═════════════════════════════════════════════════════════════════════════════════════════════

test('a finish_reason defect is NOT retryable; an empty 200 still is', () => {
  const trunc = classifyProviderResponse(truncated()) as ProviderResponseDefect;
  assert.equal(trunc.kind, 'finish_reason');
  assert.equal(trunc.finish_reason, 'length');
  assert.equal(isRetryableDefect(trunc), false, 'same prompt + same cap truncates identically');

  // The class this loop was BUILT for is untouched: 1,523 of 3,963 responses on 31 Jul came back
  // as husks, and another attempt genuinely may succeed.
  const empty = classifyProviderResponse(emptyTwoHundred()) as ProviderResponseDefect;
  assert.equal(empty.kind, 'empty_content');
  assert.equal(isRetryableDefect(empty), true);
  const none = classifyProviderResponse({}) as ProviderResponseDefect;
  assert.equal(none.kind, 'no_choices');
  assert.equal(isRetryableDefect(none), true);
  assert.equal(isRetryableDefect(null), false, 'no defect ⇒ nothing to retry');

  // content_filter is the other request-determined stop reason and rides the same rule.
  const filtered = classifyProviderResponse({ choices: [{ message: { content: 'x' }, finish_reason: 'content_filter' }] }) as ProviderResponseDefect;
  assert.equal(filtered.kind, 'finish_reason');
  assert.equal(isRetryableDefect(filtered), false);
});

test('THE 54 SECONDS: a truncating call is attempted ONCE, not three times', async () => {
  let attempts = 0;
  await assert.rejects(
    () => createWithRetry(async () => { attempts++; return truncated(); },
      { provider: 'bedrock', model: HAIKU, maxTries: 3, timeoutMs: 1000, sleepFn: async () => {} }),
    (e: unknown) => e instanceof ProviderResponseError && /finish_reason/.test(e.message));
  assert.equal(attempts, 1, 'the two extra attempts were guaranteed waste and no longer happen');
});

test('…and the empty-200 retry budget is spent in full, exactly as before', async () => {
  let attempts = 0;
  await assert.rejects(
    () => createWithRetry(async () => { attempts++; return emptyTwoHundred(); },
      { provider: 'openrouter', maxTries: 3, timeoutMs: 1000, sleepFn: async () => {} }));
  assert.equal(attempts, 3, 'no regression to the class the loop exists for');

  // …and a husk that heals on attempt 2 still returns, unchanged.
  let n = 0;
  const res = await createWithRetry(async () => (++n === 1 ? emptyTwoHundred() : good()),
    { provider: 'openrouter', maxTries: 3, timeoutMs: 1000, sleepFn: async () => {} });
  assert.equal(n, 2);
  assert.equal((res as ReturnType<typeof good>).choices[0].message.content, '{"needs_revision":false}');
});

test('the terminal error still names the truncation, so the sizing bug is readable', async () => {
  await assert.rejects(
    () => createWithRetry(async () => truncated(), { provider: 'bedrock', model: HAIKU, maxTries: 3, timeoutMs: 1000, sleepFn: async () => {} }),
    (e: unknown) => {
      const m = (e as Error).message;
      return /finish_reason=length/.test(m) && /content_length=2900/.test(m) && m.includes(HAIKU);
    });
});

test('transport failures are untouched by this rule — only BODY verdicts changed', async () => {
  let attempts = 0;
  await assert.rejects(
    () => createWithRetry(async () => { attempts++; throw Object.assign(new Error('boom'), { status: 503 }); },
      { provider: 'bedrock', maxTries: 3, timeoutMs: 1000, sleepFn: async () => {} }));
  assert.equal(attempts, 3, 'a 503 is transient and still retries');
});

// ═════════════════════════════════════════════════════════════════════════════════════════════
// 2 · The cap that caused it
// ═════════════════════════════════════════════════════════════════════════════════════════════

test('the mini-sized cap is raised to a FLOOR on the bedrock path', () => {
  // The live failure: the ask critique leg asks for 800, which produced ~2,900 chars of an
  // unfinished JSON critique on Claude.
  assert.equal(toConverseInput({ max_tokens: 800, messages: [] }, HAIKU).inferenceConfig?.maxTokens, BEDROCK_MIN_MAX_TOKENS);
  assert.equal(toConverseInput({ max_tokens: 700, messages: [] }, HAIKU).inferenceConfig?.maxTokens, BEDROCK_MIN_MAX_TOKENS, 'the ddx critique leg too');
  assert.ok(BEDROCK_MIN_MAX_TOKENS >= 4096, 'comfortably more than double the observed truncation point');

  // A FLOOR, not an override: a caller that deliberately asks for more keeps its own number.
  assert.equal(toConverseInput({ max_tokens: 8192, messages: [] }, HAIKU).inferenceConfig?.maxTokens, 8192);
  assert.equal(toConverseInput({ max_tokens: 2200, messages: [] }, HAIKU).inferenceConfig?.maxTokens, BEDROCK_MIN_MAX_TOKENS, 'the OPD audit leg is also lifted');
  // And absence still means absence — no cap is not the same as a small cap.
  assert.equal(toConverseInput({ messages: [] }, HAIKU).inferenceConfig, undefined);
  assert.equal(toConverseInput({ max_tokens: 0, messages: [] }, HAIKU).inferenceConfig, undefined);
});

test('⚠️ BYTE-IDENTITY: the floor is the BEDROCK transport’s, and reaches no other provider', () => {
  // The two other cloud paths already rewrite the caller's ceiling (+8192 for thinking headroom);
  // bedrock was the only one passing a mini-sized cap through raw. The fix stays in its transport.
  const TRACE = src('lib/trace.ts'), LLM = src('lib/llm.ts');
  assert.ok(TRACE.includes('max_tokens: baseMax + 8192,'), 'the Vertex branch is unchanged');
  assert.ok(LLM.includes('max_tokens: baseMax + 8192 }'), 'chatWithFallback is unchanged');
  assert.ok(LLM.includes('max_tokens: baseMax + 8192,'), 'buildOpenrouterParams is unchanged');
  for (const f of ['lib/trace.ts', 'lib/llm.ts', 'app/api/ask/route.ts', 'app/api/ddx/route.ts']) {
    assert.ok(!/BEDROCK_MIN_MAX_TOKENS/.test(src(f)), `${f} does not know the floor exists`);
  }
  // The routes' own caps are untouched — qwen and gemini runs are byte-identical.
  assert.ok(src('app/api/ask/route.ts').includes('max_tokens: 800,'));
  assert.ok(src('app/api/ddx/route.ts').includes('max_tokens: 700,'));
});

// ═════════════════════════════════════════════════════════════════════════════════════════════
// 3 · The failure that hid the other two: 0 issues ≠ clean
// ═════════════════════════════════════════════════════════════════════════════════════════════

test('a critique that never completed is recorded as UNAUDITED, not as clean', () => {
  // The catch in both routes swallows transport errors, truncation and unparseable JSON alike and
  // leaves { needs_revision: false } — which scores 0 issues at severity 'none'. That is exactly
  // what a passed audit looks like, and it is what the live Bedrock run stored.
  for (const [name, text] of [['ask', src('app/api/ask/route.ts')], ['ddx', src('app/api/ddx/route.ts')]] as const) {
    assert.ok(text.includes('let criticRan = true;'), `${name}: the fact is tracked`);
    assert.ok(text.includes('criticRan = false;'), `${name}: and set on EVERY failure path`);
    assert.ok(text.includes('critic_ran: criticRan,'), `${name}: it reaches the emitted event`);
    assert.ok(/UNAUDITED, not clean/.test(text), `${name}: the log line says what happened`);
    // It rides the trace event too, so an admin reading trace_events sees it without the stream.
    const ev = text.slice(text.indexOf("logEvent(traceId, 'critique_parsed'"), text.indexOf("setTraceSeverity(traceId, severity)"));
    assert.ok(ev.includes('critic_ran: criticRan,'), `${name}: and the forensic trace event`);
  }
});

test('the probe reducers carry critic_ran, so a lab row can tell the two apart', () => {
  const ask = reduceAskEvents([
    { type: 'sources', items: [1, 2] },
    { type: 'critique', severity: 'none', issue_count: 0, critic_ran: false },
    { type: 'token', content: 'an answer with a citation [1]' },
    { type: 'done', ms: 1, trace_id: 't1' },
  ]);
  assert.equal(ask.critique_issue_count, 0);
  assert.equal(ask.critic_ran, false, '0 issues AND the critic never ran — the row must say both');

  const clean = reduceAskEvents([{ type: 'critique', severity: 'none', issue_count: 0, critic_ran: true }, { type: 'done', ms: 1 }]);
  assert.equal(clean.critic_ran, true, 'a genuinely clean draft is distinguishable');

  const ddx = reduceDdxEvents([{ type: 'critique', severity: 'none', issue_count: 0, critic_ran: false }, { type: 'done', ms: 1 }]);
  assert.equal(ddx.critic_ran, false);

  // A stream with no critique event at all is UNKNOWN, not false — absence of evidence.
  assert.equal(reduceAskEvents([{ type: 'done', ms: 1 }]).critic_ran, null);
  assert.equal(reduceDdxEvents([{ type: 'done', ms: 1 }]).critic_ran, null);
  // Optional on the event: an older stream without the field leaves it unknown rather than false.
  assert.equal(reduceAskEvents([{ type: 'critique', severity: 'none', issue_count: 0 }, { type: 'done', ms: 1 }]).critic_ran, null);
  assert.ok(src('lib/stream.ts').includes("critic_ran?: boolean }"), 'optional on the event type');
});

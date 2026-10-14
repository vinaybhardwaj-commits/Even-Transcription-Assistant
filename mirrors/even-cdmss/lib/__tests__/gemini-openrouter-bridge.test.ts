/**
 *   node --test --import tsx lib/__tests__/gemini-openrouter-bridge.test.ts
 *
 * Gemini-via-OpenRouter BRIDGE (30 Jul 2026) — temporary, flag-gated, retires when
 * aiplatform.googleapis.com is re-enabled on clinical-infra.
 *
 * Every Vertex call has 403d SERVICE_DISABLED since 26 Jul 12:50 UTC; 367 OPD audits were served
 * by qwen2.5:14b under a hardcoded 'gemini-2.5-pro' label (T-5). These tests pin: the flag gate
 * (unset ⇒ byte-identical), the two traps that WILL fire on the first call if unhandled
 * (A-12 reasoning-disable 400; token headroom), the Google provider pin, the central slug
 * derivation in both transports, and the worker's served-model column fix.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { openrouterGeminiSlug, buildOpenrouterParams, OPENROUTER_GOOGLE_PROVIDER_PIN, thinkingBudgetOf } from '../llm.ts';

const LLM = readFileSync('lib/llm.ts', 'utf8');
const TRACE = readFileSync('lib/trace.ts', 'utf8');
const WORKER = readFileSync('app/api/opd-audit/worker/route.ts', 'utf8');
const CHANGELOG = readFileSync('lib/opd-audit-changelog.ts', 'utf8');

function withFlag<T>(value: string | undefined, fn: () => T): T {
  const prev = process.env.GEMINI_VIA_OPENROUTER;
  if (value === undefined) delete process.env.GEMINI_VIA_OPENROUTER;
  else process.env.GEMINI_VIA_OPENROUTER = value;
  try { return fn(); } finally {
    if (prev === undefined) delete process.env.GEMINI_VIA_OPENROUTER;
    else process.env.GEMINI_VIA_OPENROUTER = prev;
  }
}

// ═════════════════════════════════════════════════════════════════════════════════════════════
// 1 · The flag gate — unset is byte-identical to today
// ═════════════════════════════════════════════════════════════════════════════════════════════

test('flag unset ⇒ undefined, ALWAYS — the bridge does not exist without GEMINI_VIA_OPENROUTER=1', () => {
  withFlag(undefined, () => {
    assert.equal(openrouterGeminiSlug('gemini-2.5-pro'), undefined);
    assert.equal(openrouterGeminiSlug('google/gemini-2.5-pro'), undefined);
  });
  withFlag('0', () => assert.equal(openrouterGeminiSlug('gemini-2.5-pro'), undefined));
  withFlag('true', () => assert.equal(openrouterGeminiSlug('gemini-2.5-pro'), undefined, "only the exact string '1' opens the bridge"));
});

test('flag=1 ⇒ the OpenRouter slug, google/-prefixed exactly once; no model ⇒ undefined', () => {
  withFlag('1', () => {
    assert.equal(openrouterGeminiSlug('gemini-2.5-pro'), 'google/gemini-2.5-pro');
    assert.equal(openrouterGeminiSlug('gemini-2.5-flash'), 'google/gemini-2.5-flash');
    assert.equal(openrouterGeminiSlug('google/gemini-2.5-pro'), 'google/gemini-2.5-pro', 'already-prefixed passes through');
    assert.equal(openrouterGeminiSlug(undefined), undefined);
    assert.equal(openrouterGeminiSlug(''), undefined);
  });
});

// ═════════════════════════════════════════════════════════════════════════════════════════════
// 2 · Trap 1 (A-12) — Gemini 2.5 cannot disable thinking
// ═════════════════════════════════════════════════════════════════════════════════════════════

test('trap 1: a Gemini slug NEVER receives reasoning:{enabled:false} — the A-12 400 destroyed a diagnosis for 36h', () => {
  const p = buildOpenrouterParams('google/gemini-2.5-pro', { messages: [], max_tokens: 900 });
  assert.ok(!('reasoning' in p), 'no reasoning key at all — absent, not enabled:true');
});

test('trap 1 control: a NON-Gemini slug reproduces the pre-bridge behaviour byte-for-byte', () => {
  const p = buildOpenrouterParams('qwen/qwen3-32b', { messages: [], max_tokens: 700 });
  assert.deepEqual(p.reasoning, { enabled: false }, 'the critic bounded-verdict default holds');
  assert.equal(p.max_tokens, 700, 'no headroom added');
  assert.ok(!('provider' in p), 'no pin on non-Gemini slugs');
  const own = buildOpenrouterParams('qwen/qwen3-32b', { messages: [], reasoning: { enabled: true } });
  assert.deepEqual(own.reasoning, { enabled: true }, 'a caller-supplied reasoning always wins');
});

// ═════════════════════════════════════════════════════════════════════════════════════════════
// 3 · Trap 2 — token headroom, same +8192 the Vertex branch applies
// ═════════════════════════════════════════════════════════════════════════════════════════════

test('trap 2: a Gemini slug gets baseMax + 8192 — Pro spends output budget on reasoning FIRST', () => {
  assert.equal(buildOpenrouterParams('google/gemini-2.5-pro', { max_tokens: 2200 }).max_tokens, 2200 + 8192);
  assert.equal(buildOpenrouterParams('google/gemini-2.5-pro', {}).max_tokens, 1024 + 8192, 'default base 1024, same as the Vertex branch');
});

// ═════════════════════════════════════════════════════════════════════════════════════════════
// 3b · Trap 3 (T-11) — the thinking cap was being DROPPED on the bridge
//
// Call sites express the cap in the only form Vertex honors, google.thinking_config.thinking_budget.
// OpenRouter does not know that field, so from 30 Jul it rode along as dead weight and Pro thought
// WITHOUT A LIMIT on the bridge — from the same code that capped it on Vertex.
// ═════════════════════════════════════════════════════════════════════════════════════════════

const VERTEX_CAP = { google: { thinking_config: { thinking_budget: 4096 } } };

test('trap 3: the Vertex thinking budget is TRANSLATED to reasoning.max_tokens, and `google` never travels', () => {
  const p = buildOpenrouterParams('google/gemini-2.5-pro', { max_tokens: 2200, ...VERTEX_CAP });
  assert.deepEqual(p.reasoning, { max_tokens: 4096 }, 'the cap the call site already asked for');
  assert.ok(!('google' in p), 'the untranslated Vertex-only field is REMOVED from the outgoing body');
  assert.equal(p.max_tokens, 2200 + 8192, 'the output headroom is unchanged by the translation');
});

test('trap 3: NO DEFAULT IS INVENTED — no budget in, no reasoning out (byte-identical to before)', () => {
  const p = buildOpenrouterParams('google/gemini-2.5-pro', { max_tokens: 900 });
  assert.ok(!('reasoning' in p), 'a call site that never asked for a cap still sends none');
  assert.ok(!('google' in p));
  // Junk and the Pro-rejected 0 are treated as "no cap", never as a translatable budget.
  for (const bad of [0, -1, 'lots', null, undefined, NaN]) {
    const q = buildOpenrouterParams('google/gemini-2.5-pro', { google: { thinking_config: { thinking_budget: bad } } });
    assert.ok(!('reasoning' in q), `budget ${String(bad)} ⇒ no reasoning field (Pro 400s on 0)`);
  }
});

test('trap 3: the reader is pure and total — any shape yields a budget or undefined', () => {
  assert.equal(thinkingBudgetOf(VERTEX_CAP), 4096);
  assert.equal(thinkingBudgetOf({ google: { thinking_config: { thinking_budget: 512.7 } } }), 512, 'floored');
  assert.equal(thinkingBudgetOf({}), undefined);
  assert.equal(thinkingBudgetOf({ google: {} }), undefined);
  assert.equal(thinkingBudgetOf({ google: null as unknown as Record<string, unknown> }), undefined);
});

test('trap 3: an explicit OpenRouter reasoning block WINS — translation never overwrites it', () => {
  const p = buildOpenrouterParams('google/gemini-2.5-pro', { reasoning: { max_tokens: 512 }, ...VERTEX_CAP });
  assert.deepEqual(p.reasoning, { max_tokens: 512 }, 'the caller already speaks the dialect');
});

test('trap 3: the VERTEX path is untouched — it still sends the google form and no reasoning block', () => {
  // The translation lives in buildOpenrouterParams, which the Vertex branches never call. Both
  // Vertex branches forward `...rest` (google included) and add only the model + headroom.
  // (V-a2: the geminiModel param is typed optional now the ladder owns the branch, hence `as string`.)
  assert.ok(LLM.includes('const gParams = { ...rest, model: vertexModelName(geminiModel as string), max_tokens: baseMax + 8192 };'));
  // lab-v2 decision 21: the Vertex normalisation moved out of tracedChat's branch and into
  // buildVertexParams IN THIS SAME FILE, so the lab transport (governedLabChat) and the traced
  // path cannot drift — a live lab run had already sent Gemini 2.5 Pro the un-raised Ollama
  // max_tokens and got billed for empty content. The property this pin guards is unchanged;
  // it is now asserted in two halves, which is strictly stronger than the single literal was.
  assert.ok(TRACE.includes('buildVertexParams(params, opts!.gemini as string)'), 'the traced path still prefixes from opts.gemini');
  assert.ok(TRACE.includes('model: vertexModelName(model),') && TRACE.includes('max_tokens: baseMax + 8192,'), 'and buildVertexParams still does the prefix + the thinking headroom');
  assert.ok(!TRACE.includes('thinkingBudgetOf'), 'no translation on the Vertex path');
  assert.ok(LLM.includes('const { google: _g, ...body } = rest;'), 'the strip happens only in the OpenRouter builder');
});

// ═════════════════════════════════════════════════════════════════════════════════════════════
// 4 · The Google provider pin
// ═════════════════════════════════════════════════════════════════════════════════════════════

test('the pin: Google-operated providers only, no fallbacks — slugs read off the endpoints listing 30 Jul 2026', () => {
  assert.deepEqual(OPENROUTER_GOOGLE_PROVIDER_PIN, { allow_fallbacks: false, only: ['google-vertex', 'google-ai-studio'] });
  const p = buildOpenrouterParams('google/gemini-2.5-pro', {});
  assert.deepEqual(p.provider, OPENROUTER_GOOGLE_PROVIDER_PIN, 'every Gemini-slug request carries it');
});

// ═════════════════════════════════════════════════════════════════════════════════════════════
// 5 · Central derivation — no call site can be missed; explicit openrouter always wins
// ═════════════════════════════════════════════════════════════════════════════════════════════

test('both transports derive the slug centrally; a caller-supplied openrouter slug takes precedence', () => {
  assert.ok(LLM.includes('const orModel = openrouterModel || openrouterGeminiSlug(geminiModel);'), 'chatWithFallback');
  // ⚠️ PREFIXED 7 Aug 2026 (Bedrock S1), not rewritten: `bedrockModel ? undefined : (…)`. The
  // derivation inside the parens is byte-identical, so the property this test protects — one
  // central `google/` derivation that no call site can miss, with an explicit caller slug winning
  // — is unchanged. The guard only stops an explicit BEDROCK target from silently acquiring an
  // OpenRouter tier behind it, which is the F11 no-ladder rule.
  assert.ok(TRACE.includes('const orSlug = bedrockModel ? undefined : (opts?.openrouter || openrouterGeminiSlug(opts?.gemini));'), 'tracedChat');
  // V-a2: the OpenRouter arm serves as tier 1 (the derived/explicit slug) AND as tier 2 behind a
  // failed Vertex call (openrouterSlugForGemini — the SAME `google/` derivation, no flag). One
  // local `slug` covers both; the flag-gated central derivation above is unchanged.
  assert.ok(TRACE.includes("const slug = (orSlug as string | undefined) || openrouterSlugForGemini(opts!.gemini as string);"));
  assert.ok(TRACE.includes('const orParams = buildOpenrouterParams(slug, rest as Record<string, unknown>);'));
  assert.ok(LLM.includes('const slug = orModel || openrouterSlugForGemini(geminiModel as string);'));
  assert.ok(LLM.includes('const orParams = buildOpenrouterParams(slug, rest as Record<string, unknown>);'));
});

test('the Ollama last-leg fallback is untouched in both transports', () => {
  // D-1 (31 Jul): the fallback calls carry the per-request ceiling (reqOpts).
  // V-a2 (4 Aug): the two per-branch fallback sites became ONE terminal disposition after the
  // cloud ladder — same params, same reqOpts, the SOURCE tier now named by `lastTier`. So the
  // llm.ts count is 2 (the no-cloud default path + the terminal return) and trace.ts has one
  // runOllamaFallback call. `noLocalFallback: true` (the two audit call sites) throws before
  // reaching it; every other caller still lands here exactly as before.
  assert.equal((LLM.match(/return llm\.chat\.completions\.create\(params, reqOpts\);/g) || []).length, 2, 'chatWithFallback: the default path + the ladder terminal');
  assert.ok(TRACE.includes("runOllamaFallback(lastTier, servedModel, lastErr, () => llm.chat.completions.create(params, reqOpts))"));
});

// ═════════════════════════════════════════════════════════════════════════════════════════════
// 6 · Commit 2 (T-5) — the worker records what actually SERVED
// ═════════════════════════════════════════════════════════════════════════════════════════════

test("T-5: the hardcoded 'gemini-2.5-pro' literal is GONE from the worker — it hid this incident for four days", () => {
  assert.ok(!WORKER.includes("model: 'gemini-2.5-pro'"), 'no literal remains');
  // Unit B (2 Aug 2026) renamed servedCallFor → servedCallFor: it now returns the PROVIDER beside
  // the model, from one row of one query. The T-5 property is unchanged and still pinned here —
  // both save sites derive from the served trace, never from a constant.
  assert.equal((WORKER.match(/servedCallFor\(audit\.traceId\)/g) || []).length, 2, 'both save sites derive from the served trace');
});

test('T-5: servedCallFor reads the POST-fallback model from the audit trace, null when unknown', () => {
  assert.ok(WORKER.includes("kind IN ('llm_response', 'llm_stream_usage')"));
  assert.ok(WORKER.includes("stage = 'opd_audit_analyze'"), 'the main audit leg, not an incidental call');
  // Unit B: the null return became a typed { model: null, provider: null } — same property, both
  // fields. An honest gap, never a guess, and never a failed audit.
  assert.ok(WORKER.includes('const none = { model: null, provider: null };'));
  assert.ok(WORKER.includes('if (!traceId) return none;'));
  assert.ok(WORKER.includes('catch { return none; }'), 'an honest gap, never a guess — and never a failed audit');
  assert.ok(WORKER.includes("payload->>'provider' AS provider"), 'and the provider rides the same row');
});

// ═════════════════════════════════════════════════════════════════════════════════════════════
// 7 · The changelog carries the step-change warning in the same commit
// ═════════════════════════════════════════════════════════════════════════════════════════════

test('changelog: the bridge entry exists, scoring:false, and names the step change as a provider restoration', () => {
  assert.ok(CHANGELOG.includes('GEMINI_VIA_OPENROUTER=1'));
  assert.ok(CHANGELOG.includes('Expect the scores to take a visible step'));
  assert.ok(CHANGELOG.includes('RESTORATION of the intended provider, not a recalibration'));
  const entry = CHANGELOG.slice(CHANGELOG.indexOf('Gemini via OpenRouter'), CHANGELOG.indexOf('Nightly OPD audit worker'));
  assert.ok(entry.length > 0, 'entry sits newest-first, above the cron entry');
});

// Addendum A (register A-12) — LVC generation reasoning fix + fallback error de-laundering.
// Pure tests: the reasoning-injection contract (mirrored from lib/trace.ts) and the both-failed
// fallback composition (the real exported helpers).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { composeProviderFallbackError, runOllamaFallback } from '../trace.ts';

// MIRROR of lib/trace.ts tracedChat's OpenRouter reasoning default (the `'reasoning' in rest` branch).
// That line is on the PRD UNTOUCHED list (Addendum §2: "Do NOT change the default in tracedChat"), so it
// cannot be exported; this replica must stay in sync. It composes the OpenRouter body's reasoning field.
const reasoningInjection = (rest: Record<string, unknown>): Record<string, unknown> =>
  ('reasoning' in rest) ? {} : { reasoning: { enabled: false } };

// ── §7 test 1 — the LVC params carry `reasoning` ⇒ tracedChat injects NO { enabled: false } ──
test('§2/§7: LVC params (reasoning present) ⇒ no injected reasoning:{enabled:false}; the caller value survives', () => {
  // the params object even-lvc.ts:155 now passes (Fix 1)
  const lvcParams: Record<string, unknown> = {
    model: 'moonshotai/kimi-k3', temperature: 0, top_p: 1, seed: 7, max_tokens: 4000,
    reasoning: { max_tokens: 2000 }, provider: { allow_fallbacks: false, require_parameters: true },
  };
  const injected = reasoningInjection(lvcParams);
  assert.deepEqual(injected, {}, 'reasoning present ⇒ nothing injected');
  // the composed OpenRouter body keeps the caller reasoning, and is NOT { enabled: false }
  const body = { ...lvcParams, ...injected } as { reasoning?: { max_tokens?: number; enabled?: boolean } };
  assert.equal(body.reasoning?.max_tokens, 2000);
  assert.notEqual(body.reasoning?.enabled, false);
});

// ── §7 test 2 — the citation critic (no `reasoning`) STILL gets { enabled: false } (no regression) ──
test('§2/§7: a caller with NO reasoning (citation critic / Qwen3) still receives reasoning:{enabled:false}', () => {
  const criticParams: Record<string, unknown> = { model: 'qwen/qwen3', temperature: 0, max_tokens: 700 };
  const injected = reasoningInjection(criticParams) as { reasoning?: { enabled?: boolean } };
  assert.equal(injected.reasoning?.enabled, false, 'no reasoning ⇒ default {enabled:false} preserved');
});

// ── §7 test 3 — a both-failed fallback error carries BOTH provider messages (capped at 200) ──
test('§3/§7: the both-failed error contains BOTH the provider and the Ollama fallback messages', () => {
  const orig = new Error('400 Reasoning is mandatory for this endpoint and cannot be disabled.');
  const fb = new Error("404 model 'google/gemini-2.5-pro' not found");
  const e = composeProviderFallbackError('openrouter', 'google/gemini-2.5-pro', orig, fb);
  assert.match(e.message, /openrouter google\/gemini-2\.5-pro failed/);
  assert.match(e.message, /400 Reasoning is mandatory/);        // the TRUE cause survives
  assert.match(e.message, /ollama fallback failed/);
  assert.match(e.message, /404 model 'google\/gemini-2\.5-pro' not found/);
  // gemini branch composes the same shape with a 'gemini' prefix
  assert.match(composeProviderFallbackError('gemini', 'gemini-2.5-pro', orig, fb).message, /^gemini gemini-2\.5-pro failed/);
  // each message is capped — at PROVIDER_ERROR_CAP (4000), raised from 200 by the 403-diagnosis
  // kickoff §4.1: truncating a diagnostic to 200 chars destroyed the IAM-vs-quota discriminator.
  const long = 'x'.repeat(5000);
  const capped = composeProviderFallbackError('openrouter', 'm', new Error(long), new Error(long));
  assert.equal((capped.message.match(/x+/g) || []).every((run) => run.length <= 4000), true);
  assert.equal((capped.message.match(/x+/g) || []).some((run) => run.length > 200), true, 'and no longer truncated at the old defect value');
});

// ── §7 test 4 — a SUCCESSFUL fallback returns the result unchanged (only the throw path composes) ──
test('§3/§7: runOllamaFallback returns the fallback result unchanged on success; throws both-failed on error', async () => {
  const ok = await runOllamaFallback('openrouter', 'm', new Error('provider down'), async () => ({ choices: [{ message: { content: 'RESULT' } }] }));
  assert.deepEqual(ok, { choices: [{ message: { content: 'RESULT' } }] });
  // when the fallback ALSO throws, both messages surface
  await assert.rejects(
    () => runOllamaFallback('openrouter', 'm', new Error('provider 400'), async () => { throw new Error('ollama 404'); }),
    /provider 400 \| ollama fallback failed: ollama 404/,
  );
});

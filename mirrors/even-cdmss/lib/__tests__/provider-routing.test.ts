/**
 * Provider-migration (OpenRouter) — fallback-integrity guard kernel.
 * The verify.ts / cite-gate guard is `fellBack = served !== '' && !modelsAgree(served, intended)`.
 * These assert BOTH directions (Gate 3): a genuine served verdict is kept; a silent drop to the
 * local Ollama model is caught. Run: node --test --import tsx lib/__tests__/provider-routing.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { modelsAgree } from '../llm.ts';

/** The guard's decision, replicated from verify.ts/doc-audit.ts for a black-box assertion. */
const fellBack = (served: string, intended: string) => served !== '' && !modelsAgree(served, intended);

test('modelsAgree: served matches intended across provider prefixes (verdict KEPT)', () => {
  // Gemini: Vertex publisher-prefixes the served model
  assert.equal(modelsAgree('google/gemini-2.5-pro', 'gemini-2.5-pro'), true);
  assert.equal(modelsAgree('gemini-2.5-flash', 'gemini-2.5-flash'), true);
  // OpenRouter: served slug equals the intended slug — the whole point of the migration
  assert.equal(modelsAgree('qwen/qwen3-32b', 'qwen/qwen3-32b'), true);
  assert.equal(modelsAgree('qwen/qwen3.5-flash-02-23', 'qwen/qwen3.5-flash-02-23'), true);
  // tolerate a suffix/prefix variance (e.g. a ':free' tag)
  assert.equal(modelsAgree('qwen/qwen3-32b:free', 'qwen/qwen3-32b'), true);
});

test('modelsAgree: a silent drop to the local Ollama model is a MISMATCH (verdict EXCLUDED)', () => {
  // intended OpenRouter Qwen, served the local fallback → not agree
  assert.equal(modelsAgree('llama3.1:8b', 'qwen/qwen3-32b'), false);
  // intended Gemini Pro, served the local fallback → not agree (the original guard's job)
  assert.equal(modelsAgree('llama3.1:8b', 'gemini-2.5-pro'), false);
  // cross-family mismatch (pro asked, flash served) → not agree
  assert.equal(modelsAgree('gemini-2.5-flash', 'gemini-2.5-pro'), false);
  // empty served / intended → not agree (never silently trust)
  assert.equal(modelsAgree('', 'qwen/qwen3-32b'), false);
  assert.equal(modelsAgree('qwen/qwen3-32b', ''), false);
});

test('guard both directions: Qwen kept, Ollama fallback flagged — the SL2 regression', () => {
  // BEFORE (isGeminiModel): a real Qwen verdict would have been discarded. Now it is kept.
  assert.equal(fellBack('qwen/qwen3-32b', 'qwen/qwen3-32b'), false);   // kept
  assert.equal(fellBack('google/gemini-2.5-pro', 'gemini-2.5-pro'), false);   // kept
  // A genuine silent fallback is still caught in BOTH provider intents.
  assert.equal(fellBack('llama3.1:8b', 'qwen/qwen3-32b'), true);   // excluded
  assert.equal(fellBack('llama3.1:8b', 'gemini-2.5-pro'), true);   // excluded
});

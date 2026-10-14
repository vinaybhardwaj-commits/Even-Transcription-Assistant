// lib/__tests__/retrieval-llm-determinism.test.ts — both retrieval-LLM calls (expand + variants) are
// switched to temperature 0 with a fixed seed, making the retrieved candidate pool deterministic.
// Prompt text is byte-frozen; only sampling params change. Source-scan (the governedChat params are
// internal to the fail-open functions and not otherwise inspectable without network).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { RETRIEVAL_LLM_SEED } from '../expand.ts';

const expandSrc = readFileSync('lib/expand.ts', 'utf8');
const mqSrc = readFileSync('lib/multi-query.ts', 'utf8');

test('RETRIEVAL_LLM_SEED is the fixed shared seed (42), defined once in expand.ts', () => {
  assert.equal(RETRIEVAL_LLM_SEED, 42);
  assert.ok(/export const RETRIEVAL_LLM_SEED = 42\b/.test(expandSrc), 'seed defined in expand.ts');
  assert.ok(mqSrc.includes("import { expandQuery, RETRIEVAL_LLM_SEED } from './expand'"), 'multi-query imports the shared seed (no new import edge)');
});

test('expand.ts: temperature 0 + seed, num_ctx preserved, prompt + fail-open untouched', () => {
  assert.ok(expandSrc.includes('temperature: 0,'), 'expansion is greedy (temperature 0)');
  assert.ok(!expandSrc.includes('temperature: 0.1'), 'the old 0.1 sampling is gone');
  assert.ok(expandSrc.includes('seed: RETRIEVAL_LLM_SEED'), 'seed threaded into the options bag');
  assert.ok(expandSrc.includes('num_ctx: 16384'), 'num_ctx kept unchanged');
  assert.ok(expandSrc.includes('promptRef: '), 'still the governed call — no ungoverned site introduced');
  assert.ok(expandSrc.includes('return question;'), 'fail-open (→ original question) preserved');
  assert.ok(expandSrc.includes('You are a medical query rewriter.'), 'SYSTEM prompt text byte-frozen');
});

test('multi-query generateQueryVariants: temperature 0 + seed, num_ctx preserved, prompt + fail-open untouched', () => {
  assert.ok(mqSrc.includes('temperature: 0,'), 'variants are greedy (temperature 0)');
  assert.ok(!mqSrc.includes('temperature: 0.2'), 'the old 0.2 sampling is gone');
  assert.ok(mqSrc.includes('num_ctx: 8192, seed: RETRIEVAL_LLM_SEED'), 'seed added to the existing options bag (num_ctx kept)');
  assert.ok(mqSrc.includes('You are a clinical query reformulator.'), 'SYSTEM_VARIANTS prompt text byte-frozen');
  assert.ok(mqSrc.includes('return [];'), 'fail-open (→ []) preserved');
  // PRD B one-liner must survive
  assert.ok(mqSrc.includes("rerank_backend?: 'judge' | 'cohere' | 'none';"), "PRD B's FusionHit union left intact");
});

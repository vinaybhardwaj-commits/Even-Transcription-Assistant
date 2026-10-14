// lib/corpus-eval/verify.ts — Brainstem PR 0: the GOVERNED Pro model call for the verifier.
//
// Routes through the governed layer (lib/trace.ts `tracedChat`) with the registered promptRef
// `verify-core/VERIFY_SYSTEM`, so every verdict is traced, fingerprinted, and costed — never a raw
// chatWithFallback/getGeminiChatClient direct site (which reasoning:governance forbids). Pro-tier
// (P0-D). Fail-safe: any error/timeout ⇒ not_assessable (parseVerdict handles empty), so a single
// bad sample never crashes the run.
//
// Read-only measurement: no production write path, no engine/prompt-default change. It only WRITES
// trace_events for its OWN eval calls (the standard governed-call side effect), never a served output.

import { startTrace, tracedChat } from '../trace';
import { GEMINI_MODEL, modelsAgree } from '../llm';
import { VERIFY_SYSTEM, buildVerifyUser, parseVerdict, type SourceMeta, type VerifyResult } from './verify-core';

export interface VerifyUsage { prompt_tokens: number; completion_tokens: number; total_tokens: number; ms: number; provider: string; model: string }
/** fellBack=true ⇒ tracedChat served this from the local Ollama FALLBACK rather than the intended
 *  model (Gemini Pro, or an OpenRouter candidate under the κ probe). Such a verdict is FORCED to
 *  not_assessable and surfaced — a local model must never silently enter the gold judgment. NB a
 *  legitimate OpenRouter verdict is NOT a fallback (the served slug matches the intended one). */
export interface VerifyOutcome extends VerifyResult { usage: VerifyUsage; fellBack: boolean }

const PROMPT_REF = 'verify-core/VERIFY_SYSTEM';

/**
 * Verify one (claim, cited-excerpts) unit on Gemini Pro through the governed layer. Returns the
 * verdict plus the measured token usage (for the SL0 cost probe). Never throws.
 */
export async function verifyClaim(
  claim: string,
  excerpts: Array<{ text: string; meta: SourceMeta }>,
  opts: { model?: string; openrouter?: string; reasoning?: boolean | Record<string, unknown>; maxTokens?: number } = {},
): Promise<VerifyOutcome> {
  const t0 = Date.now();
  // Route: an OpenRouter slug (κ probe / migrated critic) → OpenRouter; else Gemini (`model` or the
  // Pro default). `intended` is what we asked for — the fallback guard compares the SERVED model to it.
  const intended = opts.openrouter || opts.model || GEMINI_MODEL;
  const route = opts.openrouter ? { openrouter: opts.openrouter, promptRef: PROMPT_REF } : { gemini: opts.model || GEMINI_MODEL, promptRef: PROMPT_REF };
  // Probe knobs (default-off, back-compat): `reasoning` flips an OpenRouter candidate into THINKING
  // mode (billed as output tokens); `maxTokens` widens the budget so reasoning does not starve the
  // JSON verdict and return empty content. The shipped critic path passes neither → unchanged.
  const maxTokens = opts.maxTokens ?? 700;
  const emptyUsage = (provider: string, model: string): VerifyUsage => ({ prompt_tokens: 0, completion_tokens: 0, total_tokens: 0, ms: Date.now() - t0, provider, model });
  try {
    const traceId = await startTrace('corpus_eval_verify', { promptRef: PROMPT_REF }, 1, { feature: 'corpus-eval' });
    const res = await tracedChat(
      traceId,
      'corpus_eval_verify',
      {
        model: 'llama3.1:8b',                  // Ollama fallback if the intended provider errors (tracedChat contract)
        messages: [
          { role: 'system', content: VERIFY_SYSTEM },
          { role: 'user', content: buildVerifyUser(claim, excerpts) },
        ],
        temperature: 0,
        max_tokens: maxTokens,
        response_format: { type: 'json_object' },
        ...(opts.reasoning ? { reasoning: opts.reasoning === true ? { enabled: true } : opts.reasoning } : {}),
      },
      route,
    );
    const choice = res?.choices?.[0];
    const content: string | null = choice?.message?.content ?? null;
    const u = res?.usage ?? {};
    // Fallback-integrity guard (generalized): tracedChat silently degrades to the local Ollama model
    // on a provider error/rate-limit. Compare the SERVED model to the INTENDED one — a mismatch means
    // the local model produced this verdict, so EXCLUDE it (force not_assessable). A genuine OpenRouter
    // (Qwen) verdict has served == intended and is KEPT — the old "not Gemini ⇒ fallback" test would
    // have discarded every Qwen verdict.
    const servedModel = String(res?.model ?? '');
    const fellBack = servedModel !== '' && !modelsAgree(servedModel, intended);
    const usage = {
      prompt_tokens: Number(u.prompt_tokens ?? 0),
      completion_tokens: Number(u.completion_tokens ?? 0),
      total_tokens: Number(u.total_tokens ?? 0),
      ms: Date.now() - t0,
      provider: fellBack ? 'ollama' : (opts.openrouter ? 'openrouter' : 'gemini'),
      model: servedModel || intended,
    };
    if (fellBack) {
      return { verdict: 'not_assessable', supportingSpan: null, why: `excluded: local fallback (${servedModel}) — not the intended verifier (${intended})`, usage, fellBack: true };
    }
    return { ...parseVerdict(content), usage, fellBack: false };
  } catch (e) {
    // fail-safe — a failed verify is not_assessable, never a crash and never a guessed support
    return { verdict: 'not_assessable', supportingSpan: null, why: `verify error: ${String((e as Error).message).slice(0, 120)}`, usage: emptyUsage(opts.openrouter ? 'openrouter' : 'gemini', intended), fellBack: false };
  }
}

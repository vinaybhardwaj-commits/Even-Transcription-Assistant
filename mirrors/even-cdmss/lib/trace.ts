import { randomUUID } from 'crypto';
import { sql } from './db';
import { llm, geminiConfigured, getGeminiChatClient, vertexModelName, chatWithFallback, openrouterConfigured, openrouterChatClient, vertexRegion, openrouterGeminiSlug, openrouterSlugForGemini, buildOpenrouterParams, cloudLadder, tierCeilingMs, ladderSkipError } from './llm';
import { remainingBudgetMs } from './lab-batch-core';
import { vertexSaEmail } from './gcp-auth';
import {
  PROVIDER_ERROR_CAP, beginProviderCall, endProviderCall, providerCallsInFlight, providerErrorPayload,
  providerResponsePayload, isProviderResponseError,
} from './provider-error-core';
import { openrouterCreateWithRetry, createWithRetry } from './openrouter-retry';
import { promptFingerprint } from './reasoning/registry-core';
import { billableOutputTokens } from './llm-cost-core';
import { bedrockGenerate, bedrockFailurePayload, singleChunkStream } from './bedrock';
// LAB-MCP-V2 §7 (decision 6). Inside a lab execution context every trace WRITE below
// returns without touching the database, and the two model entries delegate to the
// lab's own chat edge. Outside a context `labExecution()` is undefined and every one of
// these functions is byte-for-byte what it was before this import existed.
import { labExecution } from './lab-execution-context';

const sqlFn = sql as unknown as (q: string, p: unknown[]) => Promise<unknown>;

// ─────────────────────────────────────────────────────────────────────────────
// Invocation envelope (Reasoning Observability Stage 1) — the per-call reasoning
// fingerprint promoted from payload JSONB into queryable trace_events columns.
// Stamped from the Stage-0 registry via promptFingerprint (the single source —
// a hash is never hardcoded at a call site). Every write degrades to a no-op if
// the 0012 migration hasn't run: the base event INSERT is unchanged and the
// envelope lands in a separate guarded UPDATE.
// ─────────────────────────────────────────────────────────────────────────────

export interface TraceEnvelope {
  prompt_id: string | null;
  prompt_version: string | null;
  prompt_hash: string | null;
  rubric_versions: Record<string, string> | null;
  output_schema_version: string | null;
  call_model: string | null;
  call_provider: string | null;
  gen_params: Record<string, unknown> | null;
  tokens_in: number | null;
  tokens_out: number | null;
}

/** Build the envelope columns for one LLM call. promptRef unset (or unknown to the
 *  registry) ⇒ fingerprint columns stay null and only the call facts are written. */
export function buildEnvelope(
  promptRef: string | undefined,
  call: { model?: string | null; provider?: string | null; genParams?: Record<string, unknown> | null; tokensIn?: number | null; tokensOut?: number | null },
): TraceEnvelope {
  const fp = promptRef ? promptFingerprint(promptRef) : null;
  return {
    prompt_id: fp?.id ?? null,
    prompt_version: fp?.version ?? null,
    prompt_hash: fp?.hash ?? null,
    rubric_versions: fp && Object.keys(fp.rubricVersions).length ? fp.rubricVersions : null,
    output_schema_version: fp?.schemaId ?? null,
    call_model: call.model ?? null,
    call_provider: call.provider ?? null,
    gen_params: call.genParams ?? null,
    tokens_in: call.tokensIn ?? null,
    tokens_out: call.tokensOut ?? null,
  };
}

// Exported so the envelope test can pin the exact column set to the 0012 migration.
export const ENVELOPE_UPDATE_SQL =
  `UPDATE trace_events SET prompt_id = $1, prompt_version = $2, prompt_hash = $3,
   rubric_versions = $4::jsonb, output_schema_version = $5, call_model = $6,
   call_provider = $7, gen_params = $8::jsonb, tokens_in = $9, tokens_out = $10
   WHERE trace_id = $11 AND seq = $12`;

export async function startTrace(feature: string, input: unknown, userId: number = 1, meta?: unknown): Promise<string> {
  // §7 — a lab run has no production trace. Return a well-formed id so every downstream
  // `logEvent(traceId, ...)` stays type-correct and equally inert.
  if (labExecution()) return 'lab-v2-untraced';
  const traceId = randomUUID();
  try {
    await sqlFn(
      `INSERT INTO traces (trace_id, user_id, feature, input, status, meta) VALUES ($1, $2, $3, $4::jsonb, 'running', $5::jsonb)`,
      [traceId, userId, feature, JSON.stringify(input ?? null), meta ? JSON.stringify(meta) : null]
    );
  } catch {
    // Tracing must never break the actual request
  }
  return traceId;
}

export async function logEvent(
  traceId: string,
  kind: string,
  stage: string | null,
  payload: unknown,
  latencyMs?: number,
  envelope?: TraceEnvelope
): Promise<void> {
  if (labExecution()) return;   // §7
  try {
    // app_source is set explicitly here: the lib/db stamper cannot safely inject
    // into this INSERT because the seq subquery in VALUES contains parentheses.
    const rows = (await sqlFn(
      `INSERT INTO trace_events (trace_id, seq, kind, stage, payload, latency_ms, app_source)
       VALUES ($1, COALESCE((SELECT MAX(seq) + 1 FROM trace_events WHERE trace_id = $1), 1), $2, $3, $4::jsonb, $5, $6)
       RETURNING seq`,
      [traceId, kind, stage, JSON.stringify(payload ?? null), latencyMs ?? null, process.env.APP_SOURCE || 'standalone']
    )) as Array<{ seq?: number }>;
    // Envelope columns ride a SEPARATE guarded UPDATE (never the INSERT): before the 0012
    // migration this update fails and is swallowed while the base event row stays intact.
    if (envelope) {
      const seq = rows?.[0]?.seq;
      if (seq != null) {
        try {
          await sqlFn(ENVELOPE_UPDATE_SQL, [
            envelope.prompt_id, envelope.prompt_version, envelope.prompt_hash,
            envelope.rubric_versions ? JSON.stringify(envelope.rubric_versions) : null,
            envelope.output_schema_version, envelope.call_model, envelope.call_provider,
            envelope.gen_params ? JSON.stringify(envelope.gen_params) : null,
            envelope.tokens_in, envelope.tokens_out, traceId, seq,
          ]);
        } catch {}
      }
    }
  } catch {}
}

/**
 * D3 (R-10) — record a Cohere /rerank spend into the SAME sink the governed layer uses (a `traces`
 * row + an `llm_response` `trace_events` event carrying `usage.cost`), NOT via governedChat (the raw
 * rerank fetch is correct per the PRD; a governed wrapper would trip reasoning:governance). Best-effort:
 * cost tracking must never break retrieval. `costUsd` is OpenRouter's `usage.cost` (USD) for the call.
 *
 * NOTE (flagged): the $ read-model (lib/llm-cost.ts) prices gemini/qwen TOKENS and filters on model —
 * it does not yet price a direct USD `usage.cost`, so this entry is CAPTURED in the sink but not yet
 * surfaced on the dashboard. Displaying it is a small reader-only follow-up (add a cohere/usage.cost
 * priced branch); doing it here would touch the token-summing aggregation and risk the shipped numbers.
 */
export async function recordRerankCost(costUsd: number | null | undefined, model: string = 'cohere/rerank-v3.5'): Promise<void> {
  const cost = Number(costUsd);
  if (costUsd == null || !Number.isFinite(cost)) return;   // nothing metered on this call
  try {
    const traceId = await startTrace('rerank_cohere', { model }, 1);
    await logEvent(traceId, 'llm_response', 'rerank', { model, provider: 'openrouter-rerank', usage: { cost } });
  } catch { /* cost tracking must never break retrieval */ }
}

export async function finishTrace(
  traceId: string,
  status: 'success' | 'error' | 'partial',
  errorMessage?: string
): Promise<void> {
  if (labExecution()) return;   // §7
  try {
    await sqlFn(
      `UPDATE traces SET finished_at = NOW(), status = $1, error_message = $2,
       total_ms = EXTRACT(EPOCH FROM (NOW() - started_at)) * 1000 WHERE trace_id = $3`,
      [status, errorMessage ?? null, traceId]
    );
  } catch {}
}

/**
 * STUDY FLAG — DEFAULT-OFF. `LLM_THINKING_BUDGET=<n>` caps the reasoning ("thinking") tokens
 * Gemini 2.5 spends per call, for the thinkingBudget cost study (17 Jul 2026). Unset / 0 / junk
 * ⇒ returns undefined and tracedChat is BYTE-IDENTICAL to the uncapped shipped path. The shipped
 * production default is UNCAPPED; this exists so an arm can be driven per-process (the same
 * pattern the Flash study used for GEMINI_MODEL) without touching the engine or any prompt.
 *
 * Mechanism (SL0-verified against Vertex's OpenAI-compat endpoint, 17 Jul 2026): the ONLY form
 * this endpoint honors is a top-level `google.thinking_config.thinking_budget`. Both
 * `generationConfig.thinkingConfig` and `extra_body.generationConfig.thinkingConfig` are
 * SILENTLY IGNORED — the request succeeds and reasoning is unchanged, which is precisely how a
 * cap that does nothing would look. Verified by dose-response, not by the call not erroring:
 * budget 128/512/1024/2048 → 75/431/678/1509 actual reasoning tokens.
 *
 * NB gemini-2.5-pro REJECTS thinking_budget=0 (HTTP 400) — Pro cannot have thinking disabled;
 * 128 is its floor. -1 means "dynamic" (i.e. uncapped), so it is deliberately not accepted here.
 */
export function geminiThinkingBudget(): number | undefined {
  const raw = Number(process.env.LLM_THINKING_BUDGET);
  return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : undefined;
}

// Wraps llm.chat.completions.create with automatic event logging.
// Logs: model, full prompt (messages), full response content, token usage, finish_reason, latency.
// Returns the original response so callers can use it normally.
// Use 'any' for params/return because the OpenAI SDK's overload-based types conflict with
// Ollama-specific extra fields (options, keep_alive) and our streaming/non-streaming union.
// Callers know their own use case and cast accordingly.
/**
 * Addendum A §3 (register A-12) — the BOTH-FAILED fallback error. When a provider call fails AND the
 * local Ollama fallback ALSO fails, preserve BOTH messages. Laundering an OpenRouter 400 ("Reasoning is
 * mandatory and cannot be disabled") into the Ollama 404 that followed destroyed the true diagnosis for
 * 36h — for a governed clinical call that is not graceful degradation. Each message is capped at
 * PROVIDER_ERROR_CAP (4000 — raised from 200 by the 403-diagnosis kickoff §4.1: truncating a
 * diagnostic to 200 characters was the defect). A *successful* fallback is unaffected (this is
 * only built when both throw).
 */
export function composeProviderFallbackError(
  provider: 'openrouter' | 'gemini',
  servedModel: string | undefined,
  originalErr: unknown,
  fallbackErr: unknown,
): Error {
  const cap = (x: unknown): string => String((x as { message?: unknown })?.message ?? x).slice(0, PROVIDER_ERROR_CAP);
  return new Error(`${provider} ${servedModel ?? 'unknown'} failed: ${cap(originalErr)} | ollama fallback failed: ${cap(fallbackErr)}`);
}

/** Run the local Ollama fallback after a provider error: return its result on success (unchanged
 *  behaviour), or throw a both-failed error carrying BOTH provider messages (§3). */
export async function runOllamaFallback<T>(
  provider: 'openrouter' | 'gemini',
  servedModel: string | undefined,
  originalErr: unknown,
  doFallback: () => Promise<T>,
): Promise<T> {
  try {
    return await doFallback();
  } catch (fallbackErr) {
    throw composeProviderFallbackError(provider, servedModel, originalErr, fallbackErr);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// TRANSPORT DISPATCH EVIDENCE — LVC JUDGE GUARD FIX PRD v3.0 §3.1 (D-8, D-15), 10 Aug 2026.
//
// The transport has always known which branch it dispatched through and which model slug it
// supplied, and has always thrown that away at the return (line ~592 before this change), leaving
// callers to guess attribution from `result.model` — a field some providers do not populate. An
// empty body model then read as "wrong model", which is what made the judge retry every call.
//
// NAMED FOR WHAT IT IS. This is evidence of what the transport DISPATCHED, not proof of what
// executed inside the provider. It is deliberately NOT called `served_model` (§3.1).
//
// ADDITIVE, AND MECHANICALLY SO: the value is attached as a NON-ENUMERABLE own property, so
// Object.keys / JSON.stringify / object spread over a completion are byte-identical to before.
// No existing shape changes, no existing consumer can see it, and a frozen provider object simply
// does not receive it (attribution is best-effort; it must never cost a call).
// ─────────────────────────────────────────────────────────────────────────────

/** The property name carrying dispatch evidence on a returned completion. Namespaced so it can
 *  never collide with an OpenAI/Bedrock/OpenRouter SDK field. */
export const TRANSPORT_ATTRIBUTION_FIELD = 'cdmss_transport_attribution';

export type CdmssTransportAttribution = {
  /** Which branch of tracedChat dispatched the request. 'vertex' is the direct Vertex Gemini
   *  branch — the trace's own provider label for it is 'gemini'; this field uses the PRD's name. */
  dispatched_provider: 'vertex' | 'openrouter' | 'ollama' | 'bedrock';
  /** The model slug the transport supplied to that provider (publisher prefix as sent). */
  dispatched_model: string | null;
  /** True when a cloud provider produced this result; false for the local model. */
  cloud_response_received: boolean;
};

/** Attach dispatch evidence to a completion and return the SAME object. Non-enumerable, so no
 *  existing consumer of the completion can observe it. Never throws. */
export function attachTransportAttribution<T>(result: T, attribution: CdmssTransportAttribution): T {
  if (!result || (typeof result !== 'object' && typeof result !== 'function')) return result;
  try {
    Object.defineProperty(result, TRANSPORT_ATTRIBUTION_FIELD, {
      value: attribution, enumerable: false, configurable: true, writable: true,
    });
  } catch { /* frozen/sealed provider object — evidence is best-effort, never a thrown call */ }
  return result;
}

/** Read dispatch evidence back off a completion. `undefined` means the transport left none —
 *  which is a real state (an untraced call, a stream wrapper), not a failure. */
export function readTransportAttribution(result: unknown): CdmssTransportAttribution | undefined {
  if (!result || (typeof result !== 'object' && typeof result !== 'function')) return undefined;
  const v = (result as Record<string, unknown>)[TRANSPORT_ATTRIBUTION_FIELD];
  return v && typeof v === 'object' ? (v as CdmssTransportAttribution) : undefined;
}

/**
 * buildVertexParams — the Vertex request-body normalisation, in ONE place (decision 21).
 *
 * Vertex needs two things done to the engine's params, and BOTH are easy to forget:
 *
 *  1. STRIP the Ollama-only fields. Vertex rejects unknown fields, and `options` (num_ctx) and
 *     `keep_alive` mean nothing to it.
 *  2. RAISE max_tokens by 8192. Gemini 2.5 Pro is a THINKING model: max_tokens becomes
 *     maxOutputTokens, and reasoning tokens are spent from it FIRST. The caps tuned for Ollama
 *     (700–2200) are consumed by thinking and the JSON answer never gets written.
 *
 * ⚠️ THIS FUNCTION EXISTS BECAUSE FORGETTING (2) IS SILENT AND EXPENSIVE. Live lab run 1716bbe2
 * sent the engine's raw params to Vertex: max_tokens 2200 against a 4096-token thinking budget.
 * The model thought, ran out, and returned empty content — a 200 response, correctly attributed
 * and duly billed at 13,904 microusd, that the engine could only report as `llmLegFailed`. Every
 * status downstream said success because every one of them was true. The lab and production must
 * build this body through the same function or the drift comes back.
 */
export function buildVertexParams(params: unknown, model: string): Record<string, unknown> {
  const { options: _o, keep_alive: _k, ...rest } = params as Record<string, unknown>;
  void _o; void _k;
  const baseMax = Number((rest as { max_tokens?: number }).max_tokens) || 1024;
  return {
    ...rest,
    model: vertexModelName(model),
    max_tokens: baseMax + 8192,
  };
}

export async function tracedChat(
  traceId: string,
  label: string,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  params: any,
  // Hybrid backend: when `gemini` names a model AND Vertex is configured, the
  // call runs on Gemini and silently falls back to the local Ollama model in
  // `params.model` on any error/timeout. Omit it (or leave Gemini unconfigured)
  // and behaviour is byte-identical to the original Ollama-only path.
  // promptRef (Stage 1): a Stage-0 registry id — resolves version+hash via
  // promptFingerprint and stamps the envelope columns on this call's events.
  // Unset ⇒ only the call facts (model/provider/gen_params/tokens) are written.
  // timeoutMs (D-1, 31 Jul 2026): an audit-class call site passes its own per-request ceiling
  // ({ timeout } in the SDK request options — one client per provider, the override visible at
  // the call site). Absent ⇒ undefined ⇒ the client-level LLM_CALL_TIMEOUT_MS bound applies.
  // maxTries (Unit D, 3 Aug 2026): and its own transport try count, for the same reason — a retry
  // ladder is multiplicative against the hosting route's maxDuration, so a caller in a box that
  // cannot hold three rungs must be able to ask for one. Absent ⇒ OPENROUTER_MAX_TRIES (3).
  // noLocalFallback (Unit V-a2, 4 Aug 2026): when true, after BOTH cloud tiers have failed, THROW
  // instead of calling runOllamaFallback (the provider_error/provider_fallback events still fire,
  // with fellBackTo: 'none'). Absent or false ⇒ today's behaviour exactly. Set true at exactly two
  // audit call sites: opd-note-audit's opd_audit_analyze and doc-audit's analyze closure.
  // bedrock (Bedrock S1, 7 Aug 2026): a full Bedrock modelId. AN EXPLICIT BEDROCK TARGET OUTRANKS
  // EVERYTHING AND HAS NO LADDER BEHIND IT — see the branch below. Absent ⇒ every line here is
  // byte-identical to before this option existed.
  opts?: { gemini?: string; openrouter?: string; bedrock?: string; promptRef?: string; timeoutMs?: number; maxTries?: number; noLocalFallback?: boolean },
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
): Promise<any> {
  // §7 — inside a lab context there is no trace to write to and no fallback ladder to
  // run: the lab supplies its own single-target transport, budgeted and attributed by
  // lib/lab-v2/gateway.ts. `label` is the stage name the gateway meters against.
  const _labTraced = labExecution();
  if (_labTraced) return _labTraced.chat(label, params);
  const t0 = Date.now();
  const reqOpts = opts?.timeoutMs ? { timeout: opts.timeoutMs } : undefined;

  // Provider precedence: BEDROCK (explicit target) → OpenRouter (explicit slug) → Vertex Gemini →
  // local Ollama. Each of the middle two keeps the local Ollama model in params.model as its
  // on-error fallback; BEDROCK KEEPS NONE (F11 — an explicit target that fails is terminal).
  // BRIDGE (30 Jul 2026): with GEMINI_VIA_OPENROUTER=1 a gemini option resolves to its OpenRouter
  // slug HERE — derived centrally so no call site can be missed. Flag unset ⇒ undefined ⇒
  // byte-identical precedence. An explicit caller-supplied openrouter slug always wins.
  const bedrockModel = opts?.bedrock;
  const orSlug = bedrockModel ? undefined : (opts?.openrouter || openrouterGeminiSlug(opts?.gemini));
  const useOpenRouter = Boolean(orSlug) && openrouterConfigured();
  const useGemini = !bedrockModel && !useOpenRouter && Boolean(opts?.gemini) && geminiConfigured();
  const servedModel = bedrockModel ? bedrockModel : useOpenRouter ? (orSlug as string) : useGemini ? (opts!.gemini as string) : (params as { model?: string }).model;

  // Log the request before firing (records the model we INTEND to use)
  const requestPayload = {
    model: servedModel,
    provider: bedrockModel ? 'bedrock' : useOpenRouter ? 'openrouter' : useGemini ? 'gemini' : 'ollama',
    messages: (params as { messages?: unknown }).messages,
    temperature: (params as { temperature?: number }).temperature,
    max_tokens: (params as { max_tokens?: number }).max_tokens,
    stream: (params as { stream?: boolean }).stream ?? false,
    options: (params as Record<string, unknown>).options,
    keep_alive: (params as Record<string, unknown>).keep_alive,
  };
  // Default-off (see geminiThinkingBudget): undefined unless an arm sets LLM_THINKING_BUDGET.
  const thinkingBudget = useGemini ? geminiThinkingBudget() : undefined;
  const genParams: Record<string, unknown> = {
    temperature: requestPayload.temperature ?? null,
    max_tokens: requestPayload.max_tokens ?? null,
    stream: requestPayload.stream,
    // Only present when capped, so an uncapped call's gen_params is unchanged — and a capped
    // run is never mistakable for a shipped-default one when read back off the trace.
    ...(thinkingBudget ? { thinking_budget: thinkingBudget } : {}),
  };
  const promptRef = opts?.promptRef;
  await logEvent(traceId, 'llm_request', label, requestPayload, undefined,
    buildEnvelope(promptRef, { model: servedModel, provider: requestPayload.provider, genParams }));
  // Roll the registry id into traces.prompt_ids (only ids the registry actually knows).
  if (promptRef && promptFingerprint(promptRef)) await setTracePromptIds(traceId, [promptRef]);

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let result: any;
  let provider = requestPayload.provider;
  let actualModel = servedModel;

  try {
    if (bedrockModel) {
      // ══ BEDROCK (S1, 7 Aug 2026): ONE PROVIDER, NO LADDER, NO FALLBACK ═════════════════════
      //
      // An explicit `bedrock:` target is a STATEMENT ABOUT ATTRIBUTION, not a preference. The row
      // it produces will say Bedrock served it, so nothing else may serve it — not Vertex, not
      // OpenRouter, not the local mini. A failure here is terminal for this call and the caller's
      // own machinery (the OPD llm_leg_failed marking, the IPD failure ledger, the lab's error
      // row) is the handler. That is why this branch has no `nextHop`, no `runOllamaFallback`, and
      // no `noLocalFallback` switch: there is nothing to switch off.
      //
      // The budget reaches the transport the same way it does for the other two providers — the
      // caller's timeoutMs/maxTries, defaulted from PROVIDER_BUDGETS.bedrock inside bedrockGenerate.
      let completion;
      try {
        completion = await bedrockGenerate(params, {
          model: bedrockModel, timeoutMs: opts?.timeoutMs, maxTries: opts?.maxTries, label,
        });
      } catch (be) {
        // The payload was built at the moment of failure (honest inFlightAtError) and names BOTH
        // identities in the chain: the SA that signed the ID token and the role STS assumed.
        await logEvent(traceId, 'provider_error', label, bedrockFailurePayload(label, bedrockModel, be), Date.now() - t0);
        // No provider_fallback event: no fallback edge was taken, and inventing one would put a
        // hop in the record that never happened.
        throw be;
      }
      provider = 'bedrock';
      actualModel = bedrockModel;
      // §3.1 branch 1 of 4 — dispatch evidence. Attached to the completion; the streaming shim
      // below returns singleChunkStream(completion) instead, and that wrapper carries none.
      result = attachTransportAttribution(completion, {
        dispatched_provider: 'bedrock', dispatched_model: bedrockModel, cloud_response_received: true,
      });
      if ((params as { stream?: boolean }).stream) {
        // A streaming CALLER over a non-streaming transport (see singleChunkStream). The response
        // event is logged HERE, with the real content and the real usage, because the tail below
        // would otherwise take the streaming branch and record a call with no tokens — and an
        // untokened event is an unpriced call. Cost visibility is V's condition on this build.
        await logEvent(traceId, 'llm_response', label, {
          model: actualModel,
          provider,
          content: completion.choices[0]?.message?.content ?? '',
          finish_reason: completion.choices[0]?.finish_reason,
          usage: completion.usage,
          // Names the shim in the record: this WAS one Converse call, not a token stream.
          synthesized_stream: true,
        }, Date.now() - t0,
          buildEnvelope(promptRef, {
            model: actualModel, provider, genParams,
            tokensIn: completion.usage.prompt_tokens, tokensOut: billableOutputTokens(completion.usage),
          }));
        return singleChunkStream(completion);
      }
    } else if (useOpenRouter || useGemini) {
      // ══ UNIT V-a2 (4 Aug 2026): THE CLOUD LADDER ═══════════════════════════════════════════
      // Tier order is FIXED: Vertex, then OpenRouter (V-8 — CDMSS runs on Vertex; OpenRouter is
      // the backup tier). GEMINI_VIA_OPENROUTER=1 INVERTS it: the flag's precedence above makes
      // OpenRouter tier 1, so the bridge remains an EXACT ROLLBACK — set it back to 1 and
      // OpenRouter is primary again. That works only while the OpenRouter tier stays intact.
      //
      // ONE BUDGET PER LEG, shared across tiers (tierCeilingMs / remainingBudgetMs — the same
      // idiom openRouterGenerate has used since the tick-deadline PRD, lib/lab-batch-core.ts:84).
      // Consequence: THE GUARD ARITHMETIC DOES NOT MOVE. A leg still costs at most the caller's
      // timeoutMs whichever tiers run, so route-budget-guard.test.ts still computes 760,000 (OPD)
      // and 780,000 (IPD) and no PROVIDER_BUDGETS value changes in this unit. A second tier exists
      // only when the caller passed a leg budget — the utility surfaces keep one tier + Ollama.
      const ladder = cloudLadder({
        orFirst: useOpenRouter,
        orAvailable: openrouterConfigured(),
        vertexAvailable: Boolean(opts?.gemini) && geminiConfigured(),
        hasLegBudget: Boolean(opts?.timeoutMs),
      });
      const deadlineAt = opts?.timeoutMs ? Date.now() + opts.timeoutMs : null;
      let lastErr: unknown = null;
      let lastTier: 'openrouter' | 'gemini' = ladder[0];
      let servedByCloud = false;
      for (let ti = 0; ti < ladder.length && !servedByCloud; ti++) {
        const tier = ladder[ti];
        // A spent budget SKIPS the tier rather than calling it — throw-with-name, never a free call.
        if (ti > 0 && deadlineAt != null && remainingBudgetMs(deadlineAt) <= 0) {
          lastErr = ladderSkipError(tier, opts!.timeoutMs as number, lastErr);
          lastTier = tier;
          break;
        }
        // Where a failure here lands next: the next tier when one remains, else Ollama or nothing.
        const nextHop = ti + 1 < ladder.length ? ladder[ti + 1] : null;
        if (tier === 'openrouter') {
          // Tier-2 hop from a failed Vertex call derives the slug itself — orSlug is undefined there.
          const slug = (orSlug as string | undefined) || openrouterSlugForGemini(opts!.gemini as string);
          beginProviderCall('openrouter');
          try {
            // Strip Ollama-only params. buildOpenrouterParams: a non-Gemini slug runs NON-THINKING
            // (reasoning off — the critic wants a bounded JSON verdict; a caller may override with
            // its own `reasoning`). A GEMINI slug instead gets the A-12 no-disable handling, the
            // +8192 thinking headroom, and the Google provider pin.
            const { options: _o, keep_alive: _k, ...rest } = params as Record<string, unknown>;
            void _o; void _k;
            const orParams = buildOpenrouterParams(slug, rest as Record<string, unknown>);
            const client = openrouterChatClient();
            // Addendum F v2 task 1 — the SAME deadline/retry discipline the lab path has had since
            // D4/D2. Streaming calls keep the bare call: an in-flight stream being consumed by the
            // caller must not be aborted by a wall-clock timer, and classifyProviderResponse has
            // never judged streams.
            result = (orParams as { stream?: boolean }).stream
              // eslint-disable-next-line @typescript-eslint/no-explicit-any
              ? await client.chat.completions.create(orParams as any)
              // eslint-disable-next-line @typescript-eslint/no-explicit-any
              : await openrouterCreateWithRetry((ro) => client.chat.completions.create(orParams as any, ro), {
                  model: slug,
                  // ══ ROOT CAUSE, PART TWO (3 Aug 2026) ═════════════════════════════════════════
                  // `3039c42` fixed the IDENTICAL asymmetry in lib/llm.ts's chatWithFallback and
                  // did not touch this function — BOTH production audit paths are traced and used
                  // this branch, so the OPD fix never reached the worker. The caller's ceiling and
                  // try count now reach the loop; V-a2 clamps the ceiling to what the leg has left
                  // (tierCeilingMs), so tier 2 runs on tier 1's remainder, never a fresh budget.
                  timeoutMs: tierCeilingMs(opts?.timeoutMs, deadlineAt),
                  maxTries: opts?.maxTries,
                  onAttemptFailure: (f) => console.error(
                    `[provider-retry] openrouter ${slug} attempt ${f.attempt}/${f.maxTries} ${f.kind}${f.status != null ? ` ${f.status}` : ''} — ${f.willRetry ? 'retrying' : 'giving up'}: ${f.message}`),
                });
            endProviderCall('openrouter');
            provider = 'openrouter';
            actualModel = slug;
            // §3.1 branch 2 of 4 — dispatch evidence. `slug` is publisher-prefixed
            // (google/gemini-2.5-pro); modelsAgree tolerates the prefix, so a bridged Gemini
            // still resolves `verified` under D-15.
            attachTransportAttribution(result, {
              dispatched_provider: 'openrouter', dispatched_model: slug, cloud_response_received: true,
            });
            servedByCloud = true;
          } catch (oe) {
            // 403-diagnosis §4.1/§4.2: snapshot in-flight BEFORE decrementing (the failing call
            // counts), then the FULL error body as a provider_error event — feature is null here
            // because the traces row carries it (join on trace_id through the de-identified views).
            // §2.1/§2.2 — A 200 IS NOT A SUCCESS: the marked ProviderResponseError surfaces after
            // the bounded retry. §2.3 (no Ollama laundering) is enforced at the terminal
            // disposition below; the LADDER may still move it to the direct Vertex call, which is
            // exactly the healing this unit exists for (the broker's own 504-in-a-200).
            const inFlightAtError = providerCallsInFlight();
            endProviderCall('openrouter');
            const fellBackTo = nextHop ?? (opts?.noLocalFallback || isProviderResponseError(oe) ? 'none' : 'ollama');
            const errPayload = isProviderResponseError(oe)
              ? providerResponsePayload({
                  provider: 'openrouter', label, feature: null, fellBackTo,
                  intendedModel: slug, fallbackModel: fellBackTo === 'ollama' ? (params as { model?: string }).model ?? null : null,
                  region: null, saIdentity: null, inFlightAtError, defect: oe.defect,
                })
              : providerErrorPayload({
                  provider: 'openrouter', label, feature: null, fellBackTo,
                  intendedModel: slug, fallbackModel: fellBackTo === 'ollama' ? (params as { model?: string }).model ?? null : null,
                  region: null, saIdentity: null, error: oe, inFlightAtError,
                });
            await logEvent(traceId, 'provider_error', label, errPayload, Date.now() - t0);
            await logEvent(traceId, 'provider_fallback', label, {
              from: 'openrouter', to: fellBackTo,
              intended_model: slug,
              fallback_model: fellBackTo === 'ollama' ? (params as { model?: string }).model : null,
              error: String(errPayload.message ?? '').slice(0, PROVIDER_ERROR_CAP),
            }, Date.now() - t0);
            if (isProviderResponseError(oe)) {
              console.error(`[provider-bad-response] openrouter ${slug} returned a non-completion 200 → ${fellBackTo}:`, JSON.stringify(errPayload));
            } else {
              console.error(`[provider-fallback] openrouter ${slug} failed → ${fellBackTo}:`, JSON.stringify(errPayload));
            }
            lastErr = oe;
            lastTier = 'openrouter';
          }
        } else {
          beginProviderCall('gemini');
          try {
            // Strip Ollama-only params, publisher-prefix the model, and add the thinking
            // headroom — all of it in buildVertexParams, which the lab transport calls too
            // (decision 21). The request body here is byte-identical to what this block built
            // inline before the extraction; lib/lab-v2/__tests__/params-fidelity.test.ts holds
            // the two paths equal.
            const gParams: Record<string, unknown> = buildVertexParams(params, opts!.gemini as string);
            // Streaming calls otherwise carry NO token usage, so their spend is invisible to the LLM
            // cost tracker (this is why every /ask + /ddx pass was uncounted). Ask Vertex to emit a
            // final usage chunk. Off switch: LLM_STREAM_USAGE=0. Self-healing: if the endpoint rejects
            // the field we retry WITHOUT it (keep Gemini) rather than cascading to the Ollama fallback.
            const wantUsage = Boolean((gParams as { stream?: boolean }).stream) && process.env.LLM_STREAM_USAGE !== '0';
            if (wantUsage) gParams.stream_options = { include_usage: true };
            // Study arm only — absent on the shipped uncapped default.
            if (thinkingBudget) gParams.google = { thinking_config: { thinking_budget: thinkingBudget } };
            const gemini = await getGeminiChatClient();
            // ══ UNIT V-a1 (3 Aug 2026): THE VERTEX BRANCH RUNS THE SHARED, PROVIDER-NEUTRAL LOOP —
            // per-attempt abort deadline, bounded retry, 429/5xx handling, body classification.
            // It was the fallback then; it is TIER 1 now (V-a2), so the discipline is load-bearing.
            //
            // The stream_options SELF-HEAL lives INSIDE the attempt closure on purpose: it is a
            // different mechanism from the retry budget — one request the endpoint rejected for a
            // field it does not know — so healing it must not consume a retry. Note it mutates
            // `gParams`, so the heal persists across attempts, which is correct: once the endpoint
            // has rejected the field, later attempts should not re-send it.
            result = await createWithRetry(async (ro) => {
              try {
                // eslint-disable-next-line @typescript-eslint/no-explicit-any
                return await gemini.chat.completions.create(gParams as any, ro);
              } catch (soErr) {
                if (wantUsage && gParams.stream_options) {
                  delete gParams.stream_options;
                  // eslint-disable-next-line @typescript-eslint/no-explicit-any
                  return await gemini.chat.completions.create(gParams as any, ro);
                }
                throw soErr;
              }
            }, {
              provider: 'vertex',
              model: opts!.gemini as string,
              // Vertex's chat endpoint is OpenAI-COMPATIBLE, so the default classifyProviderResponse is
              // correct here. The NATIVE :generateContent endpoint is not, and is not routed through
              // this loop — see lib/gemini-multimodal.ts.
              // V-a2: the caller's ceiling clamped to the leg's remainder (the full budget on tier 1).
              timeoutMs: tierCeilingMs(opts?.timeoutMs, deadlineAt),
              maxTries: opts?.maxTries,
              onAttemptFailure: (f) => console.error(
                `[provider-retry] vertex ${opts?.gemini} attempt ${f.attempt}/${f.maxTries} ${f.kind}${f.status != null ? ` ${f.status}` : ''} — ${f.willRetry ? 'retrying' : 'giving up'}: ${f.message}`),
            });
            endProviderCall('gemini');
            provider = 'gemini';
            actualModel = opts!.gemini as string;
            // §3.1 branch 3 of 4 — dispatch evidence for the DIRECT Vertex branch. The slug is the
            // caller's un-prefixed model; the trace's own provider label stays 'gemini'.
            attachTransportAttribution(result, {
              dispatched_provider: 'vertex', dispatched_model: opts!.gemini as string, cloud_response_received: true,
            });
            servedByCloud = true;
          } catch (ge) {
            // 403-diagnosis §4.1/§4.2: the FULL Vertex body — error.status is the IAM-vs-quota
            // discriminator and was previously truncated at 500 chars. Snapshot in-flight BEFORE
            // decrementing: inFlightAtError is the field that tests the load-correlation hypothesis.
            const inFlightAtError = providerCallsInFlight();
            endProviderCall('gemini');
            const fellBackTo = nextHop ?? (opts?.noLocalFallback ? 'none' : 'ollama');
            const errPayload = providerErrorPayload({
              provider: 'gemini', label, feature: null, fellBackTo,
              intendedModel: (opts?.gemini as string) ?? null, fallbackModel: fellBackTo === 'ollama' ? (params as { model?: string }).model ?? null : null,
              region: vertexRegion(), saIdentity: vertexSaEmail(), error: ge, inFlightAtError,
            });
            await logEvent(traceId, 'provider_error', label, errPayload, Date.now() - t0);
            await logEvent(traceId, 'provider_fallback', label, {
              from: 'gemini', to: fellBackTo,
              intended_model: opts?.gemini,
              fallback_model: fellBackTo === 'ollama' ? (params as { model?: string }).model : null,
              error: String(errPayload.message ?? '').slice(0, PROVIDER_ERROR_CAP),
            }, Date.now() - t0);
            console.error(`[provider-fallback] gemini ${opts?.gemini} failed → ${fellBackTo}:`, JSON.stringify(errPayload));
            lastErr = ge;
            lastTier = 'gemini';
          }
        }
      }
      if (!servedByCloud) {
        // ── Terminal disposition: every cloud tier failed (or the second was skipped) ──
        // V-a2: `noLocalFallback` makes this a THROW — the audit paths' own machinery (OPD's
        // llm_leg_failed marking, the IPD failure ledger) is the handler, never a silent local
        // grade. The events above already fired with fellBackTo: 'none'.
        if (opts?.noLocalFallback) throw lastErr;
        // §2.3 stands, OpenRouter only (unchanged from before the ladder): a 200-that-is-not-a-
        // completion from OpenRouter never launders into the local model. The Vertex tier keeps
        // its historical any-error → Ollama, so a utility Gemini call degrades exactly as before.
        if (lastTier === 'openrouter' && isProviderResponseError(lastErr)) throw lastErr;
        provider = 'ollama';
        actualModel = (params as { model?: string }).model;
        // §3: keep the fallback, but if IT also throws, surface BOTH errors (not just Ollama's 404).
        result = await runOllamaFallback(lastTier, servedModel, lastErr, () => llm.chat.completions.create(params, reqOpts));
        // §3.1 branch 4 of 4 — THE LOCAL BRANCH MUST MARK ITSELF, so a local answer identifies
        // itself rather than passing as unattributed. cloud_response_received: false is the whole
        // point: under D-6 an *unknown* attribution is accepted, so a local answer must never be
        // able to arrive unknown.
        attachTransportAttribution(result, {
          dispatched_provider: 'ollama', dispatched_model: (params as { model?: string }).model ?? null, cloud_response_received: false,
        });
      }
    } else {
      result = await llm.chat.completions.create(params, reqOpts);
      // ⚠️ FIFTH BRANCH, NOT IN THE PRD'S LIST OF FOUR — flagged in the build report, not decided
      // here. This is the no-cloud-configured path (no bedrock target, no OpenRouter slug, Vertex
      // unconfigured): local Ollama serves directly, without ever entering the ladder above. It is
      // the same one-line attach and the same reason as branch 4 — an unmarked local answer would
      // reach a D-6 `unknown` and be ACCEPTED. Marking it is additive and changes no logic.
      attachTransportAttribution(result, {
        dispatched_provider: 'ollama', dispatched_model: (params as { model?: string }).model ?? null, cloud_response_received: false,
      });
    }
  } catch (e) {
    await logEvent(traceId, 'llm_error', label, {
      model: actualModel,
      provider,
      error: String((e as Error).message),
      stack: (e as Error).stack?.slice(0, 2000),
    }, Date.now() - t0,
      buildEnvelope(promptRef, { model: actualModel, provider, genParams }));
    throw e;
  }

  // For non-streaming responses, log the full content + usage
  if (!('controller' in result)) {
    const r = result as { choices?: Array<{ message?: { content?: string }; finish_reason?: string }>; usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number } };
    await logEvent(traceId, 'llm_response', label, {
      model: actualModel,
      provider,
      content: r.choices?.[0]?.message?.content ?? '',
      finish_reason: r.choices?.[0]?.finish_reason,
      usage: r.usage,          // payload UNCHANGED — the $ dashboard reads this and is already correct
    }, Date.now() - t0,
      buildEnvelope(promptRef, {
        model: actualModel, provider, genParams,
        // tokens_out is REASONING-INCLUSIVE (total − prompt), matching the OUT_TOK the dashboard
        // already prices from the payload. Previously this column recorded completion_tokens
        // alone, so any column-based reader under-counted output ~47% (measured).
        tokensIn: r.usage?.prompt_tokens ?? null, tokensOut: r.usage ? billableOutputTokens(r.usage) : null,
      }));
  } else {
    // For streaming, the caller will collect tokens and should call logStreamComplete after.
    await logEvent(traceId, 'llm_response_stream_started', label, {
      model: actualModel,
      provider,
    }, Date.now() - t0,
      buildEnvelope(promptRef, { model: actualModel, provider, genParams }));
    // The content events carry no usage, so wrap the stream to capture the final usage chunk
    // (from stream_options.include_usage) and log it once the stream drains. Gemini only —
    // this is what makes streamed spend (/ask, /ddx, /topics) visible in the cost tracker.
    if ((params as { stream?: boolean }).stream && provider === 'gemini') {
      result = wrapStreamUsage(result, traceId, label, actualModel, provider, t0, promptRef, genParams);
    }
  }

  return result;
}

// Wraps a streaming chat completion so the final `usage` chunk (requested via
// stream_options.include_usage) is captured and logged as an `llm_stream_usage` event. Yields
// every chunk unchanged so callers iterate exactly as before (the usage chunk has empty choices,
// so per-token consumers skip it). The cost tracker counts this event; without it, streamed calls
// report zero tokens and their spend is invisible.
async function* wrapStreamUsage(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  stream: AsyncIterable<any>,
  traceId: string,
  label: string,
  model: string | undefined,
  provider: string,
  t0: number,
  promptRef?: string,
  genParams?: Record<string, unknown>,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
): AsyncGenerator<any> {
  let usage: unknown;
  try {
    for await (const chunk of stream) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const u = (chunk as any)?.usage;
      if (u) usage = u;
      yield chunk;
    }
  } finally {
    if (usage) {
      const u = usage as { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number };
      await logEvent(traceId, 'llm_stream_usage', label, { model, provider, usage, streamed: true }, Date.now() - t0,
        buildEnvelope(promptRef, {
          model: model ?? null, provider, genParams: genParams ?? null,
          // reasoning-inclusive, same rule as the non-streaming path above
          tokensIn: u.prompt_tokens ?? null, tokensOut: billableOutputTokens(u),
        })).catch(() => {});
    }
  }
}

// Used by streaming endpoints to log the assembled response after consuming the stream.
export async function logStreamComplete(
  traceId: string,
  label: string,
  fullContent: string,
  startMs: number,
  meta?: Record<string, unknown>
): Promise<void> {
  await logEvent(traceId, 'llm_response_stream_complete', label, {
    content: fullContent,
    char_count: fullContent.length,
    ...(meta || {}),
  }, Date.now() - startMs);
}

// ─────────────────────────────────────────────────────────────────────────────
// v1.7 Sprint A — denormalized writers used by /ask to populate the new
// columns on `traces` for fast list/search/filter without scanning JSONB.
// All wrapped in try/catch so tracing never breaks the actual request.
// ─────────────────────────────────────────────────────────────────────────────

/** Write the first 160 chars of the question into traces.question_preview. */
export async function setTraceQuestionPreview(traceId: string, question: string): Promise<void> {
  if (labExecution()) return;   // §7
  try {
    const preview = (question || '').slice(0, 160);
    await sqlFn(`UPDATE traces SET question_preview = $1 WHERE trace_id = $2`, [preview, traceId]);
  } catch {}
}

/** Write the critique severity (none/minor/moderate/major) into traces.severity. */
export async function setTraceSeverity(traceId: string, severity: string): Promise<void> {
  if (labExecution()) return;   // §7
  try {
    await sqlFn(`UPDATE traces SET severity = $1 WHERE trace_id = $2`, [severity, traceId]);
  } catch {}
}

/** Write {draft, critique, revise, ...} → traces.model_summary JSONB. */
export async function setTraceModelSummary(traceId: string, models: Record<string, string>): Promise<void> {
  if (labExecution()) return;   // §7
  try {
    await sqlFn(`UPDATE traces SET model_summary = $1::jsonb WHERE trace_id = $2`, [JSON.stringify(models), traceId]);
  } catch {}
}

/** Write the assembled final answer text into traces.final_answer_text.
 *  The search_tsv GENERATED column will recompute automatically. */
export async function setTraceFinalAnswer(traceId: string, finalAnswer: string): Promise<void> {
  if (labExecution()) return;   // §7
  try {
    await sqlFn(`UPDATE traces SET final_answer_text = $1 WHERE trace_id = $2`, [finalAnswer, traceId]);
  } catch {}
}

/** Roll registry prompt ids into traces.prompt_ids (deduped append — an id already in the
 *  array is skipped). Stage 1 denormalized writer; degrades to no-op before migration 0012. */
export async function setTracePromptIds(traceId: string, promptIds: string[]): Promise<void> {
  if (labExecution()) return;   // §7
  try {
    for (const id of promptIds) {
      await sqlFn(
        `UPDATE traces SET prompt_ids = COALESCE(prompt_ids, '[]'::jsonb) || to_jsonb($1::text)
         WHERE trace_id = $2 AND NOT (COALESCE(prompt_ids, '[]'::jsonb) ? $1)`,
        [id, traceId]
      );
    }
  } catch {}
}

/**
 * The TRACELESS Bedrock arm (S1, 7 Aug 2026) — governedChat's other half.
 *
 * Same transport, same budget resolution, same no-fallback rule as the traced branch above; the
 * only difference is what gets recorded. With no traceId there is no trace to hang events on, so a
 * failure opens its OWN one-event trace, exactly as `emitProviderErrorTrace` does for the traceless
 * Vertex/OpenRouter path. A SUCCESS on this arm records nothing — that is the pre-existing property
 * of every traceless call in this repo (which is why the traced arm is the one production uses),
 * and changing it for one provider would make Bedrock's cost visibility depend on which arm the
 * caller happened to take.
 *
 * `stream: true` gets the same single-chunk shim the traced arm uses, so the caller's `for await`
 * contract holds identically on both.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function bedrockOnlyChat(label: string, params: any, model: string, opts: { timeoutMs?: number; maxTries?: number }): Promise<any> {
  try {
    const completion = await bedrockGenerate(params, { model, timeoutMs: opts.timeoutMs, maxTries: opts.maxTries, label });
    return (params as { stream?: boolean }).stream ? singleChunkStream(completion) : completion;
  } catch (e) {
    const payload = bedrockFailurePayload(label, model, e);
    try {
      const tid = await startTrace('provider_error', { provider: 'bedrock', model });
      await logEvent(tid, 'provider_error', label, payload);
      await finishTrace(tid, 'success');
    } catch { /* observability must never be the thing that changes the outcome */ }
    throw e;   // F11 — no fallback tier behind an explicit target.
  }
}

/**
 * The governed model-call entry for feature code (Stage 4). Traced → tracedChat (envelope
 * stamped when promptRef is set); traceless → the plain hybrid fallback, whose ONLY
 * sanctioned call site is here inside the governed layer. Transport is byte-identical to
 * the two paths it unifies (same param handling, same Gemini→Ollama fallback), so routing
 * a call through here never changes its output. scripts/reasoning-governance-check.mjs
 * hard-fails any model call that bypasses this layer.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function governedChat(
  traceId: string | undefined,
  label: string,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  params: any,
  opts?: { gemini?: string; openrouter?: string; bedrock?: string; promptRef?: string; timeoutMs?: number; maxTries?: number; noLocalFallback?: boolean },
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
): Promise<any> {
  // §7 — the lab edge outranks both arms below. It must be checked BEFORE the traceId
  // branch: a lab run that happened to carry a traceId would otherwise fall into
  // tracedChat's production ladder, which is the silent-downgrade defect F11 exists to
  // stop, in the one direction that also spends production money.
  const _labGoverned = labExecution();
  if (_labGoverned) return _labGoverned.chat(label, params);
  // ⚠️ THE TRACED ARM IS THE ONE PRODUCTION USES. Both audit legs arrive here with a traceId, so
  // a budget that only reaches the traceless arm below changes nothing in production while every
  // naive test passes — which is exactly how the 110 s ceiling survived 3039c42. Both arms carry
  // timeoutMs, maxTries and (V-a2) noLocalFallback; keep it that way.
  if (traceId) return tracedChat(traceId, label, params, opts);
  // ⚠️ AND THE SAME LESSON, INVERTED, FOR BEDROCK (S1, 7 Aug 2026). A `bedrock` option dropped on
  // THIS arm would not error — chatWithFallback would see no gemini and no openrouter slug and
  // quietly run the local mini, while the caller's row said Bedrock. That is a silent downgrade
  // producing a misattributed row: the exact defect F11 exists to stop. The target is honoured on
  // both arms or it is honoured on neither.
  if (opts?.bedrock) return bedrockOnlyChat(label, params, opts.bedrock, opts);
  return chatWithFallback(params, opts?.gemini, opts?.openrouter, opts?.timeoutMs, opts?.maxTries, opts?.noLocalFallback);
}

/**
 * governedLabChat — the Lab v2 transport (LAB-MCP-V2-PRD-v1.0 §7, §6.1).
 *
 * ONE TARGET, ONE ATTEMPT, NO LADDER. An arm names exactly one (provider, model) per
 * stage and v2 has no fallback: a stage that cannot reach its named model FAILS that
 * stage. That is not a convenience choice — a lab result silently served by a different
 * model than the arm declared is a measurement that reads as clean and is not, which is
 * precisely what §6.2's attribution machinery exists to catch. Falling back would
 * manufacture the very rows attribution is there to reject.
 *
 * `maxRetries: 0` / `maxTries: 1` on every branch for the same reason, plus a second:
 * the gateway has already RESERVED budget for exactly one call before this runs. A
 * transport-level retry would spend a second call's money against one reservation.
 *
 * It lives in lib/trace.ts because scripts/reasoning-governance-check.mjs hard-fails any
 * direct model call outside the governed layer, and because attribution must be attached
 * by the one existing mechanism (`attachTransportAttribution`) rather than a second
 * implementation that could drift from it.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function governedLabChat(
  provider: 'bedrock' | 'openrouter' | 'ollama' | 'vertex',
  model: string,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  params: any,
  timeoutMs?: number,
  signal?: AbortSignal,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
): Promise<any> {
  const reqOpts: Record<string, unknown> = { maxRetries: 0 };
  if (timeoutMs) reqOpts.timeout = timeoutMs;
  if (signal) reqOpts.signal = signal;

  if (provider === 'bedrock') {
    const completion = await bedrockGenerate(params, { model, timeoutMs, maxTries: 1, label: 'lab-v2' });
    return attachTransportAttribution(completion, {
      dispatched_provider: 'bedrock', dispatched_model: model, cloud_response_received: true,
    });
  }
  if (provider === 'openrouter') {
    // The Ollama-only fields are stripped BEFORE buildOpenrouterParams, exactly as the traced
    // path does it. buildOpenrouterParams adds the thinking headroom but does not remove these
    // two, so calling it on raw params leaked `options` and `keep_alive` onto the wire —
    // measured by the fidelity test, not assumed.
    const { options: _o, keep_alive: _k, ...rest } = params as Record<string, unknown>;
    void _o; void _k;
    const client = openrouterChatClient();
    const result = await client.chat.completions.create(
      buildOpenrouterParams(model, rest) as never, reqOpts);
    return attachTransportAttribution(result, {
      dispatched_provider: 'openrouter', dispatched_model: model, cloud_response_received: true,
    });
  }
  if (provider === 'vertex') {
    const client = await getGeminiChatClient();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result = await client.chat.completions.create(buildVertexParams(params, model) as any, reqOpts);
    return attachTransportAttribution(result, {
      dispatched_provider: 'vertex', dispatched_model: model, cloud_response_received: true,
    });
  }
  const result = await llm.chat.completions.create({ ...params, model }, reqOpts);
  return attachTransportAttribution(result, {
    dispatched_provider: 'ollama', dispatched_model: model, cloud_response_received: false,
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Guaranteed finalize (Stage 1) — closes the `running`-trace leak.
// ─────────────────────────────────────────────────────────────────────────────

/** finishTrace, but ONLY if the trace is still 'running' — never overwrites a status the
 *  pipeline already set (so withTrace's safety net can't turn a 'partial' into 'success'). */
export async function finishTraceIfRunning(
  traceId: string,
  status: 'success' | 'error' | 'partial',
  errorMessage?: string
): Promise<void> {
  if (labExecution()) return;   // §7
  try {
    await sqlFn(
      `UPDATE traces SET finished_at = NOW(), status = $1, error_message = $2,
       total_ms = EXTRACT(EPOCH FROM (NOW() - started_at)) * 1000
       WHERE trace_id = $3 AND status = 'running'`,
      [status, errorMessage ?? null, traceId]
    );
  } catch {}
}

/** Injection seam for unit tests (repo idiom — mirrors MatchDeps/SkeletonDeps). */
export interface WithTraceDeps {
  start?: (feature: string, input: unknown) => Promise<string>;
  finish?: (traceId: string, status: 'success' | 'error', errorMessage?: string) => Promise<void>;
}

/**
 * Run fn under a trace with GUARANTEED finalization: the finalizer runs exactly once, in
 * finally, on success AND on throw (rethrown unchanged). The finalizer is status-guarded
 * (finishTraceIfRunning), so a pipeline that already finished its own trace — including
 * with 'error' or 'partial' — is untouched; only a trace left 'running' gets closed.
 */
export async function withTrace<T>(
  feature: string,
  input: unknown,
  fn: (traceId: string) => Promise<T>,
  deps: WithTraceDeps = {},
): Promise<T> {
  const start = deps.start ?? startTrace;
  const finish = deps.finish ?? finishTraceIfRunning;
  const traceId = await start(feature, input);
  let error: unknown = null;
  try {
    return await fn(traceId);
  } catch (e) {
    error = e;
    throw e;
  } finally {
    await finish(traceId, error ? 'error' : 'success', error ? String((error as Error).message) : undefined);
  }
}

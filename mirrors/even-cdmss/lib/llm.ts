import OpenAI from 'openai';
import { getVertexAccessToken, vertexSaEmail } from './gcp-auth';
import {
  PROVIDER_ERROR_CAP, beginProviderCall, endProviderCall, providerCallsInFlight, providerErrorPayload,
  providerResponsePayload, isProviderResponseError,
} from './provider-error-core';
import { openrouterCreateWithRetry, createWithRetry } from './openrouter-retry';
import { remainingBudgetMs } from './lab-batch-core';

// ─── D-1 (Right Care reliability §3, 31 Jul 2026): bound every provider call ────────────────────
/** Per-call ceiling for a provider request. The SDK default is 10 minutes with 2 retries,
 *  which exceeds every serverless box we run in and can triple wall time on a stall.
 *  Override per call site — see LLM_AUDIT_TIMEOUT_MS. Pure resolvers exported for tests
 *  (module-level env reads are untestable in-process — the resolveEnvRerankBackend pattern). */
export function resolveLlmTimeoutMs(raw: string | undefined, fallback: number): number {
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
}
/** maxRetries: 0 is deliberate (PRD §3.1): a retry inside a bounded outer budget spends the budget
 *  twice for the same answer, and the soft-fail paths already degrade gracefully. Failing fast
 *  beats retrying blind. A non-numeric env value falls back to 0, never NaN. */
export function resolveLlmMaxRetries(raw: string | undefined): number {
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : 0;
}
export const LLM_CALL_TIMEOUT_MS = resolveLlmTimeoutMs(process.env.LLM_CALL_TIMEOUT_MS, 90_000);
export const LLM_MAX_RETRIES = resolveLlmMaxRetries(process.env.LLM_MAX_RETRIES);
/** The audit override, applied AT THE AUDIT CALL SITES via governedChat's timeoutMs (per-request
 *  { timeout } — one client per provider, the override visible where it is used). The audit runs
 *  p50 267 s / p75 425 s per note; 600 s clears p75 with margin and sits under the 800 s box. A
 *  single global 90 s ceiling would break the engine. */
export const LLM_AUDIT_TIMEOUT_MS = resolveLlmTimeoutMs(process.env.LLM_AUDIT_TIMEOUT_MS, 600_000);

const baseURL = `${process.env.OLLAMA_BASE_URL!}/v1`;

export const llm = new OpenAI({ baseURL, apiKey: 'ollama', timeout: LLM_CALL_TIMEOUT_MS, maxRetries: LLM_MAX_RETRIES });

// ─────────────────────────────────────────────────────────────────────────────
// Vertex AI (Gemini) — hybrid backend. The local Ollama `llm` above stays the
// default and the fallback; Gemini is used only when fully configured AND a call
// site opts in (see tracedChat's `gemini` option). All inference stays inside the
// GCP project/region pinned by GCP_LOCATION (data residency).
// ─────────────────────────────────────────────────────────────────────────────

/** Default region — override with GCP_LOCATION (e.g. asia-south1 for India residency). */
const GCP_LOCATION = process.env.GCP_LOCATION || 'asia-south1';
const GCP_PROJECT = process.env.GCP_PROJECT || '';

/** The resolved Vertex region — a provider_error record must name where the call landed
 *  (a per-region quota and a global IAM denial read identically without it). */
export function vertexRegion(): string { return GCP_LOCATION; }

/**
 * 403-diagnosis kickoff §4.2 — emit a `provider_error` trace event from the TRACELESS paths
 * (chatWithFallback has no traceId). Rides the existing startTrace/logEvent sink — no new table,
 * no migration; the trace is finished immediately so it never adds to the orphaned-`running`
 * count. Lazy import: trace.ts statically imports this module, so a static import back would be
 * a cycle. Best-effort — observability must never break the fallback that keeps requests alive.
 */
async function emitProviderErrorTrace(payload: Record<string, unknown>): Promise<void> {
  try {
    const { startTrace, logEvent, finishTrace } = await import('./trace');
    const tid = await startTrace('provider_error', { provider: payload.provider, model: payload.intended_model });
    await logEvent(tid, 'provider_error', String(payload.label ?? '') || null, payload);
    await finishTrace(tid, 'success');
  } catch { /* never block the fallback */ }
}

/** Default Gemini model (Vertex publisher-prefixed form is applied at call time). */
export const GEMINI_MODEL = process.env.GEMINI_MODEL || 'gemini-2.5-pro';

/** Cheap/fast Gemini model for the utility passes (variant-gen, reranker judge, query-expand). */
export const GEMINI_FLASH_MODEL = process.env.GEMINI_FLASH_MODEL || 'gemini-2.5-flash';

/** True only when every piece needed to call Vertex is present. */
export function geminiConfigured(): boolean {
  return Boolean(GCP_PROJECT && process.env.GCP_SA_KEY);
}

/**
 * MINI-ONLY PIPELINE SWITCH (2 Jul 2026, V). `LLM_PIPELINE=mini` forces the WHOLE app
 * back onto the Mac-mini Ollama bridge (the original architecture): geminiModelFor /
 * geminiUtilityModel return undefined, so every call runs params.model (TEXT_MODEL /
 * CRITIQUE_MODEL) against OLLAMA_BASE_URL. ₹0 marginal; cost tab shows no Gemini rows.
 * UNSET in production — this is the experimentation escape hatch, flipped deliberately
 * (env change + redeploy). Scoped per-run mini use (e.g. the OPD mini backfill) does NOT
 * need this switch — it forces locally via opts.pipeline.
 */
export function miniPipeline(): boolean {
  return (process.env.LLM_PIPELINE || '').trim().toLowerCase() === 'mini';
}

/** A model string targets Gemini if it names a gemini model (with or without the google/ prefix). */
export function isGeminiModel(model: string | undefined | null): boolean {
  return !!model && /(^|\/)gemini[-.]/i.test(model);
}

// ─────────────────────────────────────────────────────────────────────────────
// OpenRouter — third provider (OpenAI-compatible), added for the citation critic
// (provider-migration PR). A call opts into it via tracedChat's `openrouter` model
// slug; the local Ollama default + Vertex Gemini paths are unchanged, and embeddings
// stay on the mini (nomic). Fallback on error is still the local Ollama model.
// ─────────────────────────────────────────────────────────────────────────────

/** True when OpenRouter can be called (key present, and not forced onto the mini pipeline). */
export function openrouterConfigured(): boolean {
  return Boolean(process.env.OPENROUTER_API_KEY) && !miniPipeline();
}

/** OpenAI-SDK client bound to OpenRouter. Cheap to construct; the key rides the Authorization header. */
export function openrouterChatClient(): OpenAI {
  // D-1: bounded at construction. openrouterCreateWithRetry's per-request opts (110s deadline,
  // maxRetries 0) still override these on the wrapped path — this bounds the bare/streaming calls.
  return new OpenAI({ baseURL: process.env.OPENROUTER_BASE_URL || 'https://openrouter.ai/api/v1', apiKey: process.env.OPENROUTER_API_KEY, timeout: LLM_CALL_TIMEOUT_MS, maxRetries: LLM_MAX_RETRIES });
}

/** The OpenRouter slug for a Gemini model (publisher-prefixed). Used by the flag-gated bridge
 *  resolver below AND by the V-a2 ladder's tier-2 hop, which needs the slug regardless of the
 *  flag (post-cutover, OpenRouter is the BACKUP tier for a Vertex-primary Gemini call). */
export function openrouterSlugForGemini(model: string): string {
  return model.startsWith('google/') ? model : `google/${model}`;
}

/** BRIDGE (30 Jul 2026): route Gemini through OpenRouter while aiplatform.googleapis.com is
 *  disabled on clinical-infra. Returns a slug ONLY when the flag is set, so unset is
 *  byte-identical to today. Retire with the flag when Vertex is restored. */
export function openrouterGeminiSlug(model: string | undefined): string | undefined {
  if (process.env.GEMINI_VIA_OPENROUTER !== '1') return undefined;
  if (!model) return undefined;
  return openrouterSlugForGemini(model);
}

// ─────────────────────────────────────────────────────────────────────────────
// UNIT V-a2 (4 Aug 2026) — the cloud ladder. Vertex is primary, OpenRouter is
// the backup tier (V-8); the two tiers SHARE one leg budget, so the ladder can
// never cost a route more than the single tier did.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Which cloud tiers a call runs, in order.
 *
 * TIER ORDER IS FIXED: VERTEX, THEN OPENROUTER. `GEMINI_VIA_OPENROUTER=1` INVERTS IT — the flag's
 * existing precedence (an OpenRouter slug resolves for every Gemini call) already selects
 * OpenRouter as tier 1 (`orFirst`), so with the flag set the ladder is OpenRouter → Vertex and the
 * bridge remains an EXACT ROLLBACK: set the flag back to `1` and OpenRouter is primary again with
 * Vertex behind it. That works only while the OpenRouter tier stays intact — never remove it as
 * cleanup.
 *
 * A SECOND TIER EXISTS ONLY WHEN THE CALLER SUPPLIED A LEG BUDGET (`timeoutMs`): the tiers share
 * that one budget (see tierCeilingMs), so a leg still costs at most the caller's number and the
 * route-budget-guard arithmetic does not move. A caller with no budget — /ask, /ddx, /topics, the
 * cite gate, every utility surface — keeps today's single cloud tier + local fallback exactly.
 */
export function cloudLadder(i: { orFirst: boolean; orAvailable: boolean; vertexAvailable: boolean; hasLegBudget: boolean }): Array<'openrouter' | 'gemini'> {
  const ladder: Array<'openrouter' | 'gemini'> = [i.orFirst ? 'openrouter' : 'gemini'];
  if (i.hasLegBudget) {
    if (i.orFirst && i.vertexAvailable) ladder.push('gemini');
    if (!i.orFirst && i.orAvailable) ladder.push('openrouter');
  }
  return ladder;
}

/**
 * The per-attempt ceiling for the CURRENT tier: the caller's `timeoutMs` (already the call class's
 * perAttemptMs) clamped to what remains of the leg. `remainingBudgetMs` is lib/lab-batch-core.ts's
 * mechanism — the SAME idiom `openRouterGenerate` has used since the tick-deadline PRD, not a
 * second one. THE BUDGET BELONGS TO THE LEG, NOT THE PROVIDER: tier 1 enters with the full budget,
 * tier 2 with whatever tier 1 left. Consequence — THE GUARD ARITHMETIC DOES NOT MOVE: a leg still
 * costs at most legBudgetMs across BOTH tiers (the naive vertex+openrouter sum would be
 * 2 × 380,000 × 2 legs = 1,520,000 in OPD's 800,000 ms box), so route-budget-guard.test.ts still
 * computes 760,000 (OPD) and 780,000 (IPD) and NO PROVIDER_BUDGETS value changes in this unit.
 */
export function tierCeilingMs(legBudgetMs: number | undefined, deadlineAt: number | null, now: number = Date.now()): number | undefined {
  if (!legBudgetMs || deadlineAt == null) return legBudgetMs;
  return Math.min(legBudgetMs, remainingBudgetMs(deadlineAt, now));
}

/** The error thrown when a tier is SKIPPED because the leg budget is already spent — a spent
 *  budget must not buy another provider call. Names the tier that was skipped and why, and the
 *  earlier tier's failure travels with it (capped at PROVIDER_ERROR_CAP, never 200). */
export function ladderSkipError(tier: string, legBudgetMs: number, lastErr: unknown): Error {
  const prior = String((lastErr as { message?: unknown })?.message ?? lastErr ?? 'no earlier failure').slice(0, PROVIDER_ERROR_CAP);
  return new Error(`${tier} tier skipped: the ${legBudgetMs}ms leg budget is exhausted — earlier tier failed with: ${prior}`);
}

/** Provider pin for Gemini-via-OpenRouter. Slugs read off OpenRouter's endpoints listing for
 *  google/gemini-2.5-pro on 30 Jul 2026 — Google ("google-vertex", serving from OpenRouter's own
 *  GCP project) and Google AI Studio ("google-ai-studio"); every listed endpoint is
 *  Google-operated. allow_fallbacks:false so a future non-Google host can never serve a clinical
 *  call by surprise. */
export const OPENROUTER_GOOGLE_PROVIDER_PIN = { allow_fallbacks: false, only: ['google-vertex', 'google-ai-studio'] } as const;

/**
 * Build the OpenRouter request body for a slug. A non-Gemini slug reproduces the pre-bridge
 * behaviour byte-for-byte: reasoning disabled unless the caller supplied its own (the citation
 * critic's bounded-verdict contract). A GEMINI slug (the bridge) instead handles the two traps
 * that would otherwise fire on the first call:
 *   trap 1 (register A-12) — Gemini 2.5 CANNOT disable thinking; sending the disable is an
 *     OpenRouter 400 "Reasoning is mandatory and cannot be disabled". Never send it.
 *   trap 2 — Pro spends output budget on reasoning FIRST; the Ollama-tuned caps truncate the
 *     JSON mid-string. Apply the same +8192 headroom the Vertex branch applies.
 *   trap 3 (T-11, 31 Jul 2026) — THE THINKING CAP WAS BEING DROPPED. Call sites express it in the
 *     ONLY form Vertex honors, `google.thinking_config.thinking_budget` (see the trace.ts note).
 *     OpenRouter does not know that field, so it rode along as dead weight and Pro thought
 *     WITHOUT A LIMIT on the bridge while the same code capped it on Vertex. `thinkingBudgetOf`
 *     translates it to OpenRouter's own `reasoning.max_tokens` and the `google` field is dropped
 *     from the outgoing body. This is a DEFECT FIX: it restores what the call site already says.
 *     No default is invented — no budget in ⇒ no `reasoning` out, byte-identical to today.
 * Plus the Google provider pin above.
 */
export function thinkingBudgetOf(rest: Record<string, unknown>): number | undefined {
  const g = rest.google as { thinking_config?: { thinking_budget?: unknown } } | undefined;
  const n = Number(g?.thinking_config?.thinking_budget);
  // Pro rejects a budget of 0 with an HTTP 400 (it cannot have thinking disabled), so 0 is not a
  // translatable cap — it is passed on as "no cap sent", exactly as an absent field would be.
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : undefined;
}

export function buildOpenrouterParams(slug: string, rest: Record<string, unknown>): Record<string, unknown> {
  if (!isGeminiModel(slug)) {
    return { ...rest, model: slug, ...(('reasoning' in rest) ? {} : { reasoning: { enabled: false } }) };
  }
  const baseMax = Number((rest as { max_tokens?: number }).max_tokens) || 1024;
  // The Vertex-only field never travels to OpenRouter, translated or not.
  const { google: _g, ...body } = rest;
  void _g;
  const budget = thinkingBudgetOf(rest);
  return {
    ...body,
    model: slug,
    max_tokens: baseMax + 8192,
    provider: OPENROUTER_GOOGLE_PROVIDER_PIN,
    // A caller that already speaks OpenRouter's dialect (the eval body at opd-note-audit.ts:636)
    // keeps its own reasoning block — translation never overwrites an explicit one.
    ...(budget !== undefined && !('reasoning' in body) ? { reasoning: { max_tokens: budget } } : {}),
  };
}

/**
 * Does the SERVED model match the INTENDED one, tolerating provider prefixes/suffixes?
 * `google/gemini-2.5-pro` ≡ `gemini-2.5-pro`; `qwen/qwen3-32b` ≡ `qwen3-32b`. Used by the
 * fallback-integrity guard to tell a genuine served verdict from a silent drop to the local
 * Ollama model — replacing the old "served is not Gemini ⇒ fallback" test, which would reject
 * every legitimate OpenRouter (Qwen) verdict.
 */
export function modelsAgree(served: string | null | undefined, intended: string | null | undefined): boolean {
  const norm = (s: string | null | undefined) => String(s ?? '').toLowerCase().trim().replace(/^[a-z0-9._-]+\//, '');
  const a = norm(served), b = norm(intended);
  if (!a || !b) return false;
  return a === b || a.includes(b) || b.includes(a);
}

function vertexBaseURL(): string {
  // The "global" location uses the un-prefixed host; regional uses {loc}-aiplatform.
  const host =
    GCP_LOCATION === 'global'
      ? 'aiplatform.googleapis.com'
      : `${GCP_LOCATION}-aiplatform.googleapis.com`;
  return `https://${host}/v1beta1/projects/${GCP_PROJECT}/locations/${GCP_LOCATION}/endpoints/openapi`;
}

/** Vertex requires the publisher prefix (google/gemini-2.5-pro). */
export function vertexModelName(model: string): string {
  return model.startsWith('google/') ? model : `google/${model}`;
}

/**
 * Returns an OpenAI-SDK client bound to the Vertex OpenAI-compatible endpoint,
 * authenticated with a freshly-minted (cached) access token. Created per call so
 * the bearer is always current; the token itself is cached in gcp-auth.
 */
export async function getGeminiChatClient(): Promise<OpenAI> {
  const token = await getVertexAccessToken();
  // D-1: bounded at construction (the Vertex transport had NO ceiling at all — the same class
  // doc-transport-core fixed for document reads). Audit call sites override per-request.
  return new OpenAI({ baseURL: vertexBaseURL(), apiKey: token, timeout: LLM_CALL_TIMEOUT_MS, maxRetries: LLM_MAX_RETRIES });
}

/**
 * Per-surface Gemini routing. Returns the Gemini model to use for `surface`
 * (e.g. 'ddx', 'ask', 'drugs', 'coach', 'topics', 'practice'), or undefined to
 * stay on local Ollama. Enabled by GEMINI_ALL=1 (everything) OR a per-surface
 * GEMINI_<SURFACE>=1 flag, and only when Vertex is fully configured. Off by
 * default so production is unchanged until a flag is set.
 */
export function geminiModelFor(surface: string): string | undefined {
  if (miniPipeline()) return undefined; // LLM_PIPELINE=mini ⇒ everything local
  if (!geminiConfigured()) return undefined;
  const all = process.env.GEMINI_ALL === '1';
  const per = process.env[`GEMINI_${surface.toUpperCase()}`] === '1';
  return all || per ? GEMINI_MODEL : undefined;
}

/**
 * Model for the cheap utility passes (query-variant generation, reranker judge,
 * query expansion). Routes to Gemini FLASH — fast, cheap, no need for Pro's
 * reasoning — whenever Gemini is on for the whole app (GEMINI_ALL) or utility
 * specifically (GEMINI_UTILITY). This is what keeps the Mac Mini out of the
 * request path. Undefined ⇒ local Ollama (fallback). NB: embeddings still run
 * locally on nomic — the corpus is nomic-embedded, so query embeddings must
 * match that vector space and cannot move to Gemini.
 */
export function geminiUtilityModel(): string | undefined {
  if (miniPipeline()) return undefined; // LLM_PIPELINE=mini ⇒ everything local
  if (!geminiConfigured()) return undefined;
  if (process.env.GEMINI_ALL === '1' || process.env.GEMINI_UTILITY === '1') {
    return GEMINI_FLASH_MODEL;
  }
  return undefined;
}

/**
 * Provider-routing wrapper for the DIRECT (non-tracedChat) call sites
 * (streaming study-guide / practice generation). When `geminiModel` is set and
 * Vertex is configured, runs on Gemini — stripping Ollama-only params and
 * raising max_tokens so 2.5 Pro's thinking tokens don't truncate the answer —
 * and falls back to the local Ollama model in `params.model` on any error. With
 * no geminiModel it is byte-identical to `llm.chat.completions.create(params)`.
 *
 * UNIT V-a2 (4 Aug 2026): the two cloud providers are now a LADDER (cloudLadder), sharing ONE leg
 * budget (tierCeilingMs), and `noLocalFallback: true` makes both-tiers-failed a THROW instead of a
 * local answer. Absent or false ⇒ today's behaviour exactly — that is what keeps /ask, /ddx,
 * /topics, concept-extract, expand, drugs and the cite gate working unchanged.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function chatWithFallback(params: any, geminiModel?: string, openrouterModel?: string, timeoutMs?: number, maxTries?: number, noLocalFallback?: boolean): Promise<any> {
  // D-1: an audit-class call site passes its own ceiling (per-request { timeout } — one client per
  // provider, the override visible here). Absent ⇒ undefined ⇒ the client-level bound applies.
  const reqOpts = timeoutMs ? { timeout: timeoutMs } : undefined;
  // OpenRouter takes precedence when an explicit slug is given (the citation critic). Non-thinking by
  // default (bounded verdict); falls back to the local Ollama model in params.model on any error.
  // BRIDGE (30 Jul 2026): with GEMINI_VIA_OPENROUTER=1 a gemini model resolves to its OpenRouter
  // slug HERE — derived centrally so no call site can be missed (a missed site would 403 on Vertex
  // silently forever). Flag unset ⇒ openrouterGeminiSlug returns undefined ⇒ byte-identical.
  const orModel = openrouterModel || openrouterGeminiSlug(geminiModel);
  const useOpenRouter = Boolean(orModel) && openrouterConfigured();
  const useGemini = Boolean(geminiModel) && geminiConfigured();
  if (!useOpenRouter && !useGemini) {
    return llm.chat.completions.create(params, reqOpts);
  }

  // ══ UNIT V-a2 (4 Aug 2026): THE CLOUD LADDER — one leg budget across both tiers ══════════════
  // Tier order is FIXED: Vertex, then OpenRouter. GEMINI_VIA_OPENROUTER=1 inverts it (the flag's
  // precedence above makes OpenRouter tier 1), so the bridge remains an exact rollback. The budget
  // belongs to the LEG, not the provider — see tierCeilingMs: the guard arithmetic does not move,
  // a leg still costs at most the caller's timeoutMs.
  const ladder = cloudLadder({
    orFirst: useOpenRouter,
    orAvailable: openrouterConfigured(),
    vertexAvailable: useGemini,
    hasLegBudget: Boolean(timeoutMs),
  });
  const deadlineAt = timeoutMs ? Date.now() + timeoutMs : null;

  let lastErr: unknown = null;
  let lastTier: 'openrouter' | 'gemini' = ladder[0];
  for (let ti = 0; ti < ladder.length; ti++) {
    const tier = ladder[ti];
    // A spent budget SKIPS the tier rather than calling it — throw-with-name, never a free call.
    if (ti > 0 && deadlineAt != null && remainingBudgetMs(deadlineAt) <= 0) {
      lastErr = ladderSkipError(tier, timeoutMs as number, lastErr);
      lastTier = tier;
      break;
    }
    // Where a failure here lands next: the next tier when one remains, else Ollama or nothing.
    const nextHop = ti + 1 < ladder.length ? ladder[ti + 1] : null;
    if (tier === 'openrouter') {
      // Tier-2 hop from a failed Vertex call derives the slug itself — orModel is undefined there.
      const slug = orModel || openrouterSlugForGemini(geminiModel as string);
      beginProviderCall('openrouter');
      try {
        const { options: _o, keep_alive: _k, ...rest } = params as Record<string, unknown>;
        void _o; void _k;
        const orParams = buildOpenrouterParams(slug, rest as Record<string, unknown>);
        const client = openrouterChatClient();
        // Addendum F v2 task 1 — the production call carries the SAME deadline/retry discipline
        // the lab path has had since D4/D2. Streaming calls keep the bare call: an in-flight
        // stream being consumed by the caller must not be aborted by a wall-clock timer, and
        // classifyProviderResponse has never judged streams.
        const res = (orParams as { stream?: boolean }).stream
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          ? await client.chat.completions.create(orParams as any)
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          : await openrouterCreateWithRetry((ro) => client.chat.completions.create(orParams as any, ro), {
              model: slug,
              // ROOT CAUSE FIX (2 Aug 2026): the caller's ceiling reaches this call. V-a2 clamps
              // it to what the leg has left, so tier 2 runs on tier 1's remainder, never on a
              // fresh budget. Absent ⇒ 110 s, unchanged.
              timeoutMs: tierCeilingMs(timeoutMs, deadlineAt),
              // Unit D (3 Aug 2026): and the caller's TRY COUNT. An audit-class budget is one try
              // (PROVIDER_BUDGETS). Absent ⇒ OPENROUTER_MAX_TRIES (3), unchanged.
              maxTries,
              onAttemptFailure: (f) => console.error(
                `[provider-retry] openrouter ${slug} attempt ${f.attempt}/${f.maxTries} ${f.kind}${f.status != null ? ` ${f.status}` : ''} — ${f.willRetry ? 'retrying' : 'giving up'}: ${f.message}`),
            });
        endProviderCall('openrouter');
        return res;
      } catch (e) {
        // §4.1/§4.2/§4.3 — snapshot in-flight BEFORE decrementing (the failing call counts), then
        // the FULL error (4000-char cap, not 200), loud (console.error, stable prefix), and a
        // provider_error trace event. §2.1/§2.2/§2.4 — a 200 that is not a completion surfaces
        // AFTER the bounded retry as the marked ProviderResponseError; §2.3 (no Ollama laundering)
        // is enforced at the terminal disposition below, but the LADDER may still move it to the
        // other cloud tier — a broker's bad 200 is precisely what the direct Vertex call heals.
        const inFlightAtError = providerCallsInFlight();
        endProviderCall('openrouter');
        const fellBackTo = nextHop ?? (noLocalFallback || isProviderResponseError(e) ? 'none' : 'ollama');
        const payload = isProviderResponseError(e)
          ? providerResponsePayload({
              provider: 'openrouter', label: 'chatWithFallback', feature: null, fellBackTo,
              intendedModel: slug, fallbackModel: fellBackTo === 'ollama' ? (params as { model?: string }).model ?? null : null,
              region: null, saIdentity: null, inFlightAtError, defect: e.defect,
            })
          : providerErrorPayload({
              provider: 'openrouter', label: 'chatWithFallback', feature: null, fellBackTo,
              intendedModel: slug, fallbackModel: fellBackTo === 'ollama' ? (params as { model?: string }).model ?? null : null,
              region: null, saIdentity: null, error: e, inFlightAtError,
            });
        if (isProviderResponseError(e)) {
          console.error(`[provider-bad-response] openrouter ${slug} returned a non-completion 200 → ${fellBackTo}:`, JSON.stringify(payload));
        } else {
          console.error(`[provider-fallback] openrouter ${slug} failed → ${fellBackTo}:`, JSON.stringify(payload));
        }
        await emitProviderErrorTrace(payload);
        lastErr = e;
        lastTier = 'openrouter';
        continue;
      }
    }
    // tier === 'gemini'
    beginProviderCall('gemini');
    try {
      const { options: _o, keep_alive: _k, ...rest } = params as Record<string, unknown>;
      void _o; void _k;
      const baseMax = Number((rest as { max_tokens?: number }).max_tokens) || 1024;
      const gParams = { ...rest, model: vertexModelName(geminiModel as string), max_tokens: baseMax + 8192 };
      const gemini = await getGeminiChatClient();
      // ══ UNIT V-a1 (3 Aug 2026): THE VERTEX BRANCH GAINS THE OPENROUTER DISCIPLINE ═════════════
      // A bare `create()` bounded only by the SDK's own `timeout` was survivable while Vertex was
      // the fallback; it is primary now (V-a2), so it runs the same shared loop, provider-neutral.
      //
      // No stream_options self-heal here — that mechanism exists only on the traced arm, which is
      // the one that requests usage on streaming calls.
      const res = await createWithRetry(
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (ro) => gemini.chat.completions.create(gParams as any, ro),
        {
          provider: 'vertex',
          model: geminiModel,
          // Vertex's chat endpoint is OpenAI-compatible, so the default classifyProviderResponse fits.
          // V-a2: the caller's ceiling clamped to the leg's remainder (full budget when tier 1).
          timeoutMs: tierCeilingMs(timeoutMs, deadlineAt),
          maxTries,
          onAttemptFailure: (f) => console.error(
            `[provider-retry] vertex ${geminiModel} attempt ${f.attempt}/${f.maxTries} ${f.kind}${f.status != null ? ` ${f.status}` : ''} — ${f.willRetry ? 'retrying' : 'giving up'}: ${f.message}`),
        },
      );
      endProviderCall('gemini');
      return res;
    } catch (e) {
      // §4.1/§4.2/§4.3 (403 diagnosis): the FULL Vertex error body — error.status is what
      // distinguishes an IAM denial from a quota denial from a disabled API. Snapshot in-flight
      // BEFORE decrementing; loud console.error; provider_error event into trace_events.
      const inFlightAtError = providerCallsInFlight();
      endProviderCall('gemini');
      const fellBackTo = nextHop ?? (noLocalFallback ? 'none' : 'ollama');
      const payload = providerErrorPayload({
        provider: 'gemini', label: 'chatWithFallback', feature: null, fellBackTo,
        intendedModel: geminiModel ?? null, fallbackModel: fellBackTo === 'ollama' ? (params as { model?: string }).model ?? null : null,
        region: vertexRegion(), saIdentity: vertexSaEmail(), error: e, inFlightAtError,
      });
      console.error(`[provider-fallback] gemini ${geminiModel} failed → ${fellBackTo}:`, JSON.stringify(payload));
      await emitProviderErrorTrace(payload);
      lastErr = e;
      lastTier = 'gemini';
      continue;
    }
  }

  // ── Terminal disposition: every cloud tier failed (or the second was skipped, budget spent) ──
  // V-a2: `noLocalFallback` makes the failure a THROW — the audit paths' own machinery (OPD
  // llm_leg_failed, the IPD failure ledger) is the handler, never a silent local grade.
  if (noLocalFallback) throw lastErr;
  // §2.3 stands, OpenRouter only (unchanged from before the ladder): a 200-that-is-not-a-completion
  // from OpenRouter never launders into the local model. The Vertex tier keeps its historical
  // any-error → Ollama, so a utility Gemini call degrades exactly as it always has.
  if (lastTier === 'openrouter' && isProviderResponseError(lastErr)) throw lastErr;
  return llm.chat.completions.create(params, reqOpts);
}

// ─────────────────────────────────────────────────────────────────────────────
// Amazon Bedrock — fourth provider (Bedrock S1, 7 Aug 2026). The transport lives
// in lib/bedrock.ts (everything AWS in one file); these re-exports are what make
// `lib/llm.ts` still the one place a caller asks "which providers exist and what
// are their models called". DISPATCH is lib/trace.ts's, same as the other three.
//
// ⚠️ NOTHING HERE CALLS BEDROCK. Re-exporting the probe and the labels adds no
// call site: `bedrockGenerate` is imported by the governed layer alone, and
// scripts/reasoning-governance-check.mjs now fails the build on any other importer.
// ─────────────────────────────────────────────────────────────────────────────
export { bedrockConfigured, BEDROCK_MODELS, bedrockModelLabel, isKnownBedrockModel } from './bedrock';

export const TEXT_MODEL = process.env.TEXT_MODEL || 'qwen2.5:14b';
/** Model for scoped mini-pipeline runs (OPD mini backfill etc.). Defaults to TEXT_MODEL (qwen2.5:14b). */
export const MINI_MODEL = process.env.MINI_MODEL || TEXT_MODEL;
export const EMBED_MODEL = process.env.EMBED_MODEL || 'nomic-embed-text';
export const CRITIQUE_MODEL = process.env.CRITIQUE_MODEL || 'qwen2.5:7b';  // faster than 14b for audit/revise pass
export const EMBED_MODEL_V2 = process.env.EMBED_MODEL_V2 || 'mxbai-embed-large';
export const USE_EMBEDDING_V2 = false; // HOTFIX 2026-05-26: embedding_v2 column NULL for new ingestions; revert after backfill
export const TOP_K = parseInt(process.env.TOP_K || '8', 10);

export async function embedQuery(text: string): Promise<number[]> {
  const res = await llm.embeddings.create({ model: EMBED_MODEL, input: text });
  return res.data[0].embedding;
}

/** v1.6: stronger embedding (1024-dim) for the new column. */
export async function embedQueryV2(text: string): Promise<number[]> {
  const res = await llm.embeddings.create({ model: EMBED_MODEL_V2, input: text });
  return res.data[0].embedding;
}

export function vectorLiteral(v: number[]): string {
  return '[' + v.map((x) => x.toFixed(7)).join(',') + ']';
}

/** Fixed decode seed for the OPD note-audit GRADER (Audit-Score-Determinism PRD §8d, lever 2). Mirrors
 *  RETRIEVAL_LLM_SEED; env-overridable. Currently applied ONLY on the lab/eval OpenRouter body
 *  (buildOpenRouterBody) — Phase 1 measures whether Gemini honors a seed before Phase 2 touches prod. */
export const AUDIT_LLM_SEED = Number(process.env.AUDIT_LLM_SEED) || 42;

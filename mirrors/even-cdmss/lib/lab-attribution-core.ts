/**
 * lib/lab-attribution-core.ts — PURE attribution check for lab probe rows (F11 DEC-2, 7 Aug 2026).
 *
 * ⚠️ WHY THIS EXISTS. On 7 Aug a `lab_ask` probe with `model:"bedrock:…claude-haiku-4-5…"` stored a
 * row saying `provider='bedrock'`, `model='global.anthropic.claude-haiku-4-5-20251001-v1:0'`. Every
 * LLM leg of that run had in fact executed on the local mini (draft qwen2.5:14b, critique+revision
 * qwen2.5:7b). No error was raised anywhere, because nothing was broken in the transport — the
 * route's override gate REFUSED the override (silently, by design) and the route ran its production
 * default, while the MCP stamped the row from the model it had RESOLVED, which is a statement of
 * intent, not of fact.
 *
 * That is the whole F11 defect class restated: 87.8% of stored lab volume once turned out to be paid
 * Gemini while the tools advertised "₹0, never Gemini". The lesson was supposed to be "resolve the
 * provider properly". It was the wrong lesson. THE STORED ATTRIBUTION MUST BE DERIVED FROM WHAT
 * SERVED, NOT FROM WHAT WAS ASKED FOR — a resolver, however correct, only ever knows the ask.
 *
 * This module is the comparison, pure and total. The impure half (reading trace_events, correcting
 * the row) lives in lib/mcp-tools.ts.
 */

/** One LLM leg as the trace recorded it. Nulls mean the event carried no such field. */
export interface ServedCall { stage: string | null; provider: string | null; model: string | null }

/** What the caller asked for, already resolved by lib/lab-provider-core. */
export interface RequestedCall { provider: string; model: string }

/**
 * THE TWO PROVIDER VOCABULARIES, reconciled in one place.
 *
 * The lab/F11 layer says `vertex:`; the transport records `provider: 'gemini'` on the same call
 * (lib/trace.ts). They are one provider under two names, and a comparison that missed this would
 * fail every legitimate Vertex run — turning a guard against misattribution into a guard against
 * working. `ollama`, `openrouter` and `bedrock` are spelled identically on both sides.
 */
export function normaliseProvider(p: string | null | undefined): string {
  const s = String(p ?? '').trim().toLowerCase();
  if (s === 'vertex') return 'gemini';
  return s;
}

/**
 * THE LEGS AN OVERRIDE ACTUALLY STEERS, per route — i.e. the legs that carry `...LAB` at their call
 * site, and therefore the only legs whose model the stored row is entitled to claim.
 *
 * ⚠️ DELIBERATELY NOT "EVERY LEG". A run also spends utility calls — query expansion, the reranker
 * judge (llama3.1:8b), clinical-state normalisation — which legitimately stay local under any
 * override. Failing a run because its reranker judge was not Bedrock would make the guard fire on
 * every correct run, and a guard that cries wolf gets switched off.
 *
 * If a new overridable leg is added to either route, add it here — lib/__tests__/lab-attribution.test.ts
 * greps the routes for `tracedChat` call sites that receive `...LAB` and fails if this list has
 * fallen behind. It already earned its keep: `ddx_normalise` below was missing from the first
 * draft of this list, and the scan found it.
 *
 * ⚠️ A KNOWN GAP THIS LIST DELIBERATELY DOES NOT COVER (pre-existing, flagged 7 Aug 2026). Two DDx
 * legs — `parseInvestigations` and `generateHypotheses` — are written `{ gemini: G, ...LAB }` at the
 * call site, but their own opts types declare only `gemini`, so the spread's `openrouter`/`bedrock`
 * keys are dropped on the way in and those legs run LOCAL under any non-Vertex override. Judging
 * them would fail every otherwise-correct run. They are excluded here and the hole is reported
 * rather than papered over; closing it means widening those two signatures, which is its own change.
 */
export const ANSWER_LEGS: Readonly<Record<string, readonly string[]>> = Object.freeze({
  ask: Object.freeze(['draft', 'answer', 'revision', 'critique']),
  // clinical_state_normalise IS override-steered (it takes `...LAB` straight into tracedChat), so a
  // run that claims a model must have run it on that model too.
  ddx: Object.freeze(['ddx_draft', 'ddx_revision', 'ddx_critique', 'clinical_state_normalise']),
});

export type AttributionVerdict =
  /** Store it. `provider`/`model` are what SERVED and are what the row must carry. */
  | { ok: true; verified: boolean; provider: string; model: string; reason?: string }
  /** Refuse. The run is recorded as an error; the row must never assert the requested model. */
  | { ok: false; reason: 'mismatch' | 'unprovable'; message: string; served: ServedCall[] };

/**
 * Compare what was asked for against what the trace says ran.
 *
 * `agree` is INJECTED rather than reimplemented: `modelsAgree` (lib/llm.ts) already knows that
 * `google/gemini-2.5-pro` ≡ `gemini-2.5-pro`, and a second copy of that rule here would be one more
 * thing to drift. The seam also keeps this module free of the OpenAI SDK, so it strip-types cleanly.
 *
 * THE THREE OUTCOMES:
 *
 * 1 · NOTHING RECORDED. A free (`ollama`) run stores as today, marked `verified: false` — the claim
 *     it makes is the local mini, which is also what every fallback path lands on, so an unprovable
 *     ollama claim cannot be a misattribution in the direction that matters. A PAID claim with no
 *     evidence is REFUSED: "I cannot show that Bedrock served this" must not be stored as "Bedrock
 *     served this". The asymmetry is the point — it is about which claim is dangerous, not about
 *     which provider is nicer.
 *
 * 2 · A LEG RAN A DIFFERENT MODEL. Refused. This is the 7 Aug failure exactly.
 *
 * 3 · THE MODELS AGREE. Stored with the SERVED provider and model, not the requested ones. Note the
 *     consequence, which is deliberate: a `vertex:` request that the V-a2 ladder served from the
 *     OpenRouter tier is NOT an error (same model, legitimate tier hop) but IS stored as
 *     `openrouter`, because that is who answered.
 */
export function checkAttribution(
  requested: RequestedCall,
  served: ServedCall[],
  agree: (a: string | null | undefined, b: string | null | undefined) => boolean,
): AttributionVerdict {
  const calls = (served ?? []).filter((c) => c && (c.model || c.provider));
  const wantProvider = normaliseProvider(requested.provider);

  if (!calls.length) {
    if (wantProvider === 'ollama') {
      return { ok: true, verified: false, provider: requested.provider, model: requested.model,
        reason: 'no llm_response events recorded for the answer legs — stored unverified, which is safe only because the claim is the local mini' };
    }
    return { ok: false, reason: 'unprovable', served: calls,
      message: `attribution UNPROVABLE: the run claims ${requested.provider}:${requested.model} but the trace recorded no answer-leg model call. A paid claim with no evidence is refused, never stored.` };
  }

  const wrong = calls.filter((c) => !agree(c.model, requested.model));
  if (wrong.length) {
    const detail = wrong.map((c) => `${c.stage ?? '?'}=${c.provider ?? '?'}:${c.model ?? '?'}`).join(', ');
    return { ok: false, reason: 'mismatch', served: calls,
      message: `attribution MISMATCH (F11/DEC-2): the run requested ${requested.provider}:${requested.model} but ${wrong.length} of ${calls.length} answer leg(s) ran something else — ${detail}. The run is recorded as an error and the row carries what SERVED. Nothing falls back, and nothing is stored under a model that did not answer.` };
  }

  // Everything agreed. The last leg is the one that produced the stored answer.
  const last = calls[calls.length - 1];
  return {
    ok: true,
    verified: true,
    provider: normaliseProvider(last.provider) || requested.provider,
    model: last.model || requested.model,
  };
}

/** The correction envelope merged into a refused row's `output`. Names both sides, so the row is
 *  self-explaining forever — a reader never has to find this file to know what happened. */
export function attributionErrorOutput(
  base: Record<string, unknown>,
  requested: RequestedCall,
  v: Extract<AttributionVerdict, { ok: false }>,
): Record<string, unknown> {
  return {
    ...base,
    status: 'error',
    error: v.message,
    attribution: {
      verdict: v.reason,
      requested_provider: requested.provider,
      requested_model: requested.model,
      served: v.served,
      checked_at: 'run-time',
    },
  };
}

/**
 * v1.6 P3 (R-10 hardened): Cross-encoder reranker bridge.
 *
 * Reorders a candidate pool by query-document relevance using a stronger scoring model than
 * bi-encoder similarity. Two backends, picked by RERANK_BACKEND env (default 'judge'):
 *   'judge'  : LLM-as-judge (llama3.1:8b), a strict 0-10 rubric, batched, via the GOVERNED layer.
 *              Works out of the box; the production default.
 *   'cohere' : OpenRouter Cohere rerank-v3.5 — a real deterministic cross-encoder. Reachable only via
 *              an explicit rerankBackend:'cohere' call (lab) or a future env flip. relevance_score is
 *              already [0,1] (NOT sigmoided). An explicit request is STRICT: the backend is health-
 *              probed for DISCRIMINATION first, and any failure throws a typed error — never a silent
 *              fallback (the dead ollama cross-encoder ruler's silent-no-op is exactly what this replaces).
 *
 * Soft-fail: a GENERIC error on the default path returns input order unchanged (never blocks
 * retrieval). A TYPED RerankBackendError always propagates — thrown, never swallowed.
 */
import { geminiUtilityModel, geminiConfigured, openrouterConfigured, openrouterGeminiSlug } from './llm';
import { governedChat, recordRerankCost } from './trace';
import {
  evidenceFromCompletion, evidenceFromError,
  type TelemetryCapture, type CapturedBatch, type TransportEvidence, type RerankSeedStatus,
} from './retrieval-capture';
import type { BatchOutcome } from './retrieval-telemetry-core';

/**
 * ⚠️ NORMALIZED READ — LOAD-BEARING (rerank-flip-prep, 31 Jul 2026). This was a bare
 * `as 'judge' | 'cohere'` cast. Vercel held `RERANK_BACKEND=Cohere` (capital C, set 24 Jul,
 * Production+Preview); `'Cohere' === 'cohere'` is false, so from 24–31 Jul every production rerank
 * silently fell through to the LLM judge — under GEMINI_ALL=1 + the OpenRouter bridge, an unseeded
 * Gemini utility model, five calls per audit — while the operator believed the deterministic
 * cross-encoder was running. The strict health probe sat INSIDE the branch that never executed; a
 * guard behind the condition it guards cannot fire.
 *
 * Match is TRIM-ONLY, EXACT and CASE-SENSITIVE, by design (PRD Addendum A ruling): `Cohere`,
 * `COHERE` and any typo all resolve to 'judge' AND WARN on every cold start, naming the bad value.
 * Case-folding was considered and rejected — it would have made the stored `Cohere` resolve to
 * 'cohere' and flipped production on deploy, bypassing the engine bump, the scoring changelog entry
 * and the golden A/B. A config value that decides which model reads clinical evidence fails loudly;
 * it is never guessed at helpfully. Only the exact lowercase 'cohere' selects the cross-encoder,
 * and V sets that value after the A/B — never this module.
 */
/** PURE resolver for the env read — exported so the matrix is unit-testable (the module-level
 *  const below is this function applied once to process.env; ESM caching makes a module-level
 *  read untestable in-process, the same pattern as opdRetrieveOpts' injectable env). */
export function resolveEnvRerankBackend(raw: string | undefined): { backend: 'judge' | 'cohere'; warning: string | null } {
  const trimmed = (raw || 'judge').trim();
  const backend: 'judge' | 'cohere' = trimmed === 'cohere' ? 'cohere' : 'judge';
  const warning = trimmed !== 'judge' && trimmed !== 'cohere'
    ? `[rerank] unrecognised RERANK_BACKEND=${JSON.stringify(raw)} ` +
      `— using 'judge'. Valid values are exactly 'judge' or 'cohere', lowercase.`
    : null;
  return { backend, warning };
}
const ENV_READ = resolveEnvRerankBackend(process.env.RERANK_BACKEND);
const BACKEND: 'judge' | 'cohere' = ENV_READ.backend;
if (ENV_READ.warning) console.warn(ENV_READ.warning);
const JUDGE_MODEL = process.env.RERANK_JUDGE_MODEL || 'llama3.1:8b';
const JUDGE_BATCH = 5;  // 5 candidates per LLM call
/** The judge's decode temperature, named so the manifest and the call cannot drift apart. */
const JUDGE_TEMPERATURE = 0.0;
/**
 * The judge sets NO seed today, so this is `unseeded` whichever tier serves. The provider argument
 * is taken now because the moment a seed is added to the options bag the answer stops being uniform:
 * local applies it, every cloud tier strips the bag that carries it.
 */
function judgeSeedStatus(_provider: IntendedProvider): RerankSeedStatus {
  return 'unseeded';
}
const MAX_SNIPPET_CHARS = 600;

// Cohere rerank-api backend (OpenRouter). No new npm dep — raw fetch (D3: not a governed-chat site).
const RERANK_API_MODEL = process.env.RERANK_API_MODEL || 'cohere/rerank-v3.5';
const RERANK_API_URL = process.env.RERANK_API_URL || 'https://openrouter.ai/api/v1/rerank';

// ══ INTENDED ATTRIBUTION — THE RESOLVED FIRST DISPATCH TARGET (addendum v7 §5) ═══════════════════
//
// ⚠️ THREE OF THE FOUR SITES WROTE AN IMPOSSIBLE PAIR. `intendedProvider: 'vertex'` was hardcoded
// beside `intendedModel: JUDGE_MODEL`, and JUDGE_MODEL is the LOCAL model (`llama3.1:8b`). Vertex
// never serves it. C0 query 4 asks for actual provider and model, and any query comparing intended
// against served on the judge path read as a permanent mismatch — reported as finding 10a in Part X
// and now corrected at source.
//
// ⚠️ RESOLVED DYNAMICALLY, NOT HARDCODED. Replacing JUDGE_MODEL with a fixed Gemini model would
// trade one wrong constant for another: the judge's first target depends on GEMINI_ALL,
// GEMINI_UTILITY, GEMINI_VIA_OPENROUTER, LLM_PIPELINE and provider configuration, every one of them
// read at DISPATCH time. `GEMINI_VIA_OPENROUTER` reads '0' in Production and Preview today, so the
// judge targets Vertex first — but that is an observation, not an invariant, and is not encoded.
//
// ⚠️ ONE RESOLVER, FOUR CALL SITES. Duplicated logic is how three of the four drifted in the first
// place. This mirrors `chatWithFallback`'s own resolution (`lib/llm.ts`): `orModel` from
// `openrouterGeminiSlug(geminiModel)`, `useOpenRouter`, `useGemini`, the `!useOpenRouter &&
// !useGemini` local branch, and `cloudLadder({ orFirst: useOpenRouter, … })[0]`. If that ladder
// changes, this must change with it, and `intended-attribution.test.ts` pins the correspondence.

/** The provider tiers an intended pairing may name. */
export type IntendedProvider = 'vertex' | 'openrouter' | 'ollama';
export interface IntendedTarget { provider: IntendedProvider; model: string }

/**
 * The first tier `chatWithFallback` would dispatch the JUDGE to, right now.
 *
 * Not "where it ended up" — that is `served_*`, which comes from transport evidence. This is the
 * target the call is aimed at before anything is attempted.
 */
export function resolveJudgeIntendedTarget(): IntendedTarget {
  const geminiModel = geminiUtilityModel();                 // GEMINI_ALL / GEMINI_UTILITY / mini / configured
  const orModel = openrouterGeminiSlug(geminiModel);        // GEMINI_VIA_OPENROUTER === '1' only
  const useOpenRouter = Boolean(orModel) && openrouterConfigured();
  const useGemini = Boolean(geminiModel) && geminiConfigured();
  // `cloudLadder` puts OpenRouter first when the bridge flag produced a slug; otherwise Vertex.
  if (useOpenRouter) return { provider: 'openrouter', model: orModel as string };
  if (useGemini) return { provider: 'vertex', model: geminiModel as string };
  // Neither cloud tier is available: chatWithFallback runs `params.model` on the local client, and
  // for the judge that is JUDGE_MODEL. This is the one sanctioned use of JUDGE_MODEL as an INTENDED
  // model, and it is a real dispatch target rather than a placeholder.
  return { provider: 'ollama', model: JUDGE_MODEL };
}

/** Cohere is a raw fetch to OpenRouter's rerank endpoint; there is no ladder and no fallback. */
export function resolveCohereIntendedTarget(): IntendedTarget {
  return { provider: 'openrouter', model: RERANK_API_MODEL };
}

/**
 * THE GUARD (addendum v7 §5, mirroring `lib/retrieval-capture.ts:245`).
 *
 * The served side already refuses to report a requested model as a served model. The intended side
 * had no such guard, which is how `vertex` + `llama3.1:8b` reached the manifest and stayed there.
 * These are the only four sanctioned pairings:
 *
 *     vertex      + the effective Gemini model
 *     openrouter  + the Gemini slug
 *     ollama      + JUDGE_MODEL
 *     openrouter  + the effective Cohere model
 *
 * ⚠️ A PREDICATE, NOT A THROW. Constraint 2: a telemetry path that errors must degrade to a no-op,
 * never to a 500. So this reports rather than raises, `buildRetrievalPayload` turns a false into a
 * manifest defect, and `intended-attribution.test.ts` is where an impossible pairing fails loudly
 * instead of serializing.
 */
export function isSanctionedIntendedPairing(provider: string, model: string): boolean {
  if (!provider || !model) return false;
  if (provider === 'ollama') return model === JUDGE_MODEL;
  if (provider === 'openrouter') {
    if (model === RERANK_API_MODEL) return true;                 // Cohere
    return Boolean(openrouterSlugForGeminiShape(model));         // the Gemini slug
  }
  if (provider === 'vertex') {
    // A Vertex target is a Gemini model, never the local judge model.
    return model !== JUDGE_MODEL && /gemini/i.test(model);
  }
  return false;
}

/** A publisher-prefixed Gemini slug, which is the only OpenRouter-Gemini shape the bridge emits. */
function openrouterSlugForGeminiShape(model: string): boolean {
  return /gemini/i.test(model);
}

// Discrimination thresholds on the backend's normalized [0,1] score (D7; env-tunable).
export const RERANK_HEALTH_MIN_REL = Number(process.env.RERANK_HEALTH_MIN_REL) || 0.40;
export const RERANK_HEALTH_MIN_MARGIN = Number(process.env.RERANK_HEALTH_MIN_MARGIN) || 0.15;
const RERANK_HEALTH_TTL_MS = 10 * 60 * 1000;   // D6: first-use, memoized per (backend,model), 10-min TTL

// Canonical probe fixtures (D4/§2.2).
export const PROBE_QUERY = 'lumbar imaging for acute low back pain';
export const PROBE_RELEVANT = 'Routine lumbar imaging is not recommended for acute nonspecific low back pain without red flags.';
export const PROBE_IRRELEVANT = 'Montelukast is a leukotriene receptor antagonist used for asthma and allergic rhinitis.';

export type RerankCandidate = {
  id: number | string;
  text: string;
  /** Optional pass-through fields preserved on the output */
  [key: string]: unknown;
};

export type RerankResult<T extends RerankCandidate> = T & {
  rerank_score: number;        // higher = more relevant
  rerank_backend: 'judge' | 'cohere' | 'none';
};

/* ─────────────────────────────  error taxonomy (§2.1)  ───────────────────────────── */
/** Base for the three typed rerank-backend failures. Caught as a family by callers (mcp-tools);
 *  always thrown, never swallowed, never a silent fallback (preserves the D3 discipline). */
export class RerankBackendError extends Error {}
/** Network error / no base URL / no API key. */
export class RerankBackendUnreachable extends RerankBackendError {
  constructor(backend: string, model: string, why: string) { super(`rerank backend '${backend}' unreachable (${model}): ${why}`); this.name = 'RerankBackendUnreachable'; }
}
/** Endpoint or model absent (e.g. 404). */
export class RerankBackendMissing extends RerankBackendError {
  constructor(backend: string, model: string, why: string) { super(`rerank backend '${backend}' missing (${model}): ${why}`); this.name = 'RerankBackendMissing'; }
}
/** Reachable but fails the discrimination probe (returns a number but does not rank). */
export class RerankBackendUnhealthy extends RerankBackendError {
  constructor(backend: string, model: string, why: string) { super(`rerank backend '${backend}' failed the discrimination probe (${model}): ${why}`); this.name = 'RerankBackendUnhealthy'; }
}

/** Resolve the effective backend for a call: an explicit per-call override wins, else the env default.
 *  Pure — this IS the routing decision. */
export function resolveRerankBackend(backend: 'judge' | 'cohere' | undefined, envBackend: 'judge' | 'cohere' = BACKEND): 'judge' | 'cohere' {
  return backend ?? envBackend;
}

/* ─────────────────────────────  Cohere rerank-api backend (§3.1)  ───────────────────────────── */

/** One OpenRouter Cohere /rerank call → relevance scores index-aligned to `documents` + the call's
 *  `usage.cost` (USD, null if absent). Throws the typed errors on unreachable/missing (never soft-fails
 *  to 0). Shared by rerankCohere + the probe. Request shape is UNCHANGED (D3).
 *  Request:  { model, query, documents: [<text…>] }
 *  Response: { results: [{ index, relevance_score∈[0,1] }], usage: { cost } } — mapped back by index. */
async function cohereRelevanceScores(query: string, documents: string[], fetchImpl: typeof fetch = fetch): Promise<{ scores: number[]; usageCost: number | null }> {
  const key = process.env.OPENROUTER_API_KEY;
  if (!key) throw new RerankBackendUnreachable('cohere', RERANK_API_MODEL, 'OPENROUTER_API_KEY not set');
  let res: Response;
  try {
    res = await fetchImpl(RERANK_API_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
      body: JSON.stringify({ model: RERANK_API_MODEL, query, documents: documents.map((d) => String(d ?? '').slice(0, MAX_SNIPPET_CHARS)) }),
      signal: AbortSignal.timeout(10000),
    });
  } catch (e) {
    throw new RerankBackendUnreachable('cohere', RERANK_API_MODEL, String((e as Error).message).slice(0, 140));
  }
  if (res.status === 404) throw new RerankBackendMissing('cohere', RERANK_API_MODEL, 'endpoint or model 404');
  if (!res.ok) throw new RerankBackendUnreachable('cohere', RERANK_API_MODEL, `HTTP ${res.status}`);
  let j: { results?: { index: number; relevance_score: number }[]; usage?: { cost?: number } };
  try { j = await res.json() as typeof j; }
  catch (e) { throw new RerankBackendUnreachable('cohere', RERANK_API_MODEL, `bad JSON: ${String((e as Error).message).slice(0, 80)}`); }
  const scores = new Array(documents.length).fill(Number.NaN);
  for (const r of j.results ?? []) {
    if (typeof r?.index === 'number' && r.index >= 0 && r.index < documents.length) scores[r.index] = r.relevance_score;
  }
  const usageCost = typeof j.usage?.cost === 'number' && Number.isFinite(j.usage.cost) ? j.usage.cost : null;
  return { scores, usageCost };
}

/** `recordCost` (injectable for tests) routes the call's usage.cost to the cost sink (D3).
 *  `capture` is TRAILING and OPTIONAL (D4) — it comes after both existing injected dependencies,
 *  because position 3 is `fetchImpl` and a capture passed there would be called as `fetch`. */
export async function rerankCohere<T extends RerankCandidate>(
  query: string,
  candidates: T[],
  fetchImpl: typeof fetch = fetch,
  recordCost: (costUsd: number | null | undefined, model?: string) => Promise<void> = recordRerankCost,
  capture?: TelemetryCapture,
): Promise<RerankResult<T>[]> {
  const { scores, usageCost } = await cohereRelevanceScores(query, candidates.map((c) => c.text || ''), fetchImpl);
  if (capture) {
    // ONE request, ONE batch, count 1 (D16). Cohere is a raw fetch and never reaches
    // chatWithFallback, so there is no transport attribution to read: a returned score array IS
    // the evidence that it served, and the class is recorded from that rather than guessed.
    capture.servedBackend = 'cohere';
    capture.expectedBatchCount = 1;
    // Cohere is a deterministic cross-encoder: it takes neither a temperature nor a seed, and the
    // request body carries neither. Null and `not_applicable` are the accurate values, not zeros.
    capture.rerankTemperature = null;
    capture.rerankSeedStatus = 'not_applicable';
    const finite = scores.filter((s) => Number.isFinite(s)).length;
    capture.batches.push({
      index: 0, start: 0, end: candidates.length,
      evidence: { servedProvider: 'openrouter', servedModel: RERANK_API_MODEL, attempts: null, provenNotServed: false },
      outcome: finite === candidates.length ? 'success' : 'nonnumeric_score',
      expectedScoreKeys: candidates.length,
      finiteScoreKeys: finite,
      missingScoreKeys: 0,
      nonnumericScoreKeys: candidates.length - finite,
      intendedProvider: 'openrouter', intendedModel: RERANK_API_MODEL,
      // The rerank API reports spend as usage.cost, not tokens. Missing token data stays NULL —
      // §4.6 forbids turning it into zero.
      promptTokens: null, completionTokens: null,
    });
  }
  const paired = candidates.map((c, i) => ({
    ...c,
    rerank_score: Number.isFinite(scores[i]) ? scores[i] : 0,   // relevance_score used directly — NO sigmoid
    rerank_backend: 'cohere' as const,
  }));
  paired.sort((a, b) => b.rerank_score - a.rerank_score);
  // D3: meter this rerank's spend into the same sink the governed layer uses (best-effort, never blocks).
  await recordCost(usageCost, RERANK_API_MODEL);
  return paired;
}

/* ─────────────────────────────  functional health probe (§2.2)  ───────────────────────────── */

const healthCache = new Map<string, number>();   // key `${backend}:${model}` → last-pass epoch ms
/** Test-only: clear the memoized health results. */
export function _resetRerankHealth(): void { healthCache.clear(); }

/**
 * Assert the backend DISCRIMINATES (not just that a number came back): score the canonical
 * (relevant, irrelevant) pair via the backend's own path and require rel ≥ MIN_REL AND
 * rel − irr ≥ MIN_MARGIN (D7). Memoized per (backend, model) for 10 min; a thrown result is not
 * cached, so it re-probes next time. Injectable fetchImpl + clock for tests.
 */
export async function assertRerankBackendHealthy(
  backend: 'cohere',
  opts: { fetchImpl?: typeof fetch; now?: () => number } = {},
): Promise<void> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const now = opts.now ?? Date.now;
  const model = RERANK_API_MODEL;
  const cacheKey = `${backend}:${model}`;
  const last = healthCache.get(cacheKey);
  if (last != null && now() - last < RERANK_HEALTH_TTL_MS) return;   // memoized within TTL

  const { scores: [rel, irr] } = await cohereRelevanceScores(PROBE_QUERY, [PROBE_RELEVANT, PROBE_IRRELEVANT], fetchImpl);
  if (!Number.isFinite(rel) || !Number.isFinite(irr)) throw new RerankBackendUnhealthy(backend, model, `non-finite probe scores (rel=${rel}, irr=${irr})`);
  if (!(rel >= RERANK_HEALTH_MIN_REL)) throw new RerankBackendUnhealthy(backend, model, `rel ${rel} < min ${RERANK_HEALTH_MIN_REL}`);
  if (!(rel - irr >= RERANK_HEALTH_MIN_MARGIN)) throw new RerankBackendUnhealthy(backend, model, `margin ${(rel - irr).toFixed(3)} < min ${RERANK_HEALTH_MIN_MARGIN}`);
  healthCache.set(cacheKey, now());
}

/* ─────────────────────────────  dispatch (§3.2)  ───────────────────────────── */

/** Injectable collaborators — for tests ONLY. Production/real callers pass nothing. */
export type RerankDeps = {
  checkHealthy?: (backend: 'cohere', opts?: { fetchImpl?: typeof fetch; now?: () => number }) => Promise<void>;
  cohereFn?: <U extends RerankCandidate>(q: string, c: U[], capture?: TelemetryCapture) => Promise<RerankResult<U>[]>;
  judgeFn?: <U extends RerankCandidate>(q: string, c: U[], capture?: TelemetryCapture) => Promise<RerankResult<U>[]>;
  /** TEST-ONLY: simulate the RERANK_BACKEND env default (the module const `BACKEND`) so the resilient
   *  env-default-cohere path can be exercised without a real env flip. Production passes nothing. */
  envBackend?: 'judge' | 'cohere';
};

/**
 * Rerank candidates against the query. Returns a NEW array sorted by rerank_score descending.
 * Input array is not mutated.
 *
 * Two dispatch modes (R-10 D2):
 *  - EXPLICIT `backend` (a per-call override, e.g. lab `rerankBackend:'cohere'`) → STRICT. Explicit
 *    'cohere' is health-probed first and any typed RerankBackendError PROPAGATES (never falls back) —
 *    measurement honesty. Only GENERIC (non-typed) errors soft-fall to input order.
 *  - ENV-DEFAULT (no `backend` arg) 'cohere' → RESILIENT chain `cohere → judge → input-order`: the
 *    memoized probe + call run, and on ANY typed RerankBackendError it downgrades to judge, then to
 *    input order if judge throws — never erupting a retrieval error on a Cohere blip. Each downgrade
 *    is logged. Env-default 'judge' is unchanged (the current production path — byte-identical).
 */
export async function rerank<T extends RerankCandidate>(
  query: string,
  candidates: T[],
  backend?: 'judge' | 'cohere',
  deps: RerankDeps = {},
  capture?: TelemetryCapture,
): Promise<RerankResult<T>[]> {
  if (candidates.length === 0) return [];
  // Single candidate — no reorder needed.
  // ⚠️ The capture is deliberately NOT stamped on either guard above (D17's edge cases): reranking
  // did not happen, so intended backend and model stay 'none', expected and recorded stay 0, and
  // `batches` stays empty. Stamping a backend here would claim a decision that was never made.
  if (candidates.length === 1) {
    return [{ ...candidates[0], rerank_score: 1.0, rerank_backend: 'none' }];
  }

  const explicit = backend !== undefined;   // an explicit per-call override was passed
  const chosen = resolveRerankBackend(backend, deps.envBackend ?? BACKEND);
  const cohereFn = deps.cohereFn ?? (<U extends RerankCandidate>(
    q: string, c: U[], cap?: TelemetryCapture,
  ) => rerankCohere(q, c, undefined, undefined, cap));
  const judgeFn = deps.judgeFn ?? rerankJudge;
  const checkHealthy = deps.checkHealthy ?? assertRerankBackendHealthy;

  if (capture) {
    // INTENDED, not served. What actually runs is stamped by whichever backend runs (A10).
    //
    // ⚠️ `intendedBackend` is the BACKEND CHOICE ('judge' | 'cohere') and is unchanged. `intendedModel`
    // was JUDGE_MODEL on the judge arm, which names the LOCAL model whatever the judge is actually
    // dispatched to (addendum v7 §5). It now resolves the real first target.
    capture.intendedBackend = chosen;
    capture.intendedModel = (chosen === 'cohere'
      ? resolveCohereIntendedTarget()
      : resolveJudgeIntendedTarget()).model;
  }

  /**
   * Synthesise one terminal-failure record per PLANNED boundary (D16). `rerank_soft_failed`
   * describes degraded RANKING; it never waives §7's batch reconciliation, so expected must still
   * equal recorded and a soft failure has to account for the requests it planned to make.
   */
  const recordSoftFailure = (plannedBackend: 'judge' | 'cohere') => {
    if (!capture) return;
    capture.rerankSoftFailed = true;
    const boundaries = plannedBackend === 'cohere'
      ? [{ start: 0, end: candidates.length }]
      : judgeBatchBoundaries(candidates.length);
    capture.servedBackend = plannedBackend;
    capture.expectedBatchCount = boundaries.length;
    const plannedTarget = plannedBackend === 'cohere'
      ? resolveCohereIntendedTarget()
      : resolveJudgeIntendedTarget();
    // ⚠️ RESOLVED: THE PROOF RULE GOVERNS (addendum v7 §6, 14 Aug 2026). D16 contained two
    // statements that could not both hold here. Its MAPPING TABLE assigned `not_served` to a Cohere
    // soft failure; its PROOF RULE says `not_served` requires failure attribution as proof, and that
    // without proof the answer is `unattributed`. V ruled that the proof rule governs, and D16's
    // mapping table is amended to that extent and only that extent.
    //
    // Why Cohere can never carry the proof: it is a raw fetch and never reaches `chatWithFallback`,
    // so no transport attribution is ever attached. Every DECLARED Cohere failure throws a typed
    // `RerankBackendError`, which propagates or downgrades rather than reaching this branch — the
    // only path that arrives here is a GENERIC throw, where non-delivery is NOT proven.
    // `provenNotServed: true` was therefore asserting a proof that does not exist.
    //
    // ⚠️ WHERE TRANSPORT PROOF EXISTS, `not_served` STANDS and is unchanged. This branch synthesises
    // records for requests that were PLANNED, so it never has proof of anything.
    //
    // ⚠️ AND THE SAME RULE GOVERNS THE JUDGE ARM (addendum v8 §2, 14 Aug 2026). Pass 0 corrected
    // Cohere and correctly declined to correct the judge by extension, because v7 §6 ruled on Cohere
    // only. V then ruled that the rule is the rule on both arms: a generic judge failure without
    // transport proof records `provenNotServed: false`, and its class is `unattributed`.
    //
    // ⚠️ WHY IT WAS FIXED FIRST RATHER THAN DEFERRED. This branch is reached only when an injected
    // `judgeFn` throws — `rerankJudge` catches its own failures per batch — so it is effectively
    // test-only today. That is exactly the argument FOR correcting it now: a test-only path that
    // fabricates a proof poisons every proof written against it, and the twenty hard proofs are next.
    //
    // ONE record for both arms now. Neither synthesised boundary has transport evidence, because
    // both describe requests that were PLANNED and never delivered.
    const unprovenNoDelivery: TransportEvidence = {
      servedProvider: null, servedModel: null, attempts: null, provenNotServed: false,
    };
    const notServed: TransportEvidence = unprovenNoDelivery;
    capture.batches = boundaries.map((b, i): CapturedBatch => ({
      index: i, start: b.start, end: b.end,
      evidence: notServed,
      outcome: 'terminal_failure' as BatchOutcome,
      expectedScoreKeys: b.end - b.start,
      finiteScoreKeys: 0, missingScoreKeys: b.end - b.start, nonnumericScoreKeys: 0,
      // ⚠️ RESOLVED TOGETHER, NEVER AS A FIXED PAIR (addendum v7 §5). This was
      // `'vertex'` beside `JUDGE_MODEL` — an impossible pairing, because Vertex never serves the
      // local judge model. Provider and model now come from one resolution so they cannot disagree.
      intendedProvider: plannedTarget.provider,
      intendedModel: plannedTarget.model,
      promptTokens: null, completionTokens: null,
    }));
  };

  const inputOrder = (): RerankResult<T>[] => candidates.map((c, i) => ({
    ...c,
    rerank_score: 1 - i / candidates.length,   // preserve original order
    rerank_backend: 'none' as const,
  }));

  // D2 — ENV-DEFAULT cohere: resilient cohere → judge → input-order. Typed backend errors are CAUGHT
  // (never thrown); each downgrade is logged. Applies ONLY when the backend was not passed explicitly.
  if (chosen === 'cohere' && !explicit) {
    try {
      await checkHealthy('cohere');                       // memoized probe (D6); throws typed on unhealth
      return await cohereFn(query, candidates, capture);
    } catch (e) {
      if (e instanceof RerankBackendError) {
        console.warn('[rerank] env-default cohere unavailable → falling back to judge:', (e as Error).message);
        // ⚠️ THE CASE THAT WOULD HAVE FAILED THE GATE SILENTLY (A10/D16). Intended Cohere means one
        // expected batch; the judge then serves N. Under §7's never-waived reconciliation every row
        // on this path would be `persisted_partial` BY CONSTRUCTION. The expected count is
        // therefore derived from the backend that SERVES — the judge stamps it below — and the
        // downgrade is recorded as its own fact rather than hidden inside the counts.
        if (capture) capture.rerankBackendDowngraded = true;
        try {
          return await judgeFn(query, candidates, capture);
        } catch (e2) {
          // Unreachable in production: rerankJudge's only failure point is inside a per-batch
          // try/catch, and the post-loop map and sort cannot throw. Kept, and instrumented, because
          // an injected judgeFn in a test can throw and the record must still reconcile.
          console.warn('[rerank] judge fallback failed → input order:', (e2 as Error).message);
          recordSoftFailure('judge');
          return inputOrder();
        }
      }
      console.warn('[rerank] backend failed, returning input order', (e as Error).message);   // generic soft-fall
      recordSoftFailure('cohere');
      return inputOrder();
    }
  }

  // Explicit request (STRICT for 'cohere') + env-default/explicit 'judge' — unchanged strictness.
  try {
    if (chosen === 'cohere') {
      await checkHealthy('cohere');                       // explicit cohere is STRICT — probe first
      return await cohereFn(query, candidates, capture);
    }
    return await judgeFn(query, candidates, capture);
  } catch (e) {
    if (e instanceof RerankBackendError) throw e;   // explicit cohere typed error → propagate (never fall back)
    console.warn('[rerank] backend failed, returning input order', (e as Error).message);
    recordSoftFailure(chosen);
    return inputOrder();
  }
}

/* ─────────────────────────────  LLM-judge backend  ───────────────────────────── */

const JUDGE_SYSTEM = `You are a clinical relevance judge. Given a clinician's question and a list of textbook passages, score each passage 0-10 for how directly it answers the question.

Scoring rubric:
  9-10 : passage directly answers the core of the question with specific clinical facts
  7-8  : passage covers the right topic and contains relevant content but doesn't fully answer
  4-6  : passage is on the same general subject but is tangential
  1-3  : passage barely related (shared keyword only)
  0    : passage is irrelevant or noise

Return ONLY a JSON object with integer scores keyed by candidate INDEX (0-based, as I provide them):
{"0": 8, "1": 3, "2": 10, "3": 6, "4": 2}

No prose, no explanation, no markdown fences.`;

/**
 * The batch boundaries a judge run will use. Extracted so the soft-failure synthesis above can
 * account for the requests it PLANNED without reaching for JUDGE_BATCH at a second site, and so
 * the constant itself stays module-private (D16 forbids exporting it).
 */
/**
 * A batch that produced no scores: `timeout` when the TERMINAL attempt says so, `terminal_failure`
 * when the attempts were exhausted for any other reason (D15's precedence).
 *
 * Timeout is a distinct outcome, not a synonym: a batch that timed out and a batch that was refused
 * look identical in the scores array and want opposite remediation — one is a capacity question,
 * the other is not, and merging them is how a throttling problem hides as a reliability problem.
 */
function terminalOutcomeFor(evidence: TransportEvidence | null): BatchOutcome {
  const attempts = evidence?.attempts;
  if (attempts && attempts.length > 0 && attempts[attempts.length - 1].outcome === 'timeout') return 'timeout';
  return 'terminal_failure';
}

function judgeBatchBoundaries(n: number): Array<{ start: number; end: number }> {
  const out: Array<{ start: number; end: number }> = [];
  for (let i = 0; i < n; i += JUDGE_BATCH) out.push({ start: i, end: Math.min(i + JUDGE_BATCH, n) });
  return out;
}

/**
 * ⚠️ NOW EXPORTED (D4). It was module-private, which made the judge path — the production path —
 * the one leg of reranking with no direct test seam. The export adds no caller and changes no
 * behaviour; `RerankDeps.judgeFn` already widened to match its signature.
 */
export async function rerankJudge<T extends RerankCandidate>(
  query: string,
  candidates: T[],
  capture?: TelemetryCapture,
): Promise<RerankResult<T>[]> {
  const scores: number[] = new Array(candidates.length).fill(0);

  // Run JUDGE_BATCH-sized batches in PARALLEL so wall-clock stays bounded
  const batches = judgeBatchBoundaries(candidates.length);
  // Resolved ONCE per rerankJudge call, not per batch: the batches run in one Promise.all against
  // one dispatch configuration, so resolving inside the loop would re-read the environment N times
  // to get the same answer.
  const judgeTarget = resolveJudgeIntendedTarget();

  if (capture) {
    // ⚠️ WHAT ACTUALLY APPLIED, NOT WHAT WAS REQUESTED (addendum v7 §10). The judge's call below
    // sets `temperature: 0.0` and NO SEED — its options bag carries only `num_ctx`. So the honest
    // status is `unseeded` on every path, cloud or local, and it stays that way until someone adds
    // a seed. If one is ever added inside the options bag, it will reach a LOCAL model and be
    // stripped before a cloud one, which is why the status distinguishes those two outcomes rather
    // than recording the requested value.
    capture.rerankTemperature = JUDGE_TEMPERATURE;
    capture.rerankSeedStatus = judgeSeedStatus(judgeTarget.provider);
  }

  if (capture) {
    // Expected is derived from the backend that IS SERVING — this one (A10). On the Cohere
    // fall-through this overwrites the intended count of 1 with the judge's real N, which is the
    // whole point: otherwise every downgraded row is partial by construction.
    capture.servedBackend = 'judge';
    capture.expectedBatchCount = batches.length;
  }

  await Promise.all(batches.map(async ({ start, end }, batchIndex) => {
    const slice = candidates.slice(start, end);
    const passagesText = slice.map((c, idx) => {
      const snip = (c.text || '').slice(0, MAX_SNIPPET_CHARS).replace(/\s+/g, ' ').trim();
      return `[${idx}] ${snip}`;
    }).join('\n\n');

    const userMsg = `QUESTION:\n${query}\n\nPASSAGES:\n${passagesText}\n\nReturn the JSON scoring object now.`;

    // ⚠️ IN-MEMORY ONLY (constraint 3). No telemetry input or output happens inside a batch; these
    // are locals, folded into the capture once the batch settles. The terminal manifest is built
    // after Promise.all resolves.
    let evidence: TransportEvidence | null = null;
    let parseFailed = false;
    let missing = 0;
    let nonnumeric = 0;
    let finite = 0;
    let promptTokens: number | null = null;
    let completionTokens: number | null = null;
    let outcome: BatchOutcome = 'success';

    try {
      // Governed envelope (Stage 4): traceless retrieval path behaves exactly as before.
      const r = await governedChat(undefined, 'rerank_judge', {
        model: JUDGE_MODEL,
        messages: [
          { role: 'system', content: JUDGE_SYSTEM },
          { role: 'user', content: userMsg },
        ],
        temperature: JUDGE_TEMPERATURE,   // the SAME constant the manifest records (v7 §10)
        max_tokens: 200,
        ...({ options: { num_ctx: 4096 }, keep_alive: '15m' } as Record<string, unknown>),
      }, { gemini: geminiUtilityModel(), promptRef: 'rerank/JUDGE_SYSTEM' });
      evidence = evidenceFromCompletion(r);
      const usage = (r as { usage?: { prompt_tokens?: number; completion_tokens?: number } }).usage;
      promptTokens = typeof usage?.prompt_tokens === 'number' ? usage.prompt_tokens : null;
      completionTokens = typeof usage?.completion_tokens === 'number' ? usage.completion_tokens : null;
      let txt = r.choices?.[0]?.message?.content?.trim() || '';
      if (txt.startsWith('```')) txt = txt.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '').trim();
      const a = txt.indexOf('{');
      const b = txt.lastIndexOf('}');
      if (a >= 0 && b > a) txt = txt.slice(a, b + 1);
      // INNER TRY around the parse ONLY (D15). Without it a malformed completion and a dead
      // transport land in the same catch and become the same outcome — but a parse failure means a
      // completion ARRIVED, cost tokens and kept its provider, and §4.6 prices it. The error is
      // re-thrown to the outer catch so the console line and the swallow below stay byte-identical.
      let parsed: Record<string, number>;
      try {
        parsed = JSON.parse(txt) as Record<string, number>;
      } catch (pe) {
        parseFailed = true;
        throw pe;
      }
      for (let k = 0; k < slice.length; k++) {
        const raw = parsed[String(k)];
        if (typeof raw === 'number' && !Number.isNaN(raw)) {
          scores[start + k] = Math.max(0, Math.min(10, raw)) / 10;
          finite += 1;
        } else if (raw === undefined) {
          // THE DEFECT THIS WORKSTREAM EXISTS TO MAKE VISIBLE. The score stays at its initialiser
          // zero, and a genuine 0 and a missing key are indistinguishable in the array. They are
          // not indistinguishable here.
          missing += 1;
        } else {
          nonnumeric += 1;
        }
      }
      // Precedence, highest first (D15). Independent counts are preserved alongside, so a response
      // with both defects records both facts and one outcome.
      outcome = missing > 0 ? 'missing_score_key' : nonnumeric > 0 ? 'nonnumeric_score' : 'success';
    } catch (e) {
      // Batch failed — leave those scores at 0 (will sort to bottom).
      // Soft fail is OK because we still have the input order as tiebreaker downstream.
      console.warn('[rerank judge] batch failed', start, '-', end, (e as Error).message);
      if (!evidence) evidence = evidenceFromError(e);
      missing = slice.length - finite;
      outcome = parseFailed ? 'parse_failure' : terminalOutcomeFor(evidence);
    }

    if (capture) {
      capture.batches.push({
        index: batchIndex, start, end, evidence, outcome,
        expectedScoreKeys: slice.length,
        finiteScoreKeys: finite, missingScoreKeys: missing, nonnumericScoreKeys: nonnumeric,
        // ⚠️ THE HOT PATH, RESOLVED ONCE PER CALL rather than per batch (addendum v7 §5). Same
        // impossible `'vertex'` + JUDGE_MODEL pair as the soft-failure branch, on every judge batch
        // of every reranked retrieval — which is why it dominated the defect in the stored rows.
        intendedProvider: judgeTarget.provider, intendedModel: judgeTarget.model,
        promptTokens, completionTokens,
      });
    }
  }));

  // Pair, sort, return
  const paired = candidates.map((c, i) => ({
    ...c,
    rerank_score: scores[i],
    rerank_backend: 'judge' as const,
  }));
  paired.sort((a, b) => b.rerank_score - a.rerank_score);
  return paired;
}

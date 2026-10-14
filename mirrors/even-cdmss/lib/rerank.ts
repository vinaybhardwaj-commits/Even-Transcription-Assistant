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
import { geminiUtilityModel } from './llm';
import { governedChat, recordRerankCost } from './trace';

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
const MAX_SNIPPET_CHARS = 600;

// Cohere rerank-api backend (OpenRouter). No new npm dep — raw fetch (D3: not a governed-chat site).
const RERANK_API_MODEL = process.env.RERANK_API_MODEL || 'cohere/rerank-v3.5';
const RERANK_API_URL = process.env.RERANK_API_URL || 'https://openrouter.ai/api/v1/rerank';

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

/** `recordCost` (injectable for tests) routes the call's usage.cost to the cost sink (D3). */
export async function rerankCohere<T extends RerankCandidate>(
  query: string,
  candidates: T[],
  fetchImpl: typeof fetch = fetch,
  recordCost: (costUsd: number | null | undefined, model?: string) => Promise<void> = recordRerankCost,
): Promise<RerankResult<T>[]> {
  const { scores, usageCost } = await cohereRelevanceScores(query, candidates.map((c) => c.text || ''), fetchImpl);
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
  cohereFn?: <U extends RerankCandidate>(q: string, c: U[]) => Promise<RerankResult<U>[]>;
  judgeFn?: <U extends RerankCandidate>(q: string, c: U[]) => Promise<RerankResult<U>[]>;
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
): Promise<RerankResult<T>[]> {
  if (candidates.length === 0) return [];
  // Single candidate — no reorder needed
  if (candidates.length === 1) {
    return [{ ...candidates[0], rerank_score: 1.0, rerank_backend: 'none' }];
  }

  const explicit = backend !== undefined;   // an explicit per-call override was passed
  const chosen = resolveRerankBackend(backend, deps.envBackend ?? BACKEND);
  const cohereFn = deps.cohereFn ?? rerankCohere;
  const judgeFn = deps.judgeFn ?? rerankJudge;
  const checkHealthy = deps.checkHealthy ?? assertRerankBackendHealthy;

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
      return await cohereFn(query, candidates);
    } catch (e) {
      if (e instanceof RerankBackendError) {
        console.warn('[rerank] env-default cohere unavailable → falling back to judge:', (e as Error).message);
        try {
          return await judgeFn(query, candidates);
        } catch (e2) {
          console.warn('[rerank] judge fallback failed → input order:', (e2 as Error).message);
          return inputOrder();
        }
      }
      console.warn('[rerank] backend failed, returning input order', (e as Error).message);   // generic soft-fall
      return inputOrder();
    }
  }

  // Explicit request (STRICT for 'cohere') + env-default/explicit 'judge' — unchanged strictness.
  try {
    if (chosen === 'cohere') {
      await checkHealthy('cohere');                       // explicit cohere is STRICT — probe first
      return await cohereFn(query, candidates);
    }
    return await judgeFn(query, candidates);
  } catch (e) {
    if (e instanceof RerankBackendError) throw e;   // explicit cohere typed error → propagate (never fall back)
    console.warn('[rerank] backend failed, returning input order', (e as Error).message);
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

async function rerankJudge<T extends RerankCandidate>(
  query: string,
  candidates: T[],
): Promise<RerankResult<T>[]> {
  const scores: number[] = new Array(candidates.length).fill(0);

  // Run JUDGE_BATCH-sized batches in PARALLEL so wall-clock stays bounded
  const batches: { start: number; end: number }[] = [];
  for (let i = 0; i < candidates.length; i += JUDGE_BATCH) {
    batches.push({ start: i, end: Math.min(i + JUDGE_BATCH, candidates.length) });
  }

  await Promise.all(batches.map(async ({ start, end }) => {
    const slice = candidates.slice(start, end);
    const passagesText = slice.map((c, idx) => {
      const snip = (c.text || '').slice(0, MAX_SNIPPET_CHARS).replace(/\s+/g, ' ').trim();
      return `[${idx}] ${snip}`;
    }).join('\n\n');

    const userMsg = `QUESTION:\n${query}\n\nPASSAGES:\n${passagesText}\n\nReturn the JSON scoring object now.`;

    try {
      // Governed envelope (Stage 4): traceless retrieval path behaves exactly as before.
      const r = await governedChat(undefined, 'rerank_judge', {
        model: JUDGE_MODEL,
        messages: [
          { role: 'system', content: JUDGE_SYSTEM },
          { role: 'user', content: userMsg },
        ],
        temperature: 0.0,
        max_tokens: 200,
        ...({ options: { num_ctx: 4096 }, keep_alive: '15m' } as Record<string, unknown>),
      }, { gemini: geminiUtilityModel(), promptRef: 'rerank/JUDGE_SYSTEM' });
      let txt = r.choices?.[0]?.message?.content?.trim() || '';
      if (txt.startsWith('```')) txt = txt.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '').trim();
      const a = txt.indexOf('{');
      const b = txt.lastIndexOf('}');
      if (a >= 0 && b > a) txt = txt.slice(a, b + 1);
      const parsed = JSON.parse(txt) as Record<string, number>;
      for (let k = 0; k < slice.length; k++) {
        const raw = parsed[String(k)];
        if (typeof raw === 'number' && !Number.isNaN(raw)) {
          scores[start + k] = Math.max(0, Math.min(10, raw)) / 10;
        }
      }
    } catch (e) {
      // Batch failed — leave those scores at 0 (will sort to bottom).
      // Soft fail is OK because we still have the input order as tiebreaker downstream.
      console.warn('[rerank judge] batch failed', start, '-', end, (e as Error).message);
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

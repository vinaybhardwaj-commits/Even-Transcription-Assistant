/**
 * lib/lvc.ts — Appropriateness / Low-Value-Care matcher (CW.2), wired.
 *
 * Orchestrates the pure core (lib/lvc-core.ts) over the real backend:
 *   1) candidate extraction (Gemini Flash utility; skipped if proposedActions given)
 *   2) dual recall — deterministic keyword match over active lvc_recommendations
 *      + semantic retrieve() over the source='choosing-wisely' corpus subset
 *   3) applicability judge (Gemini Pro for the opt-in surface; Flash for autoflag)
 *   4) two-tier confidence-floor gate + flag assembly (core.assembleFlags)
 *
 * Every step is traced (startTrace 'appropriateness' + logEvent). The autoflag
 * path soft-fails to empty so it can never break the parent DDx/Ask answer.
 * See CDMSS-CHOOSING-WISELY-LOW-VALUE-CARE-PRD-v1.1.md §6.
 */

import { sql } from './db';
import { retrieve } from './retrieve';
import { geminiUtilityModel, geminiModelFor, TEXT_MODEL, AUDIT_LLM_SEED, modelsAgree } from './llm';
import { logEvent, finishTrace, governedChat, withTrace, readTransportAttribution } from './trace';
import type { CdmssTransportAttribution } from './trace';
import * as core from './lvc-core';
import { labPackageContext } from './scoring-policy/lab-packages';
import type { Candidate, JudgedRec, LvcFlag, LvcRecommendation, Region, Surface } from './lvc-core';

export interface MatchInput {
  scenario: string;
  /** If given, used directly as the candidate orders (skips the Flash extraction pass). */
  proposedActions?: string[];
  patient?: { age?: number; sex?: string };
  /** Slice 2 (Right Care × ClinicalState): the pre-composed PATIENT PICTURE block, threaded
   *  into the applicability judge's prompt. OPTIONAL — omitted (the default, and always when
   *  RIGHT_CARE_CLINICAL_STATE_GROUND is off) → every prompt is byte-identical to Slice 1. */
  clinicalStateText?: string;
  /** 'surface' = opt-in /appropriateness (default); 'autoflag' = unsolicited DDx/Ask advisory. */
  surface?: Surface;
  preferRegion?: Region;
  /** Restrict recall to these regions (e.g. ['IN','CA','US']). Omit = all. */
  regionFilter?: Region[];
  trace?: boolean; // default true
  /** Lab probe: force the FREE local mini (no Gemini) for ₹0 pipeline testing. Default false. */
  forceOllama?: boolean;
}

export interface MatchResult {
  flags: LvcFlag[];
  candidates: Candidate[];
  considered: number;
  surface: Surface;
  traceId?: string;
  empty: boolean;
}

/** Injection seam for unit tests — override any stage; defaults hit the real backend. */
export interface MatchDeps {
  extractCandidates: (scenario: string) => Promise<Candidate[]>;
  recall: (input: MatchInput, candidates: Candidate[]) => Promise<LvcRecommendation[]>;
  judge: (
    ctx: { scenario: string; patient?: { age?: number; sex?: string }; clinicalStateText?: string; orderedActions?: string[] },
    recs: LvcRecommendation[],
    surface: Surface,
  ) => Promise<JudgedRec[]>;
}

/** Fix-3 flag (RIGHT_CARE_JUDGE_SEES_ACTION): surface the ordered action to the appropriateness
 *  judge so it can honour precondition carve-outs (the dormant NAMED EXCLUSIONS rule). Mirrors the
 *  RIGHT_CARE_CLINICAL_STATE_GROUND opt-in shape. Unset / '' / '0' → OFF (byte-identical to today);
 *  any other value → ON. Ships default-OFF; the flip is gated on a credentialed bench, not the merge. */
function judgeSeesActionEnabled(): boolean {
  const v = process.env.RIGHT_CARE_JUDGE_SEES_ACTION;
  return !!v && v !== '0';
}

const sql2 = sql as unknown as (q: string, p: unknown[]) => Promise<Record<string, unknown>[]>;

const REC_COLS =
  'id, region, society, specialty, statement, precondition, action_type, consider_instead, ' +
  'rationale, keywords, citation_doi, citation_pmid, citation_url, source_release_year, status';

function rowToRec(r: Record<string, unknown>): LvcRecommendation {
  const kw = r.keywords;
  return {
    id: String(r.id),
    region: String(r.region) as Region,
    society: String(r.society ?? ''),
    specialty: r.specialty == null ? null : String(r.specialty),
    statement: String(r.statement ?? ''),
    precondition: r.precondition == null ? null : String(r.precondition),
    action_type: r.action_type == null ? null : String(r.action_type),
    consider_instead: r.consider_instead == null ? null : String(r.consider_instead),
    rationale: r.rationale == null ? null : String(r.rationale),
    keywords: Array.isArray(kw) ? (kw as unknown[]).map(String) : [],
    citation_doi: r.citation_doi == null ? null : String(r.citation_doi),
    citation_pmid: r.citation_pmid == null ? null : String(r.citation_pmid),
    citation_url: r.citation_url == null ? null : String(r.citation_url),
    source_release_year: r.source_release_year == null ? null : Number(r.source_release_year),
    status: r.status == null ? undefined : String(r.status),
  };
}

/**
 * TEST SEAM — LVC JUDGE GUARD FIX PRD v3.0 §3.6 test 8, 10 Aug 2026.
 *
 * `deps.call` (below) replaces the judge's provider call wholesale, which means it BYPASSES
 * llmCall and therefore cannot see the options llmCall passes on. That is precisely the thing
 * §3.6 test 8 says a source comment or a build-report claim may not stand in for: the proof that
 * production's real judge call carries `noLocalFallback: true`. This seam sits one level lower —
 * it is the transport llmCall dispatches through — so a test can read the OPTIONS OBJECT the real
 * call site built, for the judge (must carry the flag) and for candidate extraction (must not).
 *
 * Production value is always governedChat; only a test ever replaces it, and passing null restores
 * it. Nothing outside a test may call the setter.
 */
type ChatTransport = typeof governedChat;
let chatTransport: ChatTransport = governedChat;
export function setLvcChatTransportForTest(fn: ChatTransport | null): void {
  chatTransport = fn ?? governedChat;
}

/** Additive tail options for llmCall (PRD §3.5). Today: `noLocalFallback`, the judge's only user. */
export interface LlmCallOptions {
  noLocalFallback?: boolean;
}

// One LLM helper: trace it when we have a traceId, else fall back to the plain wrapper.
// promptRef (Stage 1): the Stage-0 registry id of the system prompt this call runs —
// an additive tag stamped onto the trace envelope; never alters the prompt itself.
// options (PRD §3.5, D-7): a TRAILING OPTIONAL parameter spread into the transport's options
// object. Absent ⇒ `{...undefined}` ⇒ `{ gemini, promptRef }` exactly as before, so every existing
// caller (candidate extraction included) sends a byte-identical options object.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function llmCall(traceId: string | undefined, label: string, params: any, geminiModel?: string, promptRef?: string, options?: LlmCallOptions): Promise<any> {
  return chatTransport(traceId, label, params, { gemini: geminiModel, promptRef, ...options });
}

/**
 * STAGE 1 — CANDIDATE EXTRACTION (label `lvc_extract`, prompt `lvc-core/CANDIDATE_SYSTEM`).
 *
 * ⚠️ THIS IS THE "second temperature-0.1 call near lib/lvc.ts:115" the pinning PRD (§2.4) asked the
 * builder to identify. It is NOT the judge, and it is DELIBERATELY LEFT UNPINNED — flagged for V,
 * not decided here. The reasoning, so the next reader does not have to redo it:
 *
 *   · It answers a different question. This pass turns free text into the CANDIDATE ORDER LIST;
 *     the judge decides applicability. Its variance moves which recommendations are RECALLED, not
 *     which verdict a recalled rec receives.
 *   · The A/A measurement that ordered the pin never observed it. The harness sets
 *     `proposedActions`, which SKIPS this call entirely (see matchLowValueCare below), so none of
 *     the 9 discordant cases in the 9 Aug report can be attributed to it, and pinning it would
 *     change nothing the pre-registered r2 re-measurement can see.
 *   · Pinning it is not free. Changing recall changes which recs reach the judge, i.e. LVC flag
 *     composition, on a lever the PRD's stated consequences (§3 wording, §6 hazards) do not cover.
 *     §2.4's own instruction is "do not pin unrelated calls silently".
 *   · It runs on Flash utility routing and, unlike the judge, KEEPS its Ollama soft-fall: D-2
 *     forbids a non-Gemini VERDICT, and this pass returns no verdict. Its failure mode is already
 *     fail-safe — a caught error returns [], which ends the pipeline with zero flags.
 *
 * If V wants extraction pinned too, it is the same three lines as the judge and its own decision.
 */
async function defaultExtract(scenario: string, traceId?: string, forceOllama = false): Promise<Candidate[]> {
  try {
    const r = await llmCall(traceId, 'lvc_extract', {
      model: 'llama3.1:8b',
      messages: [
        { role: 'system', content: core.CANDIDATE_SYSTEM },
        { role: 'user', content: core.buildCandidateUser(scenario) },
      ],
      temperature: 0.1,
      max_tokens: 400,
      ...({ options: { num_ctx: 8192 }, keep_alive: '15m' } as Record<string, unknown>),
    }, forceOllama ? undefined : geminiUtilityModel(), 'lvc-core/CANDIDATE_SYSTEM');
    return core.parseCandidates(r.choices?.[0]?.message?.content || '');
  } catch (e) {
    console.warn('[lvc] candidate extraction failed', (e as Error).message);
    return [];
  }
}

async function defaultRecall(input: MatchInput, candidates: Candidate[]): Promise<LvcRecommendation[]> {
  // The lvc_recommendations table is small (≤ ~900 rows), so load active recs and
  // keyword-match in memory — robust, no fragile SQL array matching.
  const rf = input.regionFilter && input.regionFilter.length ? input.regionFilter : null;
  const rows = rf
    ? await sql2(`SELECT ${REC_COLS} FROM lvc_recommendations WHERE status = 'active' AND region = ANY($1)`, [rf])
    : await sql2(`SELECT ${REC_COLS} FROM lvc_recommendations WHERE status = 'active'`, []);
  const recs = rows.map(rowToRec);
  const kw = core.keywordRecall(input.scenario, candidates, recs);

  // Semantic leg: retrieve over the CW corpus subset, map chunk item_number → rec id.
  let sem: LvcRecommendation[] = [];
  try {
    const q = [input.scenario, ...candidates.map((c) => c.name)].join('. ');
    const r = await retrieve(q, { source: 'choosing-wisely', topK: 12, useSourceWeights: true, hybrid: true });
    const itemNos = new Set(r.hits.map((h) => h.item_number).filter((x): x is string => !!x));
    sem = recs.filter((x) => itemNos.has(x.id));
  } catch (e) {
    console.warn('[lvc] semantic recall failed', (e as Error).message);
  }
  return core.dedupeById(kw, sem);
}

/** The trace event that makes the refusal rate observable (PINNING PRD §2.3). One per refused
 *  batch. KEPT UNCHANGED by GUARD FIX PRD v3.0 §3.4 — readers may already depend on it. */
export const LVC_JUDGE_REFUSED_EVENT = 'lvc_judge_gemini_refused';

/** One event per PROVIDER ATTEMPT (GUARD FIX §3.4). Two attempts ⇒ two of these. */
export const LVC_JUDGE_ATTEMPT_EVENT = 'lvc_judge_attempt';
/** One event per LOGICAL INVOCATION (GUARD FIX §3.4). Always exactly one, whatever the attempts. */
export const LVC_JUDGE_INVOCATION_EVENT = 'lvc_judge_invocation';

/** Injection seam for unit tests — the judge's ONE provider call. Defaults to the real llmCall. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type JudgeCall = (params: any) => Promise<any>;
/** Injectable event recorder (§3.6 test 9). Default writes the events through logEvent; a test
 *  supplies its own to assert the PAYLOADS without a database. Storage is unchanged either way —
 *  this build adds no new store, only two new event kinds on the existing trace_events. */
export type JudgeEventRecorder = (kind: string, payload: unknown) => void | Promise<void>;
export interface JudgeDeps { call?: JudgeCall; recordEvent?: JudgeEventRecorder }

// ══ ATTRIBUTION — LVC JUDGE GUARD FIX PRD v3.0 §3.2 (D-6, D-8, D-9, D-15), 10 Aug 2026 ═════════

export type JudgeAttributionState = 'verified' | 'wrong_model' | 'unknown';

/**
 * WHICH MODEL ANSWERED, AS THREE HONEST STATES.
 *
 * The shipped defect (8655823) had two states: `modelsAgree(served, intended)` or failure. An
 * empty served string returns false from modelsAgree — it cannot tell a WRONG model from an
 * UNREPORTED one (lib/llm.ts:246-250, unchanged here per D-9) — so every call whose provider did
 * not echo a model name was read as wrong, retried, and doubled in cost. That is the defect.
 *
 * TWO SOURCES, RANKED (D-8). The transport knows what it DISPATCHED and now returns it
 * (trace.ts's CdmssTransportAttribution); the reply body may or may not name a model. Transport
 * outranks the body, so where both are present and agree with each other only the `reason` differs.
 *
 * THE TABLE (§3.2), exactly:
 *   transport absent + body absent                  → unknown      (accepted; never retried)
 *   transport agrees, body absent                   → verified
 *   transport absent, body agrees                   → verified
 *   transport agrees, body agrees                   → verified
 *   EITHER source names a different model           → wrong_model  (one retry, then refuse)
 *   the two sources CONFLICT                        → wrong_model
 *
 * "Agrees" means the model is the intended Gemini model, WHICHEVER approved cloud route dispatched
 * it (D-15, Option B: direct Vertex and the OpenRouter bridge are both acceptable pipes; the model
 * is what is ruled on). modelsAgree tolerates the `google/` publisher prefix, which is what makes
 * the bridge's `google/gemini-2.5-pro` slug pass.
 *
 * The local model is never "agrees": its slug (llama3.1:8b / qwen2.5:14b) fails modelsAgree, and
 * the transport's local branches name that slug — so a local answer resolves wrong_model, never
 * unknown. That is deliberate: `unknown` is accepted, so nothing local may be able to reach it.
 *
 * Pure. No I/O, no provider, no clock — every row of the table is unit-tested (§3.6 test 10).
 */
export function resolveJudgeAttribution(input: {
  intendedModel: string;
  transportModel?: string | null;
  bodyModel?: string | null;
}): { state: JudgeAttributionState; reason: string } {
  const t = String(input.transportModel ?? '').trim();
  const b = String(input.bodyModel ?? '').trim();
  // null = the source said nothing, which is NOT the same as the source disagreeing.
  const tAgrees: boolean | null = t ? modelsAgree(t, input.intendedModel) : null;
  const bAgrees: boolean | null = b ? modelsAgree(b, input.intendedModel) : null;

  if (tAgrees === false) {
    return { state: 'wrong_model', reason: bAgrees === true ? 'transport_body_conflict' : 'transport_names_other_model' };
  }
  if (bAgrees === false) {
    return { state: 'wrong_model', reason: tAgrees === true ? 'transport_body_conflict' : 'body_names_other_model' };
  }
  if (tAgrees === true && bAgrees === true) return { state: 'verified', reason: 'transport_and_body_agree' };
  if (tAgrees === true) return { state: 'verified', reason: 'transport_agrees' };
  if (bAgrees === true) return { state: 'verified', reason: 'body_agrees' };
  return { state: 'unknown', reason: 'no_model_reported' };
}

// ══ OBSERVABILITY — GUARD FIX §3.4 (D-11): count now, type later ═══════════════════════════════
//
// "Judge call" was ambiguous, and the ambiguity hid exactly the case this build cares about: a
// wrong-model first attempt followed by a good retry. So both levels are recorded — one event per
// PROVIDER ATTEMPT, one per LOGICAL INVOCATION — and the payload builders below are pure, so §3.6
// test 9 can assert the payloads without a provider or a database.
//
// HONEST GUARANTEE (§3.4): the judge accepts an absent traceId and logEvent is best-effort. The
// claim this build supports is that every TRACED production judge invocation ATTEMPTS to leave
// durable attempt and outcome records. Not more than that.

export interface JudgeAttemptRecord {
  /** 1-based attempt number. Not the retry count — see retry_count on the invocation payload. */
  attempt: number;
  status: 'ok' | 'error';
  intended_model: string | null;
  dispatched_provider: string | null;
  dispatched_model: string | null;
  body_model: string | null;
  attribution_state: JudgeAttributionState | null;
  attribution_reason: string | null;
  error: string | null;
}

/** Pure builder for one attempt record. Absent values stay null — never '' and never invented,
 *  so a source that reported nothing is distinguishable from one that reported an empty string. */
export function buildJudgeAttemptPayload(input: {
  attempt: number;
  status: 'ok' | 'error';
  intendedModel: string | null;
  transport?: CdmssTransportAttribution | null;
  bodyModel?: string | null;
  attribution?: { state: JudgeAttributionState; reason: string } | null;
  error?: unknown;
}): JudgeAttemptRecord {
  const body = String(input.bodyModel ?? '').trim();
  return {
    attempt: input.attempt,
    status: input.status,
    intended_model: input.intendedModel || null,
    dispatched_provider: input.transport?.dispatched_provider ?? null,
    // Both sources are kept SEPARATELY on purpose (§3.6 test 9): a conflict must stay readable as
    // a conflict after the fact, so neither may overwrite the other.
    dispatched_model: input.transport?.dispatched_model ?? null,
    body_model: body || null,
    attribution_state: input.attribution?.state ?? null,
    attribution_reason: input.attribution?.reason ?? null,
    error: input.error == null ? null : String((input.error as Error)?.message ?? input.error).slice(0, 500),
  };
}

export interface JudgeInvocationRecord {
  intended_model: string | null;
  attempts: JudgeAttemptRecord[];
  /** 0 or 1 — the number of RETRIES, never the attempt number (§3.4, explicit). */
  retry_count: number;
  outcome: 'verdict' | 'refusal';
  refuse_reason: string | null;
  final_attribution_state: JudgeAttributionState | null;
  surface: Surface;
  n_recs: number;
  rec_ids: string[];
}

/** Pure builder for the one-per-invocation record. */
export function buildJudgeInvocationPayload(input: {
  intendedModel: string | null;
  attempts: JudgeAttemptRecord[];
  outcome: 'verdict' | 'refusal';
  refuseReason?: string | null;
  surface: Surface;
  recIds: string[];
}): JudgeInvocationRecord {
  const last = input.attempts.length ? input.attempts[input.attempts.length - 1] : null;
  return {
    intended_model: input.intendedModel || null,
    attempts: input.attempts,
    retry_count: Math.max(0, input.attempts.length - 1),
    outcome: input.outcome,
    refuse_reason: input.refuseReason ?? null,
    final_attribution_state: last?.attribution_state ?? null,
    surface: input.surface,
    n_recs: input.recIds.length,
    rec_ids: input.recIds,
  };
}

/**
 * The applicability judge. LVC JUDGE PINNING PRD v1.0 §2 (D-1, D-2), 10 Aug 2026.
 *
 * ── D-1, THE PIN ────────────────────────────────────────────────────────────────────────────────
 * temperature 0 (was 0.1) + seed AUDIT_LLM_SEED + top_p 1 — the A-8 treatment, exactly, and the
 * same three levers the production OPD scorer runs on. Nothing else in the params moves and the
 * prompt does not move: JUDGE_SYSTEM and buildJudgeUser are untouched, and so is model resolution.
 * The judge serves on the Vertex Gemini path, which IGNORES the seed, so the expected gain is
 * partial — which is why §4/D-4 pre-registers the r2 re-measurement rather than declaring victory.
 * Baseline to beat: 38/47 cases identical (80.9%) against a 95% bar
 * (CDMSS-LVC-JUDGE-AA-REPORT-9-AUG-2026).
 *
 * ── GEMINI IN THE CLOUD IS THE ONLY GRADER ──────────────────────────────────────────────────────
 * D-2's standing ruling (PINNING PRD, 10 Aug): the judge path has NO fallback. Something answering
 * as `qwen2.5:14b` through the still-live Ollama bridge served 42 lab calls in 14 days, four of
 * them judge A/A cases and three of those discordant — a fallback that ANSWERS is a defect here,
 * not a feature, because a verdict is what decides whether a clinician sees a flag at all.
 *
 * ── HOW D-2 IS ENFORCED NOW: GUARD FIX PRD v3.0 §3, 10 Aug 2026 (D-6, D-7, D-8, D-15) ───────────
 * D-2's FIRST implementation shipped a defect in 8655823 and this replaces it. It read the reply
 * body's `model` and treated ANY non-match as wrong — including an EMPTY string, which merely
 * means the provider did not echo a name. Every unlabeled call was therefore retried: 106/118
 * calls at ~140s became 0/24 finishing inside the 300s platform ceiling. What changed:
 *
 *   D-8  ATTRIBUTION COMES FROM THE TRANSPORT FIRST. tracedChat now returns what it dispatched
 *        (provider + slug) alongside the completion; the reply body is the second source.
 *   D-6  THREE STATES, NOT TWO (resolveJudgeAttribution above).
 *          verified    → the verdict is served.
 *          unknown     → the verdict is served AND NEVER RETRIED. Nothing reported a model; that
 *                        is not evidence of a wrong one. Accepting it is what removes the double
 *                        call. Hazard, per §8: a route reporting nothing anywhere passes
 *                        unchallenged — D-8 shrinks that to near-nothing, §6 step 4 measures it.
 *          wrong_model → ONE retry, then the whole batch refuses.
 *        A THROWN provider error keeps its old behaviour: one retry, then refuse. Provider failure
 *        and unknown attribution are different states and are counted separately.
 *   D-7  THE JUDGE MUST NOT CALL THE LOCAL MODEL. `noLocalFallback: true` on this call only —
 *        never on candidate extraction. Note what it does: it stops the LOCAL fallback. It does
 *        not pin the call to one cloud provider.
 *   D-15 TRANSPORT POLICY IS OPTION B. Any approved cloud route may serve the judge provided it
 *        serves the intended Gemini model — direct Vertex and the OpenRouter bridge alike. The
 *        ruling names the MODEL, not the pipe. Anything else is wrong_model.
 *   D-9  modelsAgree is NOT changed — three other callers depend on its strict behaviour. The
 *        call site is what was wrong, and the call site is what moved.
 *
 * On refusal the whole batch returns the parse default, every rec `insufficient_info`, so no flag
 * can fire and nothing false is asserted. `parseJudgeResponse('')` IS that default — reused rather
 * than re-implemented, so the refuse path can never drift from the doctrine it applies.
 *
 * NO INTENDED SLUG ⇒ IMMEDIATE REFUSAL, WITHOUT A CALL. If Vertex is unconfigured, or the lab
 * probe's `forceOllama` asked for the free mini, there is no Gemini to retry against and the only
 * model that could answer is the one D-2 forbids. Refusing before the call is the same ruling
 * applied one step earlier. FLAGGED CONSEQUENCE: `providerOverride: 'ollama'` on
 * /api/appropriateness returns zero flags — its candidate-extraction leg still runs free and
 * local, but its judge stage is dead by ruling.
 *
 * Every attempt and every logical invocation is recorded (§3.4). See CDMSS-LVC-JUDGE-GUARD-FIX-
 * PRD-v3.0-10-AUG-2026.md.
 */
export async function defaultJudge(
  ctx: { scenario: string; patient?: { age?: number; sex?: string }; clinicalStateText?: string; orderedActions?: string[] },
  recs: LvcRecommendation[],
  surface: Surface,
  traceId?: string,
  forceOllama = false,
  deps: JudgeDeps = {},
): Promise<JudgedRec[]> {
  // Phase C §7.2 — factual lab-package composition, so a panel and one of its own analytes are not
  // read as two duplicate orders. FAIL-OPEN and byte-identical when absent: an empty/malformed set
  // renders no prompt block at all (buildLabPackageBlock returns ''), so the judge sees exactly
  // today's context. Never let a context read cost a judgement.
  const labPackages = await labPackageContext().catch(() => []);
  // Opt-in surface → Pro reasoning (geminiModelFor honours GEMINI_ALL); unsolicited
  // autoflag → cheap Flash. UNCHANGED resolution (PRD §2.1) — what changed is that an
  // unresolved slug now refuses instead of soft-falling to the local mini.
  const geminiModel = forceOllama ? undefined : (surface === 'autoflag'
    ? geminiUtilityModel()
    : (geminiModelFor('appropriateness') ?? geminiUtilityModel()));
  const fallbackModel = surface === 'autoflag' ? 'llama3.1:8b' : TEXT_MODEL;

  const recIds = recs.map((r) => r.id);

  /** Fire-and-forget observability. logEvent already swallows its own errors; the outer catch is
   *  the contract: a missing — or a throwing — record must never cost or change a verdict (§3.4). */
  const recorder: JudgeEventRecorder = deps.recordEvent ?? (async (kind, payload) => {
    if (!traceId) return;
    await logEvent(traceId, kind, 'lvc_judge', payload);
  });
  const record = async (kind: string, payload: unknown): Promise<void> => {
    try { await recorder(kind, payload); } catch { /* observability must never cost a verdict */ }
  };

  /** D-2/D-6: the whole batch to insufficient_info, plus the refusal event (kept) and the
   *  one-per-invocation record carrying every attempt that led here. */
  const refuse = async (served: string, reason: string, attempts: JudgeAttemptRecord[]): Promise<JudgedRec[]> => {
    console.warn(`[lvc] judge REFUSED (${reason}): served '${served || 'none'}' != intended '${geminiModel ?? 'none'}' — every rec insufficient_info, no flag fires`);
    // KEPT VERBATIM (§3.4): existing readers of this event and its field names must not break.
    await record(LVC_JUDGE_REFUSED_EVENT, {
      reason,
      served_model: served || null,
      intended_model: geminiModel ?? null,
      surface,
      n_recs: recs.length,
      rec_ids: recIds,
    });
    await record(LVC_JUDGE_INVOCATION_EVENT, buildJudgeInvocationPayload({
      intendedModel: geminiModel ?? null, attempts, outcome: 'refusal', refuseReason: reason, surface, recIds,
    }));
    // The existing "any rec not returned → insufficient_info" doctrine, applied to the whole batch.
    return core.parseJudgeResponse('', recs);
  };

  // No slug to serve or to retry against — refuse without a call, and with zero attempts recorded.
  if (!geminiModel) return refuse('', forceOllama ? 'force_ollama_requested' : 'no_gemini_model_resolved', []);

  const params = {
    model: fallbackModel,
    messages: [
      { role: 'system', content: core.JUDGE_SYSTEM },
      { role: 'user', content: core.buildJudgeUser(ctx, recs, ctx.clinicalStateText, ctx.orderedActions, labPackages) },
    ],
    // D-1 — the pin. seed/top_p ride governedChat → tracedChat's `...rest` to the Vertex
    // OpenAI-compat client (and to OpenRouter through the bridge); the guard above guarantees this
    // body is only ever sent to a cloud Gemini, so no Ollama-only path sees them.
    temperature: 0,
    seed: AUDIT_LLM_SEED,
    top_p: 1,
    max_tokens: 900,
    ...({ options: { num_ctx: 8192 }, keep_alive: '15m' } as Record<string, unknown>),
  };
  // D-7: `noLocalFallback: true` — HERE AND NOWHERE ELSE IN THIS FILE. Candidate extraction keeps
  // its local soft-fall (it returns no verdict). After both cloud tiers fail, tracedChat throws
  // instead of calling the local model, and the throw lands in the catch below as a normal failure.
  const call: JudgeCall = deps.call ?? ((p) => llmCall(traceId, 'lvc_judge', p, geminiModel, 'lvc-core/JUDGE_SYSTEM', { noLocalFallback: true }));

  // ── THE LOOP (§3.3) ───────────────────────────────────────────────────────────────────────────
  // Per attempt: call → resolve attribution → RECORD the attempt → branch.
  //   verified / unknown → return the parsed verdicts. NEITHER RETRIES.
  //   wrong_model        → retry once, then refuse.
  //   throw              → retry once, then refuse (unchanged from before this fix).
  // At most two attempts, exactly as before; what changed is which outcomes buy the second one.
  const attempts: JudgeAttemptRecord[] = [];
  let served = '';
  let lastReason = 'unknown';
  for (let attempt = 1; attempt <= 2; attempt++) {
    let entry: JudgeAttemptRecord;
    let verdicts: JudgedRec[] | null = null;
    try {
      const r = await call(params);
      const transport: CdmssTransportAttribution | null = readTransportAttribution(r) ?? null;
      const bodyModel = String(r?.model ?? '');
      const attribution = resolveJudgeAttribution({
        intendedModel: geminiModel, transportModel: transport?.dispatched_model ?? null, bodyModel,
      });
      entry = buildJudgeAttemptPayload({
        attempt, status: 'ok', intendedModel: geminiModel, transport, bodyModel, attribution,
      });
      // The evidence a refusal will report, if it comes to that: the transport's word first.
      served = transport?.dispatched_model || bodyModel;
      lastReason = attribution.reason;
      if (attribution.state === 'wrong_model') {
        console.warn(`[lvc] judge attempt ${attempt}/2 ${attribution.reason}: transport '${transport?.dispatched_model ?? 'none'}', body '${bodyModel || 'none'}' vs intended '${geminiModel}'`);
      } else {
        // verified OR unknown — both serve the verdict. Unknown is logged, not retried.
        if (attribution.state === 'unknown') {
          console.warn(`[lvc] judge attempt ${attempt}/2 attribution UNKNOWN (no model reported by transport or body) — verdict accepted per D-6, not retried`);
        }
        verdicts = core.parseJudgeResponse(r.choices?.[0]?.message?.content || '', recs);
      }
    } catch (e) {
      lastReason = 'call_failed';
      entry = buildJudgeAttemptPayload({
        attempt, status: 'error', intendedModel: geminiModel, transport: null, bodyModel: null,
        attribution: null, error: e,
      });
      console.warn(`[lvc] judge attempt ${attempt}/2 failed`, (e as Error).message);
    }
    attempts.push(entry);
    await record(LVC_JUDGE_ATTEMPT_EVENT, entry);
    if (verdicts) {
      await record(LVC_JUDGE_INVOCATION_EVENT, buildJudgeInvocationPayload({
        intendedModel: geminiModel, attempts, outcome: 'verdict', surface, recIds,
      }));
      return verdicts;
    }
  }
  return refuse(served, lastReason, attempts);
}

/**
 * Match a clinical scenario (and optional proposed orders) against the
 * Choosing Wisely / low-value-care corpus, returning applicable flags.
 */
export async function matchLowValueCare(input: MatchInput, deps: Partial<MatchDeps> = {}): Promise<MatchResult> {
  const surface: Surface = input.surface ?? 'surface';
  const doTrace = input.trace !== false;

  // Stage 1 (guaranteed finalize): the pipeline runs under withTrace, whose status-guarded
  // finally closes any trace left 'running' — the explicit finishTrace calls below keep
  // setting the real statuses first, so behaviour is unchanged on every existing path.
  const run = async (traceId?: string): Promise<MatchResult> => {

  const fo = input.forceOllama === true;
  const extract = deps.extractCandidates ?? ((s: string) => defaultExtract(s, traceId, fo));
  const recall = deps.recall ?? defaultRecall;
  const judge = deps.judge ?? ((ctx, recs, surf) => defaultJudge(ctx, recs, surf, traceId, fo));

  try {
    const candidates = input.proposedActions?.length
      ? input.proposedActions.map((a) => ({ name: a }))
      : await extract(input.scenario);
    if (traceId) await logEvent(traceId, 'lvc_candidates', null, { candidates });

    if (candidates.length === 0) {
      if (traceId) await finishTrace(traceId, 'success');
      return { flags: [], candidates: [], considered: 0, surface, traceId, empty: true };
    }

    const recs = await recall(input, candidates);
    if (traceId) await logEvent(traceId, 'lvc_recall', null, { count: recs.length, ids: recs.map((r) => r.id) });

    if (recs.length === 0) {
      if (traceId) await finishTrace(traceId, 'success');
      return { flags: [], candidates, considered: 0, surface, traceId, empty: true };
    }

    // Fix-3 (gated): when RIGHT_CARE_JUDGE_SEES_ACTION is on, surface the ordered actions — the
    // SAME `candidates` already used to select recs, never a re-extraction — to the judge so it can
    // honour precondition carve-outs. Flag off OR no candidates → pass the exact Slice-1 ctx (three
    // keys), so the judge(...) call and its user message are byte-identical to today. Fail-safe: a
    // problem here degrades to the no-action path, never a wrong verdict.
    const judgeCtx: { scenario: string; patient?: { age?: number; sex?: string }; clinicalStateText?: string; orderedActions?: string[] } =
      { scenario: input.scenario, patient: input.patient, clinicalStateText: input.clinicalStateText };
    if (judgeSeesActionEnabled() && candidates.length) judgeCtx.orderedActions = candidates.map((c) => c.name);
    const judged = await judge(judgeCtx, recs, surface);
    if (traceId) {
      await logEvent(traceId, 'lvc_judge_verdicts', null, {
        verdicts: judged.map((j) => ({ id: j.rec.id, verdict: j.verdict, confidence: j.confidence })),
      });
    }

    const flags = core.assembleFlags(judged, surface, { preferRegion: input.preferRegion });
    if (traceId) {
      await logEvent(traceId, 'lvc_flags', null, { count: flags.length, ids: flags.map((f) => f.id) });
      await finishTrace(traceId, 'success');
    }
    return { flags, candidates, considered: recs.length, surface, traceId, empty: flags.length === 0 };
  } catch (e) {
    if (traceId) await finishTrace(traceId, 'error', String((e as Error).message));
    // The autoflag path must never break the parent DDx/Ask answer.
    if (surface === 'autoflag') {
      return { flags: [], candidates: [], considered: 0, surface, traceId, empty: true };
    }
    throw e;
  }

  };

  if (!doTrace) return run(undefined);
  return withTrace('appropriateness', {
    scenario: input.scenario.slice(0, 500), surface, patient: input.patient, regionFilter: input.regionFilter,
  }, run);
}

export type { LvcFlag, Candidate } from './lvc-core';

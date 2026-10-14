/**
 * lib/lab-batch.ts — cohort-scoped, cron-drained qwen eval batches into the Lab store.
 *
 * Wraps the per-note mini→lab primitive (runMiniOpdToLab) in the mini-backfill lock/tick
 * pattern, pointed at a UID COHORT instead of a date cursor. Writes ONLY to lab_analyses
 * (experiment-namespaced) — NEVER opd_note_audits. Free mini only (qwen, ₹0).
 *
 * Three front doors share this core: the cron (/api/admin/lab-batch?auto=1), the admin
 * status endpoint, and the Lab MCP tools (lab_batch_start/status/stop/tick). It YIELDS to
 * the prod mini-backfill (both hit the single Mac-mini) via that worker's soft lock.
 *
 * S2b (8 Aug 2026) — A BATCH MAY NAME A MODEL. `lab_batch_start { model: 'bedrock:<id>' }` runs the
 * cohort on Bedrock instead of the Mac-mini: resolved through the F11 resolver, reachability-checked,
 * threaded to the audit leg the way the S2 backfill runner threads it, and — because a paid claim
 * must be provable — TRACED, verified against that trace (DEC-2), and priced per note. Still
 * lab_analyses only; still never opd_note_audits. No model named ⇒ every line below behaves exactly
 * as it did before, mini-yield and all.
 */
import { sql } from './db';
import { auditOpdNote, isDeadlineErrorMessage, opdMiniEngine, type LlmEnvelope, type EvalPathError } from './opd-note-audit';
import { MINI_MODEL, modelsAgree, bedrockConfigured } from './llm';
import { fetchOpdNoteByUid } from './metabase';
import { saveLabAnalysis } from './lab';
import { resolveProvider } from './lab-provider-core';
import { checkAttribution } from './lab-attribution-core';
import { servedCallForAudit, usageForTrace } from './backfill-runs';
import { costUsd } from './llm-cost-core';
import { type TelemetryRequestContext } from './retrieval-telemetry-core';
import { type LifecycleHandle } from './retrieval-telemetry-store';
import { settleOwned } from './retrieval-settlement';
import { PRICING } from './llm-cost';
import { getSettings, setSetting, windowOpen, lockHeld, readState as readMiniState } from './mini-backfill';
import { LB_KEYS, LB_LOCK_TTL_MS, EVAL_TICK_DEADLINE_MS, type LabBatchState, parseBatchState, remainingUids, batchGate, drainPlan, boundedPool, labLockHeld, ttlBreach, ttlBreachMessage } from './lab-batch-core';

const run = sql as unknown as (text: string, params?: unknown[]) => Promise<Record<string, unknown>[]>;

export async function readBatchState(): Promise<LabBatchState> {
  const s = await getSettings(Object.values(LB_KEYS));
  return parseBatchState(s);
}

/** DISTINCT input_ref already stored for this experiment (the done-set). */
export async function doneUids(experiment: string): Promise<Set<string>> {
  const rows = await run(
    `SELECT DISTINCT input_ref FROM lab_analyses WHERE experiment = $1 AND input_ref IS NOT NULL`, [experiment],
  ).catch(() => [] as Record<string, unknown>[]);
  return new Set(rows.map((r) => String(r.input_ref)));
}

export async function batchProgress(experiment: string, cohort: string[]): Promise<{ total: number; done: number; remaining: number }> {
  const done = await doneUids(experiment);
  const doneInCohort = cohort.filter((u) => done.has(u)).length;
  return { total: cohort.length, done: doneInCohort, remaining: Math.max(0, cohort.length - doneInCohort) };
}

/** Lab eval config for a batch (R-11 Stage 2 Phase 2). Absent ⇒ today's mini/leg-off behaviour.
 *  `deadlineAt` (Eval-tick-deadline PRD D1) is absolute epoch ms, set by `batchTick`'s EVAL branch
 *  only — the mini branch leaves it undefined and is byte-identical. */
export interface LabEvalConfig {
  evalNormativeLeg?: boolean; evalModel?: string; evalNormativeChannel?: boolean; deadlineAt?: number;
  rerankBackend?: 'judge' | 'cohere';
  /** S2b C1 — grade this batch on a BEDROCK model (the full modelId). Absent ⇒ every line of this
   *  file behaves exactly as before. Mutually exclusive with `evalModel` (rejected at the door). */
  bedrockModel?: string;
  /** ⚠️ CARRIED ON THE CONFIG RATHER THAN AS A FOURTH PARAMETER, so `runMiniOpdToLab(uid,
   *  experiment, evalCfg)` stays the call `lib/__tests__/eval-hardening.test.ts` reads to prove the
   *  tombstone budget check happens BEFORE the attempt. A new parameter would have broken a pin
   *  that has nothing to do with telemetry, to say something the config can say instead. */
  telemetry?: TelemetryRequestContext;
}

// ── S2b C1: the batch gains a model (BAKEOFF-DESIGN §6 gap 1) ────────────────────────────────────
//
// WHY A KEY OF ITS OWN RATHER THAN A FIELD ON LabBatchState. Exactly the reason LB_ATTEMPTS_KEY
// above has one: lib/lab-batch-core.ts is outside this build's file contract, so LB_KEYS and
// parseBatchState cannot grow. The reader below is the whole surface, and nothing else needs it.
//
// ⚠️ THIS KEY IS STICKY, AND THAT IS THE HAZARD IT MUST NOT HAVE. A stale `bedrock:` here would
// silently make the NEXT free-mini batch a paid one. `lab_batch_start` therefore WRITES IT ON EVERY
// START — the empty string when no model is named — so the key always describes the batch that is
// actually queued, never the one before it.
export const LB_MODEL_KEY = 'lab_batch_model';

/** The batch's provider-prefixed model string, or '' for today's free-mini path. */
export async function readBatchModel(): Promise<string> {
  const s = await getSettings([LB_MODEL_KEY]).catch(() => ({} as Record<string, string>));
  return String(s[LB_MODEL_KEY] ?? '').trim();
}

export type BatchModelResolution =
  /** `modelId: null` ⇒ no model named ⇒ the mini path, byte-identical to before S2b. */
  | { ok: true; modelId: string | null }
  | { ok: false; error: string };

/**
 * Resolve the batch's `model` argument. ERRORS LOUD, NEVER FALLS BACK — the same rule the lab
 * override and the backfill runner hold, for the same reason: a batch whose model was silently
 * substituted produces 150 unattributable rows and an experiment nobody can read.
 *
 * ⚠️ BEDROCK ONLY, and the refusal names the alternative rather than just saying no. OpenRouter
 * already has a door on this path (`evalModel`, with its own concurrency and deadline machinery);
 * a second one would be two ways to say the same thing that drift. `ollama:`/`vertex:` are refused
 * because the batch's ₹0 default IS ollama and because the lab never writes a production audit row.
 */
export function resolveBatchModel(raw: string | null | undefined): BatchModelResolution {
  const s = String(raw ?? '').trim();
  if (!s) return { ok: true, modelId: null };
  const r = resolveProvider(s, MINI_MODEL);
  if (!r.ok) return { ok: false, error: r.error };
  if (r.provider !== 'bedrock') {
    return { ok: false, error: `batch model '${s}' resolves to ${r.provider}; the lab batch accepts 'bedrock:<modelId>' only (use evalModel for OpenRouter, or omit model for the free mini). Never falls back.` };
  }
  return { ok: true, modelId: r.model };
}

// ── per-uid failure budget (Eval-hardening D3/D4) ────────────────────────────────────────────────
//
// THE POISON NOTE WAS UNBOUNDED: drainOne catches, records, writes no row ⇒ doneUids never contains
// the uid ⇒ remainingUids re-selects it every tick, forever. At window:'always' that is indefinite
// paid retrying and the batch never reaches finished:true.

/** Terminal failures per uid before a tombstone replaces the attempt (D3). */
export const EVAL_MAX_UID_FAILURES = 3;

/** app_settings key. NOT added to LB_KEYS — lab-batch-core.ts is read-only in this build, and no
 *  reader needs it in parseBatchState; it is read by the eval branch alone. */
export const LB_ATTEMPTS_KEY = 'lab_batch_attempts';

export interface UidAttempts {
  failures: number;
  deadline_abandons: number;
  /** Last TERMINAL failure's evidence, persisted here because the tombstone is written on a LATER
   *  tick than the failure that earned it — by then the error object is long gone (D5). */
  last_error?: string;
  llm_envelope?: LlmEnvelope | null;
  error_type?: string | null;
}

/** The stored map is EXPERIMENT-SCOPED. That scoping IS the reset: a new experiment starts with a
 *  clean budget, and a resumed batch (same experiment — the done-set persists by design) keeps its
 *  counts. `lab_batch_start` lives in mcp-tools.ts, outside this build's file contract, so the
 *  reset could not be an explicit write there. */
export interface AttemptsState { experiment: string; uids: Record<string, UidAttempts> }

/** Absent, malformed, or another experiment's map ⇒ empty. A batch is DRAINING MID-DEPLOY as this
 *  ships (det_08114_fixed_seed_b): the key will not exist on first read, and that must mean "no
 *  budget recorded", never an error. */
export function parseAttemptsState(raw: string | null | undefined, experiment: string): AttemptsState {
  try {
    const j = JSON.parse(String(raw ?? '')) as { experiment?: unknown; uids?: unknown };
    if (!j || typeof j !== 'object' || j.experiment !== experiment || !j.uids || typeof j.uids !== 'object') {
      return { experiment, uids: {} };
    }
    const uids: Record<string, UidAttempts> = {};
    const n = (x: unknown) => (typeof x === 'number' && Number.isFinite(x) && x >= 0 ? Math.floor(x) : 0);
    for (const [k, v] of Object.entries(j.uids as Record<string, unknown>)) {
      const o = (v && typeof v === 'object' ? v : {}) as Record<string, unknown>;
      uids[k] = {
        failures: n(o.failures),
        deadline_abandons: n(o.deadline_abandons),
        ...(typeof o.last_error === 'string' ? { last_error: o.last_error } : {}),
        ...(o.llm_envelope && typeof o.llm_envelope === 'object' ? { llm_envelope: o.llm_envelope as LlmEnvelope } : {}),
        ...(o.error_type != null ? { error_type: String(o.error_type) } : {}),
      };
    }
    return { experiment, uids };
  } catch {
    return { experiment, uids: {} };
  }
}

/**
 * Record one failed drain. ⚠️ D4 (O3) — A DEADLINE ABANDONMENT IS NOT A FAILURE. Measured 28 Jul:
 * EVAL_TICK_DEADLINE_MS = 240s and arm A's p90 latency = 242s — the same number — so ~1 note in 10
 * is deadline-abandoned in a HEALTHY wave. Counting those toward the budget would tombstone a
 * perfectly good slow note after three unlucky ticks having never once failed. Only TERMINAL
 * failures increment `failures`: non-retryable HTTP, 3× empty content, 3× transport, and the parse
 * guards. Deadline abandons are tracked separately, for visibility alone.
 */
export function recordDrainFailure(state: AttemptsState, uid: string, e: unknown): UidAttempts {
  const rec: UidAttempts = state.uids[uid] ?? { failures: 0, deadline_abandons: 0 };
  const msg = String((e as Error)?.message ?? e);
  if (isDeadlineErrorMessage(msg)) {
    rec.deadline_abandons += 1;
  } else {
    rec.failures += 1;
    rec.last_error = msg.slice(0, 600);
    const ex = e as EvalPathError;
    rec.llm_envelope = ex.envelope ?? null;
    rec.error_type = ex.error_type ?? null;
  }
  state.uids[uid] = rec;
  return rec;
}

/** True when the uid has exhausted its budget and the next selection writes a tombstone instead. */
export function tombstoneDue(state: AttemptsState, uid: string): boolean {
  return (state.uids[uid]?.failures ?? 0) >= EVAL_MAX_UID_FAILURES;
}

/** The shared per-note primitive: audit one db13 uid → lab_analyses. Writes ONLY lab_analyses (via
 *  saveLabAnalysis); auditOpdNote is pure compute and never writes opd_note_audits. `evalCfg` (Phase 2)
 *  forces the R-11 normative leg on and/or routes generation to an OpenRouter model — absent ⇒ mini. */
export async function runMiniOpdToLab(uid: string, experiment: string, evalCfg: LabEvalConfig = {}): Promise<{ id: string; band: string; index: number; findings: number; engine: string; usd?: number }> {
  const telemetry = evalCfg.telemetry;
  const row = await fetchOpdNoteByUid(uid);
  if (!row) throw new Error(`no db13 OPD note for uid ${uid}`);
  const started = Date.now();
  // S2b C1 — the bake-off arm. `onBedrock` is the ONLY branch in this function: every line below is
  // guarded on it, so a batch with no model is byte-identical to before this existed.
  const bedrockModel = String(evalCfg.bedrockModel ?? '').trim();
  const onBedrock = !!bedrockModel;
  // PDQI-9 fail-loud Phase 1 (R2): keep the LAST envelope seen. On the eval path openRouterGenerate
  // emits one per attempt, so after a retry this holds the attempt that actually produced the
  // content. Assignment only — it cannot throw, and it is never read unless the audit SUCCEEDS.
  // If the audit fails, the catch in auditOpdNote rethrows (eval only), drainOne records the error,
  // and no row is written at all — which is the point of the build.
  let lastEnvelope: LlmEnvelope | null = null;
  // ⚠️ THIS PATH WRITES `lab_analyses` AND NOTHING ELSE (D9). It never touches opd_note_audits, so
  // its retrieval rows settle `no_persistence_intended` — a statement that persistence was never
  // intended, which is a different fact from a save that failed. The intent is declared up front for
  // the same reason D12 gives: no property of the `primary` role could have told anyone.
  let handle: LifecycleHandle | null = null;
  let published = false;
  try {
  const audit = await auditOpdNote(row, {
    ...(telemetry ? {
      telemetry: { ctx: telemetry, route: 'lab_batch' as const, persistenceIntent: 'never_persists' as const },
      onLifecycleHandleUpdated: (h: LifecycleHandle) => { handle = h; published = true; },
    } : {}),
    pipeline: 'mini', engineTag: 'lab',
    // ⚠️ THE BEDROCK ARM IS TRACED, AND IT HAS TO BE. `trace: false` is right for the mini — a free
    // local call with nothing to attribute and nothing to price — but a paid arm that records no
    // trace can prove neither WHO SERVED it (DEC-2) nor WHAT IT COST, and both are conditions on
    // this build. Every other path keeps `false` exactly as before.
    trace: onBedrock,
    bedrockModel: onBedrock ? bedrockModel : undefined,
    evalNormativeLeg: evalCfg.evalNormativeLeg, evalModel: evalCfg.evalModel,
    evalNormativeChannel: evalCfg.evalNormativeChannel,
    // Rerank-flip-prep (31 Jul): named rerank backend for the flip A/B. Absent ⇒ retrieve opts
    // deep-equal to today's (guarded spread downstream); explicit 'cohere' stays strict.
    rerankBackend: evalCfg.rerankBackend,
    // Inert unless evalModel is also set — it reaches the LLM only via defaultGenerate's eval branch.
    deadlineAt: evalCfg.deadlineAt,
    onEnvelope: (e) => { lastEnvelope = e; },
  });
  // ══ F11 / DEC-2 (51d5d41) ON THE BATCH PATH ═══════════════════════════════════════════════════
  //
  // The 7 Aug failure was a row that said `bedrock` while every leg had run on the local mini, and
  // the lesson was NOT "resolve the provider properly" — the resolver was already right. It was that
  // A STORED ATTRIBUTION MUST BE DERIVED FROM WHAT SERVED. The probe path learned it; this path is
  // the one about to write 450 rows for the bake-off, so it learns it too, through the SAME pure
  // comparison (`checkAttribution`) rather than a second copy of the rule.
  //
  // REFUSAL MEANS NO ROW. Not a corrected row, not a row with a warning: nothing. An unwritten uid
  // stays outside `doneUids`, so the next tick re-offers it and the per-uid budget below bounds the
  // retries. Writing "whoever answered" instead would quietly fill one arm of a note-paired
  // comparison with a different model's grades — which is worse than the gap it papers over.
  let attribution: { verified: boolean; provider: string; model: string } | null = null;
  let usage: { tokens_in: number; tokens_out: number; usd: number } | null = null;
  if (onBedrock) {
    const served = await servedCallForAudit(audit.traceId);
    const calls = served.model || served.provider ? [{ stage: 'opd_audit_analyze', provider: served.provider, model: served.model }] : [];
    const verdict = checkAttribution({ provider: 'bedrock', model: bedrockModel }, calls, modelsAgree);
    if (!verdict.ok) throw new Error(`uid ${uid}: ${verdict.message}`);
    attribution = { verified: verdict.verified, provider: verdict.provider, model: verdict.model };
    // Cost per note per arm is a deliverable of the bake-off (BAKEOFF-DESIGN §4.5), and it is read
    // from the trace's ENVELOPE COLUMNS — never its payload, which carries the clinical text.
    // Best-effort: zeros understate a run's cost rather than failing a note already graded.
    const u = await usageForTrace(audit.traceId);
    usage = {
      tokens_in: u.tokensIn, tokens_out: u.tokensOut,
      usd: Number(costUsd(verdict.model, u.tokensIn, u.tokensOut, false, PRICING).toFixed(6)),
    };
  }
  const output = {
    index: audit.scorecard.headline, band: audit.scorecard.band, scorecard: audit.scorecard,
    completeness: audit.completeness, findings: audit.findings, suggestions: audit.suggestions,
    // Phase-2 provenance stamp so band-migration analysis can split arms by (model × leg × channel).
    eval: { model: evalCfg.evalModel ?? null, normativeLeg: evalCfg.evalNormativeLeg === true, normativeChannel: evalCfg.evalNormativeChannel === true, rerank: evalCfg.rerankBackend ?? null },
    // R2 instrumentation. ADDITIVE — a key inside the existing `output` jsonb that saveLabAnalysis
    // already writes whole, so there is NO migration. Absent on the mini path (no evalModel ⇒ no
    // OpenRouter call ⇒ no envelope), which keeps every non-eval lab row byte-identical.
    ...(lastEnvelope ? { llm_envelope: lastEnvelope } : {}),
    // Bedrock arm only: the verified attribution and this note's own spend, so an arm is readable
    // from its rows alone without joining back to traces.
    ...(attribution ? { attribution } : {}),
    ...(usage ? { usage } : {}),
  };
  const id = await saveLabAnalysis({
    experiment, kind: 'opd_note', engine: audit.engineVersion, inputRef: uid,
    inputPreview: `uid ${uid}`, output,
    // ⚠️ THE COLUMNS CARRY WHAT SERVED. `provider` is what the paid-run ceiling counts
    // (countPaidRuns: provider IS NOT NULL AND provider <> 'ollama'), so a bedrock arm registers as
    // paid where the free mini never does. On the mini/eval path both are exactly as before —
    // `provider` stays absent, which is why today's eval batches do not move that counter.
    model: attribution ? attribution.model : (evalCfg.evalModel || MINI_MODEL),
    ...(attribution ? { provider: attribution.provider } : {}),
    latencyMs: Date.now() - started,
  });
  await settleOwned(handle, 'no_persistence_intended');
  return {
    id, band: audit.scorecard.band, index: audit.scorecard.headline,
    findings: audit.findings.length, engine: audit.engineVersion,
    ...(usage ? { usd: usage.usd } : {}),
  };
  } catch (e) {
    // The DEC-2 refusal branch throws from inside this try and is ALSO `no_persistence_intended`:
    // this path never intended to write an audit row, so refusing to write a LAB row does not change
    // what the retrieval's persistence intent was. Every other throw is the audit's own.
    await settleOwned(handle,
      /verified|attribution|answered/i.test(String((e as Error).message)) ? 'no_persistence_intended'
        : published ? 'audit_generation_failed' : 'retrieval_not_run');
    throw e;
  }
}

/** One tick: drain up to n un-done cohort uids into lab_analyses. Idempotent + resumable.
 *  ignoreWindow=true is the manual-nudge path (lab_batch_tick) — the cron respects the window. */
/** ⚠️ `batchTick` ACCEPTS THE TYPED CONTEXT AND NEVER CREATES ITS OWN (D11). It is reached from two
 *  different boundaries — the admin route's cron and the MCP `lab_batch_tick` tool — and a context
 *  minted here would report both of them as the same kind of invocation, which is exactly the
 *  overlap question §8 exists to answer. */
export async function batchTick(opts: { ignoreWindow?: boolean; telemetry?: TelemetryRequestContext } = {}): Promise<Record<string, unknown>> {
  // D3 — wall clock for the tick. PURE OBSERVATION: read only where the summary is built, never
  // branched on. The old summary could not distinguish "tick completed" from "tick never ran", which
  // is precisely how the killed-invocation defect stayed invisible for a full paid run.
  const tickStart = Date.now();
  const st = await readBatchState();
  const base = { enabled: st.enabled, experiment: st.experiment, window: st.window, total: st.uids.length };
  // ── S2b C1 — the batch's model, resolved before anything else happens ─────────────────────────
  // Re-resolved EVERY TICK rather than trusted from start time, for the reason the runner re-probes
  // every tick: the rollback for this whole build is unsetting a BEDROCK_* var, and a batch that
  // kept grinding against an unreachable provider would turn that rollback into a wall of failed
  // notes instead of one visible, stopped batch.
  const resolvedModel = resolveBatchModel(await readBatchModel());
  if (!resolvedModel.ok) {
    await setSetting(LB_KEYS.error, resolvedModel.error.slice(0, 300)).catch(() => {});
    return { ...base, skipped: `batch model refused: ${resolvedModel.error}` };
  }
  const bedrockModel = resolvedModel.modelId;
  if (bedrockModel && !bedrockConfigured()) {
    // The one reachability fact, read where it lives (lib/llm.ts) — `probeReachable('bedrock')` in
    // lib/lab-override.ts delegates to this same function, so there is one rule, not two.
    const msg = 'bedrock is not reachable in this deployment (BEDROCK_REGION / BEDROCK_ROLE_ARN / BEDROCK_OIDC_AUDIENCE / GCP_SA_KEY) — batch tick refused, nothing graded';
    await setSetting(LB_KEYS.error, msg).catch(() => {});
    return { ...base, model: `bedrock:${bedrockModel}`, skipped: msg };
  }
  // Eval batches (evalModel set → OpenRouter, hosted+concurrent) fan out and skip the mini-yield —
  // that lock only protects the single mini GPU, which the eval path never touches. Mini batches
  // (no evalModel) keep the legacy plan EXACTLY: n≤2, serial, mini-yield honoured.
  const plan = drainPlan(st);
  // Prod re-score now yields to us (bounded run has priority), so we only defer to prod's transient
  // in-flight note for ONE tick to avoid a literal concurrent mini call — not a standing yield.
  let miniBusy = false;
  // ⚠️ THE BEDROCK ARM DOES NOT YIELD TO THE MAC-MINI. `drainPlan` returns useMiniYield for every
  // non-eval batch because, until S2b, every non-eval batch WAS the mini. A Bedrock batch never
  // touches that box, so deferring to its lock would be waiting on a resource it does not use — and
  // a prod worker whose lock ever stuck would silently wedge a paid bake-off arm behind it. The
  // yield is dropped here rather than in drainPlan because lib/lab-batch-core.ts is outside this
  // build's file contract; the eval branch's `useMiniYield: false` is the same call, made there.
  if (plan.useMiniYield && !bedrockModel) {
    // DELIBERATELY the PROD worker's lockHeld/MB_LOCK_TTL_MS — this reads the mini-backfill's lock
    // to see whether the shared GPU is busy, so it must keep the prod worker's TTL. Do NOT switch
    // this to labLockHeld: the two locks belong to two different workers (D1).
    try { miniBusy = lockHeld((await readMiniState()).lock); } catch { miniBusy = false; }
  }
  const skip = batchGate({
    enabled: st.enabled,
    hasJob: !!st.experiment && st.uids.length > 0,
    windowOpen: opts.ignoreWindow ? true : windowOpen(st.window),
    // The BATCH's own lock, governed by LB_LOCK_TTL_MS (D1). Previously this called the prod
    // worker's lockHeld, so MB_LOCK_TTL_MS=210s governed a batch whose average note takes 212.8s.
    lockHeld: labLockHeld(st.lock),
    miniBusy,
  });
  if (skip) return { ...base, skipped: skip };

  await setSetting(LB_KEYS.lock, new Date().toISOString());
  try {
    const experiment = st.experiment as string;
    const done = await doneUids(experiment);
    const todo = remainingUids(st.uids, done);
    if (todo.length === 0) {
      await setSetting(LB_KEYS.enabled, '0');
      const summary = {
        ...base, done: st.uids.length, remaining: 0, finished: true, at: new Date().toISOString(),
        tick_ms: Date.now() - tickStart, slice_planned: plan.sliceSize, slice_drained: 0,
      };
      await setSetting(LB_KEYS.last, JSON.stringify(summary));
      return summary;
    }
    const priorDone = st.uids.length - todo.length;
    const slice = todo.slice(0, plan.sliceSize);
    // D1 — the tick deadline, computed ONCE, from the tick's own start. EVAL BRANCH ONLY: the mini
    // branch gets `undefined` and is byte-identical, because the mini path is serial on a single GPU
    // and never retries inside the tick, so it has neither the failure mode nor the fan-out.
    const deadlineAt = plan.evalMode ? tickStart + EVAL_TICK_DEADLINE_MS : undefined;
    const evalCfg = { evalNormativeLeg: st.evalNormativeLeg, evalModel: st.evalModel ?? undefined, evalNormativeChannel: st.evalNormativeChannel, rerankBackend: st.evalRerankBackend ?? undefined, ...(deadlineAt != null ? { deadlineAt } : {}), ...(bedrockModel ? { bedrockModel } : {}), ...(opts.telemetry ? { telemetry: opts.telemetry } : {}) };
    // Eval-hardening D3/D4 — the per-uid failure budget. PAID BRANCHES ONLY: the free mini branch
    // neither reads nor writes it. Absent key ⇒ empty state, never an error (a batch is draining
    // mid-deploy as this ships). The read failing entirely degrades to "no budget enforcement" —
    // losing the budget must never cost the drain (§4 fail-safe direction).
    //
    // ⚠️ S2b EXTENDS THIS TO THE BEDROCK ARM, and the reason is the one D3 was written for. The
    // poison note is unbounded by construction: drainOne catches, writes no row, so `doneUids` never
    // contains the uid and `remainingUids` re-selects it every tick FOREVER. On the free mini that
    // costs GPU time. On a paid arm it is indefinite paid retrying of a note that will never parse —
    // and the DEC-2 refusal above is itself a no-row failure, so an arm pointed at a misconfigured
    // provider would retry every uid in the cohort without end. Three terminal failures, then a
    // tombstone, exactly as the OpenRouter path.
    const attempts: AttemptsState | null = (plan.evalMode || !!bedrockModel)
      ? await getSettings([LB_ATTEMPTS_KEY])
          .then((s) => parseAttemptsState(s[LB_ATTEMPTS_KEY], experiment))
          .catch(() => ({ experiment, uids: {} }))
      : null;
    // One note → one result row; errors captured per-note (never thrown out of the drain).
    const drainOne = async (uid: string): Promise<Record<string, unknown>> => {
      const t0 = Date.now();
      // D3 — at budget, a TOMBSTONE replaces the attempt: a deliberate, labelled non-result. It is
      // an ordinary lab_analyses row for this experiment, so doneUids (which counts any input_ref,
      // no kind filter) stops re-selecting the uid and the batch can reach finished:true.
      if (attempts && tombstoneDue(attempts, uid)) {
        try {
          const rec = attempts.uids[uid]!;
          const id = await saveLabAnalysis({
            experiment, kind: 'eval_failed', engine: opdMiniEngine('lab'), inputRef: uid,
            inputPreview: `uid ${uid} — tombstoned after ${rec.failures} terminal failures`,
            output: {
              failed: true, attempts: rec.failures, last_error: rec.last_error ?? null,
              llm_envelope: rec.llm_envelope ?? null, error_type: rec.error_type ?? null,
            },
            // The tombstone names the model that FAILED, not the mini. It carries no `provider`:
            // nothing served it, so it must not register against the paid-run ceiling.
            model: bedrockModel || st.evalModel || MINI_MODEL, latencyMs: Date.now() - t0,
          });
          return { uid, tombstoned: true, id, ms: Date.now() - t0 };
        } catch (e) {
          // The tombstone write itself failed — leave the uid un-done; next tick tries again.
          return { uid, error: `tombstone write failed: ${String((e as Error).message).slice(0, 200)}`, ms: Date.now() - t0 };
        }
      }
      try {
        const r = await runMiniOpdToLab(uid, experiment, evalCfg);
        return { uid, band: r.band, index: r.index, findings: r.findings, ...(r.usd != null ? { usd: r.usd } : {}), ms: Date.now() - t0 };
      } catch (e) {
        const msg = String((e as Error).message);
        // D4 — deadline abandons and terminal failures are budgeted SEPARATELY (see recordDrainFailure).
        if (attempts) recordDrainFailure(attempts, uid, e);
        await setSetting(LB_KEYS.error, `${uid}: ${msg}`.slice(0, 300)).catch(() => {});
        const et = (e as EvalPathError).error_type ?? null;
        return { uid, error: msg, ...(et != null ? { error_type: et } : {}), ms: Date.now() - t0 };
      }
    };
    let results: Record<string, unknown>[];
    if (plan.evalMode) {
      // OpenRouter path: bounded fan-out — never more than plan.concurrency audits in flight.
      results = await boundedPool(slice, plan.concurrency, drainOne);
    } else {
      // Mini path: strictly serial, exactly as before (single GPU).
      results = [];
      for (const uid of slice) results.push(await drainOne(uid));
    }
    // Persist the budget map — wrapped: losing the map must never cost the drain that already
    // succeeded (§4). Written whole; drainOne mutated it in-memory (single-threaded, no races).
    if (attempts) await setSetting(LB_ATTEMPTS_KEY, JSON.stringify(attempts)).catch(() => {});
    // A tombstoned uid IS done (it now holds a lab_analyses row), so it counts toward progress.
    const okNow = results.filter((r) => !('error' in r)).length;
    const doneNow = priorDone + okNow;
    // D2 — THE CONTRADICTING FIELD. Assert observed latency against the TTL meant to cover it. Pure
    // observation, wrapped so it can NEVER throw and NEVER block a tick: a failure here must not
    // cost the drain that already succeeded.
    let breach = { breach: false, maxMs: 0 };
    try { breach = ttlBreach(results as { ms?: number }[], LB_LOCK_TTL_MS); } catch { breach = { breach: false, maxMs: 0 }; }
    if (breach.breach) {
      await setSetting(LB_KEYS.error, ttlBreachMessage(breach.maxMs, LB_LOCK_TTL_MS)).catch(() => {});
    }
    const summary = {
      ...base, experiment,
      model: bedrockModel ? `bedrock:${bedrockModel}` : (st.evalModel || MINI_MODEL),
      processed: results.length,
      // Bedrock arm only: this tick's spend, summed from the per-note usage each row already carries.
      ...(bedrockModel ? {
        provider: 'bedrock',
        tick_usd: Number(results.reduce((s, r) => s + (Number(r.usd) || 0), 0).toFixed(6)),
        // The budget's two fields, reported for this arm too — a paid arm that is quietly
        // tombstoning notes must say so on the surface an operator actually watches.
        tombstoned: results.filter((r) => r.tombstoned === true).length,
        failed_uids: attempts ? Object.entries(attempts.uids).filter(([, r]) => r.failures > 0).map(([u]) => u).slice(0, 50) : [],
      } : {}),
      // D1 instrumentation, EVAL-ONLY so mini summaries stay byte-identical. `deadline_ms` is the
      // field V watches to confirm the deploy took; `deadline_hits` counts notes abandoned to let
      // the tick report — each stays un-done and is retried next tick, with NO lab_analyses row.
      // Eval-hardening adds `tombstoned` (this tick) and `failed_uids` (every uid carrying at least
      // one TERMINAL failure — deadline-only stragglers are deliberately absent from this list).
      ...(plan.evalMode ? {
        evalConcurrency: plan.concurrency, deadline_ms: EVAL_TICK_DEADLINE_MS,
        deadline_hits: results.filter((r) => isDeadlineErrorMessage(r.error)).length,
        tombstoned: results.filter((r) => r.tombstoned === true).length,
        failed_uids: attempts ? Object.entries(attempts.uids).filter(([, r]) => r.failures > 0).map(([u]) => u).slice(0, 50) : [],
      } : {}),
      done: doneNow, remaining: Math.max(0, st.uids.length - doneNow), results, at: new Date().toISOString(),
      ttl_breach: breach.breach, max_ms: breach.maxMs, ttl_ms: LB_LOCK_TTL_MS,
      // D3 — the fields the old summary lacked. `slice_planned` vs `slice_drained` says whether the
      // wave completed; `tick_ms` says how long one wave actually took. All three are derived from
      // values already computed above — no new work, no branch, nothing that can throw.
      tick_ms: Date.now() - tickStart, slice_planned: plan.sliceSize, slice_drained: results.length,
    };
    await setSetting(LB_KEYS.last, JSON.stringify(summary));
    return summary;
  } finally {
    await setSetting(LB_KEYS.lock, '').catch(() => {});
  }
}

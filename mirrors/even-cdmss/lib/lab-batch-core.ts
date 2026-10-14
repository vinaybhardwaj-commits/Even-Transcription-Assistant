/**
 * lib/lab-batch-core.ts — PURE helpers for the cohort-scoped Lab eval batch runner.
 * No db / no audit imports, so this stays unit-testable under --experimental-strip-types.
 * See lib/lab-batch.ts for the runtime (db + mini audit + tick).
 */

export const LB_KEYS = {
  enabled: 'lab_batch_enabled',
  experiment: 'lab_batch_experiment',
  kind: 'lab_batch_kind',
  uids: 'lab_batch_uids',            // JSON array of the cohort uids
  n: 'lab_batch_n',                  // notes per tick (clamped 1..LB_MAX_N)
  window: 'lab_batch_window',        // 'night' | 'always'
  lock: 'lab_batch_lock',            // soft-lock ISO ts
  last: 'lab_batch_last',            // last tick summary json
  error: 'lab_batch_last_error',     // last per-note error string
  evalNormativeLeg: 'lab_batch_eval_normative_leg',  // '1' ⇒ force the R-11 leg on for this eval batch
  evalModel: 'lab_batch_eval_model',                 // OpenRouter model id for eval generation ('' ⇒ mini)
  evalConcurrency: 'lab_batch_eval_concurrency',     // eval drain pool size (clamped 1..EVAL_CONCURRENCY_MAX)
  evalNormativeChannel: 'lab_batch_eval_normative_channel',  // '1' ⇒ ADDITIVE CW channel (R-11 fix candidate)
  evalRerankBackend: 'lab_batch_eval_rerank_backend',        // 'judge'|'cohere' ⇒ named rerank backend for the flip A/B ('' ⇒ today's default)
} as const;

/**
 * Soft-lock TTL for the LAB BATCH's own lock — deliberately NOT the prod mini-backfill's
 * MB_LOCK_TTL_MS, which stays at 210s and governs a different worker (decision D1).
 *
 * 900s. MEASURED 27 Jul 2026 over 38 runs of experiment `det_model_independence_mini`:
 * avg note 212.8s, max 513.7s. The previous 210s expired BEFORE the AVERAGE note finished, so a
 * cron fire during a still-running tick saw no lock, started a second tick, and both drained from a
 * `done` set the in-flight tick had not yet written — 9 duplicate rows across 38 runs, 24% of GPU
 * time bought nothing. 900s covers the observed max with ~75% headroom.
 *
 * THE NUMBER IS NOT THE FIX. This constant asserted a latency for months while lab_analyses.latency_ms
 * recorded the true one in the same database, and nothing ever compared them. ttlBreach() below is
 * the contradicting field it never had — do not remove it as redundant.
 * See CDMSS-LAB-BATCH-LOCK-PRD-AND-KICKOFF-27-JUL-2026.
 */
export const LB_LOCK_TTL_MS = 900 * 1000;
export const LB_MAX_COHORT = 2000;
// VALUE UNCHANGED at 2 (hard-listed). Only the arithmetic in this comment is corrected: it claimed
// ~72s/note, which the 27 Jul measurement puts at 212.8s avg / 513.7s max — wrong by ~3x. At 2 notes
// a tick can therefore run ~425s and has been observed at 513.7s, i.e. OVER the 300s Vercel cap the
// old comment reasoned from. Raising or lowering n is a PRD decision, not a build one; this only
// stops the file asserting a number the database disproves.
export const LB_MAX_N = 2;

// ── eval-drain constants (R-11 Phase 2, OpenRouter path ONLY — the mini caps above are untouched) ──
// VALUE UNCHANGED at 50. Its ROLE changed (D2): it is a hard CEILING on the eval slice, no longer
// the slice itself. The slice is now the concurrency (see drainPlan). At every allowed concurrency
// (1..EVAL_CONCURRENCY_MAX=25) this ceiling is slack; it binds only if the max is ever raised past 50.
export const EVAL_TICK_MAX = 50;             // ceiling on uids per tick when evalModel is set (hosted, no mini GPU)
export const EVAL_CONCURRENCY_DEFAULT = 10;  // audits in flight (OpenRouter rate-limit safety)
export const EVAL_CONCURRENCY_MAX = 25;

export function clampEvalConcurrency(v: unknown): number {
  const n = Math.floor(Number(v));
  if (!Number.isFinite(n) || n < 1) return EVAL_CONCURRENCY_DEFAULT;
  return Math.min(EVAL_CONCURRENCY_MAX, n);
}

/**
 * EVAL-ONLY (lab): the wall-clock deadline for ONE eval tick. Computed once at tick start and
 * threaded to every LLM attempt (Eval-tick-deadline PRD D1).
 *
 * ⚠️ THIS CORRECTS THE CLOSING NOTE ON `drainPlan` BELOW, which rejected a wall-clock budget as
 * "dead code asserting a protection it does not provide". That reasoning was about a budget gating
 * DISPATCHING — and it is right about that one: with one wave there is nothing left to dispatch
 * after t=0. This budget gates RETURNING AND RETRYING, which is a different mechanism. `6b12652`
 * made a failing note retry up to 3× INSIDE the tick, so a wave containing one failure runs ~3×
 * longer, exactly when the tick most needs to finish and report.
 *
 * MEASURED 27 Jul (probe `probe_r2_envelope_01`, 20 uids, evalConcurrency 6): the tick started
 * 14:22:00, wrote 5 rows by 14:26:54, then died. `app_settings.lab_batch_last` still held the 12:46
 * tick at 14:37 — the tick never completed — and `lab_batch_last_error` was EMPTY throughout,
 * because the invocation was killed mid-retry: the throw never completed, `drainOne` never caught
 * it, and the error key was never written.
 *
 * 240s leaves headroom under the observed ~300s kill. Env-overridable.
 */
export const EVAL_TICK_DEADLINE_MS = Number(process.env.EVAL_TICK_DEADLINE_MS) || 240_000;

/** Remaining budget against an absolute epoch-ms deadline, floored at 0. Pure. */
export function remainingBudgetMs(deadlineAt: number, now = Date.now()): number {
  return Math.max(0, deadlineAt - now);
}

/** Pure drain decision: how a tick drains, given the batch state. Mini (no evalModel) keeps the
 *  legacy shape EXACTLY — n≤2, serial, mini-yield honoured. Eval (evalModel set) fans out.
 *
 * ONE WAVE PER TICK (decision D1, 27 Jul 2026). The eval slice is the CONCURRENCY, not
 * EVAL_TICK_MAX. MEASURED on the live run `det_08114_25pro_seed_a` (gemini-2.5-pro, concurrency 10,
 * 178.4s mean audit): sliceSize 50 at concurrency 10 is ~890s of work inside ONE function
 * invocation. Vercel killed it at ~200–225s, so the `finally` that clears LB_KEYS.lock never ran,
 * the lock stayed set, and every subsequent cron tick skipped 'locked' for the full 900s TTL —
 * observed duty cycle 19% (bursts of ~200s separated by gaps of 848s and 704s). The corroborating
 * field: app_settings.lab_batch_last still held the 26 Jul MINI summary, i.e. no eval tick had ever
 * reached the line that writes it.
 *
 * With sliceSize == concurrency a tick dispatches exactly one wave and awaits it, so tick duration
 * is ONE audit's latency whatever the model does and the invocation cannot be killed by fan-out
 * depth. EVAL_TICK_MAX is retained as a hard CEILING (D2), not the default — it binds only if
 * concurrency is ever raised above it.
 *
 * NOT a wall-clock budget (considered, rejected): with one wave there is no dispatching after t=0,
 * so a budget would never fire — dead code asserting a protection it does not provide.
 * See CDMSS-EVAL-TICK-BUDGET-PRD-AND-KICKOFF-27-JUL-2026.
 */
export function drainPlan(st: { evalModel: string | null; evalConcurrency?: number; n: number }): {
  evalMode: boolean; sliceSize: number; concurrency: number; useMiniYield: boolean;
} {
  if (st.evalModel) {
    const concurrency = clampEvalConcurrency(st.evalConcurrency);
    return { evalMode: true, sliceSize: Math.min(EVAL_TICK_MAX, concurrency), concurrency, useMiniYield: false };
  }
  return { evalMode: false, sliceSize: st.n, concurrency: 1, useMiniYield: true };
}

/** Bounded-concurrency pool over native promises (no dep). At most `limit` tasks in flight; results
 *  index-aligned to items. `fn` must not throw for per-item error capture — wrap inside the caller. */
export async function boundedPool<T, R>(items: T[], limit: number, fn: (item: T, idx: number) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    while (true) {
      const i = next++;
      if (i >= items.length) return;
      results[i] = await fn(items[i], i);
    }
  });
  await Promise.all(workers);
  return results;
}

export interface LabBatchState {
  enabled: boolean;
  experiment: string | null;
  kind: string;
  uids: string[];
  n: number;
  window: 'night' | 'always';
  lock: string | null;
  last: Record<string, unknown> | null;
  lastError: string | null;
  evalNormativeLeg: boolean;     // lab eval: force the R-11 normative leg on
  evalModel: string | null;      // lab eval: OpenRouter model id (null ⇒ mini generation, today's path)
  evalConcurrency: number;       // lab eval: drain pool size (default EVAL_CONCURRENCY_DEFAULT)
  evalNormativeChannel: boolean; // lab eval: ADDITIVE CW channel (independent of the leg)
  /** Lab eval (rerank-flip-prep Addendum C): named rerank backend for the flip A/B. null ⇒ today's
   *  path exactly. Explicit 'cohere' inherits the strict non-falling-back behaviour downstream, so a
   *  backend failure errors rather than silently filling an arm with judge results. */
  evalRerankBackend: 'judge' | 'cohere' | null;
}

export function clampN(v: unknown): number {
  const n = Math.floor(Number(v));
  if (!Number.isFinite(n) || n < 1) return 1;
  return Math.min(LB_MAX_N, n);
}

/** Accept only short id-safe tokens (db13 Firestore-style uids); de-dupe; cap at LB_MAX_COHORT. */
export function sanitizeUids(arr: unknown): string[] {
  if (!Array.isArray(arr)) return [];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const v of arr) {
    const s = String(v ?? '').trim();
    if (!s || seen.has(s)) continue;
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(s)) continue;
    seen.add(s);
    out.push(s);
    if (out.length >= LB_MAX_COHORT) break;
  }
  return out;
}

/** Cohort minus the already-done set, order preserved. */
export function remainingUids(cohort: string[], done: Iterable<string>): string[] {
  const d = done instanceof Set ? done : new Set(done);
  return cohort.filter((u) => !d.has(u));
}

/** Pure parse of the app_settings key/value map into typed state. */
export function parseBatchState(s: Record<string, string>): LabBatchState {
  let uids: string[] = [];
  try { uids = sanitizeUids(JSON.parse(s[LB_KEYS.uids] || '[]')); } catch { uids = []; }
  let last: Record<string, unknown> | null = null;
  try { last = s[LB_KEYS.last] ? JSON.parse(s[LB_KEYS.last]) : null; } catch { last = null; }
  return {
    enabled: s[LB_KEYS.enabled] === '1',
    experiment: s[LB_KEYS.experiment] ? s[LB_KEYS.experiment] : null,
    kind: s[LB_KEYS.kind] || 'opd',
    uids,
    n: clampN(s[LB_KEYS.n] || '2'),
    window: s[LB_KEYS.window] === 'always' ? 'always' : 'night',
    lock: s[LB_KEYS.lock] || null,
    last,
    lastError: s[LB_KEYS.error] || null,
    evalNormativeLeg: s[LB_KEYS.evalNormativeLeg] === '1',   // absent ⇒ false ⇒ today's behaviour
    evalModel: s[LB_KEYS.evalModel] ? s[LB_KEYS.evalModel] : null,
    evalConcurrency: clampEvalConcurrency(s[LB_KEYS.evalConcurrency]),
    evalNormativeChannel: s[LB_KEYS.evalNormativeChannel] === '1',   // absent ⇒ false ⇒ today's assembly
    // EXACT match only (the Addendum A principle) — absent/''/anything else ⇒ null ⇒ today's path.
    // The write side (lab_batch_start) REJECTS unrecognised values loudly; this pure parse has no
    // warning channel, and the lab row's eval provenance stamp records what actually ran either way.
    evalRerankBackend: s[LB_KEYS.evalRerankBackend] === 'judge' || s[LB_KEYS.evalRerankBackend] === 'cohere'
      ? (s[LB_KEYS.evalRerankBackend] as 'judge' | 'cohere') : null,
  };
}

/**
 * Soft lock for the LAB BATCH: true if a fresher-than-LB_LOCK_TTL_MS lock exists.
 *
 * Semantics are byte-for-byte those of mini-backfill.lockHeld — absent/empty ⇒ false, unparseable ⇒
 * false, otherwise `now - t < TTL` — differing ONLY in which TTL is read. That mirroring is
 * deliberate: lab-batch.ts previously imported lockHeld from ./mini-backfill for BOTH its own lock
 * and the prod-worker busy check, so one constant silently governed two unrelated workers.
 */
export function labLockHeld(lockTs: string | null, now: Date = new Date()): boolean {
  if (!lockTs) return false;
  const t = Date.parse(lockTs);
  return Number.isFinite(t) && now.getTime() - t < LB_LOCK_TTL_MS;
}

/**
 * THE CONTRADICTING FIELD (decision D2). Observed per-note latency vs the TTL that is supposed to
 * cover it. `breach` means at least one note ran at or beyond the lock's lifetime — so the lock
 * expired mid-tick and concurrent ticks became possible, which is exactly how the 9 duplicates
 * happened.
 *
 * PURE OBSERVATION: it never blocks a tick and never throws. A non-numeric or absent `ms` is
 * ignored rather than coerced, and an empty set yields maxMs 0 ⇒ no breach.
 */
export function ttlBreach(
  results: { ms?: number }[],
  ttlMs: number = LB_LOCK_TTL_MS,
): { breach: boolean; maxMs: number } {
  let maxMs = 0;
  for (const r of results ?? []) {
    const n = Number(r?.ms);
    if (Number.isFinite(n) && n > maxMs) maxMs = n;
  }
  return { breach: maxMs >= ttlMs, maxMs };
}

/** The breach message, verbatim per PRD §5. Exported so the runtime cannot drift from the spec. */
export function ttlBreachMessage(maxMs: number, ttlMs: number): string {
  return `LOCK TTL BREACH: a note took ${maxMs}ms against LB_LOCK_TTL_MS=${ttlMs}ms.
Concurrent ticks are now possible and duplicate rows will follow.
Raise LB_LOCK_TTL_MS above observed latency.`;
}

export type BatchSkip = 'disabled' | 'no_job' | 'outside_window' | 'locked' | 'mini_busy' | null;

/** Pure gate: given state + external conditions, return the skip reason (null = run). */
export function batchGate(o: { enabled: boolean; hasJob: boolean; windowOpen: boolean; lockHeld: boolean; miniBusy: boolean }): BatchSkip {
  if (!o.enabled) return 'disabled';
  if (!o.hasJob) return 'no_job';
  if (!o.windowOpen) return 'outside_window';
  if (o.lockHeld) return 'locked';
  if (o.miniBusy) return 'mini_busy';
  return null;
}

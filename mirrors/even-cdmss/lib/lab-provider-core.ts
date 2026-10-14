/**
 * lib/lab-provider-core.ts — PURE provider resolution for F11 (three-provider model routing).
 * No db, no Next, no model clients — this decides WHICH provider a `model` string names and whether
 * a paid run is still inside its ceiling. The impure runner dispatches.
 *
 * D16 / decision 9: all three providers, plus a per-experiment paid ceiling defaulting to 250.
 *
 * ERRORS LOUD, NEVER FALLS BACK. This deliberately matches rerankBackend='cohere': an unresolvable
 * or unavailable model is a typed error, not a silent downgrade to the mini. A silent fallback would
 * make a lab result unattributable — the row would say one thing and the run would have been another
 * — and unattributable rows are exactly what F11 exists to stop (87.8% of stored lab volume turned
 * out to be paid Gemini while the tools advertised "₹0, never Gemini").
 */

// 'bedrock' added 2 Aug 2026 (PROVIDER-SWITCH PRD §4.1). ONE ARRAY ENTRY is the whole of "add a
// provider": resolveProvider's prefix parsing is already generic, so `bedrock:anthropic.claude-x`
// resolves the moment the name is here. Reachability is separate and still false until credentials
// exist (probeReachable in lib/lab-override.ts) — a provider that resolves but cannot be reached
// errors loudly rather than falling back, which is the property this module exists to hold.
export const LAB_PROVIDERS = ['ollama', 'openrouter', 'vertex', 'bedrock'] as const;
export type LabProvider = (typeof LAB_PROVIDERS)[number];

/**
 * What KIND of call this is. The classes have genuinely different shapes, and conflating them is
 * what caused both of 2 August's outages:
 *   · 'audit'     — ONE LLM LEG of an OPD note audit. Not the whole audit: see OPD_AUDIT_LEGS.
 *   · 'audit_ipd' — ONE LLM LEG of an IPD document analyze. Not the whole analyze: IPD_ANALYZE_LEGS.
 *   · 'utility'   — a short bounded call (critic, classifier, expansion). Seconds.
 *   · 'doc_read'  — a multimodal document read. Bounded separately from the analyze that follows it.
 *
 * ⚠️ 'audit_ipd' EXISTS BECAUSE IPD IS NOT OPD (DEC-A1). They were one class until 3 Aug and the
 * shared number was sized for OPD, which is the slower of the two.
 *
 * ⚠️ A CLASS BUDGET IS PER LEG, NOT PER DOCUMENT. Addendum A budgeted one leg per audit and was
 * therefore out by 3× on IPD and 2× on OPD, putting both routes over their box while appearing to
 * prove they fitted. Any route sizing itself against these numbers MUST multiply by its leg count.
 */
export type CallClass = 'audit' | 'audit_ipd' | 'utility' | 'doc_read';

/** A per-attempt ceiling and how many attempts the transport may make. */
export interface ProviderBudget { perAttemptMs: number; maxTries: number }

/**
 * THESE NUMBERS ARE MEASURED, NOT PREFERRED.
 *
 * A 110 s per-attempt constant sat in front of the OPD audit — `openrouterCreateWithRetry` overrode
 * the caller's 600 s with its own — so from 30 July, when the OpenRouter bridge went live, every
 * audit slower than 110 s aborted three times and fell through to the local model: 126 notes graded
 * by qwen2.5:14b overnight, zero by Gemini, every row still labelled `gemini-2.5-pro`. The same
 * day, the IPD worker's batch was sized against no budget at all and 504'd on every run.
 *
 * ⚠️ CORRECTION (3 Aug 2026). This note used to open "The OPD audit runs p50 267 s / p75 425 s per
 * note" and conclude the MEDIAN audit could never complete. Both halves were wrong. MEASURED on
 * v_trace_summary, `opd_note_audit` successes: 2 Aug n=869 p50 51,713 · p75 89,650 · p95 382,195;
 * 1 Aug n=857 p50 65,578 · p95 393,147; 31 Jul n=1,702 p50 69,521 · p95 309,419 · max 908,045;
 * 30 Jul n=939 p50 68,147 · p95 338,404. p50 is 52–93 s, not 267 s. THAT IS WHY THE OPD GRADER
 * MOSTLY WORKED DESPITE THE BROKEN CEILING — most notes finish inside 110 s, and the handful of
 * qwen rows plus the fat p95 are what the defect actually cost. The 267/425 pair was carried
 * between documents and never re-measured; it also appears in opd-note-audit.ts and the OPD worker
 * header and is corrected in both.
 *
 * Both failures were the same missing fact: nobody could state, as a number, how long a call of a
 * given class on a given provider is allowed to take. This table is that fact, per provider and per
 * class, in one place a route can be checked against.
 *
 * A `null` means the provider does not serve that class at all — see the ollama/doc_read note.
 *
 * ⚠️ THESE ARE COMPOSITION-DERIVED, NOT LEG-MEASURED (DEC-B8). Per-leg latency was NOT observable
 * when they were set: v_trace_summary carries only whole-trace `total_ms`, its `model_summary` was
 * null on every row sampled, and trace_events is PHI-blocked by lib/sql-guard-core.ts. So these are
 * sized top-down — pick the largest per-leg ceiling under which the FULL worst-case composition
 * still fits the route box — and then sanity-checked against whole-trace percentiles:
 *
 *   IPD   180,000 + 3 × 200,000  =  780,000  in an 800,000 box   (margin 2.5%)
 *   OPD             2 × 380,000  =  760,000  in an 800,000 box   (margin 5.0%)
 *
 *   Sanity: measured doc_audit whole-trace p95 is 250,275 ms for extract + three legs + retrieval,
 *   so a 200,000 ms ceiling PER LEG sits far above any leg's share of it. Measured opd_note_audit
 *   whole-trace p95 is 382,195 ms for retrieval + up to two legs + scoring, so a 380,000 ms
 *   ceiling per leg sits above the entire trace at p95.
 *
 * The margins are thin (2.5% and 5.0%) and the derivation is indirect, which is a known weakness,
 * not a hidden one. `v_stage_latency` (added in this same build, via /api/admin/migrate-lab-views)
 * makes the per-leg distribution queryable by stage AND by who actually answered. RE-DERIVE THESE
 * FROM IT once it holds a night of data — that is DEC-B8 and it is owed.
 */
export const PROVIDER_BUDGETS: Record<LabProvider, Record<CallClass, ProviderBudget | null>> = {
  // Local mini: one try, never retried. A local box that did not answer in the budget will not
  // answer on a second ask, and there is no spend to amortise. doc_read is NULL, not a number:
  // the mini is not multimodal, so a document read on ollama is not slow — it is IMPOSSIBLE.
  // Encoding a duration here would let a caller compute a budget for a call that cannot be made.
  // audit_ipd IS a number: the mini serves that class (the analyze leg of the Qwen backfill).
  ollama:     { audit: { perAttemptMs: 380_000, maxTries: 1 }, audit_ipd: { perAttemptMs: 200_000, maxTries: 1 }, utility: { perAttemptMs: 90_000, maxTries: 1 }, doc_read: null },
  // Cloud providers: ONE try on both audit classes. Three rungs of a 380,000 ms ladder is
  // 1,140,000 ms against an 800,000 ms box — the route could not hold its own retry policy. The
  // retry did not disappear, it moved: both workers sweep for un-audited work every tick, so the
  // SWEEP is the retry and it has a whole window of budget instead of the tail of one invocation.
  // `utility` keeps three tries: it is seconds long, nothing sizes a route against it, and it is
  // the cite-gate critic, which is dark by default.
  openrouter: { audit: { perAttemptMs: 380_000, maxTries: 1 }, audit_ipd: { perAttemptMs: 200_000, maxTries: 1 }, utility: { perAttemptMs: 110_000, maxTries: 3 }, doc_read: { perAttemptMs: 180_000, maxTries: 1 } },
  vertex:     { audit: { perAttemptMs: 380_000, maxTries: 1 }, audit_ipd: { perAttemptMs: 200_000, maxTries: 1 }, utility: { perAttemptMs: 110_000, maxTries: 3 }, doc_read: { perAttemptMs: 180_000, maxTries: 1 } },
  bedrock:    { audit: { perAttemptMs: 380_000, maxTries: 1 }, audit_ipd: { perAttemptMs: 200_000, maxTries: 1 }, utility: { perAttemptMs: 110_000, maxTries: 3 }, doc_read: { perAttemptMs: 180_000, maxTries: 1 } },
};

/**
 * The BACKOFF ALLOWANCE: the worst-case time spent sleeping BETWEEN attempts, not calling.
 *
 * Derived from the shipped curve rather than guessed. `openRouterBackoffMs` (lib/openrouter-retry.ts)
 * is `round(500 × 2^(attempt-1) × (0.5 + rand()))` with `rand()` in [0,1), so one sleep is at most
 * `750 × 2^(attempt-1)`. N tries means N−1 sleeps, and summing the geometric series gives
 * `750 × (2^(N−1) − 1)` — 0 ms at one try, 2,250 ms at three.
 *
 * It is deliberately the exact UPPER BOUND of the real curve, not a round number: a budget a route
 * is checked against must never be optimistic, and 2.25 s is small enough that being exact costs
 * nothing. If the backoff curve changes, this must change with it — they are one fact in two files.
 */
export function backoffAllowanceMs(maxTries: number): number {
  const n = Math.max(1, Math.trunc(Number(maxTries) || 1));
  return 750 * (2 ** (n - 1) - 1);
}

/**
 * THE NUMBER A ROUTE MUST FIT: worst-case wall time for one call of this class on this provider,
 * including the sleeps between retries. Null when the provider does not serve the class.
 *
 * Its ABSENCE is what caused both of today's outages — no caller could compare a call's ceiling
 * against the box it runs in, so a 110 s ceiling sat in front of a 267 s call and a ~1,530 s batch
 * sat in an 800 s route, and both were invisible until they were measured from the outside.
 */
export function totalBudgetMs(provider: LabProvider, callClass: CallClass): number | null {
  const b = PROVIDER_BUDGETS[provider]?.[callClass];
  if (!b) return null;
  return b.perAttemptMs * b.maxTries + backoffAllowanceMs(b.maxTries);
}

/**
 * PROVIDER-SWITCH master flag (Unit D, 3 Aug 2026). DEFAULT OFF, and read at CALL time so it can
 * be flipped without a redeploy.
 *
 * ⚠️ WHAT IS AND IS NOT BEHIND IT. Only two behaviour changes are: `?provider=` resolution on the
 * audit workers, and DEC-2 errors-loud (a failed provider call fails that note and writes no row,
 * instead of degrading to the local mini). The per-attempt ceiling fix, the try counts, the budget
 * threading, the batch re-sizing and the guard are NOT behind it — they are a bug fix, and a bug
 * fix parked behind an unset flag would mean the deploy changed nothing.
 *
 * With the flag OFF a terminal timeout still degrades to Ollama in lib/trace.ts. That is expected:
 * against a per-leg ceiling now well above the measured leg times, timeouts should become rare
 * rather than impossible.
 */
export function providerSwitchEnabled(): boolean {
  return process.env.PROVIDER_SWITCH_ENABLED === '1';
}

/**
 * Resolve a worker's `?provider=` argument. Accepts a BARE provider name ('openrouter') — which is
 * what a worker route takes, since the model is the engine's business, not the caller's — and also
 * a full `provider:model` string, which it hands to `resolveProvider` unchanged.
 *
 * ERRORS LOUD, NEVER FALLS BACK, exactly like `resolveProvider`: an unknown name is a typed error,
 * not a silent downgrade. A worker that quietly ran on a different provider than it was asked for
 * would produce exactly the unattributable rows this module exists to prevent.
 *
 * `null`/absent ⇒ ok with `provider: null`, meaning "the route's own default" — the caller decides.
 */
export function resolveWorkerProvider(raw: unknown, miniModel: string): { ok: true; provider: LabProvider | null } | { ok: false; error: string } {
  const s = raw === null || raw === undefined ? '' : String(raw).trim();
  if (!s) return { ok: true, provider: null };
  if (s.includes(':')) {
    const r = resolveProvider(s, miniModel);
    return r.ok ? { ok: true, provider: r.provider } : { ok: false, error: r.error };
  }
  const p = s.toLowerCase();
  if (!(LAB_PROVIDERS as readonly string[]).includes(p)) {
    return { ok: false, error: `unknown provider '${s}' — expected one of ${LAB_PROVIDERS.join(', ')}. Never falls back.` };
  }
  return { ok: true, provider: p as LabProvider };
}

/**
 * Can this provider serve this class at all? A `null` budget means NO — and the answer is REFUSE,
 * never "substitute a default". `ollama.doc_read` is the live case: the mini is not multimodal, so
 * a document read there is impossible rather than slow, and quietly giving it the module default
 * would let a route compute a budget for a call that cannot be made.
 */
export function canServe(provider: LabProvider, callClass: CallClass): boolean {
  return PROVIDER_BUDGETS[provider]?.[callClass] != null;
}

/** Decision 9 — raised only by passing it explicitly on the call. */
export const DEFAULT_PAID_CEILING = 250;

export type ProviderResolution =
  | { ok: true; provider: LabProvider; model: string; paid: boolean; raw: string }
  | { ok: false; error: string };

/**
 * Resolve a `model` argument.
 *   ollama:<name>     → local mini, free
 *   openrouter:<id>   → PAID
 *   vertex:<id>       → PAID (generation only; the Lab never writes a production audit row)
 *   unprefixed / omitted → the local mini, i.e. today's behaviour unchanged
 *
 * An unknown prefix is an ERROR rather than a fallback: "gpt5:foo" must not quietly run on Qwen and
 * be recorded as if it had run on gpt5.
 */
export function resolveProvider(model: unknown, miniModel: string): ProviderResolution {
  const raw = model === null || model === undefined ? '' : String(model).trim();
  if (!raw) return { ok: true, provider: 'ollama', model: miniModel, paid: false, raw: '' };

  const colon = raw.indexOf(':');
  if (colon < 0) {
    // Unprefixed is the documented "just use the mini" path — but a bare string that LOOKS like a
    // vendor id is far more likely a forgotten prefix than a deliberate mini run, so say so.
    if (/\//.test(raw)) {
      return { ok: false, error: `model '${raw}' has no provider prefix but looks like a vendor id — prefix it with ${LAB_PROVIDERS.map((p) => `${p}:`).join(' / ')}` };
    }
    return { ok: true, provider: 'ollama', model: raw, paid: false, raw };
  }

  const prefix = raw.slice(0, colon).toLowerCase();
  const rest = raw.slice(colon + 1).trim();
  if (!(LAB_PROVIDERS as readonly string[]).includes(prefix)) {
    return { ok: false, error: `unknown provider prefix '${prefix}' — expected one of ${LAB_PROVIDERS.join(', ')}. Never falls back to the mini.` };
  }
  if (!rest) return { ok: false, error: `model id missing after '${prefix}:'` };
  const provider = prefix as LabProvider;
  return { ok: true, provider, model: rest, paid: provider !== 'ollama', raw };
}

export type CeilingCheck =
  | { ok: true; used: number; ceiling: number; remaining: number }
  | { ok: false; error: string; used: number; ceiling: number };

/**
 * Per-experiment ceiling on NON-OLLAMA runs. Free local runs are never counted — the ceiling exists
 * to bound spend, not throughput. Exceeding it STOPS and REPORTS rather than trimming silently, so a
 * half-finished experiment is visible as half-finished.
 */
export function checkPaidCeiling(paidRunsSoFar: number, ceiling: unknown = DEFAULT_PAID_CEILING): CeilingCheck {
  const used = Math.max(0, Math.trunc(Number(paidRunsSoFar) || 0));
  const nRaw = Number(ceiling);
  const cap = Number.isFinite(nRaw) && nRaw > 0 ? Math.trunc(nRaw) : DEFAULT_PAID_CEILING;
  if (used >= cap) {
    return {
      ok: false, used, ceiling: cap,
      error: `paid-run ceiling reached for this experiment: ${used}/${cap}. STOPPED — pass a higher ceiling explicitly to continue (default ${DEFAULT_PAID_CEILING}).`,
    };
  }
  return { ok: true, used, ceiling: cap, remaining: cap - used };
}

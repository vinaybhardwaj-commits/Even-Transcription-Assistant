/**
 * lib/stt/paid-engines.ts — C1b Part B. The guard that stands between an operator and a bill.
 *
 * PRD §1.6 asks for four properties on any paid call: ATTENDED, EXPLICIT, BOUNDED, ATTRIBUTABLE.
 * This module is where the first three are enforced and the fourth is recorded.
 *
 * ─── TWO FACTS, TWO COLUMNS, ONE ANSWER EACH ───────────────────────────────────────────────────
 * WHETHER an engine costs money is `stt_engine.is_paid`. WHAT it costs is `cost_per_min_usd`.
 * Conflating them is what made the first version of this guard inert: it derived "paid" from
 * `cost_per_min_usd > 0`, and EVERY paid engine is seeded `is_paid = true, cost_per_min_usd = NULL`
 * — deepgram, sarvam, elevenlabs and ekascribe (0018_stt_engine.sql:24-38) and gemini (0073:58,
 * NULL by design because Vertex bills per token, not per minute). NULL is "an admin has not filled
 * the rate in yet" (0018:18 says so); it is not "free". So the guard read every paid engine in the
 * system as free and stopped nothing: unnamed sarvam for nine hours was allowed, unaudited.
 *
 * `lib/stt/fanout.ts` already had this right — it tests `is_paid` and falls back to a conservative
 * rate for the price. The two modules read the same NULL and reached opposite conclusions; fanout
 * was correct. The rate constant now lives HERE and fanout imports it, so there is one definition
 * of "a paid engine nobody has priced" and they cannot drift apart again.
 *
 * There is still no name list, which was the point of deriving it: a new engine is caught by its
 * own row, not by someone remembering to edit an array.
 */
import { sql } from "@/lib/db";

/**
 * The per-call ceiling for a PAID engine.
 *
 * TEN MINUTES, and the number is chosen against the accident it prevents rather than against any
 * clinical ideal. The thing a cap must make impossible is "one call quietly billed a whole day":
 * a room-day runs about eight hours, so this bounds a single mistake to roughly one fiftieth of
 * one, and an operator who genuinely wants an hour must ask for it six times and see six costs.
 * It also sits comfortably above a real consultation — a 15-minute room WINDOW is mostly silence
 * around a shorter encounter — so it refuses accidents without refusing the work.
 *
 * FREE engines are not capped by this. Whisper on the Mini costs electricity and its own queue,
 * which the step budget already bounds; a spend ceiling on it would be theatre.
 */
export const PAID_MAX_DURATION_MS = 600_000;

/**
 * The rate used for a PAID engine whose `cost_per_min_usd` nobody has filled in.
 *
 * Errs high on purpose: the job of an estimate attached to a guard is to make runaway spend
 * visible, and an unpriced engine reported as $0 is how a budget becomes a no-op. Moved here from
 * fanout.ts so both modules share one definition — they previously read the same NULL and reached
 * opposite conclusions.
 */
export const DEFAULT_PAID_RATE_USD_PER_MIN = 0.02;

export type PaidEngineInfo = {
  engine: string;
  /** From `is_paid`. The FACT of costing money. */
  paid: boolean;
  /** From `cost_per_min_usd`. NULL means unpriced, NOT free. */
  costPerMinUsd: number | null;
  /** What the estimate actually uses: the row's rate, or the conservative default for a paid row. */
  effectiveRateUsdPerMin: number | null;
  /** True when this engine is billed but nobody has told us at what rate. */
  unpriced: boolean;
};

/** The one read. `is_paid` answers "does this cost money"; the rate answers "how much". */
export async function paidEngineInfo(engineId: string): Promise<PaidEngineInfo> {
  const rows = (await sql`
    SELECT is_paid, cost_per_min_usd FROM stt_engine WHERE id = ${engineId} LIMIT 1
  `) as Array<{ is_paid: boolean | null; cost_per_min_usd: number | string | null }>;
  const row = rows[0];
  // ── AN ENGINE WITH NO `stt_engine` ROW ───────────────────────────────────────────────────────
  // The ruling is `paid := is_paid = true`, and a missing row has no is_paid, so this reports FREE
  // rather than inventing a refusal. That is a deliberate choice against my own first instinct, and
  // the reasoning is worth keeping: every ROUTED path already requires the row — `resolveRouting`
  // reads `enabled` and returns null without it, which the drain turns into a loud `no_engine` —
  // so a row-less engine is unreachable there. Failing closed here would instead have made the FREE
  // local whisper path depend on a database row it has never needed, turning a table outage into a
  // total transcription outage.
  //
  // The residual exposure is narrow and named: an engine that has a code adapter, is named
  // explicitly through the MCP, and has no registry row. It is logged so the invisible case is at
  // least visible, and flagged in the build report rather than silently accepted.
  if (!row) {
    console.warn("[stt] engine has no stt_engine row; treated as free", JSON.stringify({ engine: engineId }));
    return { engine: engineId, paid: false, costPerMinUsd: null, effectiveRateUsdPerMin: 0, unpriced: false };
  }
  const raw = row.cost_per_min_usd ?? null;
  const cost = raw === null ? null : Number(raw);
  const costPerMinUsd = cost !== null && Number.isFinite(cost) ? cost : null;
  const paid = row.is_paid === true;
  return {
    engine: engineId,
    paid,
    costPerMinUsd,
    effectiveRateUsdPerMin: paid ? (costPerMinUsd ?? DEFAULT_PAID_RATE_USD_PER_MIN) : 0,
    unpriced: paid && costPerMinUsd === null,
  };
}

/** PURE. What this call is expected to cost. The rate passed in is the EFFECTIVE one. */
export function estimateCostUsd(rateUsdPerMin: number | null, durationMs: number): number | null {
  if (rateUsdPerMin === null || !Number.isFinite(rateUsdPerMin) || rateUsdPerMin <= 0) return null;
  if (!Number.isFinite(durationMs) || durationMs <= 0) return 0;
  return Math.round((durationMs / 60_000) * rateUsdPerMin * 10_000) / 10_000;
}

export type PaidRefusal = { ok: false; error: string; engine: string; detail?: string; limit_ms?: number; duration_ms?: number };
export type PaidAllowed = { ok: true; paid: boolean; costPerMinUsd: number | null; effectiveRateUsdPerMin: number | null; unpriced: boolean; estimatedCostUsd: number | null };

/**
 * The gate. Called once, before any audio is sent anywhere.
 *
 * `explicitlyNamed` is the caller's answer to ONE question: did the request itself carry this
 * engine's name? Not the schema default, not `auto`, not a routing row — the request. A paid
 * engine reached by any of those is an unattended spend, which is exactly what §1.6 forbids, and
 * the refusal says which of them happened so the operator can see what they nearly did.
 */
export async function guardPaidEngine(opts: {
  engine: string;
  explicitlyNamed: boolean;
  durationMs: number;
}): Promise<PaidAllowed | PaidRefusal> {
  const info = await paidEngineInfo(opts.engine);
  if (!info.paid) return { ok: true, paid: false, costPerMinUsd: info.costPerMinUsd, effectiveRateUsdPerMin: 0, unpriced: false, estimatedCostUsd: null };

  if (!opts.explicitlyNamed) {
    return {
      ok: false, engine: opts.engine, error: "paid_engine_must_be_named",
      detail: "a paid engine is never reached by a default, by 'auto', or by inheriting a routing row — name it in the call",
    };
  }
  if (opts.durationMs > PAID_MAX_DURATION_MS) {
    return {
      ok: false, engine: opts.engine, error: "paid_engine_duration_cap",
      limit_ms: PAID_MAX_DURATION_MS, duration_ms: Math.round(opts.durationMs),
      detail: "one call may not bill more than the cap; ask for a shorter range",
    };
  }
  return { ok: true, paid: true, costPerMinUsd: info.costPerMinUsd, effectiveRateUsdPerMin: info.effectiveRateUsdPerMin, unpriced: info.unpriced,
           estimatedCostUsd: estimateCostUsd(info.effectiveRateUsdPerMin, opts.durationMs) };
}

/**
 * ATTRIBUTABLE — one row per paid call, written BEFORE the spend.
 *
 * Before, not after, and that is the point: a call that is billed and then crashes must still have
 * left a record of who asked for it. A best-effort write that fails never blocks the call — an
 * audit failure must not become a transcription failure — but it is logged loudly.
 */
export async function recordPaidCall(opts: {
  actor: string;
  engine: string;
  durationMs: number;
  estimatedCostUsd: number | null;
  costPerMinUsd: number | null;
  subject?: string | null;
}): Promise<void> {
  try {
    await sql`
      INSERT INTO audit_log (actor_type, actor_id, action, target_type, target_id, metadata_json)
      VALUES ('mcp', ${opts.actor}, 'stt.paid_call', 'stt_engine', ${opts.engine}, ${JSON.stringify({
        engine: opts.engine,
        duration_ms: Math.round(opts.durationMs),
        audio_minutes: Math.round((opts.durationMs / 60_000) * 1000) / 1000,
        cost_per_min_usd: opts.costPerMinUsd,
        estimated_cost_usd: opts.estimatedCostUsd,
        cap_ms: PAID_MAX_DURATION_MS,
        ...(opts.subject ? { subject: opts.subject } : {}),
      })}::jsonb)
    `;
  } catch (e) {
    console.error("[stt] paid-call audit write FAILED", JSON.stringify({
      engine: opts.engine, actor: opts.actor, err: String(e).slice(0, 160),
    }));
  }
}

/**
 * lib/stt/paid-engines.ts — C1b Part B. The guard that stands between an operator and a bill.
 *
 * PRD §1.6 asks for four properties on any paid call: ATTENDED, EXPLICIT, BOUNDED, ATTRIBUTABLE.
 * This module is where the first three are enforced and the fourth is recorded.
 *
 * ─── "PAID" IS DERIVED, NEVER TYPED ────────────────────────────────────────────────────────────
 * An engine is paid iff `stt_engine.cost_per_min_usd > 0`. There is no name list here, and adding
 * one would be the bug: the next paid engine someone adds to the registry would be free to bill
 * until a human remembered to edit an array. The column is already the leaderboard's source for
 * cost, so this reads the same fact the rest of the system reads, and a new paid engine is caught
 * by the same guard with no code change at all.
 *
 * A NULL or 0 cost means free, deliberately, and a NEGATIVE is treated as free too — neither can
 * bill anyone, and inventing a refusal for a nonsensical row would block a local engine over a
 * data-entry slip.
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

export type PaidEngineInfo = { engine: string; paid: boolean; costPerMinUsd: number | null };

/** The one read. `cost_per_min_usd > 0` is the whole definition of paid. */
export async function paidEngineInfo(engineId: string): Promise<PaidEngineInfo> {
  const rows = (await sql`
    SELECT cost_per_min_usd FROM stt_engine WHERE id = ${engineId} LIMIT 1
  `) as Array<{ cost_per_min_usd: number | string | null }>;
  const raw = rows[0]?.cost_per_min_usd ?? null;
  const cost = raw === null ? null : Number(raw);
  const costPerMinUsd = cost !== null && Number.isFinite(cost) ? cost : null;
  return { engine: engineId, paid: costPerMinUsd !== null && costPerMinUsd > 0, costPerMinUsd };
}

/** PURE. What this call is expected to cost, to the cent, or null when the rate is unknown. */
export function estimateCostUsd(costPerMinUsd: number | null, durationMs: number): number | null {
  if (costPerMinUsd === null || !Number.isFinite(costPerMinUsd) || costPerMinUsd <= 0) return null;
  if (!Number.isFinite(durationMs) || durationMs <= 0) return 0;
  return Math.round((durationMs / 60_000) * costPerMinUsd * 10_000) / 10_000;
}

export type PaidRefusal = { ok: false; error: string; engine: string; detail?: string; limit_ms?: number; duration_ms?: number };
export type PaidAllowed = { ok: true; paid: boolean; costPerMinUsd: number | null; estimatedCostUsd: number | null };

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
  if (!info.paid) return { ok: true, paid: false, costPerMinUsd: info.costPerMinUsd, estimatedCostUsd: null };

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
  return { ok: true, paid: true, costPerMinUsd: info.costPerMinUsd, estimatedCostUsd: estimateCostUsd(info.costPerMinUsd, opts.durationMs) };
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

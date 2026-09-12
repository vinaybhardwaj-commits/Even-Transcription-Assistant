/**
 * lib/stt/guarded-transcribe.ts — C1b fix-up item 3. THE CHOKEPOINT.
 *
 * WHY THIS FILE EXISTS. The paid guard used to be a call at ONE site in one MCP tool, with nine
 * paths to a transcription call in the codebase — three of which reached a paid engine without it.
 * A guard at one call site is a convention, and conventions are what this system keeps discovering
 * it did not have. This is the single function through which an `SttAdapter` is invoked, so the
 * question "can a paid engine be reached without the guard" has a mechanical answer instead of an
 * argument: not unless someone calls `adapter.transcribe` directly, which is now the one thing a
 * reviewer has to look for.
 *
 * IT DOES FOUR THINGS, IN THIS ORDER, AND THE ORDER MATTERS:
 *   1. asks whether the engine is paid — from `is_paid`, the fact, not from a price;
 *   2. refuses an unattended or over-long paid call BEFORE any audio leaves the process;
 *   3. writes the audit row BEFORE the spend, so a call that bills and then crashes still says
 *      who asked for it;
 *   4. only then calls the adapter.
 *
 * `explicitlyNamed` is the caller's answer to one question: did a PERSON name this engine in this
 * request? A routing row did not. A schema default did not. `auto` did not. Every caller passes it
 * as a literal at the call site so the answer is readable where the decision is made.
 */
import type { SttAdapter, SttTranscribeResult } from "./types";
import { guardPaidEngine, recordPaidCall, PAID_MAX_DURATION_MS, type PaidRefusal } from "./paid-engines";

export type GuardedTranscribeOk = {
  ok: true;
  result: SttTranscribeResult;
  /** What the operator is told they just spent. `paid:false` for a free engine, never a fake 0. */
  spend: { engine: string; paid: boolean; estimated_cost_usd?: number | null; cost_per_min_usd?: number | null; rate_is_default?: boolean; audio_minutes?: number };
};
export type GuardedTranscribeRefused = { ok: false; refusal: PaidRefusal & { cap_ms: number } };
export type GuardedTranscribeOutcome = GuardedTranscribeOk | GuardedTranscribeRefused;

export async function guardedTranscribe(opts: {
  adapter: SttAdapter;
  /** The `stt_engine.id` this call is billed against. Usually the adapter key; not always. */
  engineId: string;
  audio: Buffer;
  /** How much AUDIO is being sent — not the range asked for. These differ when a whole chunk is
   *  sent for a shorter window, and the billed number is the one that leaves the process. */
  durationMs: number;
  explicitlyNamed: boolean;
  actor: string;
  subject?: string | null;
  transcribeOpts: { contentType: string; language?: string; longForm?: boolean; mode?: "transcribe" | "translate"; durationMs?: number };
}): Promise<GuardedTranscribeOutcome> {
  const paid = await guardPaidEngine({
    engine: opts.engineId,
    explicitlyNamed: opts.explicitlyNamed,
    durationMs: opts.durationMs,
  });
  if (!paid.ok) return { ok: false, refusal: { ...paid, cap_ms: PAID_MAX_DURATION_MS } };

  if (paid.paid) {
    await recordPaidCall({
      actor: opts.actor,
      engine: opts.engineId,
      durationMs: opts.durationMs,
      estimatedCostUsd: paid.estimatedCostUsd,
      costPerMinUsd: paid.effectiveRateUsdPerMin,
      subject: opts.subject ?? null,
    });
  }

  const result = await opts.adapter.transcribe(opts.audio, opts.transcribeOpts);
  return {
    ok: true,
    result,
    spend: paid.paid
      ? {
          engine: opts.engineId, paid: true,
          estimated_cost_usd: paid.estimatedCostUsd,
          cost_per_min_usd: paid.costPerMinUsd,
          // Says out loud when the number is a placeholder rather than the vendor's rate.
          rate_is_default: paid.unpriced,
          audio_minutes: Math.round((opts.durationMs / 60_000) * 1000) / 1000,
        }
      : { engine: opts.engineId, paid: false },
  };
}

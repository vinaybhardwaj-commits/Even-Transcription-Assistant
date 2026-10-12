/**
 * lib/diarize-nemotron/probs-lane.ts — the PROBS lane switch (Architecture #23 follow-up, 11 Oct 2026).
 *
 * Windows stored before migration 0143 (or whose probability upload failed) have turns but no `.nlp` in R2, so Timbre cannot
 * score them. /pending re-offers them, newest first, ONLY when production has nothing to offer the box worker at that instant
 * (live intake always goes first; never to HF overflow). The stored turns are never touched: only `probs_r2_key` is set.
 *
 * NEMOTRON_PROBS_BACKFILL: unset = ON (the lane drains itself and then offers nothing); a falsy value turns it off; any other
 * value THROWS (parseFlag), and /pending then simply skips the lane rather than failing the claim.
 */
import { parseFlag } from "@/lib/flags";

export function probsBackfillEnabled(env: Record<string, string | undefined> = process.env): boolean {
  return env.NEMOTRON_PROBS_BACKFILL === undefined ? true : parseFlag("NEMOTRON_PROBS_BACKFILL", env);
}

/**
 * lib/transcript/repeat-runs-store.ts — persistence for the phrase-loop flag (0104).
 *
 * One writer, one shape: a whole window's worth of detectRepeatRuns() output, upserted in one
 * statement via unnest(). Re-running over the same (window_id, source_ref) replaces the row —
 * a turn cannot belong to two runs at once, so a later measurement simply wins (see 0104).
 */
import { sql } from "@/lib/db";
import type { RepeatRunResult } from "./repeat-runs";

export async function writeRepeatRuns(windowId: string, results: readonly RepeatRunResult[]): Promise<number> {
  if (results.length === 0) return 0;
  const sourceRefs = results.map((r) => r.source_ref);
  const inRuns = results.map((r) => r.in_run);
  const runIds = results.map((r) => r.run_id);
  const runLengths = results.map((r) => r.run_length);
  const runRanks = results.map((r) => r.run_rank);

  const rows = (await sql`
    INSERT INTO room_turn_repeat_run (window_id, source_ref, in_run, run_id, run_length, run_rank, measured_at)
    SELECT ${windowId}, s.source_ref, s.in_run, s.run_id, s.run_length, s.run_rank, NOW()
      FROM unnest(
        ${sourceRefs}::text[],
        ${inRuns}::boolean[],
        ${runIds}::text[],
        ${runLengths}::int[],
        ${runRanks}::int[]
      ) AS s(source_ref, in_run, run_id, run_length, run_rank)
    ON CONFLICT (window_id, source_ref) DO UPDATE SET
      in_run      = EXCLUDED.in_run,
      run_id      = EXCLUDED.run_id,
      run_length  = EXCLUDED.run_length,
      run_rank    = EXCLUDED.run_rank,
      measured_at = EXCLUDED.measured_at
    RETURNING source_ref
  `) as Array<{ source_ref: string }>;
  return rows.length;
}

/** One row per measured turn for a window, keyed by source_ref. Empty map = never measured. */
export async function readRepeatRuns(windowId: string): Promise<Map<string, { in_run: boolean; run_id: string | null; run_length: number; run_rank: number }>> {
  const rows = (await sql`
    SELECT source_ref, in_run, run_id, run_length, run_rank
      FROM room_turn_repeat_run
     WHERE window_id = ${windowId}
  `) as Array<{ source_ref: string; in_run: boolean; run_id: string | null; run_length: number; run_rank: number }>;
  return new Map(rows.map((r) => [r.source_ref, { in_run: r.in_run, run_id: r.run_id, run_length: r.run_length, run_rank: r.run_rank }]));
}

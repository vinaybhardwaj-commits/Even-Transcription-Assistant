/**
 * lib/transcript/repeat-runs-backfill.ts — one-shot read-and-flag pass over the existing corpus.
 *
 * NOT a re-transcribe. Reads turns the pipeline already wrote (cue, type stt_turn), runs the
 * pure detector (repeat-runs.ts), writes the flag (repeat-runs-store.ts). Touches no other table
 * and no turn's own text.
 *
 * A "window" here is any bench_window that has at least one stt_turn cue whose payload names
 * that window's own (session_id, start_ms, end_ms) — the same join shape loadWindowTurns()
 * uses in lib/stt/diarize-window.ts, minus the room_day_id leg (not every window has one set).
 */
import { sql } from "@/lib/db";
import { detectRepeatRuns, type RepeatRunTurnInput } from "./repeat-runs";
import { writeRepeatRuns } from "./repeat-runs-store";

export type BackfillWindowResult = { window_id: string; turns: number; flagged: number };
export type BackfillSummary = {
  windows_considered: number;
  windows_with_turns: number;
  turns_total: number;
  turns_flagged: number;
  per_window: BackfillWindowResult[];
};

async function listCandidateWindows(): Promise<Array<{ window_id: string; session_id: string; start_ms: number; end_ms: number }>> {
  const rows = (await sql`
    SELECT bw.id AS window_id, bw.session_id, bw.start_ms, bw.end_ms
      FROM bench_window bw
     WHERE EXISTS (
       SELECT 1 FROM cue c
        WHERE c.type = 'stt_turn'
          AND c.session_id = bw.session_id
          AND (c.payload->'window'->>'start_ms')::bigint = bw.start_ms
          AND (c.payload->'window'->>'end_ms')::bigint = bw.end_ms
     )
     ORDER BY bw.start_ms
  `) as Array<{ window_id: string; session_id: string; start_ms: string | number; end_ms: string | number }>;
  return rows.map((r) => ({ window_id: r.window_id, session_id: r.session_id, start_ms: Number(r.start_ms), end_ms: Number(r.end_ms) }));
}

async function loadWindowTurnsForBackfill(sessionId: string, startMs: number, endMs: number): Promise<RepeatRunTurnInput[]> {
  const rows = (await sql`
    SELECT source_ref, payload->>'text' AS text, (payload->>'start_ms')::bigint AS start_ms
      FROM cue
     WHERE type = 'stt_turn'
       AND session_id = ${sessionId}
       AND (payload->'window'->>'start_ms')::bigint = ${startMs}
       AND (payload->'window'->>'end_ms')::bigint = ${endMs}
       AND source_ref IS NOT NULL
       AND payload->>'text' IS NOT NULL
     ORDER BY (payload->>'start_ms')::bigint
  `) as Array<{ source_ref: string; text: string; start_ms: string | number }>;
  return rows.map((r) => ({ source_ref: r.source_ref, text: r.text }));
}

/** Runs the detector over every candidate window and persists the flags. Idempotent. */
export async function backfillRepeatRuns(): Promise<BackfillSummary> {
  const windows = await listCandidateWindows();
  const perWindow: BackfillWindowResult[] = [];
  let turnsTotal = 0;
  let turnsFlagged = 0;

  for (const w of windows) {
    const turns = await loadWindowTurnsForBackfill(w.session_id, w.start_ms, w.end_ms);
    if (turns.length === 0) {
      perWindow.push({ window_id: w.window_id, turns: 0, flagged: 0 });
      continue;
    }
    const results = detectRepeatRuns(turns);
    const flagged = results.filter((r) => r.in_run).length;
    await writeRepeatRuns(w.window_id, results);
    perWindow.push({ window_id: w.window_id, turns: turns.length, flagged });
    turnsTotal += turns.length;
    turnsFlagged += flagged;
  }

  return {
    windows_considered: windows.length,
    windows_with_turns: perWindow.filter((w) => w.turns > 0).length,
    turns_total: turnsTotal,
    turns_flagged: turnsFlagged,
    per_window: perWindow,
  };
}

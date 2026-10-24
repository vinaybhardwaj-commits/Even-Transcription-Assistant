/**
 * Reader spine_transcript — SPINE S7a: the room-table reads of the `transcript_final` stage. lib/spine holds no room-table SQL text of its own.
 *
 *  - readCoveringWindows: the grid-aligned bench windows of one encounter's room-day that overlap [t_open, t_close], with their state, their stored ROUTE run (engine = 'route', no error) and the drain's own
 *    marks (an open room_window job, the last refusal). Metadata only: no text column. A window with ANY held-out placement is dropped and only COUNTED (lib/room-access/check windowsBlindAny). A window with no
 *    room_day cannot be placed and is not returned (fail closed). The caller refuses a blind room-day itself, before it calls this.
 *  - readRunTexts: the text of named route runs. Called only once every covering window is terminal; the caller never logs it.
 *  - markWindowOffered: the one write, the drain's own refusal mark (see its comment).
 */
import { sql } from "@/lib/db";
import { ROOM_WINDOW_KIND } from "@/lib/jobs/kinds/room-window-kind";
import { windowsBlindAny } from "@/lib/room-access/check";
import { FINAL_ENGINE, type CoveringWindow, type RunText } from "@/lib/spine/transcript-final";

const ms = (v: unknown): number | null => (v === null || v === undefined ? null : Number.isNaN(Date.parse(String(v))) ? null : Date.parse(String(v)));

export async function readCoveringWindows(a: { room_id: string; ist_date: string; t_open_ms: number; t_close_ms: number }): Promise<{ windows: CoveringWindow[]; blind_excluded: number }> {
  const rows = (await sql`
    SELECT w.id, w.start_ms::float8 AS start_ms, w.end_ms::float8 AS end_ms, w.source_mic, w.state, w.closed_at, w.auto_drain_refused_at, w.auto_drain_refused_reason,
           EXISTS (SELECT 1 FROM scribe_job j WHERE j.kind = ${ROOM_WINDOW_KIND} AND j.args->>'window_id' = w.id AND j.status IN ('queued', 'running')) AS job_open,
           r.id AS run_id, r.created_at AS run_at
      FROM bench_window w
      JOIN bench_session s ON s.id = w.session_id
      JOIN room_day rd ON rd.id = w.room_day_id
      LEFT JOIN LATERAL (
        SELECT id, created_at FROM transcription_run
         WHERE subject_type = 'bench_window' AND subject_id = w.id AND engine = ${FINAL_ENGINE} AND error IS NULL
         ORDER BY created_at DESC, id DESC LIMIT 1
      ) r ON TRUE
     WHERE s.room_id = ${a.room_id}::text AND rd.room_id = ${a.room_id}::text AND rd.ist_date = ${a.ist_date}::date
       AND w.grid_aligned = TRUE
       AND w.start_ms < ${a.t_close_ms}::float8 AND w.end_ms > ${a.t_open_ms}::float8
     ORDER BY w.start_ms, w.source_mic, w.id
  `) as Array<Record<string, unknown>>;
  const blind = await windowsBlindAny(rows.map((r) => String(r.id)));
  const kept = rows.filter((r) => !blind.has(String(r.id)));
  return {
    blind_excluded: rows.length - kept.length,
    windows: kept.map((r) => ({
      id: String(r.id), start_ms: Number(r.start_ms), end_ms: Number(r.end_ms), source_mic: String(r.source_mic), state: String(r.state),
      run_id: r.run_id == null ? null : String(r.run_id), run_at_ms: ms(r.run_at), closed_at_ms: ms(r.closed_at),
      refused_at_ms: ms(r.auto_drain_refused_at), refused_reason: r.auto_drain_refused_reason == null ? null : String(r.auto_drain_refused_reason),
      job_open: r.job_open === true,
    })),
  };
}

export async function readRunTexts(runIds: readonly string[]): Promise<RunText[]> {
  if (runIds.length === 0) return [];
  const rows = (await sql`
    SELECT id, subject_id, engine, transcript_original, transcript_english FROM transcription_run
     WHERE id = ANY(${[...runIds]}::text[]) AND subject_type = 'bench_window' AND error IS NULL
  `) as Array<Record<string, unknown>>;
  return rows.map((r) => ({
    run_id: String(r.id), window_id: String(r.subject_id), engine: String(r.engine),
    original: r.transcript_original == null ? null : String(r.transcript_original), english: r.transcript_english == null ? null : String(r.transcript_english),
  }));
}

/**
 * The refusal mark the auto-drain itself writes after it offers a window (lib/stt/auto-drain.ts): cleared on `enqueued`, else the drain's step name and the time. It paces the next offer (the cooldown) and
 * keeps this stage and the auto-drain from re-offering the same refused window on every tick. No other room column is written here.
 */
export async function markWindowOffered(windowId: string, step: string): Promise<void> {
  if (step === "enqueued") await sql`UPDATE bench_window SET auto_drain_refused_at = NULL, auto_drain_refused_reason = NULL WHERE id = ${windowId}`;
  else await sql`UPDATE bench_window SET auto_drain_refused_at = NOW(), auto_drain_refused_reason = ${step} WHERE id = ${windowId}`;
}

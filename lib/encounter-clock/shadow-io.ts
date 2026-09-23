/**
 * lib/encounter-clock/shadow-io.ts — the only part of the E-shadow run that touches a database.
 *
 * READS: bench_chunk (the recorded day and the tape-off gaps), bench_window joined to
 * transcription_run (the text ALREADY STORED and the timeline that places it), and the level log
 * through readRoomLevelDay — the same aggregator GET /api/admin/bench/levels uses, so the energy the
 * gate sees is the energy the admin card shows.
 *
 * WRITES: writeHypothesisRun, and nothing else, ever. The E-5 store's own one-statement insert is the
 * single write in this path; no note, encounter, room_day or cue row is touched, and a test asserts
 * that every write statement this module causes names an encounter_hypothesis table.
 *
 * NO STT. Windows without a stored transcript contribute no text, and their probes come back
 * `unjudged` by the gate's own rule.
 *
 * APPEND, NOT REPLACE. The E-5 store is append-only by design ("a rerun is a new run"), so a rerun
 * writes a NEW run and the previous one stays as history; `supersedes` names the run this one
 * displaces for readers, who take the latest. Fable's order asked for replacement — flagged in the
 * report rather than decided here, because deleting rows would contradict a store the Refuter has
 * already passed.
 */
import { sql } from "@/lib/db";
import { readRoomLevelDay } from "@/lib/bench-levels";
import { writeHypothesisRun, readLatestRun, type WriteRunResult } from "@/lib/encounter-hypotheses";
import { runShadow, type DayEvidence, type ShadowSummary, type ShadowWindow } from "@/lib/encounter-clock/shadow";
import type { TapeOff } from "@/lib/encounter-clock/smooth";
import type { TimelineSpan } from "@/lib/encounter-clock/gate";

/** Chunks closer together than this are one continuous tape; a wider gap is tape-off. */
export const TAPE_GAP_MS = 5_000;

type ChunkRow = { started_at: string | Date; ended_at: string | Date | null };
type WindowRow = { start_ms: string | number; end_ms: string | number; txt: string | null; lt: unknown };

const ms = (v: string | Date | null): number | null => (v === null ? null : new Date(v).getTime());

/** The recorded day and its tape-off gaps, from chunk timestamps alone. */
export function tapeFromChunks(rows: ChunkRow[]): { day_start_ms: number; day_end_ms: number; tape_off: TapeOff[] } | null {
  const spans = rows
    .map((r) => ({ a: ms(r.started_at)!, b: ms(r.ended_at) }))
    .filter((x) => Number.isFinite(x.a))
    .map((x) => ({ a: x.a, b: x.b !== null && x.b > x.a ? x.b : x.a }))
    .sort((p, q) => p.a - q.a);
  if (!spans.length) return null;
  const on: Array<[number, number]> = [];
  for (const s of spans) {
    const last = on[on.length - 1];
    if (last && s.a - last[1] <= TAPE_GAP_MS) last[1] = Math.max(last[1], s.b);
    else on.push([s.a, s.b]);
  }
  const tape_off: TapeOff[] = [];
  for (let i = 0; i < on.length - 1; i++) tape_off.push({ start_ms: on[i][1], end_ms: on[i + 1][0] });
  return { day_start_ms: on[0][0], day_end_ms: on[on.length - 1][1], tape_off };
}

/** The timeline spans as stored, or null when the run carries none (a window we cannot place). */
export function timelineOf(lt: unknown): TimelineSpan[] | null {
  const raw = typeof lt === "string" ? safeJson(lt) : lt;
  const spans = (raw as { spans?: unknown } | null)?.spans;
  if (!Array.isArray(spans)) return null;
  const out: TimelineSpan[] = [];
  for (const s of spans) {
    const x = s as { start_s?: unknown; end_s?: unknown; chars?: unknown };
    if (typeof x.start_s !== "number" || typeof x.end_s !== "number" || typeof x.chars !== "number") continue;
    out.push({ start_s: x.start_s, end_s: x.end_s, chars: x.chars });
  }
  return out.length ? out : null;
}

const safeJson = (s: string): unknown => { try { return JSON.parse(s); } catch { return null; } };

export async function loadDayEvidence(roomId: string, roomDayId: string, istDate: string): Promise<DayEvidence | null> {
  const chunks = (await sql`
    SELECT c.started_at, c.ended_at
      FROM bench_chunk c
     WHERE coalesce(c.source, 'primary') = 'primary'
       AND c.session_id IN (SELECT DISTINCT session_id FROM bench_window WHERE room_day_id = ${roomDayId})
     ORDER BY c.started_at ASC
  `) as ChunkRow[];
  const tape = tapeFromChunks(chunks);
  if (!tape) return null;

  const rows = (await sql`
    SELECT DISTINCT ON (w.id)
           w.start_ms, w.end_ms,
           t.transcript_original AS txt,
           t.metrics_json -> 'language_timeline' AS lt
      FROM bench_window w
      JOIN transcription_run t
        ON t.subject_type = 'bench_window' AND t.subject_id = w.id
     WHERE w.room_day_id = ${roomDayId}
       AND coalesce(t.transcript_original, '') <> ''
     ORDER BY w.id, t.created_at DESC
  `) as WindowRow[];
  const windows: ShadowWindow[] = rows.map((r) => ({
    start_ms: Number(r.start_ms), end_ms: Number(r.end_ms),
    text: r.txt ?? "", timeline: timelineOf(r.lt),
  }));

  const levels = await readRoomLevelDay(roomId, istDate);
  return {
    room_day_id: roomDayId,
    day_start_ms: tape.day_start_ms, day_end_ms: tape.day_end_ms,
    tape_off: tape.tape_off, level_samples: levels.samples, windows,
  };
}

export type ShadowRunResult =
  | { ok: true; run_id: string; supersedes: string | null; summary: ShadowSummary }
  | { ok: false; error: "no_recorded_audio" | "write_refused"; detail?: unknown };

/** Run the clock over one room-day and store the result. The ONLY write is the E-5 insert. */
export async function runShadowForRoomDay(input: { room_id: string; room_day_id: string; ist_date: string }): Promise<ShadowRunResult> {
  const evidence = await loadDayEvidence(input.room_id, input.room_day_id, input.ist_date);
  if (!evidence) return { ok: false, error: "no_recorded_audio" };
  const { run, summary } = runShadow(evidence);
  const previous = await readLatestRun(input.room_day_id);
  const written: WriteRunResult = await writeHypothesisRun(run);
  if (!written.ok) return { ok: false, error: "write_refused", detail: written.problems };
  return { ok: true, run_id: written.run_id, supersedes: previous.run?.id ?? null, summary };
}

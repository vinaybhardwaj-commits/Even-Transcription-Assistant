/**
 * Reader turns — S7-0. A window's whisper turns (cue type stt_turn) with the diarizer's speaker for each (room_turn_speaker) and, when diarize ran, the window's row state.
 *
 * THE TURN-TEXT KEY (the open question in the spec): the ONLY text key on an `stt_turn` cue's payload is `text`, in the language ASR produced (never English per turn);
 * the turn's times are `payload.start_ms` / `payload.end_ms`, and `payload.window.{start_ms,end_ms}` are the bounds of the window it belongs to (lib/stt/diarize-window.ts
 * loadWindowTurns, lib/jobs/kinds/jev-role.ts). The join to room_turn_speaker is (window_id, source_ref). Text is selected ONLY with includeText.
 * A turn with no room_turn_speaker row was never attributed (no overlap with any speaker); a clinician's role is `role = 'clinician'` (an enrolled voiceprint matched).
 */
import { sql } from "@/lib/db";
import { blindGuardWindow, refuse, type ReadResult } from "@/lib/room-access/readers/common";

export type Turn = { source_ref: string; start_ms: number; end_ms: number; speaker_idx: number | null; role: string | null; overlap_ms: number | null; text?: string | null };
export type WindowTurns = { window_id: string; room_day_id: string; start_ms: number; end_ms: number; diarize_state: string | null; turns: Turn[]; attributed: number };

export async function readWindowTurns(windowId: string, opts: { includeText?: boolean } = {}): Promise<ReadResult<WindowTurns>> {
  if (!/^[A-Za-z0-9_-]{1,80}$/.test(windowId)) return refuse("bad_unit_key");
  const blind = await blindGuardWindow(windowId); // BEFORE the cues are read
  if (blind) return blind;
  const w = (await sql`SELECT id, room_day_id, start_ms, end_ms FROM bench_window WHERE id = ${windowId}::text LIMIT 1`) as Array<{ id: string; room_day_id: string | null; start_ms: string | number; end_ms: string | number }>;
  if (!w[0]) return refuse("not_found", "no such window");
  const startMs = Number(w[0].start_ms), endMs = Number(w[0].end_ms);
  const rows = (opts.includeText
    ? await sql`
        SELECT c.source_ref, (c.payload->>'start_ms')::bigint AS s, (c.payload->>'end_ms')::bigint AS e, t.speaker_idx, t.role, t.overlap_ms, c.payload->>'text' AS text
          FROM cue c LEFT JOIN room_turn_speaker t ON t.window_id = ${windowId}::text AND t.source_ref = c.source_ref
         WHERE c.room_day_id = ${w[0].room_day_id}::text AND c.type = 'stt_turn' AND c.source_ref IS NOT NULL
           AND (c.payload->'window'->>'start_ms')::bigint = ${startMs}::bigint AND (c.payload->'window'->>'end_ms')::bigint = ${endMs}::bigint
         ORDER BY (c.payload->>'start_ms')::bigint, c.source_ref`
    : await sql`
        SELECT c.source_ref, (c.payload->>'start_ms')::bigint AS s, (c.payload->>'end_ms')::bigint AS e, t.speaker_idx, t.role, t.overlap_ms, NULL::text AS text
          FROM cue c LEFT JOIN room_turn_speaker t ON t.window_id = ${windowId}::text AND t.source_ref = c.source_ref
         WHERE c.room_day_id = ${w[0].room_day_id}::text AND c.type = 'stt_turn' AND c.source_ref IS NOT NULL
           AND (c.payload->'window'->>'start_ms')::bigint = ${startMs}::bigint AND (c.payload->'window'->>'end_ms')::bigint = ${endMs}::bigint
         ORDER BY (c.payload->>'start_ms')::bigint, c.source_ref`) as Array<{ source_ref: string; s: string | number; e: string | number; speaker_idx: number | null; role: string | null; overlap_ms: number | null; text: string | null }>;
  const dz = (await sql`SELECT state FROM room_diarize_window WHERE window_id = ${windowId}::text LIMIT 1`) as Array<{ state: string }>;
  const turns: Turn[] = rows
    .map((r) => ({ source_ref: r.source_ref, start_ms: Number(r.s), end_ms: Number(r.e), speaker_idx: r.speaker_idx === null ? null : Number(r.speaker_idx), role: r.role, overlap_ms: r.overlap_ms === null ? null : Number(r.overlap_ms), ...(opts.includeText ? { text: r.text } : {}) }))
    .filter((t) => Number.isFinite(t.start_ms) && Number.isFinite(t.end_ms) && t.end_ms > t.start_ms);
  return { ok: true, data: { window_id: windowId, room_day_id: w[0].room_day_id!, start_ms: startMs, end_ms: endMs, diarize_state: dz[0]?.state ?? null, turns, attributed: turns.filter((t) => t.speaker_idx !== null).length } };
}

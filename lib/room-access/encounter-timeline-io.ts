/**
 * lib/room-access/encounter-timeline-io.ts — the reads of the pre-STT timeline run (epic #23, ticket f). READ-ONLY.
 *
 * Reads bench_chunk (the recorded day and its tape-off gaps), the level log (readRoomLevelDay), and the stored
 * Nemotron rows (diarize_nemotron_window, status ok|empty, latest per window) with the identity pass's speaker rows
 * (diarize_nemotron_speaker). It lives in lib/room-access/ because it names bench_window and the room tables.
 * No transcript is read: the run is pre-STT by design, and a timeline state never carries text.
 *
 * Held-out windows (any placement) are left out and counted, as every other evidence loader does.
 */
import { sql } from "@/lib/db";
import { readRoomLevelDay } from "@/lib/bench-levels";
import type { BenchLevelSample } from "@/lib/bench-levels";
import { tapeFromChunks, dayIsComplete } from "@/lib/room-access/encounter-shadow-io";
import { splitBlindWindows } from "@/lib/room-access/jobs";
import type { TapeOff } from "@/lib/encounter-clock/smooth";
import type { TimelineWindow, TimelineTurn } from "@/lib/encounter-clock/timeline";

/** What the identity pass said about one speaker of one stored row. */
export type SpeakerIdentity = {
  /** pulse_room set, decision 'match': the Pulse doctor uid the speaker matched. */
  pulse_doctor_uid: string | null;
  /** voice_print set, attribution 'voiceprint': the matched clinician and its cosine. */
  clinician_id: string | null;
  match_confidence: number | null;
  speech_ms: number;
};

export type TimelineEvidence = {
  room_day_id: string;
  day_start_ms: number;
  day_end_ms: number;
  tape_off: TapeOff[];
  level_samples: BenchLevelSample[];
  windows: TimelineWindow[];
  /** window_id → speaker_idx → identity. Absent = the pass has not run for that row. */
  identity: Map<string, Map<number, SpeakerIdentity>>;
  day_complete: boolean;
  n_blind_excluded: number;
};

type NemoRow = { id: string | number; window_id: string; start_ms: string | number; audio_ms: string | number; turns_json: unknown };
type SpkRow = {
  window_row_id: string | number; centroid_set: string; speaker_label: string; speech_ms: number;
  clinician_id: string | null; match_confidence: number | null; decision: string | null; pulse_doctor_uid: string | null;
};

/** PURE — `spkN` → N, or null. */
export function speakerIdx(label: unknown): number | null {
  const m = typeof label === "string" ? /^spk(\d{1,2})$/.exec(label) : null;
  return m ? Number(m[1]) : null;
}

/** PURE — a stored turns_json ([[start_ms, end_ms, "spkN"], …], clip-relative) as timeline turns; malformed entries skipped. */
export function turnsOf(raw: unknown): TimelineTurn[] {
  const arr = typeof raw === "string" ? (() => { try { return JSON.parse(raw); } catch { return null; } })() : raw;
  if (!Array.isArray(arr)) return [];
  const out: TimelineTurn[] = [];
  for (const t of arr) {
    if (!Array.isArray(t) || t.length < 3) continue;
    const [a, b, label] = t as [unknown, unknown, unknown];
    const idx = speakerIdx(label);
    if (typeof a !== "number" || typeof b !== "number" || !Number.isFinite(a) || !Number.isFinite(b) || !(b > a) || idx === null) continue;
    out.push({ start_ms: a, end_ms: b, speaker_idx: idx });
  }
  return out;
}

export async function loadTimelineEvidence(roomId: string, roomDayId: string, istDate: string, now: Date = new Date()): Promise<TimelineEvidence | null> {
  const chunks = (await sql`
    SELECT c.started_at, c.ended_at
      FROM bench_chunk c
     WHERE coalesce(c.source, 'primary') = 'primary'
       AND c.session_id IN (SELECT DISTINCT session_id FROM bench_window WHERE room_day_id = ${roomDayId})
     ORDER BY c.started_at ASC
  `) as Array<{ started_at: string | Date; ended_at: string | Date | null }>;
  const tape = tapeFromChunks(chunks);
  if (!tape) return null;

  const rows = (await sql`
    SELECT DISTINCT ON (n.window_id) n.id, n.window_id, w.start_ms, n.audio_ms, n.turns_json
      FROM diarize_nemotron_window n
      JOIN bench_window w ON w.id = n.window_id
     WHERE w.room_day_id = ${roomDayId} AND n.status IN ('ok', 'empty') AND n.audio_ms > 0
     ORDER BY n.window_id, n.received_at DESC, n.id DESC
  `) as NemoRow[];
  const { kept, excluded } = await splitBlindWindows(rows, (r) => r.window_id);

  const windows: TimelineWindow[] = kept.map((r) => ({
    window_id: r.window_id,
    origin_ms: Number(r.start_ms),
    window_end_ms: Number(r.start_ms) + Number(r.audio_ms),
    turns: turnsOf(r.turns_json),
  }));

  const identity = new Map<string, Map<number, SpeakerIdentity>>();
  if (kept.length) {
    const ids = kept.map((r) => Number(r.id));
    const spk = (await sql`
      SELECT s.window_row_id, s.centroid_set, s.speaker_label, s.speech_ms, s.clinician_id, s.match_confidence,
             s.decision, s.pulse_doctor_uid
        FROM diarize_nemotron_speaker s
       WHERE s.window_row_id = ANY(${ids}::bigint[])
         AND s.centroid_set IN ('voice_print', 'pulse_room')
    `) as SpkRow[];
    const windowOfRow = new Map(kept.map((r) => [Number(r.id), r.window_id]));
    for (const s of spk) {
      const wid = windowOfRow.get(Number(s.window_row_id));
      const idx = speakerIdx(s.speaker_label);
      if (!wid || idx === null) continue;
      const per = identity.get(wid) ?? new Map<number, SpeakerIdentity>();
      const cur = per.get(idx) ?? { pulse_doctor_uid: null, clinician_id: null, match_confidence: null, speech_ms: Number(s.speech_ms) };
      if (s.centroid_set === "pulse_room" && s.decision === "match") cur.pulse_doctor_uid = s.pulse_doctor_uid;
      if (s.centroid_set === "voice_print" && s.clinician_id) { cur.clinician_id = s.clinician_id; cur.match_confidence = s.match_confidence; }
      per.set(idx, cur);
      identity.set(wid, per);
    }
  }

  const levels = await readRoomLevelDay(roomId, istDate);
  return {
    room_day_id: roomDayId,
    day_start_ms: tape.day_start_ms, day_end_ms: tape.day_end_ms, tape_off: tape.tape_off,
    level_samples: levels.samples, windows, identity,
    day_complete: dayIsComplete(istDate, tape.day_end_ms, now),
    n_blind_excluded: excluded,
  };
}

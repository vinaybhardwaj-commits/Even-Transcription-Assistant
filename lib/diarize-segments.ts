/**
 * lib/diarize-segments.ts — speaker TIMINGS for one encounter, one room window, or one bench session,
 * with no text. The doctor-ID feed (plan §D): a caller that needs "when did each voice speak" to cut
 * solo clips or to score a voiceprint must not be handed "what was said" to get it.
 *
 * READS ONLY WHAT IS ALREADY STORED. No migration, no diarize call:
 *   · phone encounters → encounter.transcript_segments + encounter.speakers (0007), written by the
 *     encounter process route from the diarize service's answer. Times are relative to the recording.
 *   · room windows     → room_diarize_window.segments_json + speakers_json (0074), written only by
 *     recordDiarizeWindow. Times are relative to the window's clip; bench_window.start_ms is the
 *     clip's t=0 on the wall clock (the same addition lib/stt/diarize-window.ts makes).
 *
 * THE PAYLOAD IS BUILT FIELD BY FIELD, NEVER SPREAD FROM A ROW. Both stores hold more than timings:
 * speakers carry an ECAPA embedding (biometric) and the service's heuristic label/type (which can read
 * like an attribution), and a segment object could carry any key a future service version adds.
 * Nothing from a stored object reaches the output unless it is named below and has the expected type.
 * speaker_label is therefore NEUTRAL (`S0`, `S1`, … from the index), never the stored label.
 *
 * `source` names WHICH DIARIZER PRODUCED THE TIMINGS, because two diarizers do not agree at speaker
 * switches (the 19 Sep arm64/x86_64 ruling) and this route is the doctor-ID feed. The writers record
 * that as `producer` on the timing JSON (`{worker, arch, platform, service_device, worker_version,
 * host}`; 859 room windows carry it). `source` is `<worker>/<arch>` from it, e.g. `night-drain/arm64`.
 * A row with no producer (534 room windows, and every encounter so far) was written by the app
 * against the Mini's eta-diarize, and says `eta-diarize`.
 */
import { sql } from "@/lib/db";

export const DIARIZE_SOURCE_DEFAULT = "eta-diarize";
export const SESSION_WINDOW_LIMIT_DEFAULT = 100;
export const SESSION_WINDOW_LIMIT_MAX = 500;

export type SpeakerTiming = {
  speaker_idx: number;
  speaker_label: string;
  /** Present only where the diarize service matched an enrolled voiceprint. An id, never a name. */
  matched_clinician_id?: string;
  confidence?: number;
  total_speech_ms?: number;
};

export type SegmentTiming = {
  start_ms: number;
  end_ms: number;
  speaker_idx: number;
  speaker_label: string;
  source: string;
  /** True where the service marked this span as overlapped speech (two voices at once). */
  overlap: boolean;
  /** The speaker's voiceprint-match confidence, only where that speaker was matched. */
  confidence?: number;
};

export type EncounterSegments = {
  kind: "encounter";
  encounter_id: string;
  doctor_id: string | null;
  recorded_at: string | null;
  duration_seconds: number | null;
  diarize_status: string | null;
  diarized_at: string | null;
  /** Segment times are ms from the start of the recording. */
  clock: "recording_relative";
  source: string;
  speakers: SpeakerTiming[];
  segments: SegmentTiming[];
};

export type WindowSegments = {
  kind: "window";
  window_id: string;
  session_id: string | null;
  room_day_id: string | null;
  source_mic: string | null;
  diarize_state: string | null;
  diarized_at: string | null;
  /** Wall-clock epoch ms of the clip's t=0 (bench_window.start_ms). Add it to a segment for wall time. */
  origin_ms: number | null;
  window_end_ms: number | null;
  /** Segment times are ms from the start of the window's clip. */
  clock: "clip_relative";
  segments_run_id: string | null;
  /** True when the stored segments came from an older run than the window's last (0099). */
  segments_stale: boolean;
  source: string;
  speakers: SpeakerTiming[];
  segments: SegmentTiming[];
};

export type SessionSegments = {
  kind: "session";
  session_id: string;
  windows: WindowSegments[];
  truncated: boolean;
};

export type SegmentsPayload = EncounterSegments | WindowSegments | SessionSegments;

export type SegmentsQuery = {
  encounter_id?: string | null;
  window_id?: string | null;
  session_id?: string | null;
  limit?: number | null;
};

export type SegmentsLookup =
  | { ok: true; payload: SegmentsPayload }
  | { ok: false; status: 400 | 404; error: "one_id_required" | "bad_id" | "not_found" };

// ---------------------------------------------------------------------------
// PURE shaping
// ---------------------------------------------------------------------------

const finite = (v: unknown): number | null => {
  const n = typeof v === "number" ? v : typeof v === "string" && v.trim() !== "" ? Number(v) : NaN;
  return Number.isFinite(n) ? n : null;
};

const idxOf = (v: unknown): number | null => {
  const n = finite(v);
  return n !== null && Number.isInteger(n) && n >= 0 ? n : null;
};

export const speakerLabel = (idx: number): string => `S${idx}`;

/** PURE — the stored speakers array → whitelisted timings. Embedding, label, type and names never pass. */
export function shapeSpeakers(raw: unknown): SpeakerTiming[] {
  if (!Array.isArray(raw)) return [];
  const out: SpeakerTiming[] = [];
  const seen = new Set<number>();
  for (const item of raw) {
    if (typeof item !== "object" || item === null || Array.isArray(item)) continue;
    const o = item as Record<string, unknown>;
    const idx = idxOf(o.idx ?? o.speaker_idx);
    if (idx === null || seen.has(idx)) continue;
    seen.add(idx);
    const sp: SpeakerTiming = { speaker_idx: idx, speaker_label: speakerLabel(idx) };
    const cid = o.clinician_id;
    if (typeof cid === "string" && /^[A-Za-z0-9_-]{1,64}$/.test(cid)) {
      sp.matched_clinician_id = cid;
      const conf = finite(o.confidence);
      if (conf !== null) sp.confidence = conf;
    }
    const speech = finite(o.total_speech_sec);
    if (speech !== null && speech >= 0) sp.total_speech_ms = Math.round(speech * 1000);
    out.push(sp);
  }
  return out.sort((a, b) => a.speaker_idx - b.speaker_idx);
}

/** PURE — the stored segments array → whitelisted timings, dropping anything unreadable individually. */
export function shapeSegments(raw: unknown, speakers: readonly SpeakerTiming[], source: string): SegmentTiming[] {
  if (!Array.isArray(raw)) return [];
  const confByIdx = new Map<number, number>();
  for (const s of speakers) if (s.confidence !== undefined) confByIdx.set(s.speaker_idx, s.confidence);
  const out: SegmentTiming[] = [];
  for (const item of raw) {
    if (typeof item !== "object" || item === null || Array.isArray(item)) continue;
    const o = item as Record<string, unknown>;
    const start = finite(o.start_ms);
    const end = finite(o.end_ms);
    const idx = idxOf(o.speaker_idx);
    if (start === null || end === null || end <= start || start < 0 || idx === null) continue;
    const seg: SegmentTiming = {
      start_ms: Math.round(start),
      end_ms: Math.round(end),
      speaker_idx: idx,
      speaker_label: speakerLabel(idx),
      source,
      overlap: o.overlap === true,
    };
    const conf = confByIdx.get(idx);
    if (conf !== undefined) seg.confidence = conf;
    out.push(seg);
  }
  return out.sort((a, b) => a.start_ms - b.start_ms || a.end_ms - b.end_ms || a.speaker_idx - b.speaker_idx);
}

const PRODUCER_PART_RE = /^[a-z0-9._-]{1,40}$/i;

/**
 * PURE — the source label from a stored timing JSON: `<worker>/<arch>` from its `producer` object,
 * `<worker>` when it has no arch, `eta-diarize/<arch>` when it has an arch and no worker, and
 * `eta-diarize` when it has neither. A part that is not a short token is ignored, never echoed.
 */
export function sourceOf(timing: unknown): string {
  let worker: string | null = null;
  let arch: string | null = null;
  if (timing && typeof timing === "object" && !Array.isArray(timing)) {
    const p = (timing as Record<string, unknown>).producer;
    if (p && typeof p === "object" && !Array.isArray(p)) {
      const o = p as Record<string, unknown>;
      if (typeof o.worker === "string" && PRODUCER_PART_RE.test(o.worker)) worker = o.worker;
      if (typeof o.arch === "string" && PRODUCER_PART_RE.test(o.arch)) arch = o.arch;
    }
  }
  const base = worker ?? DIARIZE_SOURCE_DEFAULT;
  return arch ? `${base}/${arch}` : base;
}

const iso = (v: unknown): string | null => {
  if (v instanceof Date) return Number.isNaN(v.getTime()) ? null : v.toISOString();
  if (typeof v === "string" && v) {
    const d = new Date(v);
    return Number.isNaN(d.getTime()) ? null : d.toISOString();
  }
  return null;
};
const str = (v: unknown): string | null => (typeof v === "string" && v ? v : null);

export type EncounterRow = {
  id: string;
  doctor_id: unknown;
  recorded_at: unknown;
  duration_seconds: unknown;
  diarize_status: unknown;
  diarize_completed_at: unknown;
  speakers: unknown;
  transcript_segments: unknown;
  diarize_timing: unknown;
};

/** PURE */
export function encounterPayload(row: EncounterRow): EncounterSegments {
  const source = sourceOf(row.diarize_timing);
  const speakers = shapeSpeakers(row.speakers);
  return {
    kind: "encounter",
    encounter_id: row.id,
    doctor_id: str(row.doctor_id),
    recorded_at: iso(row.recorded_at),
    duration_seconds: finite(row.duration_seconds),
    diarize_status: str(row.diarize_status),
    diarized_at: iso(row.diarize_completed_at),
    clock: "recording_relative",
    source,
    speakers,
    segments: shapeSegments(row.transcript_segments, speakers, source),
  };
}

export type WindowRow = {
  window_id: string;
  session_id: unknown;
  room_day_id: unknown;
  source_mic: unknown;
  state: unknown;
  diarized_at: unknown;
  start_ms: unknown;
  end_ms: unknown;
  segments_run_id: unknown;
  last_run_id: unknown;
  speakers_json: unknown;
  segments_json: unknown;
  timing_json: unknown;
};

/** PURE */
export function windowPayload(row: WindowRow): WindowSegments {
  const source = sourceOf(row.timing_json);
  const speakers = shapeSpeakers(row.speakers_json);
  const segRun = str(row.segments_run_id);
  const lastRun = str(row.last_run_id);
  return {
    kind: "window",
    window_id: row.window_id,
    session_id: str(row.session_id),
    room_day_id: str(row.room_day_id),
    source_mic: str(row.source_mic),
    diarize_state: str(row.state),
    diarized_at: iso(row.diarized_at),
    origin_ms: finite(row.start_ms),
    window_end_ms: finite(row.end_ms),
    clock: "clip_relative",
    segments_run_id: segRun,
    // Same rule as the emotion job (0099): NULL provenance, or a later run, means stale.
    segments_stale: segRun === null || (lastRun !== null && segRun !== lastRun),
    source,
    speakers,
    segments: shapeSegments(row.segments_json, speakers, source),
  };
}

const ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

/** PURE — which one id was asked for, or why the query is refused. */
export function pickQuery(q: SegmentsQuery):
  | { ok: true; by: "encounter_id" | "window_id" | "session_id"; id: string; limit: number }
  | { ok: false; status: 400; error: "one_id_required" | "bad_id" } {
  const given = (["encounter_id", "window_id", "session_id"] as const).filter(
    (k) => typeof q[k] === "string" && q[k]!.trim() !== "",
  );
  if (given.length !== 1) return { ok: false, status: 400, error: "one_id_required" };
  const by = given[0]!;
  const id = q[by]!.trim();
  if (!ID_RE.test(id)) return { ok: false, status: 400, error: "bad_id" };
  const n = finite(q.limit);
  const limit = n === null ? SESSION_WINDOW_LIMIT_DEFAULT : Math.min(SESSION_WINDOW_LIMIT_MAX, Math.max(1, Math.trunc(n)));
  return { ok: true, by, id, limit };
}

// ---------------------------------------------------------------------------
// Reads. SELECT only; the column lists name no text column.
// ---------------------------------------------------------------------------

export async function lookupSegments(q: SegmentsQuery): Promise<SegmentsLookup> {
  const pick = pickQuery(q);
  if (!pick.ok) return pick;

  if (pick.by === "encounter_id") {
    const rows = (await sql`
      SELECT id, doctor_id, recorded_at, duration_seconds, diarize_status, diarize_completed_at,
             speakers, transcript_segments, diarize_timing
        FROM encounter
       WHERE id = ${pick.id} AND deleted_at IS NULL
       LIMIT 1
    `) as EncounterRow[];
    const row = rows[0];
    return row ? { ok: true, payload: encounterPayload(row) } : { ok: false, status: 404, error: "not_found" };
  }

  if (pick.by === "window_id") {
    const rows = (await sql`
      SELECT d.window_id, w.session_id, d.room_day_id, w.source_mic, d.state, d.diarized_at,
             w.start_ms, w.end_ms, d.segments_run_id, d.last_run_id,
             d.speakers_json, d.segments_json, d.timing_json
        FROM room_diarize_window d
        JOIN bench_window w ON w.id = d.window_id
       WHERE d.window_id = ${pick.id}
       LIMIT 1
    `) as WindowRow[];
    const row = rows[0];
    return row ? { ok: true, payload: windowPayload(row) } : { ok: false, status: 404, error: "not_found" };
  }

  // One more row than the limit, so `truncated` is a fact rather than a guess.
  const rows = (await sql`
    SELECT d.window_id, w.session_id, d.room_day_id, w.source_mic, d.state, d.diarized_at,
           w.start_ms, w.end_ms, d.segments_run_id, d.last_run_id,
           d.speakers_json, d.segments_json, d.timing_json
      FROM bench_window w
      JOIN room_diarize_window d ON d.window_id = w.id
     WHERE w.session_id = ${pick.id}
     ORDER BY w.start_ms
     LIMIT ${pick.limit + 1}
  `) as WindowRow[];
  if (rows.length === 0) return { ok: false, status: 404, error: "not_found" };
  return {
    ok: true,
    payload: {
      kind: "session",
      session_id: pick.id,
      windows: rows.slice(0, pick.limit).map(windowPayload),
      truncated: rows.length > pick.limit,
    },
  };
}

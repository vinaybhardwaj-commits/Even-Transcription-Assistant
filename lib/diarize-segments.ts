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
 *
 * `engine=nemotron` (epic #23 b) reads the SHADOW engine instead: diarize_nemotron_window (0140), the
 * newest `ok`/`empty` row for one window. Same payload shape; `source` is `nemotron/<machine>`, speaker
 * indices come from the worker's `spkN` labels, `overlap` is true where a turn intersects another
 * speaker's, and there is never a clinician match (Nemotron has no identity — that is ticket c). Only
 * `window_id` is supported for it. With no `engine`, every answer is exactly what it was.
 */
import { BLIND_ROOM_DAYS, isBlindRoomDay } from "@/lib/rubrics/blind-room-days";
import { guardSessionSpan, refusalForPairs, windowBlindAny, windowPlacement } from "@/lib/voice-blind";
import { sql } from "@/lib/db";
import { nemotronShadowEnabled } from "@/lib/diarize-engine";

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
  /** S6-BLIND (the guarded MCP read only): windows left out because their room-day is held out / because they have no room-day */
  n_blind_excluded?: number;
  n_unplaced_excluded?: number;
};

export type SegmentsPayload = EncounterSegments | WindowSegments | SessionSegments;

export type SegmentsQuery = {
  encounter_id?: string | null;
  window_id?: string | null;
  session_id?: string | null;
  limit?: number | null;
  /** Absent = the production store, unchanged. `nemotron` = the shadow store (window_id only). */
  engine?: string | null;
};

/** The engines `engine=` accepts. Absent means production's own store. */
export const SEGMENT_ENGINES = ["nemotron"] as const;
export type SegmentEngine = (typeof SEGMENT_ENGINES)[number];

export type SegmentsLookup =
  | { ok: true; payload: SegmentsPayload }
  | { ok: false; status: 400 | 404; error: "one_id_required" | "bad_id" | "bad_engine" | "engine_needs_window_id" | "not_found" | "engine_disabled" }
  // S6-BLIND (only when the caller asks for the guard: the MCP tool): a held-out room-day, or a window with no room-day
  | { ok: false; status: 403; error: "blind_room_day" | "window_unplaced" };

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

export type NemotronWindowRow = {
  window_id: string;
  session_id: unknown;
  room_day_id: unknown;
  source_mic: unknown;
  status: unknown;
  received_at: unknown;
  start_ms: unknown;
  end_ms: unknown;
  model_rev: unknown;
  machine: unknown;
  turns_json: unknown;
};

/**
 * PURE — a stored Nemotron row → the window payload. Turns are re-checked one by one (a malformed turn is
 * dropped, never echoed); labels other than `spkN` are dropped; the stored label never reaches the output.
 */
export function nemotronWindowPayload(row: NemotronWindowRow): WindowSegments {
  const machine = str(row.machine);
  const source = machine && PRODUCER_PART_RE.test(machine) ? `nemotron/${machine}` : "nemotron";
  const turns: Array<{ s: number; e: number; idx: number }> = [];
  if (Array.isArray(row.turns_json)) {
    for (const t of row.turns_json) {
      if (!Array.isArray(t) || t.length !== 3) continue;
      const s = finite(t[0]);
      const e = finite(t[1]);
      const m = typeof t[2] === "string" ? /^spk(\d{1,2})$/.exec(t[2]) : null;
      if (s === null || e === null || s < 0 || e <= s || !m) continue;
      turns.push({ s: Math.round(s), e: Math.round(e), idx: Number(m[1]) });
    }
  }
  const speech = new Map<number, number>();
  for (const t of turns) speech.set(t.idx, (speech.get(t.idx) ?? 0) + (t.e - t.s));
  const speakers: SpeakerTiming[] = [...speech.keys()]
    .sort((a, b) => a - b)
    .map((idx) => ({ speaker_idx: idx, speaker_label: speakerLabel(idx), total_speech_ms: speech.get(idx)! }));
  const segments: SegmentTiming[] = turns
    .map((t) => ({
      start_ms: t.s,
      end_ms: t.e,
      speaker_idx: t.idx,
      speaker_label: speakerLabel(t.idx),
      source,
      overlap: turns.some((o) => o.idx !== t.idx && o.s < t.e && t.s < o.e),
    }))
    .sort((a, b) => a.start_ms - b.start_ms || a.end_ms - b.end_ms || a.speaker_idx - b.speaker_idx);
  const rev = str(row.model_rev);
  return {
    kind: "window",
    window_id: row.window_id,
    session_id: str(row.session_id),
    room_day_id: str(row.room_day_id),
    source_mic: str(row.source_mic),
    diarize_state: str(row.status),
    diarized_at: iso(row.received_at),
    origin_ms: finite(row.start_ms),
    window_end_ms: finite(row.end_ms),
    clock: "clip_relative",
    segments_run_id: rev,
    // The newest stored row for the window is what is returned, so it is never stale relative to itself.
    segments_stale: false,
    source,
    speakers,
    segments,
  };
}

/** PURE — which one id was asked for, or why the query is refused. */
export function pickQuery(q: SegmentsQuery):
  | { ok: true; by: "encounter_id" | "window_id" | "session_id"; id: string; limit: number; engine: SegmentEngine | null }
  | { ok: false; status: 400; error: "one_id_required" | "bad_id" | "bad_engine" | "engine_needs_window_id" } {
  const given = (["encounter_id", "window_id", "session_id"] as const).filter(
    (k) => typeof q[k] === "string" && q[k]!.trim() !== "",
  );
  if (given.length !== 1) return { ok: false, status: 400, error: "one_id_required" };
  const by = given[0]!;
  const id = q[by]!.trim();
  if (!ID_RE.test(id)) return { ok: false, status: 400, error: "bad_id" };
  const n = finite(q.limit);
  const limit = n === null ? SESSION_WINDOW_LIMIT_DEFAULT : Math.min(SESSION_WINDOW_LIMIT_MAX, Math.max(1, Math.trunc(n)));
  let engine: SegmentEngine | null = null;
  if (typeof q.engine === "string" && q.engine.trim() !== "") {
    const e = q.engine.trim().toLowerCase();
    if (!(SEGMENT_ENGINES as readonly string[]).includes(e)) return { ok: false, status: 400, error: "bad_engine" };
    if (by !== "window_id") return { ok: false, status: 400, error: "engine_needs_window_id" };
    engine = e as SegmentEngine;
  }
  return { ok: true, by, id, limit, engine };
}

// ---------------------------------------------------------------------------
// Reads. SELECT only; the column lists name no text column.
// ---------------------------------------------------------------------------

export async function lookupSegments(q: SegmentsQuery, opts: { blindGuard?: boolean } = {}): Promise<SegmentsLookup> {
  const pick = pickQuery(q);
  if (!pick.ok) return pick;
  const guard = opts.blindGuard !== false; // S6-BLIND: guarded by default, so the MCP tool and the /api route (its bearer twin) share one rule

  if (pick.engine === "nemotron") {
    // the shadow store is readable only while DIARIZE_NEMOTRON_SHADOW is on; a bad flag value reads as off (fail closed)
    let on = false;
    try {
      on = nemotronShadowEnabled();
    } catch {
      on = false;
    }
    if (!on) return { ok: false, status: 404, error: "engine_disabled" };
    // S6-BLIND: the placement check runs before the shadow store is read, exactly as for the ensemble path (a held-out or unplaced window is refused; an unknown one stays not_found)
    if (guard) {
      const p = await windowPlacement(pick.id);
      // G1: the placement pairs AND the full any-placement set (turn rows, window text, emotion rows included)
      if (p.known) { const g = refusalForPairs(p.pairs) ?? ((await windowBlindAny(pick.id)) ? "blind_room_day" : null); if (g) return { ok: false, status: 403, error: g }; }
    }
    const rows = (await sql`
      SELECT n.window_id, w.session_id, n.room_day_id, w.source_mic, n.status, n.received_at,
             w.start_ms, w.end_ms, n.model_rev, n.machine, n.turns_json,
             nrd.room_id AS shadow_room_id, nrd.ist_date::text AS shadow_ist_date
        FROM diarize_nemotron_window n
        JOIN bench_window w ON w.id = n.window_id
        LEFT JOIN room_day nrd ON nrd.id = n.room_day_id
       WHERE n.window_id = ${pick.id} AND n.status IN ('ok', 'empty')
       ORDER BY n.received_at DESC, n.id DESC
       LIMIT 1
    `) as Array<NemotronWindowRow & { shadow_room_id?: string | null; shadow_ist_date?: string | null }>;
    const row = rows[0];
    // N2-1: the EITHER-placement rule covers the shadow row's OWN room-day too (n.room_day_id): a window whose bench placement is clean but whose shadow row sits on a held-out day is refused, and no turn leaves
    if (guard && row && row.shadow_room_id && row.shadow_ist_date && isBlindRoomDay(row.shadow_ist_date, row.shadow_room_id)) return { ok: false, status: 403, error: "blind_room_day" };
    return row ? { ok: true, payload: nemotronWindowPayload(row) } : { ok: false, status: 404, error: "not_found" };
  }

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
    if (guard) {
      // S6-BLIND: the window's placement is asked first; a held-out window is refused before its segments (or anything else) are read. An unknown window stays not_found (nothing to leak).
      const p = await windowPlacement(pick.id);
      // G1: the placement pairs AND the full any-placement set (turn rows, window text, emotion rows included)
      if (p.known) { const g = refusalForPairs(p.pairs) ?? ((await windowBlindAny(pick.id)) ? "blind_room_day" : null); if (g) return { ok: false, status: 403, error: g }; }
    }
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

  if (guard) return sessionGuarded(pick.id, pick.limit);
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

/**
 * S6-BLIND: a session's windows with the held-out room-days left out IN SQL (before the LIMIT) and counted, and the windows with no room-day left out and counted (fail closed). A window is placed
 * through room_diarize_window.room_day_id, else bench_window.room_day_id. Nothing is named: only counts.
 */
async function sessionGuarded(sessionId: string, limit: number): Promise<SegmentsLookup> {
  // G1: a session that scribe_get_session refuses whole (its day or span is held out, or ANY window has ANY held-out placement) serves none of its windows either
  if ((await guardSessionSpan(sessionId)) === "blind_room_day") return { ok: false, status: 403, error: "blind_room_day" };
  const days = BLIND_ROOM_DAYS.map(([d]) => d), rooms = BLIND_ROOM_DAYS.map(([, r]) => r);
  // Y1: a window is held out if EITHER of its placements (room_diarize_window.room_day_id, bench_window.room_day_id) is a held-out pair, as in the window view (lib/voice-blind refusalForPairs).
  // Y2: the INNER JOIN below is the unplaced exclusion (a window with no room-day at all drops out and is counted).
  const rows = (await sql`
    SELECT d.window_id, w.session_id, d.room_day_id, w.source_mic, d.state, d.diarized_at,
           w.start_ms, w.end_ms, d.segments_run_id, d.last_run_id,
           d.speakers_json, d.segments_json, d.timing_json
      FROM bench_window w
      JOIN room_diarize_window d ON d.window_id = w.id
      JOIN room_day rd ON rd.id = COALESCE(d.room_day_id, w.room_day_id)
     WHERE w.session_id = ${sessionId}
       AND NOT EXISTS (SELECT 1 FROM room_day r1, unnest(${days}::date[], ${rooms}::text[]) AS b(d, r) WHERE r1.id IN (d.room_day_id, w.room_day_id) AND b.d = r1.ist_date AND b.r = r1.room_id)
     ORDER BY w.start_ms
     LIMIT ${limit + 1}
  `) as WindowRow[];
  const ex = (await sql`
    SELECT count(*) FILTER (WHERE bl.blind)::int AS blind,
           count(*) FILTER (WHERE rd.id IS NULL AND NOT bl.blind)::int AS unplaced
      FROM bench_window w
      JOIN room_diarize_window d ON d.window_id = w.id
      LEFT JOIN room_day rd ON rd.id = COALESCE(d.room_day_id, w.room_day_id)
      CROSS JOIN LATERAL (SELECT EXISTS (SELECT 1 FROM room_day r1, unnest(${days}::date[], ${rooms}::text[]) AS b(d, r) WHERE r1.id IN (d.room_day_id, w.room_day_id) AND b.d = r1.ist_date AND b.r = r1.room_id) AS blind) bl
     WHERE w.session_id = ${sessionId}
  `) as Array<{ unplaced: number; blind: number }>;
  const n_blind_excluded = Number(ex[0]?.blind ?? 0), n_unplaced_excluded = Number(ex[0]?.unplaced ?? 0);
  if (rows.length === 0 && n_blind_excluded + n_unplaced_excluded === 0) return { ok: false, status: 404, error: "not_found" };
  return {
    ok: true,
    payload: { kind: "session", session_id: sessionId, windows: rows.slice(0, limit).map(windowPayload), truncated: rows.length > limit, n_blind_excluded, n_unplaced_excluded },
  };
}

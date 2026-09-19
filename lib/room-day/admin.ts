/**
 * lib/room-day/admin.ts — S1: the room-day tape (read model only).
 *
 * ONE HELPER, `getRoomDayTape(roomId, istDate)`, assembles everything a human needs to see about
 * one room on one day, window by window, down the whole span of the day — including the gaps.
 * Two supporting list helpers (`listRoomsOverview`, `listRoomDays`) back the two upstream routes.
 *
 * WRITES NOTHING. Every statement below is a SELECT.
 *
 * WHY db/schema.ts IS NOT IMPORTED HERE: it is stale for every table this file reads (missing
 * transcription_run.subject_type among others - ETA-S1-ROOM-DAY-TAPE-SPEC-v1.0 section 2). Every column
 * name below is read from the migration that added it, not from the drizzle schema.
 *
 * THE EMOTION GATE IS CHECKED BEFORE THE QUERY. `room_span_emotion` is queried only when
 * `canSurfaceEmotion(env)` is true - see `getRoomDayTape` below. Test case 6 in
 * tests/unit/room-day-tape.test.ts asserts this against the fake-pg call list, not just the
 * output, and tests/unit/c3-emotion.test.ts now allowlists this file as the one caller of
 * `canSurfaceEmotion` in the whole codebase.
 *
 * THE TURN'S OWN TIMING. `room_turn_speaker` carries no start_ms/end_ms of its own - it is keyed
 * on `source_ref`, and a turn's absolute bounds are recovered two ways, in priority order:
 *   1. the joined `stt_turn` cue's `payload.start_ms`/`end_ms` - ALREADY ABSOLUTE (buildTurns,
 *      lib/mcp/tools/bench.ts, stamps `clipStartMs + segment_offset`, never a clip-relative value);
 *   2. failing that, `source_ref` itself - `{session_id}|{start_ms}|{end_ms}|{speaker}`
 *      (turnSourceRef, lib/mcp/tools/bench.ts) - the same absolute values, pipe-encoded.
 * Neither needs the window's start_ms added. `room_diarize_window.segments_json` is genuinely
 * clip-relative (the GOTCHA the spec calls out) and is never used for a turn's bounds here; see
 * `toAbsoluteMs` below for where that column's arithmetic is guarded and tested instead.
 */

import { sql } from "@/lib/db";
import { emotionEnabled, canSurfaceEmotion } from "@/lib/emotion/gate";
import { AUTO_DRAIN_MAX_AGE_HOURS } from "@/lib/stt/auto-drain";

// ===========================================================================
// Constants
// ===========================================================================

/** One tape slot, in milliseconds. */
export const SLOT_MS = 15 * 60 * 1000;

/** The three cosine floors E20 lives to inform. UNRATIFIED - rendered as a footnote, never as fact. */
export const VOICE_THRESHOLDS_UNRATIFIED = { room: 0.65, encounter: 0.7, phone: 0.78 } as const;

// ===========================================================================
// Public shape (ETA-S1-ROOM-DAY-TAPE-SPEC-v1.0 section 5.2)
// ===========================================================================

export type BenchWindowState = "open" | "closed" | "transcribing" | "transcribed" | "failed" | "silent";

export type TapeTurn = {
  source_ref: string;
  speaker_idx: number;
  cluster_id: string | null;
  /** ABSOLUTE epoch ms - see the file header for how these are recovered. */
  start_ms: number;
  end_ms: number;
  /**
   * Where start_ms/end_ms came from, in the priority order the file header describes. "window_start"
   * means BOTH the cue join and the source_ref decode failed and the window's own bounds were used as
   * a last resort - this is an ESTIMATE, not a measurement, and must render as one (D-11).
   */
  time_basis: "cue" | "source_ref" | "window_start";
  text: string | null;
  voice: {
    clinician_id: string | null;
    clinician_name: string | null;
    role: "clinician" | null;
    match_confidence: number | null;
    losing_clinician_id: string | null;
    losing_clinician_name: string | null;
    /** A raw cosine in [0,1] - NEVER a confidence. See VOICE_THRESHOLDS_UNRATIFIED. */
    losing_score: number | null;
    score_basis: string | null;
    no_role_reason: string | null;
  };
  /** null when not scored OR not surfaceable (the gate is false). UNCALIBRATED when present. */
  emotion: {
    top_label: string;
    top_score: number;
    speech_ms: number | null;
    speech_basis: string | null;
    scores: Record<string, number>;
  } | null;
  /**
   * The phrase-loop flag (0104, lib/transcript/repeat-runs.ts). MARK NEVER DELETE - a looped turn
   * is never dropped from `turns`, only labelled. null = never measured (predates the flag, or the
   * backfill has not reached this window yet), NOT the same as "measured and clean".
   */
  repeat_run: { in_run: boolean; run_id: string | null; run_length: number; run_rank: number } | null;
};

export type TapeSlot =
  | { start_ms: number; end_ms: number; label: string; kind: "no_recording" }
  | {
      start_ms: number;
      end_ms: number;
      label: string;
      kind: "window";
      window: {
        id: string;
        session_id: string;
        source_mic: string;
        state: BenchWindowState;
        grid_aligned: boolean;
        closed_at: string | null;
        auto_drain_refused_at: string | null;
        auto_drain_refused_reason: string | null;
        drain_reachable: boolean;
        transcript: {
          text: string | null;
          language: string | null;
          activity: string | null;
          audio_seconds: number | null;
          spoken_seconds: number | null;
          segment_count: number | null;
          engine: string | null;
          language_mix: Record<string, number> | null;
          latency_ms: number | null;
          error: string | null;
        } | null;
        diarize: {
          state: string;
          speaker_count: number | null;
          error: string | null;
          attempts: number;
          segments_run_id: string | null;
        } | null;
        turns: TapeTurn[];
        emotion_window: {
          state: string;
          segments_scored: number | null;
          segments_skipped: number | null;
          error: string | null;
        } | null;
      };
    };

export type RoomDayTape = {
  room: { id: string; name: string; slug: string };
  room_day: {
    id: string | null;
    ist_date: string;
    doctor_id: string | null;
    started_at: string | null;
    ended_at: string | null;
  };
  emotion: { compute_enabled: boolean; surface_enabled: boolean };
  totals: {
    slots: number;
    windows: number;
    by_state: Record<string, number>;
    turns: number;
    turns_named: number;
    turns_with_losing_score: number;
    emotion_windows_scored: number;
  };
  slots: TapeSlot[];
};

// ===========================================================================
// Pure helpers - each independently unit-testable (tests/unit/room-day-tape.test.ts)
// ===========================================================================

/** The 15-minute grid across [spanStartMs, spanEndMs). Empty when the span is not positive. */
export function buildSlotGrid(spanStartMs: number, spanEndMs: number): Array<{ start_ms: number; end_ms: number }> {
  const grid: Array<{ start_ms: number; end_ms: number }> = [];
  if (!Number.isFinite(spanStartMs) || !Number.isFinite(spanEndMs) || spanEndMs <= spanStartMs) return grid;
  for (let t = spanStartMs; t < spanEndMs; t += SLOT_MS) grid.push({ start_ms: t, end_ms: t + SLOT_MS });
  return grid;
}

/**
 * Section 5.5. A `closed` window is reachable by the auto-drain only while it is younger than
 * AUTO_DRAIN_MAX_AGE_HOURS. Every other state is not the auto-drain's concern and reads false.
 * `nowMs` is INJECTED so a test can hold the clock still - see test case 3.
 */
export function computeDrainReachable(state: string, startMs: number, nowMs: number, maxAgeHours: number): boolean {
  if (state !== "closed") return false;
  return nowMs - startMs < maxAgeHours * 60 * 60 * 1000;
}

/**
 * Section 5.1 GOTCHA. `room_diarize_window.segments_json` times are RELATIVE TO THE CLIP. This is the
 * ONE place that arithmetic happens - add the window's own start_ms, exactly once, and never
 * apply it a second time to a value this function already produced. Exported and pure so the
 * "shifted exactly once" claim is a unit test (test case 4) and not a hope.
 */
export function toAbsoluteMs(relativeMs: number, windowStartMs: number): number {
  return relativeMs + windowStartMs;
}

/**
 * A turn's own natural key - `{session_id}|{start_ms}|{end_ms}|{speaker}` (turnSourceRef,
 * lib/mcp/tools/bench.ts) - decoded back into its parts. Both ms values are ALREADY ABSOLUTE:
 * turnSourceRef is built from `clipStartMs + segment offset`, never a clip-relative time.
 */
export function parseTurnSourceRef(ref: string): { session_id: string; start_ms: number; end_ms: number; speaker: string } | null {
  const parts = ref.split("|");
  if (parts.length !== 4) return null;
  const [session_id, s, e, speaker] = parts as [string, string, string, string];
  const start_ms = Number(s);
  const end_ms = Number(e);
  if (!Number.isFinite(start_ms) || !Number.isFinite(end_ms)) return null;
  return { session_id, start_ms, end_ms, speaker };
}

const IST_SLOT_FMT = new Intl.DateTimeFormat("en-GB", {
  timeZone: "Asia/Kolkata",
  hour: "2-digit",
  minute: "2-digit",
  hour12: false,
});

/** "14:15-14:30 IST". */
export function slotLabel(startMs: number, endMs: number): string {
  return `${IST_SLOT_FMT.format(new Date(startMs))}–${IST_SLOT_FMT.format(new Date(endMs))} IST`;
}

function pickLanguage(metrics: Record<string, unknown>): string | null {
  const v = metrics.full_window_language ?? metrics.sarvam_language ?? metrics.probe_language ?? metrics.language_sent ?? null;
  return typeof v === "string" && v ? v : null;
}

function numOrNull(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}
function strOrNull(v: unknown): string | null {
  return typeof v === "string" ? v : null;
}

// ===========================================================================
// Raw row shapes the DB layer produces, and the pure assembler that turns them into a RoomDayTape
// ===========================================================================

export type RawBenchWindowRow = {
  id: string;
  session_id: string;
  room_day_id: string | null;
  start_ms: number;
  end_ms: number;
  source_mic: string;
  grid_aligned: boolean;
  state: BenchWindowState;
  closed_at: string | null;
  auto_drain_refused_at: string | null;
  auto_drain_refused_reason: string | null;
};

export type RawDiarizeRow = {
  window_id: string;
  state: string;
  error: string | null;
  attempts: number;
  segments_run_id: string | null;
  speaker_count: number | null;
};

export type RawTranscriptRow = {
  window_id: string;
  engine: string | null;
  error: string | null;
  latency_ms: number | null;
  transcript_original: string | null;
  metrics_json: Record<string, unknown>;
};

export type RawTurnRow = {
  window_id: string;
  source_ref: string;
  speaker_idx: number;
  cluster_id: string | null;
  cue_text: string | null;
  cue_start_ms: number | null;
  cue_end_ms: number | null;
  clinician_id: string | null;
  role: "clinician" | null;
  match_confidence: number | null;
  no_role_reason: string | null;
  losing_clinician_id: string | null;
  losing_score: number | null;
  score_basis: string | null;
};

export type RawRepeatRunRow = {
  window_id: string;
  source_ref: string;
  in_run: boolean;
  run_id: string | null;
  run_length: number;
  run_rank: number;
};

export type RawEmotionWindowRow = {
  window_id: string;
  state: string;
  segments_scored: number | null;
  segments_skipped: number | null;
  error: string | null;
};

export type RawSpanEmotionRow = {
  window_id: string;
  source_refs: string[];
  top_label: string;
  top_score: number;
  speech_ms: number | null;
  speech_basis: string | null;
  anger: number;
  disgust: number;
  enthusiasm: number;
  fear: number;
  happiness: number;
  neutral: number;
  sadness: number;
};

export type AssembleTapeInput = {
  room: { id: string; name: string; slug: string };
  ist_date: string;
  roomDay: { id: string; doctor_id: string | null; started_at: string | null; ended_at: string | null } | null;
  spanStartMs: number;
  spanEndMs: number;
  windows: RawBenchWindowRow[];
  diarizeRows: RawDiarizeRow[];
  transcriptRows: RawTranscriptRow[];
  turnRows: RawTurnRow[];
  repeatRunRows: RawRepeatRunRow[];
  emotionWindowRows: RawEmotionWindowRow[];
  /** [] whenever the gate is false - see getRoomDayTape. */
  spanEmotionRows: RawSpanEmotionRow[];
  clinicianNames: Record<string, string>;
  emotion: { compute_enabled: boolean; surface_enabled: boolean };
  nowMs: number;
  autoDrainMaxAgeHours: number;
};

/** (window_id, source_ref) is room_turn_repeat_run's primary key; NUL cannot occur in either part. */
const repeatRunKey = (windowId: string, sourceRef: string) => `${windowId}\u0000${sourceRef}`;

function buildTapeTurn(
  t: RawTurnRow,
  w: RawBenchWindowRow,
  clinicianNames: Record<string, string>,
  emotion: { compute_enabled: boolean; surface_enabled: boolean },
  spanEmotionRows: RawSpanEmotionRow[],
  repeatRunByTurn: Map<string, RawRepeatRunRow>,
): TapeTurn {
  const parsed = parseTurnSourceRef(t.source_ref);
  let time_basis: TapeTurn["time_basis"];
  let start_ms: number;
  let end_ms: number;
  if (t.cue_start_ms != null && t.cue_end_ms != null) {
    time_basis = "cue";
    start_ms = Number(t.cue_start_ms);
    end_ms = Number(t.cue_end_ms);
  } else if (parsed) {
    time_basis = "source_ref";
    start_ms = parsed.start_ms;
    end_ms = parsed.end_ms;
  } else {
    // Both sources failed. w.start_ms/w.end_ms is a DERIVED ESTIMATE, not a measured value - see
    // time_basis on TapeTurn, and render it as the estimate it is (D-11). Unreachable on today's
    // data (every turn joins a cue), covered by test case "both timing sources missing".
    time_basis = "window_start";
    start_ms = w.start_ms;
    end_ms = w.end_ms;
  }

  let turnEmotion: TapeTurn["emotion"] = null;
  if (emotion.surface_enabled) {
    const match = spanEmotionRows.find((r) => r.window_id === w.id && r.source_refs.includes(t.source_ref));
    if (match) {
      turnEmotion = {
        top_label: match.top_label,
        top_score: match.top_score,
        speech_ms: match.speech_ms,
        speech_basis: match.speech_basis,
        scores: {
          anger: match.anger,
          disgust: match.disgust,
          enthusiasm: match.enthusiasm,
          fear: match.fear,
          happiness: match.happiness,
          neutral: match.neutral,
          sadness: match.sadness,
        },
      };
    }
  }

  const repeatRunMatch = repeatRunByTurn.get(repeatRunKey(w.id, t.source_ref));

  return {
    source_ref: t.source_ref,
    speaker_idx: t.speaker_idx,
    cluster_id: t.cluster_id,
    start_ms,
    end_ms,
    time_basis,
    text: t.cue_text,
    repeat_run: repeatRunMatch
      ? { in_run: repeatRunMatch.in_run, run_id: repeatRunMatch.run_id, run_length: repeatRunMatch.run_length, run_rank: repeatRunMatch.run_rank }
      : null,
    voice: {
      clinician_id: t.clinician_id,
      clinician_name: t.clinician_id ? (clinicianNames[t.clinician_id] ?? null) : null,
      role: t.role,
      match_confidence: t.match_confidence,
      losing_clinician_id: t.losing_clinician_id,
      losing_clinician_name: t.losing_clinician_id ? (clinicianNames[t.losing_clinician_id] ?? null) : null,
      losing_score: t.losing_score,
      score_basis: t.score_basis,
      no_role_reason: t.no_role_reason,
    },
    emotion: turnEmotion,
  };
}

/**
 * PURE. Every DB row this file reads, already fetched, turned into one RoomDayTape. No I/O -
 * this is what test cases 1-5 and 7-9 exercise directly, without a mocked database.
 */
export function assembleTape(input: AssembleTapeInput): RoomDayTape {
  const {
    room,
    ist_date,
    roomDay,
    spanStartMs,
    spanEndMs,
    windows,
    diarizeRows,
    transcriptRows,
    turnRows,
    repeatRunRows,
    emotionWindowRows,
    spanEmotionRows,
    clinicianNames,
    emotion,
    nowMs,
    autoDrainMaxAgeHours,
  } = input;

  const diarizeByWindow = new Map(diarizeRows.map((d) => [d.window_id, d]));
  const repeatRunByTurn = new Map(repeatRunRows.map((r) => [repeatRunKey(r.window_id, r.source_ref), r]));
  const transcriptByWindow = new Map(transcriptRows.map((t) => [t.window_id, t]));
  const emotionWindowByWindow = new Map(emotionWindowRows.map((e) => [e.window_id, e]));
  const turnsByWindow = new Map<string, RawTurnRow[]>();
  for (const t of turnRows) {
    const arr = turnsByWindow.get(t.window_id) ?? [];
    arr.push(t);
    turnsByWindow.set(t.window_id, arr);
  }

  // A shared 15-min slot can hold two mic rows (primary + backup, section 5.3's grid_aligned windows are
  // one per mic). Primary wins the slot; this is a v1 simplification - see the build report.
  const sortedWindows = [...windows].sort((a, b) => {
    if (a.start_ms !== b.start_ms) return a.start_ms - b.start_ms;
    if (a.source_mic === b.source_mic) return 0;
    if (a.source_mic === "primary") return -1;
    if (b.source_mic === "primary") return 1;
    return a.source_mic.localeCompare(b.source_mic);
  });
  // w.start_ms is ALREADY an exact SLOT_MS multiple (bench_window is written on the 15-min grid -
  // see the build report's DEFECT 1). Bin on it directly rather than re-deriving an offset from
  // spanStartMs: spanStartMs itself is only a session/room_day timestamp, seconds off the grid, and
  // computing an offset from it is exactly what dropped the day's first window and shifted every
  // other one by a slot. The grid this window's slot key must match is built from a FLOORED
  // spanStartMs (getRoomDayTape floors it before calling in), so w.start_ms lines up with a real
  // grid slot's start_ms whenever spanStartMs was floored correctly upstream.
  const windowBySlotStart = new Map<number, RawBenchWindowRow>();
  for (const w of sortedWindows) {
    if (!windowBySlotStart.has(w.start_ms)) windowBySlotStart.set(w.start_ms, w);
  }

  const grid = buildSlotGrid(spanStartMs, spanEndMs);
  const slots: TapeSlot[] = grid.map(({ start_ms, end_ms }) => {
    const label = slotLabel(start_ms, end_ms);
    const w = windowBySlotStart.get(start_ms);
    if (!w) return { start_ms, end_ms, label, kind: "no_recording" };

    const diarizeRow = diarizeByWindow.get(w.id) ?? null;
    const transcriptRow = transcriptByWindow.get(w.id) ?? null;
    const emotionWindowRow = emotionWindowByWindow.get(w.id) ?? null;
    const rawTurns = turnsByWindow.get(w.id) ?? [];
    const turns = rawTurns
      .map((t) => buildTapeTurn(t, w, clinicianNames, emotion, spanEmotionRows, repeatRunByTurn))
      .sort((a, b) => a.start_ms - b.start_ms);

    const metrics = transcriptRow?.metrics_json ?? {};
    const languageTimeline = (metrics.language_timeline ?? null) as Record<string, unknown> | null;

    return {
      start_ms,
      end_ms,
      label,
      kind: "window",
      window: {
        id: w.id,
        session_id: w.session_id,
        source_mic: w.source_mic,
        state: w.state,
        grid_aligned: w.grid_aligned,
        closed_at: w.closed_at,
        auto_drain_refused_at: w.auto_drain_refused_at,
        auto_drain_refused_reason: w.auto_drain_refused_reason,
        drain_reachable: computeDrainReachable(w.state, w.start_ms, nowMs, autoDrainMaxAgeHours),
        transcript: transcriptRow
          ? {
              text: transcriptRow.transcript_original,
              language: pickLanguage(metrics),
              activity: strOrNull(metrics.activity),
              audio_seconds: numOrNull(metrics.audio_seconds),
              spoken_seconds: numOrNull(languageTimeline?.spoken_seconds),
              segment_count: numOrNull(metrics.segment_count),
              engine: transcriptRow.engine,
              language_mix: (languageTimeline?.language_mix as Record<string, number> | undefined) ?? null,
              latency_ms: transcriptRow.latency_ms,
              error: transcriptRow.error,
            }
          : null,
        diarize: diarizeRow
          ? {
              state: diarizeRow.state,
              speaker_count: diarizeRow.speaker_count,
              error: diarizeRow.error,
              attempts: diarizeRow.attempts,
              segments_run_id: diarizeRow.segments_run_id,
            }
          : null,
        turns,
        emotion_window: emotionWindowRow
          ? {
              state: emotionWindowRow.state,
              segments_scored: emotionWindowRow.segments_scored,
              segments_skipped: emotionWindowRow.segments_skipped,
              error: emotionWindowRow.error,
            }
          : null,
      },
    };
  });

  const by_state: Record<string, number> = {};
  for (const w of windows) by_state[w.state] = (by_state[w.state] ?? 0) + 1;

  return {
    room,
    room_day: {
      id: roomDay?.id ?? null,
      ist_date,
      doctor_id: roomDay?.doctor_id ?? null,
      started_at: roomDay?.started_at ?? null,
      ended_at: roomDay?.ended_at ?? null,
    },
    emotion,
    totals: {
      slots: grid.length,
      windows: windows.length,
      by_state,
      turns: turnRows.length,
      turns_named: turnRows.filter((t) => t.role === "clinician").length,
      turns_with_losing_score: turnRows.filter((t) => t.losing_score !== null).length,
      emotion_windows_scored: emotionWindowRows.filter((e) => e.state === "ok").length,
    },
    slots,
  };
}

// ===========================================================================
// The DB layer - every statement below is a SELECT
// ===========================================================================

function msOf(v: string | Date): number {
  return v instanceof Date ? v.getTime() : Date.parse(v);
}

type GetRoomDayTapeOpts = {
  now?: () => number;
  env?: Record<string, string | undefined>;
};

/**
 * ETA-S1-ROOM-DAY-TAPE-SPEC-v1.0 section 5. Returns null when the room does not exist, or the room
 * exists but has neither a room_day row nor any bench_session on that IST date (nothing to show).
 */
export async function getRoomDayTape(roomId: string, istDate: string, opts: GetRoomDayTapeOpts = {}): Promise<RoomDayTape | null> {
  const nowMs = (opts.now ?? Date.now)();
  const env = opts.env ?? process.env;

  const roomRows = (await sql`SELECT id, slug, name FROM room WHERE id = ${roomId} LIMIT 1`) as Array<{
    id: string;
    slug: string;
    name: string;
  }>;
  const room = roomRows[0];
  if (!room) return null;

  const dayRows = (await sql`
    SELECT id, doctor_id, started_at, ended_at
      FROM room_day
     WHERE room_id = ${roomId} AND ist_date = ${istDate}::date
  `) as Array<{ id: string; doctor_id: string | null; started_at: string; ended_at: string | null }>;
  const roomDay = dayRows[0] ?? null;

  const sessionRows = (await sql`
    SELECT id, started_at, ended_at
      FROM bench_session
     WHERE room_id = ${roomId}
       AND (started_at AT TIME ZONE 'Asia/Kolkata')::date = ${istDate}::date
     ORDER BY started_at ASC
  `) as Array<{ id: string; started_at: string; ended_at: string | null }>;

  if (!roomDay && sessionRows.length === 0) return null;

  // DEFECT 1 (build report): bench_window.start_ms sits on an exact 15-min grid; a session's or
  // room_day's own started_at/ended_at does not (started_at is measured seconds after the window it
  // opens for — 74/74 real room-days have started_at > min(window.start_ms)). Anchoring the slot grid
  // to the RAW timestamp shifted every slot by one and silently dropped the day's first window. Floor
  // spanStartMs onto the SLOT_MS grid before it goes anywhere near buildSlotGrid — flooring is safe
  // here because IST is UTC+5:30, itself an exact 22*SLOT_MS offset, so a UTC-epoch floor lands on the
  // same wall-clock 15-min mark in IST too.
  const rawSpanStartMs = sessionRows.length ? Math.min(...sessionRows.map((s) => msOf(s.started_at))) : msOf(roomDay!.started_at ?? new Date(0).toISOString());
  const spanStartMs = Math.floor(rawSpanStartMs / SLOT_MS) * SLOT_MS;

  // The end needs the SAME floor for a room-day that has genuinely ended — an ended_at timestamp is
  // stamped a few seconds AFTER the last window's own close boundary, and flooring it lands exactly on
  // that boundary, which is what stops the phantom empty slot the un-floored value used to mint past
  // the real last window. But a room-day still being recorded has no ended_at: it falls back to nowMs,
  // which sits somewhere INSIDE the currently-open window's own slot, not past it — flooring THAT would
  // exclude the live window from the grid entirely (its own start_ms would equal the floored spanEndMs,
  // and buildSlotGrid's `t < spanEndMs` is strict). So nowMs is rounded up to the boundary AFTER it,
  // which keeps the in-progress slot in view without reopening the phantom-trailing-slot the ended case
  // just fixed.
  const endOfSpan = (endedAtIso: string | null): number =>
    endedAtIso ? Math.floor(Math.min(msOf(endedAtIso), nowMs) / SLOT_MS) * SLOT_MS : Math.ceil(nowMs / SLOT_MS) * SLOT_MS;
  const spanEndMs = sessionRows.length ? Math.max(...sessionRows.map((s) => endOfSpan(s.ended_at))) : endOfSpan(roomDay!.ended_at);

  // Section 5.4 - a window belongs to this room-day by room_day_id, OR (when room_day_id is NULL) by its
  // OWN start_ms's IST date. The 8-window class this rescues.
  const windowDbRows = (await sql`
    SELECT w.id, w.session_id, w.room_day_id, w.start_ms, w.end_ms, w.source_mic,
           w.grid_aligned, w.state, w.closed_at, w.auto_drain_refused_at, w.auto_drain_refused_reason
      FROM bench_window w
      JOIN bench_session s ON s.id = w.session_id
     WHERE s.room_id = ${roomId}
       AND (
         w.room_day_id = ${roomDay?.id ?? null}::text
         OR (w.room_day_id IS NULL AND (to_timestamp(w.start_ms / 1000.0) AT TIME ZONE 'Asia/Kolkata')::date = ${istDate}::date)
       )
     ORDER BY w.start_ms ASC, w.source_mic ASC
  `) as Array<{
    id: string;
    session_id: string;
    room_day_id: string | null;
    start_ms: string | number;
    end_ms: string | number;
    source_mic: string;
    grid_aligned: boolean;
    state: string;
    closed_at: string | null;
    auto_drain_refused_at: string | null;
    auto_drain_refused_reason: string | null;
  }>;

  const windows: RawBenchWindowRow[] = windowDbRows.map((w) => ({
    id: w.id,
    session_id: w.session_id,
    room_day_id: w.room_day_id,
    start_ms: Number(w.start_ms),
    end_ms: Number(w.end_ms),
    source_mic: w.source_mic,
    grid_aligned: w.grid_aligned,
    state: w.state as BenchWindowState,
    closed_at: w.closed_at,
    auto_drain_refused_at: w.auto_drain_refused_at,
    auto_drain_refused_reason: w.auto_drain_refused_reason,
  }));
  const windowIds = windows.map((w) => w.id);

  let diarizeRows: RawDiarizeRow[] = [];
  let transcriptRows: RawTranscriptRow[] = [];
  let turnRows: RawTurnRow[] = [];
  let repeatRunRows: RawRepeatRunRow[] = [];
  let emotionWindowRows: RawEmotionWindowRow[] = [];
  let clinicianNames: Record<string, string> = {};

  if (windowIds.length > 0) {
    const [diarizeDb, transcriptDb, turnDb, repeatRunDb, emoWindowDb] = await Promise.all([
      sql`
        SELECT window_id, state, error, attempts, segments_run_id, speakers_json
          FROM room_diarize_window
         WHERE window_id = ANY(${windowIds}::text[])
      ` as unknown as Promise<Array<{ window_id: string; state: string; error: string | null; attempts: number; segments_run_id: string | null; speakers_json: unknown }>>,
      sql`
        SELECT subject_id AS window_id, engine, error, latency_ms, metrics_json, transcript_original
          FROM transcription_run
         WHERE subject_type = 'bench_window' AND subject_id = ANY(${windowIds}::text[])
      ` as unknown as Promise<Array<{ window_id: string; engine: string | null; error: string | null; latency_ms: number | null; metrics_json: unknown; transcript_original: string | null }>>,
      sql`
        SELECT rts.window_id, rts.source_ref, rts.speaker_idx, rts.cluster_id,
               rts.clinician_id, rts.role, rts.match_confidence, rts.no_role_reason,
               rts.losing_clinician_id, rts.losing_score, rts.score_basis,
               c.payload->>'text' AS cue_text,
               (c.payload->>'start_ms')::bigint AS cue_start_ms,
               (c.payload->>'end_ms')::bigint AS cue_end_ms
          FROM room_turn_speaker rts
          LEFT JOIN cue c ON c.source_ref = rts.source_ref AND c.type = 'stt_turn'
         WHERE rts.window_id = ANY(${windowIds}::text[])
      ` as unknown as Promise<
        Array<{
          window_id: string;
          source_ref: string;
          speaker_idx: number;
          cluster_id: string | null;
          clinician_id: string | null;
          role: string | null;
          match_confidence: number | null;
          no_role_reason: string | null;
          losing_clinician_id: string | null;
          losing_score: number | null;
          score_basis: string | null;
          cue_text: string | null;
          cue_start_ms: string | number | null;
          cue_end_ms: string | number | null;
        }>
      >,
      sql`
        SELECT window_id, source_ref, in_run, run_id, run_length, run_rank
          FROM room_turn_repeat_run
         WHERE window_id = ANY(${windowIds}::text[])
      ` as unknown as Promise<Array<{ window_id: string; source_ref: string; in_run: boolean; run_id: string | null; run_length: number; run_rank: number }>>,
      sql`
        SELECT window_id, state, segments_scored, segments_skipped, error
          FROM room_emotion_window
         WHERE window_id = ANY(${windowIds}::text[])
      ` as unknown as Promise<Array<{ window_id: string; state: string; segments_scored: number | null; segments_skipped: number | null; error: string | null }>>,
    ]);

    diarizeRows = diarizeDb.map((d) => ({
      window_id: d.window_id,
      state: d.state,
      error: d.error,
      attempts: d.attempts,
      segments_run_id: d.segments_run_id,
      speaker_count: Array.isArray(d.speakers_json) ? d.speakers_json.length : null,
    }));

    transcriptRows = transcriptDb.map((t) => ({
      window_id: t.window_id,
      engine: t.engine,
      error: t.error,
      latency_ms: t.latency_ms,
      transcript_original: t.transcript_original,
      metrics_json: (t.metrics_json ?? {}) as Record<string, unknown>,
    }));

    turnRows = turnDb.map((t) => ({
      window_id: t.window_id,
      source_ref: t.source_ref,
      speaker_idx: t.speaker_idx,
      cluster_id: t.cluster_id,
      cue_text: t.cue_text,
      cue_start_ms: t.cue_start_ms === null ? null : Number(t.cue_start_ms),
      cue_end_ms: t.cue_end_ms === null ? null : Number(t.cue_end_ms),
      clinician_id: t.clinician_id,
      role: t.role === "clinician" ? "clinician" : null,
      match_confidence: t.match_confidence,
      no_role_reason: t.no_role_reason,
      losing_clinician_id: t.losing_clinician_id,
      losing_score: t.losing_score,
      score_basis: t.score_basis,
    }));

    repeatRunRows = repeatRunDb.map((r) => ({
      window_id: r.window_id,
      source_ref: r.source_ref,
      in_run: r.in_run,
      run_id: r.run_id,
      run_length: r.run_length,
      run_rank: r.run_rank,
    }));

    emotionWindowRows = emoWindowDb.map((e) => ({
      window_id: e.window_id,
      state: e.state,
      segments_scored: e.segments_scored,
      segments_skipped: e.segments_skipped,
      error: e.error,
    }));

    const clinicianIds = Array.from(
      new Set(turnRows.flatMap((t) => [t.clinician_id, t.losing_clinician_id]).filter((x): x is string => !!x)),
    );
    if (clinicianIds.length > 0) {
      const rows = (await sql`
        SELECT id, full_name FROM clinician WHERE id = ANY(${clinicianIds}::text[])
      `) as Array<{ id: string; full_name: string }>;
      clinicianNames = Object.fromEntries(rows.map((r) => [r.id, r.full_name]));
    }
  }

  // THE GATE, CHECKED BEFORE THE QUERY (section 6.3). room_span_emotion is reached only when the gate is
  // true - the "off" path below issues zero queries against it, which is what test case 6 proves.
  const emotion = { compute_enabled: emotionEnabled(env), surface_enabled: canSurfaceEmotion(env) };
  let spanEmotionRows: RawSpanEmotionRow[] = [];
  if (emotion.surface_enabled && windowIds.length > 0) {
    const rows = (await sql`
      SELECT window_id, source_refs, top_label, top_score, speech_ms, speech_basis,
             anger, disgust, enthusiasm, fear, happiness, neutral, sadness
        FROM room_span_emotion
       WHERE window_id = ANY(${windowIds}::text[]) AND state = 'scored'
    `) as Array<{
      window_id: string;
      source_refs: string[];
      top_label: string;
      top_score: number;
      speech_ms: number | null;
      speech_basis: string | null;
      anger: number;
      disgust: number;
      enthusiasm: number;
      fear: number;
      happiness: number;
      neutral: number;
      sadness: number;
    }>;
    spanEmotionRows = rows.map((r) => ({ ...r, source_refs: Array.isArray(r.source_refs) ? r.source_refs : [] }));
  }

  return assembleTape({
    room,
    ist_date: istDate,
    roomDay: roomDay ? { id: roomDay.id, doctor_id: roomDay.doctor_id, started_at: roomDay.started_at, ended_at: roomDay.ended_at } : null,
    spanStartMs,
    spanEndMs,
    windows,
    diarizeRows,
    transcriptRows,
    turnRows,
    repeatRunRows,
    emotionWindowRows,
    spanEmotionRows,
    clinicianNames,
    emotion,
    nowMs,
    autoDrainMaxAgeHours: AUTO_DRAIN_MAX_AGE_HOURS,
  });
}

// ===========================================================================
// The two list routes (section 4) - best-effort, fail-safe to [] like lib/bench.ts's own readers
// ===========================================================================

export type RoomOverviewRow = {
  id: string;
  slug: string;
  name: string;
  disabled_at: string | null;
  latest_ist_date: string | null;
  day_count: number;
};

/** Every room, with its most recent room_day and a count of days (`/admin/rooms`). */
export async function listRoomsOverview(): Promise<RoomOverviewRow[]> {
  try {
    return (await sql`
      SELECT r.id, r.slug, r.name, r.disabled_at,
             MAX(rd.ist_date::text) AS latest_ist_date,
             COUNT(rd.id)::int AS day_count
        FROM room r
        LEFT JOIN room_day rd ON rd.room_id = r.id
       GROUP BY r.id, r.slug, r.name, r.disabled_at
       ORDER BY r.name ASC
    `) as RoomOverviewRow[];
  } catch {
    return [];
  }
}

export type RoomDayOverviewRow = {
  ist_date: string;
  room_day_id: string | null;
  window_count: number;
  transcribed_count: number;
  turn_count: number;
  any_voice_match: boolean;
};

/**
 * A room's days, newest first (`/admin/rooms/[roomId]`). Grouped on the CALENDAR DATE, not on
 * room_day_id, so the 8 NULL-room_day_id windows' days still show up (section 5.4).
 */
export async function listRoomDays(roomId: string): Promise<RoomDayOverviewRow[]> {
  try {
    return (await sql`
      WITH days AS (
        SELECT (started_at AT TIME ZONE 'Asia/Kolkata')::date AS ist_date
          FROM bench_session WHERE room_id = ${roomId}
        UNION
        SELECT ist_date FROM room_day WHERE room_id = ${roomId}
      )
      SELECT d.ist_date::text AS ist_date,
             rd.id AS room_day_id,
             COUNT(DISTINCT w.id)::int AS window_count,
             COUNT(DISTINCT w.id) FILTER (WHERE w.state = 'transcribed')::int AS transcribed_count,
             COUNT(DISTINCT rts.source_ref)::int AS turn_count,
             COALESCE(BOOL_OR(rts.role = 'clinician'), false) AS any_voice_match
        FROM days d
        LEFT JOIN room_day rd ON rd.room_id = ${roomId} AND rd.ist_date = d.ist_date
        LEFT JOIN bench_session s ON s.room_id = ${roomId} AND (s.started_at AT TIME ZONE 'Asia/Kolkata')::date = d.ist_date
        LEFT JOIN bench_window w ON w.session_id = s.id
        LEFT JOIN room_turn_speaker rts ON rts.window_id = w.id
       GROUP BY d.ist_date, rd.id
       ORDER BY d.ist_date DESC
    `) as RoomDayOverviewRow[];
  } catch {
    return [];
  }
}

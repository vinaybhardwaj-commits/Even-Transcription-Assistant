/**
 * lib/admin/rooms-live.ts — the live operator monitor's aggregation (24 Aug OPD day).
 *
 * READ-ONLY. Nothing in this file writes. The one write in the whole monitor is the command
 * route, which calls lib/bench-commands.ts's own decision functions rather than reimplementing
 * any of them.
 *
 * TWO CLOCKS, TWO DATABASES' WORTH OF SEPARATION. `bench_*` and `room` are read through the app
 * handle (lib/db); `cue` and `room_day` are read through the brain handle (lib/brain/db), the
 * same split every other reader in this codebase observes. They happen to live in one Postgres,
 * but the roles and the grants differ and this file does not blur that.
 *
 * THE VITAL THAT IS EASY TO GET WRONG, and the reason for the naming rules below.
 *
 * The doctor-clock gap is NOT "the warehouse is silent". even_hospitals.doctor_opd_rooms is null
 * on every hospital, so the warehouse holds no room at all: it can only ever tell us that ONE
 * LABELLED DOCTOR has or has not clocked. A gap therefore means that doctor has not clocked — it
 * does not mean the room is empty, and it does not mean Pulse is quiet. Another doctor may be
 * sitting in that room seeing patients the whole time. Reading it the other way is exactly what
 * turned a busy morning into an apparent six-hour blackout on 19 August, and every string in this
 * monitor is written to make that misreading impossible. See DOCTOR_CLOCK_LABEL below.
 */

import { sql } from "@/lib/db";
import { query as brainQuery } from "@/lib/brain/db";
import { WAREHOUSE_CUE_TYPES } from "@/lib/mcp/tools/fuse-report";
import { LISTENER_FRESH_MS, type ListenerRow } from "@/lib/bench-commands";
import { STALLED_BADGE_MINUTES } from "@/lib/bench-reaper-core";
import { ENDED_DISAGREES_SKEW_GRACE_MS, fmtCoarse } from "@/lib/bench-bus-constants";

/** The mark cue's type on the brain side. fuse-report keeps its own copy private; this is that
 *  same literal, and tests hold the two in agreement with 0054's index predicate. */
export const MARK_CUE_TYPE = "consult_mark";

/** The completeness marker speech-turns slice A writes, one per asked window. */
export const WINDOW_CUE_TYPE = "stt_window";

// ---------------------------------------------------------------------------
// Thresholds — settled, and every one of them lives here only
// ---------------------------------------------------------------------------

/**
 * MIC FRESHNESS, measured on bench_chunk.created_at — the UPLOAD clock, not ended_at.
 * A healthy mic therefore cycles from 0 to about five minutes as each chunk is closed and
 * uploaded, which is precisely why amber sits at 7 and not at 5: a mic that has just rotated is
 * not a mic in trouble.
 */
export const MIC_AMBER_MS = 7 * 60_000;
export const MIC_RED_MS = 10 * 60_000;

/**
 * THE DOCTOR CLOCK. Counted ONLY while a session is recording and the room is not paused, and
 * reset by any warehouse-typed cue. Never counted against a paused or ended room: a room that is
 * not recording is not a room anybody is failing to clock in.
 */
export const DOCTOR_CLOCK_AMBER_MS = 15 * 60_000;
export const DOCTOR_CLOCK_RED_MS = 30 * 60_000;

/**
 * THE LABEL, and it is normative. D13. Never "warehouse silent", never "no warehouse event" —
 * those phrases describe a system-wide outage and this vital cannot detect one.
 */
export const DOCTOR_CLOCK_LABEL = "this doctor";
export const DOCTOR_CLOCK_NOTE =
  "no Pulse clock from the labelled doctor. Another doctor may be in this room and seeing patients — the warehouse holds no room, so this cannot tell you the room is empty.";

export type Level = "ok" | "amber" | "red" | "unknown";

/** PURE. Age of the newest chunk on either mic → its level. Null age is unknown, never ok. */
export function micLevel(ageMs: number | null): Level {
  if (ageMs === null || !Number.isFinite(ageMs)) return "unknown";
  if (ageMs >= MIC_RED_MS) return "red";
  if (ageMs >= MIC_AMBER_MS) return "amber";
  return "ok";
}

/** PURE. The doctor clock's gap → its level. Null (not recording, or paused) is not a state to
 *  colour: there is nothing to be late for. */
export function doctorClockLevel(silentMs: number | null): Level {
  if (silentMs === null || !Number.isFinite(silentMs)) return "unknown";
  if (silentMs >= DOCTOR_CLOCK_RED_MS) return "red";
  if (silentMs >= DOCTOR_CLOCK_AMBER_MS) return "amber";
  return "ok";
}

export type ListenerState = "never" | "stale" | "listening" | "unknown";

/**
 * PURE. THREE STATES AND A FAILURE, never collapsed into a boolean:
 *
 *   never      no bench_listener row at all — no kiosk tab has ever polled for this room
 *   stale      a row older than the bus's own freshness window, with a real age to show
 *   listening  a row inside it
 *   unknown    the read itself failed. NOT "never": a bus outage is not an absent kiosk, and
 *              telling an operator to go and open a page that is already open wastes the one
 *              thing they have least of on a clinic day.
 */
export function listenerState(listener: ListenerRow | null, readFailed: boolean, nowMs: number): ListenerState {
  if (readFailed) return "unknown";
  if (!listener) return "never";
  const age = nowMs - new Date(listener.last_poll_at).getTime();
  return Number.isFinite(age) && age <= LISTENER_FRESH_MS ? "listening" : "stale";
}

// The six room states (K2 §1) live in lib/bench-bus-constants.ts — the PURE module that is safe
// to pull into a browser bundle. THIS file imports lib/db and lib/brain/db, so a client component
// importing roomState from here would drag a Postgres driver into the browser and fail the build.
// Re-exported so every server-side caller keeps one import path.
export {
  LISTENER_OFFLINE_MS,
  roomState,
  fmtDayIst,
  ENDED_DISAGREES,
  ENDED_DISAGREES_TITLE,
  ENDED_DISAGREES_HINT,
  ENDED_DISAGREES_SKEW_GRACE_MS,
  chunkDisagreesWithEnd,
  type RoomState,
  type RoomStateView,
} from "@/lib/bench-bus-constants";

/** PURE. IST is UTC+05:30 with no DST, so the day boundary is arithmetic and needs no Intl data.
 *  HALF-OPEN [from, to) so the range is sargable and bench_session_room_started_idx is usable —
 *  the reason the monitor writes its own session query instead of reusing listBenchSessions,
 *  whose AT TIME ZONE filter defeats any index on started_at. */
export { fmtCoarse };

export function istDayRangeUtc(istDate: string): { fromIso: string; toIso: string } {
  const from = Date.parse(`${istDate}T00:00:00.000+05:30`);
  return { fromIso: new Date(from).toISOString(), toIso: new Date(from + 86_400_000).toISOString() };
}

const ms = (v: string | Date | null | undefined): number | null => {
  if (v == null || v === "") return null;
  const t = v instanceof Date ? v.getTime() : Date.parse(String(v));
  return Number.isFinite(t) ? t : null;
};
const iso = (v: string | Date | null | undefined): string | null => {
  const t = ms(v);
  return t === null ? null : new Date(t).toISOString();
};

// ---------------------------------------------------------------------------
// Shapes
// ---------------------------------------------------------------------------

export type LiveSession = {
  id: string;
  room_id: string;
  status: string;
  started_at: string;
  ended_at: string | null;
  last_primary_at: string | null;
  last_backup_at: string | null;
  backup_chunks: number;
  primary_chunks: number;
  /** ENDED DISAGREES — pieces whose UPLOAD landed after this session's ended_at. */
  chunks_after_end: number;
};

export type RoomLive = {
  room: { id: string; slug: string; name: string };
  recording: boolean;
  paused_session: boolean;
  session_id: string | null;
  session_started_at: string | null;
  /** Mic — freshness of the newest chunk on EITHER source, on the upload clock. */
  last_primary_at: string | null;
  last_backup_at: string | null;
  last_piece_at: string | null;
  mic_level: Level;
  backup_chunks_today: number;
  /** Amber: a backup mic that recorded nothing at all this session. */
  backup_reads_no_chunks: boolean;
  stalled: boolean;
  stalled_age_ms: number | null;
  /**
   * ENDED DISAGREES — the session row says over and the tape says otherwise.
   *
   * Named beside the states, never folded into one: `roomState()` is a precedence chain where
   * the first match wins, and this is orthogonal to all six. A room can read ready, dropped or
   * offline AND still be taking chunks into an ended session — that is exactly what bs_g3dwud4p
   * looked like for six hours, and a chain would have shown one fact and hidden the other.
   * `paused_disagrees` sits beside the states for the same reason.
   *
   * DERIVED FROM THE CHUNK ROWS, not from the bench_event the chunk route writes. Same fact, two
   * witnesses, and this is the one that cannot be missed: the event exists only if the route saw
   * the chunk after this build shipped, whereas the chunks are the durable evidence and were
   * there all along. The event is the timeline record; this is the live read.
   */
  /** The two switches, as stored. Null-free: a room row always has them after 0065. */
  transcript_enabled: boolean;
  visits_enabled: boolean;
  transcript_counts: TranscriptCounts;
  visit_counts: VisitCounts;
  /** Ready-made lane rows — one place decides the words, so the screen and the MCP agree. */
  lanes: { tape: LaneView; transcript: LaneView; visits: LaneView };
  ended_disagrees: boolean;
  ended_disagrees_session_id: string | null;
  /** When the row says the session ended — the start of the disagreement, not of the session. */
  ended_disagrees_ended_at: string | null;
  /** Newest piece that landed after that, on the upload clock. */
  ended_disagrees_last_piece_at: string | null;
  ended_disagrees_chunks: number;
  /** The doctor clock. Null unless recording and not paused. */
  last_warehouse_at: string | null;
  doctor_clock_silent_ms: number | null;
  doctor_clock_level: Level;
  marks_today: number;
  last_mark_at: string | null;
  marks_not_sent: number;
  last_window_asked_at: string | null;
  last_window_complete: boolean | null;
  degraded: string[];
};

/**
 * Today, all rooms — the four numbers in the mockup's day card.
 *
 * MINUTES OF AUDIO, NEVER MONEY (R11). A rupee figure on a clinical monitor invites the wrong
 * conversation in front of the wrong person, and there is deliberately no field here that could
 * carry one.
 */
export type DaySummary = {
  audio_recorded_ms: number;
  turned_into_words_ms: number;
  gave_up: number;
  visits_built: number;
};

export type RoomsLiveResult = {
  ist_date: string;
  now: string;
  rooms: RoomLive[];
  day: DaySummary;
  thresholds: {
    mic_amber_ms: number;
    mic_red_ms: number;
    doctor_clock_amber_ms: number;
    doctor_clock_red_ms: number;
    listener_fresh_ms: number;
    stall_minutes: number;
  };
  degraded: string[];
};

// ---------------------------------------------------------------------------
// Reads — every one INFERRED (no live database in the build sandbox) and listed
// verbatim in the build report.
// ---------------------------------------------------------------------------

// The two app-side reads are written as TAGGED TEMPLATES, like every other reader in this
// codebase, rather than as parameterised strings. lib/db's `sql` is a Neon HTTP tag; reaching for
// `sql.query(text, params)` would work at runtime but returns undefined wherever the module is
// mocked as a bare tag — a silent empty monitor, which is the one failure this screen must not
// have. Both are listed verbatim in the build report.

/**
 * The brain-side rollup: the doctor clock and the marks, per room, for one IST day.
 * cue_warehouse_recent_idx and cue_mark_recent_idx (0054) serve the two FILTERs.
 */
export const SQL_ROOM_DAY_ROLLUP =
  "SELECT rd.room_id, " +
  "MAX(c.at) FILTER (WHERE c.type IN ('pqm_called', 'pstart', 'dx_event', 'pulse_note')) AS last_warehouse_at, " +
  "COUNT(c.id) FILTER (WHERE c.type = 'consult_mark')::int AS marks_today, " +
  "MAX(c.at)   FILTER (WHERE c.type = 'consult_mark') AS last_mark_at " +
  "FROM room_day rd LEFT JOIN cue c ON c.room_day_id = rd.id " +
  "WHERE rd.ist_date = $1::date AND rd.room_id = ANY($2::text[]) " +
  "GROUP BY rd.room_id";

/**
 * The newest completeness marker per room, for the day.
 *
 * NO DEDICATED INDEX — 0054 specifies four statements and this is not one of them, so this rides
 * cue_room_day_at_idx (0042) and filters. Flagged in the build report: on a day with thousands of
 * stt_turn rows the backward scan can read a long way before it meets an stt_window. It is on the
 * 20 s poll, never the 3 s one, and the fix if it ever bites is a fifth partial index.
 */
/**
 * The Visits lane: visits built on today's room-day, and how many are still open.
 * 'ended' is the only closed state in visit.state's CHECK, so open is everything else.
 * visit_room_day_idx (0042) serves the join.
 */
export const SQL_VISITS_TODAY =
  "SELECT rd.room_id, COUNT(v.id)::int AS built, " +
  "COUNT(v.id) FILTER (WHERE v.state <> 'ended')::int AS open " +
  "FROM room_day rd JOIN visit v ON v.room_day_id = rd.id " +
  "WHERE rd.ist_date = $1::date AND rd.room_id = ANY($2::text[]) " +
  "GROUP BY rd.room_id";

export const SQL_LAST_WINDOW_MARKER =
  "SELECT DISTINCT ON (rd.room_id) rd.room_id, c.at, c.payload " +
  "FROM room_day rd JOIN cue c ON c.room_day_id = rd.id " +
  "WHERE rd.ist_date = $1::date AND rd.room_id = ANY($2::text[]) AND c.type = 'stt_window' " +
  "ORDER BY rd.room_id, c.at DESC";

// ---------------------------------------------------------------------------
// The aggregation
// ---------------------------------------------------------------------------

type RoomRow = { id: string; slug: string; name: string; transcript_enabled: boolean; visits_enabled: boolean };

/**
 * The three lanes the card shows, in the operator's words (PRD R4). The interface never says
 * drain, fuse, window or subject — those are ours. `level` follows R6: GREEN MEANS WORKING. A
 * lane that is on with nothing to do is grey and says so, because "on" showing green while
 * nothing happens is the state that hid a nine-hour fault.
 */
/** The four lamp colours the mockup draws: green working, amber acting-needed, red audio at
 *  risk, grey off-or-idle. Its own union rather than `Level` — `Level` has "unknown", which a
 *  lane never is, and lacks "off", which is half of what a lane says. */
export type LaneLevel = "ok" | "amber" | "red" | "off";
export type LaneView = { level: LaneLevel; state: string; enabled: boolean | null };

/** Counts behind the Transcript lane, for one room, today. Derived from bench_window state. */
export type TranscriptCounts = { done: number; waiting: number; in_progress: number; failed: number; words_ms: number };
export type VisitCounts = { built: number; open: number };

/**
 * PURE — the three lanes, in plain words (PRD §7 and the approved mockup).
 *
 * THE RULE THAT MATTERS IS R6: GREEN MEANS WORKING. A lane that is switched on with nothing to
 * do is GREY and says "On, nothing to do". It is not green. An "on" lamp glowing over a room
 * where nothing is happening is precisely the display that let a nine-hour fault sit unnoticed
 * on Friday night, and the whole point of putting three lanes on the card is to stop reading a
 * switch position as evidence of work.
 */
export function tapeLane(r: {
  recording: boolean; paused_session: boolean; stalled: boolean; stalled_age_ms: number | null;
  session_started_at: string | null; primary_chunks: number; nowMs: number;
}): LaneView {
  if (r.stalled) {
    return { level: "red", state: `Says recording, silent ${fmtCoarse(r.stalled_age_ms ?? 0)}`, enabled: null };
  }
  if (r.paused_session) return { level: "amber", state: "Paused for consent", enabled: null };
  if (r.recording) {
    const since = ms(r.session_started_at);
    const dur = since === null ? null : r.nowMs - since;
    const pieces = `${r.primary_chunks} piece${r.primary_chunks === 1 ? "" : "s"}`;
    return { level: "ok", state: dur === null ? `Recording · ${pieces}` : `Recording · ${fmtCoarse(dur)} · ${pieces}`, enabled: null };
  }
  return { level: "off", state: "Not recording", enabled: null };
}

export function transcriptLane(enabled: boolean, c: TranscriptCounts): LaneView {
  if (!enabled) return { level: "off", state: "Off", enabled: false };
  const busy = c.done + c.waiting + c.in_progress + c.failed;
  if (busy === 0) return { level: "off", state: "On, nothing to do", enabled: true };
  const parts: string[] = [`${c.done} done`];
  if (c.waiting > 0) parts.push(`${c.waiting} waiting`);
  if (c.in_progress > 0) parts.push(`${c.in_progress} in progress`);
  if (c.failed > 0) parts.push(`${c.failed} failed`);
  // AMBER when anything is waiting or has given up — those are the two states a person can act
  // on. Green only when the queue is empty and nothing failed, which is what "up to date" means.
  const behind = c.waiting > 0 || c.failed > 0;
  return {
    level: behind ? "amber" : "ok",
    state: behind ? parts.join(", ") : `${parts.join(", ")} · up to date`,
    enabled: true,
  };
}

export function visitsLane(enabled: boolean, v: VisitCounts): LaneView {
  if (!enabled) return { level: "off", state: "Off", enabled: false };
  if (v.built === 0) return { level: "off", state: "On, nothing to do", enabled: true };
  return { level: "ok", state: `${v.built} today · ${v.open} open`, enabled: true };
}

/**
 * PURE — the per-room view, from rows already read. Every threshold decision happens here so it
 * can be tested without a database, and so the route stays a thin shell around it.
 */
export function buildRoomLive(
  room: RoomRow,
  sessions: readonly LiveSession[],
  counts: { transcript: TranscriptCounts; visits: VisitCounts },
  brain: {
    last_warehouse_at: string | null;
    marks_today: number;
    last_mark_at: string | null;
    last_window_asked_at: string | null;
    last_window_complete: boolean | null;
  },
  marksNotSent: number,
  nowMs: number,
  degraded: string[],
): RoomLive {
  // The live tape is the newest non-ended session. A paused room still has one.
  const live = sessions.find((s) => s.status === "recording") ?? sessions.find((s) => s.status === "paused") ?? null;
  const recording = live?.status === "recording";
  const pausedSession = live?.status === "paused";

  // Plain max-or-null. `Math.max(a ?? -Infinity, …) || null` looks equivalent and is not:
  // -Infinity is truthy, so a room with no piece at all would carry -Infinity into new Date()
  // and throw "Invalid time value" on the one screen that must never fail to render.
  const maxOf = (pick: (s: LiveSession) => string | null): number | null =>
    sessions.reduce<number | null>((acc, s) => {
      const t = ms(pick(s));
      return t !== null && (acc === null || t > acc) ? t : acc;
    }, null);
  const lastPrimary = maxOf((s) => s.last_primary_at);
  const lastBackup = maxOf((s) => s.last_backup_at);
  const newestPiece = [lastPrimary, lastBackup].filter((x): x is number => x !== null).sort((a, b) => b - a)[0] ?? null;

  // Mic freshness is only a question while something is recording. An ended room has no mic.
  const micAge = recording ? (newestPiece === null ? nowMs - (ms(live?.started_at) ?? nowMs) : nowMs - newestPiece) : null;

  const backupChunks = sessions.reduce((a, s) => a + (s.backup_chunks || 0), 0);
  // A backup mic that has recorded NOTHING all session. Amber, and it reads "no chunks" rather
  // than pretending the second microphone is fine because nobody has asked it for anything.
  const backupReadsNoChunks = Boolean(recording) && backupChunks === 0;

  // The stall badge is the reaper's own rule, imported and never re-derived.
  const stalledSession = sessions.find(
    (s) => s.status === "recording" && nowMs - (ms(s.last_primary_at) ?? ms(s.last_backup_at) ?? ms(s.started_at) ?? nowMs) > STALLED_BADGE_MINUTES * 60_000,
  ) ?? null;
  const stalledAge = stalledSession
    ? nowMs - (ms(stalledSession.last_primary_at) ?? ms(stalledSession.last_backup_at) ?? ms(stalledSession.started_at) ?? nowMs)
    : null;

  // ENDED DISAGREES. No extra query and no extra join: `chunks_after_end` rides the same
  // per-session aggregate that already counts pieces per microphone.
  //
  // A NORMAL end never trips this — but NOT for the reason it first appears. The kiosk marks the
  // session ended as soon as the recorder stops and only then finishes uploading its flush, so a
  // chunk ROW created after ended_at is the ordinary case, in every room, every evening. What the
  // count above measures is chunks whose CAPTURE began after the end, which a flush cannot
  // produce: it holds only the chunk that was already in progress.
  //
  // Worst first: if more than one session in the day disagrees, report the one still taking
  // audio most recently, because that is the one somebody has to walk to.
  const disagreeing = sessions
    .filter((sn) => sn.status === "ended" && sn.ended_at !== null && sn.chunks_after_end > 0)
    .sort((a, b) => {
      const at = Math.max(ms(a.last_primary_at) ?? 0, ms(a.last_backup_at) ?? 0);
      const bt = Math.max(ms(b.last_primary_at) ?? 0, ms(b.last_backup_at) ?? 0);
      return bt - at;
    })[0] ?? null;
  const disagreeLastPiece = disagreeing
    ? [ms(disagreeing.last_primary_at), ms(disagreeing.last_backup_at)].filter((x): x is number => x !== null).sort((a, b) => b - a)[0] ?? null
    : null;

  // THE DOCTOR CLOCK. Only while recording AND not paused; reset by any warehouse-typed cue,
  // and started from the tape's own start when the day has seen none yet.
  const clockBase = ms(brain.last_warehouse_at) ?? ms(live?.started_at ?? null);
  const doctorClockSilentMs = recording && !pausedSession && clockBase !== null ? Math.max(0, nowMs - clockBase) : null;

  const transcriptEnabled = Boolean(room.transcript_enabled);
  const visitsEnabled = Boolean(room.visits_enabled);
  const primaryChunks = sessions.reduce((a, sn) => a + (sn.primary_chunks || 0), 0);

  return {
    room: { id: room.id, slug: room.slug, name: room.name },
    recording: Boolean(recording),
    paused_session: Boolean(pausedSession),
    session_id: live?.id ?? null,
    session_started_at: live ? iso(live.started_at) : null,
    last_primary_at: lastPrimary === null ? null : new Date(lastPrimary).toISOString(),
    last_backup_at: lastBackup === null ? null : new Date(lastBackup).toISOString(),
    last_piece_at: newestPiece === null ? null : new Date(newestPiece).toISOString(),
    mic_level: micLevel(micAge),
    backup_chunks_today: backupChunks,
    backup_reads_no_chunks: backupReadsNoChunks,
    stalled: stalledSession !== null,
    stalled_age_ms: stalledAge,
    transcript_enabled: transcriptEnabled,
    visits_enabled: visitsEnabled,
    transcript_counts: counts.transcript,
    visit_counts: counts.visits,
    lanes: {
      tape: tapeLane({
        recording: Boolean(recording), paused_session: Boolean(pausedSession),
        stalled: stalledSession !== null, stalled_age_ms: stalledAge,
        session_started_at: live ? iso(live.started_at) : null, primary_chunks: primaryChunks, nowMs,
      }),
      transcript: transcriptLane(transcriptEnabled, counts.transcript),
      visits: visitsLane(visitsEnabled, counts.visits),
    },
    ended_disagrees: disagreeing !== null,
    ended_disagrees_session_id: disagreeing?.id ?? null,
    ended_disagrees_ended_at: disagreeing?.ended_at ?? null,
    ended_disagrees_last_piece_at: disagreeLastPiece === null ? null : new Date(disagreeLastPiece).toISOString(),
    ended_disagrees_chunks: disagreeing?.chunks_after_end ?? 0,
    last_warehouse_at: brain.last_warehouse_at,
    doctor_clock_silent_ms: doctorClockSilentMs,
    doctor_clock_level: doctorClockLevel(doctorClockSilentMs),
    marks_today: brain.marks_today,
    last_mark_at: brain.last_mark_at,
    marks_not_sent: marksNotSent,
    last_window_asked_at: brain.last_window_asked_at,
    last_window_complete: brain.last_window_complete,
    degraded,
  };
}

/**
 * PURE — a completeness marker's payload → complete / not / UNKNOWN.
 *
 * A marker whose payload never says `complete` reads as unknown, NEVER as failed. Reading that
 * silence as false invents a failure nothing reported, which is the same mistake as reading a
 * quiet doctor clock as a warehouse outage.
 */
export function markerComplete(payload: unknown): boolean | null {
  if (typeof payload !== "object" || payload === null || Array.isArray(payload)) return null;
  const v = (payload as Record<string, unknown>).complete;
  return typeof v === "boolean" ? v : null;
}

/**
 * The whole rollup. Every read is individually guarded: a failure degrades that section to empty
 * and names itself, and the monitor still renders. It never throws and never returns a 500.
 */
export async function readRoomsLive(now: Date = new Date()): Promise<RoomsLiveResult> {
  const nowMs = now.getTime();
  const istDate = new Date(nowMs + 5.5 * 3_600_000).toISOString().slice(0, 10);
  const { fromIso, toIso } = istDayRangeUtc(istDate);
  const topDegraded: string[] = [];

  let rooms: RoomRow[] = [];
  try {
    rooms = (await sql`
      SELECT id, slug, name, transcript_enabled, visits_enabled FROM room
       WHERE disabled_at IS NULL
         AND left(id, length('room_scratch_'::text)) <> 'room_scratch_'::text
       ORDER BY created_at
    `) as RoomRow[];
  } catch (e) {
    topDegraded.push(`rooms_unavailable:${String((e as Error)?.message ?? e).slice(0, 80)}`);
  }
  const roomIds = rooms.map((r) => r.id);

  let sessions: LiveSession[] = [];
  try {
    // Per-source FILTER copied from app/api/bench/sessions/active/route.ts, including
    // c.created_at — the UPLOAD clock, not ended_at. bench_chunk.source is NOT NULL DEFAULT
    // 'primary' (0045), so 'primary' and 'backup' are exhaustive and neither misses a row.
    // HALF-OPEN started_at range so bench_session_room_started_idx (0054) is usable; this is
    // why the monitor writes its own query rather than touching listBenchSessions.
    const rows = (await sql`
      SELECT s.id, s.room_id, s.status, s.started_at, s.ended_at,
             MAX(c.created_at) FILTER (WHERE c.source = 'primary') AS last_primary_at,
             MAX(c.created_at) FILTER (WHERE c.source = 'backup')  AS last_backup_at,
             COUNT(c.id)       FILTER (WHERE c.source = 'backup')  AS backup_chunks,
             COUNT(c.id)       FILTER (WHERE c.source = 'primary') AS primary_chunks,
             -- ENDED DISAGREES: pieces RECORDED after the row said the session was over.
             --
             -- c.started_at, NOT c.created_at, and this is the whole precision of the alarm. The
             -- kiosk marks the session ended as soon as the recorder stops and only then finishes
             -- uploading its flush, so on EVERY normal end of day a chunk row is created after
             -- ended_at while holding audio captured before it. The upload clock cannot tell that
             -- apart from a kiosk nobody told; the capture clock can.
             --
             -- Deliberately the opposite clock from the mic vitals above, which use created_at
             -- because they ask "is audio still ARRIVING". This asks "was it RECORDED after we
             -- stopped". The grace covers browser-vs-server skew only (see the constant).
             -- A FILTER on the aggregate that is already here — no extra query, no extra join,
             -- and s.ended_at is in the GROUP BY so it is legal to reference.
             COUNT(c.id) FILTER (
               WHERE s.ended_at IS NOT NULL
                 AND c.started_at > s.ended_at + make_interval(secs => ${ENDED_DISAGREES_SKEW_GRACE_MS / 1000}::int)
             ) AS chunks_after_end
        FROM bench_session s
        LEFT JOIN bench_chunk c ON c.session_id = s.id
       WHERE s.started_at >= ${fromIso}::timestamptz
         AND s.started_at <  ${toIso}::timestamptz
       GROUP BY s.id, s.room_id, s.status, s.started_at, s.ended_at
       ORDER BY s.started_at DESC
    `) as unknown[];
    sessions = normaliseSessions(rows);
  } catch (e) {
    topDegraded.push(`sessions_unavailable:${String((e as Error)?.message ?? e).slice(0, 80)}`);
  }
  const byRoom = new Map<string, LiveSession[]>();
  for (const s of sessions) {
    const list = byRoom.get(s.room_id) ?? [];
    list.push(s);
    byRoom.set(s.room_id, list);
  }

  const notSent = new Map<string, number>();
  const sessionIds = sessions.map((s) => s.id);
  if (sessionIds.length) {
    try {
      // Marks the kiosk could not get to the brain. bench_event_session_kind_idx (0054) serves it.
      const rows = (await sql`
        SELECT session_id, COUNT(*)::int AS n
          FROM bench_event
         WHERE session_id = ANY(${sessionIds}::text[])
           AND kind = 'consult_mark'
           AND brain_status <> 'sent'
         GROUP BY session_id
      `) as Array<{ session_id: string; n: number }>;
      for (const row of rows) notSent.set(row.session_id, Number(row.n) || 0);
    } catch (e) {
      topDegraded.push(`marks_not_sent_unavailable:${String((e as Error)?.message ?? e).slice(0, 80)}`);
    }
  }

  // ---- Transcript lane: bench_window state per room, today -------------------------------
  //
  // Windows are reached through their session, because bench_window carries session_id and the
  // day is already scoped by session start above. 'open' is NOT counted: a window still being
  // recorded into is not work waiting, and counting it would make every live room read "behind".
  const transcriptByRoom = new Map<string, TranscriptCounts>();
  if (sessionIds.length) {
    try {
      const rows = (await sql`
        SELECT s.room_id,
               COUNT(*) FILTER (WHERE w.state = 'transcribed')  ::int AS done,
               COUNT(*) FILTER (WHERE w.state = 'closed')       ::int AS waiting,
               COUNT(*) FILTER (WHERE w.state = 'transcribing') ::int AS in_progress,
               COUNT(*) FILTER (WHERE w.state = 'failed')       ::int AS failed,
               COALESCE(SUM(w.end_ms - w.start_ms) FILTER (WHERE w.state = 'transcribed'), 0)::bigint AS words_ms
          FROM bench_window w
          JOIN bench_session s ON s.id = w.session_id
         WHERE w.session_id = ANY(${sessionIds}::text[])
         GROUP BY s.room_id
      `) as Array<{ room_id: string; done: number; waiting: number; in_progress: number; failed: number; words_ms: string | number }>;
      for (const r of rows) {
        transcriptByRoom.set(r.room_id, {
          done: Number(r.done) || 0, waiting: Number(r.waiting) || 0,
          in_progress: Number(r.in_progress) || 0, failed: Number(r.failed) || 0,
          words_ms: Number(r.words_ms) || 0,
        });
      }
    } catch (e) {
      topDegraded.push(`transcript_counts_unavailable:${String((e as Error)?.message ?? e).slice(0, 80)}`);
    }
  }

  // ---- audio recorded today, per room. PRIMARY ONLY -------------------------------------
  // The backup lane records the same wall-clock in parallel, so summing both would report double
  // the audio that exists. This is minutes of tape, not minutes of file.
  const audioMsByRoom = new Map<string, number>();
  if (sessionIds.length) {
    try {
      const rows = (await sql`
        SELECT s.room_id, COALESCE(SUM(c.duration_ms), 0)::bigint AS audio_ms
          FROM bench_chunk c JOIN bench_session s ON s.id = c.session_id
         WHERE c.session_id = ANY(${sessionIds}::text[]) AND c.source = 'primary'
         GROUP BY s.room_id
      `) as Array<{ room_id: string; audio_ms: string | number }>;
      for (const r of rows) audioMsByRoom.set(r.room_id, Number(r.audio_ms) || 0);
    } catch (e) {
      topDegraded.push(`audio_minutes_unavailable:${String((e as Error)?.message ?? e).slice(0, 80)}`);
    }
  }

  const brainByRoom = new Map<string, { last_warehouse_at: string | null; marks_today: number; last_mark_at: string | null; last_window_asked_at: string | null; last_window_complete: boolean | null }>();
  const brainDegraded: string[] = [];
  const visitsByRoom = new Map<string, VisitCounts>();
  if (roomIds.length) {
    try {
      const r = await brainQuery<{ room_id: string; last_warehouse_at: Date | null; marks_today: number; last_mark_at: Date | null }>(SQL_ROOM_DAY_ROLLUP, [istDate, roomIds]);
      for (const row of r.rows) {
        brainByRoom.set(row.room_id, {
          last_warehouse_at: iso(row.last_warehouse_at),
          marks_today: Number(row.marks_today) || 0,
          last_mark_at: iso(row.last_mark_at),
          last_window_asked_at: null,
          last_window_complete: null,
        });
      }
    } catch (e) {
      brainDegraded.push(`brain_rollup_unavailable:${String((e as Error)?.message ?? e).slice(0, 80)}`);
    }
    try {
      // Visits lane: what the fuse has built on today's room-day, and how many are still open.
      const r = await brainQuery<{ room_id: string; built: number; open: number }>(SQL_VISITS_TODAY, [istDate, roomIds]);
      for (const row of r.rows) visitsByRoom.set(row.room_id, { built: Number(row.built) || 0, open: Number(row.open) || 0 });
    } catch (e) {
      brainDegraded.push(`visits_unavailable:${String((e as Error)?.message ?? e).slice(0, 80)}`);
    }
    try {
      const r = await brainQuery<{ room_id: string; at: Date; payload: unknown }>(SQL_LAST_WINDOW_MARKER, [istDate, roomIds]);
      for (const row of r.rows) {
        const prev = brainByRoom.get(row.room_id) ?? { last_warehouse_at: null, marks_today: 0, last_mark_at: null, last_window_asked_at: null, last_window_complete: null };
        brainByRoom.set(row.room_id, { ...prev, last_window_asked_at: iso(row.at), last_window_complete: markerComplete(row.payload) });
      }
    } catch (e) {
      brainDegraded.push(`window_marker_unavailable:${String((e as Error)?.message ?? e).slice(0, 80)}`);
    }
  }

  const ZERO_TRANSCRIPT: TranscriptCounts = { done: 0, waiting: 0, in_progress: 0, failed: 0, words_ms: 0 };
  const out = rooms.map((room) => {
    const mine = byRoom.get(room.id) ?? [];
    const brain = brainByRoom.get(room.id) ?? { last_warehouse_at: null, marks_today: 0, last_mark_at: null, last_window_asked_at: null, last_window_complete: null };
    const marksNotSent = mine.reduce((a, s) => a + (notSent.get(s.id) ?? 0), 0);
    const counts = {
      transcript: transcriptByRoom.get(room.id) ?? ZERO_TRANSCRIPT,
      visits: visitsByRoom.get(room.id) ?? { built: 0, open: 0 },
    };
    return buildRoomLive(room, mine, counts, brain, marksNotSent, nowMs, [...brainDegraded]);
  });

  const day: DaySummary = {
    audio_recorded_ms: [...audioMsByRoom.values()].reduce((a, b) => a + b, 0),
    turned_into_words_ms: out.reduce((a, r) => a + r.transcript_counts.words_ms, 0),
    gave_up: out.reduce((a, r) => a + r.transcript_counts.failed, 0),
    visits_built: out.reduce((a, r) => a + r.visit_counts.built, 0),
  };

  return {
    ist_date: istDate,
    now: now.toISOString(),
    rooms: out,
    day,
    thresholds: {
      mic_amber_ms: MIC_AMBER_MS,
      mic_red_ms: MIC_RED_MS,
      doctor_clock_amber_ms: DOCTOR_CLOCK_AMBER_MS,
      doctor_clock_red_ms: DOCTOR_CLOCK_RED_MS,
      listener_fresh_ms: LISTENER_FRESH_MS,
      stall_minutes: STALLED_BADGE_MINUTES,
    },
    degraded: topDegraded,
  };
}

/** Rows in, LiveSession out. Tolerant: a row missing a count is 0, never NaN. */
export function normaliseSessions(rows: readonly unknown[]): LiveSession[] {
  const out: LiveSession[] = [];
  for (const raw of rows) {
    if (typeof raw !== "object" || raw === null) continue;
    const r = raw as Record<string, unknown>;
    if (typeof r.id !== "string" || typeof r.room_id !== "string") continue;
    out.push({
      id: r.id,
      room_id: r.room_id,
      status: String(r.status ?? "unknown"),
      started_at: iso(r.started_at as string) ?? new Date(0).toISOString(),
      ended_at: iso(r.ended_at as string),
      last_primary_at: iso(r.last_primary_at as string),
      last_backup_at: iso(r.last_backup_at as string),
      backup_chunks: Number(r.backup_chunks) || 0,
      primary_chunks: Number(r.primary_chunks) || 0,
      chunks_after_end: Number(r.chunks_after_end) || 0,
    });
  }
  return out;
}

export { WAREHOUSE_CUE_TYPES };

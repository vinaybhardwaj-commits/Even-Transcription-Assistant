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
import { LISTENER_FRESH_MS, listListeners, type ListenerRow } from "@/lib/bench-commands";
import { STALLED_BADGE_MINUTES } from "@/lib/bench-reaper-core";
import { ENDED_DISAGREES_SKEW_GRACE_MS, fmtCoarse } from "@/lib/bench-bus-constants";
// EVERY DECISION ON THIS SCREEN IS MADE IN lib/room-facts.ts, and the door makes it there too
// (Build 1 §3.6). Re-exported below so no caller's import path changed.
import {
  MIC_AMBER_MS, MIC_RED_MS, DOCTOR_CLOCK_AMBER_MS, DOCTOR_CLOCK_RED_MS,
  micLevel, doctorClockLevel, doctorClockSilentMs, hasDoctorClock, endedAtLies,
  tapeLane, transcriptLane, visitsLane, strandedAudio, strandedTotal, ZERO_STRANDED_RAW,
  type Level, type LaneView, type TranscriptCounts, type VisitCounts,
  type Stranded, type StrandedRaw,
} from "@/lib/room-facts";
import { readAudioMs, readMicSizes, readTranscriptAndStranded, readWaitingAudioCounts } from "@/lib/admin/room-reads";
import type { MicHealth } from "@/lib/mic-health";

/** The mark cue's type on the brain side. fuse-report keeps its own copy private; this is that
 *  same literal, and tests hold the two in agreement with 0054's index predicate. */
export const MARK_CUE_TYPE = "consult_mark";

/** The completeness marker speech-turns slice A writes, one per asked window. */
export const WINDOW_CUE_TYPE = "stt_window";

// ---------------------------------------------------------------------------
// Thresholds, levels and lanes — ALL of them now live in lib/room-facts.ts, which is PURE and
// which lib/mcp/tools/bench.ts imports too, so the screen and the door cannot hold different
// numbers or different words for the same room. Re-exported here so every existing import path
// through this module keeps working unchanged.
// ---------------------------------------------------------------------------
export {
  MIC_AMBER_MS, MIC_RED_MS, DOCTOR_CLOCK_AMBER_MS, DOCTOR_CLOCK_RED_MS,
  DOCTOR_CLOCK_LABEL, DOCTOR_CLOCK_NOTE,
  micLevel, doctorClockLevel, doctorClockSilentMs, hasDoctorClock, endedAtLies,
  tapeLane, transcriptLane, visitsLane,
  strandedAudio, strandedTotal, ZERO_STRANDED_RAW,
  WAITING_PHRASE, STRANDED_MEASURE_NOTE, STRANDED_WAITING, STRANDED_NO_DAY, STRANDED_NEVER_CLOSED,
  type Level, type LaneLevel, type LaneView, type TranscriptCounts, type VisitCounts,
  type Stranded, type StrandedRaw, type StrandedReason,
} from "@/lib/room-facts";

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
  NO_DAY_TITLE,
  NO_DAY_FIX,
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
  /**
   * §2.3 — THE SIZE VITAL, beside the freshness vital and never instead of it.
   *
   * Freshness answers "is audio still arriving". This answers the question that let four hours of
   * Cardiology go unnoticed: "is what arrives actually audio". Each microphone judged against a
   * baseline learned from THAT ROOM'S OWN recent pieces on THAT SAME microphone, so the rule works
   * on a rig with one microphone — which is the normal case (D32).
   */
  mic_size: MicHealth | null;
  spare_size: MicHealth | null;
  /** D32 — a spare EXISTS only where one actually recorded. Most rooms have one microphone and
   *  the card says nothing at all about a spare for them: no lane, no placeholder, no vital. */
  spare_exists: boolean;
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
  /** Finished windows with no job across ALL clinic days. Drives the manual paid recovery control. */
  waiting_audio_count: number;
  visit_counts: VisitCounts;
  /**
   * D7 — MINUTES THAT CANNOT CURRENTLY BE TURNED INTO WORDS, split by reason.
   *
   * Measured in fifteen-minute slots, which is NOT the measure `audio_recorded_ms` below uses.
   * Both are honest and they do not subtract; STRANDED_MEASURE_NOTE is the sentence every
   * surface showing both must carry.
   */
  stranded: Stranded;
  /** Audio recorded in this room today, summed from the PIECES. Primary mic only — the backup
   *  records the same wall-clock in parallel, so summing both would double the day. */
  audio_recorded_ms: number;
  /**
   * Does a room_day exist for this room TODAY?
   *
   * NULL means we could not tell — the brain read failed — and null must never be read as
   * "no". Telling an operator to press a button because a database was briefly unreachable is
   * how a good alarm becomes one people learn to ignore.
   */
  has_room_day_today: boolean | null;
  /** Ready-made lane rows — one place decides the words, so the screen and the MCP agree. */
  lanes: { tape: LaneView; transcript: LaneView; visits: LaneView };
  ended_disagrees: boolean;
  /**
   * THE MIRROR IMAGE, and until Build 1 the screen did not have it (§3.6).
   *
   * `ended_disagrees` is the tape running on after the ROW said stop. This is the row claiming
   * to have run on after the TAPE stopped: a stored ended_at later than the last piece by more
   * than the stall window. The door has raised it since it was written and the screen never
   * could, so an operator and a watcher looking at one room saw two different faults.
   */
  ended_at_lies: boolean;
  ended_at_lies_sessions: string[];
  /** D30 — the room's most recent session today is `ended`. The seventh state's own input. */
  last_session_ended: boolean;
  ended_disagrees_session_id: string | null;
  /** When the row says the session ended — the start of the disagreement, not of the session. */
  ended_disagrees_ended_at: string | null;
  /** Newest piece that landed after that, on the upload clock. */
  ended_disagrees_last_piece_at: string | null;
  ended_disagrees_chunks: number;
  /**
   * THE DOCTOR CLOCK. Null unless recording, not paused, AND a genuine warehouse-typed cue
   * exists on the room-day. There is no fallback to the session's start any more (§3.1) — the
   * number that produced was the length of the recording wearing a clock gap's label, and it
   * turned every room in the estate red thirty minutes in.
   */
  last_warehouse_at: string | null;
  /** Does a genuine warehouse-typed cue exist today? The card renders the row only if it does:
   *  a vital nothing feeds should not hold a line on a clinic screen saying nothing. */
  has_doctor_clock: boolean;
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
  /** D7 — the figure that was over eight hours on 24 August and was nowhere on the screen. */
  stranded: Stranded;
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
 * PURE — the per-room view, from rows already read. Every threshold decision happens here so it
 * can be tested without a database, and so the route stays a thin shell around it.
 */
export function buildRoomLive(
  room: RoomRow,
  sessions: readonly LiveSession[],
  counts: {
    transcript: TranscriptCounts;
    visits: VisitCounts;
    has_room_day_today?: boolean | null;
    stranded_raw?: StrandedRaw;
    audio_recorded_ms?: number;
    mic_size?: MicHealth | null;
    spare_size?: MicHealth | null;
    spare_exists?: boolean;
    waiting_audio_count?: number;
  },
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

  // THE DOCTOR CLOCK, and the fallback that used to be on this line is GONE (§3.1).
  //
  // It read `ms(brain.last_warehouse_at) ?? ms(live?.started_at)`, so a room with no warehouse
  // cue — which is every room, because nothing in production writes one — had the length of its
  // own recording displayed as a clock gap. Amber at fifteen minutes, red at thirty, every room,
  // every day. And the door had no such fallback, so the two surfaces reported different numbers
  // for the same room. With no cue the answer is now NULL: we cannot tell, the row does not
  // render, and no attention item can fire. The thresholds are untouched and the vital returns
  // intact the day something feeds it.
  const clockSilentMs = doctorClockSilentMs({
    lastWarehouseAt: brain.last_warehouse_at,
    recording: Boolean(recording),
    paused: Boolean(pausedSession),
    nowMs,
  });

  const hasRoomDayToday = counts.has_room_day_today ?? null;
  const transcriptEnabled = Boolean(room.transcript_enabled);
  const visitsEnabled = Boolean(room.visits_enabled);
  const primaryChunks = sessions.reduce((a, sn) => a + (sn.primary_chunks || 0), 0);

  // ENDED_AT LIES — the door's check, now the screen's too (§3.6). A stored end LATER than the
  // last piece by more than the stall window. No new query: both stamps are already here.
  const liars = sessions.filter((sn) => {
    const tape = [ms(sn.last_primary_at), ms(sn.last_backup_at), ms(sn.started_at)]
      .filter((x): x is number => x !== null)
      .sort((a, b) => b - a)[0] ?? null;
    return endedAtLies(ms(sn.ended_at), tape, STALLED_BADGE_MINUTES * 60_000);
  });

  // D30 — is the room's MOST RECENT session today an ended one? Computed from the rows rather
  // than trusting the caller's ordering, because a state this visible must not depend on an
  // ORDER BY somewhere else.
  const newest = sessions.reduce<LiveSession | null>((acc, sn) => {
    const t = ms(sn.started_at);
    if (t === null) return acc;
    const at = acc === null ? null : ms(acc.started_at);
    return at === null || t > at ? sn : acc;
  }, null);
  const lastSessionEnded = newest?.status === "ended" && !recording && !pausedSession;

  const stranded = strandedAudio(counts.stranded_raw ?? ZERO_STRANDED_RAW, hasRoomDayToday);

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
    mic_size: counts.mic_size ?? null,
    spare_size: counts.spare_size ?? null,
    spare_exists: Boolean(counts.spare_exists),
    stalled: stalledSession !== null,
    stalled_age_ms: stalledAge,
    transcript_enabled: transcriptEnabled,
    visits_enabled: visitsEnabled,
    transcript_counts: counts.transcript,
    waiting_audio_count: Number(counts.waiting_audio_count) || 0,
    visit_counts: counts.visits,
    stranded,
    audio_recorded_ms: Number(counts.audio_recorded_ms) || 0,
    has_room_day_today: hasRoomDayToday,
    lanes: {
      tape: tapeLane({
        recording: Boolean(recording), paused_session: Boolean(pausedSession),
        stalled: stalledSession !== null, stalled_age_ms: stalledAge,
        session_started_at: live ? iso(live.started_at) : null, primary_chunks: primaryChunks, nowMs,
      }),
      transcript: transcriptLane(transcriptEnabled, counts.transcript, hasRoomDayToday),
      visits: visitsLane(visitsEnabled, counts.visits),
    },
    ended_disagrees: disagreeing !== null,
    ended_at_lies: liars.length > 0,
    ended_at_lies_sessions: liars.map((sn) => sn.id),
    last_session_ended: Boolean(lastSessionEnded),
    ended_disagrees_session_id: disagreeing?.id ?? null,
    ended_disagrees_ended_at: disagreeing?.ended_at ?? null,
    ended_disagrees_last_piece_at: disagreeLastPiece === null ? null : new Date(disagreeLastPiece).toISOString(),
    ended_disagrees_chunks: disagreeing?.chunks_after_end ?? 0,
    last_warehouse_at: brain.last_warehouse_at,
    has_doctor_clock: hasDoctorClock(brain.last_warehouse_at),
    doctor_clock_silent_ms: clockSilentMs,
    doctor_clock_level: doctorClockLevel(clockSilentMs),
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

  // ---- Transcript lane, stranded audio and minutes of tape ------------------------------
  //
  // BOTH READS ARE lib/admin/room-reads.ts's, WHICH THE DOOR CALLS TOO (§3.6). The counts on
  // this screen and the counts scribe_diff_room reports are now literally the same query, so
  // they cannot drift the way the doctor clock and the end-time checks did.
  const tsRead = await readTranscriptAndStranded(sessionIds);
  if (tsRead.degraded) topDegraded.push(tsRead.degraded);
  const transcriptByRoom = tsRead.value;

  // §3.10 recovery is intentionally all-history. Today's transcript/stranded rollup above stays
  // day-scoped; this independent count is the control's own eligibility query.
  const waitingRead = await readWaitingAudioCounts(roomIds);
  if (waitingRead.degraded) topDegraded.push(waitingRead.degraded);
  const waitingAudioByRoom = waitingRead.value;

  const audioRead = await readAudioMs(sessionIds);
  if (audioRead.degraded) topDegraded.push(audioRead.degraded);
  const audioMsByRoom = audioRead.value;

  // §2.3 — the size vital. Its own read and its own failure: if this one breaks, the size vital
  // reads UNKNOWN on every card and every other vital on the page is untouched.
  const sizeRead = await readMicSizes(sessionIds);
  if (sizeRead.degraded) topDegraded.push(sizeRead.degraded);
  const sizeByRoom = sizeRead.value;

  // §2.4 (D32/P8) — A SPARE EXISTS ONLY WHERE THE CLIENT REPORTED A SECOND DEVICE, never where a
  // backup piece merely arrived. Read from bench_listener.spare_device, on its OWN try/catch: a
  // bus fault degrades this to "no spare reported anywhere" (the safe direction — draw no spare
  // lane) and touches no other vital, and it must never be allowed to spread and silence the
  // no-day alarm (Build 3 §4). The browser kiosk never sets the flag, so today every rig reads
  // false and the phantom Home Office spare disappears from the page.
  const spareDeviceByRoom = new Map<string, boolean>();
  try {
    for (const l of await listListeners(now)) spareDeviceByRoom.set(l.room_id, l.spare_device === true);
  } catch (e) {
    topDegraded.push(`spare_device_unavailable:${String((e as Error)?.message ?? e).slice(0, 60)}`);
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

  const ZERO_TRANSCRIPT: TranscriptCounts = { done: 0, waiting: 0, no_day: 0, in_progress: 0, failed: 0, words_ms: 0 };
  const out = rooms.map((room) => {
    const mine = byRoom.get(room.id) ?? [];
    const brain = brainByRoom.get(room.id) ?? { last_warehouse_at: null, marks_today: 0, last_mark_at: null, last_window_asked_at: null, last_window_complete: null };
    const marksNotSent = mine.reduce((a, s) => a + (notSent.get(s.id) ?? 0), 0);
    // Does today's room_day exist for this room? SQL_ROOM_DAY_ROLLUP selects FROM room_day, so a
    // room with no day yields no row and is absent from the map. If the brain read FAILED we
    // cannot tell, and null is passed rather than false — see has_room_day_today.
    const dayKnown = brainDegraded.length === 0;
    const ts = transcriptByRoom.get(room.id) ?? null;
    const counts = {
      transcript: ts?.counts ?? ZERO_TRANSCRIPT,
      visits: visitsByRoom.get(room.id) ?? { built: 0, open: 0 },
      has_room_day_today: dayKnown ? brainByRoom.has(room.id) : null,
      stranded_raw: ts?.stranded ?? ZERO_STRANDED_RAW,
      audio_recorded_ms: audioMsByRoom.get(room.id) ?? 0,
      mic_size: sizeByRoom.get(room.id)?.primary ?? null,
      spare_size: sizeByRoom.get(room.id)?.backup ?? null,
      // §2.4 — from the reported device, NOT from sizeByRoom's backup-piece count. A rig that
      // wrote backup pieces from an auto-picked phantom device but reported no second device has
      // no spare here.
      spare_exists: spareDeviceByRoom.get(room.id) ?? false,
      waiting_audio_count: waitingAudioByRoom.get(room.id) ?? 0,
    };
    return buildRoomLive(room, mine, counts, brain, marksNotSent, nowMs, [...brainDegraded]);
  });

  const day: DaySummary = {
    audio_recorded_ms: [...audioMsByRoom.values()].reduce((a, b) => a + b, 0),
    turned_into_words_ms: out.reduce((a, r) => a + r.transcript_counts.words_ms, 0),
    gave_up: out.reduce((a, r) => a + r.transcript_counts.failed, 0),
    visits_built: out.reduce((a, r) => a + r.visit_counts.built, 0),
    // D7 — summed from the ROOMS, so the day figure and the cards can never disagree, and so
    // each room's own has_room_day_today guard is applied before anything is added up.
    stranded: strandedTotal(out.map((r) => r.stranded)),
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

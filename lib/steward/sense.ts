/**
 * lib/steward/sense.ts — Room Steward part 2: what is true about each room RIGHT NOW (read-only; nothing here acts on a room).
 *
 * senseAll(sql, asOf, roster, degraded?) -> Map<room_id, RoomSense>. A BOUNDED set of statements, each machine-scoped (machine = ANY / = m.n) or room-scoped
 * (room_id = ANY) and time-bounded to asOf (the full list with bounds is in the steward-2 notes and the comment on each statement below). Everything the existing
 * readers already compute is REUSED, not re-queried: readKioskHealth (recorder.status, heartbeat, audio.devices, chrome.profile/alert, enrolment), extHealth
 * (ext status, poller idle) and scopedOccupancy (occupancy, pending login, identity fault; roster-scoped, 2 h), isSilentChunk / evaluateStartBackoff (R3 silence by rate, start backoff).
 *
 * FAILURE CONTRACT. Every source is read through safe(): a source that throws is NAMED in `degraded` and its fields stay null; the room's `missing` lists every null
 * input by name so a rule can say WHY it did not fire. A failed source never throws out of senseAll.
 *
 * `inputs` the rules read never carry names or PHI: ids, booleans, ISO times and counts only.
 */
import { REHOME_NOTE_PREFIX } from "@/lib/bench-reaper-core";
import type { WindowsDb } from "@/lib/encounter-windows/db";
import { extHealth, isExtHealthExcluded, type ExtHealthRoom, type ExtHealthRow, type ExtStatus } from "@/lib/encounter-windows/ext-health";
import { machineKeys } from "@/lib/encounter-windows/machine-keys";
import { scopedOccupancy, type ScopedOccupancy } from "./occupancy-read";
import { DEFAULT_SOURCE_TIMEOUT_MS } from "./config";
import { KH_ASLEEP_MAX_AGE_MS, KH_HEARTBEAT_AFTER_SLEEP_MS } from "@/lib/kiosk-health-rules";
import { SourceTimeout, raceTimeout } from "./timeout";
import { canonicalMachine, expandKeys, matchKey, readKioskHealth, type KioskHealthSnapshot } from "@/lib/kiosk-health-read";
import { START_ACK_SESSION_GRACE_S, type StartAttempt } from "@/lib/bench-commands";
import { LISTENER_FRESH_MS, SILENT_MS, SILENT_ZERO_RATIO, parseInstallState } from "@/lib/bench-bus-constants";
import { isSilentChunk, SILENT_CHUNKS_REQUIRED } from "@/lib/fleet-attention";
import { istMidnightOf, normalizeMachine, type RoomClass, type RosterRoom, type ScheduleKind } from "./config";
import type { StewardSql } from "./tickets";

export type RecorderStatus = { state: string | null; session_open: boolean | null; received_at: string };

/** the late-evening start gates read their data from this IST time of day (20:00) */
export const DAY_GATES_FROM_MS = 20 * 3_600_000;

export type RoomSense = {
  room_id: string;
  room_name: string;
  machine: string | null;
  klass: RoomClass;
  kind: ScheduleKind;
  flags: string[];
  as_of: string;
  recording: {
    session_open: boolean | null;
    session_id: string | null;
    session_status: "recording" | "paused" | null;
    session_started_at: string | null;
    /** newest bench chunk of the open session (any age), or null */
    last_chunk_at: string | null;
    /** newest bench chunk of ANY of the room's sessions in the last 24 h (visibility for inputs.last_chunk_s; no rule reads it), null when there is none */
    last_chunk_24h_at?: string | null;
    /** the recorder.status history of the last 30 min (kiosk_health_events), newest first walk: `latest_*` = the newest row; `ready_since` / `ready_samples` = the oldest received_at and the count of the contiguous run of rows that are state "ready" with session_open false ending at the newest row (null when the newest row is not ready). null = no recorder.status row at all (no kiosk-health). */
    recorder_history?: { latest_at: string; latest_state: string | null; latest_session_open: string | null; ready_since: string | null; ready_samples: number } | null;
    recorder_status: RecorderStatus | null;
  };
  /** bench_listener: the browser-kiosk poll. `paused` is the consent pause: the steward never starts a paused room. */
  listener: { listening: boolean | null; paused: boolean | null };
  reachable: {
    poller_ok_at: string | null;
    kh_heartbeat_at: string | null;
    kh_enrolled: boolean | null;
    /** the kiosk-health sleep marker (bench rule R11 derivation, see khSleepMarker): ISO ts of a sleep/darkwake/display-off event with no wake and no heartbeat since, else null */
    sleep_at?: string | null;
  };
  chrome: {
    running: boolean | null;
    active: string[] | null;
    last_used: string | null;
    presence_ok: boolean | null;
    last_alert_reason: string | null;
    last_alert_at: string | null;
  };
  ext: { applicable: boolean; status: ExtStatus | null; last_event_at: string | null; last_heartbeat_reason: string | null; no_tab: boolean | null };
  /** S7: a presence encounter_open with no later close, or an open eta_encounter_windows row. null = cannot tell. */
  consult_open: boolean | null;
  consult_started_at: string | null;
  occupancy: { state: "nobody" | "present" | "pending"; idle_s: number | null; identity_fault: boolean } | null;
  audio: {
    default_input_present: boolean | null;
    /** ISO received_at of the newest audio.devices row, any age (visibility only; never a missing input), null when none */
    devices_at?: string | null;
    usb_removed_recent: boolean | null;
    device_missing_flag: boolean | null;
    silent_while_recording_since: string | null;
    /** room_install.expected_device_name: the input device this room should be on (the name an alert names), null when never reported */
    configured_device?: string | null;
    /** the default input's name in the newest audio.devices row, null when unknown */
    default_input_name?: string | null;
  };
  /** this room's steward start_day commands since IST midnight (bench_command source 'steward'), oldest first; null = unreadable */
  start_attempts: StartAttempt[] | null;
  /** the late-evening start gates (rules.ts G2/G3/G4): read only from 20:00 IST. operator_end_at = newest NON-steward end_day acked in this IST day at or after 20:00 IST; session_today = the room started a bench session this IST day. undefined = not read (before 20:00 IST); null = the read failed. */
  day?: { operator_end_at: string | null; session_today: boolean } | null;
  /** newest bench session started this IST day, any status, re-homed sessions excluded (the REHOME note test of main's start schedule); null = none today OR the read failed (an episode is then not closed) */
  session_start_today_at?: string | null;
  /** every input that was null (source failed, or the machine simply has no row), by name */
  missing: string[];
};

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

const toIso = (x: unknown): string | null => {
  if (x === null || x === undefined) return null;
  const t = new Date(x as string | number | Date).getTime();
  return Number.isFinite(t) ? new Date(t).toISOString() : null;
};
const numOrNull = (x: unknown): number | null => {
  if (x === null || x === undefined || x === "") return null;
  const n = Number(x);
  return Number.isFinite(n) ? n : null;
};
const jsonVal = (v: unknown): unknown => {
  if (typeof v === "string") {
    try {
      return JSON.parse(v);
    } catch {
      return null;
    }
  }
  return v;
};
/**
 * recorder.status.session_open as the daemon writes it (eta-kiosk-health RecorderState.swift): "yes" / "no" / "unknown". "yes" and true = open, "no" and false = closed,
 * anything else ("unknown", null, junk) = null: NOT closed, so every gate that needs "closed" fails closed. The legacy "true" / "false" spellings are accepted too.
 */
export const sessionOpenOf = (v: unknown): boolean | null => (v === true || v === "yes" || v === "true" ? true : v === false || v === "no" || v === "false" ? false : null);
const boolOrNull = (v: unknown): boolean | null => (v === true || v === "true" ? true : v === false || v === "false" ? false : null);

/** Limits for one sense pass: every source read has a timeout, and nothing new starts after the deadline. */
export type SenseLimits = {
  /** per-source timeout (steward_config source_timeout_ms), default 6000 */
  sourceTimeoutMs?: number;
  /** absolute time (in `now()` units) after which no source is started and a running one is cut: the tick keeps the rest of its budget for the decisions INSERT */
  deadlineMs?: number;
  now?: () => number;
};

/**
 * A source read with a timeout (min of the per-source timeout and the time left to the deadline). A failure names the source in `degraded`; a timeout names
 * `<source>:timeout`; a source not started because the deadline had passed names `<source>:skipped`. The fallback stands in for the data in every case.
 */
export async function safeRead<T>(lim: SenseLimits, source: string, degraded: string[], fn: () => Promise<T>, fallback: T): Promise<{ v: T; ok: boolean }> {
  const now = lim.now ?? Date.now;
  const mark = (name: string) => {
    if (!degraded.includes(name)) degraded.push(name);
  };
  const left = lim.deadlineMs === undefined ? Number.POSITIVE_INFINITY : lim.deadlineMs - now();
  if (left <= 0) {
    mark(`${source}:skipped`);
    return { v: fallback, ok: false };
  }
  const ms = Math.min(lim.sourceTimeoutMs ?? DEFAULT_SOURCE_TIMEOUT_MS, left);
  try {
    return { v: await raceTimeout(fn, ms), ok: true };
  } catch (e) {
    if (e instanceof SourceTimeout) {
      console.error(`[steward-sense] ${source} timed out after ${Math.round(ms)} ms`);
      mark(`${source}:timeout`);
    } else {
      console.error(`[steward-sense] could not read ${source}:`, e instanceof Error ? e.message.slice(0, 200) : String(e).slice(0, 200));
      mark(source);
    }
    return { v: fallback, ok: false };
  }
}

const groupBy = <T extends { room_id: string }>(rows: T[]): Map<string, T[]> => {
  const m = new Map<string, T[]>();
  for (const r of rows) {
    const a = m.get(r.room_id);
    if (a) a.push(r);
    else m.set(r.room_id, [r]);
  }
  return m;
};

/**
 * The kiosk-health SLEEP marker, same derivation as bench rule R11 (lib/kiosk-health-rules.ts): the newest of power.sleep / power.darkwake / power.wake by EVENT time is a
 * sleep or darkwake, it happened within 12 h of asOf, and no heartbeat was received after its ts + 180 s. A display.state "off" (a sleeping display; "on" and "unknown" are not-off, "unknown" = ioreg gave no reading) newer than that power event counts the
 * same way. Returns the ISO ts of the sleep, or null. Pure. Needs an enrolled snapshot (any kiosk-health row in 7 days).
 */
export function khSleepMarker(kh: KioskHealthSnapshot | undefined | null, A: number): string | null {
  if (!kh || !kh.enrolled) return null;
  const tsOf = (e: { ts: string; received_at: string }) => Date.parse(e.ts);
  const state = kh.power_events.filter((e) => e.kind === "power.sleep" || e.kind === "power.darkwake" || e.kind === "power.wake");
  const newest = state.reduce<(typeof state)[number] | null>((best, e) => (!best || tsOf(e) > tsOf(best) || (tsOf(e) === tsOf(best) && Date.parse(e.received_at) > Date.parse(best.received_at)) ? e : best), null);
  let candidate: number | null = null;
  if (newest && newest.kind !== "power.wake") candidate = tsOf(newest);
  const ds = kh.last_display_state;
  if (ds && ds.state === "off" && Number.isFinite(Date.parse(ds.ts)) && (!newest || Date.parse(ds.ts) > tsOf(newest))) candidate = Date.parse(ds.ts);
  if (candidate === null || !Number.isFinite(candidate)) return null;
  const hb = kh.last_heartbeat_received_at ? Date.parse(kh.last_heartbeat_received_at) : NaN;
  const heartbeatedSince = Number.isFinite(hb) && hb > candidate + KH_HEARTBEAT_AFTER_SLEEP_MS;
  if (A - candidate > KH_ASLEEP_MAX_AGE_MS || heartbeatedSince) return null;
  return new Date(candidate).toISOString();
}

export const SENSE_BOUNDS = {
  /** newest poller `ok` row per machine (24 h: kiosk_asleep needs "awake today" and "any data in 2 h"; one LIMIT 1 index probe per spelling, so the width costs nothing when rows exist) */
  poller_lookback_min: 24 * 60,
  /** and at most this many of the machine's newest rows are examined per spelling (the poller `ok` is picked from them): the cost bound of the wide lookback */
  poller_scan_rows: 720,
  /** newest ext event of any kind (explains no_tab) */
  ext_event_lookback_h: 2,
  /** newest ext heartbeat */
  ext_heartbeat_lookback_min: 30,
  /** consult: presence open/close events and open windows (the resolver caps a consult at 90 min) */
  consult_lookback_min: 90,
  /** newest chrome.profile (for active[]) */
  chrome_profile_lookback_min: 30,
  /** audio.devices rows for the present -> absent transition */
  audio_devices_lookback_min: 40,
  /** level samples for the silent run */
  levels_lookback_min: 5,
  /** chunks for R3 silence by rate */
  chunks_lookback_min: 30,
  /** open sessions are looked for this far back */
  session_lookback_days: 3,
  /** the newest chunk of any session (inputs.last_chunk_s) is looked for this far back */
  last_chunk_lookback_h: 24,
  /** recorder.status rows for the live-start "ready for >= 5 min" derivation */
  recorder_history_lookback_min: 30,
  usb_removed_within_min: 5,
} as const;

// ---------------------------------------------------------------------------
// senseAll
// ---------------------------------------------------------------------------

type SessionRow = { room_id: string; id: string; status: string; started_at: unknown; last_chunk_at: unknown };
type RecorderRow = { machine: string; ts: unknown; state: string | null; session_open: string | null };
type LastChunkRow = { room_id: string; last_chunk_at: unknown };
type ChunkRow = { room_id: string; created_at: unknown; started_at: unknown; size_bytes: unknown; duration_ms: unknown };
type LevelRow = { room_id: string; sampled_at: unknown; zero_ratio: unknown };
type ListenerRow = { room_id: string; last_poll_at: unknown; paused: unknown };
type AttemptRow = { room_id: string; status: string; created_at: unknown; acked_at: unknown; session_started: boolean; session_named: boolean };
type PollerRow = { machine: string; ts: unknown; idle: unknown; chrome: string | null };
type ExtRow = { machine: string; ev: string | null; ev_ts: unknown; ev_reason: string | null; hb_ts: unknown; hb_reason: string | null; hb_no_pulse_tab: string | null };
type PresConsultRow = { machine: string; event: string; ts: unknown; enc: string | null };
type WinConsultRow = { room_id: string; t_open: unknown };
type ChromeRow = { machine: string; received_at: unknown; active: unknown };
type AudioRow = { machine: string; ts: unknown; present: boolean | null };

export async function senseAll(
  sqlIn: StewardSql,
  asOfIn: number | string | Date,
  roster: readonly RosterRoom[],
  degraded: string[] = [],
  limits: SenseLimits = {},
): Promise<Map<string, RoomSense>> {
  const sql = sqlIn as unknown as WindowsDb & StewardSql;
  const safe = <T>(source: string, deg: string[], fn: () => Promise<T>, fallback: T) => safeRead(limits, source, deg, fn, fallback);
  const A = new Date(asOfIn).getTime();
  if (!Number.isFinite(A)) throw new Error("senseAll: bad asOf");
  const hi = new Date(A).toISOString();
  const dayStartIso = new Date(istMidnightOf(A)).toISOString();
  const B = SENSE_BOUNDS;
  const mins = (n: number) => `${n} minutes`;

  const ids = roster.map((r) => r.room_id);
  const withMachine = roster.filter((r) => r.machine);
  const machines = withMachine.map((r) => ({ n: normalizeMachine(r.machine as string), keys: machineKeys(r.machine as string) }));
  // De-duplicate machines (two rooms can in principle share one).
  const uniqMachines = [...new Map(machines.map((m) => [m.n.toLowerCase(), m])).values()];
  const mj = JSON.stringify(uniqMachines);
  const khKeys = [...new Set(withMachine.flatMap((r) => machineKeys(r.machine as string)))];
  const khKeysExpanded = expandKeys(khKeys);
  /** every spelling pulse_presence_events may carry for the roster machines (canonical + legacy keys) */
  const occKeys = [...new Set([...khKeys, ...uniqMachines.map((m) => m.n)])];
  const extRooms: ExtHealthRoom[] = withMachine.map((r) => ({ room_id: r.room_id, room_name: r.room_name, hostname: r.machine as string }));

  if (roster.length === 0) return new Map();

  // 1 — the open sessions (recording | paused) of the fleet, started within 3 days, with the newest chunk of each (any age <= asOf).
  //     bench_session (room_id, started_at DESC); bench_chunk (session_id, source, idx).
  const sess = await safe("bench_session", degraded, async () => (await sql`
    SELECT s.room_id, s.id, s.status, s.started_at,
           (SELECT max(c.created_at) FROM bench_chunk c WHERE c.session_id = s.id AND c.created_at <= ${hi}::timestamptz) AS last_chunk_at
      FROM bench_session s
     WHERE s.room_id = ANY(${ids}::text[]) AND s.status IN ('recording', 'paused')
       AND s.started_at > ${hi}::timestamptz - make_interval(days => ${B.session_lookback_days}::int)
       AND s.started_at <= ${hi}::timestamptz
  `) as unknown as SessionRow[], [] as SessionRow[]);
  const openRoomIds = [...new Set(sess.v.map((s) => s.room_id))];

  // 1b — session starts today (any status; a re-homed session after a reap is not a start, the same REHOME note test as main's start schedule). Read every tick: G3 (from 20:30 IST) and the
  //      close of a waiting_for_mic episode both need it. Then the operator end_day, read only from 20:00 IST (G2).
  const lateEvening = A - istMidnightOf(A) >= DAY_GATES_FROM_MS;
  const [sessionTodayR, operatorEndR] = await Promise.all([
    safe("bench_session_today", degraded, async () => (await sql`
      SELECT s.room_id, max(s.started_at) AS started_at FROM bench_session s
       WHERE s.room_id = ANY(${ids}::text[]) AND s.started_at >= ${dayStartIso}::timestamptz AND s.started_at <= ${hi}::timestamptz
         AND (s.notes IS NULL OR s.notes NOT LIKE ${REHOME_NOTE_PREFIX + "%"})
       GROUP BY s.room_id
    `) as unknown as Array<{ room_id: string; started_at: string | Date | null }>, [] as Array<{ room_id: string; started_at: string | Date | null }>),
    lateEvening
      ? safe("bench_command_end_day", degraded, async () => (await sql`
          SELECT c.room_id, max(c.acked_at) AS acked_at
            FROM bench_command c
           WHERE c.room_id = ANY(${ids}::text[]) AND c.kind = 'end_day' AND c.source IS DISTINCT FROM 'steward' AND c.acked_at IS NOT NULL
             AND c.acked_at >= ${new Date(istMidnightOf(A) + DAY_GATES_FROM_MS).toISOString()}::timestamptz AND c.acked_at <= ${hi}::timestamptz
           GROUP BY c.room_id
        `) as unknown as Array<{ room_id: string; acked_at: string | Date | null }>, [] as Array<{ room_id: string; acked_at: string | Date | null }>)
      : Promise.resolve(null),
  ]);
  const operatorEndBy = new Map((operatorEndR?.v ?? []).map((x) => [x.room_id, toIso(x.acked_at)] as const));
  const sessionStartBy = new Map((sessionTodayR?.v ?? []).map((x) => [x.room_id, toIso(x.started_at)] as const));

  const [chunksR, levelsR, listenerR, attemptsR, pollerR, extR, presR, winR, chromeR, audioR, khR, extHealthR, occR, lastChunkR, recorderR] = await Promise.all([
    // 2 — chunks of the open sessions, last 30 min (R3 silence by rate).
    safe("bench_chunk", degraded, async () => (await sql`
      SELECT s.room_id, c.created_at, c.started_at, c.size_bytes, c.duration_ms
        FROM bench_session s
        JOIN bench_chunk c ON c.session_id = s.id
       WHERE s.room_id = ANY(${openRoomIds}::text[]) AND s.status IN ('recording', 'paused')
         AND s.started_at > ${hi}::timestamptz - make_interval(days => ${B.session_lookback_days}::int) AND s.started_at <= ${hi}::timestamptz
         AND c.created_at > ${hi}::timestamptz - ${mins(B.chunks_lookback_min)}::interval AND c.created_at <= ${hi}::timestamptz
    `) as unknown as ChunkRow[], [] as ChunkRow[]),
    // 3 — level samples, last 5 min, rooms with an open session only (room_id leads (room_id, ist_date, sampled_at); ist_date and sampled_at bound it).
    safe("bench_level_sample", degraded, async () => (await sql`
      SELECT b.room_id, b.sampled_at, b.zero_ratio
        FROM bench_level_sample b
       WHERE b.room_id = ANY(${openRoomIds}::text[])
         AND b.ist_date >= ((${hi}::timestamptz - ${mins(B.levels_lookback_min)}::interval) AT TIME ZONE 'Asia/Kolkata')::date
         AND b.sampled_at > ${hi}::timestamptz - ${mins(B.levels_lookback_min)}::interval AND b.sampled_at <= ${hi}::timestamptz
    `) as unknown as LevelRow[], [] as LevelRow[]),
    // 4 — the browser kiosk's listener row (one per room).
    safe("bench_listener", degraded, async () => (await sql`
      SELECT l.room_id, l.last_poll_at, l.paused FROM bench_listener l WHERE l.room_id = ANY(${ids}::text[])
    `) as unknown as ListenerRow[], [] as ListenerRow[]),
    // 5 — this room's STEWARD start_day commands since IST midnight (the 3-per-day cap and the 5/15/45 min backoff, lib/steward/start-schedule.ts), same row shape as getRecentStartAttempts.
    safe("bench_command", degraded, async () => (await sql`
      SELECT c.room_id, c.status, c.created_at, c.acked_at,
             EXISTS (SELECT 1 FROM bench_session s WHERE s.room_id = c.room_id AND s.id = c.result ->> 'session_id') AS session_named,
             EXISTS (SELECT 1 FROM bench_session s WHERE s.room_id = c.room_id AND (s.notes IS NULL OR s.notes NOT LIKE ${REHOME_NOTE_PREFIX + "%"}) AND s.started_at >= c.created_at AND c.acked_at IS NOT NULL
                       AND s.started_at <= c.acked_at + (${START_ACK_SESSION_GRACE_S}::int * INTERVAL '1 second')) AS session_started
        FROM bench_command c
       WHERE c.room_id = ANY(${ids}::text[]) AND c.kind = 'start_day'
         AND c.source = 'steward'
         AND c.created_at >= ${dayStartIso}::timestamptz AND c.created_at <= ${hi}::timestamptz
       ORDER BY c.created_at ASC
    `) as unknown as AttemptRow[], [] as AttemptRow[]),
    // 6 — the newest poller `ok` row per machine within 30 min (every spelling, one index lookup per spelling on (machine, ts)).
    safe("presence_poller", degraded, async () => (await sql`
      SELECT m.n AS machine, t.ts, t.idle, t.chrome
        FROM jsonb_to_recordset(${mj}::jsonb) AS m(n text, keys text[])
        CROSS JOIN LATERAL (
          SELECT q.ts, q.idle, q.chrome
            FROM unnest(m.keys) AS k(key)
           CROSS JOIN LATERAL (
             SELECT w.ts, w.payload->>'chrome_running' AS chrome,
                    CASE WHEN w.payload->>'idle_s' ~ '^[0-9]{1,9}(\\.[0-9]+)?$' THEN (w.payload->>'idle_s')::numeric END AS idle
               FROM (
                 SELECT p.ts, p.source, p.event, p.payload
                   FROM pulse_presence_events p
                  WHERE p.machine = k.key
                    AND p.ts > ${hi}::timestamptz - ${mins(B.poller_lookback_min)}::interval AND p.ts <= ${hi}::timestamptz
                  ORDER BY p.ts DESC LIMIT ${B.poller_scan_rows}::int
               ) w
              WHERE w.source = 'poller' AND w.event = 'ok'
              ORDER BY w.ts DESC LIMIT 1
           ) q
           ORDER BY q.ts DESC LIMIT 1
        ) t
    `) as unknown as PollerRow[], [] as PollerRow[]),
    // 7 — the newest ext event of any kind (2 h) and the newest ext heartbeat (30 min) per machine: reason / no_pulse_tab.
    safe("presence_ext", degraded, async () => (await sql`
      SELECT m.n AS machine, x.event AS ev, x.ts AS ev_ts, x.reason AS ev_reason, h.ts AS hb_ts, h.reason AS hb_reason, h.npt AS hb_no_pulse_tab
        FROM jsonb_to_recordset(${mj}::jsonb) AS m(n text, keys text[])
        LEFT JOIN LATERAL (
          SELECT p.event, p.ts, p.payload->>'reason' AS reason
            FROM pulse_presence_events p
           WHERE p.source = 'ext' AND p.machine = m.n
             AND p.ts > ${hi}::timestamptz - make_interval(hours => ${B.ext_event_lookback_h}::int) AND p.ts <= ${hi}::timestamptz
           ORDER BY p.ts DESC LIMIT 1
        ) x ON true
        LEFT JOIN LATERAL (
          SELECT p.ts, p.payload->>'reason' AS reason, p.payload->>'no_pulse_tab' AS npt
            FROM pulse_presence_events p
           WHERE p.source = 'ext' AND p.machine = m.n AND p.event = 'heartbeat'
             AND p.ts > ${hi}::timestamptz - ${mins(B.ext_heartbeat_lookback_min)}::interval AND p.ts <= ${hi}::timestamptz
           ORDER BY p.ts DESC LIMIT 1
        ) h ON true
    `) as unknown as ExtRow[], [] as ExtRow[]),
    // 8 — consult, source 1: encounter_open / encounter_close of the last 90 min per machine (newest 20).
    safe("presence_consult", degraded, async () => (await sql`
      SELECT m.n AS machine, e.event, e.ts, e.enc
        FROM jsonb_to_recordset(${mj}::jsonb) AS m(n text, keys text[])
        CROSS JOIN LATERAL (
          SELECT p.event, p.ts, p.payload->>'encounter_id' AS enc
            FROM pulse_presence_events p
           WHERE p.source = 'ext' AND p.machine = m.n AND p.event IN ('encounter_open', 'encounter_close')
             AND p.ts > ${hi}::timestamptz - ${mins(B.consult_lookback_min)}::interval AND p.ts <= ${hi}::timestamptz
           ORDER BY p.ts DESC LIMIT 20
        ) e
    `) as unknown as PresConsultRow[], [] as PresConsultRow[]),
    // 9 — consult, source 2: an open eta_encounter_windows row (opened within 90 min, no close or a close in the future). (room_id, t_open) index.
    safe("eta_encounter_windows", degraded, async () => (await sql`
      SELECT w.room_id, w.t_open
        FROM eta_encounter_windows w
       WHERE w.room_id = ANY(${ids}::text[])
         AND w.t_open > ${hi}::timestamptz - ${mins(B.consult_lookback_min)}::interval AND w.t_open <= ${hi}::timestamptz
         AND (w.t_close IS NULL OR w.t_close > ${hi}::timestamptz)
    `) as unknown as WinConsultRow[], [] as WinConsultRow[]),
    // 10 — the newest chrome.profile per machine received within 30 min: only for active[] (the kiosk-health snapshot does not carry it).
    safe("kiosk_health_chrome", degraded, async () => (await sql`
      SELECT DISTINCT ON (k.machine) k.machine, k.received_at, k.payload->'active' AS active
        FROM kiosk_health_events k
       WHERE k.machine = ANY(${khKeysExpanded}::text[]) AND k.kind = 'chrome.profile'
         AND k.received_at > ${hi}::timestamptz - ${mins(B.chrome_profile_lookback_min)}::interval AND k.received_at <= ${hi}::timestamptz
       ORDER BY k.machine, k.ts DESC, k.received_at DESC
    `) as unknown as ChromeRow[], [] as ChromeRow[]),
    // 11 — audio.devices rows of the last 40 min (boolean default_input_present only), oldest first: a present -> absent transition = "unplugged".
    safe("kiosk_health_audio", degraded, async () => (await sql`
      SELECT k.machine, k.ts, (k.payload->>'default_input_present')::boolean AS present
        FROM kiosk_health_events k
       WHERE k.machine = ANY(${khKeysExpanded}::text[]) AND k.kind = 'audio.devices'
         AND jsonb_typeof(k.payload->'default_input_present') = 'boolean'
         AND k.received_at > ${hi}::timestamptz - ${mins(B.audio_devices_lookback_min)}::interval AND k.received_at <= ${hi}::timestamptz
       ORDER BY k.machine, k.ts
    `) as unknown as AudioRow[], [] as AudioRow[]),
    // 12 — kiosk health: reuse readKioskHealth (4 statements, 24 h / 7 d bounds, see lib/kiosk-health-read.ts).
    safe("kiosk_health", degraded, async () => {
      const r = await readKioskHealth(sql, khKeys, hi);
      if (!r.ok) throw new Error("readKioskHealth not ok");
      return r.snapshots;
    }, new Map<string, KioskHealthSnapshot>()),
    // 13 — extension health: reuse extHealth (ext status, poller idle; excluded machines have no row).
    safe("ext_health", degraded, () => extHealth(sql, { asOf: A, rooms: extRooms }), [] as ExtHealthRow[]),
    // 14 — occupancy (pending login, identity fault, occupied): the steward's own SCOPED reader (lib/steward/occupancy-read.ts): roster machines only, last 2 h, LIMIT 5000,
    //      on the (machine, ts) index — not machineOccupancy, which scans every machine for 25-49 h.
    safe("occupancy", degraded, () => scopedOccupancy(sql, A, occKeys), [] as ScopedOccupancy[]),
    // 15 — the newest chunk of ANY session per room, last 24 h (inputs.last_chunk_s: "null only when no chunk in 24 h"). Sessions started within 3 days; one GROUP BY over the roster.
    safe("bench_chunk_24h", degraded, async () => (await sql`
      SELECT s.room_id, max(c.created_at) AS last_chunk_at
        FROM bench_session s
        JOIN bench_chunk c ON c.session_id = s.id
       WHERE s.room_id = ANY(${ids}::text[])
         AND s.started_at > ${hi}::timestamptz - make_interval(days => ${B.session_lookback_days}::int) AND s.started_at <= ${hi}::timestamptz
         AND c.created_at > ${hi}::timestamptz - make_interval(hours => ${B.last_chunk_lookback_h}::int) AND c.created_at <= ${hi}::timestamptz
       GROUP BY s.room_id
    `) as unknown as LastChunkRow[], [] as LastChunkRow[]),
    // 16 — recorder.status history, last 30 min, newest first per machine (the live-start gate "ready and no session, held >= 5 min" is derived from the run, never from one sample). (machine, received_at) index (0127). Times are the SERVER's received_at, never the kiosk's own clock (a skewed clock must not shorten or lengthen the held-ready duration).
    safe("kiosk_health_recorder", degraded, async () => (await sql`
      SELECT k.machine, k.received_at AS ts, k.payload->>'state' AS state, k.payload->>'session_open' AS session_open
        FROM kiosk_health_events k
       WHERE k.machine = ANY(${khKeysExpanded}::text[]) AND k.kind = 'recorder.status'
         AND k.received_at > ${hi}::timestamptz - make_interval(mins => ${B.recorder_history_lookback_min}::int) AND k.received_at <= ${hi}::timestamptz
       ORDER BY k.machine, k.received_at DESC
       LIMIT 3000
    `) as unknown as RecorderRow[], [] as RecorderRow[]),
  ]);

  const sessBy = new Map<string, SessionRow>();
  for (const s of sess.v) {
    const prev = sessBy.get(s.room_id);
    const t = toIso(s.started_at);
    if (!t) continue;
    if (!prev || Date.parse(t) > Date.parse(toIso(prev.started_at) ?? "")) sessBy.set(s.room_id, s);
  }
  const chunksBy = groupBy(chunksR.v);
  const levelsBy = groupBy(levelsR.v);
  const listenerBy = new Map(listenerR.v.map((l) => [l.room_id, l]));
  const attemptsBy = groupBy(attemptsR.v);
  const lc = (s: string) => matchKey(s);
  const pollerBy = new Map(pollerR.v.map((p) => [lc(p.machine), p]));
  const extBy = new Map(extR.v.map((p) => [lc(p.machine), p]));
  const presBy = new Map<string, PresConsultRow[]>();
  for (const p of presR.v) {
    const k = lc(p.machine);
    const a = presBy.get(k);
    if (a) a.push(p);
    else presBy.set(k, [p]);
  }
  const winBy = groupBy(winR.v);
  const chromeBy = new Map(chromeR.v.map((p) => [lc(canonicalMachine(p.machine)), p]));
  const audioBy = new Map<string, AudioRow[]>();
  for (const p of audioR.v) {
    const k = lc(canonicalMachine(p.machine));
    const a = audioBy.get(k);
    if (a) a.push(p);
    else audioBy.set(k, [p]);
  }
  const khBy = new Map([...khR.v.entries()].map(([k, s]) => [lc(k), s]));
  const extHealthBy = new Map(extHealthR.v.map((r) => [lc(r.machine), r]));
  const occBy = new Map(occR.v.map((o) => [lc(o.machine), o]));
  const lastChunkBy = new Map(lastChunkR.v.map((l) => [l.room_id, toIso(l.last_chunk_at)]));
  const recBy = new Map<string, RecorderRow[]>();
  for (const p of recorderR.v) {
    const k = lc(canonicalMachine(p.machine));
    const a = recBy.get(k);
    if (a) a.push(p);
    else recBy.set(k, [p]);
  }

  const out = new Map<string, RoomSense>();
  for (const r of roster) {
    const missing: string[] = [];
    const miss = (name: string) => {
      if (!missing.includes(name)) missing.push(name);
    };
    const canon = r.machine ? normalizeMachine(r.machine) : null;
    const key = canon ? lc(canon) : null;

    // --- recording
    const s = sessBy.get(r.room_id);
    const sessionOpen = sess.ok ? Boolean(s) : null;
    if (!sess.ok) miss("bench_session");
    const kh = key ? khBy.get(key) : undefined;
    if (!khR.ok) miss("kiosk_health");
    else if (!kh) miss("kiosk_health.snapshot");
    const rs = kh?.last_recorder_status ?? null;
    if (khR.ok && kh && !rs) miss("recorder_status");
    const recorder_status: RecorderStatus | null = rs ? { state: rs.state, session_open: sessionOpenOf(rs.session_open), received_at: rs.received_at } : null;

    // --- listener
    const lrow = listenerBy.get(r.room_id);
    const listener = listenerR.ok
      ? { listening: lrow ? A - (new Date(lrow.last_poll_at as string).getTime() || 0) <= LISTENER_FRESH_MS : false, paused: lrow ? lrow.paused === true : false }
      : { listening: null, paused: null };
    if (!listenerR.ok) miss("bench_listener");

    // --- reachability
    const poll = key ? pollerBy.get(key) : undefined;
    if (!pollerR.ok) miss("presence_poller");
    else if (!poll) miss("poller_ok_row");
    const khHb = kh?.last_heartbeat_received_at ?? null;
    if (khR.ok && kh && !khHb) miss("kh_heartbeat");

    // --- chrome
    const chromeRow = key ? chromeBy.get(key) : undefined;
    const activeRaw = chromeRow ? jsonVal(chromeRow.active) : null;
    const active = Array.isArray(activeRaw) ? activeRaw.filter((x): x is string => typeof x === "string") : null;
    const prof = kh?.last_chrome_profile ?? null;
    if (khR.ok && kh && !prof) miss("chrome_profile");
    const alert = kh?.last_chrome_alert ?? null;

    // --- extension
    const applicable = r.machine ? !isExtHealthExcluded(r.machine) : false;
    const eh = key ? extHealthBy.get(key) : undefined;
    const er = key ? extBy.get(key) : undefined;
    let ext: RoomSense["ext"] = { applicable, status: null, last_event_at: null, last_heartbeat_reason: null, no_tab: null };
    if (applicable) {
      if (!extHealthR.ok) miss("ext_health");
      else if (!eh) miss("ext_health.row");
      if (!extR.ok) miss("presence_ext");
      const hbReason = er?.hb_reason ?? null;
      const npt = boolOrNull(er?.hb_no_pulse_tab);
      ext = {
        applicable,
        status: eh?.status ?? null,
        last_event_at: toIso(er?.ev_ts) ?? eh?.last_ext_ts ?? null,
        last_heartbeat_reason: hbReason,
        no_tab: extHealthR.ok || extR.ok ? eh?.status === "no_tab" || (hbReason !== null && hbReason.includes("no_tab")) || npt === true : null,
      };
    }

    // --- consult (S7)
    let consultOpen: boolean | null = null;
    let consultStarted: string | null = null;
    {
      const pres = key ? (presBy.get(key) ?? []) : [];
      const evs = pres.map((p) => ({ event: p.event, ts: toIso(p.ts), enc: p.enc })).filter((p): p is { event: string; ts: string; enc: string | null } => p.ts !== null);
      evs.sort((a, b) => Date.parse(b.ts) - Date.parse(a.ts));
      const newestOpen = evs.find((e) => e.event === "encounter_open");
      let presOpen: boolean | null = false;
      let presStart: string | null = null;
      if (!presR.ok) presOpen = null;
      else if (newestOpen) {
        const closed = evs.some((e) => e.event === "encounter_close" && Date.parse(e.ts) >= Date.parse(newestOpen.ts) && (e.enc === null || newestOpen.enc === null || e.enc === newestOpen.enc));
        presOpen = !closed;
        presStart = closed ? null : newestOpen.ts;
      }
      const wins = (winBy.get(r.room_id) ?? []).map((w) => toIso(w.t_open)).filter((t): t is string => t !== null).sort();
      const winOpen: boolean | null = winR.ok ? wins.length > 0 : null;
      if (presOpen === true || winOpen === true) {
        consultOpen = true;
        consultStarted = [presStart, wins[0] ?? null].filter((t): t is string => t !== null).sort()[0] ?? null;
      } else if (presOpen === false && winOpen === false) consultOpen = false;
      else consultOpen = null;
      if (consultOpen === null) miss("consult");
    }

    // --- occupancy
    let occupancy: RoomSense["occupancy"] = null;
    if (!occR.ok) miss("occupancy");
    else {
      const o = key ? occBy.get(key) : undefined;
      const idle = numOrNull(poll?.idle) ?? eh?.poller.idle_s ?? null;
      if (idle === null) miss("idle_s");
      occupancy = {
        state: o ? (o.occupied ? "present" : o.pending ? "pending" : "nobody") : "nobody",
        idle_s: idle,
        identity_fault: !!o && (o.pending?.reason === "identity_stale" || o.stale_occupant !== null),
      };
    }

    // --- audio
    const dev = kh?.last_audio_devices ?? null;
    // audio.devices is event-driven (first poll, USB/audio appear/disappear, system_profiler every 30 min only when changed): hours of silence are normal, so the latest row is
    // read at any age and its absence is never a missing input; the age is recorded for visibility only (inputs.audio_devices_age_s).
    const defaultInputPresent = dev ? dev.default_input_present : null;
    const devicesAt = dev ? toIso(dev.received_at) : null;
    let usbRemoved: boolean | null = null;
    if (audioR.ok) {
      const rows = (key ? (audioBy.get(key) ?? []) : [])
        .map((a) => ({ ts: toIso(a.ts), present: a.present }))
        .filter((a): a is { ts: string; present: boolean } => a.ts !== null && typeof a.present === "boolean")
        .sort((a, b) => Date.parse(a.ts) - Date.parse(b.ts));
      let removedAt: string | null = null;
      for (let i = 1; i < rows.length; i++) if (rows[i - 1]!.present && !rows[i]!.present) removedAt = rows[i]!.ts;
      // the transition counts only while the newest row is still "absent"
      usbRemoved = removedAt !== null && rows[rows.length - 1]!.present === false && A - Date.parse(removedAt) <= B.usb_removed_within_min * 60_000;
    } else miss("audio_history");
    const flags = parseInstallState(r.state_flags);
    const flagsKnown = r.state_flags !== null && r.state_flags !== undefined;
    if (!flagsKnown) miss("install_state_flags");
    // silent run: trailing run of zero_ratio >= 0.98 samples whose newest sample is <= 30 s old (levels), else two silent chunks by rate (R3), else the install flag
    let silentSince: string | null = null;
    if (sessionOpen && s?.status === "recording") {
      const lv = (levelsBy.get(r.room_id) ?? [])
        .map((l) => ({ t: toIso(l.sampled_at), z: numOrNull(l.zero_ratio) }))
        .filter((l): l is { t: string; z: number | null } => l.t !== null)
        .sort((a, b) => Date.parse(a.t) - Date.parse(b.t));
      if (levelsR.ok && lv.length > 0 && A - Date.parse(lv[lv.length - 1]!.t) <= 30_000) {
        let i = lv.length - 1;
        while (i >= 0 && lv[i]!.z !== null && (lv[i]!.z as number) >= SILENT_ZERO_RATIO) i--;
        if (i < lv.length - 1) silentSince = lv[i + 1]!.t;
      } else if (!levelsR.ok) miss("levels");
      if (silentSince === null) {
        const ch = (chunksBy.get(r.room_id) ?? [])
          .map((c) => ({ created: toIso(c.created_at), started: toIso(c.started_at), size_bytes: numOrNull(c.size_bytes), duration_ms: numOrNull(c.duration_ms) }))
          .filter((c): c is { created: string; started: string; size_bytes: number | null; duration_ms: number | null } => c.created !== null && c.started !== null)
          .sort((a, b) => Date.parse(b.created) - Date.parse(a.created))
          .slice(0, SILENT_CHUNKS_REQUIRED);
        if (ch.length === SILENT_CHUNKS_REQUIRED && ch.every((c) => isSilentChunk(c))) silentSince = ch[ch.length - 1]!.started;
      }
      if (silentSince === null && flags.flags.includes("SILENT_WHILE_RECORDING")) silentSince = new Date(A - SILENT_MS).toISOString();
    }

    // --- this room's steward start attempts of the IST day
    let startAttempts: RoomSense["start_attempts"] = null;
    if (attemptsR.ok) {
      startAttempts = (attemptsBy.get(r.room_id) ?? []).map((a) => ({
        status: a.status,
        created_at: toIso(a.created_at) ?? "",
        acked_at: toIso(a.acked_at),
        session_started: a.session_started === true,
        session_named: a.session_named === true,
      }));
    } else miss("start_attempts");

    // --- recorder.status history (visibility + the live-start gate; a failed read leaves it null and is named in `degraded`, never in `missing`)
    let recorderHistory: NonNullable<RoomSense["recording"]["recorder_history"]> | null = null;
    {
      const rows = (key ? (recBy.get(key) ?? []) : [])
        .map((x) => ({ ts: toIso(x.ts), ready: x.state === "ready" && sessionOpenOf(x.session_open) === false, state: x.state, so: x.session_open }))
        .filter((x): x is { ts: string; ready: boolean; state: string | null; so: string | null } => x.ts !== null)
        .sort((a, b) => Date.parse(b.ts) - Date.parse(a.ts));
      if (rows.length > 0) {
        let n = 0;
        while (n < rows.length && rows[n]!.ready) n++;
        recorderHistory = {
          latest_at: rows[0]!.ts,
          latest_state: rows[0]!.state,
          latest_session_open: rows[0]!.so,
          ready_since: n > 0 ? rows[n - 1]!.ts : null,
          ready_samples: n,
        };
      }
    }

    out.set(r.room_id, {
      room_id: r.room_id,
      room_name: r.room_name,
      machine: r.machine,
      klass: r.klass,
      kind: r.kind,
      flags: r.flags,
      as_of: hi,
      recording: {
        session_open: sessionOpen,
        session_id: s?.id ?? null,
        session_status: s ? (s.status === "paused" ? "paused" : "recording") : null,
        session_started_at: s ? toIso(s.started_at) : null,
        last_chunk_at: s ? toIso(s.last_chunk_at) : null,
        last_chunk_24h_at: lastChunkBy.get(r.room_id) ?? null,
        recorder_history: recorderHistory,
        recorder_status,
      },
      listener,
      reachable: { poller_ok_at: toIso(poll?.ts), kh_heartbeat_at: khHb, kh_enrolled: khR.ok ? (kh ? kh.enrolled : false) : null, sleep_at: khR.ok ? khSleepMarker(kh, A) : null },
      chrome: {
        running: prof?.running ?? boolOrNull(poll?.chrome) ?? null,
        active,
        last_used: prof?.last_used ?? null,
        presence_ok: prof?.presence_ok ?? null,
        last_alert_reason: alert?.reason ?? null,
        last_alert_at: alert?.received_at ?? null,
      },
      ext,
      consult_open: consultOpen,
      consult_started_at: consultStarted,
      occupancy,
      audio: {
        default_input_present: defaultInputPresent,
        devices_at: devicesAt,
        usb_removed_recent: usbRemoved,
        device_missing_flag: flagsKnown ? flags.flags.includes("DEVICE_MISSING") : null,
        silent_while_recording_since: silentSince,
        configured_device: r.device_name ?? null,
        default_input_name: dev?.default_input_name ?? null,
      },
      start_attempts: startAttempts,
      session_start_today_at: sessionTodayR?.ok ? sessionStartBy.get(r.room_id) ?? null : null,
      ...(lateEvening ? { day: operatorEndR?.ok && sessionTodayR?.ok ? { operator_end_at: operatorEndBy.get(r.room_id) ?? null, session_today: sessionStartBy.has(r.room_id) } : null } : {}),
      missing,
    });
  }
  return out;
}

/**
 * lib/fleet-attention.ts — "what needs a human right now", derived from STATE, never from events.
 *
 * WHY (5 Oct 2026). /admin/bench printed "Nothing needs attention." while OPD 4 had recorded nothing for four days and OPD 3's microphone was
 * dead. The room watchdog (lib/room-watchdog.ts) is EDGE-triggered: it speaks once when a room changes status, its `recovered` fired when a
 * session CLOSED (a clean poll), Macs that fell into DarkWake still polled, and nobody consumes its outbox. An edge is a fact about a moment; a
 * person standing in the hallway needs a fact about NOW. So every rule below is a pure function of the room's current evidence, re-evaluated on
 * every call: an item exists exactly while its condition holds, and disappears the call after it stops holding. Nothing is remembered.
 *
 * R1 asleep (kind id kept; plain words "Mac not capturing")
 *                           a session is open AND the Mac is screen-locked or unreachable AND there is no audio evidence (no chunk in 10 min, or
 *                           <= 1 distinct level value in 120 s); OR the tailnet poller's newest row has been `unreachable` for >= 3 min. Red.
 *                           A LOCKED SCREEN ALONE IS NOT A FAULT: rooms record normally under a locked screen (OPD 5 recorded all morning at
 *                           idle_s ~31,000 with locked=true; OPD 6/5/1 were remote-started at 09:13 under locked screens). Any audio evidence
 *                           clears R1 at once. See the comment on `resolveLockState` for what this cannot yet tell apart.
 * R2 capture_frozen         a session is open and the level meter has delivered one identical value (or nothing) for 120 s. Red.
 * R3 silent_tape            the two newest chunks of the open session are digital silence by RATE: <= 800 bytes/s over >= 150 s. Red.
 * R4 consult_without_tape   Pulse says a consult is open (or opened < 15 min ago) and no chunk has arrived for 10 min. Red.
 * R5 no_session_in_clinic   clinic hours, the Mac was in use in the last 30 min, and no session is open. Amber.
 *                            R4 and R5 NAME the warehouse consulting doctor; when the extension's cookie login names someone else they add
 *                            "The session shows <name>, unverified." (the cookie is a Google session Pulse never clears; see encounter-windows/occupant.ts).
 * R6 open_outbox            a watchdog offline/degraded alert with no GENUINE recovery since (chunk after it AND >= 2 distinct levels). Red/amber.
 *                           R6 clears on the FIRST genuine evidence, by spec (a single recovery chunk is enough; there is no hold-down).
 * R7 stale_start            a remote start_day failed in the last 60 min and no session has opened since. Red.
 * R8 extension_missing      the Pulse Presence extension has sent nothing for >= 10 min while the poller says Chrome is running and the Mac is up
 *                           (lib/encounter-windows/ext-health.ts status `missing`; the 4 Oct Cardiology reboot lost its policy file). Red.
 * R9 extension_behind       ONE fleet-level amber row ("N rooms on old extension builds: <room (version), ...>; update to <target>") for every room whose extension is
 *                           alive but below EXT_TARGET_VERSION and has been for >= 60 min. Action is to update the extension, not to re-install the policy.
 *                           R8/R9 never fire for a machine on EXT_HEALTH_EXCLUDED_MACHINES (Home Office, ORB3, ORB2: no extension).
 *                           R8's text and action come from the machine's newest chrome.profile (kiosk-health, received within 20 min) when there is one
 *                           (lib/kiosk-health-rules.ts extensionMissingAdvice); only without one does the wording below apply.
 *                           R8's action says "(machine rebooted at HH:MM, policy file lost)" when the poller shows a reboot in the last 15 min (unreachable -> ok with idle_s ~0,
 *                           or an ok -> ok idle_s drop from >= 600 to <= 120 while the extension went quiet); otherwise "(policy file lost, usually after a reboot)".
 *                           Status `quiet` (nobody has used the console since the extension went quiet, so the Mac may simply be idle) raises nothing; the table shows it.
 * R10 chrome_not_running    the poller is ok and says chrome_running=false (any extension age): Chrome is down, so presence cannot report. Amber.
 *                           Only between 08:00 and 21:30 IST (the Kiosk Bot and the nightly shutdown make it noise overnight).
 *                           R8 is red only when chrome_running=true; the two never fire together for one machine.
 * guard_activity            ONE fleet-level amber row when the presence guard (eta-presence-guard) acted on any Mac in the last 24 h: a guard event other than
 *                           `boot` (missing, stripped, rewrite_failed, relaunch, unknown_host) — ext-health guard_events_24h > 0 or guard_relaunches_24h > 0.
 *                           "Presence guard acted in the last 24 h: OPD 4 (stripped ×1, relaunch ×1), OPD 6 (missing ×1)." A boot rewrite alone raises nothing;
 *                           it is listed in the detail (boot ×n) of a room that did raise. `since` = the OLDEST non-boot guard event in the 24 h window across the listed rooms (guard_first_at).
 *
 * `computeAttention` is PURE (no I/O). `loadAttentionInputs` / `getFleetAttention` are the DB half: read-only SELECTs, bound parameters only (the
 * Neon HTTP driver has no sql.unsafe), timestamps normalised from whatever the driver returns. Every bench_level_sample / bench_chunk read is
 * scoped by `room_id = ANY(<the fleet's room ids>)` (or a per-room lookup) plus a time bound, so it rides the (room_id, ist_date, sampled_at) and
 * bench_session (room_id, started_at) indexes; tests/unit/fleet-attention-sql.test.ts runs EXPLAIN ANALYZE on every one of them against a real
 * postgres and fails on a Seq Scan of bench_level_sample. A source that cannot be read is NAMED in `degraded` and its rules are skipped; the panel
 * never says "Nothing needs attention" over a degraded read.
 *
 * Browser code imports the types and wording from lib/fleet-attention-format.ts (no database); only the route imports this file.
 */
import { sql } from "@/lib/db";
import { normalizeHostname } from "@/lib/encounter-windows/types";
import { BEHIND_LOOKBACK_H, EXT_TARGET_VERSION, extHealth, isExtHealthExcluded, type ExtHealthRow } from "@/lib/encounter-windows/ext-health";
import { POLLER_LEGACY_KEYS, legacyPollerKey, machineKeys } from "@/lib/encounter-windows/machine-keys";
import { readKioskHealth, type KioskHealthSnapshot } from "@/lib/kiosk-health-read";
import { extensionMissingAdvice, kioskHealthItems, summarizeKioskHealth, type KioskRoomRef } from "@/lib/kiosk-health-rules";
import { REASON_LABEL, isGenuineRecovery, RECOVERY_LIVE_MAX_ZERO_RATIO, RECOVERY_LIVE_MIN_PEAK, SILENT_ALERT_BODY_MARKERS, type DegradationReason } from "@/lib/room-watchdog";
import {
  fmtIst,
  type AttentionItem,
  type AttentionKind,
  type AttentionSeverity,
  type FleetAttentionResponse,
} from "@/lib/fleet-attention-format";

export type { AttentionItem, AttentionKind, AttentionSeverity, FleetAttentionResponse } from "@/lib/fleet-attention-format";

// ---------------------------------------------------------------------------
// Thresholds
// ---------------------------------------------------------------------------

/** R2: the window the meter must have moved in. The meter reports every ~2.5 s, so 120 s is ~48 samples. */
export const FROZEN_WINDOW_MS = 120_000;
/**
 * R3: a chunk is digital silence by RATE, not by absolute size: size_bytes / (duration_ms / 1000) <= 800 B/s, and only for a chunk of at least
 * 150 s (a short tail chunk is small whatever it holds). The 5 Oct silent chunks were 212,378 bytes over 300 s = 708 B/s.
 */
export const SILENT_BYTES_PER_SEC = 800;
export const SILENT_MIN_DURATION_MS = 150_000;
export const SILENT_CHUNKS_REQUIRED = 2;
/** R1: audio evidence — a chunk newer than this, and (separately) >= 2 distinct levels in FROZEN_WINDOW_MS. */
export const AUDIO_CHUNK_WINDOW_MS = 10 * 60_000;
/** R1(b): the poller's newest row is `unreachable` and the unbroken run is at least this old. */
export const UNREACHABLE_AFTER_MS = 3 * 60_000;
/** R1(b): a poller row older than this says nothing about now (the poller itself may be down). */
export const POLLER_FRESH_MS = 10 * 60_000;
/** R4 */
export const CONSULT_RECENT_OPEN_MS = 15 * 60_000;
export const CONSULT_NO_CHUNK_MS = 10 * 60_000;
/** R4: an unclosed window older than this is a resolver leftover, not a live consult (the resolver itself caps a consult at 90 min). */
export const CONSULT_MAX_OPEN_MS = 4 * 3_600_000;
/** R5 */
export const ACTIVITY_WINDOW_MS = 30 * 60_000;
/** R5: a warehouse consult this recent (or still open) names the doctor at the Mac. */
export const CONSULT_DISPLAY_MS = 90 * 60_000;
/** R7 */
export const FAILED_START_WINDOW_MS = 60 * 60_000;
/** R8: the extension must have been silent this long (ext-health `missing` already implies it; the rule keeps it explicit). */
export const EXT_MISSING_AFTER_MS = 10 * 60_000;
/** R9: the machine must have been below the target version this long. */
export const EXT_BEHIND_AFTER_MS = 60 * 60_000;
/** R8 when the extension has never been heard in the loader's look-back: the condition is at least this old. */
const EXT_NEVER_SEEN_MS = 14 * 86_400_000;
/** R10 only speaks between 08:00 and 21:30 IST, every day. */
const EXT_CHROME_ALERT_OPEN_MIN = 8 * 60;
const EXT_CHROME_ALERT_CLOSE_MIN = 21 * 60 + 30;

/** Clinic hours, IST: 08:30–20:30, Monday to Saturday. */
export const CLINIC_OPEN_MIN = 8 * 60 + 30;
export const CLINIC_CLOSE_MIN = 20 * 60 + 30;
const IST_OFFSET_MS = 19_800_000;
const DAY_MS = 86_400_000;

/** IST clock fields for an instant. `dow` 0 = Sunday. */
function istParts(ms: number): { dow: number; minutes: number; midnightMs: number } {
  const shifted = ms + IST_OFFSET_MS;
  const dayStart = Math.floor(shifted / DAY_MS) * DAY_MS;
  return { dow: new Date(shifted).getUTCDay(), minutes: Math.floor((shifted - dayStart) / 60_000), midnightMs: dayStart - IST_OFFSET_MS };
}

export function isClinicHours(ms: number): boolean {
  const { dow, minutes } = istParts(ms);
  return dow >= 1 && dow <= 6 && minutes >= CLINIC_OPEN_MIN && minutes < CLINIC_CLOSE_MIN;
}

// The pre-5-Oct poller short keys live in lib/encounter-windows/machine-keys.ts (shared with the ext-health loader); re-exported here for callers and tests.
export { POLLER_LEGACY_KEYS, legacyPollerKey };

// ---------------------------------------------------------------------------
// Inputs
// ---------------------------------------------------------------------------

/** One presence event from the Pulse extension (source 'ext'). `tab_focus` is payload->>'tab_focus' (a boolean or the string form). */
export type PresenceEventLite = { event: string; ts: string; tab_focus?: boolean | string | null };

/**
 * The newest tailnet-poller row for the machine. `asleep_since` = start of the current unbroken run of locked/unreachable polls;
 * `unreachable_since` = start of the current unbroken run of `unreachable` polls (null unless the newest row is `unreachable`).
 */
export type PollerLite = { ts: string; state: string | null; locked: boolean; asleep_since?: string | null; unreachable_since?: string | null };

export type LevelSample = { sampled_at: string; peak: number; zero_ratio: number | null };
export type ChunkLite = {
  session_id: string;
  source: string;
  created_at: string;
  started_at: string;
  size_bytes: number | null;
  /** the chunk's audio length; null when unknown (then it can never be called silent) */
  duration_ms?: number | null;
};
/**
 * display_name is the doctor to NAME (the warehouse consulting doctor when Pulse's own consult record answered, else the extension's). `source` is the
 * window's attribution_source; `stale` = the extension's cookie login names a DIFFERENT doctor than the warehouse (doctor_mismatch with source
 * 'warehouse'), and `cookie_name` is that login. The cookie identity comes from a Google session cookie Pulse never clears, so it is unverified.
 */
export type WindowLite = {
  display_name: string | null;
  t_open: string;
  t_close: string | null;
  cookie_name?: string | null;
  source?: string | null;
  stale?: boolean;
};

/** The newest watchdog offline/degraded alert for the room, with the two facts a GENUINE recovery needs, measured since that alert. */
export type OutboxFacts = {
  id: string | number;
  kind: "offline" | "degraded";
  created_at: string;
  body: string;
  chunk_after_alert: boolean;
  distinct_levels_since_alert: number;
  /** Arch #20 dwell: level samples in the last RECOVERY_LEVEL_WINDOW_S that are live (zero_ratio < RECOVERY_LIVE_MAX_ZERO_RATIO and peak >= RECOVERY_LIVE_MIN_PEAK), and all samples in that window. Absent: no dwell test. */
  live_samples_since_alert?: number;
  total_samples_recent?: number;
  /**
   * The room's watchdog state (`room_alert_state.status`) when the loader read it; null = no state row; undefined = not supplied (legacy callers and
   * plain-object tests: no gate). R6 is gated on it: a state of `ok` with no open session means the watchdog closed the alert (genuinely, or quietly
   * because nothing was open to prove anything about), so the alert is not an item.
   */
  state_status?: string | null;
};

export type RoomAttentionInputs = {
  room_id: string;
  room_name: string;
  /** room_install.hostname (the presence `machine`), or null */
  machine: string | null;
  /** R1: raw ext events — any subset that includes the newest lock-determining ones; ordering is not assumed. */
  ext_events: PresenceEventLite[];
  poller: PollerLite | null;
  /** R5: genuine ext activity (login/active/focused heartbeat/encounter_*) in the last ACTIVITY_WINDOW_MS */
  recent_activity: { first_at: string; last_at: string } | null;
  /** The room's open bench_session (recording or paused), or null. */
  open_session: { id: string; status: "recording" | "paused"; started_at: string } | null;
  /** Start of the room's newest session of any status, or null. */
  last_session_started_at: string | null;
  /** R1: when the open session's newest chunk (any age) landed, or null. Used only to say how long there has been no audio. */
  last_chunk_at?: string | null;
  /** R1/R2: level samples from the last FROZEN_WINDOW_MS. */
  samples: LevelSample[];
  /** R1/R2: when the current identical-value run began, if the loader looked further back than the window. */
  frozen_since: string | null;
  /** R1/R2: the newest sample of any age the loader could find. */
  last_sample_at: string | null;
  /** R1/R3/R4: the room's chunks from the last 30 minutes, any source, any order. */
  chunks: ChunkLite[];
  /** R4: consult windows that may qualify (the pure code applies the exact test). */
  windows: WindowLite[];
  /** R6 */
  outbox: OutboxFacts | null;
  /** R7: the room's newest failed start_day ack, with `error` the ack reason. */
  failed_start: { acked_at: string; error: string | null } | null;
  /** R8/R9: the machine's extension health row (lib/encounter-windows/ext-health.ts), or absent/null (no machine, excluded machine, or source degraded). */
  ext?: ExtHealthRow | null;
};

export type AttentionInputs = {
  now_ms: number;
  rooms: RoomAttentionInputs[];
  /** R11-R17: the kiosk-health daemon evidence per canonical machine (lib/kiosk-health-read.ts). Absent or empty = no kiosk-health rule can fire. */
  kiosk_health?: Map<string, KioskHealthSnapshot>;
};

// ---------------------------------------------------------------------------
// R1 — lock / reachability state
// ---------------------------------------------------------------------------

const isFocused = (f: unknown): boolean => f === true || f === "true";

/**
 * Does this ext event say anything about the SCREEN? `locked` = the screen locked. login/active/encounter_* and a FOCUSED heartbeat = a person is
 * at it. `idle`, `logout` and an UNFOCUSED heartbeat say nothing: on 5 Oct the extension kept sending unfocused heartbeats all through DarkWake,
 * so a heartbeat alone must never clear a `locked`. The loader's SQL uses this same predicate.
 *
 * `locked` MEANS SCREEN LOCKED, NOT ASLEEP (Refuter, 5 Oct 2026). Rooms record normally under a locked screen.
 */
export function classifyExtEvent(e: PresenceEventLite): "locked" | "awake" | null {
  switch (e.event) {
    case "locked":
      return "locked";
    case "active":
    case "login":
    case "encounter_open":
    case "encounter_close":
      return "awake";
    case "heartbeat":
      return isFocused(e.tab_focus) ? "awake" : null;
    default:
      return null;
  }
}

/**
 * PURE. Is the Mac screen-locked or unreachable right now, and since when? Newest determination wins across the extension and the poller.
 *
 * WHAT THIS CANNOT TELL APART. A Mac in DarkWake (asleep, waking for maintenance) and a Mac idling under a locked screen look the same through
 * `locked` and the poller's `locked` flag: both read "locked". So a locked screen is NEVER an item on its own — it only matters together with a
 * session that is open and a lack of audio (R1(a)). Telling DarkWake from a locked-but-awake Mac needs the pmset sleep/wake events, which the
 * health daemon does not ship yet; when it does, R1 can say "asleep" again and no longer needs the audio test to be sure.
 *
 * `by` says which it is — "locked" (screen locked, per the extension or the poller's flag) or "unreachable" (the poller could not reach it).
 */
export function resolveLockState(
  extEvents: readonly PresenceEventLite[],
  poller: PollerLite | null,
): { down: boolean; since: string | null; by: "locked" | "unreachable" | null } {
  let ext: { state: "locked" | "awake"; ts: number } | null = null;
  for (const e of extEvents) {
    const state = classifyExtEvent(e);
    const ts = Date.parse(e.ts);
    if (!state || !Number.isFinite(ts)) continue;
    if (!ext || ts >= ext.ts) ext = { state, ts };
  }
  let pol: { state: "locked" | "unreachable" | "awake"; ts: number; since: string } | null = null;
  if (poller) {
    const ts = Date.parse(poller.ts);
    const state = poller.state === "unreachable" ? "unreachable" : poller.locked ? "locked" : poller.state === "ok" ? "awake" : null;
    if (state && Number.isFinite(ts)) pol = { state, ts, since: poller.asleep_since ?? new Date(ts).toISOString() };
  }
  if (!ext && !pol) return { down: false, since: null, by: null };
  // Newest wins; on an exact tie the alarm wins.
  let winner: { state: string; ts: number };
  if (ext && pol) winner = pol.ts > ext.ts ? pol : ext.ts > pol.ts ? ext : ext.state === "locked" ? ext : pol;
  else winner = (ext ?? pol)!;
  if (winner.state === "awake") return { down: false, since: null, by: null };
  const starts: number[] = [];
  if (ext && ext.state === "locked") starts.push(ext.ts);
  if (pol && pol.state !== "awake") starts.push(Date.parse(pol.since));
  const valid = starts.filter(Number.isFinite);
  const lockedByAny = (ext !== null && ext.state === "locked") || (pol !== null && pol.state === "locked");
  return {
    down: true,
    since: new Date(valid.length ? Math.min(...valid) : winner.ts).toISOString(),
    by: lockedByAny ? "locked" : "unreachable",
  };
}

// ---------------------------------------------------------------------------
// The rules
// ---------------------------------------------------------------------------

const clean = (s: string | null | undefined, max = 160): string =>
  (s ?? "").replace(/[\u0000-\u001f"]/g, " ").replace(/\s+/g, " ").trim().slice(0, max);

/** The presence guard's reasons in the order a person reads them: faults first, boot rewrites last. */
const GUARD_REASON_ORDER = ["missing", "stripped", "rewrite_failed", "relaunch", "unknown_host", "boot"];

/** "stripped ×1, relaunch ×1, boot ×2" from a reason -> count map. Zero counts and unknown reasons are dropped; unknown ones cannot occur (ingest validates). */
function guardReasonList(reasons: Record<string, number>): string {
  return GUARD_REASON_ORDER.filter((r) => (reasons[r] ?? 0) > 0).map((r) => `${r} ×${reasons[r]}`).join(", ");
}

const doctorLabel = (name: string | null): string => {
  const n = clean(name, 80);
  if (!n) return "A doctor";
  return /^dr\.?\s/i.test(n) ? n : `Dr ${n}`;
};

/** " The session shows Dr X, unverified." when the extension's cookie login disagrees with the warehouse consult doctor; "" otherwise. */
const staleNote = (w: WindowLite): string =>
  w.stale ? ` The session shows ${clean(w.cookie_name, 80) ? doctorLabel(w.cookie_name ?? null) : "a different login"}, unverified.` : "";

/** R5: the warehouse doctor of the room's most recent consult (opened within CONSULT_DISPLAY_MS, or unclosed within CONSULT_MAX_OPEN_MS), or null. */
function recentWarehouseConsult(windows: WindowLite[], now: number): WindowLite | null {
  const recent = windows
    .map((w) => ({ w, open: Date.parse(w.t_open) }))
    .filter(({ w, open }) => Number.isFinite(open) && open <= now && (now - open <= CONSULT_DISPLAY_MS || (w.t_close === null && now - open <= CONSULT_MAX_OPEN_MS)))
    .sort((a, b) => b.open - a.open);
  const top = recent[0]?.w;
  return top && top.source === "warehouse" ? top : null;
}

/** "15:44" — the IST clock time of an instant (24 h, no date, no zone word). */
const istHourMinute = (iso: string): string => {
  const d = new Date(Date.parse(iso) + IST_OFFSET_MS);
  return `${String(d.getUTCHours()).padStart(2, "0")}:${String(d.getUTCMinutes()).padStart(2, "0")}`;
};

const sevRank = (s: AttentionSeverity): number => (s === "red" ? 0 : 1);

/** Bytes per second of audio, or null when the chunk's size or length is unknown. */
export function chunkBytesPerSecond(c: Pick<ChunkLite, "size_bytes" | "duration_ms">): number | null {
  if (c.size_bytes === null || c.size_bytes === undefined || !c.duration_ms || c.duration_ms <= 0) return null;
  return c.size_bytes / (c.duration_ms / 1000);
}

/** R3's test for one chunk. */
export function isSilentChunk(c: Pick<ChunkLite, "size_bytes" | "duration_ms">): boolean {
  const bps = chunkBytesPerSecond(c);
  return bps !== null && (c.duration_ms ?? 0) >= SILENT_MIN_DURATION_MS && bps <= SILENT_BYTES_PER_SEC;
}

/** PURE — every item that should be on screen right now, red first, then oldest first. */
export function computeAttention(inputs: AttentionInputs): AttentionItem[] {
  const now = inputs.now_ms;
  const out: AttentionItem[] = [];
  const behindRooms: Array<{ name: string; version: string; since: number; atFloor: boolean }> = [];
  const guardRooms: Array<{ name: string; since: number; reasons: Record<string, number> }> = [];

  for (const r of inputs.rooms) {
    const mk = (kind: AttentionKind, severity: AttentionSeverity, sinceMs: number, detail: string, action: string): void => {
      out.push({
        room_id: r.room_id,
        room_name: r.room_name,
        machine: r.machine,
        kind,
        since: new Date(Number.isFinite(sinceMs) ? sinceMs : now).toISOString(),
        detail,
        action,
        severity,
      });
    };
    const name = r.room_name;
    const recording = r.open_session?.status === "recording";
    const sessionStartMs = r.open_session ? Date.parse(r.open_session.started_at) : NaN;
    const sessionAge = recording ? now - sessionStartMs : NaN;

    // The level samples of the last 120 s, oldest first — shared by R1 and R2.
    const win = r.samples
      .map((s) => ({ ...s, t: Date.parse(s.sampled_at) }))
      .filter((s) => Number.isFinite(s.t) && s.t >= now - FROZEN_WINDOW_MS && s.t <= now + 60_000)
      .sort((a, b) => a.t - b.t);
    const distinctLevels = new Set(win.map((s) => `${s.peak}|${s.zero_ratio}`)).size;
    const chunkTimes = r.chunks.map((c) => Date.parse(c.created_at)).filter(Number.isFinite);

    // AUDIO EVIDENCE for a RECORDING session: the meter has moved (>= 2 distinct values in 120 s) AND a chunk landed in the last 10 minutes. A
    // session younger than the window has not had time to produce either, so it is given the benefit of the doubt on that half.
    const levelsMoving = !recording || sessionAge < FROZEN_WINDOW_MS || distinctLevels >= 2;
    const chunkRecent = !recording || sessionAge < AUDIO_CHUNK_WINDOW_MS || chunkTimes.some((t) => now - t <= AUDIO_CHUNK_WINDOW_MS);
    const audioOk = levelsMoving && chunkRecent;

    // R1 — MAC NOT CAPTURING (kind id `asleep`).
    //  (a) a session is open, the Mac is screen-locked or unreachable, and there is no audio evidence;
    //  (b) the poller's newest row is `unreachable` and has been for >= 3 minutes (with or without a session) — unless a recording session is
    //      demonstrably delivering audio, in which case the poller's failure to reach the Mac is a network fact, not a capture fact.
    // A locked screen with NO session open produces nothing: see resolveLockState for why.
    const lock = resolveLockState(r.ext_events, r.poller);
    if (recording && lock.down && lock.since && !audioOk) {
      const starts: number[] = [];
      if (!levelsMoving) {
        const lastSample = r.last_sample_at ? Date.parse(r.last_sample_at) : NaN;
        starts.push(
          win.length === 0
            ? Math.max(Number.isFinite(lastSample) ? lastSample : 0, sessionStartMs)
            : r.frozen_since ? Date.parse(r.frozen_since) : win[0]!.t,
        );
      }
      if (!chunkRecent) {
        const lastChunk = r.last_chunk_at ? Date.parse(r.last_chunk_at) : NaN;
        starts.push(Math.max(Number.isFinite(lastChunk) ? lastChunk : 0, sessionStartMs));
      }
      const noAudioSince = Math.min(...starts.filter(Number.isFinite));
      const since = Math.max(Date.parse(lock.since), Number.isFinite(noAudioSince) ? noAudioSince : 0);
      mk(
        "asleep",
        "red",
        since,
        `${lock.by === "unreachable" ? "Mac unreachable on the network" : "Screen locked"} and no audio since ${fmtIst(new Date(since).toISOString(), now)}.`,
        `Go to ${name}: check the microphone cable and that the recorder app is running on the Mac, and restart the recorder app if the levels stay flat.`,
      );
    }
    if (r.poller && r.poller.state === "unreachable" && !(recording && audioOk)) {
      const pollTs = Date.parse(r.poller.ts);
      const unreachableSince = r.poller.unreachable_since ? Date.parse(r.poller.unreachable_since) : NaN;
      if (
        Number.isFinite(pollTs) && now - pollTs <= POLLER_FRESH_MS &&
        Number.isFinite(unreachableSince) && now - unreachableSince >= UNREACHABLE_AFTER_MS
      ) {
        mk(
          "asleep",
          "red",
          unreachableSince,
          `The Mac in ${name} has been unreachable on the network since ${fmtIst(new Date(unreachableSince).toISOString(), now)}.`,
          `Check the Mac in ${name} is on, awake and connected to the network, and that the recorder app is running.`,
        );
      }
    }

    // R2 — CAPTURE FROZEN. CoreAudio stopping delivery freezes the meter to ONE value (4,220 identical samples on OPD 6 from 01:36:52).
    // A session that opened under two minutes ago has not had time to prove anything either way.
    if (recording && sessionAge >= FROZEN_WINDOW_MS) {
      const action = `Check the microphone cable in ${name} and that the Mac is awake, then restart the recorder app on that Mac.`;
      if (win.length === 0) {
        const lastSample = r.last_sample_at ? Date.parse(r.last_sample_at) : NaN;
        const since = Math.max(Number.isFinite(lastSample) ? lastSample : 0, sessionStartMs);
        mk(
          "capture_frozen",
          "red",
          since,
          `No microphone level readings have reached the server from ${name} since ${fmtIst(new Date(since).toISOString(), now)} although a recording is open.`,
          action,
        );
      } else if (distinctLevels <= 1) {
        const since = r.frozen_since ? Date.parse(r.frozen_since) : win[0]!.t;
        mk(
          "capture_frozen",
          "red",
          since,
          `The microphone level in ${name} has read one identical value since ${fmtIst(new Date(since).toISOString(), now)}, so the Mac is no longer receiving audio.`,
          action,
        );
      }
    }

    // R3 — SILENT TAPE. Newest chunks of the OPEN session's primary mic, as a run from the newest backwards, silent BY RATE (see isSilentChunk).
    if (recording && r.open_session) {
      const prim = r.chunks
        .filter((c) => c.session_id === r.open_session!.id && c.source === "primary")
        .sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at));
      const run: ChunkLite[] = [];
      for (const c of prim) {
        if (isSilentChunk(c)) run.push(c);
        else break;
      }
      if (run.length >= SILENT_CHUNKS_REQUIRED) {
        const oldest = run[run.length - 1]!;
        mk(
          "silent_tape",
          "red",
          Date.parse(oldest.started_at),
          `The last ${run.length} recording pieces from ${name} are digital silence (about ${Math.round(chunkBytesPerSecond(run[0]!) ?? 0)} bytes per second) — the microphone is connected but delivering no sound.`,
          `Check the microphone and the Mac's selected input device in ${name}, then restart the recorder app.`,
        );
      }
    }

    // R4 — CONSULT WITHOUT TAPE. Pulse says a doctor is consulting here; the tape says nothing has arrived.
    {
      const live = r.windows
        .map((w) => ({ w, open: Date.parse(w.t_open), close: w.t_close ? Date.parse(w.t_close) : null }))
        .filter(({ open, close }) => {
          if (!Number.isFinite(open) || open > now) return false;
          const openNow = close === null ? now - open <= CONSULT_MAX_OPEN_MS : close > now;
          return openNow || now - open <= CONSULT_RECENT_OPEN_MS;
        })
        .sort((a, b) => a.open - b.open);
      const lastChunk = chunkTimes.length ? Math.max(...chunkTimes) : -Infinity;
      // A tape that started under 10 minutes ago has not had time to produce its first 5-minute piece, so silence is not yet evidence.
      const tapeJustStarted = Number.isFinite(sessionStartMs) && now - sessionStartMs < CONSULT_NO_CHUNK_MS;
      if (live.length > 0 && now - lastChunk > CONSULT_NO_CHUNK_MS && !tapeJustStarted) {
        const first = live[0]!;
        mk(
          "consult_without_tape",
          "red",
          first.open,
          `${doctorLabel(first.w.display_name)} is consulting but nothing is being recorded — no recording has reached the server in the last 10 minutes.${staleNote(first.w)}`,
          `Go to ${name} now: check the recorder app is running and the microphone is connected, and start the day recording if it is not.`,
        );
      }
    }

    // R5 — NO SESSION IN CLINIC. Somebody is using the Mac during clinic hours and no tape is open (paused still counts as open).
    if (isClinicHours(now) && r.recent_activity && !r.open_session) {
      const first = Date.parse(r.recent_activity.first_at);
      const clinicOpen = istParts(now).midnightMs + CLINIC_OPEN_MIN * 60_000;
      const consult = recentWarehouseConsult(r.windows, now);
      mk(
        "no_session_in_clinic",
        "amber",
        Math.max(clinicOpen, Number.isFinite(first) ? first : clinicOpen),
        `The Mac in ${name} has been in use during clinic hours but no recording is open.${consult ? ` Consulting doctor per Pulse: ${doctorLabel(consult.display_name)}.${staleNote(consult)}` : ""}`,
        `Start the day recording from the room page on the Mac in ${name}.`,
      );
    }

    // R6 — OPEN OUTBOX. The watchdog's newest offline/degraded alert stands until audio is PROVEN back: a chunk newer than the alert and a level
    // signal that has moved since. It clears on the FIRST such evidence, by spec — there is no hold-down. The watchdog's own `recovered` message
    // is deliberately not consulted: it fired falsely at 04:36 on 5 Oct.
    // GATE: the alert is closed when the room's watchdog state is `ok` AND no session is open for it (a room closed for the day, whose alert the
    // watchdog closed quietly). A session that is open keeps the alert standing until audio is proven. No state row = not closed.
    const alertClosedByWatchdog = r.outbox?.state_status === "ok" && !r.open_session;
    if (r.outbox && !alertClosedByWatchdog && !isGenuineRecovery({ chunk_after_alert: r.outbox.chunk_after_alert, distinct_levels: r.outbox.distinct_levels_since_alert, live_samples: r.outbox.live_samples_since_alert, total_samples: r.outbox.total_samples_recent, silent_alert: r.outbox.kind === "degraded" && SILENT_ALERT_BODY_MARKERS.some((m) => r.outbox!.body.includes(m)) })) {
      const o = r.outbox;
      const reasons = (Object.keys(REASON_LABEL) as DegradationReason[]).filter((k) => o.body.includes(REASON_LABEL[k]));
      const red = o.kind === "offline" || reasons.includes("device_missing") || reasons.includes("tape_stalled");
      const at = fmtIst(o.created_at, now);
      const why = o.chunk_after_alert ? "the audio levels have not moved since" : "no new recording has arrived since";
      const what =
        o.kind === "offline"
          ? `The watchdog marked ${name} offline at ${at}`
          : `The watchdog flagged ${name} as degraded at ${at}${reasons.length ? ` (${reasons.map((k) => REASON_LABEL[k]).join(", ")})` : ""}`;
      mk(
        "open_outbox",
        red ? "red" : "amber",
        Date.parse(o.created_at),
        `${what}, and ${why}.`,
        o.kind === "offline"
          ? `Check the Mac in ${name} is on, awake and on the network.`
          : `Go to ${name} and check the microphone, the Mac's input device and that the recorder app is recording.`,
      );
    }

    // R7 — STALE START. A remote start that failed and that nobody has recovered by hand.
    if (r.failed_start) {
      const acked = Date.parse(r.failed_start.acked_at);
      const lastStart = r.last_session_started_at ? Date.parse(r.last_session_started_at) : -Infinity;
      if (Number.isFinite(acked) && now - acked <= FAILED_START_WINDOW_MS && now >= acked && !r.open_session && !(lastStart > acked)) {
        const why = clean(r.failed_start.error) || "no reason given";
        mk(
          "stale_start",
          "red",
          acked,
          `The remote start for ${name} failed at ${fmtIst(r.failed_start.acked_at, now)} ("${why}") and no recording has opened since.`,
          `Go to ${name} and start the day recording from the room page, or restart the recorder app.`,
        );
      }
    }

    // R8 / R9 / R10 — PRESENCE EXTENSION. State from lib/encounter-windows/ext-health.ts; an excluded machine (Home Office, ORB3, ORB2) never has a row.
    // R8: the extension has been silent for >= 10 min while the Mac is up, Chrome is running and somebody HAS used the console since it went quiet (else it is `quiet`).
    // R9: collected here, raised ONCE for the fleet after the loop. `quiet` raises nothing.
    if (r.ext) {
      const e = r.ext;
      const lastMs = e.last_ext_ts ? Date.parse(e.last_ext_ts) : NaN;
      const ver = e.ext_version ? `version ${clean(e.ext_version, 40)}` : "version unknown";
      const beat = Number.isFinite(lastMs) ? `last heartbeat ${fmtIst(new Date(lastMs).toISOString(), now)}` : `no heartbeat on record in the last ${EXT_NEVER_SEEN_MS / 86_400_000} days`;
      const place = `${name}${e.machine ? ` (${clean(e.machine, 60)})` : ""}`;
      const missingAction =
        e.rebooted_recently && e.rebooted_at
          ? `Re-run the presence install on ${name} (machine rebooted at ${istHourMinute(e.rebooted_at)}, policy file lost).`
          : `Re-run the presence install on ${name} (policy file lost, usually after a reboot).`;
      if (e.status === "missing" && (e.ext_age_s === null || e.ext_age_s * 1000 >= EXT_MISSING_AFTER_MS)) {
        // When the kiosk-health daemon's newest chrome.profile (received within 20 min) exists, the cause and the action come from it (a present policy file
        // with a dead extension is a profile fault, not a lost policy); with no such row the old "policy file lost, re-run the install" wording stays.
        const advice = r.machine ? extensionMissingAdvice(inputs.kiosk_health?.get(normalizeHostname(r.machine)), now) : null;
        mk(
          "extension_missing",
          "red",
          Number.isFinite(lastMs) ? lastMs : now - EXT_NEVER_SEEN_MS,
          advice
            ? `The Pulse Presence extension on ${place} has gone silent although the Mac is up. ${advice.cause}; ${beat}, ${ver}. Doctor and room attribution is blind on this Mac.`
            : `The Pulse Presence extension on ${place} has gone silent although the Mac is up and Chrome is running; ${beat}, ${ver}. Doctor and room attribution is blind on this Mac.`,
          advice ? advice.action : missingAction,
        );
      }
      if (e.status === "behind" && e.behind_since) {
        const since = Date.parse(e.behind_since);
        if (Number.isFinite(since) && now - since >= EXT_BEHIND_AFTER_MS) {
          behindRooms.push({ name, version: e.ext_version ? clean(e.ext_version, 40) : "version unknown", since, atFloor: e.behind_at_floor });
        }
      }
      // guard_activity: collected here, raised ONCE for the fleet after the loop. A boot rewrite alone does not raise it.
      if (e.guard_events_24h > 0 || e.guard_relaunches_24h > 0) {
        const at = e.guard_first_at ? Date.parse(e.guard_first_at) : NaN;
        guardRooms.push({ name, since: Number.isFinite(at) ? at : now, reasons: e.guard_reasons_24h ?? {} });
      }
      // R10 — CHROME NOT RUNNING. The extension lives inside Chrome; with Chrome down nothing can report. Amber: a person (or the Kiosk Bot) opens it.
      // Clinic hours only (08:00–21:30 IST, every day): overnight Chrome is down by design.
      const istMin = istParts(now).minutes;
      if (e.status === "no_chrome" && istMin >= EXT_CHROME_ALERT_OPEN_MIN && istMin < EXT_CHROME_ALERT_CLOSE_MIN) {
        const down = e.chrome_down_since ? Date.parse(e.chrome_down_since) : NaN;
        mk(
          "chrome_not_running",
          "amber",
          Number.isFinite(down) ? down : now - (e.poller.age_s ?? 0) * 1000,
          `Chrome is not running on ${name}; presence cannot report.`,
          "Open Chrome on the kiosk (or wait for the Kiosk Bot).",
        );
      }
    }
  }

  // R9 — one fleet-level row for every room still on an old build.
  if (behindRooms.length > 0) {
    behindRooms.sort((x, y) => x.since - y.since || x.name.localeCompare(y.name));
    const n = behindRooms.length;
    const list = behindRooms.map((b) => `${b.name} (${b.version})`).join(", ");
    const floor = behindRooms.some((b) => b.atFloor) ? ` Behind for at least ${BEHIND_LOOKBACK_H} h.` : "";
    out.push({
      room_id: "fleet",
      room_name: "Fleet",
      machine: null,
      kind: "extension_behind",
      since: new Date(behindRooms[0].since).toISOString(),
      detail: `${n} ${n === 1 ? "room" : "rooms"} on old extension builds: ${list}; update to ${EXT_TARGET_VERSION}.${floor}`,
      action: `Update the Pulse Presence extension to ${EXT_TARGET_VERSION} on ${n === 1 ? "that Mac" : "those Macs"} (reload it from chrome://extensions, or re-pack from the current build).`,
      severity: "amber",
    });
  }

  // guard_activity — one fleet-level row for every Mac the presence guard acted on in the last 24 h.
  if (guardRooms.length > 0) {
    guardRooms.sort((x, y) => x.name.localeCompare(y.name, "en", { numeric: true }));
    const list = guardRooms.map((g) => `${g.name} (${guardReasonList(g.reasons)})`).join(", ");
    out.push({
      room_id: "fleet",
      room_name: "Fleet",
      machine: null,
      kind: "guard_activity",
      since: new Date(Math.min(...guardRooms.map((g) => g.since))).toISOString(),
      detail: `Presence guard acted in the last 24 h: ${list}.`,
      action: `The guard already repaired the extension policy or restarted Chrome. If the same ${guardRooms.length === 1 ? "Mac shows" : "Macs show"} up again tomorrow, find out why its policy file keeps being lost.`,
      severity: "amber",
    });
  }

  // R11-R17 — the kiosk-health daemon's rules (lib/kiosk-health-rules.ts), merged here so the one dedupe/sort below orders everything.
  // R16 (presence_cannot_run) is the EXPLANATION for a silent extension, so it replaces R8 (extension_missing) for the same room.
  if (inputs.kiosk_health && inputs.kiosk_health.size > 0) {
    const extByMachine = new Map<string, ExtHealthRow>();
    const roomByMachine = new Map<string, KioskRoomRef>();
    for (const r of inputs.rooms) {
      if (!r.machine) continue;
      const canon = normalizeHostname(r.machine);
      roomByMachine.set(canon, { room_id: r.room_id, room_name: r.room_name, machine: r.machine });
      if (r.ext) extByMachine.set(canon, r.ext);
    }
    const kiosk = kioskHealthItems(inputs.kiosk_health, extByMachine, new Date(now).toISOString(), isClinicHours(now), roomByMachine);
    const explained = new Set(kiosk.filter((k) => k.kind === "presence_cannot_run").map((k) => k.room_id));
    if (explained.size > 0) {
      for (let i = out.length - 1; i >= 0; i--) if (out[i]!.kind === "extension_missing" && explained.has(out[i]!.room_id)) out.splice(i, 1);
    }
    out.push(...kiosk);
  }

  // One item per kind per room (the earliest wins), then red first, oldest first.
  const seen = new Map<string, AttentionItem>();
  for (const it of out) {
    const k = `${it.room_id}|${it.kind}`;
    const prev = seen.get(k);
    if (!prev || Date.parse(it.since) < Date.parse(prev.since)) seen.set(k, it);
  }
  return [...seen.values()].sort((a, b) => sevRank(a.severity) - sevRank(b.severity) || Date.parse(a.since) - Date.parse(b.since) || a.room_name.localeCompare(b.room_name));
}

// ---------------------------------------------------------------------------
// The DB half — read-only. The rules above are proven with plain objects (tests/unit/fleet-attention.test.ts); these SELECTs are proven against a
// real postgres, query plans included (tests/unit/fleet-attention-sql.test.ts).
// ---------------------------------------------------------------------------

const toIso = (x: unknown): string | null => {
  if (x === null || x === undefined) return null;
  const t = new Date(x as string | number | Date).getTime();
  return Number.isFinite(t) ? new Date(t).toISOString() : null;
};
const num = (x: unknown): number | null => {
  if (x === null || x === undefined) return null;
  const n = Number(x);
  return Number.isFinite(n) ? n : null;
};

async function safe<T>(source: string, degraded: string[], fn: () => Promise<T>, fallback: T): Promise<T> {
  try {
    return await fn();
  } catch (e) {
    // Names and the driver's message only — never row contents.
    console.error(`[fleet-attention] could not read ${source}:`, e instanceof Error ? e.message.slice(0, 200) : String(e).slice(0, 200));
    degraded.push(source);
    return fallback;
  }
}

type RoomRow = { room_id: string; room_name: string; hostname: string | null };

export async function loadAttentionInputs(nowMs: number = Date.now()): Promise<{ inputs: AttentionInputs; degraded: string[] }> {
  // The fleet itself is the one read that is allowed to abort: with no room list there is nothing to say.
  const roomRows = (await sql`
    SELECT r.id AS room_id, r.name AS room_name, ri.hostname
      FROM room_install ri
      JOIN room r ON r.id = ri.room_id
     WHERE ri.retired_at IS NULL AND ri.enrolled_at IS NOT NULL AND r.disabled_at IS NULL
     ORDER BY r.name
  `) as RoomRow[];

  const degraded: string[] = [];
  // Every bench_level_sample / bench_chunk read below is scoped to THESE rooms (`= ANY(ids)`) so it rides the room_id-leading indexes.
  const ids = roomRows.map((r) => r.room_id);
  const machines = roomRows
    .filter((r) => r.hostname)
    .map((r) => {
      const n = normalizeHostname(r.hostname as string);
      return { n, raw: r.hostname as string, legacy: legacyPollerKey(n) };
    });
  const mj = JSON.stringify(machines);

  const [extLatest, activity, poller, sessions, samples, lastSamples, chunks, windows, outbox, failed, extRows] = await Promise.all([
    // R1 — the newest lock-determining ext event per machine (same predicate as classifyExtEvent).
    safe("presence_ext", degraded, async () => (await sql`
      SELECT m.n AS machine, e.event, e.ts, e.focus
        FROM jsonb_to_recordset(${mj}::jsonb) AS m(n text, raw text, legacy text)
        CROSS JOIN LATERAL (
          SELECT p.event, p.ts, p.payload->>'tab_focus' AS focus
            FROM pulse_presence_events p
           WHERE p.source = 'ext' AND p.machine IN (m.n, m.raw) AND p.ts > now() - interval '14 days'
             AND (p.event IN ('locked', 'active', 'login', 'encounter_open', 'encounter_close')
                  OR (p.event = 'heartbeat' AND p.payload->>'tab_focus' = 'true'))
           ORDER BY p.ts DESC LIMIT 1
        ) e
    `) as Array<{ machine: string; event: string; ts: unknown; focus: string | null }>, []),
    // R5 — genuine activity in the last 30 minutes.
    safe("presence_activity", degraded, async () => (await sql`
      SELECT m.n AS machine, min(p.ts) AS first_at, max(p.ts) AS last_at
        FROM jsonb_to_recordset(${mj}::jsonb) AS m(n text, raw text, legacy text)
        JOIN pulse_presence_events p
          ON p.source = 'ext' AND p.machine IN (m.n, m.raw) AND p.ts > now() - interval '30 minutes'
         AND (p.event IN ('login', 'active', 'encounter_open', 'encounter_close')
              OR (p.event = 'heartbeat' AND p.payload->>'tab_focus' = 'true'))
       GROUP BY m.n
    `) as Array<{ machine: string; first_at: unknown; last_at: unknown }>, []),
    // R1 — the poller's newest row per machine, matched on the canonical key, the raw hostname AND the pre-rename short key (POLLER_LEGACY_KEYS);
    // where its current locked/unreachable run began, and where its current `unreachable` run began (3-day look-back each).
    safe("presence_poller", degraded, async () => (await sql`
      SELECT m.n AS machine, l.ts, l.state, l.locked,
             (SELECT min(q.ts) FROM pulse_presence_events q
               WHERE q.source = 'poller' AND q.machine IN (m.n, m.raw, m.legacy)
                 AND q.ts > COALESCE(
                       (SELECT max(o.ts) FROM pulse_presence_events o
                         WHERE o.source = 'poller' AND o.machine IN (m.n, m.raw, m.legacy) AND o.ts > now() - interval '3 days'
                           AND o.event = 'ok' AND o.payload->>'locked' IS DISTINCT FROM 'true'),
                       now() - interval '3 days')) AS asleep_since,
             (SELECT min(q.ts) FROM pulse_presence_events q
               WHERE q.source = 'poller' AND q.machine IN (m.n, m.raw, m.legacy) AND q.event = 'unreachable'
                 AND q.ts > COALESCE(
                       (SELECT max(o.ts) FROM pulse_presence_events o
                         WHERE o.source = 'poller' AND o.machine IN (m.n, m.raw, m.legacy) AND o.ts > now() - interval '3 days'
                           AND o.event <> 'unreachable'),
                       now() - interval '3 days')) AS unreachable_since
        FROM jsonb_to_recordset(${mj}::jsonb) AS m(n text, raw text, legacy text)
        CROSS JOIN LATERAL (
          SELECT p.ts, p.event AS state, p.payload->>'locked' AS locked
            FROM pulse_presence_events p
           WHERE p.source = 'poller' AND p.machine IN (m.n, m.raw, m.legacy) AND p.ts > now() - interval '14 days'
           ORDER BY p.ts DESC LIMIT 1
        ) l
    `) as Array<{ machine: string; ts: unknown; state: string | null; locked: string | null; asleep_since: unknown; unreachable_since: unknown }>, []),
    // The fleet's open sessions and the last 2 days' starts (bench_session (room_id, started_at DESC)). For an OPEN session also the newest chunk of
    // any age, by the (session_id, source, idx) index.
    safe("bench_session", degraded, async () => (await sql`
      SELECT s.room_id, s.id, s.status, s.started_at,
             CASE WHEN s.status IN ('recording', 'paused')
                  THEN (SELECT max(c.created_at) FROM bench_chunk c WHERE c.session_id = s.id) END AS last_chunk_at
        FROM bench_session s
       WHERE s.room_id = ANY(${ids}::text[])
         AND (s.started_at > now() - interval '2 days' OR s.status IN ('recording', 'paused'))
    `) as Array<{ room_id: string; id: string; status: string; started_at: unknown; last_chunk_at: unknown }>, []),
    // R1/R2 — the last 120 s of levels for the fleet: room_id = ANY(ids) leads the (room_id, ist_date, sampled_at) index, ist_date and sampled_at bound it.
    safe("bench_level_sample", degraded, async () => (await sql`
      SELECT b.room_id, b.sampled_at, b.peak, b.zero_ratio
        FROM bench_level_sample b
       WHERE b.room_id = ANY(${ids}::text[])
         AND b.ist_date >= ((now() - interval '120 seconds') AT TIME ZONE 'Asia/Kolkata')::date
         AND b.sampled_at > now() - interval '120 seconds'
    `) as Array<{ room_id: string; sampled_at: unknown; peak: unknown; zero_ratio: unknown }>, []),
    // The newest sample per room — one backwards index lookup each.
    safe("bench_level_last", degraded, async () => (await sql`
      SELECT x.room_id, (
               SELECT b.sampled_at FROM bench_level_sample b
                WHERE b.room_id = x.room_id AND b.ist_date >= ((now() - interval '2 days') AT TIME ZONE 'Asia/Kolkata')::date
                ORDER BY b.ist_date DESC, b.sampled_at DESC LIMIT 1
             ) AS last_sample_at
        FROM unnest(${ids}::text[]) AS x(room_id)
    `) as Array<{ room_id: string; last_sample_at: unknown }>, []),
    // Chunks of the last 30 min, for the fleet's open sessions and the last 2 days' sessions (bench_session (room_id, started_at DESC), then
    // bench_chunk (session_id, source, idx)); bench_chunk has no room_id, so the room scope is on the session.
    safe("bench_chunk", degraded, async () => (await sql`
      SELECT s.room_id, c.session_id, c.source, c.created_at, c.started_at, c.size_bytes, c.duration_ms
        FROM bench_session s
        JOIN bench_chunk c ON c.session_id = s.id
       WHERE s.room_id = ANY(${ids}::text[])
         AND (s.started_at > now() - interval '2 days' OR s.status IN ('recording', 'paused'))
         AND c.created_at > now() - interval '30 minutes'
    `) as Array<{ room_id: string; session_id: string; source: string; created_at: unknown; started_at: unknown; size_bytes: unknown; duration_ms: unknown }>, []),
    safe("eta_encounter_windows", degraded, async () => (await sql`
      SELECT w.room_id, COALESCE(w.consulting_doctor_name, w.display_name) AS display_name, w.t_open, w.t_close,
             w.display_name AS cookie_name, w.attribution_source, w.doctor_mismatch
        FROM eta_encounter_windows w
       WHERE w.room_id = ANY(${ids}::text[])
         AND (w.t_open > now() - interval '90 minutes'
              OR ((w.t_close IS NULL OR w.t_close > now()) AND w.t_open > now() - interval '4 hours'))
    `) as Array<{ room_id: string; display_name: string | null; t_open: unknown; t_close: unknown; cookie_name: string | null; attribution_source: string | null; doctor_mismatch: unknown }>, []),
    // R6 — the newest offline/degraded alert per room (last 7 days) plus, measured since it: any chunk (only sessions that had not ended before the
    // alert can have one), and whether any level sample differs from the first one after the alert. `distinct_levels_since_alert` is 0 (no
    // samples), 1 (all identical) or 2 (at least two values). Every sample read is per room (a.room_id) and bounded by the alert's IST date.
    safe("room_alert_outbox", degraded, async () => (await sql`
      WITH a AS (
        SELECT DISTINCT ON (rid) rid AS room_id, o.id, o.kind, o.created_at, o.body
          FROM room_alert_outbox o
          CROSS JOIN LATERAL unnest(o.room_ids) AS rid
         WHERE o.kind IN ('offline', 'degraded') AND o.created_at > now() - interval '7 days'
         ORDER BY rid, o.created_at DESC, o.id DESC
      )
      SELECT a.room_id, a.id, a.kind, a.created_at, a.body,
             (SELECT ras.status FROM room_alert_state ras WHERE ras.room_id = a.room_id) AS state_status,
             EXISTS (
               SELECT 1 FROM bench_session s JOIN bench_chunk c ON c.session_id = s.id
                WHERE s.room_id = a.room_id AND (s.ended_at IS NULL OR s.ended_at > a.created_at) AND c.created_at > a.created_at
             ) AS chunk_after_alert,
             COALESCE((
               SELECT CASE WHEN EXISTS (
                        SELECT 1 FROM bench_level_sample b
                         WHERE b.room_id = a.room_id
                           AND b.ist_date >= (a.created_at AT TIME ZONE 'Asia/Kolkata')::date
                           AND b.sampled_at > f.sampled_at
                           AND (b.peak, b.zero_ratio) IS DISTINCT FROM (f.peak, f.zero_ratio)
                      ) THEN 2 ELSE 1 END
                 FROM (
                   SELECT x.sampled_at, x.peak, x.zero_ratio FROM bench_level_sample x
                    WHERE x.room_id = a.room_id
                      AND x.ist_date >= (a.created_at AT TIME ZONE 'Asia/Kolkata')::date
                      AND x.sampled_at > a.created_at
                    ORDER BY x.ist_date, x.sampled_at LIMIT 1
                 ) f
             ), 0)::int AS distinct_levels_since_alert,
             (SELECT count(*) FILTER (WHERE x.zero_ratio IS NOT NULL AND x.zero_ratio < ${RECOVERY_LIVE_MAX_ZERO_RATIO} AND x.peak >= ${RECOVERY_LIVE_MIN_PEAK})::int
                FROM bench_level_sample x
               WHERE x.room_id = a.room_id AND x.ist_date >= (a.created_at AT TIME ZONE 'Asia/Kolkata')::date
                 AND x.sampled_at > a.created_at AND x.sampled_at > now() - interval '120 seconds') AS live_samples_since_alert,
             (SELECT count(*)::int FROM bench_level_sample x
               WHERE x.room_id = a.room_id AND x.ist_date >= (a.created_at AT TIME ZONE 'Asia/Kolkata')::date
                 AND x.sampled_at > a.created_at AND x.sampled_at > now() - interval '120 seconds') AS total_samples_recent
        FROM a
       WHERE a.room_id = ANY(${ids}::text[])
    `) as Array<{ room_id: string; id: unknown; kind: string; created_at: unknown; body: string; state_status: string | null; chunk_after_alert: boolean; distinct_levels_since_alert: unknown; live_samples_since_alert: unknown; total_samples_recent: unknown }>, []),
    safe("bench_command", degraded, async () => (await sql`
      SELECT DISTINCT ON (c.room_id) c.room_id, c.acked_at, COALESCE(c.error, c.result->>'error') AS error
        FROM bench_command c
       WHERE c.room_id = ANY(${ids}::text[]) AND c.kind = 'start_day' AND c.status = 'failed'
         AND c.acked_at > now() - interval '60 minutes' AND c.created_at > now() - interval '3 hours'
       ORDER BY c.room_id, c.acked_at DESC
    `) as Array<{ room_id: string; acked_at: unknown; error: string | null }>, []),
    // R8/R9 — the extension's health per presence machine (excluded machines have no row). Its own source name, so a failure degrades only R8/R9.
    safe("ext_health", degraded, () => extHealth(sql, { asOf: nowMs, rooms: roomRows }), [] as ExtHealthRow[]),
  ]);
  const extHealthBy = new Map(extRows.filter((x) => x.room_id).map((x) => [x.room_id as string, x]));
  // R11-R17 — kiosk-health evidence for the same machines (every spelling), same asOf. A failed read (readKioskHealth's ok:false, or a throw) is an empty
  // map plus the "kiosk_health" source marked degraded, so "nothing needs attention" is not shown on the strength of evidence that was never read.
  const kioskKeys = [...new Set(roomRows.filter((r) => r.hostname && !isExtHealthExcluded(r.hostname)).flatMap((r) => machineKeys(r.hostname as string)))];
  const kh = await safe("kiosk_health", degraded, () => readKioskHealth(sql as never, kioskKeys, new Date(nowMs).toISOString()), { snapshots: new Map<string, KioskHealthSnapshot>(), ok: true });
  if (!kh.ok) degraded.push("kiosk_health");
  const kioskHealth = kh.snapshots;

  const byMachine = <T extends { machine: string }>(rows: T[]) => new Map(rows.map((r) => [r.machine, r]));
  const extBy = new Map<string, PresenceEventLite[]>();
  for (const e of extLatest) {
    const ts = toIso(e.ts);
    if (ts) extBy.set(e.machine, [{ event: e.event, ts, tab_focus: e.focus }]);
  }
  const actBy = byMachine(activity);
  const pollBy = byMachine(poller);

  const sessBy = new Map<string, RoomAttentionInputs["open_session"]>();
  const lastChunkBy = new Map<string, string | null>();
  const lastStartBy = new Map<string, string>();
  for (const s of sessions) {
    const started = toIso(s.started_at);
    if (!started) continue;
    const prevLast = lastStartBy.get(s.room_id);
    if (!prevLast || Date.parse(started) > Date.parse(prevLast)) lastStartBy.set(s.room_id, started);
    if (s.status === "recording" || s.status === "paused") {
      const prev = sessBy.get(s.room_id);
      if (!prev || Date.parse(started) > Date.parse(prev.started_at)) {
        sessBy.set(s.room_id, { id: s.id, status: s.status, started_at: started });
        lastChunkBy.set(s.room_id, toIso(s.last_chunk_at));
      }
    }
  }

  const group = <T extends { room_id: string }, U>(rows: T[], f: (r: T) => U | null): Map<string, U[]> => {
    const m = new Map<string, U[]>();
    for (const r of rows) {
      const u = f(r);
      if (u === null) continue;
      const a = m.get(r.room_id);
      if (a) a.push(u);
      else m.set(r.room_id, [u]);
    }
    return m;
  };
  const samplesBy = group(samples, (r): LevelSample | null => {
    const t = toIso(r.sampled_at);
    const peak = num(r.peak);
    return t && peak !== null ? { sampled_at: t, peak, zero_ratio: num(r.zero_ratio) } : null;
  });
  const chunksBy = group(chunks, (r): ChunkLite | null => {
    const created = toIso(r.created_at);
    const started = toIso(r.started_at);
    return created && started
      ? { session_id: r.session_id, source: r.source, created_at: created, started_at: started, size_bytes: num(r.size_bytes), duration_ms: num(r.duration_ms) }
      : null;
  });
  const windowsBy = group(windows, (r): WindowLite | null => {
    const open = toIso(r.t_open);
    return open
      ? {
          display_name: r.display_name,
          t_open: open,
          t_close: toIso(r.t_close),
          cookie_name: r.cookie_name ?? null,
          source: r.attribution_source ?? null,
          stale: r.attribution_source === "warehouse" && r.doctor_mismatch === true,
        }
      : null;
  });
  const lastSampleBy = new Map(lastSamples.map((r) => [r.room_id, toIso(r.last_sample_at)]));
  const outboxBy = new Map(outbox.map((r) => [r.room_id, r]));
  const failedBy = new Map(failed.map((r) => [r.room_id, r]));

  // R1/R2's look-back: only for rooms whose last 120 s is ONE identical value, find where that run began (2-day look-back). Rare, so per room;
  // both reads are room_id = $1 with an ist_date bound.
  const frozenSince = new Map<string, string | null>();
  for (const [roomId, ss] of samplesBy) {
    if (!sessBy.has(roomId) || new Set(ss.map((s) => `${s.peak}|${s.zero_ratio}`)).size > 1) continue;
    const last = ss[ss.length - 1]!;
    const since = await safe("bench_level_frozen_since", degraded, async () => (await sql`
      SELECT min(b.sampled_at) AS since
        FROM bench_level_sample b
       WHERE b.room_id = ${roomId}
         AND b.ist_date >= ((now() - interval '2 days') AT TIME ZONE 'Asia/Kolkata')::date
         AND b.sampled_at > COALESCE((
               SELECT max(d.sampled_at) FROM bench_level_sample d
                WHERE d.room_id = ${roomId}
                  AND d.ist_date >= ((now() - interval '2 days') AT TIME ZONE 'Asia/Kolkata')::date
                  AND (d.peak, d.zero_ratio) IS DISTINCT FROM (${last.peak}::real, ${last.zero_ratio}::real)
             ), now() - interval '2 days')
    `) as Array<{ since: unknown }>, []);
    frozenSince.set(roomId, toIso(since[0]?.since));
  }

  const rooms: RoomAttentionInputs[] = roomRows.map((r) => {
    const key = r.hostname ? normalizeHostname(r.hostname) : null;
    const act = key ? actBy.get(key) : undefined;
    const pol = key ? pollBy.get(key) : undefined;
    const ob = outboxBy.get(r.room_id);
    const fs = failedBy.get(r.room_id);
    const obAt = ob ? toIso(ob.created_at) : null;
    const polTs = pol ? toIso(pol.ts) : null;
    const actFirst = act ? toIso(act.first_at) : null;
    const actLast = act ? toIso(act.last_at) : null;
    const fsAt = fs ? toIso(fs.acked_at) : null;
    return {
      room_id: r.room_id,
      room_name: r.room_name,
      machine: r.hostname,
      ext_events: key ? (extBy.get(key) ?? []) : [],
      poller:
        pol && polTs
          ? { ts: polTs, state: pol.state, locked: pol.locked === "true", asleep_since: toIso(pol.asleep_since), unreachable_since: toIso(pol.unreachable_since) }
          : null,
      recent_activity: actFirst && actLast ? { first_at: actFirst, last_at: actLast } : null,
      open_session: sessBy.get(r.room_id) ?? null,
      last_session_started_at: lastStartBy.get(r.room_id) ?? null,
      last_chunk_at: lastChunkBy.get(r.room_id) ?? null,
      samples: samplesBy.get(r.room_id) ?? [],
      frozen_since: frozenSince.get(r.room_id) ?? null,
      last_sample_at: lastSampleBy.get(r.room_id) ?? null,
      chunks: chunksBy.get(r.room_id) ?? [],
      windows: windowsBy.get(r.room_id) ?? [],
      outbox:
        ob && obAt && (ob.kind === "offline" || ob.kind === "degraded")
          ? {
              id: String(ob.id),
              kind: ob.kind,
              created_at: obAt,
              body: ob.body ?? "",
              state_status: ob.state_status ?? null,
              chunk_after_alert: Boolean(ob.chunk_after_alert),
              distinct_levels_since_alert: Number(ob.distinct_levels_since_alert) || 0,
              live_samples_since_alert: Number(ob.live_samples_since_alert) || 0,
              total_samples_recent: Number(ob.total_samples_recent) || 0,
            }
          : null,
      failed_start: fs && fsAt ? { acked_at: fsAt, error: fs.error } : null,
      ext: extHealthBy.get(r.room_id) ?? null,
    };
  });

  return { inputs: { now_ms: nowMs, rooms, kiosk_health: kioskHealth }, degraded };
}

/** The route's whole job: load, compute, wrap. */
export async function getFleetAttention(nowMs: number = Date.now()): Promise<FleetAttentionResponse> {
  const { inputs, degraded } = await loadAttentionInputs(nowMs);
  return {
    generated_at: new Date(nowMs).toISOString(),
    items: computeAttention(inputs),
    rooms_checked: inputs.rooms.length,
    ...(inputs.kiosk_health && inputs.kiosk_health.size > 0 ? { kiosk_health: summarizeKioskHealth(inputs.kiosk_health, nowMs) } : {}),
    ...(degraded.length ? { degraded: [...new Set(degraded)] } : {}),
  };
}

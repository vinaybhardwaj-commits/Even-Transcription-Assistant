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
 * R6 open_outbox            a watchdog offline/degraded alert with no GENUINE recovery since (chunk after it AND >= 2 distinct levels). Red/amber.
 *                           R6 clears on the FIRST genuine evidence, by spec (a single recovery chunk is enough; there is no hold-down).
 * R7 stale_start            a remote start_day failed in the last 60 min and no session has opened since. Red.
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
import { REASON_LABEL, isGenuineRecovery, type DegradationReason } from "@/lib/room-watchdog";
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
/** R7 */
export const FAILED_START_WINDOW_MS = 60 * 60_000;

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

/**
 * Poller rows written BEFORE the 5 Oct 2026 cutover (04:44Z, poller commit "key machine on full hostname") key `machine` on the short name;
 * every row since keys on the full hostname, `unreachable` rows included (poller/events.py `make_event(host["machine"], …, None)`: one `machine`
 * for ok and unreachable alike). The loader reads BOTH spellings so a lock/unreachable run that straddles the cutover is not cut in two. The two
 * `-2` Macs (OPD 1, OPD 4 Ortho) were always keyed on full names and have no short form. Legacy key -> canonical key.
 */
export const POLLER_LEGACY_KEYS: Readonly<Record<string, string>> = {
  consul4: "EHRC-CONSUL4s-Mac-mini",
  consul5: "EHRC-CONSUL5s-Mac-mini",
  consul6: "EHRC-CONSUL6s-Mac-mini",
  consul7: "EHRC-CONSUL7s-Mac-mini",
  echo: "EHRC-ECHOs-Mac-mini",
  discussion: "EHRC-DISCUSSIONs-Mac-mini",
  audiometry: "EHRC-AUDIOMETRYs-Mac-mini",
};

/** The pre-rename poller key for a canonical machine key, or null. */
export function legacyPollerKey(canonical: string): string | null {
  for (const [legacy, canon] of Object.entries(POLLER_LEGACY_KEYS)) if (canon === canonical) return legacy;
  return null;
}

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
export type WindowLite = { display_name: string | null; t_open: string; t_close: string | null };

/** The newest watchdog offline/degraded alert for the room, with the two facts a GENUINE recovery needs, measured since that alert. */
export type OutboxFacts = {
  id: string | number;
  kind: "offline" | "degraded";
  created_at: string;
  body: string;
  chunk_after_alert: boolean;
  distinct_levels_since_alert: number;
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
};

export type AttentionInputs = { now_ms: number; rooms: RoomAttentionInputs[] };

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

const doctorLabel = (name: string | null): string => {
  const n = clean(name, 80);
  if (!n) return "A doctor";
  return /^dr\.?\s/i.test(n) ? n : `Dr ${n}`;
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
          `${doctorLabel(first.w.display_name)} is consulting but nothing is being recorded — no recording has reached the server in the last 10 minutes.`,
          `Go to ${name} now: check the recorder app is running and the microphone is connected, and start the day recording if it is not.`,
        );
      }
    }

    // R5 — NO SESSION IN CLINIC. Somebody is using the Mac during clinic hours and no tape is open (paused still counts as open).
    if (isClinicHours(now) && r.recent_activity && !r.open_session) {
      const first = Date.parse(r.recent_activity.first_at);
      const clinicOpen = istParts(now).midnightMs + CLINIC_OPEN_MIN * 60_000;
      mk(
        "no_session_in_clinic",
        "amber",
        Math.max(clinicOpen, Number.isFinite(first) ? first : clinicOpen),
        `The Mac in ${name} has been in use during clinic hours but no recording is open.`,
        `Start the day recording from the room page on the Mac in ${name}.`,
      );
    }

    // R6 — OPEN OUTBOX. The watchdog's newest offline/degraded alert stands until audio is PROVEN back: a chunk newer than the alert and a level
    // signal that has moved since. It clears on the FIRST such evidence, by spec — there is no hold-down. The watchdog's own `recovered` message
    // is deliberately not consulted: it fired falsely at 04:36 on 5 Oct.
    // GATE: the alert is closed when the room's watchdog state is `ok` AND no session is open for it (a room closed for the day, whose alert the
    // watchdog closed quietly). A session that is open keeps the alert standing until audio is proven. No state row = not closed.
    const alertClosedByWatchdog = r.outbox?.state_status === "ok" && !r.open_session;
    if (r.outbox && !alertClosedByWatchdog && !isGenuineRecovery({ chunk_after_alert: r.outbox.chunk_after_alert, distinct_levels: r.outbox.distinct_levels_since_alert })) {
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

  const [extLatest, activity, poller, sessions, samples, lastSamples, chunks, windows, outbox, failed] = await Promise.all([
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
      SELECT w.room_id, w.display_name, w.t_open, w.t_close
        FROM eta_encounter_windows w
       WHERE w.room_id = ANY(${ids}::text[])
         AND (w.t_open > now() - interval '15 minutes'
              OR ((w.t_close IS NULL OR w.t_close > now()) AND w.t_open > now() - interval '4 hours'))
    `) as Array<{ room_id: string; display_name: string | null; t_open: unknown; t_close: unknown }>, []),
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
             ), 0)::int AS distinct_levels_since_alert
        FROM a
       WHERE a.room_id = ANY(${ids}::text[])
    `) as Array<{ room_id: string; id: unknown; kind: string; created_at: unknown; body: string; state_status: string | null; chunk_after_alert: boolean; distinct_levels_since_alert: unknown }>, []),
    safe("bench_command", degraded, async () => (await sql`
      SELECT DISTINCT ON (c.room_id) c.room_id, c.acked_at, COALESCE(c.error, c.result->>'error') AS error
        FROM bench_command c
       WHERE c.room_id = ANY(${ids}::text[]) AND c.kind = 'start_day' AND c.status = 'failed'
         AND c.acked_at > now() - interval '60 minutes' AND c.created_at > now() - interval '3 hours'
       ORDER BY c.room_id, c.acked_at DESC
    `) as Array<{ room_id: string; acked_at: unknown; error: string | null }>, []),
  ]);

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
    return open ? { display_name: r.display_name, t_open: open, t_close: toIso(r.t_close) } : null;
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
            }
          : null,
      failed_start: fs && fsAt ? { acked_at: fsAt, error: fs.error } : null,
    };
  });

  return { inputs: { now_ms: nowMs, rooms }, degraded };
}

/** The route's whole job: load, compute, wrap. */
export async function getFleetAttention(nowMs: number = Date.now()): Promise<FleetAttentionResponse> {
  const { inputs, degraded } = await loadAttentionInputs(nowMs);
  return {
    generated_at: new Date(nowMs).toISOString(),
    items: computeAttention(inputs),
    rooms_checked: inputs.rooms.length,
    ...(degraded.length ? { degraded: [...new Set(degraded)] } : {}),
  };
}

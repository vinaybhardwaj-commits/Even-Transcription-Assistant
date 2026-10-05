/**
 * lib/fleet-attention.ts — "what needs a human right now", derived from STATE, never from events.
 *
 * WHY (5 Oct 2026). /admin/bench printed "Nothing needs attention." while OPD 4 had recorded nothing for four days and OPD 3's microphone was
 * dead. The room watchdog (lib/room-watchdog.ts) is EDGE-triggered: it speaks once when a room changes status, its `recovered` fires when a
 * session CLOSES (a clean poll), Macs that fell into DarkWake still polled, and nobody consumes its outbox. An edge is a fact about a moment; a
 * person standing in the hallway needs a fact about NOW. So every rule below is a pure function of the room's current evidence, re-evaluated on
 * every call: an item exists exactly while its condition holds, and disappears the call after it stops holding. Nothing is remembered.
 *
 * R1 asleep                 the Mac slept (ext `locked`, or the tailnet poller sees it locked/unreachable) and nothing woke it. Red, any hour.
 * R2 capture_frozen         a session is open and the level meter has delivered one identical value (or nothing) for 120 s. Red.
 * R3 silent_tape            two newest chunks of the open session are digital silence (<= 230,000 bytes). Red.
 * R4 consult_without_tape   Pulse says a consult is open (or opened < 15 min ago) and no chunk has arrived for 10 min. Red.
 * R5 no_session_in_clinic   clinic hours, the Mac was in use in the last 30 min, and no session is open. Amber.
 * R6 open_outbox            a watchdog offline/degraded alert with no GENUINE recovery since (chunk after it AND >= 2 distinct levels). Red/amber.
 * R7 stale_start            a remote start_day failed in the last 60 min and no session has opened since. Red.
 *
 * `computeAttention` is PURE (no I/O). `loadAttentionInputs` / `getFleetAttention` are the DB half: read-only SELECTs, bound parameters only (the
 * Neon HTTP driver has no sql.unsafe), timestamps normalised from whatever the driver returns. A source that cannot be read is NAMED in
 * `degraded` and its rules are skipped; the panel never says "Nothing needs attention" over a degraded read.
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
/** R3: a 5-minute chunk this small or smaller is digital silence (212,378 bytes measured on 5 Oct). */
export const SILENT_CHUNK_MAX_BYTES = 230_000;
export const SILENT_CHUNKS_REQUIRED = 2;
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

// ---------------------------------------------------------------------------
// Inputs
// ---------------------------------------------------------------------------

/** One presence event from the Pulse extension (source 'ext'). `tab_focus` is payload->>'tab_focus' (a boolean or the string form). */
export type PresenceEventLite = { event: string; ts: string; tab_focus?: boolean | string | null };

/** The newest tailnet-poller row for the machine. `asleep_since` = start of the current unbroken run of locked/unreachable polls, if known. */
export type PollerLite = { ts: string; state: string | null; locked: boolean; asleep_since?: string | null };

export type LevelSample = { sampled_at: string; peak: number; zero_ratio: number | null };
export type ChunkLite = { session_id: string; source: string; created_at: string; started_at: string; size_bytes: number | null };
export type WindowLite = { display_name: string | null; t_open: string; t_close: string | null };

/** The newest watchdog offline/degraded alert for the room, with the two facts a GENUINE recovery needs, measured since that alert. */
export type OutboxFacts = {
  id: string | number;
  kind: "offline" | "degraded";
  created_at: string;
  body: string;
  chunk_after_alert: boolean;
  distinct_levels_since_alert: number;
};

export type RoomAttentionInputs = {
  room_id: string;
  room_name: string;
  /** room_install.hostname (the presence `machine`), or null */
  machine: string | null;
  /** R1: raw ext events — any subset that includes the newest power-determining ones; ordering is not assumed. */
  ext_events: PresenceEventLite[];
  poller: PollerLite | null;
  /** R5: genuine ext activity (login/active/focused heartbeat/encounter_*) in the last ACTIVITY_WINDOW_MS */
  recent_activity: { first_at: string; last_at: string } | null;
  /** The room's open bench_session (recording or paused), or null. */
  open_session: { id: string; status: "recording" | "paused"; started_at: string } | null;
  /** Start of the room's newest session of any status, or null. */
  last_session_started_at: string | null;
  /** R2: level samples from the last FROZEN_WINDOW_MS. */
  samples: LevelSample[];
  /** R2: when the current identical-value run began, if the loader looked further back than the window. */
  frozen_since: string | null;
  /** R2: the newest sample of any age the loader could find. */
  last_sample_at: string | null;
  /** R3/R4: the room's chunks from the last 30 minutes, any source, any order. */
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
// R1 — power state
// ---------------------------------------------------------------------------

const isFocused = (f: unknown): boolean => f === true || f === "true";

/**
 * Does this ext event say anything about whether the Mac is awake? `locked` = it slept. login/active/encounter_* and a FOCUSED heartbeat = a
 * person is at it. `idle`, `logout` and an UNFOCUSED heartbeat say nothing: on 5 Oct the extension kept sending unfocused heartbeats all
 * through DarkWake, so a heartbeat alone must never clear a `locked`. The loader's SQL uses this same predicate.
 */
export function classifyExtEvent(e: PresenceEventLite): "asleep" | "awake" | null {
  switch (e.event) {
    case "locked":
      return "asleep";
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

/** PURE. Newest determination wins across the extension and the poller. */
export function resolvePower(
  extEvents: readonly PresenceEventLite[],
  poller: PollerLite | null,
): { asleep: boolean; since: string | null } {
  let ext: { state: "asleep" | "awake"; ts: number; iso: string } | null = null;
  for (const e of extEvents) {
    const state = classifyExtEvent(e);
    const ts = Date.parse(e.ts);
    if (!state || !Number.isFinite(ts)) continue;
    if (!ext || ts >= ext.ts) ext = { state, ts, iso: new Date(ts).toISOString() };
  }
  let pol: { state: "asleep" | "awake"; ts: number; since: string } | null = null;
  if (poller) {
    const ts = Date.parse(poller.ts);
    const state = poller.locked || poller.state === "unreachable" ? "asleep" : poller.state === "ok" ? "awake" : null;
    if (state && Number.isFinite(ts)) pol = { state, ts, since: poller.asleep_since ?? new Date(ts).toISOString() };
  }
  if (!ext && !pol) return { asleep: false, since: null };
  // Newest wins; on an exact tie the alarm wins.
  let winner: { state: "asleep" | "awake"; ts: number };
  if (ext && pol) winner = pol.ts > ext.ts ? pol : ext.ts > pol.ts ? ext : ext.state === "asleep" ? ext : pol;
  else winner = (ext ?? pol)!;
  if (winner.state !== "asleep") return { asleep: false, since: null };
  const starts: number[] = [];
  if (ext && ext.state === "asleep") starts.push(ext.ts);
  if (pol && pol.state === "asleep") starts.push(Date.parse(pol.since));
  const valid = starts.filter(Number.isFinite);
  return { asleep: true, since: new Date(valid.length ? Math.min(...valid) : winner.ts).toISOString() };
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

    // R1 — ASLEEP. Any hour: a Mac that sleeps overnight and is still asleep at 08:30 records nothing, and "since" says how long.
    const power = resolvePower(r.ext_events, r.poller);
    if (power.asleep && power.since) {
      mk(
        "asleep",
        "red",
        Date.parse(power.since),
        `The Mac in ${name} went to sleep at ${fmtIst(power.since, now)} and has not woken since.`,
        `Wake the Mac in ${name} (press a key) and check it stays awake and the room page is open.`,
      );
    }

    // R2 — CAPTURE FROZEN. CoreAudio stopping delivery freezes the meter to ONE value (4,220 identical samples on OPD 6 from 01:36:52).
    // A session that opened under two minutes ago has not had time to prove anything either way.
    if (recording && now - sessionStartMs >= FROZEN_WINDOW_MS) {
      const win = r.samples
        .map((s) => ({ ...s, t: Date.parse(s.sampled_at) }))
        .filter((s) => Number.isFinite(s.t) && s.t >= now - FROZEN_WINDOW_MS && s.t <= now + 60_000)
        .sort((a, b) => a.t - b.t);
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
      } else {
        const distinct = new Set(win.map((s) => `${s.peak}|${s.zero_ratio}`));
        if (distinct.size <= 1) {
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
    }

    // R3 — SILENT TAPE. Newest chunks of the OPEN session's primary mic, as a run from the newest backwards.
    if (recording && r.open_session) {
      const prim = r.chunks
        .filter((c) => c.session_id === r.open_session!.id && c.source === "primary")
        .sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at));
      const run: ChunkLite[] = [];
      for (const c of prim) {
        if (c.size_bytes !== null && c.size_bytes <= SILENT_CHUNK_MAX_BYTES) run.push(c);
        else break;
      }
      if (run.length >= SILENT_CHUNKS_REQUIRED) {
        const oldest = run[run.length - 1]!;
        mk(
          "silent_tape",
          "red",
          Date.parse(oldest.started_at),
          `The last ${run.length} recording pieces from ${name} are digital silence (about ${Math.round((run[0]!.size_bytes ?? 0) / 1000)} KB each) — the microphone is connected but delivering no sound.`,
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
      const chunkTimes = r.chunks.map((c) => Date.parse(c.created_at)).filter(Number.isFinite);
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
    // signal that has moved since. The watchdog's own `recovered` message is deliberately not consulted — it fired falsely at 04:36 on 5 Oct.
    if (r.outbox && !isGenuineRecovery({ chunk_after_alert: r.outbox.chunk_after_alert, distinct_levels: r.outbox.distinct_levels_since_alert })) {
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
// The DB half — read-only. Not unit-tested (no database in the test run); the queries were run against the live database read-only and
// are listed in docs/handoff/ETA-FLEET-ATTENTION-BUILD-05-OCT-2026.md.
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
  const machines = roomRows
    .filter((r) => r.hostname)
    .map((r) => ({ n: normalizeHostname(r.hostname as string), raw: r.hostname as string }));
  const mj = JSON.stringify(machines);

  const [extLatest, activity, poller, sessions, samples, lastSamples, chunks, windows, outbox, failed] = await Promise.all([
    // R1 — the newest power-determining ext event per machine (same predicate as classifyExtEvent).
    safe("presence_ext", degraded, async () => (await sql`
      SELECT m.n AS machine, e.event, e.ts, e.focus
        FROM jsonb_to_recordset(${mj}::jsonb) AS m(n text, raw text)
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
        FROM jsonb_to_recordset(${mj}::jsonb) AS m(n text, raw text)
        JOIN pulse_presence_events p
          ON p.source = 'ext' AND p.machine IN (m.n, m.raw) AND p.ts > now() - interval '30 minutes'
         AND (p.event IN ('login', 'active', 'encounter_open', 'encounter_close')
              OR (p.event = 'heartbeat' AND p.payload->>'tab_focus' = 'true'))
       GROUP BY m.n
    `) as Array<{ machine: string; first_at: unknown; last_at: unknown }>, []),
    // R1 — the poller's newest row per machine, and where its current locked/unreachable run began (3-day look-back).
    safe("presence_poller", degraded, async () => (await sql`
      SELECT m.n AS machine, l.ts, l.state, l.locked,
             (SELECT min(q.ts) FROM pulse_presence_events q
               WHERE q.source = 'poller' AND q.machine IN (m.n, m.raw)
                 AND q.ts > COALESCE(
                       (SELECT max(o.ts) FROM pulse_presence_events o
                         WHERE o.source = 'poller' AND o.machine IN (m.n, m.raw) AND o.ts > now() - interval '3 days'
                           AND o.event = 'ok' AND o.payload->>'locked' IS DISTINCT FROM 'true'),
                       now() - interval '3 days')) AS asleep_since
        FROM jsonb_to_recordset(${mj}::jsonb) AS m(n text, raw text)
        CROSS JOIN LATERAL (
          SELECT p.ts, p.event AS state, p.payload->>'locked' AS locked
            FROM pulse_presence_events p
           WHERE p.source = 'poller' AND p.machine IN (m.n, m.raw) AND p.ts > now() - interval '14 days'
           ORDER BY p.ts DESC LIMIT 1
        ) l
    `) as Array<{ machine: string; ts: unknown; state: string | null; locked: string | null; asleep_since: unknown }>, []),
    safe("bench_session", degraded, async () => (await sql`
      SELECT s.room_id, s.id, s.status, s.started_at
        FROM bench_session s
       WHERE s.started_at > now() - interval '2 days' OR s.status IN ('recording', 'paused')
    `) as Array<{ room_id: string; id: string; status: string; started_at: unknown }>, []),
    // R2 — the ist_date bound keeps the read on the newest pages of the (room_id, ist_date, sampled_at) index.
    safe("bench_level_sample", degraded, async () => (await sql`
      SELECT b.room_id, b.sampled_at, b.peak, b.zero_ratio
        FROM bench_level_sample b
       WHERE b.ist_date >= ((now() - interval '120 seconds') AT TIME ZONE 'Asia/Kolkata')::date
         AND b.sampled_at > now() - interval '120 seconds'
    `) as Array<{ room_id: string; sampled_at: unknown; peak: unknown; zero_ratio: unknown }>, []),
    safe("bench_level_last", degraded, async () => (await sql`
      SELECT x.room_id, (
               SELECT b.sampled_at FROM bench_level_sample b
                WHERE b.room_id = x.room_id ORDER BY b.ist_date DESC, b.sampled_at DESC LIMIT 1
             ) AS last_sample_at
        FROM (SELECT DISTINCT room_id FROM room_install WHERE retired_at IS NULL AND enrolled_at IS NOT NULL) x
    `) as Array<{ room_id: string; last_sample_at: unknown }>, []),
    safe("bench_chunk", degraded, async () => (await sql`
      SELECT s.room_id, c.session_id, c.source, c.created_at, c.started_at, c.size_bytes
        FROM bench_session s
        JOIN bench_chunk c ON c.session_id = s.id
       WHERE (s.started_at > now() - interval '2 days' OR s.status IN ('recording', 'paused'))
         AND c.created_at > now() - interval '30 minutes'
    `) as Array<{ room_id: string; session_id: string; source: string; created_at: unknown; started_at: unknown; size_bytes: unknown }>, []),
    safe("eta_encounter_windows", degraded, async () => (await sql`
      SELECT w.room_id, w.display_name, w.t_open, w.t_close
        FROM eta_encounter_windows w
       WHERE w.room_id IS NOT NULL
         AND (w.t_open > now() - interval '15 minutes'
              OR ((w.t_close IS NULL OR w.t_close > now()) AND w.t_open > now() - interval '4 hours'))
    `) as Array<{ room_id: string; display_name: string | null; t_open: unknown; t_close: unknown }>, []),
    // R6 — the newest offline/degraded alert per room (last 7 days) plus, measured since it: any chunk, and whether any level sample differs
    // from the first one after the alert. `distinct_levels_since_alert` is 0 (no samples), 1 (all identical) or 2 (at least two values).
    safe("room_alert_outbox", degraded, async () => (await sql`
      WITH a AS (
        SELECT DISTINCT ON (rid) rid AS room_id, o.id, o.kind, o.created_at, o.body
          FROM room_alert_outbox o
          CROSS JOIN LATERAL unnest(o.room_ids) AS rid
         WHERE o.kind IN ('offline', 'degraded') AND o.created_at > now() - interval '7 days'
         ORDER BY rid, o.created_at DESC, o.id DESC
      )
      SELECT a.room_id, a.id, a.kind, a.created_at, a.body,
             EXISTS (
               SELECT 1 FROM bench_chunk c JOIN bench_session s ON s.id = c.session_id
                WHERE s.room_id = a.room_id AND c.created_at > a.created_at
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
    `) as Array<{ room_id: string; id: unknown; kind: string; created_at: unknown; body: string; chunk_after_alert: boolean; distinct_levels_since_alert: unknown }>, []),
    safe("bench_command", degraded, async () => (await sql`
      SELECT DISTINCT ON (c.room_id) c.room_id, c.acked_at, COALESCE(c.error, c.result->>'error') AS error
        FROM bench_command c
       WHERE c.kind = 'start_day' AND c.status = 'failed'
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
  const lastStartBy = new Map<string, string>();
  for (const s of sessions) {
    const started = toIso(s.started_at);
    if (!started) continue;
    const prevLast = lastStartBy.get(s.room_id);
    if (!prevLast || Date.parse(started) > Date.parse(prevLast)) lastStartBy.set(s.room_id, started);
    if (s.status === "recording" || s.status === "paused") {
      const prev = sessBy.get(s.room_id);
      if (!prev || Date.parse(started) > Date.parse(prev.started_at)) sessBy.set(s.room_id, { id: s.id, status: s.status, started_at: started });
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
    return created && started ? { session_id: r.session_id, source: r.source, created_at: created, started_at: started, size_bytes: num(r.size_bytes) } : null;
  });
  const windowsBy = group(windows, (r): WindowLite | null => {
    const open = toIso(r.t_open);
    return open ? { display_name: r.display_name, t_open: open, t_close: toIso(r.t_close) } : null;
  });
  const lastSampleBy = new Map(lastSamples.map((r) => [r.room_id, toIso(r.last_sample_at)]));
  const outboxBy = new Map(outbox.map((r) => [r.room_id, r]));
  const failedBy = new Map(failed.map((r) => [r.room_id, r]));

  // R2's look-back: only for rooms whose last 120 s is ONE identical value, find where that run began (2-day look-back). Rare, so per room.
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
      poller: pol && polTs ? { ts: polTs, state: pol.state, locked: pol.locked === "true", asleep_since: toIso(pol.asleep_since) } : null,
      recent_activity: actFirst && actLast ? { first_at: actFirst, last_at: actLast } : null,
      open_session: sessBy.get(r.room_id) ?? null,
      last_session_started_at: lastStartBy.get(r.room_id) ?? null,
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

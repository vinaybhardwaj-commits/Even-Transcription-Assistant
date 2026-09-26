/**
 * Per-room recording schedule — the ONE definition the app's auto-start and fleet-watch's
 * "has not started" alert both read (V, 26 Sep 2026, confirmed 20:10 IST).
 *
 *   clinic rooms   every day 08:30–20:30 IST (the whole hospital runs 7 days a week)
 *   orbox3 / ORB3  06:00 → 02:00 the NEXT day, every day (the window crosses midnight)
 *
 * PURE. No clock read, no I/O: every function takes `nowMs`. IST has no DST, so a fixed UTC offset
 * is exact and needs no Intl / tz database.
 *
 * ─── A WINDOW BELONGS TO THE DAY IT STARTS ON ──────────────────────────────────────────────────
 * `days` names the weekday a window STARTS. A window whose `end` is at or before its `start`
 * crosses midnight and ends on the following calendar day. So orbox3's Monday window runs Mon 06:00
 * → Tue 02:00, and at Tue 01:30 the room is INSIDE Monday's window — it must not be read as
 * "Tuesday, before the 06:00 open, not started". `activeWindow` therefore looks at today's windows
 * AND yesterday's spill-over.
 *
 * ─── ABSENCE IS DERIVED AT READ TIME ───────────────────────────────────────────────────────────
 * `notStartedAlert` is computed from the schedule and a fresh clock on every read and never stored.
 */

export type ScheduleWindow = {
  /** Weekdays the window STARTS on, 0 = Sunday … 6 = Saturday. */
  days: readonly number[];
  /** "HH:MM", 24-hour, local to the schedule's offset. */
  start: string;
  /** "HH:MM". At or before `start` = ends the next calendar day. */
  end: string;
};

export type RoomSchedule = {
  /** Minutes east of UTC. IST = 330. */
  utcOffsetMinutes: number;
  windows: readonly ScheduleWindow[];
};

export const IST_OFFSET_MINUTES = 330;

/** Clinic default: every day, 08:30–20:30 IST. */
export const DEFAULT_CLINIC_SCHEDULE: RoomSchedule = {
  utcOffsetMinutes: IST_OFFSET_MINUTES,
  windows: [{ days: [0, 1, 2, 3, 4, 5, 6], start: "08:30", end: "20:30" }],
};

/** ORBOX (Linux OT recorder): 06:00 → 02:00 next day, every day. */
export const ORBOX_SCHEDULE: RoomSchedule = {
  utcOffsetMinutes: IST_OFFSET_MINUTES,
  windows: [{ days: [0, 1, 2, 3, 4, 5, 6], start: "06:00", end: "02:00" }],
};

/**
 * Room-level overrides, keyed by room slug. A room with no entry takes the clinic default.
 * (A DB column would let this move without a build; that needs a migration and is a follow-up.)
 */
export const ROOM_SCHEDULE_OVERRIDES: Readonly<Record<string, RoomSchedule>> = {
  "orb3-29ac": ORBOX_SCHEDULE,
};

export function scheduleForRoom(slug: string | null | undefined): RoomSchedule {
  return (slug && ROOM_SCHEDULE_OVERRIDES[slug]) || DEFAULT_CLINIC_SCHEDULE;
}

export type ActiveWindow = { startMs: number; endMs: number };

const DAY_MS = 86_400_000;

function minutesOf(hhmm: string): number | null {
  const m = /^(\d{2}):(\d{2})$/.exec(hhmm);
  if (!m) return null;
  const h = Number(m[1]);
  const mi = Number(m[2]);
  return h <= 23 && mi <= 59 ? h * 60 + mi : null;
}

/**
 * The window `nowMs` falls inside, or null. `startMs` inclusive, `endMs` exclusive, both real UTC
 * instants. A malformed window is skipped, never guessed at.
 */
export function activeWindow(schedule: RoomSchedule, nowMs: number): ActiveWindow | null {
  const offsetMs = schedule.utcOffsetMinutes * 60_000;
  // Local "day number" and its midnight, as UTC instants.
  const localNow = nowMs + offsetMs;
  const todayIndex = Math.floor(localNow / DAY_MS);
  // Yesterday first: a spill-over window that began yesterday and is still running.
  for (const dayIndex of [todayIndex - 1, todayIndex]) {
    const weekday = (((dayIndex + 4) % 7) + 7) % 7; // 1970-01-01 was a Thursday (4)
    const dayStartMs = dayIndex * DAY_MS - offsetMs;
    for (const w of schedule.windows) {
      if (!w.days.includes(weekday)) continue;
      const s = minutesOf(w.start);
      const e = minutesOf(w.end);
      if (s === null || e === null || s === e) continue;
      const startMs = dayStartMs + s * 60_000;
      const endMs = dayStartMs + e * 60_000 + (e <= s ? DAY_MS : 0);
      if (nowMs >= startMs && nowMs < endMs) return { startMs, endMs };
    }
  }
  return null;
}

/** How long after open a room may still be starting before fleet-watch says so. */
export const NOT_STARTED_GRACE_MS = 10 * 60_000;

/**
 * PURE — is the room INSIDE its window, past the grace, with nothing recorded since the window
 * opened? Returns the window when the answer is yes, else null.
 *
 * `lastSessionStartedMs` is when the room's most recent recording session began (any session, open
 * or since ended: a desk `end_day` after a start is a room that DID start). `sessionOpen` is
 * whether one is open right now. Either one clears the alert. Outside the window nothing alerts —
 * including 01:30 for a window that opened at 06:00 the day before.
 */
export function notStartedAlert(input: {
  schedule: RoomSchedule;
  nowMs: number;
  sessionOpen: boolean;
  lastSessionStartedMs: number | null;
  graceMs?: number;
}): ActiveWindow | null {
  const window = activeWindow(input.schedule, input.nowMs);
  if (!window) return null;
  if (input.nowMs < window.startMs + (input.graceMs ?? NOT_STARTED_GRACE_MS)) return null;
  if (input.sessionOpen) return null;
  if (input.lastSessionStartedMs !== null && input.lastSessionStartedMs >= window.startMs) return null;
  return window;
}

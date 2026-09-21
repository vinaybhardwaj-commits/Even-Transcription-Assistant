/**
 * lib/overnight-translate/hours.ts — when the overnight transcribe+translate driver may SUBMIT.
 *
 * Modelled on the night-drain's closed-hours gate (21:30 → 07:30 IST, from 14 days of clinic data:
 * the latest session end was ~21:10, the earliest first chunk 08:22), with the one difference V's ruling
 * of 21 Sep 2026 asks for: a HARD STOP ON SUBMITTING at 07:10.
 *
 * WHY 07:10 AND NOT 07:30. The night-drain can stop a window in flight; this driver cannot. A
 * `room_window` job is submitted to the app and then runs there, and the router has no cancel
 * endpoint (`GET /healthz`, `POST /route`, `POST /route/job`, `GET /route/job/{id}`), so a job that has
 * been submitted runs to completion. The longest router run measured was 613 s, and the job has more steps
 * than the router leg — so the last submit has to leave room for the slowest window plus a buffer
 * before the closed period ends. 07:10 is 20 minutes ahead of 07:30.
 *
 * `room_window` has NO clock gate of its own (the auto-drain runs it at any hour, by design, on windows
 * under 6 h old), so this module is the only thing between the backlog run and clinic hours.
 *
 * Everything is pure arithmetic on epoch milliseconds. IST is a fixed +05:30 with no daylight saving,
 * so a constant is exact and nothing reads the machine's timezone.
 */
export const IST_OFFSET_MS = 5.5 * 3_600_000;
const DAY_MS = 86_400_000;
const MIN_MS = 60_000;

/** Closed hours: 21:30 → 07:30 IST. The period the Mini has no clinic load. */
export const CLOSED_START_MIN = 21 * 60 + 30;
export const CLOSED_END_MIN = 7 * 60 + 30;
/** The last minute-of-day at which a NEW window may be submitted is just before this. */
export const STOP_SUBMIT_MIN = 7 * 60 + 10;

/** Milliseconds since IST midnight, in [0, DAY_MS). */
export function istMsOfDay(nowMs: number): number {
  return (((nowMs + IST_OFFSET_MS) % DAY_MS) + DAY_MS) % DAY_MS;
}

/** True while `nowMs` is inside closed hours (start inclusive, end exclusive, wrapping midnight). */
export function isClosed(nowMs: number): boolean {
  const t = istMsOfDay(nowMs);
  return t >= CLOSED_START_MIN * MIN_MS || t < CLOSED_END_MIN * MIN_MS;
}

/**
 * May a NEW window be submitted now? Only from 21:30 up to (not including) 07:10 IST. Between 07:10 and
 * 07:30 the clinic is still closed but no new work starts, so whatever is in flight can finish.
 */
export function maySubmit(nowMs: number): boolean {
  const t = istMsOfDay(nowMs);
  return t >= CLOSED_START_MIN * MIN_MS || t < STOP_SUBMIT_MIN * MIN_MS;
}

/** Milliseconds until the next moment `maySubmit` is true; 0 when it already is. */
export function msUntilMaySubmit(nowMs: number): number {
  if (maySubmit(nowMs)) return 0;
  return CLOSED_START_MIN * MIN_MS - istMsOfDay(nowMs);
}

/**
 * Has the closed period itself ended? A job still running past this moment is running into clinic
 * hours: the driver stops WAITING for it (it cannot cancel it) and says so.
 */
export function closedHoursOver(nowMs: number): boolean {
  return !isClosed(nowMs);
}

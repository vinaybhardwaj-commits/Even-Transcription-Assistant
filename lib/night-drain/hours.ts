/**
 * lib/night-drain/hours.ts — when the overnight Mini drain may run.
 *
 * THE BOUNDARY COMES FROM THE DATA, NOT A HABIT. Over the 14 days to 18 Sep 2026 the first clinic
 * chunk of a day was 08:22 IST at the earliest (usually 08:38–09:00) and the last was 19:46–20:04, with
 * sessions running to 21:10 on 11 Sep and 18 Sep. So closed hours are 21:30 → 07:30 IST: 20 minutes
 * after the latest observed session end, 52 minutes before the earliest observed first chunk.
 * Sunday 13 Sep had 535 chunks, so weekends are NOT closed: the gate is the clock, never the weekday.
 *
 * Everything here is pure arithmetic on epoch milliseconds. IST is a fixed +05:30 with no daylight
 * saving, so the offset is a constant and nothing reads the machine's timezone.
 */
export const IST_OFFSET_MS = 5.5 * 3_600_000;
const DAY_MS = 86_400_000;
const MIN_MS = 60_000;

export type ClosedHours = {
  /** Minutes after IST midnight at which closed hours begin (inclusive). */
  startMin: number;
  /** Minutes after IST midnight at which closed hours end (exclusive). */
  endMin: number;
};

export const CLOSED_HOURS: ClosedHours = { startMin: 21 * 60 + 30, endMin: 7 * 60 + 30 };

/**
 * No NEW window starts inside the last four minutes of closed hours. A window is ~70 s of service
 * plus fetch and join, so one started at 07:25:59 has finished by 07:30; the buffer is what lets
 * "stops at 07:30" be true without abandoning work.
 */
export const START_BUFFER_MS = 4 * MIN_MS;

/** A window still in flight this long after closed hours end is abandoned (nothing written). */
export const END_GRACE_MS = 2 * MIN_MS;

/** Milliseconds since IST midnight, in [0, DAY_MS). */
export function istMsOfDay(nowMs: number): number {
  return (((nowMs + IST_OFFSET_MS) % DAY_MS) + DAY_MS) % DAY_MS;
}

/** True while `nowMs` is inside closed hours. Start inclusive, end exclusive; wraps midnight. */
export function isClosed(nowMs: number, h: ClosedHours = CLOSED_HOURS): boolean {
  const t = istMsOfDay(nowMs);
  const s = h.startMin * MIN_MS;
  const e = h.endMin * MIN_MS;
  return s > e ? t >= s || t < e : t >= s && t < e;
}

/** Milliseconds from `nowMs` to the end of the current closed period; 0 when not closed. */
export function msUntilClose(nowMs: number, h: ClosedHours = CLOSED_HOURS): number {
  if (!isClosed(nowMs, h)) return 0;
  const t = istMsOfDay(nowMs);
  const e = h.endMin * MIN_MS;
  return t < e ? e - t : DAY_MS - t + e;
}

/** Milliseconds from `nowMs` to the next start of closed hours; 0 when already closed. */
export function msUntilOpenForWork(nowMs: number, h: ClosedHours = CLOSED_HOURS): number {
  if (isClosed(nowMs, h)) return 0;
  const t = istMsOfDay(nowMs);
  const s = h.startMin * MIN_MS;
  return t < s ? s - t : DAY_MS - t + s;
}

/** May a new window start now? Closed, and not inside the start buffer at the end. */
export function mayStartWindow(nowMs: number, h: ClosedHours = CLOSED_HOURS, bufferMs: number = START_BUFFER_MS): boolean {
  return isClosed(nowMs, h) && msUntilClose(nowMs, h) > bufferMs;
}

/** The instant (epoch ms) after which an in-flight window is abandoned. Only meaningful while closed. */
export function abandonAtMs(nowMs: number, h: ClosedHours = CLOSED_HOURS, graceMs: number = END_GRACE_MS): number {
  return nowMs + msUntilClose(nowMs, h) + graceMs;
}

/** IST calendar date (YYYY-MM-DD) of the closed period `nowMs` belongs to: the date it STARTED on. */
export function nightOf(nowMs: number, h: ClosedHours = CLOSED_HOURS): string {
  const t = istMsOfDay(nowMs);
  const startedYesterday = h.startMin > h.endMin && t < h.endMin * MIN_MS;
  const d = new Date(nowMs + IST_OFFSET_MS - (startedYesterday ? DAY_MS : 0));
  return d.toISOString().slice(0, 10);
}

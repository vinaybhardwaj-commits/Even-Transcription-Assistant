/**
 * lib/alerts/clinic-hours.ts — the ONE place the clinic-hours window for room alerts is defined (gating/opd4-guard, S3).
 * 07:30-21:30 IST, Monday to Saturday. PURE: an instant goes in, a boolean (or a window start) comes out.
 * The steward's own window (lib/steward/config.ts, `schedule.clinic`) is configurable and has no weekday; the alerts do not read it, so a
 * config edit cannot silently move when a person is paged.
 */
export const CLINIC_START_MIN = 7 * 60 + 30;
export const CLINIC_END_MIN = 21 * 60 + 30;
/** getUTCDay() of the IST date: 0 = Sunday. Monday to Saturday. */
export const CLINIC_DAYS: readonly number[] = [1, 2, 3, 4, 5, 6];
const IST_OFFSET_MS = 19_800_000;
const DAY_MS = 86_400_000;

/** The start (epoch ms) of the clinic window that contains `ms`, or null when `ms` is outside clinic hours. */
export function clinicWindowStartMs(ms: number): number | null {
  const ist = ms + IST_OFFSET_MS;
  const day = new Date(ist).getUTCDay();
  if (!CLINIC_DAYS.includes(day)) return null;
  const midnightIst = Math.floor(ist / DAY_MS) * DAY_MS;
  const minutes = Math.floor((ist - midnightIst) / 60_000);
  if (minutes < CLINIC_START_MIN || minutes >= CLINIC_END_MIN) return null;
  return midnightIst - IST_OFFSET_MS + CLINIC_START_MIN * 60_000;
}

export const isClinicHours = (ms: number): boolean => clinicWindowStartMs(ms) !== null;

/** A roster room with no audio reaching the server for this long inside clinic hours is `recorder_off` (S3b, S4). */
export const RECORDER_OFF_MINUTES = 15;

/**
 * PURE — minutes the room has had no audio, or null when it is not counted. The clock starts at the LATER of the room's newest chunk and today's window start, so
 * 07:30 itself never alarms for a room that was quiet overnight. `lastChunkMs` null = no chunk in the lookback at all. Outside clinic hours: null.
 */
export function recorderOffMinutes(nowMs: number, lastChunkMs: number | null): number | null {
  const start = clinicWindowStartMs(nowMs);
  if (start === null) return null;
  const since = lastChunkMs === null ? start : Math.max(start, lastChunkMs);
  const mins = Math.floor((nowMs - since) / 60_000);
  return mins >= RECORDER_OFF_MINUTES ? mins : null;
}

/** FR1-A: with a consult window open, a room whose audio (or, if later, whose window start) is this old is `recorder_off` with consult_open, at any hour. */
export const CONSULT_RECORDER_OFF_MINUTES = 5;

/**
 * lib/spine/window.ts — the hourly K-lane window (S6 R3). Pure: `now` is passed in.
 * palimpsest-hourly starts at :40 IST and skips its whole run when the lock is taken, so the box executor refuses K lanes from :25 to :45, and also when under MIN_LANE_BUDGET_S is left
 * before the next :25 (i.e. from :20 on). The claim route does not hand out K-lane jobs in that time at all; the executor's `release` is the backstop (the box may be configured otherwise).
 */
export const K_LANE_STAGES: readonly string[] = ["acoustics", "nemotron"];
const IST_OFFSET_MS = 5.5 * 3600e3;
const HOURLY_FROM_MIN = 25;
const HOURLY_TO_MIN = 45;
export const MIN_LANE_BUDGET_S = 300;

/** Seconds into the IST hour. */
export function istSecondOfHour(now: Date): number {
  return (((now.getTime() + IST_OFFSET_MS) % 3600e3) + 3600e3) % 3600e3 / 1000;
}

/** Same parse as executors.py _env_min: an integer 0..60, else the default. */
function envMin(raw: string | undefined, dflt: number): number {
  if (raw === undefined || !/^\s*[+-]?\d+\s*$/.test(raw)) return dflt;
  const v = Number(raw);
  return v >= 0 && v <= 60 ? v : dflt;
}

/** The refusal window (minutes) from the box's own env (SPINE_HOURLY_FROM_MIN / _TO_MIN); an inverted or empty pair falls back to :25-:45, as the box does. */
export function hourlyWindowMin(env: Record<string, string | undefined> = process.env): [number, number] {
  const f = envMin(env.SPINE_HOURLY_FROM_MIN, HOURLY_FROM_MIN);
  const t = envMin(env.SPINE_HOURLY_TO_MIN, HOURLY_TO_MIN);
  return f >= t ? [HOURLY_FROM_MIN, HOURLY_TO_MIN] : [f, t];
}

/** True when a K lane cannot start now: inside the window, or with under MIN_LANE_BUDGET_S before its start (default :20-:25). */
export function kLaneBlockedNow(now: Date, env: Record<string, string | undefined> = process.env): boolean {
  const s = istSecondOfHour(now);
  const [f, t] = hourlyWindowMin(env);
  return s >= f * 60 - MIN_LANE_BUDGET_S && s < t * 60;
}

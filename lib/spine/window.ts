/**
 * lib/spine/window.ts — the hourly K-lane window (S6 R3). Pure: `now` is passed in.
 * palimpsest-hourly starts at :40 IST and skips its whole run when the lock is taken, so the box executor refuses K lanes from :25 to :45, and also when under MIN_LANE_BUDGET_S is left
 * before the next :25 (i.e. from :20 on). The claim route does not hand out K-lane jobs in that time at all; the executor's `release` is the backstop (the box may be configured otherwise).
 */
export const K_LANE_STAGES: readonly string[] = ["acoustics", "nemotron"];
const IST_OFFSET_MS = 5.5 * 3600e3;
const HOURLY_FROM_S = 25 * 60;
const HOURLY_TO_S = 45 * 60;
export const MIN_LANE_BUDGET_S = 300;

/** Seconds into the IST hour. */
export function istSecondOfHour(now: Date): number {
  return (((now.getTime() + IST_OFFSET_MS) % 3600e3) + 3600e3) % 3600e3 / 1000;
}

/** True when a K lane cannot start now: inside :25-:45, or with under MIN_LANE_BUDGET_S before the next :25 (:20-:25). */
export function kLaneBlockedNow(now: Date): boolean {
  const s = istSecondOfHour(now);
  return s >= HOURLY_FROM_S - MIN_LANE_BUDGET_S && s < HOURLY_TO_S;
}

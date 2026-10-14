/**
 * 6-month linear decay (PRD §6.2 step 3).
 *
 *   decay_weight = max(0, 1 − days_old / 180)
 *
 * - days_old = 0   → weight 1.0
 * - days_old = 90  → weight 0.5
 * - days_old = 180 → weight 0.0
 * - days_old > 180 → weight 0.0 (clamped, observation excluded from window)
 */

export const WINDOW_DAYS = 180;

export function decayWeight(daysOld: number): number {
  if (daysOld <= 0) return 1;
  if (daysOld >= WINDOW_DAYS) return 0;
  return 1 - daysOld / WINDOW_DAYS;
}

/**
 * Compute days between two dates (positive number of days). Both inputs
 * accept Date or ISO string; time-of-day is ignored (treated as UTC midnight).
 */
export function daysBetween(from: string | Date, to: string | Date): number {
  const ms =
    (toDate(to).getTime() - toDate(from).getTime()) / (1000 * 60 * 60 * 24);
  return ms;
}

function toDate(v: string | Date): Date {
  if (v instanceof Date) return v;
  // Force UTC midnight so daylight-saving doesn't shift day counts.
  if (/^\d{4}-\d{2}-\d{2}$/.test(v)) {
    return new Date(`${v}T00:00:00Z`);
  }
  return new Date(v);
}

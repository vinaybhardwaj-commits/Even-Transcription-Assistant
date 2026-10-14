const DAY = /^\d{4}-\d{2}-\d{2}$/;

function addDays(day: string, delta: number): string {
  const d = new Date(`${day}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + delta);
  return d.toISOString().slice(0, 10);
}

/** Oldest-first IST calendar days in a bounded sweep whose upper bound is `to`. */
export function opdSweepDays(to: string, lookback: number, floor: string): string[] {
  if (!DAY.test(to) || !DAY.test(floor)) throw new Error('bad day (YYYY-MM-DD)');
  const width = Math.max(1, Math.min(14, Math.floor(lookback)));
  const days: string[] = [];
  for (let i = width - 1; i >= 0; i--) {
    const day = addDays(to, -i);
    if (day >= floor) days.push(day);
  }
  return days;
}

/**
 * Completion comes from the upstream candidate page, never from comparing cached counts.
 * A full page can have another page behind it; failed candidates must also reopen the day.
 */
export function opdCandidateProbeDone(candidates: number, pageSize: number, completed: number, remaining: number): boolean {
  return remaining === 0 && (candidates === 0 || (candidates < pageSize && completed === candidates));
}

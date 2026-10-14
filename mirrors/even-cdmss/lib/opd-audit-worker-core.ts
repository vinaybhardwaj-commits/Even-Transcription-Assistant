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

/**
 * One sweep invocation enters at most this many days, and never more than the
 * lookback it was given. A day that inserts still ends the tick immediately;
 * the cap only bounds how far a run of stalls may walk.
 */
export const OPD_SWEEP_MAX_DAYS = 14;

export function opdSweepDayCap(lookback: number): number {
  if (!Number.isFinite(lookback)) return 1;
  return Math.max(1, Math.min(OPD_SWEEP_MAX_DAYS, Math.floor(lookback)));
}

export type OpdSweepDayResult = {
  day: string;
  total: number;
  audited: number;
  processed: number;
  inserted: number;
  remaining: number;
  done: boolean;
  /** Rows the upstream fetch returned before the already-audited drop. */
  fetched?: number;
};

/** A finished day is skipped. A day that inserted new audits stops the tick.
 *  Anything else — an empty fetch, or a page whose saves all came back
 *  `exists` — is a stall, and the sweep moves on. */
export function opdSweepStep(day: { processed: number; inserted: number; done: boolean }): 'skip' | 'stall' | 'yield' {
  if (day.done) return 'skip';
  if (day.processed > 0 && day.inserted > 0) return 'yield';
  return 'stall';
}

export function opdSweepStallDetail(day: OpdSweepDayResult): string {
  if (day.processed > 0 && day.inserted === 0) {
    return `sweep stalled on ${day.day}: processed ${day.processed}, inserted 0 — already audited, so the sweep moved on`;
  }
  if ((day.fetched ?? 0) > 0) {
    return `sweep stalled on ${day.day}: ${day.fetched} candidate note(s) already audited under another date, none sent to the model`;
  }
  return `sweep made no progress on ${day.day}: count says ${day.total}, ${day.audited} audited, the fetch returned no rows`;
}

/** Split a fetched page into notes the worker may audit and notes that already
 *  hold an audit row. `heldUids` is date-agnostic: a note re-dated in the source
 *  is still held. */
export function opdCandidatesToAudit<T extends { uid?: unknown }>(
  rows: readonly T[],
  heldUids: readonly string[],
): { audit: T[]; alreadyAudited: T[] } {
  const held = new Set(heldUids.filter((uid) => typeof uid === 'string' && uid.length > 0));
  const audit: T[] = [];
  const alreadyAudited: T[] = [];
  for (const row of rows) {
    const uid = String(row.uid ?? '').trim();
    if (uid && held.has(uid)) alreadyAudited.push(row);
    else audit.push(row);
  }
  return { audit, alreadyAudited };
}

const SOURCE_INSTANT = /^\d{4}-\d{2}-\d{2}(?:[T ]\d.*)?$/;

/** Instant to write when the source day and the stored note day disagree.
 *  The fetch is already scoped to `sweepDay`, so that day is the fallback. */
export function opdSourceNoteInstant(timestamp: unknown, sweepDay: string): string | null {
  if (timestamp instanceof Date && !Number.isNaN(timestamp.getTime())) return timestamp.toISOString();
  if (typeof timestamp === 'number' && Number.isFinite(timestamp)) {
    const asDate = new Date(timestamp);
    if (!Number.isNaN(asDate.getTime())) return asDate.toISOString();
  }
  if (typeof timestamp === 'string' && SOURCE_INSTANT.test(timestamp.trim())) return timestamp.trim();
  return DAY.test(sweepDay) ? `${sweepDay}T00:00:00+05:30` : null;
}

/**
 * Oldest-first. `done` days are walked but do not end the run. A stall is
 * recorded and the next day starts in the same run. The first day that inserts
 * is returned. `exhausted` is false when the cap stops the walk early.
 */
export async function runOpdSweep<T extends OpdSweepDayResult>(
  days: readonly string[],
  cap: number,
  processDay: (day: string) => Promise<T>,
  onStall: (day: T) => Promise<void> | void,
): Promise<{ stalled: T[]; yielded: T | null; visited: number; exhausted: boolean }> {
  const stalled: T[] = [];
  let visited = 0;
  const limit = Math.max(0, Math.floor(cap));
  for (const day of days) {
    if (visited >= limit) return { stalled, yielded: null, visited, exhausted: false };
    visited += 1;
    const result = await processDay(day);
    const step = opdSweepStep(result);
    if (step === 'skip') continue;
    if (step === 'stall') {
      stalled.push(result);
      await onStall(result);
      continue;
    }
    return { stalled, yielded: result, visited, exhausted: false };
  }
  return { stalled, yielded: null, visited, exhausted: true };
}

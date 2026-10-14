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

/** Pages of already-audited uids one tick will walk past before it audits. A full day is ~500 notes. */
export const OPD_SWEEP_HELD_PAGE_CAP = 64;

export type OpdSweepCandidate = Record<string, unknown>;

export interface OpdSweepPorts<R extends { status?: string; error?: string }> {
  countForDay(day: string): Promise<number>;
  /** Day-scoped exclude list. A uid stored under a different note_date is not in this set. */
  auditedOnDay(day: string): Promise<string[]>;
  /** Current-engine hold, any note_date. Fail closed: an error must reject, not return []. */
  heldAtCurrentEngine(uids: string[]): Promise<readonly string[]>;
  /** Best-effort date correction. The sweep still skips the model if this throws. */
  alignNoteDate(uid: string, noteTimestamp: string): Promise<void>;
  fetchPage(day: string, excludeUids: string[], limit: number): Promise<OpdSweepCandidate[]>;
  auditBatch(rows: OpdSweepCandidate[]): Promise<R[]>;
}

export interface OpdSweepDayResult<R> {
  day: string;
  total: number;
  audited: number;
  processed: number;
  saved: number;
  skippedExisting: number;
  remaining: number;
  done: boolean;
  results: R[];
}

export interface OpdSweepStall {
  day: string;
  total: number;
  audited: number;
  remaining: number;
  processed: number;
  skippedExisting: number;
}

/** Inserted or updated a row. 'exists' and 'skipped' wrote nothing; an error saved nothing. */
export function opdSweepSavedCount(results: readonly { status?: string; error?: string }[]): number {
  let n = 0;
  for (const r of results) {
    if (r.error) continue;
    if (r.status === 'inserted' || r.status === 'updated') n += 1;
  }
  return n;
}

/**
 * Timestamp to store when the source day moved. The source value is kept when its
 * IST calendar day is the day being swept; otherwise noon IST on that day, so a
 * bad clock cannot park the row on yet another day.
 */
export function opdSourceNoteTimestamp(row: { timestamp?: unknown }, day: string): string {
  const fallback = `${day}T12:00:00+05:30`;
  const ts = row.timestamp;
  let raw = '';
  if (typeof ts === 'string') raw = ts.trim();
  else if (typeof ts === 'number' && Number.isFinite(ts)) raw = new Date(ts).toISOString();
  else if (ts instanceof Date && !Number.isNaN(ts.getTime())) raw = ts.toISOString();
  if (!raw) return fallback;
  const parsed = Date.parse(raw);
  if (Number.isNaN(parsed)) return fallback;
  const ist = new Date(parsed + 330 * 60 * 1000).toISOString().slice(0, 10);
  return ist === day ? raw : fallback;
}

/**
 * One day of the sweep. Uids that already hold a current-engine audit — whatever
 * note_date they were stored under — are not sent to the model and do not occupy
 * the page. Only inserted/updated rows count as saved.
 */
export async function processOpdSweepDay<R extends { status?: string; error?: string }>(
  day: string,
  max: number,
  ports: OpdSweepPorts<R>,
): Promise<OpdSweepDayResult<R>> {
  const total = await ports.countForDay(day);
  const exclude = new Set((await ports.auditedOnDay(day)).filter(Boolean));
  const alreadyCount = exclude.size;
  const held: string[] = [];
  const fresh: OpdSweepCandidate[] = [];
  let pages = 0;
  let drained = false;
  while (fresh.length < max && pages < OPD_SWEEP_HELD_PAGE_CAP) {
    const page = await ports.fetchPage(day, [...exclude], max);
    pages += 1;
    if (page.length === 0) { drained = true; break; }
    const heldSet = new Set(await ports.heldAtCurrentEngine(
      page.map((row) => String(row.uid ?? '').trim()).filter(Boolean),
    ));
    let pageHeld = 0;
    for (const row of page) {
      const uid = String(row.uid ?? '').trim();
      if (uid && heldSet.has(uid)) {
        pageHeld += 1;
        if (!exclude.has(uid)) {
          exclude.add(uid);
          held.push(uid);
          try { await ports.alignNoteDate(uid, opdSourceNoteTimestamp(row, day)); }
          catch { /* excluded for this tick either way; the next tick retries the date */ }
        }
        continue;
      }
      fresh.push(row);
      if (fresh.length >= max) break;
    }
    // A short page has nothing behind it. A full page of held uids does: they were
    // sitting in front of later notes, and the next fetch skips them.
    if (page.length < max) { drained = true; break; }
    if (pageHeld === 0) break;
  }
  const results = fresh.length ? await ports.auditBatch(fresh.slice(0, max)) : [];
  const saved = opdSweepSavedCount(results);
  const audited = alreadyCount + held.length + saved;
  const observedTotal = Math.max(total, alreadyCount + held.length + fresh.length);
  const remaining = Math.max(0, observedTotal - audited);
  // No fresh work and the walk did not drain (page cap): do not call the day finished.
  const candidates = fresh.length > 0 ? Math.min(fresh.length, max) : (drained ? 0 : max);
  const done = opdCandidateProbeDone(candidates, max, saved, remaining);
  return {
    day,
    total: observedTotal,
    audited,
    processed: results.length,
    saved,
    skippedExisting: held.length,
    remaining,
    done,
    results,
  };
}

/**
 * Oldest day first. A day that saves nothing — including one that only rediscovered
 * an audit stored under a different note_date — does not end the tick.
 */
export async function runOpdSweep<R extends { status?: string; error?: string }>(
  days: readonly string[],
  max: number,
  ports: OpdSweepPorts<R> & { onStall(mark: OpdSweepStall): Promise<void> },
): Promise<{ stopped: OpdSweepDayResult<R> | null; stalled: OpdSweepStall[] }> {
  const stalled: OpdSweepStall[] = [];
  for (const day of days) {
    const r = await processOpdSweepDay(day, max, ports);
    if (r.done) continue;
    if (r.saved === 0) {
      const mark: OpdSweepStall = {
        day,
        total: r.total,
        audited: r.audited,
        remaining: r.remaining,
        processed: r.processed,
        skippedExisting: r.skippedExisting,
      };
      await ports.onStall(mark);
      stalled.push(mark);
      continue;
    }
    return { stopped: r, stalled };
  }
  return { stopped: null, stalled };
}

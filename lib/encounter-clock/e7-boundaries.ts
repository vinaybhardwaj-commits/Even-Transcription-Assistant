/**
 * lib/encounter-clock/e7-boundaries.ts — score shadow consults against Pulse windows and consult-index cuts.
 *
 * PURE. Match is the E-7 rule: overlap at least half the shorter interval. Errors are whole seconds.
 * A truth matched by two hypotheses is a two-consult split. Missed and extra are unmatched intervals.
 * Nothing here reads or writes.
 */
import { matches, overlapMs, percentile, type Iv } from "@/lib/encounter-clock/e7-score";

export type Boundary = Iv & { end_clicked?: boolean };

export type ErrSec = { n: number; median_s: number | null; p90_s: number | null };

export type BoundaryScore = {
  truth: number;
  hypotheses: number;
  missed: number;
  extra: number;
  two_consult_splits: number;
  start_error_s: ErrSec;
  end_error_s: ErrSec;
};

const sec = (ms: number): number => Math.round(ms / 1000);
const err = (xs: number[]): ErrSec => ({ n: xs.length, median_s: percentile(xs, 0.5) == null ? null : sec(percentile(xs, 0.5)!), p90_s: percentile(xs, 0.9) == null ? null : sec(percentile(xs, 0.9)!) });

export function boundaryScore(truth: readonly Boundary[], hyp: readonly Boundary[]): BoundaryScore {
  const same = (a: Iv, b: Iv) => (a.room_id ?? "_") === (b.room_id ?? "_");
  const tMatches = truth.map((t) => hyp.map((h, j) => (same(t, h) && matches(t, h) ? j : -1)).filter((j) => j >= 0));
  const hMatched = hyp.map((h) => truth.some((t) => same(t, h) && matches(t, h)));
  const startErr: number[] = [], endErr: number[] = [];
  truth.forEach((t, i) => {
    const js = tMatches[i]!;
    if (!js.length) return;
    const best = js.map((j) => hyp[j]!).sort((a, b) => overlapMs(t, b) - overlapMs(t, a) || a.start_ms - b.start_ms)[0]!;
    startErr.push(Math.abs(best.start_ms - t.start_ms));
    endErr.push(Math.abs(best.end_ms - t.end_ms));
  });
  return {
    truth: truth.length,
    hypotheses: hyp.length,
    missed: tMatches.filter((m) => m.length === 0).length,
    extra: hMatched.filter((ok) => !ok).length,
    two_consult_splits: tMatches.filter((m) => m.length > 1).length,
    start_error_s: err(startErr),
    end_error_s: err(endErr),
  };
}

export type CloseCoverage = {
  consults: number;
  by_close_kind: Record<string, number>;
  end_clicked: number;
  not_clicked: number;
};

/** PURE — counts of Pulse close kinds. end_clicked is only a real endConsult. */
export function closeCoverage(rows: readonly { close_kind: string; end_clicked: boolean }[]): CloseCoverage {
  const by: Record<string, number> = {};
  let clicked = 0;
  for (const r of rows) {
    by[r.close_kind] = (by[r.close_kind] ?? 0) + 1;
    if (r.end_clicked) clicked++;
  }
  return { consults: rows.length, by_close_kind: by, end_clicked: clicked, not_clicked: rows.length - clicked };
}

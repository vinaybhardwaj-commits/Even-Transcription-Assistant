/**
 * lib/encounter-clock/e7-score.ts — the E-7 scoring CORE (epic #23, ticket h). PURE: intervals in, numbers out.
 *
 * WHAT IS HERE: the match rule (≥ 50 % overlap of the SHORTER interval), recall, precision, splits, merges, start and
 * end error (median, p90; the end error also broken out for consults with a MISSING End click), per-room results,
 * the shifted-anchor control, and the read-only Pulse close-reason coverage report.
 *
 * WHAT IS NOT: reading anything. No SELECT on Neon, no Metabase db 13, no PQM exclusions, no CLI, no markdown/CSV
 * writer, and the 24 Sep table (A0/A1 2/23, arm d 18/23) has NOT been reproduced — that needs the stored inputs. A
 * caller passes plain intervals; this module can write nothing because it holds no handle to anything.
 *
 * Output carries counts and millisecond errors only — no ids beyond the room key the caller supplies, no text.
 */
export type Iv = { start_ms: number; end_ms: number; room_id?: string };
export type TruthIv = Iv & { /** false = the consult's End was never clicked (Pulse). Absent = unknown. */ end_clicked?: boolean };

export const MATCH_OVERLAP = 0.5;

const sameRoom = (a: Iv, b: Iv): boolean => (a.room_id ?? "_") === (b.room_id ?? "_");

const len = (a: Iv): number => Math.max(0, a.end_ms - a.start_ms);
export const overlapMs = (a: Iv, b: Iv): number => Math.max(0, Math.min(a.end_ms, b.end_ms) - Math.max(a.start_ms, b.start_ms));

/** PURE — true when the overlap is at least MATCH_OVERLAP of the shorter interval (an empty interval never matches). */
export function matches(a: Iv, b: Iv): boolean {
  const shorter = Math.min(len(a), len(b));
  return shorter > 0 && overlapMs(a, b) >= MATCH_OVERLAP * shorter;
}

/** PURE — nearest-rank percentile of a list, null when empty. */
export function percentile(xs: ReadonlyArray<number>, p: number): number | null {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.max(0, Math.ceil(p * s.length) - 1))]!;
}

export type ErrStats = { n: number; median_ms: number | null; p90_ms: number | null };
const errStats = (xs: number[]): ErrStats => ({ n: xs.length, median_ms: percentile(xs, 0.5), p90_ms: percentile(xs, 0.9) });

export type ArmScore = {
  truth: number;
  hypotheses: number;
  recall: number | null;
  precision: number | null;
  recalled: number;
  precise: number;
  splits: number;
  merges: number;
  start_error: ErrStats;
  end_error: ErrStats;
  /** End error over truths whose End click is known to be missing (end_clicked === false). */
  end_error_missing_end: ErrStats;
};

export function scoreArm(truth: ReadonlyArray<TruthIv>, hyp: ReadonlyArray<Iv>): ArmScore {
  const tMatches = truth.map((t) => hyp.map((h, j) => (sameRoom(t, h) && matches(t, h) ? j : -1)).filter((j) => j >= 0));
  const hMatches = hyp.map((h) => truth.filter((t) => sameRoom(t, h) && matches(t, h)).length);
  const startErr: number[] = [], endErr: number[] = [], endErrMissing: number[] = [];
  truth.forEach((t, i) => {
    const js = tMatches[i]!;
    if (!js.length) return;
    // the best match is the hypothesis overlapping most; ties go to the earlier start
    const best = js.map((j) => hyp[j]!).sort((a, b) => overlapMs(t, b) - overlapMs(t, a) || a.start_ms - b.start_ms)[0]!;
    startErr.push(Math.abs(best.start_ms - t.start_ms));
    const e = Math.abs(best.end_ms - t.end_ms);
    endErr.push(e);
    if (t.end_clicked === false) endErrMissing.push(e);
  });
  const recalled = tMatches.filter((m) => m.length > 0).length;
  const precise = hMatches.filter((n) => n > 0).length;
  return {
    truth: truth.length, hypotheses: hyp.length,
    recall: truth.length ? recalled / truth.length : null,
    precision: hyp.length ? precise / hyp.length : null,
    recalled, precise,
    splits: tMatches.filter((m) => m.length > 1).length,
    merges: hMatches.filter((n) => n > 1).length,
    start_error: errStats(startErr), end_error: errStats(endErr), end_error_missing_end: errStats(endErrMissing),
  };
}

/** PURE — scoreArm over each room separately, plus the pooled score. A room with truth but no hypotheses scores recall 0. */
export function scoreByRoom(truth: ReadonlyArray<TruthIv>, hyp: ReadonlyArray<Iv>): { pooled: ArmScore; rooms: Record<string, ArmScore> } {
  const keys = [...new Set([...truth, ...hyp].map((x) => x.room_id ?? "_"))].sort();
  const rooms: Record<string, ArmScore> = {};
  for (const k of keys) rooms[k] = scoreArm(truth.filter((t) => (t.room_id ?? "_") === k), hyp.filter((h) => (h.room_id ?? "_") === k));
  return { pooled: scoreArm(truth, hyp), rooms };
}

/**
 * PURE — the shifted-anchor control: the arm re-run with every anchor-derived start moved by ±shift. A real anchor
 * effect collapses when the anchors are shifted by 10 min; an arm that scores the same shifted is not using them.
 * `arm(shift_ms)` is the caller's own arm function.
 */
export function shiftedAnchorControl(
  truth: ReadonlyArray<TruthIv>, arm: (shift_ms: number) => ReadonlyArray<Iv>, shift_ms = 10 * 60_000,
): { base: ArmScore; plus: ArmScore; minus: ArmScore } {
  return { base: scoreArm(truth, arm(0)), plus: scoreArm(truth, arm(shift_ms)), minus: scoreArm(truth, arm(-shift_ms)) };
}

// ── coverage (read-only) ──────────────────────────────────────────────────────────────────────────────

export type CoverageAnchor = Iv & { close_kind: string; end_clicked: boolean };
export type Coverage = {
  consults: number;
  by_close_kind: Record<string, number>;
  by_end_clicked: { clicked: number; not_clicked: number };
  pqm_consults: number;
  /** PQM consults that match no Pulse window at all: the doctor never clicked Start. */
  pqm_without_start: number;
  pqm_with_pulse_window_share: number | null;
};

export function coverageReport(anchors: ReadonlyArray<CoverageAnchor>, truth: ReadonlyArray<Iv>): Coverage {
  const by: Record<string, number> = {};
  let clicked = 0;
  for (const a of anchors) { by[a.close_kind] = (by[a.close_kind] ?? 0) + 1; if (a.end_clicked) clicked++; }
  const without = truth.filter((t) => !anchors.some((a) => sameRoom(a, t) && matches(t, a))).length;
  return {
    consults: anchors.length, by_close_kind: by, by_end_clicked: { clicked, not_clicked: anchors.length - clicked },
    pqm_consults: truth.length, pqm_without_start: without,
    pqm_with_pulse_window_share: truth.length ? (truth.length - without) / truth.length : null,
  };
}

/**
 * lib/jev/bench.ts — Slice J4 (ETA-JEV-ARM-D §7): the bench's arithmetic. PURE — no IO, no clock,
 * no env, no model call. Everything a metric needs arrives as an argument, so the same numbers
 * come out of a fixture and out of the database.
 *
 * WHAT THIS FILE REFUSES TO DO. Report a bare point estimate: every rate carries its numerator,
 * its denominator and a 95% Wilson interval, every distribution a seeded bootstrap interval
 * (spec §7 — on ~37 truth opens a recall carries roughly ±0.13). Invent a role label: with no
 * label file, role accuracy is the string "UNVERIFIED", not a number. Read a firing rule or a close
 * from anywhere but the arm's own `DraftVisit`. `visit.ambiguity` is `ambiguityOf(reasons)` —
 * deduplicated, known tokens sorted into the closed-set order (unknown ones kept), comma-joined, NULL
 * when empty: a re-encoding of the list, not the list. Worse, `writeVisits` nulls `end_reason` and `ended_at` for any visit whose state
 * is not `ended`, and Arm D emits `in_chair`: a database read of Arm D would show NO closes at all.
 *
 * THE TRUTH IS NOT INDEPENDENT OF ARM A. `consult_mark` is the cue arm A OPENS ITS VISITS FROM
 * (rules.ts, the mark pass). Scored against consult_mark truth its open recall is high by
 * construction. `scoreArm` cannot know that; `TRUTH_IN_INPUT` names the arms it is true of and the
 * report says so beside the number.
 */
import type { DraftVisit, FuseCue } from "@/lib/brain/fuse/types";

export const BENCH_ARMS = ["rules", "hybrid", "flash", "jev", "jev-native"] as const;
export type BenchArm = (typeof BENCH_ARMS)[number];

/** Arms whose own INPUT contains the cue types the truth is built from (circular against them). */
export const TRUTH_IN_INPUT: readonly BenchArm[] = ["rules", "hybrid", "flash"];

export const ROLES = ["clinician", "patient", "attendant", "nurse_or_staff", "other"] as const;

// ---------------------------------------------------------------- parameters

export type Thresholds = {
  open_recall: number;
  open_precision: number;
  median_open_error_s: number;
  ece_p_start: number;
  role_accuracy: number;
  cost_usd_per_room_day: number;
};

/** Spec §7's targets. PROPOSED, not settled — callers pass their own; nothing else reads these. */
export const DEFAULT_THRESHOLDS: Thresholds = {
  open_recall: 0.8,
  open_precision: 0.8,
  median_open_error_s: 90,
  ece_p_start: 0.1,
  role_accuracy: 0.85,
  cost_usd_per_room_day: 0.05,
};

export type BenchParams = {
  /** a predicted open/close within this many seconds of a truth instant is a hit (spec: 180) */
  tolerance_s: number;
  /** calibration positives: windows within this many seconds of a truth open/close (spec: 60) */
  calib_radius_s: number;
  /** truth candidates closer than this are one visit (a kiosk mark and its warehouse pstart) */
  dedupe_s: number;
  truth_open_source: "merged" | "mark" | "pstart";
  /** spec §7: no wire-it-in / drop-it verdict below this many truth opens */
  min_truth_opens: number;
  bootstrap: number;
  seed: number;
  /** $42 per billion input tokens (spec §1); output is free */
  usd_per_billion_tokens: number;
  /** the composite's text-confidence floor, for the null-share line only */
  role_t: number;
  thresholds: Thresholds;
};

export const DEFAULT_PARAMS: BenchParams = {
  tolerance_s: 180,
  calib_radius_s: 60,
  dedupe_s: 120,
  truth_open_source: "merged",
  min_truth_opens: 100,
  bootstrap: 1000,
  seed: 20260919,
  usd_per_billion_tokens: 42,
  role_t: 0.6,
  thresholds: DEFAULT_THRESHOLDS,
};

/** "open_recall=0.8,ece_p_start=0.12" over the defaults. An unknown key is an error, never ignored. */
export function parseThresholds(spec: string | undefined): Thresholds {
  const out: Thresholds = { ...DEFAULT_THRESHOLDS };
  if (!spec || !spec.trim()) return out;
  for (const part of spec.split(",")) {
    const eq = part.indexOf("=");
    if (eq < 0) throw new Error(`bad_threshold_spec:${part.trim()}`);
    const k = part.slice(0, eq).trim();
    const v = part.slice(eq + 1).trim();
    if (!k || !Object.hasOwn(out, k)) throw new Error(`unknown_threshold:${k}`);
    const n = Number(v);
    if (!Number.isFinite(n)) throw new Error(`bad_threshold_value:${k}`);
    (out as Record<string, number>)[k] = n;
  }
  return out;
}

// ---------------------------------------------------------------- statistics

export type Rate = { value: number | null; k: number; n: number; ci: [number, number] | null };

/** 95% Wilson score interval. n = 0 has no interval, not a 0–1 one. */
export function wilson(k: number, n: number, z = 1.96): [number, number] | null {
  if (n <= 0) return null;
  const p = k / n;
  const z2 = z * z;
  const denom = 1 + z2 / n;
  const centre = (p + z2 / (2 * n)) / denom;
  const half = (z * Math.sqrt((p * (1 - p)) / n + z2 / (4 * n * n))) / denom;
  return [Math.max(0, centre - half), Math.min(1, centre + half)];
}

export const rate = (k: number, n: number): Rate => ({ value: n > 0 ? k / n : null, k, n, ci: wilson(k, n) });

/** type-7 (linear interpolation) quantile of an ASCENDING array. */
export function quantile(sorted: readonly number[], q: number): number | null {
  if (sorted.length === 0) return null;
  const pos = (sorted.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
}

/** mulberry32 — a small seeded generator so a bootstrap interval is the same on every run. */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Percentile bootstrap of `stat` over `values`. null when there is nothing to resample. */
export function bootstrapCI(values: readonly number[], stat: (v: number[]) => number | null, B: number, seed: number): [number, number] | null {
  if (values.length === 0 || B <= 0) return null;
  const rnd = mulberry32(seed);
  const reps: number[] = [];
  for (let b = 0; b < B; b++) {
    const s: number[] = new Array(values.length);
    for (let i = 0; i < values.length; i++) s[i] = values[Math.floor(rnd() * values.length)];
    const v = stat(s);
    if (v !== null && Number.isFinite(v)) reps.push(v);
  }
  if (reps.length === 0) return null;
  reps.sort((x, y) => x - y);
  return [quantile(reps, 0.025) as number, quantile(reps, 0.975) as number];
}

export type Dist = { n: number; median: number | null; p90: number | null; median_ci: [number, number] | null; p90_ci: [number, number] | null };

export function dist(values: readonly number[], B: number, seed: number): Dist {
  const sorted = [...values].sort((a, b) => a - b);
  const med = (v: number[]) => quantile([...v].sort((a, b) => a - b), 0.5);
  const p90 = (v: number[]) => quantile([...v].sort((a, b) => a - b), 0.9);
  return {
    n: sorted.length,
    median: quantile(sorted, 0.5),
    p90: quantile(sorted, 0.9),
    median_ci: bootstrapCI(values, med, B, seed),
    p90_ci: bootstrapCI(values, p90, B, seed + 1),
  };
}

/** exact two-sided sign test on the discordant pairs of a paired comparison. */
export function signTestTwoSided(b: number, c: number): number | null {
  const n = b + c;
  if (n === 0) return null;
  const m = Math.min(b, c);
  // P(X <= m) for X ~ Binomial(n, 0.5), summed in log space so a large n cannot overflow.
  let logC = 0; // log C(n, 0)
  let cum = 0;
  for (let i = 0; i <= m; i++) {
    if (i > 0) logC += Math.log(n - i + 1) - Math.log(i);
    cum += Math.exp(logC - n * Math.LN2);
  }
  return Math.min(1, 2 * cum);
}

// ---------------------------------------------------------------- truth

export type TruthInstant = { ms: number; source: "consult_mark" | "pstart" | "pulse_note" | "next_open" };
export type Truth = { opens: TruthInstant[]; /** aligned to `opens`; null where no close truth exists */ closes: (TruthInstant | null)[] };

const msOf = (iso: string): number => Date.parse(iso);

/**
 * Spec §7 truth. Opens: `consult_mark` (kiosk and replay) and, where present, warehouse `pstart`.
 * A mark and a pstart inside `dedupe_s` of each other are ONE visit and the warehouse instant
 * wins (it is the official start). Closes: the first `pulse_note` after the open and no later than
 * the next open, else the next open itself, else none.
 */
export function deriveTruth(cues: readonly FuseCue[], p: Pick<BenchParams, "dedupe_s" | "truth_open_source">): Truth {
  const marks: number[] = [];
  const pstarts: number[] = [];
  for (const c of cues) {
    const t = msOf(c.at);
    if (!Number.isFinite(t)) continue;
    if (c.type === "consult_mark" && p.truth_open_source !== "pstart") marks.push(t);
    if (c.type === "pstart" && c.source === "warehouse" && p.truth_open_source !== "mark") pstarts.push(t);
  }
  // A mark and a pstart inside `dedupe_s` are the same visit seen by two systems: pair them one to
  // one (best pairing first) and keep the warehouse instant. Two MARKS are never merged, however
  // close — a kiosk pressed twice in two minutes is two presses, and deleting one deletes truth.
  const paired = matchOneToOne(marks, pstarts, p.dedupe_s * 1000);
  const opens: TruthInstant[] = [];
  marks.forEach((t, i) => { if (!paired.truth_hit[i]) opens.push({ ms: t, source: "consult_mark" }); });
  pstarts.forEach((t) => opens.push({ ms: t, source: "pstart" }));
  opens.sort((a, b) => a.ms - b.ms || (a.source < b.source ? -1 : 1));

  const notes = cues.filter((c) => c.type === "pulse_note").map((c) => msOf(c.at)).filter(Number.isFinite).sort((a, b) => a - b);
  const closes = opens.map((o, i) => {
    const next = opens[i + 1]?.ms ?? Infinity;
    const note = notes.find((n) => n > o.ms && n <= next);
    if (note !== undefined) return { ms: note, source: "pulse_note" as const };
    if (i + 1 < opens.length) return { ms: opens[i + 1].ms, source: "next_open" as const };
    return null;
  });
  return { opens, closes };
}

// ---------------------------------------------------------------- predictions

export type PredVisit = {
  open_ms: number | null;
  close_ms: number | null;
  open_from: "pstart_at" | "opener_cue" | "tape_start" | "none";
  state: string;
  /** the FIRING RULES, from DraftVisit.reasons — never from visit.ambiguity (see the file header) */
  reasons: string[];
  end_reason: string | null;
};

/** cue id and source_ref → its instant, so a mark-opened visit (pstart_at null) still has an open time. */
export function cueInstants(cues: readonly FuseCue[]): Map<string, number> {
  const m = new Map<string, number>();
  for (const c of cues) {
    const t = msOf(c.at);
    if (!Number.isFinite(t)) continue;
    m.set(c.id, t);
    if (c.source_ref) m.set(c.source_ref, t);
  }
  return m;
}

type VisitLike = {
  pstart_at: string | null;
  ended_at: string | null;
  tape_start_ms: number | null;
  opened_by: string;
  state: string;
  reasons?: readonly string[];
  end_reason?: string | null;
};

export function predFromVisit(v: VisitLike, at: ReadonlyMap<string, number>): PredVisit {
  let open_ms: number | null = null;
  let open_from: PredVisit["open_from"] = "none";
  const p = v.pstart_at ? msOf(v.pstart_at) : NaN;
  if (Number.isFinite(p)) { open_ms = p; open_from = "pstart_at"; }
  else if (at.has(v.opened_by)) { open_ms = at.get(v.opened_by) as number; open_from = "opener_cue"; }
  else if (v.tape_start_ms !== null && v.tape_start_ms !== undefined && Number.isFinite(Number(v.tape_start_ms))) { open_ms = Number(v.tape_start_ms); open_from = "tape_start"; }
  const e = v.ended_at ? msOf(v.ended_at) : NaN;
  return { open_ms, close_ms: Number.isFinite(e) ? e : null, open_from, state: v.state, reasons: [...(v.reasons ?? [])], end_reason: v.end_reason ?? null };
}

export const predFromDraft = (v: DraftVisit, at: ReadonlyMap<string, number>): PredVisit => predFromVisit(v, at);

// ---------------------------------------------------------------- matching and scoring

export type Matching = { pairs: { ti: number; pi: number; err_ms: number }[]; truth_hit: boolean[]; pred_hit: boolean[] };

/**
 * A MAXIMUM one-to-one matching inside ±tol (inclusive), and among the maximum ones the smallest
 * total error. Greedy "nearest pair first" is not maximum — truths at 0 s and 100 s against
 * predictions at 90 s and 200 s would pair only 100↔90 and leave 0 and 200 unmatched — so a
 * greedy matcher under-reports recall and precision exactly where visits are dense. On a line an
 * optimal matching can be taken non-crossing (uncrossing never lengthens either pair), so a DP over
 * the two sorted lists is exact. Ties break deterministically: more pairs, then lower cost, then
 * skip-truth before skip-pred before match.
 */
export function matchOneToOne(truth: readonly number[], pred: readonly number[], tolMs: number): Matching {
  const T = truth.map((ms, i) => ({ ms, i })).sort((a, b) => a.ms - b.ms || a.i - b.i);
  const P = pred.map((ms, i) => ({ ms, i })).sort((a, b) => a.ms - b.ms || a.i - b.i);
  const n = T.length;
  const m = P.length;
  const cnt = Array.from({ length: n + 1 }, () => new Int32Array(m + 1));
  const cost = Array.from({ length: n + 1 }, () => new Float64Array(m + 1));
  const how = Array.from({ length: n + 1 }, () => new Uint8Array(m + 1)); // 0 skip truth, 1 skip pred, 2 match
  for (let i = 0; i <= n; i++) {
    for (let j = 0; j <= m; j++) {
      if (i === 0 && j === 0) continue;
      let bc = -1, bcost = Infinity, bh = 0;
      const consider = (c: number, k: number, h: number) => { if (c > bc || (c === bc && k < bcost)) { bc = c; bcost = k; bh = h; } };
      if (i > 0) consider(cnt[i - 1][j], cost[i - 1][j], 0);
      if (j > 0) consider(cnt[i][j - 1], cost[i][j - 1], 1);
      if (i > 0 && j > 0) {
        const err = Math.abs(T[i - 1].ms - P[j - 1].ms);
        if (err <= tolMs) consider(cnt[i - 1][j - 1] + 1, cost[i - 1][j - 1] + err, 2);
      }
      cnt[i][j] = bc; cost[i][j] = bcost; how[i][j] = bh;
    }
  }
  const truth_hit = truth.map(() => false);
  const pred_hit = pred.map(() => false);
  const pairs: Matching["pairs"] = [];
  for (let i = n, j = m; i > 0 || j > 0; ) {
    const h = how[i][j];
    if (i > 0 && j > 0 && h === 2) {
      truth_hit[T[i - 1].i] = true;
      pred_hit[P[j - 1].i] = true;
      pairs.push({ ti: T[i - 1].i, pi: P[j - 1].i, err_ms: Math.abs(T[i - 1].ms - P[j - 1].ms) });
      i--; j--;
    } else if (i > 0 && (h === 0 || j === 0)) i--;
    else j--;
  }
  pairs.reverse();
  return { pairs, truth_hit, pred_hit };
}

export type DayScoreInput = { room_day_id: string; truth: Truth; preds: readonly PredVisit[] };

/** `precision` for the open edge counts a predicted visit with NO open instant as a false positive (it cannot match anything). */
export type EdgeScore = { recall: Rate; precision: Rate; error_matched_s: Dist; error_nearest_s: Dist; predicted_without_instant: number };

export type ArmScore = {
  days: number;
  truth_opens: number;
  truth_closes: number;
  open: EdgeScore;
  close: EdgeScore;
  visits: { truth_total: number; pred_total: number; ratio: number | null; mean_abs_diff_per_day: number | null; per_day: { room_day_id: string; truth: number; pred: number }[] };
  /** per room-day, aligned to that day's truth opens — the paired comparison reads these */
  open_hits: Record<string, boolean[]>;
};

function scoreEdge(days: readonly DayScoreInput[], edge: "open" | "close", p: BenchParams): EdgeScore {
  const tolMs = p.tolerance_s * 1000;
  let truthN = 0, truthHit = 0, predN = 0, predHit = 0, noInstant = 0;
  const matchedErr: number[] = [];
  const nearestErr: number[] = [];
  for (const d of days) {
    const truthMs: number[] = [];
    if (edge === "open") for (const o of d.truth.opens) truthMs.push(o.ms);
    else for (const c of d.truth.closes) if (c) truthMs.push(c.ms);
    const predMs: number[] = [];
    for (const v of d.preds) {
      const t = edge === "open" ? v.open_ms : v.close_ms;
      if (t === null) { if (edge === "open") noInstant++; continue; }
      predMs.push(t);
    }
    const m = matchOneToOne(truthMs, predMs, tolMs);
    truthN += truthMs.length;
    predN += predMs.length + (edge === "open" ? d.preds.filter((v) => v.open_ms === null).length : 0);
    truthHit += m.truth_hit.filter(Boolean).length;
    predHit += m.pred_hit.filter(Boolean).length;
    for (const pr of m.pairs) matchedErr.push(pr.err_ms / 1000);
    if (predMs.length > 0) for (const t of truthMs) nearestErr.push(Math.min(...predMs.map((x) => Math.abs(x - t))) / 1000);
  }
  return {
    recall: rate(truthHit, truthN),
    precision: rate(predHit, predN),
    error_matched_s: dist(matchedErr, p.bootstrap, p.seed),
    error_nearest_s: dist(nearestErr, p.bootstrap, p.seed + 10),
    predicted_without_instant: noInstant,
  };
}

export function scoreArm(days: readonly DayScoreInput[], p: BenchParams): ArmScore {
  const open_hits: Record<string, boolean[]> = {};
  const perDay: ArmScore["visits"]["per_day"] = [];
  let truthTotal = 0, predTotal = 0, absDiff = 0;
  for (const d of days) {
    const m = matchOneToOne(d.truth.opens.map((o) => o.ms), d.preds.flatMap((v) => (v.open_ms === null ? [] : [v.open_ms])), p.tolerance_s * 1000);
    open_hits[d.room_day_id] = m.truth_hit;
    perDay.push({ room_day_id: d.room_day_id, truth: d.truth.opens.length, pred: d.preds.length });
    truthTotal += d.truth.opens.length;
    predTotal += d.preds.length;
    absDiff += Math.abs(d.preds.length - d.truth.opens.length);
  }
  return {
    days: days.length,
    truth_opens: truthTotal,
    truth_closes: days.reduce((a, d) => a + d.truth.closes.filter(Boolean).length, 0),
    open: scoreEdge(days, "open", p),
    close: scoreEdge(days, "close", p),
    visits: { truth_total: truthTotal, pred_total: predTotal, ratio: truthTotal > 0 ? predTotal / truthTotal : null, mean_abs_diff_per_day: days.length > 0 ? absDiff / days.length : null, per_day: perDay },
    open_hits,
  };
}

export type PairedOpenRecall = { both: number; a_only: number; b_only: number; neither: number; p_value: number | null; statement: string };

/** Same truth opens, two arms: who hit what. Exact sign test on the discordant ones. */
export function pairedOpenRecall(a: ArmScore, b: ArmScore, aName: string, bName: string): PairedOpenRecall {
  let both = 0, aOnly = 0, bOnly = 0, neither = 0;
  for (const day of Object.keys(a.open_hits)) {
    const ha = a.open_hits[day];
    const hb = b.open_hits[day] ?? [];
    ha.forEach((x, i) => {
      const y = hb[i] === true;
      if (x && y) both++; else if (x) aOnly++; else if (y) bOnly++; else neither++;
    });
  }
  const p = signTestTwoSided(aOnly, bOnly);
  const beats = aOnly > bOnly && p !== null && p < 0.05;
  const statement = beats
    ? `${aName} matched more truth opens than ${bName} (${aName}-only ${aOnly}, ${bName}-only ${bOnly}, exact sign test p=${(p as number).toFixed(3)}).`
    : `${aName} does NOT beat ${bName} on open recall at this n (${aName}-only ${aOnly}, ${bName}-only ${bOnly}, both ${both}, neither ${neither}${p === null ? ", no discordant pairs" : `, exact sign test p=${p.toFixed(3)}`}).`;
  return { both, a_only: aOnly, b_only: bOnly, neither, p_value: p, statement };
}

// ---------------------------------------------------------------- calibration

export type Reliability = {
  n: number;
  n_positive: number;
  bins: { lo: number; hi: number; n: number; mean_p: number | null; observed: number | null }[];
  ece: number | null;
  ece_ci: [number, number] | null;
};

export type ProbLabel = { p: number; y: 0 | 1 };

function eceOf(pairs: readonly ProbLabel[], nBins: number): number | null {
  if (pairs.length === 0) return null;
  const sums = Array.from({ length: nBins }, () => ({ n: 0, p: 0, y: 0 }));
  for (const x of pairs) {
    const b = Math.min(nBins - 1, Math.max(0, Math.floor(x.p * nBins)));
    sums[b].n++; sums[b].p += x.p; sums[b].y += x.y;
  }
  let e = 0;
  for (const s of sums) if (s.n > 0) e += (s.n / pairs.length) * Math.abs(s.y / s.n - s.p / s.n);
  return e;
}

/** 10 equal-width bins (p = 1 lands in the last), ECE = Σ (n_b/N)·|observed_b − mean_p_b|, bootstrap CI. */
export function reliability(pairs: readonly ProbLabel[], nBins: number, B: number, seed: number): Reliability {
  const bins = Array.from({ length: nBins }, (_, i) => ({ lo: i / nBins, hi: (i + 1) / nBins, n: 0, sp: 0, sy: 0 }));
  for (const x of pairs) {
    const b = Math.min(nBins - 1, Math.max(0, Math.floor(x.p * nBins)));
    bins[b].n++; bins[b].sp += x.p; bins[b].sy += x.y;
  }
  let ci: [number, number] | null = null;
  if (pairs.length > 0 && B > 0) {
    const rnd = mulberry32(seed);
    const reps: number[] = [];
    for (let b = 0; b < B; b++) {
      const s: ProbLabel[] = new Array(pairs.length);
      for (let i = 0; i < pairs.length; i++) s[i] = pairs[Math.floor(rnd() * pairs.length)];
      const e = eceOf(s, nBins);
      if (e !== null) reps.push(e);
    }
    reps.sort((a, b) => a - b);
    if (reps.length > 0) ci = [quantile(reps, 0.025) as number, quantile(reps, 0.975) as number];
  }
  return {
    n: pairs.length,
    n_positive: pairs.filter((x) => x.y === 1).length,
    bins: bins.map((b) => ({ lo: b.lo, hi: b.hi, n: b.n, mean_p: b.n ? b.sp / b.n : null, observed: b.n ? b.sy / b.n : null })),
    ece: eceOf(pairs, nBins),
    ece_ci: ci,
  };
}

export type CalibSignal = { session_id: string; start_ms: number; end_ms: number; p_start: number; p_end: number; prompt_version: string };

export type Anchored = { epochStart: number; epochEnd: number; s: CalibSignal };

/** Window instants on the wall clock: session started_at + the window's session-relative offset (J2's own rule). */
export function anchorSignals<T extends CalibSignal>(signals: readonly T[], sessionStartMs: ReadonlyMap<string, number>): { anchored: { epochStart: number; epochEnd: number; s: T }[]; unanchored: number } {
  const anchored: { epochStart: number; epochEnd: number; s: T }[] = [];
  let unanchored = 0;
  for (const s of signals) {
    const base = sessionStartMs.get(s.session_id);
    if (base === undefined || !Number.isFinite(base)) { unanchored++; continue; }
    anchored.push({ epochStart: base + Number(s.start_ms), epochEnd: base + Number(s.end_ms), s });
  }
  return { anchored, unanchored };
}

/** A window is a positive when it overlaps [t − r, t + r] for some truth instant t. Skipped windows never enter. */
export function calibrationPairs(
  anchored: readonly { epochStart: number; epochEnd: number; s: CalibSignal }[],
  truthMs: readonly number[],
  radiusMs: number,
  field: "p_start" | "p_end",
  /** windows starting at or after this instant have NO label (e.g. after the last open when its close is unknown) and are left out */
  unlabelledFromMs: number = Infinity,
): { pairs: ProbLabel[]; skipped_excluded: number; unlabelled_excluded: number } {
  const pairs: ProbLabel[] = [];
  let skipped = 0;
  let unlabelled = 0;
  for (const a of anchored) {
    if (String(a.s.prompt_version ?? "").startsWith("skipped:")) { skipped++; continue; }
    if (a.epochStart >= unlabelledFromMs) { unlabelled++; continue; }
    const pos = truthMs.some((t) => a.epochEnd >= t - radiusMs && a.epochStart <= t + radiusMs);
    pairs.push({ p: a.s[field], y: pos ? 1 : 0 });
  }
  return { pairs, skipped_excluded: skipped, unlabelled_excluded: unlabelled };
}

// ---------------------------------------------------------------- roles

export type RoleLabel = { window_id: string; speaker_idx: number; role: string };
export type RoleSignal = { window_id: string; speaker_idx: number; role: string; role_confidence: number; acoustic_clinician: boolean };

/** `window_id,speaker_idx,role` with a header row. Invalid rows are counted, never guessed at. */
export function parseRoleLabelsCsv(text: string): { labels: RoleLabel[]; invalid_rows: number; header_ok: boolean } {
  const lines = text.split(/\r?\n/).map((l) => l.trim()).filter((l) => l.length > 0);
  if (lines.length === 0) return { labels: [], invalid_rows: 0, header_ok: false };
  const header = lines[0].split(",").map((s) => s.trim().toLowerCase());
  const header_ok = header.length >= 3 && header[0] === "window_id" && header[1] === "speaker_idx" && header[2] === "role";
  const labels: RoleLabel[] = [];
  let invalid = 0;
  for (const line of lines.slice(header_ok ? 1 : 0)) {
    const [w, i, r] = line.split(",").map((s) => s.trim());
    const idx = Number(i);
    if (!w || !Number.isInteger(idx) || idx < 0 || !(ROLES as readonly string[]).includes(r)) { invalid++; continue; }
    labels.push({ window_id: w, speaker_idx: idx, role: r });
  }
  return { labels, invalid_rows: invalid, header_ok };
}

export type RoleReport = {
  accuracy:
    | { status: "UNVERIFIED"; reason: string }
    | {
        status: "measured";
        scope: "labelled_non_clinician_speakers";
        result: Rate;
        all_labelled: Rate;
        confusion: Record<string, Record<string, number>>;
        labels_without_signal: number;
        labels_invalid_rows: number;
      };
  acoustic_agreement: { n: number; k: number; value: number | null; ci: [number, number] | null; note: string };
  composite_null_share: { n_speakers: number; n_null: number; share: number | null };
  speakers_scored: number;
};

/**
 * Role accuracy is measured ONLY against a label file. With none, it is UNVERIFIED and the
 * fallback is agreement with the acoustic clinician flag — which is a different question (the flag
 * is itself a model output) and is labelled as such. No label is ever inferred from the flag.
 */
export function roleMetrics(signals: readonly RoleSignal[], labels: readonly RoleLabel[] | null, tRole: number, labelsInvalidRows = 0): RoleReport {
  const acoustic = signals.filter((s) => s.acoustic_clinician);
  const acousticK = acoustic.filter((s) => s.role === "clinician").length;
  const nullN = signals.filter((s) => !s.acoustic_clinician && s.role_confidence < tRole).length;
  const composable = signals.filter((s) => !s.acoustic_clinician).length;
  const base = {
    acoustic_agreement: {
      n: acoustic.length,
      k: acousticK,
      value: acoustic.length > 0 ? acousticK / acoustic.length : null,
      ci: wilson(acousticK, acoustic.length),
      note: acoustic.length === 0 ? "UNDEFINED: no speaker in scope carries an acoustic clinician flag" : "agreement with a model-derived flag, not with a human label",
    },
    composite_null_share: { n_speakers: composable, n_null: nullN, share: composable > 0 ? nullN / composable : null },
    speakers_scored: signals.length,
  };
  if (labels === null) return { accuracy: { status: "UNVERIFIED", reason: "no label file: docs/handoff/scratch/jev-role-labels.csv is absent, and no label is invented" }, ...base };
  if (labels.length === 0) return { accuracy: { status: "UNVERIFIED", reason: "label file present but holds no valid rows" }, ...base };

  const sig = new Map(signals.map((s) => [`${s.window_id}#${s.speaker_idx}`, s]));
  const confusion: Record<string, Record<string, number>> = {};
  let allK = 0, allN = 0, ncK = 0, ncN = 0, without = 0;
  for (const l of labels) {
    const s = sig.get(`${l.window_id}#${l.speaker_idx}`);
    if (!s) { without++; continue; }
    (confusion[l.role] ??= {})[s.role] = ((confusion[l.role] ??= {})[s.role] ?? 0) + 1;
    allN++;
    if (s.role === l.role) allK++;
    if (l.role !== "clinician") { ncN++; if (s.role === l.role) ncK++; }
  }
  return {
    accuracy: { status: "measured", scope: "labelled_non_clinician_speakers", result: rate(ncK, ncN), all_labelled: rate(allK, allN), confusion, labels_without_signal: without, labels_invalid_rows: labelsInvalidRows },
    ...base,
  };
}

// ---------------------------------------------------------------- cost and latency

export type CostSignal = { batch_id: string; input_tokens: number; prompt_version: string };

export type DayCost = { input_tokens: number; calls: number; windows: number; windows_skipped: number; usd: number };

/** Σ per-window input_tokens (J2 stores each batch's total divided across its windows, rounded), $ at the stated rate. */
export function dayCost(signals: readonly CostSignal[], usdPerBillion: number): DayCost {
  const isSkip = (s: CostSignal) => String(s.prompt_version ?? "").startsWith("skipped:");
  const skipped = signals.filter(isSkip).length;
  const asked = signals.filter((s) => !isSkip(s));
  const tokens = asked.reduce((a, s) => a + Number(s.input_tokens || 0), 0);
  return { input_tokens: tokens, calls: new Set(asked.map((s) => s.batch_id)).size, windows: signals.length, windows_skipped: skipped, usd: (tokens * usdPerBillion) / 1e9 };
}

export type LatencySummary = { n: number; median_ms: number | null; p90_ms: number | null };
export function latencySummary(ms: readonly number[]): LatencySummary {
  const s = [...ms].filter((x) => Number.isFinite(x)).sort((a, b) => a - b);
  return { n: s.length, median_ms: quantile(s, 0.5), p90_ms: quantile(s, 0.9) };
}

// ---------------------------------------------------------------- verdicts

export type Verdict = {
  metric: keyof Thresholds;
  direction: ">=" | "<=";
  threshold: number;
  value: number | null;
  ci: [number, number] | null;
  n: number;
  /** the point estimate is on the right side of the threshold; null = not evaluable */
  meets_point: boolean | null;
  /** the whole 95% interval is on the right side; null = no interval */
  ci_clears: boolean | null;
};

export function judge(metric: keyof Thresholds, threshold: number, direction: ">=" | "<=", value: number | null, ci: [number, number] | null, n: number): Verdict {
  const meets = value === null ? null : direction === ">=" ? value >= threshold : value <= threshold;
  const clears = ci === null ? null : direction === ">=" ? ci[0] >= threshold : ci[1] <= threshold;
  return { metric, direction, threshold, value, ci, n, meets_point: meets, ci_clears: clears };
}

/** Spec §7: run one is directional only until there are ≥ min_truth_opens truth opens. */
export const verdictStatus = (truthOpens: number, minTruth: number): "directional_only" | "eligible" => (truthOpens >= minTruth ? "eligible" : "directional_only");

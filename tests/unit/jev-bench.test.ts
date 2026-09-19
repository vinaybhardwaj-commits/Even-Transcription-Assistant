/**
 * tests/unit/jev-bench.test.ts — Slice J4 (ETA-JEV-ARM-D §7): the bench harness, proved on a
 * synthetic fixture. Nothing here touches a database, a network or a real room-day.
 *
 * The fixture (tests/fixtures/jev/bench-fixture.json) is built so every headline number can be
 * derived by hand: five truth opens across two days; Arm D opens at 0 s, +30 s, (a miss), +90 s
 * and -90 s of them, so recall 4/5, precision 4/5, matched errors {0, 30, 90, 90}, median 60 s;
 * Arm A opens FROM the marks, so it hits all five by construction.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import {
  DEFAULT_PARAMS, DEFAULT_THRESHOLDS, anchorSignals, bootstrapCI, calibrationPairs, dayCost, deriveTruth, dist, judge, latencySummary, matchOneToOne,
  mulberry32, parseRoleLabelsCsv, parseThresholds, quantile, reliability, roleMetrics, scoreArm, signTestTwoSided, verdictStatus, wilson,
  type BenchParams, type RoleSignal,
} from "@/lib/jev/bench";
import { dbReader, fixtureReader, type BenchDay, type Sql } from "@/lib/jev/bench-reader";
import { renderMarkdown, runBench, type BenchOptions } from "@/lib/jev/bench-run";
import { LIVE_ACK_ENV, LIVE_ACK_VALUE, USAGE, dateLabel, main, parseArgs, type CliDeps } from "@/lib/jev/bench-cli";
import { ambiguityOf } from "@/lib/brain/fuse/rules";
import type { FuseCue } from "@/lib/brain/fuse/types";

const FIXTURE = JSON.parse(readFileSync("tests/fixtures/jev/bench-fixture.json", "utf8")) as { days: (Partial<BenchDay> & { room_day_id: string })[] };
const LABELS = readFileSync("tests/fixtures/jev/bench-role-labels.csv", "utf8");

const P: BenchParams = { ...DEFAULT_PARAMS, bootstrap: 200 };
const opts = (over: Partial<BenchOptions> = {}): BenchOptions => ({
  mode: "dry-run", live_ack: false, arms: ["rules", "hybrid", "flash", "jev"], room_days: FIXTURE.days.map((d) => d.room_day_id), params: P, role_labels: null, date: "19-SEP-2026", ...over,
});
const cue = (id: string, type: string, at: string, extra: Partial<FuseCue> = {}): FuseCue => ({ id, type, at, payload: null, source: null, source_ref: null, ...extra });

// ------------------------------------------------------------------------------------------------
describe("J4 — statistics", () => {
  it("Wilson 95% interval: known value, and no interval for an empty denominator", () => {
    const [lo, hi] = wilson(4, 5) as [number, number];
    expect(lo).toBeCloseTo(0.376, 2);
    expect(hi).toBeCloseTo(0.964, 2);
    expect(wilson(0, 0)).toBeNull();
    expect(wilson(0, 10)![0]).toBe(0);
    expect(wilson(10, 10)![1]).toBe(1);
  });

  it("quantile is type-7 linear interpolation; empty is null", () => {
    expect(quantile([1, 2, 3, 4], 0.5)).toBe(2.5);
    expect(quantile([0, 30, 90, 90], 0.9)).toBeCloseTo(90, 9);
    expect(quantile([], 0.5)).toBeNull();
  });

  it("the seeded bootstrap is deterministic and brackets the estimate", () => {
    const v = [0, 30, 90, 90, 40, 20, 10, 75];
    const med = (x: number[]) => quantile([...x].sort((a, b) => a - b), 0.5);
    const a = bootstrapCI(v, med, 300, 7);
    const b = bootstrapCI(v, med, 300, 7);
    expect(a).toEqual(b);
    expect(a![0]).toBeLessThanOrEqual(med(v)!);
    expect(a![1]).toBeGreaterThanOrEqual(med(v)!);
    expect(bootstrapCI([], med, 300, 7)).toBeNull();
    const r = mulberry32(1);
    expect(r()).toBe(mulberry32(1)());
  });

  it("exact two-sided sign test", () => {
    expect(signTestTwoSided(0, 0)).toBeNull();
    expect(signTestTwoSided(1, 0)).toBe(1);
    expect(signTestTwoSided(8, 0)).toBeCloseTo(2 * 0.5 ** 8, 12);
    expect(signTestTwoSided(3, 3)).toBe(1);
  });

  it("dist reports n, median, p90 with intervals; an empty dist reports n=0 and nulls", () => {
    const d = dist([0, 30, 90, 90], 200, 1);
    expect(d.n).toBe(4);
    expect(d.median).toBe(60);
    expect(d.p90).toBeCloseTo(90, 9);
    expect(d.median_ci).not.toBeNull();
    const e = dist([], 200, 1);
    expect(e).toEqual({ n: 0, median: null, p90: null, median_ci: null, p90_ci: null });
  });
});

// ------------------------------------------------------------------------------------------------
describe("J4 — truth", () => {
  it("a kiosk mark and a warehouse pstart inside the dedupe window are ONE visit and the pstart instant wins", () => {
    const t = deriveTruth(
      [cue("m1", "consult_mark", "2026-09-01T04:00:30.000Z"), cue("p1", "pstart", "2026-09-01T04:00:00.000Z", { source: "warehouse" }), cue("m2", "consult_mark", "2026-09-01T04:20:00.000Z")],
      DEFAULT_PARAMS,
    );
    expect(t.opens.map((o) => [o.source, o.ms])).toEqual([["pstart", Date.parse("2026-09-01T04:00:00.000Z")], ["consult_mark", Date.parse("2026-09-01T04:20:00.000Z")]]);
  });

  it("a pstart that is not warehouse-sourced is not truth", () => {
    const t = deriveTruth([cue("p1", "pstart", "2026-09-01T04:00:00.000Z", { source: "replay" })], DEFAULT_PARAMS);
    expect(t.opens).toEqual([]);
  });

  it("truth_open_source narrows the candidates", () => {
    const cues = [cue("m1", "consult_mark", "2026-09-01T04:00:00.000Z"), cue("p1", "pstart", "2026-09-01T05:00:00.000Z", { source: "warehouse" })];
    expect(deriveTruth(cues, { ...DEFAULT_PARAMS, truth_open_source: "mark" }).opens).toHaveLength(1);
    expect(deriveTruth(cues, { ...DEFAULT_PARAMS, truth_open_source: "pstart" }).opens[0].source).toBe("pstart");
    expect(deriveTruth(cues, DEFAULT_PARAMS).opens).toHaveLength(2);
  });

  it("closes: a pulse_note between the opens wins, else the NEXT open, else none", () => {
    const t = deriveTruth(
      [
        cue("m1", "consult_mark", "2026-09-01T04:00:00.000Z"),
        cue("pn", "pulse_note", "2026-09-01T04:08:00.000Z"),
        cue("m2", "consult_mark", "2026-09-01T04:10:00.000Z"),
        cue("m3", "consult_mark", "2026-09-01T04:30:00.000Z"),
      ],
      DEFAULT_PARAMS,
    );
    expect(t.closes.map((c) => c && [c.source, c.ms])).toEqual([
      ["pulse_note", Date.parse("2026-09-01T04:08:00.000Z")],
      ["next_open", Date.parse("2026-09-01T04:30:00.000Z")],
      null,
    ]);
  });
});

// ------------------------------------------------------------------------------------------------
describe("J4 — matching at ±180 s", () => {
  it("180 s is a hit, 181 s is a miss", () => {
    expect(matchOneToOne([0], [180_000], 180_000).truth_hit).toEqual([true]);
    expect(matchOneToOne([0], [181_000], 180_000).truth_hit).toEqual([false]);
  });

  it("one-to-one: two predictions near one truth open give one hit and one false positive", () => {
    const m = matchOneToOne([1_000_000], [1_000_000 + 10_000, 1_000_000 + 60_000], 180_000);
    expect(m.pairs).toHaveLength(1);
    expect(m.pairs[0].err_ms).toBe(10_000);
    expect(m.pred_hit).toEqual([true, false]);
  });

  it("the nearest pairing is taken first, so a far pair cannot steal a near one", () => {
    const m = matchOneToOne([0, 100_000], [90_000], 180_000);
    expect(m.truth_hit).toEqual([false, true]);
  });
});

// ------------------------------------------------------------------------------------------------
describe("J4 — calibration", () => {
  it("a perfectly calibrated set has ECE 0 and p = 1 lands in the last bin", () => {
    const pairs = [...Array(10).fill(0).map(() => ({ p: 0.5, y: 0 as const })).slice(0, 5), ...Array(5).fill(0).map(() => ({ p: 0.5, y: 1 as const }))];
    expect(reliability(pairs, 10, 0, 1).ece).toBeCloseTo(0, 12);
    const r = reliability([{ p: 1, y: 0 }], 10, 0, 1);
    expect(r.bins[9].n).toBe(1);
    expect(r.ece).toBe(1);
  });

  it("windows within ±radius of a truth instant are positives (inclusive); skipped windows never enter", () => {
    const starts = new Map([["s1", 0]]);
    const sig = (k: number, pv = "jev-arm-d-v1") => ({ session_id: "s1", start_ms: k * 30_000, end_ms: (k + 1) * 30_000, p_start: 0.5, p_end: 0.5, prompt_version: pv });
    const { anchored, unanchored } = anchorSignals([sig(0), sig(1), sig(2, "skipped:no_english"), { ...sig(3), session_id: "ghost" }], starts);
    expect(unanchored).toBe(1);
    const { pairs, skipped_excluded } = calibrationPairs(anchored, [60_000 + 60_000], 60_000, "p_start"); // t = 120 s, radius 60 s → [60, 180]
    expect(skipped_excluded).toBe(1);
    expect(pairs.map((x) => x.y)).toEqual([0, 1]); // window 0 ends at 30 s < 60 s; window 1 spans 30–60 s and touches 60 s
  });
});

// ------------------------------------------------------------------------------------------------
describe("J4 — roles: never invent a label", () => {
  const sig = (w: string, i: number, role: string, conf: number, ac = false): RoleSignal => ({ window_id: w, speaker_idx: i, role, role_confidence: conf, acoustic_clinician: ac });

  it("no label file → accuracy is UNVERIFIED with no number anywhere in it", () => {
    const r = roleMetrics([sig("w", 0, "clinician", 0.9, true), sig("w", 1, "patient", 0.8)], null, 0.6);
    expect(r.accuracy.status).toBe("UNVERIFIED");
    expect(JSON.stringify(r.accuracy)).not.toMatch(/"value"|"k"|"n"/);
  });

  it("an empty or invalid label file is UNVERIFIED too, never accuracy 0", () => {
    expect(roleMetrics([sig("w", 0, "patient", 0.9)], [], 0.6).accuracy.status).toBe("UNVERIFIED");
    const parsed = parseRoleLabelsCsv("window_id,speaker_idx,role\nw,0,astronaut\n,1,patient\nw,x,patient\n");
    expect(parsed.labels).toEqual([]);
    expect(parsed.invalid_rows).toBe(3);
  });

  it("acoustic agreement with zero flagged speakers is UNDEFINED, not 0 and not 1", () => {
    const r = roleMetrics([sig("w", 0, "patient", 0.9)], null, 0.6);
    expect(r.acoustic_agreement.value).toBeNull();
    expect(r.acoustic_agreement.n).toBe(0);
    expect(r.acoustic_agreement.note).toContain("UNDEFINED");
  });

  it("with labels: accuracy is on non-clinician speakers, confusion is per class, an unmatched label is counted not scored", () => {
    const parsed = parseRoleLabelsCsv(LABELS);
    expect(parsed.header_ok).toBe(true);
    expect(parsed.labels).toHaveLength(4);
    const signals = FIXTURE.days[0].role_signals as RoleSignal[];
    const r = roleMetrics(signals, [...parsed.labels, { window_id: "bw_nowhere", speaker_idx: 0, role: "patient" }], 0.6);
    if (r.accuracy.status !== "measured") throw new Error("expected measured");
    expect(r.accuracy.result).toMatchObject({ k: 2, n: 3 }); // patient ✓, patient-vs-attendant ✗, nurse ✓
    expect(r.accuracy.all_labelled).toMatchObject({ k: 3, n: 4 });
    expect(r.accuracy.confusion.patient).toEqual({ patient: 1, attendant: 1 });
    expect(r.accuracy.labels_without_signal).toBe(1);
    expect(r.acoustic_agreement).toMatchObject({ n: 1, k: 1, value: 1 });
    expect(r.composite_null_share).toMatchObject({ n_speakers: 3, n_null: 1 }); // the 0.5-confidence attendant
  });
});

// ------------------------------------------------------------------------------------------------
describe("J4 — cost and thresholds", () => {
  it("skipped windows cost nothing and are counted; $42 per billion tokens", () => {
    const c = dayCost([
      { batch_id: "b0", input_tokens: 1000, prompt_version: "jev-arm-d-v1" },
      { batch_id: "b0", input_tokens: 1000, prompt_version: "jev-arm-d-v1" },
      { batch_id: "b1", input_tokens: 0, prompt_version: "skipped:no_english" },
    ], 42);
    expect(c).toMatchObject({ input_tokens: 2000, calls: 1, windows: 3, windows_skipped: 1 });
    expect(c.usd).toBeCloseTo(2000 * 42e-9, 12);
  });

  it("latency summary ignores non-finite values", () => {
    expect(latencySummary([800, 900, 1000, 1200, NaN])).toEqual({ n: 4, median_ms: 950, p90_ms: 1140 });
  });

  it("thresholds are parameters: spec defaults, overridable, and an unknown key is an error", () => {
    expect(DEFAULT_THRESHOLDS).toEqual({ open_recall: 0.8, open_precision: 0.8, median_open_error_s: 90, ece_p_start: 0.1, role_accuracy: 0.85, cost_usd_per_room_day: 0.05 });
    expect(parseThresholds(undefined)).toEqual(DEFAULT_THRESHOLDS);
    expect(parseThresholds("open_recall=0.5, ece_p_start=0.2")).toMatchObject({ open_recall: 0.5, ece_p_start: 0.2, open_precision: 0.8 });
    expect(() => parseThresholds("recall=0.5")).toThrow("unknown_threshold");
    expect(() => parseThresholds("open_recall=high")).toThrow("bad_threshold_value");
  });

  it("judge: point and interval are separate questions; verdict status waits for the truth-open floor", () => {
    expect(judge("open_recall", 0.8, ">=", 0.8, [0.376, 0.964], 5)).toMatchObject({ meets_point: true, ci_clears: false });
    expect(judge("median_open_error_s", 90, "<=", 60, [0, 90], 4)).toMatchObject({ meets_point: true, ci_clears: true });
    expect(judge("role_accuracy", 0.85, ">=", null, null, 0)).toMatchObject({ meets_point: null, ci_clears: null });
    expect(verdictStatus(99, 100)).toBe("directional_only");
    expect(verdictStatus(100, 100)).toBe("eligible");
  });
});

// ------------------------------------------------------------------------------------------------
describe("J4 — the bench on the fixture", () => {
  it("Arm D and Arm A: the hand-derived numbers", async () => {
    const r = await runBench(fixtureReader(FIXTURE), opts());
    expect(r.status).toBe("ok");
    expect(r.dataset).toMatchObject({ room_days_requested: 3, room_days_loaded: 3, room_days_with_truth: 2, room_days_common: 2, truth_opens_common: 5 });
    expect(r.dataset.excluded).toEqual([{ room_day_id: "rd_bench_fixture_c", reason: "no_truth_opens" }]);

    const d = r.arms.jev!.common_days!;
    expect(d.open.recall).toMatchObject({ k: 4, n: 5, value: 0.8 });
    expect(d.open.precision).toMatchObject({ k: 4, n: 5, value: 0.8 });
    expect(d.open.error_matched_s.n).toBe(4);
    expect(d.open.error_matched_s.median).toBe(60);
    expect(d.open.error_matched_s.p90).toBeCloseTo(90, 9);
    expect(d.visits).toMatchObject({ truth_total: 5, pred_total: 5, ratio: 1 });
    // the missed third mark: nearest prediction that day is 210 s away
    expect(d.open.error_nearest_s.n).toBe(5);

    const a = r.arms.rules!.common_days!;
    expect(a.open.recall).toMatchObject({ k: 5, n: 5 });
    expect(a.open.precision).toMatchObject({ k: 5, n: 5 });
    expect(r.arms.rules!.truth_in_input).toBe(true);
    expect(r.arms.jev!.truth_in_input).toBe(false);
  });

  it("directional only below the truth-open floor; every verdict carries a denominator and an interval", async () => {
    const r = await runBench(fixtureReader(FIXTURE), opts());
    expect(r.verdict_status).toBe("directional_only");
    const byMetric = Object.fromEntries(r.verdicts.map((v) => [v.metric, v]));
    expect(byMetric.open_recall).toMatchObject({ n: 5, meets_point: true, ci_clears: false });
    expect(byMetric.open_recall.ci![0]).toBeCloseTo(0.376, 2);
    expect(byMetric.median_open_error_s).toMatchObject({ value: 60, meets_point: true });
    expect(byMetric.role_accuracy).toMatchObject({ value: null, meets_point: null }); // no labels supplied here
    expect(byMetric.cost_usd_per_room_day.meets_point).toBe(true);
    const eligible = await runBench(fixtureReader(FIXTURE), opts({ params: { ...P, min_truth_opens: 5 } }));
    expect(eligible.verdict_status).toBe("eligible");
  });

  it("hybrid and flash are ABSENT with no persisted rows and never called; jev-native is ABSENT without a signal file", async () => {
    const r = await runBench(fixtureReader(FIXTURE), opts({ arms: ["rules", "hybrid", "flash", "jev", "jev-native"] }));
    for (const arm of ["hybrid", "flash", "jev-native"] as const) {
      expect(r.arms[arm]).toMatchObject({ available: false, common_days: null });
    }
    expect(r.unverified.join(" ")).toContain("hybrid: ABSENT");
    expect(r.unverified.join(" ")).toContain("jev-native: ABSENT");
    // an absent arm does not shrink the common-day set
    expect(r.dataset.room_days_common).toBe(2);
  });

  it("persisted rows make hybrid/flash available, read without the ambiguity column", async () => {
    const withFlash = structuredClone(FIXTURE);
    withFlash.days[0].persisted = { flash: [{ arm: "flash", state: "in_chair", pstart_at: "2026-09-01T04:05:20.000Z", ended_at: null, tape_start_ms: null, opened_by: "x" }] };
    withFlash.days[1].persisted = { flash: [{ arm: "flash", state: "ended", pstart_at: null, ended_at: null, tape_start_ms: Date.parse("2026-09-01T09:10:10.000Z"), opened_by: "cm_b1" }] };
    const r = await runBench(fixtureReader(withFlash), opts({ arms: ["rules", "flash", "jev"] }));
    expect(r.arms.flash).toMatchObject({ available: true, source: "persisted_visit_rows" });
    // common days are unchanged (both days have flash rows); flash matched 2 of the 5 truth opens (a's first, b's first)
    expect(r.arms.flash!.common_days!.open.recall).toMatchObject({ k: 2, n: 5 });
  });

  it("jev-native from a signal file is scored beside jev and compared to it", async () => {
    const native = { rd_bench_fixture_a: FIXTURE.days[0].jev_signals!, rd_bench_fixture_b: FIXTURE.days[1].jev_signals! };
    const r = await runBench(fixtureReader(FIXTURE), opts({ arms: ["jev", "jev-native"], native_signals: native as never }));
    expect(r.arms["jev-native"]!.common_days!.open.recall).toMatchObject({ k: 4, n: 5 });
    expect(r.comparison.jev_native_vs_jev).toMatchObject({ both: 4, neither: 1, a_only: 0, b_only: 0 });
  });

  it("Arm D versus Arm A is compared on the same truth opens and says plainly it does NOT win, and why Arm A is inflated", async () => {
    const r = await runBench(fixtureReader(FIXTURE), opts());
    expect(r.comparison.jev_vs_rules).toMatchObject({ both: 4, a_only: 0, b_only: 1, neither: 0, p_value: 1 });
    expect(r.comparison.statement).toContain("does NOT beat");
    expect(r.comparison.statement).toContain("FROM the consult_mark cues");
  });

  it("TRAP 1: firing rules and closes come from the arm's own DraftVisit, which the persisted row cannot give", async () => {
    const r = await runBench(fixtureReader(FIXTURE), opts());
    const rules = r.arms.jev!.firing_rules!;
    expect(rules.p_start).toBe(5);
    expect(rules.jev_end).toBeGreaterThan(0);
    // (1) the column is a re-encoding of the list: duplicates collapse, order follows the closed set, empty is null
    expect(ambiguityOf(["p_start:0.90", "p_start:0.90"])).toBe("p_start:0.90");
    expect(ambiguityOf(["zzz", "mark_without_warehouse_evidence"])).toBe("mark_without_warehouse_evidence,zzz");
    expect(ambiguityOf([])).toBeNull();
    // (2) the bigger loss: Arm D emits in_chair visits and writeVisits nulls ended_at for any state but 'ended',
    //     so a database read of Arm D would have NO closes — the bench, reading the DraftVisit, has them.
    const jevDays = FIXTURE.days.slice(0, 2);
    for (const d of jevDays) {
      const { runJevArm } = await import("@/lib/brain/fuse/jev-arm");
      const out = runJevArm(d.cues as FuseCue[], d.jev_signals as never, d.sessions as never);
      expect(out.visits.every((v) => v.state !== "ended")).toBe(true);
      expect(out.visits.some((v) => v.ended_at !== null)).toBe(true);
    }
    expect(r.arms.jev!.common_days!.close.precision.n).toBeGreaterThan(0);
  });

  it("calibration: 108 windows (2 skipped excluded), 30 positives around the five truth opens, and a p_end table on the days with close truth", async () => {
    const r = await runBench(fixtureReader(FIXTURE), opts());
    const c = r.arms.jev!.calibration!;
    expect(c.p_start).toMatchObject({ n: 108, n_positive: 30, skipped_windows_excluded: 2 });
    expect(c.p_start!.bins).toHaveLength(10);
    expect(c.p_start!.ece).toBeGreaterThan(0);
    expect(c.p_start!.ece_ci).not.toBeNull();
    expect(c.p_end!.days_used).toBe(2);
    expect(r.arms.rules!.calibration).toBeUndefined(); // only the Jev arms have probabilities
  });

  it("cost per room-day counts skipped windows without charging for them; latency is labelled approximate", async () => {
    const r = await runBench(fixtureReader(FIXTURE), opts());
    const cost = r.arms.jev!.cost!;
    const a = cost.per_day.find((x) => x.room_day_id === "rd_bench_fixture_a")!.cost;
    const b = cost.per_day.find((x) => x.room_day_id === "rd_bench_fixture_b")!.cost;
    expect(a).toMatchObject({ input_tokens: 6000, windows: 60, windows_skipped: 0 });
    expect(b).toMatchObject({ input_tokens: 4800, windows: 50, windows_skipped: 2 });
    expect(cost.input_tokens_total).toBe(10800);
    expect(r.arms.jev!.latency!.attribution).toContain("approximate");
    expect(r.arms.jev!.latency!.per_call_total_ms).toMatchObject({ n: 4, median_ms: 950, p90_ms: 1140 });
    expect(r.unverified.join(" ")).toContain("latency: APPROXIMATE");
  });

  it("role accuracy is UNVERIFIED with no labels, MEASURED with them", async () => {
    const without = await runBench(fixtureReader(FIXTURE), opts());
    expect(without.role!.accuracy.status).toBe("UNVERIFIED");
    expect(without.unverified.join(" ")).toContain("role accuracy: UNVERIFIED");
    const p = parseRoleLabelsCsv(LABELS);
    const withL = await runBench(fixtureReader(FIXTURE), opts({ role_labels: { labels: p.labels, invalid_rows: p.invalid_rows } }));
    if (withL.role!.accuracy.status !== "measured") throw new Error("expected measured");
    expect(withL.role!.accuracy.result).toMatchObject({ k: 2, n: 3 });
  });

  it("the report carries no identifier from a payload: not the individual_uid, not a name", async () => {
    const r = await runBench(fixtureReader(FIXTURE), opts({ role_labels: { labels: [], invalid_rows: 0 } }));
    const text = JSON.stringify(r) + renderMarkdown(r);
    expect(text).not.toContain("individual_uid");
    expect(text).not.toContain("uid_cm_a1");
    expect(text).not.toMatch(/api[_-]?key|postgres(ql)?:\/\//i);
  });

  it("the markdown says UNVERIFIED, directional only, and inflated-by-construction where it applies", async () => {
    const md = renderMarkdown(await runBench(fixtureReader(FIXTURE), opts()));
    expect(md).toContain("UNVERIFIED");
    expect(md).toContain("Directional only");
    expect(md).toContain("inflated by construction");
    expect(md).toContain("95% CI");
    expect(md).toContain("Reliability, p_start");
  });

  it("J0 coverage: a day with windows but no English is named, because Arm D would skip all of it", async () => {
    const fx = structuredClone(FIXTURE);
    fx.days[0].english_coverage = { windows: 60, text_rows: 60, english_nonempty: 0 };
    const r = await runBench(fixtureReader(fx), opts());
    expect(r.unverified.join(" ")).toContain("J0 has not produced English");
    expect(r.dataset.days_detail.find((d) => d.room_day_id === "rd_bench_fixture_a")!.english_coverage).toEqual({ windows: 60, text_rows: 60, english_nonempty: 0 });
  });
});

// ------------------------------------------------------------------------------------------------
describe("J4 — it will not run on live data", () => {
  const countingReader = (days: (Partial<BenchDay> & { room_day_id: string })[]) => {
    const inner = fixtureReader({ days });
    const calls = { loadDay: 0 };
    return { calls, reader: { roomDayMeta: inner.roomDayMeta, loadDay: async (id: string) => { calls.loadDay++; return inner.loadDay(id); } } };
  };

  it("dry-run refuses a non-scratch day BY NAME and reads nothing", async () => {
    const live = { ...structuredClone(FIXTURE.days[0]), room_day_id: "rd_real_day", scratch: false };
    const { reader, calls } = countingReader([FIXTURE.days[1], live]);
    const r = await runBench(reader, opts({ room_days: ["rd_bench_fixture_b", "rd_real_day"] }));
    expect(r.status).toBe("refused");
    expect(r.refusal).toMatchObject({ room_days: ["rd_real_day"] });
    expect(r.refusal!.reason).toContain("not_a_scratch_day");
    expect(calls.loadDay).toBe(0);
    expect(r.arms).toEqual({});
  });

  it("a day whose scratch flag is null is refused as well (unknown is not scratch)", async () => {
    const { reader, calls } = countingReader([{ ...structuredClone(FIXTURE.days[0]), scratch: null }]);
    const r = await runBench(reader, opts({ room_days: ["rd_bench_fixture_a"] }));
    expect(r.status).toBe("refused");
    expect(calls.loadDay).toBe(0);
  });

  it("live mode without V's word refuses before it even asks which days exist", async () => {
    let asked = 0;
    const reader = { roomDayMeta: async () => { asked++; return []; }, loadDay: async () => { throw new Error("must not load"); } };
    const r = await runBench(reader, opts({ mode: "live", live_ack: false }));
    expect(r.status).toBe("refused");
    expect(r.refusal!.reason).toContain("live_not_authorised");
    expect(asked).toBe(0);
  });

  it("live mode with the word excludes scratch days (spec §7) and scores the rest", async () => {
    const real = { ...structuredClone(FIXTURE.days[0]), room_day_id: "rd_real_day", scratch: false };
    const { reader } = countingReader([FIXTURE.days[1], real]);
    const r = await runBench(reader, opts({ mode: "live", live_ack: true, room_days: ["rd_bench_fixture_b", "rd_real_day"] }));
    expect(r.status).toBe("ok");
    expect(r.dataset.excluded).toContainEqual({ room_day_id: "rd_bench_fixture_b", reason: "scratch_day_excluded_in_live_mode" });
    expect(r.dataset.room_days_loaded).toBe(1);
  });

  it("an unknown room-day id is excluded and named, not a crash", async () => {
    const r = await runBench(fixtureReader(FIXTURE), opts({ room_days: ["rd_bench_fixture_a", "rd_nowhere"] }));
    expect(r.dataset.excluded).toContainEqual({ room_day_id: "rd_nowhere", reason: "room_day_not_found" });
  });
});

// ------------------------------------------------------------------------------------------------
describe("J4 — the database reader", () => {
  /** A tag that records every statement and answers from `rows(sqlText)`. */
  const tag = (rows: (text: string) => unknown[] | Error) => {
    const seen: string[] = [];
    const sql: Sql = (strings) => {
      const text = strings.join("?");
      seen.push(text);
      const out = rows(text);
      return out instanceof Error ? Promise.reject(out) : Promise.resolve(out);
    };
    return { sql, seen };
  };
  const missing = (t: string) => new Error(`relation "${t}" does not exist`);

  it("every statement is a SELECT; none writes; none reads visit.ambiguity, a transcript or a name", async () => {
    const { sql, seen } = tag((t) => {
      if (t.includes("FROM jev_window_signal")) return [{ window_id: "w1", room_day_id: "rd", session_id: "s1", start_ms: "0", end_ms: "30000", phase: "history", phase_probs: {}, phase_confidence: 0.9, p_start: 0.9, p_end: 0.1, p_clinician: 0.9, p_clinical: 0.9, model: "m", prompt_version: "jev-arm-d-v1", input_tokens: 10, batch_id: "b", created_iso: "2026-09-01T12:00:00.000Z" }];
      if (t.includes("FROM jev_role_signal")) return [{ window_id: "w1", speaker_idx: 0, role: "patient", role_confidence: 0.8 }];
      if (t.includes("FROM room_turn_speaker")) return [{ window_id: "w1", speaker_idx: 0, acoustic: false }];
      if (t.includes("FROM llm_traces")) return [{ total_ms: 800 }];
      if (t.includes("count(*)")) return [{ windows: "1", text_rows: "1", english_nonempty: "1" }];
      if (t.includes("FROM room_day")) return [{ id: "rd", scratch: true }];
      return [];
    });
    const day = await dbReader(sql).loadDay("rd");
    expect(day.jev_signals).toHaveLength(1);
    expect(day.role_signals).toHaveLength(1);
    expect(day.jev_trace_total_ms).toEqual([800]);
    expect(day.english_coverage).toEqual({ windows: 1, text_rows: 1, english_nonempty: 1 });
    expect(seen.length).toBeGreaterThan(5);
    for (const t of seen) {
      expect(t.trim().toUpperCase().startsWith("SELECT")).toBe(true);
      expect(t).not.toMatch(/\b(INSERT|UPDATE|DELETE|DROP|ALTER|TRUNCATE|CREATE)\b/i);
      expect(t).not.toMatch(/ambiguity/i);
      expect(t).not.toMatch(/transcript|english\s*,|\bfull_name\b|\bname\b|email|phone|payload->>/i);
    }
  });

  it("timestamps leave the database as ISO strings: every statement that selects one goes through to_char in UTC", async () => {
    const t = tag((q) => (q.includes("FROM jev_window_signal") ? [{ window_id: "w1", room_day_id: "rd", session_id: "s1", start_ms: 0, end_ms: 30000, phase: "history", phase_probs: {}, phase_confidence: 1, p_start: 0, p_end: 0, p_clinician: 0, p_clinical: 0, model: "m", prompt_version: "v", input_tokens: 1, batch_id: "b", created_iso: "2026-09-01T12:00:00.000Z" }] : []));
    await dbReader(t.sql).loadDay("rd");
    for (const table of ["FROM cue", "FROM jev_window_signal", "FROM bench_session", "FROM visit"]) {
      const stmt = t.seen.find((x) => x.includes(table));
      expect(stmt, table).toBeDefined();
      expect(stmt!).toContain("to_char(");
      expect(stmt!).toContain("AT TIME ZONE 'UTC'");
    }
  });

  it("a missing jev_window_signal (0106 unapplied — the live state today) is an ABSENT arm with the migration named, not a throw and not a zero", async () => {
    const { sql } = tag((t) => (t.includes("FROM jev_window_signal") ? missing("jev_window_signal") : t.includes("FROM jev_role_signal") ? missing("jev_role_signal") : t.includes("FROM room_day") ? [{ id: "rd", scratch: true }] : []));
    const day = await dbReader(sql).loadDay("rd");
    expect(day.jev_signals).toBeNull();
    expect(day.jev_signals_absent).toContain("0106");
    expect(day.role_signals_absent).toContain("0107");
    // and the whole bench still runs: rules alone is scored, jev is named absent
    const cues = [cue("m1", "consult_mark", "2026-09-01T04:00:00.000Z")];
    const reader = { roomDayMeta: async () => [{ id: "rd", scratch: true }], loadDay: async () => ({ ...day, cues }) };
    const r = await runBench(reader, opts({ room_days: ["rd"], arms: ["rules", "jev"] }));
    expect(r.status).toBe("ok");
    expect(r.arms.jev).toMatchObject({ available: false });
    expect(Object.keys(r.arms.jev!.unavailable_days).join(" ")).toContain("0106");
    expect(r.arms.rules!.available).toBe(true);
    expect(r.unverified.join(" ")).toContain("jev: ABSENT");
    // regression (found by the live scratch-day dry run): the dataset's truth count comes from the truth,
    // not from Arm D's score, so an absent Arm D cannot make it read 0
    expect(r.dataset).toMatchObject({ room_days_common: 1, truth_opens_common: 1 });
    expect(r.notes.join(" ")).toContain("Truth opens on the common days: 1");
  });

  it("an error that is NOT a missing table propagates", async () => {
    const { sql } = tag((t) => (t.includes("FROM jev_window_signal") ? new Error("connection reset") : []));
    await expect(dbReader(sql).loadDay("rd")).rejects.toThrow("connection reset");
  });

  it("the cue timestamp reaches the arms as the ISO string the SQL produced", async () => {
    const { sql } = tag((t) => (t.includes("FROM cue") ? [{ id: "c1", type: "consult_mark", payload: { individual_uid: "u" }, source: null, source_ref: null, at_iso: "2026-09-01T04:00:00.123Z" }] : t.includes("FROM jev_window_signal") ? missing("jev_window_signal") : []));
    const day = await dbReader(sql).loadDay("rd");
    expect(day.cues[0]).toMatchObject({ id: "c1", at: "2026-09-01T04:00:00.123Z" });
  });
});

// ------------------------------------------------------------------------------------------------
describe("J4 — the command line", () => {
  const mkDeps = (env: Record<string, string | undefined> = {}, files: Record<string, string> = {}) => {
    const out: Record<string, string> = {};
    const logs: string[] = [];
    const deps: CliDeps = {
      env,
      readText: (p) => (p in files ? files[p] : null),
      writeText: (p, t) => { out[p] = t; },
      makeDbReader: () => { throw new Error("must not build a database reader in fixture mode"); },
      now: () => new Date(Date.UTC(2026, 8, 19)),
      log: (l) => logs.push(l),
    };
    return { deps, out, logs };
  };
  const FIX_PATH = "tests/fixtures/jev/bench-fixture.json";
  const fixtureFiles = { [FIX_PATH]: readFileSync(FIX_PATH, "utf8"), "labels.csv": LABELS };

  it("a fixture run writes the JSON and the markdown beside it, and exits 0", async () => {
    const { deps, out, logs } = mkDeps({}, fixtureFiles);
    const code = await main(["--fixture", FIX_PATH, "--out", "out/x.json", "--bootstrap", "100", "--role-labels", "labels.csv"], deps);
    expect(code).toBe(0);
    expect(Object.keys(out).sort()).toEqual(["out/x.json", "out/x.md"]);
    const report = JSON.parse(out["out/x.json"]);
    expect(report).toMatchObject({ schema: "jev-bench/1", status: "ok", date: "19-SEP-2026", mode: "dry-run", verdict_status: "directional_only" });
    expect(report.role.accuracy.status).toBe("measured");
    expect(out["out/x.md"]).toContain("Jev bench");
    expect(logs.join("\n")).toContain("truth_opens=5");
  });

  it("the default output path is docs/handoff/scratch/jev-bench-<DD-MON-YYYY>.{json,md}", async () => {
    const { deps, out } = mkDeps({}, fixtureFiles);
    await main(["--fixture", FIX_PATH, "--bootstrap", "10"], deps);
    expect(Object.keys(out).sort()).toEqual(["docs/handoff/scratch/jev-bench-19-SEP-2026.json", "docs/handoff/scratch/jev-bench-19-SEP-2026.md"]);
    expect(dateLabel(new Date(Date.UTC(2026, 0, 5)))).toBe("05-JAN-2026");
  });

  it("with the default label path absent, role accuracy is reported UNVERIFIED (nothing invented)", async () => {
    const { deps, out } = mkDeps({}, { [FIX_PATH]: fixtureFiles[FIX_PATH] });
    await main(["--fixture", FIX_PATH, "--out", "o.json", "--bootstrap", "10"], deps);
    expect(JSON.parse(out["o.json"]).role.accuracy.status).toBe("UNVERIFIED");
  });

  it("thresholds are parameters on the command line and reach the verdicts", async () => {
    const { deps, out } = mkDeps({}, fixtureFiles);
    await main(["--fixture", FIX_PATH, "--out", "t.json", "--bootstrap", "10", "--thresholds", "open_recall=0.95,median_open_error_s=30"], deps);
    const v = Object.fromEntries((JSON.parse(out["t.json"]).verdicts as { metric: string; threshold: number; meets_point: boolean }[]).map((x) => [x.metric, x]));
    expect(v.open_recall).toMatchObject({ threshold: 0.95, meets_point: false });
    expect(v.median_open_error_s).toMatchObject({ threshold: 30, meets_point: false });
    expect(v.open_precision.threshold).toBe(0.8);
  });

  it("--mode live without the environment word exits 2 and says so; with a scratch-only fixture the live run scores nothing", async () => {
    const { deps, out, logs } = mkDeps({}, fixtureFiles);
    expect(await main(["--fixture", FIX_PATH, "--out", "l.json", "--mode", "live"], deps)).toBe(2);
    expect(JSON.parse(out["l.json"]).status).toBe("refused");
    expect(logs.join("\n")).toContain("live_not_authorised");
    const ok = mkDeps({ [LIVE_ACK_ENV]: LIVE_ACK_VALUE }, fixtureFiles);
    expect(await main(["--fixture", FIX_PATH, "--out", "l2.json", "--mode", "live", "--bootstrap", "10"], ok.deps)).toBe(0);
    expect(JSON.parse(ok.out["l2.json"]).dataset.room_days_loaded).toBe(0); // every fixture day is scratch → excluded in live mode
  });

  it("dry-run over a non-scratch fixture day exits 2", async () => {
    const fx = structuredClone(FIXTURE);
    fx.days[0].scratch = false;
    const { deps } = mkDeps({}, { [FIX_PATH]: JSON.stringify(fx) });
    expect(await main(["--fixture", FIX_PATH, "--out", "r.json"], deps)).toBe(2);
  });

  it("database mode names APP_DATABASE_URL by name when it is missing, and never prints a value", async () => {
    const { deps, logs } = mkDeps({});
    expect(await main(["--room-days", "rd_x"], deps)).toBe(1);
    expect(logs.join("\n")).toContain("APP_DATABASE_URL is not set");
    const set = mkDeps({ APP_DATABASE_URL: "postgres://u:secret@host/db" });
    set.deps.makeDbReader = () => ({ roomDayMeta: async () => [], loadDay: async () => { throw new Error("no"); } });
    await main(["--room-days", "rd_x", "--out", "d.json", "--bootstrap", "10"], set.deps);
    expect(set.logs.join("\n") + Object.values(set.out).join("\n")).not.toContain("secret");
  });

  it("--room-days reads a file (one id per line, # comments) or a csv", async () => {
    const seen: string[][] = [];
    const { deps } = mkDeps({ APP_DATABASE_URL: "x" }, { "days.txt": "rd_a\n# skip me\nrd_b # inline\n\nrd_a\n" });
    deps.makeDbReader = () => ({ roomDayMeta: async (ids) => { seen.push([...ids]); return []; }, loadDay: async () => { throw new Error("no"); } });
    await main(["--room-days", "days.txt", "--out", "f.json", "--bootstrap", "10"], deps);
    await main(["--room-days", "rd_c, rd_d", "--out", "f.json", "--bootstrap", "10"], deps);
    expect(seen).toEqual([["rd_a", "rd_b"], ["rd_c", "rd_d"]]);
  });

  it("bad arguments exit 1 with the usage text; --help exits 0", async () => {
    for (const argv of [["--nope"], ["--arms", "rules,gpt"], ["--mode", "yolo"], ["--tolerance-s", "soon"], ["--thresholds", "bogus=1"], ["--out"]]) {
      const { deps, logs } = mkDeps({}, fixtureFiles);
      expect(await main(argv, deps)).toBe(1);
      expect(logs.join("\n")).toContain("error:");
    }
    const h = mkDeps();
    expect(await main(["--help"], h.deps)).toBe(0);
    expect(h.logs.join("\n")).toBe(USAGE);
  });

  it("parseArgs defaults are the spec's: ±180 s, ±60 s calibration radius, 100-open floor, all four arms, dry-run", () => {
    const a = parseArgs([]);
    expect(a.params).toMatchObject({ tolerance_s: 180, calib_radius_s: 60, min_truth_opens: 100 });
    expect(a.arms).toEqual(["rules", "hybrid", "flash", "jev"]);
    expect(a.mode).toBe("dry-run");
    expect(a.params.thresholds).toEqual(DEFAULT_THRESHOLDS);
  });
});

// ------------------------------------------------------------------------------------------------
describe("J4 — Reviewer findings, each with its concrete failing input", () => {
  it("F1 the matcher is MAXIMUM, not greedy: truths 0 s and 100 s, predictions 90 s and 200 s → both hit", () => {
    const m = matchOneToOne([0, 100_000], [90_000, 200_000], 180_000);
    expect(m.truth_hit).toEqual([true, true]);
    expect(m.pred_hit).toEqual([true, true]);
    expect(m.pairs.map((x) => [x.ti, x.pi])).toEqual([[0, 0], [1, 1]]);
  });

  it("F1 among maximum matchings the one with the least total error wins; crossing input is uncrossed; empty sides are fine", () => {
    // one prediction, two truths inside tolerance: it goes to the nearer
    expect(matchOneToOne([0, 100_000], [90_000], 180_000).pairs).toEqual([{ ti: 1, pi: 0, err_ms: 10_000 }]);
    // predictions given out of order still pair the sorted way
    const m = matchOneToOne([0, 100_000], [200_000, 90_000], 180_000);
    expect(m.pairs.map((x) => [x.ti, x.pi]).sort()).toEqual([[0, 1], [1, 0]]);
    expect(matchOneToOne([], [1, 2], 10).pairs).toEqual([]);
    expect(matchOneToOne([1, 2], [], 10).truth_hit).toEqual([false, false]);
  });

  it("F1 the maximum matching cannot exceed either side, and never pairs outside the tolerance", () => {
    const rnd = mulberry32(3);
    for (let round = 0; round < 200; round++) {
      const t = Array.from({ length: 1 + Math.floor(rnd() * 6) }, () => Math.floor(rnd() * 1_000_000));
      const q = Array.from({ length: Math.floor(rnd() * 6) }, () => Math.floor(rnd() * 1_000_000));
      const m = matchOneToOne(t, q, 180_000);
      expect(m.pairs.length).toBeLessThanOrEqual(Math.min(t.length, q.length));
      for (const x of m.pairs) expect(Math.abs(t[x.ti] - q[x.pi])).toBeLessThanOrEqual(180_000);
      expect(new Set(m.pairs.map((x) => x.ti)).size).toBe(m.pairs.length);
      expect(new Set(m.pairs.map((x) => x.pi)).size).toBe(m.pairs.length);
    }
  });

  it("F2 two genuine consult_marks 100 s apart are TWO truth opens; only a mark and a warehouse pstart pair", () => {
    const marks = deriveTruth([cue("m1", "consult_mark", "2026-09-01T04:00:00.000Z"), cue("m2", "consult_mark", "2026-09-01T04:01:40.000Z")], DEFAULT_PARAMS);
    expect(marks.opens).toHaveLength(2);
    const pstarts = deriveTruth([cue("p1", "pstart", "2026-09-01T04:00:00.000Z", { source: "warehouse" }), cue("p2", "pstart", "2026-09-01T04:01:00.000Z", { source: "warehouse" })], DEFAULT_PARAMS);
    expect(pstarts.opens).toHaveLength(2);
    // two marks and ONE pstart between them: the nearer mark is the pstart's twin, the other stays a mark
    const mixed = deriveTruth([cue("m1", "consult_mark", "2026-09-01T04:00:00.000Z"), cue("p1", "pstart", "2026-09-01T04:01:00.000Z", { source: "warehouse" }), cue("m2", "consult_mark", "2026-09-01T04:01:40.000Z")], DEFAULT_PARAMS);
    expect(mixed.opens.map((o) => o.source).sort()).toEqual(["consult_mark", "pstart"]);
  });

  it("F3 a jev_window_signal row with NULL created_at cannot throw the run: no trace span, no RangeError", async () => {
    const row = { window_id: "w1", room_day_id: "rd", session_id: "s1", start_ms: 0, end_ms: 30000, phase: "history", phase_probs: {}, phase_confidence: 0.9, p_start: 0.9, p_end: 0.1, p_clinician: 0.9, p_clinical: 0.9, model: "m", prompt_version: "v", input_tokens: 5, batch_id: "b", created_iso: null };
    const sql: Sql = (strings) => Promise.resolve(strings.join("?").includes("FROM jev_window_signal") ? [row] : []);
    const day = await dbReader(sql).loadDay("rd");
    expect(day.jev_signals).toHaveLength(1);
    expect(day.jev_trace_total_ms).toBeNull();
  });

  it("F4 a NULL number is NOT a confident zero: the row is dropped and counted, never scored", async () => {
    const good = { window_id: "w1", room_day_id: "rd", session_id: "s1", start_ms: 0, end_ms: 30000, phase: "history", phase_probs: {}, phase_confidence: 0.9, p_start: 0.9, p_end: 0.1, p_clinician: 0.9, p_clinical: 0.9, model: "m", prompt_version: "v", input_tokens: 5, batch_id: "b", created_iso: "2026-09-01T12:00:00.000Z" };
    const nullStart = { ...good, window_id: "w2", p_start: null };
    const nullOffset = { ...good, window_id: "w3", start_ms: null };
    const mk = (rows: unknown[]): Sql => (strings) => Promise.resolve(strings.join("?").includes("FROM jev_window_signal") ? rows : []);
    const day = await dbReader(mk([good, nullStart, nullOffset])).loadDay("rd");
    expect(day.jev_signals!.map((x) => x.window_id)).toEqual(["w1"]);
    expect(day.jev_signals_invalid).toBe(2);
    const all = await dbReader(mk([nullStart])).loadDay("rd");
    expect(all.jev_signals).toBeNull();
    expect(all.jev_signals_absent).toContain("invalid");
    const r = await runBench({ roomDayMeta: async () => [{ id: "rd", scratch: true }], loadDay: async () => ({ ...day, cues: [cue("m1", "consult_mark", "2026-09-01T04:00:00.000Z")], sessions: [{ id: "s1", started_at: "2026-09-01T04:00:00.000Z", ended_at: null }] }) }, opts({ room_days: ["rd"], arms: ["jev"] }));
    expect(r.notes.join(" ")).toContain("2 jev_window_signal row(s) were dropped");
  });

  it("F5 windows after the last open are UNLABELLED for p_end when its close is unknown — left out, not scored as misses", async () => {
    const r = await runBench(fixtureReader(FIXTURE), opts());
    const e = r.arms.jev!.calibration!.p_end!;
    expect(e.unlabelled_tail_excluded).toBe(22); // day a: windows 48–59 (12), day b: windows 40–49 (10)
    // day a: 60 windows − 12 tail = 48; day b: 50 windows − 2 skipped (excluded first) − 10 tail = 38
    expect(e.n).toBe(86);
    expect(e.skipped_windows_excluded).toBe(2);
  });

  it("F6 a predicted visit with no open instant can never match, so it is a false positive for open precision", () => {
    const truth = { opens: [{ ms: 1_000_000, source: "consult_mark" as const }], closes: [null] };
    const mkPred = (open_ms: number | null) => ({ open_ms, close_ms: null, open_from: "none" as const, state: "unknown", reasons: [], end_reason: null });
    const sc = scoreArm([{ room_day_id: "d", truth, preds: [mkPred(1_000_000), mkPred(null)] }], P);
    expect(sc.open.precision).toMatchObject({ k: 1, n: 2 });
    expect(sc.open.predicted_without_instant).toBe(1);
    expect(sc.open.recall).toMatchObject({ k: 1, n: 1 });
  });

  it("F7 an arm with output on a strict subset of days is NAMED as the thing limiting the common set", async () => {
    const one = structuredClone(FIXTURE);
    one.days[0].persisted = { flash: [{ arm: "flash", state: "in_chair", pstart_at: "2026-09-01T04:05:00.000Z", ended_at: null, tape_start_ms: null, opened_by: "x" }] };
    const r = await runBench(fixtureReader(one), opts({ arms: ["rules", "flash", "jev"] }));
    expect(r.dataset.room_days_common).toBe(1);
    expect(r.notes.join(" ")).toContain("Common days are limited by flash: it has output on 1 of 2 truth day(s)");
    expect(r.arms.jev!.own_days!.truth_opens).toBe(5); // Arm D's own-day score still covers both days
  });

  it("F8 a missing table is recognised by SQLSTATE 42P01 even when the message says nothing useful", async () => {
    const err = Object.assign(new Error("server error"), { code: "42P01" });
    const sql: Sql = (strings) => (strings.join("?").includes("FROM jev_window_signal") || strings.join("?").includes("FROM jev_role_signal") ? Promise.reject(err) : Promise.resolve(strings.join("?").includes("FROM room_day") ? [{ id: "rd", scratch: true }] : []));
    const day = await dbReader(sql).loadDay("rd");
    expect(day.jev_signals_absent).toContain("0106");
    expect(day.role_signals_absent).toContain("0107");
  });

  it("F9 a signal whose session is unknown makes the day UNAVAILABLE by name — never a 1970 visit scored as a miss", async () => {
    const fx = structuredClone(FIXTURE);
    fx.days[0].sessions = []; // signals name bs_fx_a, the day carries no such session
    const r = await runBench(fixtureReader(fx), opts({ arms: ["rules", "jev"] }));
    expect(Object.keys(r.arms.jev!.unavailable_days).join(" ")).toContain("session_missing_for_60_signal_window(s)");
    expect(r.arms.jev!.days_with_output).toBe(1); // only day b
  });

  it("F9 jev-native signals may name sessions the day did not: the reader is asked for them", async () => {
    const fx = structuredClone(FIXTURE);
    const native = { rd_bench_fixture_a: structuredClone(FIXTURE.days[0].jev_signals!) };
    const inner = fixtureReader(fx);
    const asked: string[][] = [];
    fx.days[0].sessions = [];
    const reader = { ...inner, sessionsById: async (ids: readonly string[]) => { asked.push([...ids]); return [{ id: "bs_fx_a", started_at: "2026-09-01T04:00:00.000Z", ended_at: null }]; } };
    const r = await runBench(reader, opts({ room_days: ["rd_bench_fixture_a"], arms: ["jev-native"], native_signals: native as never }));
    expect(asked).toEqual([["bs_fx_a"]]);
    expect(r.arms["jev-native"]!.common_days!.open.recall).toMatchObject({ n: 3 });
  });

  it("F10 threshold and arm parsing: prototype keys, a bare key, and an empty arm list are errors", () => {
    expect(() => parseThresholds("toString=5")).toThrow("unknown_threshold");
    expect(() => parseThresholds("constructor=1")).toThrow("unknown_threshold");
    expect(() => parseThresholds("open_recall")).toThrow("bad_threshold_spec");
    expect(() => parseArgs(["--arms", ","])).toThrow("no_arms");
  });

  it("R7 the latency summary carries an interval too", async () => {
    const r = await runBench(fixtureReader(FIXTURE), opts());
    expect(r.arms.jev!.latency!.per_call_total_ms.median_ci_ms).not.toBeNull();
  });
});

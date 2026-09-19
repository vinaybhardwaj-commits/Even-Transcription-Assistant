/**
 * lib/jev/bench-run.ts — Slice J4: runs the bench over a `BenchReader` and returns one JSON-able
 * report plus its markdown. No filesystem, no env, no network — the CLI (scripts/jev-bench.ts)
 * owns those, so a test can drive the whole thing from a fixture.
 *
 * MODES. `dry-run` (the default) accepts ONLY `room_day.scratch = true` days and refuses the whole
 * run, naming the offenders, if any other is asked for. `live` is the J4 run itself: it needs the
 * caller to say it holds V's word (`live_ack`), and it drops scratch days (spec §7 excludes them).
 * The bench never writes; there is no mode in which it does.
 *
 * WHICH ARMS ARE RUN HERE. `rules` and `jev` are PURE functions of the cue list and the signal
 * rows, so they are recomputed in-process — which is also what keeps `DraftVisit.reasons` and
 * `ended_at` in hand. The persisted row loses both: `visit.ambiguity` is the reasons deduplicated,
 * reordered and comma-joined, and `writeVisits` nulls `ended_at`/`end_reason` for an `in_chair` visit.
 * `hybrid` and `flash` call Gemini; the bench does not, so it reads whatever `visit` rows those
 * arms already wrote and calls the arm ABSENT when there are none. `jev-native` (J0 option C) needs
 * a second signal set that `jev_window_signal`'s one-row-per-window key cannot hold beside the
 * first; it takes a signal file from the caller and is absent without one.
 *
 * SCORING BASIS. Only room-days with at least one truth open are scored (a day with no mark has
 * no truth, not truth of "no visits"), and the headline numbers use the COMMON days — those every
 * available arm produced output for — so no arm is judged on days another was never asked.
 */
import { runRulesArm } from "@/lib/brain/fuse/rules";
import { runJevArm } from "@/lib/brain/fuse/jev-arm";
import type { DraftVisit } from "@/lib/brain/fuse/types";
import {
  TRUTH_IN_INPUT, anchorSignals, bootstrapCI, calibrationPairs, cueInstants, dayCost, deriveTruth, dist, judge, latencySummary, pairedOpenRecall,
  predFromDraft, predFromVisit, reliability, roleMetrics, scoreArm, verdictStatus,
  type ArmScore, type BenchArm, type BenchParams, type DayCost, type DayScoreInput, type Dist, type PairedOpenRecall, type Rate, type Reliability,
  type RoleLabel, type RoleReport, type Truth, type Verdict,
} from "./bench";
import type { BenchDay, BenchJevSignal, BenchReader } from "./bench-reader";

export type BenchOptions = {
  mode: "dry-run" | "live";
  /** true ONLY when the caller holds V's explicit word for J4 (the CLI reads it from the environment) */
  live_ack: boolean;
  arms: BenchArm[];
  room_days: string[];
  params: BenchParams;
  role_labels: { labels: RoleLabel[]; invalid_rows: number } | null;
  /** jev-native signals by room_day_id, from a file the caller loaded */
  native_signals?: Record<string, BenchJevSignal[]>;
  /** a label for the report; the bench never reads a clock */
  date: string;
};

type ArmRun = {
  days: Map<string, DayScoreInput>;
  unavailable: Map<string, string>;
  firing: Record<string, number>;
  end_reasons: Record<string, number>;
  visits_total: number;
};

export type ArmReport = {
  source: "recomputed_pure" | "persisted_visit_rows" | "signals_file";
  available: boolean;
  truth_in_input: boolean;
  days_with_output: number;
  unavailable_days: Record<string, number>;
  common_days: ArmScore | null;
  own_days: ArmScore | null;
  firing_rules?: Record<string, number>;
  end_reasons?: Record<string, number>;
  calibration?: { p_start: (Reliability & { skipped_windows_excluded: number; unanchored_windows: number }) | null; p_end: (Reliability & { skipped_windows_excluded: number; unanchored_windows: number; days_used: number; unlabelled_tail_excluded: number }) | null };
  cost?: { per_day: { room_day_id: string; cost: DayCost }[]; usd_per_room_day: Dist; input_tokens_total: number; days_over_threshold: number; threshold_usd: number };
  latency?: { attribution: "approximate: llm_traces carry no room_day_id"; per_call_total_ms: { n: number; median_ms: number | null; p90_ms: number | null; median_ci_ms: [number, number] | null }; per_room_day: { room_day_id: string; n: number; median_ms: number | null; p90_ms: number | null }[] };
};

export type BenchReport = {
  schema: "jev-bench/1";
  date: string;
  mode: BenchOptions["mode"];
  status: "ok" | "refused";
  refusal?: { reason: string; room_days: string[] };
  params: BenchParams;
  dataset: {
    room_days_requested: number;
    room_days_loaded: number;
    room_days_with_truth: number;
    room_days_common: number;
    truth_opens_common: number;
    truth_closes_common: number;
    excluded: { room_day_id: string; reason: string }[];
    days_detail: { room_day_id: string; truth_opens: number; truth_closes: number; cues: number; jev_signal_windows: number; english_coverage: BenchDay["english_coverage"] }[];
  };
  arms: Partial<Record<BenchArm, ArmReport>>;
  comparison: { jev_vs_rules?: PairedOpenRecall; jev_native_vs_jev?: PairedOpenRecall; statement: string };
  role: RoleReport | null;
  verdict_status: "directional_only" | "eligible";
  verdicts: Verdict[];
  notes: string[];
  unverified: string[];
};

const emptyReport = (o: BenchOptions, refusal: NonNullable<BenchReport["refusal"]>): BenchReport => ({
  schema: "jev-bench/1", date: o.date, mode: o.mode, status: "refused", refusal, params: o.params,
  dataset: { room_days_requested: o.room_days.length, room_days_loaded: 0, room_days_with_truth: 0, room_days_common: 0, truth_opens_common: 0, truth_closes_common: 0, excluded: [], days_detail: [] },
  arms: {}, comparison: { statement: "not run: refused" }, role: null, verdict_status: "directional_only", verdicts: [],
  notes: [`REFUSED: ${refusal.reason}. Nothing was read and nothing was computed.`], unverified: [],
});

function tally(into: Record<string, number>, key: string) { into[key] = (into[key] ?? 0) + 1; }

/** The rule that fired, from the arm's own `reasons` — `p_start:0.85` and friends collapse to their name. */
const ruleName = (r: string): string => r.split(":")[0];

function runArmOnDay(arm: BenchArm, day: BenchDay, native: BenchJevSignal[] | null, run: ArmRun, truth: Truth) {
  const at = cueInstants(day.cues);
  let visits: DraftVisit[] | null = null;
  let preds = null as ReturnType<typeof predFromVisit>[] | null;
  if (arm === "rules") {
    visits = runRulesArm(day.cues, { day_complete: true }).visits;
  } else if (arm === "jev" || arm === "jev-native") {
    const sig = arm === "jev" ? day.jev_signals : native;
    if (!sig || sig.length === 0) { run.unavailable.set(day.room_day_id, arm === "jev" ? day.jev_signals_absent ?? "no_signals" : "no_native_signals_for_day"); return; }
    // runJevArm anchors a window with no known session at epoch 0 and says nothing. That is a 1970
    // visit scored as a miss, so a signal without its session makes the day UNAVAILABLE, by name.
    const known = new Set(day.sessions.map((s) => s.id));
    const orphan = sig.filter((s) => !known.has(s.session_id)).length;
    if (orphan > 0) { run.unavailable.set(day.room_day_id, `session_missing_for_${orphan}_signal_window(s)`); return; }
    visits = runJevArm(day.cues, sig, day.sessions).visits;
  } else {
    const rows = day.persisted[arm] ?? [];
    if (rows.length === 0) { run.unavailable.set(day.room_day_id, "no_persisted_visit_rows (the bench does not call the Gemini arms)"); return; }
    preds = rows.map((v) => predFromVisit({ pstart_at: v.pstart_at, ended_at: v.ended_at, tape_start_ms: v.tape_start_ms, opened_by: v.opened_by, state: v.state }, at));
  }
  if (visits) {
    preds = visits.map((v) => predFromDraft(v, at));
    for (const v of visits) {
      for (const r of v.reasons) tally(run.firing, ruleName(r));
      if (v.end_reason) tally(run.end_reasons, v.end_reason);
    }
  }
  run.visits_total += (preds ?? []).length;
  run.days.set(day.room_day_id, { room_day_id: day.room_day_id, truth, preds: preds ?? [] });
}

const sourceOf = (arm: BenchArm): ArmReport["source"] => (arm === "hybrid" || arm === "flash" ? "persisted_visit_rows" : arm === "jev-native" ? "signals_file" : "recomputed_pure");

export async function runBench(reader: BenchReader, o: BenchOptions): Promise<BenchReport> {
  const p = o.params;

  // ---- the guard, before a single cue is read -----------------------------------------------
  if (o.mode === "live" && !o.live_ack) return emptyReport(o, { reason: "live_not_authorised: J4 on real room-days needs V's explicit word", room_days: [] });
  const meta = await reader.roomDayMeta(o.room_days);
  const found = new Map(meta.map((m) => [m.id, m.scratch]));
  const excluded: BenchReport["dataset"]["excluded"] = [];
  const wanted: string[] = [];
  for (const id of o.room_days) {
    if (!found.has(id)) { excluded.push({ room_day_id: id, reason: "room_day_not_found" }); continue; }
    wanted.push(id);
  }
  if (o.mode === "dry-run") {
    const notScratch = wanted.filter((id) => found.get(id) !== true);
    if (notScratch.length > 0) return emptyReport(o, { reason: "not_a_scratch_day: dry-run reads room_day.scratch = true days only", room_days: notScratch });
  } else {
    for (const id of [...wanted]) if (found.get(id) === true) { excluded.push({ room_day_id: id, reason: "scratch_day_excluded_in_live_mode" }); wanted.splice(wanted.indexOf(id), 1); }
  }

  // ---- load, derive truth ------------------------------------------------------------------
  const days: BenchDay[] = [];
  for (const id of wanted) {
    const day = await reader.loadDay(id);
    // a jev-native signal file may name sessions the day's own signals did not
    const native = o.native_signals?.[id];
    if (native && reader.sessionsById) {
      const known = new Set(day.sessions.map((s) => s.id));
      const need = [...new Set(native.map((s) => s.session_id))].filter((sid) => !known.has(sid));
      if (need.length > 0) day.sessions = [...day.sessions, ...(await reader.sessionsById(need))];
    }
    days.push(day);
  }
  const truthByDay = new Map<string, Truth>();
  for (const d of days) truthByDay.set(d.room_day_id, deriveTruth(d.cues, p));
  const truthDays = days.filter((d) => (truthByDay.get(d.room_day_id)?.opens.length ?? 0) > 0);
  for (const d of days) if (!truthDays.includes(d)) excluded.push({ room_day_id: d.room_day_id, reason: "no_truth_opens" });

  // ---- run each requested arm on each truth day --------------------------------------------
  const runs = new Map<BenchArm, ArmRun>();
  for (const arm of o.arms) {
    const run: ArmRun = { days: new Map(), unavailable: new Map(), firing: {}, end_reasons: {}, visits_total: 0 };
    for (const d of truthDays) runArmOnDay(arm, d, o.native_signals?.[d.room_day_id] ?? d.jev_native_signals, run, truthByDay.get(d.room_day_id) as Truth);
    runs.set(arm, run);
  }
  const available = o.arms.filter((a) => (runs.get(a)?.days.size ?? 0) > 0);
  let common = truthDays.map((d) => d.room_day_id);
  for (const a of available) common = common.filter((id) => runs.get(a)?.days.has(id));
  const commonSet = new Set(common);

  const arms: BenchReport["arms"] = {};
  const scores: Partial<Record<BenchArm, ArmScore>> = {};
  for (const arm of o.arms) {
    const run = runs.get(arm) as ArmRun;
    const unavailable_days: Record<string, number> = {};
    for (const r of run.unavailable.values()) tally(unavailable_days, r);
    const own = [...run.days.values()];
    const commonDays = own.filter((d) => commonSet.has(d.room_day_id));
    const rep: ArmReport = {
      source: sourceOf(arm), available: own.length > 0, truth_in_input: TRUTH_IN_INPUT.includes(arm), days_with_output: own.length, unavailable_days,
      common_days: own.length > 0 && commonDays.length > 0 ? scoreArm(commonDays, p) : null,
      own_days: own.length > 0 ? scoreArm(own, p) : null,
    };
    if (own.length > 0) { rep.firing_rules = run.firing; rep.end_reasons = run.end_reasons; }
    if (rep.common_days) scores[arm] = rep.common_days;

    // ---- the Jev arms: calibration, cost, latency ------------------------------------------
    if (arm === "jev" || arm === "jev-native") {
      const pick = (d: BenchDay) => (arm === "jev" ? d.jev_signals : o.native_signals?.[d.room_day_id] ?? d.jev_native_signals);
      const startPairs: { p: number; y: 0 | 1 }[] = [];
      const endPairs: { p: number; y: 0 | 1 }[] = [];
      let skipS = 0, skipE = 0, unS = 0, unE = 0, endDays = 0, tailE = 0;
      for (const d of truthDays.filter((x) => commonSet.has(x.room_day_id))) {
        const sig = pick(d);
        if (!sig) continue;
        const truth = truthByDay.get(d.room_day_id) as Truth;
        const starts = new Map(d.sessions.map((s) => [s.id, Date.parse(s.started_at)]));
        const { anchored, unanchored } = anchorSignals(sig, starts);
        const s1 = calibrationPairs(anchored, truth.opens.map((t) => t.ms), p.calib_radius_s * 1000, "p_start");
        startPairs.push(...s1.pairs); skipS += s1.skipped_excluded; unS += unanchored;
        // p_end negatives are only negatives on a day that HAS close truth; elsewhere they are unlabelled.
        const closeMs = truth.closes.flatMap((c) => (c ? [c.ms] : []));
        if (closeMs.length > 0) {
          // If the last visit has no close truth, everything from its open onward is UNLABELLED for p_end,
          // not a run of negatives: leave it out rather than score a real end as a miss.
          const lastClose = truth.closes[truth.closes.length - 1];
          const tail = lastClose === null ? truth.opens[truth.opens.length - 1].ms : Infinity;
          const e1 = calibrationPairs(anchored, closeMs, p.calib_radius_s * 1000, "p_end", tail);
          endPairs.push(...e1.pairs); skipE += e1.skipped_excluded; unE += unanchored; endDays++; tailE += e1.unlabelled_excluded;
        }
      }
      rep.calibration = {
        p_start: startPairs.length ? { ...reliability(startPairs, 10, p.bootstrap, p.seed + 20), skipped_windows_excluded: skipS, unanchored_windows: unS } : null,
        p_end: endPairs.length ? { ...reliability(endPairs, 10, p.bootstrap, p.seed + 21), skipped_windows_excluded: skipE, unanchored_windows: unE, days_used: endDays, unlabelled_tail_excluded: tailE } : null,
      };
      const perDay = days.filter((d) => (arm === "jev" ? d.jev_signals : o.native_signals?.[d.room_day_id] ?? d.jev_native_signals)).map((d) => ({
        room_day_id: d.room_day_id, cost: dayCost((arm === "jev" ? d.jev_signals : o.native_signals?.[d.room_day_id] ?? d.jev_native_signals) as BenchJevSignal[], p.usd_per_billion_tokens),
      }));
      if (perDay.length > 0) {
        rep.cost = {
          per_day: perDay, usd_per_room_day: dist(perDay.map((x) => x.cost.usd), p.bootstrap, p.seed + 30),
          input_tokens_total: perDay.reduce((a, x) => a + x.cost.input_tokens, 0), days_over_threshold: perDay.filter((x) => x.cost.usd > p.thresholds.cost_usd_per_room_day).length, threshold_usd: p.thresholds.cost_usd_per_room_day,
        };
      }
      if (arm === "jev") {
        const ms = days.flatMap((d) => d.jev_trace_total_ms ?? []);
        rep.latency = { attribution: "approximate: llm_traces carry no room_day_id", per_call_total_ms: { ...latencySummary(ms), median_ci_ms: bootstrapCI(ms, (v) => latencySummary(v).median_ms, p.bootstrap, p.seed + 40) }, per_room_day: days.filter((d) => d.jev_trace_total_ms).map((d) => ({ room_day_id: d.room_day_id, ...latencySummary(d.jev_trace_total_ms as number[]) })) };
      }
    }
    arms[arm] = rep;
  }

  // ---- comparison --------------------------------------------------------------------------
  const cmp: BenchReport["comparison"] = { statement: "" };
  const statements: string[] = [];
  if (scores.jev && scores.rules) {
    cmp.jev_vs_rules = pairedOpenRecall(scores.jev, scores.rules, "Arm D (jev)", "Arm A (rules)");
    statements.push(cmp.jev_vs_rules.statement + " Arm A opens its visits FROM the consult_mark cues the truth is built from, so its recall here is inflated by construction.");
  } else statements.push("Arm D versus Arm A was not computed: " + (!scores.jev ? "Arm D has no output on the common truth days" : "Arm A has no output on the common truth days") + ".");
  if (scores["jev-native"] && scores.jev) { cmp.jev_native_vs_jev = pairedOpenRecall(scores["jev-native"], scores.jev, "jev-native", "jev (translated)"); statements.push(cmp.jev_native_vs_jev.statement); }
  cmp.statement = statements.join(" ");

  // ---- roles -------------------------------------------------------------------------------
  const roleSignals = days.flatMap((d) => d.role_signals ?? []);
  const role = roleSignals.length > 0 || o.role_labels ? roleMetrics(roleSignals, o.role_labels ? o.role_labels.labels : null, p.role_t, o.role_labels?.invalid_rows ?? 0) : null;

  // ---- verdicts (Arm D) --------------------------------------------------------------------
  const jev = arms.jev;
  const verdicts: Verdict[] = [];
  const t = p.thresholds;
  const js = jev?.common_days ?? null;
  verdicts.push(judge("open_recall", t.open_recall, ">=", js?.open.recall.value ?? null, js?.open.recall.ci ?? null, js?.open.recall.n ?? 0));
  verdicts.push(judge("open_precision", t.open_precision, ">=", js?.open.precision.value ?? null, js?.open.precision.ci ?? null, js?.open.precision.n ?? 0));
  verdicts.push(judge("median_open_error_s", t.median_open_error_s, "<=", js?.open.error_matched_s.median ?? null, js?.open.error_matched_s.median_ci ?? null, js?.open.error_matched_s.n ?? 0));
  const ps = jev?.calibration?.p_start ?? null;
  verdicts.push(judge("ece_p_start", t.ece_p_start, "<=", ps?.ece ?? null, ps?.ece_ci ?? null, ps?.n ?? 0));
  const acc = role && role.accuracy.status === "measured" ? role.accuracy.result : null;
  verdicts.push(judge("role_accuracy", t.role_accuracy, ">=", acc?.value ?? null, acc?.ci ?? null, acc?.n ?? 0));
  const c = jev?.cost;
  verdicts.push(judge("cost_usd_per_room_day", t.cost_usd_per_room_day, "<=", c?.usd_per_room_day.median ?? null, c?.usd_per_room_day.median_ci ?? null, c?.usd_per_room_day.n ?? 0));

  // ---- notes and UNVERIFIED ----------------------------------------------------------------
  // Counted from the TRUTH on the common days, not from any one arm's score: an arm with no output
  // (Arm D before 0106 is applied) must not make the dataset look empty.
  const truthOpens = common.reduce((a, id) => a + (truthByDay.get(id)?.opens.length ?? 0), 0);
  const truthCloses = common.reduce((a, id) => a + (truthByDay.get(id)?.closes.filter(Boolean).length ?? 0), 0);
  const notes: string[] = [
    `Scored on ${common.length} common room-day(s) with truth (${truthDays.length} had truth of ${days.length} loaded). Truth opens on the common days: ${truthOpens}.`,
    `Every rate carries numerator, denominator and a 95% Wilson interval; distributions carry a seeded bootstrap interval (B=${p.bootstrap}, seed=${p.seed}).`,
    `Thresholds are PROPOSED parameters, not settled: ${JSON.stringify(t)}.`,
    `Verdict status: ${verdictStatus(truthOpens, p.min_truth_opens)} (needs >= ${p.min_truth_opens} truth opens to be eligible; spec §7).`,
    "Firing rules and closes are read from the arm's own DraftVisit (reasons, ended_at), not from the visit row: visit.ambiguity is a deduplicated, reordered, comma-joined encoding, and writeVisits nulls ended_at/end_reason for Arm D's in_chair visits, so a database read would show no closes.",
  ];
  // Name what limits the common set, so one thin arm cannot shrink every headline without being seen.
  for (const a of available) {
    const n = runs.get(a)?.days.size ?? 0;
    if (n < truthDays.length) notes.push(`Common days are limited by ${a}: it has output on ${n} of ${truthDays.length} truth day(s), so every arm is scored on ${common.length}. Each arm's own-day score is in the JSON (own_days).`);
  }
  const invalidRows = days.reduce((x, d) => x + d.jev_signals_invalid, 0);
  if (invalidRows > 0) notes.push(`${invalidRows} jev_window_signal row(s) were dropped: a required number was NULL or not finite.`);
  const unverified: string[] = [];
  for (const arm of ["hybrid", "flash"] as const) if (o.arms.includes(arm) && !arms[arm]?.available) unverified.push(`${arm}: ABSENT — no persisted visit rows on the scored days and the bench does not call the Gemini arms.`);
  if (o.arms.includes("jev-native") && !arms["jev-native"]?.available) unverified.push("jev-native: ABSENT — needs a second signal set (--native-signals); jev_window_signal keys on window_id and cannot hold both, and no migration is allowed here.");
  if (o.arms.includes("jev") && !arms.jev?.available) unverified.push(`jev: ABSENT — ${Object.keys(arms.jev?.unavailable_days ?? {}).join("; ") || "no signals"}.`);
  if (!role || role.accuracy.status !== "measured") unverified.push("role accuracy: UNVERIFIED — " + (role && role.accuracy.status === "UNVERIFIED" ? role.accuracy.reason : "no role signals and no label file") + ".");
  if (role && role.acoustic_agreement.n === 0) unverified.push("acoustic clinician agreement: UNDEFINED — no speaker in scope carries a clinician flag.");
  if (jev?.latency) unverified.push("latency: APPROXIMATE — matched by time span, because llm_traces rows for surface 'jev' carry no room_day_id (lib/jev/client.ts); another job's calls can fall inside the span. Per-room-day latency needs a room_day_id in the trace's request_input.");
  if (jev?.cost) unverified.push("cost: per-window input_tokens is each batch's total divided across its target windows and rounded (J2), so a day's sum can differ from the true total by rounding.");
  const noJ0 = days.filter((d) => d.english_coverage && d.english_coverage.windows > 0 && d.english_coverage.english_nonempty === 0).map((d) => d.room_day_id);
  if (noJ0.length) unverified.push(`J0 has not produced English for ${noJ0.length} day(s) (${noJ0.join(", ")}): Arm D would skip every window there. Run jev-english first (spec §7).`);
  if (days.some((d) => d.english_coverage === null)) unverified.push("J0 coverage: not read for at least one day (jev_window_text absent or not part of the source).");
  unverified.push("truth: the kiosk consult_mark is the instant a person pressed a button, not an independently observed visit start; close truth falls back to the NEXT open, which an arm that closes on next_opener matches by construction.");

  return {
    schema: "jev-bench/1", date: o.date, mode: o.mode, status: "ok", params: p,
    dataset: {
      room_days_requested: o.room_days.length, room_days_loaded: days.length, room_days_with_truth: truthDays.length, room_days_common: common.length,
      truth_opens_common: truthOpens, truth_closes_common: truthCloses, excluded,
      days_detail: days.map((d) => {
        const t = truthByDay.get(d.room_day_id) as Truth;
        return { room_day_id: d.room_day_id, truth_opens: t.opens.length, truth_closes: t.closes.filter(Boolean).length, cues: d.cues.length, jev_signal_windows: d.jev_signals?.length ?? 0, english_coverage: d.english_coverage };
      }),
    },
    arms, comparison: cmp, role, verdict_status: verdictStatus(truthOpens, p.min_truth_opens), verdicts, notes, unverified,
  };
}

// ---------------------------------------------------------------- markdown

const f3 = (x: number | null | undefined) => (x === null || x === undefined || !Number.isFinite(x) ? "n/a" : x.toFixed(3));
const fv = (x: number | null | undefined) => (typeof x === "number" && Number.isFinite(x) && x !== 0 && Math.abs(x) < 0.01 ? x.toPrecision(3) : f3(x));
const f4 = (x: number | null | undefined) => (x === null || x === undefined || !Number.isFinite(x) ? "n/a" : x.toFixed(4));
const f1 = (x: number | null | undefined) => (x === null || x === undefined || !Number.isFinite(x) ? "n/a" : x.toFixed(1));
const ciS = (c: [number, number] | null, f = f3) => (c ? `${f(c[0])}–${f(c[1])}` : "n/a");
const rateS = (r: Rate) => (r.value === null ? "n/a (0/0)" : `${f3(r.value)} (${r.k}/${r.n}, 95% CI ${ciS(r.ci)})`);
const distS = (d: Dist) => (d.n === 0 ? "n/a (n=0)" : `median ${f1(d.median)}s [${ciS(d.median_ci, f1)}], p90 ${f1(d.p90)}s [${ciS(d.p90_ci, f1)}], n=${d.n}`);

export function renderMarkdown(r: BenchReport): string {
  const L: string[] = [];
  L.push(`# Jev bench (${r.schema}) — ${r.date}`, "");
  L.push(`Mode: **${r.mode}**. Status: **${r.status}**. Verdict status: **${r.verdict_status}**.`, "");
  if (r.status === "refused") {
    L.push(`REFUSED: ${r.refusal?.reason}`, r.refusal && r.refusal.room_days.length ? `Room-days: ${r.refusal.room_days.join(", ")}` : "", "");
    return L.join("\n");
  }
  const d = r.dataset;
  L.push("## Dataset", "", `Requested ${d.room_days_requested}, loaded ${d.room_days_loaded}, with truth ${d.room_days_with_truth}, common to every available arm ${d.room_days_common}. Truth opens on the common days: **${d.truth_opens_common}**; truth closes: ${d.truth_closes_common}.`, "");
  if (d.excluded.length) L.push("Excluded: " + d.excluded.map((e) => `${e.room_day_id} (${e.reason})`).join("; "), "");
  L.push("## Acceptance thresholds (proposed, parameters)", "", "| metric | threshold | value | 95% interval | n | meets (point) | interval clears |", "|---|---|---|---|---|---|---|");
  for (const v of r.verdicts) L.push(`| ${v.metric} | ${v.direction} ${v.threshold} | ${fv(v.value)} | ${ciS(v.ci, fv)} | ${v.n} | ${v.meets_point === null ? "not evaluable" : v.meets_point ? "yes" : "no"} | ${v.ci_clears === null ? "n/a" : v.ci_clears ? "yes" : "no"} |`);
  L.push("", r.verdict_status === "directional_only" ? "**Directional only.** Below the truth-open floor no wire-it-in / drop-it verdict is drawn." : "Truth-open floor met.", "");
  L.push("## Arms (common days)", "");
  for (const [name, a] of Object.entries(r.arms) as [BenchArm, ArmReport][]) {
    L.push(`### ${name}`, "");
    L.push(`Source: ${a.source}. ${a.available ? `Output on ${a.days_with_output} day(s).` : "**ABSENT.**"}${a.truth_in_input ? " **Truth is in this arm's input — its open recall is inflated by construction.**" : ""}`);
    if (Object.keys(a.unavailable_days).length) L.push("", "Unavailable: " + Object.entries(a.unavailable_days).map(([k, v]) => `${v}× ${k}`).join("; "));
    const s = a.common_days;
    if (s) {
      L.push("", `- Open recall: ${rateS(s.open.recall)}`, `- Open precision: ${rateS(s.open.precision)}`, `- Open error, matched: ${distS(s.open.error_matched_s)}`, `- Open error, nearest prediction (all truth opens with any prediction that day): ${distS(s.open.error_nearest_s)}`);
      L.push(`- Close recall: ${rateS(s.close.recall)}`, `- Close precision: ${rateS(s.close.precision)}`, `- Close error, matched: ${distS(s.close.error_matched_s)}`);
      L.push(`- Visits: ${s.visits.pred_total} predicted against ${s.visits.truth_total} truth (ratio ${f3(s.visits.ratio)}, mean absolute difference per day ${f3(s.visits.mean_abs_diff_per_day)}); ${s.open.predicted_without_instant} predicted visit(s) had no open instant.`);
    } else if (a.available) L.push("", "No common truth days: nothing scored on the common basis.");
    if (a.firing_rules && Object.keys(a.firing_rules).length) L.push("", "Firing rules (from reasons): " + Object.entries(a.firing_rules).map(([k, v]) => `${k}=${v}`).join(", "));
    if (a.end_reasons && Object.keys(a.end_reasons).length) L.push("End reasons: " + Object.entries(a.end_reasons).map(([k, v]) => `${k}=${v}`).join(", "));
    for (const key of ["p_start", "p_end"] as const) {
      const rel = a.calibration?.[key];
      if (!rel) continue;
      L.push("", `Reliability, ${key} (${rel.n} windows, ${rel.n_positive} positive; ${rel.skipped_windows_excluded} skipped windows excluded${"unlabelled_tail_excluded" in rel ? `, ${(rel as { unlabelled_tail_excluded: number }).unlabelled_tail_excluded} unlabelled tail windows excluded` : ""}): ECE ${f3(rel.ece)} [${ciS(rel.ece_ci)}]`, "", "| bin | n | mean p | observed |", "|---|---|---|---|");
      for (const b of rel.bins) L.push(`| ${b.lo.toFixed(1)}–${b.hi.toFixed(1)} | ${b.n} | ${f3(b.mean_p)} | ${f3(b.observed)} |`);
    }
    if (a.cost) {
      const u = a.cost.usd_per_room_day;
      L.push("", `Cost per room-day (n=${u.n} day(s)): median $${f4(u.median)} [${ciS(u.median_ci, f4)}], p90 $${f4(u.p90)}; ${a.cost.input_tokens_total} input tokens in total; ${a.cost.days_over_threshold} day(s) over $${a.cost.threshold_usd}.`);
    }
    if (a.latency) L.push("", `Latency (${a.latency.attribution}): n=${a.latency.per_call_total_ms.n}, median ${f1(a.latency.per_call_total_ms.median_ms)} ms [${ciS(a.latency.per_call_total_ms.median_ci_ms, f1)}], p90 ${f1(a.latency.per_call_total_ms.p90_ms)} ms; per room-day medians: ${a.latency.per_room_day.map((x) => `${x.room_day_id}=${f1(x.median_ms)}ms (n=${x.n})`).join(", ") || "n/a"}.`);
    L.push("");
  }
  L.push("## Does Jev beat rules?", "", r.comparison.statement, "");
  L.push("## Roles", "");
  if (!r.role) L.push("No role signals and no label file. **UNVERIFIED.**", "");
  else {
    const a = r.role.accuracy;
    L.push(a.status === "measured" ? `Accuracy on labelled non-clinician speakers: ${rateS(a.result)}; all labelled: ${rateS(a.all_labelled)}; ${a.labels_without_signal} label(s) had no signal, ${a.labels_invalid_rows} invalid row(s).` : `Accuracy: **UNVERIFIED** — ${a.reason}`);
    const g = r.role.acoustic_agreement;
    L.push("", `Agreement with the acoustic clinician flag: ${g.value === null ? "UNDEFINED" : `${f3(g.value)} (${g.k}/${g.n}, CI ${ciS(g.ci)})`} — ${g.note}.`, `Left null by the composite: ${r.role.composite_null_share.n_null}/${r.role.composite_null_share.n_speakers} (${f3(r.role.composite_null_share.share)}).`, "");
  }
  L.push("## Notes", "", ...r.notes.map((n) => `- ${n}`), "", "## UNVERIFIED", "", ...r.unverified.map((n) => `- ${n}`), "");
  return L.join("\n");
}

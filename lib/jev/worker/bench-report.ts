/**
 * lib/jev/worker/bench-report.ts — the bench report (PRD calibration spec §3). PURE: rows in, numbers out.
 *
 * Accuracy is on NON-ABSTAINED items with COVERAGE beside it; Cohen's kappa; a confusion matrix; ESCAPE RECALL (truth is an escape -> Jev abstained); the
 * forward-vs-reversed disagreement rate; counts of what was skipped and why. It holds ids, option keys, row labels and numbers: NEVER text. Dev numbers are
 * in-sample and the report says so (the test split is run once per frozen version, and by CAA, not here).
 */
import type { BenchRow } from "./call";
import type { QuestionDef } from "./sets";

export type BenchLabel = { subject_id: string; question_id: string; label: string };
export type SubjectOutcome = { subject_id: string; status: "asked" | "abstained" | "too_large" | "no_state" | "failed" | "deferred"; reason?: string; rows: BenchRow[]; evidence?: Record<string, unknown>; tokens: number; calls: number };
export type Resolve = (questionId: string, value: string, evidence: Record<string, unknown>) => string;

export type QuestionReport = {
  question_id: string; kind: string; n_derived: number; n_abstained: number; n_gated: number; abstain_rate: number | null; mean_confidence: number | null;
  distribution: Record<string, number>; order_flip_rate: number | null; n_flip_pairs: number;
  vs_labels?: { n_labeled: number; n_scored: number; coverage: number | null; accuracy: number | null; kappa: number | null; escape_recall: number | null; n_escape_truth: number; confusion: Record<string, Record<string, number>> };
};
export type BenchReport = {
  set: string; version: string; sha8: string; use: string; mode: "bench"; in_sample: true; mock: boolean;
  counts: { subjects: number; asked: number; abstained: number; too_large: number; no_state: number; failed: number; deferred: number; calls: number; input_tokens: number; est_usd: number };
  abstain_reasons: Record<string, number>; failed_reasons: Record<string, number>;
  questions: QuestionReport[]; stopped?: string;
};

const r4 = (x: number): number => Math.round(x * 1e4) / 1e4;

export function cohenKappa(pairs: ReadonlyArray<readonly [string, string]>): number | null {
  const n = pairs.length;
  if (n === 0) return null;
  const cats = [...new Set(pairs.flatMap(([a, b]) => [a, b]))];
  const po = pairs.filter(([a, b]) => a === b).length / n;
  let pe = 0;
  for (const c of cats) pe += (pairs.filter(([a]) => a === c).length / n) * (pairs.filter(([, b]) => b === c).length / n);
  return pe === 1 ? null : r4((po - pe) / (1 - pe));
}

export function buildBenchReport(input: {
  set: { id: string; version: string; sha: string; use: string }; defs: ReadonlyArray<QuestionDef>; outcomes: ReadonlyArray<SubjectOutcome>;
  labels?: ReadonlyArray<BenchLabel>; resolve?: Resolve; mock: boolean; usdPerToken: number; stopped?: string;
}): BenchReport {
  const { outcomes, defs } = input;
  const by = (s: SubjectOutcome["status"]) => outcomes.filter((o) => o.status === s).length;
  const abstain_reasons: Record<string, number> = {}, failed_reasons: Record<string, number> = {};
  for (const o of outcomes) {
    if (o.status === "abstained" || o.status === "too_large" || o.status === "no_state") abstain_reasons[o.reason ?? o.status] = (abstain_reasons[o.reason ?? o.status] ?? 0) + 1;
    if (o.status === "failed" || o.status === "deferred") failed_reasons[o.reason ?? o.status] = (failed_reasons[o.reason ?? o.status] ?? 0) + 1;
  }
  const tokens = outcomes.reduce((a, o) => a + o.tokens, 0);
  const questions: QuestionReport[] = [];
  for (const d of defs) {
    const escapes = new Set(d.escape_options ?? []);
    const derived: Array<{ subject: string; value: string; conf: number | null; evidence: Record<string, unknown>; gated: boolean }> = [];
    let flipPairs = 0, flips = 0;
    for (const o of outcomes) {
      const rows = o.rows.filter((r) => r.question_id === d.question_id);
      const dr = rows.find((r) => r.variant === "derived");
      if (dr) derived.push({ subject: o.subject_id, value: dr.gated ? "gated_overwritten" : String(dr.value), conf: dr.confidence, evidence: o.evidence ?? {}, gated: dr.gated === true });
      const f = rows.find((r) => r.variant === "fwd"), v = rows.find((r) => r.variant === "rev");
      if (f && v) { flipPairs += 1; if (String(f.value) !== String(v.value)) flips += 1; }
    }
    const resolved = derived.map((x) => ({ ...x, mapped: input.resolve ? input.resolve(d.question_id, x.value, x.evidence) : x.value }));
    const distribution: Record<string, number> = {};
    for (const x of resolved) distribution[x.value] = (distribution[x.value] ?? 0) + 1;
    const isAbstain = (x: { value: string; gated: boolean }): boolean => x.gated || escapes.has(x.value);
    const abstained = derived.filter(isAbstain).length;
    const nGated = derived.filter((x) => x.gated).length;
    const q: QuestionReport = {
      question_id: d.question_id, kind: d.kind, n_derived: derived.length, n_abstained: abstained, n_gated: nGated, abstain_rate: derived.length ? r4(abstained / derived.length) : null,
      mean_confidence: derived.length ? r4(derived.reduce((a, x) => a + (x.conf ?? 0), 0) / derived.length) : null,
      distribution, order_flip_rate: flipPairs ? r4(flips / flipPairs) : null, n_flip_pairs: flipPairs,
    };
    const labels = (input.labels ?? []).filter((l) => l.question_id === d.question_id);
    if (labels.length) {
      const lab = new Map(labels.map((l) => [l.subject_id, l.label]));
      const labeled = resolved.filter((x) => lab.has(x.subject));
      const scored = labeled.filter((x) => !isAbstain(x));
      const pairs = scored.map((x) => [lab.get(x.subject)!, x.mapped] as const);
      const truthEsc = labeled.filter((x) => escapes.has(lab.get(x.subject)!));
      const confusion: Record<string, Record<string, number>> = {};
      for (const [t, p] of pairs) { (confusion[t] ??= {})[p] = ((confusion[t] ??= {})[p] ?? 0) + 1; }
      q.vs_labels = {
        n_labeled: labeled.length, n_scored: scored.length, coverage: labeled.length ? r4(scored.length / labeled.length) : null,
        accuracy: pairs.length ? r4(pairs.filter(([t, p]) => t === p).length / pairs.length) : null, kappa: cohenKappa(pairs),
        escape_recall: truthEsc.length ? r4(truthEsc.filter(isAbstain).length / truthEsc.length) : null, n_escape_truth: truthEsc.length, confusion,
      };
    }
    questions.push(q);
  }
  return {
    set: input.set.id, version: input.set.version, sha8: input.set.sha.slice(0, 8), use: input.set.use, mode: "bench", in_sample: true, mock: input.mock,
    counts: { subjects: outcomes.length, asked: by("asked"), abstained: by("abstained"), too_large: by("too_large"), no_state: by("no_state"), failed: by("failed"), deferred: by("deferred"),
      calls: outcomes.reduce((a, o) => a + o.calls, 0), input_tokens: tokens, est_usd: Math.round(tokens * input.usdPerToken * 1e8) / 1e8 },
    abstain_reasons, failed_reasons, questions, ...(input.stopped ? { stopped: input.stopped } : {}),
  };
}

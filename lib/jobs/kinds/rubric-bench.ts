/**
 * lib/jobs/kinds/rubric-bench.ts — S7-0: run a rubric over its labelled bench set and score it (lib/rubrics/bench.ts -> lib/jev/bench.ts scoreJevBench).
 *   load      read the bench set (the lab store rubric/<id>/<version>/bench.json, or the repo's rubrics/<id>/bench.json once benched), open the rubric_run row (kind bench)
 *   evaluate  a batch of items per claim: evaluate the unit, compare with the expected fields; the per-item comparison is kept in progress (ids, field names, labels: no text)
 *   finish    score, write the report to R2 rubric/<id>/<version>/bench-<run_id>.json, close the rubric_run row; the job result says passed / not passed
 * Draft, benched and production rubrics may all be benched. A bench writes NO rubric_result row (it must not overwrite the results of real units).
 */
import { z } from "zod";
import { JobArgsError, doneWith, failWith, nextStep, type JobKind, type StepContext, type StepOutcome } from "../types";
import { jobError } from "../errors";
import { callsLeft, capRefusal, isLlmRubric } from "@/lib/rubrics/llm-cap";
import { getRubric, canRun } from "@/lib/rubrics/registry";
import { evaluateUnit } from "@/lib/rubrics/engines";
import { compareItem, labelReport, parseBenchSet, scoreBench, type BenchSet } from "@/lib/rubrics/bench";
import { finishRun, insertRun, newRunId, readEvidence, writeEvidence } from "@/lib/rubrics/store";
import { rubricTiming } from "./rubric-run";
import { labStore } from "@/lib/sarvam-lab";

export const RUBRIC_BENCH_KIND = "rubric_bench";
/**
 * S71-AB/C: which labelled set a bench runs. `gold` (default) = the rubric's own bench.location; `grokbot_agreement` = model labels by the GrokBot Sentiment Analyzer (NOT human gold; the report
 * calls the metric agreement_with_grokbot); `human_v` = V's own labels (human gold; the report calls the metric accuracy_vs_V and states n). Each set is its own run and its own report.
 */
export const BENCH_SETS = ["gold", "grokbot_agreement", "human_v"] as const;
export type BenchSetName = (typeof BENCH_SETS)[number];
const Args = z.object({ rubric_id: z.string().regex(/^[a-z][a-z0-9_]{1,63}$/), set: z.enum(BENCH_SETS).optional() }).strict();

export function parseRubricBenchArgs(raw: unknown): { rubric_id: string; set?: BenchSetName } {
  const p = Args.safeParse(raw ?? {});
  if (!p.success) throw new JobArgsError(`bad args: ${p.error.issues[0]?.path.join(".") || "args"} ${p.error.issues[0]?.message ?? ""}`.trim().slice(0, 160));
  const r = getRubric(p.data.rubric_id);
  const refusal = canRun(r, { lab: true });
  if (refusal) throw new JobArgsError(`${refusal.error}${refusal.detail ? `: ${refusal.detail}` : ""}`);
  return p.data;
}

export const rubricBenchKind: JobKind = {
  name: RUBRIC_BENCH_KIND,
  first: "load",
  scope: "invoke",
  precheck: async (args) => { const m = await capRefusal(RUBRIC_BENCH_KIND, args); if (m) throw new JobArgsError(m); },
  parseArgs: (raw) => parseRubricBenchArgs(raw) as unknown as Record<string, unknown>,
  dedupeOn: (args) => [["rubric_id", String(args.rubric_id)], ["set", String(args.set ?? "gold")]],
  async run(ctx: StepContext) {
    switch (ctx.step) {
      case "load": return loadStep(ctx);
      case "evaluate": return evaluateStep(ctx);
      case "finish": return finishStep(ctx);
      default: return failWith(jobError("unknown_step", ctx.step));
    }
  },
};

/** Repo bench sets are registered here once a rubric is benched (static imports: the bundler ships them). None yet. */
export const REPO_BENCH_SETS: Record<string, unknown> = {};

async function loadBenchSet(rubricId: string, version: string, location: string, set: BenchSetName = "gold"): Promise<BenchSet | null> {
  if (set !== "gold") return loadGold(`rubric/bench/${rubricId}/${set}.jsonl`, set);
  // llm_zdr rubrics: gold prepared offline and uploaded as JSONL (rubric/bench/<rubric_id>/gold.jsonl); the gold never enters the repo
  if (location.startsWith("rubric/bench/")) return loadGold(location, "gold");
  // the repo copy first (once a rubric is benched its set is registered above); otherwise the lab store copy for this exact version (a draft's labelled set lives there until it is committed)
  const repo = location.startsWith("rubrics/") ? parseBenchSet(REPO_BENCH_SETS[location]) : null;
  return repo ?? parseBenchSet(await readEvidence(`rubric/${rubricId}/${version}/bench.json`));
}

/** One JSON object per line: { unit_key, expected: { field: value } }. Bad lines make the whole set invalid (a silent skip would inflate the score). */
async function loadGold(location: string, set: BenchSetName = "gold"): Promise<BenchSet | null> {
  const store = labStore();
  if (!store || !/^rubric\/bench\/[a-z][a-z0-9_]{1,63}\/(gold|grokbot_agreement|human_v)\.jsonl$/.test(location)) return null;
  const obj = await store.get(location);
  if (!obj) return null;
  const items: unknown[] = [];
  for (const line of obj.body.split("\n")) {
    if (!line.trim()) continue;
    try { items.push(JSON.parse(line)); } catch { return null; }
  }
  // unit_kind "excerpt" (S71-C2): the unit is a transcript excerpt held in the lab store; a set is all excerpts or none
  const kinds = new Set(items.map((x) => (x as { unit_kind?: unknown } | null)?.unit_kind ?? "consult"));
  if (kinds.size !== 1 || !(kinds.has("consult") || kinds.has("excerpt"))) return null;
  const parsed = parseBenchSet({ unit: "consult", items });
  // GATING-G68: an excerpt skips every database blind check, so it is accepted from the ONE set whose blind status was verified offline (human_v: 18/18 resolved, 0 blind); any other set naming excerpts is no set
  if (kinds.has("excerpt") && set !== "human_v") return null;
  return parsed && kinds.has("excerpt") ? { ...parsed, excerpt: true } : parsed;
}

const num = (v: unknown): number => (typeof v === "number" ? v : Number(v)) || 0;

async function loadStep(ctx: StepContext): Promise<StepOutcome> {
  const a = ctx.args as { rubric_id: string; set?: BenchSetName };
  const r = getRubric(a.rubric_id);
  if (!r) return failWith(jobError("unknown_rubric", a.rubric_id));
  if (r.bench.metric !== "field_accuracy" && r.bench.metric !== "accuracy") return failWith(jobError("bench_metric_unsupported", r.bench.metric));
  if (typeof ctx.progress.run_id === "string") return nextStep("evaluate", ctx.progress);
  const set = await loadBenchSet(r.id, r.version, r.bench.location, a.set ?? "gold");
  if (!set) return failWith(jobError("bench_set_missing", r.bench.location));
  const runId = newRunId();
  await insertRun({ run_id: runId, rubric_id: r.id, version: r.version, kind: "bench", units_planned: set.items.length, actor: ctx.job.actor ?? null });
  return nextStep("evaluate", { run_id: runId, set, idx: 0, compared: [] });
}

async function evaluateStep(ctx: StepContext): Promise<StepOutcome> {
  const a = ctx.args as { rubric_id: string };
  const r = getRubric(a.rubric_id);
  if (!r) return failWith(jobError("unknown_rubric", a.rubric_id));
  const set = ctx.progress.set as BenchSet;
  const compared = [...((ctx.progress.compared as Array<ReturnType<typeof compareItem>> | undefined) ?? [])];
  let idx = num(ctx.progress.idx);
  const deadline = Date.now() + rubricTiming.evaluateStepMs;
  const end = Math.min(set.items.length, idx + rubricTiming.batchUnits);
  const llm = isLlmRubric(r.id);
  let made = num(ctx.progress.llm_calls), capSkipped = num(ctx.progress.skipped_cap);
  let left = llm ? await callsLeft(set.items.length, made) : Number.POSITIVE_INFINITY;
  while (idx < end && Date.now() < deadline) {
    if (llm && left <= 0) { // G71: at the cap, the remaining items are unscored (reason llm_cap) and no more calls are made
      for (; idx < set.items.length; idx++) { compared[idx] = compareItem(set.items[idx]!, null); capSkipped += 1; }
      break;
    }
    const item = set.items[idx]!;
    // a DB / R2 error throws (the step is retried); a unit the engine could not score, or that is held out or unresolved, comes back skipped / failed and fails every expected field
    const out = await evaluateUnit(r, set.unit, item.unit_key, { bench: true, ...(set.excerpt ? { excerpt: true, room_id: item.room_id ?? null, room_ids: item.room_ids ?? null, ist_date: item.ist_date ?? null } : {}) });
    // a skipped unit with a score is a scored "nothing to score" (no surgery recommended, unscorable tape): it can be right or wrong against the gold
    const score: Record<string, unknown> | null = out.status === "ok" || out.status === "empty" || (out.status === "skipped" && out.score) ? (out.score ?? null) : null;
    compared[idx] = compareItem(item, score);
    made += out.calls ?? 0;
    left -= out.calls ?? 0;
    idx += 1;
  }
  return nextStep(idx >= set.items.length ? "finish" : "evaluate", { ...ctx.progress, idx, compared, llm_calls: made, skipped_cap: capSkipped });
}

async function finishStep(ctx: StepContext): Promise<StepOutcome> {
  const a = ctx.args as { rubric_id: string; set?: BenchSetName };
  const setName: BenchSetName = a.set ?? "gold";
  const r = getRubric(a.rubric_id)!;
  const runId = String(ctx.progress.run_id ?? "");
  const compared = (ctx.progress.compared as Array<ReturnType<typeof compareItem>>) ?? [];
  const report = scoreBench(r.bench.metric, r.bench.threshold, compared);
  if ("error" in report) return failWith(jobError("bench_metric_unsupported", r.bench.metric));
  const excerpt = (ctx.progress.set as BenchSet | undefined)?.excerpt === true;
  const labelled = labelReport(setName, report, { excerpt }) as { metric: string; threshold: number | null; passed: boolean | null; human_gold?: boolean };
  const reportKey = await writeEvidence(r.id, r.version, `bench-${runId}`, { rubric_id: r.id, version: r.version, run_id: runId, status_at_run: r.status, population: (r.definition as { bench_population?: string } | undefined)?.bench_population ?? null, ...labelReport(setName, report, { excerpt }), items_detail: compared });
  await finishRun({ run_id: runId, units_ok: compared.length - report.unscored, units_failed: report.unscored });
  return doneWith({ run_id: runId, rubric_id: r.id, version: r.version, set: setName, metric: labelled.metric, value: report.value, threshold: labelled.threshold, passed: labelled.passed, n: report.items, items: report.items, fields: report.fields, unscored: report.unscored, report_key: reportKey, status_at_run: r.status, llm_calls: num(ctx.progress.llm_calls), skipped_llm_cap: num(ctx.progress.skipped_cap) });
}

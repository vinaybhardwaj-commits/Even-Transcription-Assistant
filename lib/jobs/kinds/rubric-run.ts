/**
 * lib/jobs/kinds/rubric-run.ts — S7-0: run one rubric over a set of units. Steps (each well inside MAX_STEP_MS, resumable from `progress`):
 *   resolve   check the rubric may run (production, or lab:true with an explicit unit list), resolve the units, open the rubric_run row (kind run)
 *   evaluate  a batch of units per claim: read inputs through the readers, run the engine, write the rubric_result row and the R2 evidence; the cursor is in progress
 *   finish    close the rubric_run row with the counts
 * G53: only an ENGINE fault is a failed unit; DB / R2 errors propagate (retried); a result row is written only for a unit whose room and IST date are known and not held out.
 * progress holds ids and counts only (unit keys are window ids, consult keys, room:date:hour): never text. A unit the readers refuse (blind room-day, no diarization, ...) is
 * `skipped` with its closed reason, not failed; a unit whose engine throws is `failed` (code engine_error); a DATABASE or R2 error is transient and throws, so the step is retried.
 */
import { z } from "zod";
import { JobArgsError, doneWith, failWith, nextStep, withProgressPatch, type JobKind, type StepContext, type StepOutcome } from "../types";
import { jobError } from "../errors";
import { callsLeft, capRefusal, isLlmRubric, reservationFor } from "@/lib/rubrics/llm-cap";
import { getRubric, canRun, unitsOf } from "@/lib/rubrics/registry";
import { RUBRIC_UNITS, type RubricUnit } from "@/lib/rubrics/types";
import { evaluateUnit, resolveUnits, STAY_RUN_MAX } from "@/lib/rubrics/engines";
import { parseStayKey, withStayBatch, STAY_BATCH_MAX } from "@/lib/rubrics/readers/stay-record";
import { countingCalls, talliedCalls } from "@/lib/rubrics/llm";
import { finishRun, insertRun, newRunId, upsertResult, writeEvidence } from "@/lib/rubrics/store";
import { perUnitHeldOut } from "../held-out";

export const RUBRIC_RUN_KIND = "rubric_run";
export const RUBRIC_RUN_MAX_UNITS = 500;
/** Timing knobs (mutable so a test needs no waiting). */
export const rubricTiming = { evaluateStepMs: 120_000, batchUnits: 40 };

const Args = z.object({
  rubric_id: z.string().regex(/^[a-z][a-z0-9_]{1,63}$/),
  unit: z.enum(RUBRIC_UNITS).optional(),
  lab: z.boolean().default(false),
  unit_keys: z.array(z.string().min(1).max(200)).min(1).max(RUBRIC_RUN_MAX_UNITS).optional(),
  rooms: z.array(z.string().regex(/^[A-Za-z0-9_-]{1,64}$/)).min(1).max(20).optional(),
  from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  limit: z.number().int().min(1).max(RUBRIC_RUN_MAX_UNITS).default(200),
}).strict();
export type RubricRunArgs = z.infer<typeof Args> & { unit: RubricUnit };

/** PURE (reads the registry). Throws JobArgsError with the closed refusal code first: unknown_rubric, lab_required, engine_not_available, unit_not_supported. */
export function parseRubricRunArgs(raw: unknown): RubricRunArgs {
  const p = Args.safeParse(raw ?? {});
  if (!p.success) throw new JobArgsError(`bad args: ${p.error.issues[0]?.path.join(".") || "args"} ${p.error.issues[0]?.message ?? ""}`.trim().slice(0, 160));
  const a = p.data;
  const r = getRubric(a.rubric_id);
  const unit = a.unit ?? r?.unit ?? "window";
  const refusal = canRun(r, { lab: a.lab, unit });
  if (refusal) throw new JobArgsError(`${refusal.error}${refusal.detail ? `: ${refusal.detail}` : ""}`);
  // S7-3: a stay run covers at most STAY_RUN_MAX stays; with lab:true a stay run may name an admission date range instead of keys (surgical stays only, the same cap)
  if (unit === "stay") {
    if ((a.unit_keys?.length ?? 0) > STAY_RUN_MAX) throw new JobArgsError(`bad args: unit_keys at most ${STAY_RUN_MAX} stays`);
    return { ...a, unit, limit: Math.min(a.limit, STAY_RUN_MAX) };
  }
  // a non-production rubric runs ONLY on an explicit unit list (lab:true alone is not enough)
  if (r!.status !== "production" && !a.unit_keys) throw new JobArgsError(`explicit_units_required: ${r!.id}@${r!.version} is ${r!.status}: give unit_keys`);
  return { ...a, unit };
}

export const rubricRunKind: JobKind = {
  name: RUBRIC_RUN_KIND,
  first: "resolve",
  roomData: true,
  heldOut: perUnitHeldOut,
  scope: "invoke",
  capPlan: (args) => reservationFor(RUBRIC_RUN_KIND, args),
  precheck: async (args) => { const m = await capRefusal(RUBRIC_RUN_KIND, args); if (m) throw new JobArgsError(m); },
  parseArgs: (raw) => parseRubricRunArgs(raw) as unknown as Record<string, unknown>,
  async run(ctx: StepContext) {
    switch (ctx.step) {
      case "resolve": return resolveStep(ctx);
      case "evaluate": return evaluateStep(ctx);
      case "finish": return finishStep(ctx);
      default: return failWith(jobError("unknown_step", ctx.step));
    }
  },
};

const num = (v: unknown): number => (typeof v === "number" ? v : Number(v)) || 0;

async function resolveStep(ctx: StepContext): Promise<StepOutcome> {
  const a = ctx.args as unknown as RubricRunArgs;
  const r = getRubric(a.rubric_id);
  if (!r) return failWith(jobError("unknown_rubric", a.rubric_id));
  if (typeof ctx.progress.run_id === "string") return nextStep("evaluate", ctx.progress); // replay: the run row exists
  const plan = await resolveUnits(r, a.unit, { unit_keys: a.unit_keys, rooms: a.rooms, from: a.from, to: a.to, limit: a.limit });
  if ("error" in plan) return failWith(jobError("rubric_units_unresolved", plan.error));
  const runId = newRunId();
  await insertRun({ run_id: runId, rubric_id: r.id, version: r.version, kind: "run", units_planned: plan.keys.length, actor: ctx.job.actor ?? null });
  return nextStep(plan.keys.length === 0 ? "finish" : "evaluate", { run_id: runId, keys: plan.keys, idx: 0, ok: 0, failed: 0, skipped: 0, truncated: plan.truncated, blind_excluded: plan.blind_excluded ?? 0 });
}

async function evaluateStep(ctx: StepContext): Promise<StepOutcome> {
  const a = ctx.args as unknown as RubricRunArgs;
  const r = getRubric(a.rubric_id);
  if (!r) return failWith(jobError("unknown_rubric", a.rubric_id));
  const keys = (ctx.progress.keys as string[] | undefined) ?? [];
  const runId = String(ctx.progress.run_id ?? "");
  if (!runId) return failWith(jobError("progress_incomplete", "run_id"));
  const lab = r.status !== "production" || a.lab === true;
  const deadline = Date.now() + rubricTiming.evaluateStepMs;
  let idx = num(ctx.progress.idx), ok = num(ctx.progress.ok), failed = num(ctx.progress.failed), skipped = num(ctx.progress.skipped), blind = num(ctx.progress.blind), unresolved = num(ctx.progress.unresolved);
  const end = Math.min(keys.length, idx + rubricTiming.batchUnits);
  // G71: a model-call ceiling. Calls made by this job are carried in progress; the day's other usage is read once per step.
  const llm = isLlmRubric(r.id);
  let made = num(ctx.progress.llm_calls), capSkipped = num(ctx.progress.skipped_cap);
  let left = llm ? await callsLeft(keys.length, made) : Number.POSITIVE_INFINITY;
  // G80: a throw anywhere in the batch (llm_unavailable, a database or R2 error) keeps what the batch already did: the position, the counters and EVERY model call made so far, the failing unit's own attempts included
  // S7-3: a stay batch reads the warehouse ONCE per table for the whole batch (at most STAY_BATCH_MAX stays), then each stay is answered from it
  const inBatch = <T>(fn: () => Promise<T>): Promise<T> => (a.unit === "stay" ? withStayBatch(keys.slice(idx, end).map((k) => parseStayKey(k) ?? "").filter(Boolean).slice(0, STAY_BATCH_MAX), fn) : fn());
  try {
  await inBatch(async () => {
  while (idx < end && Date.now() < deadline) {
    if (llm && left <= 0) { // at the cap: the remaining units are skipped (reason llm_cap), no more calls
      capSkipped += keys.length - idx;
      skipped += keys.length - idx;
      idx = keys.length;
      break;
    }
    const key = keys[idx]!;
    // NO try/catch here (S7-0-R3, G53): a database or R2 error from the resolver, a reader or a write throws, the runner retries the step (MAX_FAILURES), and nothing half-written is
    // hidden as a failed unit. An ENGINE fault (an exception inside the pure engine) is caught inside evaluateUnit and comes back as status failed / engine_error.
    const out = await countingCalls(() => evaluateUnit(r, a.unit, key));
    made += out.calls ?? 0;
    left -= out.calls ?? 0;
    // a held-out room-day (lib/rubrics/blind-room-days.ts) was refused by the reader before any fetch: NOTHING is written for it, not even a skipped row; it is only counted
    if (out.reason === "blind_room_day") {
      skipped += 1;
      blind += 1;
      idx += 1;
      continue;
    }
    // a result row always has a known room and IST date: a unit whose room or date could not be resolved (no such window, no room-day, a bad key) is counted, never written
    if ((out.room_id === null && a.unit !== "stay") || out.ist_date === null) { // a stay has no room: its IST date is the admission's
      skipped += 1;
      unresolved += 1;
      idx += 1;
      continue;
    }
    let evidenceKey: string | null = null;
    if (out.status === "ok" || out.status === "empty") {
      evidenceKey = await writeEvidence(r.id, r.version, key, { rubric_id: r.id, version: r.version, unit_kind: a.unit, unit_key: key, run_id: runId, lab, status: out.status, score: out.score ?? null, findings: out.findings, evidence: out.evidence ?? {} }, { room_id: out.room_id, ist_date: out.ist_date });
    }
    await upsertResult({
      rubric_id: r.id, version: r.version, unit_kind: a.unit, unit_key: key, room_id: out.room_id, ist_date: out.ist_date, run_id: runId, status: out.status,
      score: out.score ? { ...out.score, ...(evidenceKey ? { evidence_key: evidenceKey } : {}) } : out.reason ? { reason: out.reason } : null, findings: out.findings, lab,
    });
    if (out.status === "ok" || out.status === "empty") ok += 1;
    else if (out.status === "failed") failed += 1;
    else skipped += 1;
    idx += 1;
  }
  });
  } catch (e) {
    throw withProgressPatch(e, { idx, ok, failed, skipped, blind, unresolved, llm_calls: made + talliedCalls(e), skipped_cap: capSkipped });
  }
  const progress = { ...ctx.progress, idx, ok, failed, skipped, blind, unresolved, llm_calls: made, skipped_cap: capSkipped };
  return nextStep(idx >= keys.length ? "finish" : "evaluate", progress);
}

async function finishStep(ctx: StepContext): Promise<StepOutcome> {
  const runId = String(ctx.progress.run_id ?? "");
  if (!runId) return failWith(jobError("progress_incomplete", "run_id"));
  await finishRun({ run_id: runId, units_ok: num(ctx.progress.ok), units_failed: num(ctx.progress.failed) });
  const a = ctx.args as unknown as RubricRunArgs;
  const r = getRubric(a.rubric_id)!;
  return doneWith({ run_id: runId, rubric_id: r.id, version: r.version, units_planned: ((ctx.progress.keys as string[] | undefined) ?? []).length, ok: num(ctx.progress.ok), failed: num(ctx.progress.failed), skipped: num(ctx.progress.skipped), blind_room_days: num(ctx.progress.blind), llm_calls: num(ctx.progress.llm_calls), skipped_llm_cap: num(ctx.progress.skipped_cap), blind_excluded: num(ctx.progress.blind_excluded), unresolved: num(ctx.progress.unresolved), truncated: ctx.progress.truncated === true, units: unitsOf(r) });
}

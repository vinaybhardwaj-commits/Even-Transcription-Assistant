/**
 * lib/jobs/kinds/jev-ask.ts — the generic Jev worker job (PRD §3.5, P1.3): plan -> ask (batches) -> finish.
 *
 * SHIPS DARK. Nothing here runs unless JEV_WORKER_ENABLED (and the use's flag for shadow/live, ETA_JEV_TEXT_LANE for a text set)
 * is on, and ETA_JEV_ENABLED gates the client again before any fetch. A flag off ends the job `skipped` with ZERO calls.
 *
 *   plan   verifies flags, the set's DB mirror against the deployed file's hash, the status the MODE needs (draft -> bench only;
 *          shadow needs status >= shadow; live needs status live AND the use's JEV_*_LIVE), the breaker and the budget; picks the
 *          subjects (ids only into `progress`).
 *   ask    up to JEV_ASK_BATCH subjects: the state builder RE-FETCHES evidence by id, one call per subject per option order, ledger
 *          row, decision rows. A retryable class THROWS (withProgressPatch keeps finished subjects); a non-retryable one is recorded on the
 *          subject and the job goes on. Circuit open / budget exceeded end the job with the subjects still pending.
 *   finish the summary: counts and closed codes. Never text.
 *
 * roomData is false: the kind reads no room data itself. A use's state builder (P2-P4) declares its own evidence. The blind rule
 * is lifted (V, 10 Oct 2026), so no held-out guard is added.
 */
import { createHash } from "node:crypto";
import { sql } from "@/lib/db";
import { QUESTION_SET_FILES } from "@/jev/question-sets";
import { breakerIsOpen } from "@/lib/jev/worker/breaker";
import { budgetCheck, reservationUsd } from "@/lib/jev/worker/budget";
import { askSubject, type BenchRow, type SetRef } from "@/lib/jev/worker/call";
import { askBatch, assertMockFallbackSane, modeGate, REAL_USES, type JevMode, type RealUse } from "@/lib/jev/worker/flags";
import { classifyDbError, policyOf } from "@/lib/jev/worker/errors";
import { setSha, validateSetFile, type QuestionDef } from "@/lib/jev/worker/sets";
import { getUse } from "@/lib/jev/worker/uses";
import { pendingSubjects } from "@/lib/jev/worker/sweeper";
import { JobArgsError, doneWith, failWith, nextStep, withProgressPatch, type JobKind, type StepContext, type StepOutcome } from "../types";

export const JEV_ASK_KIND_NAME = "jev_ask";
const MAX_SUBJECTS = 500;
const MAX_BENCH_ROWS = 500;
const STEP_BUDGET_MS = 150_000;

export function parseJevAskArgs(raw: unknown): Record<string, unknown> {
  if (!raw || typeof raw !== "object") throw new JobArgsError("args must be an object");
  const r = raw as Record<string, unknown>;
  if (!(REAL_USES as readonly string[]).includes(r.use as string)) throw new JobArgsError("use must be one of the real uses");
  if (r.mode !== "bench" && r.mode !== "shadow" && r.mode !== "live") throw new JobArgsError("mode must be bench, shadow or live");
  if (typeof r.set_id !== "string" || !r.set_id || typeof r.version !== "string" || !r.version) throw new JobArgsError("set_id and version are required");
  let ids: string[] | null = null;
  if (r.subject_ids !== undefined) {
    if (!Array.isArray(r.subject_ids) || r.subject_ids.length === 0 || r.subject_ids.length > MAX_SUBJECTS || r.subject_ids.some((x) => typeof x !== "string" || !x || x.length > 200)) {
      throw new JobArgsError(`subject_ids must be 1..${MAX_SUBJECTS} non-empty strings`);
    }
    ids = [...new Set(r.subject_ids as string[])];
  }
  if (r.reserve_usd !== undefined && !(typeof r.reserve_usd === "number" && r.reserve_usd >= 0 && Number.isFinite(r.reserve_usd))) throw new JobArgsError("reserve_usd must be a non-negative number");
  return {
    use: r.use, mode: r.mode, set_id: r.set_id, version: r.version,
    ...(ids ? { subject_ids: ids } : {}),
    subjects_key: ids ? createHash("sha256").update([...ids].sort().join("\n")).digest("hex").slice(0, 16) : "sweep",
    ...(r.reserve_usd !== undefined ? { reserve_usd: r.reserve_usd } : {}),
  };
}

type SetRow = { id: string; version: string; use: string; subject_type: string; model_pin: string; content_sha256: string; status: string; bands: { act: number; caution: number } | null };

/** The set the job will ask, its questions from the DB mirror, and the verdict on whether the mode may run it. */
export async function loadSetForMode(use: RealUse, mode: JevMode, setId: string, version: string): Promise<
  | { ok: true; set: SetRef; defs: QuestionDef[] }
  | { ok: false; reason: "set_not_allowed"; detail: string }
> {
  const rows = (await sql`SELECT id, version, use, subject_type, model_pin, content_sha256, status, bands FROM jev_question_set WHERE id = ${setId} AND version = ${version}`) as SetRow[];
  const row = rows[0];
  const no = (detail: string) => ({ ok: false as const, reason: "set_not_allowed" as const, detail });
  if (!row) return no("not_synced");
  if (row.use !== use) return no("use_mismatch");
  if (row.status === "retired") return no("retired");
  // The DB mirror must equal the deployed file: a set whose file changed without a new version never runs.
  const file = QUESTION_SET_FILES.map((f) => { try { return validateSetFile(f); } catch { return null; } }).find((f) => f && f.id === setId && f.version === version);
  if (!file) return no("no_file");
  if (setSha(file) !== row.content_sha256) return no("hash_mismatch");
  if (mode === "shadow" && row.status !== "shadow" && row.status !== "live") return no(`status_${row.status}_for_shadow`);
  if (mode === "live" && row.status !== "live") return no(`status_${row.status}_for_live`);
  // bench runs any non-retired set, a draft included.
  return {
    ok: true,
    set: { id: row.id, version: row.version, sha: row.content_sha256, modelPin: row.model_pin, use: row.use, subjectType: row.subject_type, bands: row.bands },
    defs: file.questions,
  };
}

type Progress = {
  subjects: string[]; i: number; decisions: number; calls: number; tokens: number; failed: Array<{ id: string; cls: string }>; bench: BenchRow[]; bench_dropped: number;
};
const readProgress = (p: Record<string, unknown>): Progress => ({
  subjects: Array.isArray(p.subjects) ? (p.subjects as string[]) : [], i: Number(p.i ?? 0), decisions: Number(p.decisions ?? 0), calls: Number(p.calls ?? 0), tokens: Number(p.tokens ?? 0),
  failed: Array.isArray(p.failed) ? (p.failed as Progress["failed"]) : [], bench: Array.isArray(p.bench) ? (p.bench as BenchRow[]) : [], bench_dropped: Number(p.bench_dropped ?? 0),
});

async function plan(ctx: StepContext): Promise<StepOutcome> {
  assertMockFallbackSane();
  const a = ctx.args as { use: RealUse; mode: JevMode; set_id: string; version: string; subject_ids?: string[] };
  const gate = modeGate(a.use, a.mode);
  if (!gate.ok) return doneWith({ skipped: gate.reason, calls: 0 });
  const def = getUse(a.use);
  if (!def) return doneWith({ skipped: "no_use_registered", calls: 0 });
  const loaded = await loadSetForMode(a.use, a.mode, a.set_id, a.version);
  if (!loaded.ok) return doneWith({ skipped: "set_not_allowed", detail: loaded.detail, calls: 0 });
  if (await breakerIsOpen(a.use)) return doneWith({ skipped: "circuit_open", calls: 0 });
  const per = reservationUsd(8_000, 2_000) * 2;
  const subjects = (a.subject_ids ?? (await pendingSubjects(def, loaded.set.sha, a.mode, askBatch() * 4))).slice(0, MAX_SUBJECTS);
  if (!(await budgetCheck(per)).ok) return doneWith({ skipped: "budget_exceeded", calls: 0 });
  return nextStep("ask", { subjects, i: 0, decisions: 0, calls: 0, tokens: 0, failed: [], bench: [], bench_dropped: 0 });
}

async function ask(ctx: StepContext): Promise<StepOutcome> {
  assertMockFallbackSane();
  const a = ctx.args as { use: RealUse; mode: JevMode; set_id: string; version: string };
  const gate = modeGate(a.use, a.mode);   // re-checked every step: a flag switched off mid-job stops the next step
  if (!gate.ok) return doneWith({ ...summary(readProgress(ctx.progress)), skipped: gate.reason });
  const def = getUse(a.use);
  if (!def) return doneWith({ ...summary(readProgress(ctx.progress)), skipped: "no_use_registered" });
  const loaded = await loadSetForMode(a.use, a.mode, a.set_id, a.version);
  if (!loaded.ok) return doneWith({ ...summary(readProgress(ctx.progress)), skipped: "set_not_allowed", detail: loaded.detail });
  const p = readProgress(ctx.progress);
  const t0 = Date.now();
  const stop = Math.min(p.subjects.length, p.i + askBatch());
  while (p.i < stop) {
    if (Date.now() - t0 > STEP_BUDGET_MS) break;
    const id = p.subjects[p.i]!;
    let out;
    try {
      out = await askSubject({ jobId: ctx.job.id, set: loaded.set, defs: loaded.defs, mode: a.mode, subjectId: id, build: await def.build(id), signal: ctx.signal });
    } catch (e) {
      // a database fault while building or persisting: db_error:<code> or persist_failed, retried, never a Jev error
      throw withProgressPatch(new Error(classifyDbError(e)), toProgress(p));
    }
    p.calls += out.calls;
    if (out.kind === "deferred") {
      if (out.why === "no_slot") return nextStep("ask", toProgress(p));               // retry next minute; not a failure
      return doneWith({ ...summary(p), skipped: out.why });                           // circuit open / budget exceeded: the rest stays pending
    }
    if (out.kind === "failed") {
      const pol = policyOf(out.errorClass);
      if (out.errorClass === "config_missing_key" || out.errorClass === "auth" || out.errorClass === "disabled") return failWith(`jev_ask:${out.errorClass}`);
      if (pol.retry) throw withProgressPatch(new Error(out.errorClass), toProgress(p));
      p.failed.push({ id, cls: out.errorClass });
      p.i += 1;
      continue;
    }
    p.decisions += out.decisions;
    p.tokens += out.inputTokens;
    for (const b of out.bench) { if (p.bench.length < MAX_BENCH_ROWS) p.bench.push(b); else p.bench_dropped += 1; }
    p.i += 1;
  }
  return nextStep(p.i >= p.subjects.length ? "finish" : "ask", toProgress(p));
}

const toProgress = (p: Progress): Record<string, unknown> => ({ ...p, failed: p.failed.slice(0, 50) });
function summary(p: Progress): Record<string, unknown> {
  return { subjects: p.subjects.length, asked: p.i, decisions: p.decisions, calls: p.calls, input_tokens: p.tokens, failed: p.failed.length, failed_classes: [...new Set(p.failed.map((f) => f.cls))],
    ...(p.bench.length ? { bench: p.bench, bench_dropped: p.bench_dropped } : {}) };
}
async function finish(ctx: StepContext): Promise<StepOutcome> {
  return doneWith(summary(readProgress(ctx.progress)));
}

export const jevAskKind: JobKind = {
  name: JEV_ASK_KIND_NAME,
  roomData: false,
  roomDataNote: "reads no room data itself: a use's state builder declares and fetches its own evidence by id; blind/held-out guards are lifted (V, 10 Oct 2026)",
  first: "plan",
  scope: "invoke",
  parseArgs: parseJevAskArgs,
  dedupeOn: (args) => [["use", String(args.use)], ["mode", String(args.mode)], ["set_id", String(args.set_id)], ["version", String(args.version)], ["subjects_key", String(args.subjects_key)]],
  // The fast refusal on the generic submit path. The atomic cap is submitJevAskCapped (sweeper); the per-step check is the hard stop.
  precheck: async (args) => {
    const b = await budgetCheck(typeof args.reserve_usd === "number" ? args.reserve_usd : 0);
    if (!b.ok) throw new JobArgsError(`budget_exceeded: spent $${b.spent.toFixed(4)} of $${b.cap} today`);
  },
  run: async (ctx) => {
    if (ctx.step === "plan") return plan(ctx);
    if (ctx.step === "ask") return ask(ctx);
    if (ctx.step === "finish") return finish(ctx);
    return failWith(`unknown_step:${ctx.step}`);
  },
};

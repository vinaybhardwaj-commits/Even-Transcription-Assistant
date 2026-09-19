/**
 * lib/jobs/kinds/jev-window.ts — Slice J2 (ETA-JEV-ARM-D §5.2). Arm D's per-window Jev signals.
 *
 * READS jev_window_text (J0) — NEVER transcription_run.transcript_english / detected_language,
 * both NULL on every bench window (spec amendment banner). A room-day with NO jev_window_text
 * rows at all means J0 never ran for it: FAILS the job with jev_english_missing rather than
 * silently skipping (D-10/D-11 — "J0 never ran" and "nothing to translate" are different facts).
 * A window whose row has english IS NULL is a genuine, terminal-for-this-run skip: it is stamped
 * phase='non_clinical', all p_* = 0, prompt_version='skipped:no_english' WITHOUT calling Jev.
 *
 * STEP MACHINE (jobs/types.ts contract): `collect` reads bench_window + jev_window_text once,
 * writes the no-english skip rows immediately, and builds the batch plan (window ids only — NO
 * transcript text carried in `progress`, contract #4). `ask` processes ONE BATCH per step,
 * re-fetching each batch's text from jev_window_text by id (never held across steps), calling
 * Jev through lib/jev/client (mock or real, per ETA_JEV_MOCK/ETA_JEV_ENABLED), and persisting one
 * jev_window_signal row per TARGET window. Context windows (§5.2 step 2) are read-only and never
 * persisted from that batch.
 *
 * REFUTER F6 (19 Sep):
 *  (a) Batches are now sliced from the FULL ordered, non-already-signalled window list, not just
 *      the subset with English text. A window with no English text still gets its skip row
 *      written immediately in `collect` (unchanged), but it also keeps its PLACE in the batch
 *      sequence, appearing in that batch's `state.windows` as `{id, text: null, note: "no English
 *      text"}` — so "consecutive" (the window numbering Jev sees) reflects true chronological
 *      adjacency instead of silently closing the gap a no-English window leaves. A batch with no
 *      real target inside it (every window a placeholder) is dropped before it reaches `ask` —
 *      there is nothing to call Jev about.
 *  (b) A batch's `result.usage.input_tokens` is a TOTAL for every target window Jev was asked
 *      about in that call, not a per-window figure. Each row's own `input_tokens` column now
 *      stores that total divided by the number of target windows in the batch (rounded); the raw
 *      batch total is still summed exactly once into the job's own summary (`input_tokens`,
 *      `est_cost_usd`), unchanged.
 *  (c) An in-flight semaphore caps concurrent Jev calls per spec §5.2: at most
 *      `ETA_JEV_MAX_INFLIGHT_PER_JOB` (default 2) calls for the same room-day, and at most
 *      `ETA_JEV_MAX_INFLIGHT_GLOBAL` (default 4) calls across every room-day sharing this module
 *      instance. `ask` acquires a slot before calling `client.systemOne` and releases it in a
 *      `finally`, whether the call succeeds or throws.
 */
import { sql } from "@/lib/db";
import { getJevClient } from "@/lib/jev/client";
import { PROMPT_VERSION, SETTING, clinicalQuestion, clinicianQuestion, endQuestion, phaseQuestion, qid, startQuestion } from "@/lib/jev/prompts/arm-d-v1";
import type { JevAnswer } from "@/lib/jev/types";
import { JobArgsError, doneWith, failWith, nextStep, type JobKind, type StepContext, type StepOutcome } from "../types";

export const JEV_WINDOW_KIND = "jev_window";

function envInt(name: string, def: number): number {
  const raw = process.env[name];
  if (!raw) return def;
  const n = Number(raw);
  return Number.isFinite(n) ? Math.round(n) : def;
}
const ETA_JEV_BATCH_WINDOWS = envInt("ETA_JEV_BATCH_WINDOWS", 20);
const ETA_JEV_CONTEXT_WINDOWS = envInt("ETA_JEV_CONTEXT_WINDOWS", 2);
const SKIPPED_PROMPT_VERSION = "skipped:no_english";
const COST_PER_INPUT_TOKEN = 42e-9;

type WindowMeta = { id: string; session_id: string; start_ms: number; end_ms: number; hasEnglish: boolean };

// ---------------------------------------------------------------------------
// F6(c) — in-flight semaphore: per-job (room_day_id) cap 2, module-wide cap 4.
// ---------------------------------------------------------------------------
const ETA_JEV_MAX_INFLIGHT_PER_JOB = envInt("ETA_JEV_MAX_INFLIGHT_PER_JOB", 2);
const ETA_JEV_MAX_INFLIGHT_GLOBAL = envInt("ETA_JEV_MAX_INFLIGHT_GLOBAL", 4);

let moduleInFlight = 0;
const perJobInFlight = new Map<string, number>();
const waiters: Array<() => void> = [];

function tryAcquire(jobKey: string): boolean {
  const jobCount = perJobInFlight.get(jobKey) ?? 0;
  if (moduleInFlight >= ETA_JEV_MAX_INFLIGHT_GLOBAL || jobCount >= ETA_JEV_MAX_INFLIGHT_PER_JOB) return false;
  moduleInFlight += 1;
  perJobInFlight.set(jobKey, jobCount + 1);
  return true;
}

function release(jobKey: string): void {
  moduleInFlight = Math.max(0, moduleInFlight - 1);
  const remaining = (perJobInFlight.get(jobKey) ?? 1) - 1;
  if (remaining <= 0) perJobInFlight.delete(jobKey);
  else perJobInFlight.set(jobKey, remaining);
  const next = waiters.shift();
  if (next) next();
}

/** Test-only introspection: current in-flight counts. */
export function _jevInFlightForTests(): { module: number; perJob: Map<string, number> } {
  return { module: moduleInFlight, perJob: new Map(perJobInFlight) };
}

/** Test-only: reset the semaphore's shared state between tests. */
export function _resetJevInFlightForTests(): void {
  moduleInFlight = 0;
  perJobInFlight.clear();
  waiters.length = 0;
}

/** Acquire a slot for `jobKey`, waiting if either cap is currently full. Always release it. */
export async function acquireJevSlot(jobKey: string): Promise<() => void> {
  while (!tryAcquire(jobKey)) {
    await new Promise<void>((resolve) => waiters.push(resolve));
  }
  return () => release(jobKey);
}

function parseArgs(raw: unknown): Record<string, unknown> {
  if (!raw || typeof raw !== "object") throw new JobArgsError("args must be an object");
  const r = raw as Record<string, unknown>;
  if (typeof r.room_day_id !== "string" || !r.room_day_id.trim()) throw new JobArgsError("room_day_id is required");
  if (r.force !== undefined && typeof r.force !== "boolean") throw new JobArgsError("force must be a boolean");
  if (r.prompt_version !== undefined && typeof r.prompt_version !== "string") throw new JobArgsError("prompt_version must be a string");
  return { room_day_id: r.room_day_id.trim(), force: r.force === true, prompt_version: (r.prompt_version as string | undefined) ?? PROMPT_VERSION };
}

async function writeSkipRow(w: WindowMeta, roomDayId: string): Promise<void> {
  await sql`
    INSERT INTO jev_window_signal
      (window_id, room_day_id, session_id, start_ms, end_ms, phase, phase_probs, phase_confidence,
       p_start, p_end, p_clinician, p_clinical, model, prompt_version, input_tokens, batch_id)
    VALUES
      (${w.id}, ${roomDayId}, ${w.session_id}, ${w.start_ms}, ${w.end_ms}, 'non_clinical', ${JSON.stringify({ non_clinical: 1 })}::jsonb, 1,
       0, 0, 0, 0, 'none', ${SKIPPED_PROMPT_VERSION}, 0, 'skip')
    ON CONFLICT (window_id) DO UPDATE SET
      phase = EXCLUDED.phase, phase_probs = EXCLUDED.phase_probs, phase_confidence = EXCLUDED.phase_confidence,
      p_start = EXCLUDED.p_start, p_end = EXCLUDED.p_end, p_clinician = EXCLUDED.p_clinician, p_clinical = EXCLUDED.p_clinical,
      model = EXCLUDED.model, prompt_version = EXCLUDED.prompt_version, input_tokens = EXCLUDED.input_tokens, batch_id = EXCLUDED.batch_id,
      created_at = now()
  `;
}

async function collect(ctx: StepContext): Promise<StepOutcome> {
  const roomDayId = ctx.args.room_day_id as string;
  const force = ctx.args.force === true;
  const promptVersion = ctx.args.prompt_version as string;

  const windows = (await sql`
    SELECT id, session_id, start_ms, end_ms FROM bench_window WHERE room_day_id = ${roomDayId} ORDER BY start_ms
  `) as Array<{ id: string; session_id: string; start_ms: number; end_ms: number }>;

  const textRows = (await sql`
    SELECT window_id, english FROM jev_window_text WHERE room_day_id = ${roomDayId}
  `) as Array<{ window_id: string; english: string | null }>;

  if (textRows.length === 0) {
    return failWith("jev_english_missing");
  }
  const englishById = new Map(textRows.map((r) => [r.window_id, r.english]));

  let existing = new Set<string>();
  if (!force) {
    const rows = (await sql`SELECT window_id FROM jev_window_signal WHERE room_day_id = ${roomDayId}`) as Array<{ window_id: string }>;
    existing = new Set(rows.map((r) => r.window_id));
  }

  const meta: WindowMeta[] = windows.map((w) => ({ ...w, hasEnglish: !!englishById.get(w.id) }));
  const metaById = new Map(meta.map((m) => [m.id, m]));

  let skipped = 0;
  // F6(a): the eligible sequence keeps EVERY non-already-signalled window in order, English or
  // not — a no-English window still gets its skip row written here, but also keeps its place so
  // batches are sliced from the real, consecutive window list.
  const eligibleIds: string[] = [];
  for (const w of meta) {
    if (existing.has(w.id)) { skipped += 1; continue; }
    if (!w.hasEnglish) {
      await writeSkipRow(w, roomDayId);
      skipped += 1;
    }
    eligibleIds.push(w.id);
  }

  const rawBatches: string[][] = [];
  for (let i = 0; i < eligibleIds.length; i += ETA_JEV_BATCH_WINDOWS) rawBatches.push(eligibleIds.slice(i, i + ETA_JEV_BATCH_WINDOWS));
  // Drop a batch that is nothing but no-English placeholders — already fully persisted above,
  // and there is nothing left to ask Jev.
  const batches = rawBatches.filter((b) => b.some((id) => metaById.get(id)!.hasEnglish));

  if (batches.length === 0) {
    return doneWith({ room_day_id: roomDayId, windows_total: windows.length, windows_asked: 0, windows_skipped: skipped, calls: 0, input_tokens: 0, est_cost_usd: 0 });
  }

  return nextStep("ask", {
    room_day_id: roomDayId,
    prompt_version: promptVersion,
    windows_total: windows.length,
    windows_skipped: skipped,
    meta, // ids + session/start/end + hasEnglish only — no text
    batches,
    batch_index: 0,
    windows_asked: 0,
    calls: 0,
    input_tokens: 0,
  });
}

function contextFor(meta: WindowMeta[], firstTargetId: string): string[] {
  const idx = meta.findIndex((m) => m.id === firstTargetId);
  if (idx < 0) return [];
  const out: string[] = [];
  for (let i = idx - 1; i >= 0 && out.length < ETA_JEV_CONTEXT_WINDOWS; i--) {
    if (meta[i]!.hasEnglish) out.unshift(meta[i]!.id);
  }
  return out;
}

async function ask(ctx: StepContext): Promise<StepOutcome> {
  const roomDayId = ctx.progress.room_day_id as string;
  const promptVersion = ctx.progress.prompt_version as string;
  const meta = ctx.progress.meta as WindowMeta[];
  const batches = ctx.progress.batches as string[][];
  const batchIndex = ctx.progress.batch_index as number;
  const batch = batches[batchIndex]!;
  const metaById = new Map(meta.map((m) => [m.id, m]));

  // F6(a): split the batch into real targets (asked) and no-English placeholders (already
  // persisted in `collect`, kept here only so the state's window numbering stays consecutive).
  const targetIds = batch.filter((id) => metaById.get(id)!.hasEnglish);
  const placeholderIds = new Set(batch.filter((id) => !metaById.get(id)!.hasEnglish));

  const contextIds = targetIds.length > 0 ? contextFor(meta, targetIds[0]!) : [];
  const textFetchIds = [...contextIds, ...targetIds];
  const textRows = (await sql`
    SELECT window_id, english FROM jev_window_text WHERE window_id = ANY(${textFetchIds})
  `) as Array<{ window_id: string; english: string | null }>;
  const textById = new Map(textRows.map((r) => [r.window_id, r.english ?? ""]));

  const state = {
    setting: SETTING,
    context_windows: contextIds.map((id) => ({ id, text: textById.get(id) ?? "" })),
    windows: batch.map((id) =>
      placeholderIds.has(id) ? { id, text: null, note: "no English text" } : { id, text: textById.get(id) ?? "" },
    ),
  };

  const questions: Record<string, ReturnType<typeof phaseQuestion>> = {};
  for (const id of targetIds) {
    questions[qid.phase(id)] = phaseQuestion(id) as never;
    questions[qid.start(id)] = startQuestion(id) as never;
    questions[qid.end(id)] = endQuestion(id) as never;
    questions[qid.clinician(id)] = clinicianQuestion(id) as never;
    questions[qid.clinical(id)] = clinicalQuestion(id) as never;
  }

  const client = getJevClient();
  const batchId = `${roomDayId}:${batchIndex}`;

  // F6(c): at most ETA_JEV_MAX_INFLIGHT_PER_JOB calls for this room-day, ETA_JEV_MAX_INFLIGHT_GLOBAL overall.
  const releaseSlot = await acquireJevSlot(roomDayId);
  let result: Awaited<ReturnType<typeof client.systemOne>>;
  try {
    result = await client.systemOne({ state, questions }, { signal: ctx.signal });
  } finally {
    releaseSlot();
  }

  const nounVal = (a: JevAnswer | undefined): number => (a && a.type === "noul" ? a.noul : 0);

  // F6(b): the batch's own usage.input_tokens is a TOTAL for every target window asked about;
  // each row gets its share, the raw total is summed once into the job summary below.
  const perWindowTokens = targetIds.length > 0 ? Math.round(result.usage.input_tokens / targetIds.length) : 0;

  for (const id of targetIds) {
    const m = metaById.get(id)!;
    const phaseAns = result.answers[qid.phase(id)];
    const phase = phaseAns && phaseAns.type === "choice" ? phaseAns.choice : "non_clinical";
    const phaseProbs = phaseAns && phaseAns.type === "choice" ? phaseAns.probabilities : { non_clinical: 1 };
    const phaseConfidence = phaseAns && phaseAns.type === "choice" ? phaseAns.confidence : 0;
    const p_start = nounVal(result.answers[qid.start(id)]);
    const p_end = nounVal(result.answers[qid.end(id)]);
    const p_clinician = nounVal(result.answers[qid.clinician(id)]);
    const p_clinical = nounVal(result.answers[qid.clinical(id)]);

    await sql`
      INSERT INTO jev_window_signal
        (window_id, room_day_id, session_id, start_ms, end_ms, phase, phase_probs, phase_confidence,
         p_start, p_end, p_clinician, p_clinical, model, prompt_version, input_tokens, batch_id)
      VALUES
        (${id}, ${roomDayId}, ${m.session_id}, ${m.start_ms}, ${m.end_ms}, ${phase}, ${JSON.stringify(phaseProbs)}::jsonb, ${phaseConfidence},
         ${p_start}, ${p_end}, ${p_clinician}, ${p_clinical}, ${result.model}, ${promptVersion}, ${perWindowTokens}, ${batchId})
      ON CONFLICT (window_id) DO UPDATE SET
        phase = EXCLUDED.phase, phase_probs = EXCLUDED.phase_probs, phase_confidence = EXCLUDED.phase_confidence,
        p_start = EXCLUDED.p_start, p_end = EXCLUDED.p_end, p_clinician = EXCLUDED.p_clinician, p_clinical = EXCLUDED.p_clinical,
        model = EXCLUDED.model, prompt_version = EXCLUDED.prompt_version, input_tokens = EXCLUDED.input_tokens, batch_id = EXCLUDED.batch_id,
        created_at = now()
    `;
  }

  const windows_asked = (ctx.progress.windows_asked as number) + targetIds.length;
  const calls = (ctx.progress.calls as number) + 1;
  const input_tokens = (ctx.progress.input_tokens as number) + result.usage.input_tokens; // raw batch total, once

  if (batchIndex + 1 < batches.length) {
    return nextStep("ask", { ...ctx.progress, batch_index: batchIndex + 1, windows_asked, calls, input_tokens });
  }
  return doneWith({
    room_day_id: roomDayId,
    windows_total: ctx.progress.windows_total,
    windows_asked,
    windows_skipped: ctx.progress.windows_skipped,
    calls,
    input_tokens,
    est_cost_usd: input_tokens * COST_PER_INPUT_TOKEN,
  });
}

export const jevWindowKind: JobKind = {
  name: JEV_WINDOW_KIND,
  first: "collect",
  scope: "invoke",
  parseArgs,
  run: async (ctx: StepContext): Promise<StepOutcome> => {
    if (ctx.step === "ask") return ask(ctx);
    return collect(ctx);
  },
};

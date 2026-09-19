/**
 * lib/jobs/kinds/jev-english.ts — Slice J0 (ETA-JEV-ARM-D §3A). Produce the English text Arm D reads.
 *
 * Arm D's declared input (transcription_run.transcript_english for bench windows) is NULL on every
 * window. This job derives the English for one room-day and persists it in jev_window_text, so the
 * arm has an input and so "no English for this window" is an evidenced state, never an absence
 * (D-11: a row is ALWAYS written per window read).
 *
 * PER WINDOW (lib/jev/english.ts decides steps 1–2, PURE):
 *   1. transcript_english non-empty        → source='run_english'   (free; NULL today, live path later)
 *   2. else already-English per metrics_json → source='native_en'    (store transcript_original as-is)
 *   3. else, IF ETA_JEV_TRANSLATE_ENABLED   → translate on the Mini  → source='translated'
 *   4. else / empty result / no original     → english=NULL, source='empty'
 *
 * THE MODEL IS NEVER LOADED UNLESS STEP 3 RUNS. ETA_JEV_TRANSLATE_ENABLED unset → step 3 is skipped
 * entirely (those windows land 'empty') and lib/jev/translate.ts is never called. When it is set,
 * translation runs in BOUNDED BATCHES (JEV_TRANSLATE_BATCH per step) so a step stays under the job
 * ceiling and the runner reclaims between batches — the 11.5 GB model is resident only while a batch
 * is translating, and Ollama's idle expiry unloads it between the runner's claims.
 *
 * RESUMABLE, and no transcript text in progress (types.ts contract #4): the classify step records
 * only the window ids that still need translation; the translate step RE-FETCHES each original from
 * transcription_run by id. Every write is an upsert on the window_id primary key, so a replayed step
 * is idempotent. `force` re-runs windows already in jev_window_text; without it they are skipped.
 */
import { sql } from "@/lib/db";
import { parseFlag, FlagValueError } from "@/lib/flags";
import { classifyWindow, emptyRow, notReadyRow, failedRow, translatedRow, TERMINAL_SOURCES, type JevWindowText } from "@/lib/jev/english";
import { translateToEnglish } from "@/lib/jev/translate";
import { JobArgsError, doneWith, failWith, nextStep, type JobKind, type StepContext, type StepOutcome } from "../types";

export const JEV_ENGLISH_KIND = "jev_english"; // name underscore (matches diarize_window/emotion_window); file stays jev-english.ts. Spec wrote "jev-english" — see report.
export const ETA_JEV_TRANSLATE_ENABLED = "ETA_JEV_TRANSLATE_ENABLED";
/** Windows translated per step. Sized so a step of up-to-60 s calls stays under MAX_STEP_MS (~200 s). */
export const JEV_TRANSLATE_BATCH = 3;

type Counts = { run_english: number; native_en: number; translated: number; empty: number; not_ready: number; failed: number };
const zero = (): Counts => ({ run_english: 0, native_en: 0, translated: 0, empty: 0, not_ready: 0, failed: 0 });
const bump = (c: Counts, s: JevWindowText["source"]) => { c[s] += 1; };

type RunRow = {
  transcript_english: string | null;
  transcript_original: string | null;
  metrics_json: unknown;
  detected_language: string | null;
};

/** The latest ASR run for one bench window, or null when the window has never been transcribed. */
async function latestRun(windowId: string): Promise<RunRow | null> {
  const rows = (await sql`
    SELECT transcript_english, transcript_original, metrics_json, detected_language
      FROM transcription_run
     WHERE subject_type = 'bench_window' AND subject_id = ${windowId}
     ORDER BY created_at DESC
     LIMIT 1
  `) as RunRow[];
  return rows[0] ?? null;
}

async function writeRow(row: JevWindowText): Promise<void> {
  await sql`
    INSERT INTO jev_window_text (window_id, room_day_id, english, source, char_count, model, error, input_chars, latency_ms)
    VALUES (${row.window_id}, ${row.room_day_id}, ${row.english}, ${row.source}, ${row.char_count}, ${row.model}, ${row.error}, ${row.input_chars}, ${row.latency_ms})
    ON CONFLICT (window_id) DO UPDATE
      SET room_day_id = EXCLUDED.room_day_id,
          english     = EXCLUDED.english,
          source      = EXCLUDED.source,
          char_count  = EXCLUDED.char_count,
          model       = EXCLUDED.model,
          error       = EXCLUDED.error,
          input_chars = EXCLUDED.input_chars,
          latency_ms  = EXCLUDED.latency_ms,
          created_at  = now()
  `;
}

/** metrics_json.sarvam_language, else the run's detected_language, else "hi" — a code, never text. */
function langHint(run: RunRow): string {
  const m = run.metrics_json;
  if (m && typeof m === "object") {
    const s = (m as { sarvam_language?: unknown }).sarvam_language;
    if (typeof s === "string" && s.trim()) return s.trim();
  }
  return run.detected_language?.trim() || "hi";
}

function parseArgs(raw: unknown): Record<string, unknown> {
  if (!raw || typeof raw !== "object") throw new JobArgsError("args must be an object");
  const r = raw as Record<string, unknown>;
  if (typeof r.room_day_id !== "string" || !r.room_day_id.trim()) throw new JobArgsError("room_day_id is required");
  if (r.force !== undefined && typeof r.force !== "boolean") throw new JobArgsError("force must be a boolean");
  return { room_day_id: r.room_day_id.trim(), force: r.force === true };
}

async function classify(ctx: StepContext): Promise<StepOutcome> {
  const roomDayId = ctx.args.room_day_id as string;
  const force = ctx.args.force === true;

  // The flag is read HERE, once. An unrecognised value fails the job loudly (never read as off).
  let translateEnabled: boolean;
  try {
    translateEnabled = parseFlag(ETA_JEV_TRANSLATE_ENABLED);
  } catch (e) {
    if (e instanceof FlagValueError) return failWith(`jev-english: ${e.message}`);
    throw e;
  }

  const windows = (await sql`SELECT id FROM bench_window WHERE room_day_id = ${roomDayId} ORDER BY start_ms`) as Array<{ id: string }>;

  // Skip only windows already in a TERMINAL source. not_ready (no run yet / gated off) and failed
  // (a translation attempt) are deliberately NOT skipped — they are re-evaluated every run, which is
  // how "no run yet" becomes a real source on its own once a run appears, with no force and no human.
  let skip = new Set<string>();
  if (!force) {
    const existing = (await sql`SELECT window_id, source FROM jev_window_text WHERE room_day_id = ${roomDayId}`) as Array<{ window_id: string; source: JevWindowText["source"] }>;
    skip = new Set(existing.filter((r) => TERMINAL_SOURCES.has(r.source)).map((r) => r.window_id));
  }

  const counts = zero();
  const toTranslate: string[] = [];
  let skipped = 0;

  for (const w of windows) {
    if (skip.has(w.id)) { skipped += 1; continue; }
    const run = await latestRun(w.id);
    if (!run) {
      // (a) NO RUN YET — not terminal. It becomes eligible again on its own when a run appears.
      await writeRow(notReadyRow(w.id, roomDayId));
      bump(counts, "not_ready");
      continue;
    }
    const c = classifyWindow({
      window_id: w.id,
      room_day_id: roomDayId,
      transcript_english: run.transcript_english,
      transcript_original: run.transcript_original,
      metrics: (run.metrics_json ?? null) as never,
    });
    if ("done" in c) {
      await writeRow(c.done);
      bump(counts, c.done.source);
    } else if (c.original === null) {
      // (b) A run exists and its source text is genuinely empty. Terminal, honest.
      await writeRow(emptyRow(w.id, roomDayId));
      bump(counts, "empty");
    } else if (!translateEnabled) {
      // Translation gated off, but there IS text to translate — NOT terminal. Re-evaluated once the
      // flag is on. (This is the milder form of the same bug: gated-off must not read as done.)
      await writeRow(notReadyRow(w.id, roomDayId));
      bump(counts, "not_ready");
    } else {
      // Defer only the id — the original is re-fetched in the translate step (no text in progress).
      toTranslate.push(w.id);
    }
  }

  if (toTranslate.length === 0) {
    return doneWith({ room_day_id: roomDayId, windows: windows.length, skipped, ...counts });
  }
  return nextStep("translate", { room_day_id: roomDayId, windows: windows.length, skipped, to_translate: toTranslate, counts });
}

async function translate(ctx: StepContext): Promise<StepOutcome> {
  const roomDayId = ctx.progress.room_day_id as string;
  const remaining = [...((ctx.progress.to_translate as string[]) ?? [])];
  const counts = { ...zero(), ...((ctx.progress.counts as Counts) ?? {}) };
  const windows = (ctx.progress.windows as number) ?? 0;
  const skipped = (ctx.progress.skipped as number) ?? 0;

  const batch = remaining.splice(0, JEV_TRANSLATE_BATCH);
  for (const windowId of batch) {
    const run = await latestRun(windowId);
    const original = run?.transcript_original?.trim() || null;
    if (!original) { await writeRow(emptyRow(windowId, roomDayId)); bump(counts, "empty"); continue; }
    const outcome = await translateToEnglish(original, langHint(run!), { signal: ctx.signal });
    // A qwen error/timeout/abort is a RETRYABLE failure recorded with its reason — never 'empty'.
    // A successful-but-empty output is also a failure (empty_output), via translatedRow.
    const row = outcome.status === "failed"
      ? failedRow(windowId, roomDayId, outcome.reason)
      : translatedRow(windowId, roomDayId, outcome);
    await writeRow(row);
    bump(counts, row.source);
  }

  if (remaining.length > 0) {
    return nextStep("translate", { room_day_id: roomDayId, windows, skipped, to_translate: remaining, counts });
  }
  return doneWith({ room_day_id: roomDayId, windows, skipped, ...counts });
}

export const jevEnglishKind: JobKind = {
  name: JEV_ENGLISH_KIND,
  first: "classify",
  scope: "invoke",
  parseArgs,
  run: async (ctx: StepContext): Promise<StepOutcome> => {
    if (ctx.step === "translate") return translate(ctx);
    return classify(ctx);
  },
};

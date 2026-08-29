/**
 * lib/stt/window-scoring.ts — the refusal-emitting scorer (Build 2 §C).
 *
 * PRD §4: "no code path renders WER without its refusal rate." That is not a reporting
 * convention, it is the design of this file. A scorer that silently drops the pairs it cannot
 * handle produces a leaderboard about the easy tape, and the easy tape is exactly the tape whose
 * numbers nobody needed.
 *
 * So every (window, engine) pair reaches one of two outcomes and never a third: it is SCORED, or
 * it is REFUSED with a reason from a closed set. Skipping is not available.
 *
 * ─── WHY EVERY PAIR REFUSES TODAY, AND WHY THAT IS THE CORRECT ANSWER ─────────────────────
 * Two independent reasons, both by design:
 *   1. The five Cardiology seeds are `status='seed'`, not 'graduated'. Graduation needs a blind
 *      human re-listen (PRD §1.4) and Build 2 deliberately ships no graduation tooling.
 *   2. No adapter reports a provider engine version, so `receipt_complete` is false everywhere
 *      (see receipt.ts — flagged).
 * A leaderboard of zero scored pairs and a full refusal breakdown is the honest state of this
 * system today. It is what the build is FOR: the previous state was not "no numbers", it was
 * "numbers with no idea what they excluded".
 *
 * ─── ALL SQL HERE IS INFERRED ─────────────────────────────────────────────────────────────
 * No live database in the sandbox. Every read fails safe to empty with a logged reason and never
 * throws; a read that fails produces NO score and NO refusal, because a refusal invented from a
 * failed read is a false statement about an engine.
 */

import { sql } from "@/lib/db";
import { wer, cer } from "./wer";

/** The closed vocabulary. Mirrors the CHECK on stt_score_refusal.reason_code (migration 0072). */
export type RefusalReason =
  | "NO_RECEIPT"
  | "LEGACY_UNRECEIPTED"
  | "NO_GOLD"
  | "GOLD_NOT_GRADUATED"
  | "FAMILY_CONTAMINATION"
  | "COVERAGE_BELOW_FLOOR"
  | "SILENCE_UNTYPED";

/** PRD §4 — 60% of covered_ms/window_ms. */
export const COVERAGE_FLOOR = 0.6;

export type GoldRow = {
  window_id: string;
  reference_text: string;
  status: string;
  seed_engine_family: string | null;
  covered_ms: number | null;
  window_ms: number | null;
  silence_spans_json: unknown;
};

export type RunRow = {
  id: string;
  engine: string;
  transcript_original: string | null;
  receipt_complete: boolean | null;
  created_at: string | Date;
};

/** A typed silence span. An untyped or unrecognised span is not evidence about silence. */
export type SilenceSpan = { start_ms: number; end_ms: number; type: "equipment" | "corridor" | "ambient" };

const SPAN_TYPES = new Set(["equipment", "corridor", "ambient"]);

/**
 * PURE — parse typed silence spans, or null when they are not usable.
 *
 * NULL AND "PRESENT BUT UNTYPED" COLLAPSE TO THE SAME ANSWER on purpose. A span with no type, or
 * a type outside the closed set, tells you a stretch was quiet but not what KIND of quiet — and
 * the insertion metric's whole claim is that words appearing during typed silence are
 * hallucinations. An untyped span cannot support that claim, so it refuses exactly as a missing
 * one does.
 */
export function parseSilenceSpans(raw: unknown): SilenceSpan[] | null {
  if (!Array.isArray(raw) || raw.length === 0) return null;
  const out: SilenceSpan[] = [];
  for (const item of raw) {
    if (typeof item !== "object" || item === null) return null;
    const o = item as Record<string, unknown>;
    const start = Number(o.start_ms);
    const end = Number(o.end_ms);
    const type = o.type;
    if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) return null;
    if (typeof type !== "string" || !SPAN_TYPES.has(type)) return null;
    out.push({ start_ms: start, end_ms: end, type: type as SilenceSpan["type"] });
  }
  return out.length > 0 ? out : null;
}

/**
 * PURE — clip a hypothesis to the fraction of the window the reference actually covers.
 *
 * ═══ FLAGGED APPROXIMATION ═══
 * `covered_ms` is a SCALAR duration, not a set of spans, so there is no way to know WHICH part of
 * the window the labeller transcribed — only how much. This takes the leading proportion of the
 * hypothesis by word count.
 *
 * That is right when a labeller worked from the start of the window and stopped, which is how
 * partial transcription actually happens, and wrong if they transcribed the middle. The spec
 * settles the floor (60%) but not the clip method; a proportional leading clip is the only thing
 * derivable from the column that exists, and it is stated here rather than hidden because a WER
 * computed against a mis-clipped hypothesis is a wrong number that looks exactly like a right one.
 * Recording covered SPANS instead of a scalar would remove the guess entirely — raised, not done.
 *
 * Full coverage clips nothing, which is the case every current seed is in (covered = window).
 */
export function clipHypothesisToCovered(
  hypothesis: string,
  coveredMs: number | null,
  windowMs: number | null,
): string {
  if (!hypothesis) return "";
  if (!coveredMs || !windowMs || windowMs <= 0) return hypothesis;
  if (coveredMs >= windowMs) return hypothesis;
  const words = hypothesis.trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return "";
  const keep = Math.max(1, Math.ceil(words.length * (coveredMs / windowMs)));
  return words.slice(0, keep).join(" ");
}

/** PURE — coverage ratio, or null when the gold does not state one. */
export function coverageRatio(coveredMs: number | null, windowMs: number | null): number | null {
  if (coveredMs === null || windowMs === null || !Number.isFinite(coveredMs) || !Number.isFinite(windowMs)) return null;
  if (windowMs <= 0) return null;
  return coveredMs / windowMs;
}

export type ScoreDecision =
  | { kind: "refused"; reason: RefusalReason }
  | {
      kind: "scored";
      wer: number | null;
      cer: number | null;
      /** Null with its own reason when spans are missing or untyped — WER still stands. */
      insertions_per_silent_second: number | null;
      insertion_refusal: "SILENCE_UNTYPED" | null;
    };

export type DecideInput = {
  gold: GoldRow | null;
  run: RunRow;
  /** The engine's family, resolved through stt_engine_family. Null = not in the registry. */
  engineFamily: string | null;
  /** applied_at of migration 0072; runs older than this are LEGACY, not merely unreceipted. */
  spineAppliedAt: Date | null;
  /** Transcript spans on the wall clock, for the insertion metric. */
  textSpans?: ReadonlyArray<{ start_ms: number; end_ms: number; text?: string | null }>;
};

/**
 * PURE — the whole decision for one (window, engine) pair.
 *
 * ═══ PRECEDENCE, DECIDED AND STATED ═══
 * The schema carries ONE reason per pair, so when several are true one must win. The order runs
 * from "there is nothing to score against" to "there is a reference but this run is not
 * admissible against it":
 *
 *   1. NO_GOLD               no reference exists. Nothing else can be evaluated without one.
 *   2. GOLD_NOT_GRADUATED    a reference exists but nobody has verified it.
 *   3. FAMILY_CONTAMINATION  checked AFTER graduation and therefore SURVIVES it — a graduated
 *                            seed still refuses its own family, which is the point of storing
 *                            seed_engine_family past graduation at all.
 *   4. COVERAGE_BELOW_FLOOR  the reference is real and clean but covers too little of the window.
 *   5. NO_RECEIPT / LEGACY_UNRECEIPTED   the reference is fine; this particular RUN is not
 *                            auditable.
 *
 * The spec does not fix this order, so it is flagged. Gold-first is chosen because a missing or
 * unverified reference is a fact about the PROGRAMME (it tells V what labour is owed), while an
 * unreceipted run is a fact about one row — and today, when both are true of every pair, the
 * breakdown should name the blocker a human can act on.
 */
export function decideScore(input: DecideInput): ScoreDecision {
  const { gold, run, engineFamily, spineAppliedAt } = input;

  if (!gold) return { kind: "refused", reason: "NO_GOLD" };
  if (gold.status !== "graduated") return { kind: "refused", reason: "GOLD_NOT_GRADUATED" };

  // FAIL CLOSED ON AN UNKNOWN FAMILY — flagged. An engine with no stt_engine_family row cannot be
  // PROVEN uncontaminated, and the two directions are not symmetric: wrongly refusing costs a
  // number, wrongly scoring publishes an engine grading its own output. The closed reason set has
  // no code for "family unknown", and adding an eighth would widen a set the spec closed, so the
  // refusal borrows FAMILY_CONTAMINATION. Migration 0072 seeds every existing key plus the
  // reserved Gemini key precisely so this branch stays unreachable in practice.
  if (gold.seed_engine_family !== null) {
    if (engineFamily === null || engineFamily === gold.seed_engine_family) {
      return { kind: "refused", reason: "FAMILY_CONTAMINATION" };
    }
  }

  const ratio = coverageRatio(gold.covered_ms, gold.window_ms);
  // A gold row that does not state its coverage cannot clear a coverage floor. Treated as below
  // it rather than waved through: the floor exists to stop a reference of one sentence scoring a
  // fifteen-minute window, and "unstated" is not evidence that it does not.
  if (ratio === null || ratio < COVERAGE_FLOOR) {
    return { kind: "refused", reason: "COVERAGE_BELOW_FLOOR" };
  }

  if (run.receipt_complete !== true) {
    const created = run.created_at instanceof Date ? run.created_at : new Date(run.created_at);
    // LEGACY vs NO_RECEIPT is a statement about whether the run COULD have carried a receipt.
    // A run written before the spine existed had no columns to write into and is not a fault;
    // one written after had every column available and did not fill them, which is.
    const isLegacy =
      spineAppliedAt !== null && Number.isFinite(created.getTime()) && created < spineAppliedAt;
    return { kind: "refused", reason: isLegacy ? "LEGACY_UNRECEIPTED" : "NO_RECEIPT" };
  }

  // ── Scored. WER first, and it does NOT depend on the silence spans. ──────────────────────
  const hypothesis = clipHypothesisToCovered(run.transcript_original ?? "", gold.covered_ms, gold.window_ms);
  const werValue = wer(gold.reference_text, hypothesis);
  const cerValue = cer(gold.reference_text, hypothesis);

  const spans = parseSilenceSpans(gold.silence_spans_json);
  if (spans === null) {
    // §C — the insertion metric refuses ALONE. WER is already computed above and stands; only the
    // number that genuinely requires typed spans is withheld.
    return {
      kind: "scored",
      wer: werValue,
      cer: cerValue,
      insertions_per_silent_second: null,
      insertion_refusal: "SILENCE_UNTYPED",
    };
  }

  return {
    kind: "scored",
    wer: werValue,
    cer: cerValue,
    insertions_per_silent_second: insertionsPerSilentSecond(input.textSpans ?? [], spans),
    insertion_refusal: null,
  };
}

/**
 * PURE — words the engine placed inside typed silence, per second of that silence.
 *
 * A word counts when the span carrying it OVERLAPS a silence span. Overlap rather than
 * containment: a phrase that begins in speech and runs into silence still put words where there
 * were none, and requiring containment would score a hallucination as clean simply because it
 * started early.
 */
export function insertionsPerSilentSecond(
  textSpans: ReadonlyArray<{ start_ms: number; end_ms: number; text?: string | null }>,
  silence: readonly SilenceSpan[],
): number | null {
  const silentMs = silence.reduce((a, s) => a + (s.end_ms - s.start_ms), 0);
  if (silentMs <= 0) return null;
  let words = 0;
  for (const t of textSpans) {
    const text = (t.text ?? "").trim();
    if (!text) continue;
    const hits = silence.some((s) => t.start_ms < s.end_ms && t.end_ms > s.start_ms);
    if (hits) words += text.split(/\s+/).filter(Boolean).length;
  }
  return Math.round((words / (silentMs / 1000)) * 1000) / 1000;
}

// ---------------------------------------------------------------------------
// The database half — every read fails safe
// ---------------------------------------------------------------------------

type Logger = (msg: string) => void;

async function safeRead<T>(what: string, fallback: T, log: Logger, run: () => Promise<T>): Promise<{ ok: boolean; value: T }> {
  try {
    return { ok: true, value: await run() };
  } catch (e) {
    log(`[score] read failed (${what}): ${String((e as Error)?.message ?? e).slice(0, 200)} — degraded to empty, nothing written`);
    return { ok: false, value: fallback };
  }
}

const refusalId = () => `sr_${Math.random().toString(36).slice(2, 12)}`;

export type ScoreRunResult = {
  pairs: number;
  scored: number;
  refused: number;
  refusal_breakdown: Record<string, number>;
  errors: string[];
};

/**
 * Score every (window, engine) pair that has a room run, writing a refusal for each declined one.
 * Never throws.
 */
export async function scoreWindows(opts: { limit?: number; log?: Logger } = {}): Promise<ScoreRunResult> {
  const log = opts.log ?? ((m: string) => console.log(m));
  const limit = Math.max(1, Math.min(1000, Math.trunc(opts.limit ?? 500) || 500));
  const errors: string[] = [];
  const result: ScoreRunResult = { pairs: 0, scored: 0, refused: 0, refusal_breakdown: {}, errors };

  // INFERRED SQL #1 — when the spine landed. Runs older than this are LEGACY_UNRECEIPTED rather
  // than NO_RECEIPT. A missing row means we cannot tell the two apart, and the code then reports
  // NO_RECEIPT — the stricter of the two — rather than excusing a run it cannot date.
  const applied = await safeRead<Array<{ applied_at: string }>>("schema_migrations 72", [], log, async () =>
    (await sql`SELECT applied_at FROM schema_migrations WHERE version = 72 LIMIT 1`) as Array<{ applied_at: string }>);
  const spineAppliedAt = applied.value[0]?.applied_at ? new Date(applied.value[0].applied_at) : null;

  // INFERRED SQL #2 — every room run, with its gold and its family already joined. LEFT JOINs
  // throughout: a run with no gold and a run with no family row must both still reach the
  // decision, because both are refusals and a missing row that silently dropped the pair would be
  // the skip this file exists to make impossible.
  const rows = await safeRead<Array<Record<string, unknown>>>("run/gold/family join", [], log, async () =>
    (await sql`
      SELECT r.id, r.engine, r.transcript_original, r.receipt_complete, r.created_at,
             r.subject_id AS window_id,
             f.family AS engine_family,
             g.reference_text, g.status AS gold_status, g.seed_engine_family,
             g.covered_ms, g.window_ms, g.silence_spans_json
        FROM transcription_run r
        LEFT JOIN stt_engine_family f ON f.engine_key = r.engine
        LEFT JOIN stt_gold_window   g ON g.window_id = r.subject_id
       WHERE r.subject_type = 'bench_window'
       ORDER BY r.created_at DESC
       LIMIT ${limit}
    `) as Array<Record<string, unknown>>);

  if (!rows.ok) {
    errors.push("run/gold/family join failed");
    return result;
  }

  for (const row of rows.value) {
    const windowId = String(row.window_id ?? "");
    const engineKey = String(row.engine ?? "");
    if (!windowId || !engineKey) continue;
    result.pairs++;

    const gold: GoldRow | null = row.reference_text
      ? {
          window_id: windowId,
          reference_text: String(row.reference_text),
          status: String(row.gold_status ?? ""),
          seed_engine_family: row.seed_engine_family === null || row.seed_engine_family === undefined ? null : String(row.seed_engine_family),
          covered_ms: row.covered_ms === null || row.covered_ms === undefined ? null : Number(row.covered_ms),
          window_ms: row.window_ms === null || row.window_ms === undefined ? null : Number(row.window_ms),
          silence_spans_json: row.silence_spans_json,
        }
      : null;

    const decision = decideScore({
      gold,
      run: {
        id: String(row.id),
        engine: engineKey,
        transcript_original: row.transcript_original === null || row.transcript_original === undefined ? null : String(row.transcript_original),
        receipt_complete: row.receipt_complete === true,
        created_at: String(row.created_at),
      },
      engineFamily: row.engine_family === null || row.engine_family === undefined ? null : String(row.engine_family),
      spineAppliedAt,
    });

    if (decision.kind === "refused") {
      result.refused++;
      result.refusal_breakdown[decision.reason] = (result.refusal_breakdown[decision.reason] ?? 0) + 1;
      try {
        // INFERRED SQL #3 — idempotent by the unique index on (window_id, engine_key, reason_code),
        // so a nightly re-score does not grow n_refused while nothing has changed.
        await sql`
          INSERT INTO stt_score_refusal (id, window_id, engine_key, reason_code, created_at)
          VALUES (${refusalId()}, ${windowId}, ${engineKey}, ${decision.reason}, NOW())
          ON CONFLICT (window_id, engine_key, reason_code) DO NOTHING
        `;
      } catch (e) {
        const msg = `[score] ${windowId}/${engineKey}: refusal write failed: ${String((e as Error)?.message ?? e).slice(0, 200)}`;
        log(msg);
        errors.push(msg);
      }
      continue;
    }

    result.scored++;
    if (decision.insertion_refusal) {
      try {
        // The insertion metric refused on its own; the pair is SCORED, and this row records only
        // that one number was withheld. It is not counted in `refused` — the pair was not.
        await sql`
          INSERT INTO stt_score_refusal (id, window_id, engine_key, reason_code, created_at)
          VALUES (${refusalId()}, ${windowId}, ${engineKey}, 'SILENCE_UNTYPED', NOW())
          ON CONFLICT (window_id, engine_key, reason_code) DO NOTHING
        `;
      } catch { /* the score stands whether or not the note lands */ }
    }

    try {
      // INFERRED SQL #4 — scores live in stt_window_score (Build 1's table), never on the run row.
      await sql`
        INSERT INTO stt_window_score (window_id, engine_key, metrics_json, computed_at)
        VALUES (${windowId}, ${engineKey}, ${JSON.stringify({
          wer: decision.wer,
          cer: decision.cer,
          insertions_per_silent_second: decision.insertions_per_silent_second,
          insertion_refusal: decision.insertion_refusal,
          scorer_version: "window-scoring-v1",
        })}::jsonb, NOW())
        ON CONFLICT (window_id, engine_key) DO UPDATE SET
          metrics_json = stt_window_score.metrics_json || EXCLUDED.metrics_json,
          computed_at = NOW()
      `;
    } catch (e) {
      const msg = `[score] ${windowId}/${engineKey}: score write failed: ${String((e as Error)?.message ?? e).slice(0, 200)}`;
      log(msg);
      errors.push(msg);
    }
  }

  log(`[score] pairs=${result.pairs} scored=${result.scored} refused=${result.refused}`);
  return result;
}

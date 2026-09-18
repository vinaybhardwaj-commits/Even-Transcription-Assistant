/**
 * lib/stt/measure-job.ts — the nightly measure job (Build 1 §B, §D).
 *
 * Per closed window not yet measured: read its chunks, partition its milliseconds, score its
 * language opinions, write one stt_window_measure row and (where a transcript exists) one
 * stt_window_score row per engine. Then run the tuning fork once for the whole pass.
 *
 * ─── EVERY SQL STRING IN THIS FILE IS INFERRED ────────────────────────────────────────────
 * This was built with no live database. Column names on bench_chunk and bench_window, and the
 * metrics_json keys on transcription_run, are read from the migrations and from the drain's own
 * INSERT — which is good evidence but is not the same as having run the query. Two consequences
 * are designed in rather than hoped for:
 *
 *   (a) EVERY READ FAILS SAFE. A query that throws degrades to an empty result with a logged
 *       reason. It never 500s the endpoint, never aborts the pass, and — the part that matters —
 *       never writes a row built out of a partial answer. A window whose chunks could not be read
 *       is a window that goes unmeasured tonight and is picked up tomorrow, which is exactly what
 *       "not yet measured" already means. A measurement written from a failed read would be
 *       indistinguishable from a real one for ever.
 *
 *   (b) EVERY INFERRED STRING AND KEY IS LISTED VERBATIM IN THE BUILD REPORT for an orchestrator
 *       to validate against production before any number here is trusted.
 *
 * ─── IDEMPOTENCE IS STRUCTURAL ────────────────────────────────────────────────────────────
 * stt_window_measure.window_id is the primary key and every write is an UPSERT, so a second
 * writer racing the first cannot produce a duplicate — the second simply wins the row with an
 * identical value. The job also only SELECTS windows with no measure row, so the normal case is
 * that a rerun does nothing at all. §3's "cron overlapping itself → idempotent by window id,
 * second writer loses" is therefore enforced by the schema and not by this file's own care.
 */

import { sql } from "@/lib/db";
import { getObjectBytes, headObject } from "@/lib/r2";
import { transcribeWithWhisper } from "@/lib/whisper";
import {
  measureWindow,
  confusabilityOf,
  scoreWindow,
  roomEnergyFloor,
  PROXY_VERSION,
  type MeasureChunk,
  type TextSpan,
} from "./window-measure";
import {
  runTuningFork,
  TUNING_FORK_R2_KEY,
  ALARM_KIND_REFERENCE,
  type ForkOutcome,
} from "./tuning-fork";
import { scoreWindows, type ScoreRunResult } from "./window-scoring";

/** How many windows one pass will measure. Bounded so the pass fits a single invocation. */
export const MEASURE_BATCH_LIMIT = 200;

const alarmId = () => `ca_${Math.random().toString(36).slice(2, 12)}`;

type Logger = (msg: string) => void;

/**
 * A read that returns a fallback instead of throwing, and says why.
 *
 * THE POINT OF THE FALLBACK IS THAT IT IS EMPTY, NOT THAT IT IS SAFE. Returning `[]` from a
 * failed chunk read means the window looks like it has no audio — which is why every caller
 * below treats a failed read as "skip this window", never as "measure it as NO_AUDIO". A
 * degraded read must produce no row at all; producing a confident wrong row is the one outcome
 * this whole build exists to prevent.
 */
async function safeRead<T>(what: string, fallback: T, log: Logger, run: () => Promise<T>): Promise<{ ok: boolean; value: T }> {
  try {
    return { ok: true, value: await run() };
  } catch (e) {
    log(`[measure] read failed (${what}): ${String((e as Error)?.message ?? e).slice(0, 200)} — degraded to empty, no row written`);
    return { ok: false, value: fallback };
  }
}

export type MeasureWindowRow = {
  id: string;
  session_id: string;
  room_id: string | null;
  start_ms: string | number;
  end_ms: string | number;
  source_mic: string;
};

export type MeasureJobResult = {
  scanned: number;
  measured: number;
  skipped_unreadable: number;
  quarantined: Record<string, number>;
  scores_written: number;
  /** The coverage report §3 calls the job's first honest output. */
  coverage: {
    windows: number;
    energy_ms: number;
    silent_ms: number;
    unknown_ms: number;
    /** Fraction of measured window time that carries a usable peak_level at all. */
    level_coverage: number | null;
  };
  fork: ForkOutcome | { kind: "not_run"; reason: string };
  /**
   * Build 3 §C — the scoring pass (PRD §1.2a).
   *
   * Build 2 shipped a refusal-emitting scorer that NOTHING CALLED: `window-scoring.ts` was
   * reachable only from its own test, because the spec named the function and never its
   * invocation. A scorer with no trigger produces an empty leaderboard that looks exactly like a
   * leaderboard of engines nobody has run — the precise ambiguity the refusal vocabulary exists
   * to abolish. This is that trigger.
   */
  scoring: ScoreRunResult | { skipped: string };
  /**
   * Gold rows whose window has NO room run at all. Reported rather than scored, because a
   * (window, engine) pair needs an engine and a gold row alone does not name one — so there is
   * literally no pair to refuse. Counted so a reference that nobody has run against is visible
   * instead of vanishing between the two enumerations.
   */
  gold_without_run: number | null;
  proxy_version: string;
  errors: string[];
};

/**
 * One pass. Never throws — a caller gets a result describing what happened, including nothing.
 */
export async function runMeasureJob(opts: { limit?: number; log?: Logger; skipFork?: boolean; skipScoring?: boolean } = {}): Promise<MeasureJobResult> {
  const log = opts.log ?? ((m: string) => console.log(m));
  const limit = Math.max(1, Math.min(MEASURE_BATCH_LIMIT, Math.trunc(opts.limit ?? MEASURE_BATCH_LIMIT) || MEASURE_BATCH_LIMIT));
  const errors: string[] = [];
  const result: MeasureJobResult = {
    scanned: 0, measured: 0, skipped_unreadable: 0, quarantined: {}, scores_written: 0,
    coverage: { windows: 0, energy_ms: 0, silent_ms: 0, unknown_ms: 0, level_coverage: null },
    fork: { kind: "not_run", reason: "not_reached" },
    scoring: { skipped: "not_reached" },
    gold_without_run: null,
    proxy_version: PROXY_VERSION,
    errors,
  };

  // --- the windows that need measuring -------------------------------------------------------
  // INFERRED SQL #1. Closed-or-settled windows with no measure row yet. `state IN (...)` rather
  // than 'closed' alone because a window that has already been transcribed is still tape that
  // wants measuring — the measurement is about the AUDIO, not about whether anyone paid to read
  // it. Oldest first so a backlog drains in a stable order across passes.
  const windows = await safeRead<MeasureWindowRow[]>("bench_window scan", [], log, async () =>
    (await sql`
      SELECT w.id, w.session_id, s.room_id, w.start_ms, w.end_ms, w.source_mic
        FROM bench_window w
        JOIN bench_session s ON s.id = w.session_id
       WHERE w.state IN ('closed', 'transcribing', 'transcribed', 'failed', 'silent')
         AND NOT EXISTS (SELECT 1 FROM stt_window_measure m WHERE m.window_id = w.id)
       ORDER BY w.start_ms ASC
       LIMIT ${limit}
    `) as MeasureWindowRow[]);

  if (!windows.ok) errors.push("bench_window scan failed");
  result.scanned = windows.value.length;

  for (const w of windows.value) {
    const startMs = Number(w.start_ms);
    const endMs = Number(w.end_ms);
    if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs <= startMs) {
      result.skipped_unreadable++;
      log(`[measure] ${w.id}: unreadable bounds — skipped`);
      continue;
    }
    const source = w.source_mic === "backup" ? "backup" : "primary";
    const floor = roomEnergyFloor(w.room_id);

    // INFERRED SQL #2. The chunks of this session on this microphone that overlap the window.
    // Overlap is half-open on both sides — a chunk that merely touches the boundary contributes
    // nothing. Times are timestamptz; the window is epoch ms, hence to_timestamp on both bounds.
    const chunks = await safeRead<MeasureChunk[]>(`bench_chunk for ${w.id}`, [], log, async () =>
      (await sql`
        SELECT started_at, ended_at, upload_state, peak_level, gap_before_ms
          FROM bench_chunk
         WHERE session_id = ${w.session_id}
           AND source = ${source}
           AND started_at < to_timestamp(${endMs}::bigint / 1000.0)
           AND ended_at   > to_timestamp(${startMs}::bigint / 1000.0)
         ORDER BY started_at ASC
      `) as MeasureChunk[]);

    // A FAILED CHUNK READ IS NOT AN EMPTY WINDOW. Skip it; tomorrow's pass picks it up because
    // it still has no measure row. Writing NO_AUDIO here would be a confident falsehood.
    if (!chunks.ok) {
      result.skipped_unreadable++;
      continue;
    }

    const measure = measureWindow(chunks.value, startMs, endMs, floor);

    // --- the three language opinions -------------------------------------------------------
    // INFERRED SQL #3, and INFERRED JSON KEYS. The drain writes probe_language,
    // full_window_language and sarvam_language into transcription_run.metrics_json (K4b, and
    // grounding §3). The run is keyed polymorphically since migration 0058.
    const runs = await safeRead<Array<{ metrics_json: unknown }>>(`transcription_run for ${w.id}`, [], log, async () =>
      (await sql`
        SELECT metrics_json
          FROM transcription_run
         WHERE subject_type = 'bench_window' AND subject_id = ${w.id}
         ORDER BY created_at DESC
         LIMIT 1
      `) as Array<{ metrics_json: unknown }>);

    const mj = (runs.value[0]?.metrics_json ?? {}) as Record<string, unknown>;
    const opinions = {
      probe_language: typeof mj.probe_language === "string" ? mj.probe_language : null,
      full_window_language: typeof mj.full_window_language === "string" ? mj.full_window_language : null,
      sarvam_language: typeof mj.sarvam_language === "string" ? mj.sarvam_language : null,
    };
    // A run that could not be read yields no opinions, and `opinions_present: 0` says exactly
    // that — missing evidence, never agreement (PRD §2).
    const conf = confusabilityOf(runs.ok ? opinions : {});

    // --- write the measure -----------------------------------------------------------------
    // INFERRED SQL #4. UPSERT on the primary key: a rerun replaces the row with an identical
    // value rather than failing or duplicating, which is what makes the pass idempotent.
    try {
      await sql`
        INSERT INTO stt_window_measure
          (window_id, energy_ms, silent_ms, unknown_ms, m, quarantine_reason,
           confusability, opinions_present, proxy_version, computed_at)
        VALUES
          (${w.id}, ${measure.energy_ms}, ${measure.silent_ms}, ${measure.unknown_ms},
           ${measure.m}, ${measure.quarantine_reason},
           ${conf.confusability}, ${conf.opinions_present}, ${PROXY_VERSION}, NOW())
        ON CONFLICT (window_id) DO UPDATE SET
          energy_ms = EXCLUDED.energy_ms,
          silent_ms = EXCLUDED.silent_ms,
          unknown_ms = EXCLUDED.unknown_ms,
          m = EXCLUDED.m,
          quarantine_reason = EXCLUDED.quarantine_reason,
          confusability = EXCLUDED.confusability,
          opinions_present = EXCLUDED.opinions_present,
          proxy_version = EXCLUDED.proxy_version,
          computed_at = NOW()
      `;
    } catch (e) {
      const msg = `[measure] ${w.id}: write failed: ${String((e as Error)?.message ?? e).slice(0, 200)}`;
      log(msg);
      errors.push(msg);
      continue;
    }

    result.measured++;
    result.coverage.windows++;
    result.coverage.energy_ms += measure.energy_ms;
    result.coverage.silent_ms += measure.silent_ms;
    result.coverage.unknown_ms += measure.unknown_ms;
    if (measure.quarantine_reason) {
      result.quarantined[measure.quarantine_reason] = (result.quarantined[measure.quarantine_reason] ?? 0) + 1;
    }

    // --- scores, only where a transcript exists ---------------------------------------------
    // A QUARANTINED WINDOW IS NEVER SCORED (PRD §3). Below the floor there is not enough measured
    // tape for "text on silence" to mean anything, and a number computed over 20% of a window
    // would sit in the same column as one computed over 100%.
    if (measure.quarantine_reason) continue;

    // INFERRED SQL #5, and INFERRED JSON KEYS. The turn cues carry the transcript on the clock.
    // `payload.window` is the window ASKED FOR and is identical on every cue of the window
    // (buildTurns), so it is the join key; `payload.engine` names the adapter that produced the
    // segments, read from the payload rather than assumed to be Whisper.
    //
    // BUILD 2 §E — CAST TO ::bigint, matching lib/brain/state.ts. This compared the window bounds
    // as TEXT, which is right only while both sides are the same digits: jsonb preserves whatever
    // numeric form was written, so a value serialised as 1.7875566e12 or with a trailing .0 by any
    // future writer would stop matching and the window would silently score with no transcript —
    // a fail-safe miss, but a miss. Comparing numbers as numbers removes the dependency on
    // formatting entirely. Queued out of the Build 1 validation pass.
    const spans = await safeRead<Array<{ engine: string | null; start_ms: string | number; end_ms: string | number; text: string | null }>>(
      `cue turns for ${w.id}`, [], log, async () =>
        (await sql`
          SELECT payload->>'engine' AS engine,
                 (payload->>'start_ms')::bigint AS start_ms,
                 (payload->>'end_ms')::bigint AS end_ms,
                 payload->>'text' AS text
            FROM cue
           WHERE type = 'stt_turn'
             AND (payload->'window'->>'start_ms')::bigint = ${startMs}
             AND (payload->'window'->>'end_ms')::bigint = ${endMs}
             AND payload->>'session_id' = ${w.session_id}
        `) as Array<{ engine: string | null; start_ms: string | number; end_ms: string | number; text: string | null }>);

    if (!spans.ok || spans.value.length === 0) continue;

    const byEngine = new Map<string, TextSpan[]>();
    for (const s of spans.value) {
      const key = s.engine ?? "unknown";
      const start = Number(s.start_ms);
      const end = Number(s.end_ms);
      if (!Number.isFinite(start) || !Number.isFinite(end)) continue;
      const list = byEngine.get(key) ?? [];
      list.push({ start_ms: start, end_ms: end, text: s.text });
      byEngine.set(key, list);
    }

    for (const [engineKey, list] of byEngine) {
      const metrics = scoreWindow(chunks.value, list, startMs, endMs, floor);
      try {
        // INFERRED SQL #6.
        await sql`
          INSERT INTO stt_window_score (window_id, engine_key, metrics_json, computed_at)
          VALUES (${w.id}, ${engineKey}, ${JSON.stringify(metrics)}::jsonb, NOW())
          ON CONFLICT (window_id, engine_key) DO UPDATE SET
            metrics_json = EXCLUDED.metrics_json,
            computed_at = NOW()
        `;
        result.scores_written++;
      } catch (e) {
        const msg = `[measure] ${w.id}/${engineKey}: score write failed: ${String((e as Error)?.message ?? e).slice(0, 200)}`;
        log(msg);
        errors.push(msg);
      }
    }
  }

  // The coverage figure §3 asks for: of the window time that any chunk covered, how much carries
  // a usable level at all. NULL rather than 0 when nothing was covered — dividing by nothing is
  // not 0% coverage, it is no answer, and 0% would read as a catastrophic finding.
  const covered = result.coverage.energy_ms + result.coverage.silent_ms + result.coverage.unknown_ms;
  result.coverage.level_coverage = covered > 0
    ? Math.round(((result.coverage.energy_ms + result.coverage.silent_ms) / covered) * 1e4) / 1e4
    : null;

  // --- the scoring pass (§C) -----------------------------------------------------------------
  //
  // AFTER measurement, deliberately: the scorer refuses a quarantined window, so running it
  // before tonight's measurements exist would refuse pairs that this same pass was about to make
  // scoreable, and the refusal rows are idempotent by (window, engine, reason) — a wrong refusal
  // written first would still be sitting there afterwards.
  //
  // IDEMPOTENT ACROSS DOUBLE RUNS by the uq_stt_score_refusal_pair unique index (migration 0072)
  // and the (window_id, engine_key) primary key on stt_window_score. Two overlapping crons
  // therefore converge rather than accumulate — the same structural idempotence the measure pass
  // relies on, not a second layer of care in this file.
  if (opts.skipScoring) {
    result.scoring = { skipped: "skipped_by_caller" };
  } else {
    try {
      result.scoring = await scoreWindows({ log });
    } catch (e) {
      // The scorer never throws by design; this catch exists so that if it ever does, the
      // measurements this pass already committed are not lost with it.
      const reason = String((e as Error)?.message ?? e).slice(0, 200);
      log(`[measure] scoring pass failed: ${reason} — measurements are unaffected`);
      result.scoring = { skipped: reason };
      errors.push(`scoring: ${reason}`);
    }
  }

  // INFERRED SQL #9 — gold references with no room run. Fails safe to null, which reads as "not
  // counted", never as zero.
  const orphan = await safeRead<Array<{ n: number }>>("gold without run", [], log, async () =>
    (await sql`
      SELECT COUNT(*)::int AS n
        FROM stt_gold_window g
       WHERE NOT EXISTS (
         SELECT 1 FROM transcription_run r
          WHERE r.subject_type = 'bench_window' AND r.subject_id = g.window_id
       )
    `) as Array<{ n: number }>);
  result.gold_without_run = orphan.ok ? (Number(orphan.value[0]?.n) || 0) : null;

  // --- the tuning fork, once per pass --------------------------------------------------------
  if (opts.skipFork) {
    result.fork = { kind: "not_run", reason: "skipped_by_caller" };
  } else {
    result.fork = await runForkStep(log);
  }

  log(`[measure] pass done: scanned=${result.scanned} measured=${result.measured} scores=${result.scores_written} skipped=${result.skipped_unreadable} coverage=${result.coverage.level_coverage ?? "n/a"} fork=${result.fork.kind} scored=${"scored" in result.scoring ? result.scoring.scored : "skipped"} refused=${"refused" in result.scoring ? result.scoring.refused : "skipped"}`);
  return result;
}

/** The fork step wired to real R2, real Whisper and the real alarm table. Never throws. */
export async function runForkStep(log: Logger): Promise<ForkOutcome | { kind: "not_run"; reason: string }> {
  try {
    return await runTuningFork({
      log,
      fetchClip: async () => {
        // headObject first: an absent clip costs one HEAD rather than a GET of a 90-second file.
        const head = await headObject(TUNING_FORK_R2_KEY);
        if (head.size === null) return null;
        return await getObjectBytes(TUNING_FORK_R2_KEY);
      },
      transcribe: async (audio) => {
        const r = await transcribeWithWhisper(audio, "audio/webm", { timeoutMs: 90_000 });
        return r.ok ? { ok: true, transcript: r.transcript } : { ok: false, error: r.error };
      },
      readReference: async () => {
        // INFERRED SQL #7. THE OLDEST reference row, never the newest: a second reference written
        // by mistake must not be able to silently re-baseline the instrument and erase a drift
        // that already happened.
        const rows = (await sql`
          SELECT detail_json->>'sha256' AS sha256
            FROM stt_canary_alarm
           WHERE kind = ${ALARM_KIND_REFERENCE}
           ORDER BY created_at ASC
           LIMIT 1
        `) as Array<{ sha256: string | null }>;
        return rows[0]?.sha256 ?? null;
      },
      writeAlarm: async (kind, detail) => {
        // INFERRED SQL #8.
        await sql`
          INSERT INTO stt_canary_alarm (id, kind, detail_json, created_at)
          VALUES (${alarmId()}, ${kind}, ${JSON.stringify(detail)}::jsonb, NOW())
        `;
      },
    });
  } catch (e) {
    const reason = String((e as Error)?.message ?? e).slice(0, 200);
    log(`[tuning-fork] step failed: ${reason} — the measure pass is unaffected`);
    return { kind: "not_run", reason };
  }
}

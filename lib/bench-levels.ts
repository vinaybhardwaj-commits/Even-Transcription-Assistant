import { sql } from "@/lib/db";
import { istDate as todayIstDate } from "@/lib/bench-reaper-core";

export const LEVEL_TIMELINE_BUCKET_SECONDS = 15;

export type MicLevels = { peak: number; avg: number | null; zeroRatio?: number };

export type BenchLevelSample = {
  t_ms: number;
  peak: number;
  avg: number | null;
  zero_ratio: number | null;
  session_open: boolean;
  tape_advancing: boolean;
  samples: number;
};

/** A finite number from a number or non-empty numeric string; everything else is absent. */
export function finiteNumberOrNull(value: unknown): number | null {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value !== "string" || value.trim() === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

/**
 * A complete normalised level pair, or null. A partial pair is no measurement because filling
 * either side with zero would invent a value that no microphone reported.
 */
export function parseMicLevelPair(peakValue: unknown, avgValue: unknown): MicLevels | null {
  const peak = finiteNumberOrNull(peakValue);
  const avg = finiteNumberOrNull(avgValue);
  if (peak === null || avg === null || peak < 0 || peak > 1 || avg < 0 || avg > peak) return null;
  return { peak, avg };
}

/** The object form used by the command poll and its existing callers. */
export function parseMicLevels(value: unknown): MicLevels | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const pair = value as Record<string, unknown>;
  return parseMicLevelPair(pair.peak, pair.avg);
}

export function isIsoDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

export async function readRoomLevelDay(
  roomId: string,
  istDate: string,
): Promise<{ samples: BenchLevelSample[]; sampleCount: number }> {
  const rows = (await sql`
    SELECT
      max(sampled_at) AS sampled_at,
      max(peak) AS peak,
      avg(avg) FILTER (WHERE avg IS NOT NULL) AS avg,
      max(zero_ratio) FILTER (WHERE zero_ratio IS NOT NULL) AS zero_ratio,
      bool_or(session_open) AS session_open,
      bool_or(tape_advancing) AS tape_advancing,
      count(*)::int AS samples
    FROM bench_level_sample
    WHERE room_id = ${roomId}
      AND ist_date = ${istDate}::date
    GROUP BY floor(extract(epoch FROM sampled_at) / ${LEVEL_TIMELINE_BUCKET_SECONDS}::int)
    ORDER BY max(sampled_at) ASC
  `) as Array<{
    sampled_at: string | Date;
    peak: number | string;
    avg: number | string | null;
    zero_ratio: number | string | null;
    session_open: boolean;
    tape_advancing: boolean;
    samples: number | string;
  }>;

  const samples = rows.map((row) => ({
    t_ms: new Date(row.sampled_at).getTime(),
    peak: Number(row.peak),
    avg: row.avg === null ? null : Number(row.avg),
    zero_ratio: row.zero_ratio === null ? null : Number(row.zero_ratio),
    session_open: Boolean(row.session_open),
    tape_advancing: Boolean(row.tape_advancing),
    samples: Number(row.samples),
  }));

  return {
    samples,
    sampleCount: samples.reduce((total, sample) => total + sample.samples, 0),
  };
}

// ---------------------------------------------------------------------------
// Retention (plan §2: raw kept 7 IST days)
// ---------------------------------------------------------------------------

/** How many IST calendar days of raw bench_level_sample rows to keep. */
export const LEVEL_RETENTION_DAYS = 7;

/** Rows are deleted in slices this size, so one invocation never holds a long-running statement. */
export const LEVEL_RETENTION_BATCH_SIZE = 5_000;

/** Hard cap on batches per invocation — a safety bound against a route that never catches up. */
export const LEVEL_RETENTION_MAX_BATCHES = 50;

/**
 * PURE. The `ist_date` cutoff: a row is old iff its `ist_date` is before this. `ist_date` is
 * already a plain calendar date (the writer's IST day, not a timestamp), so retention is exact
 * calendar-day arithmetic on that column — no timezone conversion of `sampled_at` needed here.
 */
export function levelRetentionCutoffIstDate(now: Date = new Date(), days: number = LEVEL_RETENTION_DAYS): string {
  const today = todayIstDate(now);
  const cutoff = new Date(`${today}T00:00:00.000Z`);
  cutoff.setUTCDate(cutoff.getUTCDate() - days);
  return cutoff.toISOString().slice(0, 10);
}

/** How many rows are older than `cutoffIstDate`, without touching any of them. */
export async function countOldLevelSamples(cutoffIstDate: string): Promise<number> {
  const rows = (await sql`
    SELECT count(*)::int AS n FROM bench_level_sample WHERE ist_date < ${cutoffIstDate}::date
  `) as Array<{ n: number }>;
  return rows[0]?.n ?? 0;
}

/**
 * Delete up to `batchSize` rows older than `cutoffIstDate`. Returns how many were actually removed
 * (0 when nothing qualifies) — the caller loops this until a batch comes back short of `batchSize`.
 * IDEMPOTENT BY CONSTRUCTION: a row is targeted by `ist_date`, never by "have I seen this id
 * before", so a rerun after a partial run (or after everything is already gone) deletes exactly
 * what still qualifies and nothing else — running it twice in a row is a no-op the second time.
 */
export async function purgeOldLevelSamplesBatch(cutoffIstDate: string, batchSize: number = LEVEL_RETENTION_BATCH_SIZE): Promise<number> {
  const rows = (await sql`
    WITH doomed AS (
      SELECT id FROM bench_level_sample WHERE ist_date < ${cutoffIstDate}::date LIMIT ${batchSize}
    )
    DELETE FROM bench_level_sample WHERE id IN (SELECT id FROM doomed)
    RETURNING id
  `) as Array<{ id: number }>;
  return rows.length;
}

// ---------------------------------------------------------------------------
// low_signal — a read-side confabulation marker (STT-HALLUCINATION-PACK item 2)
//
// Whisper invents fluent text from a quiet or distant mic; the level log is the one signal
// that can tell a transcript apart from a hallucination over it. This section computes, for
// any transcript segment's time span, the peak/avg the level log saw over that span, and
// flags low_signal when the span's peak sits below a floor. READ-SIDE ONLY: nothing here
// alters or drops a transcript, a turn, or a cue — see lib/mcp/tools/bench.ts's turnsAnswer,
// the only writer that calls into this, which attaches the result and writes nothing new.
// ---------------------------------------------------------------------------

export type LevelSample = { sampledAtMs: number; peak: number; avg: number | null };

export type SegmentLevel = {
  peak: number | null;
  avg: number | null;
  samples: number;
  /** null = no level-log samples over this span, so low_signal cannot be judged either way —
   * never coerced to false, which would read as "checked, and it was fine". */
  low_signal: boolean | null;
};

/**
 * PROVISIONAL floor for low_signal, on the same 0..1 RMS scale as bench_level_sample.peak
 * (rmsOfBytes, lib/bench-dual.ts). SILENCE_RMS (0.0015, lib/bench-dual.ts) already marks
 * digital-zero / dead-mic territory; low_signal needs to sit clearly ABOVE that — "the mic
 * heard something, but not much" is a different, larger case than "the mic heard nothing".
 *
 * DERIVATION, and why it is a placeholder: the intended method (deriveQuietFloor below) is
 * the Nth percentile of peak across ACTIVELY RECORDING spans (tape_advancing = true, which
 * excludes idle/paused/closed-room rows that would pull the distribution toward digital zero
 * for the wrong reason) in bench_level_sample itself. This sandbox has no live database, so
 * that query has not been run. The nearest REAL number on record is docs/handoff's
 * ETA-E13-WE-CANNOT-TELL-A-QUIET-ROOM-FROM-A-DEAD-MIC-14-SEP-2026.md: a 25 Aug bring-up
 * sample in one room measured median peak 0.0079 (bench_chunk.peak_level, the sibling metric
 * bench_level_sample replaced — same rmsOfBytes scale) — "mostly near-silence with occasional
 * loud chunks". QUIET_FLOOR_RMS is set at 2x that median, clearly above SILENCE_RMS and below
 * where recognisable speech typically registers. Run deriveQuietFloor against production and
 * replace this constant with its result once bench_level_sample has enough of a history.
 */
export const QUIET_FLOOR_RMS = 0.016;

/** PURE. The `p`th percentile (0-100) of `values`, nearest-rank. null on an empty input —
 * never 0, which would read as a real (very quiet) measurement rather than no data at all. */
export function percentile(values: number[], p: number): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.round((p / 100) * (sorted.length - 1))));
  return sorted[idx]!;
}

/**
 * PURE. `samples` already fetched (readLevelSamplesInRange, below) — no I/O here, so this is
 * as testable as buildTurns. `low_signal` compares the span's PEAK (the highest reading, i.e.
 * "did anyone speak up at all") to `floor`; a quiet room with one loud moment is not low_signal
 * even if its average is near the floor, because that one moment is exactly what a clinician
 * would want surfaced, not hidden behind an average.
 */
export function levelForSpan(samples: readonly LevelSample[], startMs: number, endMs: number, floor: number): SegmentLevel {
  const inSpan = samples.filter((s) => s.sampledAtMs >= startMs && s.sampledAtMs <= endMs);
  if (inSpan.length === 0) return { peak: null, avg: null, samples: 0, low_signal: null };
  const peak = Math.max(...inSpan.map((s) => s.peak));
  const avgValues = inSpan.map((s) => s.avg).filter((v): v is number => v !== null);
  const avg = avgValues.length ? avgValues.reduce((a, b) => a + b, 0) / avgValues.length : null;
  return { peak, avg, samples: inSpan.length, low_signal: peak < floor };
}

/** The level-log rows for one room over `[startMs, endMs]`, inclusive — one query per response
 * (the caller spans every turn it is about to score), not one per turn. */
export async function readLevelSamplesInRange(roomId: string, startMs: number, endMs: number): Promise<LevelSample[]> {
  const rows = (await sql`
    SELECT sampled_at, peak, avg
    FROM bench_level_sample
    WHERE room_id = ${roomId}
      AND sampled_at >= ${new Date(startMs).toISOString()}::timestamptz
      AND sampled_at <= ${new Date(endMs).toISOString()}::timestamptz
    ORDER BY sampled_at ASC
  `) as Array<{ sampled_at: string | Date; peak: number | string; avg: number | string | null }>;
  return rows.map((row) => ({
    sampledAtMs: new Date(row.sampled_at).getTime(),
    peak: Number(row.peak),
    avg: row.avg === null ? null : Number(row.avg),
  }));
}

/**
 * The REAL derivation QUIET_FLOOR_RMS's comment describes — the Nth percentile of peak over
 * actively-recording spans across all rooms, in the last `days` days. Not called anywhere in
 * this build; it is here so the derivation this ruling asked for is a method that can be run
 * against production, not just a number asserted in a comment. Fail-safe like every other MCP
 * read: a query failure returns floor:null with sampleCount 0, never a thrown error.
 */
export async function deriveQuietFloor(percentileRank = 20, days = 14): Promise<{ floor: number | null; sampleCount: number }> {
  try {
    const rows = (await sql`
      SELECT peak
      FROM bench_level_sample
      WHERE tape_advancing = true
        AND sampled_at >= now() - (${days}::int * INTERVAL '1 day')
    `) as Array<{ peak: number | string }>;
    const values = rows.map((row) => Number(row.peak));
    return { floor: percentile(values, percentileRank), sampleCount: values.length };
  } catch {
    return { floor: null, sampleCount: 0 };
  }
}

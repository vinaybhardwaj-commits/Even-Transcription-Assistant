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

/** One room's share of what a retention run would remove. */
export type OldLevelSamplesByRoom = { room_id: string; count: number; oldest_ist_date: string; newest_ist_date: string };

/**
 * Per-room breakdown of rows older than `cutoffIstDate`, without touching any of them. For the
 * dry-run report (GET /api/admin/bench/levels-retention/report): so "how much, and from which
 * rooms" is visible before BENCH_LEVEL_RETENTION is ever turned on. Ordered by count, largest
 * first, so the rooms that matter most are the ones a reader sees without scrolling.
 */
export async function oldLevelSamplesByRoom(cutoffIstDate: string): Promise<OldLevelSamplesByRoom[]> {
  const rows = (await sql`
    SELECT room_id, count(*)::int AS n, min(ist_date) AS oldest, max(ist_date) AS newest
    FROM bench_level_sample
    WHERE ist_date < ${cutoffIstDate}::date
    GROUP BY room_id
    ORDER BY n DESC, room_id ASC
  `) as Array<{ room_id: string; n: number; oldest: string | Date; newest: string | Date }>;
  const isoDate = (v: string | Date) => (v instanceof Date ? v.toISOString().slice(0, 10) : String(v).slice(0, 10));
  return rows.map((r) => ({ room_id: r.room_id, count: r.n, oldest_ist_date: isoDate(r.oldest), newest_ist_date: isoDate(r.newest) }));
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
 * The floor for low_signal, on the same 0..1 RMS scale as bench_level_sample.peak (rmsOfBytes,
 * lib/bench-dual.ts). SILENCE_RMS (0.0015, lib/bench-dual.ts) already marks digital-zero /
 * dead-mic territory; low_signal needs to sit clearly ABOVE that — "the mic heard something, but
 * not much" is a different, larger case than "the mic heard nothing".
 *
 * MEASURED, not guessed (ETA-LOW-SIGNAL-MARKER-REFUTER-VERDICT-23-SEP-2026.md): deriveQuietFloor
 * (below) was run read-only against production — the p05 of peak over ACTIVELY RECORDING spans
 * (tape_advancing = true) in bench_level_sample, n=51,074. The first shipped value, 0.016, was 2x
 * the nearest real number then available (ETA-E13's 25 Aug bench_chunk median, 0.0079) — and
 * doubling a median guarantees the result sits ABOVE it, which a FLOOR must not do: 0.016 sat
 * above the real median (0.0107) and flagged 74% of actively-recording samples, which is not a
 * marker, it is a constant. The ETA-E13 reference itself was almost exactly right — it is within
 * 0.0001 of the real p05 (0.0080) — so QUIET_FLOOR_RMS is now that measured p05 DIRECTLY, no
 * doubling: expected to flag ~3.6% of actively-recording spans. deriveQuietFloor's own default
 * percentile is p05 to match, so a future re-run reproduces this same calibration target rather
 * than a different one.
 */
export const QUIET_FLOOR_RMS = 0.008;

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
 * actively-recording spans across all rooms, in the last `days` days. Already run once, read-only,
 * against production (ETA-LOW-SIGNAL-MARKER-REFUTER-VERDICT-23-SEP-2026.md): n=51,074, p01=0.0077,
 * p05=0.0080, p25=0.0091, p50=0.0107 — the bottom of the distribution is extremely tight (p01 to
 * p25 is a 1.2x spread) then explodes toward p90=0.1362, so the exact percentile chosen barely
 * moves the floor but moves the share flagged a lot: p05 flags ~3.6%, p01 ~0.4%. The default is
 * p05 to match QUIET_FLOOR_RMS exactly, so a future re-run reproduces the same calibration target
 * rather than a silently different one. Fail-safe like every other MCP read: a query failure
 * returns floor:null with sampleCount 0, never a thrown error.
 */
export async function deriveQuietFloor(percentileRank = 5, days = 14): Promise<{ floor: number | null; sampleCount: number }> {
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

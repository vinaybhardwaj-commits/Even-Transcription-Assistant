import { sql } from "@/lib/db";

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

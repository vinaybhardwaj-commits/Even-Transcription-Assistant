/**
 * lib/bench-range.ts — pure helpers for "audio by clock time" (Operator MCP S3, PRD §10).
 *
 * Operators ask for a clock, not a chunk index. These helpers turn `HH:MM[:SS]` IST (or ISO)
 * into UTC instants on the session's IST date, and map a [start, end) window onto the
 * session's chunk rows (started_at / ended_at). Pure: no DB, no React — unit-tested.
 *
 * Notes that matter:
 *   - Bench R2 keys carry the UTC date of session start; the IST clinic date can differ for
 *     sessions started after 18:30 UTC (00:00 IST). Clock parsing always anchors on the
 *     session's IST date (istDate of started_at), never on the UTC folder date.
 *   - v1 serves ONE covering chunk (offset + duration inside it). A window that spans chunks
 *     is an error that still lists every covering chunk (D2: stitching is v1.1).
 */

import { istDate, IST_TZ } from "@/lib/bench-reaper-core";

export { istDate };

const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;
const CLOCK_RE = /^(\d{1,2}):(\d{2})(?::(\d{2}))?$/;

export type ParsedInstant = { ms: number; kind: "clock" | "iso" };

/**
 * Parse an operator time. `HH:MM[:SS]` is an IST wall clock on `istDateYmd` (YYYY-MM-DD in
 * Asia/Kolkata); anything else is tried as ISO/epoch. Null when unparseable.
 */
export function parseOperatorTime(raw: unknown, istDateYmd: string): ParsedInstant | null {
  if (typeof raw === "number" && Number.isFinite(raw)) return { ms: raw, kind: "iso" };
  if (typeof raw !== "string") return null;
  const s = raw.trim();
  const m = CLOCK_RE.exec(s);
  if (m) {
    const hh = Number(m[1]);
    const mm = Number(m[2]);
    const ss = Number(m[3] ?? "0");
    if (hh > 23 || mm > 59 || ss > 59) return null;
    // IST has no DST: wall clock on date D = UTC(D 00:00) + hh:mm:ss − 05:30.
    const dayUtcMidnight = Date.parse(`${istDateYmd}T00:00:00Z`);
    if (Number.isNaN(dayUtcMidnight)) return null;
    return { ms: dayUtcMidnight - IST_OFFSET_MS + ((hh * 60 + mm) * 60 + ss) * 1000, kind: "clock" };
  }
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? null : { ms: d.getTime(), kind: "iso" };
}

/** IST wall-clock HH:MM:SS for an instant (for echoing the requested range). */
export function fmtIstClock(ms: number): string {
  return new Intl.DateTimeFormat("en-GB", { timeZone: IST_TZ, hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false }).format(new Date(ms));
}

export type RangeChunk = {
  idx: number;
  source: "primary" | "backup";
  r2_key: string;
  content_type: string;
  started_at: string | Date;
  ended_at: string | Date;
  upload_state: string;
};

export type CoveringChunk<C extends RangeChunk = RangeChunk> = {
  chunk: C;
  /** seconds from the chunk's start to max(start, chunk start) */
  offset_in_chunk_s: number;
  /** seconds of the requested window that fall inside this chunk */
  duration_s: number;
  chunk_bounds: { started_at: string; ended_at: string };
};

export type RangeResolution<C extends RangeChunk = RangeChunk> =
  | { kind: "single"; covering: CoveringChunk<C> }
  | { kind: "multi"; covering: CoveringChunk<C>[] }
  | { kind: "none" };

/** Chunks of `source` that overlap [startMs, endMs), in idx order, with offsets. */
export function resolveRange<C extends RangeChunk>(chunks: readonly C[], startMs: number, endMs: number, source: "primary" | "backup" = "primary"): RangeResolution<C> {
  if (!(endMs > startMs)) return { kind: "none" };
  const covering: CoveringChunk<C>[] = [];
  for (const c of [...chunks].filter((x) => (x.source ?? "primary") === source).sort((a, b) => a.idx - b.idx)) {
    const cs = new Date(c.started_at).getTime();
    const ce = new Date(c.ended_at).getTime();
    if (Number.isNaN(cs) || Number.isNaN(ce)) continue;
    if (ce <= startMs || cs >= endMs) continue; // no overlap
    const from = Math.max(cs, startMs);
    const to = Math.min(ce, endMs);
    covering.push({
      chunk: c,
      offset_in_chunk_s: Math.max(0, Math.round(((from - cs) / 1000) * 100) / 100),
      duration_s: Math.max(0, Math.round(((to - from) / 1000) * 100) / 100),
      chunk_bounds: { started_at: new Date(cs).toISOString(), ended_at: new Date(ce).toISOString() },
    });
  }
  if (covering.length === 0) return { kind: "none" };
  if (covering.length === 1) return { kind: "single", covering: covering[0]! };
  return { kind: "multi", covering };
}

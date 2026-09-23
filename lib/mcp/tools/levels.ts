/**
 * lib/mcp/tools/levels.ts — read-only room mic-level history (plan §2).
 *
 * One room, one IST day OR an IST time range, in the same 15 s buckets GET /api/admin/bench/levels
 * reads (readRoomLevelDay, lib/bench-levels.ts) — reused verbatim, per day, so this can never drift
 * from what the admin card shows and there is no second aggregator to keep in step. A range simply
 * reads the one or two IST days it touches and keeps the buckets inside it. MCP-token read scope
 * only: no admin cookie, so a watcher can read levels without a browser session. Uses: dead-mic
 * detection (zero_ratio), the E-2 energy half, E-1's probe pre-selector.
 *
 * TWO CAPS, both refusing rather than guessing:
 *   - a range longer than MAX_RANGE_HOURS is refused outright (`range_too_long`), so no caller can
 *     ask this door for a week of a room's day;
 *   - at most `limit` buckets come back (default DEFAULT_LIMIT, ceiling MAX_LIMIT = a full 24 h of
 *     15 s buckets), and a cut answer says `truncated: true` and where to resume.
 * Numbers only: this table holds no audio and no text, and none is invented here.
 */
import { readRoomLevelDay, LEVEL_TIMELINE_BUCKET_SECONDS, isIsoDate, type BenchLevelSample } from "@/lib/bench-levels";
import { istDate } from "@/lib/bench-reaper-core";
import { failSafe, argStr, argInt, type McpTool, type ToolArgs } from "../registry";

/** The longest range this door will read. A day is the unit the aggregator works in; two is the most
 *  a 24 h IST range can touch. */
export const MAX_RANGE_HOURS = 24;
/** Buckets returned when the caller names no limit. 1,000 x 15 s is about 4 h. */
export const DEFAULT_LIMIT = 1_000;
/** Ceiling: a full 24 h of 15 s buckets. */
export const MAX_LIMIT = (MAX_RANGE_HOURS * 3600) / LEVEL_TIMELINE_BUCKET_SECONDS;

const IST_OFFSET = "+05:30";
const CLOCK_RE = /^([01]\d|2[0-3]):([0-5]\d)(?::([0-5]\d))?$/;

/**
 * "HH:MM[:SS]" on `day` read as IST, or a full ISO timestamp. Returns null for anything else — a
 * malformed bound is refused, never quietly taken as midnight. IST has no daylight saving, so the
 * fixed +05:30 is exact.
 */
export function parseIstBound(value: string, day: string): number | null {
  const clock = CLOCK_RE.exec(value.trim());
  if (clock) {
    const [, hh, mm, ss] = clock;
    const t = Date.parse(`${day}T${hh}:${mm}:${ss ?? "00"}.000${IST_OFFSET}`);
    return Number.isNaN(t) ? null : t;
  }
  if (!/[T ]/.test(value)) return null;                     // a bare date is a day, not a bound
  const t = Date.parse(value.trim());
  return Number.isNaN(t) ? null : t;
}

/** The IST calendar days a [from, to) range touches, in order — one or two for any legal range. */
export function istDaysSpanned(fromMs: number, toMs: number): string[] {
  const days: string[] = [];
  for (let t = fromMs; ; t += 86_400_000) {
    const day = istDate(new Date(Math.min(t, toMs)));
    if (!days.includes(day)) days.push(day);
    if (t >= toMs) break;
  }
  return days;
}

const roomLevels: McpTool = {
  name: "scribe_room_levels",
  description: "One room's mic-level history for an IST day or an IST time range, in the same 15 s buckets as GET /api/admin/bench/levels: peak, avg, zero_ratio, session_open, tape_advancing, samples per bucket. A range over 24 h is refused; at most `limit` buckets come back and a cut answer says so. No transcript text — this table holds none. Read scope; no admin cookie needed.",
  scope: "read",
  inputSchema: {
    type: "object",
    properties: {
      room_id: { type: "string" },
      ist_date: { type: "string", description: "YYYY-MM-DD (Asia/Kolkata); default today. The day a clock-time `from`/`to` is read on, and the whole day read when neither is given." },
      from: { type: "string", description: "Range start: HH:MM[:SS] IST on ist_date, or a full ISO timestamp. With `to` omitted the range runs to the end of ist_date." },
      to: { type: "string", description: "Range end, exclusive: HH:MM[:SS] IST on ist_date, or a full ISO timestamp." },
      limit: { type: "integer", description: `Buckets returned, default ${DEFAULT_LIMIT}, ceiling ${MAX_LIMIT} (24 h). A cut answer says truncated and next_from_ms.` },
    },
    required: ["room_id"],
    additionalProperties: false,
  },
  handler: async (args: ToolArgs) =>
    failSafe({ samples: [] as unknown[], sample_count: 0 }, async () => {
      const roomId = argStr(args, "room_id", 128);
      if (!roomId) return { samples: [], sample_count: 0, error: "room_id_required" };
      const dayArg = argStr(args, "ist_date", 10);
      const day = dayArg && isIsoDate(dayArg) ? dayArg : istDate(new Date());
      const limit = argInt(args, "limit", DEFAULT_LIMIT, 1, MAX_LIMIT);

      const fromArg = argStr(args, "from", 40);
      const toArg = argStr(args, "to", 40);
      let fromMs: number | null = null;
      let toMs: number | null = null;
      if (fromArg || toArg) {
        fromMs = fromArg ? parseIstBound(fromArg, day) : Date.parse(`${day}T00:00:00.000${IST_OFFSET}`);
        toMs = toArg ? parseIstBound(toArg, day) : Date.parse(`${day}T23:59:59.999${IST_OFFSET}`);
        if (fromMs === null || toMs === null) {
          return { room_id: roomId, samples: [], sample_count: 0, error: "bad_range" };
        }
        if (toMs <= fromMs) {
          return { room_id: roomId, samples: [], sample_count: 0, error: "empty_range" };
        }
        if (toMs - fromMs > MAX_RANGE_HOURS * 3_600_000) {
          return {
            room_id: roomId, samples: [], sample_count: 0,
            error: "range_too_long", max_range_hours: MAX_RANGE_HOURS,
          };
        }
      }

      // One aggregator, called per IST day the range touches. No second query lives here.
      const days = fromMs !== null && toMs !== null ? istDaysSpanned(fromMs, toMs) : [day];
      let samples: BenchLevelSample[] = [];
      for (const d of days) samples = samples.concat((await readRoomLevelDay(roomId, d)).samples);
      if (fromMs !== null && toMs !== null) {
        samples = samples.filter((x) => x.t_ms >= fromMs! && x.t_ms < toMs!);
      }
      samples.sort((a, b) => a.t_ms - b.t_ms);

      const truncated = samples.length > limit;
      const kept = truncated ? samples.slice(0, limit) : samples;
      return {
        room_id: roomId,
        ist_date: day,
        ist_days_read: days,
        ...(fromMs !== null && toMs !== null ? { from_ms: fromMs, to_ms: toMs } : {}),
        bucket_seconds: LEVEL_TIMELINE_BUCKET_SECONDS,
        limit,
        truncated,
        ...(truncated ? { next_from_ms: samples[limit].t_ms } : {}),
        // the raw rows the RETURNED buckets aggregate, not the whole day's
        sample_count: kept.reduce((n, x) => n + x.samples, 0),
        samples: kept,
      };
    }),
};

export const LEVEL_TOOLS: McpTool[] = [roomLevels];

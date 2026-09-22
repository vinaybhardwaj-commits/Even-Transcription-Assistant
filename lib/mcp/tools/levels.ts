/**
 * lib/mcp/tools/levels.ts — read-only room mic-level history (plan §2).
 *
 * One room, one IST day, the same 15 s buckets GET /api/admin/bench/levels reads
 * (readRoomLevelDay, lib/bench-levels.ts) — reused verbatim so this can never drift from what the
 * admin card shows. MCP-token read scope only: no admin cookie, so a watcher can read levels
 * without a browser session. Uses: dead-mic detection (zero_ratio), the E-2 energy half, E-1's
 * probe pre-selector.
 */
import { readRoomLevelDay, LEVEL_TIMELINE_BUCKET_SECONDS, isIsoDate } from "@/lib/bench-levels";
import { istDate } from "@/lib/bench-reaper-core";
import { failSafe, argStr, type McpTool, type ToolArgs } from "../registry";

const roomLevels: McpTool = {
  name: "scribe_room_levels",
  description: "One room's mic-level history for an IST day, in the same 15 s buckets as GET /api/admin/bench/levels: peak, avg, zero_ratio, session_open, tape_advancing, samples per bucket. No transcript text — this table holds none. Read scope; no admin cookie needed.",
  scope: "read",
  inputSchema: {
    type: "object",
    properties: {
      room_id: { type: "string" },
      ist_date: { type: "string", description: "YYYY-MM-DD (Asia/Kolkata); default today" },
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
      const timeline = await readRoomLevelDay(roomId, day);
      return {
        room_id: roomId,
        ist_date: day,
        bucket_seconds: LEVEL_TIMELINE_BUCKET_SECONDS,
        sample_count: timeline.sampleCount,
        samples: timeline.samples,
      };
    }),
};

export const LEVEL_TOOLS: McpTool[] = [roomLevels];

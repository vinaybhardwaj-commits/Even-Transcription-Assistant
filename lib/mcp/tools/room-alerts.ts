/**
 * lib/mcp/tools/room-alerts.ts — scribe_room_alerts: the Room Watchdog's alert outbox, read-only (design rev 3, Fable ruling 128(a)).
 *
 * For the relay on the Mini that posts each alert to the bus. Read scope; it writes nothing and keeps no cursor (the relay owns its cursor).
 *
 * EVERY ANSWER SAYS `ok`, AND ONLY `ok: true` MEANS "I READ THE OUTBOX". A read that fails answers `{ ok: false, error }` — deliberately NOT the
 * usual failSafe `degraded` shape, which would hand a relay an empty list that reads as "no new alerts" (eta-refuter F4). A relay must treat anything
 * other than `ok === true`, a non-200, an auth failure or a missing field as its own SILENT condition. Room names are in the rows (the bus
 * message may carry them); the conductor BOARD must carry room ids only.
 */
import { readRoomAlerts, DEFAULT_LOOKBACK_MINUTES, MAX_LOOKBACK_MINUTES, DEFAULT_ALERT_LIMIT, MAX_ALERT_LIMIT } from "@/lib/room-alerts";
import { argInt, ToolScopeError, type McpTool, type ToolArgs } from "../registry";

const roomAlerts: McpTool = {
  name: "scribe_room_alerts",
  description:
    "The Room Watchdog's alert outbox, read-only, for the relay that posts alerts to the bus. Returns `new` (id > after_id, ascending, capped at `limit`) and `late` " +
    "(id <= after_id but created within the last `lookback_minutes`, on the DATABASE's clock, for rows a slower run committed after a higher id was read), " +
    "`head_id`, and `heartbeat` = { state: ok | stale | none, age_s } computed by the database. `ok: true` means the outbox was read; anything else is a failure and must " +
    "never be read as 'no alerts'. Dedupe by row id.",
  scope: "read",
  inputSchema: {
    type: "object",
    properties: {
      after_id: { type: "integer", description: "The highest outbox id the relay has already handled; default 0." },
      lookback_minutes: { type: "integer", description: `Window for the late-committer set, default ${DEFAULT_LOOKBACK_MINUTES}, ceiling ${MAX_LOOKBACK_MINUTES}.` },
      limit: { type: "integer", description: `Cap on NEW rows, default ${DEFAULT_ALERT_LIMIT}, ceiling ${MAX_ALERT_LIMIT}.` },
    },
    additionalProperties: false,
  },
  handler: async (args: ToolArgs) => {
    try {
      return await readRoomAlerts({
        afterId: argInt(args, "after_id", 0, 0, Number.MAX_SAFE_INTEGER),
        lookbackMinutes: argInt(args, "lookback_minutes", DEFAULT_LOOKBACK_MINUTES, 1, MAX_LOOKBACK_MINUTES),
        limit: argInt(args, "limit", DEFAULT_ALERT_LIMIT, 1, MAX_ALERT_LIMIT),
      });
    } catch (e) {
      if (e instanceof ToolScopeError) throw e;
      // NOT failSafe's `degraded` shape: an explicit failure, so it cannot be mistaken for an empty outbox.
      return { ok: false, error: String((e as Error)?.message ?? e).slice(0, 200) };
    }
  },
};

export const ROOM_ALERT_TOOLS: McpTool[] = [roomAlerts];

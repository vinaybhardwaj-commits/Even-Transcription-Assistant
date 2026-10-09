/**
 * lib/mcp/tools/s5.ts — S5A (8 Oct 2026): scribe_reb_index, a read-only view of reb_track_index (migration 0135, palimpsest PR #23).
 *
 * Mirrors GET /api/reb/index (app/api/reb/index/route.ts) semantics with this file's own bound SELECT: window_id | ist_date required,
 * optional layer / engine / room, shadow rows excluded unless asked, keyset pagination by id with next_cursor. Rows come back as stored:
 * ids, layers, engines, versions, R2 keys, sha256, status, times. The table holds no transcript text and no patient identifier.
 * The table missing (SQLSTATE 42P01 / 42703) answers { not_collected: true, reason }. Nothing here writes.
 */
import { BLIND_ROOM_DAYS } from "@/lib/rubrics/blind-room-days";

const BLIND_DAYS = BLIND_ROOM_DAYS.map(([d]) => d);
const BLIND_ROOMS = BLIND_ROOM_DAYS.map(([, r]) => r);
import { rebIndexRows } from "@/lib/room-access/tool-reads";
import { argBool, argInt, argStr, type McpTool, type ToolArgs } from "../registry";
import { isRealDate, iso, notCollectedReason, pickRoom, roomRef } from "./s1";

type Row = Record<string, unknown>;

export const REB_LIMIT_DEFAULT = 200;
export const REB_LIMIT_MAX = 1000;

const num = (v: unknown): number | null => (v === null || v === undefined || Number.isNaN(Number(v)) ? null : Number(v));

const rebIndex: McpTool = {
  name: "scribe_reb_index",
  description:
    "REB track index (reb_track_index), read-only; touches no room. Give `window_id` or `ist_date` (one required); optional layer, engine, room; shadow rows only with include_shadow. " +
    "Rows as stored: layer, engine, version, status, R2 key, sha256. limit <= 1000 (default 200), keyset `cursor` = the previous next_cursor. " +
    "Mirrors GET /api/reb/index. Not collected when the table is absent. Times UTC.",
  scope: "read",
  inputSchema: {
    type: "object",
    properties: {
      window_id: { type: "string" },
      ist_date: { type: "string", description: "YYYY-MM-DD (Asia/Kolkata)" },
      layer: { type: "string" },
      engine: { type: "string" },
      room: { type: "string", description: "id, slug or exact name" },
      include_shadow: { type: "boolean", description: "default false: shadow rows excluded" },
      limit: { type: "integer", minimum: 1, maximum: REB_LIMIT_MAX, default: REB_LIMIT_DEFAULT },
      cursor: { type: "integer", minimum: 0, description: "previous next_cursor" },
    },
    additionalProperties: false,
  },
  handler: async (args: ToolArgs) => {
    const windowId = argStr(args, "window_id", 200);
    const day = argStr(args, "ist_date", 10);
    if (!windowId && !day) return { ok: false, error: "window_id_or_ist_date_required" };
    if (day && !isRealDate(day)) return { ok: false, error: "invalid_ist_date" };
    const layer = argStr(args, "layer", 64);
    const engine = argStr(args, "engine", 64);
    let roomId: string | null = null;
    let ref: ReturnType<typeof roomRef> | null = null;
    if (argStr(args, "room", 128)) {
      const picked = await pickRoom(args);
      if ("error" in picked) return picked.error;
      roomId = picked.room.id;
      ref = roomRef(picked.room);
    }
    const limit = argInt(args, "limit", REB_LIMIT_DEFAULT, 1, REB_LIMIT_MAX);
    const rawLimit = typeof args.limit === "number" ? Math.trunc(args.limit) : typeof args.limit === "string" ? Math.trunc(Number(args.limit)) : null;
    const clamp = rawLimit !== null && Number.isFinite(rawLimit) && rawLimit !== limit ? { clamped: true, limit_applied: limit } : {};
    let cursor = 0;
    if (args.cursor !== undefined && args.cursor !== null && args.cursor !== "") {
      cursor = Number(args.cursor);
      if (!Number.isSafeInteger(cursor) || cursor < 0) return { ok: false, error: "invalid_cursor" };
    }
    const withShadow = argBool(args, "include_shadow");
    try {
      const got = (await rebIndexRows({ cursor, windowId, day, layer, engine, roomId, withShadow, limit })) as Row[];
      const page = got.slice(0, limit);
      const rows = page.map((r) => ({
        ...r,
        id: Number(r.id),
        t0_ms: num(r.t0_ms),
        t1_ms: num(r.t1_ms),
        bytes: num(r.bytes),
        started_at: iso(r.started_at),
        finished_at: iso(r.finished_at),
        indexed_at: iso(r.indexed_at),
      }));
      return { ok: true, ...(ref ? { room: ref } : {}), ...clamp, include_shadow: withShadow, count: rows.length, rows, next_cursor: got.length > limit ? rows[rows.length - 1]!.id : null };
    } catch (e) {
      const why = notCollectedReason(e);
      if (why) return { not_collected: true, reason: why };
      return { ok: false, error: String((e as Error)?.message ?? e).slice(0, 200) };
    }
  },
};

export const S5_TOOLS: McpTool[] = [rebIndex];

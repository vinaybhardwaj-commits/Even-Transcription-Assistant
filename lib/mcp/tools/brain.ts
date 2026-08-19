/**
 * lib/mcp/tools/brain.ts — brain read tools (Operator MCP S1, PRD §12 11.2).
 *
 * scribe_list_rooms — `room` table via the app DB (id, slug, name, enabled; NO pin_hash).
 * scribe_get_state  — the picture: lib/brain/state readGraph over the brain pool (same as
 *                     GET /api/brain/rooms/:id/state).
 * scribe_list_cues  — lib/brain/state listCuesForDay (the same lib fn behind the new
 *                     GET /api/brain/rooms/:id/cues). Summary (80 chars) by default; full
 *                     payload only with include_payload=true.
 * Rooms may be addressed by room_id OR room_slug. IST day = server clock (istDate()).
 */

import { sql } from "@/lib/db";
import { getPool } from "@/lib/brain/db";
import { CUES_DEFAULT_LIMIT, CUES_MAX_LIMIT, findRoomDay, isIstDateString, istDate, listCuesForDay, readGraph, roomExists } from "@/lib/brain/state";
import { argBool, argDate, argInt, argStr, failSafe, type McpTool, type ToolArgs } from "../registry";

export type RoomRef = { id: string; slug: string; name: string; enabled: boolean };

export class AmbiguousRoomError extends Error {
  constructor(public matches: RoomRef[]) {
    super("ambiguous_room");
  }
}

/**
 * Resolve a room (app DB). Accepts room_id, room_slug, or `room` = id | slug | name
 * (case-insensitive exact name; PRD §8.3). Null when nothing matches; throws
 * AmbiguousRoomError listing the matches when a name matches more than one room.
 */
export async function resolveRoom(args: ToolArgs): Promise<RoomRef | null> {
  const id = argStr(args, "room_id", 128);
  const slug = argStr(args, "room_slug", 128);
  const free = argStr(args, "room", 128);
  if (!id && !slug && !free) return null;
  const rows = (await sql`
    SELECT id, slug, name, disabled_at
      FROM room
     WHERE (${id}::text IS NOT NULL AND id = ${id}::text)
        OR (${slug}::text IS NOT NULL AND slug = ${slug}::text)
        OR (${free}::text IS NOT NULL AND (id = ${free}::text OR slug = ${free}::text OR lower(name) = lower(${free}::text)))
     ORDER BY created_at
     LIMIT 10
  `) as Array<{ id: string; slug: string; name: string; disabled_at: string | Date | null }>;
  const refs = rows.map((r) => ({ id: r.id, slug: r.slug, name: r.name, enabled: r.disabled_at === null }));
  if (refs.length === 0) return null;
  if (refs.length === 1) return refs[0]!;
  // An id/slug hit is unique by definition; only a free-text name can fan out.
  const exact = refs.find((r) => r.id === (id ?? free) || r.slug === (slug ?? free));
  if (exact) return exact;
  throw new AmbiguousRoomError(refs);
}

export function pickIstDate(args: ToolArgs): { date: string } | { error: string } {
  const d = argStr(args, "ist_date", 10);
  if (d === null) return { date: istDate() };
  return isIstDateString(d) ? { date: d } : { error: "invalid_ist_date" };
}

const ROOM_ARGS = {
  room_id: { type: "string", description: "room_… id (or give room_slug / room)" },
  room_slug: { type: "string", description: "e.g. opd-test-a7q9" },
  room: { type: "string", description: "id, slug, or exact room name (case-insensitive)" },
  ist_date: { type: "string", description: "YYYY-MM-DD in Asia/Kolkata; default today (server clock)" },
};

const listRooms: McpTool = {
  name: "scribe_list_rooms",
  description: "Bench rooms (room table): id, slug, name, enabled, created_at, last session. No PIN, no pin_hash.",
  scope: "read",
  inputSchema: { type: "object", properties: {}, additionalProperties: false },
  handler: async () =>
    failSafe({ rooms: [] as unknown[] }, async () => {
      // Same query as GET /api/bench/rooms (app/api/bench/rooms/route.ts).
      const rows = (await sql`
        SELECT r.id, r.slug, r.name, r.created_at, r.disabled_at,
               ls.started_at AS last_session_at, ls.status AS last_session_status
          FROM room r
          LEFT JOIN LATERAL (
            SELECT started_at, status
              FROM bench_session
             WHERE room_id = r.id
             ORDER BY started_at DESC
             LIMIT 1
          ) ls ON true
         ORDER BY r.created_at
      `) as Array<{ id: string; slug: string; name: string; created_at: string | Date; disabled_at: string | Date | null; last_session_at: string | Date | null; last_session_status: string | null }>;
      return {
        rooms: rows.map((r) => ({
          id: r.id,
          slug: r.slug,
          name: r.name,
          enabled: r.disabled_at === null,
          created_at: new Date(r.created_at).toISOString(),
          last_session_at: r.last_session_at ? new Date(r.last_session_at).toISOString() : null,
          last_session_status: r.last_session_status,
        })),
      };
    }),
};

const getState: McpTool = {
  name: "scribe_get_state",
  description: "Brain picture for a room-day: { room_id, room_day_id, ist_date, visits[], active_visit_id, clusters[] (no vectors), confidence, as_of }. Read-only; never creates a day.",
  scope: "read",
  inputSchema: { type: "object", properties: ROOM_ARGS, additionalProperties: false },
  handler: async (args: ToolArgs) =>
    failSafe({ state: null as unknown }, async () => {
      const room = await resolveRoom(args);
      if (!room) return { state: null, error: "unknown_room" };
      const d = pickIstDate(args);
      if ("error" in d) return { state: null, error: d.error };
      if (!(await roomExists(room.id))) return { state: null, error: "unknown_room" };
      const day = await findRoomDay(room.id, d.date);
      const state = await readGraph(getPool(), room.id, d.date, day?.id ?? null);
      return { room: { id: room.id, slug: room.slug, name: room.name }, state };
    }),
};

const listCues: McpTool = {
  name: "scribe_list_cues",
  description: "Cues for a room-day, newest first: { id, type, at, created_at, summary }. summary = first 80 chars of the payload JSON; full payload ONLY with include_payload=true. Filters: since (ISO, at > since), type (exact), limit (default 50, max 200).",
  scope: "read",
  inputSchema: {
    type: "object",
    properties: {
      ...ROOM_ARGS,
      since: { type: "string", description: "ISO timestamp; cues with at > since" },
      type: { type: "string", maxLength: 64 },
      limit: { type: "integer", minimum: 1, maximum: CUES_MAX_LIMIT, default: CUES_DEFAULT_LIMIT },
      include_payload: { type: "boolean", default: false },
    },
    additionalProperties: false,
  },
  handler: async (args: ToolArgs) =>
    failSafe({ cues: [] as unknown[] }, async () => {
      const room = await resolveRoom(args);
      if (!room) return { cues: [], error: "unknown_room" };
      const d = pickIstDate(args);
      if ("error" in d) return { cues: [], error: d.error };
      const since = argDate(args, "since");
      if (args.since !== undefined && since === null) return { cues: [], error: "invalid_since" };
      const type = argStr(args, "type", 64);
      if (!(await roomExists(room.id))) return { cues: [], error: "unknown_room" };
      const out = await listCuesForDay(room.id, d.date, {
        since,
        type,
        limit: argInt(args, "limit", CUES_DEFAULT_LIMIT, 1, CUES_MAX_LIMIT),
        includePayload: argBool(args, "include_payload"),
      });
      return { room: { id: room.id, slug: room.slug, name: room.name }, ...out };
    }),
};

export const BRAIN_TOOLS: McpTool[] = [listRooms, getState, listCues];

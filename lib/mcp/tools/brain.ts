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
 *
 * S3 WRITES (PRD §9, §11.1 Pin, §11.4 source tags; scope write):
 * scribe_post_cue  — independent brain write: POST same-origin /api/brain/cues with the
 *                    server-injected BRAIN_SERVICE_TOKEN (the MCP is a CLIENT of the brain — no
 *                    direct cue SQL; BRAIN_BASE_URL override honoured exactly like brain-proxy).
 *                    `source` (mcp|warehouse|replay, default mcp) is FORCED into the payload.
 *                    Needs no active tape.
 * scribe_pin_visit — cue type operator_pin {visit_id?|individual_uid?, phase, source:"mcp"}.
 *                    NEVER touches the `visit` table — evidence for the future fuse (§11.3).
 */

import { sql } from "@/lib/db";
import { getPool, TOKEN_ENV } from "@/lib/brain/db";
import { CUES_DEFAULT_LIMIT, CUES_MAX_LIMIT, findRoomDay, isIstDateString, istDate, listCuesForDay, readGraph, roomExists } from "@/lib/brain/state";
import { argBool, argDate, argInt, argStr, failSafe, type McpTool, type ToolArgs, type ToolContext } from "../registry";

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

// ---------------------------------------------------------------------------
// S3 — the single brain write door, as a client (same-origin HTTP + server token)
// ---------------------------------------------------------------------------

const BRAIN_TIMEOUT_MS = 5_000;
export const CUE_SOURCES = ["mcp", "warehouse", "replay"] as const;
export type CueSource = (typeof CUE_SOURCES)[number];

function brainCuesUrl(origin: string): string {
  const base = process.env.BRAIN_BASE_URL?.trim();
  if (base) return new URL("/api/brain/cues", base.endsWith("/") ? base : `${base}/`).toString();
  return new URL("/api/brain/cues", origin).toString();
}

export type PostCueResult =
  | { ok: true; cue_id: string; cue_at: string; brain_status: number; state_summary: string }
  | { ok: false; error: string; brain_status: number | null; detail?: string };

/**
 * POST /api/brain/cues with Bearer BRAIN_SERVICE_TOKEN (server-side env). `source` is forced
 * into the payload by the caller's policy (never trusted from args). Never throws.
 */
export async function postBrainCue(
  origin: string,
  body: { room_id: string; type: string; at?: string; payload: Record<string, unknown> },
): Promise<PostCueResult> {
  const token = process.env[TOKEN_ENV];
  if (!token) return { ok: false, error: "service_token_not_configured", brain_status: null };
  try {
    const res = await fetch(brainCuesUrl(origin), {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(BRAIN_TIMEOUT_MS),
      cache: "no-store",
    });
    const j = (await res.json().catch(() => null)) as { ok?: boolean; cue_id?: string; cue_at?: string; error?: string; state?: unknown } | null;
    if (!res.ok || !j?.ok) {
      return { ok: false, error: j?.error ?? `brain_${res.status}`, brain_status: res.status };
    }
    let summary = "";
    try {
      summary = JSON.stringify(j.state ?? {}).slice(0, 80);
    } catch {
      summary = "";
    }
    return { ok: true, cue_id: String(j.cue_id ?? ""), cue_at: String(j.cue_at ?? ""), brain_status: res.status, state_summary: summary };
  } catch (e) {
    const name = (e as Error)?.name;
    return { ok: false, error: name === "TimeoutError" || name === "AbortError" ? "brain_timeout" : "brain_unreachable", brain_status: null, detail: String((e as Error)?.message ?? e).slice(0, 160) };
  }
}

async function resolveRoomForWrite(args: ToolArgs): Promise<{ room: RoomRef } | { error: Record<string, unknown> }> {
  try {
    const room = await resolveRoom(args);
    if (!room) return { error: { ok: false, error: "unknown_room" } };
    return { room };
  } catch (e) {
    if (e instanceof AmbiguousRoomError) return { error: { ok: false, error: "ambiguous_room", matches: e.matches.map((m) => ({ id: m.id, slug: m.slug, name: m.name })) } };
    return { error: { ok: false, error: "room_lookup_failed", degraded: true, detail: String((e as Error)?.message ?? e).slice(0, 160) } };
  }
}

function parseAtArg(args: ToolArgs): { at?: string } | { error: string } {
  if (args.at === undefined || args.at === null || args.at === "") return {};
  const d = argDate(args, "at");
  return d ? { at: d.toISOString() } : { error: "invalid_at" };
}

const WRITE_ROOM_ARGS = {
  room: { type: "string", description: "room id, slug, or exact name" },
  room_id: { type: "string" },
  room_slug: { type: "string" },
};

const postCue: McpTool = {
  name: "scribe_post_cue",
  description: "Independent operator cue into the brain (PRD §9): POST /api/brain/cues as a client with the server-side token. type is an open set (≤64 chars). payload is any JSON object; `source` (mcp|warehouse|replay, default mcp) is FORCED into it. Does not need an active tape. Returns { ok, cue_id, cue_at, state_summary (80 chars) }.",
  scope: "write",
  inputSchema: {
    type: "object",
    properties: {
      ...WRITE_ROOM_ARGS,
      type: { type: "string", maxLength: 64, description: "cue type, e.g. consult_mark | stt_turn | warehouse_event | pulse_note | test" },
      at: { type: "string", description: "ISO timestamp; default now (server)" },
      payload: { type: "object", description: "any JSON object; source is overwritten" },
      source: { type: "string", enum: ["mcp", "warehouse", "replay"], default: "mcp" },
    },
    required: ["type"],
    additionalProperties: false,
  },
  handler: async (args: ToolArgs, ctx: ToolContext) => {
    const r = await resolveRoomForWrite(args);
    if ("error" in r) return r.error;
    const type = argStr(args, "type", 64);
    if (!type) return { ok: false, error: "type_required" };
    const at = parseAtArg(args);
    if ("error" in at) return { ok: false, error: at.error };
    const srcRaw = argStr(args, "source", 16) ?? "mcp";
    if (!(CUE_SOURCES as readonly string[]).includes(srcRaw)) return { ok: false, error: "source_not_allowed", allowed: CUE_SOURCES };
    const source = srcRaw as CueSource;
    const rawPayload = args.payload;
    if (rawPayload !== undefined && (typeof rawPayload !== "object" || rawPayload === null || Array.isArray(rawPayload))) {
      return { ok: false, error: "payload_must_be_object" };
    }
    const payload = { ...((rawPayload as Record<string, unknown>) ?? {}), source }; // forced
    const out = await postBrainCue(ctx.origin, { room_id: r.room.id, type, ...(at.at ? { at: at.at } : {}), payload });
    return { room: { id: r.room.id, slug: r.room.slug, name: r.room.name }, type, source, ...out };
  },
};

const VISIT_PHASES = ["called", "in_chair", "at_diagnostics", "ended", "unknown"] as const;

const pinVisit: McpTool = {
  name: "scribe_pin_visit",
  description: "Operator pin (PRD §11.1): cue type operator_pin with { visit_id? | individual_uid?, phase ∈ called|in_chair|at_diagnostics|ended|unknown, source:'mcp' }. Evidence for the future fuse — NEVER writes or updates the visit table.",
  scope: "write",
  inputSchema: {
    type: "object",
    properties: {
      ...WRITE_ROOM_ARGS,
      at: { type: "string", description: "ISO timestamp; default now" },
      visit_id: { type: "string" },
      individual_uid: { type: "string" },
      phase: { type: "string", enum: [...VISIT_PHASES] },
    },
    required: ["phase"],
    additionalProperties: false,
  },
  handler: async (args: ToolArgs, ctx: ToolContext) => {
    const r = await resolveRoomForWrite(args);
    if ("error" in r) return r.error;
    const phase = argStr(args, "phase", 32);
    if (!phase || !(VISIT_PHASES as readonly string[]).includes(phase)) return { ok: false, error: "invalid_phase", allowed: VISIT_PHASES };
    const at = parseAtArg(args);
    if ("error" in at) return { ok: false, error: at.error };
    const visitId = argStr(args, "visit_id", 128);
    const individualUid = argStr(args, "individual_uid", 128);
    const payload: Record<string, unknown> = { phase, source: "mcp" };
    if (visitId) payload.visit_id = visitId;
    if (individualUid) payload.individual_uid = individualUid;
    const out = await postBrainCue(ctx.origin, { room_id: r.room.id, type: "operator_pin", ...(at.at ? { at: at.at } : {}), payload });
    return { room: { id: r.room.id, slug: r.room.slug, name: r.room.name }, type: "operator_pin", phase, ...out, visit_table_touched: false };
  },
};

export const BRAIN_TOOLS: McpTool[] = [listRooms, getState, listCues, postCue, pinVisit];

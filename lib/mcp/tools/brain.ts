/**
 * lib/mcp/tools/brain.ts — brain read tools (Operator MCP S1, PRD §12 11.2).
 *
 * scribe_list_rooms — `room` table via the app DB (id, slug, name, enabled; NO pin_hash).
 *                     Scratch rooms (SCRATCH_ROOM_PREFIX, fuse slice 2) are hidden unless
 *                     include_scratch:true. resolveRoom below is deliberately NOT filtered —
 *                     every room-addressed tool must still be able to reach a scratch room by
 *                     id or slug, which is how the fuse's scratch day is read back.
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
 *                    direct cue SQL; always same-origin, exactly like brain-proxy).
 *                    `source` (mcp|warehouse|replay, default mcp) is FORCED into the payload.
 *                    Needs no active tape.
 * scribe_pin_visit — cue type operator_pin {visit_id?|individual_uid?, phase, source:"mcp"}.
 *                    NEVER touches the `visit` table — evidence for the future fuse (§11.3).
 */

import { sql } from "@/lib/db";
import { getPool, TOKEN_ENV } from "@/lib/brain/db";
import { SCRATCH_ROOM_PREFIX } from "@/lib/brain/scratch";
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
  description:
    "Bench rooms (room table): id, slug, name, enabled, created_at, last session. No PIN, no pin_hash. Scratch rooms (id room_scratch_…, the fuse's replay targets) are HIDDEN by default; pass include_scratch:true to list them too.",
  scope: "read",
  inputSchema: {
    type: "object",
    properties: {
      include_scratch: { type: "boolean", description: "also list the fuse's scratch rooms (room_scratch_…); default false", default: false },
    },
    additionalProperties: false,
  },
  handler: async (args: ToolArgs) =>
    failSafe({ rooms: [] as unknown[] }, async () => {
      const includeScratch = argBool(args, "include_scratch");
      // Same query as GET /api/bench/rooms (app/api/bench/rooms/route.ts), plus the scratch
      // filter. `_` is a single-character wildcard in LIKE, so the prefix is matched with
      // left()/length() rather than a pattern — no ESCAPE clause to get wrong, and the
      // prefix comes from the one exported constant so it cannot drift.
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
         WHERE ${includeScratch}::boolean
            OR left(r.id, length(${SCRATCH_ROOM_PREFIX}::text)) <> ${SCRATCH_ROOM_PREFIX}::text
         ORDER BY r.created_at
      `) as Array<{ id: string; slug: string; name: string; created_at: string | Date; disabled_at: string | Date | null; last_session_at: string | Date | null; last_session_status: string | null }>;
      return {
        include_scratch: includeScratch,
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
/**
 * The sources `scribe_post_cue` will stamp on a cue. `warehouse` was removed in fuse slice 3:
 * nothing produces a warehouse cue by hand any more. A warehouse cue now comes only from
 * scripts/load-warehouse-fixture.ts, which writes it into the SCRATCH graph with a source_ref
 * so 0047's natural key can absorb a re-run. Letting an operator stamp `warehouse` on a cue
 * with no source_ref would put an un-keyed row in the same namespace — and, on this tool,
 * onto a LIVE room-day, which is the one thing slice 3 must not do.
 */
export const CUE_SOURCES = ["mcp", "replay"] as const;
export type CueSource = (typeof CUE_SOURCES)[number];

/**
 * Cue types this tool REFUSES, by name, before anything is posted.
 *
 * Every one of them is a MACHINE type: it belongs to a pipeline that owns its own natural key
 * and writes into the SCRATCH graph, never onto a room's live day, which is the only day this
 * tool can reach. The hazard is not an untidy row — it is a keyless one:
 *
 *   · stt_turn / stt_silence / stt_window / speaker_match — the speech-turn writer keys on
 *     cue.source_ref = "{session_id}|{start_ms}|{end_ms}|{speaker}" and leans on 0050's partial
 *     unique index to absorb a re-run. A turn stamped by hand carries no source_ref, so it is in
 *     no index, and every re-run of the operator's hand would add another copy of it.
 *     stt_window (K3) is refused for a second reason on top of that one: it is the WINDOW'S
 *     COMPLETENESS RECORD, and a hand-stamped `complete: true` would assert that a window was
 *     finished when nothing had read the tape at all. Only the writer that did the work may say
 *     whether the work finished.
 *   · pqm_called / pstart / dx_event / pulse_note — the warehouse types (0047). Same shape, same
 *     reason: the loader carries the warehouse row's own id in source_ref, and a hand-stamped
 *     one would sit un-keyed in the same namespace. `warehouse` was already removed from
 *     CUE_SOURCES for exactly this reason; the type is the other half of that door.
 *
 * An open `type` set is still the design (0042, 0046) — consult_mark, operator_pin, a test cue
 * and anything a human invents keep working. This is a named blocklist, not a new closed set.
 */
export const POST_CUE_BLOCKED_TYPES = [
  "stt_turn",
  "stt_silence",
  "stt_window",
  "speaker_match",
  "pqm_called",
  "pstart",
  "dx_event",
  "pulse_note",
] as const;

const POST_CUE_BLOCKED_SET: ReadonlySet<string> = new Set<string>(POST_CUE_BLOCKED_TYPES);

function brainCuesUrl(origin: string): string {
  // Always this app's own origin — lib/brain is the only brain.
  return new URL("/api/brain/cues", origin).toString();
}

export type PostCueResult =
  | { ok: true; cue_id: string | null; cue_at: string; brain_status: number; state_summary: string; already_existed: boolean }
  | { ok: false; error: string; brain_status: number | null; detail?: string };

/**
 * POST /api/brain/cues with Bearer BRAIN_SERVICE_TOKEN (server-side env). `source` is forced
 * into the payload by the caller's policy (never trusted from args). Never throws.
 *
 * Fuse slice 2: the body may also carry `room_day_id` (write to THAT day — the route then
 * applies the scratch guard), plus `session_id` and `source` for the two 0046 columns. Slice 3
 * adds `source_ref` (0047), the warehouse row's own id. Every live caller omits all four and
 * gets exactly today's behaviour. When the route reports the cue already existed, that is
 * ok:true with already_existed:true and a null cue_id.
 */
export async function postBrainCue(
  origin: string,
  body: { room_id: string; type: string; at?: string; payload: Record<string, unknown>; room_day_id?: string; session_id?: string; source?: string; source_ref?: string },
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
    const j = (await res.json().catch(() => null)) as { ok?: boolean; cue_id?: string | null; cue_at?: string; error?: string; state?: unknown; already_existed?: boolean } | null;
    if (!res.ok || !j?.ok) {
      return { ok: false, error: j?.error ?? `brain_${res.status}`, brain_status: res.status };
    }
    let summary = "";
    try {
      summary = JSON.stringify(j.state ?? {}).slice(0, 80);
    } catch {
      summary = "";
    }
    return {
      ok: true,
      cue_id: j.cue_id == null ? null : String(j.cue_id),
      cue_at: String(j.cue_at ?? ""),
      brain_status: res.status,
      state_summary: summary,
      already_existed: j.already_existed === true,
    };
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
  description: "Independent operator cue into the brain (PRD §9): POST /api/brain/cues as a client with the server-side token, onto the room's LIVE day. type is an open set (≤64 chars) MINUS a named blocklist: stt_turn, stt_silence, speaker_match, pqm_called, pstart, dx_event and pulse_note are refused by name (type_not_allowed) because each belongs to a pipeline that keys its cues on source_ref and writes them into the SCRATCH graph — stamped by hand here they would land keyless on a LIVE day and duplicate on every re-run. payload is any JSON object; `source` (mcp|replay, default mcp) is FORCED into it. `warehouse` is NOT accepted here — a warehouse cue carries the id of the warehouse row it came from and belongs in the scratch graph, which is scripts/load-warehouse-fixture.ts's job, not this tool's. Does not need an active tape. Returns { ok, cue_id, cue_at, state_summary (80 chars) }.",
  scope: "write",
  inputSchema: {
    type: "object",
    properties: {
      ...WRITE_ROOM_ARGS,
      type: { type: "string", maxLength: 64, description: "cue type, e.g. consult_mark | operator_note | test — the machine types (stt_turn, stt_silence, stt_window, speaker_match, pqm_called, pstart, dx_event, pulse_note) are refused" },
      at: { type: "string", description: "ISO timestamp; default now (server)" },
      payload: { type: "object", description: "any JSON object; source is overwritten" },
      source: { type: "string", enum: ["mcp", "replay"], default: "mcp" },
    },
    required: ["type"],
    additionalProperties: false,
  },
  handler: async (args: ToolArgs, ctx: ToolContext) => {
    const r = await resolveRoomForWrite(args);
    if ("error" in r) return r.error;
    const type = argStr(args, "type", 64);
    if (!type) return { ok: false, error: "type_required" };
    // The blocklist, before the room is used for anything and long before a cue is posted. A
    // machine type stamped by hand carries no source_ref, so no partial unique index holds it
    // and a second press writes a second copy — onto a LIVE day.
    if (POST_CUE_BLOCKED_SET.has(type)) {
      return {
        ok: false,
        error: "type_not_allowed",
        type,
        blocked: POST_CUE_BLOCKED_TYPES,
        note: "this type belongs to a pipeline that keys its cues on source_ref and writes them into the scratch graph — it is never stamped by hand onto a live day.",
      };
    }
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

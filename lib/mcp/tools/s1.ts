/**
 * lib/mcp/tools/s1.ts — S1A (8 Oct 2026): the first three S1 reads of SPEC-PHASE1. All read scope, bound parameters, summaries by default.
 * NOTHING here writes: no INSERT/UPDATE/DELETE, no command, no claim clear. Old tool names are untouched; these wrap their sources.
 *
 *   scribe_now       {include_claims?}                 the fleet board — the same snapshot GET /api/rooms-live/now serves (lib/rooms-live/snapshot)
 *   scribe_room      {room, view, window_min?}         alerts | levels | commands | devices for ONE room
 *   scribe_tape_day  {ist_date, room?}                 room_audio_day rollup (+ room_audio_state intervals with include_segments)
 *
 * A source table or column that does not exist answers `{ not_collected: true, reason }` for that view; schema is never invented.
 */
import { sql } from "@/lib/db";
import { listCommands } from "@/lib/bench-commands";
import { buildSnapshot } from "@/lib/rooms-live/snapshot";
import { claimResolved, toView } from "@/lib/rooms-live/claims";
import { openClaims } from "@/lib/rooms-live-claims";
import { argBool, argInt, argStr, IST_DATE_RE, failSafe, type McpTool, type ToolArgs } from "../registry";
import { AmbiguousRoomError, resolveRoom, type RoomRef } from "./brain";
import { LEVEL_TOOLS } from "./levels";

export const WINDOW_MIN_DEFAULT = 60;
export const WINDOW_MIN_MAX = 240;
export const COMMAND_ROWS_MAX = 50;
export const ALERT_ROWS_MAX = 100;
export const SEGMENTS_MAX = 400;
/** zero_ratio at or above this is digital silence (the same 0.98 the Watchdog and the Rooms Live screen use) */
export const CAPTURE_DEAD_ZERO_RATIO = 0.98;
/** a room's newest 15 s level bucket older than this is stale (the meter has stopped, or the listener is gone) */
export const LEVEL_STALE_AFTER_S = 120;

const iso = (v: unknown): string | null => {
  if (v === null || v === undefined) return null;
  const d = v instanceof Date ? v : new Date(String(v));
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
};

/** A missing table or column is "not collected", not an error: the tool never invents schema. */
export function notCollectedReason(e: unknown): string | null {
  const err = e as { code?: string; message?: string } | null;
  const msg = String(err?.message ?? e);
  if (err?.code === "42P01" || err?.code === "42703" || /relation .* does not exist|column .* does not exist/i.test(msg)) return msg.slice(0, 160);
  return null;
}

type RoomOutcome = { room: RoomRef } | { error: Record<string, unknown> };

async function pickRoom(args: ToolArgs): Promise<RoomOutcome> {
  const asked = argStr(args, "room", 128);
  if (!asked) return { error: { ok: false, error: "room_required" } };
  try {
    const room = await resolveRoom({ room: asked });
    if (!room) return { error: { ok: false, error: "unknown_room", room: asked } };
    return { room };
  } catch (e) {
    if (e instanceof AmbiguousRoomError) {
      return { error: { ok: false, error: "ambiguous_room", room: asked, matches: e.matches.map((m) => ({ id: m.id, slug: m.slug, name: m.name })) } };
    }
    throw e;
  }
}

const roomRef = (r: RoomRef) => ({ id: r.id, slug: r.slug, name: r.name });

// ---------------------------------------------------------------------------
// scribe_now
// ---------------------------------------------------------------------------

const now: McpTool = {
  name: "scribe_now",
  description:
    "The fleet board, read-only: every Rooms Live room's state (listening, quiet, recording, silent, offline, unknown…), state_since, detail_code, level (rms, zero, at, stale), device, session, steward, ages. " +
    "The SAME snapshot GET /api/rooms-live/now serves (lib/rooms-live/snapshot), computed fresh each call. " +
    "tape_advancing does not mean audio is arriving — trust the room state and the ages (ages_s), not a single level reading. zero_ratio >= 0.98 = digital silence; levels can freeze after a device drop. " +
    "`include_claims` (default false) adds each room's open \"I'm on it\" claim; reading it never clears one (the route's auto-clear belongs to the route). Doctor names are included as the screen shows them. Times UTC.",
  scope: "read",
  inputSchema: {
    type: "object",
    properties: { include_claims: { type: "boolean", description: "Attach each room's open claim ({by, since}); default false. Read-only: no auto-clear." } },
    additionalProperties: false,
  },
  handler: async (args: ToolArgs) =>
    failSafe({ rooms: [] as unknown[], degraded: ["snapshot"] }, async () => {
      // buildSnapshot, not getSnapshot: the route's 2-second memo and its claim-streak / auto-clear state belong to the route; a tool call must not feed or skew them.
      const snap = await buildSnapshot({ db: sql as never });
      if (!argBool(args, "include_claims")) return snap as never;
      const degraded = [...snap.degraded];
      try {
        const claims = await openClaims(sql as never);
        for (const c of claims) {
          const row = snap.rooms.find((r) => r.room_id === c.room_id);
          if (row && !claimResolved(row.state, !!row.doctor, row.doctor_known)) row.claim = toView(c);
        }
      } catch {
        degraded.push("rooms_live_claim");
      }
      return { ...snap, degraded } as never;
    }),
};

// ---------------------------------------------------------------------------
// scribe_room
// ---------------------------------------------------------------------------

const VIEWS = ["alerts", "levels", "commands", "devices"] as const;
type View = (typeof VIEWS)[number];

async function viewAlerts(room: RoomRef, windowMin: number): Promise<Record<string, unknown>> {
  try {
    const rows = (await sql`
      SELECT id, created_at, kind, room_ids, room_name, status_from, status_to, subject, body
        FROM room_alert_outbox
       WHERE room_ids @> ARRAY[${room.id}]::text[]
         AND created_at > now() - make_interval(mins => ${windowMin})
       ORDER BY id DESC
       LIMIT ${ALERT_ROWS_MAX + 1}
    `) as Array<Record<string, unknown>>;
    const kept = rows.slice(0, ALERT_ROWS_MAX);
    const byKind: Record<string, number> = {};
    for (const r of kept) byKind[String(r.kind)] = (byKind[String(r.kind)] ?? 0) + 1;
    return {
      ok: true,
      count: kept.length,
      truncated: rows.length > ALERT_ROWS_MAX,
      by_kind: byKind,
      alerts: kept.map((r) => ({
        id: Number(r.id),
        created_at: iso(r.created_at),
        kind: r.kind,
        status_from: r.status_from ?? null,
        status_to: r.status_to ?? null,
        room_count: Array.isArray(r.room_ids) ? r.room_ids.length : 1,
        subject: String(r.subject),
      })),
    };
  } catch (e) {
    const why = notCollectedReason(e);
    if (why) return { not_collected: true, reason: why };
    return { ok: false, error: String((e as Error)?.message ?? e).slice(0, 200) };
  }
}

type LevelsAnswer = { samples?: Array<{ t_ms: number; zero_ratio: number | null; samples: number; stale?: boolean }>; error?: string };

async function viewLevels(room: RoomRef, windowMin: number, includeSamples: boolean): Promise<Record<string, unknown>> {
  const to = Date.now();
  const from = to - windowMin * 60_000;
  const ans = (await LEVEL_TOOLS[0]!.handler({ room_id: room.id, from: new Date(from).toISOString(), to: new Date(to).toISOString(), limit: 5760 }, { origin: "", actor: "", scopes: new Set(["read"]) } as never)) as LevelsAnswer & Record<string, unknown>;
  if (ans.error) return { ok: false, error: ans.error };
  const samples = ans.samples ?? [];
  let n = 0;
  let zeroWeighted = 0;
  for (const s of samples) {
    if (s.zero_ratio === null || !s.samples) continue;
    n += s.samples;
    zeroWeighted += s.zero_ratio * s.samples;
  }
  const zeroRatio = n > 0 ? Math.round((zeroWeighted / n) * 10_000) / 10_000 : null;
  const newest = samples.length ? samples[samples.length - 1]! : null;
  const newestAge = newest ? Math.max(0, Math.round((to - newest.t_ms) / 1000)) : null;
  // stale = nothing arrived lately, or the newest bucket is a frozen meter (the same flag the admin card shows)
  const stale = newest === null || (newestAge as number) > LEVEL_STALE_AFTER_S || newest.stale === true;
  return {
    ok: true,
    window_min: windowMin,
    bucket_seconds: ans.bucket_seconds ?? null,
    buckets: samples.length,
    raw_samples: n,
    zero_ratio: zeroRatio,
    capture_dead: zeroRatio !== null && zeroRatio >= CAPTURE_DEAD_ZERO_RATIO,
    stale,
    newest_bucket_at: newest ? new Date(newest.t_ms).toISOString() : null,
    newest_bucket_age_s: newestAge,
    stale_after_s: LEVEL_STALE_AFTER_S,
    ...(ans.truncated ? { truncated: true } : {}),
    ...(includeSamples ? { samples } : {}),
  };
}

async function viewCommands(room: RoomRef, windowMin: number, includePayload: boolean): Promise<Record<string, unknown>> {
  try {
    const rows = await listCommands({ roomId: room.id, status: null, limit: 200 });
    const since = Date.now() - windowMin * 60_000;
    const inWindow = rows.filter((c) => new Date(c.created_at).getTime() >= since);
    const byStatus: Record<string, number> = {};
    for (const c of inWindow) byStatus[c.status] = (byStatus[c.status] ?? 0) + 1;
    return {
      ok: true,
      window_min: windowMin,
      count: inWindow.length,
      by_status: byStatus,
      // listCommands caps at 200 rows; a room with more commands than that in the window is cut at the oldest
      truncated: rows.length >= 200 && inWindow.length === rows.length,
      commands: inWindow.slice(0, COMMAND_ROWS_MAX).map((c) => ({
        id: c.id,
        kind: c.kind,
        status: c.status,
        source: c.source,
        error: c.error,
        created_at: iso(c.created_at),
        acked_at: iso(c.acked_at),
        ...(includePayload ? { args: c.args ?? null, result: c.result ?? null } : {}),
      })),
    };
  } catch (e) {
    return { ok: false, error: String((e as Error)?.message ?? e).slice(0, 200) };
  }
}

async function viewDevices(room: RoomRef): Promise<Record<string, unknown>> {
  try {
    const rows = (await sql`
      SELECT hostname, state_flags, state_changed_at, input_device_name, input_devices
        FROM room_install
       WHERE room_id = ${room.id}::text AND retired_at IS NULL AND enrolled_at IS NOT NULL
       ORDER BY enrolled_at DESC
       LIMIT 5
    `) as Array<Record<string, unknown>>;
    if (rows.length === 0) return { ok: true, installs: 0, devices: [] };
    return {
      ok: true,
      installs: rows.length,
      // as stored: the recorder's own report of its input devices, untouched
      devices: rows.map((r) => ({
        machine: (r.hostname as string | null) ?? null,
        input_device_name: (r.input_device_name as string | null) ?? null,
        input_devices: r.input_devices ?? null,
        state_flags: r.state_flags ?? null,
        state_changed_at: iso(r.state_changed_at),
      })),
    };
  } catch (e) {
    const why = notCollectedReason(e);
    if (why) return { not_collected: true, reason: why };
    return { ok: false, error: String((e as Error)?.message ?? e).slice(0, 200) };
  }
}

const room: McpTool = {
  name: "scribe_room",
  description:
    "One room, read-only; reads a live room, changes nothing: `view` picks alerts (Room Watchdog rows incl. recovered), levels (mic-level summary with zero_ratio, capture_dead = zero_ratio >= 0.98, stale), commands (bench_command outcomes) or devices (the recorder's stored input devices). " +
    "`room` is an id, slug or exact name; `window_min` is 1-240 (default 60). " +
    "tape_advancing does not mean audio is arriving; zero_ratio >= 0.98 = digital silence; levels can freeze after a device drop. " +
    "Flags: include_samples (levels: the 15 s buckets), include_payload (commands: args and result). An unknown room answers { ok:false, error:'unknown_room' }. Times UTC.",
  scope: "read",
  inputSchema: {
    type: "object",
    properties: {
      room: { type: "string", description: "id, slug, or exact room name (case-insensitive)" },
      view: { type: "string", enum: [...VIEWS] },
      window_min: { type: "integer", minimum: 1, maximum: WINDOW_MIN_MAX, default: WINDOW_MIN_DEFAULT, description: "Look-back window in minutes, ceiling 240." },
      include_samples: { type: "boolean", description: "levels: also return the 15 s buckets; default false." },
      include_payload: { type: "boolean", description: "commands: also return each command's args and result; default false." },
    },
    required: ["room", "view"],
    additionalProperties: false,
  },
  handler: async (args: ToolArgs) => {
    const view = argStr(args, "view", 16) as View | null;
    if (!view || !VIEWS.includes(view)) return { ok: false, error: "unknown_view", allowed: [...VIEWS] };
    const picked = await pickRoom(args);
    if ("error" in picked) return picked.error;
    const windowMin = argInt(args, "window_min", WINDOW_MIN_DEFAULT, 1, WINDOW_MIN_MAX);
    const body =
      view === "alerts" ? await viewAlerts(picked.room, windowMin)
      : view === "levels" ? await viewLevels(picked.room, windowMin, argBool(args, "include_samples"))
      : view === "commands" ? await viewCommands(picked.room, windowMin, argBool(args, "include_payload"))
      : await viewDevices(picked.room);
    return { room: roomRef(picked.room), view, ...body };
  },
};

// ---------------------------------------------------------------------------
// scribe_tape_day
// ---------------------------------------------------------------------------

const DAY_COLUMNS = "room_id, ist_day, min_off, min_muted, min_zero_all_day, min_present, min_gated, min_withheld, consult_min_usable, consult_min_uncertain, consult_min_lost, n_consults, classifier_version, written_at";

const tapeDay: McpTool = {
  name: "scribe_tape_day",
  description:
    "One IST day of room-audio state, read-only; touches no room: per-room minutes by state (off, muted, zero all day, present, gated, withheld), consult minutes usable / uncertain / lost, and the consult count, from room_audio_day. " +
    "`room` (id, slug or name) narrows to one room; include_segments adds that room's state intervals from room_audio_state (needs `room`). The classifier writes about an hour behind; `as_of` says how far. Read-only: CONSULT's classifier writes these tables, this tool never does. Times UTC.",
  scope: "read",
  inputSchema: {
    type: "object",
    properties: {
      ist_date: { type: "string", description: "YYYY-MM-DD (Asia/Kolkata)." },
      room: { type: "string", description: "id, slug, or exact room name; omit for every room that has a row that day." },
      include_segments: { type: "boolean", description: "With `room`: also return the state intervals (max 400); default false." },
    },
    required: ["ist_date"],
    additionalProperties: false,
  },
  handler: async (args: ToolArgs) => {
    const day = argStr(args, "ist_date", 10);
    if (!day || !IST_DATE_RE.test(day) || Number.isNaN(Date.parse(`${day}T00:00:00Z`))) return { ok: false, error: "invalid_ist_date" };
    void DAY_COLUMNS; // the sql tag takes no identifiers; the column list is spelled out in the statement
    let roomId: string | null = null;
    let ref: RoomRef | null = null;
    const asked = argStr(args, "room", 128);
    if (asked) {
      const picked = await pickRoom(args);
      if ("error" in picked) return picked.error;
      ref = picked.room;
      roomId = ref.id;
    }
    try {
      const rows = (await sql`
        SELECT room_id, ist_day, min_off, min_muted, min_zero_all_day, min_present, min_gated, min_withheld,
               consult_min_usable, consult_min_uncertain, consult_min_lost, n_consults, classifier_version, written_at
          FROM room_audio_day
         WHERE ist_day = ${day}::date AND (${roomId}::text IS NULL OR room_id = ${roomId}::text)
         ORDER BY room_id
         LIMIT 100
      `) as Array<Record<string, unknown>>;
      const num = (v: unknown): number => Number(v ?? 0);
      const out: Record<string, unknown> = {
        ok: true,
        ist_date: day,
        ...(ref ? { room: roomRef(ref) } : {}),
        rooms: rows.map((r) => ({
          room_id: String(r.room_id),
          min_off: num(r.min_off),
          min_muted: num(r.min_muted),
          min_zero_all_day: num(r.min_zero_all_day),
          min_present: num(r.min_present),
          min_gated: num(r.min_gated),
          min_withheld: num(r.min_withheld),
          consult_min_usable: num(r.consult_min_usable),
          consult_min_uncertain: num(r.consult_min_uncertain),
          consult_min_lost: num(r.consult_min_lost),
          n_consults: num(r.n_consults),
          classifier_version: String(r.classifier_version),
          written_at: iso(r.written_at),
        })),
        as_of: rows.length ? iso(new Date(rows.map((r) => new Date(String(r.written_at)).getTime()).reduce((a, b) => Math.max(a, b)))) : null,
      };
      if (argBool(args, "include_segments")) {
        if (!roomId) return { ...out, segments_error: "room_required_for_segments" };
        const seg = (await sql`
          SELECT state, ts_start, ts_end
            FROM room_audio_state
           WHERE room_id = ${roomId}::text AND ist_day = ${day}::date
           ORDER BY ts_start
           LIMIT ${SEGMENTS_MAX}
        `) as Array<Record<string, unknown>>;
        out.segments = seg.map((s) => ({ state: String(s.state), start: iso(s.ts_start), end: iso(s.ts_end) }));
        out.segments_truncated = seg.length >= SEGMENTS_MAX;
      }
      return out;
    } catch (e) {
      const why = notCollectedReason(e);
      if (why) return { ok: true, ist_date: day, not_collected: true, reason: why };
      return { ok: false, error: String((e as Error)?.message ?? e).slice(0, 200) };
    }
  },
};

export const S1_TOOLS: McpTool[] = [now, room, tapeDay];

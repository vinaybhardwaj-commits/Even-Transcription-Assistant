/**
 * lib/mcp/tools/s1b.ts — S1B (8 Oct 2026): scribe_steward, scribe_kiosks, scribe_stt_windows. Read scope, bound parameters, summaries by default.
 * NOTHING here writes. lib/steward, lib/rooms-live and app/ are not edited; their tables are read with this file's own SELECTs.
 *
 *   scribe_steward      steward_config, steward_decisions (+ room), steward_tickets, the last-tick/lease config rows
 *   scribe_kiosks       room_install, kiosk_health_events, bench_listener, pulse_presence_events (extension version / last event)
 *   scribe_stt_windows  bench_window (+ bench_session, room), stt_subject_job, scribe_job, transcription_run (no text), encounter_hypothesis_run
 *
 * A missing table or column (SQLSTATE 42P01 / 42703) answers { not_collected: true, reason } for that view. No transcript text, no patient
 * identifier, no ticket signature or nonce, no storage key is returned.
 */
import { sql } from "@/lib/db";
import { expandKeys, matchKey } from "@/lib/kiosk-health-read";
import { machineKeys } from "@/lib/encounter-windows/machine-keys";
import { argBool, argInt, argStr, type McpTool, type ToolArgs } from "../registry";
import type { RoomRef } from "./brain";
import { isRealDate, iso, notCollectedReason, pickRoom, roomRef } from "./s1";

type Row = Record<string, unknown>;

export const SINCE_HOURS_DEFAULT = 24;
export const SINCE_HOURS_MAX = 168;
export const LIMIT_DEFAULT = 50;
export const LIMIT_MAX = 200;
/** scribe_steward why: decision rows within this many minutes either side of `at` */
export const WHY_WINDOW_MIN = 15;
/** steward_decisions retention (migration 0128 / kiosk-health-retention cron) */
export const DECISION_RETENTION_DAYS = 30;
export const KIOSK_ROOMS_MAX = 40;
export const KH_WINDOW_H = 24;
export const KH_LAST_SEEN_DAYS = 7;
export const POWER_ROWS_PER_MACHINE = 20;
export const WINDOWS_DEFAULT = 100;

/** Keys that must never leave this door, wherever they sit in a stored JSON value (a steward.result event stores the ticket's nonce in `result`). */
const SECRET_KEYS = /^(nonce|signature)$/i;
export function scrub(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(scrub);
  if (v && typeof v === "object") return Object.fromEntries(Object.entries(v as Row).filter(([k]) => !SECRET_KEYS.test(k)).map(([k, x]) => [k, scrub(x)]));
  return v;
}

const trunc = (v: unknown, n = 200): string | null => (typeof v === "string" ? v.slice(0, n) : null);
const num = (v: unknown): number | null => (v === null || v === undefined || Number.isNaN(Number(v)) ? null : Number(v));
const ageS = (v: unknown, nowMs = Date.now()): number | null => {
  const t = v instanceof Date ? v.getTime() : Date.parse(String(v ?? ""));
  return Number.isFinite(t) ? Math.max(0, Math.round((nowMs - t) / 1000)) : null;
};

/** Run a view; a missing table or column is not_collected, any other failure is ok:false. Never throws. */
async function guarded(fn: () => Promise<Row>): Promise<Row> {
  try {
    return await fn();
  } catch (e) {
    const why = notCollectedReason(e);
    if (why) return { not_collected: true, reason: why };
    return { ok: false, error: String((e as Error)?.message ?? e).slice(0, 200) };
  }
}

/** since_hours / limit with the ceilings; says so when it clamps. */
function bounds(args: ToolArgs): { sinceHours: number; limit: number; clamp: Row } {
  const sinceHours = argInt(args, "since_hours", SINCE_HOURS_DEFAULT, 1, SINCE_HOURS_MAX);
  const limit = argInt(args, "limit", LIMIT_DEFAULT, 1, LIMIT_MAX);
  const clamp: Row = {};
  const raw = (k: string) => (typeof args[k] === "number" ? (args[k] as number) : typeof args[k] === "string" ? Number(args[k]) : NaN);
  if (Number.isFinite(raw("since_hours")) && Math.trunc(raw("since_hours")) !== sinceHours) Object.assign(clamp, { clamped: true, since_hours_applied: sinceHours });
  if (Number.isFinite(raw("limit")) && Math.trunc(raw("limit")) !== limit) Object.assign(clamp, { clamped: true, limit_applied: limit });
  return { sinceHours, limit, clamp };
}

/** The room argument, when given, resolved; absent is fine. */
async function optionalRoom(args: ToolArgs): Promise<{ room: RoomRef | null } | { error: Row }> {
  if (!argStr(args, "room", 128)) return { room: null };
  const picked = await pickRoom(args);
  return "error" in picked ? { error: picked.error } : { room: picked.room };
}

// ---------------------------------------------------------------------------
// scribe_steward
// ---------------------------------------------------------------------------

const STEWARD_VIEWS = ["config", "decisions", "tickets", "tick", "why"] as const;
type StewardView = (typeof STEWARD_VIEWS)[number];
/** config rows that are bookkeeping, not settings: the loop lease and the last-tick summary (shown by `tick`) */
const NON_SETTING_KEYS = ["loop_lease", "last_tick"];

async function stewardConfigRows(): Promise<Array<{ key: string; value: unknown; updated_at: string | null; updated_by: string | null }>> {
  const rows = (await sql`
    SELECT key, value, updated_at, updated_by FROM steward_config
     WHERE key <> ALL(${NON_SETTING_KEYS}::text[])
     ORDER BY key
     LIMIT 50
  `) as Row[];
  return rows.map((r) => ({ key: String(r.key), value: scrub(r.value), updated_at: iso(r.updated_at), updated_by: (r.updated_by as string | null) ?? null }));
}

const decisionOut = (r: Row, payload: boolean): Row => ({
  id: Number(r.id),
  ts: iso(r.ts),
  room_id: (r.room_id as string | null) ?? null,
  room_name: (r.room_name as string | null) ?? null,
  machine: (r.machine as string | null) ?? null,
  window_kind: (r.window_kind as string | null) ?? null,
  rule: String(r.rule),
  action: String(r.action),
  mode: String(r.mode),
  result: (r.result as string | null) ?? null,
  actor: String(r.actor),
  why: trunc(r.why, 400),
  why_not: trunc(r.why_not, 400),
  ...(payload ? { params: scrub(r.params ?? null), inputs: scrub(r.inputs ?? null), inputs_hash: (r.inputs_hash as string | null) ?? null } : {}),
});

async function stewardDecisions(roomId: string | null, sinceHours: number, limit: number, payload: boolean): Promise<Row> {
  const rows = (await sql`
    SELECT d.id, d.ts, d.room_id, r.name AS room_name, d.machine, d.window_kind, d.rule, d.action, d.params, d.mode, d.result, d.actor,
           d.why, d.why_not, d.inputs_hash, d.inputs
      FROM steward_decisions d
      LEFT JOIN room r ON r.id = d.room_id
     WHERE d.ts > now() - make_interval(hours => ${sinceHours})
       AND (${roomId}::text IS NULL OR d.room_id = ${roomId}::text)
     ORDER BY d.ts DESC, d.id DESC
     LIMIT ${limit + 1}
  `) as Row[];
  const kept = rows.slice(0, limit);
  const byAction: Record<string, number> = {};
  for (const r of kept) byAction[String(r.action)] = (byAction[String(r.action)] ?? 0) + 1;
  return { ok: true, since_hours: sinceHours, count: kept.length, truncated: rows.length > limit, by_action: byAction, decisions: kept.map((r) => decisionOut(r, payload)) };
}

async function stewardTickets(roomId: string | null, sinceHours: number, limit: number, payload: boolean): Promise<Row> {
  // A ticket belongs to a machine; a room's machines are its enrolled installs' hostnames, plus any ticket whose decision was about the room.
  const rows = (await sql`
    SELECT t.ticket_id, t.machine, t.action, t.status, t.issued_at, t.expires_at, t.fetched_at, t.completed_at, t.decision_id, t.params, t.result
      FROM steward_tickets t
     WHERE t.issued_at > now() - make_interval(hours => ${sinceHours})
       AND (${roomId}::text IS NULL
            OR t.machine IN (SELECT i.hostname FROM room_install i WHERE i.room_id = ${roomId}::text AND i.retired_at IS NULL AND i.hostname IS NOT NULL)
            OR t.decision_id IN (SELECT d.id FROM steward_decisions d WHERE d.room_id = ${roomId}::text))
     ORDER BY t.issued_at DESC
     LIMIT ${limit + 1}
  `) as Row[];
  const kept = rows.slice(0, limit);
  const byStatus: Record<string, number> = {};
  for (const r of kept) byStatus[String(r.status)] = (byStatus[String(r.status)] ?? 0) + 1;
  // never the signature or the nonce: not as columns, and not inside params / result (scrub)
  return {
    ok: true,
    since_hours: sinceHours,
    count: kept.length,
    truncated: rows.length > limit,
    by_status: byStatus,
    tickets: kept.map((r) => ({
      ticket_id: String(r.ticket_id),
      machine: String(r.machine),
      action: String(r.action),
      status: String(r.status),
      issued_at: iso(r.issued_at),
      expires_at: iso(r.expires_at),
      fetched_at: iso(r.fetched_at),
      completed_at: iso(r.completed_at),
      decision_id: r.decision_id === null || r.decision_id === undefined ? null : Number(r.decision_id),
      ...(payload ? { params: scrub(r.params ?? null), result: scrub(r.result ?? null) } : {}),
    })),
  };
}

async function stewardTick(): Promise<Row> {
  const rows = (await sql`
    SELECT key, value, updated_at, EXTRACT(EPOCH FROM (now() - updated_at))::int AS age_s
      FROM steward_config
     WHERE key = ANY(${["last_tick", "loop_lease", "kill_switch"]}::text[])
  `) as Row[];
  const by = new Map(rows.map((r) => [String(r.key), r]));
  const last = by.get("last_tick");
  const lease = by.get("loop_lease");
  const kill = by.get("kill_switch");
  const leaseVal = (lease?.value ?? null) as { until?: unknown } | null;
  const untilMs = leaseVal && typeof leaseVal === "object" ? Date.parse(String(leaseVal.until ?? "")) : NaN;
  const recent = (await sql`
    SELECT count(*)::int AS n, max(ts) AS newest FROM steward_decisions WHERE ts > now() - interval '1 hour'
  `) as Row[];
  return {
    ok: true,
    last_tick: last ? { ...(scrub(last.value) as object), recorded_at: iso(last.updated_at), age_s: num(last.age_s) } : null,
    kill_switch: kill ? ((scrub(kill.value) as { on?: unknown } | null)?.on ?? null) : null,
    // the holder is an internal run id and is not shown; only whether a lease is live
    lease: lease ? { until: Number.isFinite(untilMs) ? new Date(untilMs).toISOString() : null, held: Number.isFinite(untilMs) ? untilMs > Date.now() : null } : null,
    decisions_last_hour: num(recent[0]?.n) ?? 0,
    newest_decision_at: iso(recent[0]?.newest),
  };
}

async function stewardWhy(args: ToolArgs, room: RoomRef): Promise<Row> {
  const at = argStr(args, "at", 40);
  if (!at) return { ok: false, error: "at_required" };
  // an ISO stamp that names its own offset: a naive one would mean different instants on different hosts (S1 rule, as scribe_room_levels)
  const atMs = /(?:Z|[+-]\d{2}:?\d{2})$/i.test(at) && /\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}/.test(at) ? Date.parse(at) : NaN;
  if (!Number.isFinite(atMs)) return { ok: false, error: "invalid_at", hint: "ISO timestamp with an offset, e.g. 2026-10-08T09:30:00Z" };
  const lo = new Date(atMs - WHY_WINDOW_MIN * 60_000).toISOString();
  const hi = new Date(atMs + WHY_WINDOW_MIN * 60_000).toISOString();
  const rows = (await sql`
    SELECT d.id, d.ts, d.room_id, r.name AS room_name, d.machine, d.window_kind, d.rule, d.action, d.params, d.mode, d.result, d.actor,
           d.why, d.why_not, d.inputs_hash, d.inputs
      FROM steward_decisions d
      LEFT JOIN room r ON r.id = d.room_id
     WHERE d.room_id = ${room.id}::text AND d.ts >= ${lo}::timestamptz AND d.ts <= ${hi}::timestamptz
     ORDER BY d.ts, d.id
     LIMIT ${LIMIT_DEFAULT + 1}
  `) as Row[];
  const cfg = await stewardConfigRows();
  const by = new Map(cfg.map((c) => [c.key, c.value]));
  const rooms = (by.get("rooms") ?? null) as Record<string, unknown> | null;
  const beyond = atMs < Date.now() - DECISION_RETENTION_DAYS * 86_400_000;
  return {
    ok: true,
    at: new Date(atMs).toISOString(),
    window: { from: lo, to: hi, minutes_each_side: WHY_WINDOW_MIN },
    count: Math.min(rows.length, LIMIT_DEFAULT),
    truncated: rows.length > LIMIT_DEFAULT,
    // beyond retention the decision log has been pruned: an empty answer there means "gone", not "nothing happened"
    ...(beyond ? { beyond_retention: true, retention_days: DECISION_RETENTION_DAYS } : {}),
    decisions: rows.slice(0, LIMIT_DEFAULT).map((r) => decisionOut(r, argBool(args, "include_payload"))),
    // steward_config keeps no history: these are the values NOW, not at `at`
    config_in_force: {
      history: false,
      note: "steward_config stores only the current value of each key; these are today's values, not those in force at `at`.",
      kill_switch: by.get("kill_switch") ?? null,
      shadow: by.get("shadow") ?? null,
      schedule: by.get("schedule") ?? null,
      days: by.get("days") ?? null,
      caps: by.get("caps") ?? null,
      priority: by.get("priority") ?? null,
      room: rooms ? (rooms[room.id] ?? null) : null,
    },
  };
}

const steward: McpTool = {
  name: "scribe_steward",
  description:
    "Room Steward, read-only; touches no room (the steward itself may act on one). `view`: config (settings now), decisions (newest first, room name joined), tickets (repair tickets, never the signature or nonce), tick (last tick, kill switch, lease), " +
    "why ({room, at}: decisions within 15 min either side of `at`, plus the config now; steward_config keeps no history so history:false). since_hours <= 168 (default 24), limit <= 200 (default 50), both clamped with clamped:true. " +
    "include_payload adds decision params/inputs and ticket params/result. Decision rows are kept 30 days. Times UTC.",
  scope: "read",
  inputSchema: {
    type: "object",
    properties: {
      view: { type: "string", enum: [...STEWARD_VIEWS] },
      room: { type: "string", description: "id, slug or exact name; required for why" },
      at: { type: "string", description: "why: ISO time with offset" },
      since_hours: { type: "integer", minimum: 1, maximum: SINCE_HOURS_MAX, default: SINCE_HOURS_DEFAULT },
      limit: { type: "integer", minimum: 1, maximum: LIMIT_MAX, default: LIMIT_DEFAULT },
      include_payload: { type: "boolean", description: "decisions/tickets: add params, inputs, result" },
    },
    required: ["view"],
    additionalProperties: false,
  },
  handler: async (args: ToolArgs) => {
    const view = argStr(args, "view", 16) as StewardView | null;
    if (!view || !STEWARD_VIEWS.includes(view)) return { ok: false, error: "unknown_view", allowed: [...STEWARD_VIEWS] };
    const r = await optionalRoom(args);
    if ("error" in r) return r.error;
    if (view === "why" && !r.room) return { ok: false, error: "room_required" };
    const { sinceHours, limit, clamp } = bounds(args);
    const payload = argBool(args, "include_payload");
    const body = await guarded(async () => {
      switch (view) {
        case "config": return { ok: true, config: await stewardConfigRows() };
        case "decisions": return stewardDecisions(r.room?.id ?? null, sinceHours, limit, payload);
        case "tickets": return stewardTickets(r.room?.id ?? null, sinceHours, limit, payload);
        case "tick": return stewardTick();
        case "why": return stewardWhy(args, r.room!);
      }
    });
    return { view, ...(r.room ? { room: roomRef(r.room) } : {}), ...(view === "decisions" || view === "tickets" ? clamp : {}), ...body };
  },
};

// ---------------------------------------------------------------------------
// scribe_kiosks
// ---------------------------------------------------------------------------

const KIOSK_VIEWS = ["health", "versions", "devices", "power", "last_seen"] as const;
type KioskView = (typeof KIOSK_VIEWS)[number];

type Install = { room_id: string; room_name: string; hostname: string | null; row: Row };

async function installs(roomId: string | null): Promise<Install[]> {
  const rows = (await sql`
    SELECT i.room_id, r.name AS room_name, i.hostname, i.app_version, i.build_sha, i.os_version, i.hardware_model, i.update_channel, i.assigned_channel,
           i.last_update_result, i.last_update_version, i.last_update_error, i.last_update_at, i.first_seen_at, i.last_seen_at, i.never_sleep, i.disk_free_bytes,
           i.mic_state, i.launch_agent_loaded, i.session_open, i.tape_advancing, i.state_flags, i.state_changed_at, i.input_device_name, i.input_devices, i.expected_device_name
      FROM room_install i
      JOIN room r ON r.id = i.room_id
     WHERE i.retired_at IS NULL AND i.enrolled_at IS NOT NULL
       AND (${roomId}::text IS NULL OR i.room_id = ${roomId}::text)
     ORDER BY r.name
     LIMIT ${KIOSK_ROOMS_MAX}
  `) as Row[];
  return rows.map((r) => ({ room_id: String(r.room_id), room_name: String(r.room_name), hostname: (r.hostname as string | null) ?? null, row: r }));
}

/** SQL key list for a set of installs, and the key → room map used to put event rows back on their room */
function keyMap(list: Install[]): { keys: string[]; roomOf: Map<string, string> } {
  const roomOf = new Map<string, string>();
  const keys = new Set<string>();
  for (const i of list) {
    if (!i.hostname) continue;
    for (const k of expandKeys(machineKeys(i.hostname))) {
      keys.add(k);
      roomOf.set(matchKey(k), i.room_id);
    }
  }
  return { keys: [...keys], roomOf };
}

const base = (i: Install): Row => ({ room_id: i.room_id, room_name: i.room_name, machine: i.hostname });

async function kioskVersions(list: Install[]): Promise<Row> {
  const { keys, roomOf } = keyMap(list);
  // the extension's newest reported version per machine; its table missing is a field-level not_collected, not a failure of the view
  let ext: Map<string, { ver: string; ts: string | null }> | { not_collected: true; reason: string } = new Map();
  if (keys.length) {
    try {
      const rows = (await sql`
        SELECT DISTINCT ON (p.machine) p.machine, p.payload->>'ext_version' AS ver, p.ts
          FROM pulse_presence_events p
         WHERE p.source = 'ext' AND p.machine = ANY(${keys}::text[]) AND p.payload->>'ext_version' IS NOT NULL
         ORDER BY p.machine, p.ts DESC, p.id DESC
         LIMIT 200
      `) as Row[];
      const m = new Map<string, { ver: string; ts: string | null }>();
      for (const r of rows) {
        const room = roomOf.get(matchKey(String(r.machine)));
        if (room && !m.has(room)) m.set(room, { ver: String(r.ver).slice(0, 32), ts: iso(r.ts) });
      }
      ext = m;
    } catch (e) {
      const why = notCollectedReason(e);
      if (!why) throw e;
      ext = { not_collected: true, reason: why };
    }
  }
  return {
    ok: true,
    kiosks: list.map((i) => {
      const r = i.row;
      const e = ext instanceof Map ? ext.get(i.room_id) : undefined;
      return {
        ...base(i),
        app_version: (r.app_version as string | null) ?? null,
        build_sha: (r.build_sha as string | null) ?? null,
        os_version: (r.os_version as string | null) ?? null,
        hardware_model: (r.hardware_model as string | null) ?? null,
        update_channel: (r.update_channel as string | null) ?? null,
        assigned_channel: (r.assigned_channel as string | null) ?? null,
        last_update: { result: (r.last_update_result as string | null) ?? null, version: (r.last_update_version as string | null) ?? null, at: iso(r.last_update_at), error: trunc(r.last_update_error) },
        extension: ext instanceof Map ? (e ? { version: e.ver, as_of: e.ts } : null) : ext,
      };
    }),
  };
}

const kioskDevices = (list: Install[]): Row => ({
  ok: true,
  // as stored: the recorder's own report; nothing is reinterpreted
  kiosks: list.map((i) => ({
    ...base(i),
    input_device_name: (i.row.input_device_name as string | null) ?? null,
    expected_device_name: (i.row.expected_device_name as string | null) ?? null,
    input_devices: i.row.input_devices ?? null,
    mic_state: (i.row.mic_state as string | null) ?? null,
    state_flags: i.row.state_flags ?? null,
    state_changed_at: iso(i.row.state_changed_at),
  })),
});

async function kioskHealth(list: Install[]): Promise<Row> {
  const { keys, roomOf } = keyMap(list);
  const byRoom = new Map<string, Row[]>();
  if (keys.length) {
    const rows = (await sql`
      SELECT DISTINCT ON (k.machine, k.kind) k.machine, k.kind, k.ts, k.received_at
        FROM kiosk_health_events k
       WHERE k.machine = ANY(${keys}::text[]) AND k.received_at > now() - make_interval(hours => ${KH_WINDOW_H})
       ORDER BY k.machine, k.kind, k.received_at DESC
       LIMIT 1000
    `) as Row[];
    for (const r of rows) {
      const room = roomOf.get(matchKey(String(r.machine)));
      if (!room) continue;
      const list2 = byRoom.get(room) ?? [];
      list2.push({ kind: String(r.kind), ts: iso(r.ts), received_at: iso(r.received_at), age_s: ageS(r.received_at) });
      byRoom.set(room, list2);
    }
  }
  return {
    ok: true,
    window_h: KH_WINDOW_H,
    kiosks: list.map((i) => {
      // the same kind can arrive under two spellings of the machine; keep the newest of each
      const newest = new Map<string, Row>();
      for (const e of byRoom.get(i.room_id) ?? []) {
        const prior = newest.get(e.kind as string);
        if (!prior || Date.parse(String(e.received_at)) > Date.parse(String(prior.received_at))) newest.set(e.kind as string, e);
      }
      const events = [...newest.values()].sort((a, b) => String(a.kind).localeCompare(String(b.kind)));
      const hb = newest.get("heartbeat");
      return { ...base(i), heartbeat_age_s: hb ? hb.age_s : null, kinds: events.length, newest_by_kind: events };
    }),
  };
}

async function kioskPower(list: Install[]): Promise<Row> {
  const { keys, roomOf } = keyMap(list);
  if (keys.length === 0) return { not_collected: true, reason: "no machine bound to this room" };
  const rows = keys.length
    ? ((await sql`
        SELECT w.machine, w.kind, w.ts, w.received_at, w.reason, w.kaesleep FROM (
          SELECT k.machine, k.kind, k.ts, k.received_at, k.payload->>'reason' AS reason, k.payload->>'kAESleep' AS kaesleep,
                 row_number() OVER (PARTITION BY k.machine ORDER BY k.ts DESC) AS rn
            FROM kiosk_health_events k
           WHERE k.kind LIKE 'power.%' AND k.machine = ANY(${keys}::text[])
             AND k.received_at > now() - make_interval(days => ${KH_LAST_SEEN_DAYS})
        ) w
        WHERE w.rn <= ${POWER_ROWS_PER_MACHINE}
        ORDER BY w.machine, w.ts DESC
        LIMIT 800
      `) as Row[])
    : [];
  if (rows.length === 0) {
    return { not_collected: true, reason: `no power.* (sleep / wake / shutdown) events stored for ${list.length ? "these rooms' machines" : "any enrolled machine"} in the last ${KH_LAST_SEEN_DAYS} days` };
  }
  const byRoom = new Map<string, Row[]>();
  for (const r of rows) {
    const room = roomOf.get(matchKey(String(r.machine)));
    if (!room) continue;
    const l = byRoom.get(room) ?? [];
    l.push({ kind: String(r.kind), ts: iso(r.ts), received_at: iso(r.received_at), reason: trunc(r.reason, 80), kAESleep: trunc(r.kaesleep, 20) });
    byRoom.set(room, l);
  }
  return {
    ok: true,
    window_days: KH_LAST_SEEN_DAYS,
    note: "ts is event time (pmset rows can arrive hours late); received_at is arrival time",
    kiosks: list.map((i) => ({ ...base(i), events: (byRoom.get(i.room_id) ?? []).sort((a, b) => Date.parse(String(b.ts)) - Date.parse(String(a.ts))).slice(0, POWER_ROWS_PER_MACHINE) })),
  };
}

async function kioskLastSeen(list: Install[]): Promise<Row> {
  const { keys, roomOf } = keyMap(list);
  const ids = list.map((i) => i.room_id);
  const newest = async (text: Row[], field: string): Promise<Map<string, string>> => {
    const m = new Map<string, string>();
    for (const r of text) {
      const room = roomOf.get(matchKey(String(r.machine)));
      const t = iso(r[field]);
      if (room && t && (!m.has(room) || Date.parse(t) > Date.parse(m.get(room)!))) m.set(room, t);
    }
    return m;
  };
  const listeners = ids.length
    ? ((await sql`SELECT room_id, last_poll_at FROM bench_listener WHERE room_id = ANY(${ids}::text[]) LIMIT 50`) as Row[])
    : [];
  const anyEvent = keys.length
    ? await newest(
        (await sql`
          SELECT DISTINCT ON (k.machine) k.machine, k.received_at
            FROM kiosk_health_events k
           WHERE k.machine = ANY(${keys}::text[]) AND k.received_at > now() - make_interval(days => ${KH_LAST_SEEN_DAYS})
           ORDER BY k.machine, k.received_at DESC
           LIMIT 200
        `) as Row[],
        "received_at",
      )
    : new Map<string, string>();
  const heartbeat = keys.length
    ? await newest(
        (await sql`
          SELECT DISTINCT ON (k.machine) k.machine, k.received_at
            FROM kiosk_health_events k
           WHERE k.kind = 'heartbeat' AND k.machine = ANY(${keys}::text[]) AND k.received_at > now() - make_interval(days => ${KH_LAST_SEEN_DAYS})
           ORDER BY k.machine, k.received_at DESC
           LIMIT 200
        `) as Row[],
        "received_at",
      )
    : new Map<string, string>();
  // the extension's table is the Pulse side; if it is absent that signal alone is not_collected
  let ext: Map<string, string> | null = new Map();
  if (keys.length) {
    try {
      ext = await newest(
        (await sql`
          SELECT DISTINCT ON (p.machine) p.machine, p.ts
            FROM pulse_presence_events p
           WHERE p.source = 'ext' AND p.machine = ANY(${keys}::text[]) AND p.ts > now() - make_interval(days => ${KH_LAST_SEEN_DAYS})
           ORDER BY p.machine, p.ts DESC, p.id DESC
           LIMIT 200
        `) as Row[],
        "ts",
      );
    } catch (e) {
      if (!notCollectedReason(e)) throw e;
      ext = null;
    }
  }
  const listenerBy = new Map(listeners.map((l) => [String(l.room_id), iso(l.last_poll_at)]));
  const sig = (at: string | null | undefined) => ({ at: at ?? null, age_s: at ? ageS(at) : null });
  return {
    ok: true,
    window_days: KH_LAST_SEEN_DAYS,
    kiosks: list.map((i) => ({
      ...base(i),
      install_last_seen: sig(iso(i.row.last_seen_at)),
      listener_last_poll: sig(listenerBy.get(i.room_id)),
      kiosk_health_last_event: sig(anyEvent.get(i.room_id)),
      kiosk_health_last_heartbeat: sig(heartbeat.get(i.room_id)),
      extension_last_event: ext === null ? { not_collected: true } : sig(ext.get(i.room_id)),
    })),
  };
}

const kiosks: McpTool = {
  name: "scribe_kiosks",
  description:
    "Kiosk fleet, read-only; reads live kiosks' stored reports, sends no command. `view`: health (newest event per kind, 24 h), versions (app, OS, update channel, last update, extension), devices (audio inputs as stored), " +
    "power (sleep/wake/shutdown events; not_collected when none stored), last_seen (newest signal per room with ages_s). `room` narrows to one room; omit for every enrolled kiosk (max 40). " +
    "Health payloads and log lines are never returned. Times UTC.",
  scope: "read",
  inputSchema: {
    type: "object",
    properties: {
      view: { type: "string", enum: [...KIOSK_VIEWS] },
      room: { type: "string", description: "id, slug or exact name; omit for every enrolled kiosk" },
    },
    required: ["view"],
    additionalProperties: false,
  },
  handler: async (args: ToolArgs) => {
    const view = argStr(args, "view", 16) as KioskView | null;
    if (!view || !KIOSK_VIEWS.includes(view)) return { ok: false, error: "unknown_view", allowed: [...KIOSK_VIEWS] };
    const r = await optionalRoom(args);
    if ("error" in r) return r.error;
    const body = await guarded(async () => {
      const list = await installs(r.room?.id ?? null);
      switch (view) {
        case "health": return kioskHealth(list);
        case "versions": return kioskVersions(list);
        case "devices": return kioskDevices(list);
        case "power": return kioskPower(list);
        case "last_seen": return kioskLastSeen(list);
      }
    });
    return { view, ...(r.room ? { room: roomRef(r.room) } : {}), ...body };
  },
};

// ---------------------------------------------------------------------------
// scribe_stt_windows
// ---------------------------------------------------------------------------

const WINDOW_SELECT_NOTE = "lab / REB fields are null until S5";

async function oneWindow(windowId: string): Promise<Row> {
  const w = (await sql`
    SELECT w.id, w.session_id, w.room_day_id, w.start_ms, w.end_ms, w.source_mic, w.grid_aligned, w.state, w.closed_at, w.created_at,
           w.auto_drain_refused_at, w.auto_drain_refused_reason, s.room_id, r.name AS room_name, s.started_at AS session_started_at
      FROM bench_window w
      JOIN bench_session s ON s.id = w.session_id
      JOIN room r ON r.id = s.room_id
     WHERE w.id = ${windowId}::text
     LIMIT 1
  `) as Row[];
  if (w.length === 0) return { ok: false, error: "unknown_window", window_id: windowId };
  const win = w[0]!;
  const drain = (await sql`
    SELECT tier, state, attempts, last_error, queued_at, started_at, finished_at
      FROM stt_subject_job
     WHERE subject_type = 'bench_window' AND subject_id = ${windowId}::text
     ORDER BY tier
     LIMIT 10
  `) as Row[];
  const jobs = (await sql`
    SELECT id, kind, status, step, attempts, failures, created_at, started_at, finished_at, (error IS NOT NULL) AS has_error
      FROM scribe_job
     WHERE args->>'window_id' = ${windowId}::text
     ORDER BY created_at DESC
     LIMIT 20
  `) as Row[];
  // runs carry transcript text in their own columns; only its length is read here
  const runs = (await sql`
    SELECT id, encounter_id, engine, stt_engine_id, mode, tier, detected_language, latency_ms, cost_usd, error,
           COALESCE(length(transcript_original), 0) AS original_chars, created_at
      FROM transcription_run
     WHERE subject_type = 'bench_window' AND subject_id = ${windowId}::text
     ORDER BY created_at DESC
     LIMIT 20
  `) as Row[];
  let hypo: Row;
  try {
    const h = (await sql`
      SELECT id, created_at, n_hypotheses FROM encounter_hypothesis_run
       WHERE room_day_id = ${(win.room_day_id as string | null) ?? ""}::text
       ORDER BY created_at DESC LIMIT 1
    `) as Row[];
    hypo = h[0] ? { latest_run_id: String(h[0].id), run_at: iso(h[0].created_at), n_hypotheses: num(h[0].n_hypotheses) } : { latest_run_id: null };
  } catch (e) {
    const why = notCollectedReason(e);
    if (!why) throw e;
    hypo = { not_collected: true, reason: why };
  }
  const encIds = [...new Set(runs.map((x) => x.encounter_id).filter((x): x is string => typeof x === "string"))];
  return {
    ok: true,
    window: {
      id: String(win.id),
      room: { id: String(win.room_id), name: String(win.room_name) },
      session_id: String(win.session_id),
      room_day_id: (win.room_day_id as string | null) ?? null,
      start_ms: num(win.start_ms),
      end_ms: num(win.end_ms),
      duration_s: num(win.end_ms) !== null && num(win.start_ms) !== null ? Math.round(((num(win.end_ms) as number) - (num(win.start_ms) as number)) / 1000) : null,
      source_mic: String(win.source_mic),
      grid_aligned: win.grid_aligned === true,
      state: String(win.state),
      closed_at: iso(win.closed_at),
      created_at: iso(win.created_at),
      auto_drain_refused: win.auto_drain_refused_at ? { at: iso(win.auto_drain_refused_at), reason: trunc(win.auto_drain_refused_reason) } : null,
    },
    drain: drain.map((d) => ({ tier: String(d.tier), state: String(d.state), attempts: num(d.attempts), last_error: trunc(d.last_error), queued_at: iso(d.queued_at), started_at: iso(d.started_at), finished_at: iso(d.finished_at) })),
    jobs: jobs.map((j) => ({ id: String(j.id), kind: String(j.kind), status: String(j.status), step: (j.step as string | null) ?? null, attempts: num(j.attempts), failures: num(j.failures), has_error: j.has_error === true, created_at: iso(j.created_at), started_at: iso(j.started_at), finished_at: iso(j.finished_at) })),
    runs: runs.map((x) => ({ id: String(x.id), engine: String(x.engine), stt_engine_id: (x.stt_engine_id as string | null) ?? null, mode: String(x.mode), tier: (x.tier as string | null) ?? null, language: (x.detected_language as string | null) ?? null, latency_ms: num(x.latency_ms), cost_usd: num(x.cost_usd), error: trunc(x.error), original_chars: num(x.original_chars), created_at: iso(x.created_at) })),
    encounter_link: { run_encounter_ids: encIds, room_day_id: (win.room_day_id as string | null) ?? null, hypotheses: hypo },
    lab: { reb: null, lab_fields: null, note: `S5: ${WINDOW_SELECT_NOTE}` },
  };
}

async function dayWindows(roomId: string, day: string, limit: number): Promise<Row> {
  // bench_window.start_ms is epoch ms (lib/bench-window.ts), so a window belongs to the IST day it STARTS in, whatever day its session started.
  const dayLo = Date.parse(`${day}T00:00:00+05:30`);
  const dayHi = dayLo + 86_400_000;
  const rows = (await sql`
    SELECT w.id, w.room_day_id, w.start_ms, w.end_ms, w.source_mic, w.state, w.closed_at
      FROM bench_window w
      JOIN bench_session s ON s.id = w.session_id
     WHERE s.room_id = ${roomId}::text AND w.start_ms >= ${dayLo}::bigint AND w.start_ms < ${dayHi}::bigint
     ORDER BY w.start_ms
     LIMIT ${limit + 1}
  `) as Row[];
  const kept = rows.slice(0, limit);
  const ids = kept.map((r) => String(r.id));
  const drain = ids.length
    ? ((await sql`
        SELECT subject_id, tier, state, attempts FROM stt_subject_job
         WHERE subject_type = 'bench_window' AND subject_id = ANY(${ids}::text[])
         LIMIT ${limit * 2}
      `) as Row[])
    : [];
  const drainBy = new Map<string, Row>();
  for (const d of drain) if (!drainBy.has(String(d.subject_id)) || d.tier === "asr") drainBy.set(String(d.subject_id), d);
  const byState: Record<string, number> = {};
  const drainStates: Record<string, number> = {};
  for (const r of kept) byState[String(r.state)] = (byState[String(r.state)] ?? 0) + 1;
  for (const id of ids) {
    const k = drainBy.get(id) ? String(drainBy.get(id)!.state) : "no_job";
    drainStates[k] = (drainStates[k] ?? 0) + 1;
  }
  return {
    ok: true,
    ist_date: day,
    count: kept.length,
    truncated: rows.length > limit,
    by_state: byState,
    drain_by_state: drainStates,
    windows: kept.map((r) => ({ id: String(r.id), start_ms: num(r.start_ms), end_ms: num(r.end_ms), source_mic: String(r.source_mic), state: String(r.state), closed_at: iso(r.closed_at), drain: drainBy.get(String(r.id)) ? { state: String(drainBy.get(String(r.id))!.state), attempts: num(drainBy.get(String(r.id))!.attempts) } : null })),
    lab: { reb: null, lab_fields: null, note: `S5: ${WINDOW_SELECT_NOTE}` },
  };
}

const sttWindows: McpTool = {
  name: "scribe_stt_windows",
  description:
    "STT windows, read-only; touches no room. Pass `window_id` for one window (state, drain job, scribe_job rows, runs with engine/cost/length, encounter link) or `ist_date` + `room` for the windows that START in that IST day, with state counts. " +
    "No transcript text, clip keys or patient identifiers. Lab / REB fields are null (S5). `limit` <= 200 (default 100) for a day. Times UTC.",
  scope: "read",
  inputSchema: {
    type: "object",
    properties: {
      window_id: { type: "string", description: "bench_window id" },
      ist_date: { type: "string", description: "YYYY-MM-DD (Asia/Kolkata), with room" },
      room: { type: "string", description: "id, slug or exact name" },
      limit: { type: "integer", minimum: 1, maximum: LIMIT_MAX, default: WINDOWS_DEFAULT },
    },
    additionalProperties: false,
  },
  handler: async (args: ToolArgs) => {
    const windowId = argStr(args, "window_id", 128);
    const day = argStr(args, "ist_date", 10);
    if (windowId && (day || argStr(args, "room", 128))) return { ok: false, error: "window_id_or_day_and_room", detail: "pass window_id alone, or ist_date with room" };
    if (windowId) return guarded(() => oneWindow(windowId));
    if (!day) return { ok: false, error: "window_id_or_day_and_room", detail: "pass window_id, or ist_date with room" };
    if (!isRealDate(day)) return { ok: false, error: "invalid_ist_date" };
    if (!argStr(args, "room", 128)) return { ok: false, error: "room_required" };
    const picked = await pickRoom(args);
    if ("error" in picked) return picked.error;
    const limit = argInt(args, "limit", WINDOWS_DEFAULT, 1, LIMIT_MAX);
    const body = await guarded(() => dayWindows(picked.room.id, day, limit));
    return { room: roomRef(picked.room), ...body };
  },
};

export const S1B_TOOLS: McpTool[] = [steward, kiosks, sttWindows];

/**
 * lib/steward/write.ts — S2L (8 Oct 2026): the ONE way the Scribe MCP changes Room Steward config.
 *
 * scribe_steward_command (lib/mcp/tools/s2l.ts) calls runCommand(). Nothing else writes steward_config through the MCP, and this file touches no other
 * steward file (the tick, the rules and the executor are GATING's and are not edited).
 *
 * ONE STATEMENT, ONE TRANSACTION. The Neon HTTP driver has no interactive transaction, so the change is a single data-modifying CTE: it writes the
 * steward_config row AND the steward_config_history row (migration 0136) or neither. The write is COMPARE-AND-SET on the value that was read
 * (`steward_config.value IS NOT DISTINCT FROM <before>`), so two operators racing cannot overwrite each other unseen; a lost race re-reads and retries.
 *
 * KILL SWITCH (steward_config `kill_switch`, seeded ON): turning it ON is always allowed. While it is ON (or its row is missing / malformed — the safe
 * side) every other kind except `note` answers kill_switch_on; turning it OFF is a kill_switch command like any other and needs a reason. The check
 * is in the SQL too, so a switch flipped between the read and the write still stops the change.
 *
 * KEYS THIS FILE DEFINES (documented in docs/operator-mcp/TOOL-NOTES.md; the Steward READING them is GATING's change):
 *   operator_note  { text, room_id|null, actor, at }                       the latest operator note
 *   alert_mutes    { rooms: { "<room_id>"|"*": { until, by, set_at } } }   alerts muted until a time; "*" = every room
 */
import { z } from "zod";
import { nanoid } from "nanoid";
import type { StewardSql } from "./tickets";
import { LIVE_CAPABLE_ACTIONS } from "./config";

export const COMMAND_KINDS = ["set_shadow", "kill_switch", "start_day_live", "add_room", "flag_room", "set_window", "note", "mute_alerts"] as const;
export type CommandKind = (typeof COMMAND_KINDS)[number];

export const REASON_MAX = 280;
export const NOTE_MAX = 500;
export const MUTE_MIN_MINUTES = 5;
export const MUTE_MAX_MINUTES = 720;
/** keys a command may write — the allowlist the SQL is built from */
export const COMMAND_KEYS: Record<CommandKind, string> = {
  set_shadow: "shadow",
  kill_switch: "kill_switch",
  start_day_live: "start_day_live",
  add_room: "rooms",
  flag_room: "rooms",
  set_window: "schedule",
  note: "operator_note",
  mute_alerts: "alert_mutes",
};
const RETRIES = 3;

type Obj = Record<string, unknown>;
const isObj = (x: unknown): x is Obj => typeof x === "object" && x !== null && !Array.isArray(x);
const jsonVal = (v: unknown): unknown => {
  if (typeof v === "string") {
    try { return JSON.parse(v); } catch { return undefined; }
  }
  return v;
};
/** key-order-independent JSON, so "nothing changed" is decided on content */
const stable = (v: unknown): string => JSON.stringify(v, (_k, x) => (isObj(x) ? Object.fromEntries(Object.entries(x).sort(([a], [b]) => (a < b ? -1 : 1))) : x));

// --- validation (the shapes lib/steward/config.ts parseConfig accepts) ----------------------------------------------------------------------
const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;
const FLAG = /^[a-z0-9_-]{1,32}$/;
const ACTION_KEY = /^[A-Za-z0-9_:.-]{1,64}$/;
const flags = z.array(z.string().regex(FLAG)).max(10);

export const Reason = z.string().trim().min(1).max(REASON_MAX);
const V = {
  // `actions` is a PARTIAL update: each key is set to true / false, or to null to clear that one key (G18)
  set_shadow: z.object({ global: z.boolean().optional(), actions: z.record(z.string().regex(ACTION_KEY), z.boolean().nullable()).refine((r) => Object.keys(r).length <= 30).optional() }).strict()
    .refine((v) => v.global !== undefined || v.actions !== undefined, { message: "give global and/or actions" }),
  kill_switch: z.object({ on: z.boolean() }).strict(),
  start_day_live: z.object({ on: z.boolean() }).strict(),
  add_room: z.object({ class: z.enum(["ot", "opd", "clinic"]).optional(), flags: flags.optional(), machine: z.string().trim().min(1).max(64).optional() }).strict(),
  flag_room: z.object({ add: flags.optional(), remove: flags.optional() }).strict().refine((v) => (v.add?.length ?? 0) + (v.remove?.length ?? 0) > 0, { message: "give add and/or remove" }),
  set_window: z.object({
    profile: z.enum(["clinic", "ot"]), start: z.string().regex(HHMM), end: z.string().regex(HHMM), late_stop_max_min: z.number().int().min(1).max(180).optional(),
  }).strict(),
  note: z.string().max(NOTE_MAX),
};

export type Revert = { kind: CommandKind; room?: string; value?: unknown; minutes?: number; exact: boolean; note?: string };
export type PlanInput = { kind: CommandKind; value: unknown; minutes?: number | null; roomId: string | null; nowMs: number; actor: string };
export type Plan =
  | { ok: true; key: string; before: unknown | null; after: unknown; revert: Revert; unchanged: boolean; requireKillOff: boolean }
  | { ok: false; error: string; detail?: string };

const fail = (error: string, detail?: string): Plan => ({ ok: false, error, ...(detail ? { detail: detail.slice(0, 200) } : {}) });
const zodDetail = (e: z.ZodError): string => `${e.issues[0]?.path.join(".") || "value"}: ${e.issues[0]?.message ?? "invalid"}`;

/** Is the kill switch on? A missing or malformed row is ON — the safe side, as parseConfig reads it. */
export function killSwitchOn(raw: unknown): boolean {
  const v = jsonVal(raw);
  return !(isObj(v) && v.on === false);
}

/** PURE: the change a command would make, given the current raw values of the keys it touches (`current[key]`, undefined when the row is absent). */
export function planCommand(input: PlanInput, current: Record<string, unknown>): Plan {
  const { kind } = input;
  const key = COMMAND_KEYS[kind];
  if (!key) return fail("unknown_kind");
  const cur = (k: string): unknown => jsonVal(current[k]);
  const before = current[key] === undefined ? null : (cur(key) ?? null);
  const kill = killSwitchOn(current.kill_switch);
  // kill switch ON blocks everything except turning it (back) on/off and notes
  if (kill && kind !== "kill_switch" && kind !== "note") return fail("kill_switch_on", "turn the kill switch off (kill_switch {on:false}) before changing steward config");
  const requireKillOff = kind !== "kill_switch" && kind !== "note";
  const done = (after: unknown, revert: Revert): Plan => ({ ok: true, key, before, after, revert, unchanged: stable(before) === stable(after), requireKillOff });

  switch (kind) {
    case "kill_switch": {
      const p = V.kill_switch.safeParse(input.value);
      if (!p.success) return fail("bad_value", zodDetail(p.error));
      const wasOn = killSwitchOn(current.kill_switch);
      return done({ on: p.data.on }, { kind: "kill_switch", value: { on: wasOn }, exact: true });
    }
    case "start_day_live": {
      const p = V.start_day_live.safeParse(input.value);
      if (!p.success) return fail("bad_value", zodDetail(p.error));
      const was = isObj(cur(key)) && (cur(key) as Obj).on === true;
      return done({ on: p.data.on }, { kind: "start_day_live", value: { on: was }, exact: true });
    }
    case "set_shadow": {
      const p = V.set_shadow.safeParse(input.value);
      if (!p.success) return fail("bad_value", zodDetail(p.error));
      const c = cur(key);
      const curGlobal = isObj(c) && typeof c.global === "boolean" ? c.global : true; // parseConfig's fallback is shadow ON
      const curActions = isObj(c) && isObj(c.actions) ? (c.actions as Record<string, boolean>) : {};
      // G17: only a published action name may be set — the actions the Steward can ever take out of shadow (LIVE_CAPABLE_ACTIONS). Anything else is always
      // shadow, so a setting for it would be a silent no-op that reads like a control. A key ALREADY in the map may still be cleared with null (clean-up of a legacy key).
      const touched = p.data.actions ?? {};
      const unknown = Object.entries(touched).filter(([k, v]) => !LIVE_CAPABLE_ACTIONS.includes(k) && !(v === null && k in curActions)).map(([k]) => k);
      if (unknown.length > 0) return fail("unknown_action", `not a published steward action: ${unknown.slice(0, 5).join(", ")}; allowed: ${LIVE_CAPABLE_ACTIONS.join(", ")}`);
      const turningOff = p.data.global === false && curGlobal !== false; // global true/absent -> false
      // SF1: going live is explicit PER ACTION. global:false must carry an actions map naming at least one action; every published action it does NOT name is written
      // as held in shadow (true), so nothing goes live implicitly (V's ruling: only scribe_start is ever meant to be live, and changing that is V's decision).
      if (turningOff) {
        if (Object.keys(touched).length === 0) {
          return fail("explicit_actions_required", `global:false takes actions live only by name: give actions {"<action>": false} for each action to go live (the rest are held in shadow); published: ${LIVE_CAPABLE_ACTIONS.join(", ")}`);
        }
        if (Object.values(touched).some((v) => v === null)) return fail("bad_value", "actions: null is not allowed in the call that turns global off; name each action true (held) or false (live)");
      }
      // G18: merge per key; null clears one key (G35: held, not removed, while global is false)
      const actions: Record<string, boolean> = { ...curActions };
      if (turningOff) for (const a of LIVE_CAPABLE_ACTIONS) actions[a] = true; // held unless this call names it false below
      const undo: Record<string, boolean | null> = {};
      const legacyCleared: string[] = [];
      const afterGlobal = p.data.global ?? curGlobal;
      for (const [k, v] of Object.entries(touched)) {
        const published = LIVE_CAPABLE_ACTIONS.includes(k);
        if (!published) legacyCleared.push(k);
        else undo[k] = k in curActions ? curActions[k]! : null; // what the key was before: its value, or null (absent)
        // G35: while global is (or becomes) false an ABSENT published key is LIVE, so null there means "back to held" (true), never "clear". Only an unpublished legacy key,
        // or any key while global stays true (absent = shadow anyway), is really removed.
        if (v === null) {
          if (published && afterGlobal === false) actions[k] = true;
          else delete actions[k];
        } else actions[k] = v;
      }
      const after = { global: afterGlobal, actions };
      let revert: Revert;
      if (turningOff) {
        // undo of the whole transition: global back on, and every published key back to what it was (absent = null)
        const all: Record<string, boolean | null> = {};
        for (const a of LIVE_CAPABLE_ACTIONS) all[a] = a in curActions ? curActions[a]! : null;
        revert = { kind: "set_shadow", value: { global: true, actions: all }, exact: true };
      } else if (curGlobal === false) {
        // the prior state had global OFF: replaying `global:false` needs an actions map, so carry the explicit prior value of every published key (absent = live = false)
        const all: Record<string, boolean | null> = {};
        for (const a of LIVE_CAPABLE_ACTIONS) all[a] = a in curActions ? curActions[a]! : false;
        revert = { kind: "set_shadow", value: { global: false, actions: all }, exact: true };
      } else {
        revert = { kind: "set_shadow", value: { global: curGlobal, ...(Object.keys(undo).length ? { actions: undo } : {}) }, exact: true };
      }
      // SF3: a cleared LEGACY (unpublished) key is not put back by the revert (set_shadow refuses to create unpublished keys), so that revert is not exact
      if (legacyCleared.length > 0) revert = { ...revert, exact: false, note: `cleared legacy key(s) ${legacyCleared.slice(0, 5).join(", ")} are not published steward actions and are not re-created by the revert` };
      return done(after, revert);
    }
    case "add_room": {
      if (!input.roomId) return fail("room_required");
      const p = V.add_room.safeParse(input.value ?? {});
      if (!p.success) return fail("bad_value", zodDetail(p.error));
      const rooms = cur(key);
      if (!isObj(rooms)) return fail("rooms_config_missing", "steward_config.rooms is absent or malformed; the roster has no fallback and is not created here");
      if (input.roomId in rooms) return fail("room_exists", "the room is already in steward_config.rooms; use flag_room");
      const entry: Obj = { flags: p.data.flags ?? [], ...(p.data.class ? { class: p.data.class } : {}), ...(p.data.machine ? { machine: p.data.machine } : {}) };
      // the config has no remove: the closest undo is flagging the room `dev`, which takes it out of the roster
      return done({ ...rooms, [input.roomId]: entry }, { kind: "flag_room", room: input.roomId, value: { add: ["dev"] }, exact: false, note: "no remove kind exists; flagging a room dev takes it out of the roster" });
    }
    case "flag_room": {
      if (!input.roomId) return fail("room_required");
      const p = V.flag_room.safeParse(input.value);
      if (!p.success) return fail("bad_value", zodDetail(p.error));
      const rooms = cur(key);
      if (!isObj(rooms) || !isObj(rooms[input.roomId])) return fail("room_not_in_config", "add the room first (add_room)");
      const entry = rooms[input.roomId] as Obj;
      const had: string[] = Array.isArray(entry.flags) ? entry.flags.filter((f): f is string => typeof f === "string") : [];
      const remove = new Set(p.data.remove ?? []);
      const next = [...new Set([...had.filter((f) => !remove.has(f)), ...(p.data.add ?? [])])];
      if (next.length > 10) return fail("bad_value", "at most 10 flags per room");
      const added = next.filter((f) => !had.includes(f));
      const removed = had.filter((f) => !next.includes(f));
      return done({ ...rooms, [input.roomId]: { ...entry, flags: next } }, { kind: "flag_room", room: input.roomId, value: { add: removed, remove: added }, exact: true });
    }
    case "set_window": {
      const p = V.set_window.safeParse(input.value);
      if (!p.success) return fail("bad_value", zodDetail(p.error));
      const sc = cur(key);
      if (!isObj(sc) || !isObj(sc.clinic) || !isObj(sc.ot)) return fail("schedule_missing", "steward_config.schedule is absent or malformed; it has no fallback and is not created here");
      const old = sc[p.data.profile] as Obj;
      const late = p.data.late_stop_max_min ?? (typeof old.late_stop_max_min === "number" ? old.late_stop_max_min : 30);
      const after = { ...sc, [p.data.profile]: { ...old, start: p.data.start, end: p.data.end, tz: "Asia/Kolkata", late_stop_max_min: late } };
      const oldLate = typeof old.late_stop_max_min === "number" ? old.late_stop_max_min : 30;
      const oldStart = typeof old.start === "string" && HHMM.test(old.start) ? old.start : null;
      const oldEnd = typeof old.end === "string" && HHMM.test(old.end) ? old.end : null;
      if (!oldStart || !oldEnd) return fail("schedule_missing", "the current window for that profile is malformed");
      return done(after, { kind: "set_window", value: { profile: p.data.profile, start: oldStart, end: oldEnd, late_stop_max_min: oldLate }, exact: true });
    }
    case "note": {
      const text = V.note.safeParse(input.value);
      if (!text.success) return fail("bad_value", zodDetail(text.error));
      const prev = cur(key);
      const prevText = isObj(prev) && typeof prev.text === "string" ? prev.text : "";
      const after = { text: text.data.trim(), room_id: input.roomId, actor: input.actor, at: new Date(input.nowMs).toISOString() };
      return done(after, { kind: "note", ...(input.roomId ? { room: input.roomId } : {}), value: prevText, exact: true });
    }
    case "mute_alerts": {
      const minutes = input.minutes;
      if (typeof minutes !== "number" || !Number.isInteger(minutes) || (minutes !== 0 && (minutes < MUTE_MIN_MINUTES || minutes > MUTE_MAX_MINUTES))) {
        return fail("bad_minutes", `minutes is 0 (unmute) or ${MUTE_MIN_MINUTES}..${MUTE_MAX_MINUTES}`);
      }
      const prev = cur(key);
      const rooms: Record<string, Obj> = {};
      // expired mutes are dropped as the object is rewritten
      if (isObj(prev) && isObj(prev.rooms)) {
        for (const [id, m] of Object.entries(prev.rooms)) if (isObj(m) && typeof m.until === "string" && Date.parse(m.until) > input.nowMs) rooms[id] = m;
      }
      const target = input.roomId ?? "*";
      const had = rooms[target];
      const hadMinutes = had && typeof had.until === "string" ? Math.max(0, Math.ceil((Date.parse(had.until) - input.nowMs) / 60_000)) : 0;
      if (minutes === 0) delete rooms[target];
      else rooms[target] = { until: new Date(input.nowMs + minutes * 60_000).toISOString(), by: input.actor, set_at: new Date(input.nowMs).toISOString() };
      const restorable = hadMinutes === 0 || (hadMinutes >= MUTE_MIN_MINUTES && hadMinutes <= MUTE_MAX_MINUTES);
      return done({ rooms }, { kind: "mute_alerts", ...(input.roomId ? { room: input.roomId } : {}), minutes: restorable ? hadMinutes : MUTE_MAX_MINUTES, exact: restorable });
    }
  }
}

/**
 * SF1: what a set_shadow answer must say. `live_actions` = the published actions that WOULD execute under this shadow config (global false and the action not held
 * with true); they still need the kill switch off, and scribe_start also start_day_live. `changed_actions` = published actions whose live/shadow state differs from before.
 */
export function shadowView(before: unknown, after: unknown): { live_actions: string[]; changed_actions: string[] } {
  const live = (v: unknown): string[] => {
    const g = isObj(v) && typeof v.global === "boolean" ? v.global : true;
    const acts = isObj(v) && isObj(v.actions) ? (v.actions as Record<string, unknown>) : {};
    return g ? [] : LIVE_CAPABLE_ACTIONS.filter((a) => acts[a] !== true);
  };
  const was = new Set(live(before));
  const now = live(after);
  const nowSet = new Set(now);
  return { live_actions: now, changed_actions: LIVE_CAPABLE_ACTIONS.filter((a) => was.has(a) !== nowSet.has(a)) };
}

export type CommandResult =
  | { ok: true; kind: CommandKind; key: string; before: unknown | null; after: unknown; revert: Revert; unchanged: boolean; history_id: string | null; live_actions?: string[]; changed_actions?: string[] }
  | { ok: false; error: string; detail?: string };

/**
 * Run one command: read the keys it touches, plan, write config + history in ONE statement (compare-and-set), retrying a lost race up to 3 times.
 * `reason` and `actor` are logged on every change. Never throws for an expected refusal; a database error propagates to the caller.
 */
export async function runCommand(sql: StewardSql, input: PlanInput & { reason: string }): Promise<CommandResult> {
  const reason = Reason.safeParse(input.reason);
  if (!reason.success) return { ok: false, error: "reason_required", detail: `1..${REASON_MAX} characters` };
  const key = COMMAND_KEYS[input.kind];
  if (!key) return { ok: false, error: "unknown_kind" };
  for (let attempt = 1; attempt <= RETRIES; attempt++) {
    const rows = (await sql`SELECT key, value FROM steward_config WHERE key = ANY(${["kill_switch", key]}::text[])`) as Array<{ key: string; value: unknown }>;
    const current: Record<string, unknown> = {};
    for (const r of rows) current[r.key] = r.value;
    const plan = planCommand(input, current);
    if (!plan.ok) return plan;
    const view = input.kind === "set_shadow" ? shadowView(plan.before, plan.after) : {};
    if (plan.unchanged) return { ok: true, kind: input.kind, key: plan.key, before: plan.before, after: plan.after, revert: plan.revert, unchanged: true, history_id: null, ...view };

    const id = `sch_${nanoid(16)}`;
    const beforeJson = plan.before === null ? null : JSON.stringify(plan.before);
    const afterJson = JSON.stringify(plan.after);
    const out = (await sql`
      WITH k AS (SELECT value FROM steward_config WHERE key = 'kill_switch'),
      upd AS (
        INSERT INTO steward_config (key, value, updated_by)
        SELECT ${plan.key}::text, ${afterJson}::jsonb, ${input.actor}::text
         WHERE (NOT ${plan.requireKillOff}::boolean OR EXISTS (SELECT 1 FROM k WHERE k.value->>'on' = 'false'))
        ON CONFLICT (key) DO UPDATE
           SET value = EXCLUDED.value, updated_at = now(), updated_by = EXCLUDED.updated_by
         WHERE steward_config.value IS NOT DISTINCT FROM ${beforeJson}::jsonb
        RETURNING key
      ),
      hist AS (
        INSERT INTO steward_config_history (id, key, kind, room_id, before, after, actor, reason, via)
        SELECT ${id}::text, ${plan.key}::text, ${input.kind}::text, ${input.roomId}::text, ${beforeJson}::jsonb, ${afterJson}::jsonb, ${input.actor}::text, ${reason.data}::text, 'mcp'
          FROM upd
        RETURNING id
      )
      SELECT (SELECT count(*) FROM upd)::int AS applied, (SELECT count(*) FROM hist)::int AS logged
    `) as Array<{ applied: number | string; logged: number | string }>;
    if (Number(out[0]?.applied ?? 0) === 1 && Number(out[0]?.logged ?? 0) === 1) {
      return { ok: true, kind: input.kind, key: plan.key, before: plan.before, after: plan.after, revert: plan.revert, unchanged: false, history_id: id, ...view };
    }
    // nothing was written: the value changed under us, or the kill switch was switched ON between the read and the write. Read again and decide.
  }
  return { ok: false, error: "config_changed_concurrently", detail: "the steward config changed while this command ran; read it again and retry" };
}

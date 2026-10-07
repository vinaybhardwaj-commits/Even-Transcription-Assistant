/**
 * lib/steward/config.ts — Room Steward part 2: the typed config, the room roster and the schedule windows.
 *
 * steward_config (migration 0128) is key/value jsonb, seeded once, one row per knob. loadConfig reads ALL rows in ONE statement; parseConfig turns them into a
 * typed Config. A missing or malformed key falls back to the seed value and is named in `invalid` — except the kill switch, whose fallback is ON (the safe side).
 * The fallback is for caps / timeouts / switches ONLY. `rooms` and `schedule` have NO fallback: if either is missing or malformed (or the read fails) the config is
 * UNAVAILABLE (`fatal`) and the loop skips the tick (a default roster would re-admit dev/test rooms and re-class the OT room; a default schedule would act on the wrong hours).
 *
 * Roster (buildRoster, pure): every Scribe room (the `room` table, not disabled), class from config.rooms[room].class else 'clinic'; excluded when the room's config
 * flags contain 'test' or 'dev'; machine from config.rooms[room].machine else the room's enrolled install hostname (the same room↔machine mapping ext-health uses).
 *
 * Windows (windowAt, pure, IST): clinic 07:30–21:30 same day; ot 06:00–04:00 next day (the window crosses midnight). Start inclusive, end exclusive.
 * days.mode "every_day" with days.closed = ISO dates (IST) on which a window STARTING that day does not run. Only Asia/Kolkata is supported (fixed +05:30).
 */
import type { StewardSql } from "./tickets";

export type RoomClass = "ot" | "opd" | "clinic";
export type ScheduleKind = "clinic" | "ot";

export type Sched = { start: string; end: string; tz: string; late_stop_max_min: number };
export type RoomOverride = { class?: RoomClass; flags: string[]; machine?: string };

export type Config = {
  kill_switch: boolean;
  shadow: { global: boolean; actions: Record<string, boolean> };
  schedule: { clinic: Sched; ot: Sched };
  days: { mode: string; closed: string[] };
  caps: { actions_per_room_per_hour: number; policy_cycle_per_profile_per_day: number; start_retries: number };
  /** steward_config key `start_day_live` {"on": bool}: the LIVE start_day switch. Missing / malformed = false (fail-closed). scribe_start executes only if this is on AND the kill switch is off AND actionMode allows it. */
  start_day_live: boolean;
  priority: RoomClass[];
  rooms: Record<string, RoomOverride>;
  /** per-source read timeout of the sense step (steward_config key `source_timeout_ms`, optional: a number or {ms}); default 6000 */
  source_timeout_ms: number;
};

export const CONFIG_KEYS = ["kill_switch", "shadow", "schedule", "days", "caps", "priority", "rooms"] as const;
/** keys with NO fallback: missing or malformed = config unavailable (the tick is skipped). */
export const FATAL_CONFIG_KEYS = ["rooms", "schedule"] as const;
export const DEFAULT_SOURCE_TIMEOUT_MS = 6000;

/** The seed of migration 0128, minus the seeded rooms (those are data, not defaults). Kill switch ON. */
export const DEFAULT_CONFIG: Config = {
  kill_switch: true,
  shadow: { global: true, actions: {} },
  schedule: {
    clinic: { start: "07:30", end: "21:30", tz: "Asia/Kolkata", late_stop_max_min: 30 },
    ot: { start: "06:00", end: "04:00", tz: "Asia/Kolkata", late_stop_max_min: 30 },
  },
  days: { mode: "every_day", closed: [] },
  caps: { actions_per_room_per_hour: 4, policy_cycle_per_profile_per_day: 1, start_retries: 3 },
  start_day_live: false,
  priority: ["ot", "opd", "clinic"],
  // NOT a fallback: rooms/schedule are FATAL when missing (see FATAL_CONFIG_KEYS). These are placeholders so the type is total.
  rooms: {},
  source_timeout_ms: DEFAULT_SOURCE_TIMEOUT_MS,
};

const isObj = (x: unknown): x is Record<string, unknown> => typeof x === "object" && x !== null && !Array.isArray(x);
const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const posInt = (x: unknown): number | null => (typeof x === "number" && Number.isInteger(x) && x > 0 && x < 100_000 ? x : null);
const jsonVal = (v: unknown): unknown => {
  if (typeof v === "string") {
    try {
      return JSON.parse(v);
    } catch {
      return undefined;
    }
  }
  return v;
};

function parseSched(raw: unknown, dflt: Sched): Sched | null {
  if (!isObj(raw)) return null;
  const { start, end, tz, late_stop_max_min } = raw;
  if (typeof start !== "string" || !HHMM.test(start) || typeof end !== "string" || !HHMM.test(end)) return null;
  if (tz !== undefined && tz !== "Asia/Kolkata") return null;
  const late = late_stop_max_min === undefined ? dflt.late_stop_max_min : posInt(late_stop_max_min);
  if (late === null) return null;
  return { start, end, tz: "Asia/Kolkata", late_stop_max_min: late };
}

/**
 * Typed config from the raw rows. `invalid` names every key that was missing or malformed (its default was used). `fatal` is the subset with no safe default
 * (rooms, schedule): when it is non-empty the caller must not run a tick with this config.
 */
export function parseConfig(rows: ReadonlyArray<{ key: string; value: unknown }>): { config: Config; invalid: string[]; fatal: string[] } {
  const raw = new Map<string, unknown>();
  for (const r of rows) raw.set(r.key, jsonVal(r.value));
  const invalid: string[] = [];
  const cfg: Config = JSON.parse(JSON.stringify(DEFAULT_CONFIG)) as Config;

  const ks = raw.get("kill_switch");
  if (isObj(ks) && typeof ks.on === "boolean") cfg.kill_switch = ks.on;
  else invalid.push("kill_switch");

  const sh = raw.get("shadow");
  if (isObj(sh) && typeof sh.global === "boolean" && (sh.actions === undefined || isObj(sh.actions))) {
    const actions: Record<string, boolean> = {};
    let badAction = false;
    for (const [k, v] of Object.entries((sh.actions as Record<string, unknown>) ?? {})) {
      if (typeof v === "boolean") actions[k] = v;
      else {
        // a malformed per-action value must never lift an action out of shadow by being ignored: it stays SHADOW (true) and is named
        actions[k] = true;
        badAction = true;
      }
    }
    cfg.shadow = { global: sh.global, actions };
    if (badAction) invalid.push("shadow");
  } else invalid.push("shadow");

  const sc = raw.get("schedule");
  const clinic = isObj(sc) ? parseSched(sc.clinic, DEFAULT_CONFIG.schedule.clinic) : null;
  const ot = isObj(sc) ? parseSched(sc.ot, DEFAULT_CONFIG.schedule.ot) : null;
  if (clinic && ot) cfg.schedule = { clinic, ot };
  else invalid.push("schedule");

  const dy = raw.get("days");
  if (isObj(dy) && typeof dy.mode === "string" && Array.isArray(dy.closed) && dy.closed.every((d) => typeof d === "string" && ISO_DATE.test(d))) {
    cfg.days = { mode: dy.mode, closed: dy.closed as string[] };
  } else invalid.push("days");

  const cp = raw.get("caps");
  const a = isObj(cp) ? posInt(cp.actions_per_room_per_hour) : null;
  const b = isObj(cp) ? posInt(cp.policy_cycle_per_profile_per_day) : null;
  const c = isObj(cp) ? posInt(cp.start_retries) : null;
  if (a !== null && b !== null && c !== null) cfg.caps = { actions_per_room_per_hour: a, policy_cycle_per_profile_per_day: b, start_retries: c };
  else invalid.push("caps");

  const pr = raw.get("priority");
  if (isObj(pr) && Array.isArray(pr.order) && pr.order.length > 0 && pr.order.every((x) => x === "ot" || x === "opd" || x === "clinic")) {
    cfg.priority = pr.order as RoomClass[];
  } else invalid.push("priority");

  const rm = raw.get("rooms");
  if (isObj(rm)) {
    const rooms: Record<string, RoomOverride> = {};
    let ok = true;
    for (const [id, v] of Object.entries(rm)) {
      if (!isObj(v)) {
        ok = false;
        continue;
      }
      const flags = Array.isArray(v.flags) ? v.flags.filter((f): f is string => typeof f === "string") : [];
      const o: RoomOverride = { flags };
      if (v.class === "ot" || v.class === "opd" || v.class === "clinic") o.class = v.class;
      else if (v.class !== undefined) ok = false;
      if (typeof v.machine === "string" && v.machine.trim()) o.machine = v.machine.trim();
      rooms[id] = o;
    }
    cfg.rooms = rooms;
    if (!ok) invalid.push("rooms");
  } else invalid.push("rooms");

  // start_day_live: absent = false (NOT invalid: the row is not seeded); present but malformed = false and invalid. Fail-closed either way.
  if (raw.has("start_day_live")) {
    const v = raw.get("start_day_live");
    if (isObj(v) && typeof v.on === "boolean") cfg.start_day_live = v.on;
    else invalid.push("start_day_live");
  }

  // optional: absent = default and NOT invalid; present but malformed = default and invalid
  if (raw.has("source_timeout_ms")) {
    const v = raw.get("source_timeout_ms");
    const ms = typeof v === "number" ? v : isObj(v) ? v.ms : undefined;
    if (typeof ms === "number" && Number.isInteger(ms) && ms >= 500 && ms <= 15_000) cfg.source_timeout_ms = ms;
    else invalid.push("source_timeout_ms");
  }

  const fatal = invalid.filter((k) => (FATAL_CONFIG_KEYS as readonly string[]).includes(k));
  return { config: cfg, invalid, fatal };
}

/** ONE statement: every steward_config row. */
export async function loadConfig(sql: StewardSql): Promise<{ config: Config; invalid: string[]; fatal: string[] }> {
  const rows = (await sql`SELECT key, value FROM steward_config`) as Array<{ key: string; value: unknown }>;
  return parseConfig(rows);
}

// ---------------------------------------------------------------------------
// Action mode (kill switch + shadow)
// ---------------------------------------------------------------------------

/** The actions that may EVER leave shadow (one per executor method the live executor implements or will implement). Anything else is always shadow. */
export const LIVE_CAPABLE_ACTIONS: readonly string[] = [
  "scribe_start",
  "ticket:wake",
  "ticket:open_pulse",
  "ticket:relaunch_chrome",
  "ticket:policy_cycle",
  "ticket:restart_recorder_app",
  "ticket:restart_kiosk_health",
  "message",
];

export type ActionMode = "kill_switch" | "shadow" | "live";

/**
 * How ONE action is executed under this config. An action executes ONLY if kill_switch.on = false AND shadow.global = false AND shadow.actions[action] !== true AND the
 * action is a known live-capable name, and (scribe_start only) start_day_live.on is true. Everything else records the decision and executes nothing: "kill_switch" when the switch is on, "shadow" otherwise.
 * (Before this rule a per-action `false` overrode `global: true`; now global true shadows every action, and a per-action `true` is the only way to hold one back.)
 */
export function actionMode(cfg: Config, action: string): ActionMode {
  if (cfg.kill_switch) return "kill_switch";
  if (cfg.shadow.global) return "shadow";
  if (!LIVE_CAPABLE_ACTIONS.includes(action)) return "shadow";
  if (cfg.shadow.actions[action] === true) return "shadow";
  // the live start has its own switch: steward_config start_day_live {"on":true} (fail-closed)
  if (action === "scribe_start" && !cfg.start_day_live) return "shadow";
  return "live";
}

// ---------------------------------------------------------------------------
// Roster
// ---------------------------------------------------------------------------

/** "EHRC-CONSUL2’s Mac mini (2)" -> "EHRC-CONSUL2s-Mac-mini-2" (same rule as lib/encounter-windows/types.ts normalizeHostname; copied so this module has no imports). */
export const normalizeMachine = (h: string): string => h.replace(/’/g, "").replace(/'/g, "").replace(/\s*\((\d+)\)/, "-$1").replace(/\s+/g, "-");

export type RosterRow = { room_id: string; room_name: string; hostname: string | null; state_flags?: unknown; device_name?: string | null };
export type RosterRoom = { room_id: string; room_name: string; machine: string | null; klass: RoomClass; flags: string[]; kind: ScheduleKind; state_flags: unknown; /** room_install.expected_device_name: the input device the room should be on */ device_name: string | null };

export const EXCLUDED_FLAGS: readonly string[] = ["test", "dev"];
/** rooms whose id starts with this are dev/test scratch rooms (lib/brain/scratch.ts SCRATCH_ROOM_PREFIX, copied: this module has no imports) and never join the roster. */
export const SCRATCH_ROOM_PREFIX = "room_scratch_";
/** hard list (ORB3, Home Office): never in the roster whatever steward_config.rooms says (dev rigs; a live start there is never wanted) */
export const NEVER_ROSTER_ROOM_IDS: readonly string[] = ["room_jwyrr4dc", "room_2qe955hy"];

/** Every non-excluded room, in processing order (config.priority, then name). */
export function buildRoster(rows: readonly RosterRow[], cfg: Config): RosterRoom[] {
  const out: RosterRoom[] = [];
  for (const r of rows) {
    if (r.room_id.startsWith(SCRATCH_ROOM_PREFIX) || NEVER_ROSTER_ROOM_IDS.includes(r.room_id)) continue;
    const o = cfg.rooms[r.room_id];
    const flags = o?.flags ?? [];
    if (flags.some((f) => EXCLUDED_FLAGS.includes(f.toLowerCase()))) continue;
    const klass: RoomClass = o?.class ?? "clinic";
    const machine = o?.machine ?? (r.hostname ? normalizeMachine(r.hostname) : null);
    out.push({ room_id: r.room_id, room_name: r.room_name, machine, klass, flags, kind: klass === "ot" ? "ot" : "clinic", state_flags: r.state_flags ?? null, device_name: r.device_name ?? null });
  }
  const rank = (k: RoomClass): number => {
    const i = cfg.priority.indexOf(k);
    return i < 0 ? cfg.priority.length : i;
  };
  return out.sort((a, b) => rank(a.klass) - rank(b.klass) || a.room_name.localeCompare(b.room_name) || a.room_id.localeCompare(b.room_id));
}

// ---------------------------------------------------------------------------
// Windows (IST)
// ---------------------------------------------------------------------------

export const IST_OFFSET_MS = 19_800_000;
const DAY_MS = 86_400_000;
const minutesOf = (hhmm: string): number => Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3, 5));

/** IST calendar date (YYYY-MM-DD) of an instant. */
export function istDateOf(ms: number): string {
  return new Date(ms + IST_OFFSET_MS).toISOString().slice(0, 10);
}
export const istMidnightOf = (ms: number): number => Math.floor((ms + IST_OFFSET_MS) / DAY_MS) * DAY_MS - IST_OFFSET_MS;

export type WindowState = {
  kind: ScheduleKind;
  in_window: boolean;
  /** the window that contains asOf (null when outside) */
  start_ms: number | null;
  end_ms: number | null;
  /** today's IST date is in days.closed */
  closed_day: boolean;
  /** end of the most recent non-closed window at or before asOf, and how long ago (null when none within 3 days) */
  last_end_ms: number | null;
  since_end_ms: number | null;
};

export function windowAt(cfg: Config, kind: ScheduleKind, asOfMs: number): WindowState {
  const s = cfg.schedule[kind];
  const startMin = minutesOf(s.start);
  const endMin = minutesOf(s.end);
  const todayMid = istMidnightOf(asOfMs);
  const closed = new Set(cfg.days.closed);
  let inStart: number | null = null;
  let inEnd: number | null = null;
  let lastEnd: number | null = null;
  for (let back = 0; back <= 3; back++) {
    const mid = todayMid - back * DAY_MS;
    if (closed.has(istDateOf(mid + 12 * 3_600_000))) continue;
    const start = mid + startMin * 60_000;
    const end = mid + endMin * 60_000 + (endMin <= startMin ? DAY_MS : 0);
    if (start <= asOfMs && asOfMs < end) {
      inStart = start;
      inEnd = end;
    }
    if (end <= asOfMs && (lastEnd === null || end > lastEnd)) lastEnd = end;
  }
  return {
    kind,
    in_window: inStart !== null,
    start_ms: inStart,
    end_ms: inEnd,
    closed_day: closed.has(istDateOf(asOfMs)),
    last_end_ms: lastEnd,
    since_end_ms: lastEnd === null ? null : asOfMs - lastEnd,
  };
}

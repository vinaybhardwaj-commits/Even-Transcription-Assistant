/**
 * lib/rooms-live/roster.ts — which rooms the screen shows (v1.1 F29). The default is the eight OPD rooms of rooms.ts, in that order, with those labels.
 * A room list can change without a deploy: steward_config key `rooms_live_rooms` (READ only here; GATING owns the write), value = a JSON array of room ids, or { "ids": [...] }.
 * The key is optional. Absent, malformed or unreadable -> the default eight. Whatever the list says, a room must exist in the `room` table with disabled_at IS NULL, and the
 * hard exclusions never join: Audiometry (testbed), ORB2, ORB3, Home Office, every room_scratch_* room. A room outside the default eight is labelled with room.name.
 * The result is memoised for 60 s per instance. Every failure falls back to the default eight: the screen never loses its rooms to a config read.
 */
import { ROOMS, type RoomDef } from "./rooms";
import type { Db } from "./read";

export const ROSTER_KEY = "rooms_live_rooms";
export const ROSTER_MEMO_MS = 60_000;
export const ROSTER_MAX = 40;
/** Audiometry (room_d74hhmc4, a testbed), ORB2 (room_mah3aspr), ORB3 (room_jwyrr4dc), Home Office (room_2qe955hy) */
export const NEVER_SHOWN: readonly string[] = ["room_d74hhmc4", "room_mah3aspr", "room_jwyrr4dc", "room_2qe955hy"];
const SCRATCH_PREFIX = "room_scratch_";
const DEFAULT_LABEL = new Map(ROOMS.map((r) => [r.room_id, r.label]));

/** the ids a steward_config value names, de-duplicated and bounded; null when the value is not a usable list */
export function parseRosterIds(raw: unknown): string[] | null {
  let v: unknown = raw;
  if (typeof v === "string") {
    try {
      v = JSON.parse(v);
    } catch {
      return null;
    }
  }
  if (v && typeof v === "object" && !Array.isArray(v)) v = (v as { ids?: unknown }).ids;
  if (!Array.isArray(v)) return null;
  const ids = v.filter((x): x is string => typeof x === "string" && /^room_[a-z0-9_]{1,40}$/.test(x) && !NEVER_SHOWN.includes(x) && !x.startsWith(SCRATCH_PREFIX));
  const uniq = [...new Set(ids)].slice(0, ROSTER_MAX);
  return uniq.length > 0 ? uniq : null;
}

export async function readRoster(db: Db): Promise<RoomDef[]> {
  let wanted: string[] = ROOMS.map((r) => r.room_id);
  try {
    const cfg = (await db`
      SELECT value FROM steward_config WHERE key = ${ROSTER_KEY} LIMIT 1
    `) as Array<Record<string, unknown>>;
    wanted = (cfg.length > 0 ? parseRosterIds(cfg[0]!.value) : null) ?? wanted;
  } catch {
    /* no key or no read: the default eight */
  }
  try {
    const rows = (await db`
      SELECT id AS room_id, name FROM room WHERE id = ANY(${wanted}::text[]) AND disabled_at IS NULL LIMIT 60
    `) as Array<Record<string, unknown>>;
    const nameOf = new Map(rows.map((r) => [String(r.room_id), typeof r.name === "string" ? r.name.trim().slice(0, 40) : ""]));
    const out: RoomDef[] = [];
    for (const id of wanted) {
      if (!nameOf.has(id)) continue;
      out.push({ room_id: id, label: DEFAULT_LABEL.get(id) ?? (nameOf.get(id) || id), order: out.length + 1 });
    }
    return out.length > 0 ? out : [...ROOMS];
  } catch {
    return [...ROOMS];
  }
}

let memo: { at: number; p: Promise<RoomDef[]> } | null = null;
export const resetRosterForTests = (): void => {
  memo = null;
};

export async function loadRoster(db: Db, now: number = Date.now()): Promise<RoomDef[]> {
  if (memo && now - memo.at < ROSTER_MEMO_MS && now >= memo.at) return memo.p;
  const p = readRoster(db);
  memo = { at: now, p };
  return p;
}

export async function isRosterRoom(db: Db, roomId: string): Promise<boolean> {
  return (await loadRoster(db)).some((r) => r.room_id === roomId);
}

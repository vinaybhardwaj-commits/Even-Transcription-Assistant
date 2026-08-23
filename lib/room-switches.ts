/**
 * lib/room-switches.ts — the two processing switches, read from the room.
 *
 * REPLACES lib/stt/room-drain-flag.ts and lib/brain/fuse/live-flag.ts, both deleted. The
 * environment variables ROOM_STT_DRAIN_ENABLED and FUSE_LIVE_ENABLED are GONE FROM THE CODE, not
 * ignored (PRD R1). A dead variable that still changes behaviour is how a stale RERANK_BACKEND
 * routed production wrongly for seven days; leaving the reads in place "just in case" is the
 * failure mode, not the safety net.
 *
 * WHY THIS MOVED. Vercel bakes environment variables into a build, so turning processing off
 * during a clinic required a redeploy. The only instant switch was room.disabled_at, which stops
 * the room entirely including its recording. That is a hammer. These are dials, and they live
 * where room.disabled_at lives: on the row.
 *
 * ── THE CACHE, AND WHY IT IS ONE NUMBER ─────────────────────────────────────────────────────
 *
 * These are read on hot paths — every chunk's window evaluation, every cue post, every drain
 * pass — so an uncached read would put an app-database round trip in front of each one, and one
 * of those call sites is inside the room_day advisory lock.
 *
 * So there is a cache, and it is bounded to ROOM_SWITCH_CACHE_MS. The PRD promises a change
 * takes effect "within seconds" (R3), and that promise is worth exactly one number in one place
 * rather than an assumption distributed across five call sites. If somebody needs the window
 * shorter, they change this constant and nothing else. The acceptance row that times a switch
 * (B3) times it against THIS value.
 *
 * NOT a module-scope snapshot of the VALUE — that is the thing the environment variables did
 * wrong. Every call goes through the cache; the cache expires; the row is authoritative.
 *
 * FAIL CLOSED. A failed read returns false for both lanes: if we cannot tell whether a room is
 * allowed to write to its own permanent record, the answer is that it is not. It also does not
 * poison the cache, so the next call retries rather than inheriting a guess for five seconds.
 */

import { sql } from "@/lib/db";

/**
 * How long a room's switch positions may be reused before the row is read again.
 *
 * FIVE SECONDS, and it is the ceiling the PRD sets. It is here, exported and named, so that
 * "takes effect within seconds" is a measurable claim rather than a hopeful one.
 */
export const ROOM_SWITCH_CACHE_MS = 5_000;

export type RoomSwitches = {
  /** Turn this room's audio into words. Was ROOM_STT_DRAIN_ENABLED. */
  transcript_enabled: boolean;
  /** Build this room's record of who was seen. Was FUSE_LIVE_ENABLED. */
  visits_enabled: boolean;
};

export const SWITCHES_OFF: RoomSwitches = { transcript_enabled: false, visits_enabled: false };

type Entry = { value: RoomSwitches; readAt: number };
const cache = new Map<string, Entry>();

/** Drop a room's cached position. Called by the writer so an operator's own tap is instant. */
export function invalidateRoomSwitches(roomId?: string): void {
  if (roomId) cache.delete(roomId);
  else cache.clear();
}

/** Test seam only — the cache outlives a module, which is the point of it. */
export function __resetRoomSwitchCache(): void {
  cache.clear();
}

/**
 * The room's two switch positions, cached for at most ROOM_SWITCH_CACHE_MS.
 *
 * `room` is an app table and is read through the app handle, the same split every other reader
 * in this codebase observes (lib/admin/rooms-live.ts says so out loud). brain_svc has SELECT on
 * it and no UPDATE, deliberately — nothing on the brain side writes these.
 */
export async function readRoomSwitches(roomId: string, now = Date.now()): Promise<RoomSwitches> {
  if (!roomId) return SWITCHES_OFF;
  const hit = cache.get(roomId);
  if (hit && now - hit.readAt < ROOM_SWITCH_CACHE_MS) return hit.value;
  try {
    const rows = (await sql`
      SELECT transcript_enabled, visits_enabled FROM room WHERE id = ${roomId} LIMIT 1
    `) as Array<{ transcript_enabled: boolean; visits_enabled: boolean }>;
    const row = rows[0];
    const value: RoomSwitches = row
      ? { transcript_enabled: Boolean(row.transcript_enabled), visits_enabled: Boolean(row.visits_enabled) }
      // An unknown room is off. It is not an error worth throwing on a recording path.
      : SWITCHES_OFF;
    cache.set(roomId, { value, readAt: now });
    return value;
  } catch (e) {
    // Fail closed and DO NOT CACHE. A database blip must not hold a room off — or on — for five
    // seconds on the strength of one failed query.
    console.warn(`[room-switches] read failed room=${roomId}: ${String((e as Error)?.message ?? e).slice(0, 150)}`);
    return SWITCHES_OFF;
  }
}

/** Is this room turning its audio into words? (Was isRoomDrainEnabled.) */
export async function isTranscriptEnabled(roomId: string): Promise<boolean> {
  return (await readRoomSwitches(roomId)).transcript_enabled;
}

/** Is this room building its record of who was seen? (Was isFuseLiveEnabled.) */
export async function isVisitsEnabled(roomId: string): Promise<boolean> {
  return (await readRoomSwitches(roomId)).visits_enabled;
}

// ---------------------------------------------------------------------------
// The lane vocabulary — plain words, in one place
// ---------------------------------------------------------------------------

/**
 * R4: the interface never says drain, fuse, window or subject. Those are our words. These are
 * the operator's, and they are defined here so the screen, the audit rows and the API cannot
 * drift into three different vocabularies.
 */
export const LANES = ["transcript", "visits"] as const;
export type Lane = (typeof LANES)[number];

/** The column each lane writes. The only mapping from operator word to storage. */
export const LANE_COLUMN: Record<Lane, keyof RoomSwitches> = {
  transcript: "transcript_enabled",
  visits: "visits_enabled",
};

/** What a person calls it, for the confirmation copy and the audit row. */
export const LANE_LABEL: Record<Lane, string> = {
  transcript: "Transcript",
  visits: "Visits",
};

export const isLane = (v: unknown): v is Lane => typeof v === "string" && (LANES as readonly string[]).includes(v);

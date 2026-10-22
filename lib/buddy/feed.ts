/**
 * lib/buddy/feed.ts — Buddy server-side feed (Part E). Called at the END of the bench chunk route's after() block.
 *
 * For one verified piece it asks, in ONE query, whether the piece overlaps a SHADOW consult in a gated room, and if so
 * posts {opaque_id, piece_idx, started_at, ended_at, url} to newcat's internal route, where `url` is a presigned R2 GET
 * for that one object (expiry <= PRESIGN_MAX_S).
 *
 * OFF unless BUDDY_FEED === "on" AND BUDDY_FEED_URL is set: then there is no read, no post and no work.
 * ROOMS. The room must be in BUDDY_RELAY_ROOMS (parsed by relayRooms, as the relay does).
 * SHADOW. buddy_consult_ref records no decision; the relay stores it in the consult_started bench_command args
 * ({opaque_id, window, live}). A shadow session is live = true with window = false. Joined on args->>'opaque_id'.
 * OVERLAP. The ref is open, or closed at most CLOSE_GRACE_MIN before the piece's started_at; and it opened at most OPEN_MAX_MIN before it (a lost close never feeds for the rest of the day).
 * AUTH. Bearer NEWCAT_RELAY_KEY, as lib/buddy/relay.ts reads it.
 *
 * NEVER AFFECTS THE CHUNK. buddyFeed never throws. Logs carry counts and reason codes only: no URL (it holds a signature),
 * no opaque_id, no consult_uid, no key.
 */
import { sql } from "@/lib/db";
import { signGetUrl } from "@/lib/r2";
import { relayRooms } from "@/lib/buddy/relay";

export const PRESIGN_MAX_S = 900;
export const POST_TIMEOUT_MS = 5000;
export const RETRY_DELAY_MS = 1000;
export const CLOSE_GRACE_MIN = 10;
/** Refute S1: a ref whose close was never relayed stops feeding once it opened more than this long before the piece (the cutter caps a consult at 90 min too). */
export const OPEN_MAX_MIN = 90;

export type FeedPiece = { roomId: string; idx: number; r2Key: string; startedAt: Date; endedAt: Date };

export type FeedDeps = {
  query: (roomId: string, startedAtIso: string, endedAtIso: string) => Promise<Array<{ opaque_id: string }>>;
  presign: (key: string, expiresInSeconds: number) => Promise<string>;
  fetchFn: typeof fetch;
  sleep: (ms: number) => Promise<void>;
  env: NodeJS.ProcessEnv;
};

/** Counts only. buddy_feed_skipped_<reason> keys appear as they occur. */
export const feedCounters: Record<string, number> = { buddy_feed_posted: 0, buddy_feed_failed: 0 };
function bump(name: string): void {
  feedCounters[name] = (feedCounters[name] ?? 0) + 1;
}

const defaultDeps: FeedDeps = {
  query: async (roomId, startedAtIso, endedAtIso) =>
    (await sql`
      SELECT r.opaque_id
        FROM buddy_consult_ref r
        JOIN bench_command c
          ON c.kind = 'consult_started' AND c.source = 'buddy' AND c.room_id = r.room_id AND c.args->>'opaque_id' = r.opaque_id
       WHERE r.room_id = ${roomId}
         AND c.args->>'live' = 'true' AND c.args->>'window' = 'false'
         AND r.opened_at <= ${endedAtIso}::timestamptz
         AND (r.closed_at IS NULL OR r.closed_at >= ${startedAtIso}::timestamptz - make_interval(mins => ${CLOSE_GRACE_MIN}))
         AND r.opened_at >= ${startedAtIso}::timestamptz - make_interval(mins => ${OPEN_MAX_MIN})
       ORDER BY r.opened_at DESC
       LIMIT 1
    `) as Array<{ opaque_id: string }>,
  presign: (key, expiresInSeconds) => signGetUrl({ key, expiresInSeconds }),
  fetchFn: (...a) => fetch(...a),
  sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
  env: process.env,
};

async function postOnce(deps: FeedDeps, target: string, key: string, body: string): Promise<boolean> {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), POST_TIMEOUT_MS);
  try {
    const res = await deps.fetchFn(target, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
      body,
      signal: ctl.signal,
    });
    return !!res && res.ok;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

/** Never throws. Returns the outcome code (for tests); the route ignores it. */
export async function buddyFeed(piece: FeedPiece, overrides: Partial<FeedDeps> = {}): Promise<string> {
  const deps: FeedDeps = { ...defaultDeps, ...overrides };
  try {
    if (deps.env.BUDDY_FEED !== "on") return "off";
    const target = (deps.env.BUDDY_FEED_URL ?? "").trim();
    const key = (deps.env.NEWCAT_RELAY_KEY ?? "").trim();
    if (!target || !key) {
      bump("buddy_feed_skipped_not_configured");
      return "not_configured";
    }
    const gate = (deps.env === process.env ? relayRooms() : (deps.env.BUDDY_RELAY_ROOMS ?? "").split(",").map((s) => s.trim()).filter(Boolean));
    if (!gate.includes(piece.roomId)) {
      bump("buddy_feed_skipped_room");
      return "room";
    }
    const rows = await deps.query(piece.roomId, piece.startedAt.toISOString(), piece.endedAt.toISOString());
    const opaqueId = rows[0]?.opaque_id;
    if (!opaqueId) {
      bump("buddy_feed_skipped_no_shadow_consult");
      return "no_shadow_consult";
    }
    const url = await deps.presign(piece.r2Key, PRESIGN_MAX_S);
    const body = JSON.stringify({
      opaque_id: opaqueId,
      piece_idx: piece.idx,
      started_at: piece.startedAt.toISOString(),
      ended_at: piece.endedAt.toISOString(),
      url,
    });
    let ok = await postOnce(deps, target, key, body);
    if (!ok) {
      await deps.sleep(RETRY_DELAY_MS);
      ok = await postOnce(deps, target, key, body);
    }
    if (ok) {
      bump("buddy_feed_posted");
      console.log("[buddy-feed] posted=1");
      return "posted";
    }
    bump("buddy_feed_failed");
    console.warn("[buddy-feed] failed=1");
    return "failed";
  } catch {
    bump("buddy_feed_failed");
    console.warn("[buddy-feed] failed=1 reason=exception");
    return "failed";
  }
}

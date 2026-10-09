/**
 * /api/admin/bench/drain — run and inspect the room STT drain (K4b).
 *
 * GET  ?session_id=bs_…   every window of a session with its drain state, job row and run.
 * POST { window_id }      drain exactly that window.
 * POST { session_id, limit } drain up to `limit` QUEUED windows of that session, oldest first.
 *
 * MANUAL ONLY. Nothing schedules this: there is no cron, and the chunk route enqueues but never
 * drains. A build that spends money on a paid engine does not get a background loop two days
 * before a live OPD day — the operator asks for each pass, and the answer says what it cost.
 *
 * The switch still decides. This route cannot drain a room whose Transcript switch is off;
 * the guard is inside drainRoomWindow, not here, so no future caller can route around it.
 */
import { NextRequest } from "next/server";
import { sql } from "@/lib/db";
import { adminDrainRows } from "@/lib/room-access/tool-reads";
import { readAdminCookie } from "@/lib/cookie";
import { verifyAdminJwt } from "@/lib/auth";
import { respondOk, respondError } from "@/lib/respond";
import { drainRoomWindow, drainQueuedRoomWindows } from "@/lib/stt/room-drain";
import { isUsableActor } from "@/lib/stt/receipt";
import { readRoomSwitches, ROOM_SWITCH_CACHE_MS } from "@/lib/room-switches";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

async function guard(): Promise<string | null> {
  const cookie = await readAdminCookie();
  if (!cookie) return null;
  try {
    const c = await verifyAdminJwt(cookie);
    return String(c.admin_id ?? "");
  } catch {
    return null;
  }
}

export async function GET(req: NextRequest) {
  if ((await guard()) === null) return respondError("AUTH_REQUIRED", "Sign in required");
  const sp = new URL(req.url).searchParams;
  const sessionId = sp.get("session_id") ?? "";
  if (!sessionId.startsWith("bs_")) return respondError("VALIDATION_FAILED", "session_id_required");

  const got = await adminDrainRows(sessionId);
  if ("error" in got) return respondError("FORBIDDEN", got.error);
  const rows = got.rows;
  const roomId = got.roomId;

  return respondOk({
    session_id: sessionId,
    room_id: roomId,
    // Evidence: what this process reads for this room RIGHT NOW, from the room row. The old
    // shape reported an environment variable's parse; there is no environment variable any
    // more, so it reports the switches and the window inside which a change becomes visible.
    switches: roomId
      ? { ...(await readRoomSwitches(roomId)), source: "room_row", cache_ms: ROOM_SWITCH_CACHE_MS }
      : { transcript_enabled: false, visits_enabled: false, source: "room_row", cache_ms: ROOM_SWITCH_CACHE_MS },
    windows: rows.map((r) => ({
      ...r,
      start_at: new Date(Number(r.start_ms)).toISOString(),
      end_at: new Date(Number(r.end_ms)).toISOString(),
    })),
  });
}

export async function POST(req: NextRequest) {
  const adminId = await guard();
  if (adminId === null) return respondError("AUTH_REQUIRED", "Sign in required");
  // Build 2 §B — `adminId` was already bound here and then never used (grounding §3). It is the
  // initiator now, and an empty one is refused rather than defaulted.
  if (!isUsableActor(adminId)) return respondError("AUTH_REQUIRED", "admin_id_missing_from_token");
  const actor = { actor: adminId, via: "admin_route" as const };
  let body: { window_id?: unknown; session_id?: unknown; limit?: unknown; force?: unknown };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return respondError("VALIDATION_FAILED", "body_not_json");
  }
  const origin = new URL(req.url).origin;

  if (typeof body.window_id === "string" && body.window_id.startsWith("bw_")) {
    const out = await drainRoomWindow(body.window_id, origin, { force: body.force === true, ...actor });
    return respondOk({ drained: [out] });
  }

  const limit = typeof body.limit === "number" && Number.isFinite(body.limit) ? Math.floor(body.limit) : 1;
  const out = await drainQueuedRoomWindows(origin, limit, actor);
  return respondOk({ drained: out });
}

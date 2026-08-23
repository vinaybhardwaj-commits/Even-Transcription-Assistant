/**
 * /api/admin/bench/processing — the two room processing switches.
 *
 * PATCH { room_id, lane: "transcript"|"visits", enabled: boolean }   one lane on one room
 * POST  { action: "stop_all" }                                       every lane, every room, off
 *
 * WHAT THIS REPLACES. Both lanes used to be environment variables that Vercel bakes into a
 * build, so turning processing off during a clinic meant a redeploy. This route writes a column
 * on the room, and the readers pick it up within ROOM_SWITCH_CACHE_MS. That is the entire point
 * of the build (PRD R3, acceptance B3).
 *
 * WHAT IT DOES NOT TOUCH: recording. Not the tape, not a chunk, not a kiosk, not bench_session,
 * not room.disabled_at. "Stop all processing" turns two booleans off and nothing else — which is
 * exactly what makes it safe to press under pressure (R9), and why the button says so.
 *
 * AUDIT (R12). Every change writes one audit_log row naming the room, the lane, the new value
 * and the actor. Stop-all writes ONE ROW PER ROOM, not one row for the gesture, so a later
 * reader of a single room's history sees what happened to that room.
 *
 * ADMIN COOKIE ONLY, like every other write on this page. The actor is the admin id from the
 * cookie, never a string the client supplied.
 */
import { NextRequest } from "next/server";
import { sql } from "@/lib/db";
import { readAdminCookie } from "@/lib/cookie";
import { verifyAdminJwt } from "@/lib/auth";
import { respondOk, respondError } from "@/lib/respond";
import { invalidateRoomSwitches, isLane, LANE_COLUMN, LANE_LABEL, ROOM_SWITCH_CACHE_MS, type Lane } from "@/lib/room-switches";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

async function actor(): Promise<string | null> {
  const cookie = await readAdminCookie();
  if (!cookie) return null;
  try {
    const c = await verifyAdminJwt(cookie);
    return String(c.admin_id ?? "admin");
  } catch {
    return null;
  }
}

/** One audit row per room per lane. Best-effort AFTER the write it describes, never before it. */
async function audit(adminId: string, roomId: string, lane: Lane, enabled: boolean, how: string): Promise<void> {
  try {
    await sql`
      INSERT INTO audit_log (actor_type, actor_id, action, target_type, target_id, metadata_json)
      VALUES ('admin', ${adminId}, ${`room_processing_${enabled ? "on" : "off"}`}, 'room', ${roomId},
              ${JSON.stringify({ lane, label: LANE_LABEL[lane], column: LANE_COLUMN[lane], enabled, via: how })}::jsonb)
    `;
  } catch (e) {
    console.warn(`[processing] audit write failed room=${roomId} lane=${lane}: ${String((e as Error)?.message ?? e).slice(0, 150)}`);
  }
}

export async function PATCH(req: NextRequest) {
  const adminId = await actor();
  if (!adminId) return respondError("AUTH_REQUIRED", "Sign in required");

  let body: { room_id?: unknown; lane?: unknown; enabled?: unknown };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return respondError("VALIDATION_FAILED", "body_not_json");
  }
  const roomId = typeof body.room_id === "string" ? body.room_id : "";
  const lane = body.lane;
  const enabled = body.enabled;
  if (!roomId.startsWith("room_")) return respondError("VALIDATION_FAILED", "bad_room_id");
  if (!isLane(lane)) return respondError("VALIDATION_FAILED", "bad_lane");
  if (typeof enabled !== "boolean") return respondError("VALIDATION_FAILED", "enabled_must_be_boolean");

  // RETURNING the stored row, so the answer is what the database now holds rather than what the
  // caller asked for. The screen corrects its own switch from this (PRD §6, acceptance U7) — a
  // switch that lies about a clinical system is worse than a slow one.
  let rows: Array<{ transcript_enabled: boolean; visits_enabled: boolean }>;
  try {
    rows = (lane === "transcript"
      ? await sql`UPDATE room SET transcript_enabled = ${enabled} WHERE id = ${roomId} RETURNING transcript_enabled, visits_enabled`
      : await sql`UPDATE room SET visits_enabled = ${enabled} WHERE id = ${roomId} RETURNING transcript_enabled, visits_enabled`
    ) as Array<{ transcript_enabled: boolean; visits_enabled: boolean }>;
  } catch (e) {
    return respondError("UPSTREAM_UNAVAILABLE", String((e as Error)?.message ?? e).slice(0, 150));
  }
  if (!rows[0]) return respondError("NOT_FOUND", "room_not_found");

  // The operator's own tap should not wait out the cache in the process that served it.
  invalidateRoomSwitches(roomId);
  await audit(adminId, roomId, lane, enabled, "switch");

  return respondOk({
    room_id: roomId,
    transcript_enabled: Boolean(rows[0].transcript_enabled),
    visits_enabled: Boolean(rows[0].visits_enabled),
    /** How long any OTHER process may still be using the previous value. */
    takes_effect_within_ms: ROOM_SWITCH_CACHE_MS,
  });
}

export async function POST(req: NextRequest) {
  const adminId = await actor();
  if (!adminId) return respondError("AUTH_REQUIRED", "Sign in required");

  let body: { action?: unknown };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return respondError("VALIDATION_FAILED", "body_not_json");
  }
  if (body.action !== "stop_all") return respondError("VALIDATION_FAILED", "unknown_action");

  // ONE STATEMENT, so it is one transaction (PRD S1). Every room, both lanes, off.
  //
  // NOTHING HERE TOUCHES RECORDING. There is no bench_session in this statement, no chunk, no
  // command to a kiosk, and room.disabled_at is not named. A tape that is rolling keeps rolling
  // (acceptance S2) — which is the fact the button's own copy states, because that is what makes
  // it pressable by somebody who is frightened.
  //
  // RETURNING only the rows that actually changed, so the audit trail records changes rather
  // than a sweep over rooms that were already off.
  let changed: Array<{ id: string; was_transcript: boolean; was_visits: boolean }>;
  try {
    changed = (await sql`
      UPDATE room
         SET transcript_enabled = FALSE, visits_enabled = FALSE
       WHERE transcript_enabled OR visits_enabled
      RETURNING id, TRUE AS was_transcript, TRUE AS was_visits
    `) as Array<{ id: string; was_transcript: boolean; was_visits: boolean }>;
  } catch (e) {
    return respondError("UPSTREAM_UNAVAILABLE", String((e as Error)?.message ?? e).slice(0, 150));
  }

  invalidateRoomSwitches();
  for (const r of changed) {
    await audit(adminId, r.id, "transcript", false, "stop_all");
    await audit(adminId, r.id, "visits", false, "stop_all");
  }

  return respondOk({
    stopped: changed.length,
    rooms: changed.map((r) => r.id),
    takes_effect_within_ms: ROOM_SWITCH_CACHE_MS,
    recording_untouched: true,
  });
}

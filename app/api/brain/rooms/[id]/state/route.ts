/**
 * GET /api/brain/rooms/:id/state[?ist_date=YYYY-MM-DD] — read the room's picture (PRD §11;
 * Kickoff A2, decision B10). Ported from brain/src/server.ts handleGetState. Read-only, never
 * creates a room_day. Semantics identical to the Kickoff A build:
 *   Bearer BRAIN_SERVICE_TOKEN → 401 unauthorized / 503 service_token_not_configured
 *   400 invalid_room_id | invalid_ist_date · 404 unknown_room
 *   200 { ok:true, state:{ room_id, room_day_id (null when no day yet), ist_date, visits,
 *                          active_visit_id, clusters, confidence:null, as_of } }
 * Default day = today in Asia/Kolkata (server clock).
 */
import { NextResponse } from "next/server";
import { checkBearer } from "@/lib/brain/auth";
import { brainLog, classifyBrainError, getPool } from "@/lib/brain/db";
import { findRoomDay, isIstDateString, istDate, readGraph, roomExists } from "@/lib/brain/state";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 30;

const MAX_ID_LEN = 128;

const fail = (status: number, error: string, extra: Record<string, unknown> = {}) =>
  NextResponse.json({ ok: false, error, ...extra }, { status, headers: { "cache-control": "no-store" } });

export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const t0 = Date.now();
  let status = 200;
  try {
    const authErr = checkBearer(req);
    if (authErr) {
      status = authErr.status;
      return fail(authErr.status, authErr.code);
    }
    let roomId: string;
    try {
      roomId = decodeURIComponent((await params).id ?? "");
    } catch {
      status = 400;
      return fail(400, "invalid_room_id");
    }
    if (!roomId || roomId.length > MAX_ID_LEN) {
      status = 400;
      return fail(400, "invalid_room_id");
    }
    const qd = new URL(req.url).searchParams.get("ist_date");
    if (qd !== null && !isIstDateString(qd)) {
      status = 400;
      return fail(400, "invalid_ist_date");
    }
    const date = qd ?? istDate();
    if (!(await roomExists(roomId))) {
      status = 404;
      return fail(404, "unknown_room");
    }
    const day = await findRoomDay(roomId, date);
    const state = await readGraph(getPool(), roomId, date, day?.id ?? null);
    return NextResponse.json({ ok: true, state }, { headers: { "cache-control": "no-store" } });
  } catch (e) {
    const c = classifyBrainError(e);
    status = c.status;
    if (c.log) brainLog("error", "request_failed", { route: "brain/state", code: c.code, err: String((e as Error)?.message ?? e) });
    return fail(c.status, c.code, c.hint ? { hint: c.hint } : {});
  } finally {
    brainLog("info", "req", { method: "GET", path: "/api/brain/rooms/:id/state", status, ms: Date.now() - t0 });
  }
}

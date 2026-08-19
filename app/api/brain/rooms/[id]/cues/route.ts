/**
 * GET /api/brain/rooms/:id/cues — list a room-day's cues (Operator MCP S1; the GET the
 * inventory flagged as missing). Same guard + envelope as the state route.
 *
 *   Bearer BRAIN_SERVICE_TOKEN → 401 unauthorized / 503 service_token_not_configured
 *   Query: ist_date? (YYYY-MM-DD, default today IST — server clock) · since? (ISO; at > since)
 *          · type? (exact, ≤64 chars) · limit? (default 50, max 200) · include_payload? (true)
 *   400 invalid_room_id | invalid_ist_date | invalid_since | invalid_type | invalid_limit
 *   404 unknown_room
 *   200 { ok:true, room_id, room_day_id (null when no day yet), ist_date, cues:[{ id, type, at,
 *         created_at, summary, payload? }], as_of }   — newest first; summary = first 80 chars of
 *         the payload JSON; full payload ONLY with include_payload=true.
 * Read-only: never creates a room_day. Reads via the brain pool (BRAIN_DATABASE_URL).
 */
import { NextResponse } from "next/server";
import { checkBearer } from "@/lib/brain/auth";
import { brainLog, classifyBrainError } from "@/lib/brain/db";
import { CUES_MAX_LIMIT, isIstDateString, istDate, listCuesForDay, roomExists } from "@/lib/brain/state";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 30;

const MAX_ID_LEN = 128;
const MAX_TYPE_LEN = 64;

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
    const sp = new URL(req.url).searchParams;
    const qd = sp.get("ist_date");
    if (qd !== null && !isIstDateString(qd)) {
      status = 400;
      return fail(400, "invalid_ist_date");
    }
    const date = qd ?? istDate();
    let since: Date | null = null;
    const qs = sp.get("since");
    if (qs !== null && qs !== "") {
      since = new Date(qs);
      if (Number.isNaN(since.getTime())) {
        status = 400;
        return fail(400, "invalid_since");
      }
    }
    const qt = sp.get("type");
    if (qt !== null && (qt.length === 0 || qt.length > MAX_TYPE_LEN)) {
      status = 400;
      return fail(400, "invalid_type");
    }
    const ql = sp.get("limit");
    let limit: number | undefined;
    if (ql !== null) {
      limit = Number(ql);
      if (!Number.isInteger(limit) || limit < 1 || limit > CUES_MAX_LIMIT) {
        status = 400;
        return fail(400, "invalid_limit");
      }
    }
    const includePayload = sp.get("include_payload") === "true";

    if (!(await roomExists(roomId))) {
      status = 404;
      return fail(404, "unknown_room");
    }
    const out = await listCuesForDay(roomId, date, { since, type: qt, limit, includePayload });
    return NextResponse.json({ ok: true, ...out }, { headers: { "cache-control": "no-store" } });
  } catch (e) {
    const c = classifyBrainError(e);
    status = c.status;
    if (c.log) brainLog("error", "request_failed", { route: "brain/cues-list", code: c.code, err: String((e as Error)?.message ?? e) });
    return fail(c.status, c.code, c.hint ? { hint: c.hint } : {});
  } finally {
    brainLog("info", "req", { method: "GET", path: "/api/brain/rooms/:id/cues", status, ms: Date.now() - t0 });
  }
}

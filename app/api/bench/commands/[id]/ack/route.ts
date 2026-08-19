/**
 * POST /api/bench/commands/{id}/ack — kiosk acks (or fails) a command (Operator MCP S2, PRD §8.2).
 *
 * ROOM COOKIE; the command must belong to this room and still be `pending`.
 * Body { ok:boolean, session_id?, error? } → status acked (+result) | failed (+error), acked_at=now().
 * 404 command_not_pending when no such pending row for this room (already acked/expired/other room).
 * D10: DB error → 503 bus_down / bus_not_migrated.
 */
import { NextRequest, NextResponse } from "next/server";
import { readRoomClaims } from "@/lib/room-auth";
import { respondError } from "@/lib/respond";
import { ackCommand, classifyBusError } from "@/lib/bench-commands";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 10;

const NO_STORE = { "cache-control": "no-store" };

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const claims = await readRoomClaims();
  if (!claims) return respondError("AUTH_REQUIRED", "Room sign-in required");
  const { id } = await params;
  if (!id || !id.startsWith("cmd_") || id.length > 64) return respondError("VALIDATION_FAILED", "bad_command_id");

  let body: { ok?: unknown; session_id?: unknown; error?: unknown };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return respondError("VALIDATION_FAILED", "body_not_json");
  }
  if (typeof body?.ok !== "boolean") return respondError("VALIDATION_FAILED", "ok_required");
  const sessionId = typeof body.session_id === "string" && body.session_id.startsWith("bs_") ? body.session_id.slice(0, 64) : null;
  const error = typeof body.error === "string" ? body.error.slice(0, 200) : null;

  try {
    const status = await ackCommand({ roomId: claims.room_id, commandId: id, ok: body.ok, sessionId, error });
    if (!status) return respondError("NOT_FOUND", "command_not_pending");
    return NextResponse.json({ ok: true, id, status }, { headers: NO_STORE });
  } catch (e) {
    const b = classifyBusError(e);
    console.warn("[bench-commands] ack failed", JSON.stringify({ room_id: claims.room_id, id, code: b.code, err: b.cause_message ?? null }));
    return NextResponse.json({ ok: false, error: b.code }, { status: 503, headers: NO_STORE });
  }
}

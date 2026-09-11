/**
 * POST /api/bench/commands/{id}/ack — kiosk acks (or fails) a command (Operator MCP S2, PRD §8.2).
 *
 * ROOM COOKIE; the command must belong to this room and still be `pending`.
 * Body { ok:boolean, session_id?, error? } → status acked (+result) | failed (+error), acked_at=now().
 * R4-D12: a 0.1.21 app's set_audio_input ack may add applied_device_uid (string ≤256),
 * applied_input_volume (0..1) and input_volume_settable (bool). Each is validated on its own by
 * `cleanAckApplied` and dropped if malformed — never a refusal — and every other key is dropped. An
 * ack without them writes exactly the result it wrote before.
 * 404 command_not_pending when no such pending row for this room (already acked/expired/other room).
 * D10: DB error → 503 bus_down / bus_not_migrated.
 */
import { NextRequest, NextResponse, after } from "next/server";
import { readRoomClaims } from "@/lib/room-auth";
import { respondError } from "@/lib/respond";
import { ackCommand, classifyBusError, cleanAckApplied, getCommand } from "@/lib/bench-commands";
import { ensureRoomDayOpen } from "@/lib/brain/open-day";
import { istDate } from "@/lib/brain/state";

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
  const applied = cleanAckApplied(body);

  try {
    const status = await ackCommand({ roomId: claims.room_id, commandId: id, ok: body.ok, sessionId, error, applied });
    if (!status) return respondError("NOT_FOUND", "command_not_pending");

    // D39 (Build 3 §2.3) — on a successful START_DAY ack, open today's day record so it exists
    // from the moment the desk starts a room, before the first piece lands. OFF the ack path
    // (after()), and never throwing, so a slow or failed day-open never delays or fails the ack
    // the kiosk is waiting on. Keyed to today's IST date; the chunk-verify path (keyed to each
    // piece's own date) is what carries a session across midnight.
    if (body.ok) {
      const roomId = claims.room_id;
      after(async () => {
        try {
          const cmd = await getCommand(id);
          if (cmd?.kind === "start_day") {
            const opened = await ensureRoomDayOpen(roomId, istDate());
            if (opened.created) console.log(`[bench-ack] D39 opened room_day ${opened.room_day_id} for ${roomId} on ${opened.ist_date} (start_day)`);
          }
        } catch {
          /* the chunk-verify path opens the day on the first piece regardless; this is the earlier of two chances */
        }
      });
    }
    return NextResponse.json({ ok: true, id, status }, { headers: NO_STORE });
  } catch (e) {
    const b = classifyBusError(e);
    console.warn("[bench-commands] ack failed", JSON.stringify({ room_id: claims.room_id, id, code: b.code, err: b.cause_message ?? null }));
    return NextResponse.json({ ok: false, error: b.code }, { status: 503, headers: NO_STORE });
  }
}

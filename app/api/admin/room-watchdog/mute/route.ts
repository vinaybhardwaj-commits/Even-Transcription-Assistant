/**
 * POST /api/admin/room-watchdog/mute — D9: a known-bad room can be silenced until a timestamp,
 * rather than the operator having to switch the whole watchdog off.
 *
 * Body: { room_id: string, muted_until: string | null } — an ISO datetime, or null to unmute.
 * `muted_until` only ever touches that one column: a muted room's status keeps recording every
 * run (lib/room-watchdog.ts's `setRoomMute`), so unmuting mid-outage does not require the outage
 * to re-begin before anyone is told.
 *
 * Same admin-or-migration-secret guard as the other install admin routes (lib/room-install.ts's
 * installAdminGuard) — reused, not reinvented, for one more admin mutation.
 */
import { NextRequest, NextResponse } from "next/server";
import { installAdminGuard } from "@/lib/room-install";
import { setRoomMute } from "@/lib/room-watchdog";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const NO_STORE = { headers: { "cache-control": "no-store" } };

export async function POST(req: NextRequest) {
  const guard = await installAdminGuard(req);
  if (!guard.ok) {
    return NextResponse.json(
      { error: { code: "AUTH_REQUIRED", message: "admin or migration secret required" } },
      { status: 401, ...NO_STORE },
    );
  }

  let body: { room_id?: unknown; muted_until?: unknown } = {};
  try {
    body = (await req.json()) as typeof body;
  } catch {
    // empty body handled by the validation below
  }

  const roomId = typeof body.room_id === "string" && body.room_id.length > 0 ? body.room_id : null;
  if (!roomId) {
    return NextResponse.json(
      { error: { code: "VALIDATION_FAILED", message: "room_id is required" } },
      { status: 400, ...NO_STORE },
    );
  }

  let mutedUntil: string | null;
  if (body.muted_until === null) {
    mutedUntil = null;
  } else if (typeof body.muted_until === "string" && Number.isFinite(Date.parse(body.muted_until))) {
    mutedUntil = body.muted_until;
  } else {
    return NextResponse.json(
      { error: { code: "VALIDATION_FAILED", message: "muted_until must be an ISO datetime string, or null to unmute" } },
      { status: 400, ...NO_STORE },
    );
  }

  await setRoomMute(roomId, mutedUntil);
  return NextResponse.json({ ok: true, room_id: roomId, muted_until: mutedUntil }, NO_STORE);
}

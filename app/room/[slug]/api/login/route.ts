/**
 * POST /room/{slug}/api/login — Room Bench PIN auth (Room-Bench PRD D5/§9.3).
 * Body: { pin }
 *
 * bcrypt + lockout mirroring the clinician policy (thresholds in
 * lib/room-auth.ts); on success issues the eta_room_session cookie
 * (JWT aud:"room", signed with JWT_SECRET_DOCTOR — mutually invalid with
 * doctor sessions by audience). Probe-proof: unknown slug returns the same
 * PIN_INVALID as a wrong PIN.
 */
import { NextRequest, NextResponse } from "next/server";
import bcrypt from "bcryptjs";
import { sql } from "@/lib/db";
import { respondError } from "@/lib/respond";
import {
  signRoomJwt,
  setRoomCookie,
  roomPreAttemptCheck,
  roomRecordFailedAttempt,
  roomRecordSuccessfulAttempt,
  type RoomLockState,
} from "@/lib/room-auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type RoomRow = {
  id: string;
  slug: string;
  name: string;
  pin_hash: string;
  failed_attempts: number;
  locked_until: Date | string | null;
  disabled_at: Date | string | null;
};

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ slug: string }> },
) {
  const { slug } = await params;

  let body: { pin?: unknown };
  try {
    body = await req.json();
  } catch {
    return respondError("VALIDATION_FAILED", "Body must be JSON");
  }
  if (typeof body.pin !== "string" || !/^\d{4}$/.test(body.pin)) {
    return respondError("VALIDATION_FAILED", "4-digit pin is required");
  }
  const pin = body.pin;

  let room: RoomRow | null = null;
  try {
    const rows = (await sql`
      SELECT id, slug, name, pin_hash, failed_attempts, locked_until, disabled_at
        FROM room
       WHERE slug = ${slug}
       LIMIT 1
    `) as RoomRow[];
    room = rows[0] ?? null;
  } catch (e) {
    return respondError("UPSTREAM_UNAVAILABLE", "Room lookup failed: " + String(e).slice(0, 120));
  }

  if (!room) {
    // Probe-proof: same shape as wrong PIN
    return respondError("PIN_INVALID", "Incorrect PIN");
  }

  const lockState: RoomLockState = {
    id: room.id,
    slug: room.slug,
    failed_attempts: room.failed_attempts,
    locked_until: room.locked_until,
    disabled_at: room.disabled_at,
  };

  const pre = roomPreAttemptCheck(lockState);
  if (pre.kind === "disabled") return respondError("FORBIDDEN", "Room disabled");
  if (pre.kind === "locked")
    return respondError("PIN_LOCKED", pre.reason, { retry_after_seconds: pre.retry_after_seconds });

  let pinOk = false;
  try {
    pinOk = await bcrypt.compare(pin, room.pin_hash);
  } catch (e) {
    return respondError("UPSTREAM_UNAVAILABLE", "PIN check failed: " + String(e).slice(0, 120));
  }

  if (!pinOk) {
    const after = await roomRecordFailedAttempt(lockState);
    if (after.kind === "disabled") return respondError("FORBIDDEN", "Room disabled after too many attempts");
    if (after.kind === "locked")
      return respondError("PIN_LOCKED", after.reason, { retry_after_seconds: after.retry_after_seconds });
    const attemptsRemaining = Math.max(0, 5 - (room.failed_attempts + 1));
    return NextResponse.json(
      {
        error: {
          code: "PIN_INVALID",
          message: "Incorrect PIN",
          attempts_remaining: attemptsRemaining,
        },
      },
      { status: 401 },
    );
  }

  await roomRecordSuccessfulAttempt(room.id);
  const jwt = await signRoomJwt({ room_id: room.id, slug: room.slug });
  await setRoomCookie(jwt);

  return NextResponse.json({
    ok: true,
    room: { id: room.id, name: room.name, slug: room.slug },
  });
}

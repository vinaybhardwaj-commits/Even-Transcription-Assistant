/**
 * POST /room/{slug}/api/logout — clears the eta_room_session cookie.
 */
import { NextResponse } from "next/server";
import { clearRoomCookie } from "@/lib/room-auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST() {
  await clearRoomCookie();
  return NextResponse.json({ ok: true });
}

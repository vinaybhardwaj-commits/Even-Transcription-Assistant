/**
 * GET /api/rooms-live/day?room_id= — one room's audio-state intervals for today (IST) from room_audio_state, for the detail view's "Today" strip.
 * The classifier writes in batches (about an hour behind), so the strip is clipped to its newest write (`as_of`). Admin-or-staff guarded, read-only, never a 500.
 */
import { NextResponse } from "next/server";
import { sql } from "@/lib/db";
import { roomsLiveGuard } from "@/lib/rooms-live/guard";
import { readDay, istDateOf } from "@/lib/rooms-live/read";
import { isRoomId } from "@/lib/rooms-live/rooms";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 15;

const NO_STORE = { "cache-control": "no-store" };

export async function GET(req: Request) {
  const guard = await roomsLiveGuard(req);
  if (!guard.ok) return NextResponse.json({ error: { code: guard.code, message: guard.msg } }, { status: 401, headers: NO_STORE });
  const roomId = new URL(req.url).searchParams.get("room_id") ?? "";
  if (!isRoomId(roomId)) return NextResponse.json({ error: { code: "BAD_REQUEST", message: "room_id must be one of the OPD rooms" } }, { status: 400, headers: NO_STORE });
  const now = Date.now();
  const day = istDateOf(now);
  try {
    const d = await readDay(sql, roomId, day, now);
    return NextResponse.json({ room_id: roomId, ist_day: day, ...d }, { headers: NO_STORE });
  } catch {
    return NextResponse.json({ room_id: roomId, ist_day: day, as_of: null, segments: [], degraded: ["room_audio_state"] }, { headers: NO_STORE });
  }
}

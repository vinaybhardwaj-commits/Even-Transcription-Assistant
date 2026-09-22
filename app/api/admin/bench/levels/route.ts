import { NextRequest, NextResponse } from "next/server";
import { benchAdminGuard } from "@/lib/bench";
import { readRoomLevelDay, isIsoDate } from "@/lib/bench-levels";
import { istDate } from "@/lib/bench-reaper-core";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const NO_STORE = { "cache-control": "no-store" };

export async function GET(req: NextRequest) {
  const guard = await benchAdminGuard();
  if (!guard.ok) {
    return NextResponse.json(
      { error: { code: guard.code, message: guard.msg } },
      { status: 401, headers: NO_STORE },
    );
  }

  const roomId = (req.nextUrl.searchParams.get("room_id") ?? "").trim();
  const day = (req.nextUrl.searchParams.get("ist_date") ?? istDate(new Date())).trim();
  if (!roomId || roomId.length > 128 || !isIsoDate(day)) {
    return NextResponse.json(
      { error: { code: "VALIDATION_FAILED", message: "room_id and a valid ist_date are required" } },
      { status: 400, headers: NO_STORE },
    );
  }

  try {
    const timeline = await readRoomLevelDay(roomId, day);
    return NextResponse.json(
      {
        room_id: roomId,
        ist_date: day,
        bucket_seconds: 15,
        sample_count: timeline.sampleCount,
        samples: timeline.samples,
      },
      { headers: NO_STORE },
    );
  } catch (error) {
    console.warn("[bench-levels] read failed", JSON.stringify({
      room_id: roomId,
      ist_date: day,
      error: String((error as Error)?.message ?? error).slice(0, 180),
    }));
    return NextResponse.json(
      { error: { code: "LEVELS_UNAVAILABLE", message: "Room level history is unavailable" } },
      { status: 503, headers: NO_STORE },
    );
  }
}

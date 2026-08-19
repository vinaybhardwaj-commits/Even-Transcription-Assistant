/**
 * GET /api/bench/commands — the kiosk's command poll (Operator MCP S2, PRD §8.2; D4/D10).
 *
 * ROOM COOKIE. Query: tab_id (required) · prev_poll_at? (server `now` from this tab's previous
 * poll — drives D4 last-poll-wins) · recording_session_id? · paused? ("true"). Each poll upserts
 * bench_listener for the room, lazily expires pending commands older than 15 s, and returns
 * pending commands oldest first. If another tab polled this room more recently than this tab
 * last did → { superseded:true } and this tab should stop.
 *
 * D10 loud failure: DB error → 503 { error:"bus_down" }; migration 0044 not applied → 503
 * { error:"bus_not_migrated" }. NEVER an empty 200 — the kiosk shows "operator link down"
 * and its buttons keep working (fail-open for the doctor).
 */
import { NextRequest, NextResponse } from "next/server";
import { readRoomClaims } from "@/lib/room-auth";
import { respondError } from "@/lib/respond";
import { classifyBusError, pollCommands } from "@/lib/bench-commands";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 10;

const NO_STORE = { "cache-control": "no-store" };

export async function GET(req: NextRequest) {
  const claims = await readRoomClaims();
  if (!claims) return respondError("AUTH_REQUIRED", "Room sign-in required");

  const sp = req.nextUrl.searchParams;
  const tabId = (sp.get("tab_id") ?? "").trim();
  if (!tabId || tabId.length > 64) return respondError("VALIDATION_FAILED", "tab_id_required");
  const prevRaw = sp.get("prev_poll_at");
  let prevPollAt: Date | null = null;
  if (prevRaw) {
    const d = new Date(prevRaw);
    prevPollAt = Number.isNaN(d.getTime()) ? null : d;
  }
  const rs = (sp.get("recording_session_id") ?? "").trim();
  const recordingSessionId = rs && rs.startsWith("bs_") && rs.length <= 64 ? rs : null;
  const paused = sp.get("paused") === "true";

  try {
    const out = await pollCommands({ roomId: claims.room_id, tabId, prevPollAt, recordingSessionId, paused });
    return NextResponse.json({ ok: true, room_id: claims.room_id, ...out }, { headers: NO_STORE });
  } catch (e) {
    const b = classifyBusError(e);
    console.warn("[bench-commands] poll failed", JSON.stringify({ room_id: claims.room_id, code: b.code, err: b.cause_message ?? null }));
    return NextResponse.json({ ok: false, error: b.code }, { status: 503, headers: NO_STORE });
  }
}

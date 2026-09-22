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
import { classifyBusError, cleanLevels, pollCommands } from "@/lib/bench-commands";

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
  // §2.2 — the level pair, if the page sent one. `cleanLevels` drops anything outside 0..1 rather
  // than clamping it, so a malformed reading leaves the columns NULL instead of putting a number
  // on a clinical screen that no microphone produced. Nothing here can make the poll fail: an
  // absent, partial or nonsense pair simply becomes null.
  const levelPair = (peakKey: string, avgKey: string, zeroRatioKey?: string) => {
    const peak = sp.get(peakKey);
    if (peak === null) return null;
    const avg = sp.get(avgKey);
    const zeroRatio = zeroRatioKey ? sp.get(zeroRatioKey) : null;
    return cleanLevels({
      peak: Number(peak),
      ...(avg === null ? {} : { avg: Number(avg) }),
      ...(zeroRatio === null ? {} : { zero_ratio: Number(zeroRatio) }),
    });
  };
  // Native installs may call these fields peak/zero_ratio; the browser kiosk has historically
  // used mic_peak/mic_avg. Both names enter the same listener ingest and the same level log.
  const mic = sp.has("mic_peak")
    ? levelPair("mic_peak", "mic_avg", "mic_zero_ratio")
    : levelPair("peak", "mic_avg", "zero_ratio");
  const spare = levelPair("spare_peak", "spare_avg");
  // §2.4 — an EXPLICITLY chosen second device. Only ever true when the client says `spare_device=true`;
  // any other value (including absent — the browser kiosk never sends it) leaves it unreported, and
  // the upsert COALESCE means unreported never erases a stored flag. Never derived from a piece.
  const spareDeviceRaw = sp.get("spare_device");
  const spareDevice = spareDeviceRaw === "true" ? true : spareDeviceRaw === "false" ? false : null;

  try {
    const out = await pollCommands({ roomId: claims.room_id, tabId, prevPollAt, recordingSessionId, paused, mic, spare, spareDevice });
    return NextResponse.json({ ok: true, room_id: claims.room_id, ...out }, { headers: NO_STORE });
  } catch (e) {
    const b = classifyBusError(e);
    console.warn("[bench-commands] poll failed", JSON.stringify({ room_id: claims.room_id, code: b.code, err: b.cause_message ?? null }));
    return NextResponse.json({ ok: false, error: b.code }, { status: 503, headers: NO_STORE });
  }
}

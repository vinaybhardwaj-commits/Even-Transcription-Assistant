/**
 * GET /api/bench/commands — the kiosk's command poll (Operator MCP S2, PRD §8.2; D4/D10).
 *
 * ROOM COOKIE. Query: tab_id (required) · prev_poll_at? (server `now` from this tab's previous
 * poll — drives D4 last-poll-wins) · recording_session_id? · paused? ("true"). Each poll upserts
 * bench_listener for the room, lazily expires pending commands older than 15 s, and returns
 * pending commands oldest first. If another tab polled this room more recently than this tab
 * last did → { superseded:true } and this tab should stop.
 *
 * INSTALL AND FLEET §4.3 adds seven OPTIONAL query fields for the native Room Recorder:
 * install_id · app_version · build_sha · mic_state · tape_advancing · never_sleep · launched_by
 * · input_device_name
 * (plus hostname / hardware_model / os_version, which §6 step 2 renders). A poll carrying
 * install_id also writes last_seen_at and the six state columns on that room_install row; a poll
 * WITHOUT it behaves exactly as it behaves today, which is why the browser kiosk is untouched by
 * this build. A poll from a RETIRED install is answered 409 RETIRED (§4.5 rule 3) and stops.
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
  const levelPair = (peakKey: string, avgKey: string) =>
    cleanLevels({ peak: sp.get(peakKey), avg: sp.get(avgKey) });
  const mic = levelPair("mic_peak", "mic_avg");
  const spare = levelPair("spare_peak", "spare_avg");
  // §2.4 — an EXPLICITLY chosen second device. Only ever true when the client says `spare_device=true`;
  // any other value (including absent — the browser kiosk never sends it) leaves it unreported, and
  // the upsert COALESCE means unreported never erases a stored flag. Never derived from a piece.
  const spareDeviceRaw = sp.get("spare_device");
  const spareDevice = spareDeviceRaw === "true" ? true : spareDeviceRaw === "false" ? false : null;

  // Install and Fleet §4.3 — SEVEN OPTIONAL FIELDS, and the emphasis is on optional.
  //
  // `install_id` is the switch. Absent, this whole block yields undefined and the poll runs
  // exactly as it ran before this build — same query, same upsert, same response. Present, it
  // carries the native Room Recorder's report of itself onto its room_install row.
  //
  // THE THREE MACHINE FACTS (hostname, model, OS) ARE NOT AMONG THE SEVEN. They are read here
  // because §6 step 2 renders them and the app has nowhere else to put them; they are COALESCEd
  // like everything else, so a poll that omits them never erases what the first poll said.
  const installId = (sp.get("install_id") ?? "").trim();
  const tri = (key: string): boolean | null => {
    const v = sp.get(key);
    return v === "true" ? true : v === "false" ? false : null;
  };
  const install = installId
    ? {
        install_id: installId.slice(0, 64),
        app_version: sp.get("app_version"),
        build_sha: sp.get("build_sha"),
        mic_state: sp.get("mic_state"),
        tape_advancing: tri("tape_advancing"),
        never_sleep: tri("never_sleep"),
        launched_by: sp.get("launched_by"),
        hostname: sp.get("hostname"),
        hardware_model: sp.get("hardware_model"),
        os_version: sp.get("os_version"),
        input_device_name: sp.get("input_device_name"),
      }
    : undefined;

  try {
    const out = await pollCommands({ roomId: claims.room_id, tabId, prevPollAt, recordingSessionId, paused, mic, spare, spareDevice, install });
    // §4.5 rule 3 — a retired install is told once, in a status it cannot mistake for a transient
    // fault, and it stops polling. Deliberately NOT a 503: 503 means "try again", and this one
    // never should.
    if ("retired" in out) {
      return NextResponse.json(
        { ok: false, error: "RETIRED", room_id: claims.room_id, now: out.now },
        { status: 409, headers: NO_STORE },
      );
    }
    return NextResponse.json({ ok: true, room_id: claims.room_id, ...out }, { headers: NO_STORE });
  } catch (e) {
    const b = classifyBusError(e);
    console.warn("[bench-commands] poll failed", JSON.stringify({ room_id: claims.room_id, code: b.code, err: b.cause_message ?? null }));
    return NextResponse.json({ ok: false, error: b.code }, { status: 503, headers: NO_STORE });
  }
}

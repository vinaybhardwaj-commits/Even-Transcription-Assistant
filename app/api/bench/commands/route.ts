/**
 * GET /api/bench/commands — the kiosk's command poll (Operator MCP S2, PRD §8.2; D4/D10).
 *
 * ROOM COOKIE. Query: tab_id (required) · prev_poll_at? (server `now` from this tab's previous
 * poll — drives D4 last-poll-wins) · recording_session_id? · paused? ("true"). Each poll upserts
 * bench_listener for the room, lazily expires pending commands older than 15 s, and returns
 * pending commands oldest first. If another tab polled this room more recently than this tab
 * last did → { superseded:true } and this tab should stop.
 *
 * INSTALL AND FLEET §4.3 adds OPTIONAL query fields for the native Room Recorder:
 * install_id · app_version · build_sha · mic_state · tape_advancing · never_sleep · launched_by
 * · input_device_name (plus hostname / hardware_model / os_version, which §6 step 2 renders), and
 * since Build R3 §13.4: session_open · update_channel · last_update_result · last_update_version ·
 * last_update_error · last_update_at · disk_free_bytes; since Release B2: peak · zero_ratio ·
 * input_devices. A native poll's 200 also carries `assigned_channel` (B2-D5): `stable` or null.
 *
 * A poll carrying install_id writes last_seen_at and those columns on that room_install row; a poll
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

  // Install and Fleet §4.3 — OPTIONAL FIELDS, and the emphasis is on optional.
  //
  // `install_id` is the switch. Absent, this whole block yields undefined and the poll runs
  // exactly as it ran before this build — same query, same upsert, same response. Present, it
  // carries the native Room Recorder's report of itself onto its room_install row.
  //
  // THE THREE MACHINE FACTS (hostname, model, OS) ARE NOT AMONG §4.3's EIGHT. They are read here
  // because §6 step 2 renders them and the app has nowhere else to put them; they are COALESCEd
  // like everything else, so a poll that omits them never erases what the first poll said.
  const installId = (sp.get("install_id") ?? "").trim();
  const tri = (key: string): boolean | null => {
    const v = sp.get(key);
    return v === "true" ? true : v === "false" ? false : null;
  };
  // ─── BUILD R3 (§13.4) ADDS SEVEN MORE, AND THIS BLOCK IS WHERE THEY WERE MISSED ───────────
  //
  // Fix 1, F1. The app sent them and `applyInstallPoll` wrote them; this list in the middle read
  // none of them, so every one arrived as `undefined` and every column stayed NULL for ever. The
  // consequence was not a cosmetic gap: `session_open` NULL means `sessionOpen === true` is never
  // true, so R3-3 would not have FIXED the "Tape not advancing" warning, it would have DELETED it
  // — a room with a patient in it and a dead microphone cable would have read healthy.
  //
  // Every one of them keeps §5.5's rule: read what the Mac said, or read nothing. No defaults, no
  // zeroes, no coercion. `applyInstallPoll` COALESCEs all but `session_open`, so an omitted field
  // leaves the last good value in place and a fabricated one would overwrite a true reading.

  /** A whole positive number of bytes, or nothing. NEVER 0 — see the column comment on 0078. */
  const bigint = (key: string): string | null => {
    const raw = (sp.get(key) ?? "").trim();
    return /^[0-9]{1,19}$/.test(raw) && raw !== "0" ? raw : null;
  };
  /**
   * An ISO-8601 instant, or nothing (Fix 2, G5).
   *
   * SHAPE FIRST, THEN `Date.parse` — and the order is the fix. `Date.parse` alone is not a
   * validator: it accepts `"12"` as December 2001, `"2026"` as a year, and a pile of other legacy
   * forms, so a truncated or garbled field arrived as a confident wrong timestamp instead of as
   * silence. The card renders this as the clock time an update failed at; a value invented out of
   * `"12"` is exactly the kind of plausible-looking fiction §5.5 exists to forbid.
   *
   * The regex admits what the app actually sends — `Date.toISOString()` — plus an explicit offset,
   * and nothing else. `Date.parse` still runs afterwards so that a shape-valid but impossible date
   * (month 13, day 32) is rejected too.
   */
  const ISO_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?(Z|[+-]\d{2}:\d{2})$/;
  const instant = (key: string): string | null => {
    const raw = (sp.get(key) ?? "").trim();
    if (!ISO_INSTANT.test(raw)) return null;
    const ms = Date.parse(raw);
    return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
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
        // R3-6. `tri` and not a truthiness test: absent must stay absent. Every install below
        // 0.1.8 omits this for ever, and NULL reads as "not reported", never as "idle".
        session_open: tri("session_open"),
        // R3-8. `cleanPollFields` accepts only `stable` and `test` and coerces nothing.
        update_channel: sp.get("update_channel"),
        last_update_result: sp.get("last_update_result"),
        last_update_version: sp.get("last_update_version"),
        last_update_error: sp.get("last_update_error"),
        last_update_at: instant("last_update_at"),
        disk_free_bytes: bigint("disk_free_bytes"),
        // ── Release B2 (0079). Sent by 0.1.20 and later, all optional. `cleanPollFields` bounds
        // them (0..1, or a ≤16-entry device list) and drops anything else to "not reported".
        peak: sp.get("peak"),
        zero_ratio: sp.get("zero_ratio"),
        input_devices: sp.get("input_devices"),
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
    // B2-D5. A native poll's `out` carries `assigned_channel` — `stable` or null — straight from the
    // install row's own UPDATE … RETURNING, so it costs no extra read. The browser kiosk's `out`
    // has no such key and its response is exactly what it was. An app that does not know the key
    // ignores it (a keyed decoder reads only the keys it names).
    return NextResponse.json({ ok: true, room_id: claims.room_id, ...out }, { headers: NO_STORE });
  } catch (e) {
    const b = classifyBusError(e);
    console.warn("[bench-commands] poll failed", JSON.stringify({ room_id: claims.room_id, code: b.code, err: b.cause_message ?? null }));
    return NextResponse.json({ ok: false, error: b.code }, { status: 503, headers: NO_STORE });
  }
}

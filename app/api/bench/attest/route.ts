/**
 * app/api/bench/attest/route.ts — the Room Recorder attests who is sitting in the room.
 *
 * ─── THE CONTRACT, for the app team ─────────────────────────────────────────────────────────────
 *
 * POST /api/bench/attest          Content-Type: application/json
 *
 *   {
 *     "room":           "opd-5-dr-salanki-wxmp",   // room slug OR room id. REQUIRED.
 *     "clinician_slug": "dr-example-ab12",         // REQUIRED — see WHY A SLUG below.
 *     "pin":            "0000",                    // REQUIRED. Exactly 4 digits. Never logged.
 *     "session_id":     "bs_pj5fy76f",             // OPTIONAL. The recording session, when known.
 *     "started_at":     "2026-09-19T09:00:00.000Z" // OPTIONAL ISO-8601. Defaults to now.
 *   }
 *
 * 200 { "ok": true, "attestation_id": "att_…", "started_at": "…", "expires_at": "…",
 *       "replayed": false }
 *     `expires_at` is the HARD CAP (start + 4 h). The sitting really ends at the earliest of that,
 *     an explicit end, and the recording session's end — the server resolves this on read, so the
 *     app does not have to send anything when the sitting finishes. THERE IS NO END CALL.
 *     `replayed: true` means this exact (room, session) was already attested by this clinician and
 *     the original row is being returned. Retrying is safe and never creates a second sitting.
 *
 * Refusals — HTTP 4xx, always `{ "error": { "code": …, "message": … } }`, never a silent 200:
 *     PIN_INVALID          wrong PIN. Carries `attempts_remaining`.
 *     PIN_LOCKED           too many wrong PINs. Carries `retry_after_seconds`.
 *     RATE_LIMITED         too fast. Carries `retry_after_seconds`.
 *     FORBIDDEN            the clinician account is disabled.
 *     PIN_NOT_SET          that clinician has no PIN.
 *     UNKNOWN_ROOM         no room matches `room`, or the room is disabled.
 *     ROOM_NOT_RECORDING   no tape is running in that room — a PIN may not attest an idle room.
 *     CLINICIAN_ELSEWHERE  that clinician already has a live sitting in a different room.
 *     OVERLAPPING_SITTING  that room already has a live sitting covering this time.
 *     VALIDATION_FAILED    the body is not the shape above.
 *     PIPELINE_FAILED      the attempt could not be recorded; it is REFUSED, not waved through.
 *
 * WHY A CLINICIAN SLUG AND NOT JUST A PIN. The brief named room, PIN and a start. A 4-digit PIN
 * cannot identify a clinician: 25 clinicians share a 10,000-value space, so collisions are likely
 * and a PIN-only lookup would be a 4-digit login for the whole organisation. The slug is the same
 * identifier the existing web PIN screen posts, so the app has one to hand.
 *
 * WHY THE ROOM MUST BE RECORDING. An attestation is a claim about audio being captured now. With no
 * tape running there is nothing for it to bind to, and accepting one would let a PIN presented in a
 * corridor claim a room for four hours.
 *
 * NO PIN IS EVER LOGGED, audited, echoed or stored — here or anywhere it calls.
 */
import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { respondError, respondOk } from "@/lib/respond";
import { verifyClinicianPin } from "@/lib/clinician-pin";
import { loadRoomForAttestation, recordAttestation } from "@/lib/attestation";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const str = (v: unknown) => (typeof v === "string" ? v.trim() : "");

export async function POST(req: NextRequest) {
  let body: Record<string, unknown>;
  try {
    body = (await req.json()) as Record<string, unknown>;
  } catch {
    return respondError("VALIDATION_FAILED", "Body must be JSON");
  }

  const room = str(body.room);
  const clinicianSlug = str(body.clinician_slug);
  const pin = str(body.pin);
  const sessionIdIn = str(body.session_id) || null;
  const startedAtIn = str(body.started_at);

  if (!room || !clinicianSlug || !/^\d{4}$/.test(pin)) {
    return respondError("VALIDATION_FAILED", "room, clinician_slug and a 4-digit pin are required");
  }
  const startedAt = startedAtIn ? new Date(startedAtIn) : new Date();
  if (!Number.isFinite(startedAt.getTime())) {
    return respondError("VALIDATION_FAILED", "started_at must be ISO-8601");
  }

  // THE ROOM IS RESOLVED BEFORE THE PIN IS EVEN LOOKED AT. A PIN presented against a room that does
  // not exist, or one with no tape running, is refused without spending an attempt from the
  // clinician's lockout budget — an operator's typo must not lock a doctor out mid-clinic.
  let roomCtx: Awaited<ReturnType<typeof loadRoomForAttestation>>;
  try {
    roomCtx = await loadRoomForAttestation(room);
  } catch (e) {
    return respondError("PIPELINE_FAILED", "Room lookup failed: " + String(e).slice(0, 160));
  }
  if (!roomCtx || roomCtx.room.disabled_at) {
    return respondError("UNKNOWN_ROOM", "No such room");
  }
  if (!roomCtx.recordingSessionId) {
    return respondError("ROOM_NOT_RECORDING", "That room is not recording");
  }
  // The session the recorder names must be the one actually running in that room.
  const sessionId = sessionIdIn ?? roomCtx.recordingSessionId;
  if (sessionIdIn && sessionIdIn !== roomCtx.recordingSessionId) {
    return respondError("ROOM_NOT_RECORDING", "That session is not the one recording in that room");
  }

  const ip = req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || "";
  const userAgent = req.headers.get("user-agent") || "";

  const verdict = await verifyClinicianPin({ clinicianSlug, pin, ip, userAgent });
  switch (verdict.kind) {
    case "ok":
      break;
    case "unknown_clinician":
    case "pin_invalid":
      // The same code for both, so a caller cannot enumerate slugs by the shape of the refusal.
      return NextResponse.json(
        {
          error: {
            code: "PIN_INVALID",
            message: "Incorrect PIN",
            ...(verdict.kind === "pin_invalid" ? { attempts_remaining: verdict.attempts_remaining } : {}),
          },
        },
        { status: 401 },
      );
    case "pin_not_set":
      return respondError("PIN_NOT_SET", "PIN not set for this account");
    case "locked":
      return respondError("PIN_LOCKED", verdict.reason, { retry_after_seconds: verdict.retry_after_seconds });
    case "rate_limited":
      return respondError("RATE_LIMITED", "Too many attempts. Try again shortly.", {
        retry_after_seconds: verdict.retry_after_seconds,
      });
    case "disabled":
      return respondError("FORBIDDEN", "Account disabled");
    case "not_recorded":
    case "unavailable":
      // E31's rule, carried here: an attempt the counter could not record is REFUSED. Answering it
      // would let a brute force run un-counted while the clinician table is degraded.
      return respondError("PIPELINE_FAILED", "Attempt could not be recorded; refusing the attempt");
  }

  let outcome: Awaited<ReturnType<typeof recordAttestation>>;
  try {
    outcome = await recordAttestation({
      roomId: roomCtx.room.id,
      clinicianId: verdict.clinician_id,
      sessionId,
      startedAt: startedAt.toISOString(),
    });
  } catch (e) {
    return respondError("PIPELINE_FAILED", "Attestation write failed: " + String(e).slice(0, 160));
  }

  if (!outcome.ok) {
    const code = outcome.refusal === "clinician_attested_elsewhere"
      ? "CLINICIAN_ELSEWHERE"
      : outcome.refusal === "overlapping_sitting"
        ? "OVERLAPPING_SITTING"
        : outcome.refusal === "room_not_recording"
          ? "ROOM_NOT_RECORDING"
          : "UNKNOWN_ROOM";
    return respondError(code, outcome.detail ?? "Attestation refused");
  }

  return respondOk({
    ok: true,
    attestation_id: outcome.attestation_id,
    started_at: outcome.started_at,
    expires_at: outcome.expires_at,
    replayed: outcome.replayed,
  });
}

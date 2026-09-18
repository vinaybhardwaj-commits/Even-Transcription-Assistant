import { NextRequest, NextResponse } from "next/server";
import bcrypt from "bcryptjs";
import { sql } from "@/lib/db";
import { signDoctorJwt } from "@/lib/auth";
import { setDoctorCookie } from "@/lib/cookie";
import {
  preAttemptCheck,
  recordFailedAttempt,
  recordSuccessfulAttempt,
} from "@/lib/lockout";
import { respondError } from "@/lib/respond";

/**
 * POST /api/auth/pin
 * Body: { slug, pin }
 *
 * Notes:
 * - `token` (per §4.14) lives INSIDE the slug as its 4-char suffix; not
 *   a separate field. We accept slug only.
 * - On success: issue doctor JWT, set eta_session cookie scoped to /{slug}/.
 * - On failure: increment failed_pin_count, escalate lockout per §4.15.
 *
 * Per PRD §4.15 attempts: 5→15m, 10→1h, 20→24h, 30→disabled.
 */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * THE ONE REFUSAL FOR AN ATTEMPT THE SYSTEM CANNOT ACCOUNT FOR — used by the wrong-pin path (E31 R58/R63) AND by the
 * correct-pin path when nothing is recording (E32), and it must stay ONE response. If the correct pin were refused
 * with anything distinguishable — another status, another code, another message — the refusal itself would say
 * which of the 10,000 guesses was right, and the attacker would simply wait for writes to come back and use it.
 * The reason is told apart where only the operator reads it: the log line and the audit row (lib/lockout).
 */
const refuseUnrecordedAttempt = () =>
  respondError("PIPELINE_FAILED", "Attempt could not be recorded; refusing the attempt");

type DoctorRow = {
  id: string;
  full_name: string;
  url_slug: string;
  pin_hash: string | null;
  failed_pin_count: number;
  locked_until: Date | null;
  status: "active" | "disabled" | "locked";
};

export async function POST(req: NextRequest) {
  let body: { slug?: unknown; pin?: unknown };
  try {
    body = await req.json();
  } catch {
    return respondError("VALIDATION_FAILED", "Body must be JSON");
  }
  if (typeof body.slug !== "string" || typeof body.pin !== "string" || !/^\d{4}$/.test(body.pin)) {
    return respondError("VALIDATION_FAILED", "slug and 4-digit pin are required");
  }
  const slug = body.slug;
  const pin = body.pin;

  const ip = req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? null;
  const userAgent = req.headers.get("user-agent");

  // Look up doctor by full slug
  let doctor: DoctorRow | null = null;
  try {
    const rows = (await sql`
      SELECT id, full_name, url_slug, pin_hash, failed_pin_count, locked_until, status
        FROM clinician
       WHERE url_slug = ${slug}
         AND deleted_at IS NULL
       LIMIT 1
    `) as DoctorRow[];
    doctor = rows[0] ?? null;
  } catch (e) {
    return respondError("PIPELINE_FAILED", "Doctor lookup failed: " + String(e));
  }

  if (!doctor) {
    // Probe-proof: same response shape as wrong PIN, no info leak
    return respondError("PIN_INVALID", "Incorrect PIN");
  }
  if (!doctor.pin_hash) {
    return respondError("PIN_NOT_SET", "PIN not set for this account");
  }

  // Pre-attempt checks (lockout + rate limit + disabled)
  const lockState = {
    doctor_id: doctor.id,
    url_slug: doctor.url_slug,
    failed_pin_count: doctor.failed_pin_count,
    locked_until: doctor.locked_until,
    status: doctor.status,
  };
  const pre = await preAttemptCheck(lockState, ip);
  if (pre.kind === "disabled") return respondError("FORBIDDEN", "Account disabled");
  if (pre.kind === "locked")
    return respondError("PIN_LOCKED", pre.reason, { retry_after_seconds: pre.retry_after_seconds });
  if (pre.kind === "rate_limited")
    return respondError("RATE_LIMITED", "Too many attempts. Try again shortly.", {
      retry_after_seconds: pre.retry_after_seconds,
    });

  // Verify PIN
  let pinOk = false;
  try {
    pinOk = await bcrypt.compare(pin, doctor.pin_hash);
  } catch (e) {
    return respondError("PIPELINE_FAILED", "PIN check failed: " + String(e));
  }

  if (!pinOk) {
    const newState = await recordFailedAttempt(lockState, ip, userAgent);
    // E31 R58/R63 — WRONG PIN, COUNTER NOT RECORDED: FAIL CLOSED. The lockout counter did not move, so this
    // attempt is not accounted for and the next one would arrive against the same count. Answering PIN_INVALID
    // here is what let a brute force run un-counted while the clinician table was degraded: refuse instead, and
    // say the system could not record it rather than implying anything about the pin. This is the brute-force
    // path. It is NOT symmetric with the correct-pin path below, on purpose.
    if (newState.kind === "not_recorded") {
      // E32b — `audited: false` here, and on the correct-pin refusal's audit line, is how an operator learns that
      // audit_log is down as well. The client answer does not change: it is refuseUnrecordedAttempt, as below.
      console.error("[auth/pin] attempt refused, not recorded:",
        JSON.stringify({ doctor_id: doctor.id, audited: newState.audited }));
      return refuseUnrecordedAttempt();
    }
    if (newState.kind === "disabled") return respondError("FORBIDDEN", "Account disabled after too many attempts");
    if (newState.kind === "locked")
      return respondError("PIN_LOCKED", newState.reason, { retry_after_seconds: newState.retry_after_seconds });
    const attemptsRemaining = Math.max(0, 5 - (doctor.failed_pin_count + 1));
    return NextResponse.json(
      {
        error: {
          code: "PIN_INVALID",
          message: "Incorrect PIN",
          attempts_remaining: attemptsRemaining,
        },
      },
      { status: 401 }
    );
  }

  // PIN correct — reset counter + issue session. THREE STATES, and they stay three (lib/lockout, above ResetOutcome).
  const reset = await recordSuccessfulAttempt(lockState, ip, userAgent);

  // E32 — NEITHER BOUND IS RECORDING: REFUSE THE SESSION, even for this correct pin. Every wrong guess before it
  // was refused but none was counted, so nothing stopped the walk to this one: the correct pin IS the winning
  // guess. This costs the clinician nothing they could use — with no write landing anywhere, no encounter can be
  // recorded or saved either. The answer is the wrong-pin refusal, byte for byte (see refuseUnrecordedAttempt).
  if (reset.kind === "no_bound_recording") {
    // E32b — the same fields as the not_recorded branch's line, so route logs alone document both refusals.
    console.error("[auth/pin] session refused, no bound recording:",
      JSON.stringify({ doctor_id: doctor.id, audited: reset.audited }));
    return refuseUnrecordedAttempt();
  }

  // E31 R63 — EXACTLY ONE BOUND IS RECORDING: ALLOW THE LOGIN. The surviving bound still limits guessing, and
  // refusing here would lock every clinician out of the encounter assistant for a partial fault. The unrecorded
  // SUCCESS is logged (and, for the counter, audited) in recordSuccessfulAttempt. Do not re-add a refusal here to
  // "match" the failure path, and do not widen the refusal above to cover this case.
  if (reset.kind === "reset_not_recorded")
    console.error("[auth/pin] session issued with the lockout counter NOT reset:",
      JSON.stringify({ doctor_id: doctor.id, audited: reset.audited }));
  if (reset.kind === "attempt_not_recorded")
    console.warn("[auth/pin] session issued with the rate limiter's pin_attempt row NOT recorded:",
      JSON.stringify({ doctor_id: doctor.id }));
  const jwt = await signDoctorJwt({ doctor_id: doctor.id, slug: doctor.url_slug });
  await setDoctorCookie(jwt, doctor.url_slug);

  return NextResponse.json({
    ok: true,
    doctor: { id: doctor.id, full_name: doctor.full_name, url_slug: doctor.url_slug },
  });
}

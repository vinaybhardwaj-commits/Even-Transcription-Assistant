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

  // PIN correct — reset counter + issue session
  await recordSuccessfulAttempt(lockState, ip, userAgent);
  const jwt = await signDoctorJwt({ doctor_id: doctor.id, slug: doctor.url_slug });
  await setDoctorCookie(jwt, doctor.url_slug);

  return NextResponse.json({
    ok: true,
    doctor: { id: doctor.id, full_name: doctor.full_name, url_slug: doctor.url_slug },
  });
}

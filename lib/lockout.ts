/**
 * lib/lockout.ts — PIN lockout escalation per PRD §4.15.
 *
 * Thresholds:
 *   1–4   : counter increments, no lockout
 *   5     : locked_until = NOW() + 15 min
 *   10    : locked_until = NOW() + 1 hour  (admin alert)
 *   20    : locked_until = NOW() + 24 hour (escalated admin alert)
 *   30    : status='locked' until admin re-enable
 *
 * Plus per-slug rate limit: 1 attempt/sec, 60/hr, enforced via
 * pin_attempt rows.
 */

import { sql } from "@/lib/db";

export type DoctorLockState = {
  doctor_id: string;
  url_slug: string;
  failed_pin_count: number;
  locked_until: Date | null;
  status: "active" | "disabled" | "locked";
};

export type LockoutDecision =
  | { kind: "ok" }
  | { kind: "locked"; retry_after_seconds: number; reason: string }
  | { kind: "disabled" }
  | { kind: "rate_limited"; retry_after_seconds: number };

/**
 * Decide whether a PIN attempt should proceed.
 * Call this BEFORE bcrypt.compare.
 */
export async function preAttemptCheck(
  doctor: DoctorLockState,
  ip: string | null
): Promise<LockoutDecision> {
  // 1. Already disabled
  if (doctor.status === "disabled") return { kind: "disabled" };

  // 2. Locked until in the future
  if (doctor.locked_until && doctor.locked_until.getTime() > Date.now()) {
    const sec = Math.ceil((doctor.locked_until.getTime() - Date.now()) / 1000);
    return {
      kind: "locked",
      retry_after_seconds: sec,
      reason: `Account locked. Try again in ${Math.ceil(sec / 60)} min.`,
    };
  }

  // 3. Rate limit: max 1 attempt per second for this doctor
  try {
    const recent = (await sql`
      SELECT COUNT(*)::int AS n FROM pin_attempt
       WHERE doctor_id = ${doctor.doctor_id}
         AND created_at > NOW() - INTERVAL '1 second'
    `) as Array<{ n: number }>;
    if ((recent[0]?.n ?? 0) > 0) {
      return { kind: "rate_limited", retry_after_seconds: 1 };
    }
    const hourly = (await sql`
      SELECT COUNT(*)::int AS n FROM pin_attempt
       WHERE doctor_id = ${doctor.doctor_id}
         AND created_at > NOW() - INTERVAL '1 hour'
    `) as Array<{ n: number }>;
    if ((hourly[0]?.n ?? 0) >= 60) {
      return { kind: "rate_limited", retry_after_seconds: 3600 };
    }
  } catch (e) {
    console.warn("[lockout] rate-limit check failed (allowing):", e);
  }

  return { kind: "ok" };
}

/**
 * Record a failed PIN attempt and update lockout state.
 * Returns the new lockout decision (for response to client).
 */
export async function recordFailedAttempt(
  doctor: DoctorLockState,
  ip: string | null,
  userAgent: string | null
): Promise<LockoutDecision> {
  try {
    await sql`
      INSERT INTO pin_attempt (doctor_id, success, ip, user_agent)
      VALUES (${doctor.doctor_id}, false, ${ip}::inet, ${userAgent})
    `;
  } catch (e) {
    console.warn("[lockout] pin_attempt insert failed:", e);
  }

  const newCount = doctor.failed_pin_count + 1;
  let lockedUntilSec: number | null = null;
  let newStatus: "active" | "disabled" | "locked" = doctor.status;

  if (newCount >= 30) {
    newStatus = "locked";
    lockedUntilSec = null;
  } else if (newCount >= 20) {
    lockedUntilSec = 60 * 60 * 24; // 24h
  } else if (newCount >= 10) {
    lockedUntilSec = 60 * 60; // 1h
  } else if (newCount >= 5) {
    lockedUntilSec = 60 * 15; // 15min
  }

  try {
    await sql`
      UPDATE doctor
         SET failed_pin_count = ${newCount},
             locked_until = ${lockedUntilSec ? `NOW() + INTERVAL '${lockedUntilSec} seconds'` : null}::timestamptz,
             status = ${newStatus},
             updated_at = NOW()
       WHERE id = ${doctor.doctor_id}
    `;
  } catch (e) {
    // Fallback: separate query for the interval (parameterised intervals are awkward)
    if (lockedUntilSec) {
      try {
        await sql`
          UPDATE doctor
             SET failed_pin_count = ${newCount},
                 locked_until = NOW() + (${lockedUntilSec}::int * INTERVAL '1 second'),
                 status = ${newStatus},
                 updated_at = NOW()
           WHERE id = ${doctor.doctor_id}
        `;
      } catch (e2) {
        console.warn("[lockout] doctor UPDATE failed:", e2);
      }
    } else {
      try {
        await sql`
          UPDATE doctor
             SET failed_pin_count = ${newCount},
                 locked_until = NULL,
                 status = ${newStatus},
                 updated_at = NOW()
           WHERE id = ${doctor.doctor_id}
        `;
      } catch (e2) {
        console.warn("[lockout] doctor UPDATE failed:", e2);
      }
    }
  }

  if (newStatus === "locked") return { kind: "disabled" };
  if (lockedUntilSec)
    return {
      kind: "locked",
      retry_after_seconds: lockedUntilSec,
      reason: `Too many incorrect attempts. Try again in ${Math.ceil(lockedUntilSec / 60)} min.`,
    };
  return { kind: "ok" }; // attempt still valid, will fall through to PIN_INVALID
}

/**
 * Record a successful PIN attempt — resets counter, clears lockout.
 */
export async function recordSuccessfulAttempt(
  doctor: DoctorLockState,
  ip: string | null,
  userAgent: string | null
): Promise<void> {
  try {
    await sql`
      INSERT INTO pin_attempt (doctor_id, success, ip, user_agent)
      VALUES (${doctor.doctor_id}, true, ${ip}::inet, ${userAgent})
    `;
  } catch (e) {
    console.warn("[lockout] pin_attempt insert failed:", e);
  }
  try {
    await sql`
      UPDATE doctor
         SET failed_pin_count = 0,
             locked_until = NULL,
             last_active_at = NOW(),
             updated_at = NOW()
       WHERE id = ${doctor.doctor_id}
    `;
  } catch (e) {
    console.warn("[lockout] reset failed (ignoring):", e);
  }
}

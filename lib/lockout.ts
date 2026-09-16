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

/** What the one statement above hands back — the only thing the decision may be computed from. */
type LockRow = { failed_pin_count: number; status: string; retry_after_seconds: number | null };

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
  // E31 D3 — SECURITY. THE DECISION IS WHAT THE DATABASE DID, NEVER WHAT WE INTENDED.
  //
  // This used to be an INSERT and up to three UPDATEs, every one of them in its own try/catch, and then a
  // decision computed from IN-MEMORY state: all three writes could fail and the caller was still told
  // {kind:"locked"} or {kind:"disabled"}. A lockout the caller believes is enforced, that the row does not
  // record, is not a lockout — the next attempt arrives against the old count and the old status.
  //
  // ONE STATEMENT, and the answer comes out of its RETURNING. The attempt row and the clinician update land
  // together or not at all, the update is conditional on the insert (EXISTS over the CTE), and the thresholds
  // are evaluated by the database against the row's OWN count rather than against a number this process read
  // earlier — which also closes the lost-update race two simultaneous wrong PINs used to have.
  //
  // IF IT THROWS, OR IF IT MATCHES NO ROW, WE DO NOT CLAIM A LOCK. The attempt is still refused by the caller
  // (kind "ok" falls through to PIN_INVALID); what we refuse to do is assert a lock nobody recorded.
  let row: LockRow | undefined;
  try {
    const rows = (await sql`
      WITH att AS (
        INSERT INTO pin_attempt (doctor_id, success, ip, user_agent)
        VALUES (${doctor.doctor_id}, false, ${ip}::inet, ${userAgent})
        RETURNING doctor_id
      )
      UPDATE clinician c
         SET failed_pin_count = c.failed_pin_count + 1,
             locked_until = CASE
               WHEN c.failed_pin_count + 1 >= 30 THEN NULL
               WHEN c.failed_pin_count + 1 >= 20 THEN NOW() + INTERVAL '24 hours'
               WHEN c.failed_pin_count + 1 >= 10 THEN NOW() + INTERVAL '1 hour'
               WHEN c.failed_pin_count + 1 >= 5  THEN NOW() + INTERVAL '15 minutes'
               ELSE NULL END,
             status = CASE WHEN c.failed_pin_count + 1 >= 30 THEN 'locked' ELSE c.status END,
             updated_at = NOW()
       WHERE c.id = ${doctor.doctor_id}
         AND EXISTS (SELECT 1 FROM att)
      RETURNING c.failed_pin_count AS failed_pin_count,
                c.status AS status,
                GREATEST(0, CEIL(EXTRACT(EPOCH FROM (c.locked_until - NOW()))))::int AS retry_after_seconds
    `) as LockRow[];
    row = rows[0];
  } catch (e) {
    // The whole unit failed, so nothing was recorded: say so loudly and claim nothing.
    console.error("[lockout] failed-attempt write failed — NO lock recorded, and none reported:",
      JSON.stringify({ doctor_id: doctor.doctor_id, err: String((e as Error)?.message ?? e).slice(0, 160) }));
    return { kind: "ok" };
  }

  if (!row) {
    // Zero rows: the clinician row was not there, or the insert produced nothing for the update to depend on.
    // Either way no count moved, so there is no lock to report.
    console.error("[lockout] failed-attempt write matched no row — NO lock recorded, and none reported:",
      JSON.stringify({ doctor_id: doctor.doctor_id }));
    return { kind: "ok" };
  }

  // From here every branch is read off the row the database returned.
  if (row.status === "locked") return { kind: "disabled" };
  const retry = Number(row.retry_after_seconds ?? 0);
  if (retry > 0) {
    return {
      kind: "locked",
      retry_after_seconds: retry,
      reason: `Too many incorrect attempts. Try again in ${Math.ceil(retry / 60)} min.`,
    };
  }
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
      UPDATE clinician
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

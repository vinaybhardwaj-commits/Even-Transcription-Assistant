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

/**
 * E31 R63 — THE TWO UNRECORDED WRITES ARE NOT THE SAME EVENT, AND THEY DO NOT GET THE SAME ANSWER.
 *
 * The security property is "an unrecorded FAILURE must not be ignored". It was never "an unrecorded SUCCESS must
 * be punished". A wrong pin whose counter write does not land is a guess nobody counted: refuse it, or a brute
 * force runs free while the clinician table is degraded. A correct pin whose reset does not land is a clinician
 * who knows their pin: refusing them locks every doctor out of the encounter assistant for as long as the
 * database is unwell, mid-clinic, to prevent nothing — the guesses that led up to it were counted or refused on
 * the failure path. The cost of allowing it is a stale counter, which the next reset that lands clears.
 *
 * So the two log lines are distinct, the two result types are distinct, and the route handles them apart. Do
 * not fold them back into one rule in either direction.
 */
export const LOG_FAILED_ATTEMPT_NOT_RECORDED = "[lockout] FAILED ATTEMPT NOT RECORDED — refusing";
export const LOG_RESET_NOT_RECORDED = "[lockout] CORRECT PIN, RESET NOT RECORDED — allowing the login";
/**
 * R64 — the audit row follows the live audit_log convention: actor namespaced and versioned (mcp:operator-v1),
 * action dotted and named after its precedent (install.poll_write_failed), target_type a snake_case noun,
 * metadata ids, counts and flags only. Column names are those of audit_log in db/migrations/0001_init.sql, which
 * no later migration alters; lib/jobs/audit-read.ts selects actor_id and renders it as `actor`.
 */
export const AUDIT_ACTOR_PIN_LOCKOUT = "auth:pin-lockout-v1";
export const AUDIT_PIN_RESET_WRITE_FAILED = "auth.pin_reset_write_failed";

/** What recordSuccessfulAttempt reports. Deliberately NOT a LockoutDecision: it carries no refusal. */
export type ResetOutcome =
  | { kind: "reset" }
  /** The counter could not be reset. The login is ALLOWED; `audited` says whether the audit row landed. */
  | { kind: "reset_not_recorded"; audited: boolean };

/** What the one statement above hands back — the only thing the decision may be computed from. */
type LockRow = { failed_pin_count: number; status: string; retry_after_seconds: number | null };

export type LockoutDecision =
  | { kind: "ok" }
  /**
   * E31 R58 — A FAILED ATTEMPT COULD NOT BE RECORDED. Not "wrong pin" and not "locked": the lockout counter did
   * not move, so the next attempt would arrive against the same count and the bound would never be reached. The
   * caller FAILS CLOSED on this — a pin attempt the system cannot account for is refused, not answered
   * PIN_INVALID, because answering PIN_INVALID is what let a brute force run un-counted while the clinician
   * table was degraded. Only recordFailedAttempt returns this. The success path has its own type (ResetOutcome)
   * and its own answer, on purpose — see R63 there.
   */
  | { kind: "not_recorded" }
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
  // E31 D3 — SECURITY. Two writes, TWO STATEMENTS, on purpose (R58, PRD ADDENDUM 1 / D-5).
  //
  // The first cure made these one CTE, and that was wrong for a reason no test caught: `pin_attempt` is TWO
  // THINGS. It is the lockout's counter AND it is the rate limiter's evidence — preAttemptCheck counts these
  // rows for its 1/sec and 60/hr gates. Binding the row to the clinician update put both in one failure domain,
  // so a degraded clinician table took the attempt row down with it: measured at 12 wrong pins under an
  // injected clinician failure, 0 rows survived and NOTHING throttled, where the two-statement shape kept 12
  // rows and answered rate_limited. Atomicity that merges two readers' failure domains disarms one of them
  // silently. The coupling-scope check (D-5) is why this stays uncollapsed.
  //
  // What the first cure got RIGHT and keeps: the clinician update is ONE statement with RETURNING, every
  // returned kind is read off the returned row, and the thresholds are evaluated by the database against the
  // row's OWN count (c.failed_pin_count + 1), which closes the lost-update race between simultaneous attempts.
  //
  // INDEPENDENT EVIDENCE FIRST, and it survives a clinician failure by construction: its own statement, its own
  // catch. A limiter that cannot see the attempt is worse than a counter that cannot move.
  try {
    await sql`
      INSERT INTO pin_attempt (doctor_id, success, ip, user_agent)
      VALUES (${doctor.doctor_id}, false, ${ip}::inet, ${userAgent})
    `;
  } catch (e) {
    // R64 — DELIBERATELY NOT A REFUSAL. If this row fails but the clinician counter below lands, the wrong pin is
    // still answered PIN_INVALID. The counter is the security-bearing record: it landed, so brute force is still
    // bounded by the lockout. Only the rate limiter loses one data point, and the limiter is defence in depth,
    // not the bound. Refusing here would re-create lockout-during-degradation (R63) for no security gain.
    console.warn("[lockout] pin_attempt insert failed (the rate limiter loses this row):", e);
  }

  let row: LockRow | undefined;
  try {
    const rows = (await sql`
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
      RETURNING c.failed_pin_count AS failed_pin_count,
                c.status AS status,
                GREATEST(0, CEIL(EXTRACT(EPOCH FROM (c.locked_until - NOW()))))::int AS retry_after_seconds
    `) as LockRow[];
    row = rows[0];
  } catch (e) {
    console.error(LOG_FAILED_ATTEMPT_NOT_RECORDED + " (the clinician UPDATE failed):",
      JSON.stringify({ doctor_id: doctor.doctor_id, err: String((e as Error)?.message ?? e).slice(0, 160) }));
    return { kind: "not_recorded" };
  }

  if (!row) {
    console.error(LOG_FAILED_ATTEMPT_NOT_RECORDED + " (the clinician UPDATE matched no row):",
      JSON.stringify({ doctor_id: doctor.doctor_id }));
    return { kind: "not_recorded" };
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
 *
 * E31 R63 — the reset is BEST-EFFORT FOR THE LOGIN and LOUD WHEN IT FAILS. A correct pin authenticates whether
 * or not the reset lands; if it does not, this says so on its own log line, writes an audit row if audit_log is
 * reachable, and returns reset_not_recorded so the route can tell. It never returns a refusal.
 */
export async function recordSuccessfulAttempt(
  doctor: DoctorLockState,
  ip: string | null,
  userAgent: string | null
): Promise<ResetOutcome> {
  try {
    await sql`
      INSERT INTO pin_attempt (doctor_id, success, ip, user_agent)
      VALUES (${doctor.doctor_id}, true, ${ip}::inet, ${userAgent})
    `;
  } catch (e) {
    console.warn("[lockout] pin_attempt insert failed:", e);
  }
  let failure: { reason: "threw"; err: string } | { reason: "zero_rows" } | null = null;
  try {
    const reset = (await sql`
      UPDATE clinician
         SET failed_pin_count = 0,
             locked_until = NULL,
             last_active_at = NOW(),
             updated_at = NOW()
       WHERE id = ${doctor.doctor_id}
      RETURNING id
    `) as Array<{ id: string }>;
    if (!reset[0]) failure = { reason: "zero_rows" };
  } catch (e) {
    failure = { reason: "threw", err: String((e as Error)?.message ?? e).slice(0, 160) };
  }
  if (!failure) return { kind: "reset" };

  console.error(LOG_RESET_NOT_RECORDED + ":",
    JSON.stringify({ doctor_id: doctor.doctor_id, stale_failed_pin_count: doctor.failed_pin_count, ...failure }));
  let audited = false;
  try {
    const rows = (await sql`
      INSERT INTO audit_log (actor_type, actor_id, action, target_type, target_id, metadata_json)
      VALUES ('system', ${AUDIT_ACTOR_PIN_LOCKOUT}, ${AUDIT_PIN_RESET_WRITE_FAILED}, 'doctor', ${doctor.doctor_id},
              ${JSON.stringify({ reason: failure.reason, stale_failed_pin_count: doctor.failed_pin_count })}::jsonb)
      RETURNING id
    `) as Array<{ id: unknown }>;
    audited = rows.length > 0;
  } catch (e) {
    console.error("[lockout] audit row for the unrecorded reset could not be written either:",
      JSON.stringify({ doctor_id: doctor.doctor_id, err: String((e as Error)?.message ?? e).slice(0, 160) }));
  }
  return { kind: "reset_not_recorded", audited };
}

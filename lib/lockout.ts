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
 * (E32 bounds that claim: "refused" bounds nothing unless something COUNTED the refusal. It holds only while at
 * least one of the two bounds still records — see the E32 block below.)
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

/**
 * E32 — NEVER ISSUE A SESSION WHILE NEITHER THE LOCKOUT COUNTER NOR THE RATE LIMITER IS RECORDING.
 *
 * Brute force has exactly two bounds: the lockout counter (clinician.failed_pin_count) and the rate limiter's
 * evidence (pin_attempt rows). R63 above is right while at least one of them records. It is wrong when NEITHER
 * does — a database that refuses writes but still serves reads (storage quota, read-only failover). The pin
 * comparison is a read, so it still works; every wrong guess is refused, but nothing counts it, so nothing stops
 * the next one, and the correct pin is simply the guess that wins. The Refuter measured it: 80 wrong pins, then
 * the correct one, and a session. Refusing a wrong pin is no defence, because a wrong pin never authenticates
 * anyway. The only thing left to refuse is the session. This was present identically before E31.
 *
 * So the success path has THREE states, and they must stay three:
 *   BOTH recording            → `reset`                 — normal.
 *   EXACTLY ONE recording     → `reset_not_recorded`    — counter down, limiter up: ALLOW (the limiter bounds it)
 *                               `attempt_not_recorded`  — limiter down, counter up: ALLOW (the lockout bounds it)
 *                               A clinician must not be locked out of the encounter assistant by a partial fault.
 *   NEITHER recording         → `no_bound_recording`    — REFUSE, even though the pin is correct.
 *
 * WHY REFUSING THE CORRECT PIN IN THE TOTAL CASE COSTS THE CLINICIAN NOTHING: if no write lands anywhere, no
 * encounter can be recorded, transcribed or saved either. A session would open an assistant that cannot write a
 * single row. Refusing it denies nothing the clinician could have used, and it is the only bound left.
 *
 * Folding NEITHER into EXACTLY ONE re-opens the brute force. Folding EXACTLY ONE into NEITHER re-creates
 * lockout-during-degradation (R63). Folding EXACTLY ONE into BOTH hides a blind bound. Each is a named test.
 */
export const LOG_ATTEMPT_ROW_NOT_RECORDED =
  "[lockout] CORRECT PIN, pin_attempt NOT RECORDED — allowing the login (the lockout counter still records)";
export const LOG_NO_BOUND_RECORDING =
  "[lockout] CORRECT PIN, NEITHER THE LOCKOUT COUNTER NOR THE RATE LIMITER IS RECORDING — refusing the session";
export const AUDIT_PIN_SESSION_REFUSED_NO_BOUND = "auth.pin_session_refused_no_bound";

/**
 * E32b — THE TWO REFUSALS DO THE SAME AMOUNT OF WORK.
 *
 * The client cannot tell the wrong-pin refusal (not_recorded) from the correct-pin refusal (no_bound_recording):
 * one response, byte for byte. It could still tell them apart by TIME. Under a total write failure the correct pin
 * attempted three writes (pin_attempt, clinician, audit_log) and the wrong pin two, so the right guess was the one
 * that took a database round trip longer — and the attacker waits for writes to come back and uses it.
 *
 * The cure is symmetry, not deletion: the correct-pin audit row is the operator's only evidence that a session was
 * refused, so it stays, and the wrong-pin refusal attempts its own audit row. Both paths now attempt the same three
 * writes. It also means a brute force during a write outage leaves an audit trail, where before only the one guess
 * that won wrote anything. Do not drop either audit write, and do not add a write to one path without the other.
 */
export const AUDIT_PIN_ATTEMPT_REFUSED_UNRECORDED = "auth.pin_attempt_refused_unrecorded";

/** Why a write did not land. A closed code, so it can go into audit metadata. */
type WriteMiss = { reason: "threw"; err: string } | { reason: "zero_rows" };

/** What recordSuccessfulAttempt reports. Not a LockoutDecision: its one refusal is E32's, not the failure path's. */
export type ResetOutcome =
  | { kind: "reset" }
  /** The counter could not be reset; the limiter's row landed. ALLOWED; `audited` says whether the audit row landed. */
  | { kind: "reset_not_recorded"; audited: boolean }
  /** The limiter's row did not land; the counter reset did. ALLOWED. */
  | { kind: "attempt_not_recorded" }
  /** NEITHER landed. The route REFUSES the session (E32). `audited` says whether the audit row landed. */
  | { kind: "no_bound_recording"; audited: boolean };

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
   * and its own answer, on purpose — see R63 there. `audited` says whether the E32b audit row landed.
   */
  | { kind: "not_recorded"; audited: boolean }
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
    // E32b — RETURNING id, so this is the success path's statement and the two refusals send the same INSERT. The
    // result is read only to be logged: under R64 below, a pin_attempt miss on this path is never a refusal.
    const rows = (await sql`
      INSERT INTO pin_attempt (doctor_id, success, ip, user_agent)
      VALUES (${doctor.doctor_id}, false, ${ip}::inet, ${userAgent})
      RETURNING id
    `) as Array<{ id: unknown }>;
    if (rows.length === 0)
      console.warn("[lockout] pin_attempt insert landed no row (the rate limiter loses this row):",
        JSON.stringify({ doctor_id: doctor.doctor_id }));
  } catch (e) {
    // R64 — DELIBERATELY NOT A REFUSAL. If this row fails but the clinician counter below lands, the wrong pin is
    // still answered PIN_INVALID. The counter is the security-bearing record: it landed, so brute force is still
    // bounded by the lockout. Only the rate limiter loses one data point, and the limiter is defence in depth,
    // not the bound. Refusing here would re-create lockout-during-degradation (R63) for no security gain.
    console.warn("[lockout] pin_attempt insert failed (the rate limiter loses this row):", e);
  }

  let row: LockRow | undefined;
  let counterMiss: WriteMiss | null = null;
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
    if (!row) {
      counterMiss = { reason: "zero_rows" };
      console.error(LOG_FAILED_ATTEMPT_NOT_RECORDED + " (the clinician UPDATE matched no row):",
        JSON.stringify({ doctor_id: doctor.doctor_id }));
    }
  } catch (e) {
    counterMiss = { reason: "threw", err: String((e as Error)?.message ?? e).slice(0, 160) };
    console.error(LOG_FAILED_ATTEMPT_NOT_RECORDED + " (the clinician UPDATE failed):",
      JSON.stringify({ doctor_id: doctor.doctor_id, err: counterMiss.err }));
  }

  // E32b — BOTH not_recorded exits (a throw AND zero rows) attempt the audit row, so this refusal attempts the same
  // writes as the correct-pin refusal (see above AUDIT_PIN_ATTEMPT_REFUSED_UNRECORDED). Closed codes and a count.
  if (!row) {
    const audited = await auditPinLockout(AUDIT_PIN_ATTEMPT_REFUSED_UNRECORDED, doctor.doctor_id, {
      reason: counterMiss?.reason ?? "zero_rows",
      stale_failed_pin_count: doctor.failed_pin_count,
    });
    return { kind: "not_recorded", audited };
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
 * E31 R63 — the reset is BEST-EFFORT FOR THE LOGIN and LOUD WHEN IT FAILS, while the rate limiter still records.
 * E32 — and the two bounds are each checked for having LANDED, because the answer depends on how many did (see
 * the three states above ResetOutcome). A write has landed only if the database hands its row back: a throw is a
 * miss, and so is zero rows.
 */
export async function recordSuccessfulAttempt(
  doctor: DoctorLockState,
  ip: string | null,
  userAgent: string | null
): Promise<ResetOutcome> {
  // BOUND 1 — the rate limiter's evidence. Its own statement, as on the failure path (D-5).
  let attemptMiss: WriteMiss | null = null;
  try {
    const rows = (await sql`
      INSERT INTO pin_attempt (doctor_id, success, ip, user_agent)
      VALUES (${doctor.doctor_id}, true, ${ip}::inet, ${userAgent})
      RETURNING id
    `) as Array<{ id: unknown }>;
    if (rows.length === 0) attemptMiss = { reason: "zero_rows" };
  } catch (e) {
    attemptMiss = { reason: "threw", err: String((e as Error)?.message ?? e).slice(0, 160) };
  }

  // BOUND 2 — the lockout counter.
  let resetMiss: WriteMiss | null = null;
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
    if (!reset[0]) resetMiss = { reason: "zero_rows" };
  } catch (e) {
    resetMiss = { reason: "threw", err: String((e as Error)?.message ?? e).slice(0, 160) };
  }

  // BOTH RECORDING — normal.
  if (!attemptMiss && !resetMiss) return { kind: "reset" };

  // EXACTLY ONE RECORDING — ALLOW. The lockout counter landed, so the lockout still bounds guessing.
  if (attemptMiss && !resetMiss) {
    console.warn(LOG_ATTEMPT_ROW_NOT_RECORDED + ":", JSON.stringify({ doctor_id: doctor.doctor_id, ...attemptMiss }));
    return { kind: "attempt_not_recorded" };
  }

  // EXACTLY ONE RECORDING — ALLOW (R63). The limiter's row landed, so the 1/sec and 60/hr gates still bound it.
  if (!attemptMiss && resetMiss) {
    console.error(LOG_RESET_NOT_RECORDED + ":",
      JSON.stringify({ doctor_id: doctor.doctor_id, stale_failed_pin_count: doctor.failed_pin_count, ...resetMiss }));
    const audited = await auditPinLockout(AUDIT_PIN_RESET_WRITE_FAILED, doctor.doctor_id,
      { reason: resetMiss.reason, stale_failed_pin_count: doctor.failed_pin_count });
    return { kind: "reset_not_recorded", audited };
  }

  // NEITHER RECORDING — REFUSE THE SESSION (E32). Nothing bounds the next guess, so the correct pin is the only
  // thing left to refuse. The audit row is attempted: a database that refuses clinician and pin_attempt writes
  // may still take audit_log, and if it does not, this line and `audited: false` are the evidence.
  console.error(LOG_NO_BOUND_RECORDING + ":",
    JSON.stringify({ doctor_id: doctor.doctor_id, attempt: attemptMiss, reset: resetMiss }));
  const audited = await auditPinLockout(AUDIT_PIN_SESSION_REFUSED_NO_BOUND, doctor.doctor_id, {
    attempt_reason: attemptMiss!.reason,
    reset_reason: resetMiss!.reason,
    stale_failed_pin_count: doctor.failed_pin_count,
  });
  return { kind: "no_bound_recording", audited };
}

/** R64 convention: metadata is closed codes and counts only — never a pin, a name, a slug or free text. */
async function auditPinLockout(
  action: string,
  doctorId: string,
  metadata: Record<string, string | number>,
): Promise<boolean> {
  try {
    const rows = (await sql`
      INSERT INTO audit_log (actor_type, actor_id, action, target_type, target_id, metadata_json)
      VALUES ('system', ${AUDIT_ACTOR_PIN_LOCKOUT}, ${action}, 'doctor', ${doctorId},
              ${JSON.stringify(metadata)}::jsonb)
      RETURNING id
    `) as Array<{ id: unknown }>;
    return rows.length > 0;
  } catch (e) {
    console.error("[lockout] audit row could not be written either:",
      JSON.stringify({ doctor_id: doctorId, action, err: String((e as Error)?.message ?? e).slice(0, 160) }));
    return false;
  }
}

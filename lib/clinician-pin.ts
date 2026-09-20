/**
 * lib/clinician-pin.ts — verify a clinician's PIN, through the ONE lockout state machine.
 *
 * WHY THIS EXISTS. `app/api/auth/pin/route.ts` holds the only PIN verification in the codebase and
 * it is a route handler: it cannot be called from another endpoint, and on success it MINTS A WEB
 * SESSION. A recorder attesting a sitting must not acquire a clinician's browser session as a side
 * effect, so calling that route was not an option.
 *
 * WHAT IS REUSED IS THE PART WITH THE HISTORY. `preAttemptCheck`, `recordFailedAttempt` and
 * `recordSuccessfulAttempt` (lib/lockout.ts) are the rate limit, the lockout escalation and the
 * three-state reset that E31/E32 hardened — including the rule that a lockout is NEVER reported
 * unless the row records it, and that an attempt the counter could not record is refused rather
 * than answered. None of that is re-implemented here; it is called.
 *
 * WHAT IS NOT REUSED, AND IS A FLAG FOR THE REPORT. The bcrypt comparison itself now exists in two
 * places: here and in that route. Removing the duplicate means refactoring a security path that was
 * refuted SOUND and whose branch structure (E32's refusal symmetry) is pinned by its own tests —
 * a change that deserves its own brief and its own refutation, not a quiet edit inside this one.
 *
 * THE HASH PATH ONLY. This module reads `pin_hash` and nothing else. `clinician.pin_plaintext`
 * exists and is populated for most clinicians; it is never read, logged, compared or selected here.
 *
 * NEVER LOGS A PIN. No function in this file puts the submitted value into a message, an error, an
 * audit row or a console line — not on success, not on failure, not in a thrown exception.
 */
import bcrypt from "bcryptjs";
import { sql } from "@/lib/db";
import {
  preAttemptCheck,
  recordFailedAttempt,
  recordSuccessfulAttempt,
  type DoctorLockState,
} from "@/lib/lockout";

/** Every way a PIN presentation can end. Each is NAMED; none of them is a silent pass. */
export type PinVerdict =
  | { kind: "ok"; clinician_id: string }
  /** The clinician slug matched nothing live. Deliberately the same answer shape as a wrong PIN. */
  | { kind: "unknown_clinician" }
  /** No PIN has ever been set for this clinician. */
  | { kind: "pin_not_set" }
  /** Wrong PIN, and the attempt WAS recorded against the counter. */
  | { kind: "pin_invalid"; attempts_remaining: number }
  /** Wrong PIN, and the counter could not record it — refused, never answered as merely invalid. */
  | { kind: "not_recorded" }
  | { kind: "locked"; reason: string; retry_after_seconds: number }
  | { kind: "rate_limited"; retry_after_seconds: number }
  | { kind: "disabled" }
  /** The lookup or the comparison itself failed. Never reports anything about the PIN. */
  | { kind: "unavailable"; detail: string };

type ClinicianRow = {
  id: string;
  url_slug: string;
  pin_hash: string | null;
  failed_pin_count: number;
  /** Neon HTTP hands timestamps back as ISO strings; `preAttemptCheck` compares Dates. */
  locked_until: string | null;
  status: DoctorLockState["status"];
};

/**
 * Verify a PIN for one clinician, by slug, with the full lockout sequence around it.
 *
 * `ip` and `userAgent` are passed through to the limiter and the audit row exactly as the web path
 * passes them, so a recorder's attempts are counted in the same ledger as a browser's. A brute
 * force that moved to the recorder must not get a fresh budget.
 */
export async function verifyClinicianPin(input: {
  clinicianSlug: string;
  pin: string;
  ip: string;
  userAgent: string;
}): Promise<PinVerdict> {
  const slug = input.clinicianSlug.trim();
  if (!slug || !/^\d{4}$/.test(input.pin)) return { kind: "unknown_clinician" };

  let row: ClinicianRow | undefined;
  try {
    const rows = (await sql`
      SELECT id, url_slug, pin_hash, failed_pin_count, locked_until, status::text AS status
        FROM clinician
       WHERE url_slug = ${slug} AND deleted_at IS NULL
       LIMIT 1
    `) as ClinicianRow[];
    row = rows[0];
  } catch (e) {
    return { kind: "unavailable", detail: String(e).slice(0, 200) };
  }
  if (!row) return { kind: "unknown_clinician" };
  if (!row.pin_hash) return { kind: "pin_not_set" };

  const lockState: DoctorLockState = {
    doctor_id: row.id,
    url_slug: row.url_slug,
    failed_pin_count: row.failed_pin_count,
    // ISO string in, Date out — the Neon HTTP driver never returns a Date and the limiter reads
    // `.getTime()`. Converting here rather than at each call site is the whole point of one door.
    locked_until: row.locked_until ? new Date(row.locked_until) : null,
    status: row.status,
  };

  const pre = await preAttemptCheck(lockState, input.ip);
  if (pre.kind === "disabled") return { kind: "disabled" };
  if (pre.kind === "locked") {
    return { kind: "locked", reason: pre.reason, retry_after_seconds: pre.retry_after_seconds };
  }
  if (pre.kind === "rate_limited") {
    return { kind: "rate_limited", retry_after_seconds: pre.retry_after_seconds };
  }

  let pinOk = false;
  try {
    pinOk = await bcrypt.compare(input.pin, row.pin_hash);
  } catch (e) {
    // The message never carries the submitted value — only that the comparison failed.
    return { kind: "unavailable", detail: `pin_compare_failed: ${String(e).slice(0, 120)}` };
  }

  if (!pinOk) {
    const next = await recordFailedAttempt(lockState, input.ip, input.userAgent);
    // FAIL CLOSED, exactly as the web path does: an attempt the counter did not record must not be
    // answered as an ordinary wrong PIN, or a brute force runs un-counted while the table is down.
    if (next.kind === "not_recorded") return { kind: "not_recorded" };
    if (next.kind === "disabled") return { kind: "disabled" };
    if (next.kind === "locked") {
      return { kind: "locked", reason: next.reason, retry_after_seconds: next.retry_after_seconds };
    }
    return { kind: "pin_invalid", attempts_remaining: Math.max(0, 5 - (row.failed_pin_count + 1)) };
  }

  // Correct PIN. The reset is still three states; an attestation is not a login, so a partial
  // failure here does not refuse the sitting — the PIN WAS verified, and the caller records that.
  await recordSuccessfulAttempt(lockState, input.ip, input.userAgent);
  return { kind: "ok", clinician_id: row.id };
}

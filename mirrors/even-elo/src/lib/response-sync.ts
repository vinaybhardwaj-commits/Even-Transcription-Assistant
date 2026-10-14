/**
 * src/lib/response-sync.ts — forward a doctor's document-audit response to CDMSS (Round 2 / F3).
 *
 * A document-audit finding that CDMSS routed carries a `signal_reference` (EHRC-AUD-…). The doctor's
 * answer used to stay in EPI; CDMSS never learned the thread had been answered, so it stayed
 * "awaiting the doctor" and went overdue. Now the answer is POSTed to /api/governance/doctor-response.
 *
 * ⚠️ NEVER BLOCK OR FAIL THE DOCTOR'S SUBMIT. The local response is committed first. This module then
 * makes ONE short attempt (a few seconds) and records the result; every failure is a stored state,
 * not an exception. The nightly document-audit cron retries what is left.
 *
 * State per finding (document_audit_findings.cdmss_sync_*):
 *   pending  recorded locally, not yet delivered
 *   synced   CDMSS accepted it (a replay of the same answer is also a success)
 *   failed   the last attempt failed; `cdmss_sync_error` says why
 *   legacy   answered before forwarding existed (migration 040 marks every such response). NEVER
 *            forwarded: replaying history would escalate live threads and write calibration rows.
 *            Only responses recorded after the deploy are sent.
 *   `cdmss_sync_permanent` marks a failure a retry cannot fix (CDMSS refused the answer: 400 / 403 /
 *   404, or 409 because the thread was already answered differently or is closed). Those are shown to
 *   staff and never retried. Transport errors, 429 and 5xx are retried, up to MAX_ATTEMPTS.
 *
 * The request id is `elo-daf-<finding id>`, stable, so every retry is a replay upstream.
 */

import { sql } from "@/lib/db";
import { postDoctorResponse, upstreamError, type CatOutcome } from "@/lib/cdmss-governance";

export const MAX_ATTEMPTS = 8;
export const INLINE_TIMEOUT_MS = 3500;
export const RETRY_BATCH = 40;

export type SyncState = "pending" | "synced" | "failed";

/** Wall-clock budget for one retry run (the cron's maxDuration is 300 s). */
export const RETRY_BUDGET_MS = 240_000;
export const RETRY_CALL_TIMEOUT_MS = 15_000;

export interface SyncVerdict {
  state: "synced" | "failed";
  permanent: boolean;
  error: string | null;
}

/** PURE. A CDMSS answer -> what to store. */
export function classifySync(o: CatOutcome): SyncVerdict {
  if (o.kind === "transport") return { state: "failed", permanent: false, error: "CDMSS unreachable (timeout or network)" };
  if (o.status === 200) {
    const ok = (o.body as { ok?: boolean } | null)?.ok;
    if (ok === false) return { state: "failed", permanent: false, error: "CDMSS answered 200 with ok:false" };
    return { state: "synced", permanent: false, error: null };
  }
  const text = upstreamError(o.body);
  const detail = `CDMSS ${o.status}${text ? `: ${text}` : ""}`.slice(0, 300);
  if (o.status === 409) return { state: "failed", permanent: true, error: detail };
  if (o.status === 400 || o.status === 403 || o.status === 404) return { state: "failed", permanent: true, error: detail };
  // 401 means our key is wrong (an ops fix, then a retry works), 429 and 5xx are transient.
  return { state: "failed", permanent: false, error: detail };
}

export function syncRequestId(findingId: string): string {
  return `elo-daf-${findingId}`;
}

interface SyncRow {
  id: string;
  signal_reference: string | null;
  doctor_response_verb: string | null;
  doctor_response_comment: string | null;
  cdmss_doctor_uid: string | null;
  cdmss_sync_attempts: number | null;
}

/**
 * Mark a just-recorded response as owing delivery. Separate from the response UPDATE on purpose: if
 * migration 038 is not applied yet this throws and is swallowed, and the doctor's answer still stands.
 * Returns whether the finding is one CDMSS routed.
 */
export async function markResponseForSync(findingId: string): Promise<boolean> {
  try {
    const rows = (await sql`
      UPDATE document_audit_findings
      SET cdmss_sync_state = 'pending', cdmss_sync_error = NULL, cdmss_sync_attempts = 0, cdmss_sync_permanent = false
      WHERE id = ${findingId}::uuid
        AND doctor_responded_at IS NOT NULL
        AND coalesce(btrim(signal_reference), '') <> ''
        AND coalesce(response_owner, '') <> 'pipe_a'
      RETURNING id::text AS id`) as unknown as Array<{ id: string }>;
    return rows.length > 0;
  } catch {
    return false;
  }
}

async function loadRow(findingId: string): Promise<SyncRow | null> {
  const rows = (await sql`
    SELECT f.id::text AS id, f.signal_reference, f.doctor_response_verb, f.doctor_response_comment,
           p.cdmss_doctor_uid, f.cdmss_sync_attempts
    FROM document_audit_findings f
    LEFT JOIN physicians p ON p.id = f.physician_id
    WHERE f.id = ${findingId}::uuid AND f.doctor_responded_at IS NOT NULL`) as unknown as SyncRow[];
  return rows[0] ?? null;
}

/** One delivery attempt for one finding. Never throws. */
export async function syncFindingResponse(
  findingId: string,
  opts: { timeoutMs?: number } = {},
): Promise<{ state: SyncState; error: string | null; permanent: boolean }> {
  try {
    const row = await loadRow(findingId);
    if (!row || !row.signal_reference || !row.doctor_response_verb) return { state: "pending", error: null, permanent: false };
    const out = await postDoctorResponse({
      reference: row.signal_reference.trim(),
      // The physician's canonical uid, never the audit's: an audit can carry a retired alias uid, which
      // CDMSS answers with 403 (and we would then mark permanent). Null omits the field; the reference
      // already identifies the thread.
      doctorUid: row.cdmss_doctor_uid,
      verb: row.doctor_response_verb,
      comment: row.doctor_response_comment,
      clientRequestId: syncRequestId(row.id),
      timeoutMs: opts.timeoutMs,
    });
    const v = classifySync(out);
    await sql`
      UPDATE document_audit_findings
      SET cdmss_sync_state = ${v.state},
          cdmss_sync_error = ${v.error},
          cdmss_sync_permanent = ${v.permanent},
          cdmss_sync_attempts = coalesce(cdmss_sync_attempts, 0) + 1,
          cdmss_sync_at = now()
      WHERE id = ${row.id}::uuid`;
    return { state: v.state, error: v.error, permanent: v.permanent };
  } catch (e) {
    return { state: "failed", error: e instanceof Error ? e.message.slice(0, 200) : "sync failed", permanent: false };
  }
}

/**
 * Called from the doctor's respond route AFTER the local response is saved. One bounded attempt;
 * the caller ignores the result.
 */
export async function forwardResponseNow(findingId: string): Promise<void> {
  try {
    if (!(await markResponseForSync(findingId))) return;
    await syncFindingResponse(findingId, { timeoutMs: INLINE_TIMEOUT_MS });
  } catch {
    // Never surfaces to the doctor.
  }
}

export interface RetrySummary {
  attempted: number;
  synced: number;
  failed: number;
  permanent: number;
  skipped_reason?: string;
  /** The run stopped early because its time budget was spent; what is left waits for the next night. */
  stopped_reason?: "time_budget";
}

/**
 * Nightly retry. Picks up responses recorded after the deploy that are still 'pending' or 'failed'
 * (never 'legacy', never rows with no state at all), oldest first. Safe to run any number of times.
 * Stops when `deadline` (default: now + 240 s) is spent; each call is cut to what is left of it.
 */
export async function retryResponseSyncs(
  opts: { limit?: number; deadline?: number; now?: () => number } = {},
): Promise<RetrySummary> {
  const now = opts.now ?? Date.now;
  const deadline = opts.deadline ?? now() + RETRY_BUDGET_MS;
  const limit = opts.limit ?? RETRY_BATCH;
  let ids: string[] = [];
  try {
    const rows = (await sql`
      SELECT f.id::text AS id
      FROM document_audit_findings f
      WHERE f.doctor_responded_at IS NOT NULL
        AND coalesce(btrim(f.signal_reference), '') <> ''
        AND coalesce(f.response_owner, '') <> 'pipe_a'
        AND coalesce(f.cdmss_sync_permanent, false) = false
        AND coalesce(f.cdmss_sync_attempts, 0) < ${MAX_ATTEMPTS}
        AND f.cdmss_sync_state IN ('pending', 'failed')
      ORDER BY f.doctor_responded_at ASC
      LIMIT ${limit}`) as unknown as Array<{ id: string }>;
    ids = rows.map((r) => r.id);
  } catch (e) {
    return { attempted: 0, synced: 0, failed: 0, permanent: 0, skipped_reason: e instanceof Error ? e.message.slice(0, 120) : "query failed" };
  }
  const summary: RetrySummary = { attempted: 0, synced: 0, failed: 0, permanent: 0 };
  for (const id of ids) {
    const left = deadline - now();
    if (left <= 0) {
      summary.stopped_reason = "time_budget";
      break;
    }
    summary.attempted += 1;
    const r = await syncFindingResponse(id, { timeoutMs: Math.min(RETRY_CALL_TIMEOUT_MS, left) });
    if (r.state === "synced") summary.synced += 1;
    else {
      summary.failed += 1;
      if (r.permanent) summary.permanent += 1;
    }
  }
  return summary;
}

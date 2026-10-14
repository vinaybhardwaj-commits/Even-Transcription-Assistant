import { NextRequest } from "next/server";
import { portalJson } from "@/lib/portal/forbidden-keys";
import { randomUUID } from "node:crypto";
import { getCurrentPhysician } from "@/lib/physician-auth";
import { sql } from "@/lib/db";
import { disabledWrite, respondEnabled } from "@/lib/portal-flags";
import { toResponseState } from "@/lib/doctor-card";
import { friendlyError } from "@/lib/finding-labels";
import { callResponse, mapRespondOutcome, parseRespondBody } from "@/lib/findings-actions";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * POST /api/portal/findings/respond — WM2 v1: send the workflow response a finding asked for.
 *
 * ⚠️ THIS ONE LEAVES THE BUILDING. Unlike ../react, a response goes to the care manager, moves the
 * signal's status, and cannot be revised from the portal afterwards. The card says that in words
 * before the doctor presses anything, and `already_responded` says it again if they try twice.
 *
 * ⚠️ THE CLIENT NEVER NAMES A DOCTOR. `cdmss_doctor_uid` is looked up from the session's physician
 * id, and only signal_id, verb and comment are accepted from the body. The BFF creates the
 * client_request_id and sends it as both the payload field and Idempotency-Key.
 *
 * ⚠️ NOTHING FROM THE CDMSS BODY IS FORWARDED. CDMSS answers with a governance signal (uid, triage,
 * ruling, importance, possibly a null representative). The answer here is `{ ok, state }` where
 * `state` is `toResponseState(body)`: the new status and the recorded response (verb, comment,
 * time) and nothing else. If CDMSS sent no response, the doctor's own submission stands in for it.
 * The browser MERGES `state` into the card it already holds; it never replaces the card.
 *
 * ⚠️ ALWAYS HTTP 200 (except 401). See ../react for why.
 *
 * ⚠️ INFERRED SQL: this sandbox has no live database. Both queries below are listed verbatim in the
 * ship report. The lookup mirrors ../route.ts; the audit insert mirrors ../../auth/login/route.ts.
 */

export async function POST(request: NextRequest) {
  const p = await getCurrentPhysician();
  if (!p) return portalJson({ ok: false, error: "Unauthorized" }, { status: 401 });
  if (!respondEnabled()) return disabledWrite();

  let uid: string | null = null;
  try {
    const rows = (await sql`
      SELECT cdmss_doctor_uid FROM physicians WHERE id=${p.physicianId}::uuid`) as unknown as Array<{
      cdmss_doctor_uid: string | null;
    }>;
    uid = rows[0]?.cdmss_doctor_uid ?? null;
  } catch {
    uid = null;
  }
  if (!uid) return portalJson({ ok: false, error: "unmapped", message: friendlyError("unmapped") });

  const parsed = parseRespondBody(await request.json().catch(() => null));
  if (!parsed.ok) {
    // The parser's own wording is for developers; the doctor gets a plain sentence.
    return portalJson({ ok: false, error: "invalid", message: friendlyError("invalid") });
  }
  const { signalId, verb, comment } = parsed;
  const clientRequestId = randomUUID();

  const result = mapRespondOutcome(
    await callResponse({
      signalId,
      doctorUid: uid,
      verb,
      comment,
      clientRequestId,
    }),
  );

  if (!result.ok) {
    // `message` is a plain sentence; CDMSS's own error text is never relayed to a physician.
    return portalJson({ ok: false, error: result.error, message: friendlyError(result.error) });
  }

  // The response is recorded upstream; this row is the portal's record of it. Best-effort, same as
  // the login route. The COMMENT IS DELIBERATELY ABSENT: a doctor's explanation is clinical prose
  // that belongs in the governance thread it was written for, not copied into an audit log.
  try {
    await sql`INSERT INTO audit_log_v2 (action, entity_type, entity_id, after_json)
              VALUES ('portal_response', 'physician', ${p.physicianId},
              ${JSON.stringify({ signal_id: signalId, verb })}::jsonb)`;
  } catch {
    // Intentionally ignored: see above.
  }

  const state = toResponseState(result.signal);
  if (!state.response) {
    // Upstream said yes but sent no readable response: the doctor's own submission is the record.
    state.response = { verb, comment, at: new Date().toISOString() };
  }
  return portalJson({ ok: true, state });
}

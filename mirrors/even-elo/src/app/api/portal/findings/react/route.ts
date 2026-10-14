import { NextRequest } from "next/server";
import { portalJson } from "@/lib/portal/forbidden-keys";
import { getCurrentPhysician } from "@/lib/physician-auth";
import { sql } from "@/lib/db";
import { disabledWrite, reactionsEnabled } from "@/lib/portal-flags";
import { callReaction, mapReactOutcome, parseReactBody } from "@/lib/findings-actions";
import { friendlyError } from "@/lib/finding-labels";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * POST /api/portal/findings/react — WM2 v1: record this doctor's PRIVATE reaction to one finding.
 *
 * ⚠️ PRIVATE MEANS PRIVATE. This notifies nobody. It does not change the signal's status, does not
 * reach the care manager, and is not the workflow response — that is ../respond. The card says so
 * above the buttons, and this route must never grow a side effect that makes the card's promise
 * false.
 *
 * ⚠️ THE CLIENT NEVER NAMES A DOCTOR. The body is exactly `{ signal_id, reaction }` and a body with
 * any other key is refused outright, rather than ignored. Ignoring extra keys is how a
 * `doctor_uid` in a request eventually gets read by a later edit; refusing them makes that edit
 * fail a test instead. Both identities are server-side: `physician_id` comes from the session JWT,
 * `cdmss_doctor_uid` from the physicians table.
 *
 * ⚠️ ALWAYS HTTP 200 (except 401). A doctor pressed a button; they are owed a sentence, not a
 * status code. Every CDMSS answer and every transport failure is mapped to one word in the body
 * and the card turns that word into the sentence. The one exception is "not signed in", which is
 * the browser's problem to solve, not the doctor's.
 *
 * ⚠️ INFERRED SQL: this sandbox has no live database. Both queries below are listed verbatim in the
 * ship report. The lookup mirrors ../route.ts; the audit insert mirrors ../../auth/login/route.ts.
 */

export async function POST(request: NextRequest) {
  const p = await getCurrentPhysician();
  if (!p) return portalJson({ ok: false, error: "Unauthorized" }, { status: 401 });
  if (!reactionsEnabled()) return disabledWrite();

  // Same fail-safe as the findings GET: a lookup that throws lands on UNMAPPED rather than a 500.
  // Unmapped hides the reaction row, which is the right outcome whenever we cannot establish the
  // CDMSS identity — whatever the cause.
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

  const parsed = parseReactBody(await request.json().catch(() => null));
  if (!parsed.ok) {
    return portalJson({ ok: false, error: "invalid", message: friendlyError("invalid") });
  }
  const { signalId, reaction } = parsed;

  const result = mapReactOutcome(
    await callReaction({ signalId, physicianId: p.physicianId, doctorUid: uid, reaction }),
  );

  // The reaction is already recorded upstream — this row is the portal's record OF it, not a step
  // IN it, so a failing audit write must cost the doctor nothing. Swallow and continue, exactly as
  // the login route does. A replay is not a new event, so it writes no second row.
  if (result.ok && !result.replay) {
    try {
      await sql`INSERT INTO audit_log_v2 (action, entity_type, entity_id, after_json)
                VALUES ('portal_reaction', 'physician', ${p.physicianId},
                ${JSON.stringify({ signal_id: signalId, reaction })}::jsonb)`;
    } catch {
      // Intentionally ignored: see above.
    }
  }

  if (!result.ok) {
    return portalJson({ ok: false, error: result.error, message: friendlyError(result.error) });
  }
  // The upstream reaction record is not relayed; the browser needs only to know it was saved.
  return portalJson({ ok: true, replay: result.replay });
}

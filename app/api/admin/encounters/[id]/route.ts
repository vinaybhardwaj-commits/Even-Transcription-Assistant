/**
 * GET    /api/admin/encounters/{id}  — full encounter bundle for the
 *                                       admin detail page (encounter +
 *                                       doctor + send_events + audit_log
 *                                       + llm_traces + recipient picker
 *                                       candidates).
 * DELETE /api/admin/encounters/{id}  — soft tombstone per V's Q4 lock.
 *                                       status='deleted', JSONs nulled,
 *                                       audio retained in R2.
 */
import { readAdminCookie } from "@/lib/cookie";
import { verifyAdminJwt } from "@/lib/auth";
import {
  getFullEncounter,
  softDeleteEncounter,
  listEncounterRecipientCandidates,
} from "@/lib/encounter/admin";
import { respondOk, respondError } from "@/lib/respond";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

async function guard(): Promise<{ ok: true; adminId: string } | { ok: false; code: "AUTH_REQUIRED" | "AUTH_EXPIRED"; msg: string }> {
  const cookie = await readAdminCookie();
  if (!cookie) return { ok: false, code: "AUTH_REQUIRED", msg: "Sign in required" };
  try {
    const claims = await verifyAdminJwt(cookie);
    return { ok: true, adminId: String(claims.admin_id ?? "") };
  } catch {
    return { ok: false, code: "AUTH_EXPIRED", msg: "Session invalid" };
  }
}

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const g = await guard();
  if (!g.ok) return respondError(g.code, g.msg);

  const { id } = await params;
  if (!id.startsWith("enc_")) return respondError("VALIDATION_FAILED", "bad_encounter_id");

  const enc = await getFullEncounter(id);
  if (!enc) return respondError("NOT_FOUND", "encounter_not_found");

  // Bundle recipient candidates for the resend picker.
  const recipientCandidates = enc.doctor
    ? await listEncounterRecipientCandidates(enc.doctor.id)
    : { per_doctor: [], global: [] };

  return respondOk({ encounter: enc, recipient_candidates: recipientCandidates });
}

export async function DELETE(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const g = await guard();
  if (!g.ok) return respondError(g.code, g.msg);

  const { id } = await params;
  if (!id.startsWith("enc_")) return respondError("VALIDATION_FAILED", "bad_encounter_id");

  const result = await softDeleteEncounter({ id, adminId: g.adminId });
  if (!result.ok) {
    return respondError("PIPELINE_FAILED", result.error?.slice(0, 200) ?? "delete_failed");
  }
  return respondOk({ ok: true, deleted: id });
}

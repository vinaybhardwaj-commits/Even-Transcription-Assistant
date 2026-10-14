import { NextRequest } from "next/server";
import { portalJson } from "@/lib/portal/forbidden-keys";
import { getCurrentPhysician } from "@/lib/physician-auth";
import { recordDoctorFindingResponse } from "@/lib/document-audits-db";
import { disabledWrite, respondEnabled } from "@/lib/portal-flags";
import { friendlyError } from "@/lib/finding-labels";
import { normalizeComment } from "@/lib/findings-actions";
import { forwardResponseNow } from "@/lib/response-sync";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const VERBS = new Set(["agree", "disagree", "needs_clarification"]);

/**
 * POST /api/portal/document-audits/respond — a physician responds to one of their findings.
 *
 * Body: `{ finding_id, verb, comment? }`. A disagreement or a request for clarification needs a
 * comment (the same rule as the live Findings response). A finding can be answered once. Every
 * failure is a plain sentence in `message`; the code in `error` is for the client's logic only.
 *
 * When the finding is one CDMSS routed (it has a signal reference) the answer is also forwarded to
 * CDMSS after it is saved here (src/lib/response-sync.ts). That is a bounded, best-effort attempt:
 * the doctor's submit never waits on it beyond a few seconds and never fails because of it. A failed
 * delivery is stored and retried by the nightly cron.
 */
export async function POST(request: NextRequest) {
  const p = await getCurrentPhysician();
  if (!p) return portalJson({ ok: false, error: "Unauthorized" }, { status: 401 });
  if (!respondEnabled()) return disabledWrite();

  let body: { finding_id?: unknown; verb?: unknown; comment?: unknown };
  try {
    body = await request.json();
  } catch {
    return portalJson({ ok: false, error: "invalid_json", message: friendlyError("invalid_json") });
  }

  const findingId = typeof body.finding_id === "string" ? body.finding_id : "";
  const verb = typeof body.verb === "string" ? body.verb : "";
  const comment = normalizeComment(body.comment);
  const needsComment = verb === "disagree" || verb === "needs_clarification";
  if (!findingId || !VERBS.has(verb) || (needsComment && !comment)) {
    return portalJson({ ok: false, error: "invalid_body", message: friendlyError("invalid_body") });
  }

  const result = await recordDoctorFindingResponse({
    findingId,
    physicianId: p.physicianId,
    verb: verb as "agree" | "disagree" | "needs_clarification",
    comment,
  });

  if (!result.ok) {
    // A finding that cannot take a response (already answered, closed, on the live list) is a
    // conflict with its current state; anything else keeps the portal's usual 200 + named reason.
    const conflict =
      result.error === "already_responded" || result.error === "closed" || result.error === "on_live_list";
    return portalJson(
      { ok: false, error: result.error, message: friendlyError(result.error) },
      { status: conflict ? 409 : 200 },
    );
  }
  await forwardResponseNow(findingId);
  return portalJson({ ok: true });
}

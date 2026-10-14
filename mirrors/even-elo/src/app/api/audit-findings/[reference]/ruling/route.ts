import { NextRequest, NextResponse } from "next/server";
import { requireStaff } from "@/lib/staff-guard";
import { isAuditReference } from "@/lib/cdmss-governance";
import { parseRulingBody, recordRuling } from "@/lib/audit-ruling";
import { ACTION_CHOICE, allowedActions } from "@/lib/audit-findings";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 30;

/**
 * POST /api/audit-findings/[reference]/ruling — record a governance ruling on a thread.
 *
 * Body: `{ action, note }`. The note is required. Staff with the manage level only (super_admin or
 * Site Medical Head): 401 without a staff session, 403 for staff who may only view.
 *
 *   200  recorded (or a repeat of a ruling already recorded: `replayed: true`)
 *   409  the thread moved; `current_status` says where it is now, `actions` what is still allowed
 *   403  a Site Medical Head ruling on a doctor who is not engaged at a hospital they head (super admin: never)
 *   400 / 404  the request or the thread is not valid
 *   502  CDMSS did not confirm; the decision is saved here and the same button press retries it
 *
 * The decision is recorded once per thread + action + thread state (src/lib/audit-ruling.ts); pressing
 * twice never creates a second row, and a thread that was reopened can be ruled again.
 */
export async function POST(req: NextRequest, { params }: { params: { reference: string } }) {
  const gate = await requireStaff("manage");
  if (!gate.ok) return gate.response;

  const reference = decodeURIComponent(params.reference || "");
  if (!isAuditReference(reference)) {
    return NextResponse.json({ ok: false, error: "invalid", message: "That is not a thread reference." }, { status: 400 });
  }
  const parsed = parseRulingBody(await req.json().catch(() => null));
  if (!parsed.ok) return NextResponse.json({ ok: false, error: "invalid", message: parsed.message }, { status: 400 });

  const result = await recordRuling({
    reference,
    action: parsed.action,
    note: parsed.note,
    actor: { profileId: gate.user.profileId, email: gate.user.email },
    scope: gate.scope,
  });

  if (!result.ok) {
    const actions =
      result.error === "conflict" && result.current_status
        ? allowedActions(result.current_status).map((a) => ({ action: a, ...ACTION_CHOICE[a] }))
        : undefined;
    return NextResponse.json(
      { ok: false, error: result.error, message: result.message, current_status: result.current_status ?? null, actions },
      { status: result.http },
    );
  }
  return NextResponse.json({
    ok: true,
    replayed: result.replayed,
    status: result.status,
    intervention_id: result.intervention_id,
    thread: result.row,
    actions: result.row ? allowedActions(result.row.status).map((a) => ({ action: a, ...ACTION_CHOICE[a] })) : [],
  });
}

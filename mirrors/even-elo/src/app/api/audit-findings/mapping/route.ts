import { NextRequest, NextResponse } from "next/server";
import { requireStaff } from "@/lib/staff-guard";
import { decideMapping, reviewQueue } from "@/lib/cdmss-mapping-service";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 60;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/**
 * Mapping review: weak doctor-mapping matches (the F1 matcher's `review` list) for staff to settle.
 *
 *   GET   the list (rejected pairs removed), coverage, and the most recent decisions.
 *   POST  `{ decision: "confirm" | "reject", uid, physician_id, note? }`
 *         confirm writes physicians.cdmss_doctor_uid (only into an empty link) and is audited with who
 *         and when; reject stops the pair being offered. Both are recorded in cdmss_mapping_decisions.
 *
 * Staff with the manage level only (super_admin or Site Medical Head): a link decides which doctor
 * sees which findings, so viewing staff cannot make it. A Site Medical Head sees and decides only the
 * pairs whose physician is engaged at a hospital they head (403 out_of_scope otherwise); a super admin
 * sees all.
 */
export async function GET() {
  const gate = await requireStaff("manage");
  if (!gate.ok) return gate.response;
  try {
    return NextResponse.json({ ok: true, ...(await reviewQueue(gate.scope)) });
  } catch (e) {
    return NextResponse.json(
      {
        ok: false,
        error: "directory_unavailable",
        message: `The CDMSS doctor directory could not be read (${e instanceof Error ? e.message.slice(0, 80) : "error"}).`,
      },
      { status: 502 },
    );
  }
}

export async function POST(req: NextRequest) {
  const gate = await requireStaff("manage");
  if (!gate.ok) return gate.response;

  const raw = (await req.json().catch(() => null)) as Record<string, unknown> | null;
  const decision = raw?.decision;
  const uid = typeof raw?.uid === "string" ? raw.uid.trim() : "";
  const physicianId = typeof raw?.physician_id === "string" ? raw.physician_id.trim() : "";
  const note = typeof raw?.note === "string" && raw.note.trim() ? raw.note.trim().slice(0, 500) : null;
  if ((decision !== "confirm" && decision !== "reject") || !uid || uid.length > 128 || !UUID.test(physicianId)) {
    return NextResponse.json(
      { ok: false, error: "invalid", message: "Send decision (confirm or reject), the CDMSS doctor uid and the physician id." },
      { status: 400 },
    );
  }
  const result = await decideMapping({
    decision,
    uid,
    physicianId,
    note,
    actor: { profileId: gate.user.profileId, email: gate.user.email },
    scope: gate.scope,
  });
  if (!result.ok) {
    return NextResponse.json({ ok: false, error: result.error, message: result.message }, { status: result.http });
  }
  return NextResponse.json({ ok: true, decision: result.decision, physician_id: result.physician_id, uid: result.cdmss_uid });
}

import { NextRequest, NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/auth";
import { confirmFindingAuthor } from "@/lib/document-audits-db";
import { isSystemAuditAuthor } from "@/lib/document-audits";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const NO_STORE = { "Cache-Control": "no-store, max-age=0" };
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * POST /api/rmo-inbox/author — signed-in staff confirms (or edits) the RMO author stamp.
 * Body: { finding_id, authored_by_name? }. Empty name uses the session full_name.
 * The system pending label is never stored as a confirmed author.
 */
export async function POST(request: NextRequest) {
  const user = await getCurrentUser();
  if (!user || user.status !== "active") {
    return NextResponse.json({ ok: false, error: "Not authenticated" }, { status: 401, headers: NO_STORE });
  }

  let body: { finding_id?: unknown; authored_by_name?: unknown };
  try {
    body = (await request.json()) as { finding_id?: unknown; authored_by_name?: unknown };
  } catch {
    return NextResponse.json({ ok: false, error: "invalid_json" }, { status: 400, headers: NO_STORE });
  }

  const findingId = typeof body.finding_id === "string" ? body.finding_id : "";
  if (!UUID.test(findingId)) {
    return NextResponse.json({ ok: false, error: "finding_id_required" }, { status: 400, headers: NO_STORE });
  }

  const edited = typeof body.authored_by_name === "string" ? body.authored_by_name.trim() : "";
  const name = edited && !isSystemAuditAuthor(edited) ? edited.slice(0, 120) : user.full_name.trim();
  const result = await confirmFindingAuthor({
    findingId,
    profileId: user.profileId,
    authoredByName: name,
  });
  if (!result.ok) {
    const status = result.error === "not_found" ? 404 : 400;
    return NextResponse.json(result, { status, headers: NO_STORE });
  }
  return NextResponse.json({ ok: true, authored_by_name: name }, { headers: NO_STORE });
}

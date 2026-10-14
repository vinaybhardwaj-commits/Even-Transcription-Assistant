import { NextRequest, NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/auth";
import { releaseFindingToPortal } from "@/lib/document-audits-db";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const NO_STORE = { "Cache-Control": "no-store, max-age=0" };
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * POST /api/rmo-inbox/release — RMO sets portal_visible and triage_routed_at.
 * Body: { finding_id }. Pipe A matches keep response_owner=pipe_a so the doctor is not asked twice.
 */
export async function POST(request: NextRequest) {
  const user = await getCurrentUser();
  if (!user || user.status !== "active") {
    return NextResponse.json({ ok: false, error: "Not authenticated" }, { status: 401, headers: NO_STORE });
  }

  let body: { finding_id?: unknown };
  try {
    body = (await request.json()) as { finding_id?: unknown };
  } catch {
    return NextResponse.json({ ok: false, error: "invalid_json" }, { status: 400, headers: NO_STORE });
  }

  const findingId = typeof body.finding_id === "string" ? body.finding_id : "";
  if (!UUID.test(findingId)) {
    return NextResponse.json({ ok: false, error: "finding_id_required" }, { status: 400, headers: NO_STORE });
  }

  const result = await releaseFindingToPortal(findingId);
  if (!result.ok) {
    const status = result.error === "not_found" ? 404 : 400;
    return NextResponse.json(result, { status, headers: NO_STORE });
  }
  return NextResponse.json(result, { headers: NO_STORE });
}

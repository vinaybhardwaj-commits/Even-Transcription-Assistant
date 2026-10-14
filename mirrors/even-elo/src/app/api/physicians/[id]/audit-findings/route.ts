import { NextRequest, NextResponse } from "next/server";
import { requireStaff } from "@/lib/staff-guard";
import { loadPhysicianRows } from "@/lib/audit-findings-server";
import { countBuckets, sortRows } from "@/lib/audit-findings";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 30;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/**
 * GET /api/physicians/[id]/audit-findings — the "Audit findings" section on a physician's profile:
 * every routed thread for this doctor (canonical CDMSS uid plus any recorded alias uids), same row
 * shape as the worklist. Staff only (see /api/audit-findings).
 */
export async function GET(_req: NextRequest, { params }: { params: { id: string } }) {
  const gate = await requireStaff("view");
  if (!gate.ok) return gate.response;
  if (!UUID.test(params.id || "")) {
    return NextResponse.json({ ok: false, error: "invalid", message: "That is not a physician id." }, { status: 400 });
  }
  const loaded = await loadPhysicianRows(params.id);
  if (!loaded.ok) {
    return NextResponse.json(
      { ok: false, error: "cdmss_unavailable", message: "CDMSS did not answer. Audit findings cannot be shown right now." },
      { status: 502 },
    );
  }
  if (!loaded.mapped) return NextResponse.json({ ok: true, mapped: false, counts: countBuckets([]), rows: [] });
  return NextResponse.json({ ok: true, mapped: true, counts: countBuckets(loaded.rows), rows: sortRows(loaded.rows) });
}

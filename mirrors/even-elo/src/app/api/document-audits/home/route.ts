import { NextRequest, NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/auth";
import { getHospitalFilter } from "@/lib/hospital-filter";
import { filterAuditRows, type DocType, type FindingSeverity, type PipeStatus } from "@/lib/document-audits";
import { loadDocumentAuditCounts, loadDocumentAuditRows } from "@/lib/document-audits-db";

export const dynamic = "force-dynamic";
export const revalidate = 0;
export const fetchCache = "force-no-store";
export const runtime = "nodejs";

const NO_STORE = { "Cache-Control": "no-store, max-age=0" };

/**
 * GET /api/document-audits/home — Stage 4 Document Audits staff home.
 * Honest empty when no ingest. Hospital scope from epi_hospital_filter cookie.
 */
export async function GET(request: NextRequest) {
  const user = await getCurrentUser();
  if (!user || user.status !== "active") {
    return NextResponse.json({ ok: false, error: "Not authenticated" }, { status: 401, headers: NO_STORE });
  }

  const hospitalCode = await getHospitalFilter();
  const sp = request.nextUrl.searchParams;
  const physicianId = sp.get("physician_id");
  const docType = (sp.get("doc_type") as DocType | "all" | null) ?? "all";
  const severity = (sp.get("severity") as FindingSeverity | "all" | null) ?? "all";
  const status = (sp.get("status") as PipeStatus | "all" | null) ?? "all";
  const query = sp.get("q") ?? "";

  const { headline, available } = await loadDocumentAuditCounts(
    hospitalCode === "all" ? null : hospitalCode,
  );
  const rows = await loadDocumentAuditRows({
    hospitalCode: hospitalCode === "all" ? null : hospitalCode,
    physicianId,
  });
  const filtered = filterAuditRows(rows, {
    query,
    physicianId,
    docType,
    severity,
    status,
  });

  const doctorMap = new Map<string, { id: string; name: string; specialty: string }>();
  for (const r of rows) {
    if (!doctorMap.has(r.physician_id)) {
      doctorMap.set(r.physician_id, {
        id: r.physician_id,
        name: r.physician_name,
        specialty: r.specialty,
      });
    }
  }

  return NextResponse.json(
    {
      ok: true,
      available,
      hospital_code: hospitalCode,
      headline,
      rows: filtered,
      doctors: Array.from(doctorMap.values()),
    },
    { headers: NO_STORE },
  );
}

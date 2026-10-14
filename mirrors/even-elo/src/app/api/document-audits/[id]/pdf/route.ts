import { NextRequest, NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/auth";
import { sql } from "@/lib/db";
import { fetchCdmssAuditPdf, pdfStreamResponse } from "@/lib/cdmss-pdf";
import { auditUuidFromPdfUrl, isAuditUuid } from "@/lib/findings-pdf";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 30;

/**
 * GET /api/document-audits/[id]/pdf — staff proxy for a document audit's CDMSS findings PDF (A4).
 *
 * `[id]` is the local document_audits row id (what the staff pages already hold). The stored
 * `cdmss_pdf_url` points at the CDMSS host, which answers 401 in a browser (it needs GOV_API_KEY),
 * so the staff pages used to offer a dead link. This route is behind the governance session (the
 * middleware requires `epi_session` for /api/*; the handler re-checks an ACTIVE user), resolves the
 * CDMSS audit id from the stored row, and streams the file with the key kept server-side.
 *
 * Staff get the full audit PDF (no routed_only filter): that filter is for doctors.
 */
export async function GET(_req: NextRequest, { params }: { params: { id: string } }) {
  const user = await getCurrentUser();
  if (!user || user.status !== "active") {
    return NextResponse.json({ ok: false, error: "Unauthorized" }, { status: 401 });
  }
  const id = (params.id || "").trim();
  if (!isAuditUuid(id)) return NextResponse.json({ ok: false, error: "invalid" }, { status: 400 });

  let row: { source_audit_id: string | null; cdmss_pdf_url: string | null } | undefined;
  try {
    const rows = (await sql`
      SELECT source_audit_id, cdmss_pdf_url FROM document_audits WHERE id = ${id}::uuid LIMIT 1
    `) as unknown as Array<{ source_audit_id: string | null; cdmss_pdf_url: string | null }>;
    row = rows[0];
  } catch {
    return NextResponse.json({ ok: false, error: "db_error" }, { status: 500 });
  }
  if (!row) return NextResponse.json({ ok: false, error: "not_found" }, { status: 404 });

  // Prefer the id embedded in the stored CDMSS URL (the file ingest verified), else the audit id.
  const cdmssId =
    auditUuidFromPdfUrl(row.cdmss_pdf_url) ??
    (isAuditUuid(row.source_audit_id) ? row.source_audit_id!.trim() : null);
  if (!cdmssId) return NextResponse.json({ ok: false, error: "no_pdf" }, { status: 404 });

  try {
    return pdfStreamResponse(await fetchCdmssAuditPdf(cdmssId));
  } catch {
    return NextResponse.json({ ok: false, error: "upstream_unavailable" }, { status: 502 });
  }
}

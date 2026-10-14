import { NextRequest, NextResponse } from "next/server";
import { getCurrentPhysician } from "@/lib/physician-auth";
import { sql } from "@/lib/db";
import { findingsEnabled } from "@/lib/portal-flags";
import { fetchDoctorAudits } from "@/lib/doctor-audits";
import { doctorMayFetchAuditPdf, isAuditUuid, type AuditPdfSignal } from "@/lib/findings-pdf";
import { fetchCdmssAuditPdf, pdfStreamResponse } from "@/lib/cdmss-pdf";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 30;

/**
 * GET /api/portal/findings/pdf?ref=<audit uuid>
 *
 * Session-authenticated proxy for the CDMSS audit-findings PDF. The browser
 * never receives GOV_API_KEY and never links at
 * `{GOV_API_BASE}/api/governance/audits/:id/pdf` (that route is 401 without
 * the key).
 *
 * Binding matches the Findings list: the physician's `cdmss_doctor_uid` is
 * read from the session, then doctor-audits is fetched for that uid. A signal
 * grants the file only when it has instances and a real audit UUID. A
 * portal-visible local document audit for this physician is the other grant,
 * so the local strip can download without exposing the CDMSS URL.
 *
 * The upstream call ALWAYS carries routed_only=1, so the file a doctor opens
 * contains only the findings routed to them: no sibling findings, no internal
 * ids, no triage text. There is no path from this route to the unfiltered PDF
 * (staff use /api/document-audits/[id]/pdf for that).
 *
 * A missing session is 401. A reference that is not an audit UUID (including
 * EHRC-AUD-*) is 400. An audit this doctor cannot see is 404 — the same answer
 * whether it belongs to someone else or does not exist. Upstream failure is
 * 502, never an empty PDF and never the upstream body.
 */

/**
 * "View note" opens this URL in a new tab, so every non-PDF answer is a small page a doctor can
 * read, never JSON. The wording is one plain sentence with no code, and the status code is kept so
 * logs and tests still tell the cases apart.
 */
const NOTE_UNAVAILABLE = "This note isn't available right now. The quality team has been notified.";

function notePage(status: number, message: string = NOTE_UNAVAILABLE): NextResponse {
  const safe = message.replace(/[<>&]/g, "");
  const html =
    '<!doctype html><html lang="en"><head><meta charset="utf-8">' +
    '<meta name="viewport" content="width=device-width, initial-scale=1">' +
    "<title>Note unavailable</title></head>" +
    '<body style="font-family:system-ui,sans-serif;max-width:32rem;margin:15vh auto;padding:0 1.25rem;color:#292524">' +
    `<p style="font-size:1.0625rem;line-height:1.5">${safe}</p></body></html>`;
  return new NextResponse(html, {
    status,
    headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store, max-age=0" },
  });
}

async function lookupDoctorUid(physicianId: string): Promise<string | null> {
  try {
    const rows = (await sql`
      SELECT cdmss_doctor_uid FROM physicians WHERE id=${physicianId}::uuid`) as unknown as Array<{
      cdmss_doctor_uid: string | null;
    }>;
    return rows[0]?.cdmss_doctor_uid ?? null;
  } catch {
    return null;
  }
}

/** A finding of this physician, visible to them (its own portal_visible), on the audit with this CDMSS id. */
async function physicianHasLocalAuditPdf(physicianId: string, auditId: string): Promise<boolean> {
  try {
    const rows = (await sql`
      SELECT da.source_audit_id
      FROM document_audit_findings f
      JOIN document_audits da ON da.id = f.audit_id
      WHERE f.physician_id = ${physicianId}::uuid
        AND f.portal_visible = true
        AND (
          lower(da.source_audit_id) = lower(${auditId})
          OR position(lower(${auditId}) in lower(coalesce(da.cdmss_pdf_url, ''))) > 0
        )
      LIMIT 1`) as unknown as Array<{ source_audit_id: string | null }>;
    return rows.length > 0;
  } catch {
    return false;
  }
}

export async function GET(request: NextRequest) {
  const p = await getCurrentPhysician();
  if (!p) return notePage(401, "Please sign in to the doctor portal again to view this note.");
  if (!findingsEnabled()) return notePage(404);

  const ref = (request.nextUrl.searchParams.get("ref") || "").trim();
  if (!isAuditUuid(ref)) {
    return notePage(400);
  }

  const uid = await lookupDoctorUid(p.physicianId);

  let signals: AuditPdfSignal[] = [];
  let listFailed = false;
  if (uid) {
    try {
      const upstream = await fetchDoctorAudits(uid, { window: 90, status: "all" });
      const list = Array.isArray(upstream?.signals) ? upstream.signals : [];
      // A finding marked not routed never grants a file.
      signals = (list as unknown as AuditPdfSignal[]).filter(
        (s) =>
          (s as { routed?: unknown }).routed !== false &&
          (s.representative as { routed?: unknown } | null)?.routed !== false,
      );
    } catch {
      listFailed = true;
    }
  }

  const localMatch = await physicianHasLocalAuditPdf(p.physicianId, ref);
  if (!doctorMayFetchAuditPdf({ auditId: ref, signals, localMatch })) {
    if (listFailed && !localMatch) {
      return notePage(502);
    }
    return notePage(404);
  }

  try {
    return pdfStreamResponse(await fetchCdmssAuditPdf(ref, { routedOnly: true }));
  } catch {
    return notePage(502);
  }
}

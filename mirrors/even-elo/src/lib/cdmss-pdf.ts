/**
 * Server-side fetch of a CDMSS audit-findings PDF, shared by the doctor proxy and the staff proxy.
 *
 * CDMSS `GET /api/governance/audits/:id/pdf` answers 401 unless GOV_API_KEY is sent. The key stays
 * on the server; browsers only ever get a same-origin, session-authenticated route.
 *
 * `routedOnly` adds `?routed_only=1`, which makes CDMSS print only the findings routed to the
 * doctor and no internal ids or triage text. The DOCTOR proxy always passes it. The staff proxy does
 * not: staff are entitled to the full audit.
 */

import { NextResponse } from "next/server";

const PDF_TIMEOUT_MS = 20000;

export async function fetchCdmssAuditPdf(
  auditId: string,
  opts: { routedOnly?: boolean } = {},
): Promise<Response> {
  const key = process.env.GOV_API_KEY;
  if (!key) throw new Error("GOV_API_KEY not configured");
  const base = process.env.GOV_API_BASE || "https://even-cdmss.vercel.app";
  const qs = opts.routedOnly ? "?routed_only=1" : "";
  const res = await fetch(`${base}/api/governance/audits/${encodeURIComponent(auditId)}/pdf${qs}`, {
    headers: { "x-api-key": key, accept: "application/pdf" },
    cache: "no-store",
    signal: AbortSignal.timeout(PDF_TIMEOUT_MS),
  });
  const ct = (res.headers.get("content-type") || "").toLowerCase();
  if (!res.ok || !res.body) throw new Error(`CDMSS audit pdf ${res.status}`);
  if (ct.includes("json") || ct.includes("text/html") || ct.includes("text/plain")) {
    throw new Error(`CDMSS audit pdf content-type ${ct || "unknown"}`);
  }
  if (ct && !ct.includes("pdf") && !ct.includes("octet-stream")) {
    throw new Error(`CDMSS audit pdf content-type ${ct}`);
  }
  return res;
}

/** Stream an upstream PDF to the browser with the headers both proxies promise. */
export function pdfStreamResponse(upstream: Response): NextResponse {
  const headers = new Headers();
  headers.set("Content-Type", "application/pdf");
  headers.set("Content-Disposition", 'inline; filename="audit-findings.pdf"');
  headers.set("Cache-Control", "private, no-store");
  headers.set("X-Content-Type-Options", "nosniff");
  return new NextResponse(upstream.body, { status: 200, headers });
}

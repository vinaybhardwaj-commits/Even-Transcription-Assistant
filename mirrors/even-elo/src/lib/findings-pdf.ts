/**
 * Portal audit-findings PDF hrefs.
 *
 * CDMSS `GET /api/governance/audits/:id/pdf` answers 401 unless the caller sends
 * GOV_API_KEY. That key stays on the server. The browser only ever receives a
 * same-origin href: `/api/portal/findings/pdf?ref=<audit uuid>`.
 *
 * A signal reference (`EHRC-AUD-YYYY-NNNN`) is not an audit id. Zero-instance
 * shells have no representative audit to download, so they get no href.
 */

export const AUDIT_UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isAuditUuid(ref: string | null | undefined): ref is string {
  return typeof ref === "string" && AUDIT_UUID_RE.test(ref.trim());
}

/** At least one attached instance. Missing, zero, and non-numeric counts are shells. */
export function hasAttachedInstances(instances: unknown): boolean {
  if (Array.isArray(instances)) return instances.length >= 1;
  const n = typeof instances === "number" ? instances : Number(instances);
  return Number.isFinite(n) && n >= 1;
}

export function portalFindingsPdfHref(auditId: string): string {
  return `/api/portal/findings/pdf?ref=${encodeURIComponent(auditId.trim())}`;
}

/** UUID embedded in a CDMSS audit-findings PDF URL, or null. */
export function auditUuidFromPdfUrl(url: string | null | undefined): string | null {
  if (!url || typeof url !== "string") return null;
  const m = url.trim().match(/\/api\/governance\/audits\/([0-9a-f-]{36})\/pdf(?:[?#].*)?$/i);
  if (!m || !isAuditUuid(m[1])) return null;
  return m[1];
}

export function isPortalProxyHref(href: string | null | undefined): href is string {
  if (!href || typeof href !== "string") return false;
  const trimmed = href.trim();
  if (!trimmed.startsWith("/api/portal/findings/pdf?")) return false;
  try {
    const u = new URL(trimmed, "https://portal.local");
    return u.pathname === "/api/portal/findings/pdf" && isAuditUuid(u.searchParams.get("ref"));
  } catch {
    return false;
  }
}

/** A raw CDMSS governance PDF link. The browser must not be sent here. */
export function isCdmssGovernancePdfUrl(url: string): boolean {
  return /\/api\/governance\/audits\//i.test(url) || /even-cdmss\.vercel\.app/i.test(url);
}

/**
 * PURE. Findings card download. Requires a real audit UUID and at least one
 * instance. Signal references never become a href.
 */
export function findingsCardPdfHref(signal: {
  instances?: unknown;
  representative?: { audit_id?: string | null } | null;
  pdf_url?: string | null;
}): string | null {
  if (!hasAttachedInstances(signal.instances)) return null;
  const repId = signal.representative?.audit_id?.trim() ?? "";
  if (isAuditUuid(repId)) return portalFindingsPdfHref(repId);
  const embedded = auditUuidFromPdfUrl(signal.pdf_url);
  if (embedded) return portalFindingsPdfHref(embedded);
  if (isPortalProxyHref(signal.pdf_url)) return signal.pdf_url.trim();
  return null;
}

/**
 * PURE. Local document-audit card. Rewrite a stored CDMSS URL into the portal
 * proxy. Leave a non-CDMSS absolute file (blob/CDN) as stored. Hide anything
 * else, including a governance URL we cannot tie to an audit UUID.
 */
export function localCardPdfHref(
  pdfUrl: string | null | undefined,
  pdfStatus: string | null | undefined,
): string | null {
  if (pdfStatus !== "available" || !pdfUrl) return null;
  const trimmed = pdfUrl.trim();
  if (isPortalProxyHref(trimmed)) return trimmed;
  const id = auditUuidFromPdfUrl(trimmed);
  if (id) return portalFindingsPdfHref(id);
  if (isCdmssGovernancePdfUrl(trimmed)) return null;
  if (/^https?:\/\//i.test(trimmed)) return trimmed;
  return null;
}

/** BFF shape for a stored `cdmss_pdf_url` after the proxy rewrite. */
export function presentPortalPdf(storedPdfUrl: string | null): {
  pdf_url: string | null;
  pdf_status: "available" | "unavailable";
} {
  const href = localCardPdfHref(storedPdfUrl, storedPdfUrl ? "available" : "unavailable");
  if (!href) return { pdf_url: null, pdf_status: "unavailable" };
  return { pdf_url: href, pdf_status: "available" };
}

export interface AuditPdfSignal {
  instances?: unknown;
  representative?: { audit_id?: string | null; pdf_url?: string | null } | null;
  pdf_url?: string | null;
}

/**
 * PURE. One upstream signal grants a PDF only when it has instances and names
 * this audit UUID (representative id, or a UUID inside a stored PDF URL).
 */
export function signalGrantsAuditPdf(signal: AuditPdfSignal, auditId: string): boolean {
  if (!hasAttachedInstances(signal.instances)) return false;
  if (!isAuditUuid(auditId)) return false;
  const want = auditId.trim().toLowerCase();
  const repId = signal.representative?.audit_id?.trim() ?? "";
  if (isAuditUuid(repId) && repId.toLowerCase() === want) return true;
  const embedded =
    auditUuidFromPdfUrl(signal.pdf_url) ||
    auditUuidFromPdfUrl(signal.representative?.pdf_url ?? null);
  return !!embedded && embedded.toLowerCase() === want;
}

/**
 * PURE. The signed-in doctor may fetch this audit when a CDMSS signal they
 * can see grants it, or a portal-visible local document audit is theirs.
 */
export function doctorMayFetchAuditPdf(input: {
  auditId: string;
  signals: readonly AuditPdfSignal[];
  localMatch: boolean;
}): boolean {
  if (!isAuditUuid(input.auditId)) return false;
  if (input.localMatch) return true;
  return input.signals.some((s) => signalGrantsAuditPdf(s, input.auditId));
}

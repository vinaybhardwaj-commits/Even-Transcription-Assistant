/**
 * Stage 4 — Document Audits / RMO authoring (pure shaping).
 *
 * Product locks (2026-09-22):
 * 1. RMOs author findings; always record which RMO. Doctors remediate/respond.
 *    No RMO-as-fixer assignment model.
 * 2. Doctor portal: TriageBot-routed findings + CDMSS PDF download.
 * 3. Surgical ELO Adherence starts now from available audits + surgical feedback.
 *
 * Distinct from e-IRIS / Patient Feedback incidents / ISS.
 */

/** Machine stamp until an RMO confirms. Never present this as a named human RMO. */
export const SYSTEM_AUDIT_AUTHOR = "CDMSS audit (pending RMO review)";

export function isSystemAuditAuthor(name: string | null | undefined): boolean {
  return name === SYSTEM_AUDIT_AUTHOR;
}

/** Staff/portal attribution. System rows keep the pending label; confirmed rows name the RMO. */
export function authorAttribution(name: string | null | undefined): string {
  if (!name) return "Author not recorded";
  if (isSystemAuditAuthor(name)) return SYSTEM_AUDIT_AUTHOR;
  return `RMO ${name}`;
}

/**
 * Portal PDF link. Only an absolute URL already stored from CDMSS counts.
 * A guessed `/api/governance/audits/:id/pdf` is not shown until ingest has verified it.
 */
export function portalPdfStatus(cdmssPdfUrl: string | null | undefined): {
  pdf_url: string | null;
  pdf_status: "available" | "unavailable";
} {
  if (typeof cdmssPdfUrl === "string" && /^https?:\/\//i.test(cdmssPdfUrl.trim())) {
    return { pdf_url: cdmssPdfUrl.trim(), pdf_status: "available" };
  }
  return { pdf_url: null, pdf_status: "unavailable" };
}

/** Who the doctor should answer. Pipe A owns the ask when a routed signal matches. */
export function portalResponseOwner(
  responseOwner: string | null | undefined,
  signalReference: string | null | undefined,
): "pipe_a" | "local" {
  if (responseOwner === "pipe_a") return "pipe_a";
  if (responseOwner === "local") return "local";
  if (signalReference && signalReference.trim()) return "pipe_a";
  return "local";
}

export const DOC_TYPES = ["progress", "ot", "discharge"] as const;
export type DocType = (typeof DOC_TYPES)[number];

export const FINDING_SEVERITIES = ["critical", "high", "medium", "low"] as const;
export type FindingSeverity = (typeof FINDING_SEVERITIES)[number];

export const PIPE_STATUSES = ["open", "in_progress", "remediated", "contested", "escalated"] as const;
export type PipeStatus = (typeof PIPE_STATUSES)[number];

export const DOC_TYPE_LABEL: Record<DocType, string> = {
  progress: "Progress note",
  ot: "OT note",
  discharge: "Discharge summary",
};

export const SEVERITY_LABEL: Record<FindingSeverity, string> = {
  critical: "Critical",
  high: "High",
  medium: "Medium",
  low: "Low",
};

export const PIPE_STATUS_LABEL: Record<PipeStatus, string> = {
  open: "Open",
  in_progress: "In progress",
  remediated: "Remediated",
  contested: "Contested",
  escalated: "Escalated",
};

/** Open / in-progress / contested / escalated still need physician remediation. */
export const OPEN_PIPE: ReadonlySet<PipeStatus> = new Set<PipeStatus>([
  "open",
  "in_progress",
  "contested",
  "escalated",
]);

export const HIGH_SEV: ReadonlySet<FindingSeverity> = new Set<FindingSeverity>(["critical", "high"]);

/** Ingest older than this (calendar days) is labeled Stale. */
export const AUDIT_STALE_AFTER_DAYS = 14;

export type AuditHonesty = "empty" | "live" | "stale";

export interface DocumentAuditRow {
  id: string;
  external_ref: string | null;
  hospital_code: string;
  physician_id: string;
  physician_name: string;
  specialty: string;
  doc_type: DocType;
  note_date: string | null;
  ingested_at: string;
  cdmss_pdf_url: string | null;
  triage_routed_at: string | null;
  finding_id: string | null;
  finding_label: string | null;
  finding_body: string | null;
  severity: FindingSeverity | null;
  status: PipeStatus | null;
  authored_by_name: string | null;
  authored_at: string | null;
  recurrence_count: number;
  portal_visible: boolean;
  doctor_responded_at: string | null;
}

export interface DocumentAuditsHeadline {
  total: number;
  open_findings: number;
  critical_high: number;
  doctors_with_findings: number;
  last_ingest: string | null;
  honesty: AuditHonesty;
  honesty_label: string;
}

export interface DocumentAuditsHomePayload {
  ok: true;
  headline: DocumentAuditsHeadline;
  rows: DocumentAuditListItem[];
  doctors: Array<{ id: string; name: string; specialty: string }>;
}

export interface DocumentAuditListItem {
  id: string;
  finding_id: string | null;
  external_ref: string | null;
  hospital_code: string;
  physician_id: string;
  physician_name: string;
  specialty: string;
  doc_type: DocType;
  doc_type_label: string;
  finding_label: string;
  severity: FindingSeverity | null;
  severity_label: string | null;
  status: PipeStatus | null;
  status_label: string | null;
  authored_by_name: string | null;
  authored_at: string | null;
  note_date: string | null;
  open_age_days: number | null;
  cdmss_pdf_url: string | null;
  portal_visible: boolean;
}

export interface RmoInboxHeadline {
  open: number;
  in_progress: number;
  escalated: number;
  sla_risk: number;
  hospital_label: string;
  honesty: AuditHonesty;
}

export interface RmoWorkItem {
  finding_id: string;
  audit_id: string;
  external_ref: string | null;
  finding_label: string;
  severity: FindingSeverity;
  status: PipeStatus;
  physician_id: string;
  physician_name: string;
  specialty: string;
  hospital_code: string;
  doc_type: DocType;
  doc_type_label: string;
  authored_by_name: string;
  authored_at: string;
  open_age_days: number;
  recurrence_count: number;
  remediator_note: string;
  portal_visible: boolean;
  author_pending: boolean;
  signal_reference: string | null;
}

export interface SgcExceptionItem {
  finding_id: string;
  finding_label: string;
  severity: FindingSeverity;
  status: PipeStatus;
  physician_name: string;
  hospital_code: string;
  open_age_days: number;
  recurrence_count: number;
  exception_score: number;
  authored_by_name: string;
}

export interface PhysicianDocumentationEvent {
  finding_id: string;
  audit_id: string;
  external_ref: string | null;
  date_label: string;
  doc_type: DocType;
  doc_type_label: string;
  finding_label: string;
  finding_body: string | null;
  severity: FindingSeverity;
  status: PipeStatus;
  authored_by_name: string;
  open_age_days: number;
  cdmss_pdf_url: string | null;
}

export interface PhysicianDocumentationHeadline {
  total: number;
  open_findings: number;
  critical_high: number;
  last_event: string | null;
  honesty: AuditHonesty;
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

export function normalizeDocType(raw: unknown): DocType | null {
  if (raw === "progress" || raw === "ot" || raw === "discharge") return raw;
  if (raw === "progress_note") return "progress";
  if (raw === "ot_note") return "ot";
  if (raw === "discharge_summary") return "discharge";
  return null;
}

export function normalizeSeverity(raw: unknown): FindingSeverity | null {
  if (raw === "critical" || raw === "high" || raw === "medium" || raw === "low") return raw;
  if (raw === "crit") return "critical";
  if (raw === "med") return "medium";
  return null;
}

export function normalizePipeStatus(raw: unknown): PipeStatus | null {
  if (
    raw === "open" ||
    raw === "in_progress" ||
    raw === "remediated" ||
    raw === "contested" ||
    raw === "escalated"
  ) {
    return raw;
  }
  if (raw === "progress") return "in_progress";
  return null;
}

/** Staff-facing calendar date in IST, e.g. "18 Sep 2026". */
export function formatAuditDate(iso: string | null | undefined): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  const parts = new Intl.DateTimeFormat("en-GB", {
    day: "numeric",
    month: "2-digit",
    year: "numeric",
    timeZone: "Asia/Kolkata",
  }).formatToParts(d);
  const day = parts.find((p) => p.type === "day")?.value;
  const month = parts.find((p) => p.type === "month")?.value;
  const year = parts.find((p) => p.type === "year")?.value;
  if (!day || !month || !year) return "—";
  const monthName = MONTHS[Number(month) - 1];
  if (!monthName) return "—";
  return `${Number(day)} ${monthName} ${year}`;
}

export function openAgeDays(fromIso: string | null | undefined, asOf = new Date()): number {
  if (!fromIso) return 0;
  const t = new Date(fromIso).getTime();
  if (Number.isNaN(t)) return 0;
  return Math.max(0, Math.floor((asOf.getTime() - t) / 86_400_000));
}

export function ingestHonesty(
  totalAudits: number,
  lastSuccessAt: string | null,
  asOf = new Date(),
  staleAfterDays = AUDIT_STALE_AFTER_DAYS,
): AuditHonesty {
  if (totalAudits <= 0 && !lastSuccessAt) return "empty";
  if (!lastSuccessAt) return totalAudits > 0 ? "live" : "empty";
  const age = openAgeDays(lastSuccessAt, asOf);
  if (age > staleAfterDays) return "stale";
  return totalAudits > 0 ? "live" : "empty";
}

export function honestyLabel(h: AuditHonesty): string {
  if (h === "empty") return "None yet";
  if (h === "stale") return "Stale";
  return "Live";
}

export function emptyHeadline(): DocumentAuditsHeadline {
  return {
    total: 0,
    open_findings: 0,
    critical_high: 0,
    doctors_with_findings: 0,
    last_ingest: null,
    honesty: "empty",
    honesty_label: "None yet",
  };
}

export function buildHeadline(opts: {
  total: number;
  openFindings: number;
  criticalHigh: number;
  doctorsWithFindings: number;
  lastIngest: string | null;
  asOf?: Date;
}): DocumentAuditsHeadline {
  const honesty = ingestHonesty(opts.total, opts.lastIngest, opts.asOf);
  return {
    total: opts.total,
    open_findings: opts.openFindings,
    critical_high: opts.criticalHigh,
    doctors_with_findings: opts.doctorsWithFindings,
    last_ingest: opts.lastIngest,
    honesty,
    honesty_label: honestyLabel(honesty),
  };
}

export function toListItem(row: DocumentAuditRow, asOf = new Date()): DocumentAuditListItem {
  const docType = normalizeDocType(row.doc_type) ?? "progress";
  const severity = row.severity ? normalizeSeverity(row.severity) : null;
  const status = row.status ? normalizePipeStatus(row.status) : null;
  const anchor = row.authored_at ?? row.ingested_at;
  return {
    id: row.id,
    finding_id: row.finding_id,
    external_ref: row.external_ref,
    hospital_code: row.hospital_code,
    physician_id: row.physician_id,
    physician_name: row.physician_name,
    specialty: row.specialty,
    doc_type: docType,
    doc_type_label: DOC_TYPE_LABEL[docType],
    finding_label: row.finding_label ?? "—",
    severity,
    severity_label: severity ? SEVERITY_LABEL[severity] : null,
    status,
    status_label: status ? PIPE_STATUS_LABEL[status] : null,
    authored_by_name: row.authored_by_name,
    authored_at: row.authored_at,
    note_date: row.note_date,
    open_age_days: status && OPEN_PIPE.has(status) ? openAgeDays(anchor, asOf) : null,
    cdmss_pdf_url: row.cdmss_pdf_url,
    portal_visible: row.portal_visible,
  };
}

export function filterAuditRows(
  rows: DocumentAuditListItem[],
  opts: {
    query?: string;
    physicianId?: string | null;
    docType?: DocType | "all";
    severity?: FindingSeverity | "all";
    status?: PipeStatus | "all";
  },
): DocumentAuditListItem[] {
  const q = (opts.query ?? "").trim().toLowerCase();
  return rows.filter((row) => {
    if (opts.physicianId && row.physician_id !== opts.physicianId) return false;
    if (opts.docType && opts.docType !== "all" && row.doc_type !== opts.docType) return false;
    if (opts.severity && opts.severity !== "all" && row.severity !== opts.severity) return false;
    if (opts.status && opts.status !== "all" && row.status !== opts.status) return false;
    if (!q) return true;
    return (
      row.physician_name.toLowerCase().includes(q) ||
      row.specialty.toLowerCase().includes(q) ||
      row.physician_id.toLowerCase().includes(q) ||
      (row.external_ref ?? "").toLowerCase().includes(q) ||
      row.finding_label.toLowerCase().includes(q)
    );
  });
}

/** Severity × recurrence × open age — higher = more urgent for SGC. */
export function exceptionScore(opts: {
  severity: FindingSeverity;
  recurrence: number;
  openAgeDays: number;
}): number {
  const sevW =
    opts.severity === "critical" ? 40 : opts.severity === "high" ? 28 : opts.severity === "medium" ? 14 : 6;
  const recW = Math.min(30, Math.max(0, opts.recurrence - 1) * 8);
  const ageW = Math.min(30, Math.floor(opts.openAgeDays / 2));
  return sevW + recW + ageW;
}

export function isSlaRisk(openAge: number, severity: FindingSeverity): boolean {
  if (severity === "critical") return openAge >= 3;
  if (severity === "high") return openAge >= 5;
  return openAge >= 10;
}

/**
 * Resolve a CDMSS audit-findings PDF URL.
 * Prefer an explicit URL; otherwise build from audit id when present.
 */
export function resolveAuditPdfUrl(opts: {
  pdf_url?: string | null;
  cdmss_pdf_url?: string | null;
  audit_id?: string | null;
  external_ref?: string | null;
}): string | null {
  const direct = opts.pdf_url || opts.cdmss_pdf_url;
  if (typeof direct === "string" && direct.startsWith("http")) return direct;
  const base = process.env.GOV_API_BASE || "https://even-cdmss.vercel.app";
  const id = opts.audit_id || opts.external_ref;
  if (typeof id === "string" && id.trim()) {
    return `${base}/api/governance/audits/${encodeURIComponent(id.trim())}/pdf`;
  }
  return null;
}

export function remediatorLabel(physicianName: string): string {
  return `Remediator: ${physicianName} (portal)`;
}

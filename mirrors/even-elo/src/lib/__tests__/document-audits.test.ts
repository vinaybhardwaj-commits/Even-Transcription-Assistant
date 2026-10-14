import { describe, expect, it } from "vitest";
import {
  buildHeadline,
  exceptionScore,
  filterAuditRows,
  ingestHonesty,
  isSlaRisk,
  normalizeDocType,
  normalizePipeStatus,
  normalizeSeverity,
  openAgeDays,
  remediatorLabel,
  resolveAuditPdfUrl,
  toListItem,
  type DocumentAuditRow,
} from "../document-audits";
import {
  ADHERENCE_EMPTY_LABEL,
  computeAdherencePresentation,
  emptyAdherenceInputs,
} from "../adherence-stage4";
import {
  mapDocumentAuditDetailRows,
  type DocumentAuditDetailRow,
} from "../document-audits-db";

describe("document-audits shaping", () => {
  it("normalises doc types, severity, and pipe status aliases", () => {
    expect(normalizeDocType("discharge_summary")).toBe("discharge");
    expect(normalizeSeverity("crit")).toBe("critical");
    expect(normalizePipeStatus("progress")).toBe("in_progress");
    expect(normalizeDocType("nope")).toBeNull();
  });

  it("labels empty / live / stale ingest honesty without inventing volumes", () => {
    expect(ingestHonesty(0, null)).toBe("empty");
    expect(ingestHonesty(3, new Date().toISOString())).toBe("live");
    const old = new Date(Date.now() - 20 * 86_400_000).toISOString();
    expect(ingestHonesty(3, old)).toBe("stale");
  });

  it("builds an honest empty headline", () => {
    const h = buildHeadline({
      total: 0,
      openFindings: 0,
      criticalHigh: 0,
      doctorsWithFindings: 0,
      lastIngest: null,
    });
    expect(h.honesty).toBe("empty");
    expect(h.honesty_label).toBe("None yet");
    expect(h.total).toBe(0);
  });

  it("maps rows with RMO author and remediator note helpers", () => {
    const row: DocumentAuditRow = {
      id: "a1",
      external_ref: "DA-1",
      hospital_code: "EHRC",
      physician_id: "p1",
      physician_name: "Dr. Test",
      specialty: "ENT",
      doc_type: "progress",
      note_date: "2026-09-18",
      ingested_at: "2026-09-18T10:00:00.000Z",
      cdmss_pdf_url: null,
      triage_routed_at: null,
      finding_id: "f1",
      finding_label: "Missing reassessment",
      finding_body: "Timed reassessment not documented",
      severity: "high",
      status: "open",
      authored_by_name: "RMO Sharma",
      authored_at: "2026-09-18T11:00:00.000Z",
      recurrence_count: 2,
      portal_visible: true,
      doctor_responded_at: null,
    };
    const item = toListItem(row, new Date("2026-09-22T00:00:00.000Z"));
    expect(item.authored_by_name).toBe("RMO Sharma");
    expect(item.open_age_days).toBe(openAgeDays(row.authored_at, new Date("2026-09-22T00:00:00.000Z")));
    expect(remediatorLabel("Dr. Test")).toContain("portal");
  });

  it("filters by physician, doc type, and status", () => {
    const rows = [
      toListItem({
        id: "a1",
        external_ref: "DA-1",
        hospital_code: "EHRC",
        physician_id: "p1",
        physician_name: "Dr. A",
        specialty: "ENT",
        doc_type: "ot",
        note_date: null,
        ingested_at: "2026-09-18T10:00:00.000Z",
        cdmss_pdf_url: null,
        triage_routed_at: null,
        finding_id: "f1",
        finding_label: "Consent gap",
        finding_body: null,
        severity: "critical",
        status: "escalated",
        authored_by_name: "RMO X",
        authored_at: "2026-09-18T10:00:00.000Z",
        recurrence_count: 1,
        portal_visible: false,
        doctor_responded_at: null,
      }),
    ];
    expect(filterAuditRows(rows, { docType: "ot" })).toHaveLength(1);
    expect(filterAuditRows(rows, { docType: "progress" })).toHaveLength(0);
    expect(filterAuditRows(rows, { status: "escalated" })).toHaveLength(1);
    expect(filterAuditRows(rows, { physicianId: "p2" })).toHaveLength(0);
  });

  it("scores SGC exceptions by severity × recurrence × open age", () => {
    const high = exceptionScore({ severity: "critical", recurrence: 3, openAgeDays: 10 });
    const low = exceptionScore({ severity: "low", recurrence: 1, openAgeDays: 1 });
    expect(high).toBeGreaterThan(low);
    expect(isSlaRisk(5, "high")).toBe(true);
    expect(isSlaRisk(2, "low")).toBe(false);
  });

  it("resolves PDF urls from explicit or audit id", () => {
    expect(resolveAuditPdfUrl({ pdf_url: "https://cdn.example/a.pdf" })).toBe("https://cdn.example/a.pdf");
    expect(resolveAuditPdfUrl({ audit_id: "AUD-1" })).toContain("/audits/AUD-1/pdf");
    expect(resolveAuditPdfUrl({})).toBeNull();
  });

  it("maps an audit detail with all findings and doctor responses", () => {
    const base: Omit<
      DocumentAuditDetailRow,
      | "finding_id"
      | "finding_label"
      | "finding_body"
      | "severity"
      | "status"
      | "authored_by_name"
      | "authored_at"
      | "portal_visible"
      | "response_owner"
      | "signal_reference"
      | "doctor_response_verb"
      | "doctor_response_comment"
      | "doctor_responded_at"
    > = {
      id: "a1",
      external_ref: "DA-1",
      source_audit_id: "CDMSS-1",
      hospital_code: "EHRC",
      physician_id: "p1",
      physician_name: "Dr. Test",
      specialty: "ENT",
      doc_type: "progress",
      note_date: "2026-09-18",
      ingested_at: "2026-09-18T10:00:00.000Z",
      cdmss_pdf_url: "https://example.test/audit.pdf",
    };
    const rows: DocumentAuditDetailRow[] = [
      {
        ...base,
        finding_id: "f1",
        finding_label: "Missing reassessment",
        finding_body: "Timed reassessment not documented",
        severity: "high",
        status: "contested",
        authored_by_name: "Sharma",
        authored_at: "2026-09-18T11:00:00.000Z",
        portal_visible: true,
        response_owner: "local",
        signal_reference: "EHRC-AUD-1",
        doctor_response_verb: "disagree",
        doctor_response_comment: "Reassessment is in the addendum.",
        doctor_responded_at: "2026-09-19T11:00:00.000Z",
      },
      {
        ...base,
        finding_id: "f2",
        finding_label: "Unsigned note",
        finding_body: null,
        severity: "medium",
        status: "open",
        authored_by_name: "Sharma",
        authored_at: "2026-09-18T10:30:00.000Z",
        portal_visible: false,
        response_owner: "pipe_a",
        signal_reference: null,
        doctor_response_verb: null,
        doctor_response_comment: null,
        doctor_responded_at: null,
      },
    ];

    const detail = mapDocumentAuditDetailRows(rows);
    expect(detail?.audit.source_audit_id).toBe("CDMSS-1");
    expect(detail?.audit.doc_type_label).toBe("Progress note");
    expect(detail?.findings).toHaveLength(2);
    expect(detail?.findings[0]).toMatchObject({
      id: "f1",
      doctor_response_verb: "disagree",
      doctor_response_comment: "Reassessment is in the addendum.",
      portal_visible: true,
    });
  });
});

describe("adherence stage 4", () => {
  it("stays honestly empty with no inputs", () => {
    const p = computeAdherencePresentation(emptyAdherenceInputs());
    expect(p.state).toBe("empty");
    expect(p.percent).toBeNull();
    expect(p.label).toBe(ADHERENCE_EMPTY_LABEL);
  });

  it("computes a live percent from document audits", () => {
    const p = computeAdherencePresentation({
      auditFindingCount: 10,
      remediatedCount: 8,
      openPressureCount: 1,
      surgicalFeedbackCount: 2,
      snapshotPercent: null,
    });
    expect(p.state).toBe("live");
    expect(p.percent).not.toBeNull();
    expect(p.label).toContain("%");
  });

  it("prefers score snapshot percent when present", () => {
    const p = computeAdherencePresentation({
      auditFindingCount: 0,
      remediatedCount: 0,
      openPressureCount: 0,
      surgicalFeedbackCount: 0,
      snapshotPercent: 88.2,
    });
    expect(p.state).toBe("live");
    expect(p.percent).toBe(88);
  });
});

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  authorAttribution,
  portalPdfStatus,
  portalResponseOwner,
  SYSTEM_AUDIT_AUTHOR,
} from "../document-audits";
import {
  acceptAuditPdfUrl,
  buildQueueItemRef,
  hasAllPlannedFindings,
  mapFindingSeverity,
  matchRoutedFindings,
  planDocumentAuditIngest,
  preserveAuditReference,
  preserveQueueItemRef,
  shouldProbeAuditPdf,
  type LocalFindingKey,
  type PlannedAudit,
} from "../document-audit-ingest";
import { buildDocumentAuditsExportUrl } from "../document-audit-ingest-db";

const root = join(__dirname, "../../..");

describe("document-audit ingest plan", () => {
  const payload = {
    ok: true,
    supports: { ot: true, discharge: true, progress: false },
    audits: [
      {
        audit_id: "ot-1",
        doc_type: "ot",
        map_status: "mapped",
        doctor_uid: "doc-ot",
        note_day: "2026-09-18",
        hospital_code: "ehrc",
        pdf_url: "https://cdmss.example/ot-1.pdf",
        pdf_kind: "audit_findings",
        findings: [
          {
            finding_ref: "f-ot",
            subject: "Consent gap",
            rationale: "Consent time missing",
            verdict: "fail",
            signal_type: "consent_gap",
            queue_item_ref: "ot|doc-ot|consent_gap",
          },
        ],
      },
      {
        audit_id: "ot-2",
        doc_type: "ot",
        map_status: "unmapped",
        doctor_uid: "doc-raw",
        findings: [{ subject: "Should skip" }],
      },
      {
        id: "ds-1",
        doc_type: "discharge_summary",
        doctor_uid: "doc-ds",
        discharged_at: "2026-09-20T07:18:00.000Z",
        hospital_uid: "EHBR",
        pdf_url: "https://files.example/clinical.pdf",
        pdf_kind: "source_document",
        findings: [
          {
            finding_ref: "f-ds",
            subject: "Med rec gap",
            importance: "critical",
            signal_type: "med_rec",
            reference: "ehrc-aud-2026-0042",
          },
        ],
      },
      {
        id: "ds-2",
        doc_type: "discharge",
        findings: [{ subject: "No doctor" }],
      },
      {
        id: "pr-1",
        doc_type: "progress",
        doctor_uid: "doc-pr",
        findings: [{ subject: "Progress finding", signal_type: "reassessment" }],
      },
      {
        doc_type: "opd",
        doctor_uid: "doc-opd",
        external_ref: "opd-1",
        findings: [{ subject: "OPD stays on Pipe A" }],
      },
    ],
    routed_signals: [
      {
        note_class: "discharge_summary",
        doctor_uid: "doc-ds",
        signal_type: "med_rec",
        finding_ref: "f-ds",
        audit_id: "ds-1",
        reference: "EHRC-AUD-2026-0042",
        routed_at: "2026-09-21T04:00:00.000Z",
        status: "routed",
      },
      {
        note_class: "ot",
        doctor_uid: "doc-ot",
        signal_type: "consent_gap",
        finding_ref: "f-other",
        status: "hold",
      },
    ],
  };

  it("ingests mapped OT and discharge with a doctor, and defers progress", () => {
    const plan = planDocumentAuditIngest(payload);
    expect(plan.ok).toBe(true);
    if (!plan.ok) return;
    expect(plan.progress_supported).toBe(false);
    expect(plan.audits.map((a) => a.external_ref).sort()).toEqual(["ds:ds-1", "ot:ot-1"]);
    const ot = plan.audits.find((a) => a.doc_type === "ot");
    expect(ot?.doctor_uid).toBe("doc-ot");
    expect(ot?.hospital_code).toBe("EHRC");
    expect(ot?.pdf_url).toBe("https://cdmss.example/ot-1.pdf");
    expect(ot?.findings[0]?.severity).toBe("high");
    expect(ot?.findings[0]?.queue_item_ref).toBe("ot|doc-ot|consent_gap");
    const ds = plan.audits.find((a) => a.doc_type === "discharge");
    expect(ds?.note_class).toBe("discharge_summary");
    expect(ds?.note_date).toBe("2026-09-20");
    expect(ds?.hospital_code).toBe("EHBR");
    expect(ds?.pdf_url).toBeNull();
    expect(ds?.pdf_probe_id).toBe("ds-1");
    expect(ds?.findings[0]?.severity).toBe("critical");
    expect(ds?.findings[0]?.signal_reference).toBe("EHRC-AUD-2026-0042");
    expect(ds?.findings[0]?.queue_item_ref).toBe(buildQueueItemRef("discharge_summary", "doc-ds", "med_rec"));
    expect(plan.skips.map((s) => s.reason).sort()).toEqual([
      "discharge_no_doctor",
      "opd_not_stage4",
      "ot_not_mapped",
      "progress_unsupported",
    ]);
    expect(plan.signals).toHaveLength(1);
    expect(plan.signals[0]?.reference).toBe("EHRC-AUD-2026-0042");
  });

  it("ingests progress only when the export says the store exists", () => {
    const plan = planDocumentAuditIngest({
      supports: { progress: true },
      audits: [
        {
          external_ref: "progress:1",
          doc_type: "progress",
          doctor_uid: "doc-pr",
          audit_id: "p1",
          findings: [{ finding_ref: "fp", subject: "Reassessment", verdict: "partial" }],
        },
        {
          external_ref: "progress:2",
          doc_type: "progress",
          findings: [{ subject: "No doctor" }],
        },
      ],
    });
    expect(plan.ok).toBe(true);
    if (!plan.ok) return;
    expect(plan.progress_supported).toBe(true);
    expect(plan.audits).toHaveLength(1);
    expect(plan.audits[0]?.findings[0]?.severity).toBe("medium");
    expect(plan.skips.map((s) => s.reason)).toEqual(["progress_no_doctor"]);
  });

  it("does not publish portal flags from the plan itself", () => {
    const plan = planDocumentAuditIngest(payload);
    expect(plan.ok).toBe(true);
    if (!plan.ok) return;
    expect(JSON.stringify(plan.audits)).not.toContain("portal_visible");
  });
});

describe("route match", () => {
  const local: LocalFindingKey = {
    finding_id: "local-1",
    audit_row_id: "audit-row",
    external_ref: "ds:ds-1",
    source_audit_id: "ds-1",
    doctor_uid: "doc-ds",
    note_class: "discharge_summary",
    finding_ref: "f-ds",
    queue_item_ref: "discharge_summary|doc-ds|med_rec",
    signal_type: "med_rec",
    signal_reference: "EHRC-AUD-2026-0042",
  };

  it("matches finding_ref plus audit id and ignores a different finding", () => {
    const hits = matchRoutedFindings(
      [local, { ...local, finding_id: "local-2", finding_ref: "f-other" }],
      [
        {
          note_class: "discharge_summary",
          doctor_uid: "doc-ds",
          signal_type: "med_rec",
          queue_item_ref: "discharge_summary|doc-ds|med_rec",
          audit_id: "ds-1",
          finding_ref: "f-ds",
          reference: "EHRC-AUD-2026-0042",
          routed_at: "2026-09-21T04:00:00.000Z",
          status: "routed",
        },
      ],
    );
    expect(hits.map((h) => h.finding_id)).toEqual(["local-1"]);
    expect(hits[0]?.signal_reference).toBe("EHRC-AUD-2026-0042");
  });

  it("does not match on doctor uid alone", () => {
    const hits = matchRoutedFindings(
      [{ ...local, finding_ref: null, queue_item_ref: null, signal_reference: null, signal_type: null }],
      [
        {
          note_class: "ot",
          doctor_uid: "doc-ds",
          signal_type: null,
          queue_item_ref: null,
          audit_id: null,
          finding_ref: null,
          reference: null,
          routed_at: null,
          status: "routed",
        },
      ],
    );
    expect(hits).toHaveLength(0);
  });

  it("can match an OT signal when one is actually present", () => {
    const hits = matchRoutedFindings(
      [
        {
          ...local,
          finding_ref: "f-ot",
          doctor_uid: "doc-ot",
          note_class: "ot",
          source_audit_id: "ot-1",
          queue_item_ref: "ot|doc-ot|consent_gap",
          signal_reference: null,
        },
      ],
      [
        {
          note_class: "ot",
          doctor_uid: "doc-ot",
          signal_type: "consent_gap",
          queue_item_ref: "ot|doc-ot|consent_gap",
          audit_id: "ot-1",
          finding_ref: "f-ot",
          reference: null,
          routed_at: null,
          status: "routed",
        },
      ],
    );
    expect(hits).toHaveLength(1);
  });
});

describe("existing audit skip", () => {
  const audit = {
    external_ref: "ds:ds-1",
    pdf_url: null,
    pdf_probe_id: "ds-1",
    findings: [{ finding_ref: "f-1" }, { finding_ref: "f-2" }],
  } as PlannedAudit;

  it("skips only when every planned finding ref already exists on the same audit", () => {
    expect(
      hasAllPlannedFindings(audit, {
        external_ref: "ds:ds-1",
        finding_refs: ["f-2", "older-extra", "f-1"],
      }),
    ).toBe(true);
    expect(
      hasAllPlannedFindings(audit, {
        external_ref: "ds:ds-1",
        finding_refs: ["f-1"],
      }),
    ).toBe(false);
    expect(
      hasAllPlannedFindings(audit, {
        external_ref: "ds:other",
        finding_refs: ["f-1", "f-2"],
      }),
    ).toBe(false);
    expect(hasAllPlannedFindings(audit, undefined)).toBe(false);
  });

  it("treats an existing audit with no planned findings as complete", () => {
    expect(
      hasAllPlannedFindings(
        { ...audit, findings: [] },
        { external_ref: "ds:ds-1", finding_refs: [] },
      ),
    ).toBe(true);
  });

  it("probes PDFs only for new rows or existing rows missing a PDF", () => {
    expect(shouldProbeAuditPdf(audit, undefined)).toBe(true);
    expect(shouldProbeAuditPdf(audit, null)).toBe(true);
    expect(shouldProbeAuditPdf(audit, "https://stored.example/a.pdf")).toBe(false);
    expect(
      shouldProbeAuditPdf({ ...audit, pdf_url: "https://export.example/a.pdf" }, null),
    ).toBe(false);
  });
});

describe("severity, keys, and PDF honesty", () => {
  it("maps verdict and importance without inventing critical", () => {
    expect(mapFindingSeverity({ verdict: "fail" })).toBe("high");
    expect(mapFindingSeverity({ importance: "low" })).toBe("low");
    expect(mapFindingSeverity({ severity: "medium", verdict: "fail" })).toBe("medium");
    expect(mapFindingSeverity({})).toBe("low");
  });

  it("preserves queue_item_ref and EHRC-AUD references", () => {
    expect(preserveQueueItemRef("ot|doc-1|consent_gap")).toBe("ot|doc-1|consent_gap");
    expect(preserveQueueItemRef("not a key")).toBeNull();
    expect(preserveAuditReference("ehrc-aud-2026-0007")).toBe("EHRC-AUD-2026-0007");
    expect(preserveAuditReference("note-88")).toBeNull();
    expect(buildQueueItemRef("ot", "doc-1", "consent_gap")).toBe("ot|doc-1|consent_gap");
  });

  it("rejects clinical source PDFs and guessed paths", () => {
    expect(acceptAuditPdfUrl("https://files.example/a.pdf", "source_document")).toBeNull();
    expect(acceptAuditPdfUrl("https://cdmss.example/a.pdf", "audit_findings")).toBe(
      "https://cdmss.example/a.pdf",
    );
    expect(portalPdfStatus(null)).toEqual({ pdf_url: null, pdf_status: "unavailable" });
    expect(portalPdfStatus("/api/governance/audits/x/pdf").pdf_status).toBe("unavailable");
  });

  it("names the system author without calling them an RMO", () => {
    expect(SYSTEM_AUDIT_AUTHOR).toBe("CDMSS audit (pending RMO review)");
    expect(authorAttribution(SYSTEM_AUDIT_AUTHOR)).toBe(SYSTEM_AUDIT_AUTHOR);
    expect(authorAttribution("Dr A")).toBe("RMO Dr A");
    expect(portalResponseOwner("pipe_a", null)).toBe("pipe_a");
    expect(portalResponseOwner(null, "EHRC-AUD-2026-0001")).toBe("pipe_a");
    expect(portalResponseOwner("local", "EHRC-AUD-2026-0001")).toBe("local");
  });
});

describe("export URL builder", () => {
  const base = "https://even-cdmss.vercel.app";
  const path = "/api/governance/document-audits-export";

  it("omits query string when no filters are set so CDMSS keeps its defaults", () => {
    expect(buildDocumentAuditsExportUrl(base)).toBe(`${base}${path}`);
    expect(buildDocumentAuditsExportUrl(`${base}/`, {})).toBe(`${base}${path}`);
    expect(
      buildDocumentAuditsExportUrl(base, {
        window: "",
        note_class: null,
        from: "not-a-day",
        to: "2026-9-1",
      }),
    ).toBe(`${base}${path}`);
  });

  it("forwards only provided window, note_class, from, and to", () => {
    const url = buildDocumentAuditsExportUrl(base, {
      window: 30,
      note_class: "ot",
      from: "2026-09-01",
      to: "2026-09-21",
    });
    expect(url.startsWith(`${base}${path}?`)).toBe(true);
    const qs = new URL(url).searchParams;
    expect(qs.get("window")).toBe("30");
    expect(qs.get("note_class")).toBe("ot");
    expect(qs.get("from")).toBe("2026-09-01");
    expect(qs.get("to")).toBe("2026-09-21");
  });

  it("drops invalid note_class and non-integer window", () => {
    const url = buildDocumentAuditsExportUrl(base, {
      window: "7.5",
      note_class: "opd",
      from: "2026-09-01",
    });
    const qs = new URL(url).searchParams;
    expect(qs.has("window")).toBe(false);
    expect(qs.has("note_class")).toBe(false);
    expect(qs.get("from")).toBe("2026-09-01");
    expect(Array.from(qs.keys()).sort()).toEqual(["from"]);
  });
});

describe("ingest wiring", () => {
  it("schedules the cron and keeps the portal from inventing a PDF", () => {
    const vercel = readFileSync(join(root, "vercel.json"), "utf8");
    expect(vercel).toContain("/api/cron/document-audit-ingest");
    const cron = readFileSync(join(root, "src/app/api/cron/document-audit-ingest/route.ts"), "utf8");
    // A1: bearer-only. No User-Agent trust, no session fallback.
    expect(cron).not.toContain("vercel-cron/");
    expect(cron).not.toContain("getCurrentUser");
    expect(cron).toContain("cronGuard");
    expect(cron).toContain("runDocumentAuditIngest");
    expect(cron).toContain("maxDuration = 300");
    expect(cron).toContain("?note_class=ot");
    expect(cron).toContain("?window=30");
    const portal = readFileSync(join(root, "src/app/api/portal/document-audits/route.ts"), "utf8");
    expect(portal).toContain("toDocumentCards");
    expect(portal).not.toContain("resolveAuditPdfUrl");
    const findings = readFileSync(join(root, "src/components/portal/FindingsForDoctor.tsx"), "utf8");
    expect(findings).toContain("export function FindingsForDoctor");
    expect(findings).toContain('["ot", "OT"]');
    const migration = readFileSync(join(root, "src/lib/migrations.ts"), "utf8");
    expect(migration).toContain("031_document_audit_ingest_keys");
    expect(migration).toContain("finding_ref");
  });
});

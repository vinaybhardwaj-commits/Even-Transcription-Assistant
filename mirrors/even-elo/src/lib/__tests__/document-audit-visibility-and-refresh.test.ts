import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * F4 (per-finding visibility) and F5 (ingest refreshes content, preserves responses, honest timing).
 *
 * The database is a fake that records every statement and answers the handful of reads ingest
 * makes, so these tests exercise the real SQL text and the real value order, not a re-statement.
 */

type Call = { q: string; values: unknown[] };
const h = vi.hoisted(() => ({
  calls: [] as Array<{ q: string; values: unknown[] }>,
  existing: [] as Array<Record<string, unknown>>,
  locals: [] as Array<Record<string, unknown>>,
  deadlineInPast: false,
  /** Who holds the doctor uid directly (null = nobody), and who lists it as an alias. */
  directHolder: "00000000-0000-4000-8000-0000000000aa" as string | null,
  aliasHolders: [] as Array<{ id: string }>,
  /** What the "why was nothing updated" lookup in recordDoctorFindingResponse finds. */
  respondLookup: [] as Array<Record<string, unknown>>,
}));

vi.mock("@/lib/db", () => ({
  sql: async (strings: TemplateStringsArray, ...values: unknown[]) => {
    const q = Array.from(strings).join("?");
    h.calls.push({ q, values });
    if (q.includes("FROM document_audits da") && q.includes("ANY(")) return h.existing;
    if (q.includes("FROM hospitals")) return [{ id: "00000000-0000-4000-8000-000000000001" }];
    if (q.includes("SELECT status, response_owner")) return h.respondLookup;
    if (q.includes("FROM physicians")) {
      if (q.includes("ANY(cdmss_alias_uids)")) return h.aliasHolders;
      return h.directHolder ? [{ id: h.directHolder }] : [];
    }
    if (q.includes("INSERT INTO document_audits (")) return [{ id: "00000000-0000-4000-8000-0000000000bb" }];
    if (q.includes("FROM document_audit_findings f") && q.includes("JOIN document_audits da")) return h.locals;
    return [];
  },
}));

vi.mock("@/lib/ingest-timing", async () => {
  const actual = await vi.importActual<typeof import("@/lib/ingest-timing")>("@/lib/ingest-timing");
  return { ...actual, workDeadlineMs: (s: number) => (h.deadlineInPast ? 0 : actual.workDeadlineMs(s)) };
});

import {
  findingContentHash,
  hasAllPlannedFindings,
  isRouteHitCurrent,
  matchRoutedFindings,
  parseCitations,
  parsePatient,
  planDocumentAuditIngest,
  type LocalFindingKey,
  type PlannedAudit,
  type RoutedSignal,
} from "@/lib/document-audit-ingest";
import { runDocumentAuditIngest } from "@/lib/document-audit-ingest-db";
import { loadPortalRoutedFindings, recordDoctorFindingResponse } from "@/lib/document-audits-db";
import {
  INGEST_MAX_DURATION_S,
  PARTIAL_RUN_MARKER,
  exportTimeoutMs,
  workDeadlineMs,
} from "@/lib/ingest-timing";

const SRC = (p: string) => readFileSync(join(process.cwd(), p), "utf8");

function exportPayload(over: { rationale?: string; routed2?: boolean | null; extra?: Record<string, unknown> } = {}) {
  return {
    ok: true,
    audits: [
      {
        audit_id: "aud-1",
        doc_type: "discharge",
        note_class: "discharge_summary",
        doctor_uid: "DOC-1",
        note_date: "2026-09-20",
        hospital_code: "EHRC",
        pdf_available: false,
        findings: [
          {
            finding_ref: "f-1",
            subject: "Discharge medications not reconciled",
            rationale: over.rationale ?? "Home medicines are not listed against the discharge list.",
            signal_type: "documentation_gap",
            importance: "high",
            routed: true,
            evidence_excerpt: "Tab X 5mg OD continued",
            citations: [{ title: "Discharge policy 4.2", url: "https://example.test/p42" }],
            patient: { name: "Asha Rao", age: 54, sex: "F", ip_number: "IP-1001", uhid: "U-77" },
            ...over.extra,
          },
          {
            finding_ref: "f-2",
            subject: "Follow-up date missing",
            rationale: "No review date written.",
            signal_type: "followup_missing",
            routed: over.routed2 === undefined ? false : over.routed2,
          },
        ],
      },
    ],
    routed_signals: [],
  };
}

function planned(over?: Parameters<typeof exportPayload>[0]): PlannedAudit {
  const plan = planDocumentAuditIngest(exportPayload(over));
  if (!plan.ok) throw new Error(plan.error);
  return plan.audits[0];
}

describe("contract fields reach the plan", () => {
  it("parses routed, evidence excerpt, citations, patient and note date per finding", () => {
    const [f1, f2] = planned().findings;
    expect(f1.routed).toBe(true);
    expect(f2.routed).toBe(false);
    expect(f1.evidence_excerpt).toBe("Tab X 5mg OD continued");
    expect(f1.citations).toEqual([{ title: "Discharge policy 4.2", url: "https://example.test/p42" }]);
    expect(f1.patient).toEqual({ name: "Asha Rao", age: "54", sex: "F", ip_number: "IP-1001", uhid: "U-77" });
    expect(f1.note_date).toBe("2026-09-20");
    expect(f2.evidence_excerpt).toBeNull();
    expect(f2.citations).toEqual([]);
    expect(f2.patient).toBeNull();
  });

  it("an absent routed field is null (older CDMSS), not false", () => {
    const plan = planDocumentAuditIngest({
      ok: true,
      audits: [
        {
          audit_id: "a",
          doc_type: "ot",
          doctor_uid: "D",
          map_status: "mapped",
          findings: [{ finding_ref: "r", subject: "s" }],
        },
      ],
    });
    if (!plan.ok) throw new Error("plan");
    expect(plan.audits[0].findings[0].routed).toBeNull();
  });

  it("caps the evidence excerpt at 600 characters and keeps `evidence` out of the rationale slot", () => {
    const long = "x".repeat(900);
    const plan = planDocumentAuditIngest({
      ok: true,
      audits: [
        {
          audit_id: "a",
          doc_type: "discharge",
          doctor_uid: "D",
          findings: [{ finding_ref: "r", subject: "s", evidence: long }],
        },
      ],
    });
    if (!plan.ok) throw new Error("plan");
    const f = plan.audits[0].findings[0];
    expect(f.evidence_excerpt).toHaveLength(600);
    expect(f.finding_body).toBeNull();
  });

  it("parsePatient and parseCitations drop junk and never invent values", () => {
    expect(parsePatient(null)).toBeNull();
    expect(parsePatient({})).toBeNull();
    expect(parsePatient({ name: "  ", age: null })).toBeNull();
    expect(parsePatient({ uhid: "U1" })).toEqual({ name: null, age: null, sex: null, ip_number: null, uhid: "U1" });
    expect(parseCitations("nope")).toEqual([]);
    expect(
      parseCitations([{ title: "A", url: "javascript:alert(1)" }, { url: "https://x.test" }, "Plain title", { title: "A", url: "javascript:alert(1)" }]),
    ).toEqual([
      { title: "A", url: null },
      { title: "Plain title", url: null },
    ]);
  });

  it("the content hash moves with content and holds when nothing changed", () => {
    const a = planned().findings[0];
    const same = planned().findings[0];
    const changed = planned({ rationale: "Rewritten rationale." }).findings[0];
    expect(a.content_hash).toBe(same.content_hash);
    expect(changed.content_hash).not.toBe(a.content_hash);
    expect(findingContentHash({ ...a })).toBe(a.content_hash);
  });
});

describe("hasAllPlannedFindings with stored hashes (F5)", () => {
  const audit = () => planned();
  const key = (hashes: Record<string, string | null> | undefined) => ({
    external_ref: audit().external_ref,
    finding_refs: ["f-1", "f-2"],
    finding_hashes: hashes,
  });

  it("skips when every hash is unchanged", () => {
    const a = audit();
    const hashes = Object.fromEntries(a.findings.map((f) => [f.finding_ref, f.content_hash]));
    expect(hasAllPlannedFindings(a, key(hashes))).toBe(true);
  });

  it("does not skip when CDMSS changed one finding", () => {
    const a = audit();
    const hashes = Object.fromEntries(a.findings.map((f) => [f.finding_ref, f.content_hash]));
    hashes["f-1"] = "stale";
    expect(hasAllPlannedFindings(a, key(hashes))).toBe(false);
  });

  it("does not skip rows written before hashing existed (null hash), so they backfill once", () => {
    expect(hasAllPlannedFindings(audit(), key({ "f-1": null, "f-2": null }))).toBe(false);
  });

  it("still treats missing hashes (legacy callers) as presence-only", () => {
    expect(hasAllPlannedFindings(audit(), key(undefined))).toBe(true);
  });
});

describe("per-finding routing (F4)", () => {
  const local = (over: Partial<LocalFindingKey>): LocalFindingKey => ({
    finding_id: "fid",
    audit_row_id: "aid",
    external_ref: "ds:aud-1",
    source_audit_id: "aud-1",
    doctor_uid: "DOC-1",
    note_class: "discharge_summary",
    finding_ref: "f-1",
    queue_item_ref: "discharge_summary|DOC-1|documentation_gap",
    signal_type: "documentation_gap",
    signal_reference: null,
    ...over,
  });
  const signal: RoutedSignal = {
    note_class: "discharge_summary",
    doctor_uid: "DOC-1",
    signal_type: "documentation_gap",
    queue_item_ref: "discharge_summary|DOC-1|documentation_gap",
    audit_id: null,
    finding_ref: null,
    reference: "EHRC-AUD-2026-0042",
    routed_at: "2026-09-21T00:00:00Z",
    status: "routed",
  };

  it("a routed signal opens only findings of its own type, not siblings on the same audit", () => {
    const hits = matchRoutedFindings(
      [
        local({ finding_id: "f1" }),
        local({
          finding_id: "f2",
          finding_ref: "f-2",
          signal_type: "followup_missing",
          queue_item_ref: "discharge_summary|DOC-1|followup_missing",
        }),
      ],
      [signal],
    );
    expect(hits.map((x) => x.finding_id)).toEqual(["f1"]);
  });

  it("CDMSS saying routed=false for a finding vetoes the signal-key match", () => {
    expect(matchRoutedFindings([local({ cdmss_routed: false })], [signal])).toEqual([]);
    expect(matchRoutedFindings([local({ cdmss_routed: null })], [signal])).toHaveLength(1);
  });

  it("isRouteHitCurrent skips rewriting a row that already has the state", () => {
    const hit = matchRoutedFindings([local({})], [signal])[0];
    expect(isRouteHitCurrent(undefined, hit)).toBe(false);
    expect(isRouteHitCurrent(local({ portal_visible: false }), hit)).toBe(false);
    expect(
      isRouteHitCurrent(
        local({
          portal_visible: true,
          response_owner: "pipe_a",
          signal_reference: "EHRC-AUD-2026-0042",
        }),
        hit,
      ),
    ).toBe(true);
  });

  it("the doctor read selects on the finding's own portal_visible and never on the audit stamp", async () => {
    h.calls.length = 0;
    await loadPortalRoutedFindings("11111111-1111-4111-8111-111111111111");
    const q = h.calls.map((c) => c.q).join("\n");
    expect(q).toContain("f.portal_visible = true");
    expect(q).not.toContain("triage_routed_at");
  });

  it("the doctor write and the PDF grant use the same per-finding gate", async () => {
    h.calls.length = 0;
    await recordDoctorFindingResponse({
      findingId: "22222222-2222-4222-8222-222222222222",
      physicianId: "11111111-1111-4111-8111-111111111111",
      verb: "agree",
      comment: null,
    });
    expect(h.calls[0].q).toContain("AND portal_visible = true");
    expect(h.calls[0].q).not.toContain("triage_routed_at");
    expect(SRC("src/app/api/portal/findings/pdf/route.ts")).not.toContain("triage_routed_at");
    expect(SRC("src/app/api/portal/findings/pdf/route.ts")).toContain("f.portal_visible = true");
  });
});

describe("runDocumentAuditIngest: refresh, preserve, and time (F5)", () => {
  const fetchMock = vi.fn();
  beforeEach(() => {
    h.calls.length = 0;
    h.existing = [];
    h.locals = [];
    h.deadlineInPast = false;
    process.env.GOV_API_KEY = "k";
    vi.stubGlobal("fetch", fetchMock);
    fetchMock.mockReset();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  const respondWith = (payload: unknown) =>
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify(payload), { status: 200, headers: { "content-type": "application/json" } }),
    );
  const findingInserts = () => h.calls.filter((c) => c.q.includes("INSERT INTO document_audit_findings"));
  const metaWrites = () => h.calls.filter((c) => c.q.includes("document_audit_ingest_meta"));

  function existingRow(hashes: Record<string, string | null>) {
    const a = planned();
    return {
      audit_row_id: "aid",
      external_ref: a.external_ref,
      source_audit_id: "aud-1",
      last_synced_at: null,
      cdmss_pdf_url: "https://cdmss.test/api/governance/audits/x/pdf",
      finding_refs: ["f-1", "f-2"],
      finding_hashes: hashes,
    };
  }

  it("rewrites a finding whose CDMSS content changed, and the conflict update never touches responses", async () => {
    const old = planned();
    h.existing = [existingRow(Object.fromEntries(old.findings.map((f) => [f.finding_ref, f.content_hash])))];
    respondWith(exportPayload({ rationale: "Rewritten by CDMSS after the doctor already answered." }));
    const res = await runDocumentAuditIngest();
    expect(res.partial).toBe(false);
    const inserts = findingInserts();
    expect(inserts.length).toBe(2); // the audit is not skipped: one hash changed
    const first = inserts.find((c) => c.values.includes("Rewritten by CDMSS after the doctor already answered."));
    expect(first).toBeTruthy();
    const onConflict = first!.q.slice(first!.q.indexOf("DO UPDATE SET"));
    expect(onConflict).toContain("finding_body = EXCLUDED.finding_body");
    expect(onConflict).toContain("content_hash = EXCLUDED.content_hash");
    for (const protectedColumn of ["doctor_response", "status", "authored_by", "authored_at", "response_owner"]) {
      expect(onConflict).not.toContain(protectedColumn);
    }
    // And it no longer waits for the system author stamp before refreshing.
    expect(onConflict).not.toContain("authored_by_name");
  });

  it("writes nothing when every stored hash matches the export", async () => {
    const a = planned();
    h.existing = [existingRow(Object.fromEntries(a.findings.map((f) => [f.finding_ref, f.content_hash])))];
    respondWith(exportPayload());
    await runDocumentAuditIngest();
    expect(findingInserts()).toHaveLength(0);
    expect(h.calls.some((c) => c.q.includes("INSERT INTO document_audits ("))).toBe(false);
  });

  it("sets portal visibility from CDMSS routed per finding: only the routed finding opens", async () => {
    respondWith(exportPayload());
    await runDocumentAuditIngest();
    const byLabel = (label: string) => findingInserts().find((c) => c.values.includes(label))!;
    const routed = byLabel("Discharge medications not reconciled");
    const notRouted = byLabel("Follow-up date missing");
    // values[7] is the portal_visible parameter of the INSERT.
    expect(routed.values[7]).toBe(true);
    expect(notRouted.values[7]).toBe(false);
    const conflict = routed.q.slice(routed.q.indexOf("DO UPDATE SET"));
    expect(conflict).toContain("WHEN EXCLUDED.cdmss_routed IS TRUE THEN true");
    expect(conflict).toContain("WHEN EXCLUDED.cdmss_routed IS FALSE AND document_audit_findings.cdmss_routed IS TRUE THEN false");
  });

  it("stores the card content: excerpt, citations, patient, note date", async () => {
    respondWith(exportPayload());
    await runDocumentAuditIngest();
    const routed = findingInserts().find((c) => c.values.includes("Discharge medications not reconciled"))!;
    expect(routed.values).toContain("Tab X 5mg OD continued");
    expect(routed.values).toContain("2026-09-20");
    expect(routed.values.some((v) => typeof v === "string" && v.includes("Discharge policy 4.2"))).toBe(true);
    expect(routed.values.some((v) => typeof v === "string" && v.includes("IP-1001"))).toBe(true);
  });

  describe("resolving the audit's doctor", () => {
    const AUDIT_INSERT = (calls: typeof h.calls) => calls.some((c) => c.q.includes("INSERT INTO document_audits ("));
    afterEach(() => {
      h.directHolder = "00000000-0000-4000-8000-0000000000aa";
      h.aliasHolders = [];
    });

    it("the physician who holds the uid directly wins, and no alias lookup happens", async () => {
      respondWith(exportPayload());
      await runDocumentAuditIngest();
      const lookups = h.calls.filter((c) => c.q.includes("FROM physicians"));
      expect(lookups).toHaveLength(1);
      expect(lookups[0].values).toContain("DOC-1");
      expect(AUDIT_INSERT(h.calls)).toBe(true);
    });

    it("falls back to a recorded alias only when exactly one physician holds it", async () => {
      h.directHolder = null;
      h.aliasHolders = [{ id: "00000000-0000-4000-8000-0000000000cc" }];
      respondWith(exportPayload());
      await runDocumentAuditIngest();
      expect(h.calls.some((c) => c.q.includes("ANY(cdmss_alias_uids)"))).toBe(true);
      const insert = h.calls.find((c) => c.q.includes("INSERT INTO document_audits ("))!;
      expect(insert.values).toContain("00000000-0000-4000-8000-0000000000cc");
    });

    it("an alias held by two physicians is ambiguous: the audit stays unmapped, not misattributed", async () => {
      h.directHolder = null;
      h.aliasHolders = [{ id: "a" }, { id: "b" }];
      respondWith(exportPayload());
      await runDocumentAuditIngest();
      expect(AUDIT_INSERT(h.calls)).toBe(false);
    });

    it("an audit under a uid nobody holds or lists is skipped", async () => {
      h.directHolder = null;
      h.aliasHolders = [];
      respondWith(exportPayload());
      await runDocumentAuditIngest();
      expect(AUDIT_INSERT(h.calls)).toBe(false);
    });
  });

  it("an export that times out leaves a PARTIAL_RUN marker, marks the run not-successful, and throws", async () => {
    const err = new DOMException("The operation was aborted due to timeout", "TimeoutError");
    fetchMock.mockRejectedValue(err);
    const logged = vi.spyOn(console, "error").mockImplementation(() => undefined);
    await expect(runDocumentAuditIngest()).rejects.toThrow(/document-audits-export timed out after 180s/);
    const meta = metaWrites()[0];
    expect(String(meta.values[1])).toContain(PARTIAL_RUN_MARKER);
    expect(meta.values[0]).toBe(false);
    expect(logged.mock.calls.some((c) => String(c[0]).includes(PARTIAL_RUN_MARKER))).toBe(true);
  });

  it("stops at the work deadline, says how far it got, and is not marked successful", async () => {
    h.deadlineInPast = true;
    respondWith(exportPayload());
    const logged = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const res = await runDocumentAuditIngest();
    expect(res.partial).toBe(true);
    expect(res.note).toContain(`${PARTIAL_RUN_MARKER} time_budget processed=0/1 audits`);
    expect(findingInserts()).toHaveLength(0);
    expect(metaWrites()[0].values[0]).toBe(false);
    expect(logged).toHaveBeenCalled();
  });
});

describe("timeouts sit strictly inside the function limit", () => {
  it("the export aborts at least 60 s before maxDuration, and writes stop 30 s before it", () => {
    expect(exportTimeoutMs()).toBeLessThanOrEqual((INGEST_MAX_DURATION_S - 60) * 1000);
    expect(exportTimeoutMs()).toBeGreaterThan(20_000);
    h.deadlineInPast = false;
    expect(workDeadlineMs(0)).toBe((INGEST_MAX_DURATION_S - 30) * 1000);
  });

  it("the route's literal maxDuration is the constant the timeouts derive from", () => {
    const route = SRC("src/app/api/cron/document-audit-ingest/route.ts");
    expect(route).toContain(`export const maxDuration = ${INGEST_MAX_DURATION_S}`);
    expect(SRC("src/lib/document-audit-ingest-db.ts")).not.toContain("AbortSignal.timeout(20000)");
  });
});

describe("migration 035", () => {
  it("is idempotent and adds the card columns", () => {
    const src = SRC("src/lib/migrations.ts");
    const at = src.indexOf('id: "035_document_audit_finding_card_fields"');
    expect(at).toBeGreaterThan(src.indexOf('id: "034_portal_login_failures"'));
    const block = src.slice(at);
    for (const col of ["cdmss_routed boolean", "note_date date", "evidence_excerpt text", "citations_json jsonb", "patient_json jsonb", "content_hash text"]) {
      expect(block).toContain(`ADD COLUMN IF NOT EXISTS ${col}`);
    }
  });
});

describe("recordDoctorFindingResponse refuses what the card would not offer", () => {
  const ask = () =>
    recordDoctorFindingResponse({ findingId: "f1", physicianId: "p1", verb: "agree", comment: null });
  afterEach(() => {
    h.respondLookup = [];
  });

  it("the UPDATE itself excludes answered, closed and live-list findings", async () => {
    h.calls.length = 0;
    await ask();
    const update = h.calls.find((c) => c.q.includes("UPDATE document_audit_findings"))!;
    expect(update.q).toContain("doctor_responded_at IS NULL");
    expect(update.q).toContain("status NOT IN ('remediated', 'escalated')");
    expect(update.q).toContain("response_owner = 'local'");
    expect(update.q).toContain("portal_visible = true");
  });

  it("names the reason for a refusal", async () => {
    h.respondLookup = [{ status: "open", response_owner: "local", signal_reference: null, doctor_responded_at: "2026-10-03T00:00:00Z" }];
    expect(await ask()).toEqual({ ok: false, error: "already_responded" });
    h.respondLookup = [{ status: "remediated", response_owner: "local", signal_reference: null, doctor_responded_at: null }];
    expect(await ask()).toEqual({ ok: false, error: "closed" });
    h.respondLookup = [{ status: "open", response_owner: "pipe_a", signal_reference: "X", doctor_responded_at: null }];
    expect(await ask()).toEqual({ ok: false, error: "on_live_list" });
    h.respondLookup = [{ status: "open", response_owner: null, signal_reference: "EHRC-AUD-2026-0001", doctor_responded_at: null }];
    expect(await ask()).toEqual({ ok: false, error: "on_live_list" });
    h.respondLookup = []; // not this doctor's, or not visible: nothing is revealed
    expect(await ask()).toEqual({ ok: false, error: "not_found" });
  });
});

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

vi.hoisted(() => {
  process.env.GOV_API_KEY = "gov-key-should-stay-server";
  process.env.GOV_API_BASE = "https://cdmss.test";
});

vi.mock("@/lib/physician-auth", () => ({
  getCurrentPhysician: vi.fn(),
}));

vi.mock("@/lib/db", () => ({
  sql: vi.fn(),
}));

import { getCurrentPhysician } from "@/lib/physician-auth";
import { sql } from "@/lib/db";
import { GET } from "@/app/api/portal/findings/pdf/route";
import type { DoctorAuditSignal } from "@/lib/doctor-audits";
import { toLiveCard } from "@/lib/doctor-card";
import {
  doctorMayFetchAuditPdf,
  findingsCardPdfHref,
  hasAttachedInstances,
  localCardPdfHref,
  presentPortalPdf,
  signalGrantsAuditPdf,
} from "@/lib/findings-pdf";

const SRC = (p: string) => readFileSync(join(process.cwd(), p), "utf8");

const PHYSICIAN_ID = "11111111-1111-4111-8111-111111111111";
const AUDIT_ID = "22222222-2222-4222-8222-222222222222";
const OTHER_AUDIT = "33333333-3333-4333-8333-333333333333";
const DOCTOR_UID = "cdmss-uid-from-session";
const GOV_KEY = "gov-key-should-stay-server";

const fetchMock = vi.fn();

function physician() {
  return {
    kind: "physician" as const,
    physicianId: PHYSICIAN_ID,
    email: "doctor@example.test",
    full_name: "Dr Example",
  };
}

function signal(over: Partial<DoctorAuditSignal> = {}): DoctorAuditSignal {
  return {
    reference: "EHRC-AUD-2026-0030",
    signal_id: "sig-1",
    doctor_uid: "cdmss-uid-must-never-ship",
    signal_type: "antibiotic_stewardship",
    note_class: "discharge",
    label: "Antibiotic stewardship",
    importance: "high",
    response_required: "acknowledgment",
    status: "routed",
    overdue: true,
    instances: 3,
    window: { from: "2026-09-17", to: "2026-09-23" },
    representative: {
      audit_id: AUDIT_ID,
      finding_ref: "f-1",
      subject: "Antibiotic course",
      verdict: "fail",
      rationale: "Duration exceeds policy",
      note_date: "2026-09-19",
      citations: [{ n: 1, title: "Policy", url: "https://example.test/policy" }],
    },
    routed_at: "2026-09-22T00:00:00Z",
    sla_due_at: "2026-09-29T00:00:00Z",
    response: null,
    ruling: null,
    ...over,
  };
}

function auditsPayload(signals: DoctorAuditSignal[]) {
  return {
    ok: true,
    doctor: { uid: DOCTOR_UID, name: "Dr Example" },
    window: { days: 90 },
    metrics: { audit: { score: 1 }, operational: { late: 1 } },
    signals,
    advisory: "Advisory",
  };
}

function pdfRequest(ref: string) {
  return new NextRequest(`https://portal.test/api/portal/findings/pdf?ref=${encodeURIComponent(ref)}`);
}

/** A failure the doctor sees in a new tab: one plain sentence, no JSON, no code. */
function expectPlainPage(html: string) {
  expect(html).toContain("This note isn't available right now. The quality team has been notified.");
  expect(html).not.toMatch(/upstream_unavailable|not_found|"ok"|error/i);
}

function sqlText(strings: TemplateStringsArray): string {
  return Array.from(strings).join(" ");
}

describe("findings PDF hrefs", () => {
  it("offers the portal proxy only for a real audit UUID with instances", () => {
    const href = findingsCardPdfHref({
      instances: 3,
      representative: { audit_id: AUDIT_ID },
    });
    expect(href).toBe(`/api/portal/findings/pdf?ref=${AUDIT_ID}`);
    expect(href).not.toContain("cdmss");
    expect(href).not.toContain("/api/governance/");
  });

  it("hides download for a zero-instance shell and for an EHRC-AUD reference", () => {
    expect(
      findingsCardPdfHref({
        instances: 0,
        representative: { audit_id: AUDIT_ID },
        pdf_url: `https://cdmss.test/api/governance/audits/${AUDIT_ID}/pdf`,
      }),
    ).toBeNull();
    expect(
      findingsCardPdfHref({
        instances: 3,
        representative: { audit_id: "EHRC-AUD-2026-0111" },
      }),
    ).toBeNull();
    expect(hasAttachedInstances(0)).toBe(false);
    expect(hasAttachedInstances("0")).toBe(false);
    expect(hasAttachedInstances(3)).toBe(true);
  });

  it("rewrites a stored CDMSS PDF URL and leaves a non-CDMSS file alone", () => {
    const stored = `https://even-cdmss.vercel.app/api/governance/audits/${AUDIT_ID}/pdf`;
    expect(presentPortalPdf(stored)).toEqual({
      pdf_url: `/api/portal/findings/pdf?ref=${AUDIT_ID}`,
      pdf_status: "available",
    });
    expect(localCardPdfHref("https://cdn.example/a.pdf", "available")).toBe(
      "https://cdn.example/a.pdf",
    );
    expect(localCardPdfHref(`https://cdmss.test/api/governance/audits/EHRC-AUD-2026-0111/pdf`, "available")).toBeNull();
    expect(presentPortalPdf(null)).toEqual({ pdf_url: null, pdf_status: "unavailable" });
  });

  it("toLiveCard never emits a CDMSS PDF URL or a reference fallback", () => {
    const live = toLiveCard(signal())!;
    expect(live.view_note_href).toBe(`/api/portal/findings/pdf?ref=${AUDIT_ID}`);
    expect(JSON.stringify(live)).not.toContain("even-cdmss.vercel.app");
    expect(JSON.stringify(live)).not.toContain("/api/governance/audits/");
    expect(JSON.stringify(live)).not.toContain("cdmss-uid-must-never-ship");
    expect(live).not.toHaveProperty("doctor_uid");

    const shell = toLiveCard(
      signal({
        instances: 0,
        reference: "EHRC-AUD-2026-0111",
        representative: null,
      }),
    )!;
    expect(shell.view_note_href).toBeNull();
    expect(JSON.stringify(shell)).not.toContain("EHRC-AUD-2026-0111");

    const withNested = toLiveCard(
      signal({
        representative: {
          audit_id: AUDIT_ID,
          finding_ref: "f-1",
          subject: "Antibiotic course",
          verdict: "fail",
          rationale: "Duration",
          note_date: "2026-09-19",
          citations: [],
          pdf_url: `https://cdmss.test/api/governance/audits/${AUDIT_ID}/pdf`,
        } as DoctorAuditSignal["representative"],
      }),
    );
    expect(JSON.stringify(withNested)).not.toContain("pdf_url");
    expect(withNested!.view_note_href).toBe(`/api/portal/findings/pdf?ref=${AUDIT_ID}`);
  });
});

describe("doctor binding for an audit PDF", () => {
  it("grants a signal only when instances are attached and the audit UUID matches", () => {
    expect(signalGrantsAuditPdf(signal(), AUDIT_ID)).toBe(true);
    expect(signalGrantsAuditPdf(signal({ instances: 0 }), AUDIT_ID)).toBe(false);
    expect(signalGrantsAuditPdf(signal(), OTHER_AUDIT)).toBe(false);
    expect(signalGrantsAuditPdf(signal({ representative: null }), "EHRC-AUD-2026-0111")).toBe(false);
    expect(
      signalGrantsAuditPdf(
        {
          instances: 3,
          representative: null,
          pdf_url: `https://cdmss.test/api/governance/audits/${AUDIT_ID}/pdf`,
        },
        AUDIT_ID,
      ),
    ).toBe(true);
  });

  it("allows a local portal row even when the CDMSS signal is an empty shell", () => {
    expect(
      doctorMayFetchAuditPdf({
        auditId: AUDIT_ID,
        signals: [signal({ instances: 0 })],
        localMatch: true,
      }),
    ).toBe(true);
    expect(
      doctorMayFetchAuditPdf({
        auditId: AUDIT_ID,
        signals: [signal({ instances: 0 })],
        localMatch: false,
      }),
    ).toBe(false);
    expect(
      doctorMayFetchAuditPdf({
        auditId: "EHRC-AUD-2026-0111",
        signals: [signal()],
        localMatch: true,
      }),
    ).toBe(false);
  });
});

describe("GET /api/portal/findings/pdf", () => {
  beforeEach(() => {
    process.env.GOV_API_KEY = GOV_KEY;
    process.env.GOV_API_BASE = "https://cdmss.test";
    process.env.PORTAL_FINDINGS = "1";
    vi.mocked(getCurrentPhysician).mockReset();
    vi.mocked(sql).mockReset();
    fetchMock.mockReset();
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    delete process.env.PORTAL_FINDINGS;
  });

  function mockSql(opts: { uid: string | null; local: boolean }) {
    vi.mocked(sql).mockImplementation((async (strings: TemplateStringsArray) => {
      const q = sqlText(strings);
      if (q.includes("cdmss_doctor_uid")) return [{ cdmss_doctor_uid: opts.uid }];
      if (q.includes("source_audit_id")) return opts.local ? [{ source_audit_id: AUDIT_ID }] : [];
      return [];
    }) as unknown as typeof sql);
  }

  function mockUpstream(signals: DoctorAuditSignal[], pdfStatus = 200, pdfType = "application/pdf") {
    fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
      const u = String(url);
      if (u.includes("/api/governance/doctor-audits")) {
        return new Response(JSON.stringify(auditsPayload(signals)), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      if (u.includes(`/api/governance/audits/${AUDIT_ID}/pdf`)) {
        const headers = new Headers(init?.headers);
        if (headers.get("x-api-key") !== GOV_KEY) {
          return new Response(JSON.stringify({ ok: false, error: "unauthorized" }), {
            status: 401,
            headers: { "content-type": "application/json" },
          });
        }
        if (pdfStatus !== 200) {
          return new Response(JSON.stringify({ ok: false }), {
            status: pdfStatus,
            headers: { "content-type": "application/json" },
          });
        }
        return new Response(new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d]), {
          status: 200,
          headers: { "content-type": pdfType },
        });
      }
      return new Response("missing", { status: 500 });
    });
  }

  it("rejects a missing session before any upstream call", async () => {
    vi.mocked(getCurrentPhysician).mockResolvedValue(null);
    const res = await GET(pdfRequest(AUDIT_ID));
    expect(res.status).toBe(401);
    expect(await res.text()).toContain("Please sign in to the doctor portal again");
    expect(sql).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rejects an EHRC-AUD reference instead of proxying it", async () => {
    vi.mocked(getCurrentPhysician).mockResolvedValue(physician());
    const res = await GET(pdfRequest("EHRC-AUD-2026-0111"));
    expect(res.status).toBe(400);
    expectPlainPage(await res.text());
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("streams the PDF when the session doctor has the audit with instances", async () => {
    vi.mocked(getCurrentPhysician).mockResolvedValue(physician());
    mockSql({ uid: DOCTOR_UID, local: false });
    mockUpstream([signal()]);

    const res = await GET(pdfRequest(AUDIT_ID));
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/pdf");
    expect(res.headers.get("x-api-key")).toBeNull();
    const bytes = new Uint8Array(await res.arrayBuffer());
    const text = new TextDecoder().decode(bytes);
    expect(text.startsWith("%PDF-")).toBe(true);
    expect(text).not.toContain(GOV_KEY);

    const calls = fetchMock.mock.calls.map((c) => String(c[0]));
    const list = calls.find((u) => u.includes("/api/governance/doctor-audits"));
    expect(list).toContain(`doctor_uid=${encodeURIComponent(DOCTOR_UID)}`);
    expect(list).not.toContain(PHYSICIAN_ID);
    const pdfCall = fetchMock.mock.calls.find((c) => String(c[0]).includes("/audits/"));
    // Doctor proxy: always routed_only=1 so the file holds only findings routed to this doctor.
    expect(String(pdfCall?.[0])).toBe(`https://cdmss.test/api/governance/audits/${AUDIT_ID}/pdf?routed_only=1`);
    expect(new Headers(pdfCall?.[1]?.headers).get("x-api-key")).toBe(GOV_KEY);
  });

  it("does not fetch a PDF for a zero-instance shell that merely names the audit", async () => {
    vi.mocked(getCurrentPhysician).mockResolvedValue(physician());
    mockSql({ uid: DOCTOR_UID, local: false });
    mockUpstream([signal({ instances: 0 })]);

    const res = await GET(pdfRequest(AUDIT_ID));
    expect(res.status).toBe(404);
    expectPlainPage(await res.text());
    expect(fetchMock.mock.calls.some((c) => String(c[0]).includes("/audits/"))).toBe(false);
  });

  it("does not fetch a PDF for another doctor's audit", async () => {
    vi.mocked(getCurrentPhysician).mockResolvedValue(physician());
    mockSql({ uid: DOCTOR_UID, local: false });
    mockUpstream([signal()]);

    const res = await GET(pdfRequest(OTHER_AUDIT));
    expect(res.status).toBe(404);
    expect(fetchMock.mock.calls.some((c) => String(c[0]).includes(OTHER_AUDIT))).toBe(false);
  });

  it("allows a portal-visible local audit when the doctor has no CDMSS uid", async () => {
    vi.mocked(getCurrentPhysician).mockResolvedValue(physician());
    mockSql({ uid: null, local: true });
    mockUpstream([signal()]);

    const res = await GET(pdfRequest(AUDIT_ID));
    expect(res.status).toBe(200);
    expect(fetchMock.mock.calls.some((c) => String(c[0]).includes("/doctor-audits"))).toBe(false);
    expect(fetchMock.mock.calls.some((c) => String(c[0]).includes(`/audits/${AUDIT_ID}/pdf`))).toBe(true);
  });

  it("returns upstream_unavailable when the findings list cannot be read and nothing local matches", async () => {
    vi.mocked(getCurrentPhysician).mockResolvedValue(physician());
    mockSql({ uid: DOCTOR_UID, local: false });
    fetchMock.mockResolvedValue(
      new Response("nope", { status: 503, headers: { "content-type": "text/plain" } }),
    );

    const res = await GET(pdfRequest(AUDIT_ID));
    expect(res.status).toBe(502);
    const body = await res.text();
    expectPlainPage(body);
    expect(body).not.toContain(GOV_KEY);
  });

  it("does not pass a JSON 401 from CDMSS through as a download", async () => {
    vi.mocked(getCurrentPhysician).mockResolvedValue(physician());
    mockSql({ uid: DOCTOR_UID, local: false });
    mockUpstream([signal()], 401);

    const res = await GET(pdfRequest(AUDIT_ID));
    expect(res.status).toBe(502);
    expect(res.headers.get("content-type")).toContain("text/html");
    expectPlainPage(await res.text());
  });
});

describe("Findings PDF wiring stays off the raw CDMSS URL", () => {
  it("the card and the local strip point Download at the portal proxy", () => {
    const card = SRC("src/components/portal/FindingsForDoctor.tsx");
    const local = SRC("src/components/portal/LocalDocumentAuditsForDoctor.tsx");
    const route = SRC("src/app/api/portal/findings/pdf/route.ts");
    const docs = SRC("src/app/api/portal/document-audits/route.ts");

    const shared = SRC("src/components/portal/FindingCard.tsx");
    const builder = SRC("src/lib/doctor-card.ts");

    // One shared card renders the single "View note" link from the card's server-built href.
    expect(card).toContain("FindingCard");
    expect(local).toContain("FindingCard");
    expect(shared).toContain("card.view_note_href");
    expect(builder).toContain("findingsCardPdfHref");
    expect(builder).toContain("localCardPdfHref");
    // Only the portal proxy may ever be shipped as a link.
    expect(builder).toContain('href.startsWith("/api/portal/findings/pdf?ref=")');
    for (const src of [card, local, shared]) {
      expect(src).not.toContain("even-cdmss.vercel.app");
      expect(src).not.toContain("/api/governance/audits/");
      expect(src).not.toContain("GOV_API_KEY");
    }

    expect(route).toContain("getCurrentPhysician()");
    expect(route).toContain("SELECT cdmss_doctor_uid FROM physicians WHERE id=");
    expect(route).toContain("fetchDoctorAudits");
    expect(route).toContain("fetchCdmssAuditPdf(ref, { routedOnly: true })");
    expect(SRC("src/lib/cdmss-pdf.ts")).toContain('headers: { "x-api-key": key, accept: "application/pdf" }');
    expect(route).toContain("doctorMayFetchAuditPdf");
    expect(route).not.toContain("NEXT_PUBLIC");

    expect(docs).toContain("toDocumentCards");
    expect(builder).toContain("portalPdfStatus");
  });
});

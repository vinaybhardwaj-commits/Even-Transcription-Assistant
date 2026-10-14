import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const h = vi.hoisted(() => ({
  user: { status: "active" } as null | { status: string },
  row: null as null | { source_audit_id: string | null; cdmss_pdf_url: string | null },
}));

vi.mock("@/lib/auth", () => ({ getCurrentUser: vi.fn(async () => h.user) }));
vi.mock("@/lib/db", () => ({
  sql: vi.fn(async () => (h.row ? [h.row] : [])),
}));

import { GET } from "@/app/api/document-audits/[id]/pdf/route";

const ROW_ID = "44444444-4444-4444-8444-444444444444";
const CDMSS_ID = "22222222-2222-4222-8222-222222222222";
const KEY = "gov-key-stays-server";
const fetchMock = vi.fn();
const SRC = (p: string) => readFileSync(join(process.cwd(), p), "utf8");

const call = (id: string) =>
  GET(new NextRequest(`https://governance.test/api/document-audits/${id}/pdf`), { params: { id } });

describe("staff document-audit PDF proxy (A4)", () => {
  beforeEach(() => {
    process.env.GOV_API_KEY = KEY;
    process.env.GOV_API_BASE = "https://cdmss.test";
    h.user = { status: "active" };
    h.row = { source_audit_id: CDMSS_ID, cdmss_pdf_url: `https://cdmss.test/api/governance/audits/${CDMSS_ID}/pdf` };
    fetchMock.mockReset();
    fetchMock.mockResolvedValue(
      new Response(new Uint8Array([0x25, 0x50, 0x44, 0x46]), { status: 200, headers: { "content-type": "application/pdf" } }),
    );
    vi.stubGlobal("fetch", fetchMock);
  });
  afterEach(() => vi.unstubAllGlobals());

  it("refuses without an active staff session, before touching CDMSS", async () => {
    h.user = null;
    expect((await call(ROW_ID)).status).toBe(401);
    h.user = { status: "pending" };
    expect((await call(ROW_ID)).status).toBe(401);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rejects an id that is not a uuid", async () => {
    expect((await call("EHRC-AUD-2026-0001")).status).toBe(400);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("streams the PDF with the key kept server-side, without the doctor-only routed_only filter", async () => {
    const res = await call(ROW_ID);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/pdf");
    expect(res.headers.get("cache-control")).toBe("private, no-store");
    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url)).toBe(`https://cdmss.test/api/governance/audits/${CDMSS_ID}/pdf`);
    expect(String(url)).not.toContain("routed_only");
    expect(new Headers(init.headers).get("x-api-key")).toBe(KEY);
    expect(new TextDecoder().decode(await res.arrayBuffer())).not.toContain(KEY);
  });

  it("falls back to the stored CDMSS audit id when the url holds none", async () => {
    h.row = { source_audit_id: CDMSS_ID, cdmss_pdf_url: null };
    expect((await call(ROW_ID)).status).toBe(200);
    expect(String(fetchMock.mock.calls[0][0])).toContain(CDMSS_ID);
  });

  it("404s an unknown audit or one with no resolvable CDMSS id", async () => {
    h.row = null;
    expect((await call(ROW_ID)).status).toBe(404);
    h.row = { source_audit_id: "not-a-uuid", cdmss_pdf_url: null };
    expect((await call(ROW_ID)).status).toBe(404);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("502s on an upstream failure and never passes a JSON error through as a file", async () => {
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify({ ok: false }), { status: 401, headers: { "content-type": "application/json" } }),
    );
    const res = await call(ROW_ID);
    expect(res.status).toBe(502);
    expect(await res.json()).toEqual({ ok: false, error: "upstream_unavailable" });
  });

  it("staff pages link to the proxy, not the raw CDMSS url", () => {
    const detail = SRC("src/components/document-audits/DocumentAuditDetail.tsx");
    const section = SRC("src/components/document-audits/PhysicianDocumentationSection.tsx");
    expect(detail).toContain("href={`/api/document-audits/${audit.id}/pdf`}");
    expect(section).toContain("href={`/api/document-audits/${active.audit_id}/pdf`}");
    expect(detail).not.toContain("href={audit.cdmss_pdf_url}");
    expect(section).not.toContain("href={active.cdmss_pdf_url}");
  });
});

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

vi.mock("@/lib/gov-signals", () => ({
  storeSnapshot: vi.fn(async () => ({ day: "2026-10-01" })),
  storeIncidentSnapshot: vi.fn(async () => ({ day: "2026-10-01", clusters: 0 })),
}));
vi.mock("@/lib/document-audit-ingest-db", () => ({
  runDocumentAuditIngest: vi.fn(async () => ({ ok: true, audits: 0 })),
  recordIngestMeta: vi.fn(async () => undefined),
}));
vi.mock("@/lib/capture/access", async () => {
  const actual = await vi.importActual<typeof import("@/lib/capture/access")>("@/lib/capture/access");
  return { ...actual, isOtCaptureOcrEnabled: () => false };
});
vi.mock("@/lib/capture/db", () => ({ isMissingCaptureTable: () => false }));
vi.mock("@/lib/capture/ocr/run", () => ({
  clampOcrLimit: () => 5,
  processQueuedCaptures: vi.fn(async () => ({ ok: true, processed: 0, results: [] })),
}));
vi.mock("@/lib/capture/sheets-db", () => ({ isMissingSheetTable: () => false }));
vi.mock("@/lib/capture/staff", () => ({ isUuid: () => true }));
vi.mock("@/lib/auth", () => ({ getCurrentUser: vi.fn(async () => ({ status: "active", is_super_admin: true })) }));

import { checkCronAuth } from "@/lib/cron-auth";
import { middleware } from "@/middleware";
import { GET as govSnapshotGET } from "@/app/api/cron/gov-snapshot/route";
import { GET as ingestGET } from "@/app/api/cron/document-audit-ingest/route";
import { GET as ocrGET } from "@/app/api/cron/ot-capture-ocr/route";
import { storeSnapshot } from "@/lib/gov-signals";
import { runDocumentAuditIngest } from "@/lib/document-audit-ingest-db";

const SECRET = "s3cret-cron-value";
const url = (p: string) => `https://governance.test${p}`;

function req(path: string, headers: Record<string, string> = {}) {
  return new NextRequest(url(path), { headers });
}

describe("checkCronAuth", () => {
  it("accepts exactly Bearer <secret>", () => {
    expect(checkCronAuth(`Bearer ${SECRET}`, SECRET)).toEqual({ ok: true });
  });

  it("refuses a missing, malformed, or wrong header with 401", () => {
    for (const h of [null, undefined, "", SECRET, `bearer ${SECRET}`, `Bearer ${SECRET}x`, `Bearer wrong`, `Basic ${SECRET}`]) {
      expect(checkCronAuth(h, SECRET)).toEqual({ ok: false, status: 401, error: "Unauthorized" });
    }
  });

  it("fails closed with 503 when CRON_SECRET is unset or empty, even with a header", () => {
    expect(checkCronAuth(`Bearer ${SECRET}`, undefined)).toEqual({
      ok: false,
      status: 503,
      error: "cron_not_configured",
    });
    expect(checkCronAuth("Bearer ", "")).toMatchObject({ ok: false, status: 503 });
    expect(checkCronAuth(null, undefined)).toMatchObject({ ok: false, status: 503 });
  });
});

describe("cron routes (A1)", () => {
  let errSpy: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    process.env.CRON_SECRET = SECRET;
    vi.mocked(storeSnapshot).mockClear();
    vi.mocked(runDocumentAuditIngest).mockClear();
    errSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
  });
  afterEach(() => {
    delete process.env.CRON_SECRET;
    errSpy.mockRestore();
  });

  const routes: Array<[string, (r: NextRequest) => Promise<Response>, string]> = [
    ["gov-snapshot", govSnapshotGET, "/api/cron/gov-snapshot"],
    ["document-audit-ingest", ingestGET, "/api/cron/document-audit-ingest"],
    ["ot-capture-ocr", ocrGET, "/api/cron/ot-capture-ocr"],
  ];

  for (const [name, handler, path] of routes) {
    it(`${name}: the vercel-cron User-Agent alone is refused`, async () => {
      const res = await handler(req(path, { "user-agent": "vercel-cron/1.0" }));
      expect(res.status).toBe(401);
    });

    it(`${name}: a wrong bearer is refused and a signed-in session is not enough`, async () => {
      const res = await handler(req(path, { authorization: "Bearer nope", cookie: "epi_session=anything" }));
      expect(res.status).toBe(401);
    });

    it(`${name}: the right bearer runs`, async () => {
      const res = await handler(req(path, { authorization: `Bearer ${SECRET}` }));
      expect(res.status).toBe(200);
    });

    it(`${name}: no CRON_SECRET configured answers 503 and logs`, async () => {
      delete process.env.CRON_SECRET;
      const res = await handler(req(path, { authorization: `Bearer ${SECRET}`, "user-agent": "vercel-cron/1.0" }));
      expect(res.status).toBe(503);
      expect(await res.json()).toEqual({ ok: false, error: "cron_not_configured" });
      expect(errSpy).toHaveBeenCalled();
    });
  }

  it("a refused request never reaches the work", async () => {
    await govSnapshotGET(req("/api/cron/gov-snapshot", { "user-agent": "vercel-cron/1.0" }));
    await ingestGET(req("/api/cron/document-audit-ingest?window=30", { "user-agent": "vercel-cron/1.0" }));
    expect(storeSnapshot).not.toHaveBeenCalled();
    expect(runDocumentAuditIngest).not.toHaveBeenCalled();
  });
});

describe("middleware no longer bypasses /api/cron/*", () => {
  beforeEach(() => {
    process.env.CRON_SECRET = SECRET;
    process.env.JWT_SECRET = "jwt-test-secret";
  });
  afterEach(() => {
    delete process.env.CRON_SECRET;
  });

  it("refuses a bare request and a User-Agent-only request with 401", async () => {
    const bare = await middleware(req("/api/cron/gov-snapshot"));
    expect(bare.status).toBe(401);
    const ua = await middleware(req("/api/cron/document-audit-ingest", { "user-agent": "vercel-cron/1.0" }));
    expect(ua.status).toBe(401);
  });

  it("passes the correct bearer through to the route", async () => {
    const res = await middleware(req("/api/cron/gov-snapshot", { authorization: `Bearer ${SECRET}` }));
    expect(res.status).toBe(200);
    expect(res.headers.get("x-middleware-next")).toBe("1");
  });

  it("answers 503 when CRON_SECRET is unset", async () => {
    delete process.env.CRON_SECRET;
    const res = await middleware(req("/api/cron/ot-capture-ocr", { authorization: `Bearer ${SECRET}` }));
    expect(res.status).toBe(503);
  });
});

describe("cron routes carry no weaker credential in source", () => {
  for (const f of ["gov-snapshot", "document-audit-ingest", "ot-capture-ocr"]) {
    it(`${f} has no User-Agent trust and no session fallback`, () => {
      const src = readFileSync(join(process.cwd(), `src/app/api/cron/${f}/route.ts`), "utf8");
      expect(src).not.toContain("vercel-cron/");
      expect(src).not.toContain("getCurrentUser");
      expect(src).toContain("cronGuard(");
    });
  }
});

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

vi.mock("@/lib/physician-auth", () => ({
  getCurrentPhysician: vi.fn(async () => ({
    kind: "physician",
    physicianId: "11111111-1111-4111-8111-111111111111",
    email: "doc@example.test",
    full_name: "Dr Example",
  })),
}));
vi.mock("@/lib/db", () => ({
  sql: vi.fn(async () => [{ cdmss_doctor_uid: "uid-1", source_audit_id: null }]),
}));
vi.mock("@/lib/doctor-audits", async () => {
  const actual = await vi.importActual<typeof import("@/lib/doctor-audits")>("@/lib/doctor-audits");
  return {
    ...actual,
    fetchDoctorAudits: vi.fn(async () => ({
      ok: true,
      doctor: { uid: "uid-1" },
      window: { days: 90 },
      metrics: {},
      signals: [],
      advisory: "",
    })),
    fetchDoctorReactions: vi.fn(async () => ({})),
  };
});
vi.mock("@/lib/findings-actions", async () => {
  const actual = await vi.importActual<typeof import("@/lib/findings-actions")>("@/lib/findings-actions");
  return {
    ...actual,
    callReaction: vi.fn(async () => ({ kind: "http", status: 200, body: { ok: true, reaction: {} } })),
    callResponse: vi.fn(async () => ({ kind: "http", status: 200, body: { ok: true, signal: null } })),
  };
});
vi.mock("@/lib/response-sync", () => ({ forwardResponseNow: vi.fn(async () => undefined) }));
vi.mock("@/lib/document-audits-db", () => ({
  loadPortalRoutedFindings: vi.fn(async () => []),
  recordDoctorFindingResponse: vi.fn(async () => ({ ok: true })),
}));

import { GET as findingsGET } from "@/app/api/portal/findings/route";
import { GET as pdfGET } from "@/app/api/portal/findings/pdf/route";
import { POST as reactPOST } from "@/app/api/portal/findings/react/route";
import { POST as respondPOST } from "@/app/api/portal/findings/respond/route";
import { GET as docsGET } from "@/app/api/portal/document-audits/route";
import { POST as docsRespondPOST } from "@/app/api/portal/document-audits/respond/route";
import { GET as announcementsGET } from "@/app/api/portal/announcements/route";
import { fetchDoctorAudits } from "@/lib/doctor-audits";
import { callReaction, callResponse } from "@/lib/findings-actions";
import { loadPortalRoutedFindings, recordDoctorFindingResponse } from "@/lib/document-audits-db";
import { portalFlags, reactionsEnabled, respondEnabled, findingsEnabled } from "@/lib/portal-flags";
import { getCurrentPhysician } from "@/lib/physician-auth";

const FLAGS = ["PORTAL_FINDINGS", "PORTAL_REACTIONS", "PORTAL_FINDINGS_RESPOND"] as const;
const AUDIT = "22222222-2222-4222-8222-222222222222";

function setFlags(on: Partial<Record<(typeof FLAGS)[number], boolean>>) {
  for (const f of FLAGS) {
    if (on[f]) process.env[f] = "1";
    else delete process.env[f];
  }
}

const get = (path: string) => new NextRequest(`https://portal.test${path}`);
const post = (path: string, body: unknown) =>
  new NextRequest(`https://portal.test${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });

beforeEach(() => {
  process.env.GOV_API_KEY = "k";
  vi.mocked(fetchDoctorAudits).mockClear();
  vi.mocked(callReaction).mockClear();
  vi.mocked(callResponse).mockClear();
  vi.mocked(loadPortalRoutedFindings).mockClear();
  vi.mocked(recordDoctorFindingResponse).mockClear();
});
afterEach(() => setFlags({}));

describe("flag helpers", () => {
  it("a flag is on only for the exact string 1", () => {
    process.env.PORTAL_FINDINGS = "true";
    expect(findingsEnabled()).toBe(false);
    process.env.PORTAL_FINDINGS = "1";
    expect(findingsEnabled()).toBe(true);
  });

  it("reactions and respond also need PORTAL_FINDINGS", () => {
    setFlags({ PORTAL_REACTIONS: true, PORTAL_FINDINGS_RESPOND: true });
    expect(reactionsEnabled()).toBe(false);
    expect(respondEnabled()).toBe(false);
    setFlags({ PORTAL_FINDINGS: true, PORTAL_REACTIONS: true, PORTAL_FINDINGS_RESPOND: true });
    expect(reactionsEnabled()).toBe(true);
    expect(respondEnabled()).toBe(true);
  });

  it("the announcements feature set is the same module the routes use", async () => {
    setFlags({ PORTAL_FINDINGS: true, PORTAL_REACTIONS: true });
    const res = await announcementsGET();
    // announcements reads the DB for rows; the sql mock returns one row, which is fine for features.
    const body = await res.json();
    expect(body.features).toEqual(portalFlags());
    expect(body.features).toMatchObject({ findings: true, reactions: true, findingsRespond: false });
  });
});

describe("A2: flags are enforced in the API routes, not only the UI", () => {
  it("PORTAL_FINDINGS off: findings, document-audits and the PDF proxy answer 404 and do no work", async () => {
    setFlags({});
    for (const res of [await findingsGET(get("/api/portal/findings")), await docsGET()]) {
      expect(res.status).toBe(404);
      expect(await res.json()).toEqual({ ok: false, error: "disabled" });
    }
    // The PDF route opens in a browser tab, so it answers a plain page rather than JSON.
    const pdf = await pdfGET(get(`/api/portal/findings/pdf?ref=${AUDIT}`));
    expect(pdf.status).toBe(404);
    expect(await pdf.text()).toContain("isn't available right now");
    expect(fetchDoctorAudits).not.toHaveBeenCalled();
    expect(loadPortalRoutedFindings).not.toHaveBeenCalled();
  });

  it("PORTAL_FINDINGS on: findings and document-audits are served", async () => {
    setFlags({ PORTAL_FINDINGS: true });
    const f = await findingsGET(get("/api/portal/findings"));
    expect(f.status).toBe(200);
    expect(fetchDoctorAudits).toHaveBeenCalled();
    const d = await docsGET();
    expect(d.status).toBe(200);
    expect(loadPortalRoutedFindings).toHaveBeenCalled();
  });

  it("PORTAL_REACTIONS off (or PORTAL_FINDINGS off): react answers disabled and never calls CDMSS", async () => {
    setFlags({ PORTAL_FINDINGS: true });
    expect(await (await reactPOST(post("/api/portal/findings/react", { signal_id: "s", reaction: "dismiss" }))).json()).toEqual({
      ok: false,
      error: "disabled",
    });
    setFlags({ PORTAL_REACTIONS: true });
    expect(await (await reactPOST(post("/api/portal/findings/react", { signal_id: "s", reaction: "dismiss" }))).json()).toEqual({
      ok: false,
      error: "disabled",
    });
    expect(callReaction).not.toHaveBeenCalled();
  });

  it("PORTAL_REACTIONS on: react proceeds", async () => {
    setFlags({ PORTAL_FINDINGS: true, PORTAL_REACTIONS: true });
    const res = await reactPOST(post("/api/portal/findings/react", { signal_id: "s", reaction: "dismiss" }));
    expect((await res.json()).ok).toBe(true);
    expect(callReaction).toHaveBeenCalled();
  });

  it("PORTAL_FINDINGS_RESPOND off: both respond routes answer disabled and never write", async () => {
    setFlags({ PORTAL_FINDINGS: true });
    expect(await (await respondPOST(post("/api/portal/findings/respond", { signal_id: "s", verb: "agree" }))).json()).toEqual({
      ok: false,
      error: "disabled",
    });
    expect(
      await (
        await docsRespondPOST(post("/api/portal/document-audits/respond", { finding_id: "f", verb: "agree" }))
      ).json(),
    ).toEqual({ ok: false, error: "disabled" });
    expect(callResponse).not.toHaveBeenCalled();
    expect(recordDoctorFindingResponse).not.toHaveBeenCalled();
  });

  it("PORTAL_FINDINGS_RESPOND on: both respond routes proceed", async () => {
    setFlags({ PORTAL_FINDINGS: true, PORTAL_FINDINGS_RESPOND: true });
    const a = await respondPOST(post("/api/portal/findings/respond", { signal_id: "s", verb: "agree" }));
    expect((await a.json()).error).not.toBe("disabled");
    expect(callResponse).toHaveBeenCalled();
    const b = await docsRespondPOST(post("/api/portal/document-audits/respond", { finding_id: "f", verb: "agree" }));
    expect((await b.json()).ok).toBe(true);
    expect(recordDoctorFindingResponse).toHaveBeenCalled();
  });

  it("a missing session is still 401 before the flag is consulted", async () => {
    vi.mocked(getCurrentPhysician).mockResolvedValueOnce(null);
    setFlags({});
    const res = await findingsGET(get("/api/portal/findings"));
    expect(res.status).toBe(401);
  });
});

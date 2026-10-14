import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { REF, EVENTS, fakeSql, json, liveFromClaims, signalObject, staff } from "./helpers/fixtures";

const h = vi.hoisted(() => ({
  user: null as unknown,
  live: "claims" as unknown,
  sql: null as unknown as (...a: unknown[]) => unknown,
}));

vi.mock("@/lib/auth", () => ({ getCurrentUser: vi.fn(async () => h.user) }));
vi.mock("@/lib/db", () => ({ sql: (...a: unknown[]) => h.sql(...a) }));
vi.mock("@/lib/staff-live", async (orig) => {
  const real = await orig<typeof import("@/lib/staff-live")>();
  const { liveFromClaims } = await import("./helpers/fixtures");
  return { ...real, loadLiveStaff: vi.fn(async () => (h.live === "claims" ? liveFromClaims(h.user) : h.live)) };
});

import { GET as worklistGET } from "@/app/api/audit-findings/route";
import { GET as threadGET } from "@/app/api/audit-findings/[reference]/route";
import { POST as rulingPOST } from "@/app/api/audit-findings/[reference]/ruling/route";
import { GET as profileGET } from "@/app/api/physicians/[id]/audit-findings/route";
import { GET as mappingGET, POST as mappingPOST } from "@/app/api/audit-findings/mapping/route";

const PHYSICIAN = "11111111-1111-4111-8111-111111111111";
const fetchMock = vi.fn();

const url = (p: string) => `https://governance.test${p}`;
const req = (p: string, init?: ConstructorParameters<typeof NextRequest>[1]) => new NextRequest(url(p), init);
const post = (p: string, body: unknown) =>
  req(p, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

type Call = () => Promise<Response>;

/** Every new staff route, as a thunk, with the level it needs. */
const ROUTES: Array<{ name: string; level: "view" | "manage"; call: Call }> = [
  { name: "GET /api/audit-findings", level: "view", call: () => worklistGET(req("/api/audit-findings")) },
  { name: "GET /api/audit-findings/[reference]", level: "view", call: () => threadGET(req(`/api/audit-findings/${REF}`), { params: { reference: REF } }) },
  {
    name: "POST /api/audit-findings/[reference]/ruling",
    level: "manage",
    call: () => rulingPOST(post(`/api/audit-findings/${REF}/ruling`, { action: "closed", note: "Done and dusted." }), { params: { reference: REF } }),
  },
  { name: "GET /api/physicians/[id]/audit-findings", level: "view", call: () => profileGET(req(`/api/physicians/${PHYSICIAN}/audit-findings`), { params: { id: PHYSICIAN } }) },
  { name: "GET /api/audit-findings/mapping", level: "manage", call: () => mappingGET() },
  {
    name: "POST /api/audit-findings/mapping",
    level: "manage",
    call: () => mappingPOST(post("/api/audit-findings/mapping", { decision: "reject", uid: "D-1", physician_id: PHYSICIAN })),
  },
];

beforeEach(() => {
  h.live = "claims";
  process.env.GOV_API_KEY = "gov-key";
  process.env.GOV_API_BASE = "https://cdmss.test";
  h.sql = fakeSql(() => []);
  fetchMock.mockReset();
  fetchMock.mockImplementation(async (u: string) => {
    const s = String(u);
    if (s.includes("/roster-audits")) return json(200, { ok: true, doctors: [{ doctor_uid: "D-100", name: "Asha", signals: [signalObject()] }] });
    if (s.includes("/audit-signal/")) return json(200, { ok: true, signal: signalObject(), instances: [signalObject().representative], events: EVENTS });
    if (s.includes("/doctor-directory")) return json(200, { ok: true, doctors: [{ doctor_uid: "D-1", name: "Ravi Menon" }] });
    return json(404, { ok: false });
  });
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => vi.unstubAllGlobals());

describe("staff-only auth on every new route", () => {
  for (const r of ROUTES) {
    describe(r.name, () => {
      it("refuses with 401 when there is no staff session (a doctor's portal session is another cookie)", async () => {
        h.user = null;
        expect((await r.call()).status).toBe(401);
        expect(fetchMock).not.toHaveBeenCalled();
      });

      it("refuses a physician token presented as a staff cookie, even one claiming super_admin", async () => {
        h.user = staff.physicianToken;
        expect((await r.call()).status).toBe(401);
        expect(fetchMock).not.toHaveBeenCalled();
      });

      it("refuses an account that is not active", async () => {
        h.user = staff.pending;
        expect((await r.call()).status).toBe(401);
        expect(fetchMock).not.toHaveBeenCalled();
      });

      it("refuses a staff member without a governance role (403)", async () => {
        h.user = staff.hr;
        const res = await r.call();
        expect(res.status).toBe(403);
        expect(await res.json()).toEqual({ ok: false, error: "Forbidden" });
        expect(fetchMock).not.toHaveBeenCalled();
      });

      it(r.level === "view" ? "lets a Site Governance Officer in" : "refuses a Site Governance Officer (view only)", async () => {
        h.user = staff.sgo;
        const res = await r.call();
        if (r.level === "view") expect(res.status).toBe(200);
        else expect(res.status).toBe(403);
      });

      it("lets a Site Medical Head and a super admin in", async () => {
        for (const u of [staff.smh, staff.superAdmin]) {
          h.user = u;
          const res = await r.call();
          // Past the role gate. (The write routes then fail on this test's empty fake database. A Site
          // Medical Head may also be refused for site scope, which is a 403 "out_of_scope", not a role 403.)
          expect(res.status).not.toBe(401);
          if (res.status === 403) {
            expect(u).toBe(staff.smh);
            expect(r.level).toBe("manage");
            expect((await res.json()).error).toBe("out_of_scope");
          }
        }
      });
    });
  }
});

describe("worklist route", () => {
  it("returns the needs-attention view by default with counts over the whole set", async () => {
    h.user = staff.sgo;
    const body = await (await worklistGET(req("/api/audit-findings"))).json();
    expect(body.ok).toBe(true);
    expect(body.filters.view).toBe("attention");
    expect(body.counts.all).toBe(1);
    expect(body.counts.awaiting_ruling).toBe(1);
    expect(body.rows[0]).toMatchObject({ reference: REF, finding_type: "Drug interaction", note_type: "OPD note", status_text: "Doctor disagreed, awaiting ruling" });
    expect(body.options.doctors).toEqual([{ uid: "D-100", name: "Asha" }]);
  });

  it("answers 502 in words when CDMSS is down", async () => {
    h.user = staff.sgo;
    fetchMock.mockRejectedValue(new Error("down"));
    const res = await worklistGET(req("/api/audit-findings"));
    expect(res.status).toBe(502);
    expect((await res.json()).message).toMatch(/CDMSS did not answer/);
  });

  it("sends GOV_API_KEY on the server side only", async () => {
    h.user = staff.sgo;
    const res = await worklistGET(req("/api/audit-findings"));
    const [, init] = fetchMock.mock.calls[0];
    expect(new Headers(init.headers).get("x-api-key")).toBe("gov-key");
    expect(JSON.stringify(await res.json())).not.toContain("gov-key");
  });
});

/** The sql fake for a doctor D-100 linked to PHYSICIAN, engaged at HOSPITAL_A or not. */
function physicianSql(opts: { linked?: boolean; engaged?: boolean; pending?: unknown[] } = {}) {
  const { linked = true, engaged = true, pending = [] } = opts;
  h.sql = fakeSql((text) => {
    if (text.includes("FROM physicians WHERE cdmss_doctor_uid IS NOT NULL")) {
      return linked ? [{ id: PHYSICIAN, full_name: "Asha Rao", cdmss_doctor_uid: "D-100", cdmss_alias_uids: null }] : [];
    }
    if (text.includes("FROM physician_engagements")) return engaged ? [{ id: PHYSICIAN }] : [];
    if (text.includes("FROM gov_interventions") && text.includes("cdmss_sync_state = 'pending'")) return pending;
    return [];
  });
}

describe("thread route", () => {
  it("L4: a Site Medical Head can rule only for a doctor at their own hospital; a super admin anywhere", async () => {
    const call = async () => (await threadGET(req(`/api/audit-findings/${REF}`), { params: { reference: REF } })).json();
    h.user = staff.smh;
    physicianSql({ engaged: true });
    expect((await call()).can_rule).toBe(true);
    physicianSql({ engaged: false });
    const other = await call();
    expect(other.can_rule).toBe(false);
    expect(other.actions).toEqual([]);
    physicianSql({ linked: false });
    expect((await call()).can_rule).toBe(false); // a doctor not yet linked to a profile
    h.user = staff.superAdmin;
    expect((await call()).can_rule).toBe(true);
  });

  it("M3: lists rulings saved here that CDMSS has not confirmed", async () => {
    h.user = staff.smh;
    physicianSql({
      pending: [
        { id: "iv-1", reference: REF, action: "closed", actor_email: "benita@even.in", ruling_note: "Done.", attempts: 2, created_at: "2026-10-07T05:00:00.000Z", error: "transport" },
        { id: "iv-2", reference: "EHRC-AUD-2026-0099", action: "dismissed", actor_email: "x@even.in", ruling_note: "n", attempts: 0, created_at: null, error: null },
      ],
    });
    const body = await (await threadGET(req(`/api/audit-findings/${REF}`), { params: { reference: REF } })).json();
    expect(body.pending_rulings).toEqual([{ action: "closed", attempts: 2, since: "2026-10-07T05:00:00.000Z" }]);
  });

  it("returns content, instances, the response and a plain-word timeline; offers rulings only to those who can rule", async () => {
    h.user = staff.smh;
    physicianSql();
    const body = await (await threadGET(req(`/api/audit-findings/${REF}`), { params: { reference: REF } })).json();
    expect(body.thread.response.verb_text).toBe("Disagreed");
    expect(body.instances[0].subject).toBe("Warfarin with ibuprofen");
    expect(body.timeline.map((e: { text: string }) => e.text)).toContain("The doctor disagreed");
    expect(body.can_rule).toBe(true);
    expect(body.actions.map((a: { action: string }) => a.action)).toHaveLength(4);

    h.user = staff.sgo;
    physicianSql();
    const viewOnly = await (await threadGET(req(`/api/audit-findings/${REF}`), { params: { reference: REF } })).json();
    expect(viewOnly.can_rule).toBe(false);
    expect(viewOnly.actions).toEqual([]);
  });

  it("rejects a malformed reference and passes a CDMSS 404 through as 404", async () => {
    h.user = staff.smh;
    expect((await threadGET(req("/api/audit-findings/x"), { params: { reference: "not-a-ref" } })).status).toBe(400);
    fetchMock.mockResolvedValue(json(404, { ok: false, error: "unknown reference" }));
    expect((await threadGET(req(`/api/audit-findings/${REF}`), { params: { reference: REF } })).status).toBe(404);
  });
});

describe("physician profile route", () => {
  it("says 'not mapped' for a physician with no CDMSS link, without calling CDMSS", async () => {
    h.user = staff.sgo;
    h.sql = fakeSql(() => [{ full_name: "Asha Rao", cdmss_doctor_uid: null, cdmss_alias_uids: null }]);
    const body = await (await profileGET(req(`/api/physicians/${PHYSICIAN}/audit-findings`), { params: { id: PHYSICIAN } })).json();
    expect(body).toMatchObject({ ok: true, mapped: false, rows: [] });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("asks CDMSS for the canonical uid and every alias and merges the threads once", async () => {
    h.user = staff.sgo;
    h.sql = fakeSql(() => [{ full_name: "Asha Rao", cdmss_doctor_uid: "D-100", cdmss_alias_uids: ["D-OLD"] }]);
    const body = await (await profileGET(req(`/api/physicians/${PHYSICIAN}/audit-findings`), { params: { id: PHYSICIAN } })).json();
    const urls = fetchMock.mock.calls.map((c) => String(c[0]));
    expect(urls.some((u) => u.includes("doctor_uid=D-100"))).toBe(true);
    expect(urls.some((u) => u.includes("doctor_uid=D-OLD"))).toBe(true);
    expect(body.rows).toHaveLength(1);
    expect(body.rows[0].doctor_name).toBe("Asha Rao");
  });

  it("rejects an id that is not a uuid", async () => {
    h.user = staff.sgo;
    expect((await profileGET(req("/api/physicians/x/audit-findings"), { params: { id: "x" } })).status).toBe(400);
  });
});

describe("source guard", () => {
  it("every new route handler calls requireStaff before doing anything", async () => {
    const { readFileSync } = await import("node:fs");
    const { join } = await import("node:path");
    const files = [
      "src/app/api/audit-findings/route.ts",
      "src/app/api/audit-findings/[reference]/route.ts",
      "src/app/api/audit-findings/[reference]/ruling/route.ts",
      "src/app/api/audit-findings/mapping/route.ts",
      "src/app/api/physicians/[id]/audit-findings/route.ts",
    ];
    for (const f of files) {
      const src = readFileSync(join(process.cwd(), f), "utf8");
      const handlers = src.match(/export async function (GET|POST)\b/g) ?? [];
      const guards = src.match(/await requireStaff\(/g) ?? [];
      expect(guards.length, f).toBe(handlers.length);
    }
  });
});

describe("worklist route: Not yet synced", () => {
  const syncRow = (over: Record<string, unknown> = {}) => ({ reference: REF, state: "failed", permanent: false, attempts: 2, ...over });
  const withSync = (rows: unknown[] | Error) => {
    h.sql = fakeSql((text) => {
      if (text.includes("document_audit_findings")) {
        if (rows instanceof Error) throw rows;
        return rows;
      }
      return [];
    });
  };

  it("flags the thread and counts it at the top when its forward failed", async () => {
    h.user = staff.sgo;
    withSync([syncRow()]);
    const body = await (await worklistGET(req("/api/audit-findings"))).json();
    expect(body.sync).toEqual({ not_synced: 1, failed: 1, rulings_pending: 0 });
    expect(body.rows[0].sync).toEqual({ state: "failed", permanent: false, attempts: 2 });
  });

  it("a pending forward is flagged too but not counted as failed; a failure outranks pending on the same thread", async () => {
    h.user = staff.sgo;
    withSync([syncRow({ state: "pending", attempts: 0 })]);
    let body = await (await worklistGET(req("/api/audit-findings"))).json();
    expect(body.sync).toEqual({ not_synced: 1, failed: 0, rulings_pending: 0 });
    withSync([syncRow({ state: "pending", attempts: 0 }), syncRow({ state: "failed", permanent: true, attempts: 3 })]);
    body = await (await worklistGET(req("/api/audit-findings"))).json();
    expect(body.rows[0].sync).toEqual({ state: "failed", permanent: true, attempts: 3 });
    expect(body.sync.not_synced).toBe(1);
  });

  it("counts over the whole set, not the filtered view, and ignores references that are not on the roster", async () => {
    h.user = staff.sgo;
    withSync([syncRow(), syncRow({ reference: "EHRC-AUD-2026-9999" })]);
    const body = await (await worklistGET(req("/api/audit-findings?view=overdue"))).json();
    expect(body.rows).toHaveLength(0);
    expect(body.sync).toEqual({ not_synced: 1, failed: 1, rulings_pending: 0 });
  });

  it("shows no badge and no count when everything is synced", async () => {
    h.user = staff.sgo;
    withSync([]);
    const body = await (await worklistGET(req("/api/audit-findings"))).json();
    expect(body.sync).toEqual({ not_synced: 0, failed: 0, rulings_pending: 0 });
    expect(body.rows[0].sync).toBeUndefined();
  });

  it("still serves the worklist when the sync columns do not exist yet (migration 038 unapplied)", async () => {
    h.user = staff.sgo;
    withSync(new Error('column "cdmss_sync_state" does not exist'));
    const res = await worklistGET(req("/api/audit-findings"));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.sync).toEqual({ not_synced: 0, failed: 0, rulings_pending: 0 });
    expect(body.rows).toHaveLength(1);
  });
});

describe("worklist route: Pending sync rulings (M3)", () => {
  const pendingRow = (over: Record<string, unknown> = {}) => ({
    id: "iv-1", reference: REF, action: "closed", actor_email: "benita@even.in", ruling_note: "Done.", attempts: 1, created_at: "2026-10-07T05:00:00.000Z", error: "transport", ...over,
  });
  const withPending = (rows: unknown[]) => {
    h.sql = fakeSql((text) => (text.includes("FROM gov_interventions") && text.includes("cdmss_sync_state = 'pending'") ? rows : []));
  };

  it("flags a thread whose ruling CDMSS has not confirmed and counts it; the thread status is not changed by it", async () => {
    h.user = staff.sgo;
    withPending([pendingRow()]);
    const body = await (await worklistGET(req("/api/audit-findings"))).json();
    expect(body.sync.rulings_pending).toBe(1);
    expect(body.rows[0].pending_ruling).toEqual({ action: "closed", attempts: 1, since: "2026-10-07T05:00:00.000Z" });
    expect(body.rows[0].status).toBe("escalated"); // still what CDMSS says: never shown as ruled/closed
    expect(body.rows[0].status_text).not.toMatch(/closed/i);
  });

  it("only the oldest pending ruling per thread is shown, and unknown threads are ignored", async () => {
    h.user = staff.sgo;
    withPending([pendingRow(), pendingRow({ id: "iv-2", action: "dismissed" }), pendingRow({ id: "iv-3", reference: "EHRC-AUD-2026-0777" })]);
    const body = await (await worklistGET(req("/api/audit-findings"))).json();
    expect(body.rows[0].pending_ruling.action).toBe("closed");
    expect(body.sync.rulings_pending).toBe(1);
  });

  it("no pending rulings, no flag; the sync columns missing (migration 040 unapplied) gives zeros and a working list", async () => {
    h.user = staff.sgo;
    withPending([]);
    let body = await (await worklistGET(req("/api/audit-findings"))).json();
    expect(body.sync.rulings_pending).toBe(0);
    expect(body.rows[0].pending_ruling).toBeUndefined();
    h.sql = fakeSql((text) => {
      if (text.includes("gov_interventions")) throw new Error('column "ruling_note" does not exist');
      return [];
    });
    const res = await worklistGET(req("/api/audit-findings"));
    expect(res.status).toBe(200);
    body = await res.json();
    expect(body.sync.rulings_pending).toBe(0);
    expect(body.rows).toHaveLength(1);
  });
});

describe("staff role is re-read from the database (L3)", () => {
  it("a revoked role, a deactivated account and an unreadable database are refused on every staff route", async () => {
    h.user = staff.superAdmin; // cookie still says super admin
    for (const live of [
      { ...liveFromClaims(staff.superAdmin)!, is_super_admin: false }, // revoked: no governance role left
      { ...liveFromClaims(staff.superAdmin)!, status: "deactivated" },
      null,
    ]) {
      h.live = live;
      for (const r of ROUTES) {
        const res = await r.call();
        expect([401, 403], `${r.name} with ${JSON.stringify(live)?.slice(0, 40)}`).toContain(res.status);
      }
    }
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("a revoked super admin who still holds the SGO role may view but not rule", async () => {
    h.user = staff.superAdmin;
    h.live = { ...liveFromClaims(staff.sgo)! };
    expect((await ROUTES[0].call()).status).toBe(200);
    expect((await ROUTES[2].call()).status).toBe(403);
  });
});

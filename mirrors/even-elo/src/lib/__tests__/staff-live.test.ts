import { beforeEach, describe, expect, it, vi } from "vitest";
import { HOSPITAL_A, HOSPITAL_B, PROFILE_ID, fakeSql, staff } from "./helpers/fixtures";

const h = vi.hoisted(() => ({
  user: null as unknown,
  sql: null as unknown as (...a: unknown[]) => unknown,
}));

vi.mock("@/lib/auth", () => ({ getCurrentUser: vi.fn(async () => h.user) }));
vi.mock("@/lib/db", () => ({ sql: (...a: unknown[]) => h.sql(...a) }));

import { canActOnPhysician, loadLiveStaff, physiciansInScope, scopeOf } from "@/lib/staff-live";
import { requireStaff } from "@/lib/staff-guard";
import { requireOps } from "@/lib/ops-auth";

const P1 = "11111111-1111-4111-8111-111111111111";
const P2 = "22222222-2222-4222-8222-222222222222";

function liveRow(over: Record<string, unknown> = {}) {
  return { status: "active", is_super_admin: false, is_site_medical_head: false, is_sgc_member: false, smh_hospital_ids: [], ...over };
}

let queries: Array<{ text: string; values: unknown[] }>;
function install(handler: (text: string, v: unknown[]) => unknown) {
  h.sql = fakeSql((text, v) => {
    queries.push({ text, values: v });
    return handler(text, v);
  });
}

beforeEach(() => {
  queries = [];
  h.user = null;
  delete process.env.ADMIN_OPS_TOKEN;
  install(() => []);
});

describe("loadLiveStaff", () => {
  it("reads status, the three role flags and the hospitals headed, by profile id", async () => {
    install(() => [liveRow({ is_site_medical_head: true, smh_hospital_ids: [HOSPITAL_A] })]);
    expect(await loadLiveStaff(PROFILE_ID)).toEqual({
      status: "active",
      is_super_admin: false,
      is_site_medical_head: true,
      is_sgc_member: false,
      smh_hospital_ids: [HOSPITAL_A],
    });
    expect(queries[0].text).toContain("profiles_with_roles");
    expect(queries[0].text).toContain("profile_hospital_roles");
    expect(queries[0].values).toEqual([PROFILE_ID]);
  });

  it("is null for a missing profile, an empty id and a failing database (callers refuse on null)", async () => {
    expect(await loadLiveStaff(PROFILE_ID)).toBeNull(); // no row
    expect(await loadLiveStaff("")).toBeNull();
    install(() => {
      throw new Error("db down");
    });
    expect(await loadLiveStaff(PROFILE_ID)).toBeNull();
  });

  it("only a literal true counts as a role", async () => {
    install(() => [liveRow({ is_super_admin: "true", is_site_medical_head: 1, is_sgc_member: null })]);
    expect(await loadLiveStaff(PROFILE_ID)).toMatchObject({ is_super_admin: false, is_site_medical_head: false, is_sgc_member: false });
  });
});

describe("scope", () => {
  it("a super admin acts everywhere; anyone else only at the hospitals they head", () => {
    expect(scopeOf({ is_super_admin: true, smh_hospital_ids: [HOSPITAL_A] })).toEqual({ all: true });
    expect(scopeOf({ is_super_admin: false, smh_hospital_ids: [HOSPITAL_A] })).toEqual({ all: false, hospitalIds: [HOSPITAL_A] });
  });

  it("a super admin needs no query; a head with no hospitals gets nothing without one", async () => {
    expect(Array.from(await physiciansInScope({ all: true }, [P1, P2])).sort()).toEqual([P1, P2]);
    expect((await physiciansInScope({ all: false, hospitalIds: [] }, [P1])).size).toBe(0);
    expect(queries).toHaveLength(0);
  });

  it("a head gets the physicians with a non-terminated engagement at their hospitals", async () => {
    install(() => [{ id: P1 }]);
    const got = await physiciansInScope({ all: false, hospitalIds: [HOSPITAL_A, HOSPITAL_B] }, [P1, P2, P1]);
    expect(Array.from(got)).toEqual([P1]);
    expect(queries[0].text).toContain("physician_engagements");
    expect(queries[0].text).toContain("status <> 'terminated'");
    expect(queries[0].values).toEqual([[P1, P2], [HOSPITAL_A, HOSPITAL_B]]);
  });

  it("fails closed when the engagement read fails", async () => {
    install(() => {
      throw new Error("db down");
    });
    expect((await physiciansInScope({ all: false, hospitalIds: [HOSPITAL_A] }, [P1])).size).toBe(0);
    expect(await canActOnPhysician({ all: false, hospitalIds: [HOSPITAL_A] }, P1)).toBe(false);
  });

  it("canActOnPhysician: an unlinked doctor (no physician id) only for a super admin", async () => {
    expect(await canActOnPhysician({ all: true }, null)).toBe(true);
    expect(await canActOnPhysician({ all: false, hospitalIds: [HOSPITAL_A] }, null)).toBe(false);
    expect(await canActOnPhysician({ all: false, hospitalIds: [HOSPITAL_A] }, undefined)).toBe(false);
  });
});

describe("requireStaff uses the live role, not the cookie", () => {
  it("returns the live flags and scope; the cookie's stale flags are overwritten", async () => {
    h.user = { ...staff.superAdmin }; // cookie: super admin
    install(() => [liveRow({ is_site_medical_head: true, smh_hospital_ids: [HOSPITAL_A] })]); // database: only a site head now
    const gate = await requireStaff("manage");
    expect(gate.ok).toBe(true);
    if (gate.ok) {
      expect(gate.user.is_super_admin).toBe(false);
      expect(gate.user.is_site_medical_head).toBe(true);
      expect(gate.scope).toEqual({ all: false, hospitalIds: [HOSPITAL_A] });
    }
  });

  it("refuses 401 for a deactivated or vanished account and 403 for a live account without the role", async () => {
    h.user = { ...staff.superAdmin };
    install(() => [liveRow({ status: "deactivated", is_super_admin: true })]);
    const a = await requireStaff("view");
    expect(!a.ok && a.response.status).toBe(401);
    install(() => []);
    const b = await requireStaff("view");
    expect(!b.ok && b.response.status).toBe(401);
    install(() => [liveRow()]);
    const c = await requireStaff("view");
    expect(!c.ok && c.response.status).toBe(403);
  });

  it("does not even query the database for a physician token or no session", async () => {
    h.user = staff.physicianToken;
    const a = await requireStaff("view");
    h.user = null;
    const b = await requireStaff("view");
    expect(!a.ok && a.response.status).toBe(401);
    expect(!b.ok && b.response.status).toBe(401);
    expect(queries).toHaveLength(0);
  });
});

describe("requireOps uses the live role, not the cookie", () => {
  const req = () => new Request("https://governance.test/api/admin/db-fresh");

  it("opens for a super admin the database confirms", async () => {
    h.user = { ...staff.superAdmin };
    install(() => [liveRow({ is_super_admin: true })]);
    expect(await requireOps(req())).toBeNull();
  });

  it("refuses a cookie super admin the database says is not one, and one it cannot confirm", async () => {
    h.user = { ...staff.superAdmin };
    install(() => [liveRow({ is_super_admin: false })]);
    expect((await requireOps(req()))?.status).toBe(401);
    install(() => []);
    expect((await requireOps(req()))?.status).toBe(401);
    install(() => {
      throw new Error("db down");
    });
    expect((await requireOps(req()))?.status).toBe(401);
  });
});

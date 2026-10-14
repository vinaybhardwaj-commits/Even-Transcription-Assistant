import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { HOSPITAL_A, HOSPITAL_B, PROFILE_ID, fakeSql, json, liveFromClaims, staff } from "./helpers/fixtures";

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

import { GET, POST } from "@/app/api/audit-findings/mapping/route";

const P_SUNIL = "11111111-1111-4111-8111-111111111101"; // "Sunil Shah" (unlinked)
const P_MEERA = "11111111-1111-4111-8111-111111111102"; // "Meera Iyer" (unlinked, phone ends 1111)
const P_LINKED = "11111111-1111-4111-8111-111111111103"; // "Ravi Menon" already linked to D-OLD
const fetchMock = vi.fn();

interface Phys {
  id: string;
  full_name: string;
  phone: string | null;
  cdmss_doctor_uid: string | null;
  cdmss_alias_uids: string[] | null;
}
interface Dec {
  id: string;
  decision: string;
  uid: string;
  name: string;
  physician_id: string;
  physician_name: string;
  reason: string;
  note: string | null;
  profile: string;
  email: string;
}

let physicians: Phys[];
let decisions: Dec[];
let audits: Array<{ actor: string; action: string; entity: string; after: Record<string, unknown> }>;
let failDecisionInsert: boolean;
let updateMode: "normal" | "no_rows" | "unique";
let sqlCalls: string[];
/** Physicians with a non-terminated engagement at HOSPITAL_A (the site a Site Medical Head in these tests heads). */
let engagedAtA: Set<string>;


const DIRECTORY = {
  ok: true,
  doctors: [
    { doctor_uid: "D-SUNIL", name: "Dr. Sunil Kumar Shah", mobile_last4: "5555" }, // physician is "Sunil Shah": a name part is missing
    { doctor_uid: "D-MEERA", name: "Meera Iyer", mobile_last4: "2222" }, // same name, phone differs
    { doctor_uid: "D-RAVI", name: "Ravi Menon", mobile_last4: "3333" }, // name held by a physician linked elsewhere
  ],
};

function installSql() {
  h.sql = fakeSql((text, v) => {
    sqlCalls.push(text);
    if (text.includes("FROM physician_engagements")) {
      const ids = v[0] as string[];
      const hospitals = v[1] as string[];
      return hospitals.includes(HOSPITAL_A) ? ids.filter((id) => engagedAtA.has(id)).map((id) => ({ id })) : [];
    }
    if (text.includes("FROM physicians WHERE current_status = 'active'")) return physicians.map((p) => ({ ...p }));
    if (text.includes("FROM cdmss_mapping_decisions WHERE decision = 'reject'")) {
      return decisions.filter((d) => d.decision === "reject").map((d) => ({ cdmss_uid: d.uid, physician_id: d.physician_id }));
    }
    if (text.includes("FROM cdmss_mapping_decisions ORDER BY decided_at")) {
      return decisions.map((d) => ({ id: d.id, decision: d.decision, cdmss_uid: d.uid, cdmss_name: d.name, physician_id: d.physician_id, physician_name: d.physician_name, reason: d.reason, note: d.note, decided_by_email: d.email, decided_at: "2026-10-08T05:00:00.000Z" }));
    }
    if (text.includes("INSERT INTO cdmss_mapping_decisions")) {
      if (failDecisionInsert) throw new Error("relation cdmss_mapping_decisions does not exist");
      const d: Dec = { id: `dec-${decisions.length + 1}`, decision: String(v[0]), uid: String(v[1]), name: String(v[2]), physician_id: String(v[3]), physician_name: String(v[4]), reason: String(v[5]), note: (v[6] as string | null) ?? null, profile: String(v[7]), email: String(v[8]) };
      if (decisions.some((x) => x.decision === d.decision && x.uid === d.uid && x.physician_id === d.physician_id)) return [];
      decisions.push(d);
      return [{ id: d.id }];
    }
    if (text.includes("DELETE FROM cdmss_mapping_decisions")) {
      decisions = decisions.filter((d) => d.id !== v[0]);
      return [];
    }
    if (text.includes("UPDATE physicians SET cdmss_doctor_uid")) {
      if (updateMode === "no_rows") return []; // linked by someone else after the page was loaded
      if (updateMode === "unique") throw new Error('duplicate key value violates unique constraint "idx_physicians_cdmss_uid"');
      const uid = String(v[0]);
      const id = String(v[1]);
      if (physicians.some((p) => p.cdmss_doctor_uid === uid && p.id !== id)) {
        throw new Error('duplicate key value violates unique constraint "idx_physicians_cdmss_uid"');
      }
      const p = physicians.find((x) => x.id === id);
      if (!p || p.cdmss_doctor_uid) return [];
      p.cdmss_doctor_uid = uid;
      return [{ id }];
    }
    if (text.includes("INSERT INTO audit_log_v2")) {
      audits.push({ actor: String(v[0]), action: String(v[1]), entity: String(v[2]), after: JSON.parse(String(v[3])) });
      return [];
    }
    return [];
  });
}

beforeEach(() => {
  process.env.GOV_API_KEY = "gov-key";
  process.env.GOV_API_BASE = "https://cdmss.test";
  h.user = staff.smh;
  h.live = "claims";
  engagedAtA = new Set([P_SUNIL, P_MEERA, P_LINKED]);
  physicians = [
    { id: P_SUNIL, full_name: "Sunil Shah", phone: "9000005555", cdmss_doctor_uid: null, cdmss_alias_uids: null },
    { id: P_MEERA, full_name: "Meera Iyer", phone: "9000001111", cdmss_doctor_uid: null, cdmss_alias_uids: null },
    { id: P_LINKED, full_name: "Ravi Menon", phone: "9000003333", cdmss_doctor_uid: "D-OLD", cdmss_alias_uids: null },
  ];
  decisions = [];
  audits = [];
  failDecisionInsert = false;
  updateMode = "normal";
  sqlCalls = [];
  installSql();
  fetchMock.mockReset();
  fetchMock.mockImplementation(async (u: string) => (String(u).includes("/doctor-directory") ? json(200, DIRECTORY) : json(404, {})));
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => vi.unstubAllGlobals());

const post = (body: unknown) =>
  POST(new NextRequest("https://governance.test/api/audit-findings/mapping", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }));

const writes = () => sqlCalls.filter((t) => /^\s*(INSERT|UPDATE|DELETE)/.test(t) && !t.includes("audit_log_v2"));

describe("mapping review list", () => {
  it("lists the weak matches from the F1 matcher with reasons in words and which candidates can be confirmed", async () => {
    const body = await (await GET()).json();
    expect(body.ok).toBe(true);
    const byUid = Object.fromEntries(body.items.map((i: { uid: string }) => [i.uid, i]));
    expect(byUid["D-SUNIL"].reason).toBe("partial_name");
    expect(byUid["D-SUNIL"].reason_text).toMatch(/Partial name/);
    expect(byUid["D-SUNIL"].candidates).toEqual([{ physician_id: P_SUNIL, physician_name: "Sunil Shah", linked_uid: null, confirmable: true }]);
    expect(byUid["D-MEERA"].reason).toBe("mobile_mismatch");
    expect(byUid["D-RAVI"].reason).toBe("linked_to_other_uid");
    expect(byUid["D-RAVI"].candidates[0]).toMatchObject({ physician_id: P_LINKED, linked_uid: "D-OLD", confirmable: false });
    expect(body.coverage.before).toMatchObject({ active_physicians: 3, linked_physicians: 1 });
  });

  it("reads nothing but the directory and the database; it writes nothing", async () => {
    await GET();
    expect(writes()).toEqual([]);
  });

  it("answers 502 in words when the directory is down", async () => {
    fetchMock.mockRejectedValue(new Error("down"));
    const res = await GET();
    expect(res.status).toBe(502);
    expect((await res.json()).error).toBe("directory_unavailable");
  });
});

describe("confirm", () => {
  it("writes cdmss_doctor_uid and records who decided and when, in the decisions table and the audit log", async () => {
    const res = await post({ decision: "confirm", uid: "D-SUNIL", physician_id: P_SUNIL, note: "Same person, checked with HR." });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, decision: "confirm", physician_id: P_SUNIL, uid: "D-SUNIL" });
    expect(physicians.find((p) => p.id === P_SUNIL)!.cdmss_doctor_uid).toBe("D-SUNIL");

    expect(decisions).toHaveLength(1);
    expect(decisions[0]).toMatchObject({
      decision: "confirm",
      uid: "D-SUNIL",
      physician_id: P_SUNIL,
      reason: "partial_name",
      note: "Same person, checked with HR.",
      profile: PROFILE_ID,
      email: "benita@even.in",
    });
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({ actor: PROFILE_ID, action: "cdmss_mapping_confirmed", entity: P_SUNIL });
    expect(audits[0].after).toMatchObject({ cdmss_uid: "D-SUNIL", decided_by: "benita@even.in", reason: "partial_name" });

    // The audit row is written BEFORE the link: no link without its record.
    const insertAt = sqlCalls.findIndex((t) => t.includes("INSERT INTO cdmss_mapping_decisions"));
    const updateAt = sqlCalls.findIndex((t) => t.includes("UPDATE physicians SET cdmss_doctor_uid"));
    expect(insertAt).toBeGreaterThanOrEqual(0);
    expect(insertAt).toBeLessThan(updateAt);
  });

  it("only fills an empty link: a physician linked while the page was open is not overwritten, and the audit row is withdrawn", async () => {
    updateMode = "no_rows";
    const res = await post({ decision: "confirm", uid: "D-SUNIL", physician_id: P_SUNIL });
    expect(res.status).toBe(409);
    expect((await res.json()).error).toBe("physician_already_linked");
    expect(decisions).toHaveLength(0);
    expect(audits).toHaveLength(0);
  });

  it("refuses to overwrite a physician who is already linked to another CDMSS doctor", async () => {
    const res = await post({ decision: "confirm", uid: "D-RAVI", physician_id: P_LINKED });
    expect(res.status).toBe(409);
    expect((await res.json()).error).toBe("physician_already_linked");
    expect(physicians.find((p) => p.id === P_LINKED)!.cdmss_doctor_uid).toBe("D-OLD");
    expect(writes()).toEqual([]);
  });

  it("refuses when another physician took the CDMSS doctor meanwhile (unique index), and leaves no decision behind", async () => {
    updateMode = "unique";
    const res = await post({ decision: "confirm", uid: "D-SUNIL", physician_id: P_SUNIL });
    expect(res.status).toBe(409);
    expect((await res.json()).error).toBe("uid_already_linked");
    expect(decisions).toHaveLength(0);
    expect(audits).toHaveLength(0);
  });

  it("only accepts a pair that is on the current review list", async () => {
    // Not a candidate for that CDMSS doctor.
    const res = await post({ decision: "confirm", uid: "D-SUNIL", physician_id: P_MEERA });
    expect(res.status).toBe(409);
    expect((await res.json()).error).toBe("not_in_review");
    // A CDMSS doctor that is not under review at all.
    expect((await post({ decision: "confirm", uid: "D-NOBODY", physician_id: P_SUNIL })).status).toBe(409);
    expect(writes()).toEqual([]);
    expect(physicians.every((p) => p.cdmss_doctor_uid === null || p.id === P_LINKED)).toBe(true);
  });

  it("changes nothing when the decision cannot be recorded", async () => {
    failDecisionInsert = true;
    const res = await post({ decision: "confirm", uid: "D-SUNIL", physician_id: P_SUNIL });
    expect(res.status).toBe(500);
    expect((await res.json()).error).toBe("decision_not_recorded");
    expect(physicians.find((p) => p.id === P_SUNIL)!.cdmss_doctor_uid).toBeNull();
    expect(sqlCalls.some((t) => t.includes("UPDATE physicians SET cdmss_doctor_uid"))).toBe(false);
  });

  it("changes nothing when the directory cannot be read", async () => {
    fetchMock.mockRejectedValue(new Error("down"));
    const res = await post({ decision: "confirm", uid: "D-SUNIL", physician_id: P_SUNIL });
    expect(res.status).toBe(502);
    expect(writes()).toEqual([]);
  });
});

describe("reject", () => {
  it("records the rejection with who and when, never touches the physician, and stops offering the pair", async () => {
    const res = await post({ decision: "reject", uid: "D-MEERA", physician_id: P_MEERA });
    expect(res.status).toBe(200);
    expect(decisions[0]).toMatchObject({ decision: "reject", uid: "D-MEERA", physician_id: P_MEERA, email: "benita@even.in", profile: PROFILE_ID });
    expect(audits[0]).toMatchObject({ action: "cdmss_mapping_rejected", entity: P_MEERA });
    expect(sqlCalls.some((t) => t.includes("UPDATE physicians"))).toBe(false);

    const after = await (await GET()).json();
    expect(after.items.map((i: { uid: string }) => i.uid)).not.toContain("D-MEERA");
    expect(after.items.map((i: { uid: string }) => i.uid)).toContain("D-SUNIL");
    expect(after.recent[0]).toMatchObject({ decision: "reject", decided_by_email: "benita@even.in" });
  });

  it("a repeated reject is harmless", async () => {
    await post({ decision: "reject", uid: "D-MEERA", physician_id: P_MEERA });
    const again = await post({ decision: "reject", uid: "D-MEERA", physician_id: P_MEERA });
    expect(again.status).toBe(200);
    expect(decisions.filter((d) => d.decision === "reject")).toHaveLength(1);
    expect(audits).toHaveLength(1);
  });
});

describe("request validation", () => {
  it("rejects a malformed body before reading anything", async () => {
    for (const bad of [{}, { decision: "approve", uid: "D-1", physician_id: P_SUNIL }, { decision: "confirm", uid: "", physician_id: P_SUNIL }, { decision: "confirm", uid: "D-1", physician_id: "not-a-uuid" }]) {
      expect((await post(bad)).status).toBe(400);
    }
    expect(fetchMock).not.toHaveBeenCalled();
    expect(sqlCalls).toEqual([]);
  });
});

describe("site scope and live role (L3, L4)", () => {
  const confirmSunil = () => post({ decision: "confirm", uid: "D-SUNIL", physician_id: P_SUNIL });

  it("a Site Medical Head sees and decides only physicians engaged at a hospital they head", async () => {
    engagedAtA = new Set([P_SUNIL]); // Meera and Ravi are at another site
    const body = await (await GET()).json();
    expect(body.items.map((i: { uid: string }) => i.uid)).toEqual(["D-SUNIL"]);

    const refused = await post({ decision: "confirm", uid: "D-MEERA", physician_id: P_MEERA });
    expect(refused.status).toBe(403);
    expect((await refused.json()).error).toBe("out_of_scope");
    const rejected = await post({ decision: "reject", uid: "D-MEERA", physician_id: P_MEERA });
    expect(rejected.status).toBe(403);
    expect(writes()).toHaveLength(0); // no decision row, no link
    expect(physicians.find((p) => p.id === P_MEERA)?.cdmss_doctor_uid).toBeNull();

    expect((await confirmSunil()).status).toBe(200);
    expect(physicians.find((p) => p.id === P_SUNIL)?.cdmss_doctor_uid).toBe("D-SUNIL");
  });

  it("a Site Medical Head of a different hospital gets nothing", async () => {
    h.live = { ...liveFromClaims(staff.smh)!, smh_hospital_ids: [HOSPITAL_B] };
    expect((await (await GET()).json()).items).toEqual([]);
    expect((await confirmSunil()).status).toBe(403);
    expect(writes()).toHaveLength(0);
  });

  it("a super admin decides for any physician at any hospital", async () => {
    h.user = staff.superAdmin;
    engagedAtA = new Set();
    expect((await (await GET()).json()).items.length).toBe(3);
    expect((await confirmSunil()).status).toBe(200);
  });

  it("the role is the database's, not the cookie's: a revoked Site Medical Head is refused", async () => {
    h.live = { ...liveFromClaims(staff.smh)!, is_site_medical_head: false, smh_hospital_ids: [] };
    expect((await GET()).status).toBe(403);
    expect((await confirmSunil()).status).toBe(403);
    h.live = { ...liveFromClaims(staff.smh)!, status: "deactivated" };
    expect((await confirmSunil()).status).toBe(401);
    h.live = null;
    expect((await confirmSunil()).status).toBe(401);
    expect(writes()).toHaveLength(0);
  });

  it("a promoted super admin does not need a new login to lose access, and a stale cookie cannot grant one", async () => {
    // Cookie says super admin; the database says plain staff with no governance role.
    h.user = staff.superAdmin;
    h.live = { ...liveFromClaims(staff.hr)!, is_super_admin: false };
    expect((await confirmSunil()).status).toBe(403);
  });
});

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const h = vi.hoisted(() => ({
  user: { profileId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", status: "active", is_super_admin: true } as null | { profileId?: string; status?: string; is_super_admin: boolean },
  physicians: [] as Array<Record<string, unknown>>,
  writes: [] as Array<{ q: string; values: unknown[] }>,
}));

vi.mock("@/lib/auth", () => ({ getCurrentUser: vi.fn(async () => h.user) }));
vi.mock("@/lib/db", () => ({
  sql: async (strings: TemplateStringsArray, ...values: unknown[]) => {
    const q = Array.from(strings).join("?");
    if (q.includes("FROM physicians WHERE current_status")) return h.physicians;
    h.writes.push({ q, values });
    if (q.includes("UPDATE physicians") && q.includes("RETURNING")) return [{ id: values[2] }];
    return [];
  },
}));
vi.mock("@/lib/staff-live", async (orig) => {
  const real = await orig<typeof import("@/lib/staff-live")>();
  const { liveFromClaims } = await import("./helpers/fixtures");
  return { ...real, loadLiveStaff: vi.fn(async () => liveFromClaims(h.user)) };
});

import {
  last4,
  matchDirectory,
  normalizeName,
  parseDirectory,
  type DirectoryDoctor,
  type PhysicianRow,
} from "@/lib/cdmss-doctor-mapping";
import { GET, POST } from "@/app/api/admin/map-cdmss-doctors/route";

const dir = (over: Partial<DirectoryDoctor> & { doctor_uid: string; name: string }): DirectoryDoctor => ({
  mobile_last4: null,
  alias_uids: [],
  disabled: false,
  ...over,
});
const phys = (over: Partial<PhysicianRow> & { id: string; full_name: string }): PhysicianRow => ({
  phone: null,
  cdmss_doctor_uid: null,
  cdmss_alias_uids: null,
  ...over,
});

describe("name normalisation", () => {
  it("is order-independent and ignores titles and punctuation", () => {
    expect(normalizeName("Dr. K N Srikanth")).toBe(normalizeName("Srikanth K N"));
    expect(normalizeName("DR  Asha-Rao")).toBe("asha rao");
    expect(normalizeName("")).toBe("");
  });

  it("last4 returns at most four digits", () => {
    expect(last4("+91 98450 12345")).toBe("2345");
    expect(last4("123")).toBeNull();
    expect(last4(null)).toBeNull();
  });
});

describe("parseDirectory", () => {
  it("keeps alias_uids and disabled, drops rows without uid or name, and de-duplicates", () => {
    const out = parseDirectory({
      ok: true,
      doctors: [
        { doctor_uid: "A", name: "Asha Rao", mobile_last4: "1234", alias_uids: ["A2", "A", "A2"], disabled: true },
        { doctor_uid: "A", name: "Asha Rao dup" },
        { doctor_uid: "", name: "x" },
        { doctor_uid: "B" },
        { doctor_uid: "C", name: "Chand", mobile_last4: "12" },
      ],
    });
    expect(out).toEqual([
      { doctor_uid: "A", name: "Asha Rao", mobile_last4: "1234", alias_uids: ["A2"], disabled: true },
      { doctor_uid: "C", name: "Chand", mobile_last4: null, alias_uids: [], disabled: false },
    ]);
  });
});

describe("matchDirectory: auto-link only when certain", () => {
  it("links an exact unique name regardless of word order", () => {
    const r = matchDirectory(
      [dir({ doctor_uid: "U1", name: "Srikanth K N" })],
      [phys({ id: "p1", full_name: "Dr. K N Srikanth" })],
    );
    expect(r.auto).toHaveLength(1);
    expect(r.auto[0]).toMatchObject({ uid: "U1", physician_id: "p1", reason: "exact_unique_name" });
    expect(r.review).toEqual([]);
  });

  it("calls it name_and_mobile when the last-4 agrees too", () => {
    const r = matchDirectory(
      [dir({ doctor_uid: "U1", name: "Asha Rao", mobile_last4: "4321" })],
      [phys({ id: "p1", full_name: "Asha Rao", phone: "98450 04321" })],
    );
    expect(r.auto[0].reason).toBe("name_and_mobile");
  });

  it("refuses to link when a unique name has a mobile that disagrees", () => {
    const r = matchDirectory(
      [dir({ doctor_uid: "U1", name: "Asha Rao", mobile_last4: "4321" })],
      [phys({ id: "p1", full_name: "Asha Rao", phone: "9845011111" })],
    );
    expect(r.auto).toEqual([]);
    expect(r.review).toEqual([
      expect.objectContaining({ uid: "U1", reason: "mobile_mismatch", candidates: [{ physician_id: "p1", physician_name: "Asha Rao" }] }),
    ]);
  });

  it("two doctors with one name: the mobile last-4 picks the right physician for each", () => {
    const r = matchDirectory(
      [
        dir({ doctor_uid: "U1", name: "Rajesh Kumar", mobile_last4: "1111" }),
        dir({ doctor_uid: "U2", name: "Rajesh Kumar", mobile_last4: "2222" }),
      ],
      [
        phys({ id: "p1", full_name: "Rajesh Kumar", phone: "9000002222" }),
        phys({ id: "p2", full_name: "Kumar Rajesh", phone: "9000001111" }),
      ],
    );
    expect(r.auto.map((a) => [a.uid, a.physician_id, a.reason])).toEqual([
      ["U1", "p2", "name_and_mobile"],
      ["U2", "p1", "name_and_mobile"],
    ]);
    expect(r.review).toEqual([]);
  });

  it("an ambiguous name with no usable mobile goes to review, never auto", () => {
    const r = matchDirectory(
      [dir({ doctor_uid: "U1", name: "Rajesh Kumar" })],
      [phys({ id: "p1", full_name: "Rajesh Kumar" }), phys({ id: "p2", full_name: "Kumar Rajesh" })],
    );
    expect(r.auto).toEqual([]);
    expect(r.review[0]).toMatchObject({ uid: "U1", reason: "ambiguous_name" });
    expect(r.review[0].candidates.map((c) => c.physician_id)).toEqual(["p1", "p2"]);
  });

  it("a partial name (middle name missing) is review-only, and an unrelated doctor is unmatched", () => {
    const r = matchDirectory(
      [dir({ doctor_uid: "U1", name: "Asha Kumari Rao" }), dir({ doctor_uid: "U2", name: "Zed Nobody" })],
      [phys({ id: "p1", full_name: "Asha Rao" })],
    );
    expect(r.auto).toEqual([]);
    expect(r.review).toEqual([expect.objectContaining({ uid: "U1", reason: "partial_name" })]);
    expect(r.unmatched).toEqual([{ uid: "U2", name: "Zed Nobody", disabled: false }]);
  });

  it("never reassigns a physician who is already linked, and reports the name clash", () => {
    const r = matchDirectory(
      [dir({ doctor_uid: "U2", name: "Asha Rao" })],
      [phys({ id: "p1", full_name: "Asha Rao", cdmss_doctor_uid: "U1" })],
    );
    expect(r.auto).toEqual([]);
    expect(r.review[0].reason).toBe("linked_to_other_uid");
  });

  it("already-linked physicians are counted and not touched", () => {
    const r = matchDirectory(
      [dir({ doctor_uid: "U1", name: "Asha Rao" })],
      [phys({ id: "p1", full_name: "Asha Rao", cdmss_doctor_uid: "U1" })],
    );
    expect(r.auto).toEqual([]);
    expect(r.already_linked).toBe(1);
    expect(r.review).toEqual([]);
  });
});

describe("matchDirectory: alias_uids and disabled doctors", () => {
  it("records only PROVEN aliases when linking, and flags disabled doctors without hiding them", () => {
    const r = matchDirectory(
      [
        dir({
          doctor_uid: "U1",
          name: "Asha Rao",
          alias_uids: ["OLD1", "OLD2"],
          alias_names: { OLD1: "Dr. Rao Asha", OLD2: "Someone Else" },
          disabled: true,
        }),
      ],
      [phys({ id: "p1", full_name: "Asha Rao" })],
    );
    expect(r.auto[0]).toMatchObject({ uid: "U1", alias_uids: ["OLD1"], disabled: true });
  });

  it("an alias with no name evidence is not recorded", () => {
    const r = matchDirectory(
      [dir({ doctor_uid: "U1", name: "Asha Rao", alias_uids: ["U2"] })],
      [phys({ id: "p1", full_name: "Asha Rao" })],
    );
    expect(r.auto[0].alias_uids).toEqual([]);
  });

  it("shared department phone: two different names on one mobile never move physician B onto A's uid", () => {
    // CDMSS collapsed B's uid U2 into A's U1 because they share a mobile. B is linked to U2.
    const directory = [
      dir({ doctor_uid: "U1", name: "Asha Rao", mobile_last4: "5555", alias_uids: ["U2"] }),
    ];
    const physicians = [
      phys({ id: "pA", full_name: "Asha Rao", phone: "+91 90000 05555" }),
      phys({ id: "pB", full_name: "Vikram Shetty", phone: "+91 90000 05555", cdmss_doctor_uid: "U2" }),
    ];
    const r = matchDirectory(directory, physicians);
    // B is not moved, and is flagged for a person to look at.
    expect(r.auto.find((a) => a.physician_id === "pB")).toBeUndefined();
    expect(r.review).toEqual([
      expect.objectContaining({
        uid: "U1",
        reason: "alias_name_mismatch",
        candidates: [{ physician_id: "pB", physician_name: "Vikram Shetty" }],
      }),
    ]);
    // A still links to U1 on its own name, and does NOT inherit B's uid as an alias.
    const a = r.auto.find((x) => x.physician_id === "pA")!;
    expect(a).toMatchObject({ uid: "U1", alias_uids: [] });
    expect(r.alias_updates).toEqual([]);
  });

  it("the same case when A is already linked to U1: B stays on U2, and A is not given U2", () => {
    const r = matchDirectory(
      [dir({ doctor_uid: "U1", name: "Asha Rao", alias_uids: ["U2"] })],
      [
        phys({ id: "pA", full_name: "Asha Rao", cdmss_doctor_uid: "U1", cdmss_alias_uids: [] }),
        phys({ id: "pB", full_name: "Vikram Shetty", cdmss_doctor_uid: "U2" }),
      ],
    );
    expect(r.auto).toEqual([]);
    expect(r.review.map((x) => x.reason)).toEqual(["alias_name_mismatch"]);
    expect(r.alias_updates).toEqual([]); // nothing proves U2 is Asha Rao, so it is never written to her
  });

  it("an existing link under a different name keeps its link and alias list untouched", () => {
    const r = matchDirectory(
      [dir({ doctor_uid: "U1", name: "Asha Rao", alias_uids: ["X"], alias_names: { X: "Asha Rao" } })],
      [phys({ id: "p1", full_name: "Totally Different", cdmss_doctor_uid: "U1" })],
    );
    expect(r.auto).toEqual([]);
    expect(r.alias_updates).toEqual([]);
    expect(r.already_linked).toBe(1);
  });

  it("parseDirectory reads alias names from either shape", () => {
    const out = parseDirectory({
      doctors: [
        { doctor_uid: "U1", name: "A", alias_uids: ["X", "Y"], alias_names: { X: "A" } },
        { doctor_uid: "U2", name: "B", alias_uids: ["Z"], aliases: [{ doctor_uid: "Z", name: "B" }] },
      ],
    });
    expect(out[0].alias_names).toEqual({ X: "A" });
    expect(out[1].alias_names).toEqual({ Z: "B" });
  });

  it("moves a physician linked through a retired alias onto the canonical uid", () => {
    const r = matchDirectory(
      [dir({ doctor_uid: "U1", name: "Asha Rao", alias_uids: ["OLD1"] })],
      [phys({ id: "p1", full_name: "Asha Rao", cdmss_doctor_uid: "OLD1" })],
    );
    expect(r.auto).toEqual([
      expect.objectContaining({ uid: "U1", physician_id: "p1", reason: "alias_relink", alias_uids: ["OLD1"] }),
    ]);
    expect(r.already_linked).toBe(0);
  });

  it("proposes an alias-list refresh for a physician already on the canonical uid, from proven aliases", () => {
    const r = matchDirectory(
      [dir({ doctor_uid: "U1", name: "Asha Rao", alias_uids: ["OLD1"], alias_names: { OLD1: "Asha Rao" } })],
      [phys({ id: "p1", full_name: "Asha Rao", cdmss_doctor_uid: "U1", cdmss_alias_uids: [] })],
    );
    expect(r.alias_updates).toEqual([{ physician_id: "p1", uid: "U1", alias_uids: ["OLD1"] }]);
  });

  it("a physician two directory doctors would claim is sent to review for both", () => {
    const r = matchDirectory(
      [
        dir({ doctor_uid: "U1", name: "Asha Rao", mobile_last4: "1111" }),
        dir({ doctor_uid: "U2", name: "Rao Asha", mobile_last4: "1111" }),
      ],
      [phys({ id: "p1", full_name: "Asha Rao", phone: "9000001111" })],
    );
    expect(r.auto).toEqual([]);
    expect(r.review.map((x) => x.reason)).toEqual(["ambiguous_name", "ambiguous_name"]);
  });
});

describe("coverage before/after (the dry-run report)", () => {
  it("projects coverage without writing", () => {
    const r = matchDirectory(
      [
        dir({ doctor_uid: "U1", name: "Asha Rao" }),
        dir({ doctor_uid: "U2", name: "Bina Shah" }),
        dir({ doctor_uid: "U3", name: "Chet Nair" }),
        dir({ doctor_uid: "U4", name: "Deepa Iyer" }),
      ],
      [
        phys({ id: "p1", full_name: "Asha Rao", cdmss_doctor_uid: "U1" }),
        phys({ id: "p2", full_name: "Bina Shah" }),
        phys({ id: "p3", full_name: "Chet Nair" }),
        phys({ id: "p4", full_name: "Somebody Else" }),
      ],
    );
    expect(r.coverage.before).toMatchObject({ active_physicians: 4, linked_physicians: 1, directory_doctors: 4, directory_linked: 1 });
    expect(r.coverage.after).toMatchObject({ linked_physicians: 3, directory_linked: 3 });
    expect(r.coverage.before.physician_percent).toBe(25);
    expect(r.coverage.after.physician_percent).toBe(75);
    expect(r.unmatched.map((u) => u.uid)).toEqual(["U4"]);
  });
});

describe("admin route: dry run writes nothing, apply writes only auto links", () => {
  const fetchMock = vi.fn();
  beforeEach(() => {
    h.user = { profileId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", status: "active", is_super_admin: true };
    h.writes.length = 0;
    process.env.GOV_API_KEY = "k";
    h.physicians = [
      { id: "p1", full_name: "Asha Rao", phone: null, cdmss_doctor_uid: null, cdmss_alias_uids: null },
      { id: "p2", full_name: "Rajesh Kumar", phone: null, cdmss_doctor_uid: null, cdmss_alias_uids: null },
      { id: "p3", full_name: "Kumar Rajesh", phone: null, cdmss_doctor_uid: null, cdmss_alias_uids: null },
    ];
    fetchMock.mockReset();
    fetchMock.mockResolvedValue(
      new Response(
        JSON.stringify({
          ok: true,
          doctors: [
            { doctor_uid: "U1", name: "Asha Rao", mobile_last4: null, alias_uids: ["OLD"], alias_names: { OLD: "Asha Rao" } },
            { doctor_uid: "U2", name: "Rajesh Kumar", mobile_last4: null },
          ],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    );
    vi.stubGlobal("fetch", fetchMock);
  });
  afterEach(() => vi.unstubAllGlobals());

  const req = (qs = "") => new NextRequest(`https://gov.test/api/admin/map-cdmss-doctors${qs}`, { method: "POST" });
  const getReq = () => new Request("https://gov.test/api/admin/map-cdmss-doctors");

  it("GET is a dry run with coverage and a review list, and issues no write", async () => {
    const res = await GET(getReq());
    const body = await res.json();
    expect(body.mode).toBe("dry_run");
    expect(body.would_link.map((a: { uid: string }) => a.uid)).toEqual(["U1"]);
    expect(body.review.map((a: { uid: string; reason: string }) => [a.uid, a.reason])).toEqual([["U2", "ambiguous_name"]]);
    expect(body.coverage.before.linked_physicians).toBe(0);
    expect(body.coverage.after.linked_physicians).toBe(1);
    expect(h.writes).toHaveLength(0);
  });

  it("POST ?dry_run=1 is also write-free", async () => {
    const res = await POST(req("?dry_run=1"));
    expect((await res.json()).mode).toBe("dry_run");
    expect(h.writes).toHaveLength(0);
  });

  it("POST applies the auto link (with aliases) and never the review item", async () => {
    const res = await POST(req());
    const body = await res.json();
    expect(body).toMatchObject({ ok: true, mode: "apply", applied: 1 });
    const updates = h.writes.filter((w) => w.q.includes("UPDATE physicians"));
    expect(updates).toHaveLength(1);
    expect(updates[0].values[0]).toBe("U1");
    expect(updates[0].values[1]).toEqual(["OLD"]);
    expect(updates[0].values[2]).toBe("p1");
    expect(updates[0].q).toContain("cdmss_doctor_uid IS NULL OR cdmss_doctor_uid = ANY(");
    expect(body.review).toHaveLength(1);
  });

  it("is super_admin (or the ops bearer) only; see ops-auth.test.ts for the bearer paths", async () => {
    h.user = { is_super_admin: false };
    expect((await GET(getReq())).status).toBe(401);
    expect((await POST(req())).status).toBe(401);
    h.user = null;
    expect((await GET(getReq())).status).toBe(401);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("answers 502 when the directory cannot be read, and writes nothing", async () => {
    fetchMock.mockResolvedValue(new Response("nope", { status: 503 }));
    const res = await POST(req());
    expect(res.status).toBe(502);
    expect(h.writes).toHaveLength(0);
  });
});

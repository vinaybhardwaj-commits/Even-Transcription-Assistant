/** Open access (owner ruling 8 Oct 2026): POST /api/rooms-live/claims with no cookie, the name it records, and the 30-a-minute per-IP limit. In-memory stand-in for the database. */
import { describe, it, expect, vi, beforeEach } from "vitest";

const M = vi.hoisted(() => ({ cookie: vi.fn(), verify: vi.fn(), claim: vi.fn(), clear: vi.fn(), staff: { value: null as string | null } }));
vi.mock("@/lib/db", () => ({ sql: (() => Promise.resolve([])) as unknown }));
vi.mock("@/lib/cookie", () => ({ readAdminCookie: M.cookie }));
vi.mock("@/lib/auth", () => ({ verifyAdminJwt: M.verify, ADMIN_COOKIE: "admin" }));
vi.mock("next/headers", () => ({ cookies: async () => ({ get: (n: string) => (n === "eta_staff_session" && M.staff.value ? { value: M.staff.value } : undefined) }) }));
vi.mock("@/lib/rooms-live-claims", () => ({ claim: M.claim, clear: M.clear, openClaims: async () => [] }));
vi.mock("@/lib/rooms-live/roster", () => ({ loadRoster: async () => [{ room_id: "room_a", label: "A" }], isRosterRoom: async (_d: unknown, id: string) => id === "room_a" }));
vi.mock("@/lib/rooms-live/snapshot", () => ({ buildSnapshot: async () => ({ rooms: [{ room_id: "room_a", state: "muted" }] }), resetSnapshotMemo: () => {} }));

import { POST } from "@/app/api/rooms-live/claims/route";
import { resetClaimLimitForTests } from "@/lib/rooms-live/claim-limit";
import { signStaffJwt } from "@/lib/rooms-live/staff-auth";

const post = (body: unknown, ip = "10.1.0.1") => POST(new Request("http://x/api/rooms-live/claims", { method: "POST", headers: { "content-type": "application/json", "x-forwarded-for": ip }, body: JSON.stringify(body) }));
const claimedBy = () => (M.claim.mock.calls.at(-1)![1] as { claimed_by: string }).claimed_by;

beforeEach(() => {
  resetClaimLimitForTests();
  M.cookie.mockReset().mockResolvedValue(null);
  M.verify.mockReset();
  M.claim.mockReset().mockImplementation(async (_d: unknown, i: { claimed_by: string }) => ({ ok: true, claim: { claimed_by: i.claimed_by, claimed_at: new Date().toISOString() } }));
  M.clear.mockReset().mockResolvedValue({ ok: true });
  M.staff.value = null;
  process.env.JWT_SECRET_STAFF = "fixture-staff-secret-not-real";
});

describe("claims POST, no cookie", () => {
  it("records the body name", async () => {
    const res = await post({ room_id: "room_a", action: "claim", name: "  Asha   Kumar " });
    expect(res.status).toBe(200);
    expect(claimedBy()).toBe("Asha Kumar");
  });
  it("falls back to 'staff' when the name is missing, blank or not a string", async () => {
    for (const name of [undefined, "", "   ", 5, null]) {
      await post({ room_id: "room_a", action: "claim", name }, `10.1.1.${String(name)}`);
      expect(claimedBy()).toBe("staff");
    }
  });
  it("a 65-character name is ignored (falls back to 'staff'); 64 is kept; control characters are stripped", async () => {
    await post({ room_id: "room_a", action: "claim", name: "x".repeat(65) });
    expect(claimedBy()).toBe("staff");
    await post({ room_id: "room_a", action: "claim", name: "y".repeat(64) });
    expect(claimedBy()).toBe("y".repeat(64));
    await post({ room_id: "room_a", action: "claim", name: "A\u0000\nB" });
    expect(claimedBy()).toBe("A B");
  });
  it("clear uses the same name rule", async () => {
    await post({ room_id: "room_a", action: "clear", name: "Ravi" });
    expect((M.clear.mock.calls.at(-1)![1] as { cleared_by: string }).cleared_by).toBe("Ravi");
  });
  it("a staff cookie's name wins over a body name", async () => {
    M.staff.value = await signStaffJwt("Front Desk");
    await post({ room_id: "room_a", action: "claim", name: "Someone Else" });
    expect(claimedBy()).toBe("Front Desk");
  });
  it("an expired/garbage staff cookie is treated as open (body name used, not 401)", async () => {
    M.staff.value = "not.a.jwt";
    const res = await post({ room_id: "room_a", action: "claim", name: "Meera" });
    expect(res.status).toBe(200);
    expect(claimedBy()).toBe("Meera");
  });
});

describe("claims POST rate limit", () => {
  it("30 POSTs a minute per IP pass; the 31st is 429 rate_limited; another IP is unaffected", async () => {
    for (let i = 0; i < 30; i++) expect((await post({ room_id: "room_a", action: "claim", name: "A" }, "10.2.0.1")).status).toBe(200);
    const res = await post({ room_id: "room_a", action: "claim", name: "A" }, "10.2.0.1");
    expect(res.status).toBe(429);
    expect(await res.json()).toEqual({ ok: false, reason: "rate_limited" });
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect((await post({ room_id: "room_a", action: "claim", name: "A" }, "10.2.0.2")).status).toBe(200);
  });
  it("the window moves on", async () => {
    const { claimAllowed } = await import("@/lib/rooms-live/claim-limit");
    for (let i = 0; i < 30; i++) expect(claimAllowed("ip-w", 1000 + i)).toBe(true);
    expect(claimAllowed("ip-w", 1100)).toBe(false);
    expect(claimAllowed("ip-w", 1000 + 60_001)).toBe(true);
  });
});

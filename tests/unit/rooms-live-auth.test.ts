/** Staff login (SPEC-v1 AMENDMENT 2): good PIN, bad PIN, the rate limit, the cookie, and "a staff cookie opens nothing else". Fixture values only. */
import { describe, it, expect, vi, beforeEach } from "vitest";
import bcrypt from "bcryptjs";

const M = vi.hoisted(() => ({ cookie: vi.fn(), verify: vi.fn(), staff: { value: null as string | null } }));
vi.mock("@/lib/db", () => ({ sql: (() => Promise.resolve([])) as unknown }));
vi.mock("@/lib/cookie", () => ({ readAdminCookie: M.cookie }));
vi.mock("@/lib/auth", () => ({ verifyAdminJwt: M.verify, ADMIN_COOKIE: "admin" }));
vi.mock("next/headers", () => ({ cookies: async () => ({ get: (n: string) => (n === "eta_staff_session" && M.staff.value ? { value: M.staff.value } : undefined) }) }));

import { POST as login } from "@/app/api/rooms-live/login/route";
import { POST as logout } from "@/app/api/rooms-live/logout/route";
import { STAFF_COOKIE, cleanName, pinOk, rateLimited, recordFailure, resetRateLimitForTests, signStaffJwt, verifyStaffJwt } from "@/lib/rooms-live/staff-auth";

const PIN = "4821";
const post = (body: unknown, ip = "10.0.0.1") => login(new Request("http://x/api/rooms-live/login", { method: "POST", headers: { "content-type": "application/json", "x-forwarded-for": ip }, body: JSON.stringify(body) }));

beforeEach(() => {
  resetRateLimitForTests();
  process.env.JWT_SECRET_STAFF = "fixture-staff-secret-not-real";
  process.env.ROOMS_LIVE_STAFF_PIN_HASH = bcrypt.hashSync(PIN, 4);
  M.cookie.mockReset();
  M.verify.mockReset();
  M.staff.value = null;
});

describe("login", () => {
  it("good PIN + name: 200, the cookie is set with the required attributes, the JWT carries aud staff, staff:true and the typed name", async () => {
    const res = await post({ pin: PIN, name: "  Asha  Kumar " });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, name: "Asha Kumar" });
    const sc = res.headers.get("set-cookie") ?? "";
    expect(sc).toContain(`${STAFF_COOKIE}=`);
    expect(sc).toMatch(/HttpOnly/i);
    expect(sc).toMatch(/Secure/i);
    expect(sc).toMatch(/SameSite=lax/i);
    expect(sc).toMatch(/Path=\//);
    expect(sc).toMatch(/Max-Age=43200/);
    expect(res.headers.get("cache-control")).toBe("no-store");
    const jwt = decodeURIComponent(sc.split(";")[0]!.split("=")[1]!);
    const claims = await verifyStaffJwt(jwt);
    expect(claims).toEqual({ staff: true, name: "Asha Kumar" });
    const payload = JSON.parse(Buffer.from(jwt.split(".")[1]!, "base64url").toString());
    expect(payload.aud).toBe("staff");
    expect(payload.exp - payload.iat).toBe(43200);
  });
  it("bad PIN, empty PIN, missing name, long name, non-JSON body: all the same 401, no cookie", async () => {
    for (const b of [{ pin: "0000", name: "A" }, { pin: "", name: "A" }, { pin: PIN, name: "" }, { pin: PIN, name: "x".repeat(65) }, { pin: PIN }, {}, { pin: 4821, name: "A" }]) {
      const res = await post(b, "10.0.0.2");
      expect(res.status, JSON.stringify(b)).toBe(401);
      expect(res.headers.get("set-cookie")).toBeNull();
      expect((await res.json()).error.code).toBe("BAD_LOGIN");
      resetRateLimitForTests();
    }
    const raw = await login(new Request("http://x/api/rooms-live/login", { method: "POST", headers: { "x-forwarded-for": "10.0.0.3" }, body: "not json" }));
    expect(raw.status).toBe(401);
  });
  it("FIX-1 F7: only FAILED attempts count: 12 successful logins in a minute from one IP all succeed", async () => {
    for (let i = 0; i < 12; i++) expect((await post({ pin: PIN, name: `Person ${i}` }, "10.0.0.20")).status).toBe(200);
  });
  it("FIX-1 F7: 10 failures a minute per IP; the 11th attempt is 429 even with the right PIN; another IP is unaffected; the window moves on", async () => {
    for (let i = 0; i < 10; i++) expect((await post({ pin: "0000", name: "A" }, "10.0.0.9")).status).toBe(401);
    const eleventh = await post({ pin: PIN, name: "A" }, "10.0.0.9");
    expect(eleventh.status).toBe(429);
    expect(eleventh.headers.get("set-cookie")).toBeNull();
    expect((await post({ pin: PIN, name: "A" }, "10.0.0.10")).status).toBe(200);
    expect(rateLimited("ip-x", 1000)).toBe(false);
    for (let i = 0; i < 9; i++) recordFailure("ip-x", 1000 + i);
    expect(rateLimited("ip-x", 1010)).toBe(false);
    recordFailure("ip-x", 1011);
    expect(rateLimited("ip-x", 1012)).toBe(true);
    expect(rateLimited("ip-x", 1000 + 60_002)).toBe(false);
  });
  it("FIX-2 F26: 15 CONCURRENT wrong-PIN calls from one IP: at most 10 reach bcrypt, the other 5 are 429 (the attempt is counted before bcrypt runs)", async () => {
    const spy = vi.spyOn(bcrypt, "compare");
    try {
      const results = await Promise.all(Array.from({ length: 15 }, () => post({ pin: "0000", name: "A" }, "10.0.0.30")));
      expect(results.filter((r) => r.status === 401).length).toBe(10);
      expect(results.filter((r) => r.status === 429).length).toBe(5);
      expect(spy.mock.calls.length).toBeLessThanOrEqual(10);
      // a success forgives its own attempt: it does not eat into the limit
      spy.mockClear();
      resetRateLimitForTests();
      for (let i = 0; i < 12; i++) expect((await post({ pin: PIN, name: "B" }, "10.0.0.31")).status).toBe(200);
    } finally {
      spy.mockRestore();
    }
  });
  it("login not configured: an unset PIN hash never lets anyone in (401); an unset secret is 503, with no cookie", async () => {
    delete process.env.ROOMS_LIVE_STAFF_PIN_HASH;
    expect((await post({ pin: PIN, name: "A" }, "10.0.1.1")).status).toBe(401);
    expect(await pinOk(PIN, {})).toBe(false);
    process.env.ROOMS_LIVE_STAFF_PIN_HASH = bcrypt.hashSync(PIN, 4);
    delete process.env.JWT_SECRET_STAFF;
    const res = await post({ pin: PIN, name: "A" }, "10.0.1.2");
    expect(res.status).toBe(503);
    expect(res.headers.get("set-cookie")).toBeNull();
  });
  it("the PIN compare is bcrypt (a plain-text env value never matches) and a malformed hash is just false", async () => {
    expect(await pinOk(PIN, { ROOMS_LIVE_STAFF_PIN_HASH: PIN })).toBe(false);
    expect(await pinOk(PIN, { ROOMS_LIVE_STAFF_PIN_HASH: "$2a$10$short" })).toBe(false);
    expect(await pinOk(PIN, { ROOMS_LIVE_STAFF_PIN_HASH: bcrypt.hashSync(PIN, 4) })).toBe(true);
    expect(await pinOk("x".repeat(40), { ROOMS_LIVE_STAFF_PIN_HASH: bcrypt.hashSync(PIN, 4) })).toBe(false);
  });
  it("neither the PIN, the hash nor the secret is ever logged or echoed", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    delete process.env.JWT_SECRET_STAFF;
    const res = await post({ pin: PIN, name: "A" }, "10.0.2.1");
    const text = JSON.stringify([await res.text(), spy.mock.calls, log.mock.calls]);
    expect(text).not.toContain(PIN);
    expect(text).not.toContain(process.env.ROOMS_LIVE_STAFF_PIN_HASH!);
    spy.mockRestore();
    log.mockRestore();
  });
  it("logout expires the cookie", async () => {
    const res = await logout();
    const sc = res.headers.get("set-cookie") ?? "";
    expect(sc).toContain(`${STAFF_COOKIE}=;`);
    expect(sc).toMatch(/Max-Age=0/);
  });
  it("names: control characters and runs of spaces collapse; 64 is the limit", () => {
    expect(cleanName("A\u0000\nB")).toBe("A B");
    expect(cleanName("x".repeat(64))).toHaveLength(64);
    expect(cleanName("x".repeat(65))).toBeNull();
    expect(cleanName("   ")).toBeNull();
    expect(cleanName(5)).toBeNull();
  });
});

describe("the staff cookie opens nothing else", () => {
  it("signed with the STAFF secret only: a token signed with another secret, another audience or an expired one is rejected", async () => {
    const good = await signStaffJwt("A");
    expect(await verifyStaffJwt(good)).not.toBeNull();
    expect(await verifyStaffJwt(good, { JWT_SECRET_STAFF: "another-secret" })).toBeNull();
    expect(await verifyStaffJwt("x.y.z")).toBeNull();
    const { SignJWT } = await import("jose");
    const wrongAud = await new SignJWT({ staff: true, name: "A" }).setProtectedHeader({ alg: "HS256" }).setAudience("admin").setExpirationTime("1h").sign(new TextEncoder().encode("fixture-staff-secret-not-real"));
    expect(await verifyStaffJwt(wrongAud)).toBeNull();
    const old = await new SignJWT({ staff: true, name: "A" }).setProtectedHeader({ alg: "HS256" }).setAudience("staff").setExpirationTime(Math.floor(Date.now() / 1000) - 10).sign(new TextEncoder().encode("fixture-staff-secret-not-real"));
    expect(await verifyStaffJwt(old)).toBeNull();
  });
  it("a staff cookie gets 401 from an existing bench route (benchAdminGuard is unchanged: it only knows the admin cookie)", async () => {
    M.staff.value = await signStaffJwt("Reception");
    M.cookie.mockResolvedValue(null); // no admin cookie
    const { GET } = await import("@/app/api/admin/bench/listeners/route");
    const res = await GET();
    expect(res.status).toBe(401);
    const { benchAdminGuard } = await import("@/lib/bench");
    expect((await benchAdminGuard()).ok).toBe(false);
  });
});

describe("v1.1: client IP", () => {
  it("x-vercel-forwarded-for wins over the first x-forwarded-for entry (the client can write the latter)", async () => {
    const { clientIp } = await import("@/lib/rooms-live/staff-auth");
    const h = (o: Record<string, string>) => new Request("http://x/", { headers: o });
    expect(clientIp(h({ "x-vercel-forwarded-for": "203.0.113.7", "x-forwarded-for": "1.2.3.4, 203.0.113.7" }))).toBe("203.0.113.7");
    expect(clientIp(h({ "x-forwarded-for": "1.2.3.4, 5.6.7.8" }))).toBe("1.2.3.4");
    expect(clientIp(h({ "x-real-ip": "9.9.9.9" }))).toBe("9.9.9.9");
    expect(clientIp(h({}))).toBe("unknown");
  });
});

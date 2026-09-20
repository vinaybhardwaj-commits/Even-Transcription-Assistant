/**
 * lib/admin-gate.ts — an UNSET ADMIN_TOKEN MEANS REFUSE.
 *
 * The gate used to read `if (!expected) return null; // dev mode`: with the secret unset, every
 * caller passed. That is the fall-through `app/api/run-migrations/route.ts` avoids by refusing when
 * its secret is unset, and it is the case nobody writes a test for, so it is the first thing this
 * file asserts. Every unset-shaped input (unset, empty, blank) is run against every kind of
 * presented credential (none, empty, junk, a bearer, a ?token=), including an EMPTY credential
 * against an EMPTY secret, which is the case where `"" === ""` would let anyone in.
 *
 * TOKEN is a fixture, not a credential.
 */
import { describe, it, expect, afterEach, vi } from "vitest";
import { NextRequest } from "next/server";
import { readFileSync } from "node:fs";
import path from "node:path";
import { requireAdmin } from "@/lib/admin-gate";

const ENV = "ADMIN_TOKEN";
const TOKEN = "fixture-admin-token-0123456789abcdef";
const saved = process.env[ENV];
afterEach(() => {
  if (saved === undefined) delete process.env[ENV]; else process.env[ENV] = saved;
  vi.restoreAllMocks();
});

const req = (opts: { auth?: string; qs?: string } = {}) =>
  new NextRequest(`http://localhost/api/x${opts.qs !== undefined ? `?token=${opts.qs}` : ""}`, {
    headers: opts.auth !== undefined ? { authorization: opts.auth } : {},
  });

/** Every way a caller can present (or not present) a credential. */
const PRESENTED: Array<[string, () => NextRequest]> = [
  ["no credential at all", () => req()],
  ["empty Authorization header", () => req({ auth: "" })],
  ["bare `Bearer`", () => req({ auth: "Bearer" })],
  ["`Bearer ` with nothing after it", () => req({ auth: "Bearer " })],
  ["a junk bearer", () => req({ auth: "Bearer junk" })],
  ["the literal string undefined", () => req({ auth: "Bearer undefined" })],
  ["the real-looking token as a bearer", () => req({ auth: `Bearer ${TOKEN}` })],
  ["an empty ?token=", () => req({ qs: "" })],
  ["a junk ?token=", () => req({ qs: "junk" })],
  ["the real-looking token as ?token=", () => req({ qs: TOKEN })],
  // A credential that IS the blank secret: if a blank ADMIN_TOKEN were compared instead of refused,
  // these would match it exactly.
  ["a whitespace-only ?token= (three spaces)", () => req({ qs: "%20%20%20" })],
  ["a whitespace-only ?token= (tab, newline)", () => req({ qs: "%09%0A" })],
];

const refused = (r: ReturnType<typeof requireAdmin>) => r !== null && r.status === 401;

describe("ADMIN_TOKEN unset, empty or blank => EVERY request is refused", () => {
  const UNSET: Array<[string, () => void]> = [
    ["unset", () => { delete process.env[ENV]; }],
    ["empty string", () => { process.env[ENV] = ""; }],
    ["spaces", () => { process.env[ENV] = "   "; }],
    ["a tab and newline", () => { process.env[ENV] = "\t\n"; }],
  ];

  for (const [envName, setEnv] of UNSET) {
    for (const [what, make] of PRESENTED) {
      it(`env ${envName} + ${what} -> 401, never null`, async () => {
        setEnv();
        const out = requireAdmin(make());
        expect(out, "null would mean the gate let the caller through").not.toBeNull();
        expect(refused(out)).toBe(true);
        expect(await out!.json()).toEqual({ error: "admin token required" });
      });
    }
  }
});

describe("ADMIN_TOKEN set", () => {
  it("the right bearer passes (null = allowed)", () => {
    process.env[ENV] = TOKEN;
    expect(requireAdmin(req({ auth: `Bearer ${TOKEN}` }))).toBeNull();
    expect(requireAdmin(req({ auth: `bearer ${TOKEN}` }))).toBeNull();
    expect(requireAdmin(req({ auth: `Bearer   ${TOKEN}  ` }))).toBeNull();
  });

  it("the right ?token= passes", () => {
    process.env[ENV] = TOKEN;
    expect(requireAdmin(req({ qs: TOKEN }))).toBeNull();
  });

  it("no credential, wrong, empty, truncated, extended and wrong-scheme credentials are all refused", () => {
    process.env[ENV] = TOKEN;
    for (const r of [
      req(), req({ auth: "" }), req({ auth: "Bearer" }), req({ auth: "Bearer " }),
      req({ auth: "Bearer nope" }), req({ auth: `Bearer ${TOKEN}x` }), req({ auth: `Bearer ${TOKEN.slice(0, -1)}` }),
      req({ auth: TOKEN }), req({ auth: `Basic ${TOKEN}` }), req({ qs: "" }), req({ qs: "nope" }), req({ qs: TOKEN + "x" }),
    ]) {
      expect(refused(requireAdmin(r)), `${r.headers.get("authorization")} ${r.nextUrl.search}`).toBe(true);
    }
  });

  it("a refusal has the shape it always had", async () => {
    process.env[ENV] = TOKEN;
    const out = requireAdmin(req({ auth: "Bearer nope" }))!;
    expect(out.status).toBe(401);
    expect(await out.json()).toEqual({ error: "admin token required" });
  });

  it("refusing an unset token and refusing a wrong one look identical, so the response does not say which is configured", async () => {
    process.env[ENV] = TOKEN;
    const wrong = requireAdmin(req({ auth: "Bearer nope" }))!;
    delete process.env[ENV];
    const unset = requireAdmin(req({ auth: "Bearer nope" }))!;
    expect(unset.status).toBe(wrong.status);
    expect(await unset.json()).toEqual(await wrong.json());
  });

  it("neither the secret nor the presented value reaches a body or a log line", async () => {
    const spies = (["log", "info", "warn", "error", "debug"] as const).map((k) => vi.spyOn(console, k).mockImplementation(() => {}));
    process.env[ENV] = TOKEN;
    const seen = JSON.stringify([
      await requireAdmin(req({ auth: "Bearer presented-wrong-value" }))!.json(),
      spies.map((s) => s.mock.calls),
    ]);
    expect(seen).not.toContain(TOKEN);
    expect(seen).not.toContain("presented-wrong-value");
  });
});

describe("the comparison is constant-time", () => {
  it("compares SHA-256 digests with timingSafeEqual, never the raw strings with ===/!==", () => {
    const src = readFileSync(path.join(process.cwd(), "lib", "admin-gate.ts"), "utf8");
    const code = src.split("\n").filter((l) => !/^\s*(\*|\/\*|\/\/)/.test(l)).join("\n");
    expect(code).toContain("timingSafeEqual(");
    expect(code).toMatch(/createHash\('sha256'\)|createHash\("sha256"\)/);
    const withoutEmptinessCheck = code.replace("expected === ''", "").replace('expected === ""', "");
    expect(withoutEmptinessCheck).not.toMatch(/(expected|presented)\s*[!=]==|[!=]==\s*(expected|presented)\b/);
  });
});

/**
 * OPERATOR_TOKEN — a second door on the bench admin routes, and POST /api/admin/bench/clip-urls.
 *
 * THE CASE THAT MATTERS is "bearer env UNSET + any bearer -> 401", including an empty one. It is
 * the failure where an unset secret silently opens a door (`lib/admin-gate.ts` does exactly that in
 * its dev mode, and `expected === ""` compared against an empty bearer would too). Every auth test
 * below runs against all three routes so one cannot drift from the others.
 *
 * Auth is real (lib/operator-auth.ts is not mocked). Mocked: the cookie reader and the JWT verify
 * (so "the cookie path still works" is asserted through the real guard), the db, R2 presigning, and
 * the windows writer (so a 401 can be proved to have written nothing). No token value is a real
 * credential; TOKEN below is a fixture.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { NextRequest } from "next/server";
import { readFileSync } from "node:fs";
import path from "node:path";

const H = vi.hoisted(() => ({
  cookie: null as string | null,
  verify: vi.fn(async (_c: string): Promise<{ admin_id: string }> => ({ admin_id: "adm_test" })),
  sql: vi.fn(async (_text: string, _values: unknown[]): Promise<unknown[]> => []),
  sign: vi.fn(async (o: { key: string; expiresInSeconds?: number }) => `https://r2.example/${o.key}?sig=x&exp=${o.expiresInSeconds}`),
  write: vi.fn(async (_sid: string) => ({ ok: true, wrote: 0 })),
}));

vi.mock("@/lib/cookie", () => ({ readAdminCookie: async () => H.cookie }));
vi.mock("@/lib/auth", () => ({ verifyAdminJwt: (c: string) => H.verify(c) }));
vi.mock("@/lib/db", () => ({ sql: (s: TemplateStringsArray, ...v: unknown[]) => H.sql(s.join("?"), v) }));
vi.mock("@/lib/r2", () => ({ signGetUrl: (o: { key: string; expiresInSeconds?: number }) => H.sign(o) }));
vi.mock("@/lib/bench-window", async (orig) => ({
  ...(await orig<typeof import("@/lib/bench-window")>()),
  evaluateAndWriteWindows: (sid: string) => H.write(sid),
}));

import { GET as windowsGET, POST as windowsPOST } from "@/app/api/admin/bench/windows/route";
import { POST as clipUrlsPOST } from "@/app/api/admin/bench/clip-urls/route";
import { benchAdminPrincipal, OPERATOR_BEARER_PRINCIPAL } from "@/lib/operator-auth";

const TOKEN = "fixture-operator-token-0123456789abcdef";
const ENV = "OPERATOR_TOKEN";
let saved: string | undefined;

const url = (p: string) => `http://localhost${p}`;
const post = (p: string, body: unknown, headers: Record<string, string> = {}) =>
  new NextRequest(url(p), { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) });
const get = (p: string, headers: Record<string, string> = {}) => new NextRequest(url(p), { method: "GET", headers });
const bearer = (t: string) => ({ authorization: `Bearer ${t}` });

/** The three guarded calls, each with a body that is valid past the guard, so a pass is 200 and a refusal is 401. */
const DOORS: Array<{ name: string; call: (h?: Record<string, string>) => Promise<Response> }> = [
  { name: "GET  /windows", call: (h) => windowsGET(get("/api/admin/bench/windows?session_id=bs_x", h)) },
  { name: "POST /windows", call: (h) => windowsPOST(post("/api/admin/bench/windows", { session_id: "bs_x" }, h)) },
  { name: "POST /clip-urls", call: (h) => clipUrlsPOST(post("/api/admin/bench/clip-urls", { window_ids: ["bw_1"] }, h)) },
];

beforeEach(() => {
  saved = process.env[ENV];
  H.cookie = null;
  H.verify.mockClear(); H.verify.mockImplementation(async () => ({ admin_id: "adm_test" }));
  H.sql.mockClear(); H.sql.mockImplementation(async () => []);
  H.sign.mockClear();
  H.write.mockClear();
});
afterEach(() => {
  if (saved === undefined) delete process.env[ENV]; else process.env[ENV] = saved;
  vi.restoreAllMocks();
});

describe.each(DOORS)("$name — the bearer door", ({ call }) => {
  it("token set + correct bearer -> 200", async () => {
    process.env[ENV] = TOKEN;
    expect((await call(bearer(TOKEN))).status).toBe(200);
  });

  it("token set + wrong bearer -> 401", async () => {
    process.env[ENV] = TOKEN;
    expect((await call(bearer("not-the-token"))).status).toBe(401);
    expect((await call(bearer(TOKEN + "x"))).status).toBe(401);
    expect((await call(bearer(TOKEN.slice(0, -1)))).status).toBe(401);
  });

  it("token set + no Authorization header -> 401 (not a dev-mode fall-through)", async () => {
    process.env[ENV] = TOKEN;
    expect((await call()).status).toBe(401);
  });

  it("token UNSET + any bearer -> 401, including an empty one", async () => {
    delete process.env[ENV];
    for (const h of [bearer(TOKEN), bearer("anything"), bearer(""), { authorization: "Bearer" }, { authorization: "" }, bearer("undefined"), bearer("null")]) {
      expect((await call(h)).status, JSON.stringify(h)).toBe(401);
    }
    expect((await call()).status, "no header at all").toBe(401);
  });

  it("token EMPTY or blank behaves as unset: an empty bearer is not equal to an empty secret", async () => {
    for (const blank of ["", " ", "   "]) {
      process.env[ENV] = blank;
      for (const h of [bearer(""), bearer(blank), bearer("x"), { authorization: "Bearer " }, {}]) {
        expect((await call(h)).status, `env=${JSON.stringify(blank)} h=${JSON.stringify(h)}`).toBe(401);
      }
    }
  });

  it("only the Bearer scheme opens it", async () => {
    process.env[ENV] = TOKEN;
    expect((await call({ authorization: TOKEN })).status).toBe(401);
    expect((await call({ authorization: `Basic ${TOKEN}` })).status).toBe(401);
    expect((await call({ authorization: `Token ${TOKEN}` })).status).toBe(401);
    expect((await call({ authorization: `bearer ${TOKEN}` })).status, "scheme is case-insensitive, as HTTP says").toBe(200);
  });

  it("the token is in no response body and no log line, whether the request passes or fails", async () => {
    process.env[ENV] = TOKEN;
    const spies = (["log", "info", "warn", "error", "debug"] as const).map((k) => vi.spyOn(console, k).mockImplementation(() => {}));
    const WRONG = "wrong-bearer-value-98765";
    const bodies = [
      await (await call(bearer(WRONG))).text(),
      await (await call()).text(),
      await (await call(bearer(TOKEN))).text(),
    ];
    const seen = JSON.stringify([bodies, spies.map((s) => s.mock.calls)]);
    expect(seen).not.toContain(TOKEN);
    expect(seen).not.toContain(WRONG);
    delete process.env[ENV];
    expect(JSON.stringify(await (await call(bearer(TOKEN))).text())).not.toContain(TOKEN);
  });
});

describe.each(DOORS)("$name — the cookie door is unchanged", ({ call }) => {
  it("a valid admin cookie -> 200 with the token set, and with it unset", async () => {
    H.cookie = "jwt.fixture";
    process.env[ENV] = TOKEN;
    expect((await call()).status).toBe(200);
    delete process.env[ENV];
    expect((await call()).status).toBe(200);
    expect(H.verify).toHaveBeenCalledWith("jwt.fixture");
  });

  it("an invalid cookie and no bearer -> 401", async () => {
    H.cookie = "jwt.bad";
    H.verify.mockRejectedValue(new Error("bad jwt"));
    process.env[ENV] = TOKEN;
    expect((await call()).status).toBe(401);
    delete process.env[ENV];
    expect((await call()).status).toBe(401);
  });

  it("an invalid cookie does not close the bearer door", async () => {
    H.cookie = "jwt.bad";
    H.verify.mockRejectedValue(new Error("bad jwt"));
    process.env[ENV] = TOKEN;
    expect((await call(bearer(TOKEN))).status).toBe(200);
  });

  it("a cookie with an unset token and a junk bearer still passes on the cookie alone", async () => {
    H.cookie = "jwt.fixture";
    delete process.env[ENV];
    expect((await call(bearer("junk"))).status).toBe(200);
  });
});

describe("the principal", () => {
  const req = () => new Request(url("/x"), { headers: bearer(TOKEN) });

  it("a signed-in admin is recorded as themselves, even when a good bearer is also sent", async () => {
    H.cookie = "jwt.fixture";
    process.env[ENV] = TOKEN;
    expect(await benchAdminPrincipal(req())).toBe("adm_test");
  });

  it("a bearer is recorded as the operator bearer; a refusal is null", async () => {
    process.env[ENV] = TOKEN;
    expect(await benchAdminPrincipal(req())).toBe(OPERATOR_BEARER_PRINCIPAL);
    delete process.env[ENV];
    expect(await benchAdminPrincipal(req())).toBeNull();
  });
});

describe("a refusal writes and reads nothing", () => {
  it("POST /windows: 401 never reaches the writer; the good bearer does, once, with the session id", async () => {
    process.env[ENV] = TOKEN;
    expect((await windowsPOST(post("/api/admin/bench/windows", { session_id: "bs_x" }, bearer("nope")))).status).toBe(401);
    expect(H.write).not.toHaveBeenCalled();
    expect((await windowsPOST(post("/api/admin/bench/windows", { session_id: "bs_x" }, bearer(TOKEN)))).status).toBe(200);
    expect(H.write).toHaveBeenCalledTimes(1);
    expect(H.write).toHaveBeenCalledWith("bs_x");
  });

  it("GET /windows and POST /clip-urls: 401 issues no query and signs nothing", async () => {
    delete process.env[ENV];
    await windowsGET(get("/api/admin/bench/windows?session_id=bs_x", bearer(TOKEN)));
    await clipUrlsPOST(post("/api/admin/bench/clip-urls", { window_ids: ["bw_1"] }, bearer(TOKEN)));
    expect(H.sql).not.toHaveBeenCalled();
    expect(H.sign).not.toHaveBeenCalled();
  });
});

describe("POST /api/admin/bench/clip-urls", () => {
  const ask = async (ids: unknown, extra: Record<string, unknown> = {}) => {
    process.env[ENV] = TOKEN;
    const res = await clipUrlsPOST(post("/api/admin/bench/clip-urls", { window_ids: ids, ...extra }, bearer(TOKEN)));
    return { status: res.status, json: (await res.json()) as Record<string, unknown> };
  };

  it("a mix of present, null and blank keys: urls only for the present, `missing` counts the rest", async () => {
    H.sql.mockResolvedValue([
      { id: "bw_1", clip_r2_key: "clips/one.webm" },
      { id: "bw_2", clip_r2_key: null },
      { id: "bw_3", clip_r2_key: "clips/three.webm" },
      { id: "bw_4", clip_r2_key: "" },
      { id: "bw_5", clip_r2_key: null },
    ]);
    const { status, json } = await ask(["bw_1", "bw_2", "bw_3", "bw_4", "bw_5"]);
    expect(status).toBe(200);
    expect(json.missing).toBe(3);
    const urls = json.urls as Record<string, string>;
    expect(Object.keys(urls).sort()).toEqual(["bw_1", "bw_3"]);
    for (const gone of ["bw_2", "bw_4", "bw_5"]) expect(gone in urls, `${gone} is omitted entirely`).toBe(false);
    expect(Object.values(urls).every((u) => typeof u === "string" && u.startsWith("https://"))).toBe(true);
    expect(JSON.stringify(json)).not.toContain("null");
  });

  it("the response carries `urls` and `missing` and nothing else", async () => {
    H.sql.mockResolvedValue([{ id: "bw_1", clip_r2_key: "clips/one.webm" }]);
    const { json } = await ask(["bw_1"]);
    expect(Object.keys(json).sort()).toEqual(["missing", "urls"]);
  });

  it("a window id that does not exist is omitted, not an error", async () => {
    H.sql.mockResolvedValue([{ id: "bw_1", clip_r2_key: "clips/one.webm" }]);
    const { status, json } = await ask(["bw_1", "bw_ghost"]);
    expect(status).toBe(200);
    expect(Object.keys(json.urls as object)).toEqual(["bw_1"]);
    expect(json.missing, "an unknown id is not a window found without a clip").toBe(0);
  });

  it("all ids unknown: 200, empty urls, missing 0", async () => {
    H.sql.mockResolvedValue([]);
    const { status, json } = await ask(["bw_a", "bw_b"]);
    expect(status).toBe(200);
    expect(json).toEqual({ urls: {}, missing: 0 });
    expect(H.sign).not.toHaveBeenCalled();
  });

  it("presigns with the row's key and a 3600 s expiry, once per present window", async () => {
    H.sql.mockResolvedValue([{ id: "bw_1", clip_r2_key: "clips/one.webm" }, { id: "bw_3", clip_r2_key: "clips/three.webm" }]);
    await ask(["bw_1", "bw_3"]);
    expect(H.sign).toHaveBeenCalledTimes(2);
    expect(H.sign).toHaveBeenCalledWith({ key: "clips/one.webm", expiresInSeconds: 3600 });
    expect(H.sign).toHaveBeenCalledWith({ key: "clips/three.webm", expiresInSeconds: 3600 });
  });

  it("the cap is 50: 50 passes, 51 is a 400 that reads and signs nothing", async () => {
    const ids = (n: number) => Array.from({ length: n }, (_, i) => `bw_${i}`);
    expect((await ask(ids(50))).status).toBe(200);
    H.sql.mockClear(); H.sign.mockClear();
    const over = await ask(ids(51));
    expect(over.status).toBe(400);
    expect(H.sql).not.toHaveBeenCalled();
    expect(H.sign).not.toHaveBeenCalled();
  });

  it("duplicate ids are queried once", async () => {
    H.sql.mockResolvedValue([{ id: "bw_1", clip_r2_key: "clips/one.webm" }]);
    await ask(["bw_1", "bw_1", "bw_1"]);
    expect(H.sql.mock.calls[0]![1]).toEqual([["bw_1"]]);
    expect(H.sign).toHaveBeenCalledTimes(1);
  });

  it("an empty list is a valid, empty answer and touches nothing", async () => {
    const { status, json } = await ask([]);
    expect(status).toBe(200);
    expect(json).toEqual({ urls: {}, missing: 0 });
    expect(H.sql).not.toHaveBeenCalled();
  });

  it("a malformed body is a 400: not JSON, no window_ids, not an array, non-string or blank or huge entries", async () => {
    process.env[ENV] = TOKEN;
    const raw = await clipUrlsPOST(new NextRequest(url("/api/admin/bench/clip-urls"), { method: "POST", headers: bearer(TOKEN), body: "{nope" }));
    expect(raw.status).toBe(400);
    for (const bad of [undefined, null, "bw_1", { 0: "bw_1" }, [1], [null], [""], ["  "], ["x".repeat(101)], ["bw_1", { id: "bw_2" }]]) {
      expect((await ask(bad)).status, JSON.stringify(bad)).toBe(400);
    }
    expect(H.sql).not.toHaveBeenCalled();
  });

  it("a presign failure is a 503 that leaks neither the provider's message nor a key, in the body or the log", async () => {
    H.sql.mockResolvedValue([{ id: "bw_1", clip_r2_key: "clips/secret-bucket-path.webm" }]);
    H.sign.mockRejectedValueOnce(new Error("AccessDenied for bucket secret-bucket at clips/secret-bucket-path.webm"));
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const { status, json } = await ask(["bw_1"]);
    expect(status).toBe(503);
    const seen = JSON.stringify([json, spy.mock.calls]);
    expect(seen).not.toContain("secret-bucket");
    expect(seen).not.toContain("clips/secret");
  });

  it("asks the table for ids only and reads only the two columns it needs", async () => {
    H.sql.mockResolvedValue([]);
    await ask(["bw_1"]);
    const text = String(H.sql.mock.calls[0]![0]);
    expect(text).toMatch(/SELECT\s+id,\s*clip_r2_key\s+FROM\s+bench_window\s+WHERE\s+id\s*=\s*ANY\(/i);
    expect(text).not.toMatch(/transcript|clinician|room|session_id|\*/i);
  });
});

describe("the comparison is constant-time, and the secret is never interpolated anywhere", () => {
  // Timing cannot be observed from a unit test; the code can be held to the shape that makes it safe.
  const src = readFileSync(path.join(process.cwd(), "lib", "operator-auth.ts"), "utf8");
  const code = src.split("\n").filter((l) => !/^\s*(\*|\/\*|\/\/)/.test(l)).join("\n");

  it("compares SHA-256 digests with timingSafeEqual, never the raw strings with ===/!==", () => {
    expect(code).toContain("timingSafeEqual(");
    expect(code).toMatch(/createHash\("sha256"\)/);
    // The one deliberate `expected === ""` is the "is the secret set" check, not a comparison of secrets.
    const withoutEmptinessCheck = code.replace('expected === ""', "");
    expect(withoutEmptinessCheck).not.toMatch(/(expected|token)\s*[!=]==|[!=]==\s*(expected|token)\b/i);
  });

  it("checks the secret exists before it reads the request", () => {
    const at = (needle: string) => code.indexOf(needle);
    expect(at('expected === ""')).toBeGreaterThan(-1);
    expect(at('expected === ""')).toBeLessThan(at('req.headers.get("authorization")'));
  });

  it("no route or lib line logs or echoes the operator token", () => {
    for (const f of ["lib/operator-auth.ts", "app/api/admin/bench/windows/route.ts", "app/api/admin/bench/clip-urls/route.ts"]) {
      const s = readFileSync(path.join(process.cwd(), f), "utf8");
      expect(s, f).not.toMatch(/console\.\w+\([^)]*(OPERATOR_TOKEN|expected|authorization)/i);
    }
  });
});

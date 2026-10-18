/**
 * OAUTH-O2 — the authorization server: authorize, email code (start, verify), consent, token, register, revoke. Drives the REAL route modules.
 * No live Resend (a fetch stub records the mail), no live CIMD fetch (fetch stub), an in-memory store, a fake audit table.
 * Synthetic addresses at example.test only; synthetic secrets only.
 */
import { describe, it, expect, beforeEach, afterEach, beforeAll, vi } from "vitest";
import { createHash } from "node:crypto";
import { NextRequest } from "next/server";

const audit: Array<{ text: string; values: unknown[] }> = [];
vi.mock("@/lib/db", () => ({ sql: vi.fn(async (strings: TemplateStringsArray, ...values: unknown[]) => { audit.push({ text: strings.join("?"), values }); return []; }) }));
vi.mock("@/lib/mcp/oauth/store", async () => await import("../support/mcp-oauth-fake-store"));
// the identity tables are exercised for real in mcp-identity-audit-pg.test.ts; here they are a switchboard
const IDM = vi.hoisted(() => ({ status: "active" as string | null, self: false, keyId: "k_alice" as string | null, live: true }));
vi.mock("@/lib/mcp/identity", () => ({ identityStatus: async () => IDM.status, selfApproved: async () => IDM.self, activeKeyIdOf: async () => IDM.keyId, sessionKeyOk: async () => IDM.live, keyLive: async () => IDM.live }));
// after(): captured when `deferMode.capture` (to prove the send is off the response path); otherwise it throws, as it does outside a request scope, and the route runs the work inline.
const deferred: Array<() => unknown> = [];
const deferMode = { capture: false };
vi.mock("next/server", async (orig) => ({ ...(await orig<typeof import("next/server")>()), after: (fn: () => unknown) => { if (!deferMode.capture) throw new Error("outside a request scope"); deferred.push(fn); } }));

import * as fake from "../support/mcp-oauth-fake-store";
import { GET as authorizeGet } from "@/app/api/oauth/authorize/route";
import { POST as startPost } from "@/app/api/oauth/email/start/route";
import { POST as verifyPost } from "@/app/api/oauth/email/verify/route";
import { POST as consentRoutePost } from "@/app/api/oauth/email/consent/route";
import { CONSENT_URL, consentOf as consentOfPage, consentPost, lastCode, mailed, resend, resendFetch, resetMail, start, verify } from "../support/mcp-oauth-email-flow";
import { resetEmailLimitForTests } from "@/lib/mcp/oauth/email-limit";
import { POST as tokenPost } from "@/app/api/oauth/token/route";
import { POST as registerPost } from "@/app/api/oauth/register/route";
import { resetRegisterLimitForTests } from "@/lib/mcp/oauth/register-limit";
import { POST as revokePost } from "@/app/api/oauth/revoke/route";
import { isForbiddenAddress, resolvePublic, setResolverForTests, setTransportForTests, type Resolved } from "@/lib/mcp/oauth/ssrf";
import { resolveClient, swallowedCountForTests } from "@/lib/mcp/oauth/clients";
import { resetDeniedAuditForTests } from "@/lib/mcp/audit";
import { resetOauthFlagWarningForTests, mcpOauthDomain, MCP_OAUTH_DOMAIN, CLAUDE_CALLBACK } from "@/lib/mcp/oauth/config";
import { redirectMatches, redirectsEquivalent, isAllowedRedirect } from "@/lib/mcp/oauth/redirects";
import { hashSecret, randomToken, s256, signBlob } from "@/lib/mcp/oauth/crypto";

const PEPPER = "p".repeat(32);
const RESEND_KEY = "re_" + "q".repeat(24);
const DOMAIN = "example.test";
const RESOURCE = "https://www.evenscribe.app/api/mcp";
const CIMD = "https://client.example.test/oauth/meta.json";
const LOOP = "http://localhost:3118/callback";
const ALICE = "alice@example.test";
const BOB = "bob@example.test";
const VERIFIER = "v".repeat(43) + "-._~";
const CHALLENGE = s256(VERIFIER);
const sha = (t: string) => createHash("sha256").update(t).digest("hex");


// ─── range-membership helpers ───────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
// The SSRF tests need addresses INSIDE a forbidden range. They are derived from the CIDR literal at run time, so these tests check RANGE MEMBERSHIP; no concrete private,
// CGNAT or link-local host address is written in any OAuth test.
const v4n = (ip: string): number => ip.split(".").reduce((a, o) => a * 256 + Number(o), 0);
const v4s = (n: number): string => [n >>> 24, (n >>> 16) & 255, (n >>> 8) & 255, n & 255].join(".");
/** The n-th address of a CIDR range: IPv4 base + n, or for an IPv6 CIDR whose base ends in "::" the base plus ::n. */
export function hostInRange(cidr: string, n: number): string {
  const [base, bits] = cidr.split("/") as [string, string];
  if (base.includes(":")) return `${base}${n.toString(16)}`;
  const size = 2 ** (32 - Number(bits));
  if (n < 0 || n >= size) throw new Error("outside range");
  return v4s(v4n(base) + n);
}
export const lastInRange = (cidr: string): string => { const [base, bits] = cidr.split("/") as [string, string]; return v4s(v4n(base) + 2 ** (32 - Number(bits)) - 1); };
/** The address just below the first, or just above the last, address of an IPv4 CIDR: public neighbours of a forbidden range. */
export const justOutside = (cidr: string, side: "below" | "above"): string => (side === "below" ? v4s(v4n(hostInRange(cidr, 0)) - 1) : v4s(v4n(lastInRange(cidr)) + 1));
const hexMapped = (v4: string, prefix: string): string => { const n = v4n(v4); return `${prefix}${(n >>> 16).toString(16)}:${(n & 0xffff).toString(16)}`; };
const R = { zero: "0.0.0.0/8", ten: "10.0.0.0/8", cgnat: "100.64.0.0/10", loop: "127.0.0.0/8", link: "169.254.0.0/16", b172: "172.16.0.0/12", b192: "192.168.0.0/16", multicast: "224.0.0.0/4", reserved: "240.0.0.0/4", ula: "fc00::/7", ulaFd: "fd00::/8", ll6: "fe80::/10", mc6: "ff00::/8" } as const;

let cimdDoc: unknown;
let cimdMode: "ok" | "hang" | "big" | "status";
let fetchLog: string[];
let resolverAnswer: Resolved;
let pinnedTo: string[];

function installFetch() {
  vi.stubGlobal("fetch", vi.fn(async (input: string | URL, init?: RequestInit) => {
    const url = String(input);
    fetchLog.push(url);
    if (url === CIMD) {
      if (cimdMode === "hang") return await new Promise<Response>((_, rej) => init?.signal?.addEventListener("abort", () => rej(new Error("aborted"))));
      if (cimdMode === "status") return new Response("nope", { status: 404 });
      if (cimdMode === "big") return new Response(JSON.stringify({ client_id: CIMD, redirect_uris: [CLAUDE_CALLBACK], pad: "x".repeat(70_000) }), { status: 200 });
      return new Response(JSON.stringify(cimdDoc), { status: 200, headers: { "content-type": "application/json" } });
    }
    const mail = resendFetch(input, init);
    if (mail) return mail;
    throw new Error("unexpected fetch");
  }));
}

const ENV = { ...process.env };
let logs: string[];
beforeEach(() => {
  process.env.SCRIBE_MCP_OAUTH = "on";
  process.env.MCP_OAUTH_TOKEN_PEPPER = PEPPER;
  process.env.RESEND_API_KEY = RESEND_KEY;
  process.env.RESEND_FROM_EMAIL = "noreply@example.test";
  process.env.SCRIBE_MCP_OAUTH_APPROVER = "approver@example.test";
  process.env.SCRIBE_MCP_OAUTH_DOMAIN_TEST = DOMAIN;
  delete process.env.SCRIBE_MCP_RESOURCE_URL;
  delete process.env.SCRIBE_MCP_OAUTH_ISSUER;
  fake.resetFakeStore();
  fake.addPerson(ALICE);
  Object.assign(IDM, { status: "active", self: false, keyId: "k_alice", live: true });
  audit.length = 0;
  resetDeniedAuditForTests();
  resetOauthFlagWarningForTests();
  resetRegisterLimitForTests();
  resetEmailLimitForTests();
  resetMail();
  deferred.length = 0;
  deferMode.capture = false;
  cimdDoc = { client_id: CIMD, client_name: "Synthetic Client", redirect_uris: [CLAUDE_CALLBACK, LOOP], token_endpoint_auth_method: "none" };
  cimdMode = "ok";
  fetchLog = [];
  logs = [];
  for (const m of ["log", "warn", "error", "info"] as const) vi.spyOn(console, m).mockImplementation((...a: unknown[]) => { logs.push(a.map(String).join(" ")); });
  installFetch();
  resolverAnswer = [{ address: "93.184.216.34", family: 4 }];
  pinnedTo = [];
  setResolverForTests(async () => resolverAnswer);
  // the pinned transport is replaced by the fetch stub; the pinned address it was handed is recorded
  setTransportForTests(async (url, pinned, signal) => { pinnedTo.push(pinned.address); return fetch(url.toString(), { signal }); });
});
afterEach(() => {
  process.env = { ...ENV };
  setResolverForTests(null);
  setTransportForTests(null);
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const form = (o: Record<string, string>) => new URLSearchParams(o).toString();
// ─── helpers ────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
const authUrl = (over: Record<string, string | null> = {}) => {
  const p: Record<string, string | null> = { response_type: "code", client_id: CIMD, redirect_uri: CLAUDE_CALLBACK, code_challenge: CHALLENGE, code_challenge_method: "S256", resource: RESOURCE, state: "st-1", ...over };
  const u = new URL("https://www.evenscribe.app/api/oauth/authorize");
  for (const [k, v] of Object.entries(p)) if (v !== null) u.searchParams.set(k, v);
  return u.toString();
};
const authorize = (over: Record<string, string | null> = {}) => authorizeGet(new NextRequest(authUrl(over)));
const loc = (r: Response) => new URL(r.headers.get("location") ?? "https://none.invalid/");

/** authorize: the "enter your email" page and the pending cookie. */
async function startSignIn(over: Record<string, string | null> = {}) {
  const res = await authorize(over);
  expect(res.status).toBe(200);
  const cookie = res.cookies.get("mcp_oauth_pending")?.value ?? "";
  return { res, cookie };
}
const consentOf = consentOfPage;
/** start + the mailed code + verify: the consent page (or whatever verify answered). */
async function consentPageFor(over: Record<string, string | null> = {}, email = ALICE) {
  const s = await startSignIn(over);
  expect((await start(s.cookie, email)).status).toBe(200);
  expect(mailed).not.toHaveLength(0);
  const page = await verify(s.cookie, lastCode());
  return { s, ...(await consentOf(page)) };
}
/** authorize, email, code, then (when verify renders the consent page) the person's decision. */
async function fullSignIn(over: Record<string, string | null> = {}, decision: "allow" | "deny" = "allow", email = ALICE) {
  const s = await startSignIn(over);
  const before = mailed.length;
  const st = await start(s.cookie, email);
  if (mailed.length === before) return { res: st, to: new URL("https://none.invalid/"), page: st };
  const page = await verify(s.cookie, lastCode());
  if (page.status !== 200) return { res: page, to: loc(page), page };
  const c = await consentOf(page);
  const res = await consentPost(c.cookie, { csrf: c.csrf, decision }, { origin: "https://www.evenscribe.app" });
  return { res, to: loc(res), page, consent: c };
}
const tokenReq = (o: Record<string, string>, ct = "application/x-www-form-urlencoded") =>
  new NextRequest("https://www.evenscribe.app/api/oauth/token", { method: "POST", headers: { "content-type": ct }, body: form(o) });
const codeBody = (code: string, over: Record<string, string> = {}) => ({ grant_type: "authorization_code", code, client_id: CIMD, redirect_uri: CLAUDE_CALLBACK, code_verifier: VERIFIER, resource: RESOURCE, ...over });
async function getCode(over: Record<string, string | null> = {}) {
  fake.state.emailCodes.clear(); // each call is a separate person-visit: keep the 3-per-15-min address limit and the per-IP limit out of the way
  resetEmailLimitForTests();
  const { to } = await fullSignIn(over);
  expect(to.searchParams.get("code")).toBeTruthy();
  return to.searchParams.get("code") as string;
}
async function tokens() {
  const res = await tokenPost(tokenReq(codeBody(await getCode())));
  expect(res.status).toBe(200);
  return (await res.json()) as { access_token: string; refresh_token: string; token_type: string; expires_in: number; scope: string };
}
const refreshBody = (rt: string, over: Record<string, string> = {}) => ({ grant_type: "refresh_token", refresh_token: rt, client_id: CIMD, ...over });
const lastCodeOf = (text: string): string => /sign-in code: (\d{6})\./.exec(text)?.[1] ?? "";
const refusalRows = () => audit.filter((a) => a.text.includes("mcp.oauth_refused"));

// ─── authorize ──────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
describe("authorize", () => {
  it("success: 200 with the enter-your-email page; a signed HttpOnly Secure SameSite=Lax cookie scoped to /api/oauth/email; nothing stored, no redirect", async () => {
    const { res, cookie } = await startSignIn();
    const html = await res.text();
    expect(res.headers.get("location")).toBeNull();
    expect(html).toContain("enter your even.in email");
    expect(html).toContain('method="post" action="/api/oauth/email/start"');
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(res.headers.get("referrer-policy")).toBe("strict-origin");
    const sc = res.headers.get("set-cookie") ?? "";
    expect(sc).toMatch(/HttpOnly/i); expect(sc).toMatch(/Secure/i); expect(sc).toMatch(/SameSite=lax/i); expect(sc).toMatch(/Path=\/api\/oauth\/email(;|$)/);
    expect(cookie).toContain(".");
    expect(fake.state.codes.size + fake.state.emailCodes.size).toBe(0);
    expect(mailed).toHaveLength(0);
  });

  it("pre-trust refusals are a plain HTML page, never a redirect: bad response_type, unknown client, unregistered redirect_uri", async () => {
    for (const over of <Array<Record<string, string | null>>>[{ response_type: "token" }, { client_id: "dcr_unknown" }, { redirect_uri: "https://evil.example.test/cb" }, { redirect_uri: null }, { client_id: "http://client.example.test/meta.json" }]) {
      const res = await authorize(over);
      expect(res.status).toBe(400);
      expect(res.headers.get("location")).toBeNull();
      expect(res.headers.get("content-type")).toContain("text/html");
    }
  });

  it("the page echoes nothing from the request", async () => {
    const res = await authorize({ client_id: "dcr_<script>alert(1)</script>", state: "<b>x</b>" });
    const html = await res.text();
    expect(html).not.toContain("<script>alert");
    expect(html).not.toContain("<b>x</b>");
  });

  it("post-trust refusals redirect with error, state and iss: plain PKCE, missing method, short challenge, resource mismatch, overlong state", async () => {
    const cases: Array<[Record<string, string | null>, string]> = [
      [{ code_challenge_method: "plain" }, "invalid_request"],
      [{ code_challenge_method: null }, "invalid_request"],
      [{ code_challenge: "short" }, "invalid_request"],
      [{ code_challenge: null }, "invalid_request"],
      [{ resource: "https://evil.example.test/api/mcp" }, "invalid_target"],
      [{ resource: null }, "invalid_target"],
    ];
    for (const [over, err] of cases) {
      const res = await authorize(over);
      expect(res.status).toBe(302);
      const to = loc(res);
      expect(to.origin + to.pathname).toBe(CLAUDE_CALLBACK);
      expect(to.searchParams.get("error")).toBe(err);
      expect(to.searchParams.get("state")).toBe("st-1");
      expect(to.searchParams.get("iss")).toBe("https://www.evenscribe.app");
      expect(res.cookies.get("mcp_oauth_pending")).toBeUndefined();
    }
    const long = await authorize({ state: "s".repeat(600) });
    expect(loc(long).searchParams.get("error")).toBe("invalid_request");
  });

  it("no open redirect: a redirect_uri that merely starts with, or contains, an allowed one is refused", async () => {
    for (const ru of [CLAUDE_CALLBACK + ".evil.example.test", CLAUDE_CALLBACK + "/x", CLAUDE_CALLBACK + "?a=b", "https://claude.ai.evil.example.test/api/mcp/auth_callback", "http://localhost:3118/callback/x", "http://localhost.evil.example.test/callback", "http://user" + "@" + "localhost:3118/callback", "http://localhost:3118/callback?x=1"]) {
      const res = await authorize({ redirect_uri: ru });
      expect(res.status).toBe(400);
      expect(res.headers.get("location")).toBeNull();
    }
  });

  it("loopback: the port is ignored (any port on the registered host), the path and host are not", async () => {
    for (const ru of ["http://localhost:3118/callback", "http://localhost:54321/callback", "http://localhost/callback"]) expect((await authorize({ redirect_uri: ru })).status).toBe(200);
    // localhost, 127.0.0.1 and [::1] are ONE loopback class (O2-FIX1): any presented loopback URI matches any registered loopback entry
    expect(redirectMatches(["http://localhost:3118/callback"], "http://127.0.0.1:9/callback")).toBe(true);
    expect(redirectMatches(["http://127.0.0.1:3118/callback"], "http://[::1]:9/callback")).toBe(true);
    expect(redirectMatches([CLAUDE_CALLBACK], "http://127.0.0.1:9/callback")).toBe(false); // no loopback entry registered
    expect(redirectsEquivalent("http://localhost:5000/callback", "http://127.0.0.1:5000/callback")).toBe(true);
    expect(redirectsEquivalent("http://localhost:5000/callback", "http://127.0.0.1:6000/callback")).toBe(true); // port ignored
    expect(redirectsEquivalent("http://localhost:5000/callback", "http://localhost:5000/other")).toBe(false);
    expect(redirectsEquivalent(CLAUDE_CALLBACK, "http://localhost:5000/callback")).toBe(false);
    expect(redirectsEquivalent("http://localhost:5000/callback", "https://localhost:5000/callback")).toBe(false);
    expect((await authorize({ redirect_uri: "http://localhost:3118/other" })).status).toBe(400);
    expect(redirectMatches(["http://127.0.0.1:1/callback"], "http://127.0.0.1:7777/callback")).toBe(true);
    expect(isAllowedRedirect("http://[::1]:5/callback")).toBe(true);
    expect(isAllowedRedirect("https://localhost:5/callback")).toBe(false);
  });

  it("CIMD fetch rules: client_id must equal the URL; auth method none only; an off-list redirect in the document refuses the whole document", async () => {
    cimdDoc = { client_id: "https://client.example.test/other.json", redirect_uris: [CLAUDE_CALLBACK] };
    expect((await authorize()).status).toBe(400);
    cimdDoc = { client_id: CIMD, redirect_uris: [CLAUDE_CALLBACK], token_endpoint_auth_method: "client_secret_basic" };
    expect((await authorize()).status).toBe(400);
    cimdDoc = { client_id: CIMD, redirect_uris: [CLAUDE_CALLBACK, "https://evil.example.test/cb"] };
    expect((await authorize()).status).toBe(400);
    cimdDoc = { client_id: CIMD, redirect_uris: [] };
    expect((await authorize()).status).toBe(400);
    cimdDoc = [1, 2];
    expect((await authorize()).status).toBe(400);
  });

  it("CIMD fetch rules: a 404, an over-64KB body and a hang past 5 s all refuse", async () => {
    cimdMode = "status";
    expect((await authorize()).status).toBe(400);
    cimdMode = "big";
    expect((await authorize()).status).toBe(400);
    cimdMode = "hang";
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const p = authorize();
    await vi.advanceTimersByTimeAsync(5100);
    const res = await p;
    vi.useRealTimers();
    expect(res.status).toBe(400);
  }, 15000);

  it("CIMD URL shape: IP literals, localhost, single-label hosts, a port and credentials are never fetched", async () => {
    for (const id of ["https://127.0.0.1/meta.json", "https://localhost/meta.json", "https://intranet/meta.json", "https://client.example.test:8443/meta.json", "https://user:pw" + "@" + "client.example.test/meta.json", "https://client.example.test/", "https://[::1]/meta.json"]) {
      fetchLog.length = 0;
      expect((await authorize({ client_id: id })).status).toBe(400);
      expect(fetchLog).toEqual([]);
    }
  });

  it("CIMD is cached for 24 h in the client table: the second authorize does not fetch again; a stale row refetches", async () => {
    await authorize();
    await authorize();
    expect(fetchLog.filter((u) => u === CIMD)).toHaveLength(1);
    fake.state.clients.get(CIMD)!.created_at = new Date(Date.now() - 25 * 3600 * 1000).toISOString();
    await authorize();
    expect(fetchLog.filter((u) => u === CIMD)).toHaveLength(2);
  });

  it("a DCR id we issued works; one we did not is refused", async () => {
    const reg = await registerPost(new NextRequest("https://www.evenscribe.app/api/oauth/register", { method: "POST", body: JSON.stringify({ redirect_uris: [CLAUDE_CALLBACK] }) }));
    const { client_id } = await reg.json();
    expect((await authorize({ client_id })).status).toBe(200);
    expect((await authorize({ client_id: "dcr_forged" })).status).toBe(400);
  });
});

// ─── callback ───────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
describe("email sign-in", () => {
  it("success (after Allow on the consent page) mints a one-time code and redirects with code, state and iss; the pending cookie is cleared; the code is stored hashed", async () => {
    const { res, to } = await fullSignIn();
    expect(res.status).toBe(303);
    expect(to.origin + to.pathname).toBe(CLAUDE_CALLBACK);
    expect(to.searchParams.get("state")).toBe("st-1");
    expect(to.searchParams.get("iss")).toBe("https://www.evenscribe.app");
    const code = to.searchParams.get("code")!;
    const row = fake.state.codes.get(hashSecret(code))!;
    expect(row.email).toBe(ALICE);
    expect(row.scopes).toEqual(["read", "invoke", "write", "admin"]);
    expect(row.code_challenge).toBe(CHALLENGE);
    expect(fake.state.codes.has(code)).toBe(false);
    expect(res.headers.get("set-cookie")).toMatch(/Max-Age=0/i);
    expect(refusalRows()).toHaveLength(0);
  });

  it("the mail goes to the APPROVER only (never the requester), naming the requester,  from RESEND_FROM_EMAIL; the code is 6 digits and is stored only as sha256(pepper || pending_id || code)", async () => {
    const s = await startSignIn();
    await start(s.cookie, ALICE);
    expect(mailed).toHaveLength(1);
    expect(mailed[0]).toMatchObject({ to: "approver@example.test", from: "noreply@example.test", subject: "EvenScribe MCP sign-in code (approval needed)" });
    expect(mailed.some((m) => m.to === ALICE)).toBe(false);
    const code = lastCode();
    expect(code).toMatch(/^\d{6}$/);
    expect(mailed[0].text).toBe(`${ALICE} is signing in to the EvenScribe MCP connector. The sign-in code: ${code}. It expires in 10 minutes and works once. Pass it on only if you expect this request; otherwise ignore it.`);
    const [row] = [...fake.state.emailCodes.values()];
    const pid = JSON.parse(Buffer.from(s.cookie.split(".")[0], "base64url").toString()).pid as string;
    expect(row.code_hash).toBe(hashSecret(pid + code));
    expect(row.code_hash).not.toContain(code);
    expect(row.attempts).toBe(0);
    expect(row.exp - row.created).toBe(600_000);
  });

  it("the address is trimmed and lowercased before the allowlist lookup", async () => {
    const s = await startSignIn();
    await start(s.cookie, `  ${ALICE[0].toUpperCase() + ALICE.slice(1).toUpperCase()}  `);
    expect(mailed).toHaveLength(1);
    expect(mailed[0].to).toBe("approver@example.test");
    expect(mailed[0].text.startsWith(`${ALICE} `)).toBe(true); // the requester, normalised, is named in the approver's mail
  });

  it("non-allowlisted, non-even.in, revoked and malformed addresses get byte-identical pages and status to a qualifying one, and send no mail", async () => {
    fake.addPerson(BOB, ["read"], "revoked");
    const pages: Array<[string, number, string]> = [];
    for (const email of [ALICE, "carol@example.test", "alice@example.test.invalid", BOB, "not-an-email", "", "a@b@example.test", `${"x".repeat(300)}@example.test`]) {
      const s = await startSignIn();
      const before = mailed.length;
      const r = await start(s.cookie, email);
      pages.push([email.slice(0, 12), r.status, await r.text()]);
      if (email !== ALICE) expect(mailed.length, email).toBe(before);
    }
    expect(mailed).toHaveLength(1);
    for (const [e, st, html] of pages) { expect(st, e).toBe(pages[0][1]); expect(html, e).toBe(pages[0][2]); }
    expect(pages[0][2]).toContain("If that address is allowed, a code is on its way");
    expect(fake.state.emailCodes.size).toBe(1);
  });

  it("refusals write one mcp.oauth_refused row each: wrong_domain (unknown actor), not_allowlisted and revoked (the address)", async () => {
    fake.addPerson(BOB, ["read"], "revoked");
    for (const email of ["alice@example.test.invalid", "carol@example.test", BOB]) await start((await startSignIn()).cookie, email);
    const rows = refusalRows().map((r) => JSON.stringify(r.values));
    expect(rows).toHaveLength(3);
    expect(rows[0]).toContain("wrong_domain"); expect(rows[0]).toContain("unknown");
    expect(rows[1]).toContain("not_allowlisted"); expect(rows[1]).toContain("person:carol@example.test");
    expect(rows[2]).toContain("revoked"); expect(rows[2]).toContain(`person:${BOB}`);
  });

  it("TIMING: the Resend call is deferred with after(): start returns before the send runs, and the send still happens", async () => {
    deferMode.capture = true;
    resend.mode = "hang"; // a Resend that never answers cannot hold the response
    const s = await startSignIn();
    const r = await start(s.cookie, ALICE);
    expect(r.status).toBe(200);
    expect(deferred).toHaveLength(1);
    expect(mailed).toHaveLength(0);
    resend.mode = "ok";
    await deferred[0]();
    expect(mailed).toHaveLength(1);
    // a non-qualifying address defers nothing
    deferred.length = 0;
    await start((await startSignIn()).cookie, "carol@example.test");
    expect(deferred).toHaveLength(0);
  });

  it("correct code -> consent page (not a redirect, no auth code yet) -> Allow -> the token works", async () => {
    const c = await consentPageFor();
    expect(c.page.status).toBe(200);
    expect(c.html).toContain("Allow access to EvenScribe?");
    expect(fake.state.codes.size).toBe(0);
    const res = await consentPost(c.cookie, { csrf: c.csrf, decision: "allow" }, { origin: "https://www.evenscribe.app" });
    const code = loc(res).searchParams.get("code")!;
    const t = await tokenPost(tokenReq(codeBody(code)));
    expect(t.status).toBe(200);
    expect(((await t.json()) as { access_token: string }).access_token.startsWith("esp_")).toBe(true);
  });

  it("a wrong code is refused with the same form again, no consent page and no cookie change", async () => {
    const s = await startSignIn();
    await start(s.cookie, ALICE);
    const wrong = lastCode() === "000000" ? "000001" : "000000";
    const r = await verify(s.cookie, wrong);
    expect(r.status).toBe(400);
    expect(await r.text()).toContain("That code was not right");
    expect(r.headers.get("set-cookie")).toBeNull();
    expect(JSON.stringify(refusalRows().map((x) => x.values))).toContain("code_wrong");
    expect((await verify(s.cookie, lastCode())).status).toBe(200); // the real code still works
  });

  it("5 wrong attempts kill the pending flow: the 6th, even with the RIGHT code, is refused, and so is a freshly mailed code", async () => {
    const s = await startSignIn();
    await start(s.cookie, ALICE);
    const right = lastCode();
    const wrong = right === "000000" ? "000001" : "000000";
    for (let i = 0; i < 5; i++) expect((await verify(s.cookie, wrong)).status).toBe(400);
    const dead = await verify(s.cookie, right);
    expect(dead.status).toBe(400);
    expect(dead.headers.get("location")).toBeNull();
    expect(await dead.text()).toContain("code_unavailable");
    expect(dead.headers.get("set-cookie")).toMatch(/Max-Age=0/i);
    expect(fake.state.codes.size).toBe(0);
    // asking for a new code does not reset the budget
    await start(s.cookie, ALICE);
    expect(mailed).toHaveLength(1);
    expect((await verify(s.cookie, right)).status).toBe(400);
  });

  it("wrong tries on code 1 are not forgiven by mailing code 2 within the same pending flow", async () => {
    const s = await startSignIn();
    await start(s.cookie, ALICE);
    const wrong = lastCode() === "000000" ? "000001" : "000000";
    for (let i = 0; i < 3; i++) await verify(s.cookie, wrong);
    await start(s.cookie, ALICE);
    expect(mailed).toHaveLength(2);
    const code2 = lastCode();
    const wrong2 = code2 === "000000" ? "000001" : "000000";
    expect((await verify(s.cookie, wrong2)).status).toBe(400); // 4th
    expect((await verify(s.cookie, wrong2)).status).toBe(400); // 5th
    expect((await verify(s.cookie, code2)).status).toBe(400);  // dead
  });

  it("an expired code is refused (10 min)", async () => {
    const s = await startSignIn();
    await start(s.cookie, ALICE);
    fake.emailClock.offsetMs = 10 * 60 * 1000 + 1000;
    const r = await verify(s.cookie, lastCode());
    expect(r.status).toBe(400);
    expect(fake.state.codes.size).toBe(0);
    expect(JSON.stringify(refusalRows().map((x) => x.values))).toContain("code_unavailable");
  });

  it("a code is single use: after a successful verify the same code (with the old pending cookie) is refused", async () => {
    const s = await startSignIn();
    await start(s.cookie, ALICE);
    const code = lastCode();
    expect((await verify(s.cookie, code)).status).toBe(200);
    expect((await verify(s.cookie, code)).status).toBe(400);
  });

  it("a code from another pending session is rejected: it fails on a second flow even for the same address, and that second flow cannot read the first's row", async () => {
    const a = await startSignIn();
    await start(a.cookie, ALICE);
    const codeA = lastCode();
    const b = await startSignIn();
    // B never asked for a code: nothing to try
    expect((await verify(b.cookie, codeA)).status).toBe(400);
    await start(b.cookie, ALICE);
    const codeB = lastCode();
    if (codeA !== codeB) expect((await verify(b.cookie, codeA)).status).toBe(400); // (equal digits are a legitimate 1-in-a-million match for B)
    expect((await verify(b.cookie, codeB)).status).toBe(200);
    expect((await verify(a.cookie, codeA)).status).toBe(200);
  });

  it("verify without a pending cookie, with a tampered one, with a consent-purpose one, a foreign Origin, a malformed code or a JSON body never redirects and spends no attempt", async () => {
    const s = await startSignIn();
    await start(s.cookie, ALICE);
    const tampered = s.cookie.slice(0, -2) + (s.cookie.endsWith("AA") ? "BB" : "AA");
    const code = lastCode();
    for (const [name, r] of [
      ["none", await verify("", code)], ["tampered", await verify(tampered, code)],
      ["origin", await verify(s.cookie, code, { origin: "https://evil.example.test" })], ["origin null", await verify(s.cookie, code, { origin: "null" })],
      ["short", await verify(s.cookie, "12345")], ["letters", await verify(s.cookie, "abcdef")],
      ["json", await verifyPost(new NextRequest("https://www.evenscribe.app/api/oauth/email/verify", { method: "POST", headers: { "content-type": "application/json", cookie: `mcp_oauth_pending=${s.cookie}` }, body: JSON.stringify({ code }) }))],
    ] as Array<[string, Response]>) {
      expect(r.status, name).toBe(400);
      expect(r.headers.get("location"), name).toBeNull();
    }
    expect([...fake.state.emailCodes.values()][0].attempts).toBe(0);
    expect((await verify(s.cookie, code)).status).toBe(200);
  });

  it("start without a valid pending cookie, with a foreign Origin or a JSON body is a plain 400 and mails nothing", async () => {
    const s = await startSignIn();
    for (const r of [
      await start("", ALICE), await start(s.cookie.slice(0, -3) + "xyz", ALICE), await start(s.cookie, ALICE, { origin: "https://evil.example.test" }),
      await startPost(new NextRequest("https://www.evenscribe.app/api/oauth/email/start", { method: "POST", headers: { "content-type": "application/json", cookie: `mcp_oauth_pending=${s.cookie}` }, body: JSON.stringify({ email: ALICE }) })),
    ]) { expect(r.status).toBe(400); expect(r.headers.get("location")).toBeNull(); }
    expect(mailed).toHaveLength(0);
  });

  it("rate limit per address: 3 codes in 15 min, the 4th gets the same page and no mail; after 15 min it works again", async () => {
    const pages: string[] = [];
    for (let i = 0; i < 4; i++) pages.push(await (await start((await startSignIn()).cookie, ALICE)).text());
    expect(mailed).toHaveLength(3);
    expect(new Set(pages).size).toBe(1);
    expect(JSON.stringify(refusalRows().map((x) => x.values))).toContain("rate_limited");
    fake.emailClock.offsetMs = 15 * 60 * 1000 + 1000;
    await start((await startSignIn()).cookie, ALICE);
    expect(mailed).toHaveLength(4);
  });

  it("rate limit per IP: 10 starts in 15 min whatever the address, the 11th gets the same page and no mail; another IP is unaffected", async () => {
    for (let i = 0; i < 10; i++) { fake.addPerson(`p${i}@example.test`); await start((await startSignIn()).cookie, `p${i}@example.test`, { "x-forwarded-for": "203.0.113.5" }); }
    expect(mailed).toHaveLength(10);
    fake.addPerson("p10@example.test");
    const r = await start((await startSignIn()).cookie, "p10@example.test", { "x-forwarded-for": "203.0.113.5" });
    expect(r.status).toBe(200);
    expect(mailed).toHaveLength(10);
    await start((await startSignIn()).cookie, "p10@example.test", { "x-forwarded-for": "203.0.113.6" });
    expect(mailed).toHaveLength(11);
  });

  it("Resend down: the page is the same, the code row is not kept, one resend_failed audit row, and nothing can be verified", async () => {
    resend.mode = "down";
    const s = await startSignIn();
    const r = await start(s.cookie, ALICE);
    const good = await (await start((await startSignIn()).cookie, "carol@example.test")).text();
    expect(r.status).toBe(200);
    expect(await r.text()).toBe(good);
    expect(fake.state.emailCodes.size).toBe(0);
    expect(JSON.stringify(refusalRows().map((x) => x.values))).toContain("resend_failed");
    expect((await verify(s.cookie, "123456")).status).toBe(400);
    expect(logs.join("\n")).not.toContain(ALICE);
  });

  it("the attacker-link case: the consent page names the client and the redirect host, and Allow mints a code ONLY for that client and that redirect", async () => {
    const reg = await registerPost(new NextRequest("https://www.evenscribe.app/api/oauth/register", { method: "POST", headers: { "content-type": "application/json", "x-forwarded-for": "203.0.113.20" }, body: JSON.stringify({ redirect_uris: [LOOP], client_name: "Totally Legit Tool" }) }));
    const { client_id } = (await reg.json()) as { client_id: string };
    const c = await consentPageFor({ client_id, redirect_uri: LOOP });
    expect(c.html).toContain("Totally Legit Tool (self-registered)");
    expect(c.html).toContain('<dd data-consent="redirect-host">localhost:3118</dd>');
    expect(fake.state.codes.size).toBe(0); // email + code alone mint nothing
    const res = await consentPost(c.cookie, { csrf: c.csrf, decision: "allow", client_id: CIMD, redirect_uri: CLAUDE_CALLBACK }, { origin: "https://www.evenscribe.app" });
    const to = loc(res);
    expect(to.origin + to.pathname).toBe(LOOP);
    const row = fake.state.codes.get(hashSecret(to.searchParams.get("code")!))!;
    expect([row.client_id, row.redirect_uri]).toEqual([client_id, LOOP]);
  });

  it("no cookie, a tampered cookie and an expired cookie never redirect: plain HTML 400", async () => {
    const s = await startSignIn();
    const tampered = s.cookie.slice(0, -2) + (s.cookie.endsWith("AA") ? "BB" : "AA");
    const forgedBody = Buffer.from(JSON.stringify({ cid: CIMD, ru: "https://evil.example.test/cb", cc: CHALLENGE, st: null, res: RESOURCE, pid: "x", exp: 9999999999 })).toString("base64url");
    for (const c of ["", tampered, `${forgedBody}.${s.cookie.split(".")[1]}`]) {
      const res = await start(c, ALICE);
      expect(res.status).toBe(400);
      expect(res.headers.get("location")).toBeNull();
    }
    vi.useFakeTimers({ now: Date.now() + 11 * 60 * 1000, toFake: ["Date"] });
    const res = await start(s.cookie, ALICE);
    vi.useRealTimers();
    expect(res.status).toBe(400);
    expect(mailed).toHaveLength(0);
  });
});

describe("token: authorization_code", () => {
  it("issues esp_ and esr_ tokens, 1 h, Bearer, scope string, no-store; only hashes are stored", async () => {
    const t = await tokens();
    expect(t.access_token).toMatch(/^esp_[A-Za-z0-9_-]{43}$/);
    expect(t.refresh_token).toMatch(/^esr_[A-Za-z0-9_-]{43}$/);
    expect(t.token_type).toBe("Bearer");
    expect(t.expires_in).toBe(3600);
    expect(t.scope).toBe("read invoke write admin");
    expect(fake.state.tokens.has(t.access_token)).toBe(false);
    const a = fake.state.tokens.get(hashSecret(t.access_token))!;
    const r = fake.state.tokens.get(hashSecret(t.refresh_token))!;
    expect([a.kind, r.kind]).toEqual(["access", "refresh"]);
    expect(a.family_id).toBe(r.family_id);
    expect(a.email).toBe(ALICE);
    expect(a.resource).toBe(RESOURCE);
  });

  it("the response is no-store", async () => {
    const res = await tokenPost(tokenReq(codeBody(await getCode())));
    expect(res.headers.get("cache-control")).toBe("no-store");
  });

  it("only form-urlencoded: JSON is refused", async () => {
    const res = await tokenPost(tokenReq(codeBody(await getCode()), "application/json"));
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("invalid_request");
  });

  it("PKCE failure refuses and burns the code", async () => {
    const code = await getCode();
    const bad = await tokenPost(tokenReq(codeBody(code, { code_verifier: "w".repeat(50) })));
    expect(bad.status).toBe(400);
    expect((await bad.json()).error).toBe("invalid_grant");
    const retry = await tokenPost(tokenReq(codeBody(code)));
    expect(retry.status).toBe(400);
  });

  it("a verifier that is too short or has illegal characters is refused", async () => {
    for (const v of ["short", "x".repeat(200), "has spaces and is long enough to pass the length rule xx"]) {
      const code = await getCode();
      expect((await tokenPost(tokenReq(codeBody(code, { code_verifier: v })))).status).toBe(400);
    }
  });

  it("client_id, redirect_uri and resource mismatches are refused", async () => {
    expect((await tokenPost(tokenReq(codeBody(await getCode(), { client_id: "https://other.example.test/meta.json" })))).status).toBe(400);
    expect((await tokenPost(tokenReq(codeBody(await getCode(), { redirect_uri: LOOP })))).status).toBe(400);
    const r = await tokenPost(tokenReq(codeBody(await getCode(), { resource: "https://evil.example.test/api/mcp" })));
    expect(r.status).toBe(400);
    expect((await r.json()).error).toBe("invalid_target");
    const { resource: _omit, ...noRes } = codeBody(await getCode());
    expect((await tokenPost(tokenReq(noRes))).status).toBe(400);
  });

  it("code reuse is refused AND revokes everything the first use issued", async () => {
    const code = await getCode();
    const first = await tokenPost(tokenReq(codeBody(code)));
    const t = await first.json();
    const second = await tokenPost(tokenReq(codeBody(code)));
    expect(second.status).toBe(400);
    expect((await second.json()).error).toBe("invalid_grant");
    for (const tok of [t.access_token, t.refresh_token]) expect(fake.state.tokens.get(hashSecret(tok))!.revoked_at).not.toBeNull();
    const rr = await tokenPost(tokenReq(refreshBody(t.refresh_token)));
    expect(rr.status).toBe(400);
  });

  it("an expired code, an unknown code and a missing field are refused", async () => {
    const code = await getCode();
    fake.state.codes.get(hashSecret(code))!.exp = Date.now() - 1;
    expect((await tokenPost(tokenReq(codeBody(code)))).status).toBe(400);
    expect((await tokenPost(tokenReq(codeBody("never-issued")))).status).toBe(400);
    const { code_verifier: _v, ...noVerifier } = codeBody(await getCode());
    expect((await tokenPost(tokenReq(noVerifier))).status).toBe(400);
  });

  it("a person revoked between sign-in and exchange gets nothing", async () => {
    const code = await getCode();
    fake.addPerson(ALICE, ["read"], "revoked");
    expect((await tokenPost(tokenReq(codeBody(code)))).status).toBe(400);
    expect(fake.state.tokens.size).toBe(0);
  });

  it("LOW-7: a code minted BEFORE the person was revoked and re-granted is refused (re-grant inside the code minute); a scope change on an unchanged status is not a re-grant", async () => {
    const code = await getCode();
    fake.addPerson(ALICE, ["read"], "revoked");
    fake.addPerson(ALICE, ["read", "invoke", "write", "admin"], "active"); // re-grant: granted_at moves past the code's creation
    const r = await tokenPost(tokenReq(codeBody(code)));
    expect(r.status).toBe(400);
    expect((await r.json()).error).toBe("invalid_grant");
    expect(fake.state.tokens.size).toBe(0);
    const code2 = await getCode(); // a code minted AFTER the re-grant works
    expect((await tokenPost(tokenReq(codeBody(code2)))).status).toBe(200);
    const code3 = await getCode();
    fake.addPerson(ALICE, ["read"], "active"); // scopes changed, status unchanged: granted_at stays
    const ok = await tokenPost(tokenReq(codeBody(code3)));
    expect(ok.status).toBe(200);
    expect((await ok.json()).scope).toBe("read");
  });

  it("an unsupported grant_type is refused", async () => {
    const r = await tokenPost(tokenReq({ grant_type: "password", username: "u", password: "p" }));
    expect((await r.json()).error).toBe("unsupported_grant_type");
  });
});

describe("token: refresh_token", () => {
  it("rotates on every use: a new pair in the same family, the old refresh marked rotated", async () => {
    const t = await tokens();
    const res = await tokenPost(tokenReq(refreshBody(t.refresh_token)));
    expect(res.status).toBe(200);
    const n = await res.json();
    expect(n.refresh_token).not.toBe(t.refresh_token);
    expect(n.access_token).not.toBe(t.access_token);
    const old = fake.state.tokens.get(hashSecret(t.refresh_token))!;
    expect(old.rotated_to).toBe(hashSecret(n.refresh_token));
    expect(fake.state.tokens.get(hashSecret(n.refresh_token))!.family_id).toBe(old.family_id);
    const again = await tokenPost(tokenReq(refreshBody(n.refresh_token)));
    expect(again.status).toBe(200);
  });

  it("reuse of a rotated refresh token revokes the WHOLE family, including the newest tokens", async () => {
    const t = await tokens();
    const n = await (await tokenPost(tokenReq(refreshBody(t.refresh_token)))).json();
    const reuse = await tokenPost(tokenReq(refreshBody(t.refresh_token)));
    expect(reuse.status).toBe(400);
    expect((await reuse.json()).error).toBe("invalid_grant");
    for (const tok of [t.access_token, n.access_token, n.refresh_token]) expect(fake.state.tokens.get(hashSecret(tok))!.revoked_at).not.toBeNull();
    expect((await tokenPost(tokenReq(refreshBody(n.refresh_token)))).status).toBe(400);
  });

  it("the client_id must match", async () => {
    const t = await tokens();
    const r = await tokenPost(tokenReq(refreshBody(t.refresh_token, { client_id: "https://other.example.test/meta.json" })));
    expect(r.status).toBe(400);
    expect((await tokenPost(tokenReq(refreshBody(t.refresh_token)))).status).toBe(200); // the right client still works
  });

  it("a revoked person's refresh is refused and the family is revoked", async () => {
    const t = await tokens();
    fake.addPerson(ALICE, ["read"], "revoked");
    const r = await tokenPost(tokenReq(refreshBody(t.refresh_token)));
    expect(r.status).toBe(400);
    expect((await r.json()).error).toBe("invalid_grant");
    for (const tok of [t.access_token, t.refresh_token]) expect(fake.state.tokens.get(hashSecret(tok))!.revoked_at).not.toBeNull();
  });

  it("an expired refresh, an access token presented as refresh, an unknown token and a wrong resource are refused", async () => {
    const t = await tokens();
    expect((await tokenPost(tokenReq(refreshBody(t.access_token)))).status).toBe(400);
    expect((await tokenPost(tokenReq(refreshBody("esr_never")))).status).toBe(400);
    expect((await tokenPost(tokenReq(refreshBody(t.refresh_token, { resource: "https://evil.example.test/api/mcp" })))).status).toBe(400);
    fake.state.tokens.get(hashSecret(t.refresh_token))!.exp = Date.now() - 1;
    expect((await tokenPost(tokenReq(refreshBody(t.refresh_token)))).status).toBe(400);
  });

  it("scopes follow the person's CURRENT row at refresh time", async () => {
    const t = await tokens();
    fake.addPerson(ALICE, ["read"]);
    const n = await (await tokenPost(tokenReq(refreshBody(t.refresh_token)))).json();
    expect(n.scope).toBe("read");
  });
});

// ─── register / revoke ──────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
const reg = (body: unknown, ip = "203.0.113.7") =>
  new NextRequest("https://www.evenscribe.app/api/oauth/register", { method: "POST", headers: { "x-forwarded-for": `${ip}, 192.0.2.1` }, body: typeof body === "string" ? body : JSON.stringify(body) });

describe("register (DCR)", () => {
  it("issues a random dcr_ client id for the Claude callback and for a loopback callback", async () => {
    const r = await registerPost(reg({ redirect_uris: [CLAUDE_CALLBACK, LOOP], client_name: "Synthetic <b>Name</b>", token_endpoint_auth_method: "none" }));
    expect(r.status).toBe(201);
    const j = await r.json();
    expect(j.client_id).toMatch(/^dcr_[A-Za-z0-9_-]{32}$/);
    expect(j.token_endpoint_auth_method).toBe("none");
    expect(j.client_name).toBe("Synthetic bNameb");
    expect(fake.state.clients.get(j.client_id)!.kind).toBe("dcr");
    const r2 = await registerPost(reg({ redirect_uris: [CLAUDE_CALLBACK] }));
    expect((await r2.json()).client_id).not.toBe(j.client_id);
  });

  it("refuses other redirect URIs, secrets-based auth, bad grants, non-JSON and oversize bodies", async () => {
    for (const b of [
      { redirect_uris: ["https://evil.example.test/cb"] }, { redirect_uris: [] }, {}, { redirect_uris: [CLAUDE_CALLBACK, "http://example.test/callback"] },
      { redirect_uris: [CLAUDE_CALLBACK], token_endpoint_auth_method: "client_secret_post" }, { redirect_uris: [CLAUDE_CALLBACK], grant_types: ["password"] },
      "not json", "[1]", JSON.stringify({ redirect_uris: [CLAUDE_CALLBACK], pad: "x".repeat(9000) }),
    ]) expect((await registerPost(reg(b))).status).toBe(400);
  });

  it("rate-limits per IP: the 11th in a minute is 429; another IP is unaffected", async () => {
    for (let i = 0; i < 10; i++) expect((await registerPost(reg({ redirect_uris: [CLAUDE_CALLBACK] }))).status).toBe(201);
    const r = await registerPost(reg({ redirect_uris: [CLAUDE_CALLBACK] }));
    expect(r.status).toBe(429);
    expect(r.headers.get("retry-after")).toBe("60");
    expect((await registerPost(reg({ redirect_uris: [CLAUDE_CALLBACK] }, "198.51.100.9"))).status).toBe(201);
  });
});

describe("revoke", () => {
  const rv = (body: string) => new NextRequest("https://www.evenscribe.app/api/oauth/revoke", { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body });

  it("revokes the whole family from an access token or a refresh token, and answers 200 either way", async () => {
    const a = await tokens();
    const r = await revokePost(rv(form({ token: a.access_token })));
    expect(r.status).toBe(200);
    for (const tok of [a.access_token, a.refresh_token]) expect(fake.state.tokens.get(hashSecret(tok))!.revoked_at).not.toBeNull();
    expect((await tokenPost(tokenReq(refreshBody(a.refresh_token)))).status).toBe(400);
    const b = await tokens();
    expect((await revokePost(rv(form({ token: b.refresh_token, token_type_hint: "refresh_token" })))).status).toBe(200);
    expect(fake.state.tokens.get(hashSecret(b.access_token))!.revoked_at).not.toBeNull();
  });

  it("an unknown token, no token and garbage are all 200 with an empty body (no oracle)", async () => {
    for (const body of [form({ token: "esr_unknown" }), "", "%%%"]) {
      const r = await revokePost(rv(body));
      expect(r.status).toBe(200);
      expect(await r.text()).toBe("");
    }
  });
});

// ─── gates ──────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
describe("flag off, missing pepper, missing Resend env", () => {
  const all = async () => [
    await authorize(),
    await start("x", ALICE),
    await verify("x", "123456"),
    await consentPost("x", {}),
    await tokenPost(tokenReq(codeBody("c"))),
    await registerPost(reg({ redirect_uris: [CLAUDE_CALLBACK] })),
    await revokePost(new NextRequest("https://www.evenscribe.app/api/oauth/revoke", { method: "POST", body: "token=x" })),
  ];

  it("flag off (and an unknown value): every route 404s with an empty body and touches nothing", async () => {
    for (const v of [undefined, "off", "maybe"]) {
      if (v === undefined) delete process.env.SCRIBE_MCP_OAUTH; else process.env.SCRIBE_MCP_OAUTH = v;
      for (const r of await all()) { expect(r.status).toBe(404); expect(await r.text()).toBe(""); }
    }
    expect(fetchLog).toEqual([]);
    expect(fake.state.codes.size + fake.state.tokens.size + fake.state.clients.size).toBe(0);
    expect(audit).toHaveLength(0);
  });

  it("no pepper (or a short one): every route answers 503 server_error and nothing is issued or stored", async () => {
    for (const p of [undefined, "short"]) {
      if (p === undefined) delete process.env.MCP_OAUTH_TOKEN_PEPPER; else process.env.MCP_OAUTH_TOKEN_PEPPER = p;
      const rs = await all();
      for (const r of rs) expect(r.status).toBe(503);
      expect((await rs[4].json()).error).toBe("server_error");
      expect((await rs[0].text())).toContain("server_error");
    }
    expect(fake.state.codes.size + fake.state.tokens.size + fake.state.clients.size).toBe(0);
    expect(fetchLog).toEqual([]);
  });

  it("no Resend key or from-address: authorize, email/start and email/verify are 503; consent, token, register and revoke still work", async () => {
    delete process.env.RESEND_API_KEY;
    expect((await authorize()).status).toBe(503);
    expect((await start("x", ALICE)).status).toBe(503);
    expect((await verify("x", "123456")).status).toBe(503);
    expect((await consentPost("x", {})).status).toBe(400);
    expect((await registerPost(reg({ redirect_uris: [CLAUDE_CALLBACK] }))).status).toBe(201);
    expect((await tokenPost(tokenReq(codeBody("c")))).status).toBe(400);
    process.env.RESEND_API_KEY = RESEND_KEY;
    delete process.env.RESEND_FROM_EMAIL;
    expect((await authorize()).status).toBe(503);
    expect(mailed).toHaveLength(0);
  });
});

// ─── hygiene ────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
describe("hygiene", () => {
  it("the domain is even.in unless the test-only override is honoured; the override is ignored outside NODE_ENV=test", () => {
    expect(MCP_OAUTH_DOMAIN).toBe("even.in");
    delete process.env.SCRIBE_MCP_OAUTH_DOMAIN_TEST;
    expect(mcpOauthDomain()).toBe("even.in");
    process.env.SCRIBE_MCP_OAUTH_DOMAIN_TEST = "x.example.test";
    expect(mcpOauthDomain()).toBe("x.example.test");
    vi.stubEnv("NODE_ENV", "production");
    expect(mcpOauthDomain()).toBe("even.in");
    vi.unstubAllEnvs();
  });

  it("no token, code, pepper, Resend key, emailed code or verifier appears in any log line or audit row across a full flow plus refusals", async () => {
    const t = await tokens();
    const sent = mailed.map((m) => lastCodeOf(m.text));
    await tokenPost(tokenReq(refreshBody(t.refresh_token)));
    await tokenPost(tokenReq(refreshBody(t.refresh_token))); // reuse
    await fullSignIn({}, "allow", "carol@example.test");
    resend.mode = "down";
    resetDeniedAuditForTests();
    await fullSignIn();
    resend.mode = "ok";
    const s = await startSignIn();
    await start(s.cookie, ALICE);
    sent.push(lastCode());
    await verify(s.cookie, "000000");
    const everything = JSON.stringify(logs) + JSON.stringify(audit);
    for (const secret of [t.access_token, t.refresh_token, PEPPER, RESEND_KEY, VERIFIER, sha(t.refresh_token), ...sent.filter(Boolean)]) expect(everything).not.toContain(secret);
    expect(refusalRows().length).toBeGreaterThan(0);
    for (const row of refusalRows()) expect(JSON.stringify(row.values)).not.toMatch(/esp_|esr_|eyJ/);
  });

  it("with the flag OFF an esp_ token is not accepted at /api/mcp (O3 accepts it only with the flag on)", async () => {
    const { POST } = await import("@/app/api/mcp/route");
    process.env.SCRIBE_MCP_TOKEN = "h".repeat(24);
    const t = await tokens();
    process.env.SCRIBE_MCP_OAUTH = "off";
    const res = await POST(new NextRequest("https://www.evenscribe.app/api/mcp", { method: "POST", headers: { authorization: `Bearer ${t.access_token}`, "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }) }));
    expect(res.status).toBe(401);
  }, 30_000); // the first import of the whole /api/mcp route graph is slow on a cold transform
});

// ─── O2-FIX1 ────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
describe("FIX1 SHOULD-1: CIMD host is resolved and checked before the fetch, then the fetch is pinned", () => {
  it("isForbiddenAddress: first, middle and last member of every named range, mapped forms and junk are refused; the neighbours just outside the ranges are not (range membership)", () => {
    const v4ranges = [R.zero, R.ten, R.cgnat, R.loop, R.link, R.b172, R.b192, R.multicast, R.reserved];
    for (const c of v4ranges) for (const a of [hostInRange(c, 0), hostInRange(c, 12345), lastInRange(c)]) expect(isForbiddenAddress(a), `${c} ${a}`).toBe(true);
    for (const c of ["192.0.0.0/24", "198.18.0.0/15"]) for (const a of [hostInRange(c, 0), lastInRange(c)]) expect(isForbiddenAddress(a), `${c} ${a}`).toBe(true);
    for (const a of [hostInRange(R.ula, 1), hostInRange(R.ulaFd, 1), hostInRange(R.ulaFd, 0xbeef), hostInRange(R.ll6, 1), hostInRange(R.mc6, 2), "::1", "::", "2001:db8::1"]) expect(isForbiddenAddress(a), a).toBe(true);
    for (const c of [R.ten, R.loop, R.b192]) {
      const m = hostInRange(c, 7);
      expect(isForbiddenAddress(`::ffff:${m}`), `mapped ${c}`).toBe(true);
      expect(isForbiddenAddress(hexMapped(m, "::ffff:")), `hex-mapped ${c}`).toBe(true);
      expect(isForbiddenAddress(`64:ff9b::${m}`), `nat64 ${c}`).toBe(true);
      expect(isForbiddenAddress(hexMapped(m, "64:ff9b::")), `hex-nat64 ${c}`).toBe(true);
    }
    for (const a of ["not-an-ip", "", "999.1.1.1"]) expect(isForbiddenAddress(a), a).toBe(true);
    for (const c of [R.cgnat, R.b172, R.link]) for (const side of ["below", "above"] as const) expect(isForbiddenAddress(justOutside(c, side)), `${c} ${side}`).toBe(false);
    for (const a of ["93.184.216.34", "8.8.8.8", "2606:4700:4700::1111", "::ffff:8.8.8.8"]) expect(isForbiddenAddress(a), a).toBe(false);
    expect(isForbiddenAddress("64:ff9b::808:808")).toBe(true); // R2 F4: NAT64 is outside 2000::/3, so IPv6 default-deny refuses it
  });

  const loop1 = hostInRange(R.loop, 1);
  const names: Array<[string, Resolved]> = [
    [`${loop1}.nip.io`, [{ address: loop1, family: 4 }]], // a public name that resolves to loopback
    ["localtest.me", [{ address: loop1, family: 4 }]],
    ["metadata.example.test", [{ address: hostInRange(R.link, 100), family: 4 }]],
    ["internal.example.test", [{ address: hostInRange(R.ten, 5), family: 4 }]],
    ["cgnat.example.test", [{ address: hostInRange(R.cgnat, 9), family: 4 }]],
    ["ula.example.test", [{ address: hostInRange(R.ula, 1), family: 6 }]],
    ["ulafd.example.test", [{ address: hostInRange(R.ulaFd, 1), family: 6 }]], // the fd half of ULA (fc00::/7 covers fc and fd)
    ["loop6.example.test", [{ address: "::1", family: 6 }]],
    ["zero.example.test", [{ address: hostInRange(R.zero, 1), family: 4 }]],
    ["multicast.example.test", [{ address: hostInRange(R.multicast, 251), family: 4 }]],
    ["mapped.example.test", [{ address: `::ffff:${loop1}`, family: 6 }]],
    ["rebind.example.test", [{ address: "93.184.216.34", family: 4 }, { address: hostInRange(R.b192, 10), family: 4 }]], // one public, one private: refused whole
    ["empty.example.test", []],
  ];
  for (const [host, answer] of names) {
    it(`${host} resolves to a forbidden (or empty) answer: invalid_client_metadata, nothing fetched`, async () => {
      resolverAnswer = answer;
      const id = `https://${host}/oauth/meta.json`;
      fetchLog.length = 0;
      const res = await authorize({ client_id: id });
      expect(res.status).toBe(400);
      expect(res.headers.get("location")).toBeNull();
      expect(fetchLog).toEqual([]);
      expect(pinnedTo).toEqual([]);
      expect(fake.state.clients.has(id)).toBe(false);
    });
  }

  it("a resolver failure refuses; a public answer is fetched PINNED to the address that was checked", async () => {
    setResolverForTests(async () => { throw new Error("ENOTFOUND"); });
    expect((await authorize()).status).toBe(400);
    expect(pinnedTo).toEqual([]);
    resolverAnswer = [{ address: "2606:4700:4700::1111", family: 6 }, { address: "93.184.216.34", family: 4 }];
    setResolverForTests(async () => resolverAnswer);
    expect((await authorize()).status).toBe(200);
    expect(pinnedTo).toEqual(["2606:4700:4700::1111"]);
  });

  it("the cached client row is used within 24 h without resolving or fetching again", async () => {
    await authorize();
    pinnedTo.length = 0;
    resolverAnswer = [{ address: hostInRange(R.loop, 1), family: 4 }]; // would be refused if resolved again
    expect((await authorize()).status).toBe(200);
    expect(pinnedTo).toEqual([]);
  });
});

describe("FIX1 SHOULD-2: 127.0.0.1 completes the flow end to end through NextRequest on the production host", () => {
  it("authorize with a 127.0.0.1 redirect_uri (Next rewrites it to localhost), then the token request still says 127.0.0.1: 200", async () => {
    cimdDoc = { client_id: CIMD, redirect_uris: [CLAUDE_CALLBACK, "http://127.0.0.1:3118/callback"], token_endpoint_auth_method: "none" };
    const ru = "http://127.0.0.1:5123/callback";
    const { res: cb, to } = await fullSignIn({ redirect_uri: ru });
    expect(cb.status).toBe(303); // R2 F2: the code now leaves from the consent POST (303)
    expect(to.origin + to.pathname).toBe("http://localhost:5123/callback"); // what the route saw and stored (NextURL rewrite)
    const code = to.searchParams.get("code")!;
    const out = await tokenPost(tokenReq(codeBody(code, { redirect_uri: ru }))); // the client presents the original
    expect(out.status).toBe(200);
    expect((await out.json()).access_token).toMatch(/^esp_/);
  });

  it("[::1] and localhost presented at the token endpoint for a stored loopback URI also complete; a non-loopback or other-path URI does not", async () => {
    const mk = async () => (await fullSignIn({ redirect_uri: LOOP })).to.searchParams.get("code")!;
    expect((await tokenPost(tokenReq(codeBody(await mk(), { redirect_uri: "http://[::1]:3118/callback" })))).status).toBe(200);
    expect((await tokenPost(tokenReq(codeBody(await mk(), { redirect_uri: "http://localhost:3118/callback" })))).status).toBe(200);
    expect((await tokenPost(tokenReq(codeBody(await mk(), { redirect_uri: "http://localhost:3118/elsewhere" })))).status).toBe(400);
    expect((await tokenPost(tokenReq(codeBody(await mk(), { redirect_uri: CLAUDE_CALLBACK })))).status).toBe(400);
  });
});

describe("FIX1 MUST-2: the family tombstone", () => {
  it("revokeFamily tombstones the family: nothing more can be inserted into it, a refresh in it is refused, and the revoke endpoint tombstones too", async () => {
    const t = await tokens();
    const fam = fake.state.tokens.get(hashSecret(t.refresh_token))!.family_id;
    await revokePost(new NextRequest("https://www.evenscribe.app/api/oauth/revoke", { method: "POST", body: form({ token: t.access_token }) }));
    expect(fake.state.families.has(fam)).toBe(true);
    expect(await fake.insertToken({ token_hash: "late", kind: "access", email: ALICE, client_id: CIMD, scopes: ["read"], resource: RESOURCE, family_id: fam, ttl_s: 60 })).toBe(false);
    expect((await tokenPost(tokenReq(refreshBody(t.refresh_token)))).status).toBe(400);
  });

  it("code replay and refresh reuse both leave a tombstone", async () => {
    const code = await getCode();
    const first = await (await tokenPost(tokenReq(codeBody(code)))).json();
    await tokenPost(tokenReq(codeBody(code)));
    const fam = fake.state.tokens.get(hashSecret(first.refresh_token))!.family_id;
    expect(fake.state.families.has(fam)).toBe(true);
    const t = await tokens();
    await tokenPost(tokenReq(refreshBody(t.refresh_token)));
    await tokenPost(tokenReq(refreshBody(t.refresh_token)));
    expect(fake.state.families.has(fake.state.tokens.get(hashSecret(t.refresh_token))!.family_id)).toBe(true);
  });
});

describe("FIX1 MUST-1: route modules export only what Next allows", () => {
  it("every OAuth and well-known route file exports only GET/POST/OPTIONS and runtime/dynamic/maxDuration", async () => {
    const allowed = new Set(["GET", "POST", "OPTIONS", "runtime", "dynamic", "maxDuration"]);
    const mods = await Promise.all([
      import("@/app/api/oauth/authorize/route"), import("@/app/api/oauth/email/start/route"), import("@/app/api/oauth/email/verify/route"), import("@/app/api/oauth/email/consent/route"), import("@/app/api/oauth/token/route"),
      import("@/app/api/oauth/register/route"), import("@/app/api/oauth/revoke/route"),
      import("@/app/.well-known/oauth-protected-resource/route"), import("@/app/.well-known/oauth-protected-resource/api/mcp/route"), import("@/app/.well-known/oauth-authorization-server/route"),
    ]);
    for (const m of mods) for (const k of Object.keys(m)) expect(allowed.has(k), k).toBe(true);
  });
});

// ─── R2 (refute e4c1406f F1-F6) ─────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
const grantedRows = () => audit.filter((a) => a.text.includes("mcp.oauth_granted"));
describe("R2 F2: consent step between the email code and the auth code", () => {
  it("after the email code verify renders a same-origin HTML page naming the client host and the redirect host; no code is minted and nothing redirects", async () => {
    const { page, html, cookie, csrf } = await consentPageFor();
    expect(page.status).toBe(200);
    expect(page.headers.get("content-type")).toContain("text/html");
    expect(page.headers.get("location")).toBeNull();
    expect(page.headers.get("content-security-policy")).toContain("frame-ancestors 'none'");
    expect(page.headers.get("x-frame-options")).toBe("DENY");
    expect(page.headers.get("referrer-policy")).toBe("strict-origin"); // R3: no-referrer made browsers send Origin: null on the POST
    expect(html).toContain('<dd data-consent="client">client.example.test</dd>');
    expect(html).toContain('<dd data-consent="redirect-host">claude.ai</dd>');
    expect(html).toContain('method="post" action="/api/oauth/email/consent"');
    expect(html).toContain('value="allow"');
    expect(html).toContain('value="deny"');
    expect(csrf.length).toBeGreaterThanOrEqual(32);
    expect(cookie).toBeTruthy();
    expect(page.headers.get("set-cookie")).toMatch(/Path=\/api\/oauth\/email(;|$)/);
    expect(page.headers.get("set-cookie")).toMatch(/HttpOnly/i);
    expect(fake.state.codes.size).toBe(0);
    expect(grantedRows()).toHaveLength(0);
  });

  it("a DCR client is named by its client_name, escaped, with the loopback redirect host", async () => {
    const reg = await registerPost(new NextRequest("https://www.evenscribe.app/api/oauth/register", { method: "POST", headers: { "content-type": "application/json", "x-forwarded-for": "203.0.113.9" }, body: JSON.stringify({ redirect_uris: [LOOP], client_name: "Desk <b>Tool</b>" }) }));
    const { client_id } = (await reg.json()) as { client_id: string };
    fake.state.clients.get(client_id)!.client_name = 'Desk <b>Tool</b> & "x"'; // register already strips these; the page escapes anyway
    const { html } = await consentPageFor({ client_id, redirect_uri: LOOP });
    expect(html).toContain("Desk &lt;b&gt;Tool&lt;/b&gt; &amp; &quot;x&quot; (self-registered)");
    expect(html).not.toContain("<b>");
    expect(html).toContain('<dd data-consent="redirect-host">localhost:3118</dd>');
  });

  it("no code without POST Allow: the page alone, a POST with no decision, and a GET replay of the consent cookie all mint nothing", async () => {
    const { cookie, csrf } = await consentPageFor();
    expect((await consentPost(cookie, { csrf })).status).toBe(400);
    const replay = await verify(cookie, "123456"); // the consent blob is not a pending blob
    expect(replay.status).toBe(400);
    expect(replay.headers.get("location")).toBeNull();
    expect(fake.state.codes.size).toBe(0);
  });

  it("a forged POST is refused with a plain 400 that never redirects: no cookie, a wrong CSRF token, a foreign Origin, a pre-code pending cookie, an expired consent cookie", async () => {
    const { cookie, csrf } = await consentPageFor();
    const s = await startSignIn();
    const cases: Array<[string, Response]> = [
      ["no cookie", await consentPost("", { csrf, decision: "allow" })],
      ["wrong csrf", await consentPost(cookie, { csrf: "A".repeat(32), decision: "allow" })],
      ["no csrf", await consentPost(cookie, { decision: "allow" })],
      ["foreign origin", await consentPost(cookie, { csrf, decision: "allow" }, { origin: "https://evil.example.test" })],
      ["pending cookie", await consentPost(s.cookie, { csrf, decision: "allow" })],
      ["json body", await consentRoutePost(new NextRequest(CONSENT_URL, { method: "POST", headers: { "content-type": "application/json", cookie: `mcp_oauth_pending=${cookie}` }, body: JSON.stringify({ csrf, decision: "allow" }) }))],
    ];
    vi.useFakeTimers({ now: Date.now() + 6 * 60 * 1000, toFake: ["Date"] });
    cases.push(["expired", await consentPost(cookie, { csrf, decision: "allow" })]);
    vi.useRealTimers();
    for (const [name, res] of cases) {
      expect(res.status, name).toBe(400);
      expect(res.headers.get("location"), name).toBeNull();
      expect(res.headers.get("content-type"), name).toContain("text/html");
    }
    expect(fake.state.codes.size).toBe(0);
    expect(grantedRows()).toHaveLength(0);
    const reasons = refusalRows().map((r) => JSON.stringify(r.values));
    expect(reasons.some((r) => r.includes("consent_missing"))).toBe(true);
    expect(reasons.some((r) => r.includes("consent_csrf") && r.includes(`person:${ALICE}`))).toBe(true);
    // the real page can still be answered after a forged attempt
    expect(loc(await consentPost(cookie, { csrf, decision: "allow" })).searchParams.get("code")).toBeTruthy();
  });

  it("Deny: 303 back to the client with error=access_denied, state and iss; one mcp.oauth_refused row consent_denied; no code", async () => {
    const { res, to } = await fullSignIn({}, "deny");
    expect(res.status).toBe(303);
    expect(to.origin + to.pathname).toBe(CLAUDE_CALLBACK);
    expect(to.searchParams.get("error")).toBe("access_denied");
    expect(to.searchParams.get("state")).toBe("st-1");
    expect(to.searchParams.get("iss")).toBe("https://www.evenscribe.app");
    expect(to.searchParams.get("code")).toBeNull();
    expect(fake.state.codes.size).toBe(0);
    const rows = refusalRows();
    expect(rows).toHaveLength(1);
    expect(rows[0].values).toContain(`person:${ALICE}`);
    expect(JSON.stringify(rows[0].values)).toContain("consent_denied");
    expect(res.headers.get("set-cookie")).toMatch(/Max-Age=0/i);
  });

  it("Allow writes one mcp.oauth_granted row with the client host (CIMD) or the sha256 of the client_id (DCR) and the redirect host; never the code", async () => {
    const { to } = await fullSignIn();
    const code = to.searchParams.get("code")!;
    expect(grantedRows()).toHaveLength(1);
    expect(grantedRows()[0].values).toContain(`person:${ALICE}`);
    const meta = JSON.parse(grantedRows()[0].values.find((v) => typeof v === "string" && v.startsWith("{")) as string);
    expect(meta).toEqual({ ok: true, client_host: "client.example.test", redirect_host: "claude.ai" });
    expect(JSON.stringify(audit)).not.toContain(code);
    const reg = await registerPost(new NextRequest("https://www.evenscribe.app/api/oauth/register", { method: "POST", headers: { "content-type": "application/json", "x-forwarded-for": "203.0.113.10" }, body: JSON.stringify({ redirect_uris: [CLAUDE_CALLBACK] }) }));
    const { client_id } = (await reg.json()) as { client_id: string };
    await fullSignIn({ client_id });
    const meta2 = JSON.parse(grantedRows()[1].values.find((v) => typeof v === "string" && v.startsWith("{")) as string);
    expect(meta2).toEqual({ ok: true, client_sha256: sha(client_id), redirect_host: "claude.ai" });
  });

  it("a person revoked between the page and Allow gets access_denied and no code", async () => {
    const { cookie, csrf } = await consentPageFor();
    fake.addPerson(ALICE, ["read"], "revoked");
    const res = await consentPost(cookie, { csrf, decision: "allow" });
    expect(loc(res).searchParams.get("error")).toBe("access_denied");
    expect(fake.state.codes.size).toBe(0);
  });

  it("a consent blob signed for another purpose (pending) or with a forged body is refused", async () => {
    const forged = signBlob("pending", { cid: CIMD, ru: CLAUDE_CALLBACK, cc: CHALLENGE, st: null, res: RESOURCE, email: ALICE, csrf: "c".repeat(32), exp: 9999999999 });
    expect((await consentPost(forged, { csrf: "c".repeat(32), decision: "allow" })).status).toBe(400);
    expect(fake.state.codes.size).toBe(0);
  });
});

describe("R3: the consent page answers once", () => {
  const errOf = (r: Response) => { const u = loc(r); return { status: r.status, error: u.searchParams.get("error"), code: u.searchParams.get("code"), state: u.searchParams.get("state"), iss: u.searchParams.get("iss"), origin: u.origin + u.pathname }; };

  it("a replayed Allow, a double click and Deny-then-Allow mint nothing after the first answer; the replay is a 303 access_denied back to the client (state, iss); the burn stores a hash, never the csrf", async () => {
    const { cookie, csrf } = await consentPageFor();
    const body = { csrf, decision: "allow" };
    const [a, b] = await Promise.all([consentPost(cookie, body), consentPost(cookie, body)]);
    expect([a.status, b.status]).toEqual([303, 303]);
    const outs = [errOf(a), errOf(b)];
    expect(outs.filter((o) => o.code).length).toBe(1);
    const denied = outs.find((o) => !o.code)!;
    expect(denied).toEqual({ status: 303, error: "access_denied", code: null, state: "st-1", iss: "https://www.evenscribe.app", origin: CLAUDE_CALLBACK });
    expect(fake.state.codes.size).toBe(1);
    expect(grantedRows()).toHaveLength(1);
    expect([...fake.state.burned].some((h) => h.includes(csrf))).toBe(false);
    const d = await consentPageFor();
    expect((await consentPost(d.cookie, { csrf: d.csrf, decision: "deny" })).status).toBe(303);
    const late = await consentPost(d.cookie, { csrf: d.csrf, decision: "allow" });
    expect(errOf(late)).toMatchObject({ status: 303, error: "access_denied", code: null, state: "st-1" });
    expect(fake.state.codes.size).toBe(1);
  });

  it("a forged POST (wrong csrf) does not burn the page; a POST with no decision does not burn it either", async () => {
    const { cookie, csrf } = await consentPageFor();
    expect((await consentPost(cookie, { csrf: "Z".repeat(32), decision: "allow" })).status).toBe(400);
    expect((await consentPost(cookie, { csrf })).status).toBe(400);
    expect(fake.state.burned.size).toBe(0);
    expect(loc(await consentPost(cookie, { csrf, decision: "allow" })).searchParams.get("code")).toBeTruthy();
  });

  it("R3X-3: a burn that throws fails closed: 303 server_error, no code, no grant row", async () => {
    const c = await consentPageFor();
    (fake.state.burned as unknown as { has: () => boolean }).has = () => { throw new Error("db down"); };
    audit.length = 0;
    const res = await consentPost(c.cookie, { csrf: c.csrf, decision: "allow" }, { origin: "https://www.evenscribe.app" });
    delete (fake.state.burned as unknown as { has?: unknown }).has;
    expect(errOf(res)).toMatchObject({ status: 303, error: "server_error", code: null });
    expect(fake.state.codes.size).toBe(0);
    expect(grantedRows()).toHaveLength(0);
  });

  it("R3X-4: a foreign Origin and a string \"null\" Origin are 400 and burn nothing; the real Allow afterwards still mints", async () => {
    const c = await consentPageFor();
    const p = (origin: string) => consentPost(c.cookie, { csrf: c.csrf, decision: "allow" }, { origin });
    expect((await p("https://evil.example.test")).status).toBe(400);
    expect((await p("null")).status).toBe(400);
    expect(fake.state.burned.size).toBe(0);
    expect(fake.state.codes.size).toBe(0);
    const ok = await p("https://www.evenscribe.app");
    expect(ok.status).toBe(303);
    expect(loc(ok).searchParams.get("code")).toBeTruthy();
  });

  it("R3X-4: the burn key is peppered: hashSecret('consent:'+csrf), not the csrf and not a plain sha256", async () => {
    const c = await consentPageFor();
    await consentPost(c.cookie, { csrf: c.csrf, decision: "deny" }, { origin: "https://www.evenscribe.app" });
    const [h] = [...fake.state.burned];
    expect(h).toBe(hashSecret(`consent:${c.csrf}`));
    expect(h).not.toBe(sha(`consent:${c.csrf}`));
    expect(h).not.toContain(c.csrf);
  });

  it("R3X-5: the consent_replay row is written before the response returns (a write that resolves on a later macrotask is inside the response)", async () => {
    const c = await consentPageFor();
    const go = () => consentPost(c.cookie, { csrf: c.csrf, decision: "allow" }, { origin: "https://www.evenscribe.app" });
    expect((await go()).status).toBe(303);
    const { sql } = await import("@/lib/db");
    let written = false;
    (sql as unknown as ReturnType<typeof vi.fn>).mockImplementationOnce(async () => { await new Promise((r) => setTimeout(r, 20)); written = true; return []; });
    const res = await go();
    expect(errOf(res).error).toBe("access_denied");
    expect(written).toBe(true);
  });
});

describe("R2 F3: absolute refresh-family lifetime of 30 days from the family's first token", () => {
  it("a family younger than 30 d rotates; one whose first token is 30 d old is refused invalid_grant, revoked and audited", async () => {
    const t = await tokens();
    const ok = await tokenPost(tokenReq(refreshBody(t.refresh_token)));
    expect(ok.status).toBe(200);
    const next = (await ok.json()) as { refresh_token: string };
    const fam = fake.state.tokens.get(hashSecret(next.refresh_token))!.family_id;
    fake.state.familyBorn.set(fam, Date.now() - 30 * 24 * 3600 * 1000 - 1000);
    audit.length = 0;
    const res = await tokenPost(tokenReq(refreshBody(next.refresh_token)));
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("invalid_grant");
    expect(fake.state.families.has(fam)).toBe(true);
    const rows = refusalRows();
    expect(rows).toHaveLength(1);
    expect(rows[0].values).toContain(`person:${ALICE}`);
    expect(JSON.stringify(rows[0].values)).toContain("family_expired");
  });

  it("R-REFRESH follow-up: a copied refresh token no longer extends access past the family's 30 d", async () => {
    const raw = randomToken("esr_");
    await fake.insertToken({ token_hash: hashSecret(raw), kind: "refresh", email: ALICE, client_id: CIMD, scopes: ["read"], resource: RESOURCE, family_id: "f_old", ttl_s: 3600 });
    fake.state.familyBorn.set("f_old", Date.now() - 31 * 24 * 3600 * 1000);
    expect((await tokenPost(tokenReq(refreshBody(raw)))).status).toBe(400);
  });
});

describe("R2 F5: the DNS lookup shares the CIMD fetch's 5 s budget", () => {
  it("resolvePublic gives up when the signal aborts, even if the resolver never answers", async () => {
    setResolverForTests(() => new Promise<Resolved>(() => {}));
    const ac = new AbortController();
    setTimeout(() => ac.abort(), 20);
    const t0 = Date.now();
    expect(await resolvePublic("hang.example.test", ac.signal)).toBeNull();
    expect(Date.now() - t0).toBeLessThan(1000);
  });

  it("resolveClient with a hanging resolver answers invalid_client_metadata within the 5 s budget and fetches nothing", async () => {
    setResolverForTests(() => new Promise<Resolved>(() => {}));
    const t0 = Date.now();
    expect(await resolveClient(CIMD)).toEqual({ ok: false, reason: "invalid_client_metadata" });
    const ms = Date.now() - t0;
    expect(ms).toBeGreaterThanOrEqual(4900);
    expect(ms).toBeLessThan(6500);
    expect(fetchLog).not.toContain(CIMD);
  }, 10_000);
});

describe("R2 F6: the pending_missing refusal is awaited", () => {
  it("the refusal row is written before the 400 returns", async () => {
    const res = await verify("", "123456");
    expect(res.status).toBe(400);
    expect(refusalRows()).toHaveLength(1);
    expect(JSON.stringify(refusalRows()[0].values)).toContain("pending_missing");
  });
});

describe("R2 F1: a failed best-effort client call is counted and logged, never silent", () => {
  it("touchClient throwing is logged count-only (no client id, no URL)", async () => {
    const store = await import("@/lib/mcp/oauth/store");
    const spy = vi.spyOn(store, "touchClient").mockRejectedValue(new Error(`boom ${CIMD}`));
    const before = swallowedCountForTests();
    expect((await resolveClient(CIMD)).ok).toBe(true);
    spy.mockRestore();
    expect(swallowedCountForTests()).toBe(before + 1);
    const line = logs.find((l) => l.includes("best-effort client side call failed"))!;
    expect(line).toMatch(/count=\d+/);
    expect(line).not.toContain("example.test");
  });
});

// ─── spec 18 Oct 2026: approver-routed code, address lock, identity gate, sign-in alert ─────────────────────────────────────────────────────────────
describe("approver-routed email code", () => {
  it("every code goes to the APPROVER and to nobody else; the requester is named in the body and never receives a mail", async () => {
    await consentPageFor({}, ALICE);
    expect(mailed).toHaveLength(1);
    expect(mailed.map((m) => m.to)).toEqual(["approver@example.test"]);
    expect(mailed[0].text).toContain(ALICE);
    expect(mailed.some((m) => m.to === ALICE)).toBe(false);
  });

  it("flag on WITHOUT the approver env: authorize-time email steps answer 503 server_error, nothing is stored, nothing is mailed to anyone", async () => {
    const s = await startSignIn();
    delete process.env.SCRIBE_MCP_OAUTH_APPROVER;
    const r = await start(s.cookie, ALICE);
    expect(r.status).toBe(503);
    expect(await r.text()).toContain("server_error");
    expect(mailed).toHaveLength(0);
    expect(fake.state.emailCodes.size).toBe(0);
    expect((await verify(s.cookie, "123456")).status).toBe(503);
    process.env.SCRIBE_MCP_OAUTH_APPROVER = "not an address";
    expect((await start(s.cookie, ALICE)).status).toBe(503); // a malformed approver is no approver
    expect(mailed).toHaveLength(0);
  });

  it("5 wrong tries lock the ADDRESS for 15 minutes: a brand-new sign-in for the same address gets the same page and NO mail; 16 minutes later a code is sent again", async () => {
    const s = await startSignIn();
    await start(s.cookie, ALICE);
    const right = lastCode();
    const wrong = right === "000000" ? "000001" : "000000";
    for (let i = 0; i < 5; i++) await verify(s.cookie, wrong);
    resetEmailLimitForTests();
    const s2 = await startSignIn();
    const before = mailed.length;
    const r = await start(s2.cookie, ALICE);
    expect(r.status).toBe(200);
    expect(mailed).toHaveLength(before); // locked: no code issued
    fake.emailClock.offsetMs = 16 * 60_000;
    resetEmailLimitForTests();
    const s3 = await startSignIn();
    await start(s3.cookie, ALICE);
    expect(mailed).toHaveLength(before + 1);
    expect(mailed[before]!.to).toBe("approver@example.test");
  });

  it("SCRIBE_MCP_IDENTITY on: an allowlisted person with no active mcp_identity gets the identical page, no mail and a no_identity refusal row", async () => {
    process.env.SCRIBE_MCP_IDENTITY = "on";
    IDM.status = null; // no identity row
    const s = await startSignIn();
    const r = await start(s.cookie, ALICE);
    expect(r.status).toBe(200);
    expect(mailed).toHaveLength(0);
    expect(JSON.stringify(audit.filter((a) => a.text.includes("mcp.oauth_refused")).map((a) => a.values))).toContain("no_identity");
  });

  it("an Allow by a non-V person mails V a sign-in alert (address and client host only); V's own sign-in does not", async () => {
    const r = await fullSignIn({}, "allow", ALICE);
    expect(r.res.status).toBe(303);
    const alerts = mailed.filter((m) => m.subject === "EvenScribe MCP: sign-in");
    expect(alerts).toHaveLength(1);
    expect(alerts[0]!.to).toBe("approver@example.test");
    expect(alerts[0]!.text).toContain(ALICE);
    expect(alerts[0]!.text).not.toMatch(/\d{6}|csrf|token/i);
    fake.addPerson("approver@example.test");
    resetEmailLimitForTests();
    mailed.length = 0;
    await fullSignIn({}, "allow", "approver@example.test");
    expect(mailed.filter((m) => m.subject === "EvenScribe MCP: sign-in")).toHaveLength(0);
  });
});

// ─── addendum 1: code route switch, 30-day non-sliding session bound to the key ─────────────────────────────────────────────────────────────────────
describe("SCRIBE_MCP_CODE_ROUTE", () => {
  it("default and unknown values route every code to the approver, even for an approved address", async () => {
    IDM.self = true;
    for (const v of [undefined, "", "approver", "bogus", "SELF"]) {
      if (v === undefined) delete process.env.SCRIBE_MCP_CODE_ROUTE; else process.env.SCRIBE_MCP_CODE_ROUTE = v;
      resetEmailLimitForTests(); fake.state.emailCodes.clear(); mailed.length = 0;
      await start((await startSignIn()).cookie, ALICE);
      expect(mailed.map((m) => m.to)).toEqual(["approver@example.test"]);
    }
  });

  it("self_after_approval: an address V has NOT approved still gets its code through the approver", async () => {
    process.env.SCRIBE_MCP_CODE_ROUTE = "self_after_approval";
    IDM.self = false;
    await start((await startSignIn()).cookie, ALICE);
    expect(mailed.map((m) => m.to)).toEqual(["approver@example.test"]);
    expect(mailed[0]!.text).toContain(ALICE);
  });

  it("self_after_approval: once V approved the address, the code goes to that person's own address (and only there); the sign-in alert still goes to V and names the route", async () => {
    process.env.SCRIBE_MCP_CODE_ROUTE = "self_after_approval";
    IDM.self = true;
    const r = await fullSignIn({}, "allow", ALICE);
    expect(r.res.status).toBe(303);
    const code = mailed.find((m) => m.subject === "EvenScribe MCP sign-in code (approval needed)")!;
    expect(code.to).toBe(ALICE);
    expect(code.text).toMatch(/^Your EvenScribe MCP sign-in code: \d{6}\./);
    const alerts = mailed.filter((m) => m.subject === "EvenScribe MCP: sign-in");
    expect(alerts.map((m) => m.to)).toEqual(["approver@example.test"]);
    expect(alerts[0]!.text).toContain("self_after_approval");
    expect(mailed.filter((m) => m.to === "approver@example.test" && m.subject !== "EvenScribe MCP: sign-in")).toHaveLength(0);
  });

  it("self_after_approval still needs the approver env (V gets the alert): without it nothing is mailed to anyone", async () => {
    process.env.SCRIBE_MCP_CODE_ROUTE = "self_after_approval";
    IDM.self = true;
    const s = await startSignIn();
    delete process.env.SCRIBE_MCP_OAUTH_APPROVER;
    expect((await start(s.cookie, ALICE)).status).toBe(503);
    expect(mailed).toHaveLength(0);
  });
});

describe("session bound to the key (SCRIBE_MCP_IDENTITY on)", () => {
  const signedIn = async () => {
    process.env.SCRIBE_MCP_IDENTITY = "on";
    const r = await fullSignIn({}, "allow", ALICE);
    expect(r.res.status).toBe(303);
    return r.to.searchParams.get("code")!;
  };
  const exchange = async (code: string) => (await tokenPost(tokenReq(codeBody(code)))).json() as Promise<Record<string, any>>;

  it("the key id is stored on the code and carried to the access and refresh token of the session", async () => {
    const tok = await exchange(await signedIn());
    expect(tok.access_token).toMatch(/^esp_/);
    const rows = [...fake.state.tokens.values()];
    expect(rows).toHaveLength(2);
    expect(rows.map((t) => t.key_id)).toEqual(["k_alice", "k_alice"]);
  });

  it("an address with no live key cannot finish sign-in (access_denied, no code, a no_key refusal row); V's own sign-in needs none", async () => {
    IDM.keyId = null;
    process.env.SCRIBE_MCP_IDENTITY = "on";
    const r = await fullSignIn({}, "allow", ALICE);
    expect(loc(r.res).searchParams.get("error")).toBe("access_denied");
    expect(fake.state.codes.size).toBe(0);
    expect(JSON.stringify(audit.filter((a) => a.text.includes("mcp.oauth_refused")).map((a) => a.values))).toContain("no_key");
    fake.addPerson("approver@example.test");
    resetEmailLimitForTests();
    const v = await fullSignIn({}, "allow", "approver@example.test");
    expect(loc(v.res).searchParams.get("code")).toBeTruthy();
  });

  it("the code exchange is refused if the bound key died between consent and exchange", async () => {
    const code = await signedIn();
    IDM.live = false;
    const res = await tokenPost(tokenReq(codeBody(code)));
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("invalid_grant");
    expect(fake.state.tokens.size).toBe(0);
  });

  it("refresh after the key (or the email) was revoked: invalid_grant and the whole family is tombstoned; refresh while the key lives works", async () => {
    const tok = await exchange(await signedIn());
    const refresh = (t: string) => tokenPost(tokenReq({ grant_type: "refresh_token", refresh_token: t, client_id: CIMD, resource: RESOURCE }));
    const ok = await refresh(tok.refresh_token);
    expect(ok.status).toBe(200);
    const next = (await ok.json()).refresh_token as string;
    IDM.live = false;
    const dead = await refresh(next);
    expect(dead.status).toBe(400);
    expect((await dead.json()).error).toBe("invalid_grant");
    expect(fake.state.families.size).toBe(1);
    expect([...fake.state.tokens.values()].every((t) => t.revoked_at)).toBe(true);
  });

  it("30 days from sign-in, not from the last refresh: a refresh at day 29 does not extend the session; at day 30 the family is refused", async () => {
    const tok = await exchange(await signedIn());
    const fam = [...fake.state.tokens.values()][0]!.family_id;
    const day = 86_400_000;
    fake.state.familyBorn.set(fam, Date.now() - 29 * day);
    const refresh = (t: string) => tokenPost(tokenReq({ grant_type: "refresh_token", refresh_token: t, client_id: CIMD, resource: RESOURCE }));
    const r29 = await refresh(tok.refresh_token);
    expect(r29.status).toBe(200);
    expect(fake.state.familyBorn.get(fam)).toBeLessThan(Date.now() - 28 * day); // the refresh did not move the start
    fake.state.familyBorn.set(fam, Date.now() - 30 * day - 1000);
    const r30 = await refresh((await r29.json()).refresh_token);
    expect(r30.status).toBe(400);
  });
});

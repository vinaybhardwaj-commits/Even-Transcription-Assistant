/**
 * Refuter probes for the Scribe OAuth R2 fix round (cloud-scribe-oauth-r2-refute, target 7ad33769). Each describe names the verdict item it backs
 * (cloudpane-reports/SCRIBE-OAUTH-R2-VERDICT.md). Probes that document a FINDING assert today's behaviour and say so; the fix flips them.
 * Synthetic addresses at example.test and synthetic secrets only. No live Google, no network beyond 127.0.0.1. R2-P1 drives a real headless Chromium
 * (CHROME_PATH, else /opt/pw-browsers/chromium) over the DevTools protocol and is skipped when neither exists.
 */
import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from "vitest";
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { createServer, get as httpGet } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NextRequest, type NextResponse } from "next/server";

const audit: Array<{ text: string; values: unknown[] }> = [];
vi.mock("@/lib/db", () => ({ sql: vi.fn(async (strings: TemplateStringsArray, ...values: unknown[]) => { audit.push({ text: strings.join("?"), values }); return []; }) }));
vi.mock("@/lib/mcp/oauth/store", async () => await import("../support/mcp-oauth-fake-store"));

import * as fake from "../support/mcp-oauth-fake-store";
import { resetEmailLimitForTests } from "@/lib/mcp/oauth/email-limit";
import { GET as authorizeGet } from "@/app/api/oauth/authorize/route";
import { CONSENT_URL, consentPost as consentRoutePost, resendFetch, resetMail, toConsentFrom, verify } from "../support/mcp-oauth-email-flow";
import { POST as tokenPost } from "@/app/api/oauth/token/route";
import { isForbiddenAddress, resolvePublic, setResolverForTests, setTransportForTests } from "@/lib/mcp/oauth/ssrf";
import { resetDeniedAuditForTests } from "@/lib/mcp/audit";
import { CLAUDE_CALLBACK } from "@/lib/mcp/oauth/config";
import { hashSecret, randomToken, s256 } from "@/lib/mcp/oauth/crypto";

const RESOURCE = "https://www.evenscribe.app/api/mcp";
const SITE = "https://www.evenscribe.app";
const CB = CONSENT_URL;
const CIMD = "https://client.example.test/oauth/meta.json";
const ALICE = "alice@example.test";
const VERIFIER = "v".repeat(43);
const ENV = { ...process.env };
const DAY = 24 * 3600 * 1000;

beforeEach(() => {
  fake.resetFakeStore();
  resetEmailLimitForTests();
  fake.addPerson(ALICE);
  audit.length = 0;
  resetDeniedAuditForTests();
  process.env.SCRIBE_MCP_OAUTH = "on";
  process.env.MCP_OAUTH_TOKEN_PEPPER = "p".repeat(32);
  process.env.RESEND_API_KEY = "re_synthetic";
  process.env.RESEND_FROM_EMAIL = "noreply@example.test";
  process.env.SCRIBE_MCP_OAUTH_APPROVER = "approver@example.test";
  resetMail();
  process.env.SCRIBE_MCP_OAUTH_DOMAIN_TEST = "example.test";
  // a public address for the CIMD host, written as IPv4-mapped hex so no dotted literal sits in this file
  setResolverForTests(async () => [{ address: "::ffff:5db8:d822", family: 6 }]);
  setTransportForTests(async (url, _pinned, signal) => fetch(url.toString(), { signal }));
  vi.stubGlobal("fetch", vi.fn(async (input: string | URL, init?: RequestInit) => {
    const url = String(input);
    const mail = resendFetch(input, init);
    if (mail) return mail;
    if (url === CIMD) return new Response(JSON.stringify({ client_id: CIMD, client_name: "Synthetic", redirect_uris: [CLAUDE_CALLBACK] }), { status: 200 });
    throw new Error(`unexpected fetch ${url}`);
  }));
});
afterEach(() => {
  process.env = { ...ENV };
  setResolverForTests(null);
  setTransportForTests(null);
  vi.unstubAllGlobals();
});

/** authorize, the emailed code, verify: returns the consent page response, its re-signed cookie and its CSRF token. */
async function toConsent() {
  const q = new URLSearchParams({ response_type: "code", client_id: CIMD, redirect_uri: CLAUDE_CALLBACK, code_challenge: s256(VERIFIER), code_challenge_method: "S256", resource: RESOURCE, state: "st-9" });
  const a = await authorizeGet(new NextRequest(`${SITE}/api/oauth/authorize?${q}`));
  expect(a.status).toBe(200);
  const c = await toConsentFrom(a.cookies.get("mcp_oauth_pending")!.value, ALICE);
  expect(c.page.status).toBe(200);
  return c;
}
const post = (cookie: string, body: string, headers: Record<string, string> = {}) =>
  consentRoutePost(cookie, Object.fromEntries(new URLSearchParams(body)), headers);
const refusals = () => audit.filter((r) => r.text.includes("mcp.oauth_refused"));

// ─── R2-P1: what a real browser sends with the consent form ─────────────────────────────────────────────────────────────────────────────────────────
const CHROME = process.env.CHROME_PATH ?? "/opt/pw-browsers/chromium";

/** Serve the consent page bytes and headers, let headless Chromium click Allow, return the Origin header the POST carried. */
async function originChromeSends(page: { body: string; headers: Headers }, dropReferrerPolicy: boolean): Promise<string> {
  let seen: string | null = null;
  const srv = createServer((req, res) => {
    if (req.method === "GET") {
      const h: Record<string, string> = {};
      page.headers.forEach((v, k) => { if (!(dropReferrerPolicy && k === "referrer-policy") && k !== "set-cookie") h[k] = v; });
      res.writeHead(200, h);
      res.end(page.body);
      return;
    }
    seen = req.headers.origin ?? "(absent)";
    res.writeHead(200, { "content-type": "text/plain" });
    res.end("ok");
  }).listen(0, "127.0.0.1");
  await new Promise((r) => srv.once("listening", r));
  const port = (srv.address() as { port: number }).port;
  const dir = mkdtempSync(join(tmpdir(), "r2probe-"));
  const chrome = spawn(CHROME, ["--headless=new", "--no-sandbox", "--disable-gpu", "--remote-debugging-port=0", `--user-data-dir=${dir}`, "about:blank"], { stdio: ["ignore", "ignore", "pipe"] });
  try {
    const ws = await new Promise<string>((res, rej) => {
      let buf = "";
      chrome.stderr!.on("data", (d) => { buf += String(d); const m = /DevTools listening on (ws:\/\/\S+)/.exec(buf); if (m) res(m[1]!); });
      setTimeout(() => rej(new Error("chromium did not start")), 20_000);
    });
    const devPort = new URL(ws).port;
    const targets = await new Promise<Array<{ type: string; webSocketDebuggerUrl: string }>>((res, rej) =>
      httpGet(`http://127.0.0.1:${devPort}/json/list`, (r) => { let b = ""; r.on("data", (d) => (b += d)); r.on("end", () => res(JSON.parse(b))); }).on("error", rej));
    const sock = new WebSocket(targets.find((t) => t.type === "page")!.webSocketDebuggerUrl);
    await new Promise((r) => sock.addEventListener("open", r, { once: true }));
    let id = 0;
    const send = (method: string, params: object = {}) => new Promise<unknown>((res) => {
      const my = ++id;
      const on = (ev: MessageEvent) => { const m = JSON.parse(String(ev.data)); if (m.id === my) { sock.removeEventListener("message", on); res(m.result); } };
      sock.addEventListener("message", on);
      sock.send(JSON.stringify({ id: my, method, params }));
    });
    await send("Page.enable");
    const loaded = () => new Promise<void>((r) => { const on = (ev: MessageEvent) => { if (JSON.parse(String(ev.data)).method === "Page.loadEventFired") { sock.removeEventListener("message", on); r(); } }; sock.addEventListener("message", on); });
    let l = loaded();
    await send("Page.navigate", { url: `http://127.0.0.1:${port}/api/oauth/email/verify` });
    await l;
    l = loaded();
    await send("Runtime.evaluate", { expression: `document.querySelector('button[value="allow"]').click()` });
    await l;
    sock.close();
    return seen ?? "(no post)";
  } finally {
    const exited = new Promise((r) => chrome.once("exit", r));
    chrome.kill("SIGKILL");
    await exited;
    srv.close();
    try { rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); } catch { /* temp profile; the OS reaps it */ }
  }
}

describe.skipIf(!existsSync(CHROME))("R2-P1 (finding 1, fixed in R3): the consent page's Referrer-Policy is strict-origin, so Chromium sends the page origin and Allow mints", () => {
  it("real Chromium clicking Allow on the real page sends the page's own origin (not null); the real POST with that same-origin Origin is 303 with code, state and iss", async () => {
    const c = await toConsent();
    expect(c.page.headers.get("referrer-policy")).toBe("strict-origin");
    const origin = await originChromeSends({ body: c.html, headers: c.page.headers }, false);
    expect(origin).not.toBe("null");
    expect(origin).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    audit.length = 0;
    // the real deployment is same-origin with the callback, so the browser's own origin maps to SITE
    const res = await post(c.cookie, new URLSearchParams({ csrf: c.csrf, decision: "allow" }).toString(), { origin: SITE });
    expect(res.status).toBe(303);
    const to = new URL(res.headers.get("location")!);
    expect(to.searchParams.get("code")).toBeTruthy();
    expect(to.searchParams.get("state")).toBe("st-9");
    expect(to.searchParams.get("iss")).toBeTruthy();
    expect(fake.state.codes.size).toBe(1);
    expect(JSON.stringify(refusals().map((r) => r.values))).not.toContain("consent_csrf");
  }, 60_000);

  it("control: the same page WITHOUT the Referrer-Policy header gives the page's own origin, and the POST then mints (303 with code, state, iss)", async () => {
    const c = await toConsent();
    const origin = await originChromeSends({ body: c.html, headers: c.page.headers }, true);
    expect(origin).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    // the real deployment is same-origin with the callback, so the browser's own origin maps to SITE
    const res = await post(c.cookie, new URLSearchParams({ csrf: c.csrf, decision: "allow" }).toString(), { origin: SITE });
    expect(res.status).toBe(303);
    const to = new URL(res.headers.get("location")!);
    expect(to.searchParams.get("code")).toBeTruthy();
    expect(to.searchParams.get("iss")).toBeTruthy();
  }, 60_000);
});

describe("R2-P1 (null Origin): runs without Chromium", () => {
  it("the Origin check is kept: Origin null (what no-referrer produced) is still refused with a 400 consent_csrf and no code", async () => {
    const c = await toConsent();
    audit.length = 0;
    const res = await post(c.cookie, new URLSearchParams({ csrf: c.csrf, decision: "allow" }).toString(), { origin: "null" });
    expect(res.status).toBe(400);
    expect(res.headers.get("location")).toBeNull();
    expect(fake.state.codes.size).toBe(0);
    expect(JSON.stringify(refusals().map((r) => r.values))).toContain("consent_csrf");
  });
});

// ─── R2-P2: consent step, independent of the builder's tests ────────────────────────────────────────────────────────────────────────────────────────
describe("R2-P2: consent step bindings (verified, plus finding 2)", () => {
  it("nothing in the form can move the redirect: extra redirect_uri / state / client_id fields are ignored on Allow and on Deny", async () => {
    for (const decision of ["allow", "deny"]) {
      const c = await toConsent();
      const res = await post(c.cookie, new URLSearchParams({ csrf: c.csrf, decision, redirect_uri: "https://evil.example.test/cb", state: "forged", client_id: "x" }).toString(), { origin: SITE });
      expect(res.status).toBe(303);
      const to = new URL(res.headers.get("location")!);
      expect(to.origin + to.pathname).toBe(CLAUDE_CALLBACK);
      expect(to.searchParams.get("state")).toBe("st-9");
      expect(to.searchParams.get("iss")).toBeTruthy();
      if (decision === "deny") expect(to.searchParams.get("error")).toBe("access_denied");
    }
  });

  it("Deny: access_denied + state + iss, one consent_denied row, no code", async () => {
    const c = await toConsent();
    audit.length = 0;
    const res = await post(c.cookie, new URLSearchParams({ csrf: c.csrf, decision: "deny" }).toString(), { origin: SITE });
    const to = new URL(res.headers.get("location")!);
    expect([to.searchParams.get("error"), to.searchParams.get("state"), !!to.searchParams.get("iss"), to.searchParams.get("code")]).toEqual(["access_denied", "st-9", true, null]);
    expect(refusals()).toHaveLength(1);
    expect(JSON.stringify(refusals()[0]!.values)).toContain("consent_denied");
    expect(fake.state.codes.size).toBe(0);
  });

  it("the consent blob cannot pass verify and the pre-code blob cannot pass the consent POST (purpose binding)", async () => {
    const c = await toConsent();
    const g = await verify(c.cookie, "123456");
    expect(g.status).toBe(400);
    expect(g.headers.get("location")).toBeNull();
    const q = new URLSearchParams({ response_type: "code", client_id: CIMD, redirect_uri: CLAUDE_CALLBACK, code_challenge: s256(VERIFIER), code_challenge_method: "S256", resource: RESOURCE, state: "s" });
    const pending = (await authorizeGet(new NextRequest(`${SITE}/api/oauth/authorize?${q}`))).cookies.get("mcp_oauth_pending")!.value;
    expect((await post(pending, new URLSearchParams({ csrf: c.csrf, decision: "allow" }).toString(), { origin: SITE })).status).toBe(400);
    expect(fake.state.codes.size).toBe(0);
  });

  it("a CSRF token from one consent page does not open another person's/flow's cookie", async () => {
    const a = await toConsent();
    const b = await toConsent();
    expect(a.csrf).not.toBe(b.csrf);
    expect((await post(a.cookie, new URLSearchParams({ csrf: b.csrf, decision: "allow" }).toString(), { origin: SITE })).status).toBe(400);
    expect(fake.state.codes.size).toBe(0);
  });

  it("FINDING 2 (LOW, fixed in R3): the consent cookie + CSRF pair is single-use; a replayed Allow and Deny-then-Allow mint nothing", async () => {
    const c = await toConsent();
    const body = new URLSearchParams({ csrf: c.csrf, decision: "allow" }).toString();
    const r1 = await post(c.cookie, body, { origin: SITE });
    const r2 = await post(c.cookie, body, { origin: SITE });
    expect([r1.status, r2.status]).toEqual([303, 303]);
    expect(new URL(r2.headers.get("location")!).searchParams.get("error")).toBe("access_denied"); // R3 fold-in: the client can restart
    expect(new URL(r2.headers.get("location")!).searchParams.get("code")).toBeNull();
    expect(fake.state.codes.size).toBe(1);
    const d = await toConsent();
    expect((await post(d.cookie, new URLSearchParams({ csrf: d.csrf, decision: "deny" }).toString(), { origin: SITE })).status).toBe(303);
    const again = await post(d.cookie, new URLSearchParams({ csrf: d.csrf, decision: "allow" }).toString(), { origin: SITE });
    expect(again.status).toBe(303);
    expect(new URL(again.headers.get("location")!).searchParams.get("code")).toBeNull();
    expect(fake.state.codes.size).toBe(1);
    expect(JSON.stringify(refusals().map((r) => r.values))).toContain("consent_replay");
  });
});

// ─── R2-P3: absolute family lifetime, at the edges ──────────────────────────────────────────────────────────────────────────────────────────────────
describe("R2-P3: refresh family lifetime edges (fake store mirrors store.ts)", () => {
  const refresh = (raw: string, client = CIMD) =>
    tokenPost(new NextRequest(`${SITE}/api/oauth/token`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: raw, client_id: client }).toString() }));
  const seed = async (fam: string, ageMs: number) => {
    const raw = randomToken("esr_");
    await fake.insertToken({ token_hash: hashSecret(raw), kind: "refresh", email: ALICE, client_id: CIMD, scopes: ["read"], resource: RESOURCE, family_id: fam, ttl_s: 3600 });
    fake.state.familyBorn.set(fam, Date.now() - ageMs);
    return raw;
  };
  it("30 d minus 5 s rotates; 30 d plus 5 s is invalid_grant, tombstoned and audited family_expired", async () => {
    expect((await refresh(await seed("f_young", 30 * DAY - 5000))).status).toBe(200);
    audit.length = 0;
    const res = await refresh(await seed("f_old", 30 * DAY + 5000));
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("invalid_grant");
    expect(fake.state.families.has("f_old")).toBe(true);
    expect(JSON.stringify(refusals().map((r) => r.values))).toContain("family_expired");
  });
  it("many rotations do not reset the clock: the 5th rotated token of a 30 d + 5 s old family is refused", async () => {
    let raw = await seed("f_chain", 0);
    for (let i = 0; i < 4; i++) raw = ((await (await refresh(raw)).json()) as { refresh_token: string }).refresh_token;
    fake.state.familyBorn.set("f_chain", Date.now() - 30 * DAY - 5000);
    expect((await refresh(raw)).status).toBe(400);
  });
});

// ─── R2-P4: IPv6 classes, all built from parts ──────────────────────────────────────────────────────────────────────────────────────────────────────
describe("R2-P4: IPv6 default-deny, ::/96 and ::ffff forms judged by the IPv4 inside", () => {
  const loopHex = "7f00:1"; // 127.0.0.1 as two hex groups
  const tenHex = "a00:1"; // 10.0.0.1
  const pubHex = "808:808"; // a public resolver
  const dotted = (a: number, b: number, c: number, d: number) => [a, b, c, d].join(".");
  const refused = [
    `::${loopHex}`, `::${tenHex}`, `::${dotted(127, 0, 0, 1)}`, `0:0:0:0:0:0:${loopHex}`, `::0:${loopHex}`, // ::/96 IPv4-compatible
    `::ffff:${loopHex}`, `::ffff:${tenHex}`, `::ffff:${dotted(169, 254, 0, 1)}`, `0:0:0:0:0:ffff:${loopHex}`, `::FFFF:${loopHex.toUpperCase()}`, // ::ffff:0:0/96
    "::", "::1", "::0.0.0.0", // unspecified / loopback
    `::ffff:0:${loopHex}`, `::ffff:0:${pubHex}`, // SIIT ::ffff:0:0:0/96 is outside 2000::/3
    `64:ff9b::${loopHex}`, `64:ff9b::${pubHex}`, `64:ff9b:1::${pubHex}`, // NAT64 well-known and local-use
    "fec0::1", "feff::1", "fe80::1", "fc00::1", "fdff::1", "ff02::1", "100::1", "1fff:ffff::1", // outside 2000::/3
    "2002::1", `2002:${loopHex}::1`, "2001::1", "2001:0:ffff::1", "2001:db8::1", // inside 2000::/3 but refused
    "fe80::1%eth0", "[::1]", "2606:4700::1/64", "not-an-ip",
  ];
  for (const a of refused) it(`${a} is refused`, () => expect(isForbiddenAddress(a)).toBe(true));
  const allowed = ["2606:4700:4700::1111", "2a00:1450::1", "3fff:ffff::1", `::${pubHex}`, `::ffff:${pubHex}`, "2001:1::1", "2003::1"];
  for (const a of allowed) it(`control: ${a} passes`, () => expect(isForbiddenAddress(a)).toBe(false));
  it("one bad address among many sinks the host", async () => {
    setResolverForTests(async () => [{ address: "2606:4700:4700::1111", family: 6 }, { address: `::${loopHex}`, family: 6 }]);
    expect(await resolvePublic("x.example.test")).toBeNull();
  });
});

// ─── R2-P5: resolver timeout ────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
describe("R2-P5: a hanging resolver is cut by the signal; an already-aborted signal never calls through", () => {
  it("hangs forever, signal aborts at 30 ms: null in < 500 ms", async () => {
    setResolverForTests(() => new Promise(() => {}));
    const t0 = Date.now();
    expect(await resolvePublic("slow.example.test", AbortSignal.timeout(30))).toBeNull();
    expect(Date.now() - t0).toBeLessThan(500);
  });
  it("an answer that arrives before the abort still counts", async () => {
    setResolverForTests(async () => [{ address: "2606:4700:4700::1111", family: 6 }]);
    expect(await resolvePublic("ok.example.test", AbortSignal.timeout(1000))).toHaveLength(1);
  });
});

// ─── R2-P6: awaited refusal ─────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
describe("R2-P6: the pending_missing refusal row is written before the 400 returns", () => {
  it("db write that resolves on a later macrotask is still inside the response", async () => {
    const { sql } = await import("@/lib/db");
    let written = false;
    (sql as unknown as ReturnType<typeof vi.fn>).mockImplementationOnce(async () => { await new Promise((r) => setTimeout(r, 20)); written = true; return []; });
    const res = await verify("", "123456");
    expect(res.status).toBe(400);
    expect(written).toBe(true);
  });
});

// ─── R2-P7: the original "verified" list after R2 ───────────────────────────────────────────────────────────────────────────────────────────────────
describe("R2-P7: flag off, the new POST is a bare 404; Allow writes exactly one grant row and no secret", () => {
  it("SCRIBE_MCP_OAUTH off: callback POST (valid-looking or not) is 404, empty body, no cookie, no audit row, nothing minted", async () => {
    const c = await toConsent();
    process.env.SCRIBE_MCP_OAUTH = "off";
    audit.length = 0;
    for (const res of [await post(c.cookie, new URLSearchParams({ csrf: c.csrf, decision: "allow" }).toString(), { origin: SITE }), await post("", "")]) {
      expect(res.status).toBe(404);
      expect(await res.text()).toBe("");
      expect(res.headers.get("set-cookie")).toBeNull();
    }
    expect(audit).toHaveLength(0);
    expect(fake.state.codes.size).toBe(0);
  });
  it("Allow: one mcp.oauth_granted row, actor person:<email>, client_host and redirect_host only; the code, csrf and cookie never appear in any audit value", async () => {
    const c = await toConsent();
    audit.length = 0;
    const res = await post(c.cookie, new URLSearchParams({ csrf: c.csrf, decision: "allow" }).toString(), { origin: SITE });
    const code = new URL(res.headers.get("location")!).searchParams.get("code")!;
    const grants = audit.filter((r) => r.text.includes("mcp.oauth_granted"));
    expect(grants).toHaveLength(1);
    expect(grants[0]!.values[0]).toBe(`person:${ALICE}`);
    expect(JSON.parse(String(grants[0]!.values[1]))).toEqual({ ok: true, client_host: "client.example.test", redirect_host: "claude.ai" });
    const all = JSON.stringify(audit.map((r) => r.values));
    for (const s of [code, c.csrf, c.cookie]) expect(all).not.toContain(s);
  });
});

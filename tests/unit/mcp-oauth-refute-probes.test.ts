/**
 * Refuter probes for e4c1406f (cloud-scribe-oauth), carried into R2. R-SSRF and R-CONSENT now assert the FIXED behaviour (F4, F2); R-REFRESH still documents that a copied refresh token
 * works inside its family's 30 d (F3 bounds it; see mcp-oauth-o2.test.ts "R2 F3").
 * Synthetic addresses at example.test and synthetic secrets only. No network, no database.
 */
import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from "vitest";
import { NextRequest } from "next/server";

vi.mock("@/lib/db", () => ({ sql: vi.fn(async () => []) }));
vi.mock("@/lib/mcp/oauth/store", async () => await import("../support/mcp-oauth-fake-store"));

import * as fake from "../support/mcp-oauth-fake-store";
import { resetEmailLimitForTests } from "@/lib/mcp/oauth/email-limit";
import { GET as authorizeGet } from "@/app/api/oauth/authorize/route";
import { resendFetch, resetMail, toConsentFrom } from "../support/mcp-oauth-email-flow";
import { POST as tokenPost } from "@/app/api/oauth/token/route";
import { POST as registerPost } from "@/app/api/oauth/register/route";
import { resetRegisterLimitForTests } from "@/lib/mcp/oauth/register-limit";
import { isForbiddenAddress } from "@/lib/mcp/oauth/ssrf";
import { CLAUDE_CALLBACK } from "@/lib/mcp/oauth/config";
import { hashSecret, randomToken, s256 } from "@/lib/mcp/oauth/crypto";

const RESOURCE = "https://www.evenscribe.app/api/mcp";
const ALICE = "alice@example.test";
const ENV = { ...process.env };
beforeEach(() => {
  fake.resetFakeStore();
  resetEmailLimitForTests();
  resetRegisterLimitForTests();
  process.env.SCRIBE_MCP_OAUTH = "on";
  process.env.MCP_OAUTH_TOKEN_PEPPER = "p".repeat(32);
  process.env.RESEND_API_KEY = "re_synthetic";
  process.env.RESEND_FROM_EMAIL = "noreply@example.test";
  process.env.SCRIBE_MCP_OAUTH_APPROVER = "approver@example.test";
  resetMail();
  vi.stubGlobal("fetch", vi.fn(async (input: string | URL, init?: RequestInit) => (await resendFetch(input, init)) ?? new Response("{}", { status: 404 })));
});
afterEach(() => {
  process.env = { ...ENV };
  vi.unstubAllGlobals();
});

describe("R-SSRF (fixed by R2 F4): IPv6 forms that embed or alias IPv4, and non-global IPv6, are refused", () => {
  // Built from parts so no private literal is written whole.
  const loop4 = ["127", "0", "0", "1"].join(".");
  const cases = [
    `::${loop4}`, // IPv4-compatible (deprecated) loopback
    "::7f00:1", // the same, hex form
    "2002:7f00:1::1", // 6to4 wrapping loopback
    "64:ff9b:1::7f00:1", // RFC 8215 local-use NAT64
    "::ffff:0:7f00:1", // SIIT IPv4-translated
    "fec0::1", // deprecated site-local
    "100::1", // discard-only
  ];
  for (const a of cases) it(`${a} is refused`, () => expect(isForbiddenAddress(a)).toBe(true));
  it("control: a global unicast IPv6 and an IPv4-compatible public address still pass", () => {
    expect(isForbiddenAddress("2606:4700:4700::1111")).toBe(false);
    expect(isForbiddenAddress("::808:808")).toBe(false);
  });
  it("control: the IPv4-mapped form IS refused", () => expect(isForbiddenAddress("::ffff:7f00:1")).toBe(true));
});

describe("R-CONSENT (fixed by R2 F2): an authorize URL built by someone else reaches a same-origin page naming the client before any code exists", () => {
  it("DCR client with the claude.ai callback: authorize asks for the email, and after the emailed code verify renders the HTML consent step with no auth code", async () => {
    process.env.SCRIBE_MCP_OAUTH_DOMAIN_TEST = "example.test";
    fake.addPerson(ALICE);
    const reg = await registerPost(new NextRequest("https://www.evenscribe.app/api/oauth/register", { method: "POST", headers: { "content-type": "application/json", "x-forwarded-for": "203.0.113.9" }, body: JSON.stringify({ redirect_uris: [CLAUDE_CALLBACK], client_name: "anything" }) }));
    expect(reg.status).toBe(201);
    const { client_id } = (await reg.json()) as { client_id: string };
    const q = new URLSearchParams({ response_type: "code", client_id, redirect_uri: CLAUDE_CALLBACK, code_challenge: s256("a".repeat(43)), code_challenge_method: "S256", resource: RESOURCE, state: "attacker-session-state" });
    const res = await authorizeGet(new NextRequest(`https://www.evenscribe.app/api/oauth/authorize?${q}`));
    expect(res.status).toBe(200); // the "enter your email" page, not a redirect to anyone
    const cookie = res.cookies.get("mcp_oauth_pending")!.value;
    const { page, html } = await toConsentFrom(cookie, ALICE);
    expect(page.status).toBe(200);
    expect(page.headers.get("content-type")).toContain("text/html");
    expect(page.headers.get("location")).toBeNull();
    expect(html).toContain("anything (self-registered)");
    expect(html).toContain('<dd data-consent="redirect-host">claude.ai</dd>');
    expect(fake.state.codes.size).toBe(0);
  });
});

describe("R-REFRESH: a refresh token is bound only to a PUBLIC client_id, so a copy works for anyone who presents it first", () => {
  it("a copied esr_ plus the (public) client_id yields a fresh access token; no sender constraint", async () => {
    fake.addPerson(ALICE);
    const refresh = randomToken("esr_");
    await fake.insertToken({ token_hash: hashSecret(refresh), kind: "refresh", email: ALICE, client_id: "https://claude.ai/oauth/claude-code-client-metadata", scopes: ["read"], resource: RESOURCE, family_id: "f_x", ttl_s: 3600 });
    const body = new URLSearchParams({ grant_type: "refresh_token", refresh_token: refresh, client_id: "https://claude.ai/oauth/claude-code-client-metadata" });
    const res = await tokenPost(new NextRequest("https://www.evenscribe.app/api/oauth/token", { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded", "x-forwarded-for": "198.51.100.7" }, body: body.toString() }));
    expect(res.status).toBe(200);
    expect(((await res.json()) as { access_token: string }).access_token.startsWith("esp_")).toBe(true);
  });
});

/**
 * Refuter probes for e4c1406f (cloud-scribe-oauth). Each `it` documents CURRENT behaviour that the refute report names as a finding; a test passing here means the finding reproduces.
 * Synthetic addresses at example.test and synthetic secrets only. No network, no database.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { NextRequest } from "next/server";

vi.mock("@/lib/db", () => ({ sql: vi.fn(async () => []) }));
vi.mock("@/lib/mcp/oauth/store", async () => await import("../support/mcp-oauth-fake-store"));

import * as fake from "../support/mcp-oauth-fake-store";
import { GET as authorizeGet } from "@/app/api/oauth/authorize/route";
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
  resetRegisterLimitForTests();
  process.env.SCRIBE_MCP_OAUTH = "on";
  process.env.MCP_OAUTH_TOKEN_PEPPER = "p".repeat(32);
  process.env.GOOGLE_OAUTH_CLIENT_ID = "synthetic-google-client-id";
  process.env.GOOGLE_OAUTH_CLIENT_SECRET = "q".repeat(24);
});
afterEach(() => {
  process.env = { ...ENV };
});

describe("R-SSRF: IPv6 forms that embed or alias IPv4 are not refused by isForbiddenAddress", () => {
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
  for (const a of cases) it(`${a} passes the check (finding)`, () => expect(isForbiddenAddress(a)).toBe(false));
  it("control: the IPv4-mapped form IS refused", () => expect(isForbiddenAddress("::ffff:7f00:1")).toBe(true));
});

describe("R-CONSENT: an authorize URL built by someone else goes straight to Google with no screen naming the client", () => {
  it("DCR client with the claude.ai callback: authorize answers 302 to accounts.google.com directly", async () => {
    const reg = await registerPost(new NextRequest("https://www.evenscribe.app/api/oauth/register", { method: "POST", headers: { "content-type": "application/json", "x-forwarded-for": "203.0.113.9" }, body: JSON.stringify({ redirect_uris: [CLAUDE_CALLBACK], client_name: "anything" }) }));
    expect(reg.status).toBe(201);
    const { client_id } = (await reg.json()) as { client_id: string };
    const q = new URLSearchParams({ response_type: "code", client_id, redirect_uri: CLAUDE_CALLBACK, code_challenge: s256("a".repeat(43)), code_challenge_method: "S256", resource: RESOURCE, state: "attacker-session-state" });
    const res = await authorizeGet(new NextRequest(`https://www.evenscribe.app/api/oauth/authorize?${q}`));
    expect(res.status).toBe(302);
    expect(new URL(res.headers.get("location")!).host).toBe("accounts.google.com");
    expect(res.headers.get("content-type") ?? "").not.toContain("text/html"); // no interstitial
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

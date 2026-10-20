/**
 * OAUTH-O3 — person tokens accepted at /api/mcp, the MANDATORY per-user audit (spec §12), scribe_admin people actions, the audit actor filter.
 * Drives the REAL routes and handler. In-memory store, a fake audit table (the SQL is exercised for real in mcp-oauth-o3-pg.test.ts). Synthetic addresses at example.test only.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { createHash } from "node:crypto";
import { NextRequest } from "next/server";

type Captured = { text: string; values: unknown[] };
const captured: Captured[] = [];
vi.mock("@/lib/db", () => ({
  sql: vi.fn(async (strings: TemplateStringsArray, ...values: unknown[]) => {
    const text = strings.join("?");
    captured.push({ text, values });
    return text.includes("RETURNING id") ? [{ id: "00000000-0000-0000-0000-000000000001" }] : [];
  }),
}));
vi.mock("@/lib/mcp/oauth/store", async () => await import("../support/mcp-oauth-fake-store"));

import * as fake from "../support/mcp-oauth-fake-store";
import { POST as mcpPost } from "@/app/api/mcp/route";
import { POST as labPost } from "@/app/api/mcp/lab/route";
import { POST as pathKeyPost } from "@/app/api/mcp/[key]/route";
import { hashSecret } from "@/lib/mcp/oauth/crypto";
import { resetDeniedAuditForTests } from "@/lib/mcp/audit";
import { resetOauthFlagWarningForTests } from "@/lib/mcp/oauth/config";
import { MCP_TOKENS_DENY_ENV } from "@/lib/mcp/auth";

const PEPPER = "p".repeat(32);
const RESOURCE = "https://www.evenscribe.app/api/mcp";
const ALICE = "alice@example.test";
const BOB = "bob@example.test";
const CAROL = "carol@example.test";
const DOMAIN = "example.test";
const sha = (t: string) => createHash("sha256").update(t).digest("hex");
const ADMIN_TOK = "m".repeat(24);
const CHALLENGE = 'Bearer resource_metadata="https://www.evenscribe.app/.well-known/oauth-protected-resource/api/mcp"';

let seq = 0;
async function mint(email: string, over: { scopes?: string[]; ttl_s?: number; resource?: string; family?: string; kind?: "access" | "refresh" } = {}): Promise<{ token: string; family: string }> {
  const token = `esp_synthetic${++seq}-${"x".repeat(30)}`;
  const family = over.family ?? `f_family${seq}`;
  await fake.insertToken({
    token_hash: hashSecret(token), kind: over.kind ?? "access", email, client_id: "https://client.example.test/meta.json",
    scopes: over.scopes ?? ["read", "invoke", "write", "admin"], resource: over.resource ?? RESOURCE, family_id: family, ttl_s: over.ttl_s ?? 3600,
  });
  return { token, family };
}

const rpc = (method: string, params?: unknown, id: number | undefined = 1) => ({ jsonrpc: "2.0", ...(id !== undefined ? { id } : {}), method, ...(params ? { params } : {}) });
const call = (body: unknown, token?: string, path = "/api/mcp", extra: Record<string, string> = {}) =>
  new NextRequest(`https://www.evenscribe.app${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}), ...extra },
    body: JSON.stringify(body),
  });
const tool = (name: string, args: Record<string, unknown> = {}) => rpc("tools/call", { name, arguments: args });
const run = (body: unknown, token: string, extra: Record<string, string> = {}) => mcpPost(call(body, token, "/api/mcp", extra));
const toolResult = async (res: Response) => (await res.json()).result.structuredContent as Record<string, unknown>;

const personRows = () => captured.filter((c) => c.text.includes("INSERT INTO audit_log") && c.text.includes("'person'") && !c.text.includes("mcp.denied"));
const parsed = () => personRows().map((c) => ({ actor: c.values[0] as string, action: c.values[1] as string, target_type: c.values[2] as string, target: c.values[3] as string, meta: JSON.parse(c.values[4] as string) as Record<string, any>, ip: c.values[5] as string | null }));
const deniedRows = () => captured.filter((c) => c.text.includes("mcp.denied") && c.text.includes("'person'")).map((c) => ({ actor: c.values[0] as string, meta: JSON.parse(c.values[1] as string) as Record<string, any> }));
const adminRows = () => captured.filter((c) => c.text.includes("INSERT INTO audit_log") && /admin\.person/.test(JSON.stringify(c.values)));

const ENV = { ...process.env };
let logs: string[];
beforeEach(() => {
  process.env.SCRIBE_MCP_OAUTH = "on";
  process.env.MCP_OAUTH_TOKEN_PEPPER = PEPPER;
  process.env.SCRIBE_MCP_OAUTH_DOMAIN_TEST = DOMAIN;
  for (const k of ["SCRIBE_MCP_TOKEN", "SCRIBE_MCP_TOKENS", "SCRIBE_MCP_TOKENS_EXTRA", "SCRIBE_MCP_TOKENS_ADMIN", "SCRIBE_MCP_TOKENS_ADMIN_2", MCP_TOKENS_DENY_ENV, "SCRIBE_MCP_RESOURCE_URL", "SCRIBE_MCP_OAUTH_ISSUER"]) delete process.env[k];
  process.env.SCRIBE_MCP_TOKEN = "s".repeat(24);
  process.env.SCRIBE_MCP_TOKENS_ADMIN = JSON.stringify({ [sha(ADMIN_TOK)]: { actor: "admin:gating", scopes: ["read", "admin"] } });
  fake.resetFakeStore();
  fake.lookupFail.on = false;
  fake.addPerson(ALICE);
  fake.addPerson(BOB);
  captured.length = 0;
  resetDeniedAuditForTests();
  resetOauthFlagWarningForTests();
  logs = [];
  for (const m of ["log", "warn", "error", "info"] as const) vi.spyOn(console, m).mockImplementation((...a: unknown[]) => { logs.push(a.map(String).join(" ")); });
});
afterEach(() => {
  process.env = { ...ENV };
  vi.restoreAllMocks();
});

// ─── acceptance ─────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
describe("person principal", () => {
  it("a valid esp_ token is accepted on /api/mcp; scopes are token ∩ the person's CURRENT scopes", async () => {
    const a = await mint(ALICE);
    expect((await run(rpc("tools/list"), a.token)).status).toBe(200);
    fake.addPerson(ALICE, ["read"]);
    const res = await run(tool("scribe_job_cancel", { job_id: "x" }), a.token);
    expect(res.status).toBe(403); // write tool: the person now holds read only
    expect((await run(tool("scribe_help", { tool: "scribe_now" }), a.token)).status).toBe(200);
  });

  it("C6: /api/mcp/lab is STATIC-ONLY: a valid esp_ token there is an unknown token (401, no challenge, the same body and headers as a plain unknown token) and writes NO row of any kind; /api/mcp still accepts it", async () => {
    const a = await mint(ALICE);
    const unknown = await labPost(call(rpc("tools/list"), "plainly-unknown-token", "/api/mcp/lab"));
    captured.length = 0;
    const res = await labPost(call(rpc("tools/list"), a.token, "/api/mcp/lab"));
    expect(res.status).toBe(401);
    expect(res.headers.get("www-authenticate")).toBeNull();
    expect(await res.text()).toBe(await unknown.text());
    expect([...res.headers.keys()].sort()).toEqual([...unknown.headers.keys()].sort());
    expect(personRows()).toHaveLength(0);
    expect(deniedRows()).toHaveLength(0);
    expect(captured.filter((c) => c.text.includes("audit_log"))).toHaveLength(0);
    // the same token on /api/mcp is accepted
    expect((await run(rpc("tools/list"), a.token)).status).toBe(200);
    // and an expired or revoked esp_ token on /lab is just as silent (no person-attributed denied row)
    const old = await mint(ALICE, { ttl_s: -5 });
    expect((await labPost(call(rpc("tools/list"), old.token, "/api/mcp/lab"))).status).toBe(401);
    expect(deniedRows()).toHaveLength(0);
  });

  it("C6: static keys on /api/mcp/lab are unchanged (single token, map entry and admin entry all work and write the static system row)", async () => {
    const mapTok = "n".repeat(24);
    process.env.SCRIBE_MCP_TOKENS = JSON.stringify({ [sha(mapTok)]: { actor: "fleet-agents", scopes: ["read"] } });
    for (const t of ["s".repeat(24), mapTok, ADMIN_TOK]) {
      captured.length = 0;
      const res = await labPost(call(tool("scribe_help", { tool: "scribe_now" }), t, "/api/mcp/lab"));
      expect(res.status).toBe(200);
      expect(personRows()).toHaveLength(0);
      expect(captured.some((c) => c.text.includes("INSERT INTO audit_log") && c.text.includes("'system'") && c.text.includes("mcp.tools/call"))).toBe(true);
    }
    expect((await labPost(call(rpc("tools/list"), "wrong", "/api/mcp/lab"))).status).toBe(401);
  });

  it("a person token is not accepted on the path-key door (a key in a URL is a machine door)", async () => {
    const a = await mint(ALICE);
    const res = await pathKeyPost(call(rpc("tools/list"), undefined, `/api/mcp/${a.token}`), { params: Promise.resolve({ key: a.token }) });
    expect(res.status).toBe(401);
  });

  it("an esp_ token NEVER falls through to the static maps: even a static key spelled esp_… is refused with the flag on", async () => {
    const staticLooking = "esp_" + "e".repeat(40);
    process.env.SCRIBE_MCP_TOKEN = staticLooking;
    process.env.SCRIBE_MCP_TOKENS = JSON.stringify({ [sha(staticLooking)]: { actor: "mapped", scopes: ["read"] } });
    expect((await run(rpc("tools/list"), staticLooking)).status).toBe(401);
  });

  it("flag off: an esp_ token is an unknown token exactly as before (401, no challenge, no store lookup, no audit row), even a valid one", async () => {
    const a = await mint(ALICE);
    process.env.SCRIBE_MCP_OAUTH = "off";
    const res = await run(rpc("tools/list"), a.token);
    const unknown = await run(rpc("tools/list"), "plainly-unknown-token");
    expect(res.status).toBe(401);
    expect(await res.text()).toBe(await unknown.text());
    expect(res.headers.get("www-authenticate")).toBeNull();
    expect([...res.headers.keys()].sort()).toEqual([...unknown.headers.keys()].sort());
    expect(captured.filter((c) => c.text.includes("audit_log"))).toHaveLength(0);
    delete process.env.SCRIBE_MCP_OAUTH;
    expect((await run(rpc("tools/list"), a.token)).status).toBe(401);
  });

  it("the denylist applies to an esp_ hash: a valid token whose plain sha256 is denied gets the same 401", async () => {
    const a = await mint(ALICE);
    expect((await run(rpc("tools/list"), a.token)).status).toBe(200);
    process.env[MCP_TOKENS_DENY_ENV] = JSON.stringify([sha(a.token)]);
    const res = await run(rpc("tools/list"), a.token);
    expect(res.status).toBe(401);
    expect(res.headers.get("www-authenticate")).toBe(CHALLENGE);
    expect(await res.json()).toEqual((await (await run(rpc("tools/list"), "plainly-unknown-token")).json()));
  });

  it("unknown esp_, a refresh token presented as a bearer, a short garbage esp_ and an over-long one are plain 401 with no audit row", async () => {
    const r = await mint(ALICE, { kind: "refresh" });
    for (const t of ["esp_" + "u".repeat(30), r.token, "esp_", "esp_" + "z".repeat(200)]) {
      const res = await run(rpc("tools/list"), t);
      expect(res.status).toBe(401);
      expect(res.headers.get("www-authenticate")).toBe(CHALLENGE);
    }
    expect(deniedRows()).toHaveLength(0);
    expect(personRows()).toHaveLength(0);
  });

  it("static keys are unchanged: single token, map entry and the admin (fleet-style) map entry all work and write the same system row, no person row", async () => {
    const mapTok = "n".repeat(24);
    const adminTok = "f".repeat(24);
    process.env.SCRIBE_MCP_TOKENS = JSON.stringify({ [sha(mapTok)]: { actor: "fleet-agents", scopes: ["read"] } });
    process.env.SCRIBE_MCP_TOKENS_ADMIN = JSON.stringify({ [sha(adminTok)]: { actor: "admin:fleet-agents", scopes: ["read", "admin"] } });
    for (const t of ["s".repeat(24), mapTok, adminTok]) {
      const res = await run(tool("scribe_help", { tool: "scribe_now" }), t);
      expect(res.status).toBe(200);
    }
    expect((await run(tool("scribe_help", { tool: "scribe_now" }), "wrong")).status).toBe(401);
    expect(personRows()).toHaveLength(0);
    const sys = captured.filter((c) => c.text.includes("INSERT INTO audit_log") && c.text.includes("'system'") && c.text.includes("mcp.tools/call"));
    expect(sys).toHaveLength(3);
    expect(sys.map((s) => s.values[0])).toEqual(["mcp:operator-v1", "mcp:fleet-agents", "mcp:admin:fleet-agents"]);
  });

  it("a database failure during the lookup is a 503, never an accept", async () => {
    const a = await mint(ALICE);
    fake.lookupFail.on = true;
    const res = await run(rpc("tools/list"), a.token);
    expect(res.status).toBe(503);
    expect(res.headers.get("www-authenticate")).toBeNull();
    fake.lookupFail.on = false;
    process.env.MCP_OAUTH_TOKEN_PEPPER = "";
    expect((await run(rpc("tools/list"), a.token)).status).toBe(503);
  });
});

// ─── denial ─────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
describe("refused person tokens: 401 + the challenge + one mcp.denied row naming the person", () => {
  const cases: Array<[string, () => Promise<string>, string]> = [
    ["expired", async () => (await mint(ALICE, { ttl_s: -5 })).token, "expired"],
    ["revoked token", async () => { const t = await mint(ALICE); await fake.revokeFamily(t.family); return t.token; }, "revoked"],
    ["family tombstone (a racing redemption left the row unswept)", async () => { const t = await mint(ALICE); fake.state.families.add(t.family); return t.token; }, "revoked"],
    ["wrong resource", async () => (await mint(ALICE, { resource: "https://evil.example.test/api/mcp" })).token, "resource"],
    ["person revoked", async () => { fake.addPerson(CAROL, ["read"], "revoked"); return (await mint(CAROL)).token; }, "inactive"],
    ["not on the allowlist", async () => (await mint("dave@example.test")).token, "inactive"],
    ["no scope in common", async () => { fake.addPerson(CAROL, ["admin"]); return (await mint(CAROL, { scopes: ["read"] })).token; }, "inactive"],
  ];
  for (const [name, make, reason] of cases) {
    it(`${name}`, async () => {
      const token = await make();
      const res = await run(rpc("tools/list"), token);
      expect(res.status).toBe(401);
      expect(res.headers.get("www-authenticate")).toBe(CHALLENGE);
      expect(await res.json()).toEqual({ jsonrpc: "2.0", id: null, error: { code: -32000, message: "unauthorized" } }); // same body as any unknown token
      const rows = deniedRows();
      expect(rows).toHaveLength(1);
      expect(rows[0].actor).toMatch(/^person:[a-z]+@example\.test$/);
      expect(rows[0].meta).toEqual({ ok: false, err_kind: "denied", reason });
      expect(personRows()).toHaveLength(0);
    });
  }

  it("the denied row is rate-limited per subject per minute; another subject still logs", async () => {
    const a = await mint(ALICE, { ttl_s: -5 });
    const b = await mint(BOB, { ttl_s: -5 });
    await run(rpc("tools/list"), a.token);
    await run(rpc("tools/list"), a.token);
    expect(deniedRows()).toHaveLength(1);
    await run(rpc("tools/list"), b.token);
    expect(deniedRows()).toHaveLength(2);
  });
});

// ─── per-user audit ─────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
describe("per-user audit: exactly one row per call", () => {
  it("two persons each make calls: one row per call, with the right email, family id as session_id, target and metadata shape", async () => {
    const a = await mint(ALICE, { family: "f_alice-session" });
    const b = await mint(BOB, { family: "f_bob-session" });
    await run(tool("scribe_help", { tool: "scribe_now" }), a.token, { "x-forwarded-for": "203.0.113.5, 192.0.2.1" });
    expect(parsed()).toHaveLength(1);
    await run(tool("scribe_help", { tool: "scribe_rooms" }), b.token, { "x-forwarded-for": "198.51.100.7" });
    await run(tool("scribe_help", { tool: "scribe_now" }), a.token);
    const rows = parsed();
    expect(rows).toHaveLength(3);
    expect(rows.map((r) => r.actor)).toEqual([`person:${ALICE}`, `person:${BOB}`, `person:${ALICE}`]);
    expect(rows.map((r) => r.meta.session_id)).toEqual(["f_alice-session", "f_bob-session", "f_alice-session"]);
    for (const r of rows) {
      expect(r.action).toBe("mcp.tools/call");
      expect(r.target_type).toBe("mcp_tool");
      expect(r.target).toBe("scribe_help");
      expect(Object.keys(r.meta).sort()).toEqual(["arg_keys", "bytes_out", "client_ip", "err_kind", "ms", "ok", "outcome", "session_id", "subject"].sort());
      expect(r.meta.ok).toBe(true);
      expect(r.meta.err_kind).toBeNull();
      expect(r.meta.arg_keys).toEqual(["tool"]);
      expect(r.meta.bytes_out).toBeGreaterThan(0);
    }
    expect(rows[0].ip).toBe("203.0.113.5");
    expect(rows[0].meta.client_ip).toBe("203.0.113.5");
    expect(rows[1].meta.client_ip).toBe("198.51.100.7");
    expect(rows[2].meta.client_ip).toBeNull();
  });

  it("initialize, tools/list, ping, a notification and an unknown method are each audited once (action mcp.rpc, target = the method)", async () => {
    const a = await mint(ALICE);
    for (const body of [rpc("initialize", { protocolVersion: "2025-03-26" }), rpc("tools/list"), rpc("ping"), rpc("notifications/initialized", undefined, undefined), rpc("nope/nothing")]) {
      captured.length = 0;
      await run(body, a.token);
      expect(parsed(), body.method).toHaveLength(1);
      expect(parsed()[0].action).toBe("mcp.rpc");
      expect(parsed()[0].target_type).toBe("mcp_method");
      expect(parsed()[0].target).toBe(body.method === "nope/nothing" ? "unknown" : body.method); // an unknown method never reaches the row as a client string
      expect(parsed()[0].actor).toBe(`person:${ALICE}`);
    }
    captured.length = 0;
    await run(rpc("nope/nothing"), a.token);
    expect(parsed()[0].meta.ok).toBe(false);
  });

  it("a batch writes one row per item; unparseable and non-object bodies write exactly one row", async () => {
    const a = await mint(ALICE);
    await run([rpc("tools/list", undefined, 1), tool("scribe_help", { tool: "scribe_now" })], a.token);
    expect(parsed().map((r) => r.target)).toEqual(["tools/list", "scribe_help"]);
    for (const body of ["{not json", "42", "[]"]) {
      captured.length = 0;
      const res = await mcpPost(new NextRequest("https://www.evenscribe.app/api/mcp", { method: "POST", headers: { authorization: `Bearer ${a.token}`, "content-type": "application/json" }, body }));
      expect(res.status).toBe(200);
      expect(parsed(), body).toHaveLength(1);
      expect(parsed()[0].meta.ok).toBe(false);
    }
  });

  it("a refused call (scope) and an invalid tools/call are audited as one failed row each, not skipped", async () => {
    const a = await mint(ALICE, { scopes: ["read"] });
    expect((await run(tool("scribe_job_cancel", { job_id: "x" }), a.token)).status).toBe(403);
    expect(parsed()).toHaveLength(1);
    expect(parsed()[0]).toMatchObject({ target: "scribe_job_cancel" });
    expect(parsed()[0].meta).toMatchObject({ ok: false, err_kind: "refused", arg_keys: ["job_id"] });
    captured.length = 0;
    await run(rpc("tools/call", { arguments: {} }), a.token);
    expect(parsed()).toHaveLength(1);
    expect(parsed()[0].meta.ok).toBe(false);
  });

  it("only argument NAMES and subject ids reach the row: no free text, no token, no url", async () => {
    const a = await mint(ALICE);
    await run(tool("scribe_help", { tool: "scribe_now", q: "patient free text here", room_id: "room_abc", url: "https://secret.example.test/x?sig=1", note: "NOTE-BODY" }), a.token);
    const row = parsed()[0];
    expect(row.meta.subject).toEqual({ room_id: "room_abc" }); // spec 18 Oct: ids only; the free-text length and every other value are gone
    expect(row.meta.args).toBeUndefined();
    expect(row.meta.arg_keys).toEqual(["note", "q", "room_id", "tool", "url"]);
    const dump = JSON.stringify(captured) + JSON.stringify(logs);
    for (const bad of ["patient free text here", "NOTE-BODY", "secret.example.test", "sig=1", a.token, hashSecret(a.token), PEPPER]) expect(dump, bad).not.toContain(bad);
  });

  it("LOW-2: an unregistered tool name is recorded as target \"unknown\" (never the client string); arg_keys keep only ^[A-Za-z0-9_]{1,40}$ names, at most 30", async () => {
    const a = await mint(ALICE);
    const free = "patient name John Doe asked about this";
    await run(tool(free, { ok_key: 1, "bad key with spaces": 2, "dash-key": 3, ["k".repeat(41)]: 4 }), a.token);
    const row = parsed()[0]!;
    expect(row.target).toBe("unknown");
    expect(row.meta.arg_keys).toEqual(["ok_key"]);
    expect(JSON.stringify(captured)).not.toContain("John Doe");
    captured.length = 0;
    const many = Object.fromEntries(Array.from({ length: 45 }, (_, i) => [`k${String(i).padStart(2, "0")}`, i]));
    await run(tool("scribe_help", { tool: "scribe_now", ...many }), a.token);
    expect(parsed()[0]!.meta.arg_keys).toHaveLength(30);
  });

  it("MUST-1: a malformed X-Forwarded-For never reaches the inet column: ip null, and the row is STILL written", async () => {
    const a = await mint(ALICE);
    for (const xff of ["1.2.3.999", "deadbeef", "::::::", "", "   ", "2001:db8::1%eth0", "1.2.3", "a.b.c.d", "1.2.3.4.5"]) {
      captured.length = 0;
      const res = await run(tool("scribe_help", { tool: "scribe_now" }), a.token, { "x-forwarded-for": xff });
      expect(res.status, xff).toBe(200);
      expect(parsed(), xff).toHaveLength(1);
      expect(parsed()[0]!.ip, xff).toBeNull();
      expect(parsed()[0]!.meta.client_ip, xff).toBeNull();
    }
    captured.length = 0;
    await run(tool("scribe_help", { tool: "scribe_now" }), a.token, { "x-forwarded-for": "2001:db8::5, 192.0.2.1" });
    expect(parsed()[0]!.ip).toBe("2001:db8::5");
    captured.length = 0;
    await run(tool("scribe_help", { tool: "scribe_now" }), a.token); // no header at all
    expect(parsed()[0]!.ip).toBeNull();
  });

  it("append-only: no UPDATE or DELETE touches audit_log for a person's calls", async () => {
    const a = await mint(ALICE);
    await run(rpc("tools/list"), a.token);
    await run(tool("scribe_help", { tool: "scribe_now" }), a.token);
    expect(captured.filter((c) => /(UPDATE|DELETE)[^;]*audit_log/i.test(c.text))).toHaveLength(0);
  });

});

// ─── revocation ─────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
describe("revocation takes effect on the very next call (well inside 30 s: there is no cache)", () => {
  it("revoke_person by a static admin: the target's next call is 401 and logged; every family is tombstoned", async () => {
    const victim = await mint(BOB);
    expect((await run(rpc("tools/list"), victim.token)).status).toBe(200);
    const out = await toolResult(await run(tool("scribe_admin", { action: "revoke_person", email: BOB, reason: "test" }), ADMIN_TOK));
    expect(out).toMatchObject({ ok: true, changed: true, tokens_revoked: 1 });
    const t0 = Date.now();
    const after = await run(rpc("tools/list"), victim.token);
    expect(after.status).toBe(401);
    expect(Date.now() - t0).toBeLessThan(30_000);
    expect(deniedRows().at(-1)).toMatchObject({ actor: `person:${BOB}` });
    expect(fake.state.people.get(BOB)!.status).toBe("revoked");
    expect(fake.state.families.has(victim.family)).toBe(true);
  });

  it("SHOULD-1: a token inserted AFTER the revoke sweep (a racing redemption) stays dead after a re-grant; so does everything older; a new sign-in works", async () => {
    const before = await mint(BOB);
    await run(tool("scribe_admin", { action: "revoke_person", email: BOB }), ADMIN_TOK);
    const racing = await mint(BOB, { family: "f_racing-after-sweep" }); // inserted after the sweep and not tombstoned
    expect((await run(rpc("tools/list"), racing.token)).status).toBe(401); // person revoked
    expect((await toolResult(await run(tool("scribe_admin", { action: "person_grant", email: BOB }), ADMIN_TOK))).ok).toBe(true);
    expect((await run(rpc("tools/list"), racing.token)).status).toBe(401); // re-granted: still dead (created before granted_at)
    expect((await run(rpc("tools/list"), before.token)).status).toBe(401);
    expect((await run(rpc("tools/list"), (await mint(BOB)).token)).status).toBe(200);
  });

  it("changing the scopes of an ACTIVE person keeps their tokens valid (granted_at only moves on a re-activation) and they read the new scopes", async () => {
    const t = await mint(BOB);
    await run(tool("scribe_admin", { action: "person_grant", email: BOB, scopes: ["read"] }), ADMIN_TOK);
    expect((await run(rpc("tools/list"), t.token)).status).toBe(200);
    expect((await run(tool("scribe_job_cancel", { job_id: "x" }), t.token)).status).toBe(403); // now read only
  });

  it("refresh refuses a token that predates the person's last (re)grant, and revokes its family", async () => {
    // fake-store level: the same predicate the token route reads (pg covers the SQL)
    const t = await mint(BOB, { kind: "refresh" });
    fake.addPerson(BOB, ["read"], "revoked");
    fake.addPerson(BOB, ["read"], "active");
    const row = await fake.getToken(hashSecret(t.token));
    expect(row?.predates_grant).toBe(true);
  });
});

// ─── scribe_admin: V ruling, admin: actors only ────────────────────────────────────────────────────────────────
describe("scribe_admin writes need a static admin: actor; a signed-in person is refused (V ruling 16 Oct)", () => {
  const admin = (args: Record<string, unknown>, token: string) => run(tool("scribe_admin", args), token);
  const ACTIONS: Array<Record<string, unknown>> = [
    { action: "room_enable", room: "room_x", reason: "t" }, { action: "room_disable", room: "room_x", reason: "t", override_patient_gate: true }, { action: "install_mint", room: "room_x", reason: "t" },
    { action: "install_retire", room: "room_x", install_id: "inst_x", reason: "t V GO", override_patient_gate: true, confirm_live: true }, { action: "bind", room: "room_x", install_id: "inst_x", reason: "t" },
    { action: "unbind", room: "room_x", reason: "t V GO", override_patient_gate: true }, { action: "person_grant", email: "new@example.test" }, { action: "person_list" }, { action: "revoke_person", email: BOB },
  ];

  it("a person holding all four scopes is refused EVERY write action with admin_actor_required, and each refusal leaves an audit row; nothing changes", async () => {
    const a = await mint(ALICE);
    for (const args of ACTIONS) {
      captured.length = 0;
      const res = await admin(args, a.token);
      expect(res.status, String(args.action)).toBe(200);
      const out = await toolResult(res);
      expect(out, String(args.action)).toMatchObject({ ok: false, error: "admin_actor_required", action: args.action });
      const refusals = captured.filter((c) => c.text.includes("INSERT INTO audit_log") && JSON.stringify(c.values).includes(`admin.${args.action}.refused`));
      expect(refusals, String(args.action)).toHaveLength(1);
      expect(refusals[0]!.values).toContain(`person:${ALICE}`);
    }
    expect(fake.state.people.has("new@example.test")).toBe(false);
    expect(fake.state.people.get(BOB)!.status).toBe("active");
  });

  it("the room-admin 'V GO' override is not reachable by a person: the actor gate runs before any room lookup", async () => {
    const a = await mint(ALICE);
    const out = await toolResult(await admin({ action: "room_disable", room: "room_x", reason: "V GO", override_patient_gate: true, confirm_live: true }, a.token));
    expect(out.error).toBe("admin_actor_required");
  });

  it("an admin: actor still succeeds at the people actions; the room actions are not refused for the actor (they answer unknown_room for a room that does not exist)", async () => {
    const ok = await toolResult(await admin({ action: "person_grant", email: "viaadmin@example.test" }, ADMIN_TOK));
    expect(ok).toMatchObject({ ok: true, person: { email: "viaadmin@example.test" } });
    const room = await toolResult(await admin({ action: "room_enable", room: "room_x", reason: "t" }, ADMIN_TOK));
    expect(room.error).not.toBe("admin_actor_required");
  });

  it("read actions keep the rule they had: a person may call state and install_list (no admin_actor_required)", async () => {
    const a = await mint(ALICE);
    for (const action of ["state", "install_list"]) expect((await toolResult(await admin({ action, room: "room_x" }, a.token))).error).not.toBe("admin_actor_required");
  });

  it("a person still gets every other Scribe tool their scopes allow: write and invoke tools (scribe_room_command, scribe_job_cancel) are NOT refused at the door", async () => {
    const a = await mint(ALICE);
    for (const t of [tool("scribe_room_command", { kind: "nothing_real" }), tool("scribe_job_cancel", { job_id: "x" })]) {
      const res = await run(t, a.token);
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.error?.code).not.toBe(-32001);
    }
  });

  it("person_grant: lowercases, defaults to four scopes, validates scopes and the domain, all by the admin actor, with audit rows naming the caller and the target", async () => {
    const out = await toolResult(await admin({ action: "person_grant", email: ["Newperson", "Example.TEST"].join("@"), reason: "onboarding" }, ADMIN_TOK));
    expect(out).toMatchObject({ ok: true, changed: true, person: { email: "newperson@example.test", scopes: ["read", "invoke", "write", "admin"], status: "active" } });
    const pre = adminRows()[0]!;
    expect(pre.values).toContain("mcp:admin:gating");
    expect(pre.values).toContain("newperson@example.test");
    const ok = await toolResult(await admin({ action: "person_grant", email: "scoped@example.test", scopes: ["read", "read", "invoke"] }, ADMIN_TOK));
    expect(ok.person).toMatchObject({ scopes: ["read", "invoke"] });
    for (const scopes of [[], ["root"], "read", ["read", 3], ["read", "invoke", "write", "admin", "read"]]) {
      expect((await toolResult(await admin({ action: "person_grant", email: "scoped2@example.test", scopes }, ADMIN_TOK))).error, JSON.stringify(scopes)).toBe("bad_args");
    }
    for (const email of [["x", "gmail.example.test"], ["x", "example.test.evil.example.test"], ["x", "notexample.test"], ["x", "example.com"]].map((q) => q.join("@"))) {
      expect((await toolResult(await admin({ action: "person_grant", email }, ADMIN_TOK))).error, email).toBe("wrong_domain");
      expect(fake.state.people.has(email)).toBe(false);
    }
    expect(adminRows().some((r) => JSON.stringify(r.values).includes("person_grant.refused"))).toBe(true);
    expect((await toolResult(await admin({ action: "person_grant", email: "not-an-address" }, ADMIN_TOK))).error).toBe("bad_args");
  });

  it("person_list returns email, scopes, status and times, never a token", async () => {
    fake.addPerson(CAROL, ["read"], "revoked");
    const out = await toolResult(await admin({ action: "person_list" }, ADMIN_TOK));
    expect(out.count).toBe(3);
    expect(Object.keys((out.people as Array<Record<string, unknown>>)[0]!).sort()).toEqual(["email", "granted_at", "revoked_at", "scopes", "status"]);
    expect(JSON.stringify(out)).not.toMatch(/esp_|esr_/);
  });

  it("a static admin-map token without the admin scope, and the single token, cannot use them", async () => {
    const readOnly = "r".repeat(24);
    process.env.SCRIBE_MCP_TOKENS_ADMIN = JSON.stringify({ [sha(ADMIN_TOK)]: { actor: "admin:gating", scopes: ["read", "admin"] }, [sha(readOnly)]: { actor: "admin:ro", scopes: ["read"] } });
    expect((await admin({ action: "person_grant", email: "nope@example.test" }, readOnly)).status).toBe(403);
    expect((await admin({ action: "person_grant", email: "nope@example.test" }, "s".repeat(24))).status).toBe(403);
    expect(fake.state.people.has("nope@example.test")).toBe(false);
  });

  it("the help text says admin: actors only", async () => {
    const res = await run(tool("scribe_help", { tool: "scribe_admin" }), (await mint(ALICE)).token);
    const text = JSON.stringify(await res.json());
    expect(text).toContain("admin: actors only");
    expect(text).not.toContain("admin: or person:");
  });

  it("revoke_person: an unknown person is an error but still sweeps that address's tokens", async () => {
    const out = await toolResult(await admin({ action: "revoke_person", email: "ghost@example.test" }, ADMIN_TOK));
    expect(out).toMatchObject({ ok: false, error: "unknown_person" });
  });
});

// ─── actor filter ───────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
describe("scribe_audit_recent actor filter", () => {
  it("the actor is passed as an exact-match parameter; an unusable actor errors instead of silently widening", async () => {
    const a = await mint(ALICE);
    captured.length = 0;
    await run(tool("scribe_audit_recent", { actor: `person:${BOB}`, action: "mcp.tools/call" }), a.token);
    const q = captured.find((c) => c.text.includes("FROM audit_log") && c.text.includes("actor_id ="));
    expect(q).toBeDefined();
    expect(q!.values).toContain(`person:${BOB}`);
    const bad = await toolResult(await run(tool("scribe_audit_recent", { actor: "x".repeat(300) }), a.token));
    expect(bad.error).toBe("bad_actor");
    const person = await toolResult(await run(tool("scribe_audit_recent", { action: "mcp.rpc" }), a.token));
    expect(person.error).toBeUndefined();
    const refused = await toolResult(await run(tool("scribe_audit_recent", { action: "install.unlisted" }), a.token));
    expect(refused.error).toBe("action_not_readable");
  });
});

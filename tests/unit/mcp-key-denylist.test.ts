/**
 * KEY-DENYLIST (16 Oct 2026) — SCRIBE_MCP_TOKENS_DENY. Every auth case goes through checkMcpBearer or the path-key door. Synthetic tokens only; the database is a fake.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { createHash } from "node:crypto";

const inserted: Array<{ text: string; values: unknown[] }> = [];
vi.mock("@/lib/db", () => ({ sql: vi.fn(async (strings: TemplateStringsArray, ...values: unknown[]) => { inserted.push({ text: strings.join("?"), values }); return []; }) }));

import { checkMcpBearer, MCP_TOKENS_ADMIN_ENV, MCP_TOKENS_ADMIN_2_ENV, MCP_TOKENS_DENY_ENV, MCP_TOKENS_EXTRA_ENV } from "@/lib/mcp/auth";
import { checkPathKey } from "@/lib/mcp/doors";
import { auditDeniedCall, resetDeniedAuditForTests } from "@/lib/mcp/audit";
import { mcpAuthFailureResponse } from "@/lib/mcp/handler";

const sha = (t: string) => createHash("sha256").update(t).digest("hex");
const req = (token?: string) => new Request("https://x/api/mcp", { headers: token ? { authorization: `Bearer ${token}` } : {} });
const who = (t?: string) => {
  const r = checkMcpBearer(req(t));
  return r.ok ? { actor: r.principal.token_id, scopes: [...r.principal.scopes].sort() } : { fail: r.failure.status };
};
const json = (o: unknown) => JSON.stringify(o);

const ENV = { ...process.env };
let logs: string[];
beforeEach(() => {
  for (const k of ["SCRIBE_MCP_TOKEN", "SCRIBE_MCP_TOKENS", MCP_TOKENS_EXTRA_ENV, MCP_TOKENS_ADMIN_ENV, MCP_TOKENS_ADMIN_2_ENV, MCP_TOKENS_DENY_ENV]) delete process.env[k];
  logs = [];
  inserted.length = 0;
  resetDeniedAuditForTests();
  for (const m of ["log", "warn"] as const) vi.spyOn(console, m).mockImplementation((...a: unknown[]) => { logs.push(a.map(String).join(" ")); });
});
afterEach(() => { process.env = { ...ENV }; vi.restoreAllMocks(); });

describe("SCRIBE_MCP_TOKENS_DENY", () => {
  it("D1: a denied hash is 401 wherever it is listed: primary, EXTRA, ADMIN, ADMIN_2 and the single-token fallback; the other tokens are untouched", () => {
    process.env.SCRIBE_MCP_TOKENS = json({ [sha("d1p")]: { actor: "prim", scopes: ["read"] }, [sha("d1ok")]: { actor: "fine", scopes: ["read", "write"] } });
    process.env[MCP_TOKENS_EXTRA_ENV] = json({ [sha("d1e")]: { actor: "relay", scopes: ["read"] } });
    process.env[MCP_TOKENS_ADMIN_ENV] = json({ [sha("d1a")]: { actor: "admin:one", scopes: ["read", "admin"] } });
    process.env[MCP_TOKENS_ADMIN_2_ENV] = json({ [sha("d1b")]: { actor: "admin:two", scopes: ["read", "admin"] } });
    process.env.SCRIBE_MCP_TOKEN = "d1single";
    for (const t of ["d1p", "d1e", "d1a", "d1b", "d1single"]) expect(who(t), `${t} before`).not.toEqual({ fail: 401 });
    process.env[MCP_TOKENS_DENY_ENV] = json(["d1p", "d1e", "d1a", "d1b", "d1single"].map(sha));
    for (const t of ["d1p", "d1e", "d1a", "d1b", "d1single"]) expect(who(t), t).toEqual({ fail: 401 });
    expect(who("d1ok")).toEqual({ actor: "fine", scopes: ["read", "write"] });
  });
  it("D2: the path-key door is covered, and answers like an unknown key", () => {
    process.env.SCRIBE_MCP_TOKENS = json({ [sha("d2k")]: { actor: "prim", scopes: ["read"] } });
    expect(checkPathKey("d2k").ok).toBe(true);
    process.env[MCP_TOKENS_DENY_ENV] = json([sha("d2k")]);
    const denied = checkPathKey("d2k");
    const unknown = checkPathKey("never-listed");
    expect(denied.ok).toBe(false);
    expect(!denied.ok && denied.failure.status).toBe(401);
    expect(!denied.ok && denied.failure.code).toBe("unauthorized");
    expect(!unknown.ok && unknown.failure.status).toBe(401);
  });
  it("D3: the denylist outranks 'not configured'; hash case is ignored; surrounding spaces are tolerated", () => {
    process.env[MCP_TOKENS_DENY_ENV] = json([` ${sha("d3x").toUpperCase()} `]);
    expect(who("d3x")).toEqual({ fail: 401 }); // nothing configured at all: still the plain 401, not 503
    expect(who("other")).toEqual({ fail: 503 });
  });
  it("D4: unset or blank changes nothing", () => {
    process.env.SCRIBE_MCP_TOKENS = json({ [sha("d4")]: { actor: "prim", scopes: ["read"] } });
    expect(who("d4")).toEqual({ actor: "prim", scopes: ["read"] });
    for (const v of ["", "   ", "[]"]) { process.env[MCP_TOKENS_DENY_ENV] = v; expect(who("d4"), JSON.stringify(v)).toEqual({ actor: "prim", scopes: ["read"] }); }
  });
  it("D5: malformed never disables auth: not JSON, an object, a scalar and a partly-bad array all deny the hash-shaped values they can find", () => {
    process.env.SCRIBE_MCP_TOKENS = json({ [sha("d5a")]: { actor: "a", scopes: ["read"] }, [sha("d5b")]: { actor: "b", scopes: ["read"] }, [sha("d5c")]: { actor: "c", scopes: ["read"] } });
    process.env[MCP_TOKENS_DENY_ENV] = `[not json ${sha("d5a")}`;
    expect(who("d5a")).toEqual({ fail: 401 });
    expect(who("d5b")).toMatchObject({ actor: "b" });
    expect(logs.some((l) => /SCRIBE_MCP_TOKENS_DENY malformed; denying 1 hash-shaped values/.test(l))).toBe(true);
    process.env[MCP_TOKENS_DENY_ENV] = json({ k: sha("d5b") });
    expect(who("d5b")).toEqual({ fail: 401 });
    process.env[MCP_TOKENS_DENY_ENV] = `"${sha("d5c")}"`;
    expect(who("d5c")).toEqual({ fail: 401 });
    // valid array, some bad items: the good ones are denied, the bad ones counted
    logs.length = 0;
    process.env[MCP_TOKENS_DENY_ENV] = json([sha("d5a"), "short", 7, null, sha("d5b").slice(0, 63)]);
    expect(who("d5a")).toEqual({ fail: 401 });
    expect(who("d5b")).toMatchObject({ actor: "b" });
    expect(logs.some((l) => /denying 1 hash, 4 items dropped/.test(l))).toBe(true);
  });
  it("D6: it only removes access: a denied-but-unlisted hash stays 401, and a listed hash keeps its exact scopes while the list names other hashes", () => {
    process.env.SCRIBE_MCP_TOKENS = json({ [sha("d6")]: { actor: "prim", scopes: ["read", "invoke"] } });
    process.env[MCP_TOKENS_DENY_ENV] = json([sha("d6-not-listed"), sha("d6-other")]);
    expect(who("d6-not-listed")).toEqual({ fail: 401 });
    expect(who("d6")).toEqual({ actor: "prim", scopes: ["invoke", "read"] });
    expect(who(undefined)).toEqual({ fail: 401 });
  });
  it("D7: no token and no full hash in any log line, on a clean list, a malformed one and a denied call", () => {
    const tok = "d7-secret-token-value";
    process.env.SCRIBE_MCP_TOKENS = json({ [sha(tok)]: { actor: "prim", scopes: ["read"] } });
    process.env[MCP_TOKENS_DENY_ENV] = json([sha(tok)]);
    who(tok);
    process.env[MCP_TOKENS_DENY_ENV] = `junk ${sha(tok)}`;
    who(tok);
    const all = logs.join("\n");
    expect(all).not.toContain(tok);
    expect(all).not.toContain(sha(tok));
    expect(all).not.toContain(sha(tok).slice(0, 16));
  });
});

describe("the audit row of a denied call", () => {
  it("A1: ONE row, actor denied:<8 hex>, no token and no full hash; the response is the plain 401 an unknown token gets", async () => {
    process.env.SCRIBE_MCP_TOKENS = json({ [sha("a1")]: { actor: "prim", scopes: ["read"] } });
    process.env[MCP_TOKENS_DENY_ENV] = json([sha("a1")]);
    const r = checkMcpBearer(req("a1"));
    expect(r.ok).toBe(false);
    if (r.ok) return;
    const res = mcpAuthFailureResponse(r.failure);
    const unknown = checkMcpBearer(req("a1-unknown"));
    const res2 = mcpAuthFailureResponse((unknown as { ok: false; failure: never }).failure);
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual(await res2.json());
    await Promise.resolve(); await Promise.resolve();
    expect(inserted).toHaveLength(1);
    expect(inserted[0]!.values).toContain(`denied:${sha("a1").slice(0, 8)}`);
    const dump = JSON.stringify(inserted);
    expect(dump).not.toContain("a1-unknown");
    expect(dump).not.toContain(sha("a1"));
    expect(dump).not.toContain(sha("a1").slice(0, 16));
  });
  it("A2: at most one row per hash per minute; another hash gets its own row; after a minute the same hash is written again", async () => {
    const t0 = 1_000_000;
    expect(await auditDeniedCall("aaaaaaaa", t0)).toBe(true);
    expect(await auditDeniedCall("aaaaaaaa", t0 + 59_000)).toBe(false);
    expect(await auditDeniedCall("bbbbbbbb", t0 + 1_000)).toBe(true);
    expect(await auditDeniedCall("aaaaaaaa", t0 + 60_000)).toBe(true);
    expect(await auditDeniedCall("not-hex!", t0 + 200_000)).toBe(false);
    expect(inserted).toHaveLength(3);
  });
  it("A3: an ordinary 401 or 503 writes no denied row", async () => {
    process.env.SCRIBE_MCP_TOKENS = json({ [sha("a3")]: { actor: "prim", scopes: ["read"] } });
    const r = checkMcpBearer(req("nope"));
    if (!r.ok) mcpAuthFailureResponse(r.failure);
    await Promise.resolve();
    expect(inserted).toHaveLength(0);
  });
});

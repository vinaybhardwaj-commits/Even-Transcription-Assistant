/**
 * ADMIN-4 (13 Oct 2026) — the admin scope comes only from SCRIBE_MCP_TOKENS_ADMIN. Every case goes through checkMcpBearer.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { createHash } from "node:crypto";
import { checkMcpBearer, MCP_TOKENS_ADMIN_ENV, MCP_TOKENS_EXTRA_ENV } from "@/lib/mcp/auth";

const sha = (t: string) => createHash("sha256").update(t).digest("hex");
const req = (token?: string) => new Request("https://x/api/mcp", { headers: token ? { authorization: `Bearer ${token}` } : {} });
const who = (t?: string) => {
  const r = checkMcpBearer(req(t));
  return r.ok ? { actor: r.principal.token_id, scopes: [...r.principal.scopes].sort(), rooms: r.principal.rooms, tools: r.principal.tools } : { fail: r.failure.status };
};
const json = (o: unknown) => JSON.stringify(o);

const ENV = { ...process.env };
let logs: string[];
beforeEach(() => {
  for (const k of ["SCRIBE_MCP_TOKEN", "SCRIBE_MCP_TOKENS", MCP_TOKENS_EXTRA_ENV, MCP_TOKENS_ADMIN_ENV]) delete process.env[k];
  logs = [];
  for (const m of ["log", "warn"] as const) vi.spyOn(console, m).mockImplementation((...a: unknown[]) => { logs.push(a.map(String).join(" ")); });
});
afterEach(() => { process.env = { ...ENV }; vi.restoreAllMocks(); });

describe("SCRIBE_MCP_TOKENS_ADMIN", () => {
  it("an admin entry grants read + admin, with no rooms restriction", () => {
    process.env[MCP_TOKENS_ADMIN_ENV] = json({ [sha("adm1")]: { actor: "admin:fable", scopes: ["read", "admin"] } });
    expect(who("adm1")).toEqual({ actor: "admin:fable", scopes: ["admin", "read"], rooms: undefined, tools: undefined });
    expect(who("nope")).toEqual({ fail: 401 });
  });

  it("works ALONE: only the admin env configured is not a 503", () => {
    process.env[MCP_TOKENS_ADMIN_ENV] = json({ [sha("adm1")]: { actor: "admin:x", scopes: ["admin", "read"] } });
    expect(who("other")).toEqual({ fail: 401 });
  });

  it("a primary or EXTRA entry that lists admin does NOT get it; the single-token fallback never has it", () => {
    process.env.SCRIBE_MCP_TOKENS = json({ [sha("p")]: { actor: "fable", scopes: ["read", "write", "admin"] } });
    process.env[MCP_TOKENS_EXTRA_ENV] = json({ [sha("e")]: { actor: "relay", scopes: ["read", "admin"] } });
    process.env.SCRIBE_MCP_TOKEN = "single";
    expect(who("p")).toMatchObject({ actor: "fable", scopes: ["read", "write"] });
    expect(who("e")).toMatchObject({ actor: "extra:relay", scopes: ["read"] });
    expect(who("single")).toMatchObject({ actor: "operator-v1", scopes: ["invoke", "read", "write"] });
  });

  it("a collision with a primary or EXTRA hash grants nothing extra and logs an 8-char prefix only", () => {
    process.env.SCRIBE_MCP_TOKENS = json({ [sha("p")]: { actor: "watcher", scopes: ["read"] } });
    process.env[MCP_TOKENS_EXTRA_ENV] = json({ [sha("e")]: { actor: "relay", scopes: ["read"] } });
    process.env[MCP_TOKENS_ADMIN_ENV] = json({ [sha("p")]: { actor: "admin:a", scopes: ["read", "admin"] }, [sha("e")]: { actor: "admin:b", scopes: ["read", "admin"] } });
    expect(who("p")).toMatchObject({ actor: "watcher", scopes: ["read"] });
    expect(who("e")).toMatchObject({ actor: "extra:relay", scopes: ["read"] });
    const text = logs.join("\n");
    expect(text).toContain(sha("p").slice(0, 8));
    expect(text).not.toContain(sha("p").slice(0, 9));
  });

  it("malformed env grants nothing and every other token still works", () => {
    process.env.SCRIBE_MCP_TOKENS = json({ [sha("p")]: { actor: "watcher", scopes: ["read"] } });
    for (const bad of ["{not json", "[]", "\"x\"", json({ [sha("a")]: "oops" }), json({ short: { actor: "admin:a", scopes: ["admin"] } })]) {
      process.env[MCP_TOKENS_ADMIN_ENV] = bad;
      expect(who("p")).toMatchObject({ actor: "watcher", scopes: ["read"] });
      expect(who("a")).toEqual({ fail: 401 });
    }
  });

  it("write, invoke, an unknown scope, an empty scope list or a non-admin: actor drops the whole entry", () => {
    process.env[MCP_TOKENS_ADMIN_ENV] = json({
      [sha("w")]: { actor: "admin:w", scopes: ["read", "admin", "write"] },
      [sha("i")]: { actor: "admin:i", scopes: ["invoke"] },
      [sha("b")]: { actor: "admin:b", scopes: ["bogus"] },
      [sha("e")]: { actor: "admin:e", scopes: [] },
      [sha("n")]: { actor: "fable", scopes: ["read", "admin"] },
      [sha("o")]: { actor: "admin:", scopes: ["admin"] },
      [sha("ok")]: { actor: "admin:ok", scopes: ["admin"] },
    });
    for (const t of ["w", "i", "b", "e", "n", "o"]) expect(who(t), t).toEqual({ fail: 401 });
    expect(who("ok")).toMatchObject({ actor: "admin:ok", scopes: ["admin"] });
  });

  it("the log line has counts only: no hash, no actor, no token", () => {
    process.env[MCP_TOKENS_ADMIN_ENV] = json({ [sha("a1")]: { actor: "admin:secretname", scopes: ["admin", "read"] }, [sha("a2")]: { actor: "nope", scopes: ["admin"] } });
    who("a1");
    const line = logs.find((l) => l.includes(MCP_TOKENS_ADMIN_ENV))!;
    expect(line).toContain("1 valid admin entry, 1 dropped");
    const all = logs.join("\n");
    expect(all).not.toContain(sha("a1"));
    expect(all).not.toContain("secretname");
    expect(all).not.toContain("a1");
  });
});

describe("ADMIN-4b: collisions are checked against the RAW primary and EXTRA text", () => {
  it("D1: an unreadable primary (which also drops EXTRA) still blocks an admin entry with the same hash", () => {
    process.env.SCRIBE_MCP_TOKENS = "{bad";
    process.env[MCP_TOKENS_EXTRA_ENV] = json({ [sha("d")]: { actor: "relay", scopes: ["read"] } });
    process.env[MCP_TOKENS_ADMIN_ENV] = json({ [sha("d")]: { actor: "admin:y", scopes: ["read", "admin"] } });
    expect("fail" in who("d")).toBe(true); // 503 or 401: either way no admin
  });

  it("D1: a primary entry dropped as invalid still blocks an admin entry with its hash", () => {
    process.env.SCRIBE_MCP_TOKENS = json({ [sha("d")]: { actor: "", scopes: "read" }, [sha("ok")]: { actor: "w", scopes: ["read"] } });
    process.env[MCP_TOKENS_ADMIN_ENV] = json({ [sha("d")]: { actor: "admin:y", scopes: ["read", "admin"] } });
    expect(who("d")).toEqual({ fail: 401 });
    expect(who("ok")).toMatchObject({ actor: "w", scopes: ["read"] });
  });

  it("D2: an admin entry whose actor equals a primary actor is dropped (an EXTRA actor carries extra:, which no valid admin actor can)", () => {
    process.env.SCRIBE_MCP_TOKENS = json({ [sha("p")]: { actor: "admin:fable", scopes: ["read"] } });
    process.env[MCP_TOKENS_EXTRA_ENV] = json({ [sha("e")]: { actor: "relay", scopes: ["read"] } });
    process.env[MCP_TOKENS_ADMIN_ENV] = json({
      [sha("a1")]: { actor: "admin:fable", scopes: ["read", "admin"] },
      [sha("a2")]: { actor: "extra:relay", scopes: ["read", "admin"] },
      [sha("a3")]: { actor: "admin:other", scopes: ["read", "admin"] },
    });
    expect(who("a1")).toEqual({ fail: 401 });
    expect(who("a2")).toEqual({ fail: 401 });
    expect(who("a3")).toMatchObject({ actor: "admin:other", scopes: ["admin", "read"] });
    expect(logs.join("\n")).toContain("1 entry dropped");
    expect(logs.join("\n")).not.toContain("admin:fable");
  });
});

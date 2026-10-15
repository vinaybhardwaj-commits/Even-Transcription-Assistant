/**
 * ADMIN2 (15 Oct 2026) — SCRIBE_MCP_TOKENS_ADMIN_2 backs SCRIBE_MCP_TOKENS_ADMIN. Every case goes through checkMcpBearer. Synthetic tokens only.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { createHash } from "node:crypto";
import { checkMcpBearer, MCP_TOKENS_ADMIN_ENV, MCP_TOKENS_ADMIN_2_ENV, MCP_TOKENS_EXTRA_ENV } from "@/lib/mcp/auth";

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
  for (const k of ["SCRIBE_MCP_TOKEN", "SCRIBE_MCP_TOKENS", MCP_TOKENS_EXTRA_ENV, MCP_TOKENS_ADMIN_ENV, MCP_TOKENS_ADMIN_2_ENV]) delete process.env[k];
  logs = [];
  for (const m of ["log", "warn"] as const) vi.spyOn(console, m).mockImplementation((...a: unknown[]) => { logs.push(a.map(String).join(" ")); });
});
afterEach(() => { process.env = { ...ENV }; vi.restoreAllMocks(); });

describe("SCRIBE_MCP_TOKENS_ADMIN_2", () => {
  it("T1: an ADMIN_2 key gets read + admin and its actor, with ADMIN unset and with ADMIN set", () => {
    process.env[MCP_TOKENS_ADMIN_2_ENV] = json({ [sha("t1b")]: { actor: "admin:two", scopes: ["read", "admin"] } });
    expect(who("t1b")).toEqual({ actor: "admin:two", scopes: ["admin", "read"] });
    process.env[MCP_TOKENS_ADMIN_ENV] = json({ [sha("t1a")]: { actor: "admin:one", scopes: ["read", "admin"] } });
    expect(who("t1a")).toEqual({ actor: "admin:one", scopes: ["admin", "read"] });
    expect(who("t1b")).toEqual({ actor: "admin:two", scopes: ["admin", "read"] });
    expect(who("nope")).toEqual({ fail: 401 });
  });

  it("T2: malformed ADMIN_2 entries are dropped, the others kept", () => {
    process.env.SCRIBE_MCP_TOKENS = json({ [sha("t2p")]: { actor: "watcher", scopes: ["read"] } });
    for (const bad of ["{not json", "[]", json({ nothex: { actor: "admin:a", scopes: ["admin"] } })]) {
      process.env[MCP_TOKENS_ADMIN_2_ENV] = bad;
      expect(who("t2p")).toMatchObject({ actor: "watcher" });
      expect(who("t2a")).toEqual({ fail: 401 });
    }
    process.env[MCP_TOKENS_ADMIN_2_ENV] = json({
      [sha("t2w")]: { actor: "admin:w", scopes: ["read", "admin", "write"] },
      [sha("t2i")]: { actor: "admin:i", scopes: ["invoke"] },
      [sha("t2e")]: { actor: "admin:e", scopes: [] },
      [sha("t2n")]: { actor: "plain", scopes: ["read", "admin"] },
      [sha("t2ok")]: { actor: "admin:ok", scopes: ["admin"] },
    });
    for (const t of ["t2w", "t2i", "t2e", "t2n"]) expect(who(t), t).toEqual({ fail: 401 });
    expect(who("t2ok")).toEqual({ actor: "admin:ok", scopes: ["admin"] });
    expect(who("t2p")).toMatchObject({ actor: "watcher" });
  });

  it("T3: the same hash in ADMIN and ADMIN_2 -> ADMIN wins; the same hash in primary/EXTRA -> ignored", () => {
    process.env.SCRIBE_MCP_TOKENS = json({ [sha("t3p")]: { actor: "watcher", scopes: ["read"] } });
    process.env[MCP_TOKENS_EXTRA_ENV] = json({ [sha("t3e")]: { actor: "relay", scopes: ["read"] } });
    process.env[MCP_TOKENS_ADMIN_ENV] = json({ [sha("t3a")]: { actor: "admin:first", scopes: ["admin"] } });
    process.env[MCP_TOKENS_ADMIN_2_ENV] = json({
      [sha("t3a")]: { actor: "admin:second", scopes: ["read", "admin"] },
      [sha("t3p")]: { actor: "admin:p", scopes: ["read", "admin"] },
      [sha("t3e")]: { actor: "admin:e", scopes: ["read", "admin"] },
    });
    expect(who("t3a")).toEqual({ actor: "admin:first", scopes: ["admin"] });
    expect(who("t3p")).toMatchObject({ actor: "watcher", scopes: ["read"] });
    expect(who("t3e")).toMatchObject({ actor: "extra:relay", scopes: ["read"] });
  });

  it("T4: an ADMIN_2 entry with an ADMIN actor id is dropped, others kept", () => {
    process.env[MCP_TOKENS_ADMIN_ENV] = json({ [sha("t4a")]: { actor: "admin:same", scopes: ["admin"] } });
    process.env[MCP_TOKENS_ADMIN_2_ENV] = json({
      [sha("t4b")]: { actor: "admin:same", scopes: ["read", "admin"] },
      [sha("t4c")]: { actor: "admin:diff", scopes: ["read", "admin"] },
    });
    expect(who("t4b")).toEqual({ fail: 401 });
    expect(who("t4c")).toEqual({ actor: "admin:diff", scopes: ["admin", "read"] });
    expect(logs.join("\n")).toContain("1 entry dropped");
  });

  it("T4b: an ADMIN_2 entry whose actor equals a primary actor is dropped by the merge", () => {
    process.env.SCRIBE_MCP_TOKENS = json({ [sha("t4p")]: { actor: "admin:prim", scopes: ["read"] } });
    process.env[MCP_TOKENS_ADMIN_2_ENV] = json({ [sha("t4q")]: { actor: "admin:prim", scopes: ["read", "admin"] } });
    expect(who("t4q")).toEqual({ fail: 401 });
  });

  it("T5: unset, blank or whitespace ADMIN_2 changes nothing: same principals, same console output", async () => {
    const run = async (admin2: string | undefined) => {
      vi.resetModules();
      const mod = await import("@/lib/mcp/auth");
      logs.length = 0;
      process.env.SCRIBE_MCP_TOKENS = json({ [sha("t5p")]: { actor: "watcher", scopes: ["read"] } });
      process.env[MCP_TOKENS_EXTRA_ENV] = json({ [sha("t5e")]: { actor: "relay", scopes: ["read"] } });
      process.env[MCP_TOKENS_ADMIN_ENV] = json({ [sha("t5a")]: { actor: "admin:a", scopes: ["admin"] }, [sha("t5p")]: { actor: "admin:c", scopes: ["admin"] }, [sha("t5x")]: { actor: "bad", scopes: ["admin"] } });
      if (admin2 === undefined) delete process.env[MCP_TOKENS_ADMIN_2_ENV]; else process.env[MCP_TOKENS_ADMIN_2_ENV] = admin2;
      const out = ["t5p", "t5e", "t5a", "t5x", "zzz"].map((t) => {
        const r = mod.checkMcpBearer(req(t));
        return r.ok ? { a: r.principal.token_id, s: [...r.principal.scopes].sort() } : { f: r.failure.status };
      });
      return { out, logs: [...logs] };
    };
    const base = await run(undefined);
    expect(await run("")).toEqual(base);
    expect(await run("  \n ")).toEqual(base);
    expect(base.logs.join("\n")).not.toContain(MCP_TOKENS_ADMIN_2_ENV);
  });

  it("T6: ADMIN_2 log lines carry counts / an 8-char prefix only", () => {
    process.env[MCP_TOKENS_ADMIN_ENV] = json({ [sha("t6a")]: { actor: "admin:alpha", scopes: ["admin"] } });
    process.env[MCP_TOKENS_ADMIN_2_ENV] = json({
      [sha("t6a")]: { actor: "admin:beta", scopes: ["admin"] },
      [sha("t6b")]: { actor: "admin:alpha", scopes: ["admin"] },
      [sha("t6c")]: { actor: "nope", scopes: ["admin"] },
    });
    who("t6a");
    const all = logs.join("\n");
    expect(all).toContain(`${MCP_TOKENS_ADMIN_2_ENV}: 2 valid admin entries, 1 dropped`);
    expect(all).toContain(sha("t6a").slice(0, 8));
    expect(all).not.toContain(sha("t6a").slice(0, 9));
    for (const s of [sha("t6b"), "alpha", "beta", "t6b", "t6c"]) expect(all).not.toContain(s);
  });

  it("F1: a hash that is an INVALID entry in ADMIN still blocks the same hash in ADMIN_2", () => {
    process.env[MCP_TOKENS_ADMIN_ENV] = json({ [sha("f1h")]: { actor: "admin:bad", scopes: ["read", "write"] }, [sha("f1ok")]: { actor: "admin:ok", scopes: ["admin"] } });
    process.env[MCP_TOKENS_ADMIN_2_ENV] = json({ [sha("f1h")]: { actor: "admin:two", scopes: ["read", "admin"] } });
    expect(who("f1h")).toEqual({ fail: 401 });
    expect(who("f1ok")).toEqual({ actor: "admin:ok", scopes: ["admin"] });
    const all = logs.join("\n");
    expect(all).toContain(`${MCP_TOKENS_ADMIN_2_ENV}: entry ${sha("f1h").slice(0, 8)}`);
    expect(all).not.toContain(sha("f1h").slice(0, 9));
  });

  it("F2: ADMIN set but not a JSON object ignores ADMIN_2 whole; ADMIN unset or blank lets it apply", () => {
    process.env.SCRIBE_MCP_TOKENS = json({ [sha("f2p")]: { actor: "watcher", scopes: ["read"] } });
    process.env[MCP_TOKENS_ADMIN_2_ENV] = json({ [sha("f2k")]: { actor: "admin:two", scopes: ["read", "admin"] } });
    for (const bad of ["not json", "[]", "\"x\"", "42"]) {
      process.env[MCP_TOKENS_ADMIN_ENV] = bad;
      expect(who("f2k"), bad).toEqual({ fail: 401 });
      expect(who("f2p")).toMatchObject({ actor: "watcher" });
    }
    expect(logs.join("\n")).toContain(`${MCP_TOKENS_ADMIN_ENV} is not a readable object; ignoring all 1 entry in ${MCP_TOKENS_ADMIN_2_ENV}`);
    delete process.env[MCP_TOKENS_ADMIN_ENV];
    expect(who("f2k")).toEqual({ actor: "admin:two", scopes: ["admin", "read"] });
    process.env[MCP_TOKENS_ADMIN_ENV] = "  ";
    expect(who("f2k")).toEqual({ actor: "admin:two", scopes: ["admin", "read"] });
  });

  it("F3: ADMIN_2 entries blocked by primary/EXTRA name ADMIN_2 (8-char prefix, counts), never ADMIN", () => {
    process.env.SCRIBE_MCP_TOKENS = json({ [sha("f3p")]: { actor: "admin:prim", scopes: ["read"] } });
    process.env[MCP_TOKENS_EXTRA_ENV] = json({ [sha("f3e")]: { actor: "relay", scopes: ["read"] } });
    process.env[MCP_TOKENS_ADMIN_2_ENV] = json({
      [sha("f3p")]: { actor: "admin:a", scopes: ["admin"] },
      [sha("f3q")]: { actor: "admin:prim", scopes: ["admin"] },
      [sha("f3s")]: { actor: "admin:prim", scopes: ["admin"] },
      [sha("f3r")]: { actor: "admin:fine", scopes: ["admin"] },
    });
    expect(who("f3p")).toMatchObject({ scopes: ["read"] });
    expect(who("f3q")).toEqual({ fail: 401 });
    expect(who("f3r")).toEqual({ actor: "admin:fine", scopes: ["admin"] });
    const all = logs.join("\n");
    expect(all).toContain(`${MCP_TOKENS_ADMIN_2_ENV}: entry ${sha("f3p").slice(0, 8)} collides with a primary/extra token`);
    expect(all).toContain(`${MCP_TOKENS_ADMIN_2_ENV}: 2 entries dropped: the actor equals a primary/extra actor`);
    expect(all).not.toContain(sha("f3p").slice(0, 9));
    expect(logs.filter((l) => l.includes(`${MCP_TOKENS_ADMIN_ENV}:`))).toEqual([]);
  });
});

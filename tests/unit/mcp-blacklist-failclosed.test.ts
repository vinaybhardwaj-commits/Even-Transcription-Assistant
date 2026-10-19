/** R7: N4 the blacklist lookup fails closed on a database error (grant refused, nothing written); N12 the env denylist source is wired into the script's realSources via main(). Mocked sql, synthetic addresses. */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";

type Call = { text: string; values: unknown[] };
const H = vi.hoisted(() => ({ calls: [] as Array<{ text: string; values: unknown[] }>, handler: (async () => []) as (t: string, v: unknown[]) => Promise<unknown[]> }));
vi.mock("@/lib/db", () => ({ sql: (s: TemplateStringsArray, ...v: unknown[]) => { const text = s.join("?"); H.calls.push({ text, values: v }); return H.handler(text, v); } }));

const S = await import("@/lib/mcp/oauth/store");
const { main } = await import("../../scripts/blacklist-from-revocations");
const { MCP_TOKENS_DENY_ENV } = await import("@/lib/mcp/auth");

const E = "r7.n4@example.test";
const wrote = (c: Call[]) => c.filter((x) => /\b(INSERT|UPDATE|DELETE)\b/i.test(x.text));

beforeEach(() => { H.calls = []; H.handler = async () => []; S.resetGrantRefusalLogForTests(); delete process.env[MCP_TOKENS_DENY_ENV]; });

describe("N4 blacklist lookup fails closed", () => {
  it("a database error on the mcp_identity lookup refuses the grant and writes nothing", async () => {
    H.handler = async (t) => { if (t.includes("mcp_identity")) throw Object.assign(new Error("connection reset"), { code: "08006" }); return []; };
    await expect(S.grantPerson(E, ["read"], "t")).rejects.toThrow("connection reset");
    expect(wrote(H.calls)).toEqual([]);
    await expect(S.addressBlacklisted(E)).rejects.toThrow();
  });
  it("only a missing mcp_identity table counts as 'no blacklist'", async () => {
    H.handler = async (t) => { if (t.includes("mcp_identity")) throw Object.assign(new Error('relation "mcp_identity" does not exist'), { code: "42P01" }); if (/INSERT INTO mcp_person/.test(t)) return [{ email: E, scopes: ["read"], status: "active", granted_at: "x", revoked_at: null, previous_status: null }]; return []; };
    expect(await S.addressBlacklisted(E)).toBe(false);
  });
  it("a blacklisted row refuses the grant, writing only the counted refusal audit row", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    H.handler = async (t) => (t.includes("mcp_identity") ? [{ x: 1 }] : []);
    await expect(S.grantPerson(E, ["read"], "t")).rejects.toThrow("blacklisted");
    const w = wrote(H.calls);
    expect(w).toHaveLength(1);
    expect(w[0]!.text).toContain("audit_log");
    expect(H.calls.some((c) => c.text.includes("mcp_person"))).toBe(false);
  });
});

describe("N12 env denylist source is wired into realSources", () => {
  const root = mkdtempSync(`${tmpdir()}/r7-n12-`);
  const repo = `${root}/repo`; const outside = `${root}/out`; mkdirSync(repo); mkdirSync(outside);
  const run = async (argv: string[]) => { const lines: string[] = []; const err = vi.spyOn(console, "error").mockImplementation((...a) => { lines.push(a.join(" ")); }); try { return { code: await main(argv, undefined, repo, (s) => lines.push(s)), lines }; } finally { err.mockRestore(); } };
  it("main() with the default sources reads SCRIBE_MCP_TOKENS_DENY hashes, joins them to mcp_key, and unions the result with the db source", async () => {
    const hash = "ab".repeat(32);
    process.env[MCP_TOKENS_DENY_ENV] = JSON.stringify([hash]);
    H.handler = async (t, v) => {
      if (t.includes("FROM mcp_key WHERE key_hash")) { expect(JSON.stringify(v)).toContain(hash); return [{ email: "r7.env@example.test" }, { email: "r7.env2@example.test" }]; }
      if (t.includes("FROM mcp_person")) return [{ email: "r7.db@example.test" }];
      return [];
    };
    expect(await run(["--dry-count"])).toEqual({ code: 0, lines: ["db=1 env=2 union=3 rejected=0"] });
    const f = `${outside}/n12.json`;
    const w = await run([f]);
    expect(w).toEqual({ code: 0, lines: ["db=1 env=2 addresses=3"] });
    expect(JSON.parse(readFileSync(f, "utf8"))).toEqual(["r7.db@example.test", "r7.env2@example.test", "r7.env@example.test"]);
  });
});

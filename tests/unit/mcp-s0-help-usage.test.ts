/**
 * Operator MCP S0.7 / S0.8 (8 Oct 2026) — scribe_help reads the registry; scribe_usage reads
 * audit_log through bound parameters. `sql` is mocked; nothing here touches a database.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

type Row = Record<string, unknown>;
const sqlCalls: Array<{ text: string; values: unknown[] }> = [];
let sqlResults: unknown[][] = [];
let sqlFail = false;

vi.mock("@/lib/db", () => {
  const sql = (strings: TemplateStringsArray, ...values: unknown[]) => {
    sqlCalls.push({ text: strings.join("?").replace(/\s+/g, " ").trim(), values });
    if (sqlFail) return Promise.reject(new Error("neon down"));
    // each usage query is matched by shape, so Promise.all ordering does not matter
    const text = strings.join("?");
    if (/count\(\*\)::int AS n/.test(text)) return Promise.resolve(sqlResults[2] ?? []);
    if (/GROUP BY actor_id/.test(text)) return Promise.resolve(sqlResults[1] ?? []);
    if (/GROUP BY target_id/.test(text)) return Promise.resolve(sqlResults[0] ?? []);
    return Promise.resolve([]);
  };
  sql.transaction = async () => [];
  return { sql, db: {} };
});

const S = await import("@/lib/mcp/surface");
const { closestNames } = await import("@/lib/mcp/tools/meta");
const ctx = { origin: "https://x", actor: "mcp:test", scopes: new Set(["read"] as const) };
const run = (name: string, args: Row = {}) => S.CALLABLE_TOOLS.get(name)!.handler(args, ctx as never) as Promise<Row>;

beforeEach(() => {
  sqlCalls.length = 0;
  sqlResults = [];
  sqlFail = false;
});

describe("registration", () => {
  it("scribe_help and scribe_usage are listed, read scope, ungrouped", () => {
    for (const n of ["scribe_help", "scribe_usage"]) {
      const t = S.LISTED_TOOLS.find((x) => x.name === n);
      expect(t, n).toBeDefined();
      expect(t!.scope).toBe("read");
      expect(S.GROUPS.some((g) => S.groupMembers(g).includes(n))).toBe(false);
    }
  });
});

describe("S0.7 scribe_help", () => {
  it("an ungrouped tool: name, scope, full description, input schema; no DB", async () => {
    const out = await run("scribe_help", { tool: "scribe_audit_recent" });
    const real = S.CALLABLE_TOOLS.get("scribe_audit_recent")!;
    expect(out).toMatchObject({ name: "scribe_audit_recent", scope: "read", listed_in: ["operator", "lab"], description: expect.any(String), help: real.description, input_schema: real.inputSchema });
    // S3: the operator list carries the short text; the long text is `help`.
    expect((out.description as string).length).toBeLessThanOrEqual(200);
    expect(out.group).toBeUndefined();
    expect(sqlCalls).toHaveLength(0);
  });

  it("a selector group: selector key, accepted legacy names, one row per value with the member it runs", async () => {
    const out = await run("scribe_help", { tool: "scribe_rooms" });
    expect(out.name).toBe("scribe_rooms");
    expect(out.scope).toBe("read");
    expect(out.help).toBe(S.CALLABLE_TOOLS.get("scribe_rooms")!.description); // S3: long text moved to help
    expect((out.description as string).length).toBeLessThanOrEqual(400);
    expect(out.accepted_legacy_names).toEqual(expect.arrayContaining(["scribe_list_rooms", "scribe_fleet", "scribe_day_report"]));
    const m = out.members as { selector: string; values: Array<{ value: string; runs: string; meaning: string }> };
    expect(m.selector).toBe("view");
    expect(m.values.map((v) => v.value)).toEqual(["list", "now", "fleet", "day_report", "clusters"]);
    expect(m.values.find((v) => v.value === "list")).toMatchObject({ runs: "scribe_list_rooms" });
    for (const v of m.values) {
      expect(v.meaning.length).toBeGreaterThan(0);
      expect(v.meaning.length).toBeLessThanOrEqual(160);
    }
  });

  it("an id-routed group has no selector and gives example arguments instead", async () => {
    const out = await run("scribe_help", { tool: "scribe_encounter" });
    const m = out.members as { selector: string | null; values: Array<{ example_args?: Row }> };
    expect(m.selector).toBeNull();
    expect(m.values.every((v) => v.example_args !== undefined)).toBe(true);
  });

  it("an old name a group now fronts answers as itself and names its group", async () => {
    const out = await run("scribe_help", { tool: "scribe_list_rooms" });
    expect(out).toMatchObject({ name: "scribe_list_rooms", group: "scribe_rooms", listed_in: [] });
  });

  it("an unknown name answers unknown_tool with five suggestions, closest first", async () => {
    const out = await run("scribe_help", { tool: "scribe_roms" });
    expect(out.error).toBe("unknown_tool");
    const s = out.suggestions as string[];
    expect(s).toHaveLength(5);
    expect(s[0]).toBe("scribe_rooms");
    expect(s.every((n) => S.CALLABLE_TOOLS.has(n))).toBe(true);
  });

  it("a missing tool argument is named, not a crash", async () => {
    expect(await run("scribe_help", {})).toEqual({ error: "tool_required", suggestions: [] });
  });

  it("closestNames never returns more than n or a duplicate", () => {
    const r = closestNames("usage", [...S.CALLABLE_TOOLS.keys()]);
    expect(r).toHaveLength(5);
    expect(new Set(r).size).toBe(5);
    expect(r).toContain("scribe_usage");
  });
});

describe("S0.8 scribe_usage", () => {
  it("shapes rows: numbers from strings, error_rate, variant only when present, actors list", async () => {
    sqlResults = [
      [
        { tool: "scribe_rooms", variant: "scribe_fleet", calls: 10, errors: "2", p50_ms: "120.04", p95_ms: "900", max_ms: "1500.55", actors: ["mcp:a", "mcp:b"] },
        { tool: "scribe_health", variant: "", calls: 3, errors: 0, p50_ms: "5", p95_ms: "6", max_ms: "7", actors: ["mcp:a"] },
      ],
      [{ actor: "mcp:a", calls: 8 }, { actor: "mcp:b", calls: 5 }],
      [{ n: 13 }],
    ];
    const out = await run("scribe_usage", {});
    expect(out.since_hours).toBe(24);
    expect(out.total).toBe(13);
    expect(out.per_tool).toEqual([
      { tool: "scribe_rooms", variant: "scribe_fleet", calls: 10, errors: 2, error_rate: 0.2, p50_ms: 120, p95_ms: 900, max_ms: 1500.6, actors: ["mcp:a", "mcp:b"] },
      { tool: "scribe_health", calls: 3, errors: 0, error_rate: 0, p50_ms: 5, p95_ms: 6, max_ms: 7, actors: ["mcp:a"] },
    ]);
    expect(out.per_actor).toEqual([{ actor: "mcp:a", calls: 8 }, { actor: "mcp:b", calls: 5 }]);
  });

  it("binds hours and tool as parameters (never interpolated), caps hours at 336, caps rows at 100", async () => {
    const hostile = "x'; DROP TABLE audit_log; --";
    await run("scribe_usage", { since_hours: 99999, tool: hostile });
    expect(sqlCalls).toHaveLength(3);
    for (const c of sqlCalls) {
      expect(c.text).not.toContain("DROP TABLE");
      expect(c.text).toContain("action = 'mcp.tools/call'");
      expect(c.values).toContain(336);
      expect(c.values).toContain(hostile);
    }
    expect(sqlCalls[0]!.values).toContain(100);
  });

  it("defaults to 24 hours and a NULL tool filter; floors at 1 hour", async () => {
    await run("scribe_usage", {});
    expect(sqlCalls[0]!.values[0]).toBe(24);
    expect(sqlCalls[0]!.values).toContain(null);
    sqlCalls.length = 0;
    const out = await run("scribe_usage", { since_hours: 0 });
    expect(out.since_hours).toBe(1);
  });

  it("a failing query degrades to the empty shape with degraded:true and an error string, never throws", async () => {
    sqlFail = true;
    const out = await run("scribe_usage", { since_hours: 6 });
    expect(out).toMatchObject({ since_hours: 6, total: 0, per_tool: [], per_actor: [], degraded: true });
    expect(out.error).toContain("neon down");
  });
});

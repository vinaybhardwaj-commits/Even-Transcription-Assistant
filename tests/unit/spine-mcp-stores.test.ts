/** Spine S4: the spine tables in scribe_store_stats and scribe_system_map. `sql` is mocked; every statement is recorded and none may write. */
import { describe, it, expect, vi, beforeEach } from "vitest";

const stmts: string[] = [];
let failTable: string | null = null;
vi.mock("@/lib/db", () => {
  const sql = (first: TemplateStringsArray | string) => {
    const text = typeof first === "string" ? first : first.join("?");
    stmts.push(text);
    const m = /FROM (spine_\w+|eta_encounter_windows|encounter_catalog|consult_index)\b/.exec(text);
    if (m && m[1] === failTable) return Promise.reject(new Error("relation missing"));
    return Promise.resolve([{ n: m ? 7 : 0 }]);
  };
  return { sql, db: {} };
});
vi.mock("@/lib/room-access/tool-reads", async (orig) => ({
  ...(await orig<typeof import("@/lib/room-access/tool-reads")>()),
  SQL_CUES_TODAY_SPLIT: "x",
  benchChunkTotals: async () => ({ byState: {}, nBlindExcluded: 0 }),
  benchSessionTotals: async () => ({ total: 0, byStatus: {}, nBlindExcluded: 0 }),
}));
vi.mock("@/lib/brain/db", () => ({ query: async () => ({ rows: [{ live_n: 0, scratch_n: 0 }] }) }));

const { SPINE_STORE_TABLES } = await import("@/lib/mcp/tools/stores");
const S = await import("@/lib/mcp/surface");
const ctx = { origin: "x", actor: "a", scopes: new Set(["read"]) } as never;

beforeEach(() => {
  stmts.length = 0;
  failTable = null;
});

describe("scribe_store_stats spine rows", () => {
  it("lists the seven spine tables and the three missing stores, counts only, no write", async () => {
    expect([...SPINE_STORE_TABLES]).toEqual(expect.arrayContaining(["spine_signal", "spine_encounter", "spine_link", "spine_artefact", "spine_job", "spine_config", "spine_tick", "eta_encounter_windows", "encounter_catalog", "consult_index"]));
    const out = (await S.CALLABLE_TOOLS.get("scribe_store_stats")!.handler({}, ctx)) as { spine_tables: Record<string, number | null> };
    expect(Object.keys(out.spine_tables).sort()).toEqual([...SPINE_STORE_TABLES].sort());
    expect(Object.values(out.spine_tables).every((n) => n === 7)).toBe(true);
    expect(stmts.filter((s) => /\b(INSERT|UPDATE|DELETE|TRUNCATE|DROP|ALTER|CREATE)\b/i.test(s))).toEqual([]);
  });
  it("a missing table is null and does NOT degrade the tool; the other counts survive", async () => {
    failTable = "spine_job";
    const out = (await S.CALLABLE_TOOLS.get("scribe_store_stats")!.handler({}, ctx)) as { spine_tables: Record<string, number | null>; degraded?: boolean; errors?: string[] };
    expect(out.spine_tables.spine_job).toBeNull();
    expect(out.spine_tables.spine_signal).toBe(7);
    expect(out.degraded).toBeUndefined();
    expect(out.errors).toBeUndefined();
  });
});

describe("scribe_system_map", () => {
  it("names the spine tables and the three stores in app_neon", async () => {
    const out = (await S.CALLABLE_TOOLS.get("scribe_system_map")!.handler({ detail: "full" }, ctx)) as { stores: { app_neon: { tables: string[] } } };
    expect(out.stores.app_neon.tables).toEqual(expect.arrayContaining([...SPINE_STORE_TABLES]));
  });
});

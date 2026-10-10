/**
 * tests/unit/jev-brain-pool-allowlist.test.ts — Jev P0 #56 (PRD P0.3): CI fails on ANY new brain-pool read of a table
 * outside the allowlist.
 *
 * The brain pool is role brain_svc. ALLOWED = what 0053/0065 gave it (cue, room_day, visit, speaker_cluster, room) plus
 * exactly what 0144 grants. The scan (tests/support/brain-pool-scan.ts) covers EVERY importer of lib/brain/db and EVERY
 * query call in each, resolving inline templates, SQL_* constants (same file, imported, re-exported) and builder
 * functions; an argument it cannot resolve FAILS, it is never skipped.
 *
 * The mutation tests below edit the sources in memory (nothing on disk) and must each be caught by a NAMED test.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { loadSources, scanBrainPool, tablesIn, importersOfBrainPool, type Sources } from "../support/brain-pool-scan";

const BASE_0053 = ["cue", "room_day", "visit", "speaker_cluster", "room"];
const granted0144 = [...readFileSync("db/migrations/0144_jev_brain_reader_grants.sql", "utf8").matchAll(/GRANT SELECT ON TABLE (\w+) TO brain_svc/g)].map((m) => m[1]);
const ALLOWED = new Set([...BASE_0053, ...granted0144]);

/** Every way the tree can fail the allowlist: a table outside it, or a query the scan cannot read. */
function violations(src: Sources): string[] {
  const r = scanBrainPool(src);
  const out: string[] = [];
  for (const x of r.reads) for (const t of x.tables) if (!ALLOWED.has(t)) out.push(`${x.file} reads ${t}`);
  for (const u of r.unresolved) out.push(`${u.file} has a query the scan cannot resolve: ${u.arg}`);
  return out;
}

const REAL = loadSources();
/** The real tree with `file` extended by `extra` (or a new file). */
const withEdit = (file: string, extra: string, base: Sources = REAL): Sources => ({ ...base, [file]: (base[file] ?? "") + "\n" + extra });

describe("the real tree", () => {
  it("0144 grants exactly the Jev tables the readers need — no room tables (0074's intent)", () => {
    expect([...granted0144].sort()).toEqual(["jev_decision", "jev_window_signal", "jev_window_text"]);
  });

  it("every importer of the brain pool is found, and none of the Jev readers is missing", () => {
    const imp = importersOfBrainPool(REAL);
    for (const f of ["lib/mcp/tools/jev.ts", "lib/mcp/tools/fuse.ts", "lib/room-access/tool-reads.ts", "lib/mcp/tools/stores.ts", "lib/room-access/brain-state.ts"]) expect(imp).toContain(f);
    expect(imp.length).toBeGreaterThanOrEqual(15);
  });

  it("no brain-pool query names a table outside the allowlist, and every query is readable", () => {
    expect(violations(REAL)).toEqual([]);
  });

  it("the scan really reads the queries (not an empty pass)", () => {
    const r = scanBrainPool(REAL);
    const all = new Set(r.reads.flatMap((x) => x.tables));
    for (const t of ["jev_window_signal", "jev_decision", "cue", "visit", "room_day"]) expect(all.has(t), t).toBe(true);
    expect(r.reads.length).toBeGreaterThan(25);
  });
});

describe("mutations the scan must catch (each a NAMED test)", () => {
  it("MA: a new inline brain read of bench_session in a file that is not a Jev reader (stores.ts)", () => {
    const src = withEdit("lib/mcp/tools/stores.ts", "export async function mutantA() { return query(`SELECT id FROM bench_session`); }");
    expect(violations(src)).toContain("lib/mcp/tools/stores.ts reads bench_session");
  });

  it("MB: a SQL_* constant read of jev_role_signal in a pinned Jev file (fuse.ts)", () => {
    const src = withEdit("lib/mcp/tools/fuse.ts", 'const SQL_MUTANT_B = "SELECT window_id FROM jev_role_signal";\nexport async function mutantB() { return query(SQL_MUTANT_B); }');
    expect(violations(src)).toContain("lib/mcp/tools/fuse.ts reads jev_role_signal");
  });

  it("MC: a SECOND brain read of room_turn_speaker next to listJevDecisions (not just queries[0])", () => {
    const src = withEdit("lib/room-access/tool-reads.ts", "export async function mutantC() { return query(`SELECT * FROM room_turn_speaker`); }");
    expect(violations(src)).toContain("lib/room-access/tool-reads.ts reads room_turn_speaker");
  });

  it("MD: an inline read in jev.ts (control)", () => {
    const src = withEdit("lib/mcp/tools/jev.ts", "export async function mutantD() { return query(`SELECT 1 FROM jev_role_signal`); }");
    expect(violations(src)).toContain("lib/mcp/tools/jev.ts reads jev_role_signal");
  });

  it("ME: the room tables 0144 no longer grants are caught again if listJevDecisions joins them back", () => {
    const src = withEdit("lib/room-access/tool-reads.ts", "export async function mutantE() { return query(`SELECT 1 FROM jev_decision d JOIN bench_window w ON w.id = d.subject_id LEFT JOIN room_diarize_window x ON x.window_id = w.id`); }");
    const v = violations(src);
    expect(v).toContain("lib/room-access/tool-reads.ts reads bench_window");
    expect(v).toContain("lib/room-access/tool-reads.ts reads room_diarize_window");
  });

  it("a constant IMPORTED from another module is followed", () => {
    const src: Sources = {
      ...REAL,
      "lib/zz/sqls.ts": 'export const SQL_FAR = "UPDATE bench_chunk SET r2_key = $1";',
      "lib/zz/reader.ts": 'import { query } from "@/lib/brain/db";\nimport { SQL_FAR } from "./sqls";\nexport const f = () => query(SQL_FAR, []);',
    };
    expect(violations(src)).toContain("lib/zz/reader.ts reads bench_chunk");
  });

  it("a constant re-exported through another module (export { } from) is followed", () => {
    const src: Sources = {
      ...REAL,
      "lib/zz/sqls.ts": 'export const SQL_FAR = "SELECT 1 FROM room_turn_speaker";',
      "lib/zz/barrel.ts": 'export { SQL_FAR } from "./sqls";',
      "lib/zz/reader.ts": 'import { query } from "@/lib/brain/db";\nimport { SQL_FAR } from "./barrel";\nexport const f = () => query(SQL_FAR, []);',
    };
    expect(violations(src)).toContain("lib/zz/reader.ts reads room_turn_speaker");
  });

  it("a builder function's SQL is followed", () => {
    const src: Sources = {
      ...REAL,
      "lib/zz/reader.ts": 'import { query } from "@/lib/brain/db";\nfunction build(n: number): string { return "INSERT INTO bench_event (a) VALUES " + n; }\nexport const f = () => query(build(2), []);',
    };
    expect(violations(src)).toContain("lib/zz/reader.ts reads bench_event");
  });

  it("client.query, pool.query and getPool().query are calls too", () => {
    for (const call of ["client.query(", "pool.query(", "getPool().query("]) {
      const src: Sources = { ...REAL, "lib/zz/reader.ts": `import { getPool } from "@/lib/brain/db";\nexport const f = (client: any, pool: any) => ${call}"SELECT 1 FROM bench_event");` };
      expect(violations(src), call).toContain("lib/zz/reader.ts reads bench_event");
    }
  });

  it("a brand-new file importing the brain pool by a RELATIVE path is an importer", () => {
    const src: Sources = { ...REAL, "lib/brain/zz-new.ts": 'import { query } from "./db";\nexport const f = () => query("SELECT 1 FROM bench_event");' };
    expect(violations(src)).toContain("lib/brain/zz-new.ts reads bench_event");
  });

  it("a query the scan cannot resolve FAILS rather than being skipped", () => {
    const src: Sources = { ...REAL, "lib/zz/reader.ts": 'import { query } from "@/lib/brain/db";\nexport const f = (text: string) => query(text, []);' };
    expect(violations(src).some((v) => v.startsWith("lib/zz/reader.ts has a query the scan cannot resolve"))).toBe(true);
  });

  it("a query( inside a comment is not a call; UPDATE/INSERT INTO/DELETE FROM and CTEs are read right", () => {
    const quiet: Sources = { ...REAL, "lib/zz/reader.ts": 'import { query } from "@/lib/brain/db";\n// query(`SELECT 1 FROM bench_event`)\nexport const x = 1;' };
    expect(violations(quiet)).toEqual([]);
    expect(tablesIn("WITH t AS (SELECT 1) SELECT * FROM t JOIN unnest($1::text[]) u ON true")).toEqual([]);
    expect(tablesIn("INSERT INTO visit (id) VALUES ($1)")).toEqual(["visit"]);
    expect(tablesIn("UPDATE visit SET a = 1 WHERE id = $1")).toEqual(["visit"]);
    expect(tablesIn("DELETE FROM cue WHERE id = $1")).toEqual(["cue"]);
  });
});

describe("the brain query is found by BINDING, not by name (delta refute F2)", () => {
  const ZZ = "lib/zz/reader.ts";
  const BAD = "SELECT 1 FROM bench_session";
  const only = (code: string): Sources => ({ ...REAL, [ZZ]: code });
  const caught = (code: string) => expect(violations(only(code))).toContain(`${ZZ} reads bench_session`);

  it("MF: `brainQuery(...)` (query as brainQuery) appended to the REAL lib/admin/rooms-live.ts is caught", () => {
    expect(violations(withEdit("lib/admin/rooms-live.ts", `export async function mutantF() { return brainQuery(\`${BAD}\`); }`))).toContain("lib/admin/rooms-live.ts reads bench_session");
  });
  it("MG: the same in the REAL lib/mcp/tools/bench.ts, with room_turn_speaker", () => {
    expect(violations(withEdit("lib/mcp/tools/bench.ts", "export async function mutantG() { return brainQuery(`SELECT 1 FROM room_turn_speaker`); }"))).toContain("lib/mcp/tools/bench.ts reads room_turn_speaker");
  });
  it("the real rooms-live.ts and bench.ts brain reads are now scanned (they were invisible)", () => {
    const r = scanBrainPool(REAL);
    for (const f of ["lib/admin/rooms-live.ts", "lib/mcp/tools/bench.ts"]) expect(r.reads.filter((x) => x.file === f).length, f).toBeGreaterThanOrEqual(3);
  });

  it("named import under another name", () => caught(`import { query as q } from "@/lib/brain/db";\nexport const f = () => q("${BAD}");`));
  it("named import with a type argument", () => caught(`import { query as q } from "@/lib/brain/db";\nexport const f = () => q<{ id: string }>("${BAD}");`));
  it("namespace import then ns.query", () => caught(`import * as brain from "@/lib/brain/db";\nexport const f = () => brain.query("${BAD}");`));
  it("namespace import then a destructure", () => caught(`import * as brain from "@/lib/brain/db";\nconst { query: q } = brain;\nexport const f = () => q("${BAD}");`));
  it("namespace import then an alias const q = ns.query", () => caught(`import * as brain from "@/lib/brain/db";\nconst q = brain.query;\nexport const f = () => q("${BAD}");`));
  it("alias of an alias (const q2 = q)", () => caught(`import { query } from "@/lib/brain/db";\nconst q1 = query;\nconst q2 = q1;\nexport const f = () => q2("${BAD}");`));
  it("dynamic import destructured: const { query: q } = await import(...)", () => caught(`export async function f() { const { query: q } = await import("@/lib/brain/db"); return q("${BAD}"); }`));
  it("dynamic import as a namespace: const m = await import(...); m.query", () => caught(`export async function f() { const m = await import("@/lib/brain/db"); return m.query("${BAD}"); }`));
  it("require destructure", () => caught(`const { query: q } = require("@/lib/brain/db");\nexport const f = () => q("${BAD}");`));
  it("a barrel: export { query as bq } from the brain module, imported elsewhere", () => {
    const src: Sources = { ...REAL, "lib/zz/barrel.ts": 'export { query as bq } from "@/lib/brain/db";', [ZZ]: `import { bq } from "./barrel";\nexport const f = () => bq("${BAD}");` };
    expect(violations(src)).toContain(`${ZZ} reads bench_session`);
  });
  it("a barrel with export * from, and a re-export chain of two", () => {
    const src: Sources = {
      ...REAL,
      "lib/zz/a.ts": 'export * from "@/lib/brain/db";',
      "lib/zz/b.ts": 'export { query as deep } from "./a";',
      [ZZ]: `import { deep } from "./b";\nexport const f = () => deep("${BAD}");`,
    };
    expect(violations(src)).toContain(`${ZZ} reads bench_session`);
  });
  it("a barrel's namespace: export * as db from, then db.query", () => {
    const src: Sources = { ...REAL, "lib/zz/barrel.ts": 'export * as db from "@/lib/brain/db";', [ZZ]: `import { db } from "./barrel";\nexport const f = () => db.query("${BAD}");` };
    expect(violations(src)).toContain(`${ZZ} reads bench_session`);
  });
  it("a local re-export (import then export { q })", () => {
    const src: Sources = { ...REAL, "lib/zz/barrel.ts": 'import { query as q } from "@/lib/brain/db";\nexport { q as viaLocal };', [ZZ]: `import { viaLocal } from "./barrel";\nexport const f = () => viaLocal("${BAD}");` };
    expect(violations(src)).toContain(`${ZZ} reads bench_session`);
  });
  it("getPool under another name: gp().query and pool.query", () => {
    caught(`import { getPool as gp } from "@/lib/brain/db";\nexport const f = () => gp().query("${BAD}");`);
    caught(`import { getPool as gp } from "@/lib/brain/db";\nexport const f = async () => { const pool = gp(); return pool.query("${BAD}"); };`);
  });

  it("FAILS (unresolved): the binding escapes as a bare value", () => {
    const v = violations(only('import { query as q } from "@/lib/brain/db";\nconst run = (fn: unknown) => fn;\nexport const f = () => run(q);'));
    expect(v.some((x) => x.startsWith(`${ZZ} has a query the scan cannot resolve: q escapes`))).toBe(true);
  });
  it("FAILS (unresolved): a default import of a brain module", () => {
    const src: Sources = { ...REAL, "lib/zz/barrel.ts": 'export * from "@/lib/brain/db";', [ZZ]: 'import everything from "./barrel";\nexport const f = () => everything;' };
    expect(violations(src).some((x) => x.includes("default import everything"))).toBe(true);
  });
  it("FAILS (unresolved): a dynamic import of the brain pool that is not bound to a name", () => {
    expect(violations(only('export async function f() { return (await import("@/lib/brain/db")).query("SELECT 1 FROM cue"); }')).some((x) => x.includes("dynamic import()"))).toBe(true);
  });
  it("does not fail on the word `query` in a message, a comment or a type import", () => {
    expect(violations(only('import { query } from "@/lib/brain/db";\nimport type { PoolClient } from "@/lib/brain/db";\n// query is used below\nexport const f = () => query("SELECT 1 FROM cue", []) && console.warn("marks query failed");'))).toEqual([]);
  });
  it("an unrelated module's own `query` is not the brain pool", () => {
    expect(violations(only('import { query } from "@/lib/db-other";\nexport const f = () => query("SELECT 1 FROM bench_session");'))).toEqual([]);
  });
});

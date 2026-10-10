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

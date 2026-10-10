/**
 * tests/unit/jev-brain-pool-allowlist.test.ts — Jev P0 #56 (PRD P0.3): a static pin on which tables the Jev readers
 * that go through the BRAIN pool (role brain_svc, lib/brain/db) may name.
 *
 * ALLOWED = what 0053/0065 gave brain_svc (cue, room_day, visit, speaker_cluster, room) + exactly what 0144 grants.
 * A new brain-pool read of any other table fails here, instead of failing 42501 in production.
 * Scope: the Jev readers (jev.ts, listJevDecisions, the fuse jev-signals query) — the other `@/lib/brain/db` files
 * mix brain-pool and app-pool statements and are listed in the build report, not pinned here.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";

const BASE_0053 = ["cue", "room_day", "visit", "speaker_cluster", "room"];
const granted0144 = [...readFileSync("db/migrations/0144_jev_brain_reader_grants.sql", "utf8").matchAll(/GRANT SELECT ON TABLE (\w+) TO brain_svc/g)].map((m) => m[1]);
const ALLOWED = new Set([...BASE_0053, ...granted0144]);

const TABLE = /\b(?:FROM|JOIN)\s+([a-z_][a-z_0-9]*)/gi;
const NOT_TABLES = new Set(["unnest", "jsonb_to_recordset"]);
const tables = (sqlText: string) => [...sqlText.matchAll(TABLE)].map((m) => m[1].toLowerCase()).filter((t) => !NOT_TABLES.has(t));

/** The text of every backtick template that follows a brain-pool `query(` / `query<T>(` call in a file, optionally from a marker. */
function brainQueries(file: string, from?: string): string[] {
  let src = readFileSync(file, "utf8");
  if (from) src = src.slice(src.indexOf(from));
  const out: string[] = [];
  for (const m of src.matchAll(/\bquery\s*(?:<[^>]*>)?\s*\(\s*(`[^`]*`)/g)) out.push(m[1]);
  return out;
}

describe("the Jev brain-pool readers name only tables brain_svc can read", () => {
  it("0144 grants exactly the five tables the sweep found", () => {
    expect(granted0144.sort()).toEqual(["bench_window", "jev_decision", "jev_window_signal", "jev_window_text", "room_diarize_window"]);
  });

  const SOURCES: Array<[string, string, string | undefined]> = [
    ["scribe_jev_signals", "lib/mcp/tools/jev.ts", undefined],
    ["scribe_jev_decisions (listJevDecisions)", "lib/room-access/tool-reads.ts", "export async function listJevDecisions"],
    ["fuse jev signals", "lib/mcp/tools/fuse.ts", undefined],
  ];
  it.each(SOURCES)("%s", (_n, file, from) => {
    const queries = brainQueries(file, from);
    expect(queries.length, `no brain-pool query found in ${file}`).toBeGreaterThan(0);
    const named = new Set<string>();
    for (const q of queries) for (const t of tables(q)) named.add(t);
    // listJevDecisions is followed by other (app-pool) readers in the file: only its own first query is the Jev one.
    const jevOnly = from ? tables(queries[0]) : [...named];
    for (const t of jevOnly) expect(ALLOWED.has(t), `${file} reads ${t} through the brain pool, which brain_svc cannot SELECT`).toBe(true);
  });

  it("the allowlist test would catch an ungranted table", () => {
    expect(ALLOWED.has("reb_track_index")).toBe(false);
    expect(tables("SELECT 1 FROM reb_track_index t JOIN room r ON r.id = t.room_id").some((t) => !ALLOWED.has(t))).toBe(true);
  });
});

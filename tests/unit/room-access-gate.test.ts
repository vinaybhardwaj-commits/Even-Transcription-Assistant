/**
 * GUARD — the gate. lib/room-access/ is the ONLY module that runs SQL against the room-data tables or builds / reads an R2 room-audio key. This test FAILS the suite (npm run check:room-access; the deploy build is untouched) if any
 * other file under lib/ or app/ names one of those tables in SQL or writes one of those key prefixes, unless the file is on the pinned allowlist (tests/support/room-access-allowlist.ts: pipeline files, each
 * with its reason and a maximum count of mentions, so a new query in an allowed file fails too).
 */
import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { KEY_PREFIXES, ROOM_TABLES, scanSource, stripComments } from "../support/room-access-scan";
import { ALLOWLIST } from "../support/room-access-allowlist";

const walk = (d: string): string[] => readdirSync(d).flatMap((n) => {
  const p = join(d, n);
  return statSync(p).isDirectory() ? (n === "node_modules" || n === ".next" ? [] : walk(p)) : /\.(ts|tsx)$/.test(n) ? [p] : [];
});
const files = [...walk("lib"), ...walk("app")].filter((f) => !f.startsWith("lib/room-access/"));
const counts = new Map<string, number>();
for (const f of files) { const v = scanSource(f, readFileSync(f, "utf8")); if (v.length) counts.set(f, v.length); }

describe("GUARD — nothing outside lib/room-access/ touches room data", () => {
  it("every file that names a room-data table in SQL, or writes a room-audio key prefix, is on the pinned allowlist", () => {
    const loose = [...counts.entries()].filter(([f, n]) => !ALLOWLIST[f] || n > ALLOWLIST[f]!.max).map(([f, n]) => `${f}: ${n}${ALLOWLIST[f] ? ` (pinned ${ALLOWLIST[f]!.max})` : " (not allowed)"}`);
    expect(loose, "route the SQL / key through lib/room-access/ (or, for a production pipeline file only, add it to tests/support/room-access-allowlist.ts with a reason)").toEqual([]);
  });
  it("the allowlist has no stale entries (a file that no longer names a table is removed from it) and every entry carries a reason", () => {
    for (const [f, a] of Object.entries(ALLOWLIST)) {
      expect(counts.has(f), `${f} is allowlisted but names no room table any more`).toBe(true);
      expect(a.why.length, f).toBeGreaterThan(30);
      expect(a.max, f).toBeGreaterThan(0);
    }
  });
  it("the old module paths are pure re-export shims (no SQL, no key): the code moved, not copied", () => {
    for (const f of files) {
      const src = readFileSync(f, "utf8");
      if (/^\/\/ GUARD: moved to lib\/room-access\//.test(src)) expect(stripComments(src).replace(/export \* from "[^"]+";/g, "").trim(), f).toBe("");
    }
  });
  it("the scanner itself: an injected raw query or key prefix outside the module is flagged, a comment is not, the module's own files are exempt by path", () => {
    expect(scanSource("lib/x.ts", "const r = await sql`SELECT 1 FROM bench_window WHERE id = ${id}`;")).toEqual([{ file: "lib/x.ts", kind: "sql", what: "bench_window", line: 1 }]);
    for (const t of ROOM_TABLES) expect(scanSource("lib/x.ts", `sql\`DELETE FROM ${t} WHERE x\``).length, t).toBe(1);
    for (const t of ROOM_TABLES) expect(scanSource("lib/x.ts", `sql\`INSERT INTO ${t} (a) VALUES (1)\``).length, t).toBe(1);
    for (const p of KEY_PREFIXES) expect(scanSource("lib/x.ts", `const k = \`${p}\${id}\`;`).map((v) => v.kind), p).toEqual(["key"]);
    expect(scanSource("lib/x.ts", "// SELECT * FROM bench_window\n/* JOIN cue c */ const a = 1;")).toEqual([]);
    expect(scanSource("lib/x.ts", "const t = 'bench_window'; // FROM bench_session")).toEqual([]);
  });
  it("G-1: quoted names, schema-qualified names and comma FROM lists are seen (each one, for every table)", () => {
    const forms = (t: string): string[] => [`sql\`SELECT 1 FROM "${t}" x\``, `sql\`SELECT 1 FROM public.${t}\``, `sql\`SELECT 1 FROM "public"."${t}"\``, `sql\`SELECT 1 FROM public . ${t} w\``,
      `sql\`SELECT 1 FROM other_t o, ${t} e WHERE 1=1\``, `sql\`SELECT 1 FROM a, b, "${t}" c\``, `sql\`SELECT 1 FROM (SELECT 1) q, public."${t}" z ORDER BY 1\``,
      `sql\`UPDATE "${t}" SET x = 1\``, `sql\`INSERT INTO public.${t} (a) VALUES (1)\``, `sql\`SELECT 1 FROM a JOIN "${t}" ON true\``, "const q = 'select * from  " + t + "';"];
    for (const t of ROOM_TABLES) for (const f of forms(t)) expect(scanSource("lib/x.ts", f).map((v) => v.what), `${t}: ${f}`).toEqual([t]);
    // a table name that is only part of another identifier, a column, or a value is not a hit
    for (const ok of ["sql`SELECT cue_id FROM cues`", "sql`SELECT 1 FROM bench_window_silence`", "sql`SELECT 1 FROM my_bench_window`", "sql`SELECT cue, bench_window FROM other`", "const x = [cue, bench_window];"]) {
      expect(scanSource("lib/x.ts", ok), ok).toEqual([]);
    }
  });
  it("a synthetic file added to the tree would fail the gate (the assertion above is not vacuous)", () => {
    const fake = scanSource("lib/mcp/tools/new-tool.ts", "const rows = await sql`SELECT * FROM room_turn_speaker`;");
    const loose = fake.filter((v) => !ALLOWLIST[v.file]);
    expect(loose).toHaveLength(1);
  });
});

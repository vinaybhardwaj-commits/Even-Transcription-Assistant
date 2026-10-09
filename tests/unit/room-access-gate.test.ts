/**
 * GUARD — the gate. lib/room-access/ is the ONLY module that runs SQL against the room-data tables or builds / reads an R2 room-audio key. This test FAILS the suite (npm run check:room-access; the deploy build is untouched) if any
 * other file under lib/ or app/ names one of those tables in SQL or writes one of those key prefixes, unless the file is on the pinned allowlist (tests/support/room-access-allowlist.ts: pipeline files, each
 * with its reason and a maximum count of mentions, so a new query in an allowed file fails too).
 */
import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { KEY_PREFIXES, ROOM_TABLES, blankSqlComments, scanSource, stripComments } from "../support/room-access-scan";
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
  it("REL3-FU2 G3-1: tables inside parentheses (derived tables, LATERAL, subqueries in a JOIN, nested) and FROM ONLY are seen, every form for all 17 tables", () => {
    const forms = (t: string): string[] => [
      `sql\`SELECT 1 FROM (SELECT id FROM ${t}) q\``,
      `sql\`SELECT 1 FROM a, LATERAL (SELECT * FROM ${t} c) l\``,
      `sql\`SELECT 1 FROM ONLY ${t}\``,
      `sql\`SELECT 1 FROM a JOIN (SELECT x FROM ${t} WHERE y) x ON true\``,
      `sql\`SELECT 1 FROM a LEFT JOIN LATERAL (SELECT 1 FROM "public"."${t}" z LIMIT 1) l ON true\``,
      `sql\`SELECT 1 FROM (SELECT 1 FROM (SELECT 1 FROM ${t}) q1) q2\``,
      `sql\`WITH c AS (SELECT 1 FROM ${t}) SELECT 1 FROM c\``,
      `sql\`SELECT 1 FROM a WHERE EXISTS (SELECT 1 FROM ${t} z WHERE z.x = a.x)\``,
      `sql\`UPDATE ONLY ${t} SET x = 1\``,
      `sql\`SELECT 1 FROM a JOIN ONLY ${t} ON true\``,
    ];
    for (const t of ROOM_TABLES) for (const f of forms(t)) expect(scanSource("lib/x.ts", f).map((v) => v.what), `${t}: ${f}`).toEqual([t]);
    // the clean twins: a derived table over a non-room table, LATERAL over a look-alike
    for (const ok of ["sql`SELECT 1 FROM (SELECT id FROM other_t) q`", "sql`SELECT 1 FROM a, LATERAL (SELECT * FROM cues c) l`", "sql`SELECT 1 FROM ONLY bench_window_silence`"]) expect(scanSource("lib/x.ts", ok), ok).toEqual([]);
  });
  it("REL3-FU2 F2-1: SQL comments between FROM / JOIN and a table do not hide it; a comment opener inside a SQL string does not eat real SQL", () => {
    for (const t of ROOM_TABLES) {
      for (const f of [`sql\`SELECT 1 FROM /* x */ ${t}\``, `sql\`SELECT 1 FROM -- note\n ${t}\``, `sql\`SELECT 1 FROM /* a */ /* b */ ${t} z\``, `sql\`SELECT 1 FROM a JOIN /* x */ ${t} ON true\``,
        `sql\`SELECT 1 FROM /* outer /* nested */ still comment */ ${t}\``, `sql\`UPDATE /* c */ ${t} SET a = 1\``, `sql\`INSERT INTO -- c\n ${t} (a) VALUES (1)\``,
        `sql\`SELECT 1 FROM a, /* c */ ${t} b\``, `sql\`SELECT 1 FROM (SELECT 1 FROM /* c */ ${t}) q\``]) {
        expect(scanSource("lib/x.ts", f).map((v) => v.what), `${t}: ${f}`).toEqual([t]);
      }
      // comment openers INSIDE SQL strings / quoted identifiers are data: the real FROM after them is still seen
      for (const f of [`sql\`SELECT '/*' AS a FROM ${t} WHERE b = '*/'\``, `sql\`SELECT '--' AS a FROM ${t}\``, `sql\`SELECT "a--b" FROM ${t}\``, `sql\`SELECT 'it''s /* x' AS a FROM ${t}\``]) {
        expect(scanSource("lib/x.ts", f).map((v) => v.what), `${t}: ${f}`).toEqual([t]);
      }
    }
    // a table named ONLY inside a comment is still not a hit
    expect(scanSource("lib/x.ts", "sql`SELECT 1 /* FROM cue */ FROM other_t -- JOIN bench_window`")).toEqual([]);
    // the SQL-aware blanker itself
    expect(blankSqlComments("a /* b */ c -- d\ne")).toBe("a         c     \ne");
    expect(blankSqlComments("'/*' x '*/'")).toBe("'/*' x '*/'");
  });
  it("REL3-FU2 F3: fail closed — a literal with a dollar-quote or an E'..' string that names any gated table fails; the same forms without a gated table pass", () => {
    for (const t of ROOM_TABLES) {
      for (const f of [`sql\`DO $$ BEGIN PERFORM 1 FROM ${t}; END $$\``, `sql\`SELECT $q$ x $q$ || (SELECT count(*) FROM ${t})\``, `sql\`SELECT $tag$${t}$tag$\``,
        "sql(E'SELECT 1 FROM ' || 'x', [])".replace("E'SELECT 1 FROM '", `E'SELECT 1 FROM ${t}'`), `q(e'\\x41 ${t}')`]) {
        expect(scanSource("lib/x.ts", f).map((v) => v.what), `${t}: ${f}`).toContain(t);
      }
    }
    for (const f of ["sql`DO $$ BEGIN PERFORM 1 FROM other_t; END $$`", "q(E'abc\\n')", "sql`SELECT ${x}::int, $1, $2 FROM other_t`", "const s = 'price $5'", "const k = `e'${t}`"]) {
      expect(scanSource("lib/x.ts", f), f).toEqual([]);
    }
    // a plain quoted string ending in the letter e before another literal is not an E-string
    expect(scanSource("lib/x.ts", "f('name', 'cue')")).toEqual([]);
  });
  it("REL3-FU2 F4: the refuter's strings — comment openers hidden in $$ bodies and E'..' strings do not blank the table away", () => {
    const fs = [
      "sql`SELECT $$/*$$ AS a FROM bench_window WHERE b = $$*/$$`",
      "sql`SELECT E'\\\\' /*' AS a FROM bench_window`",
      "sql`SELECT $q$/*$q$ AS a FROM cue WHERE b = $q$*/$q$`",
      "sql`SELECT e'\\\\' /*' AS a FROM jev_window_text`",
    ];
    for (const f of fs) expect(scanSource("lib/x.ts", f).length, f).toBeGreaterThan(0);
    expect(scanSource("lib/x.ts", fs[0]!).map((v) => v.what)).toContain("bench_window");
    expect(scanSource("lib/x.ts", fs[1]!).map((v) => v.what)).toContain("bench_window");
    expect(scanSource("lib/x.ts", fs[2]!).map((v) => v.what)).toContain("cue");
    expect(scanSource("lib/x.ts", fs[3]!).map((v) => v.what)).toContain("jev_window_text");
  });
  it("a synthetic file added to the tree would fail the gate (the assertion above is not vacuous)", () => {
    const fake = scanSource("lib/mcp/tools/new-tool.ts", "const rows = await sql`SELECT * FROM room_turn_speaker`;");
    const loose = fake.filter((v) => !ALLOWLIST[v.file]);
    expect(loose).toHaveLength(1);
  });
});

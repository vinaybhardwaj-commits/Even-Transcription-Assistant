/** spine-prelive C (S3 R4 F-B): the nemotron page picks its rows by pk FIRST and computes `blind` over those rows only. postgres:16, synthetic ids only.
 *  Equality with the old statement on every fixture, a plan-work guard in the A8 style (work linear in the PAGE, not in the table), and the old statement kept verbatim as the negative control. */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { dockerAvailable, pgContainer } from "../support/s1-pg";
import { ROOM_STUBS_SQL } from "../support/spine-room-stubs";
import { blindDaySql, nemotronPageSql } from "@/lib/room-access/readers/spine-artefacts";

const pg = pgContainer("eta-spine-prelive-nem");
const mig = (f: string) => readFileSync(`db/migrations/${f}`, "utf8");
const q1 = (sql: string) => execFileSync("docker", ["exec", "-i", pg.name, "psql", "-qAt", "-v", "ON_ERROR_STOP=1", "-U", "postgres", "-d", "postgres"], { input: sql, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 }).trim();
const PAGE = 2000;
const bind = (sql: string, cursor: string, blind: string[]) => sql.replace("$1", `'${cursor}'`).replace(/\$2::text\[\]/g, `ARRAY[${blind.map((b) => `'${b}'`).join(",")}]::text[]`);
const LINK_WIN = "LEFT JOIN spine_link l ON l.key_kind = 'window_id' AND l.value = s.window_id AND l.active";
const PK_ID = "lpad(s.id::text, 20, '0')";

/** The pre-fix statement, verbatim: the blind subqueries sit in the SELECT list beside ORDER BY/LIMIT, and run for every row of the table. */
function oldNemotronPageSql(limit: number): string {
  const day = blindDaySql("rd.ist_date", "rd.room_id");
  return `SELECT s.id, s.window_id, s.model_rev, s.config_hash, s.payload_sha256, s.status,
      (cardinality($2::text[]) > 0 AND (
        NOT EXISTS (SELECT 1 FROM room_day r0 WHERE r0.id = s.room_day_id)
        OR EXISTS (SELECT 1 FROM room_day rd WHERE ${day} AND (rd.id = s.room_day_id
          OR rd.id IN (SELECT w.room_day_id FROM bench_window w WHERE w.id = s.window_id)
          OR rd.id IN (SELECT dw.room_day_id FROM room_diarize_window dw WHERE dw.window_id = s.window_id))))) AS blind,
      l.encounter_id, ${PK_ID} AS pk
    FROM diarize_nemotron_window s ${LINK_WIN}
    WHERE ${PK_ID} COLLATE "C" > $1 ORDER BY ${PK_ID} COLLATE "C" LIMIT ${limit}`;
}

/** Plan work from EXPLAIN (ANALYZE), no wall clock: rows x loops of every node, plus the rows each scan discarded (per loop, so x loops). */
function cost(sql: string): { work: number; maxJoinFilterRemoved: number } {
  const lines = q1(`EXPLAIN (ANALYZE) ${sql}`).split("\n");
  let work = 0, loops = 1, maxJoinFilterRemoved = 0;
  for (const l of lines) {
    const m = /actual time=\S+ rows=(\d+) loops=(\d+)/.exec(l);
    if (m) { loops = Number(m[2]); work += Number(m[1]) * loops; continue; }
    const d = /Rows Removed by (Join )?Filter: (\d+)/.exec(l);
    if (d) { work += Number(d[2]) * loops; if (d[1]) maxJoinFilterRemoved = Math.max(maxJoinFilterRemoved, Number(d[2])); }
  }
  return { work, maxJoinFilterRemoved };
}
const rowsOf = (sql: string) => q1(`SELECT count(*) || ' ' || md5(coalesce(string_agg(t::text, E'\\n' ORDER BY t.pk COLLATE "C"), '')) FROM (${sql}) t`);

/** n nemotron rows over `days` room days: row g resolves its day by g%5 -> 0 its own room_day_id, 1 via bench_window and 2 via room_diarize_window (own id points at another day), 3 a room_day_id with no room_day row (blind while the set is non-empty), 4 another day only. */
function seed(n: number, days: number) {
  pg.exec(`TRUNCATE diarize_nemotron_window, spine_link, room_day, bench_window, room_diarize_window RESTART IDENTITY;
    INSERT INTO room_day SELECT 'rd_t'||g, DATE '2026-09-01' + (g % 60), CASE WHEN g % 3 = 0 THEN 'rb' ELSE 'r' || (g % 4) END FROM generate_series(1,${days}) g;
    INSERT INTO diarize_nemotron_window (window_id, room_day_id, model, model_rev, config, config_hash, worker_id, machine, audio_ms, payload_sha256, status)
      SELECT 'bw_test_n'||g, CASE g % 5 WHEN 0 THEN 'rd_t'||(g % ${days} + 1) WHEN 3 THEN 'rd_missing'||g ELSE 'rd_t'||((g + 7) % ${days} + 1) END, 'm','r1','{}','aaaa0000x1','w','box',1000, repeat('b',64),'ok' FROM generate_series(1,${n}) g;
    INSERT INTO bench_window (id, room_day_id) SELECT 'bw_test_n'||g, 'rd_t'||(g % ${days} + 1) FROM generate_series(1,${n}) g WHERE g % 5 = 1;
    INSERT INTO room_diarize_window (window_id, room_day_id) SELECT 'bw_test_n'||g, 'rd_t'||(g % ${days} + 1) FROM generate_series(1,${n}) g WHERE g % 5 = 2;
    INSERT INTO spine_encounter (encounter_id, ist_date, room_id, t_open, t_close, status, merge_version) VALUES ('enc_testaaaaaaaaaaaa', '2026-10-19', 'room_a', '2026-10-19T04:00:00Z', '2026-10-19T04:30:00Z', 'confirmed', 'mv1') ON CONFLICT DO NOTHING;
    INSERT INTO spine_link (encounter_id, key_kind, value, basis) SELECT 'enc_testaaaaaaaaaaaa','window_id','bw_test_n'||g,'exact' FROM generate_series(1,${n}) g WHERE g % 2 = 0;
    ANALYZE;`);
}

const d = dockerAvailable() ? describe : describe.skip;
d("prelive C: nemotron page, blind work bounded to the page", () => {
  beforeAll(() => {
    pg.start();
    pg.exec("CREATE TABLE schema_migrations (version integer PRIMARY KEY, name text NOT NULL); CREATE TABLE diarize_window_label (id serial PRIMARY KEY, engine text); " + ROOM_STUBS_SQL);
    for (const f of ["0140_diarize_nemotron.sql", "0173_spine.sql"]) pg.exec(mig(f));
    pg.exec("CREATE INDEX room_diarize_window_wid ON room_diarize_window (window_id);");   // the stub has none; production's window_id is the primary key. Without it the probe is a seq scan whose cost grows with that table, not with the page
  }, 120000);
  afterAll(() => { pg.stop(); });

  it("same rows as the old statement on every fixture: empty and non-empty blind set, first page and mid-table cursors, every way of resolving the day", () => {
    for (const [n, days] of [[40, 7], [300, 25], [5000, 200]] as const) {
      seed(n, days);
      for (const blind of [[], ["2026-09-03|rb"], ["2026-09-03|rb", "2026-09-10|r1", "2026-10-01|rb"]]) {
        for (const cursor of ["", "00000000000000000100", "00000000000000002500", "00000000000000099999"]) {
          const limit = n < 100 ? 7 : PAGE;
          expect(rowsOf(bind(nemotronPageSql(limit), cursor, blind)), `n=${n} blind=${blind.length} cursor=${cursor}`).toBe(rowsOf(bind(oldNemotronPageSql(limit), cursor, blind)));
        }
      }
    }
    seed(300, 25);
    const flagged = (b: string[]) => q1(`SELECT count(*) FROM (${bind(nemotronPageSql(PAGE), "", b)}) t WHERE blind`);
    expect(flagged([])).toBe("0");
    expect(Number(flagged(["2026-09-03|rb"]))).toBeGreaterThan(0);   // the fixtures do exercise the blind branches
    expect(Number(flagged(["2026-09-03|rb"]))).toBeLessThan(300);
  }, 120000);

  it("plan work is linear in the PAGE, not the table: 5k and 20k rows cost the same; a table-wide evaluation of the blind flag is rejected by the same guard", () => {
    const BLIND = ["2026-09-03|rb", "2026-09-10|r1"];
    // Control with teeth: the blind flag computed for EVERY row of the table (a MATERIALIZED CTE over the whole table), then paged. This is the shape F-B described.
    const tableWide = () => `WITH a AS MATERIALIZED (${oldNemotronPageSql(100000000)}) SELECT * FROM a ORDER BY pk COLLATE "C" LIMIT ${PAGE}`;
    const measure = (n: number) => {
      seed(n, 1000);
      return { fixed: cost(bind(nemotronPageSql(PAGE), "", BLIND)), old: cost(bind(oldNemotronPageSql(PAGE), "", BLIND)), wide: cost(bind(tableWide(), "", BLIND)) };
    };
    const small = measure(5000), big = measure(20000);
    console.log(`prelive C plan work: fixed 5k ${JSON.stringify(small.fixed)} 20k ${JSON.stringify(big.fixed)}; old statement as written (the planner already defers its subplans past the LIMIT on postgres:16, so it is NOT flagged) 5k ${JSON.stringify(small.old)} 20k ${JSON.stringify(big.old)}; table-wide control 5k ${JSON.stringify(small.wide)} 20k ${JSON.stringify(big.wide)}`);
    // Bound: a fixed number of plan rows per page row (each blind probe scans the 1000 room_day rows), independent of the table size.
    const WORK_BOUND = 1000 * PAGE;
    expect(big.fixed.work, "fixed 20k: total plan rows").toBeLessThanOrEqual(WORK_BOUND);
    expect(small.fixed.work, "fixed 5k: total plan rows").toBeLessThanOrEqual(WORK_BOUND);
    expect(big.fixed.work, "fixed: 4x the table must not cost 4x").toBeLessThan(small.fixed.work * 1.5);
    expect(big.wide.work > WORK_BOUND || big.wide.work > small.wide.work * 1.5, `the guard failed to flag a table-wide evaluation: ${JSON.stringify({ small: small.wide, big: big.wide })}`).toBe(true);
  }, 180000);
});

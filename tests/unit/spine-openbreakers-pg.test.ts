/**
 * spine-prelive D-1 (R2): the openBreakers CODE change tested on its own, on the schema WITHOUT migration 0177 (this file never reads it), so the code is never untested if 0177 is held back.
 * Verdict equals the old statement on every history, and the read is bounded without any index. The index/rollback test stays with 0177 (spine-tick-breaker-pg.test.ts). postgres:16, synthetic data only.
 * spine_tick is append-only here: every state is made by inserting rows, never by deleting them (a fresh history = a fresh stage name).
 */
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { dockerAvailable, pgContainer } from "../support/s1-pg";

const H = vi.hoisted(() => ({ tag: null as null | ((s: TemplateStringsArray, ...v: unknown[]) => Promise<unknown[]>), seen: [] as string[] }));
vi.mock("@/lib/db", () => ({ sql: async (s: TemplateStringsArray, ...v: unknown[]) => { H.seen.push(s.join("?")); return H.tag!(s, ...v); } }));

import { openBreakers } from "@/lib/spine/jobs";
import { breakerOpen, BREAKER_OPEN_MS } from "@/lib/spine/retry";

const pg = pgContainer("eta-spine-openbrk");
const U173 = readFileSync("db/migrations/0173_spine.sql", "utf8");
const q = async (text: string) => (await pg.sql(Object.assign([text], { raw: [text] }) as unknown as TemplateStringsArray)) as Array<Record<string, unknown>>;

const psql = (text: string): string[] => execFileSync("docker", ["exec", "-i", pg.name, "psql", "-qAt", "-v", "ON_ERROR_STOP=1", "-U", "postgres", "-d", "postgres"], { input: text, encoding: "utf8" }).trim().split("\n");

const NOW = new Date("2026-10-23T06:00:00Z");
const at = (minAgo: number) => new Date(NOW.getTime() - minAgo * 60_000).toISOString();
const tick = (stage: string, minAgo: number, failed: boolean) => `INSERT INTO spine_tick (kind, ticked_at, counts) VALUES ('attempt:${stage}', '${at(minAgo)}', '{"failed": ${failed ? 1 : 0}}');`;

/** The pre-fix statement, verbatim. */
const OLD = (stage: string) => `SELECT CASE WHEN counts->>'failed' = '1' THEN 'failed' ELSE 'done' END AS status, ticked_at AS done_at FROM spine_tick WHERE kind = 'attempt:${stage}' ORDER BY ticked_at DESC, id DESC LIMIT 20`;
const oldOpen = async (stage: string, now: Date) => breakerOpen((await q(OLD(stage))) as unknown as Array<{ status: string; done_at: string }>, now);

/** The statement openBreakers really sent, with its three bound values filled in (kind, kind, since), for EXPLAIN. */
async function sentSql(stage: string, now: Date): Promise<string> {
  H.seen.length = 0;
  await openBreakers([stage], now);
  expect(H.seen.length).toBe(1);
  const vals = [`attempt:${stage}`, `attempt:${stage}`, new Date(now.getTime() - BREAKER_OPEN_MS).toISOString()];
  const parts = H.seen[0]!.split("?");
  expect(parts.length).toBe(vals.length + 1);
  return parts.map((p, i) => p + (i < vals.length ? `'${vals[i]}'` : "")).join("").replace(/::text|::timestamptz/g, "");
}
/** Plan work from EXPLAIN (ANALYZE): rows x loops of every node plus rows each node discarded. No wall clock. */
async function work(sqlText: string): Promise<number> {
  const lines = psql(`EXPLAIN (ANALYZE) ${sqlText}`);
  let w = 0, loops = 1;
  for (const l of lines) {
    const m = /actual time=\S+ rows=(\d+) loops=(\d+)/.exec(l);
    if (m) { loops = Number(m[2]); w += Number(m[1]) * loops; continue; }
    const d = /Rows Removed by (?:Join )?Filter: (\d+)/.exec(l);
    if (d) w += Number(d[1]) * loops;
  }
  return w;
}

const d = dockerAvailable() ? describe : describe.skip;
d("prelive D-1: breaker read bounded to its window (spine_tick)", () => {
  beforeAll(() => {
    pg.start();
    H.tag = pg.sql;
    pg.exec("CREATE TABLE schema_migrations (version integer PRIMARY KEY, name text NOT NULL);");
    pg.exec(U173);
  }, 120000);
  afterAll(() => { pg.stop(); });

  it("same verdict as the old statement on every history: empty, all done, recent failures, the 30-minute edge (+/- 1 s), a failure pushed out of the last 20, a failure dated after `now`", async () => {
    const hist: Record<string, string> = {
      empty: "",
      alldone: Array.from({ length: 25 }, (_, i) => tick("alldone", i, false)).join(""),
      open: Array.from({ length: 10 }, (_, i) => tick("open", i + 1, i < 4)).join(""),
      ratiolow: tick("ratiolow", 5, true) + Array.from({ length: 19 }, (_, i) => tick("ratiolow", i + 6, false)).join(""),
      edgein: tick("edgein", 29.98, true),     // 1.2 s inside the window
      edgeout: tick("edgeout", 30.02, true),   // 1.2 s outside
      edgeexact: tick("edgeexact", 30, true),  // exactly 30 min: not open (now < latest + 30 min is false)
      pushed: tick("pushed", 20, true) + Array.from({ length: 21 }, (_, i) => tick("pushed", 19 - i * 0.9, false)).join(""),
      future: tick("future", -5, true) + tick("future", 3, false),
      oldfailrecentdone: Array.from({ length: 5 }, (_, i) => tick("oldfailrecentdone", 90 + i, true)).join("") + Array.from({ length: 6 }, (_, i) => tick("oldfailrecentdone", i + 1, false)).join(""),
      other: tick("other", 2, true),
    };
    pg.exec(Object.values(hist).join("\n"));
    const seen: Record<string, boolean> = {};
    for (const stage of Object.keys(hist)) {
      const got = (await openBreakers([stage], NOW)).includes(stage);
      expect(got, stage).toBe(await oldOpen(stage, NOW));
      seen[stage] = got;
    }
    // The cases do exercise both verdicts.
    expect(seen.open && seen.edgein && seen.future).toBe(true);
    expect(seen.empty || seen.alldone || seen.edgeout || seen.edgeexact || seen.pushed || seen.ratiolow || seen.oldfailrecentdone).toBe(false);
    expect((await openBreakers(Object.keys(hist), NOW)).sort()).toEqual(Object.keys(seen).filter((k) => seen[k]).sort());
  });

  it("no 0177 anywhere in this file: 300k rows of other kinds and no recent failure cost a bounded number of plan rows; the old statement scans them all (negative control)", async () => {
    pg.exec(`INSERT INTO spine_tick (kind, ticked_at, counts) SELECT 'cron:' || (g % 7), '${at(0)}'::timestamptz - (g || ' seconds')::interval - interval '2 hours', '{}' FROM generate_series(1,300000) g;
      INSERT INTO spine_tick (kind, ticked_at, counts) SELECT 'attempt:big', '${at(0)}'::timestamptz - (g || ' minutes')::interval - interval '31 minutes', '{"failed":0}' FROM generate_series(1,40) g;
      ANALYZE spine_tick;`);
    expect(await q("SELECT 1 FROM pg_indexes WHERE indexname = 'spine_tick_kind_at_idx'")).toEqual([]);
    const fixed = await work(await sentSql("big", NOW));
    const old = await work(OLD("big"));
    console.log(`prelive D plan work, no 0177: bounded ${fixed}, old ${old}`);
    expect(fixed, "bounded read").toBeLessThanOrEqual(2000);
    expect(old > 100000, `the guard failed to flag the old statement: ${old}`).toBe(true);
    expect(await openBreakers(["big"], NOW)).toEqual([]);
    // With a recent failure the last 20 are read, and the verdict is still the old one.
    pg.exec(Array.from({ length: 8 }, (_, i) => tick("big", 8 - i, true)).join("") + tick("big", 0.5, false));   // 8 of the last 20 failed, the newest failure 1 min ago
    expect(await openBreakers(["big"], NOW)).toEqual(["big"]);
    expect(await oldOpen("big", NOW)).toBe(true);
  }, 120000);
});

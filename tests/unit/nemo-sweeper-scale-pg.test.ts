/**
 * nemo-sweeper-scale-pg.test.ts — R3 PROOF of the sweeper's cost, on postgres:16 with every migration. OPT-IN (ETA_SWEEP_SCALE=1): it seeds 30,000
 * windows and 600,000 scribe_job rows, which is minutes of work and not for the default run.
 *
 *   1. the same 20 window ids, in the same order, as the R2 query on the same seed (the R2 SQL is kept below as the ORACLE);
 *   2. EXPLAIN ANALYZE of the two R3 queries (sweep + exhausted): each well under 1 s; the R2 query's time is printed beside them.
 * Run:  ETA_SWEEP_SCALE=1 npx vitest run tests/unit/nemo-sweeper-scale-pg.test.ts   (timings are printed as `SCALE …` lines)
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { dockerAvailable, pgContainer } from "../support/s1-pg";

const H = vi.hoisted(() => ({ sql: (async () => []) as unknown as (s: TemplateStringsArray, ...v: unknown[]) => Promise<unknown[]> }));
vi.mock("@/lib/db", () => ({ sql: (s: TemplateStringsArray, ...v: unknown[]) => H.sql(s, ...v) }));
vi.setConfig({ testTimeout: 1_800_000, hookTimeout: 1_800_000 });

const RUN = process.env.ETA_SWEEP_SCALE === "1" && dockerAvailable();
const pg = pgContainer("eta-nemo-scale");
const WINDOWS = 30_000;
const JOBS_PER_WINDOW = 20;

const psql = (text: string): string =>
  execFileSync("docker", ["exec", "-i", pg.name, "psql", "-qAt", "-v", "ON_ERROR_STOP=1", "-U", "postgres", "-d", "postgres"], { input: text, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
const timeOf = (explain: string): number => Number(/Execution Time: ([0-9.]+) ms/.exec(explain)![1]);

/** The R2 query, verbatim, with its three parameters inlined — the ORACLE. A correlated count(*) over scribe_job per window. */
const OLD_SWEEP = `
  SELECT w.id AS window_id
    FROM bench_window w
   WHERE EXISTS (SELECT 1 FROM diarize_nemotron_window n WHERE n.window_id = w.id AND n.status IN ('ok', 'empty'))
     AND NOT EXISTS (SELECT 1 FROM room_diarize_window d WHERE d.window_id = w.id AND d.state <> 'failed')
     AND NOT EXISTS (SELECT 1 FROM scribe_job j WHERE j.kind = 'diarize_window' AND j.args->>'window_id' = w.id AND j.status IN ('queued', 'running'))
     AND (SELECT count(*) FROM scribe_job j WHERE j.kind = 'diarize_window' AND j.args->>'window_id' = w.id AND j.status = 'failed') < 3::int
     AND w.id <> ALL(ARRAY[]::text[])
   ORDER BY w.start_ms ASC
   LIMIT 20::int`;
const NEW_SWEEP = `
  WITH cand AS MATERIALIZED (
    SELECT w.id, w.start_ms FROM bench_window w
     WHERE EXISTS (SELECT 1 FROM diarize_nemotron_window n WHERE n.window_id = w.id AND n.status IN ('ok', 'empty'))
       AND NOT EXISTS (SELECT 1 FROM room_diarize_window d WHERE d.window_id = w.id AND d.state <> 'failed')
       AND w.id <> ALL(ARRAY[]::text[])
  ), jobs AS (
    SELECT j.args->>'window_id' AS window_id, count(*) FILTER (WHERE j.status = 'failed') AS failed, bool_or(j.status IN ('queued', 'running')) AS open
      FROM scribe_job j WHERE j.kind = 'diarize_window' AND j.status IN ('failed', 'queued', 'running') GROUP BY 1
  )
  SELECT c.id AS window_id FROM cand c LEFT JOIN jobs j ON j.window_id = c.id
   WHERE COALESCE(j.open, false) = false AND COALESCE(j.failed, 0) < 3::int
   ORDER BY c.start_ms ASC LIMIT 20::int`;
const NEW_EXHAUSTED = `
  WITH cand AS MATERIALIZED (
    SELECT w.id FROM bench_window w
     WHERE EXISTS (SELECT 1 FROM diarize_nemotron_window n WHERE n.window_id = w.id AND n.status IN ('ok', 'empty'))
       AND NOT EXISTS (SELECT 1 FROM room_diarize_window d WHERE d.window_id = w.id AND d.state <> 'failed')
       AND w.id <> ALL(ARRAY[]::text[])
  ), jobs AS (
    SELECT j.args->>'window_id' AS window_id, count(*) AS failed FROM scribe_job j WHERE j.kind = 'diarize_window' AND j.status = 'failed' GROUP BY 1
  )
  SELECT count(*)::int AS n FROM cand c JOIN jobs j ON j.window_id = c.id WHERE j.failed >= 3::int`;

beforeAll(() => {
  if (!RUN) return;
  pg.start();
  for (const f of readdirSync("db/migrations").filter((x) => x.endsWith(".sql")).sort()) pg.exec(readFileSync(`db/migrations/${f}`, "utf8"));
  pg.exec(`
    INSERT INTO room (id, slug, name, pin_hash, transcript_enabled) VALUES ('room_s', 'scale-room', 'Scale Room', 'x', TRUE);
    INSERT INTO room_day (id, room_id, ist_date) VALUES ('rd_s', 'room_s', '2026-10-01');
    INSERT INTO bench_session (id, room_id, started_at, ended_at, status) VALUES ('bs_s', 'room_s', '2026-10-01T04:00:00Z', '2026-10-01T20:00:00Z', 'ended');
    INSERT INTO bench_window (id, session_id, room_day_id, start_ms, end_ms, source_mic, clip_r2_key, grid_aligned, state, closed_at)
      SELECT 'bw_k' || lpad(g::text, 6, '0'), 'bs_s', 'rd_s', 1790000000000 + g::bigint * 900000, 1790000000000 + g::bigint * 900000 + 900000, 'primary', 'clips/k' || g, TRUE, 'transcribed', now()
        FROM generate_series(1, ${WINDOWS}) g;
    -- every window has a Nemotron answer
    INSERT INTO diarize_nemotron_window (window_id, room_day_id, model, model_rev, config, config_hash, worker_id, machine, audio_ms, turns_json, speaker_count, turn_count, speech_ms, overlap_ms, payload_sha256, status)
      SELECT id, 'rd_s', 'm', 'r', '{}', 'h', 'w', 'box', 900000, '[[0,1000,"spk0"]]', 1, 1, 1000, 0, 'p' || id, 'ok' FROM bench_window;
    -- 80% diarized ok, 5% failed rows, the oldest 3,000 of them among the undiarized (so the answer is not trivially the first 20)
    INSERT INTO room_diarize_window (window_id, room_day_id, state, speakers_json, segments_json, last_run_id, segments_run_id)
      SELECT id, 'rd_s', CASE WHEN (row_number() OVER (ORDER BY start_ms)) % 20 = 0 THEN 'failed' ELSE 'ok' END, '[]', '[]', 'r', 'r' FROM bench_window WHERE (start_ms / 900000) % 5 <> 0;
    -- 600,000 jobs: JOBS_PER_WINDOW done jobs per window, plus failed (some windows 1, some 3) and queued ones, and 100k of other kinds
    INSERT INTO scribe_job (id, kind, args, status, created_at, finished_at)
      SELECT 'j_done_' || w.n || '_' || j, 'diarize_window', jsonb_build_object('window_id', 'bw_k' || lpad(w.n::text, 6, '0')), 'done', now() - ((w.n * ${JOBS_PER_WINDOW} + j) || ' seconds')::interval, now()
        FROM generate_series(1, ${WINDOWS}) w(n), generate_series(1, ${JOBS_PER_WINDOW}) j;
    INSERT INTO scribe_job (id, kind, args, status, created_at)
      SELECT 'j_fail_' || w.n || '_' || f, 'diarize_window', jsonb_build_object('window_id', 'bw_k' || lpad(w.n::text, 6, '0')), 'failed', now() - (w.n || ' seconds')::interval
        FROM generate_series(1, ${WINDOWS}) w(n), generate_series(1, 3) f
       WHERE (w.n % 331 = 0) OR (w.n % 97 = 0 AND f = 1);
    INSERT INTO scribe_job (id, kind, args, status, created_at)
      SELECT 'j_open_' || w.n, 'diarize_window', jsonb_build_object('window_id', 'bw_k' || lpad(w.n::text, 6, '0')), 'queued', now() FROM generate_series(1, ${WINDOWS}) w(n) WHERE w.n % 211 = 0;
    INSERT INTO scribe_job (id, kind, args, status, created_at)
      SELECT 'j_other_' || g, 'emotion_window', jsonb_build_object('window_id', 'bw_k' || lpad((g % ${WINDOWS} + 1)::text, 6, '0')), 'done', now() FROM generate_series(1, 100000) g;
    ANALYZE;
  `);
}, 1_800_000);
afterAll(() => { if (RUN) pg.stop(); });

describe.runIf(RUN)("R3 — the sweeper at 30,000 windows / 600,000+ scribe_job rows", () => {
  it("seed is the size the order names", () => {
    const n = psql(`SELECT (SELECT count(*) FROM bench_window) || ' ' || (SELECT count(*) FROM scribe_job);`).trim().split(" ").map(Number);
    expect(n[0]).toBe(WINDOWS);
    expect(n[1]).toBeGreaterThanOrEqual(700_000);
    console.log(`SCALE seed windows=${n[0]} scribe_job=${n[1]}`);
  });

  it("the same 20 windows, in the same order, as the R2 query on the same seed", () => {
    const ids = (q: string) => psql(q.replace(/\n/g, " ") + ";").trim().split("\n");
    const oldIds = ids(OLD_SWEEP);
    const newIds = ids(NEW_SWEEP);
    expect(oldIds).toHaveLength(20);
    expect(newIds).toEqual(oldIds);
  });

  it("EXPLAIN ANALYZE: each R3 query runs well under 1 s", () => {
    const run = (q: string) => timeOf(psql(`EXPLAIN (ANALYZE, TIMING OFF) ${q.replace(/\n/g, " ")};`));
    const sweepMs = run(NEW_SWEEP), exhaustedMs = run(NEW_EXHAUSTED);
    console.log(`SCALE new sweep=${sweepMs} ms, new exhausted=${exhaustedMs} ms`);
    expect(sweepMs).toBeLessThan(1000);
    expect(exhaustedMs).toBeLessThan(1000);
    // the R2 query on the same seed, for the record (it is the slow one; no assertion beyond that it is slower)
    const oldMs = run(OLD_SWEEP);
    console.log(`SCALE old R2 sweep=${oldMs} ms`);
    expect(oldMs).toBeGreaterThan(sweepMs);
  });
});

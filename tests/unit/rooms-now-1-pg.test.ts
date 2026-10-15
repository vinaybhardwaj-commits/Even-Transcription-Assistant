/**
 * ROOMS-NOW-1 — readSessions counts a recording/paused session as open when it started within 20 h OR has a chunk created in the last 30 min.
 * Against a real postgres:16 with minimal bench_session / bench_chunk tables (only the columns the read uses; INFERRED from migration 0041).
 * The SQL-shape tests below run without Docker.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { dockerAvailable, pgContainer } from "../support/s1-pg";
import { readSessions, type Db } from "@/lib/rooms-live/read";

const HAVE_DOCKER = dockerAvailable();
const pg = pgContainer("eta-rooms-now-1");
const ASOF = "2026-10-15T03:45:00.000Z";
const T = Date.parse(ASOF);
const at = (msAgo: number) => new Date(T - msAgo).toISOString();
const H = 3_600_000;
const MIN = 60_000;

describe("readSessions SQL shape", () => {
  const src = readFileSync("lib/rooms-live/read.ts", "utf8");
  const sql = /FROM \(\s+SELECT s\.room_id[\s\S]*?LIMIT 40/.exec(src)![0];
  it("fenced inner select with the 7-day bound, outer 20 h OR last_chunk_at IS NOT NULL, ORDER and LIMIT 40 kept", () => {
    expect(sql).toMatch(/s\.status IN \('recording', 'paused'\)/);
    expect(sql).toMatch(/s\.started_at <= \$\{asOf\}::timestamptz AND s\.started_at > \$\{asOf\}::timestamptz - interval '7 days'\s+OFFSET 0\s+\) q/);
    expect(sql).toMatch(/c\.created_at > \$\{asOf\}::timestamptz - interval '30 minutes' AND c\.created_at <= \$\{asOf\}::timestamptz\) AS last_chunk_at/);
    expect(sql).toMatch(/WHERE q\.started_at > \$\{asOf\}::timestamptz - interval '20 hours' OR q\.last_chunk_at IS NOT NULL\s+ORDER BY q\.started_at DESC\s+LIMIT 40/);
    expect(sql).not.toMatch(/EXISTS/);
  });
});

describe.skipIf(!HAVE_DOCKER)("readSessions over real postgres", () => {
  it("26 h + fresh chunk is open; 26 h + stale chunk is not; 2 h + no chunk is open; ended never; future never", async () => {
    pg.start();
    try {
      pg.exec(`
        CREATE TABLE bench_session (id text PRIMARY KEY, room_id text NOT NULL, status text NOT NULL, started_at timestamptz NOT NULL);
        CREATE TABLE bench_chunk (id text PRIMARY KEY, session_id text NOT NULL, created_at timestamptz NOT NULL);
        INSERT INTO bench_session VALUES
          ('s_old_live',  'room_t1', 'recording', '${at(26 * H)}'),
          ('s_old_dead',  'room_t2', 'recording', '${at(26 * H)}'),
          ('s_old_stale', 'room_t3', 'paused',    '${at(26 * H)}'),
          ('s_new_nochk', 'room_t4', 'recording', '${at(2 * H)}'),
          ('s_old_ended', 'room_t5', 'ended',     '${at(26 * H)}'),
          ('s_future',    'room_t6', 'recording', '${new Date(T + 5 * MIN).toISOString()}'),
          ('s_abandoned', 'room_t7', 'recording', '${at(30 * H)}'),
          ('s_8d',        'room_t8', 'recording', '${at(8 * 24 * H)}'),
          ('s_sib_a',     'room_t9', 'recording', '${at(26 * H)}'),
          ('s_sib_b',     'room_t9', 'recording', '${at(1 * H)}');
        INSERT INTO bench_chunk VALUES
          ('c1', 's_old_live',  '${at(5 * MIN)}'),
          ('c2', 's_old_stale', '${at(31 * MIN)}'),
          ('c3', 's_old_ended', '${at(5 * MIN)}'),
          ('c4', 's_future',    '${at(5 * MIN)}'),
          ('c5', 's_old_dead',  '${new Date(T + MIN).toISOString()}'),
          ('c6', 's_abandoned', '${at(29 * H)}'),
          ('c7', 's_8d',        '${at(2 * MIN)}'),
          ('c8', 's_sib_b',     '${at(2 * MIN)}');
      `);
      const rows = await readSessions(pg.sql as unknown as Db, ["room_t1", "room_t2", "room_t3", "room_t4", "room_t5", "room_t6", "room_t7", "room_t8", "room_t9"], ASOF);
      const byId = new Map(rows.map((r) => [r.id, r]));
      expect([...byId.keys()].sort()).toEqual(["s_new_nochk", "s_old_live", "s_sib_b"]); // not: abandoned (old chunks only), 8 days old (7-day bound, fresh chunk), sibling-fresh-chunk session s_sib_a, never-any-chunk s_old_dead
      expect(byId.get("s_old_live")!.last_chunk_at).toBe(at(5 * MIN));
      expect(byId.get("s_new_nochk")!.last_chunk_at).toBeNull();
      expect(rows.map((r) => r.id)).toEqual(["s_sib_b", "s_new_nochk", "s_old_live"]); // newest first
      // EXPLAIN: with realistic volume and the real indexes, bench_chunk is read by index only (no Seq Scan on it, no hashed subplan)
      const sqlText = /FROM \(\s+SELECT s\.room_id[\s\S]*?LIMIT 40/.exec(readFileSync("lib/rooms-live/read.ts", "utf8"))![0]
        .replace(/\$\{asOf\}/g, `'${ASOF}'`).replace(/\$\{ids\}::text\[\]/g, "ARRAY['room_v1','room_v2']::text[]");
      pg.exec(`
        CREATE INDEX bench_chunk_session_idx ON bench_chunk (session_id, created_at);
        CREATE INDEX bench_session_room_started_idx ON bench_session (room_id, started_at DESC);
        INSERT INTO bench_session SELECT 'v_' || g, 'room_v' || (g % 2 + 1), 'recording', '${at(2 * H)}'::timestamptz - (g || ' minutes')::interval FROM generate_series(1, 300) g;
        INSERT INTO bench_chunk SELECT 'vc_' || g, 'v_' || (g % 300 + 1), '${at(40 * MIN)}'::timestamptz - (g || ' seconds')::interval FROM generate_series(1, 30000) g;
        ANALYZE bench_session; ANALYZE bench_chunk;`);
      const plan = execFileSync("docker", ["exec", "-i", pg.name, "psql", "-qAt", "-v", "ON_ERROR_STOP=1", "-U", "postgres", "-d", "postgres"], { input: `EXPLAIN SELECT q.room_id, q.id, q.status, q.started_at, q.last_chunk_at ${sqlText.replace(/^FROM/, "FROM")}`, encoding: "utf8" });
      if (process.env.PRINT_PLAN) console.log(plan);
      expect(plan).toMatch(/bench_chunk/);
      expect(plan).not.toMatch(/Seq Scan on bench_chunk/);
      expect(plan).not.toMatch(/hashed SubPlan/);
    } finally {
      pg.stop();
    }
  }, 240_000);
});

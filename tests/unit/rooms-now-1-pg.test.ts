/**
 * ROOMS-NOW-1 — readSessions counts a recording/paused session as open when it started within 20 h OR has a chunk created in the last 30 min.
 * Against a real postgres:16 with minimal bench_session / bench_chunk tables (only the columns the read uses; INFERRED from migration 0041).
 * The SQL-shape tests below run without Docker.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
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
  const sql = /FROM bench_session s[\s\S]*?LIMIT 40/.exec(src)![0];
  it("keeps the 20 h bound, adds the 30-minute chunk escape, keeps the order and LIMIT 40", () => {
    expect(sql).toMatch(/s\.status IN \('recording', 'paused'\)/);
    expect(sql).toMatch(/s\.started_at <= \$\{asOf\}::timestamptz/);
    expect(sql).toMatch(/s\.started_at > \$\{asOf\}::timestamptz - interval '20 hours'\s+OR EXISTS \(SELECT 1 FROM bench_chunk c2/);
    expect(sql).toMatch(/c2\.created_at > \$\{asOf\}::timestamptz - interval '30 minutes' AND c2\.created_at <= \$\{asOf\}::timestamptz/);
    expect(sql).toMatch(/ORDER BY s\.started_at DESC\s+LIMIT 40/);
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
          ('s_future',    'room_t6', 'recording', '${new Date(T + 5 * MIN).toISOString()}');
        INSERT INTO bench_chunk VALUES
          ('c1', 's_old_live',  '${at(5 * MIN)}'),
          ('c2', 's_old_stale', '${at(31 * MIN)}'),
          ('c3', 's_old_ended', '${at(5 * MIN)}'),
          ('c4', 's_future',    '${at(5 * MIN)}'),
          ('c5', 's_old_dead',  '${new Date(T + MIN).toISOString()}');
      `);
      const rows = await readSessions(pg.sql as unknown as Db, ["room_t1", "room_t2", "room_t3", "room_t4", "room_t5", "room_t6"], ASOF);
      const byId = new Map(rows.map((r) => [r.id, r]));
      expect([...byId.keys()].sort()).toEqual(["s_new_nochk", "s_old_live"]);
      expect(byId.get("s_old_live")!.last_chunk_at).toBe(at(5 * MIN));
      expect(byId.get("s_new_nochk")!.last_chunk_at).toBeNull();
      expect(rows[0]!.id).toBe("s_new_nochk"); // newest first
    } finally {
      pg.stop();
    }
  }, 240_000);
});

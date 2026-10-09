/**
 * S6-BLIND Y1/Y2 on a real postgres:16 — the session view of lookupSegments: a window is held out if EITHER placement is a held-out pair (Y1), and a window with no room-day is excluded and counted (Y2).
 */
import { describe, it, expect, vi, beforeAll, afterAll } from "vitest";
import { dockerAvailable, pgContainer } from "../support/s1-pg";
import { BLIND_ROOM_DAYS } from "@/lib/rubrics/blind-room-days";

const H = vi.hoisted(() => ({ sql: null as null | ((s: TemplateStringsArray, ...v: unknown[]) => Promise<unknown[]>) }));
vi.mock("@/lib/db", () => ({ sql: Object.assign((s: TemplateStringsArray, ...v: unknown[]) => H.sql!(s, ...v), { transaction: async () => [] }) }));
vi.setConfig({ testTimeout: 60_000, hookTimeout: 180_000 });

const HAVE = dockerAvailable();
const pg = pgContainer("eta-s6-blind-y");
const [BD, BR] = BLIND_ROOM_DAYS[0]!;

beforeAll(() => {
  if (!HAVE) return;
  pg.start();
  pg.exec(`
    CREATE TABLE room_day (id text PRIMARY KEY, room_id text NOT NULL, ist_date date NOT NULL);
    CREATE TABLE bench_window (id text PRIMARY KEY, session_id text NOT NULL, room_day_id text, source_mic text NOT NULL DEFAULT 'primary', start_ms bigint NOT NULL, end_ms bigint NOT NULL);
    CREATE TABLE room_diarize_window (window_id text PRIMARY KEY, room_day_id text, state text NOT NULL, diarized_at timestamptz DEFAULT now(), segments_run_id text, last_run_id text, speakers_json jsonb, segments_json jsonb, timing_json jsonb);
    INSERT INTO room_day VALUES ('rd_clean', 'r1', '2026-10-02'), ('rd_blind', '${BR}', '${BD}');
    INSERT INTO bench_window (id, session_id, room_day_id, start_ms, end_ms) VALUES
      ('w_clean', 'bs1', 'rd_clean', 0, 1000),
      ('w_bench_blind', 'bs1', 'rd_blind', 1000, 2000),   -- the refuter's repro: bench_window on a held-out day ...
      ('w_rdw_blind', 'bs1', 'rd_clean', 2000, 3000),     -- ... and the other way round
      ('w_both_blind', 'bs1', 'rd_blind', 3000, 4000),
      ('w_unplaced', 'bs1', NULL, 4000, 5000),
      ('w_only_bench_clean', 'bs1', 'rd_clean', 5000, 6000);
    INSERT INTO room_diarize_window (window_id, room_day_id, state) VALUES
      ('w_clean', 'rd_clean', 'ok'), ('w_bench_blind', 'rd_clean', 'ok'), ('w_rdw_blind', 'rd_blind', 'ok'), ('w_both_blind', 'rd_blind', 'ok'), ('w_unplaced', NULL, 'ok'), ('w_only_bench_clean', NULL, 'ok');
  `);
  H.sql = pg.sql as never;
});
afterAll(() => { if (HAVE) pg.stop(); });

(HAVE ? describe : describe.skip)("the session view on real postgres", () => {
  it("Y1: a window is excluded when EITHER placement is held out, and counted; Y2: the unplaced window drops out and is counted; only clean windows are returned", async () => {
    const { lookupSegments } = await import("@/lib/diarize-segments");
    const r = await lookupSegments({ session_id: "bs1" }, { blindGuard: true });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const p = r.payload as { windows: Array<{ window_id: string }>; n_blind_excluded: number; n_unplaced_excluded: number };
    expect(p.windows.map((w) => w.window_id).sort()).toEqual(["w_clean", "w_only_bench_clean"]);
    expect(p.n_blind_excluded).toBe(3);
    expect(p.n_unplaced_excluded).toBe(1);
  });
});

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
    -- REL2-R4 G1: the session guard reads these (placements only)
    CREATE TABLE bench_session (id text PRIMARY KEY, room_id text NOT NULL, started_at timestamptz NOT NULL DEFAULT now(), ended_at timestamptz);
    CREATE TABLE bench_chunk (id serial PRIMARY KEY, session_id text NOT NULL, ended_at timestamptz NOT NULL);
    CREATE TABLE room_turn_speaker (window_id text, room_day_id text);
    CREATE TABLE jev_window_text (window_id text, room_day_id text);
    CREATE TABLE room_span_emotion (window_id text, room_day_id text);
    INSERT INTO bench_session (id, room_id, started_at, ended_at) VALUES ('bs1', 'r1', '2026-10-02T04:00:00Z', '2026-10-02T05:00:00Z'), ('bs2', 'r1', '2026-10-02T06:00:00Z', '2026-10-02T07:00:00Z');
    INSERT INTO room_day VALUES ('rd_clean', 'r1', '2026-10-02'), ('rd_blind', '${BR}', '${BD}');
    INSERT INTO bench_window (id, session_id, room_day_id, start_ms, end_ms) VALUES
      ('w_clean', 'bs1', 'rd_clean', 0, 1000),
      ('w_bench_blind', 'bs1', 'rd_blind', 1000, 2000),   -- the refuter's repro: bench_window on a held-out day ...
      ('w_rdw_blind', 'bs1', 'rd_clean', 2000, 3000),     -- ... and the other way round
      ('w_both_blind', 'bs1', 'rd_blind', 3000, 4000),
      ('w_unplaced', 'bs1', NULL, 4000, 5000),
      ('w_only_bench_clean', 'bs1', 'rd_clean', 5000, 6000),
      ('w2_clean', 'bs2', 'rd_clean', 0, 1000),
      ('w2_unplaced', 'bs2', NULL, 1000, 2000);
    INSERT INTO room_diarize_window (window_id, room_day_id, state) VALUES
      ('w_clean', 'rd_clean', 'ok'), ('w_bench_blind', 'rd_clean', 'ok'), ('w_rdw_blind', 'rd_blind', 'ok'), ('w_both_blind', 'rd_blind', 'ok'), ('w_unplaced', NULL, 'ok'), ('w_only_bench_clean', NULL, 'ok'), ('w2_clean', 'rd_clean', 'ok'), ('w2_unplaced', NULL, 'ok');
  `);
  H.sql = pg.sql as never;
});
afterAll(() => { if (HAVE) pg.stop(); });

(HAVE ? describe : describe.skip)("the session view on real postgres", () => {
  it("G1 (REL2-R4): a session with ANY held-out window (bench, diarize or both) is refused WHOLE, as scribe_get_session refuses it: 403, no window", async () => {
    const { lookupSegments } = await import("@/lib/diarize-segments");
    expect(await lookupSegments({ session_id: "bs1" }, { blindGuard: true })).toEqual({ ok: false, status: 403, error: "blind_room_day" });
  });
  it("Y2 (unchanged): in a session with no held-out window, the unplaced window drops out and is counted; only placed windows are returned", async () => {
    const { lookupSegments } = await import("@/lib/diarize-segments");
    const r = await lookupSegments({ session_id: "bs2" }, { blindGuard: true });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const p = r.payload as { windows: Array<{ window_id: string }>; n_blind_excluded: number; n_unplaced_excluded: number };
    expect(p.windows.map((w) => w.window_id)).toEqual(["w2_clean"]);
    expect(p.n_blind_excluded).toBe(0);
    expect(p.n_unplaced_excluded).toBe(1);
  });
});

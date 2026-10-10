/**
 * REQUIRED PROOF — the SQL of epic #23 (f, i) on a real postgres:16: loadTimelineEvidence (chunks, latest ok|empty
 * Nemotron row per window, identity speaker rows for voice_print and pulse_room) and the worker-health readers.
 * The blind-window splitter and the level-log reader are stubbed (each has its own proof). All ids are fake.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { dockerAvailable, pgContainer } from "../support/s1-pg";

const H = vi.hoisted(() => ({ sql: null as null | ((s: TemplateStringsArray, ...v: unknown[]) => Promise<unknown[]>) }));
vi.mock("@/lib/db", () => ({ sql: (s: TemplateStringsArray, ...v: unknown[]) => H.sql!(s, ...v) }));
vi.mock("@/lib/bench-levels", () => ({ readRoomLevelDay: async () => ({ samples: [{ t_ms: 1, avg: 0.1, peak: 0.2, zero_ratio: 0 }] }) }));
vi.mock("@/lib/room-access/jobs", () => ({ splitBlindWindows: async (items: unknown[]) => ({ kept: items, excluded: 0 }) }));
vi.setConfig({ testTimeout: 60_000, hookTimeout: 180_000 });

const HAVE = dockerAvailable();
const pg = pgContainer("eta-timeline-io");
const T0 = Date.parse("2026-10-09T04:00:00Z");

beforeAll(async () => {
  if (!HAVE) return;
  pg.start();
  pg.exec(`
CREATE TABLE schema_migrations (version integer PRIMARY KEY, name text, applied_at timestamptz DEFAULT now());
CREATE TABLE room_day (id text PRIMARY KEY, room_id text NOT NULL, ist_date date NOT NULL);
CREATE TABLE bench_window (id text PRIMARY KEY, session_id text NOT NULL, room_day_id text, start_ms bigint NOT NULL, end_ms bigint NOT NULL,
  state text NOT NULL, grid_aligned boolean NOT NULL DEFAULT false, clip_r2_key text, source_mic text);
CREATE TABLE bench_chunk (session_id text, started_at timestamptz, ended_at timestamptz, source text);
`);
  pg.exec(readFileSync("db/migrations/0117_diarize_window_label.sql", "utf8"));
  pg.exec(readFileSync("db/migrations/0140_diarize_nemotron.sql", "utf8"));
  pg.exec(readFileSync("db/migrations/0141_diarize_nemotron_identity.sql", "utf8"));
  pg.exec(readFileSync("db/migrations/0143_nemotron_lab.sql", "utf8"));
  pg.exec(readFileSync("db/migrations/0145_nemotron_identity_pulse_room.sql", "utf8"));
  pg.exec(`
INSERT INTO room_day VALUES ('rd_x', 'room_fake1', '2026-10-09');
INSERT INTO bench_chunk VALUES ('s1', to_timestamp(${T0 / 1000}), to_timestamp(${(T0 + 900_000) / 1000}), 'primary'),
                               ('s1', to_timestamp(${(T0 + 900_000) / 1000}), to_timestamp(${(T0 + 1_800_000) / 1000}), 'primary');
INSERT INTO bench_window VALUES ('bw_a', 's1', 'rd_x', ${T0}, ${T0 + 900_000}, 'closed', true, 'k', NULL),
                                ('bw_b', 's1', 'rd_x', ${T0 + 900_000}, ${T0 + 1_800_000}, 'closed', true, 'k', NULL);
INSERT INTO diarize_nemotron_window (window_id, room_day_id, model, model_rev, config, config_hash, worker_id, machine, audio_ms, turns_json,
   speaker_count, turn_count, speech_ms, overlap_ms, payload_sha256, status, received_at)
 VALUES ('bw_a','rd_x','m','rev_old','{}','h1','w','box',900000,'[[0,1000,"spk0"]]',1,1,1000,0,'p1','ok', now() - interval '3 hours'),
        ('bw_a','rd_x','m','rev_new','{}','h2','w','box',900000,'[[0,4000,"spk0"],[3000,9000,"spk1"],[1,2,"bad"]]',2,2,9000,1000,'p2','ok', now() - interval '2 hours'),
        ('bw_b','rd_x','m','rev_new','{}','h2','w','hf',900000,'[]',0,0,0,0,'p3','empty', now() - interval '1 hour');
INSERT INTO diarize_nemotron_identity (window_row_id, centroid_set, state) SELECT id, 'voice_print', 'ok' FROM diarize_nemotron_window WHERE model_rev = 'rev_new' AND window_id = 'bw_a';
INSERT INTO diarize_nemotron_identity (window_row_id, centroid_set, state, shadow_trusted) SELECT id, 'pulse_room', 'ok', NULL FROM diarize_nemotron_window WHERE model_rev = 'rev_new' AND window_id = 'bw_a';
INSERT INTO diarize_nemotron_speaker (window_row_id, centroid_set, speaker_label, speech_ms, clinician_id, match_confidence, centroids_offered, attribution)
  SELECT id, 'voice_print', 'spk0', 4000, 'cl_fake1', 0.8, 3, 'voiceprint' FROM diarize_nemotron_window WHERE model_rev = 'rev_new' AND window_id = 'bw_a';
INSERT INTO diarize_nemotron_speaker (window_row_id, centroid_set, speaker_label, speech_ms, centroids_offered, attribution, decision, pulse_doctor_uid, match_source, best_cosine, runner_up_cosine)
  SELECT id, 'pulse_room', 'spk0', 4000, 2, 'voiceprint', 'match', 'doc_uid_1', 'pulse_room', 0.8, 0.3 FROM diarize_nemotron_window WHERE model_rev = 'rev_new' AND window_id = 'bw_a';
INSERT INTO diarize_nemotron_worker (worker_id, payload) VALUES ('box-fake-1', '{"queue_depth":3}');
`);
  H.sql = pg.sql as never;
}, 240_000);
afterAll(() => { if (HAVE) pg.stop(); });

describe("REQUIRED PROOF ran, or was skipped deliberately", () => {
  it("needs Docker", () => {
    if (HAVE || process.env.ETA_ALLOW_SKIP_E2E === "1") return;
    throw new Error("REQUIRED PROOF NOT RUN: tests/unit/nemotron-timeline-io-pg.test.ts needs Docker for postgres:16, or set ETA_ALLOW_SKIP_E2E=1.");
  });
});

describe.runIf(HAVE)("loadTimelineEvidence", () => {
  it("reads the newest ok|empty row per window, drops malformed turns, and maps identity by speaker index", async () => {
    const { loadTimelineEvidence } = await import("@/lib/room-access/encounter-timeline-io");
    const ev = await loadTimelineEvidence("room_fake1", "rd_x", "2026-10-09", new Date("2026-10-11T00:00:00Z"));
    expect(ev).not.toBeNull();
    expect(ev!.day_start_ms).toBe(T0);
    expect(ev!.day_end_ms).toBe(T0 + 1_800_000);
    expect(ev!.tape_off).toEqual([]);
    expect(ev!.day_complete).toBe(true);
    const a = ev!.windows.find((w) => w.window_id === "bw_a")!;
    expect(a).toMatchObject({ origin_ms: T0, window_end_ms: T0 + 900_000 });
    expect(a.turns).toEqual([{ start_ms: 0, end_ms: 4000, speaker_idx: 0 }, { start_ms: 3000, end_ms: 9000, speaker_idx: 1 }]);
    const b = ev!.windows.find((w) => w.window_id === "bw_b")!;
    expect(b.turns).toEqual([]);                         // an empty row is evidence of silence, not absence
    expect(ev!.identity.get("bw_a")!.get(0)).toMatchObject({ pulse_doctor_uid: "doc_uid_1", clinician_id: "cl_fake1", match_confidence: expect.closeTo(0.8, 5) });
    expect(ev!.identity.get("bw_a")!.get(1)).toBeUndefined();
    expect(ev!.identity.has("bw_b")).toBe(false);
  });
  it("a room-day with no recorded chunks is null", async () => {
    const { loadTimelineEvidence } = await import("@/lib/room-access/encounter-timeline-io");
    expect(await loadTimelineEvidence("room_fake1", "rd_none", "2026-10-09")).toBeNull();
  });
});

describe.runIf(HAVE)("worker-health readers", () => {
  it("heartbeats and 24 h latency / box-vs-hf", async () => {
    const store = await import("@/lib/room-access/nemotron-store");
    const hb = await store.readWorkerHeartbeats();
    expect(hb.map((h) => h.worker_id)).toEqual(["box-fake-1"]);
    const lat = await store.readNemotronLatency24h();
    expect(lat).toMatchObject({ windows_24h: 3, box_24h: 2, hf_24h: 1 });
    expect(lat.p95_latency_s).toBeGreaterThan(0);
  });
});

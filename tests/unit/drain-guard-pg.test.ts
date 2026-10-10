/**
 * DRAIN-GUARD on a real postgres:16 with ALL migrations applied: every production CHOOSER that picks its own windows leaves a held-out window out BEFORE its LIMIT, and a clean window is still chosen.
 * Choosers: auto-drain, room drain (waiting + queued), diarize enqueue, emotion enqueue, measure job, join-only listing, repeat-run backfill.
 * Held-out windows: bw_blind (a session and day on a held-out pair), bw_win (clean room, session and day, but the window is placed on a held-out room-day), bw_dz (clean window whose DIARIZE row is placed on one).
 * Clean windows: bw_clean (no diarize row), bw_cleanE (diarized ok, clean).
 */
import { describe, it, expect, vi, beforeAll, afterAll } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { dockerAvailable, pgContainer } from "../support/s1-pg";
import { FORMER_BLIND_PAIRS } from "../support/former-blind-pairs";

const H = vi.hoisted(() => ({
  sql: null as null | ((s: TemplateStringsArray, ...v: unknown[]) => Promise<unknown[]>),
  chunkSessions: [] as string[],
  submitted: [] as string[],
  logs: [] as string[],
}));
vi.mock("@/lib/db", () => ({
  sql: Object.assign((s: TemplateStringsArray, ...v: unknown[]) => {
    if (/FROM bench_chunk/.test(s.join("?")) && /^bs_/.test(String(v[0]))) H.chunkSessions.push(String(v[0]));
    return H.sql!(s, ...v);
  }, { transaction: async () => [] }),
}));
vi.mock("@/lib/jobs/submit", () => ({ submitJob: async (i: { args: { window_id: string } }) => { H.submitted.push(i.args.window_id); return { id: `job_${H.submitted.length}` }; } }));
vi.mock("@/lib/room-switches", () => ({ isTranscriptEnabled: async () => false }));
vi.mock("@/lib/r2", () => ({ headObject: async () => ({ size: null, content_type: null }), getObjectBytes: async () => null, signGetUrl: async () => "https://r2.example/x" }));
vi.mock("@/lib/whisper", () => ({ transcribeWithWhisper: async () => ({ ok: false, error: "not_called", latency_ms: 0 }) }));
vi.setConfig({ testTimeout: 120_000, hookTimeout: 300_000 });

const ENV = { ROOM_AUTO_DRAIN_ENABLED: "1", AUTO_DRAIN_BATCH_LIMIT: "10", ROOM_DIARIZE_ENABLED: "1", EMOTION_ENABLED: "1", EMOTION_SEGMENTS_SECRET: "x", EMOTION_BATCH_LIMIT: "10" };
Object.assign(process.env, ENV);

const HAVE = dockerAvailable();
const pg = pgContainer("eta-drain-guard");
const [BD, BR] = FORMER_BLIND_PAIRS[0]!;
const CLEAN_DAY = "2026-10-05";
const dayStart = Date.parse(`${BD}T00:00:00+05:30`);
const T = (ms: number) => new Date(ms).toISOString();
const BLIND = ["bw_blind", "bw_win", "bw_dz"];
const sorted = (a: string[]) => [...a].sort();

beforeAll(() => {
  if (!HAVE) return;
  pg.start();
  for (const f of readdirSync("db/migrations").filter((x) => x.endsWith(".sql")).sort()) pg.exec(readFileSync(`db/migrations/${f}`, "utf8"));
  H.sql = pg.sql as never;
  pg.exec(`
    INSERT INTO room (id, slug, name, pin_hash, transcript_enabled) VALUES ('${BR}', 'blind-room', 'Blind Room', 'x', TRUE), ('r_clean', 'clean-room', 'Clean Room', 'x', TRUE);
    INSERT INTO room_day (id, room_id, ist_date) VALUES ('rd_blind', '${BR}', '${BD}'), ('rd_clean', 'r_clean', '${CLEAN_DAY}');
    INSERT INTO bench_session (id, room_id, started_at, ended_at, status) VALUES
      ('bs_blind', '${BR}', '${T(dayStart + 3_600_000)}', '${T(dayStart + 7_200_000)}', 'ended'),
      ('bs_win', 'r_clean', '${CLEAN_DAY}T06:00:00Z', '${CLEAN_DAY}T07:00:00Z', 'ended'),
      ('bs_dz', 'r_clean', '${CLEAN_DAY}T08:00:00Z', '${CLEAN_DAY}T09:00:00Z', 'ended'),
      ('bs_clean', 'r_clean', '${CLEAN_DAY}T04:00:00Z', '${CLEAN_DAY}T05:00:00Z', 'ended'),
      ('bs_cleanE', 'r_clean', '${CLEAN_DAY}T10:00:00Z', '${CLEAN_DAY}T11:00:00Z', 'ended');
    INSERT INTO bench_window (id, session_id, room_day_id, start_ms, end_ms, source_mic, clip_r2_key, grid_aligned, state, closed_at) VALUES
      ('bw_blind', 'bs_blind', 'rd_blind', ${dayStart + 3_600_000}, ${dayStart + 4_500_000}, 'primary', 'clips/bs_blind/a.wav', TRUE, 'closed', now()),
      ('bw_win', 'bs_win', 'rd_blind', 1000, 2000, 'primary', 'clips/bs_win/a.wav', TRUE, 'closed', now()),
      ('bw_dz', 'bs_dz', 'rd_clean', 3000, 4000, 'primary', 'clips/bs_dz/a.wav', TRUE, 'closed', now()),
      ('bw_clean', 'bs_clean', 'rd_clean', 5000, 6000, 'primary', 'clips/bs_clean/a.wav', TRUE, 'closed', now()),
      ('bw_cleanE', 'bs_cleanE', 'rd_clean', 7000, 8000, 'primary', 'clips/bs_cleanE/a.wav', TRUE, 'closed', now());
    INSERT INTO room_diarize_window (window_id, room_day_id, state, last_run_id) VALUES ('bw_dz', 'rd_blind', 'ok', 'run1'), ('bw_cleanE', 'rd_clean', 'ok', 'run1');
  `);
}, 300_000);
afterAll(() => { if (HAVE) pg.stop(); });

(HAVE ? describe : describe.skip)("DRAIN-GUARD: the formerly held-out windows are chosen like any clean one, nothing is excluded", () => {
  it("blindWindowIds: empty (lifted); the three formerly held-out windows are not in it", async () => {
    const { blindWindowIds } = await import("@/lib/room-access/check");
    expect(await blindWindowIds()).toEqual([]);
    expect(BLIND).toHaveLength(3);
  });

  it("auto-drain: offers a window per room (the formerly held-out room included) and excludes none", async () => {
    vi.resetModules();
    const offered: string[] = [];
    vi.doMock("@/lib/stt/room-drain", async (orig) => ({ ...(await orig<Record<string, unknown>>()), drainRoomWindow: async (id: string) => { offered.push(id); return { window_id: id, ok: true, step: "enqueued", job_id: "j" }; } }));
    vi.doMock("@/lib/stt/fanout", () => ({ enqueueSubject: async () => {} }));
    const { enqueueAutoDrain } = await import("@/lib/stt/auto-drain");
    H.logs.length = 0;
    const r = await enqueueAutoDrain("https://x.example", { log: (m) => H.logs.push(m) });
    expect(offered).toHaveLength(2); // one slot per room: the formerly blind room (bw_blind) is drained like r_clean
    expect(offered).toContain("bw_blind");
    expect(r.n_blind_excluded ?? 0).toBe(0);
    expect(H.logs.join("\n")).not.toMatch(/n_blind_excluded [1-9]/);
    vi.doUnmock("@/lib/stt/room-drain");
    vi.doUnmock("@/lib/stt/fanout");
  });

  it("room drain: the waiting-windows batch includes the formerly held-out windows, oldest first", async () => {
    vi.resetModules();
    const { drainRoomWaitingWindows } = await import("@/lib/stt/room-drain");
    const actor = { actor: "adm_test", via: "admin_route" } as never;
    const all = await drainRoomWaitingWindows("r_clean", "https://x.example", 12, actor);
    expect(all.map((o) => o.window_id).sort()).toEqual(["bw_clean", "bw_cleanE", "bw_dz", "bw_win"]);
    // oldest first: bw_win (1000) comes before bw_dz (3000) and bw_clean (5000)
    const one = await drainRoomWaitingWindows("r_clean", "https://x.example", 1, actor);
    expect(one.map((o) => o.window_id)).toEqual(["bw_win"]);
  });

  it("room drain: the queued batch includes the formerly held-out windows, oldest queued first", async () => {
    vi.resetModules();
    pg.exec(`INSERT INTO stt_subject_job (subject_type, subject_id, tier, state, queued_at) SELECT 'bench_window', id, 'asr', 'queued', now() - (CASE id WHEN 'bw_blind' THEN 5 WHEN 'bw_win' THEN 4 WHEN 'bw_dz' THEN 3 WHEN 'bw_clean' THEN 2 ELSE 1 END) * interval '1 minute' FROM bench_window`);
    const { drainQueuedRoomWindows } = await import("@/lib/stt/room-drain");
    const actor = { actor: "adm_test", via: "admin_route" } as never;
    expect((await drainQueuedRoomWindows("https://x.example", 50, actor)).map((o) => o.window_id).sort()).toEqual(["bw_blind", "bw_clean", "bw_cleanE", "bw_dz", "bw_win"]);
    const first = await drainQueuedRoomWindows("https://x.example", 1, actor); // oldest queued first
    expect(first.map((o) => o.window_id)).toEqual(["bw_blind"]); // the oldest queued job takes the slot, formerly held-out or not
    pg.exec(`DELETE FROM stt_subject_job`);
  });

  it("diarize sweeper: the oldest ANSWERED window without a room row is swept, formerly held-out or not; nothing is excluded; with the shadow flag off it queues nothing", async () => {
    vi.resetModules();
    H.submitted.length = 0;
    process.env.DIARIZE_NEMOTRON_SHADOW = "1";
    pg.exec(`INSERT INTO diarize_nemotron_window (window_id, room_day_id, model, model_rev, config, config_hash, worker_id, machine, audio_ms, turns_json, speaker_count, turn_count, speech_ms, overlap_ms, payload_sha256, status)
             SELECT w.id, w.room_day_id, 'm', 'r', '{}', 'h', 'w', 'box', 900000, '[[0,1000,"spk0"]]', 1, 1, 1000, 0, 'p', 'ok' FROM bench_window w WHERE w.id IN ('bw_blind', 'bw_win', 'bw_clean')`);
    try {
      const { enqueueDiarizeWindows } = await import("@/lib/stt/diarize-job");
      const r = await enqueueDiarizeWindows({ actor: "adm_test", log: () => {}, limit: 1 });
      expect(H.submitted).toEqual(["bw_win"]); // oldest of the three answered windows (bw_win 1000 < bw_blind < bw_clean)
      expect(r.n_blind_excluded).toBe(0);
      process.env.DIARIZE_NEMOTRON_SHADOW = "0";
      H.submitted.length = 0;
      expect((await enqueueDiarizeWindows({ actor: "adm_test", log: () => {} })).enqueued).toEqual([]);
      expect(H.submitted).toEqual([]);
    } finally {
      delete process.env.DIARIZE_NEMOTRON_SHADOW;
    }
  });

  it("emotion enqueue: a diarized window placed on the formerly held-out room-day is enqueued like the clean one", async () => {
    vi.resetModules();
    H.submitted.length = 0;
    const { enqueueEmotionWindows } = await import("@/lib/emotion/enqueue");
    const r = await enqueueEmotionWindows({ actor: "adm_test", log: () => {} });
    expect(sorted(H.submitted)).toEqual(["bw_cleanE", "bw_dz"]);
    expect(r.n_blind_excluded ?? 0).toBe(0);
  });

  it("measure job: the formerly held-out windows are measured too; nothing excluded", async () => {
    vi.resetModules();
    H.chunkSessions.length = 0;
    const { runMeasureJob } = await import("@/lib/stt/measure-job");
    const r = await runMeasureJob({ log: () => {}, skipFork: true, skipScoring: true });
    expect(r.n_blind_excluded ?? 0).toBe(0);
    expect(r.scanned).toBe(5);
    expect(sorted(H.chunkSessions)).toEqual(["bs_blind", "bs_clean", "bs_cleanE", "bs_dz", "bs_win"]);
  });

  it("join-only listing: clipless formerly held-out windows are offered like the clean ones", async () => {
    vi.resetModules();
    pg.exec(`UPDATE bench_window SET clip_r2_key = NULL`);
    // the listing now also asks "the session has any chunk" (clip-join L2b): give EVERY session one, the held-out ones too, so a held-out window is out because of the blind predicates and not for want of a chunk
    pg.exec(`INSERT INTO bench_chunk (id, session_id, idx, r2_key, content_type, started_at, ended_at, duration_ms, size_bytes, upload_state)
      SELECT 'bcj_' || s.id, s.id, 0, 'bench/kj_' || s.id, 'audio/webm', s.started_at, s.started_at + interval '5 minutes', 300000, 1000, 'verified' FROM bench_session s
      WHERE NOT EXISTS (SELECT 1 FROM bench_chunk c WHERE c.session_id = s.id)`);
    const { listCliplessWindows } = await import("@/lib/stt/join-only");
    const rows = await listCliplessWindows({ limit: 50 });
    expect(rows.map((x) => x.window_id).sort()).toEqual(["bw_blind", "bw_clean", "bw_cleanE", "bw_dz", "bw_win"]);
  });

  it("repeat-run backfill: turns of the formerly held-out window are read and flagged like the clean window's", async () => {
    vi.resetModules();
    const cue = (i: number, session: string, rd: string, start: number, end: number) => pg.exec(`
      INSERT INTO cue (id, room_day_id, session_id, type, source, source_ref, payload, at)
      VALUES ('cue_${session}_${i}', '${rd}', '${session}', 'stt_turn', NULL, '${session}|${i}', '${JSON.stringify({ text: "loop text", start_ms: start + i, end_ms: start + i + 1, window: { start_ms: start, end_ms: end } })}'::jsonb, now())`);
    for (let i = 0; i < 4; i++) { cue(i, "bs_win", "rd_blind", 1000, 2000); cue(i, "bs_clean", "rd_clean", 5000, 6000); }
    const { backfillRepeatRuns } = await import("@/lib/transcript/repeat-runs-backfill");
    const s = await backfillRepeatRuns();
    expect(s.per_window.map((w) => w.window_id).sort()).toEqual(["bw_clean", "bw_win"]);
    expect(s.n_blind_excluded ?? 0).toBe(0);
    const flagged = (await pg.sql!`SELECT DISTINCT window_id FROM room_turn_repeat_run` as unknown as Array<{ window_id: string }>).map((r) => r.window_id);
    expect(flagged.sort()).toEqual(["bw_clean", "bw_win"]);
  });
});

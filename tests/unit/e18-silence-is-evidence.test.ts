/**
 * E18 — SILENCE IS A NAMED STATE, AN EVIDENCED VERDICT, AND A RE-ADJUDICABLE SET.
 *
 * Against a real postgres:16 with the REAL migrations (0041's bench tables, 0057, 0066's mic levels and 0101),
 * through BOUND parameters, so the CHECKs in 0101 are enforced by the database and not by this file.
 *
 * ─── THE THREE FIXTURES RULE 21 ASKS FOR ────────────────────────────────────────────────────────────────
 *   1. an empty room     — chunks that carried a meter reading, quiet but not zero;
 *   2. a dead microphone — chunks that carried a meter reading pinned at the floor;
 *   3. no level at all   — chunks that carried none, which is EVERY window the native recorder produced
 *                          (0 of 4,405 chunks have one).
 *
 * WHAT THESE PROVE, AND WHAT THEY REFUSE TO PRETEND. Fixtures 1 and 2 differ only in the NUMBERS the recorder
 * reported. E18 records them faithfully and judges neither: `verdict` is the same string in both rows, and
 * nothing in this build says which was an empty room and which was a dead mic. That is E13's work. In
 * production today the distinction is not even available, because fixture 3 is the real shape — no level at
 * all. These tests pin that limit so that no later reader mistakes a recorded number for an adjudicated cause.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { execSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dockerAvailable, pgContainer } from "../support/s1-pg";

const H = vi.hoisted(() => ({ sql: null as null | ((s: TemplateStringsArray, ...v: unknown[]) => Promise<unknown[]>) }));
vi.mock("@/lib/db", () => ({ sql: (s: TemplateStringsArray, ...v: unknown[]) => H.sql!(s, ...v) }));

const HAVE_DOCKER = dockerAvailable();
const ALLOW_SKIP = process.env.ETA_ALLOW_SKIP_E2E === "1";
const pg = pgContainer("eta-e18-silence");
const noRecord = (f: string) => readFileSync(f, "utf8").replace(/INSERT INTO schema_migrations[\s\S]*?;/g, "");

describe("REQUIRED PROOF — E18 runs against a real postgres", () => {
  it("ran, or was skipped deliberately", () => {
    if (HAVE_DOCKER || ALLOW_SKIP) return;
    throw new Error("REQUIRED PROOF NOT RUN: tests/unit/e18-silence-is-evidence.test.ts needs Docker for postgres:16. Start Docker, or set ETA_ALLOW_SKIP_E2E=1 to accept that it was not proven.");
  });
});

const WINDOW_MS = 900_000;
/** Epoch ms for window n, so a chunk's timestamptz and a window's bigint agree. */
const startOf = (n: number) => n * WINDOW_MS;

beforeAll(() => {
  if (!HAVE_DOCKER) return;
  pg.start();
  // bench_session and bench_chunk are cut down to the columns this file uses (0041 plus 0045's `source`):
  // their real DDL drags in the listener and room tables this test has no business creating. bench_window,
  // the mic levels and the silence table are the REAL migrations, verbatim, because those are what E18 changes.
  pg.exec(`CREATE TABLE schema_migrations (version int PRIMARY KEY, name text);
           CREATE TABLE bench_session (id text PRIMARY KEY, room_id text NOT NULL, started_at timestamptz, ended_at timestamptz, status text);
           CREATE TABLE bench_chunk (
             id text PRIMARY KEY, session_id text NOT NULL REFERENCES bench_session(id), idx integer NOT NULL,
             source text NOT NULL DEFAULT 'primary', r2_key text NOT NULL, content_type text NOT NULL,
             started_at timestamptz NOT NULL, ended_at timestamptz NOT NULL, upload_state text NOT NULL DEFAULT 'pending',
             UNIQUE (session_id, idx));
           -- 0066 also touches bench_listener (the kiosk's live meter), which this file does not use; the
           -- table is created empty so the migration runs verbatim rather than being edited to fit the test.
           CREATE TABLE bench_listener (session_id text PRIMARY KEY);`);
  pg.exec(noRecord("db/migrations/0057_bench_window.sql"));
  // 0066 adds the recorder's meter to bench_chunk. Without it there is no level to be absent.
  pg.exec(noRecord("db/migrations/0066_mic_levels.sql"));
  pg.exec(noRecord("db/migrations/0101_bench_window_silence.sql"));
  pg.exec(`INSERT INTO bench_session (id, room_id, started_at, status) VALUES ('sess_1', 'room_1', to_timestamp(0), 'ended');`);
  H.sql = pg.sql;
}, 240_000);
afterAll(() => { if (HAVE_DOCKER) pg.stop(); });

/**
 * One window and the chunks under it. `levels` is what the recorder metered, or null for the native
 * recorder's silence about its own microphone.
 */
function seedWindow(id: string, n: number, opts: { levels?: Array<{ peak: number; avg: number }> | null; chunks?: number; state?: string; session?: string; roomDay?: string } = {}): void {
  const start = startOf(n);
  const end = start + WINDOW_MS;
  const chunks = opts.chunks ?? 2;
  const session = opts.session ?? "sess_1";
  pg.exec(`
    INSERT INTO bench_window (id, session_id, room_day_id, start_ms, end_ms, source_mic, clip_r2_key, grid_aligned, state, closed_at)
    VALUES ('${id}', '${session}', '${opts.roomDay ?? "rd_1"}', ${start}, ${end}, 'primary', 'clips/${id}.webm', TRUE, '${opts.state ?? "silent"}', NOW());
  `);
  for (let i = 0; i < chunks; i += 1) {
    const cs = start + i * (WINDOW_MS / chunks);
    const ce = cs + WINDOW_MS / chunks;
    const lv = opts.levels === null || opts.levels === undefined ? null : opts.levels[i] ?? null;
    pg.exec(`
      INSERT INTO bench_chunk (id, session_id, idx, source, r2_key, content_type, started_at, ended_at, upload_state, peak_level, avg_level)
      VALUES ('${id}_c${i}', '${session}', ${n * 10 + i}, 'primary', 'chunks/${id}_${i}.webm', 'audio/webm',
              to_timestamp(${cs} / 1000.0), to_timestamp(${ce} / 1000.0), 'verified',
              ${lv === null ? "NULL" : lv.peak}, ${lv === null ? "NULL" : lv.avg});
    `);
  }
}

const evidenceOf = async (id: string) =>
  ((await pg.sql`SELECT verdict, engine, audio_level_source, peak_level, avg_level, level_chunks, total_chunks,
                        vad_params_source, vad_enabled, no_speech_thold, suppress_nst, silero_version,
                        reopened_at::text AS reopened_at, reopened_batch, reopened_reason
                   FROM bench_window_silence WHERE window_id = ${id}`) as Array<Record<string, unknown>>)[0];
const stateOf = async (id: string) =>
  ((await pg.sql`SELECT state FROM bench_window WHERE id = ${id}`) as Array<{ state: string }>)[0]?.state;
/**
 * R47 — the as-of a caller hands back to an apply, read off the DATABASE clock rather than this process's.
 * The fixtures are stamped with the container's NOW(); a host clock a few milliseconds behind it would put
 * freshly-seeded windows outside the bound and fail these tests for a reason that has nothing to do with them.
 */
const dbNow = async () => ((await pg.sql`SELECT now()::text AS t`) as Array<{ t: string }>)[0]!.t;

describe.runIf(HAVE_DOCKER)("E18 — the verdict, its evidence, and the set", () => {
  it("R1.2 — the three real shapes: an empty room, a dead mic, and no level at all — recorded faithfully, adjudicated NOT AT ALL", async () => {
    const { recordSilenceVerdict, readWindowAudioLevel, readVadParams, VERDICT_EMPTY_TRANSCRIPT } = await import("@/lib/stt/silence");

    // 1. AN EMPTY ROOM: the kiosk's meter heard the room's noise floor — quiet, but not nothing.
    seedWindow("bw_empty_room", 1, { levels: [{ peak: 0.012, avg: 0.004 }, { peak: 0.010, avg: 0.003 }] });
    // 2. A DEAD MIC: the same meter, pinned at zero for the whole window.
    seedWindow("bw_dead_mic", 2, { levels: [{ peak: 0, avg: 0 }, { peak: 0, avg: 0 }] });
    // 3. THE PRODUCTION SHAPE: the native recorder sent no level at all, on either chunk.
    seedWindow("bw_no_level", 3, { levels: null });

    for (const id of ["bw_empty_room", "bw_dead_mic", "bw_no_level"]) {
      const n = id === "bw_empty_room" ? 1 : id === "bw_dead_mic" ? 2 : 3;
      const level = await readWindowAudioLevel("sess_1", "primary", startOf(n), startOf(n) + WINDOW_MS);
      await recordSilenceVerdict({
        windowId: id, roomDayId: "rd_1", sessionId: "sess_1",
        verdict: VERDICT_EMPTY_TRANSCRIPT, engine: "whisper", engineVersion: null, audioSeconds: 900,
        // Today's answer shape carries no VAD report at all — that is what the service returns.
        level, vad: readVadParams({ ok: false, error: "empty_transcript", latency_ms: 120 }),
        answer: { error: "empty_transcript", latency_ms: 120, attempts: 1, source_mic: "primary" },
      });
    }

    const empty = await evidenceOf("bw_empty_room");
    const dead = await evidenceOf("bw_dead_mic");
    const none = await evidenceOf("bw_no_level");

    // The two rooms that DID carry a meter: the numbers are kept, and they differ.
    expect(empty).toMatchObject({ audio_level_source: "recorder", level_chunks: 2, total_chunks: 2 });
    expect(Number(empty!.peak_level)).toBeCloseTo(0.012, 5);
    expect(dead).toMatchObject({ audio_level_source: "recorder", level_chunks: 2, total_chunks: 2 });
    expect(Number(dead!.peak_level)).toBe(0);

    // THE HONEST LIMIT, pinned: apart from the numbers, the two verdicts are the same row. E18 names no cause,
    // and nothing here says which window was an empty room and which was a dead microphone.
    expect(dead!.verdict).toBe(empty!.verdict);
    expect(Object.keys(empty!).filter((k) => JSON.stringify(empty![k]) !== JSON.stringify(dead![k])).sort())
      .toEqual(["avg_level", "peak_level"]);

    // The production shape: no level, said as 'absent' — never as zero, which would read as a dead mic.
    expect(none).toMatchObject({ audio_level_source: "absent", peak_level: null, avg_level: null, level_chunks: 0, total_chunks: 2 });

    // The whisper parameters the verdict was made under: the service reports none, and none are invented.
    for (const e of [empty, dead, none]) {
      expect(e).toMatchObject({ vad_params_source: "unreported", vad_enabled: null, no_speech_thold: null, suppress_nst: null, silero_version: null });
      expect(e!.engine).toBe("whisper");
    }
  }, 300_000);

  it("R1.2 — the level is the WINDOW'S OWN mic: a backup-mic reading is not evidence about the primary", async () => {
    const { recordSilenceVerdict, readWindowAudioLevel, readVadParams, VERDICT_EMPTY_TRANSCRIPT } = await import("@/lib/stt/silence");
    // A dual-mic room: the primary sent no level (the native recorder), the backup did. The window was read on
    // the primary, so the backup's meter says nothing about what this window heard.
    seedWindow("bw_dual", 7, { levels: null });
    pg.exec(`
      INSERT INTO bench_chunk (id, session_id, idx, source, r2_key, content_type, started_at, ended_at, upload_state, peak_level, avg_level)
      VALUES ('bw_dual_backup', 'sess_1', 799, 'backup', 'chunks/bw_dual_b.webm', 'audio/webm',
              to_timestamp(${startOf(7)} / 1000.0), to_timestamp(${startOf(7) + WINDOW_MS} / 1000.0), 'verified', 0.31, 0.12);
    `);
    const level = await readWindowAudioLevel("sess_1", "primary", startOf(7), startOf(7) + WINDOW_MS);
    expect(level, "the backup's meter is not counted for a primary window").toMatchObject({ source: "absent", peak_level: null, level_chunks: 0, total_chunks: 2 });
    await recordSilenceVerdict({
      windowId: "bw_dual", roomDayId: "rd_1", sessionId: "sess_1", verdict: VERDICT_EMPTY_TRANSCRIPT,
      engine: "whisper", audioSeconds: 900, level, vad: readVadParams({}), answer: null,
    });
    expect(await evidenceOf("bw_dual")).toMatchObject({ audio_level_source: "absent", peak_level: null, total_chunks: 2 });
    pg.exec(`UPDATE bench_window SET state = 'transcribed' WHERE id = 'bw_dual'`);
  }, 300_000);

  it("0101 — the database refuses a verdict whose evidence contradicts itself", async () => {
    // Not silent: this window exists only to be refused by the CHECKs, and a constraint fixture has no place
    // in the population the re-adjudication path hands back.
    seedWindow("bw_chk", 4, { levels: null, state: "transcribed" });
    // 'absent' with a number, and 'recorder' without one: both are a lie about where the number came from.
    expect(() => pg.exec(`INSERT INTO bench_window_silence (window_id, session_id, verdict, engine, audio_level_source, peak_level, vad_params_source)
      VALUES ('bw_chk', 'sess_1', 'x', 'whisper', 'absent', 0.01, 'unreported');`)).toThrow(/bench_window_silence_level_chk/);
    expect(() => pg.exec(`INSERT INTO bench_window_silence (window_id, session_id, verdict, engine, audio_level_source, vad_params_source)
      VALUES ('bw_chk', 'sess_1', 'x', 'whisper', 'recorder', 'unreported');`)).toThrow(/bench_window_silence_level_chk/);
    // A row that is neither a verdict nor a ledger entry is nobody's record of anything.
    expect(() => pg.exec(`INSERT INTO bench_window_silence (window_id, session_id)
      VALUES ('bw_chk', 'sess_1');`)).toThrow(/bench_window_silence_row_kind_chk/);
    // R39 — a re-adjudication whose history is empty claims a pass it did not keep.
    expect(() => pg.exec(`INSERT INTO bench_window_silence (window_id, session_id, reopened_at, reopened_batch, reopened_reason, reopened_detector, reopened_history)
      VALUES ('bw_chk', 'sess_1', NOW(), 'b', 'r', 'd', '[]'::jsonb);`)).toThrow(/bench_window_silence_history_chk/);
    // A re-adjudication that cannot say which detector ran is refused by the database, not only by the code.
    expect(() => pg.exec(`INSERT INTO bench_window_silence (window_id, session_id, verdict, engine, audio_level_source, vad_params_source, reopened_at, reopened_batch)
      VALUES ('bw_chk', 'sess_1', 'x', 'whisper', 'absent', 'unreported', NOW(), 'b');`)).toThrow(/bench_window_silence_detector_chk/);
    // And an 'unreported' row may not carry a parameter it never observed.
    expect(() => pg.exec(`INSERT INTO bench_window_silence (window_id, session_id, verdict, engine, audio_level_source, vad_params_source, no_speech_thold)
      VALUES ('bw_chk', 'sess_1', 'x', 'whisper', 'absent', 'unreported', 0.6);`)).toThrow(/bench_window_silence_vad_chk/);
  }, 300_000);

  it("R1.1 — 'silent' is a state the database accepts and 'transcribed' is not a synonym for it", async () => {
    seedWindow("bw_state", 5, { levels: null, state: "transcribed" });
    pg.exec(`UPDATE bench_window SET state = 'silent' WHERE id = 'bw_state'`);
    expect(await stateOf("bw_state")).toBe("silent");
    expect(() => pg.exec(`UPDATE bench_window SET state = 'quiet' WHERE id = 'bw_state'`)).toThrow(/bench_window_state_chk/);
    // Put it back: this case is about the CHECK, and leaving it in the silent set would make it a fixture in
    // somebody else's population.
    pg.exec(`UPDATE bench_window SET state = 'transcribed' WHERE id = 'bw_state'`);
  }, 300_000);

  it("R1.3 — the set is queryable, and the whole backlog is handed back in ONE call, with its reason", async () => {
    const { listSilentWindows, reopenSilentWindows, silenceBacklog } = await import("@/lib/stt/silence");

    // A silent window with NO evidence row at all — a verdict from before 0101. It must be visible, because it
    // is the one most in need of a second look.
    seedWindow("bw_no_evidence", 6, { levels: null });

    const before = await listSilentWindows({});
    expect(before.map((r) => r.window_id).sort(), "every silent window, evidence or not")
      .toEqual(["bw_dead_mic", "bw_empty_room", "bw_no_evidence", "bw_no_level"]);
    expect(before.find((r) => r.window_id === "bw_no_evidence")).toMatchObject({ verdict: null, audio_level_source: null });
    expect(await silenceBacklog()).toEqual({ pending: 3, reopened: 0, no_evidence: 1 });

    // A bulk re-adjudication must be nameable and justified: this is a mechanism, not a wish.
    await expect(reopenSilentWindows({ batch: "", reason: "x", detector: "d", asOf: await dbNow() })).rejects.toThrow(/batch id is required/);
    await expect(reopenSilentWindows({ batch: "b1", reason: "  ", detector: "d", asOf: await dbNow() })).rejects.toThrow(/reason is required/);
    // R31.3 — and a run that cannot say which detector re-read the set is refused too: a second pass with a
    // better detector must be distinguishable from the first, or one verdict overwrote another unrecorded.
    await expect(reopenSilentWindows({ batch: "b1", reason: "r", detector: " ", asOf: await dbNow() })).rejects.toThrow(/detector is required/);

    const r = await reopenSilentWindows({ batch: "e15_vad_v2", reason: "E15 calibration landed; re-run the backlog", detector: "e15_vad_v2", asOf: await dbNow() });
    expect(r.reopened, "every silent window went back in one call, not one force at a time").toBe(4);
    expect(r.window_ids.sort()).toEqual(["bw_dead_mic", "bw_empty_room", "bw_no_evidence", "bw_no_level"]);
    for (const id of r.window_ids) expect(await stateOf(id), `${id} is back in the queue`).toBe("closed");
    expect(await evidenceOf("bw_empty_room")).toMatchObject({ reopened_batch: "e15_vad_v2", reopened_reason: "E15 calibration landed; re-run the backlog" });

    // Nothing is left to offer, and the ledger says who was re-run.
    expect(await listSilentWindows({})).toEqual([]);
    expect(await silenceBacklog()).toEqual({ pending: 0, reopened: 0, no_evidence: 0 });
    expect((await reopenSilentWindows({ batch: "again", reason: "second pass", detector: "e15_vad_v2", asOf: await dbNow() })).reopened, "a window already handed back is not handed back twice").toBe(0);
  }, 300_000);

  it("R1.3 — the filters pick a population, not everything: room, day and time bounds, and reopened rows stay out unless asked for", async () => {
    const { listSilentWindows, reopenSilentWindows } = await import("@/lib/stt/silence");
    const { recordSilenceVerdict, readWindowAudioLevel, readVadParams, VERDICT_EMPTY_TRANSCRIPT } = await import("@/lib/stt/silence");
    // Its own room and session: a filter test that shares a population with another case proves nothing about
    // filtering, and an order-dependent fixture is a fixture that will lie one day.
    pg.exec(`INSERT INTO bench_session (id, room_id, started_at, status) VALUES ('sess_f', 'room_f', to_timestamp(0), 'ended')`);
    seedWindow("bw_f1", 11, { levels: null, session: "sess_f", roomDay: "rd_a" });
    seedWindow("bw_f2", 12, { levels: null, session: "sess_f", roomDay: "rd_b" });
    for (const [id, n] of [["bw_f1", 11], ["bw_f2", 12]] as const) {
      await recordSilenceVerdict({
        windowId: id, roomDayId: id === "bw_f1" ? "rd_a" : "rd_b", sessionId: "sess_f",
        verdict: VERDICT_EMPTY_TRANSCRIPT, engine: "whisper", audioSeconds: 900,
        level: await readWindowAudioLevel("sess_f", "primary", startOf(n), startOf(n) + WINDOW_MS),
        vad: readVadParams({}), answer: null,
      });
    }
    expect((await listSilentWindows({ roomDayId: "rd_a" })).map((r) => r.window_id)).toEqual(["bw_f1"]);
    expect((await listSilentWindows({ roomId: "room_f" })).map((r) => r.window_id).sort()).toEqual(["bw_f1", "bw_f2"]);
    expect((await listSilentWindows({ roomId: "room_nobody" }))).toEqual([]);
    expect((await listSilentWindows({ roomId: "room_f", fromMs: startOf(12) })).map((r) => r.window_id)).toEqual(["bw_f2"]);
    expect((await listSilentWindows({ roomId: "room_f", toMs: startOf(12) })).map((r) => r.window_id)).toEqual(["bw_f1"]);

    await reopenSilentWindows({ roomDayId: "rd_a", batch: "b_day", reason: "one day only", detector: "e13_v1", asOf: await dbNow() });
    expect(await stateOf("bw_f1")).toBe("closed");
    expect(await stateOf("bw_f2"), "a filtered re-adjudication leaves the rest alone").toBe("silent");
    // The reopened row is out of the default set and back in with the flag — so a second pass can be asked for.
    pg.exec(`UPDATE bench_window SET state = 'silent' WHERE id = 'bw_f1'`);
    expect((await listSilentWindows({ roomDayId: "rd_a" }))).toEqual([]);
    expect((await listSilentWindows({ roomDayId: "rd_a", includeReopened: true })).map((r) => r.window_id)).toEqual(["bw_f1"]);
  }, 300_000);

  it("R1.3 — a bounded batch spends its limit on SILENT windows, not on windows that merely sit nearby", async () => {
    const { reopenSilentWindows, listSilentWindows } = await import("@/lib/stt/silence");
    // Two settled-but-not-silent windows FIRST on the clock, then two silent ones. An operator asking for two
    // must get the two silent ones: a batch that counted the others against its limit would quietly re-run half
    // the backlog it was asked for, and would look like it had done the job.
    pg.exec(`INSERT INTO bench_session (id, room_id, started_at, status) VALUES ('sess_lim', 'room_lim', to_timestamp(0), 'ended')`);
    seedWindow("bw_lim_done1", 41, { levels: null, session: "sess_lim", state: "transcribed" });
    seedWindow("bw_lim_done2", 42, { levels: null, session: "sess_lim", state: "transcribed" });
    seedWindow("bw_lim_sil1", 43, { levels: null, session: "sess_lim" });
    seedWindow("bw_lim_sil2", 44, { levels: null, session: "sess_lim" });

    const r = await reopenSilentWindows({ roomId: "room_lim", limit: 2, batch: "b_lim", reason: "bounded pass", detector: "e13_v1", asOf: await dbNow() });
    expect(r.reopened, "the limit is spent on the population asked for").toBe(2);
    expect(r.window_ids.sort()).toEqual(["bw_lim_sil1", "bw_lim_sil2"]);
    expect(await listSilentWindows({ roomId: "room_lim" }), "and the room's silent set is now empty").toEqual([]);
    expect(await stateOf("bw_lim_done1"), "a transcribed window is untouched by a silence batch").toBe("transcribed");
  }, 300_000);

  it("a re-drain of a silent window writes a NEW verdict and clears the re-adjudication stamps", async () => {
    const { recordSilenceVerdict, readWindowAudioLevel, readVadParams, reopenSilentWindows, VERDICT_EMPTY_TRANSCRIPT } = await import("@/lib/stt/silence");
    seedWindow("bw_redrain", 21, { levels: null, roomDay: "rd_redrain" });
    const verdict = async () => recordSilenceVerdict({
      windowId: "bw_redrain", roomDayId: "rd_redrain", sessionId: "sess_1", verdict: VERDICT_EMPTY_TRANSCRIPT,
      engine: "whisper", audioSeconds: 900,
      level: await readWindowAudioLevel("sess_1", "primary", startOf(21), startOf(21) + WINDOW_MS),
      vad: readVadParams({}), answer: null,
    });
    await verdict();
    await reopenSilentWindows({ roomDayId: "rd_redrain", batch: "b_redrain", reason: "second opinion", detector: "e13_v1", asOf: await dbNow() });
    expect(await evidenceOf("bw_redrain"), "it was re-adjudicated a moment ago").toMatchObject({ reopened_batch: "b_redrain" });
    pg.exec(`UPDATE bench_window SET state = 'silent' WHERE id = 'bw_redrain'`);
    await verdict();
    expect(await evidenceOf("bw_redrain"), "a new verdict has not been reviewed by the old batch")
      .toMatchObject({ reopened_at: null, reopened_batch: null, reopened_reason: null });
  }, 300_000);
});

describe.runIf(HAVE_DOCKER)("E18 R1.1 — the readers of the old state, on real SQL", () => {
  it("the operator's own count never adds silence to `done`, and says how much of it there is", async () => {
    // The card is where the fold would be invisible: a silent window counted as done reads as work finished.
    // This runs the REAL query from lib/admin/room-reads.ts, so a future edit that merges the two states —
    // state IN ('transcribed','silent') — fails here rather than in a month's operator report.
    pg.exec(`CREATE TABLE IF NOT EXISTS stt_subject_job (subject_type text, subject_id text, tier text, state text);`);
    pg.exec(`INSERT INTO bench_session (id, room_id, started_at, ended_at, status) VALUES ('sess_cnt', 'room_cnt', to_timestamp(0), to_timestamp(1), 'ended')`);
    seedWindow("bw_cnt_done", 31, { levels: null, session: "sess_cnt", state: "transcribed" });
    seedWindow("bw_cnt_sil1", 32, { levels: null, session: "sess_cnt" });
    seedWindow("bw_cnt_sil2", 33, { levels: null, session: "sess_cnt" });
    seedWindow("bw_cnt_wait", 34, { levels: null, session: "sess_cnt", state: "closed" });

    const { readTranscriptAndStranded } = await import("@/lib/admin/room-reads");
    const read = await readTranscriptAndStranded(["sess_cnt"]);
    expect(read.degraded, "the count must not be degraded for this to mean anything").toBeNull();
    const counts = read.value.get("room_cnt")!.counts;
    expect(counts.done, "ONE window actually produced words").toBe(1);
    expect(counts.silent, "and two were silence, counted apart").toBe(2);
    expect(counts.waiting).toBe(1);
    // The audio that turned into words is the transcribed window's alone: silence produced none.
    expect(counts.words_ms).toBe(WINDOW_MS);
  }, 300_000);
});

describe.runIf(HAVE_DOCKER)("E18 R31 — the operator surface, on real SQL", () => {
  const tool = async () => {
    const { STT_TOOLS } = await import("@/lib/mcp/tools/stt");
    return STT_TOOLS.find((t) => t.name === "scribe_silence_readjudicate")!;
  };
  const call = async (args: Record<string, unknown>) => (await (await tool()).handler(args as never, {} as never)) as Record<string, unknown>;
  const silentIn = async (room: string) =>
    ((await pg.sql`SELECT count(*)::int AS n FROM bench_window w JOIN bench_session s ON s.id = w.session_id
                    WHERE w.state = 'silent' AND s.room_id = ${room}`) as Array<{ n: number }>)[0]!.n;
  /**
   * R47 — THE OPERATOR'S TWO STEPS, in the order the surface now requires: read the set, then apply pinned to
   * the instant it was read at. Every apply below goes through here, so a change that lets an unpinned apply
   * through has to break this helper first.
   */
  const dryThenApply = async (args: Record<string, unknown>) => {
    const { apply: _apply, ...scope } = args;
    const would = (await call(scope)).would as Record<string, unknown>;
    return call({ ...args, apply: true, as_of: would.as_of });
  };

  beforeAll(() => {
    if (!HAVE_DOCKER) return;
    pg.exec(`INSERT INTO bench_session (id, room_id, started_at, status) VALUES ('sess_op', 'room_op', to_timestamp(0), 'ended')`);
    // A realistic mix: one window whose recorder metered it, three with nothing — the production shape.
    seedWindow("bw_op1", 51, { levels: [{ peak: 0.02, avg: 0.01 }, { peak: 0.02, avg: 0.01 }], session: "sess_op", roomDay: "rd_op1" });
    seedWindow("bw_op2", 52, { levels: null, session: "sess_op", roomDay: "rd_op1" });
    seedWindow("bw_op3", 53, { levels: null, session: "sess_op", roomDay: "rd_op2" });
    seedWindow("bw_op4", 54, { levels: null, session: "sess_op", roomDay: "rd_op2" });
  });

  it("the plain call is a DRY RUN: it writes nothing and says what it would re-adjudicate", async () => {
    const { recordSilenceVerdict, readWindowAudioLevel, readVadParams, VERDICT_EMPTY_TRANSCRIPT } = await import("@/lib/stt/silence");
    for (const [id, n] of [["bw_op1", 51], ["bw_op2", 52], ["bw_op3", 53]] as const) {
      await recordSilenceVerdict({
        windowId: id, roomDayId: n < 53 ? "rd_op1" : "rd_op2", sessionId: "sess_op", verdict: VERDICT_EMPTY_TRANSCRIPT,
        engine: "whisper", audioSeconds: 900,
        level: await readWindowAudioLevel("sess_op", "primary", startOf(n), startOf(n) + WINDOW_MS),
        vad: readVadParams({}), answer: null,
      });
    }
    const before = await silentIn("room_op");
    const r = await call({ room_id: "room_op" });
    expect(r.ok).toBe(true);
    expect(r.dry_run, "the default call is the preview").toBe(true);
    expect(await silentIn("room_op"), "and it moved nothing").toBe(before);

    const would = r.would as Record<string, unknown>;
    expect(would.windows).toBe(4);
    expect(would.rooms).toBe(1);
    expect(would.first_start_ms).toBe(startOf(51));
    expect(would.last_start_ms).toBe(startOf(54));
    // The distribution is the point: "re-adjudicate 4 windows" and "re-adjudicate 4 windows, 3 of which never
    // carried an audio level and one of which has no evidence row at all" are different decisions.
    expect(would.evidence).toEqual({ level_recorder: 1, level_absent: 2, no_evidence_row: 1, vad_reported: 0, vad_unreported: 3 });
    expect(would.by_engine).toEqual(expect.arrayContaining([{ engine: "whisper", n: 3 }, { engine: null, n: 1 }]));
  }, 300_000);

  it("apply is refused — and writes nothing — without a detector, without a reason, and unscoped without all_rooms", async () => {
    const before = await silentIn("room_op");
    const noDetector = await call({ room_id: "room_op", apply: true, reason: "because" });
    expect(noDetector).toMatchObject({ ok: false, dry_run: false, error: "detector_required" });
    const noReason = await call({ room_id: "room_op", apply: true, detector: "e13_v1" });
    expect(noReason).toMatchObject({ ok: false, dry_run: false, error: "reason_required" });
    // With a valid as_of, so the scope refusal is proved on its own and not merely masked by a missing bound.
    const unscoped = await call({ apply: true, detector: "e13_v1", reason: "the lot", as_of: await dbNow() });
    expect(unscoped).toMatchObject({ ok: false, dry_run: false, error: "unscoped_apply_needs_all_rooms" });
    // R47 — and an apply that was never shown a dry run is refused, before anything moves.
    const noAsOf = await call({ room_id: "room_op", apply: true, detector: "e13_v1", reason: "unpinned" });
    expect(noAsOf).toMatchObject({ ok: false, dry_run: false, error: "as_of_required" });
    const badAsOf = await call({ room_id: "room_op", apply: true, detector: "e13_v1", reason: "junk bound", as_of: "last tuesday" });
    expect(badAsOf).toMatchObject({ ok: false, dry_run: false, error: "as_of_invalid" });
    expect(unscoped.would, "a refused unscoped apply still shows the size of what was asked for").toBeDefined();
    expect(await silentIn("room_op"), "every refusal happened before the first row moved").toBe(before);
  }, 300_000);

  it("apply names its detector, moves only the scoped set, and the ledger keeps which detector ran", async () => {
    const r = await dryThenApply({ room_day_id: "rd_op1", detector: "e13_deadmic_v1", reason: "E13 landed; re-read the day" });
    expect(r).toMatchObject({ ok: true, dry_run: false, detector: "e13_deadmic_v1", reopened: 2 });
    expect(String(r.batch), "the batch names the detector and the time when the caller passes none").toContain("e13_deadmic_v1");
    expect(await stateOf("bw_op1")).toBe("closed");
    expect(await stateOf("bw_op3"), "the other day was not in scope").toBe("silent");
    const ledger = (await pg.sql`SELECT reopened_detector, reopened_reason FROM bench_window_silence WHERE window_id = 'bw_op1'`) as Array<Record<string, unknown>>;
    expect(ledger[0]).toMatchObject({ reopened_detector: "e13_deadmic_v1", reopened_reason: "E13 landed; re-read the day" });

    // R31.3 — a second pass with a better detector is distinguishable from the first.
    pg.exec(`UPDATE bench_window SET state = 'silent' WHERE id = 'bw_op1'`);
    const again = await dryThenApply({ room_day_id: "rd_op1", include_reopened: true, detector: "e13_deadmic_v2", reason: "better detector", batch: "b_v2" });
    expect(again).toMatchObject({ ok: true, reopened: 1, batch: "b_v2", detector: "e13_deadmic_v2" });
    const after = (await pg.sql`SELECT reopened_detector, reopened_batch FROM bench_window_silence WHERE window_id = 'bw_op1'`) as Array<Record<string, unknown>>;
    expect(after[0]).toEqual({ reopened_detector: "e13_deadmic_v2", reopened_batch: "b_v2" });
  }, 300_000);

  it("the preview leaves out windows already handed back, unless they are asked for", async () => {
    // bw_op1 carries a re-adjudication stamp from the case above. Put it back in 'silent' — a second verdict
    // after a re-run — and the default preview must not offer it again just because it is silent once more.
    pg.exec(`UPDATE bench_window SET state = 'silent' WHERE id = 'bw_op1'`);
    const plain = (await call({ room_day_id: "rd_op1" })).would as Record<string, unknown>;
    expect(plain.windows, "a window already re-adjudicated is not offered again by default").toBe(0);
    const asked = (await call({ room_day_id: "rd_op1", include_reopened: true })).would as Record<string, unknown>;
    expect(asked.windows, "and it comes back when the caller asks for it").toBe(1);
  }, 300_000);

  it("an unscoped apply IS allowed, once it is asked for in as many words", async () => {
    // include_reopened, because the case above deliberately left one window silent with a stamp on it.
    const r = await dryThenApply({ all_rooms: true, include_reopened: true, detector: "e15_vad_v2", reason: "calibration landed", batch: "b_all" });
    expect(r).toMatchObject({ ok: true, dry_run: false, batch: "b_all", detector: "e15_vad_v2" });
    expect(Number(r.reopened), "everything still silent across every room went back").toBeGreaterThan(0);
    expect(await silentIn("room_op")).toBe(0);
  }, 300_000);

  it("the tool is WRITE scope and nothing schedules it", async () => {
    expect((await tool()).scope).toBe("write");
    // No cron, no auto-drain, no migration hook: the only caller is a person at the door.
    const callers = execSync(`git grep -l "scribe_silence_readjudicate\\|reopenSilentWindows" -- lib app scripts || true`, { encoding: "utf8" })
      .split("\n").filter(Boolean).sort();
    expect(callers, "only the silence module and the operator tool name the bulk path")
      .toEqual(["lib/mcp/tools/stt.ts", "lib/stt/silence.ts"]);
  });
});

describe.runIf(HAVE_DOCKER)("E18 R37/R38/R39 — the preview is honest, and the ledger records every pass", () => {
  const tool = async () => (await import("@/lib/mcp/tools/stt")).STT_TOOLS.find((t) => t.name === "scribe_silence_readjudicate")!;
  const call = async (args: Record<string, unknown>) => (await (await tool()).handler(args as never, {} as never)) as Record<string, unknown>;
  const silentIn = async (room: string) =>
    ((await pg.sql`SELECT count(*)::int AS n FROM bench_window w JOIN bench_session s ON s.id = w.session_id
                    WHERE w.state = 'silent' AND s.room_id = ${room}`) as Array<{ n: number }>)[0]!.n;
  const ledger = async (id: string) =>
    ((await pg.sql`SELECT reopened_at::text AS reopened_at, reopened_batch, reopened_detector, reopened_history,
                          reopened_as_of::text AS reopened_as_of
                     FROM bench_window_silence WHERE window_id = ${id}`) as Array<Record<string, unknown>>)[0];
  /** R47 — the operator's two steps, as in the block above: read the set, then apply pinned to what was read. */
  const dryThenApply = async (args: Record<string, unknown>) => {
    const { apply: _apply, ...scope } = args;
    const would = (await call(scope)).would as Record<string, unknown>;
    return call({ ...args, apply: true, as_of: would.as_of });
  };

  it("R37 / X1 — 250 silent windows: the preview says what THIS call moves and how many match altogether, and the apply moves exactly that", async () => {
    // The Refuter's measurement, rerun here so it cannot drift back: preview 250, apply 100, 150 left was the
    // defect. One bound, two numbers, and the apply is held to the number the preview printed.
    pg.exec(`INSERT INTO bench_session (id, room_id, started_at, status) VALUES ('sess_250', 'room_250', to_timestamp(0), 'ended')`);
    const values = Array.from({ length: 250 }, (_, i) => {
      const start = startOf(1000 + i);
      return `('bw_250_${i}', 'sess_250', 'rd_250', ${start}, ${start + WINDOW_MS}, 'primary', 'clips/bw_250_${i}.webm', TRUE, 'silent', NOW())`;
    }).join(",");
    pg.exec(`INSERT INTO bench_window (id, session_id, room_day_id, start_ms, end_ms, source_mic, clip_r2_key, grid_aligned, state, closed_at) VALUES ${values};`);

    const preview = (await call({ room_id: "room_250" })).would as Record<string, unknown>;
    const eligible = preview.eligible as Record<string, unknown>;
    expect(preview.windows, "what this call would move, at the default limit").toBe(100);
    expect(eligible.total, "and how many match the filter altogether").toBe(250);

    const applied = await call({ room_id: "room_250", apply: true, as_of: preview.as_of, detector: "refuter_p1", reason: "the 250-window measurement" });
    expect(applied.reopened, "the apply moves exactly what the preview said it would").toBe(preview.windows);
    expect(await silentIn("room_250"), "and what is left is the difference, not a surprise").toBe(150);
    expect(applied.remaining_eligible, "the answer says how much is still waiting").toBe(150);

    // R47 — and the apply above was handed the preview's own as_of, so these are not two reads of a moving
    // world that happened to agree: the second is bounded by the first.
    // The same three numbers the Refuter measured, now equal by design: preview === moved, remaining === total − moved.
    expect({ preview: preview.windows, moved: applied.reopened, remaining: await silentIn("room_250") })
      .toEqual({ preview: 100, moved: 100, remaining: 150 });

    // X1 — the bound is the tool's promise, so a caller can raise it and see the whole set move.
    const rest = await dryThenApply({ room_id: "room_250", limit: 1000, detector: "refuter_p1", reason: "the rest" });
    expect(rest.reopened).toBe(150);
    expect(await silentIn("room_250")).toBe(0);
  }, 600_000);

  it("R38 / X3 — every moved window gets a ledger row, including one that had no evidence at all; nothing else is stamped", async () => {
    pg.exec(`INSERT INTO bench_session (id, room_id, started_at, status) VALUES ('sess_led', 'room_led', to_timestamp(0), 'ended')`);
    // No evidence row for either — the production shape 0101's header names, and the population that used to
    // move with nothing recorded.
    seedWindow("bw_led_moved", 61, { levels: null, session: "sess_led", roomDay: "rd_led_a" });
    seedWindow("bw_led_untouched", 62, { levels: null, session: "sess_led", roomDay: "rd_led_b" });
    expect(await ledger("bw_led_moved"), "nothing recorded about it yet").toBeUndefined();

    const r = await dryThenApply({ room_day_id: "rd_led_a", detector: "e13_v1", reason: "no-evidence population" });
    expect(r.reopened).toBe(1);

    const moved = await ledger("bw_led_moved");
    expect(moved, "R38: a moved window ALWAYS has a row saying who moved it and why").toMatchObject({ reopened_batch: expect.any(String), reopened_detector: "e13_v1" });
    expect((moved!.reopened_history as unknown[]), "one pass, recorded once").toHaveLength(1);
    // And it is no longer eligible: the silent hole that let the same windows be re-opened for ever is closed.
    expect(((await call({ room_id: "room_led" })).would as Record<string, unknown>).windows, "only the window nobody moved is still on offer").toBe(1);

    // X3 — a window outside the moved set carries NO stamp. A false ledger entry is worse than none: it says a
    // window was handed back when it never was.
    const untouched = await ledger("bw_led_untouched");
    expect(untouched === undefined || untouched.reopened_at === null, "a window that did not move is not stamped").toBe(true);
  }, 300_000);

  it("R39 — two passes on one window leave TWO records, oldest first, and a later verdict does not erase them", async () => {
    const { recordSilenceVerdict, readWindowAudioLevel, readVadParams, VERDICT_EMPTY_TRANSCRIPT } = await import("@/lib/stt/silence");
    pg.exec(`INSERT INTO bench_session (id, room_id, started_at, status) VALUES ('sess_hist', 'room_hist', to_timestamp(0), 'ended')`);
    seedWindow("bw_hist", 71, { levels: null, session: "sess_hist", roomDay: "rd_hist" });

    await dryThenApply({ room_day_id: "rd_hist", detector: "detector_A", reason: "first pass" });
    pg.exec(`UPDATE bench_window SET state = 'silent' WHERE id = 'bw_hist'`);
    await dryThenApply({ room_day_id: "rd_hist", include_reopened: true, detector: "detector_B", reason: "second pass" });

    const row = await ledger("bw_hist");
    const history = row!.reopened_history as Array<Record<string, unknown>>;
    expect(history, "R39: both passes survive — a better detector does not erase the fact of the first").toHaveLength(2);
    expect(history.map((h) => h.detector)).toEqual(["detector_A", "detector_B"]);
    expect(history.map((h) => h.reason)).toEqual(["first pass", "second pass"]);
    expect(row!.reopened_detector, "the scalars are the latest pass, for a cheap read").toBe("detector_B");

    // A fresh verdict clears the scalars — it has not been reviewed — but the history of having been
    // re-adjudicated twice is not the verdict's to erase.
    pg.exec(`UPDATE bench_window SET state = 'silent' WHERE id = 'bw_hist'`);
    await recordSilenceVerdict({
      windowId: "bw_hist", roomDayId: "rd_hist", sessionId: "sess_hist", verdict: VERDICT_EMPTY_TRANSCRIPT,
      engine: "whisper", audioSeconds: 900,
      level: await readWindowAudioLevel("sess_hist", "primary", startOf(71), startOf(71) + WINDOW_MS),
      vad: readVadParams({}), answer: null,
    });
    const after = await ledger("bw_hist");
    expect(after).toMatchObject({ reopened_at: null, reopened_detector: null });
    expect((after!.reopened_history as unknown[]), "the two passes are still on the record").toHaveLength(2);
  }, 300_000);

  it("the detector name is an identity, so it must be matchable: junk is refused by the tool and by the module", async () => {
    const { reopenSilentWindows } = await import("@/lib/stt/silence");
    const bad = await call({ room_id: "room_hist", apply: true, as_of: await dbNow(), detector: "NOT-A-DETECTOR: <script>", reason: "junk" });
    expect(bad).toMatchObject({ ok: false, error: "detector_name_invalid" });
    await expect(reopenSilentWindows({ roomId: "room_hist", batch: "b", reason: "r", detector: "two words", asOf: await dbNow() })).rejects.toThrow(/not a usable name/);
    // And a real name still passes, including the dotted and colonned shapes a version string uses.
    for (const name of ["e13_deadmic_v1", "e15.vad.2026-09-16", "silero:v5.1"]) expect(name).toMatch((await import("@/lib/stt/silence")).DETECTOR_NAME);
  }, 300_000);
});

describe.runIf(HAVE_DOCKER)("E18 R47/R48/R49 — the set is pinned in time, the order is total, and the stamp comes from the move", () => {
  const tool = async () => (await import("@/lib/mcp/tools/stt")).STT_TOOLS.find((t) => t.name === "scribe_silence_readjudicate")!;
  const call = async (args: Record<string, unknown>) => (await (await tool()).handler(args as never, {} as never)) as Record<string, unknown>;
  const verdictFor = async (id: string, n: number, session: string, roomDay: string) => {
    const { recordSilenceVerdict, readWindowAudioLevel, readVadParams, VERDICT_EMPTY_TRANSCRIPT } = await import("@/lib/stt/silence");
    await recordSilenceVerdict({
      windowId: id, roomDayId: roomDay, sessionId: session, verdict: VERDICT_EMPTY_TRANSCRIPT, engine: "whisper",
      audioSeconds: 900, level: await readWindowAudioLevel(session, "primary", startOf(n), startOf(n) + WINDOW_MS),
      vad: readVadParams({}), answer: null,
    });
  };

  it("R47 / P7 — a window that turns silent BETWEEN the preview and the apply is not moved by that apply", async () => {
    // The Refuter's P7, rerun as a committed test. Measured across the gap the apply moved FIVE windows after a
    // preview that described THREE: the apply was not bounded by what the operator read, only by the same filter
    // re-evaluated later. In a live clinic the drain writes silent verdicts continuously, so that gap is the
    // normal case and not an adversarial one.
    pg.exec(`INSERT INTO bench_session (id, room_id, started_at, status) VALUES ('sess_p7', 'room_p7', to_timestamp(0), 'ended')`);
    for (const [id, n] of [["bw_p7_a", 301], ["bw_p7_b", 302], ["bw_p7_c", 303]] as const) {
      seedWindow(id, n, { levels: null, session: "sess_p7", roomDay: "rd_p7" });
      await verdictFor(id, n, "sess_p7", "rd_p7");
    }
    // The two that will turn silent later EXIST ALREADY, closed and waiting for the drain — which is the real
    // shape: a window is created and closed long before anything reads it, and only the VERDICT lands late. A
    // fixture that creates them after the preview would pass against a bound read off the window's own age
    // instead of off its verdict, and would prove nothing about the case this test exists for.
    for (const [id, n] of [["bw_p7_d", 304], ["bw_p7_e", 305]] as const) {
      seedWindow(id, n, { levels: null, session: "sess_p7", roomDay: "rd_p7", state: "closed" });
    }

    const preview = (await call({ room_id: "room_p7" })).would as Record<string, unknown>;
    expect(preview.windows, "the operator reads three").toBe(3);
    expect(String(preview.as_of), "and is told the instant that answer was true at").toMatch(/^\d{4}-\d{2}-\d{2}/);

    // THE WORLD MOVES. The drain reaches those two and calls them silent, exactly as it does in a live clinic.
    for (const [id, n] of [["bw_p7_d", 304], ["bw_p7_e", 305]] as const) {
      pg.exec(`UPDATE bench_window SET state = 'silent' WHERE id = '${id}'`);
      await verdictFor(id, n, "sess_p7", "rd_p7");
    }
    const live = (await call({ room_id: "room_p7" })).would as Record<string, unknown>;
    expect(live.windows, "an unpinned read now finds five — this is the world the old apply used").toBe(5);

    const applied = await call({ room_id: "room_p7", apply: true, as_of: preview.as_of, detector: "e13_v1", reason: "P7" });
    expect(applied.reopened, "the apply moves what was PREVIEWED, not what matches now").toBe(3);
    expect((applied.window_ids as string[]).sort()).toEqual(["bw_p7_a", "bw_p7_b", "bw_p7_c"]);
    for (const id of ["bw_p7_d", "bw_p7_e"]) {
      expect(await stateOf(id), `${id} turned silent after the preview and was not swept up by it`).toBe("silent");
    }

    // R47 — and the bound is on the record, so which apply was pinned to what is answerable afterwards.
    const row = ((await pg.sql`SELECT reopened_as_of::text AS a, reopened_history FROM bench_window_silence WHERE window_id = 'bw_p7_a'`) as Array<Record<string, unknown>>)[0]!;
    expect(row.a, "the ledger records the bound this pass ran under").toBe(preview.as_of);
    const hist = row.reopened_history as Array<Record<string, unknown>>;
    expect(hist[hist.length - 1]!.as_of, "and so does the history entry for the pass").toBe(preview.as_of);

    // Passing the SAME as_of back a second time reproduces the same bounded set, which is what makes it a pin
    // rather than a timestamp: the two newcomers stay out however often it is replayed.
    const replay = (await call({ room_id: "room_p7", as_of: preview.as_of })).would as Record<string, unknown>;
    expect(replay.windows, "the three are gone and the two newcomers were never in the pinned set").toBe(0);
  }, 600_000);

  it("R48 / Z10 — a matching set LARGER than the limit: the apply moves the earliest windows, and the preview's span is theirs", async () => {
    // The only shape that separates an apply that orders from one that does not. With a set at or under the
    // limit both move everything and look identical, which is why Z10 survived every round so far. The rows are
    // INSERTED in descending start order on purpose: a scan that ignores ORDER BY then returns the LATEST
    // windows first, so "the earliest thirty" is a claim only the ORDER BY can satisfy.
    pg.exec(`INSERT INTO bench_session (id, room_id, started_at, status) VALUES ('sess_z10', 'room_z10', to_timestamp(0), 'ended')`);
    const N = 90;
    const rows = Array.from({ length: N }, (_, i) => i).reverse().map((i) => {
      const start = startOf(4000 + i);
      return `('bw_z10_${String(i).padStart(2, "0")}', 'sess_z10', 'rd_z10', ${start}, ${start + WINDOW_MS}, 'primary', 'clips/z10_${i}.webm', TRUE, 'silent', NOW())`;
    }).join(",");
    pg.exec(`INSERT INTO bench_window (id, session_id, room_day_id, start_ms, end_ms, source_mic, clip_r2_key, grid_aligned, state, closed_at) VALUES ${rows};`);

    const preview = (await call({ room_id: "room_z10", limit: 30 })).would as Record<string, unknown>;
    expect(preview.windows, "thirty of ninety").toBe(30);
    expect((preview.eligible as Record<string, unknown>).total).toBe(90);
    expect(Number(preview.first_start_ms), "the preview describes the EARLIEST thirty").toBe(startOf(4000));
    expect(Number(preview.last_start_ms)).toBe(startOf(4029));

    const applied = await call({ room_id: "room_z10", limit: 30, apply: true, as_of: preview.as_of, detector: "e13_v1", reason: "Z10" });
    expect(applied.reopened).toBe(30);
    const moved = (applied.window_ids as string[]).slice().sort();
    expect(moved, "and the apply moves exactly those, in the same order, by the same two keys")
      .toEqual(Array.from({ length: 30 }, (_, i) => `bw_z10_${String(i).padStart(2, "0")}`));

    // The cross-check that does not depend on the ids: the span the preview printed is the span that moved.
    const span = ((await pg.sql`SELECT min(start_ms)::bigint AS lo, max(start_ms)::bigint AS hi
                                  FROM bench_window WHERE id = ANY(${moved}::text[])`) as Array<{ lo: number; hi: number }>)[0]!;
    expect({ lo: Number(span.lo), hi: Number(span.hi) }, "preview and apply picked the same members of the same-sized set")
      .toEqual({ lo: Number(preview.first_start_ms), hi: Number(preview.last_start_ms) });
  }, 600_000);

  it("R48 — two windows sharing a start_ms: the id decides which a bounded read picks, in all three statements", async () => {
    // start_ms alone is not a total order. The Refuter could not make a three-row fixture diverge, which is the
    // definition of latent: the planner is free to choose and today it happens to choose consistently. The two
    // rows are INSERTED in DESCENDING id order so a scan that falls back on heap order picks the WRONG one, and
    // they carry different engines so the preview — which returns no ids — still says which one it picked.
    pg.exec(`INSERT INTO bench_session (id, room_id, started_at, status) VALUES ('sess_tie', 'room_tie', to_timestamp(0), 'ended')`);
    const at = startOf(5000);
    pg.exec(`INSERT INTO bench_window (id, session_id, room_day_id, start_ms, end_ms, source_mic, clip_r2_key, grid_aligned, state, closed_at) VALUES
      ('bw_tie_b', 'sess_tie', 'rd_tie', ${at}, ${at + WINDOW_MS}, 'backup',  'clips/tie_b.webm', TRUE, 'silent', NOW()),
      ('bw_tie_a', 'sess_tie', 'rd_tie', ${at}, ${at + WINDOW_MS}, 'primary', 'clips/tie_a.webm', TRUE, 'silent', NOW());`);
    const { recordSilenceVerdict, readWindowAudioLevel, readVadParams, listSilentWindows, VERDICT_EMPTY_TRANSCRIPT } = await import("@/lib/stt/silence");
    for (const [id, engine] of [["bw_tie_a", "engine_A"], ["bw_tie_b", "engine_B"]] as const) {
      await recordSilenceVerdict({
        windowId: id, roomDayId: "rd_tie", sessionId: "sess_tie", verdict: VERDICT_EMPTY_TRANSCRIPT, engine,
        audioSeconds: 900, level: await readWindowAudioLevel("sess_tie", "primary", at, at + WINDOW_MS),
        vad: readVadParams({}), answer: null,
      });
    }

    // 1. the read surface
    for (let i = 0; i < 3; i += 1) {
      const one = await listSilentWindows({ roomId: "room_tie", limit: 1 });
      expect(one.map((w) => w.window_id), `read ${i + 1}: the tie is broken the same way every time`).toEqual(["bw_tie_a"]);
    }
    // 2. the preview, which returns no ids — its by_engine roll-up is what names the window it picked
    const preview = (await call({ room_id: "room_tie", limit: 1 })).would as Record<string, unknown>;
    expect(preview.windows).toBe(1);
    expect(preview.by_engine, "the preview picked the lower id, not whichever the scan reached first")
      .toEqual([{ engine: "engine_A", n: 1 }]);
    // 3. the apply, which has to pick the SAME one
    const applied = await call({ room_id: "room_tie", limit: 1, apply: true, as_of: preview.as_of, detector: "e13_v1", reason: "tie" });
    expect(applied.window_ids, "and the apply agrees with the preview, because both orders are total").toEqual(["bw_tie_a"]);
  }, 300_000);

  it("R49 / Z12 — the ledger is built from the rows the UPDATE returned, and cannot be built from the picked set", async () => {
    // Z12 was "the stamp writes over `picked` instead of `moved`", separable only under a concurrent commit:
    // `moved` is a subset of `picked` exactly when someone else changed a row's state in between, and a stamp
    // over `picked` would then say a window had been handed back when it had not. Rather than test a race, the
    // divergence is made inexpressible: `picked` carries the id ALONE and the session and day the ledger needs
    // come out of the UPDATE's own RETURNING, so a stamp over `picked` does not resolve at all.
    const src = readFileSync("lib/stt/silence.ts", "utf8");
    const stmt = src.slice(src.indexOf("export async function reopenSilentWindows"));
    expect(stmt, "the UPDATE returns what the ledger writes").toMatch(/RETURNING w\.id, w\.session_id, w\.room_day_id/);
    expect(stmt, "and the ledger reads them off the moved set").toMatch(/FROM moved m CROSS JOIN bound b/);
    const picked = stmt.slice(stmt.indexOf("picked AS ("), stmt.indexOf("moved AS ("));
    expect(picked.slice(picked.indexOf("SELECT"), picked.indexOf("FROM")).trim(), "while picked selects the id ALONE")
      .toBe("SELECT w.id");

    // And the property it buys, measured: the ledger names every window that moved and no window that did not.
    pg.exec(`INSERT INTO bench_session (id, room_id, started_at, status) VALUES ('sess_z12', 'room_z12', to_timestamp(0), 'ended')`);
    seedWindow("bw_z12_moved", 601, { levels: null, session: "sess_z12", roomDay: "rd_z12" });
    seedWindow("bw_z12_notsilent", 602, { levels: null, session: "sess_z12", roomDay: "rd_z12", state: "transcribed" });
    const preview = (await call({ room_id: "room_z12" })).would as Record<string, unknown>;
    const applied = await call({ room_id: "room_z12", apply: true, as_of: preview.as_of, detector: "e13_v1", reason: "Z12" });
    expect(applied.reopened).toBe(1);
    const stamped = (await pg.sql`SELECT window_id FROM bench_window_silence WHERE reopened_batch = ${String(applied.batch)} ORDER BY window_id`) as Array<{ window_id: string }>;
    expect(stamped.map((r) => r.window_id), "one stamp, for the one window the UPDATE actually moved").toEqual(["bw_z12_moved"]);
  }, 300_000);
});

describe.runIf(HAVE_DOCKER)("E18 R51/R53 — a bound the server never issued, and the module's own refusals", () => {
  const tool = async () => (await import("@/lib/mcp/tools/stt")).STT_TOOLS.find((t) => t.name === "scribe_silence_readjudicate")!;
  const call = async (args: Record<string, unknown>) => (await (await tool()).handler(args as never, {} as never)) as Record<string, unknown>;
  const verdictFor = async (id: string, n: number, session: string, roomDay: string) => {
    const { recordSilenceVerdict, readWindowAudioLevel, readVadParams, VERDICT_EMPTY_TRANSCRIPT } = await import("@/lib/stt/silence");
    await recordSilenceVerdict({
      windowId: id, roomDayId: roomDay, sessionId: session, verdict: VERDICT_EMPTY_TRANSCRIPT, engine: "whisper",
      audioSeconds: 900, level: await readWindowAudioLevel(session, "primary", startOf(n), startOf(n) + WINDOW_MS),
      vad: readVadParams({}), answer: null,
    });
  };
  /** A bound no clock has reached. The database's clock is the one that matters, so it is read from there. */
  const tomorrow = async () =>
    ((await pg.sql`SELECT (now() + interval '1 day')::text AS t`) as Array<{ t: string }>)[0]!.t;

  it("R51 — a future as_of is refused by name, on the apply, and nothing moves", async () => {
    // The Refuter's measurement: preview 1, moved 2. `Date.parse` asks whether a string is A timestamp, not
    // whether it is one this system issued, so a caller passing tomorrow's date got the unbounded apply back
    // with the pin apparently satisfied. That is R47's defect wearing a different coat: a bound the caller can
    // widen is not a bound.
    pg.exec(`INSERT INTO bench_session (id, room_id, started_at, status) VALUES ('sess_r51', 'room_r51', to_timestamp(0), 'ended')`);
    seedWindow("bw_r51_seen", 801, { levels: null, session: "sess_r51", roomDay: "rd_r51" });
    await verdictFor("bw_r51_seen", 801, "sess_r51", "rd_r51");

    const preview = (await call({ room_id: "room_r51" })).would as Record<string, unknown>;
    expect(preview.windows, "the operator reads one").toBe(1);

    // A second window reaches a silent verdict after that read, exactly as in P7.
    seedWindow("bw_r51_late", 802, { levels: null, session: "sess_r51", roomDay: "rd_r51", state: "closed" });
    pg.exec(`UPDATE bench_window SET state = 'silent' WHERE id = 'bw_r51_late'`);
    await verdictFor("bw_r51_late", 802, "sess_r51", "rd_r51");

    const future = await tomorrow();
    const refused = await call({ room_id: "room_r51", apply: true, as_of: future, detector: "e13_v1", reason: "a bound of my own" });
    expect(refused, "refused by name, in the same family as as_of_required").toMatchObject({ ok: false, dry_run: false, error: "as_of_in_future" });
    for (const id of ["bw_r51_seen", "bw_r51_late"]) {
      expect(await stateOf(id), `${id} did not move: the refusal happened before the first row`).toBe("silent");
    }
    const stamps = ((await pg.sql`SELECT count(*)::int AS n FROM bench_window_silence
                                   WHERE window_id IN ('bw_r51_seen','bw_r51_late') AND reopened_at IS NOT NULL`) as Array<{ n: number }>)[0]!.n;
    expect(stamps, "and nothing was stamped either").toBe(0);

    // And the honest bound still works on the same fixture, which is what makes the refusal a fix and not a wall.
    const applied = await call({ room_id: "room_r51", apply: true, as_of: preview.as_of, detector: "e13_v1", reason: "the bound I was given" });
    expect(applied.reopened, "the pinned apply moves the one window the preview described").toBe(1);
    expect(await stateOf("bw_r51_late"), "the late one is still waiting, as it should be").toBe("silent");
  }, 600_000);

  it("R57 — the backfill sentinel is UNMINTABLE: both doors refuse it as caller input, and the old spelling shows why", async () => {
    const { reopenSilentWindows, DETECTOR_NAME, BACKFILL_DETECTOR_SENTINEL } = await import("@/lib/stt/silence");
    pg.exec(`INSERT INTO bench_session (id, room_id, started_at, status) VALUES ('sess_r57', 'room_r57', to_timestamp(0), 'ended')`);
    seedWindow("bw_r57", 821, { levels: null, session: "sess_r57", roomDay: "rd_r57" });
    await verdictFor("bw_r57", 821, "sess_r57", "rd_r57");
    const bound = (await call({ room_id: "room_r57" })).would as Record<string, unknown>;

    // (ii) THE VALIDATOR REFUSES IT. This is the property the whole design rests on, so it is pinned rather
    // than assumed: a caller cannot write the sentinel through the module or through the tool.
    expect(DETECTOR_NAME.test(BACKFILL_DETECTOR_SENTINEL), "the shape rule cannot express it at all").toBe(false);
    await expect(reopenSilentWindows({ roomId: "room_r57", batch: "b_r57", reason: "r", detector: BACKFILL_DETECTOR_SENTINEL, asOf: String(bound.as_of) }))
      .rejects.toThrow(/not a usable name/);
    const refusedAtTool = await call({ room_id: "room_r57", apply: true, as_of: bound.as_of, detector: BACKFILL_DETECTOR_SENTINEL, reason: "mint me a sentinel" });
    expect(refusedAtTool).toMatchObject({ ok: false, dry_run: false, error: "detector_name_invalid" });
    expect(await stateOf("bw_r57"), "and neither refusal moved anything").toBe("silent");

    // (iii) THE OLD SPELLING IS NOT A SENTINEL, and is not silently treated as one. unrecorded.pre-r31 passes
    // the caller shape rule, which is exactly why it was replaced: a value anyone can supply cannot also mean
    // "the system could not say". 0101 has never been applied anywhere, so no row carries it — and the
    // migration no longer contains that spelling at all, which is what this asserts rather than assuming.
    expect(DETECTOR_NAME.test("unrecorded.pre-r31"), "the old spelling was mintable — that was the defect").toBe(true);
    const migration = readFileSync("db/migrations/0101_bench_window_silence.sql", "utf8");
    expect(migration.includes("'unrecorded.pre-r31'"), "the migration writes only the unmintable spelling").toBe(false);
    expect(migration.includes("'(unrecorded.pre-r31)'"), "and it does write that one").toBe(true);
    // A row carrying the old spelling would be indistinguishable from a caller's own detector: the ledger
    // cannot tell them apart, which is the reason the sentinel had to change before 0101 ever ships.
    const applied = await call({ room_id: "room_r57", apply: true, as_of: bound.as_of, detector: "unrecorded.pre-r31", reason: "a caller minting the old spelling" });
    expect(applied, "the old spelling is accepted AS A CALLER'S DETECTOR, which is what made it unusable as a sentinel")
      .toMatchObject({ ok: true, detector: "unrecorded.pre-r31", reopened: 1 });
  }, 300_000);

  it("R54 — the check ANSWERS NOTHING: a fabricated bound is refused, and moves 0 (it fails closed, not open)", async () => {
    // The Refuter's probe. Postgres always returns one row for `SELECT (... > now()) AS future`, so an empty
    // answer needs a driver or proxy that reports success with nothing in it. That is exactly the case the old
    // `=== true` shape got wrong: undefined read as "not in the future", so the guard admitted a bound it had
    // never verified and a fabricated tomorrow moved a window. The anomaly is induced HERE, at the driver
    // boundary, because the shape of the guard is what is being tested — not Postgres's row-count behaviour.
    pg.exec(`INSERT INTO bench_session (id, room_id, started_at, status) VALUES ('sess_r54', 'room_r54', to_timestamp(0), 'ended')`);
    seedWindow("bw_r54", 811, { levels: null, session: "sess_r54", roomDay: "rd_r54" });
    await verdictFor("bw_r54", 811, "sess_r54", "rd_r54");
    const future = await tomorrow();

    const real = H.sql!;
    let asked = 0;
    // Every other statement runs for real; only the future check answers with no rows.
    H.sql = ((strings: TemplateStringsArray, ...values: unknown[]) => {
      if (strings.join("?").includes("AS future")) { asked += 1; return Promise.resolve([]); }
      return real(strings, ...values);
    }) as typeof real;
    let refused: Record<string, unknown>;
    let moduleThrew = "";
    try {
      refused = await call({ room_id: "room_r54", apply: true, as_of: future, detector: "e13_v1", reason: "a bound nobody confirmed" });
      const { reopenSilentWindows } = await import("@/lib/stt/silence");
      moduleThrew = await reopenSilentWindows({ roomId: "room_r54", batch: "b_r54", reason: "r", detector: "e13_v1", asOf: future })
        .then(() => "", (e: Error) => String(e.message));
    } finally {
      H.sql = real;
    }

    expect(asked, "the check did run — this is an empty answer, not a skipped guard").toBeGreaterThan(0);
    expect(refused!, "an answer it cannot read is a refusal").toMatchObject({ ok: false, dry_run: false, error: "as_of_in_future" });
    expect(moduleThrew, "and the module's own door refuses the same way").toMatch(/as_of_in_future/);
    // THE NUMBER THE REFUTER MEASURED AS 1. Both doors, nothing moved, nothing stamped.
    const stillSilent = ((await pg.sql`SELECT count(*)::int AS n FROM bench_window w JOIN bench_session s ON s.id = w.session_id
                                        WHERE s.room_id = 'room_r54' AND w.state = 'silent'`) as Array<{ n: number }>)[0]!.n;
    const moved = 1 - stillSilent;
    expect(moved, "moved").toBe(0);
    expect(await stateOf("bw_r54")).toBe("silent");
    expect(((await pg.sql`SELECT count(*)::int AS n FROM bench_window_silence WHERE window_id = 'bw_r54' AND reopened_at IS NOT NULL`) as Array<{ n: number }>)[0]!.n,
      "and no ledger row claims it was handed back").toBe(0);
  }, 300_000);

  it("R55 — the two clocks DISAGREE: a bound the database has reached is accepted even when this process's clock has not", async () => {
    // The clock choice is the point. The as_of is minted by now() inside the preview's own statement, so the
    // database is the only clock that can judge it; a serverless runtime lagging Neon by even a moment would
    // otherwise reject a bound it had just been given. Nothing separated the two clocks before this test, so
    // the reasoning was sound and untested — swapping in Date.now() passed everything.
    //
    // The skew is induced on THIS process only: Date is frozen an hour behind the database. On the real code
    // the answer is the database's and the apply proceeds; on a Date.now() comparison the as_of looks like an
    // hour into the future and the apply refuses, which is the legitimate bound being thrown away.
    pg.exec(`INSERT INTO bench_session (id, room_id, started_at, status) VALUES ('sess_r55', 'room_r55', to_timestamp(0), 'ended')`);
    seedWindow("bw_r55", 812, { levels: null, session: "sess_r55", roomDay: "rd_r55" });
    await verdictFor("bw_r55", 812, "sess_r55", "rd_r55");
    const preview = (await call({ room_id: "room_r55" })).would as Record<string, unknown>;
    expect(preview.windows, "one window, and its bound comes from the database").toBe(1);

    const HOUR = 3_600_000;
    vi.useFakeTimers({ toFake: ["Date"], now: Date.now() - HOUR });
    let applied: Record<string, unknown>;
    try {
      // Sanity: the skew is real and in the direction that would matter — the database's bound is "ahead" of
      // this process's clock, which is precisely what a Date.now() check would call the future.
      expect(Date.parse(String(preview.as_of)) > Date.now(), "the bound looks future-dated to this process").toBe(true);
      applied = await call({ room_id: "room_r55", apply: true, as_of: preview.as_of, detector: "e13_v1", reason: "the bound the preview gave me" });
    } finally {
      vi.useRealTimers();
    }
    expect(applied!, "the database's clock decides, so the legitimate bound is honoured").toMatchObject({ ok: true, dry_run: false, reopened: 1 });
    expect(await stateOf("bw_r55"), "and the window actually moved").toBe("closed");
  }, 300_000);

  it("R51 — the dry run refuses it too, so a fabricated bound is found while reading and not after asking to write", async () => {
    const future = await tomorrow();
    const dry = await call({ room_id: "room_r51", as_of: future });
    expect(dry).toMatchObject({ ok: false, dry_run: true, error: "as_of_in_future" });
    // A bound the server HAS reached is still accepted on the dry run — the refusal is about the future, not
    // about passing an as_of at all.
    const ok = await call({ room_id: "room_r51", as_of: await dbNow() });
    expect(ok.ok).toBe(true);
  }, 300_000);

  it("R51 / R53 — the module refuses on its own: the tool is not the only door", async () => {
    const { reopenSilentWindows } = await import("@/lib/stt/silence");
    const base = { roomId: "room_r51", batch: "b_r51", reason: "r", detector: "e13_v1" };
    // R51 at the module. A direct caller that skipped the surface gets the same rule and the same name.
    await expect(reopenSilentWindows({ ...base, asOf: await tomorrow() })).rejects.toThrow(/as_of_in_future/);
    // R53 / A2 — an EMPTY as_of fails HERE, with the published name, not at the database on ''::timestamptz.
    // Removing that throw leaves the call failing anyway, one layer down and with a cast error for a message,
    // which is the difference this asserts.
    await expect(reopenSilentWindows({ ...base, asOf: "" })).rejects.toThrow(/as_of_required/);
    await expect(reopenSilentWindows({ ...base, asOf: "   " })).rejects.toThrow(/as_of_required/);
    await expect(reopenSilentWindows({ ...base, asOf: "last tuesday" })).rejects.toThrow(/as_of_invalid/);
    // None of the four reached a statement: the room is untouched.
    expect(((await pg.sql`SELECT count(*)::int AS n FROM bench_window w JOIN bench_session s ON s.id = w.session_id
                           WHERE s.room_id = 'room_r51' AND w.state = 'silent'`) as Array<{ n: number }>)[0]!.n)
      .toBe(1);
  }, 300_000);

  it("R52 — THE LIMIT, MEASURED: a silent window with no evidence row slips any bound; only the drain's write order keeps that population from growing", async () => {
    // Rule 21. This is the Refuter's preview 1, moved 2, reproduced deliberately rather than fixed: with no
    // `decided_at` the as-of falls back to `closed_at`, which precedes any later verdict, so the window is
    // inside every bound an operator can pass. It is NOT reachable in production — `recordSilenceVerdict`
    // runs in the drain's segment step BEFORE the state moves in finish, so a crash leaves a row without a
    // silent state and never a silent state without a row. That order is the whole guarantee and it is pinned
    // in tests/unit/e11-silent-room-window.test.ts ("R52 — the verdict row is written BEFORE the state
    // moves"); the comments at both drain lines say what breaks if it is reversed. This test exists so the
    // limit is a measured number in the repo rather than a claim in a report, and so that anyone who closes
    // it has to come here and say they did.
    pg.exec(`INSERT INTO bench_session (id, room_id, started_at, status) VALUES ('sess_r52', 'room_r52', to_timestamp(0), 'ended')`);
    seedWindow("bw_r52_seen", 811, { levels: null, session: "sess_r52", roomDay: "rd_r52" });
    await verdictFor("bw_r52_seen", 811, "sess_r52", "rd_r52");
    // Closed and waiting, with no verdict of any kind — the shape the drain cannot produce in this order.
    seedWindow("bw_r52_noev", 812, { levels: null, session: "sess_r52", roomDay: "rd_r52", state: "closed" });

    const preview = (await call({ room_id: "room_r52" })).would as Record<string, unknown>;
    expect(preview.windows, "the operator reads one").toBe(1);

    // BY HAND: the state moves with no evidence row behind it. Nothing in the drain does this.
    pg.exec(`UPDATE bench_window SET state = 'silent' WHERE id = 'bw_r52_noev'`);

    const applied = await call({ room_id: "room_r52", apply: true, as_of: preview.as_of, detector: "e13_v1", reason: "R52 limit" });
    expect(applied.reopened, "MEASURED, and still open: the unevidenced window slips the bound").toBe(2);
    expect((applied.window_ids as string[]).sort()).toEqual(["bw_r52_noev", "bw_r52_seen"]);
    // R38 still holds over it: it moved, so it has a ledger row now.
    const led = ((await pg.sql`SELECT reopened_detector FROM bench_window_silence WHERE window_id = 'bw_r52_noev'`) as Array<Record<string, unknown>>)[0];
    expect(led?.reopened_detector, "a moved window always gets its row, evidence or not").toBe("e13_v1");
  }, 600_000);
});

/**
 * R50 — 0101 MUST UPGRADE A DATABASE THAT ALREADY HOLDS AN EARLIER SHAPE.
 *
 * Everything else in this file runs against a database where 0101 created the table from nothing, and that path
 * can never see this defect: `CREATE TABLE IF NOT EXISTS` with the new columns inside the body SUCCEEDS AND DOES
 * NOTHING on a database that already has the table, so the columns never arrive and the code then fails on
 * columns that are not there — the exact failure 0097 was written to prove, one migration later. 0101 was edited
 * in place three times, so a database holding one of its earlier drafts is a real starting state, not a
 * hypothetical one.
 */
describe.runIf(HAVE_DOCKER)("E18 R50 — 0101 on a database that already holds the earlier shape", () => {
  /**
   * The first draft of 0101 (commit 56320ba), frozen. Copied rather than read out of git so the test does not
   * depend on a sha surviving a squash: this is the shape, and if it is ever wrong the assertions below stop
   * meaning anything, which is why it says which columns and CHECKs it deliberately lacks.
   *   no reopened_detector (added by R31.3), no reopened_history (R39), no reopened_as_of (R47);
   *   verdict / engine / audio_level_source / vad_params_source are NOT NULL (R38 makes them nullable);
   *   no detector, row-kind or history CHECK.
   */
  const EARLIER_SHAPE = `
    CREATE TABLE bench_window_silence (
      window_id          TEXT PRIMARY KEY REFERENCES public.bench_window(id) ON DELETE CASCADE,
      room_day_id        TEXT,
      session_id         TEXT,
      decided_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      verdict            TEXT NOT NULL,
      engine             TEXT NOT NULL,
      engine_version     TEXT,
      audio_seconds      DOUBLE PRECISION,
      audio_level_source TEXT NOT NULL,
      peak_level         REAL,
      avg_level          REAL,
      level_chunks       INTEGER NOT NULL DEFAULT 0,
      total_chunks       INTEGER NOT NULL DEFAULT 0,
      vad_params_source  TEXT NOT NULL,
      vad_enabled        BOOLEAN,
      no_speech_thold    DOUBLE PRECISION,
      suppress_nst       BOOLEAN,
      silero_version     TEXT,
      answer_json        JSONB,
      reopened_at        TIMESTAMPTZ,
      reopened_batch     TEXT,
      reopened_reason    TEXT,
      CONSTRAINT bench_window_silence_level_src_chk CHECK (audio_level_source IN ('recorder','absent')),
      CONSTRAINT bench_window_silence_level_chk
        CHECK ((audio_level_source = 'recorder') = (peak_level IS NOT NULL OR avg_level IS NOT NULL)),
      CONSTRAINT bench_window_silence_vad_src_chk CHECK (vad_params_source IN ('service','unreported')),
      CONSTRAINT bench_window_silence_vad_chk
        CHECK (vad_params_source = 'service'
               OR (vad_enabled IS NULL AND no_speech_thold IS NULL AND suppress_nst IS NULL AND silero_version IS NULL)),
      CONSTRAINT bench_window_silence_reopen_chk CHECK ((reopened_at IS NULL) = (reopened_batch IS NULL))
    );`;

  const PROBE = "upgrade_probe";
  const cols = async () =>
    Object.fromEntries(((await pg.sql`SELECT column_name, is_nullable FROM information_schema.columns
                                       WHERE table_schema = ${PROBE} AND table_name = 'bench_window_silence'`) as Array<{ column_name: string; is_nullable: string }>)
      .map((c) => [c.column_name, c.is_nullable]));
  const checks = async () =>
    ((await pg.sql`SELECT conname FROM pg_constraint
                    WHERE conrelid = ${`${PROBE}.bench_window_silence`}::regclass AND contype = 'c' ORDER BY conname`) as Array<{ conname: string }>)
      .map((r) => r.conname);

  it("the columns arrive, the NOT NULLs are lifted, and the CHECKs added after the first draft are there", async () => {
    // A database at the first draft, with a verdict row and a re-adjudication recorded under it.
    pg.exec(`INSERT INTO bench_session (id, room_id, started_at, status) VALUES ('sess_up', 'room_up', to_timestamp(0), 'ended');
             INSERT INTO bench_window (id, session_id, room_day_id, start_ms, end_ms, source_mic, clip_r2_key, grid_aligned, state, closed_at)
             VALUES ('bw_up_legacy', 'sess_up', 'rd_up', ${startOf(7001)}, ${startOf(7001) + WINDOW_MS}, 'primary', 'clips/up.webm', TRUE, 'silent', NOW()),
                    ('bw_up_ledger', 'sess_up', 'rd_up', ${startOf(7002)}, ${startOf(7002) + WINDOW_MS}, 'primary', 'clips/up2.webm', TRUE, 'silent', NOW());
             CREATE SCHEMA ${PROBE};
             SET search_path TO ${PROBE}, public;
             ${EARLIER_SHAPE}
             INSERT INTO bench_window_silence
               (window_id, session_id, room_day_id, verdict, engine, audio_level_source, vad_params_source,
                reopened_at, reopened_batch, reopened_reason)
             VALUES ('bw_up_legacy', 'sess_up', 'rd_up', 'engine_empty_transcript', 'whisper', 'absent', 'unreported',
                     NOW(), 'batch_before_r31', 'a pass recorded when the ledger had no detector column');`);

    const before = await cols();
    expect(before.reopened_detector, "the starting state really is the earlier shape").toBeUndefined();
    expect(before.reopened_history).toBeUndefined();
    expect(before.verdict, "and its verdict column really is NOT NULL").toBe("NO");

    // THE MIGRATION, verbatim, against that database.
    pg.exec(`SET search_path TO ${PROBE}, public;\n${noRecord("db/migrations/0101_bench_window_silence.sql")}`);

    const after = await cols();
    for (const c of ["reopened_detector", "reopened_history", "reopened_as_of"]) {
      expect(after[c], `${c} arrived on a table the CREATE TABLE branch never touched`).toBeDefined();
    }
    for (const c of ["verdict", "engine", "audio_level_source", "vad_params_source"]) {
      expect(after[c], `${c} is nullable, so R38's ledger-only row is legal here too`).toBe("YES");
    }
    expect(await checks()).toEqual(expect.arrayContaining([
      "bench_window_silence_detector_chk", "bench_window_silence_history_chk", "bench_window_silence_row_kind_chk",
    ]));
  }, 300_000);

  it("the pass recorded before the ledger had a detector is named as unrecorded, not invented, and not deleted", async () => {
    const row = ((await pg.sql`SELECT reopened_batch, reopened_detector, reopened_as_of::text AS as_of, reopened_history
                                 FROM upgrade_probe.bench_window_silence WHERE window_id = 'bw_up_legacy'`) as Array<Record<string, unknown>>)[0]!;
    // The detector CHECK cannot be added while a reopened row carries no detector, and there is no way to find
    // out which detector ran — the fact was never written down. So it is NAMED, the same move this table makes
    // with audio_level_source='absent'. Inventing a real detector name here would be the smuggled classifier.
    // R57 — the sentinel is PARENTHESISED so that no caller can ever mint it (see BACKFILL_DETECTOR_SENTINEL).
    const { BACKFILL_DETECTOR_SENTINEL } = await import("@/lib/stt/silence");
    expect(row.reopened_detector).toBe("(unrecorded.pre-r31)");
    expect(row.reopened_detector, "and the module and the migration agree on the one spelling").toBe(BACKFILL_DETECTOR_SENTINEL);
    expect((row.reopened_history as Array<Record<string, unknown>>)[0]!.detector, "the history entry carries it too").toBe(BACKFILL_DETECTOR_SENTINEL);
    // The widened CHECK admits it BY LITERAL: the same shape with any other text inside the parentheses is not
    // a sentinel and is refused, so "parenthesised" never becomes a second, open vocabulary.
    pg.exec(`UPDATE upgrade_probe.bench_window_silence SET reopened_detector = '(unrecorded.pre-r31)' WHERE window_id = 'bw_up_legacy'`);
    expect(() => pg.exec(`UPDATE upgrade_probe.bench_window_silence SET reopened_detector = '(something.else)' WHERE window_id = 'bw_up_legacy'`))
      .toThrow(/bench_window_silence_detector_chk/);
    expect(() => pg.exec(`UPDATE upgrade_probe.bench_window_silence SET reopened_detector = 'two words' WHERE window_id = 'bw_up_legacy'`))
      .toThrow(/bench_window_silence_detector_chk/);
    expect(row.reopened_batch, "and the pass that WAS recorded is untouched").toBe("batch_before_r31");
    expect((row.reopened_history as unknown[]), "R39's history is backfilled from the scalars, one entry for the one pass").toHaveLength(1);
    expect((row.reopened_history as Array<Record<string, unknown>>)[0]!.batch).toBe("batch_before_r31");
    expect(row.as_of, "an unbounded pass really was unbounded: R47's bound stays NULL rather than being guessed").toBeNull();
  }, 300_000);

  it("after the upgrade the table behaves like a fresh one: a ledger-only row is accepted, a row that is neither is refused", async () => {
    // R38's write — the whole reason the NOT NULLs came off — against the UPGRADED table.
    pg.exec(`INSERT INTO upgrade_probe.bench_window_silence
               (window_id, session_id, room_day_id, reopened_at, reopened_batch, reopened_reason, reopened_detector, reopened_history)
             VALUES ('bw_up_ledger', 'sess_up', 'rd_up', NOW(), 'b_after', 'first ledger row', 'e13_v1',
                     jsonb_build_array(jsonb_build_object('at', NOW(), 'batch', 'b_after', 'detector', 'e13_v1')));`);
    const n = ((await pg.sql`SELECT count(*)::int AS n FROM upgrade_probe.bench_window_silence WHERE window_id = 'bw_up_ledger'`) as Array<{ n: number }>)[0]!.n;
    expect(n, "a moved window with no verdict gets its first row here too").toBe(1);

    // And the row-kind CHECK is load-bearing on the upgraded table, not merely present.
    expect(() => pg.exec(`INSERT INTO upgrade_probe.bench_window_silence (window_id, session_id) VALUES ('bw_up_legacy2', 'sess_up');`))
      .toThrow(/row_kind_chk|violates/);
  }, 300_000);
});

describe("E18 R50 — the rule that stops this recurring (no database: it reads the .sql)", () => {
  const body = readFileSync("db/migrations/0101_bench_window_silence.sql", "utf8");

  it("every column in the CREATE TABLE body is also stated as an ADD COLUMN IF NOT EXISTS, with no exception list", () => {
    // The defect was not one forgotten column, it was a file with two places a column has to be named and only
    // one of them enforced. This is the enforcement. No exception list, on purpose — the same reason
    // migrations-self-record has none: an exception is how the seventh one gets in.
    const create = body.slice(body.indexOf("CREATE TABLE IF NOT EXISTS bench_window_silence ("));
    const declared = create.slice(0, create.indexOf("\n);"))
      .split("\n").map((l) => /^ {2}([a-z_]+) +[A-Z]/.exec(l)?.[1]).filter(Boolean) as string[];
    expect(declared.length, "the column list parsed at all").toBeGreaterThan(20);
    const missing = declared.filter((c) => !new RegExp(`ALTER TABLE bench_window_silence ADD COLUMN IF NOT EXISTS ${c}\\b`).test(body));
    expect(missing, "a column added to the body alone never reaches a database that already has the table").toEqual([]);
  });

  it("the CREATE TABLE copy of each new CHECK says the same thing as the ALTER copy", () => {
    // The ALTER runs on EVERY database, fresh or upgraded, so it — not the CREATE TABLE body — is what actually
    // governs the constraint. That makes the body's copy a duplicate, and two copies of one predicate are free
    // to drift: weaken the body and a fresh database is repaired by the ALTER, so nothing fails and the file
    // now says two different things. This is what stops that, and it is why the body keeps its copy at all.
    const norm = (t: string) => t.replace(/--[^\n]*/g, " ").replace(/\s+/g, " ").replace(/\s*([(),])\s*/g, "$1").trim();
    for (const c of ["bench_window_silence_detector_chk", "bench_window_silence_row_kind_chk", "bench_window_silence_history_chk"]) {
      const inBody = new RegExp(`  CONSTRAINT ${c}\\s*\\n?([\\s\\S]*?)(?=,\\n  (?:--|CONSTRAINT)|\\n\\);)`).exec(body)?.[1];
      const inAlter = new RegExp(`ALTER TABLE bench_window_silence ADD CONSTRAINT ${c}\\s*\\n?([\\s\\S]*?);`).exec(body)?.[1];
      expect(inBody, `${c} is declared in the CREATE TABLE body`).toBeDefined();
      expect(inAlter, `${c} is declared as an ALTER`).toBeDefined();
      expect(norm(inAlter!), `${c}: the body and the ALTER must not drift apart`).toBe(norm(inBody!));
    }
  });

  it("the constraints added after the first draft are dropped-if-exists before being added", () => {
    // ADD CONSTRAINT has no IF NOT EXISTS, so an unguarded ADD fails the second time the file runs and a
    // constraint whose text changes never reaches a database that has the old one.
    for (const c of ["bench_window_silence_detector_chk", "bench_window_silence_row_kind_chk", "bench_window_silence_history_chk"]) {
      expect(body, `${c} is re-addable`).toContain(`ALTER TABLE bench_window_silence DROP CONSTRAINT IF EXISTS ${c};`);
      expect(body).toContain(`ALTER TABLE bench_window_silence ADD CONSTRAINT ${c}`);
    }
  });
});

describe("E18 — what the service tells us about the flags it ran under (pure)", () => {
  it("today's answer reports nothing, and nothing is invented", async () => {
    const { readVadParams } = await import("@/lib/stt/silence");
    for (const answer of [{}, null, { ok: false, error: "empty_transcript", latency_ms: 10 }, { params: "no" }, { vad: {} }]) {
      expect(readVadParams(answer)).toEqual({ source: "unreported", vad_enabled: null, no_speech_thold: null, suppress_nst: null, silero_version: null });
    }
  });

  it("when the service DOES report them, they are carried — including a partial report", async () => {
    const { readVadParams } = await import("@/lib/stt/silence");
    expect(readVadParams({ vad: { vad: true, no_speech_thold: 0.6, suppress_nst: false, silero_version: "v5.1" } }))
      .toEqual({ source: "service", vad_enabled: true, no_speech_thold: 0.6, suppress_nst: false, silero_version: "v5.1" });
    // A partial report is still a report: what it names is a fact, and the rest stays NULL rather than assumed.
    expect(readVadParams({ params: { no_speech_thold: 0.45 } }))
      .toEqual({ source: "service", vad_enabled: null, no_speech_thold: 0.45, suppress_nst: null, silero_version: null });
    // A non-finite threshold is not a threshold.
    expect(readVadParams({ vad: { no_speech_thold: Number.NaN } }).source).toBe("unreported");
  });
});

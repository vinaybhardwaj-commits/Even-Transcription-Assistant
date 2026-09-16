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
    await expect(reopenSilentWindows({ batch: "", reason: "x", detector: "d" })).rejects.toThrow(/batch id is required/);
    await expect(reopenSilentWindows({ batch: "b1", reason: "  ", detector: "d" })).rejects.toThrow(/reason is required/);
    // R31.3 — and a run that cannot say which detector re-read the set is refused too: a second pass with a
    // better detector must be distinguishable from the first, or one verdict overwrote another unrecorded.
    await expect(reopenSilentWindows({ batch: "b1", reason: "r", detector: " " })).rejects.toThrow(/detector is required/);

    const r = await reopenSilentWindows({ batch: "e15_vad_v2", reason: "E15 calibration landed; re-run the backlog", detector: "e15_vad_v2" });
    expect(r.reopened, "every silent window went back in one call, not one force at a time").toBe(4);
    expect(r.window_ids.sort()).toEqual(["bw_dead_mic", "bw_empty_room", "bw_no_evidence", "bw_no_level"]);
    for (const id of r.window_ids) expect(await stateOf(id), `${id} is back in the queue`).toBe("closed");
    expect(await evidenceOf("bw_empty_room")).toMatchObject({ reopened_batch: "e15_vad_v2", reopened_reason: "E15 calibration landed; re-run the backlog" });

    // Nothing is left to offer, and the ledger says who was re-run.
    expect(await listSilentWindows({})).toEqual([]);
    expect(await silenceBacklog()).toEqual({ pending: 0, reopened: 0, no_evidence: 0 });
    expect((await reopenSilentWindows({ batch: "again", reason: "second pass", detector: "e15_vad_v2" })).reopened, "a window already handed back is not handed back twice").toBe(0);
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

    await reopenSilentWindows({ roomDayId: "rd_a", batch: "b_day", reason: "one day only", detector: "e13_v1" });
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

    const r = await reopenSilentWindows({ roomId: "room_lim", limit: 2, batch: "b_lim", reason: "bounded pass", detector: "e13_v1" });
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
    await reopenSilentWindows({ roomDayId: "rd_redrain", batch: "b_redrain", reason: "second opinion", detector: "e13_v1" });
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
    const unscoped = await call({ apply: true, detector: "e13_v1", reason: "the lot" });
    expect(unscoped).toMatchObject({ ok: false, dry_run: false, error: "unscoped_apply_needs_all_rooms" });
    expect(unscoped.would, "a refused unscoped apply still shows the size of what was asked for").toBeDefined();
    expect(await silentIn("room_op"), "every refusal happened before the first row moved").toBe(before);
  }, 300_000);

  it("apply names its detector, moves only the scoped set, and the ledger keeps which detector ran", async () => {
    const r = await call({ room_day_id: "rd_op1", apply: true, detector: "e13_deadmic_v1", reason: "E13 landed; re-read the day" });
    expect(r).toMatchObject({ ok: true, dry_run: false, detector: "e13_deadmic_v1", reopened: 2 });
    expect(String(r.batch), "the batch names the detector and the time when the caller passes none").toContain("e13_deadmic_v1");
    expect(await stateOf("bw_op1")).toBe("closed");
    expect(await stateOf("bw_op3"), "the other day was not in scope").toBe("silent");
    const ledger = (await pg.sql`SELECT reopened_detector, reopened_reason FROM bench_window_silence WHERE window_id = 'bw_op1'`) as Array<Record<string, unknown>>;
    expect(ledger[0]).toMatchObject({ reopened_detector: "e13_deadmic_v1", reopened_reason: "E13 landed; re-read the day" });

    // R31.3 — a second pass with a better detector is distinguishable from the first.
    pg.exec(`UPDATE bench_window SET state = 'silent' WHERE id = 'bw_op1'`);
    const again = await call({ room_day_id: "rd_op1", include_reopened: true, apply: true, detector: "e13_deadmic_v2", reason: "better detector", batch: "b_v2" });
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
    const r = await call({ apply: true, all_rooms: true, include_reopened: true, detector: "e15_vad_v2", reason: "calibration landed", batch: "b_all" });
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
    ((await pg.sql`SELECT reopened_at::text AS reopened_at, reopened_batch, reopened_detector, reopened_history
                     FROM bench_window_silence WHERE window_id = ${id}`) as Array<Record<string, unknown>>)[0];

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

    const applied = await call({ room_id: "room_250", apply: true, detector: "refuter_p1", reason: "the 250-window measurement" });
    expect(applied.reopened, "the apply moves exactly what the preview said it would").toBe(preview.windows);
    expect(await silentIn("room_250"), "and what is left is the difference, not a surprise").toBe(150);
    expect(applied.remaining_eligible, "the answer says how much is still waiting").toBe(150);

    // The same three numbers the Refuter measured, now equal by design: preview === moved, remaining === total − moved.
    expect({ preview: preview.windows, moved: applied.reopened, remaining: await silentIn("room_250") })
      .toEqual({ preview: 100, moved: 100, remaining: 150 });

    // X1 — the bound is the tool's promise, so a caller can raise it and see the whole set move.
    const rest = await call({ room_id: "room_250", limit: 1000, apply: true, detector: "refuter_p1", reason: "the rest" });
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

    const r = await call({ room_day_id: "rd_led_a", apply: true, detector: "e13_v1", reason: "no-evidence population" });
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

    await call({ room_day_id: "rd_hist", apply: true, detector: "detector_A", reason: "first pass" });
    pg.exec(`UPDATE bench_window SET state = 'silent' WHERE id = 'bw_hist'`);
    await call({ room_day_id: "rd_hist", include_reopened: true, apply: true, detector: "detector_B", reason: "second pass" });

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
    const bad = await call({ room_id: "room_hist", apply: true, detector: "NOT-A-DETECTOR: <script>", reason: "junk" });
    expect(bad).toMatchObject({ ok: false, error: "detector_name_invalid" });
    await expect(reopenSilentWindows({ roomId: "room_hist", batch: "b", reason: "r", detector: "two words" })).rejects.toThrow(/not a usable name/);
    // And a real name still passes, including the dotted and colonned shapes a version string uses.
    for (const name of ["e13_deadmic_v1", "e15.vad.2026-09-16", "silero:v5.1"]) expect(name).toMatch((await import("@/lib/stt/silence")).DETECTOR_NAME);
  }, 300_000);
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

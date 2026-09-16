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
    await expect(reopenSilentWindows({ batch: "", reason: "x" })).rejects.toThrow(/batch id is required/);
    await expect(reopenSilentWindows({ batch: "b1", reason: "  " })).rejects.toThrow(/reason is required/);

    const r = await reopenSilentWindows({ batch: "e15_vad_v2", reason: "E15 calibration landed; re-run the backlog" });
    expect(r.reopened, "every silent window went back in one call, not one force at a time").toBe(4);
    expect(r.window_ids.sort()).toEqual(["bw_dead_mic", "bw_empty_room", "bw_no_evidence", "bw_no_level"]);
    for (const id of r.window_ids) expect(await stateOf(id), `${id} is back in the queue`).toBe("closed");
    expect(await evidenceOf("bw_empty_room")).toMatchObject({ reopened_batch: "e15_vad_v2", reopened_reason: "E15 calibration landed; re-run the backlog" });

    // Nothing is left to offer, and the ledger says who was re-run.
    expect(await listSilentWindows({})).toEqual([]);
    expect(await silenceBacklog()).toEqual({ pending: 0, reopened: 0, no_evidence: 0 });
    expect((await reopenSilentWindows({ batch: "again", reason: "second pass" })).reopened, "a window already handed back is not handed back twice").toBe(0);
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

    await reopenSilentWindows({ roomDayId: "rd_a", batch: "b_day", reason: "one day only" });
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

    const r = await reopenSilentWindows({ roomId: "room_lim", limit: 2, batch: "b_lim", reason: "bounded pass" });
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
    await reopenSilentWindows({ roomDayId: "rd_redrain", batch: "b_redrain", reason: "second opinion" });
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

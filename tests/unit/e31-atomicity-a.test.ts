/**
 * E31 BATCH 1 HALF A — A1, A2, A12, against a real postgres:16.
 *
 * WHAT THIS FILE IS FOR, AND WHAT IT REFUSES TO DO. The happy path proves nothing about atomicity: two
 * statements that both succeed look exactly like one statement that succeeded. Every case here MAKES A
 * WRITE FAIL and then asserts the database is in the EARLIER state — not a half-state, not a state that
 * reads as success, and not a state that reads as never-started when work was done.
 *
 * THE PRINCIPLE, from the E31 PRD: a write that half-lands must never read as success, and must never read
 * as never-started.
 *
 * Failure is injected with a CHECK constraint or a foreign key, never by mocking the driver: the point is
 * that POSTGRES refuses the statement mid-flight, which is what a missing column or a bad value does in
 * production. A mocked rejection would prove only that the mock rejected.
 */
import { describe, it, expect, vi, beforeAll, afterAll } from "vitest";
import { readFileSync } from "node:fs";
import { dockerAvailable, pgContainer } from "../support/s1-pg";

const H = vi.hoisted(() => ({
  sql: (async () => []) as unknown as (s: TemplateStringsArray, ...v: unknown[]) => Promise<unknown[]>,
  transcriptOn: true,
}));
vi.mock("@/lib/db", () => ({ sql: (s: TemplateStringsArray, ...v: unknown[]) => H.sql(s, ...v) }));
vi.mock("@/lib/room-switches", () => ({ isTranscriptEnabled: async () => H.transcriptOn }));

const HAVE_DOCKER = dockerAvailable();
const ALLOW_SKIP = process.env.ETA_ALLOW_SKIP_E2E === "1";
const pg = pgContainer("eta-e31-atomicity-a");
const noRecord = (f: string) => readFileSync(f, "utf8").replace(/INSERT INTO schema_migrations[\s\S]*?;/g, "");

describe("REQUIRED PROOF — E31 half A runs against a real postgres", () => {
  it("ran, or was skipped deliberately", () => {
    if (HAVE_DOCKER || ALLOW_SKIP) return;
    throw new Error("REQUIRED PROOF NOT RUN: tests/unit/e31-atomicity-a.test.ts needs Docker for postgres:16. Start Docker, or set ETA_ALLOW_SKIP_E2E=1 to accept that it was not proven.");
  });
});

beforeAll(() => {
  if (!HAVE_DOCKER) return;
  pg.start();
  const m0074 = readFileSync("db/migrations/0074_room_diarize.sql", "utf8");
  const keep = (name: string) => {
    const i = m0074.indexOf(`CREATE TABLE IF NOT EXISTS ${name}`);
    return m0074.slice(i, m0074.indexOf(");", i) + 2);
  };
  pg.exec(`
    CREATE TABLE bench_session (id text PRIMARY KEY, room_id text);
    INSERT INTO bench_session VALUES ('sess_1', 'room_1');
    CREATE TABLE room_day (id text PRIMARY KEY, room_id text, ist_date date);
    CREATE TABLE bench_chunk (
      id text PRIMARY KEY, session_id text NOT NULL, idx integer NOT NULL, source text NOT NULL DEFAULT 'primary',
      r2_key text, content_type text, started_at timestamptz NOT NULL, ended_at timestamptz NOT NULL,
      upload_state text NOT NULL DEFAULT 'verified', duration_ms integer, size_bytes integer,
      peak_level real, avg_level real);
    CREATE TABLE bench_event (id text PRIMARY KEY, session_id text, kind text, at timestamptz, payload jsonb);
    CREATE TABLE stt_subject_job (
      subject_type text NOT NULL, subject_id text NOT NULL, tier text NOT NULL DEFAULT 'asr',
      state text NOT NULL DEFAULT 'queued', attempts integer NOT NULL DEFAULT 0,
      last_error text, started_at timestamptz, finished_at timestamptz,
      PRIMARY KEY (subject_type, subject_id, tier));
    CREATE TABLE cue (id text PRIMARY KEY, room_day_id text, type text, source text, source_ref text, payload jsonb, at timestamptz DEFAULT now());
  `);
  pg.exec(noRecord("db/migrations/0057_bench_window.sql"));
  pg.exec(keep("room_turn_speaker"));
  pg.exec(keep("room_diarize_window"));
  for (const f of ["0085_room_turn_speaker_role", "0088_room_diarize_window_retry", "0089_room_emotion", "0090_diarize_run_id_and_service_guess", "0097_room_span_emotion_speech", "0099_room_diarize_segments_run_id"]) {
    pg.exec(noRecord(`db/migrations/${f}.sql`));
  }
  H.sql = pg.sql;
}, 240_000);
afterAll(() => { if (HAVE_DOCKER) pg.stop(); });

const store = () => import("@/lib/emotion/store");

let nextStart = 5_000_000;
function seedWindow(id: string): number {
  const start = (nextStart += 900_000);
  pg.exec(`INSERT INTO bench_window (id, session_id, room_day_id, start_ms, end_ms, source_mic, clip_r2_key, grid_aligned, state, closed_at)
           VALUES ('${id}', 'sess_1', 'rd_1', ${start}, ${start + 900_000}, 'primary', 'clips/${id}.webm', TRUE, 'transcribed', NOW());`);
  return start;
}
const ctx = (windowId: string, runId: string) => ({
  windowId, roomDayId: "rd_1", diarizeRunId: runId, clipR2Key: "clips/x.webm",
  windowStartMs: 0, cap_s: 30, model: { model: "m", model_key: "wavlm", subfolder: null, device: "cpu" },
});
const seg = (speakerIdx: number, startMs: number) => ({
  speaker_idx: speakerIdx, source_refs: [`t${speakerIdx}_${startMs}`],
  run_start_ms: startMs, run_end_ms: startMs + 4000, chunk_idx: 0, chunk_count: 1,
  start_ms: startMs, end_ms: startMs + 4000, clip_start_s: 0, clip_end_s: 4, speech_ms: 3000,
});
const OK = { index: 0, ok: true as const, labels: { anger: 0.1, disgust: 0.1, enthusiasm: 0.1, fear: 0.1, happiness: 0.1, neutral: 0.4, sadness: 0.1 }, top_label: "neutral" as const, top_score: 0.4, duration_s: 4, inference_s: 0.1 };
const spanCount = async (windowId: string) =>
  ((await pg.sql`SELECT count(*)::int AS n FROM room_span_emotion WHERE window_id = ${windowId}`) as Array<{ n: number }>)[0]!.n;
const spanRuns = async (windowId: string) =>
  ((await pg.sql`SELECT DISTINCT diarize_run_id AS r FROM room_span_emotion WHERE window_id = ${windowId} ORDER BY r`) as Array<{ r: string }>).map((x) => x.r);
const emotionRow = async (windowId: string) =>
  ((await pg.sql`SELECT state, attempts, error, segments_scored AS scored FROM room_emotion_window WHERE window_id = ${windowId}`) as Array<Record<string, unknown>>)[0];

describe.runIf(HAVE_DOCKER)("E31 A1 — every span of an attempt lands, or none of them does", () => {
  it("FAILURE INJECTION: one bad row in the batch and the database keeps NONE of the good ones", async () => {
    const { writeSpans, scoredOrFailedRow } = await store();
    seedWindow("bw_a1_batch");
    const w = ctx("bw_a1_batch", "run_a");

    // Three good rows and one whose window does not exist — a foreign key Postgres refuses mid-statement,
    // which is what a missing column or a bad value does in production. The loop this replaced would have
    // committed the first three and then thrown.
    const rows = [
      scoredOrFailedRow(w, seg(0, 1000) as never, OK),
      scoredOrFailedRow(w, seg(1, 5000) as never, OK),
      scoredOrFailedRow(w, seg(2, 9000) as never, OK),
      scoredOrFailedRow(ctx("bw_does_not_exist", "run_a"), seg(3, 13_000) as never, OK),
    ];
    await expect(writeSpans(rows)).rejects.toThrow();
    expect(await spanCount("bw_a1_batch"), "the three good rows are NOT half-landed — the window is as it was").toBe(0);

    // And the same batch without the bad row lands whole, so the assertion above is about atomicity and
    // not about the rows being unwritable.
    expect(await writeSpans(rows.slice(0, 3))).toBe(3);
    expect(await spanCount("bw_a1_batch")).toBe(3);
  }, 300_000);

  it("a retry of the SAME run replaces its own earlier rows rather than being dropped by the conflict", async () => {
    // Forced by A2: the delete that used to clear the table before a retry now runs at finish, so a retry
    // meets its own previous rows on the same key. DO NOTHING would keep the stale answer and count it.
    const { writeSpans, scoredOrFailedRow } = await store();
    seedWindow("bw_a1_retry");
    const w = ctx("bw_a1_retry", "run_r");
    await writeSpans([scoredOrFailedRow(w, seg(0, 1000) as never, { index: 0, ok: false as const, reason: "inference_failed" })]);
    expect(((await pg.sql`SELECT state FROM room_span_emotion WHERE window_id = 'bw_a1_retry'`) as Array<{ state: string }>)[0]!.state).toBe("failed");
    await writeSpans([scoredOrFailedRow(w, seg(0, 1000) as never, OK)]);
    const after = (await pg.sql`SELECT state FROM room_span_emotion WHERE window_id = 'bw_a1_retry'`) as Array<{ state: string }>;
    expect(after, "one row, not two").toHaveLength(1);
    expect(after[0]!.state, "the newest attempt's answer wins its key").toBe("scored");
  }, 300_000);
});

describe.runIf(HAVE_DOCKER)("E31 A2 — the previous run's spans are never deleted before their replacement is recorded", () => {
  it("FAILURE INJECTION: the finishing statement is refused, and the earlier run's spans SURVIVE", async () => {
    const { writeSpans, scoredOrFailedRow, finishEmotionWindow } = await store();
    seedWindow("bw_a2");
    // An earlier run scored this window and was recorded.
    await writeSpans([scoredOrFailedRow(ctx("bw_a2", "run_old"), seg(0, 1000) as never, OK)]);
    pg.exec(`INSERT INTO room_emotion_window (window_id, room_day_id, state, diarize_run_id, segments_scored, scored_at)
             VALUES ('bw_a2', 'rd_1', 'ok', 'run_old', 1, NOW());`);
    // A new run has written its own spans and is about to finish.
    await writeSpans([scoredOrFailedRow(ctx("bw_a2", "run_new"), seg(1, 5000) as never, OK)]);
    expect(await spanRuns("bw_a2"), "both runs' rows are present while the new one is in flight").toEqual(["run_new", "run_old"]);

    // Refuse the window-row half of the finishing statement. Under the old shape the delete had already
    // committed a whole job step earlier and this window would now hold NO spans at all.
    pg.exec(`ALTER TABLE room_emotion_window ADD CONSTRAINT e31_refuse_ok CHECK (state <> 'ok') NOT VALID;`);
    await expect(finishEmotionWindow({
      windowId: "bw_a2", roomDayId: "rd_1", diarizeRunId: "run_new", planned: 1, calls: 1,
      model: "m", model_key: "wavlm", subfolder: null, cap_s: 30,
    })).rejects.toThrow();
    expect(await spanRuns("bw_a2"), "the delete cannot land without the row that describes what replaced them").toEqual(["run_new", "run_old"]);
    expect(await emotionRow("bw_a2"), "and the window still reads as the earlier run — a consistent earlier state").toMatchObject({ state: "ok", scored: 1 });

    // Lift the refusal: the same call now deletes the old run AND records the new one, together.
    pg.exec(`ALTER TABLE room_emotion_window DROP CONSTRAINT e31_refuse_ok;`);
    const r = await finishEmotionWindow({
      windowId: "bw_a2", roomDayId: "rd_1", diarizeRunId: "run_new", planned: 1, calls: 1,
      model: "m", model_key: "wavlm", subfolder: null, cap_s: 30,
    });
    expect(r.spans_removed, "the earlier run's one row went with the write that replaced it").toBe(1);
    expect(await spanRuns("bw_a2")).toEqual(["run_new"]);
    expect(await emotionRow("bw_a2")).toMatchObject({ state: "ok", scored: 1 });
  }, 300_000);
});

describe.runIf(HAVE_DOCKER)("E31 A12 — closing a window and queueing it are one act", () => {
  const seedTape = (sessionId: string, startMs: number) => {
    pg.exec(`INSERT INTO bench_session (id, room_id) VALUES ('${sessionId}', 'room_1') ON CONFLICT DO NOTHING;`);
    // Two 450 s chunks covering one 900 s grid slot, plus one chunk after it so the slot is complete.
    for (let i = 0; i < 3; i += 1) {
      const s = startMs + i * 450_000;
      pg.exec(`INSERT INTO bench_chunk (id, session_id, idx, source, r2_key, content_type, started_at, ended_at, upload_state, duration_ms, size_bytes)
               VALUES ('${sessionId}_c${i}', '${sessionId}', ${i}, 'primary', 'k${i}', 'audio/webm',
                       to_timestamp(${s} / 1000.0), to_timestamp(${s + 450_000} / 1000.0), 'verified', 450000, 1);`);
    }
  };
  const jobRows = async (windowId: string) =>
    ((await pg.sql`SELECT count(*)::int AS n FROM stt_subject_job WHERE subject_type = 'bench_window' AND subject_id = ${windowId}`) as Array<{ n: number }>)[0]!.n;
  const windowState = async (id: string) =>
    ((await pg.sql`SELECT state FROM bench_window WHERE id = ${id}`) as Array<{ state: string }>)[0]?.state;

  it("the happy path: the window closes and the job exists, from one statement", async () => {
    const { evaluateAndWriteWindows } = await import("@/lib/bench-window");
    H.transcriptOn = true;
    seedTape("sess_a12_ok", 900_000_000);
    const r = await evaluateAndWriteWindows("sess_a12_ok");
    expect(r.closed, "one grid slot closed").toBeGreaterThan(0);
    expect(r.enqueued, "and it was queued by the same statement").toBe(r.closed);
    const id = ((await pg.sql`SELECT id FROM bench_window WHERE session_id = 'sess_a12_ok' AND state = 'closed' ORDER BY start_ms LIMIT 1`) as Array<{ id: string }>)[0]!.id;
    expect(await jobRows(id)).toBe(1);

    // AND THE ENQUEUE IS FED BY THE CLOSE, not merely adjacent to it: re-running the evaluator over a
    // settled session closes nothing, so it must queue nothing. An insert that did not read the close's
    // RETURNING would fire again here — the row count would not move (ON CONFLICT), but the count this
    // function reports would, and a reader would be told work was queued that never was.
    const again = await evaluateAndWriteWindows("sess_a12_ok");
    expect(again.closed, "nothing closed the second time").toBe(0);
    expect(again.enqueued ?? 0, "so nothing was queued the second time").toBe(0);
  }, 300_000);

  it("FAILURE INJECTION: the enqueue is refused, and the window is left OPEN rather than closed and unqueued", async () => {
    const { evaluateAndWriteWindows } = await import("@/lib/bench-window");
    H.transcriptOn = true;
    seedTape("sess_a12_fail", 1_800_000_000);
    // Refuse exactly the insert the close feeds. Under the old shape the close had already committed and
    // the failure was swallowed by a catch with no log line: a window closed for ever, never queued.
    pg.exec(`ALTER TABLE stt_subject_job ADD CONSTRAINT e31_refuse_bw CHECK (subject_type <> 'bench_window') NOT VALID;`);
    const r = await evaluateAndWriteWindows("sess_a12_fail");
    pg.exec(`ALTER TABLE stt_subject_job DROP CONSTRAINT e31_refuse_bw;`);

    expect(r.closed, "nothing was recorded as closed").toBe(0);
    const states = ((await pg.sql`SELECT state FROM bench_window WHERE session_id = 'sess_a12_fail'`) as Array<{ state: string }>).map((x) => x.state);
    expect(states.every((s) => s === "open"), "the close rolled back with the enqueue it could not do").toBe(true);

    // And with the refusal lifted the same tape closes and queues together, so the assertion above is
    // about atomicity and not about the tape being unclosable.
    const again = await evaluateAndWriteWindows("sess_a12_fail");
    expect(again.closed).toBeGreaterThan(0);
    expect(again.enqueued).toBe(again.closed);
    const id = ((await pg.sql`SELECT id FROM bench_window WHERE session_id = 'sess_a12_fail' AND state = 'closed' ORDER BY start_ms LIMIT 1`) as Array<{ id: string }>)[0]!.id;
    expect(await windowState(id)).toBe("closed");
    expect(await jobRows(id)).toBe(1);
  }, 300_000);

  it("Transcript off: the window still closes, and nothing is queued — the gate is read before the statement, not inside it", async () => {
    const { evaluateAndWriteWindows } = await import("@/lib/bench-window");
    H.transcriptOn = false;
    seedTape("sess_a12_off", 2_700_000_000);
    const r = await evaluateAndWriteWindows("sess_a12_off");
    expect(r.closed).toBeGreaterThan(0);
    expect(r.enqueued ?? 0, "the room's switch is off, so no job — and the close is unaffected").toBe(0);
    const id = ((await pg.sql`SELECT id FROM bench_window WHERE session_id = 'sess_a12_off' AND state = 'closed' ORDER BY start_ms LIMIT 1`) as Array<{ id: string }>)[0]!.id;
    expect(await jobRows(id)).toBe(0);
    H.transcriptOn = true;
  }, 300_000);

  it("THE ORDER IS PINNED: the enqueue is fed BY the close, never the other way round", () => {
    // D-4. Reversing this — an insert that runs first and a close that reads ITS returning — would queue a
    // window that is still `open`, which the drain would claim out from under a recorder still writing to
    // it. Nothing in the type system says which CTE feeds which, so it is asserted here.
    const src = readFileSync("lib/bench-window.ts", "utf8");
    const stmt = src.slice(src.indexOf("WITH closed AS ("), src.indexOf("`) as Array<{ closed: number; queued: number }>"));
    expect(stmt.indexOf("closed AS ("), "the close is the first CTE").toBeLessThan(stmt.indexOf("queued AS ("));
    expect(stmt, "the close RETURNs the id").toMatch(/UPDATE bench_window SET state = 'closed'[\s\S]*?RETURNING id/);
    expect(stmt, "and the insert SELECTs FROM it, so it cannot run without it").toMatch(/INSERT INTO stt_subject_job[\s\S]*?SELECT 'bench_window', closed\.id[\s\S]*?FROM closed/);
    expect(stmt, "the enqueue never re-reads bench_window: it takes the id the close returned").not.toMatch(/FROM bench_window[\s\S]*?queued AS/);
  });
});

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
  /** R62 — the windows auto-drain offered to the drain. The SCAN is real; only the paid drain is not. */
  drained: [] as string[],
}));
vi.mock("@/lib/db", () => ({ sql: (s: TemplateStringsArray, ...v: unknown[]) => H.sql(s, ...v) }));
vi.mock("@/lib/room-switches", () => ({ isTranscriptEnabled: async () => H.transcriptOn }));
vi.mock("@/lib/stt/room-drain", async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  drainRoomWindow: async (windowId: string) => {
    H.drained.push(windowId);
    return { window_id: windowId, ok: false, step: "flag_off" };
  },
}));

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
    CREATE TABLE room (id text PRIMARY KEY, transcript_enabled boolean NOT NULL DEFAULT FALSE);
    INSERT INTO room VALUES ('room_1', TRUE);
  `);
  pg.exec(noRecord("db/migrations/0057_bench_window.sql"));
  // R62 — what auto-drain's scan reads besides bench_window: the job store, and the refusal columns.
  pg.exec(noRecord("db/migrations/0082_scribe_job.sql"));
  pg.exec(noRecord("db/migrations/0092_bench_window_auto_drain_refusal.sql"));
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
/**
 * R60 — `diarize_run_id` IS READ, because the claim below is about WHICH RUN the row describes.
 * The A2 case is captioned "the window still reads as the earlier run"; without this column that caption
 * asserted nothing, and a row incorrectly rewritten to the NEW run would have satisfied `{state:'ok',
 * scored:1}` just as well. The property held; the test did not pin it.
 */
const emotionRow = async (windowId: string) =>
  ((await pg.sql`SELECT state, attempts, error, diarize_run_id, segments_scored AS scored FROM room_emotion_window WHERE window_id = ${windowId}`) as Array<Record<string, unknown>>)[0];

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
    // R60 — THE REFUSAL TARGETS THE FINISHING WRITE AND NOTHING ELSE. It used to be CHECK (state <> 'ok'),
    // which refuses ANY update of this row, because Postgres re-checks a constraint on every updated row.
    // That also refused a mutant that moved only `diarize_run_id` to the new run, so the assertion on the
    // run could never be shown to bite: the mutant died on the injection before the assertion was reached.
    // The seeded row has calls = NULL and the finishing write sets calls = 1, so this refuses exactly that
    // write and lets an unrelated one-column update through.
    pg.exec(`ALTER TABLE room_emotion_window ADD CONSTRAINT e31_refuse_ok CHECK (calls IS NULL) NOT VALID;`);
    await expect(finishEmotionWindow({
      windowId: "bw_a2", roomDayId: "rd_1", diarizeRunId: "run_new", planned: 1, calls: 1,
      model: "m", model_key: "wavlm", subfolder: null, cap_s: 30,
    })).rejects.toThrow();
    expect(await spanRuns("bw_a2"), "the delete cannot land without the row that describes what replaced them").toEqual(["run_new", "run_old"]);
    expect(await emotionRow("bw_a2"), "and the window still reads as the earlier run — a consistent earlier state")
      .toMatchObject({ state: "ok", scored: 1, diarize_run_id: "run_old" });

    // Lift the refusal: the same call now deletes the old run AND records the new one, together.
    pg.exec(`ALTER TABLE room_emotion_window DROP CONSTRAINT e31_refuse_ok;`);
    const r = await finishEmotionWindow({
      windowId: "bw_a2", roomDayId: "rd_1", diarizeRunId: "run_new", planned: 1, calls: 1,
      model: "m", model_key: "wavlm", subfolder: null, cap_s: 30,
    });
    expect(r.spans_removed, "the earlier run's one row went with the write that replaced it").toBe(1);
    expect(await spanRuns("bw_a2")).toEqual(["run_new"]);
    // And it MOVED: the pair of assertions is what makes the one above non-vacuous. If the row had read
    // `run_new` all along, "still reads as the earlier run" would have been true of nothing.
    expect(await emotionRow("bw_a2")).toMatchObject({ state: "ok", scored: 1, diarize_run_id: "run_new" });
  }, 300_000);
});

describe.runIf(HAVE_DOCKER)("E31 A12 (R62) — the close lands on its own; the enqueue follows it, and its failure is loud", () => {
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
  const sessionJobRows = async (sessionId: string) =>
    ((await pg.sql`SELECT count(*)::int AS n FROM stt_subject_job j JOIN bench_window w ON w.id = j.subject_id
                    WHERE j.subject_type = 'bench_window' AND w.session_id = ${sessionId}`) as Array<{ n: number }>)[0]!.n;
  const windowStates = async (sessionId: string) =>
    ((await pg.sql`SELECT state FROM bench_window WHERE session_id = ${sessionId} ORDER BY start_ms`) as Array<{ state: string }>).map((x) => x.state);
  const closedId = async (sessionId: string) =>
    ((await pg.sql`SELECT id FROM bench_window WHERE session_id = ${sessionId} AND state = 'closed' ORDER BY start_ms LIMIT 1`) as Array<{ id: string }>)[0]!.id;

  it("the happy path: the window closes and the job exists", async () => {
    const { evaluateAndWriteWindows } = await import("@/lib/bench-window");
    H.transcriptOn = true;
    seedTape("sess_a12_ok", 900_000_000);
    const r = await evaluateAndWriteWindows("sess_a12_ok");
    expect(r.closed, "one grid slot closed").toBeGreaterThan(0);
    expect(r.enqueued, "and it was queued").toBe(r.closed);
    expect(r.enqueue_failed, "and nothing failed").toBeUndefined();
    expect(await jobRows(await closedId("sess_a12_ok"))).toBe(1);

    // THE ENQUEUE RIDES THE open→closed EDGE: re-running the evaluator over a settled session closes
    // nothing, so it must queue nothing, and the count it reports must not claim work that never happened.
    const again = await evaluateAndWriteWindows("sess_a12_ok");
    expect(again.closed, "nothing closed the second time").toBe(0);
    expect(again.enqueued ?? 0, "so nothing was queued the second time").toBe(0);
  }, 300_000);

  it("FAILURE INJECTION on the enqueue: the window IS closed, the failure is loud, and both recovery readers find it", async () => {
    const { evaluateAndWriteWindows, istDateOf } = await import("@/lib/bench-window");
    const { countRoomWaitingWindows } = await import("@/lib/stt/room-drain");
    const { enqueueAutoDrain } = await import("@/lib/stt/auto-drain");
    H.transcriptOn = true;
    const start = 1_800_000_000;
    seedTape("sess_a12_fail", start);
    // A day, so the window is one the recovery readers are allowed to see (both require room_day_id).
    pg.exec(`INSERT INTO room_day (id, room_id, ist_date) VALUES ('rd_a12_fail', 'room_1', '${istDateOf(start)}');`);
    const waitingBefore = await countRoomWaitingWindows("room_1");

    // Refuse exactly the enqueue. D-5: the close is a fact other readers depend on, so it must not share
    // the enqueue's fate. The bug R62 exists to prevent — the two collapsed into one statement — leaves
    // the window OPEN here, where neither auto-drain nor run-waiting can see it.
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    pg.exec(`ALTER TABLE stt_subject_job ADD CONSTRAINT e31_refuse_bw CHECK (subject_type <> 'bench_window') NOT VALID;`);
    let r: Awaited<ReturnType<typeof evaluateAndWriteWindows>>;
    let calls: unknown[][];
    try {
      r = await evaluateAndWriteWindows("sess_a12_fail");
    } finally {
      pg.exec(`ALTER TABLE stt_subject_job DROP CONSTRAINT e31_refuse_bw;`);
      calls = [...errors.mock.calls];   // mockRestore clears them
      errors.mockRestore();
    }

    // 1. THE CLOSE LANDED.
    expect(r.closed, "the close is recorded").toBe(1);
    const id = await closedId("sess_a12_fail");
    expect((await windowStates("sess_a12_fail"))[0], "the window is closed — the refused enqueue did not roll it back").toBe("closed");
    expect(await jobRows(id), "and it has no job: closed-but-unqueued, which the database itself can tell apart").toBe(0);

    // 2. THE FAILURE IS VISIBLE (D-3): counted in the result, and logged with the window it happened to.
    expect(r.enqueued ?? 0, "nothing is claimed as queued").toBe(0);
    expect(r.enqueue_failed, "the failed enqueue is counted").toBe(1);
    expect(r.error, "a failed enqueue is not a failed chunk").toBeUndefined();
    const logged = calls.filter((c) => String(c[0]).includes("CLOSED but NOT QUEUED"));
    expect(logged, "one log line, naming the window").toHaveLength(1);
    expect(logged[0]).toContain(id);
    expect(String(logged[0]![2]), "carrying the refusal").toMatch(/stt_subject_job/);

    // 3. THE ADMIN RECOVERY SEES IT: run-waiting counts closed windows with no job.
    expect(await countRoomWaitingWindows("room_1"), "the run-waiting count went up by exactly this window").toBe(waitingBefore + 1);

    // 4. AUTO-DRAIN'S REAL SCAN FINDS IT and heals it: its legacy enqueue writes the job the evaluator
    // could not. Only the paid drain after that is stubbed.
    H.drained.length = 0;
    const saved = process.env.ROOM_AUTO_DRAIN_ENABLED;
    process.env.ROOM_AUTO_DRAIN_ENABLED = "1";
    try {
      await enqueueAutoDrain("https://x.test", { log: () => {} });
    } finally {
      if (saved === undefined) delete process.env.ROOM_AUTO_DRAIN_ENABLED;
      else process.env.ROOM_AUTO_DRAIN_ENABLED = saved;
    }
    expect(H.drained, "auto-drain's scan offered this window").toContain(id);
    expect(await jobRows(id), "and its enqueue healed the gap").toBe(1);
    expect(await countRoomWaitingWindows("room_1"), "so it no longer waits").toBe(waitingBefore);
  }, 300_000);

  it("Transcript off: the window still closes, and nothing is queued or counted as failed", async () => {
    const { evaluateAndWriteWindows } = await import("@/lib/bench-window");
    H.transcriptOn = false;
    seedTape("sess_a12_off", 2_700_000_000);
    const r = await evaluateAndWriteWindows("sess_a12_off");
    H.transcriptOn = true;
    expect(r.closed).toBeGreaterThan(0);
    expect(r.enqueued ?? 0, "the room's switch is off, so no job — and the close is unaffected").toBe(0);
    expect(r.enqueue_failed, "a switched-off room is not a failure").toBeUndefined();
    expect(await jobRows(await closedId("sess_a12_off"))).toBe(0);
  }, 300_000);

  it("THE ORDER IS PINNED (D-4), BEHAVIOURALLY: the close is refused, so nothing may be queued", async () => {
    // Close, THEN enqueue. Reversed, the enqueue lands for a window that is still `open`, and the drain
    // would claim it out from under a recorder still writing to it. Refusing the close is what tells the
    // two orders apart: close-first queues nothing; enqueue-first leaves a job behind.
    const { evaluateAndWriteWindows } = await import("@/lib/bench-window");
    H.transcriptOn = true;
    seedTape("sess_a12_order", 3_600_000_000);
    pg.exec(`ALTER TABLE bench_window ADD CONSTRAINT e31_refuse_close CHECK (state <> 'closed') NOT VALID;`);
    let r: Awaited<ReturnType<typeof evaluateAndWriteWindows>>;
    try {
      r = await evaluateAndWriteWindows("sess_a12_order");
    } finally {
      pg.exec(`ALTER TABLE bench_window DROP CONSTRAINT e31_refuse_close;`);
    }
    expect(r.closed, "the close was refused").toBe(0);
    expect((await windowStates("sess_a12_order")).every((s) => s === "open")).toBe(true);
    expect(await sessionJobRows("sess_a12_order"), "an open window was never queued").toBe(0);

    // Lifted, the same tape closes and queues, so the zero above is about order, not an unclosable tape.
    const again = await evaluateAndWriteWindows("sess_a12_order");
    expect(again.closed).toBe(1);
    expect(await sessionJobRows("sess_a12_order")).toBe(1);
  }, 300_000);

  it("THE CLOSE STAYS ITS OWN STATEMENT, AND THE ENQUEUE FOLLOWS IT WITH THE ID IT RETURNED (source pin)", () => {
    // R62 exists because the two were collapsed once and every test stayed green except the ones that make
    // the enqueue fail. This pins the shape too, so a re-collapse is named for what it is.
    const src = readFileSync("lib/bench-window.ts", "utf8");
    const closeAt = src.indexOf("UPDATE bench_window SET state = 'closed', closed_at = NOW()");
    expect(closeAt, "the close exists exactly once").toBeGreaterThan(-1);
    expect(src.indexOf("UPDATE bench_window SET state = 'closed', closed_at = NOW()", closeAt + 1)).toBe(-1);
    const stmtStart = src.lastIndexOf("sql`", closeAt);
    const stmt = src.slice(stmtStart, src.indexOf("`", closeAt));
    expect(stmt, "the close statement writes no job").not.toMatch(/stt_subject_job|INSERT\s+INTO/i);
    expect(stmt, "and no CTE carries anything alongside it").not.toMatch(/\bWITH\b/);
    const enqueueAt = src.indexOf('enqueueSubject("bench_window", closedId, "asr")');
    expect(enqueueAt, "the enqueue takes the id the close returned").toBeGreaterThan(closeAt);
    expect(src.slice(closeAt, enqueueAt), "and that id is the close's RETURNING").toMatch(/const closedId = upd\[0\]!\.id;/);
  });
});

/**
 * ─── R61 — THE THREE COPIES OF THE CONFLICT RULE, PINNED ────────────────────────────────────────────
 *
 * THE MEASUREMENT THIS ANSWERS. `room_emotion_window` now has three writers, each with its own copy of the
 * "rewrite when the stored row contradicts what these rows now say" rule. The Refuter dropped
 * `segments_unscorable` from each comparison tuple in turn: from `recordEmotionWindow` it was CAUGHT, but
 * from `finishEmotionWindow` and from `writeNoSegmentsWindow` it SURVIVED with the whole suite green. Two of
 * three copies could drift with nothing noticing, and a prose comment was the only thing holding them.
 *
 * WHY NOT "THE THREE TUPLES MUST BE IDENTICAL". They must not be, and that is correct: each compares what
 * its own statement writes. `finishEmotionWindow` nulls `stale_segments_run_id` unconditionally so has
 * nothing to compare there; `writeNoSegmentsWindow` writes `segments_planned/scored/failed` as the literal
 * `0`, so comparing them would be comparing a constant with itself. A test asserting sameness would be
 * asserting something false.
 *
 * WHY NOT A HAND-WRITTEN LIST OF FIELDS. That list is a fourth copy, and it drifts like the other three.
 *
 * THE RULE, DERIVED FROM THE STATEMENTS THEMSELVES: a `segments_*` column is in the comparison tuple IF AND
 * ONLY IF its value in that statement is not a literal constant. A value the statement computes — from the
 * span rows or from a parameter — can contradict what is stored, so it must be compared; a value that is
 * literally `0` on every execution cannot, so comparing it would be noise. That holds for all three copies
 * today, is read off the source rather than remembered, and fails the moment any tuple loses a field it
 * still computes.
 */
const STORE_SRC = readFileSync("lib/emotion/store.ts", "utf8");
/** The three writers of room_emotion_window that carry a conflict rule. The narrow failure write has none. */
const CONFLICT_COPIES = ["recordEmotionWindow", "finishEmotionWindow", "writeNoSegmentsWindow"] as const;

/** The index of the `)` matching the `(` at `from`. */
function matchParen(t: string, from: number): number {
  let d = 0;
  for (let i = from; i < t.length; i += 1) {
    if (t[i] === "(") d += 1;
    else if (t[i] === ")") { d -= 1; if (d === 0) return i; }
  }
  return -1;
}
/** Split on commas at paren depth 0, outside string literals and outside `${ … }` interpolations. */
function splitTopLevel(t: string): string[] {
  const out: string[] = [];
  let d = 0, tpl = 0, inStr = false, cur = "";
  for (let i = 0; i < t.length; i += 1) {
    const c = t[i]!;
    if (inStr) { cur += c; if (c === "'") { if (t[i + 1] === "'") cur += t[++i]; else inStr = false; } continue; }
    if (c === "'") { inStr = true; cur += c; continue; }
    if (c === "$" && t[i + 1] === "{") { tpl += 1; cur += "${"; i += 1; continue; }
    if (tpl > 0 && c === "}") { tpl -= 1; cur += c; continue; }
    if (tpl === 0 && c === "(") d += 1;
    if (tpl === 0 && c === ")") d -= 1;
    if (tpl === 0 && d === 0 && c === ",") { out.push(cur.trim()); cur = ""; continue; }
    cur += c;
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}
/** Everything one of the three writers actually says, read off the file. */
function readCopy(name: string) {
  const start = STORE_SRC.indexOf(`function ${name}`);
  expect(start, `${name} is a function in lib/emotion/store.ts`).toBeGreaterThan(-1);
  const next = STORE_SRC.indexOf("\nexport ", start + 1);
  const body = STORE_SRC.slice(start, next === -1 ? STORE_SRC.length : next);

  const ins = body.indexOf("INSERT INTO room_emotion_window");
  expect(ins, `${name} writes room_emotion_window`).toBeGreaterThan(-1);
  const lp = body.indexOf("(", ins);
  const rp = matchParen(body, lp);
  const columns = splitTopLevel(body.slice(lp + 1, rp));

  // The value list runs from the SELECT to the first FROM at paren depth 0.
  const selAt = body.indexOf("SELECT", rp);
  let d = 0, tpl = 0, inStr = false, fromAt = -1;
  for (let i = selAt + 6; i < body.length; i += 1) {
    const c = body[i]!;
    if (inStr) { if (c === "'") { if (body[i + 1] === "'") i += 1; else inStr = false; } continue; }
    if (c === "'") { inStr = true; continue; }
    if (c === "$" && body[i + 1] === "{") { tpl += 1; i += 1; continue; }
    if (tpl > 0 && c === "}") { tpl -= 1; continue; }
    if (tpl === 0 && c === "(") d += 1;
    if (tpl === 0 && c === ")") d -= 1;
    if (tpl === 0 && d === 0 && /^from\b/i.test(body.slice(i, i + 5)) && !/\w/.test(body[i - 1] ?? " ")) { fromAt = i; break; }
  }
  expect(fromAt, `${name}'s inserted value list ends at a FROM`).toBeGreaterThan(-1);
  const values = splitTopLevel(body.slice(selAt + 6, fromAt));

  const lstart = body.indexOf("(room_emotion_window.");
  expect(lstart, `${name} carries a comparison tuple`).toBeGreaterThan(-1);
  const lend = matchParen(body, lstart);
  const idf = body.indexOf("IS DISTINCT FROM", lend);
  const rstart = body.indexOf("(EXCLUDED.", idf);
  const rend = matchParen(body, rstart);
  const left = [...body.slice(lstart, lend).matchAll(/room_emotion_window\.(\w+)/g)].map((m) => m[1]!);
  const right = [...body.slice(rstart, rend).matchAll(/EXCLUDED\.(\w+)/g)].map((m) => m[1]!);
  return { name, columns, values, left, right };
}
/** A value that is the same on every execution, so comparing it with itself would say nothing. */
const isLiteralConstant = (v: string) => /^(0|NULL(::[\w ]+)?|'[^']*')$/i.test(v.trim());

describe("E31 R61 — the three copies of the conflict rule cannot drift unseen (no database: it reads the .ts)", () => {
  it("each copy's inserted columns and values line up, so the pairing below means what it says", () => {
    for (const name of CONFLICT_COPIES) {
      const c = readCopy(name);
      expect(c.columns.length, `${name}: one value per column`).toBe(c.values.length);
      expect(c.columns.length, `${name}: the column list parsed at all`).toBeGreaterThan(5);
    }
  });

  it("a segments_* column is compared IF AND ONLY IF this statement computes it", () => {
    for (const name of CONFLICT_COPIES) {
      const c = readCopy(name);
      const computed: string[] = [];
      const constant: string[] = [];
      c.columns.forEach((col, i) => {
        if (!col.startsWith("segments_")) return;
        (isLiteralConstant(c.values[i]!) ? constant : computed).push(col);
      });
      expect(computed.length, `${name}: it computes at least one segment count, or this rule is vacuous`).toBeGreaterThan(0);
      // The direction that matters: a count this statement computes MUST be compared. Dropping one from the
      // tuple while still writing it is exactly the drift that survived a whole green suite.
      for (const col of computed) {
        expect(c.left, `${name} computes ${col} but does not compare it — the stored row could contradict it and be left alone`).toContain(col);
      }
      // And the other direction, so the rule cannot be satisfied by comparing everything: a literal cannot
      // differ from itself, and comparing it would make the tuple look complete while saying nothing.
      for (const col of constant) {
        expect(c.left, `${name} writes ${col} as a literal constant, so comparing it is noise`).not.toContain(col);
      }
    }
  });

  it("every copy compares the same fields on both sides of IS DISTINCT FROM", () => {
    // A one-sided drift is a different shape of the same defect: the tuple still looks complete on the left.
    for (const name of CONFLICT_COPIES) {
      const c = readCopy(name);
      expect(c.left.length, `${name}: the tuple parsed`).toBeGreaterThan(0);
      expect(c.right, `${name}: the stored side and the incoming side compare the same fields, in the same order`).toEqual(c.left);
    }
  });

  it("all three copies open with the same rule, and a fourth writer would have to declare itself", () => {
    // The shared part IS identical across the three and is asserted as such: the two escape hatches that
    // come before the tuple. If a copy loses one it stops rewriting rows it must rewrite.
    for (const name of CONFLICT_COPIES) {
      const c = readCopy(name);
      const start = STORE_SRC.indexOf(`function ${name}`);
      const next = STORE_SRC.indexOf("\nexport ", start + 1);
      const body = STORE_SRC.slice(start, next === -1 ? STORE_SRC.length : next);
      expect(body, `${name}: a stored FAILED row is always rewritten`).toMatch(/room_emotion_window\.state = 'failed'/);
      expect(body, `${name}: a row belonging to another diarize run is always rewritten`).toMatch(/room_emotion_window\.diarize_run_id <> EXCLUDED\.diarize_run_id/);
      expect(c.left[0], `${name}: every tuple leads with state`).toBe("state");
    }
    // The count is asserted so a FOURTH copy cannot appear without this test being updated to know about it.
    const writers = [...STORE_SRC.matchAll(/INSERT INTO room_emotion_window/g)].length;
    expect(writers, "four writers of room_emotion_window: the three conflict copies plus the narrow failure write, which deliberately has no tuple").toBe(4);
  });
});

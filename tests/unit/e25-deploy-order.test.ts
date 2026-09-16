/**
 * E25 R16 — THE DEPLOY-ORDER CONSTRAINT, PROVEN BY EXECUTION, ONE MIGRATION AT A TIME.
 *
 * Three documents say "0099 MUST be applied before this code deploys, or every diarize INSERT and every emotion
 * prepare SELECT fails on the missing column" (the 0099 header, the E25 commit message, and
 * docs/handoff/ETA-E25-DEPLOY-ORDER-E24.md). Here that is run rather than asserted.
 *
 * E26 T1 — WHY THREE TESTS AND NOT ONE. The first version applied 0097 and 0099 in a SINGLE runner call, so it
 * could only prove "some migration is missing". The deploy plan rests on a stronger sentence — THESE TWO, and
 * what each one costs — so each migration is now withheld ALONE, against a schema that has the other:
 *
 *   1. 0099 WITHHELD (0097 applied): three E24 paths die, each on a column 0099 adds — the diarize INSERT on
 *      room_diarize_window.segments_run_id, the emotion prepare SELECT on d.segments_run_id, and the emotion
 *      window write on room_emotion_window.stale_segments_run_id. Applying 0099 alone fixes all three.
 *   2. 0097 WITHHELD (0099 applied — the correct order for 0099): E24 gets past every 0099 column and dies later,
 *      in the SPAN write, on room_span_emotion.speech_ms. Applying 0097 alone fixes it.
 *   3. THE STRADDLE. Both applied, PRE-E24 code still writing: tests/fixtures/pre-e24-diarize-window-insert.sql
 *      is that code's own upsert, EXECUTED here (E26 T2 — it used to be read from git with `git show a05d750:…`,
 *      which made the result depend on clone depth). The row lands NULL and E24 reads it with R17's honest
 *      reason: the writer is unrecorded, never "predates 0099".
 *
 * Both migration files carry a semicolon inside a header comment, so the runner's comment handling is proven by
 * execution in tests 1 and 2.
 *
 * WHAT IS FAKED, AND WHAT IS NOT. The database is real. The migration files are the real files. The runner is
 * the real route. Only the driver is a stand-in: `@/lib/db` is this harness's psql-backed sql, which — unlike
 * Neon HTTP — runs a transaction's statements through one psql session wrapped in BEGIN/COMMIT (see `transaction`
 * below). R2, the emotion service and the flag are faked as everywhere else.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { readFileSync, mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { dockerAvailable, pgContainer } from "../support/s1-pg";

const H = vi.hoisted(() => ({
  sql: null as null | ((s: TemplateStringsArray, ...v: unknown[]) => Promise<unknown[]>),
  raw: null as null | ((text: string) => void),
  tx: null as null | ((texts: string[]) => void),
  /** The database's own message from the last statement that failed — the kind truncates its detail at 160 chars. */
  lastError: "",
  /** Every database error in order: a break can be followed by a second one in the job's own failure bookkeeping. */
  errors: [] as string[],
}));

/** The statements the bound-parameter harness can classify; anything else (DDL from a migration) runs raw. */
const BOUND_FIRST_WORDS = new Set(["select", "with", "insert", "update", "delete"]);

vi.mock("@/lib/db", () => {
  /** A lazily-executed statement, as the Neon driver returns: awaiting it runs it; `transaction` collects it. */
  const lazy = (text: string) => ({
    text,
    then(res: (v: unknown[]) => void, rej: (e: unknown) => void) {
      try { H.raw!(text); res([]); } catch (e) { rej(e); }
    },
  });
  const record = (p: Promise<unknown[]>) => p.catch((e: Error) => { H.lastError = String(e?.message ?? e); H.errors.push(H.lastError); throw e; });
  const sql = (strings: TemplateStringsArray, ...values: unknown[]) => {
    if (values.length > 0) return record(H.sql!(strings, ...values));
    const text = strings[0] ?? "";
    const first = /^[A-Za-z]+/.exec(text.trim())?.[0]?.toLowerCase() ?? "";
    return BOUND_FIRST_WORDS.has(first) ? record(H.sql!(strings)) : lazy(text);
  };
  sql.transaction = async (queries: Array<{ text: string }>) => { H.tx!(queries.map((q) => q.text)); return []; };
  return { sql };
});
vi.mock("@/lib/r2", () => ({ signGetUrl: async () => "https://r2.example/clip", getObjectBytes: async () => new Uint8Array([1, 2, 3]) }));
vi.mock("@/lib/emotion/gate", () => ({ emotionEnabled: () => true }));
vi.mock("@/lib/emotion/client", async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  emotionSecretConfigured: () => true,
  emotionHealth: async () => ({ ok: true, cap_s: 30, min_speech_s: 1.5, loaded: true, model: "m", subfolder: "int8" }),
  // A SUCCESSFUL score, so the job reaches the SPAN write — the statement 0097's columns live in. The labels are
  // the service's seven, flat: this file tests the schema the write needs, never the scoring itself.
  scoreSegments: async (_url: string, segments: Array<{ start_s: number; end_s: number }>) => ({
    ok: true, model: "m", model_key: "wavlm", subfolder: "int8", device: "cpu", cap_s: 30, fetch_s: null, decode_s: null,
    results: segments.map((sg, i) => ({
      index: i, ok: true,
      labels: Object.fromEntries(["anger", "disgust", "enthusiasm", "fear", "happiness", "neutral", "sadness"].map((l) => [l, 1 / 7])),
      top_label: "anger", top_score: 1 / 7, duration_s: sg.end_s - sg.start_s, inference_s: 0.1,
    })),
  }),
}));

const HAVE_DOCKER = dockerAvailable();
const ALLOW_SKIP = process.env.ETA_ALLOW_SKIP_E2E === "1";
const pg = pgContainer("eta-e25-deploy-order");
const noRecord = (f: string) => readFileSync(f, "utf8").replace(/INSERT INTO schema_migrations[\s\S]*?;/g, "");

describe("REQUIRED PROOF — the deploy-order constraint runs against a real postgres", () => {
  it("ran, or was skipped deliberately", () => {
    if (HAVE_DOCKER || ALLOW_SKIP) return;
    throw new Error("REQUIRED PROOF NOT RUN: tests/unit/e25-deploy-order.test.ts needs Docker for postgres:16. Start Docker, or set ETA_ALLOW_SKIP_E2E=1 to accept that it was not proven.");
  });
});

/** The diarizer's speech for the seeded turn, clip-relative ms. */
const SEGMENTS_JSON = JSON.stringify([{ start_ms: 0, end_ms: 9000, speaker_idx: 0 }]);
const M0074 = () => readFileSync("db/migrations/0074_room_diarize.sql", "utf8");

/**
 * THE PRE-0097, PRE-0099 SCHEMA: everything E24 depends on except those two, exactly as production stood on
 * 15 Sep 2026 (highest recorded migration 93). Rebuilt per test, so each test withholds its own migration and
 * the three are independent of order.
 */
function buildBase(): void {
  const m0074 = M0074();
  const keep = (name: string) => {
    const i = m0074.indexOf(`CREATE TABLE IF NOT EXISTS ${name}`);
    return m0074.slice(i, m0074.indexOf(");", i) + 2);
  };
  pg.exec(`
    DROP SCHEMA public CASCADE; CREATE SCHEMA public;
    CREATE TABLE schema_migrations (version int PRIMARY KEY, name text, applied_at timestamptz NOT NULL DEFAULT NOW());
    CREATE TABLE bench_session (id text PRIMARY KEY, room_id text);
    INSERT INTO bench_session VALUES ('sess_1', 'room_1');
    CREATE TABLE cue (id text PRIMARY KEY, room_day_id text, type text, source text, source_ref text, payload jsonb, at timestamptz DEFAULT now());
  `);
  pg.exec(noRecord("db/migrations/0057_bench_window.sql"));
  pg.exec(keep("room_turn_speaker"));
  pg.exec(keep("room_diarize_window"));
  for (const f of ["0085_room_turn_speaker_role", "0088_room_diarize_window_retry", "0089_room_emotion", "0090_diarize_run_id_and_service_guess"]) {
    pg.exec(noRecord(`db/migrations/${f}.sql`));
  }
  pg.exec(`
    INSERT INTO bench_window (id, session_id, room_day_id, start_ms, end_ms, source_mic, clip_r2_key, grid_aligned, state, closed_at)
    VALUES ('bw_order', 'sess_1', 'rd_1', 0, 900000, 'primary', 'clips/bw_order.webm', TRUE, 'transcribed', NOW());
  `);
}

/** One speaker's turn over 0-9 s, with its cue and its binding — enough for prepare to plan one segment. */
function seedTurns(runId: string): void {
  pg.exec(`
    INSERT INTO cue (id, room_day_id, type, source, source_ref, payload)
    VALUES ('c_bw_order|a1', 'rd_1', 'stt_turn', 'replay', 'bw_order|a1', '{"start_ms":0,"end_ms":9000}'::jsonb);
    INSERT INTO room_turn_speaker (window_id, source_ref, speaker_idx, overlap_ms, room_day_id, no_role_reason, run_id)
    VALUES ('bw_order', 'bw_order|a1', 0, 9000, 'rd_1', 'no_match', '${runId}');
  `);
}

/** Apply exactly these migration files THROUGH THE REAL RUNNER — its own discovery, splitter and transaction. */
async function applyThroughRunner(files: string[]): Promise<{ applied: string[]; skipped: string[]; errored: unknown }> {
  const dir = mkdtempSync(join(tmpdir(), "e25-migrations-"));
  mkdirSync(join(dir, "db", "migrations"), { recursive: true });
  for (const f of files) {
    const body = readFileSync(`db/migrations/${f}`, "utf8");
    expect(body, `${f} carries a semicolon inside a header comment`).toMatch(/^--[^\n]*;/m);
    writeFileSync(join(dir, "db", "migrations", f), body);
  }
  const cwd = vi.spyOn(process, "cwd").mockReturnValue(dir);
  process.env.MIGRATION_SECRET = "test-migration-secret";
  const { POST } = await import("@/app/api/run-migrations/route");
  const { NextRequest } = await import("next/server");
  const res = await POST(new NextRequest("https://x.test/api/run-migrations", { method: "POST", headers: { authorization: "Bearer test-migration-secret" } }));
  cwd.mockRestore();
  expect(res.status).toBe(200);
  return (await res.json()) as { applied: string[]; skipped: string[]; errored: unknown };
}

beforeAll(() => {
  if (!HAVE_DOCKER) return;
  pg.start();
  H.sql = pg.sql;
  H.raw = (text: string) => pg.exec(text);
  H.tx = (texts: string[]) => pg.exec(`BEGIN;\n${texts.join(";\n")};\nCOMMIT;`);
}, 180_000);
afterAll(() => { if (HAVE_DOCKER) pg.stop(); });

type Outcome = { kind: string; error?: string };
const runStep = async (step: string, progress: Record<string, unknown> = {}): Promise<Outcome & { step?: string; progress?: Record<string, unknown> }> =>
  (await (await import("@/lib/jobs/kinds/emotion-window")).emotionWindowKind.run({ step, args: { window_id: "bw_order" }, progress, job: {} as never } as never)) as Outcome;
/** Drive the kind from prepare until it settles, or until `maxSteps` — the same loop the runner uses. */
const runKind = async (): Promise<Outcome> => {
  let step = "prepare";
  let progress: Record<string, unknown> = {};
  for (let i = 0; i < 12; i += 1) {
    const out = await runStep(step, progress);
    if (out.kind !== "next") return out;
    step = out.step!;
    progress = out.progress!;
  }
  throw new Error("the kind did not settle");
};
const diarizeRow = async () =>
  ((await pg.sql`SELECT state, segments_run_id, last_run_id FROM room_diarize_window WHERE window_id = 'bw_order'`) as Array<{ state: string; segments_run_id: string | null; last_run_id: string }>)[0];
const writeDiarize = async (runId: string) => {
  const { recordDiarizeWindow } = await import("@/lib/stt/diarize-window");
  return recordDiarizeWindow({
    windowId: "bw_order", roomDayId: "rd_1", state: "ok", error: null, speakers: [],
    segments: JSON.parse(SEGMENTS_JSON) as unknown[], clipR2Key: "clips/bw_order.webm", timing: null, runId,
  });
};

describe.runIf(HAVE_DOCKER)("E25 R16 / E26 T1 — the deploy order, executed one migration at a time", () => {
  it("0099 WITHHELD, 0097 applied: the diarize INSERT, the emotion prepare SELECT and the emotion window write each die on a column 0099 adds — and applying 0099 ALONE fixes all three", async () => {
    buildBase();
    pg.exec(noRecord("db/migrations/0097_room_span_emotion_speech.sql"));
    const { recordStaleWindow } = await import("@/lib/emotion/store");

    // Path A — the diarize INSERT. Every diarize_window job that reaches its window-row write dies here.
    H.lastError = "";
    const insertErr = await writeDiarize("run_pre").then(() => null, (e: Error) => String(e.message));
    expect(insertErr, "the diarize INSERT must fail before 0099").not.toBeNull();
    expect(H.lastError, "the database's own message on the writer's own statement").toMatch(/column "segments_run_id" of relation "room_diarize_window" does not exist/);

    // Path B — the emotion prepare SELECT. It dies before any row is read, so no window is ever scored; the kind
    // catches it and fails BY NAME, carrying the database's own message.
    H.lastError = "";
    const broken = await runKind();
    expect(broken.kind, "the emotion job must fail before 0099").toBe("fail");
    expect(String(broken.error), "every window fails by name, at prepare").toMatch(/^emotion_window_failed: prepare: /);
    expect(H.lastError, "the database's own message on the job's own SELECT").toMatch(/column d\.segments_run_id does not exist/);
    expect(((await pg.sql`SELECT count(*)::int AS n FROM room_diarize_window WHERE window_id = 'bw_order'`) as Array<{ n: number }>)[0]!.n, "nothing was written").toBe(0);

    // Path C — the emotion WINDOW write. Reached by every stale mark, and it names stale_segments_run_id (0099).
    H.lastError = "";
    const markErr = await recordStaleWindow({ windowId: "bw_order", roomDayId: "rd_1", diarizeRunId: "run_pre", segmentsRunId: null, reason: "x" })
      .then(() => null, (e: Error) => String(e.message));
    expect(markErr, "the emotion window write must fail before 0099").not.toBeNull();
    expect(H.lastError, "the database's own message on the store's own statement").toMatch(/column "stale_segments_run_id" of relation "room_emotion_window" does not exist/);

    // THE FIX — 0099 ALONE, through the real runner, and it records itself inside the runner's transaction.
    expect(await applyThroughRunner(["0099_room_diarize_segments_run_id.sql"]))
      .toEqual({ applied: ["0099_room_diarize_segments_run_id"], skipped: [], errored: null });
    expect((await pg.sql`SELECT version FROM schema_migrations ORDER BY version`) as Array<{ version: number }>).toEqual([{ version: 99 }]);

    await writeDiarize("run_after");
    expect(await diarizeRow(), "Path A lands, with its run recorded").toMatchObject({ state: "ok", segments_run_id: "run_after", last_run_id: "run_after" });
    const fixed = await runKind();
    expect(String(fixed.error ?? ""), "Path B reads past the column").not.toMatch(/segments_run_id does not exist/);
    await recordStaleWindow({ windowId: "bw_order", roomDayId: "rd_1", diarizeRunId: "run_after", segmentsRunId: null, reason: "x" });
    expect(((await pg.sql`SELECT stale_segments_run_id FROM room_emotion_window WHERE window_id = 'bw_order'`) as Array<{ stale_segments_run_id: string | null }>)[0], "Path C lands").toEqual({ stale_segments_run_id: null });
  }, 300_000);

  it("0097 WITHHELD, 0099 applied: E24 gets past every 0099 column and dies in the SPAN write on room_span_emotion.speech_ms — and applying 0097 ALONE fixes it", async () => {
    buildBase();
    pg.exec(noRecord("db/migrations/0099_room_diarize_segments_run_id.sql"));
    seedTurns("run_span");
    await writeDiarize("run_span");
    expect(await diarizeRow(), "the 0099 paths are healthy: this is not the earlier break wearing a new name")
      .toMatchObject({ state: "ok", segments_run_id: "run_span", last_run_id: "run_span" });

    // The job plans its segment, reaches the SPAN write, and dies there — on 0097's column, not 0099's. The
    // window write it then attempts as failure bookkeeping dies on 0097's other column (segments_unscorable) and
    // that second error escapes the kind, so without 0097 the job cannot even record its own failure.
    H.lastError = ""; H.errors.length = 0;
    const thrown = await runKind().then(() => null, (e: Error) => String(e?.message ?? e));
    expect(H.errors[0], "the FIRST break is the span write, on the database's own message").toMatch(/column "speech_ms" of relation "room_span_emotion" does not exist/);
    expect(H.errors[0], "and NOT a 0099 column: this test proves 0097's break, alone").not.toMatch(/segments_run_id/);
    expect(H.errors.join("\n"), "no 0099 column is involved anywhere in this failure").not.toMatch(/segments_run_id/);
    expect(thrown ?? H.errors.join("\n"), "the follow-on failure write dies on 0097's other column").toMatch(/column "segments_unscorable" of relation "room_emotion_window" does not exist/);
    expect(((await pg.sql`SELECT count(*)::int AS n FROM room_span_emotion WHERE window_id = 'bw_order'`) as Array<{ n: number }>)[0]!.n, "no span row was written").toBe(0);

    // THE FIX — 0097 ALONE, through the real runner.
    expect(await applyThroughRunner(["0097_room_span_emotion_speech.sql"]))
      .toEqual({ applied: ["0097_room_span_emotion_speech"], skipped: [], errored: null });
    expect((await pg.sql`SELECT version FROM schema_migrations ORDER BY version`) as Array<{ version: number }>).toEqual([{ version: 97 }]);

    H.lastError = ""; H.errors.length = 0;
    const fixed = await runKind();
    expect(H.errors.join("\n"), "nothing dies on a 0097 column any more").not.toMatch(/speech_ms|segments_unscorable/);
    const rows = (await pg.sql`SELECT state, speech_ms, speech_basis FROM room_span_emotion WHERE window_id = 'bw_order'`) as Array<{ state: string; speech_ms: number | null; speech_basis: string }>;
    expect(rows.length, `the span write lands; job outcome ${JSON.stringify(fixed)}`).toBe(1);
    expect(rows[0], "and it carries the measure 0097 added").toMatchObject({ speech_ms: 9000, speech_basis: "diarize_segments" });
  }, 300_000);

  it("THE STRADDLE: pre-E24 code's OWN upsert, executed against the post-0099 schema, lands NULL — and E24 reads it with R17's honest reason", async () => {
    buildBase();
    pg.exec(noRecord("db/migrations/0097_room_span_emotion_speech.sql"));
    pg.exec(noRecord("db/migrations/0099_room_diarize_segments_run_id.sql"));

    // E26 T2 — the fixture IS the pre-E24 statement, committed rather than read from git, so this proof does not
    // depend on how the repo was cloned. It is executed, not grepped.
    const fixture = readFileSync("tests/fixtures/pre-e24-diarize-window-insert.sql", "utf8");
    const stmt = fixture.split("\n").filter((l) => !l.startsWith("--")).join("\n");
    expect(stmt, "pre-E24 code names no segments_run_id anywhere in its upsert").not.toMatch(/segments_run_id/);
    const bind: Record<string, string> = {
      ":window_id": "'bw_order'", ":room_day_id": "'rd_1'", ":state": "'ok'", ":speakers_json": "'[]'",
      ":segments_json": `'${SEGMENTS_JSON}'`, ":clip_r2_key": "'clips/bw_order.webm'", ":error": "NULL",
      ":timing_json": "NULL", ":last_run_id": "'run_straddle'",
    };
    pg.exec(stmt.replace(/:[a-z0-9_]+/g, (m) => bind[m] ?? m));
    expect(await diarizeRow(), "a straddling write lands, and records no writer run").toMatchObject({ state: "ok", segments_run_id: null, last_run_id: "run_straddle" });

    const straddled = await runKind();
    expect(straddled.kind, "E24 reads the straddle row without crashing").toBe("fail");
    expect(String(straddled.error)).toBe("diarize_segments_stale: diarize segments have no recorded writer run (segments_run_id is NULL); which run wrote them is unknown");
    expect(String(straddled.error), "R17: the reason claims no cause it cannot know").not.toMatch(/predate|before 0099|older migration/);
    const marked = (await pg.sql`SELECT state, stale_segments_run_id FROM room_emotion_window WHERE window_id = 'bw_order'`) as Array<{ state: string; stale_segments_run_id: string | null }>;
    expect(marked[0], "and it is marked NULL, so one ok diarize run cures it (E26 T4)").toEqual({ state: "diarize_stale", stale_segments_run_id: null });
  }, 300_000);
});

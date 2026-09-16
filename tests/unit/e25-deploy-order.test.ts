/**
 * E25 R16 — THE DEPLOY-ORDER CONSTRAINT, PROVEN BY EXECUTION.
 *
 * Three documents say "0099 MUST be applied before this code deploys, or every diarize INSERT and every emotion
 * prepare SELECT fails on the missing column" (the 0099 header, the E25 commit message, and
 * docs/handoff/ETA-E25-DEPLOY-ORDER-E24.md). Until this file, that was an assertion. Here it is run:
 *
 *   1. THE BREAK. A real postgres:16 at the PRE-0099 schema. E24 code is pointed at it and both named paths
 *      fail, with the database's own message asserted, not a paraphrase.
 *   2. THE FIX. 0097 then 0099 are applied THROUGH THE REAL RUNNER (app/api/run-migrations/route.ts — its own
 *      discovery, its own splitter, its own transaction call), and the same two paths then succeed. Both files
 *      carry a semicolon inside a header comment, so the splitter's comment handling is proven by execution too.
 *   3. THE STRADDLE. With 0099 applied and PRE-E24 code writing (the a05d750 INSERT, which names no
 *      segments_run_id — asserted against that commit's own source), the row lands with NULL and nothing
 *      crashes, and E24 reads it with R17's honest reason: the writer is unrecorded, never "predates 0099".
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
import { execFileSync } from "node:child_process";
import { dockerAvailable, pgContainer } from "../support/s1-pg";

const H = vi.hoisted(() => ({
  sql: null as null | ((s: TemplateStringsArray, ...v: unknown[]) => Promise<unknown[]>),
  raw: null as null | ((text: string) => void),
  tx: null as null | ((texts: string[]) => void),
  /** The database's own message from the last statement that failed — the kind truncates its detail at 160 chars. */
  lastError: "",
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
  const record = (p: Promise<unknown[]>) => p.catch((e: Error) => { H.lastError = String(e?.message ?? e); throw e; });
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
  scoreSegments: async () => ({ ok: false, error: "not reached in this file", retryable: false }),
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

beforeAll(() => {
  if (!HAVE_DOCKER) return;
  pg.start();
  const m0074 = readFileSync("db/migrations/0074_room_diarize.sql", "utf8");
  const keep = (name: string) => {
    const i = m0074.indexOf(`CREATE TABLE IF NOT EXISTS ${name}`);
    return m0074.slice(i, m0074.indexOf(");", i) + 2);
  };
  // THE PRE-0099 SCHEMA: everything E24 depends on EXCEPT 0097 and 0099, exactly as production stood on
  // 15 Sep 2026 (highest recorded migration 93, neither 0097 nor 0099 applied).
  pg.exec(`
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
  H.sql = pg.sql;
  H.raw = (text: string) => pg.exec(text);
  H.tx = (texts: string[]) => pg.exec(`BEGIN;\n${texts.join(";\n")};\nCOMMIT;`);
}, 180_000);
afterAll(() => { if (HAVE_DOCKER) pg.stop(); });

type Outcome = { kind: string; error?: string };
const run = async (): Promise<Outcome> =>
  (await (await import("@/lib/jobs/kinds/emotion-window")).emotionWindowKind.run({ step: "prepare", args: { window_id: "bw_order" }, progress: {}, job: {} as never } as never)) as Outcome;

const diarizeRow = async () =>
  ((await pg.sql`SELECT state, segments_run_id, last_run_id FROM room_diarize_window WHERE window_id = 'bw_order'`) as Array<{ state: string; segments_run_id: string | null; last_run_id: string }>)[0];

describe.runIf(HAVE_DOCKER)("E25 R16 — the deploy order, executed", () => {
  it("PRE-0099: both named paths fail on the missing column; the ordered apply through the REAL runner fixes both; a straddling pre-E24 write lands NULL and is read honestly", async () => {
    const { recordDiarizeWindow } = await import("@/lib/stt/diarize-window");
    const write = (runId: string) => recordDiarizeWindow({
      windowId: "bw_order", roomDayId: "rd_1", state: "ok", error: null, speakers: [],
      segments: JSON.parse(SEGMENTS_JSON) as unknown[], clipR2Key: "clips/bw_order.webm", timing: null, runId,
    });

    // ─── 1. THE BREAK ──────────────────────────────────────────────────────────────────────────────────
    // Path A: the diarize INSERT. Every diarize_window job that reaches its window-row write dies here.
    H.lastError = "";
    const insertErr = await write("run_pre").then(() => null, (e: Error) => String(e.message));
    expect(insertErr, "the diarize INSERT must fail before 0099").not.toBeNull();
    expect(H.lastError, "the database's own message on the writer's own statement").toMatch(/column "segments_run_id" of relation "room_diarize_window" does not exist/);

    // Path B: the emotion prepare SELECT. It dies before any row is read, so no window is ever scored. The
    // kind catches it and fails BY NAME (emotion_window_failed), carrying the database's own message — so the
    // shape of the break is a job failure on every window, not a crash.
    H.lastError = "";
    const broken = await run();
    expect(broken.kind, "the emotion job must fail before 0099").toBe("fail");
    expect(String(broken.error), "every window fails by name, at prepare").toMatch(/^emotion_window_failed: prepare: /);
    expect(H.lastError, "the database's own message on the job's own SELECT").toMatch(/column d\.segments_run_id does not exist/);
    const before = (await pg.sql`SELECT count(*)::int AS n FROM room_diarize_window WHERE window_id = 'bw_order'`) as Array<{ n: number }>;
    expect(before[0]!.n, "nothing was written").toBe(0);

    // ─── 2. THE FIX, THROUGH THE REAL RUNNER ───────────────────────────────────────────────────────────
    // 0097 then 0099, discovered and split by the route itself. Both carry a semicolon inside a header
    // comment, so a splitter that did not track line comments would cut them mid-comment and fail here.
    const dir = mkdtempSync(join(tmpdir(), "e25-migrations-"));
    mkdirSync(join(dir, "db", "migrations"), { recursive: true });
    for (const f of ["0097_room_span_emotion_speech.sql", "0099_room_diarize_segments_run_id.sql"]) {
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
    const body = (await res.json()) as { applied: string[]; skipped: string[]; errored: unknown };
    expect(body, `the runner must apply both files; body=${JSON.stringify(body)}`).toEqual({
      applied: ["0097_room_span_emotion_speech", "0099_room_diarize_segments_run_id"], skipped: [], errored: null,
    });
    expect(res.status).toBe(200);
    // Each file recorded ITSELF inside the runner's transaction (the runner never writes that row).
    expect((await pg.sql`SELECT version FROM schema_migrations ORDER BY version`) as Array<{ version: number }>)
      .toEqual([{ version: 97 }, { version: 99 }]);

    // The same two paths, now: the INSERT lands with its run recorded, and prepare reads past the column.
    await write("run_after");
    expect(await diarizeRow()).toMatchObject({ state: "ok", segments_run_id: "run_after", last_run_id: "run_after" });
    const fixed = await run();
    expect(fixed.kind, `prepare must get past the SELECT; ${JSON.stringify(fixed)}`).not.toBe("fail");
    expect(String(fixed.error ?? ""), "not the column, and not stale: the segments are this run's").not.toMatch(/segments_run_id|diarize_segments_stale/);

    // ─── 3. THE STRADDLE ───────────────────────────────────────────────────────────────────────────────
    // 0099 applied, PRE-E24 code still deployed. That code's INSERT names no segments_run_id at all —
    // asserted here against a05d750's own source, so this fixture cannot drift from the code it stands for.
    const preE24 = execFileSync("git", ["show", "a05d750:lib/stt/diarize-window.ts"], { encoding: "utf8" });
    expect(preE24, "pre-E24 code names no segments_run_id anywhere").not.toMatch(/segments_run_id/);
    pg.exec(`
      INSERT INTO room_diarize_window (window_id, room_day_id, state, speakers_json, segments_json, clip_r2_key, error, timing_json, last_run_id, diarized_at)
      VALUES ('bw_order', 'rd_1', 'ok', '[]'::jsonb, '${SEGMENTS_JSON}'::jsonb, 'clips/bw_order.webm', NULL, NULL, 'run_straddle', NOW())
      ON CONFLICT (window_id) DO UPDATE SET segments_json = EXCLUDED.segments_json, last_run_id = EXCLUDED.last_run_id, segments_run_id = NULL;
    `);
    expect(await diarizeRow(), "a straddling write lands, and records no writer run").toMatchObject({ state: "ok", segments_run_id: null, last_run_id: "run_straddle" });

    const straddled = await run();
    expect(straddled.kind, "E24 reads the straddle row without crashing").toBe("fail");
    expect(String(straddled.error)).toBe("diarize_segments_stale: diarize segments have no recorded writer run (segments_run_id is NULL); which run wrote them is unknown");
    expect(String(straddled.error), "R17: the reason claims no cause it cannot know").not.toMatch(/predate|before 0099|older migration/);
    const marked = (await pg.sql`SELECT state, stale_segments_run_id FROM room_emotion_window WHERE window_id = 'bw_order'`) as Array<{ state: string; stale_segments_run_id: string | null }>;
    expect(marked[0], "and it is marked, so one ok diarize run cures it").toEqual({ state: "diarize_stale", stale_segments_run_id: null });
  }, 300_000);
});

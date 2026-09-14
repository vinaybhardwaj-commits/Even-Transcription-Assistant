/**
 * S1 — an emotion_window whose every segment failed is a FAILURE; and (FIX2 N1) a RETRY of it replaces
 * the rows and records what was persisted, not what was remembered.
 *
 * AGAINST A REAL POSTGRES (0057, 0074's two tables, 0085, 0088, 0089, 0090 verbatim), through BOUND
 * parameters. The finishing write counts room_span_emotion in the statement that writes the window; a
 * fake database could only echo back whatever the test hoped those counts were.
 *
 * The kind's own `run` drives every step (prepare → warm → score → finish), so step dispatch and the
 * outcome are the real ones. Only the outside world is faked: the emotion service and R2.
 *
 *   planned > 0, scored = 0             -> window `failed`, error emotion_zero_scored, job fails
 *   retry of that window, all scored    -> the failed rows are REPLACED; window `ok` counted from rows
 *   planned > 0, scored > 0, failed > 0 -> window `ok`, job done (partial success is success)
 *   memory disagrees with the rows      -> the ROWS win, in both directions
 *   planned = 0                         -> window `no_segments`, job done (a quiet pass, unchanged)
 */
import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { dockerAvailable, pgContainer } from "../support/s1-pg";

type Mode = "all_ok" | "all_fail" | "first_ok";
const H = vi.hoisted(() => ({
  sql: (async () => []) as unknown as (s: TemplateStringsArray, ...v: unknown[]) => Promise<unknown[]>,
  mode: "all_ok" as "all_ok" | "all_fail" | "first_ok",
}));
vi.mock("@/lib/db", () => ({ sql: (s: TemplateStringsArray, ...v: unknown[]) => H.sql(s, ...v) }));
vi.mock("@/lib/r2", () => ({ signGetUrl: async () => "https://r2.example/clip" }));
vi.mock("@/lib/emotion/gate", () => ({ emotionEnabled: () => true }));
vi.mock("@/lib/emotion/client", async (orig) => {
  const LABELS = ["anger", "disgust", "enthusiasm", "fear", "happiness", "neutral", "sadness"];
  return {
    ...(await orig<Record<string, unknown>>()),
    emotionSecretConfigured: () => true,
    emotionHealth: async () => ({ ok: true, cap_s: 30, loaded: true, model: "m", subfolder: "int8" }),
    scoreSegments: async (_url: string, segments: Array<{ start_s: number; end_s: number }>) => {
      const warm = segments.length === 1 && segments[0]!.start_s === 0 && segments[0]!.end_s === 1;
      return {
        ok: true, model: "m", model_key: "wavlm", subfolder: "int8", device: "cpu", cap_s: 30, fetch_s: null, decode_s: null,
        results: segments.map((sg, i) => {
          const ok = warm || H.mode === "all_ok" || (H.mode === "first_ok" && i === 0);
          return ok
            ? { index: i, ok: true, labels: Object.fromEntries(LABELS.map((l) => [l, 1 / 7])), top_label: "anger", top_score: 1 / 7, duration_s: sg.end_s - sg.start_s, inference_s: 0.1 }
            : { index: i, ok: false, reason: "segment_too_short_for_model" };
        }),
      };
    },
  };
});

const { emotionWindowKind } = await import("@/lib/jobs/kinds/emotion-window");
const { errorCodeOf } = await import("@/lib/jobs/errors");

const HAVE_DOCKER = dockerAvailable();
const ALLOW_SKIP = process.env.ETA_ALLOW_SKIP_E2E === "1";
const pg = pgContainer("eta-s1-emotion");

describe("REQUIRED PROOF — the emotion finishing write against a real postgres", () => {
  it("ran, or was skipped deliberately", () => {
    if (HAVE_DOCKER || ALLOW_SKIP) return;
    throw new Error("REQUIRED PROOF NOT RUN: tests/unit/s1-emotion-zero-scored.test.ts needs Docker for postgres:16. Start Docker, or set ETA_ALLOW_SKIP_E2E=1 to accept that it was not proven.");
  });
});

const noRecord = (f: string) => readFileSync(f, "utf8").replace(/INSERT INTO schema_migrations[\s\S]*?;/g, "");

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
    CREATE TABLE cue (id text PRIMARY KEY, room_day_id text, type text, source text, source_ref text, payload jsonb, at timestamptz DEFAULT now());
  `);
  pg.exec(noRecord("db/migrations/0057_bench_window.sql"));
  pg.exec(keep("room_turn_speaker"));
  pg.exec(keep("room_diarize_window"));
  for (const f of ["0085_room_turn_speaker_role", "0088_room_diarize_window_retry", "0089_room_emotion", "0090_diarize_run_id_and_service_guess"]) {
    pg.exec(noRecord(`db/migrations/${f}.sql`));
  }
  H.sql = pg.sql;
}, 180_000);
afterAll(() => { if (HAVE_DOCKER) pg.stop(); });

let nextStart = 0;
/**
 * A diarized window with two speakers' runs — so TWO planned segments — and, with `turns: false`, none.
 * Speaker 0: 0–4 s and 5–9 s (one run). Speaker 1: 12–16 s and 17–20 s (one run).
 */
function seedWindow(id: string, opts: { turns?: boolean } = {}): void {
  const start = (nextStart += 900_000);
  const run = `run_${id}`;
  pg.exec(`
    INSERT INTO bench_window (id, session_id, room_day_id, start_ms, end_ms, source_mic, clip_r2_key, grid_aligned, state, closed_at)
    VALUES ('${id}', 'sess_1', 'rd_1', ${start}, ${start + 900_000}, 'primary', 'clips/${id}.webm', TRUE, 'transcribed', NOW());
    INSERT INTO room_diarize_window (window_id, room_day_id, state, speakers_json, segments_json, clip_r2_key, error, timing_json, last_run_id)
    VALUES ('${id}', 'rd_1', 'ok', '[]'::jsonb, '[]'::jsonb, 'clips/${id}.webm', NULL, NULL, '${run}');
  `);
  if (opts.turns === false) return;
  const turns: Array<[string, number, number, number]> = [["a1", 0, 0, 4000], ["a2", 0, 5000, 9000], ["b1", 1, 12_000, 16_000], ["b2", 1, 17_000, 20_000]];
  for (const [ref, spk, s, e] of turns) {
    const sref = `${id}|${ref}`;
    pg.exec(`
      INSERT INTO cue (id, room_day_id, type, source, source_ref, payload)
      VALUES ('c_${sref}', 'rd_1', 'stt_turn', 'replay', '${sref}', '{"start_ms":${start + s},"end_ms":${start + e}}'::jsonb);
      INSERT INTO room_turn_speaker (window_id, source_ref, speaker_idx, overlap_ms, room_day_id, no_role_reason, run_id)
      VALUES ('${id}', '${sref}', ${spk}, 1000, 'rd_1', 'no_match', '${run}');
    `);
  }
}

type Outcome = { kind: string; result?: Record<string, unknown>; error?: string };
/** Drive the kind step by step. `beforeFinish` may rewrite the progress handed to finish. */
async function runKind(windowId: string, beforeFinish?: (p: Record<string, unknown>) => Record<string, unknown>): Promise<{ steps: string[]; out: Outcome }> {
  let step = emotionWindowKind.first;
  let progress: Record<string, unknown> = {};
  const steps: string[] = [];
  for (let i = 0; i < 12; i += 1) {
    steps.push(step);
    if (step === "finish" && beforeFinish) progress = beforeFinish(progress);
    const out = await emotionWindowKind.run({ step, args: { window_id: windowId }, progress, job: {} as never } as never) as Outcome & { step?: string; progress?: Record<string, unknown> };
    if (out.kind !== "next") return { steps, out };
    step = out.step!;
    progress = out.progress!;
  }
  throw new Error("the kind did not finish");
}

const windowRow = async (id: string) =>
  ((await pg.sql`SELECT state, error, attempts, jsonb_array_length(failure_history) AS history,
                        segments_planned AS planned, segments_scored AS scored, segments_failed AS failed, segments_skipped AS skipped
                   FROM room_emotion_window WHERE window_id = ${id}`) as Array<Record<string, unknown>>)[0];
const segmentStates = async (id: string) =>
  ((await pg.sql`SELECT state FROM room_span_emotion WHERE window_id = ${id} ORDER BY segment_start_ms`) as Array<{ state: string }>).map((r) => r.state);

describe.skipIf(!HAVE_DOCKER)("zero scored is a failure — and its retry replaces the rows (N1)", () => {
  beforeEach(() => { H.mode = "all_ok"; });

  it("attempt 1 scores nothing: window FAILED / emotion_zero_scored from the rows, and the job fails", async () => {
    seedWindow("bw_zero");
    H.mode = "all_fail";
    const { steps, out } = await runKind("bw_zero");
    expect(steps).toEqual(["prepare", "warm", "score", "finish"]);
    expect(out.kind).toBe("fail");
    expect(errorCodeOf(out.error!), "the job error still leads with a published code").toBe("emotion_window_failed");
    expect(out.error).toContain("emotion_zero_scored");
    expect(await segmentStates("bw_zero")).toEqual(["failed", "failed"]);
    expect(await windowRow("bw_zero")).toMatchObject({ state: "failed", error: "emotion_zero_scored", attempts: 1, planned: 2, scored: 0, failed: 2 });
  });

  it("attempt 2 scores everything: the failed rows are REPLACED, and the window is OK with counts taken from them", async () => {
    H.mode = "all_ok";
    const { out } = await runKind("bw_zero");
    expect(out.kind).toBe("done");
    expect(await segmentStates("bw_zero"), "a retry's writes used to collide with attempt 1's rows and do nothing").toEqual(["scored", "scored"]);
    expect(await windowRow("bw_zero")).toMatchObject({ state: "ok", error: null, attempts: 2, history: 1, planned: 2, scored: 2, failed: 0 });
    expect(out.result).toMatchObject({ scored: 2, failed: 0, window_row: "written" });
  });

  it("a re-run for the settled diarize run leaves the final window row as it is, and says so", async () => {
    const { out } = await runKind("bw_zero");
    expect(out.kind).toBe("done");
    expect(out.result).toMatchObject({ window_row: "left_final" });
    expect(await windowRow("bw_zero")).toMatchObject({ state: "ok", attempts: 2 });
    expect(await segmentStates("bw_zero")).toEqual(["scored", "scored"]);
  });

  it("partial success stays OK: one scored, one failed", async () => {
    seedWindow("bw_partial");
    H.mode = "first_ok";
    const { out } = await runKind("bw_partial");
    expect(out.kind).toBe("done");
    expect(await windowRow("bw_partial")).toMatchObject({ state: "ok", error: null, planned: 2, scored: 1, failed: 1 });
  });
});

describe.skipIf(!HAVE_DOCKER)("finish records what was PERSISTED, not what was remembered", () => {
  it("memory says nothing scored, the rows say everything did: OK, from the rows", async () => {
    seedWindow("bw_mem_low");
    H.mode = "all_ok";
    const { out } = await runKind("bw_mem_low", (p) => ({ ...p, scored: 0, failed: 2 }));
    expect(out.kind).toBe("done");
    expect(await windowRow("bw_mem_low")).toMatchObject({ state: "ok", scored: 2, failed: 0 });
  });

  it("memory says everything scored, the rows say nothing did: FAILED / emotion_zero_scored, from the rows", async () => {
    seedWindow("bw_mem_high");
    H.mode = "all_fail";
    const { out } = await runKind("bw_mem_high", (p) => ({ ...p, scored: 2, failed: 0 }));
    expect(out.kind).toBe("fail");
    expect(await windowRow("bw_mem_high")).toMatchObject({ state: "failed", error: "emotion_zero_scored", scored: 0, failed: 2 });
  });
});

describe.skipIf(!HAVE_DOCKER)("planned = 0 is still the no_segments quiet pass", () => {
  it("no attributed turns: no_segments, error null, job done — it never reaches finish", async () => {
    seedWindow("bw_quiet", { turns: false });
    const { steps, out } = await runKind("bw_quiet");
    expect(steps).toEqual(["prepare"]);
    expect(out.kind).toBe("done");
    expect(await windowRow("bw_quiet")).toMatchObject({ state: "no_segments", error: null, planned: 0, scored: 0 });
  });
});

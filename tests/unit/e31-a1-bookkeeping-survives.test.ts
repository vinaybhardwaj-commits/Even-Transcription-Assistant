/**
 * E31 A1 — THE DOUBLE FAILURE, REPRODUCED: the span write dies AND the write meant to record that death
 * dies too, for the same reason.
 *
 * THIS IS THE CASE THAT HAPPENED. A deploy reached the code before migration 0097 reached the database.
 * 0097 adds `room_span_emotion.speech_ms` AND `room_emotion_window.segments_unscorable`, so:
 *   1. the span write died on the first column, and
 *   2. the job's failure bookkeeping — which exists to record exactly that — died on the second.
 * The second error escaped the kind. No failed row. No attempt counted. No error text. The window retried
 * for ever with a counter that never moved, and every operator view read it as one nobody had reached.
 *
 * So this suite applies every migration EXCEPT 0097, which is the production shape, and asserts that the
 * attempt is counted anyway. A fresh database cannot see this defect, which is why it survived to be
 * proven in production rather than in a test.
 */
import { describe, it, expect, vi, beforeAll, afterAll } from "vitest";
import { readFileSync } from "node:fs";
import { dockerAvailable, pgContainer } from "../support/s1-pg";

const H = vi.hoisted(() => ({ sql: (async () => []) as unknown as (s: TemplateStringsArray, ...v: unknown[]) => Promise<unknown[]> }));
vi.mock("@/lib/db", () => ({ sql: (s: TemplateStringsArray, ...v: unknown[]) => H.sql(s, ...v) }));
vi.mock("@/lib/r2", () => ({ signGetUrl: async () => "https://r2.example/clip" }));
vi.mock("@/lib/emotion/gate", () => ({ emotionEnabled: () => true }));
vi.mock("@/lib/emotion/client", async (orig) => {
  const LABELS = ["anger", "disgust", "enthusiasm", "fear", "happiness", "neutral", "sadness"];
  return {
    ...(await orig<Record<string, unknown>>()),
    emotionSecretConfigured: () => true,
    emotionHealth: async () => ({ ok: true, cap_s: 30, min_speech_s: 1.5, loaded: true, model: "m", subfolder: null }),
    scoreSegments: async (_u: string, segments: Array<{ start_s: number; end_s: number }>) => ({
      ok: true, model: "m", model_key: "wavlm", subfolder: null, device: "cpu", cap_s: 30, fetch_s: null, decode_s: null,
      results: segments.map((sg, i) => ({
        index: i, ok: true, labels: Object.fromEntries(LABELS.map((l) => [l, 1 / 7])),
        top_label: "anger", top_score: 1 / 7, duration_s: sg.end_s - sg.start_s, inference_s: 0.1,
      })),
    }),
  };
});

const HAVE_DOCKER = dockerAvailable();
const ALLOW_SKIP = process.env.ETA_ALLOW_SKIP_E2E === "1";
const pg = pgContainer("eta-e31-a1-pre0097");
const noRecord = (f: string) => readFileSync(f, "utf8").replace(/INSERT INTO schema_migrations[\s\S]*?;/g, "");

describe("REQUIRED PROOF — the double failure is measured against a real postgres", () => {
  it("ran, or was skipped deliberately", () => {
    if (HAVE_DOCKER || ALLOW_SKIP) return;
    throw new Error("REQUIRED PROOF NOT RUN: tests/unit/e31-a1-bookkeeping-survives.test.ts needs Docker for postgres:16. Start Docker, or set ETA_ALLOW_SKIP_E2E=1 to accept that it was not proven.");
  });
});

const SEGMENTS_JSON = JSON.stringify([
  { start_ms: 0, end_ms: 9000, speaker_idx: 0 },
  { start_ms: 12000, end_ms: 20000, speaker_idx: 1 },
]);

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
  // EVERY MIGRATION EXCEPT 0097. This is the deploy that happened, not a hypothetical one.
  for (const f of ["0085_room_turn_speaker_role", "0088_room_diarize_window_retry", "0089_room_emotion", "0090_diarize_run_id_and_service_guess", "0099_room_diarize_segments_run_id"]) {
    pg.exec(noRecord(`db/migrations/${f}.sql`));
  }
  H.sql = pg.sql;
}, 240_000);
afterAll(() => { if (HAVE_DOCKER) pg.stop(); });

function seedWindow(id: string): void {
  const start = 900_000_000;
  const run = `run_${id}`;
  pg.exec(`
    INSERT INTO bench_window (id, session_id, room_day_id, start_ms, end_ms, source_mic, clip_r2_key, grid_aligned, state, closed_at)
    VALUES ('${id}', 'sess_1', 'rd_1', ${start}, ${start + 900_000}, 'primary', 'clips/${id}.webm', TRUE, 'transcribed', NOW());
    INSERT INTO room_diarize_window (window_id, room_day_id, state, speakers_json, segments_json, segments_run_id, clip_r2_key, error, timing_json, last_run_id)
    VALUES ('${id}', 'rd_1', 'ok', '[]'::jsonb, '${SEGMENTS_JSON}'::jsonb, '${run}', 'clips/${id}.webm', NULL, NULL, '${run}');
  `);
  const turns: Array<[string, number, number, number]> = [["a1", 0, 0, 4000], ["a2", 0, 5000, 9000], ["b1", 1, 12_000, 16_000], ["b2", 1, 17_000, 20_000]];
  for (const [ref, spk, s, e] of turns) {
    const sref = `${id}|${ref}`;
    pg.exec(`
      INSERT INTO cue (id, room_day_id, type, source, source_ref, payload)
      VALUES ('c_${sref}', 'rd_1', 'stt_turn', 'replay', '${sref}', '{"start_ms":${start + s},"end_ms":${start + e}}'::jsonb);
      INSERT INTO room_turn_speaker (window_id, source_ref, speaker_idx, overlap_ms, room_day_id, no_role_reason, run_id)
      VALUES ('${id}', '${sref}', ${spk}, 4000, 'rd_1', 'no_match', '${run}');
    `);
  }
}

async function runKind(windowId: string) {
  const { emotionWindowKind } = await import("@/lib/jobs/kinds/emotion-window");
  let step = emotionWindowKind.first;
  let progress: Record<string, unknown> = {};
  const steps: string[] = [];
  for (let i = 0; i < 12; i += 1) {
    steps.push(step);
    const out = await emotionWindowKind.run({ step, args: { window_id: windowId }, progress, job: {} as never } as never) as { kind: string; step?: string; progress?: Record<string, unknown>; error?: string };
    if (out.kind !== "next") return { steps, out };
    step = out.step!;
    progress = out.progress!;
  }
  throw new Error("the kind did not finish");
}

const row = async (id: string) =>
  ((await pg.sql`SELECT state, attempts, error, jsonb_array_length(failure_history) AS history
                   FROM room_emotion_window WHERE window_id = ${id}`) as Array<Record<string, unknown>>)[0];

describe.runIf(HAVE_DOCKER)("E31 A1 — 0097 withheld: the span write dies, and the bookkeeping does not die with it", () => {
  it("the failure is RECORDED and the attempt is COUNTED, on a database that killed both writes before", async () => {
    seedWindow("bw_pre97");
    // 0097 really is absent, so this is the production shape and not a mocked rejection.
    const cols = (await pg.sql`SELECT column_name FROM information_schema.columns
                                WHERE table_name = 'room_span_emotion' AND column_name = 'speech_ms'`) as unknown[];
    expect(cols, "the fixture is a pre-0097 database").toHaveLength(0);
    const wcols = (await pg.sql`SELECT column_name FROM information_schema.columns
                                 WHERE table_name = 'room_emotion_window' AND column_name = 'segments_unscorable'`) as unknown[];
    expect(wcols, "and its window table is pre-0097 too — which is what killed the bookkeeping").toHaveLength(0);

    const { out } = await runKind("bw_pre97");
    expect(out.kind, "the job fails, as it must").toBe("fail");

    // THE ASSERTION THIS FILE EXISTS FOR.
    const r = await row("bw_pre97");
    expect(r, "a failure row EXISTS — it did not before").toBeDefined();
    expect(r!.state).toBe("failed");
    expect(Number(r!.attempts), "THE ATTEMPT IS COUNTED: this is the number whose never moving made the window retry for ever").toBeGreaterThanOrEqual(1);
    // Both causes are on the row, because a reader of room_emotion_window has no other record of either.
    expect(String(r!.error), "the original cause").toMatch(/speech_ms|emotion_window_failed|column/i);
    expect(String(r!.error), "and the fact that the full record could not be written").toContain("bookkeeping_degraded");
  }, 300_000);

  it("a SECOND attempt counts again, so the retry bound is reachable rather than infinite", async () => {
    const before = Number((await row("bw_pre97"))!.attempts);
    const { out } = await runKind("bw_pre97");
    expect(out.kind).toBe("fail");
    const after = await row("bw_pre97");
    expect(Number(after!.attempts), "the counter moves on every attempt, which is what EMOTION_MAX_ATTEMPTS bounds").toBe(before + 1);
    expect(Number(after!.history), "and the previous failure is kept, as the full path keeps it").toBeGreaterThanOrEqual(1);
  }, 300_000);
});

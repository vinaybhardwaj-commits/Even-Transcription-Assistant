/**
 * nemo-sweeper-pg.test.ts — ROUND 2 of nemo-primary, through the REAL runner (claimJobs + runOneStep) on postgres:16 with every migration.
 *
 *   R2-1  a RETRYABLE embed error (Mini outage, timeout, 5xx, network) makes the job step THROW: the runner retries to MAX_FAILURES, and only the
 *         last attempt writes a `failed` room_diarize_window row — never `ok`. A NON-retryable embed answer keeps today's ok + attribution none.
 *   R2-2  the scheduled route is the SWEEPER: it re-drives answered windows whose room row is absent or failed, oldest first, bounded by the
 *         window's failed-job count (3), deduped, and queues nothing for ok / no_speakers rows. A refused engine or a flag off queues nothing.
 * Only the outside world is faked (R2, the Mini's /embed_speakers). All ids are fake.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { NextRequest } from "next/server";
import { dockerAvailable, pgContainer } from "../support/s1-pg";
import { makeFakeClinician } from "../support/fake-identity";

const DOC = makeFakeClinician(1);

const H = vi.hoisted(() => ({
  sql: (async () => []) as unknown as (s: TemplateStringsArray, ...v: unknown[]) => Promise<unknown[]>,
  getBytes: vi.fn(async (_k: string): Promise<Uint8Array | null> => new Uint8Array([1, 2, 3])),
  embed: vi.fn(),
  fetch: vi.fn(async () => { throw new Error("EXTERNAL CALL: fetch was reached"); }),
  askJev: vi.fn(),
  emotionMode: "all_ok" as "all_ok",
}));
vi.mock("@/lib/db", () => ({ sql: (s: TemplateStringsArray, ...v: unknown[]) => H.sql(s, ...v) }));
vi.mock("@/lib/r2", async (orig) => ({ ...(await orig<Record<string, unknown>>()), getObjectBytes: (k: string) => H.getBytes(k), signGetUrl: async () => "https://r2.example/clip" }));
vi.mock("@/lib/diarize-embed", async (orig) => ({ ...(await orig<Record<string, unknown>>()), embedSpeakers: (...a: unknown[]) => H.embed(...a) }));
vi.mock("@/lib/jev/ask", async (orig) => ({ ...(await orig<Record<string, unknown>>()), askJev: (...a: unknown[]) => H.askJev(...a) }));
vi.mock("@/lib/emotion/gate", () => ({ emotionEnabled: () => true }));
vi.mock("@/lib/emotion/client", async (orig) => {
  const LABELS = ["anger", "disgust", "enthusiasm", "fear", "happiness", "neutral", "sadness"];
  return {
    ...(await orig<Record<string, unknown>>()),
    emotionSecretConfigured: () => true,
    emotionHealth: async () => ({ ok: true, cap_s: 30, min_speech_s: 1.5, loaded: true, model: "m", subfolder: "int8" }),
    scoreSegments: async (_u: string, segments: Array<{ start_s: number; end_s: number }>) => ({
      ok: true, model: "m", model_key: "wavlm", subfolder: "int8", device: "cpu", cap_s: 30, fetch_s: null, decode_s: null,
      results: segments.map((sg, i) => ({ index: i, ok: true, labels: Object.fromEntries(LABELS.map((l) => [l, 1 / 7])), top_label: "anger", top_score: 1 / 7, duration_s: sg.end_s - sg.start_s, inference_s: 0.1 })),
    }),
  };
});
vi.setConfig({ testTimeout: 120_000, hookTimeout: 300_000 });

const HAVE = dockerAvailable();
const pg = pgContainer("eta-nemo-sweeper");
const TOKEN = "tok-fake-nemo";

const { diarizeWindowKind } = await import("@/lib/jobs/kinds/diarize-window");
const { POST: ingest } = await import("@/app/api/diarize/nemotron/ingest/route");
const { configHash } = await import("@/lib/diarize-nemotron/validate");

const f32 = (hot: number) => Buffer.from(new Float32Array(192).map((_, i) => (i === hot ? 1 : 0)).buffer).toString("base64");
const CONFIG = { chunk: 340, fifo: 40 };
const DAY = "2026-10-01";
let nextStart = 1_790_000_000_000;

const body = (windowId: string, roomDay: string, o: Record<string, unknown> = {}) => ({
  window_id: windowId, room_day_id: roomDay, engine: "nemotron", model: "nvidia/Nemotron-3-Diarization", model_rev: "rev1",
  config: CONFIG, config_hash: configHash(CONFIG), worker_id: "box-1", machine: "box", audio_ms: 900_000, clip_sha256: "c".repeat(64),
  status: "ok", error_code: null, turns: [[0, 4000, "spk0"], [3500, 8000, "spk1"], [9000, 12000, "spk0"]], ...o,
});
const post = (b: unknown) =>
  ingest(new NextRequest("https://x.test/api/diarize/nemotron/ingest", { method: "POST", headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" }, body: JSON.stringify(b) }));
const q = async <T = Record<string, unknown>>(strings: TemplateStringsArray, ...v: unknown[]) => (await pg.sql(strings, ...v)) as T[];
const jobCount = async (windowId: string) =>
  (await q<{ n: number }>`SELECT count(*)::int AS n FROM scribe_job WHERE kind = 'diarize_window' AND args->>'window_id' = ${windowId}`)[0]!.n;

/** A window with its Nemotron-timed cues: each turn sits inside ONE speaker's span so the binding is exclusive. */
function seedWindow(id: string, opts: { roomDay?: string; oldRow?: boolean } = {}): { start: number } {
  const rd = opts.roomDay ?? "rd_n1";
  const start = (nextStart += 900_000);
  pg.exec(`
    INSERT INTO bench_window (id, session_id, room_day_id, start_ms, end_ms, source_mic, clip_r2_key, grid_aligned, state, closed_at)
    VALUES ('${id}', 'bs_n1', '${rd}', ${start}, ${start + 900_000}, 'primary', 'clips/${id}.webm', TRUE, 'transcribed', NOW());
  `);
  for (const [ref, s, e] of [["a", 100, 3000], ["b", 4500, 7500], ["c", 9500, 11500]] as const) {
    pg.exec(`
      INSERT INTO cue (id, room_day_id, session_id, type, source, source_ref, payload, at)
      VALUES ('c_${id}_${ref}', '${rd}', 'bs_n1', 'stt_turn', 'replay', '${id}|${ref}',
              '{"start_ms":${start + s},"end_ms":${start + e},"text":"placeholder words for the role reader to classify as a speaker turn","window":{"start_ms":${start},"end_ms":${start + 900_000}}}'::jsonb, to_timestamp(${(start + s) / 1000}));
    `);
  }
  if (opts.oldRow) {
    pg.exec(`INSERT INTO room_diarize_window (window_id, room_day_id, state, speakers_json, segments_json, segments_run_id, clip_r2_key, last_run_id, timing_json)
             VALUES ('${id}', '${rd}', 'ok', '[{"idx":0,"label":"SPEAKER_00"}]'::jsonb, '[{"start_ms":0,"end_ms":1000,"speaker_idx":0}]'::jsonb, 'run_pyannote_era', 'clips/${id}.webm', 'run_pyannote_era',
                     '{"engine":{"name":"pyannoteai"}}'::jsonb);`);
  }
  return { start };
}

const runJob = (windowId: string) => diarizeWindowKind.run({ step: "diarize", args: { window_id: windowId }, progress: {}, job: {} as never } as never) as Promise<{ kind: string; result?: Record<string, unknown>; error?: string }>;
const diarizeRow = async (id: string) =>
  (await q<{ state: string; speakers_json: Array<Record<string, unknown>>; segments_json: Array<Record<string, unknown>>; segments_run_id: string | null; last_run_id: string | null; timing_json: { engine: Record<string, unknown> } | null }>`
    SELECT state, speakers_json, segments_json, segments_run_id, last_run_id, timing_json FROM room_diarize_window WHERE window_id = ${id}`)[0];
const turnRows = (id: string) =>
  q<{ source_ref: string; speaker_idx: number; role: string | null; clinician_id: string | null; match_confidence: number | null; no_role_reason: string | null; run_id: string }>`
    SELECT source_ref, speaker_idx, role, clinician_id, match_confidence, no_role_reason, run_id FROM room_turn_speaker WHERE window_id = ${id} ORDER BY source_ref`;
const roomTables = async () =>
  (await q<{ d: number; t: number }>`SELECT (SELECT count(*) FROM room_diarize_window)::int AS d, (SELECT count(*) FROM room_turn_speaker)::int AS t`)[0]!;

/** The embed service as the Mini would answer it: speaker 0 matches doc_n1 (centroid = e0), speaker 1 matches nobody. */
const embedAnswer = () => ({
  ok: true,
  latencyMs: 12,
  speakers: [
    { idx: 0, embedding_base64: f32(0), clinician_id: "doc_n1", label: DOC.label, type: "clinician", confidence: 0.93, source: "voiceprint" },
    { idx: 1, embedding_base64: f32(1) },
  ],
});

beforeAll(() => {
  if (!HAVE) return;
  pg.start();
  for (const f of readdirSync("db/migrations").filter((x) => x.endsWith(".sql")).sort()) pg.exec(readFileSync(`db/migrations/${f}`, "utf8"));
  H.sql = pg.sql as never;
  pg.exec(`
    INSERT INTO room (id, slug, name, pin_hash, transcript_enabled) VALUES ('room_n1', 'nemo-room', 'Nemo Room', 'x', TRUE);
    INSERT INTO room_day (id, room_id, ist_date) VALUES ('rd_n1', 'room_n1', '${DAY}');
    INSERT INTO bench_session (id, room_id, started_at, ended_at, status) VALUES ('bs_n1', 'room_n1', '${DAY}T04:00:00Z', '${DAY}T20:00:00Z', 'ended');
    INSERT INTO clinician (id, email, failed_pin_count, status, full_name, url_slug, url_token, pin_hash) VALUES ('doc_n1', '${DOC.email}', 0, 'active', '${DOC.full_name}', 'dr-fake', 'tok_n1', 'x');
    INSERT INTO voice_print (doctor_id, centroid) VALUES ('doc_n1', decode('${f32(0)}', 'base64'));
  `);
}, 300_000);
afterAll(() => { if (HAVE) pg.stop(); });

beforeEach(() => {
  H.getBytes.mockClear();
  H.embed.mockReset().mockImplementation(async () => embedAnswer());
  H.fetch.mockClear();
  vi.stubGlobal("fetch", H.fetch);
  process.env.NEMOTRON_WORKER_TOKEN = TOKEN;
  process.env.DIARIZE_NEMOTRON_SHADOW = "1";
  delete process.env.DIARIZE_ENGINE;
  delete process.env.JOBS_RUNNER_SECRET;
});

const runner = async () => ({ ...(await import("@/lib/jobs/store")), ...(await import("@/lib/jobs/runner")) });
/** Claim and run ONE step of this window's job (and nothing else), through the real runner. Returns the report outcome or "none". */
async function stepOnce(windowId: string): Promise<string> {
  const { claimJobs, runOneStep } = await runner();
  const id = `r_${windowId}_${Math.random()}`;
  // the queue is shared by every case in this file: take OTHER windows' queued jobs out of play so the claim below can only be ours
  pg.exec(`UPDATE scribe_job SET status = 'cancelled' WHERE status = 'queued' AND args->>'window_id' <> '${windowId}'`);
  const claimed = (await claimJobs(1, 240_000, id)).filter((j) => j.kind === "diarize_window" && j.args.window_id === windowId);
  if (claimed.length === 0) return "none";
  const rep = await runOneStep(claimed[0]!, id);
  return rep.outcome;
}
const jobRows = (id: string) => q<{ status: string; failures: number; error: string | null }>`SELECT status, failures, error FROM scribe_job WHERE kind = 'diarize_window' AND args->>'window_id' = ${id} ORDER BY created_at`;
const sweep = async () => (await import("@/lib/stt/diarize-job")).enqueueDiarizeWindows({ actor: "cron:test", log: () => {} });
/** Make a window's job end without a row, the way a refused engine does, `n` times. */
async function failJobs(windowId: string, n: number): Promise<void> {
  process.env.DIARIZE_ENGINE = "local";
  const { claimJobs, runOneStep } = await runner();
  for (let i = 0; i < n; i += 1) {
    // the sweeper refuses to submit under a refused engine, so submit directly, as an operator would
    const { submitJob } = await import("@/lib/jobs/submit");
    await submitJob({ kind: "diarize_window", args: { window_id: windowId }, actor: "mcp:test", scopes: new Set(["invoke"] as const) });
    pg.exec(`UPDATE scribe_job SET status = 'cancelled' WHERE status = 'queued' AND args->>'window_id' <> '${windowId}'`);
    const c = (await claimJobs(1, 240_000, `rf_${i}`)).find((j) => j.args.window_id === windowId)!;
    await runOneStep(c, `rf_${i}`);
  }
  delete process.env.DIARIZE_ENGINE;
}

describe("REQUIRED PROOF ran, or was skipped deliberately", () => {
  it("needs Docker", () => {
    if (HAVE || process.env.ETA_ALLOW_SKIP_E2E === "1") return;
    throw new Error("REQUIRED PROOF NOT RUN: tests/unit/nemo-sweeper-pg.test.ts needs Docker for postgres:16, or set ETA_ALLOW_SKIP_E2E=1.");
  });
});

describe.runIf(HAVE)("R2-1 — a retryable embed error throws; the last attempt writes `failed`, never `ok`", () => {
  it("through the real runner: 3 attempts, a failed row only at the last, no ok row, no turn rows, then the job is failed", async () => {
    seedWindow("bw_r1");
    await post(body("bw_r1", "rd_n1"));
    H.embed.mockImplementation(async () => ({ ok: false, error: "embed_failed", retryable: true }));
    expect(await stepOnce("bw_r1")).toBe("failed"); // a throw is a counted failure, the step retried by the next claim
    expect(await diarizeRow("bw_r1"), "attempt 1 writes no row").toBeUndefined();
    expect(await stepOnce("bw_r1")).toBe("failed");
    expect(await diarizeRow("bw_r1"), "attempt 2 writes no row").toBeUndefined();
    await stepOnce("bw_r1");
    const row = (await diarizeRow("bw_r1"))!;
    expect(row.state, "the last attempt records the window failed").toBe("failed");
    expect(row.timing_json!.engine).toMatchObject({ name: "nemotron", embed_error: "embed_failed", attribution: "none" });
    expect(await turnRows("bw_r1")).toEqual([]);
    expect(H.embed).toHaveBeenCalledTimes(3);
    const jobs = await jobRows("bw_r1");
    expect(jobs).toHaveLength(1);
    expect(jobs[0]).toMatchObject({ status: "failed", failures: 3 });
    expect(jobs[0]!.error).toMatch(/step_threw/);
  });

  it("a retry that finds the Mini back succeeds: ok with the clinician match, and no failed row was ever written", async () => {
    seedWindow("bw_r1b");
    await post(body("bw_r1b", "rd_n1"));
    H.embed.mockImplementationOnce(async () => ({ ok: false, error: "embed_failed", retryable: true }));
    expect(await stepOnce("bw_r1b")).toBe("failed");
    expect(await diarizeRow("bw_r1b")).toBeUndefined();
    expect(await stepOnce("bw_r1b")).toBe("done");
    expect((await diarizeRow("bw_r1b"))!.state).toBe("ok");
    expect((await turnRows("bw_r1b")).some((t) => t.role === "clinician")).toBe(true);
  });

  it("a NON-retryable embed answer keeps today's behaviour: ok, attribution none, embed_error recorded, one attempt", async () => {
    seedWindow("bw_r1c");
    await post(body("bw_r1c", "rd_n1"));
    H.embed.mockImplementation(async () => ({ ok: false, error: "embed_bad_response", retryable: false }));
    expect(await stepOnce("bw_r1c")).toBe("done");
    const row = (await diarizeRow("bw_r1c"))!;
    expect(row.state).toBe("ok");
    expect(row.timing_json!.engine).toMatchObject({ attribution: "none", embed_error: "embed_bad_response" });
    expect(H.embed).toHaveBeenCalledTimes(1);
  });
});

describe.runIf(HAVE)("R2-2 — the sweeper re-drives windows whose job left no ok row", () => {
  beforeEach(() => { process.env.DIARIZE_NEMOTRON_SHADOW = "1"; });

  it("a REFUSED window is re-driven after the cause is fixed: refused engine → job failed, no row → sweep → ok", async () => {
    seedWindow("bw_s1");
    await post(body("bw_s1", "rd_n1"));
    pg.exec(`UPDATE scribe_job SET status = 'cancelled' WHERE status IN ('queued', 'running')`); // the ingest's own job: take it out of play
    await failJobs("bw_s1", 1);
    expect((await jobRows("bw_s1")).map((j) => j.status)).toEqual(["cancelled", "failed"]);
    expect(await diarizeRow("bw_s1")).toBeUndefined();
    // while the engine is still refused the sweeper is idle and says so
    process.env.DIARIZE_ENGINE = "local";
    expect((await sweep()).note).toMatch(/DIARIZE_ENGINE is refused/);
    delete process.env.DIARIZE_ENGINE;
    const r = await sweep();
    expect(r.enqueued.map((e) => e.window_id)).toContain("bw_s1");
    expect(await stepOnce("bw_s1")).toBe("done");
    expect((await diarizeRow("bw_s1"))!.state).toBe("ok");
    // done is final: the next sweep queues nothing for it
    expect((await sweep()).enqueued.map((e) => e.window_id)).not.toContain("bw_s1");
  });

  it("a FAILED row (clip was missing) is re-driven once the clip is back; a second sweep while its job is open queues no duplicate", async () => {
    seedWindow("bw_s2");
    await post(body("bw_s2", "rd_n1"));
    H.getBytes.mockResolvedValueOnce(null);
    await stepOnce("bw_s2");
    expect((await diarizeRow("bw_s2"))!.state).toBe("failed");
    const first = await sweep();
    expect(first.enqueued.map((e) => e.window_id)).toContain("bw_s2");
    const again = await sweep();
    expect(again.enqueued.map((e) => e.window_id), "an open job dedupes").not.toContain("bw_s2");
    expect(await stepOnce("bw_s2")).toBe("done");
    const row = (await diarizeRow("bw_s2"))!;
    expect(row.state).toBe("ok");
  });

  it("the ATTEMPT CAP stops it: after 3 failed jobs the window is not re-driven, and is COUNTED as exhausted", async () => {
    seedWindow("bw_s3");
    await post(body("bw_s3", "rd_n1"));
    pg.exec(`UPDATE scribe_job SET status = 'cancelled' WHERE status IN ('queued', 'running')`);
    await failJobs("bw_s3", 3);
    expect((await jobRows("bw_s3")).filter((j) => j.status === "failed")).toHaveLength(3);
    const r = await sweep();
    expect(r.enqueued.map((e) => e.window_id)).not.toContain("bw_s3");
    expect(r.exhausted).toBeGreaterThanOrEqual(1);
  });

  it("nothing is queued for an ok or a no_speakers row — pyannote-era or this engine's own", async () => {
    seedWindow("bw_s4", { oldRow: true });
    pg.exec(`INSERT INTO diarize_nemotron_window (window_id, room_day_id, model, model_rev, config, config_hash, worker_id, machine, audio_ms, turns_json, speaker_count, turn_count, speech_ms, overlap_ms, payload_sha256, status)
             VALUES ('bw_s4', 'rd_n1', 'm', 'rev1', '{}', 'h', 'w', 'box', 900000, '[[0,1000,"spk0"]]', 1, 1, 1000, 0, 'p', 'ok')`);
    seedWindow("bw_s5");
    await post(body("bw_s5", "rd_n1", { status: "empty", turns: [] }));
    expect(await stepOnce("bw_s5")).toBe("done");
    expect((await diarizeRow("bw_s5"))!.state).toBe("no_speakers");
    const r = await sweep();
    expect(r.enqueued.map((e) => e.window_id)).not.toContain("bw_s4");
    expect(r.enqueued.map((e) => e.window_id)).not.toContain("bw_s5");
  });

  it("oldest first, at most 20 per tick; and with DIARIZE_NEMOTRON_SHADOW off nothing is queued", async () => {
    pg.exec(`UPDATE scribe_job SET status = 'cancelled' WHERE status IN ('queued', 'running')`);
    for (let i = 0; i < 23; i += 1) {
      seedWindow(`bw_lim${String(i).padStart(2, "0")}`);
      pg.exec(`INSERT INTO diarize_nemotron_window (window_id, room_day_id, model, model_rev, config, config_hash, worker_id, machine, audio_ms, turns_json, speaker_count, turn_count, speech_ms, overlap_ms, payload_sha256, status)
               VALUES ('bw_lim${String(i).padStart(2, "0")}', 'rd_n1', 'm', 'rev1', '{}', 'h', 'w', 'box', 900000, '[[0,1000,"spk0"]]', 1, 1, 1000, 0, 'p', 'ok')`);
    }
    process.env.DIARIZE_NEMOTRON_SHADOW = "0";
    const off = await sweep();
    expect(off.enqueued).toEqual([]);
    expect(off.note).toMatch(/DIARIZE_NEMOTRON_SHADOW is off/);
    process.env.DIARIZE_NEMOTRON_SHADOW = "1";
    const on = await sweep();
    expect(on.enqueued).toHaveLength(20);
    const ids = on.enqueued.map((e) => e.window_id);
    // oldest first: the order returned is the order of bench_window.start_ms
    const starts = await q<{ id: string }>`SELECT id FROM bench_window WHERE id = ANY(${ids}::text[]) ORDER BY start_ms`;
    expect(starts.map((r) => r.id)).toEqual(ids);
  });
});

/**
 * nemo-primary-pg.test.ts — NEMOTRON AS THE ROOM DIARIZE ENGINE (design A), against a real postgres:16 with EVERY migration applied.
 *
 *   ingest    a stored Nemotron answer submits exactly ONE `diarize_window` job (a re-post never a second); it never writes the room tables
 *   job       the nemotron path writes room_diarize_window `ok` (speakers_json with embeddings, segments_json with overlap) and room_turn_speaker
 *             rows, with the clinician match when a centroid matches; `empty` → no_speakers; an existing ok row is history and is not touched
 *   refusal   DIARIZE_ENGINE=local|pyannoteai is refused by name with ZERO external calls (clip, embed, fetch)
 *   readers   emotion enqueue picks the window and the emotion job does NOT report diarize_stale; talk-time and jev-role read the rows
 *
 * Only the outside world is faked: R2, the Mini's /embed_speakers, the emotion service, the Jev model. Every SQL statement is the real one.
 * All ids are fake. No transcript text beyond a placeholder word.
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
const pg = pgContainer("eta-nemo-primary");
const TOKEN = "tok-fake-nemo";

const { diarizeWindowKind } = await import("@/lib/jobs/kinds/diarize-window");
const { emotionWindowKind } = await import("@/lib/jobs/kinds/emotion-window");
const { jevRoleKind } = await import("@/lib/jobs/kinds/jev-role");
const { enqueueEmotionWindows } = await import("@/lib/emotion/enqueue");
const { POST: ingest } = await import("@/app/api/diarize/nemotron/ingest/route");
const { configHash } = await import("@/lib/diarize-nemotron/validate");
const { readWindowTurns } = await import("@/lib/room-access/readers/turns");
const { evaluateTalkTime } = await import("@/lib/rubrics/engines/talk-time");
const { roleQid } = await import("@/lib/jev/prompts/role-v1");

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

describe("REQUIRED PROOF ran, or was skipped deliberately", () => {
  it("needs Docker", () => {
    if (HAVE || process.env.ETA_ALLOW_SKIP_E2E === "1") return;
    throw new Error("REQUIRED PROOF NOT RUN: tests/unit/nemo-primary-pg.test.ts needs Docker for postgres:16, or set ETA_ALLOW_SKIP_E2E=1.");
  });
});

describe.runIf(HAVE)("ingest → exactly one diarize_window job", () => {
  it("a stored window submits ONE job and writes NO room table; an identical re-post queues no second", async () => {
    seedWindow("bw_ing1");
    const before = await roomTables();
    const r1 = await post(body("bw_ing1", "rd_n1"));
    expect(r1.status).toBe(200);
    expect(await r1.json()).toMatchObject({ ok: true, result: "stored", job: "submitted" });
    expect(await jobCount("bw_ing1")).toBe(1);
    expect(await roomTables(), "the ingest route writes neither room_diarize_window nor room_turn_speaker").toEqual(before);
    const r2 = await post(body("bw_ing1", "rd_n1"));
    expect(await r2.json()).toMatchObject({ ok: true, result: "duplicate", job: "deduped" });
    expect(await jobCount("bw_ing1")).toBe(1);
  });

  it("after the job has run, a re-post queues nothing: the window already has its row", async () => {
    seedWindow("bw_ing2");
    await post(body("bw_ing2", "rd_n1"));
    expect((await runJob("bw_ing2")).kind).toBe("done");
    pg.exec(`UPDATE scribe_job SET status = 'done' WHERE kind = 'diarize_window' AND args->>'window_id' = 'bw_ing2'`);
    const r = await post(body("bw_ing2", "rd_n1"));
    expect(await r.json()).toMatchObject({ result: "duplicate", job: "none" });
    expect(await jobCount("bw_ing2")).toBe(1);
  });

  it("a lost first submit is rescued by the re-post (the row is stored, no job, no room row)", async () => {
    seedWindow("bw_ing3");
    await post(body("bw_ing3", "rd_n1"));
    pg.exec(`DELETE FROM scribe_job WHERE kind = 'diarize_window' AND args->>'window_id' = 'bw_ing3'`);
    expect(await jobCount("bw_ing3")).toBe(0);
    expect(await (await post(body("bw_ing3", "rd_n1"))).json()).toMatchObject({ result: "duplicate", job: "submitted" });
    expect(await jobCount("bw_ing3")).toBe(1);
  });

  it("an `empty` answer queues a job too; a stored `failed` answer queues none", async () => {
    seedWindow("bw_ing4");
    expect(await (await post(body("bw_ing4", "rd_n1", { status: "empty", turns: [] }))).json()).toMatchObject({ result: "stored", job: "submitted" });
    seedWindow("bw_ing5");
    pg.exec(`INSERT INTO diarize_nemotron_claim (window_id, worker_id, lease_until, attempts) VALUES ('bw_ing5', 'box-1', now() + interval '10 minutes', 1)`);
    const failed = await post(body("bw_ing5", "rd_n1", { status: "failed", error_code: "decode_failed", turns: [], audio_ms: 0, clip_sha256: null }));
    expect(await failed.json()).toMatchObject({ ok: true, result: "stored", job: "none" });
    expect(await jobCount("bw_ing5")).toBe(0);
  });
});

describe.runIf(HAVE)("the diarize_window job, nemotron path", () => {
  it("writes room_diarize_window ok with embeddings + overlap, and turn rows with the clinician match", async () => {
    seedWindow("bw_job1");
    await post(body("bw_job1", "rd_n1"));
    const out = await runJob("bw_job1");
    expect(out.kind).toBe("done");
    expect(out.result).toMatchObject({ engine: "nemotron", speakers_embedded: 2, model_rev: "rev1" });
    const row = (await diarizeRow("bw_job1"))!;
    expect(row.state).toBe("ok");
    expect(row.speakers_json.map((s) => [s.idx, typeof s.embedding_base64])).toEqual([[0, "string"], [1, "string"]]);
    expect(row.speakers_json[0]).toMatchObject({ clinician_id: "doc_n1", confidence: 0.93 });
    expect(row.segments_json).toEqual([
      { start_ms: 0, end_ms: 4000, speaker_idx: 0, overlap: true },
      { start_ms: 3500, end_ms: 8000, speaker_idx: 1, overlap: true },
      { start_ms: 9000, end_ms: 12000, speaker_idx: 0, overlap: false },
    ]);
    expect(row.timing_json!.engine).toMatchObject({ name: "nemotron", model: "nvidia/Nemotron-3-Diarization", model_rev: "rev1", config_hash: configHash(CONFIG), attribution: "voiceprint", centroids_offered: 1 });
    expect(row.segments_run_id, "the segments belong to the run that wrote the turns").toBe(row.last_run_id);
    const turns = await turnRows("bw_job1");
    expect(turns.map((t) => [t.source_ref, t.speaker_idx, t.role, t.clinician_id])).toEqual([
      ["bw_job1|a", 0, "clinician", "doc_n1"],
      ["bw_job1|b", 1, null, null],
      ["bw_job1|c", 0, "clinician", "doc_n1"],
    ]);
    expect(turns[1]!.no_role_reason).toBe("no_match");
    expect(new Set(turns.map((t) => t.run_id))).toEqual(new Set([row.last_run_id]));
    expect(H.fetch, "no external call but the (mocked) embed seam").not.toHaveBeenCalled();
  });

  it("an `empty` answer records no_speakers, and says it was Nemotron that found it empty", async () => {
    seedWindow("bw_job2");
    await post(body("bw_job2", "rd_n1", { status: "empty", turns: [] }));
    const out = await runJob("bw_job2");
    expect(out).toMatchObject({ kind: "done", result: { skipped: "nemotron_empty", speakers: 0 } });
    const row = (await diarizeRow("bw_job2"))!;
    expect(row).toMatchObject({ state: "no_speakers", speakers_json: [], segments_json: [] });
    expect(row.timing_json!.engine).toMatchObject({ name: "nemotron", skipped: "nemotron_empty", attribution: "none" });
    expect(H.getBytes, "an empty window never fetches the clip").not.toHaveBeenCalled();
    expect(H.embed).not.toHaveBeenCalled();
  });

  it("an embed failure is recorded as embed_error, never as 'nobody matched'", async () => {
    seedWindow("bw_job3");
    await post(body("bw_job3", "rd_n1"));
    H.embed.mockImplementation(async () => ({ ok: false, error: "embed_failed", retryable: true }));
    expect((await runJob("bw_job3")).kind).toBe("done");
    const row = (await diarizeRow("bw_job3"))!;
    expect(row.timing_json!.engine).toMatchObject({ attribution: "none", embed_error: "embed_failed" });
    expect((await turnRows("bw_job3")).every((t) => t.role === null)).toBe(true);
  });

  it("a pyannote-era ok row is HISTORY: the job writes nothing, so its run ids and turns are untouched", async () => {
    seedWindow("bw_old1", { oldRow: true });
    pg.exec(`INSERT INTO diarize_nemotron_window (window_id, room_day_id, model, model_rev, config, config_hash, worker_id, machine, audio_ms, turns_json, speaker_count, turn_count, speech_ms, overlap_ms, payload_sha256, status)
             VALUES ('bw_old1', 'rd_n1', 'm', 'rev1', '{}', 'h', 'w', 'box', 900000, '[[0,1000,"spk0"]]', 1, 1, 1000, 0, 'p', 'ok')`);
    const before = await diarizeRow("bw_old1");
    const out = await runJob("bw_old1");
    expect(out).toMatchObject({ kind: "done", result: { skipped: "already_diarized", state: "ok" } });
    expect(await diarizeRow("bw_old1")).toEqual(before);
    expect(await turnRows("bw_old1")).toEqual([]);
    expect(H.getBytes).not.toHaveBeenCalled();
    // and the ingest does not queue it either
    expect(await (await post(body("bw_old1", "rd_n1", { model_rev: "rev2" }))).json()).toMatchObject({ result: "stored", job: "none" });
    expect(await jobCount("bw_old1")).toBe(0);
  });

  it("a missing clip fails the step by name and records the failed row", async () => {
    seedWindow("bw_job4");
    await post(body("bw_job4", "rd_n1"));
    H.getBytes.mockResolvedValueOnce(null);
    const out = await runJob("bw_job4");
    expect(out.kind).toBe("fail");
    expect(out.error).toMatch(/clip_missing_in_r2/);
    expect((await diarizeRow("bw_job4"))!.state).toBe("failed");
  });

  it("a re-run on THIS engine's own row follows the unchanged keep-rule: content kept, run id moves, nothing fails", async () => {
    seedWindow("bw_job5");
    await post(body("bw_job5", "rd_n1"));
    expect((await runJob("bw_job5")).kind).toBe("done");
    const first = (await diarizeRow("bw_job5"))!;
    expect((await runJob("bw_job5")).kind).toBe("done");
    const second = (await diarizeRow("bw_job5"))!;
    expect(second.segments_json, "an ok row keeps its content (recordDiarizeWindow's rule, unchanged)").toEqual(first.segments_json);
    expect(second.segments_run_id).toBe(first.segments_run_id);
    expect(second.last_run_id, "last_run_id moves on every run that wrote turns").not.toBe(first.last_run_id);
  });
});

describe.runIf(HAVE)("local and pyannoteai are REFUSED, with zero external calls", () => {
  for (const engine of ["local", "pyannoteai", "LOCAL "]) {
    it(`DIARIZE_ENGINE=${JSON.stringify(engine)} → diarize_engine_refused, no clip / embed / fetch / room write`, async () => {
      seedWindow(`bw_ref_${engine.trim()}`);
      await post(body(`bw_ref_${engine.trim()}`, "rd_n1"));
      process.env.DIARIZE_ENGINE = engine;
      const before = await roomTables();
      const out = await runJob(`bw_ref_${engine.trim()}`);
      expect(out.kind).toBe("fail");
      expect(out.error).toMatch(/diarize_engine_refused/);
      expect(out.error).toMatch(/pyannote is retired/);
      expect(H.getBytes).not.toHaveBeenCalled();
      expect(H.embed).not.toHaveBeenCalled();
      expect(H.fetch).not.toHaveBeenCalled();
      expect(await roomTables()).toEqual(before);
    });
  }
  it("a typo fails the step by name too, and the unset default is nemotron", async () => {
    seedWindow("bw_ref_typo");
    await post(body("bw_ref_typo", "rd_n1"));
    process.env.DIARIZE_ENGINE = "nemotron-3";
    const typo = await runJob("bw_ref_typo");
    expect(typo).toMatchObject({ kind: "fail" });
    expect(typo.error).toMatch(/diarize_engine_refused.*unrecognised value/);
    expect(H.getBytes).not.toHaveBeenCalled();
    delete process.env.DIARIZE_ENGINE;
    expect((await runJob("bw_ref_typo")).kind).toBe("done");
  });
});

describe.runIf(HAVE)("the readers see what the nemotron path wrote", () => {
  it("emotion enqueue picks the window; the emotion job runs it and does NOT report diarize_stale (run ids line up)", async () => {
    seedWindow("bw_rd1");
    await post(body("bw_rd1", "rd_n1"));
    await runJob("bw_rd1");
    // the chooser takes ONE window per tick, oldest first: hide the other test windows from it so this one is the candidate
    pg.exec(`UPDATE room_diarize_window SET last_run_id = NULL WHERE window_id <> 'bw_rd1'`);
    const picked = await enqueueEmotionWindows({ actor: "test" });
    expect(picked.enqueued.map((e) => e.window_id)).toContain("bw_rd1");
    let step: string = emotionWindowKind.first;
    let progress: Record<string, unknown> = {};
    let last: { kind: string; step?: string; progress?: Record<string, unknown>; error?: string } = { kind: "next" };
    for (let i = 0; i < 12 && last.kind === "next"; i += 1) {
      last = (await emotionWindowKind.run({ step, args: { window_id: "bw_rd1" }, progress, job: {} as never } as never)) as typeof last;
      if (last.kind === "next") { step = last.step!; progress = last.progress!; }
    }
    expect(last.kind, last.error).toBe("done");
    const e = await q<{ state: string }>`SELECT state FROM room_emotion_window WHERE window_id = 'bw_rd1'`;
    expect(e[0]!.state).toBe("ok");
    expect((await q<{ n: number }>`SELECT count(*)::int AS n FROM room_span_emotion WHERE window_id = 'bw_rd1' AND state = 'scored'`)[0]!.n).toBeGreaterThan(0);
  });

  it("talk-time reads the rows: the matched clinician's turns are the doctor's, the other speaker's are 'other'", async () => {
    seedWindow("bw_rd2");
    await post(body("bw_rd2", "rd_n1"));
    await runJob("bw_rd2");
    const r = await readWindowTurns("bw_rd2");
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.data).toMatchObject({ diarize_state: "ok", attributed: 3 });
    const res = evaluateTalkTime(r.data.turns.map((t) => ({ ...t, speaker_idx: t.speaker_idx, role: t.role })) as never, { start_ms: r.data.start_ms, end_ms: r.data.end_ms });
    expect(res.status).toBe("ok");
    expect(res.findings).not.toContain("no_doctor_identified");
    expect(res.score).toMatchObject({ doctor_turns: 2, other_turns: 1, unattributed_turns: 0, speakers: 2 });
  });

  it("jev-role reads the rows: a window with a matched speaker gets the acoustic role for that speaker", async () => {
    seedWindow("bw_rd3");
    await post(body("bw_rd3", "rd_n1"));
    await runJob("bw_rd3");
    pg.exec(`INSERT INTO jev_window_text (window_id, room_day_id, english, source, char_count) VALUES ('bw_rd3', 'rd_n1', 'placeholder', 'native_en', 11)`);
    H.askJev.mockImplementation(async () => ({
      model: "m", latencyMs: 1, usage: { input_tokens: 1, output_tokens: 1 }, persisted: { ok: true, written: 0 },
      results: Object.fromEntries(["S0", "S1"].map((s) => [roleQid(s), { answer: { type: "choice", choice: "patient", probabilities: { patient: 0.9 }, confidence: 0.9 } }])),
    }));
    // only this window: rd_n1 holds others, but jev-role is idempotent per (window, speaker, prompt) and force re-runs them all
    const out = (await jevRoleKind.run({ step: "run", args: { room_day_id: "rd_n1", force: true, prompt_version: "role-v1" }, progress: {}, job: {} as never } as never)) as { kind: string; result?: Record<string, unknown>; error?: string };
    expect(out.kind, out.error).toBe("done");
    const sig = await q<{ speaker_idx: number; role: string }>`SELECT speaker_idx, role FROM jev_role_signal WHERE window_id = 'bw_rd3' ORDER BY speaker_idx`;
    expect(sig.map((s) => [s.speaker_idx, s.role])).toEqual([[0, "clinician"], [1, "patient"]]);
  });
});

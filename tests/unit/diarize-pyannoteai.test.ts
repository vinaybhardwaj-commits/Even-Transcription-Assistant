/**
 * The pyannote.ai diarization switch (23 Sep 2026).
 *
 * What is actually at risk here, and therefore what this file spends its length on:
 *
 *  1. THE KEY and THE PRESIGNED URL. Both are bearer credentials — one for the account, one for a
 *     patient recording — and the cheapest way to lose either is a log line or a query string. The
 *     tests drive every path INCLUDING the failures (a failure is where a URL usually leaks into
 *     an error string) and then assert neither value appears in anything logged or in any URL.
 *  2. THE STRICT PARSER, in BOTH directions. That `pyannoteai` enables is the easy half. That a
 *     typo THROWS instead of quietly reading as `local` is the half that costs a clinical decision
 *     made on the engine nobody chose.
 *  3. THE MODEL LABEL IS DERIVED. The fake server answers with a model that is deliberately NOT
 *     the one this build asks for, so a constant — even the right-looking constant — fails.
 *  4. A FALLBACK SAYS SO. A window the local diarizer produced after pyannote.ai declined must not
 *     be indistinguishable from one pyannote.ai produced.
 *  5. LOCAL IS UNTOUCHED. The default path does not presign, does not submit, and makes no call to
 *     anything hosted.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// ── mocks ────────────────────────────────────────────────────────────────────────────────────
const sqlCalls: Array<{ text: string; values: unknown[] }> = [];
let turnsRow: Array<Record<string, unknown>> = [];
let windowRow: Array<Record<string, unknown>> = [];

vi.mock("@/lib/db", () => ({
  sql: (strings: TemplateStringsArray, ...values: unknown[]) => {
    const text = strings.join("?").replace(/\s+/g, " ").trim();
    sqlCalls.push({ text, values });
    if (/FROM bench_window/.test(text)) return Promise.resolve(windowRow);
    if (/FROM cue/.test(text)) return Promise.resolve(turnsRow);
    if (/FROM voice_print/.test(text)) return Promise.resolve([]);
    return Promise.resolve([]);
  },
}));

const r2 = { bytes: new Uint8Array([1, 2, 3]) as Uint8Array | null, signed: "https://r2.example/clip.webm?X-Amz-Signature=SIGNATURE_SECRET", signThrows: false };
vi.mock("@/lib/r2", () => ({
  getObjectBytes: async () => r2.bytes,
  headObject: async () => ({ size: 3, content_type: "audio/webm" }),
  signGetUrl: async (o: { key: string; expiresInSeconds?: number }) => {
    signCalls.push(o);
    if (r2.signThrows) throw new Error("boom");
    return r2.signed;
  },
}));
const signCalls: Array<{ key: string; expiresInSeconds?: number }> = [];

const vad = { calls: 0 };
vi.mock("@/lib/stt/speech-gate", async (orig) => {
  const real = await orig<typeof import("@/lib/stt/speech-gate")>();
  return { ...real, fetchWindowSpeech: async () => { vad.calls += 1; return { ok: true as const, spans: [{ start_ms: 0, end_ms: 60_000 }] }; } };
});

const localDiarize = { calls: 0, ok: true as boolean };
const localDiarizeOverride: { result: Record<string, unknown> | null } = { result: null };
vi.mock("@/lib/diarize", () => ({
  runDiarize: async () => {
    localDiarize.calls += 1;
    if (!localDiarize.ok) return { ok: false, error: "http_500: local said no", retryable: false, latencyMs: 5, timing: { wall_ms: 5 } };
    return {
      ok: true,
      latencyMs: 12,
      timing: { wall_ms: 12 },
      result: localDiarizeOverride.result ?? {
        speakers: [{ idx: 0, label: "Speaker 1", type: "other" }],
        transcript_segments: [{ start_ms: 0, end_ms: 4_000, speaker_idx: 0 }],
        overlap_windows: [],
        aggregates: {},
        model_versions: { diarization: "mini-pyannote-3.1" },
      },
    };
  },
}));

// ── the fake pyannote.ai ─────────────────────────────────────────────────────────────────────
const KEY = "pyaai-secret-key-do-not-log-8f3a91";
const BASE = "https://fake-pyannote.test";

type FetchCall = { url: string; method: string; headers: Record<string, string>; body: string | null };
const fetchCalls: FetchCall[] = [];
const server = {
  submitStatus: 200,
  submitBody: { jobId: "job-abc-123", status: "created" } as unknown,
  /** Successive answers to GET /v1/jobs/{id}. The last one repeats. */
  jobAnswers: [] as unknown[],
  jobStatus: 200,
  /** What GET /v2/jobs reports. The model here is NOT what this build asks for, on purpose. */
  records: [{ id: "job-abc-123", status: "succeeded", type: "diarize", model: "precision-4-fake" }] as unknown[],
  recordsStatus: 200,
};

const logs: string[] = [];
const captureLogs = () => {
  for (const m of ["log", "warn", "error"] as const) {
    vi.spyOn(console, m).mockImplementation((...a: unknown[]) => {
      logs.push(a.map((x) => (typeof x === "string" ? x : JSON.stringify(x))).join(" "));
    });
  }
};

const okJob = (n = 1) => ({
  jobId: "job-abc-123",
  status: "succeeded",
  createdAt: "2026-09-23T10:00:00.000Z",
  updatedAt: "2026-09-23T10:00:05.000Z",
  output: { diarization: n === 2
    ? [{ start: 0.5, end: 2.25, speaker: "SPEAKER_01" }, { start: 2.5, end: 9.75, speaker: "SPEAKER_00" }]
    : [{ start: 1.0, end: 4.5, speaker: "SPEAKER_00" }] },
});

beforeEach(() => {
  sqlCalls.length = 0; fetchCalls.length = 0; signCalls.length = 0; logs.length = 0;
  turnsRow = []; localDiarize.calls = 0; localDiarize.ok = true; localDiarizeOverride.result = null; vad.calls = 0;
  r2.bytes = new Uint8Array([1, 2, 3]); r2.signThrows = false;
  windowRow = [{ id: "w1", room_day_id: "rd1", start_ms: 0, end_ms: 900_000, clip_r2_key: "clips/w1.webm" }];
  server.submitStatus = 200; server.submitBody = { jobId: "job-abc-123", status: "created" };
  server.jobAnswers = [okJob()]; server.jobStatus = 200;
  server.records = [{ id: "job-abc-123", status: "succeeded", type: "diarize", model: "precision-4-fake" }];
  server.recordsStatus = 200;
  process.env.PYANNOTEAI_API_KEY = KEY;
  // A test must not sit through the shipped poll cadence; the values themselves are pinned below.
  process.env.DIARIZE_POLL_INTERVAL_MS = "1";
  process.env.DIARIZE_POLL_BUDGET_MS = "40";
  process.env.PYANNOTEAI_BASE_URL = BASE;
  delete (process.env as Record<string, string | undefined>).DIARIZE_ENGINE;
  delete (process.env as Record<string, string | undefined>).DIARIZE_SPEECH_GATE;

  vi.stubGlobal("fetch", async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    const headers = Object.fromEntries(Object.entries((init?.headers ?? {}) as Record<string, string>));
    fetchCalls.push({ url, method: init?.method ?? "GET", headers, body: typeof init?.body === "string" ? init.body : null });
    const reply = (status: number, body: unknown) =>
      ({ ok: status >= 200 && status < 300, status, text: async () => JSON.stringify(body) }) as unknown as Response;
    if (url.includes("/v1/diarize")) return reply(server.submitStatus, server.submitBody);
    if (url.includes("/v2/jobs")) return reply(server.recordsStatus, { items: server.records, nextCursor: null });
    if (url.includes("/v1/jobs/")) {
      const a = server.jobAnswers.length > 1 ? server.jobAnswers.shift() : server.jobAnswers[0];
      return reply(server.jobStatus, a);
    }
    throw new Error(`unexpected fetch ${url}`);
  });
  captureLogs();
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  delete (process.env as Record<string, string | undefined>).DIARIZE_ENGINE;
  delete (process.env as Record<string, string | undefined>).PYANNOTEAI_API_KEY;
  delete (process.env as Record<string, string | undefined>).PYANNOTEAI_BASE_URL;
  delete (process.env as Record<string, string | undefined>).DIARIZE_POLL_INTERVAL_MS;
  delete (process.env as Record<string, string | undefined>).DIARIZE_POLL_BUDGET_MS;
});

const runStep = async (step: string, progress: Record<string, unknown> = {}) => {
  const { diarizeWindowKind } = await import("@/lib/jobs/kinds/diarize-window");
  return diarizeWindowKind.run({
    job: {} as never,
    step,
    args: { window_id: "w1" },
    progress,
  });
};

// ── 1. the strict parser, both halves ────────────────────────────────────────────────────────
describe("DIARIZE_ENGINE — the parser refuses to guess", () => {
  it("unset, empty and 'local' all mean the engine production already had", async () => {
    const { diarizeEngine } = await import("@/lib/diarize-engine");
    expect(diarizeEngine({})).toBe("local");
    expect(diarizeEngine({ DIARIZE_ENGINE: "" })).toBe("local");
    expect(diarizeEngine({ DIARIZE_ENGINE: "   " })).toBe("local");
    expect(diarizeEngine({ DIARIZE_ENGINE: "local" })).toBe("local");
  });

  it("'pyannoteai' selects it, trimmed and case-insensitively", async () => {
    const { diarizeEngine } = await import("@/lib/diarize-engine");
    for (const v of ["pyannoteai", "PyannoteAI", " pyannoteai ", "PYANNOTEAI\n"]) {
      expect(diarizeEngine({ DIARIZE_ENGINE: v }), `value ${JSON.stringify(v)}`).toBe("pyannoteai");
    }
  });

  it("A TYPO THROWS — it never reads as local", async () => {
    const { diarizeEngine, DiarizeEngineError } = await import("@/lib/diarize-engine");
    // Every one of these is a plausible mistake, and every one of them silently selecting the
    // local engine is the failure this switch cannot survive: an operator who believes the
    // clinical output came from the engine V chose, when it did not.
    for (const v of ["pyannote", "pyannote-ai", "pyannote.ai", "pyannoteAI!", "hosted", "remote", "mini", "yes", "1", "true", "0", "off"]) {
      expect(() => diarizeEngine({ DIARIZE_ENGINE: v }), `value ${JSON.stringify(v)}`).toThrow(DiarizeEngineError);
    }
  });

  it("the refusal names the length, never the value — an env value is not echoed", async () => {
    const { diarizeEngine } = await import("@/lib/diarize-engine");
    const secretish = "pyannote-ai-oops";
    let msg = "";
    try { diarizeEngine({ DIARIZE_ENGINE: secretish }); } catch (e) { msg = String(e); }
    expect(msg).not.toContain(secretish);
    expect(msg).toContain(`length ${secretish.length}`);
  });

  it("the job kind uses this parser, so a typo fails the step rather than diarizing locally", async () => {
    process.env.DIARIZE_ENGINE = "pyannote";
    await expect(runStep("diarize")).rejects.toThrow();
    expect(localDiarize.calls).toBe(0);
    expect(fetchCalls).toHaveLength(0);
  });
});

// ── 2. mapping into the shape the local service already returns ───────────────────────────────
describe("mapSegments — pyannote.ai spans become the local service's shape", () => {
  it("seconds become milliseconds and labels become indices by FIRST APPEARANCE", async () => {
    const { mapSegments } = await import("@/lib/diarize-pyannoteai");
    const { segments, speakerLabels } = mapSegments([
      { start: 2.5, end: 9.75, speaker: "SPEAKER_00" },
      { start: 0.5, end: 2.25, speaker: "SPEAKER_01" },
    ]);
    // SPEAKER_01 spoke first, so it is index 0 — the digits in the label decide nothing.
    expect(segments).toEqual([
      { start_ms: 500, end_ms: 2_250, speaker_idx: 0 },
      { start_ms: 2_500, end_ms: 9_750, speaker_idx: 1 },
    ]);
    expect(speakerLabels).toEqual(["SPEAKER_01", "SPEAKER_00"]);
  });

  it("the index does NOT come from the digits in the provider's label", async () => {
    const { mapSegments } = await import("@/lib/diarize-pyannoteai");
    const { segments } = mapSegments([{ start: 0, end: 1, speaker: "SPEAKER_07" }]);
    expect(segments[0]!.speaker_idx).toBe(0);
  });

  it("unreadable spans are dropped one at a time, like the local parser", async () => {
    const { mapSegments } = await import("@/lib/diarize-pyannoteai");
    const { segments } = mapSegments([
      null, "x", {}, { start: 1 }, { start: "a", end: 2, speaker: "S" },
      { start: 5, end: 5, speaker: "S" },      // zero length
      { start: 5, end: 4, speaker: "S" },      // ends before it starts
      { start: -1, end: 2, speaker: "S" },     // before the clip
      { start: 1, end: 2, speaker: "" },       // no label
      { start: 1, end: 2, speaker: "S" },      // the only good one
    ]);
    expect(segments).toEqual([{ start_ms: 1_000, end_ms: 2_000, speaker_idx: 0 }]);
  });

  it("a span that rounds to zero length is dropped, so end_ms > start_ms always holds", async () => {
    const { mapSegments } = await import("@/lib/diarize-pyannoteai");
    const { segments } = mapSegments([{ start: 1.00001, end: 1.00002, speaker: "S" }]);
    expect(segments).toEqual([]);
  });

  it("speaker rows carry no identity, because pyannote.ai returns none", async () => {
    const { speakersFromLabels } = await import("@/lib/stt/diarize-window");
    const sp = speakersFromLabels(["SPEAKER_00"], [{ start_ms: 1_000, end_ms: 4_500, speaker_idx: 0 }]);
    expect(sp).toHaveLength(1);
    expect(sp[0]!.clinician_id).toBeUndefined();
    expect(sp[0]!.confidence).toBeUndefined();
    expect(sp[0]!.embedding_base64).toBeUndefined();
    expect(sp[0]!.total_speech_sec).toBe(3.5);
    // "other" would be a guess spelled as an answer; this engine made no guess.
    expect(sp[0]!.type).toBe("unknown");
  });

  it("and so every turn is UNATTRIBUTED — no_match because nothing tried", async () => {
    const { speakersFromLabels } = await import("@/lib/stt/diarize-window");
    const { rolesByIndex } = await import("@/lib/stt/speaker-roles");
    const roles = rolesByIndex(speakersFromLabels(["SPEAKER_00"], [{ start_ms: 0, end_ms: 1_000, speaker_idx: 0 }]));
    expect(roles.get(0)).toMatchObject({ role: null, clinician_id: null, no_role_reason: "no_match" });
  });
});

// ── 3. the flow, end to end, against the fake server ─────────────────────────────────────────
describe("the pyannote.ai path", () => {
  beforeEach(() => { process.env.DIARIZE_ENGINE = "pyannoteai"; });

  it("submits with a presigned R2 URL and hands the job id to a poll step", async () => {
    const out = await runStep("diarize");
    expect(out.kind).toBe("next");
    if (out.kind !== "next") throw new Error("unreachable");
    expect(out.step).toBe("pyannote_poll");
    expect(out.progress.pyannoteai_job_id).toBe("job-abc-123");
    expect(out.progress.engine).toBe("pyannoteai");
    expect(out.progress.run_id).toBeTruthy();
    expect(out.progress.audio_seconds_sent).toBe(900);

    const submit = fetchCalls.find((c) => c.url.includes("/v1/diarize"))!;
    expect(submit.method).toBe("POST");
    expect(JSON.parse(submit.body!).url).toBe(r2.signed);
    // ONE object, and minutes not hours.
    expect(signCalls).toEqual([{ key: "clips/w1.webm", expiresInSeconds: 900 }]);
    expect(localDiarize.calls).toBe(0);
  });

  it("the presigned URL points at R2 — never at the Mini tunnel", async () => {
    await runStep("diarize");
    const submit = fetchCalls.find((c) => c.url.includes("/v1/diarize"))!;
    const handed = String(JSON.parse(submit.body!).url);
    expect(handed).toMatch(/^https:\/\/r2\./);
    expect(handed).not.toMatch(/llmvinayminihome|diarize\./);
  });

  it("a finished job is stored in the SAME columns the local diarizer writes", async () => {
    turnsRow = [{ source_ref: "t1", start_ms: 1_200, end_ms: 3_000 }];
    const out = await runStep("pyannote_poll", { pyannoteai_job_id: "job-abc-123", run_id: "run-1", window_id: "w1", engine: "pyannoteai", audio_seconds_sent: 900 });
    expect(out.kind).toBe("done");

    const insert = sqlCalls.find((c) => /INSERT INTO room_diarize_window/.test(c.text));
    expect(insert, "the window row is written by the same writer").toBeTruthy();
    const turn = sqlCalls.find((c) => /INSERT INTO room_turn_speaker/.test(c.text));
    expect(turn, "turns are bound and written by the same path").toBeTruthy();

    const stored = JSON.parse(String(insert!.values.find((v) => typeof v === "string" && v.includes("\"engine\""))));
    expect(stored.engine).toMatchObject({ name: "pyannoteai", attribution: "none", job_id: "job-abc-123", fallback_from: null });
  });

  it("segment times are on the day clock, offset by the window start", async () => {
    windowRow = [{ id: "w1", room_day_id: "rd1", start_ms: 600_000, end_ms: 1_500_000, clip_r2_key: "clips/w1.webm" }];
    turnsRow = [{ source_ref: "t1", start_ms: 601_500, end_ms: 604_000 }];
    await runStep("pyannote_poll", { pyannoteai_job_id: "job-abc-123", run_id: "run-1", window_id: "w1", engine: "pyannoteai" });
    // The clip-relative span 1.0-4.5 s must have bound the turn at 601 500 ms, which can only
    // happen if the window start was added exactly once.
    const turn = sqlCalls.find((c) => /INSERT INTO room_turn_speaker/.test(c.text));
    expect(turn!.values).toContain("t1");
  });

  it("polls until the job finishes rather than deciding early", async () => {
    server.jobAnswers = [{ jobId: "job-abc-123", status: "running" }, { jobId: "job-abc-123", status: "running" }, okJob()];
    const out = await runStep("pyannote_poll", { pyannoteai_job_id: "job-abc-123", run_id: "run-1", window_id: "w1", engine: "pyannoteai" });
    expect(out.kind).toBe("done");
    expect(fetchCalls.filter((c) => c.url.includes("/v1/jobs/"))).toHaveLength(3);
  });

  it("a state this build has never seen is PENDING, not finished", async () => {
    const { pollDiarize } = await import("@/lib/diarize-pyannoteai");
    server.jobAnswers = [{ jobId: "j", status: "some_future_state" }];
    await expect(pollDiarize("j")).resolves.toEqual({ ok: true, state: "pending" });
  });
});

// ── 4. the model label is DERIVED ────────────────────────────────────────────────────────────
describe("the engine label comes from the answer, never from what we asked for", () => {
  beforeEach(() => { process.env.DIARIZE_ENGINE = "pyannoteai"; });

  it("the stored model is the one the job RECORD reports", async () => {
    // The fake reports precision-4-fake; this build asks for precision-3. A constant fails here.
    const { PYANNOTEAI_MODEL_DEFAULT } = await import("@/lib/diarize-pyannoteai");
    expect(PYANNOTEAI_MODEL_DEFAULT).toBe("precision-3");
    await runStep("pyannote_poll", { pyannoteai_job_id: "job-abc-123", run_id: "r", window_id: "w1", engine: "pyannoteai" });
    const insert = sqlCalls.find((c) => /INSERT INTO room_diarize_window/.test(c.text))!;
    const stored = JSON.parse(String(insert.values.find((v) => typeof v === "string" && v.includes("\"engine\""))));
    expect(stored.engine.model).toBe("precision-4-fake");
    expect(stored.engine.model).not.toBe(PYANNOTEAI_MODEL_DEFAULT);
  });

  it("a record without a model stores NULL — never a plausible default", async () => {
    server.records = [{ id: "job-abc-123", status: "succeeded", type: "diarize" }];
    await runStep("pyannote_poll", { pyannoteai_job_id: "job-abc-123", run_id: "r", window_id: "w1", engine: "pyannoteai" });
    const insert = sqlCalls.find((c) => /INSERT INTO room_diarize_window/.test(c.text))!;
    const stored = JSON.parse(String(insert.values.find((v) => typeof v === "string" && v.includes("\"engine\""))));
    expect(stored.engine.model).toBeNull();
  });

  it("a record that cannot be found stores NULL, and the window is still stored", async () => {
    server.records = [];
    const out = await runStep("pyannote_poll", { pyannoteai_job_id: "job-abc-123", run_id: "r", window_id: "w1", engine: "pyannoteai" });
    expect(out.kind).toBe("done");
    const insert = sqlCalls.find((c) => /INSERT INTO room_diarize_window/.test(c.text))!;
    const stored = JSON.parse(String(insert.values.find((v) => typeof v === "string" && v.includes("\"engine\""))));
    expect(stored.engine.model).toBeNull();
  });

  it("a lookup that fails does not fail the window", async () => {
    server.recordsStatus = 500;
    const out = await runStep("pyannote_poll", { pyannoteai_job_id: "job-abc-123", run_id: "r", window_id: "w1", engine: "pyannoteai" });
    expect(out.kind).toBe("done");
  });

  it("the local engine's label is derived too, from its own model_versions", async () => {
    const { localModelLabel } = await import("@/lib/stt/diarize-window");
    expect(localModelLabel({ diarization: "mini-pyannote-3.1" })).toBe("mini-pyannote-3.1");
    expect(localModelLabel(undefined)).toBeNull();
    expect(localModelLabel({})).toBeNull();
  });
});

// ── 5. the fallback, and that it says so ─────────────────────────────────────────────────────
describe("fallback to the local diarizer", () => {
  beforeEach(() => { process.env.DIARIZE_ENGINE = "pyannoteai"; });

  it("a refused submit falls back, and the row names the engine it fell back from", async () => {
    server.submitStatus = 401;
    server.submitBody = { message: "unauthorized" };
    const out = await runStep("diarize");
    expect(out.kind).toBe("done");
    expect(localDiarize.calls).toBe(1);
    const insert = sqlCalls.find((c) => /INSERT INTO room_diarize_window/.test(c.text))!;
    const stored = JSON.parse(String(insert.values.find((v) => typeof v === "string" && v.includes("\"engine\""))));
    expect(stored.engine).toMatchObject({
      name: "local",
      fallback_from: "pyannoteai",
      fallback_reason: "pyannoteai_submit_failed",
      // The window WAS attributed, because the local service does that — the fallback is not a
      // downgrade of identity, and the row must not imply it was.
      attribution: "voiceprint",
    });
  });

  it("a failed pyannote.ai job falls back from the POLL step", async () => {
    server.jobAnswers = [{ jobId: "job-abc-123", status: "failed" }];
    const out = await runStep("pyannote_poll", { pyannoteai_job_id: "job-abc-123", run_id: "r", window_id: "w1", engine: "pyannoteai" });
    expect(out.kind).toBe("done");
    expect(localDiarize.calls).toBe(1);
    if (out.kind !== "done") throw new Error("unreachable");
    expect(out.result).toMatchObject({ engine: "local", fell_back_from: "pyannoteai", fallback_reason: "pyannoteai_job_failed", fallbacks: 1 });
  });

  it("a succeeded job with no spans falls back rather than storing an empty window", async () => {
    server.jobAnswers = [{ jobId: "job-abc-123", status: "succeeded", output: { diarization: [] } }];
    const out = await runStep("pyannote_poll", { pyannoteai_job_id: "job-abc-123", run_id: "r", window_id: "w1", engine: "pyannoteai" });
    expect(out.kind).toBe("done");
    expect(localDiarize.calls).toBe(1);
    if (out.kind !== "done") throw new Error("unreachable");
    expect(out.result).toMatchObject({ fallback_reason: "pyannoteai_no_segments" });
  });

  it("a 200 with no jobId is a bad response, not a job — it falls back and never polls", async () => {
    server.submitBody = { status: "created" };     // accepted, but nothing to poll
    const out = await runStep("diarize");
    expect(out.kind).toBe("done");
    expect(localDiarize.calls).toBe(1);
    if (out.kind !== "done") throw new Error("unreachable");
    expect(out.result).toMatchObject({ fallback_reason: "pyannoteai_bad_response" });
    expect(fetchCalls.filter((c) => c.url.includes("/v1/jobs/"))).toHaveLength(0);
  });

  it("a fallback from the POLL step re-asks the VAD — it does not inherit an absent answer", async () => {
    // The VAD answer is not carried across a step boundary. With the gate on, handing the local
    // diarizer an absent answer would mark every segment unjudged, so this window would differ
    // from the same window had it gone local from the start. A fallback must not be a demotion.
    process.env.DIARIZE_SPEECH_GATE = "1";
    server.jobAnswers = [{ jobId: "job-abc-123", status: "failed" }];
    const out = await runStep("pyannote_poll", { pyannoteai_job_id: "job-abc-123", run_id: "r", window_id: "w1", engine: "pyannoteai" });
    expect(out.kind).toBe("done");
    expect(localDiarize.calls).toBe(1);
    expect(vad.calls).toBe(1);
    delete (process.env as Record<string, string | undefined>).DIARIZE_SPEECH_GATE;
  });

  it("with the gate OFF the fallback asks no VAD at all — off stays a true no-op", async () => {
    // DIARIZE_SPEECH_GATE is unset here. "Off, no VAD is called, nothing is paid for" is the
    // invariant lib/jobs/kinds/diarize-window.ts states, and the fallback path must not be the
    // one place it stops holding.
    server.jobAnswers = [{ jobId: "job-abc-123", status: "failed" }];
    await runStep("pyannote_poll", { pyannoteai_job_id: "job-abc-123", run_id: "r", window_id: "w1", engine: "pyannoteai" });
    expect(localDiarize.calls).toBe(1);
    expect(vad.calls).toBe(0);
  });

  it("an in-step fallback re-uses the answer it already has rather than asking twice", async () => {
    process.env.DIARIZE_SPEECH_GATE = "1";
    server.submitStatus = 500;
    await runStep("diarize");
    expect(localDiarize.calls).toBe(1);
    expect(vad.calls).toBe(1);
    delete (process.env as Record<string, string | undefined>).DIARIZE_SPEECH_GATE;
  });

  it("a presign that throws falls back instead of failing the window", async () => {
    r2.signThrows = true;
    const out = await runStep("diarize");
    expect(out.kind).toBe("done");
    expect(localDiarize.calls).toBe(1);
    expect(fetchCalls.filter((c) => c.url.includes("/v1/diarize"))).toHaveLength(0);
  });

  it("a fallback counts in the job result, so fallbacks are countable per run", async () => {
    server.submitStatus = 500;
    const out = await runStep("diarize");
    if (out.kind !== "done") throw new Error("unreachable");
    expect(out.result.fallbacks).toBe(1);
  });

  it("a retryable poll hands the row back to the queue rather than burning the paid job", async () => {
    server.jobStatus = 503;
    const out = await runStep("pyannote_poll", { pyannoteai_job_id: "job-abc-123", run_id: "r", window_id: "w1", engine: "pyannoteai" });
    expect(out.kind).toBe("next");
    expect(localDiarize.calls).toBe(0);
  });
});

// ── 6. the poll step is bound to the engine that made the submission ─────────────────────────
describe("a rollback mid-flight does not strand a paid job", () => {
  it("the poll step finishes a pyannote.ai job even with DIARIZE_ENGINE back to local", async () => {
    delete (process.env as Record<string, string | undefined>).DIARIZE_ENGINE;
    const out = await runStep("pyannote_poll", { pyannoteai_job_id: "job-abc-123", run_id: "r", window_id: "w1", engine: "pyannoteai" });
    expect(out.kind).toBe("done");
    // It polled the job it had; it did not silently start a local diarization instead.
    expect(fetchCalls.some((c) => c.url.includes("/v1/jobs/job-abc-123"))).toBe(true);
    expect(localDiarize.calls).toBe(0);
  });

  it("a poll step with no job id in progress fails rather than guessing", async () => {
    const out = await runStep("pyannote_poll", { window_id: "w1" });
    expect(out.kind).toBe("fail");
    expect(localDiarize.calls).toBe(0);
  });
});

describe("the shipped poll cadence", () => {
  it("is 150 s of budget at 3 s intervals, both well under one step and one lease", async () => {
    const k = await import("@/lib/jobs/kinds/diarize-window");
    const { MAX_STEP_MS, LEASE_MS } = await import("@/lib/jobs/types");
    expect(k.POLL_BUDGET_MS).toBe(150_000);
    expect(k.POLL_INTERVAL_MS).toBe(3_000);
    expect(k.POLL_BUDGET_MS).toBeLessThan(MAX_STEP_MS);
    expect(k.POLL_BUDGET_MS).toBeLessThan(LEASE_MS);
  });
});

// ── 7. the cost guard ────────────────────────────────────────────────────────────────────────
describe("the cost guard skips only on a REAL answer of silence", () => {
  it("a VAD answer below the speech floor skips the paid call and says it was skipped", async () => {
    const { vadSaysSilent } = await import("@/lib/jobs/kinds/diarize-window");
    const { DEFAULT_MIN_SPEECH_MS } = await import("@/lib/stt/speech-gate");
    // Derived through the INVERSE of the rule: one span one millisecond short of the floor.
    expect(vadSaysSilent({ ok: true, spans: [{ start_ms: 0, end_ms: DEFAULT_MIN_SPEECH_MS - 1 }] })).toBe(true);
    expect(vadSaysSilent({ ok: true, spans: [] })).toBe(true);
  });

  it("a window AT the floor is not silent — the threshold is exclusive", async () => {
    const { vadSaysSilent } = await import("@/lib/jobs/kinds/diarize-window");
    const { DEFAULT_MIN_SPEECH_MS } = await import("@/lib/stt/speech-gate");
    expect(vadSaysSilent({ ok: true, spans: [{ start_ms: 0, end_ms: DEFAULT_MIN_SPEECH_MS }] })).toBe(false);
  });

  it("NO VAD ANSWER NEVER SKIPS — absence of evidence is not silence", async () => {
    const { vadSaysSilent } = await import("@/lib/jobs/kinds/diarize-window");
    expect(vadSaysSilent(undefined)).toBe(false);
    expect(vadSaysSilent({ ok: false, reason: "vad_unavailable" })).toBe(false);
    // The VAD answering nothing is, on this audio, more often a VAD failure than a quiet room —
    // lib/stt/speech-gate.ts says so, and paying nothing for a real consultation is the cost of
    // getting this wrong.
    expect(vadSaysSilent({ ok: false, reason: "vad_empty_window" })).toBe(false);
  });

  it("several short spans are summed, not judged one at a time", async () => {
    const { vadSaysSilent } = await import("@/lib/jobs/kinds/diarize-window");
    expect(vadSaysSilent({ ok: true, spans: [{ start_ms: 0, end_ms: 600 }, { start_ms: 5_000, end_ms: 5_600 }] })).toBe(false);
  });
});

// ── 8. the credentials ───────────────────────────────────────────────────────────────────────
describe("neither the API key nor the presigned URL ever leaves this process in the clear", () => {
  const driveEveryPath = async () => {
    process.env.DIARIZE_ENGINE = "pyannoteai";
    await runStep("diarize");                                     // happy submit
    server.submitStatus = 401; server.submitBody = { message: "unauthorized" };
    await runStep("diarize");                                     // refused submit -> fallback
    server.submitStatus = 200; server.submitBody = { jobId: "job-abc-123" };
    server.jobAnswers = [{ jobId: "job-abc-123", status: "failed" }];
    await runStep("pyannote_poll", { pyannoteai_job_id: "job-abc-123", run_id: "r", window_id: "w1", engine: "pyannoteai" });
    server.jobStatus = 500; server.jobAnswers = [{}];
    await runStep("pyannote_poll", { pyannoteai_job_id: "job-abc-123", run_id: "r", window_id: "w1", engine: "pyannoteai" });
    r2.signThrows = true;
    await runStep("diarize");                                     // presign throws
  };

  it("the key is in the Authorization header and NOWHERE else", async () => {
    await driveEveryPath();
    expect(fetchCalls.length).toBeGreaterThan(3);
    for (const c of fetchCalls) {
      expect(c.url, "never a query string").not.toContain(KEY);
      expect(c.body ?? "", "never a body field").not.toContain(KEY);
      expect(c.headers.Authorization).toBe(`Bearer ${KEY}`);
    }
  });

  it("the key appears in no log line, on any path including the failures", async () => {
    await driveEveryPath();
    expect(logs.length).toBeGreaterThan(0);
    for (const line of logs) expect(line).not.toContain(KEY);
  });

  it("the presigned URL and its signature appear in no log line", async () => {
    await driveEveryPath();
    for (const line of logs) {
      expect(line).not.toContain(r2.signed);
      expect(line).not.toContain("X-Amz-Signature");
      expect(line).not.toContain("SIGNATURE_SECRET");
    }
  });

  it("neither credential is written to the database", async () => {
    await driveEveryPath();
    const all = JSON.stringify(sqlCalls);
    expect(all).not.toContain(KEY);
    expect(all).not.toContain("SIGNATURE_SECRET");
  });

  it("a provider message never reaches a stored row — codes only", async () => {
    process.env.DIARIZE_ENGINE = "pyannoteai";
    server.jobAnswers = [{ jobId: "job-abc-123", status: "failed", error: "audio contained the phrase ..." }];
    await runStep("pyannote_poll", { pyannoteai_job_id: "job-abc-123", run_id: "r", window_id: "w1", engine: "pyannoteai" });
    const all = JSON.stringify(sqlCalls);
    expect(all).not.toContain("audio contained the phrase");
  });

  it("a missing key does not reach the wire at all", async () => {
    delete (process.env as Record<string, string | undefined>).PYANNOTEAI_API_KEY;
    const { submitDiarize } = await import("@/lib/diarize-pyannoteai");
    await expect(submitDiarize("https://r2.example/x", { label: "w1" })).resolves.toMatchObject({ ok: false, error: "pyannoteai_key_missing" });
    expect(fetchCalls).toHaveLength(0);
  });
});

// ── 9. local stays exactly as it was ─────────────────────────────────────────────────────────
describe("the default engine is untouched", () => {
  it("nothing hosted is contacted, nothing is presigned, and the local service runs", async () => {
    const out = await runStep("diarize");
    expect(out.kind).toBe("done");
    expect(localDiarize.calls).toBe(1);
    expect(fetchCalls).toHaveLength(0);
    expect(signCalls).toHaveLength(0);
  });

  it("the row records the local engine and that it CAN attribute a voice", async () => {
    await runStep("diarize");
    const insert = sqlCalls.find((c) => /INSERT INTO room_diarize_window/.test(c.text))!;
    const stored = JSON.parse(String(insert.values.find((v) => typeof v === "string" && v.includes("\"engine\""))));
    expect(stored.engine).toMatchObject({ name: "local", attribution: "voiceprint", job_id: null, fallback_from: null });
    expect(stored.engine.model).toBe("mini-pyannote-3.1");
  });

  // The state comes from the SPEAKER LIST and always has. Span count is a different quantity that
  // agrees with it almost always, which is exactly why swapping them survives a careless suite.
  it("a speaker with no spans is still 'ok' — the state reads the speaker list, not the spans", async () => {
    localDiarizeOverride.result = {
      speakers: [{ idx: 0, label: "Speaker 1", type: "other" }],
      transcript_segments: [],
      overlap_windows: [], aggregates: {}, model_versions: {},
    };
    await runStep("diarize");
    const insert = sqlCalls.find((c) => /INSERT INTO room_diarize_window/.test(c.text))!;
    expect(insert.values[2]).toBe("ok");
  });

  it("spans with no speakers is 'no_speakers', for the same reason", async () => {
    localDiarizeOverride.result = {
      speakers: [],
      transcript_segments: [{ start_ms: 0, end_ms: 4_000, speaker_idx: 0 }],
      overlap_windows: [], aggregates: {}, model_versions: {},
    };
    await runStep("diarize");
    const insert = sqlCalls.find((c) => /INSERT INTO room_diarize_window/.test(c.text))!;
    expect(insert.values[2]).toBe("no_speakers");
  });

  // A speaker the role map cannot key (no usable idx) is still a speaker. The state counts the
  // LIST; the outcome counts ROLES. They agree on every ordinary window, which is why only a
  // malformed one can tell whether the right quantity is being read.
  it("a speaker the role map drops still makes the window 'ok'", async () => {
    localDiarizeOverride.result = {
      speakers: [{ label: "Speaker 1", type: "other" }],   // no idx: no role, but a speaker
      transcript_segments: [{ start_ms: 0, end_ms: 4_000, speaker_idx: 0 }],
      overlap_windows: [], aggregates: {}, model_versions: {},
    };
    await runStep("diarize");
    const insert = sqlCalls.find((c) => /INSERT INTO room_diarize_window/.test(c.text))!;
    expect(insert.values[2]).toBe("ok");
  });

  it("a clip missing from R2 still fails the way it always did", async () => {
    r2.bytes = null;
    const out = await runStep("diarize");
    expect(out.kind).toBe("fail");
    if (out.kind !== "fail") throw new Error("unreachable");
    expect(out.error).toContain("clip_missing_in_r2");
  });

  it("the local diarizer failing is still a failed row, not a fallback to anything", async () => {
    localDiarize.ok = false;
    const out = await runStep("diarize");
    expect(out.kind).toBe("fail");
    expect(fetchCalls).toHaveLength(0);
  });
});

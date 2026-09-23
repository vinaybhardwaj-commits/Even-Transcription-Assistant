/**
 * The hybrid (pyannote.ai turns + Mini embeddings), the teacher labels, and the level gate.
 *
 * The three things most likely to be wrong, and what each test is defending:
 *
 *  1. IDENTITY MUST BE EARNED. `attribution: "voiceprint"` may only appear when embeddings really
 *     came back. If it were assumed from the engine name, a window where the Mini was unreachable
 *     would report "nobody matched" when the truth is "nobody was compared" — and those two are
 *     indistinguishable downstream in room_turn_speaker.
 *  2. THE LEVEL GATE MUST NOT CONVICT AN UNSEEN WINDOW. It stops a paid call, so a false "silent"
 *     silently throws away a consultation. Absence of readings is never silence.
 *  3. THE LOCAL COMPARISON RUN MUST NOT TOUCH PRODUCTION. It exists to measure the teacher's lead;
 *     if it wrote turns it would overwrite the identities the hybrid just stored.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { readFileSync } from "node:fs";
import { makeFakeClinician } from "../support/fake-identity";

const DOC = makeFakeClinician(1);

const sqlCalls: Array<{ text: string; values: unknown[] }> = [];
let windowRow: Array<Record<string, unknown>> = [];
let levelRows: Array<Record<string, unknown>> = [];
let turnsRow: Array<Record<string, unknown>> = [];
let countRows: Array<Record<string, unknown>> = [];
let roomDayRows: Array<Record<string, unknown>> = [];
let roomDayThrows = false;
let voicePrintRows: Array<Record<string, unknown>> = [];

vi.mock("@/lib/db", () => ({
  sql: (strings: TemplateStringsArray, ...values: unknown[]) => {
    const text = strings.join("?").replace(/\s+/g, " ").trim();
    sqlCalls.push({ text, values });
    if (/FROM bench_window/.test(text)) return Promise.resolve(windowRow);
    if (/FROM room_day/.test(text)) {
      return roomDayThrows ? Promise.reject(new Error("relation room_day does not exist")) : Promise.resolve(roomDayRows);
    }
    if (/FROM bench_level_sample/.test(text)) return Promise.resolve(levelRows);
    if (/FROM diarize_window_label/.test(text)) return Promise.resolve(countRows);
    if (/FROM cue/.test(text)) return Promise.resolve(turnsRow);
    if (/FROM voice_print/.test(text)) return Promise.resolve(voicePrintRows);
    return Promise.resolve([]);
  },
}));

const r2 = { bytes: new Uint8Array([1, 2, 3]) as Uint8Array | null };
vi.mock("@/lib/r2", () => ({
  getObjectBytes: async () => r2.bytes,
  headObject: async () => ({ size: 3, content_type: "audio/webm" }),
  signGetUrl: async () => "https://r2.example/clip.webm?X-Amz-Signature=SIG",
}));

const local = { calls: 0, ok: true as boolean, lastCentroids: null as unknown };
const localOverride: { result: Record<string, unknown> | null } = { result: null };
vi.mock("@/lib/diarize", () => ({
  runDiarize: async (_a: unknown, _c: unknown, o: { clinicianCentroids?: unknown[] }) => {
    local.calls += 1;
    local.lastCentroids = o.clinicianCentroids;
    if (!local.ok) return { ok: false, error: "nope", retryable: false, latencyMs: 1, timing: {} };
    return {
      ok: true, latencyMs: 9, timing: { wall_ms: 9 },
      result: localOverride.result ?? {
        speakers: [{ idx: 0, label: "S1", type: "other", embedding_base64: "LOCALEMB" }],
        transcript_segments: [{ start_ms: 0, end_ms: 3000, speaker_idx: 0 }],
        overlap_windows: [], aggregates: {}, model_versions: { diarization: "mini-3.1" },
      },
    };
  },
}));

const PY = "https://fake-pyannote.test";
const MINI = "https://fake-mini.test";
const server = {
  job: { jobId: "job-1", status: "succeeded", output: { diarization: [
    { start: 1.0, end: 9.0, speaker: "SPEAKER_A" },
    { start: 10.0, end: 12.0, speaker: "SPEAKER_B" },
  ] } } as unknown,
  records: [{ id: "job-1", model: "precision-4-fake", type: "diarize", status: "succeeded" }] as unknown[],
  embedOk: true,
  embedBody: null as unknown,
  embedStatus: 200,
};
const logs: string[] = [];
const fetchCalls: Array<{ url: string; body: unknown }> = [];

beforeEach(() => {
  sqlCalls.length = 0; logs.length = 0; fetchCalls.length = 0;
  windowRow = [{ id: "w1", room_day_id: "rd1", start_ms: 0, end_ms: 900_000, clip_r2_key: "c/w1.webm" }];
  levelRows = []; turnsRow = []; countRows = [];
  roomDayRows = [{ room_id: "room1", ist_date: "2026-09-23" }]; roomDayThrows = false;
  voicePrintRows = [{ clinician_id: DOC.id, full_name: DOC.full_name, centroid_base64: "AAAA" }];
  r2.bytes = new Uint8Array([1, 2, 3]);
  local.calls = 0; local.ok = true; local.lastCentroids = null; localOverride.result = null;
  server.job = { jobId: "job-1", status: "succeeded", output: { diarization: [
    { start: 1.0, end: 9.0, speaker: "SPEAKER_A" }, { start: 10.0, end: 12.0, speaker: "SPEAKER_B" },
  ] } };
  server.records = [{ id: "job-1", model: "precision-4-fake", type: "diarize", status: "succeeded" }];
  server.embedOk = true; server.embedStatus = 200; server.embedBody = null;
  process.env.PYANNOTEAI_API_KEY = "k"; process.env.PYANNOTEAI_BASE_URL = PY;
  process.env.DIARIZE_BASE_URL = MINI;
  process.env.DIARIZE_POLL_INTERVAL_MS = "1"; process.env.DIARIZE_POLL_BUDGET_MS = "40";
  delete (process.env as Record<string, string | undefined>).DIARIZE_ENGINE;
  delete (process.env as Record<string, string | undefined>).DIARIZE_TEACHER_LABELS;
  delete (process.env as Record<string, string | undefined>).DIARIZE_SPEECH_GATE;
  delete (process.env as Record<string, string | undefined>).PYANNOTEAI_EUR_PER_AUDIO_HOUR;
  for (const m of ["log", "warn", "error"] as const) {
    vi.spyOn(console, m).mockImplementation((...a: unknown[]) => {
      logs.push(a.map((x) => (typeof x === "string" ? x : JSON.stringify(x))).join(" "));
    });
  }
  vi.stubGlobal("fetch", async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    fetchCalls.push({ url, body: init?.body });
    const reply = (status: number, body: unknown) =>
      ({ ok: status >= 200 && status < 300, status, text: async () => JSON.stringify(body) }) as unknown as Response;
    if (url.includes("/embed_speakers")) {
      if (server.embedBody !== null) return reply(server.embedStatus, server.embedBody);
      if (!server.embedOk) return reply(500, { ok: false, error: "boom" });
      return reply(200, { ok: true, speakers: [
        { idx: 0, embedding_base64: "EMB0", clinician_id: DOC.id, label: DOC.label, type: "clinician", confidence: 0.81, source: "auto" },
        { idx: 1, embedding_base64: "EMB1" },
      ] });
    }
    if (url.includes("/v1/diarize")) return reply(200, { jobId: "job-1" });
    if (url.includes("/v2/jobs")) return reply(200, { items: server.records, nextCursor: null });
    if (url.includes("/v1/jobs/")) return reply(200, server.job);
    throw new Error(`unexpected fetch ${url}`);
  });
});
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

const runStep = async (step: string, progress: Record<string, unknown> = {}) => {
  const { diarizeWindowKind } = await import("@/lib/jobs/kinds/diarize-window");
  return diarizeWindowKind.run({ job: {} as never, step, args: { window_id: "w1" }, progress });
};
const pollProgress = { pyannoteai_job_id: "job-1", run_id: "r1", window_id: "w1", engine: "pyannoteai", audio_seconds_sent: 900 };
const storedEngine = () => {
  const ins = sqlCalls.find((c) => /INSERT INTO room_diarize_window/.test(c.text))!;
  return JSON.parse(String(ins.values.find((v) => typeof v === "string" && v.includes('"engine"')))).engine;
};

// ── 1. the span choice ───────────────────────────────────────────────────────────────────────
describe("longestSpanPerSpeaker — one span each, and the longest", () => {
  it("picks the longest span but totals ALL of a speaker's spans", async () => {
    const { longestSpanPerSpeaker } = await import("@/lib/diarize-embed");
    const out = longestSpanPerSpeaker([
      { start_ms: 0, end_ms: 1_000, speaker_idx: 0 },
      { start_ms: 5_000, end_ms: 9_000, speaker_idx: 0 },
      { start_ms: 20_000, end_ms: 22_000, speaker_idx: 1 },
    ]);
    expect(out).toEqual([
      // the 4 s span is embedded; priority uses 1 s + 4 s
      { idx: 0, start_s: 5, end_s: 9, total_speech_sec: 5 },
      { idx: 1, start_s: 20, end_s: 22, total_speech_sec: 2 },
    ]);
  });

  it("a tie goes to the earlier span, so input order cannot change the answer", async () => {
    const { longestSpanPerSpeaker } = await import("@/lib/diarize-embed");
    const a = [{ start_ms: 0, end_ms: 2_000, speaker_idx: 0 }, { start_ms: 9_000, end_ms: 11_000, speaker_idx: 0 }];
    expect(longestSpanPerSpeaker(a)[0]!.start_s).toBe(0);
    expect(longestSpanPerSpeaker([...a].reverse())[0]!.start_s).toBe(0);
  });

  it("this reproduces /diarize's rule — the LONGEST span, never a pooled average", () => {
    // The Mini embeds `longest = max(segments, key=length)`; a centroid enrolled against
    // longest-span embeddings is only comparable to longest-span embeddings.
    const src = readFileSync("lib/diarize-embed.ts", "utf8");
    expect(src).toMatch(/longest/i);
  });
});

// ── 2. identity is added, never invented ─────────────────────────────────────────────────────
describe("mergeEmbeddings — only ever adds", () => {
  it("a matched speaker gains identity; an unmatched one keeps its embedding and nothing else", async () => {
    const { mergeEmbeddings } = await import("@/lib/diarize-embed");
    const out = mergeEmbeddings(
      [{ idx: 0, type: "unknown" }, { idx: 1, type: "unknown" }],
      [{ idx: 0, embedding_base64: "E0", clinician_id: DOC.id, label: DOC.label, type: "clinician", confidence: 0.8, source: "auto" },
       { idx: 1, embedding_base64: "E1", label: "ignored", type: "patient" }],
    );
    expect(out[0]).toMatchObject({ idx: 0, embedding_base64: "E0", clinician_id: DOC.id, type: "clinician", confidence: 0.8 });
    // NOT "patient": an unmatched speaker must not acquire a heuristic label from the service.
    expect(out[1]).toEqual({ idx: 1, type: "unknown", embedding_base64: "E1" });
  });

  it("a speaker the service could not embed is returned untouched", async () => {
    const { mergeEmbeddings } = await import("@/lib/diarize-embed");
    const out = mergeEmbeddings([{ idx: 0, type: "unknown" }], [{ idx: 0, embedding_base64: null }]);
    expect(out[0]).toEqual({ idx: 0, type: "unknown" });
  });
});

// ── 3. the hybrid end to end ─────────────────────────────────────────────────────────────────
describe("the hybrid stores pyannote.ai turns with this system's identities", () => {
  beforeEach(() => { process.env.DIARIZE_ENGINE = "pyannoteai"; });

  it("embeds the speakers and stores a voiceprint attribution it EARNED", async () => {
    turnsRow = [{ source_ref: "t1", start_ms: 2_000, end_ms: 5_000 }];
    const out = await runStep("pyannote_poll", pollProgress);
    expect(out.kind).toBe("done");
    const embed = fetchCalls.find((c) => c.url.includes("/embed_speakers"));
    expect(embed, "the Mini was asked for embeddings").toBeTruthy();
    expect(storedEngine()).toMatchObject({ name: "pyannoteai", attribution: "voiceprint", model: "precision-4-fake" });
    if (out.kind !== "done") throw new Error("x");
    expect(out.result.speakers_embedded).toBe(2);
  });

  it("the stored speakers carry embedding_base64, so speaker-calibration keeps its input", async () => {
    await runStep("pyannote_poll", pollProgress);
    const ins = sqlCalls.find((c) => /INSERT INTO room_diarize_window/.test(c.text))!;
    const speakersJson = String(ins.values.find((v) => typeof v === "string" && v.includes("embedding_base64")));
    expect(speakersJson).toContain("EMB0");
    expect(speakersJson).toContain("EMB1");
  });

  it("a matched speaker reaches room_turn_speaker as a CLINICIAN, not no_match", async () => {
    turnsRow = [{ source_ref: "t1", start_ms: 2_000, end_ms: 5_000 }];
    await runStep("pyannote_poll", pollProgress);
    const turn = sqlCalls.find((c) => /INSERT INTO room_turn_speaker/.test(c.text))!;
    expect(turn.values).toContain(DOC.id);
    expect(turn.values).toContain("clinician");
  });

  it("WHEN THE MINI IS UNREACHABLE the attribution is 'none' and the reason is recorded", async () => {
    server.embedOk = false;
    const out = await runStep("pyannote_poll", pollProgress);
    expect(out.kind).toBe("done");
    // "none" is the honest word: nothing was compared. It must never read as "nobody matched".
    expect(storedEngine()).toMatchObject({ attribution: "none", embed_error: "embed_failed" });
    if (out.kind !== "done") throw new Error("x");
    expect(out.result.embed_error).toBe("embed_failed");
    expect(out.result.speakers_embedded).toBe(0);
  });

  it("an embed answer with every embedding null is also 'none' — zero compared is zero", async () => {
    server.embedBody = { ok: true, speakers: [{ idx: 0, embedding_base64: null }, { idx: 1, embedding_base64: null }] };
    await runStep("pyannote_poll", pollProgress);
    expect(storedEngine()).toMatchObject({ attribution: "none" });
  });

  it("the window is still stored when embeddings fail — the segmentation is not lost", async () => {
    server.embedOk = false;
    await runStep("pyannote_poll", pollProgress);
    expect(sqlCalls.some((c) => /INSERT INTO room_diarize_window/.test(c.text))).toBe(true);
  });
});

// ── 3b. attribution is earned on BOTH arms ──────────────────────────────────────────────────
describe("attribution is earned, on the local arm too", () => {
  it("attributionFor needs BOTH halves: something to compare, and something to compare against", async () => {
    const { attributionFor } = await import("@/lib/stt/diarize-window");
    expect(attributionFor([{ embedding_base64: "E" }], 1)).toBe("voiceprint");
    // Nothing to compare against — the matcher ran over an empty list and named nobody.
    expect(attributionFor([{ embedding_base64: "E" }], 0)).toBe("none");
    // Nothing to compare.
    expect(attributionFor([{ embedding_base64: null }], 1)).toBe("none");
    expect(attributionFor([{}], 1)).toBe("none");
    expect(attributionFor([], 1)).toBe("none");
    expect(attributionFor([{ embedding_base64: "" }], 1)).toBe("none");
  });

  it("LOCAL with an enrolled voiceprint and an embedding earns 'voiceprint'", async () => {
    const out = await runStep("diarize");                    // engine unset = local
    expect(out.kind).toBe("done");
    expect(storedEngine()).toMatchObject({ name: "local", attribution: "voiceprint", centroids_offered: 1 });
  });

  it("LOCAL WITH NO ENROLLED VOICEPRINTS reports 'none' — the matcher compared against nothing", async () => {
    // /diarize still runs its own matcher, but loadClinicianCentroids() returns [] when no active
    // clinician has a voiceprint, so every turn lands no_match having been compared to nobody.
    // Claiming "voiceprint" here is the same conflation the pyannote arm was written to close.
    voicePrintRows = [];
    await runStep("diarize");
    expect(storedEngine()).toMatchObject({ name: "local", attribution: "none", centroids_offered: 0 });
  });

  it("LOCAL with centroids but no embedding back reports 'none'", async () => {
    localOverride.result = {
      speakers: [{ idx: 0, label: "S1", type: "other" }],     // no embedding_base64
      transcript_segments: [{ start_ms: 0, end_ms: 3000, speaker_idx: 0 }],
      overlap_windows: [], aggregates: {}, model_versions: {},
    };
    await runStep("diarize");
    expect(storedEngine()).toMatchObject({ attribution: "none" });
  });

  it("THE HYBRID WITH NO ENROLLED VOICEPRINTS is 'none' even though embeddings came back", async () => {
    // The hole on my own arm, found while fixing the Refuter's: counting embeddings alone claims
    // an attribution on a day when nobody is enrolled.
    process.env.DIARIZE_ENGINE = "pyannoteai";
    voicePrintRows = [];
    await runStep("pyannote_poll", pollProgress);
    expect(storedEngine()).toMatchObject({ name: "pyannoteai", attribution: "none", centroids_offered: 0 });
  });

  it("the provenance carries the EVIDENCE for its own claim", async () => {
    process.env.DIARIZE_ENGINE = "pyannoteai";
    await runStep("pyannote_poll", pollProgress);
    const e = storedEngine();
    expect(e.centroids_offered).toBe(1);
    expect(e.attribution).toBe("voiceprint");
  });
});

// ── 4. the level gate ────────────────────────────────────────────────────────────────────────
describe("the level gate stops a paid call only on evidence", () => {
  const win = { start_ms: 0, end_ms: 900_000 };
  const bucket = (t: number, peak: number) => ({ t_ms: t, peak, avg: null, zero_ratio: null, session_open: true, tape_advancing: true, samples: 1 });
  const full = (peak: number) => Array.from({ length: 60 }, (_, i) => bucket(i * 15_000, peak));

  it("a fully covered window below the floor is SILENT", async () => {
    const { judgeLevels } = await import("@/lib/diarize-level-gate");
    const { DEFAULT_ROOM_ENERGY_FLOOR } = await import("@/lib/stt/window-measure");
    const v = judgeLevels(full(DEFAULT_ROOM_ENERGY_FLOOR / 2), win);
    expect(v).toMatchObject({ verdict: "silent", reason: "peak_below_floor", basis: "peak", active: 0 });
  });

  it("NO SAMPLES IS UNKNOWN, never silent", async () => {
    const { judgeLevels } = await import("@/lib/diarize-level-gate");
    expect(judgeLevels([], win)).toMatchObject({ verdict: "unknown", reason: "no_samples" });
  });

  it("THIN COVERAGE IS UNKNOWN — three quiet readings do not convict a 15-minute window", async () => {
    const { judgeLevels } = await import("@/lib/diarize-level-gate");
    const { DEFAULT_ROOM_ENERGY_FLOOR } = await import("@/lib/stt/window-measure");
    const v = judgeLevels([bucket(0, 0), bucket(15_000, 0), bucket(30_000, DEFAULT_ROOM_ENERGY_FLOOR / 4)], win);
    expect(v).toMatchObject({ verdict: "unknown", reason: "thin_coverage" });
  });

  it("ONE bucket above the floor is enough to spare the window, whatever the coverage", async () => {
    const { judgeLevels } = await import("@/lib/diarize-level-gate");
    const { DEFAULT_ROOM_ENERGY_FLOOR } = await import("@/lib/stt/window-measure");
    const v = judgeLevels([bucket(0, DEFAULT_ROOM_ENERGY_FLOOR)], win);
    expect(v).toMatchObject({ verdict: "has_sound", reason: "peak_above_floor", active: 1 });
  });

  it("the floor is the shared one, and the boundary is inclusive", async () => {
    const { judgeLevels } = await import("@/lib/diarize-level-gate");
    const { DEFAULT_ROOM_ENERGY_FLOOR } = await import("@/lib/stt/window-measure");
    // Derived through the INVERSE: one step below the floor is silence, exactly at it is not.
    expect(judgeLevels(full(DEFAULT_ROOM_ENERGY_FLOOR), win).verdict).toBe("has_sound");
    expect(judgeLevels(full(DEFAULT_ROOM_ENERGY_FLOOR - 1e-9), win).verdict).toBe("silent");
  });

  it("samples outside the window are not counted", async () => {
    const { judgeLevels } = await import("@/lib/diarize-level-gate");
    const { DEFAULT_ROOM_ENERGY_FLOOR } = await import("@/lib/stt/window-measure");
    const v = judgeLevels([...full(0), bucket(2_000_000, DEFAULT_ROOM_ENERGY_FLOOR * 10)], win);
    expect(v.verdict).toBe("silent");
  });

  it("a flat level log skips the paid call and never contacts pyannote.ai", async () => {
    process.env.DIARIZE_ENGINE = "pyannoteai";
    levelRows = Array.from({ length: 60 }, (_, i) => ({
      sampled_at: new Date(i * 15_000).toISOString(), peak: 0, avg: null, zero_ratio: null,
      session_open: true, tape_advancing: true, samples: 1,
    }));
    const out = await runStep("diarize");
    expect(out.kind).toBe("done");
    if (out.kind !== "done") throw new Error("x");
    expect(out.result.skipped).toBe("silent_window");
    expect(out.result.audio_seconds_sent).toBe(0);
    // A window nothing ran on compared nothing; the row must not inherit a claim.
    expect(storedEngine()).toMatchObject({ attribution: "none", audio_seconds_sent: 0 });
    expect(fetchCalls.filter((c) => c.url.includes("/v1/diarize"))).toHaveLength(0);
  });

  // ── THE DECISION, not the value. `unknown` is pinned as a RETURN of judgeLevels by the tests
  // above; these pin what the JOB DOES with it. ETA-Refuter's L1: `=== "silent"` mutated to
  // `!== "has_sound"` passed 91/91, because the two fail-safe tests below are guarded by `if (rd)`
  // and so never reach the comparison at all — they pin resolution, not judgement.
  //
  // Each asserts the gate WAS consulted (a bench_level_sample read happened). Without that the
  // test would pass for the wrong reason the moment the gate stopped running, which is the exact
  // shape of the hole it is closing.
  it("an UNKNOWN verdict still diarizes — a window we could not judge is not a window we judged silent", async () => {
    process.env.DIARIZE_ENGINE = "pyannoteai";
    levelRows = [];                                        // no readings at all -> no_samples
    const out = await runStep("diarize");
    expect(sqlCalls.some((c) => /FROM bench_level_sample/.test(c.text)), "the gate really ran").toBe(true);
    expect(out.kind).toBe("next");
    expect(fetchCalls.some((c) => c.url.includes("/v1/diarize")), "the paid call was made").toBe(true);
  });

  it("THIN COVERAGE still diarizes — three quiet readings do not convict a 15-minute window", async () => {
    // The direction matters: `!== "has_sound"` reads as MORE careful ("only pay when we know there
    // is sound") and silently stores every thinly-logged window as no_speakers, asserting a
    // judgement that was never made. It costs data, not money.
    process.env.DIARIZE_ENGINE = "pyannoteai";
    levelRows = [0, 1, 2].map((i) => ({
      sampled_at: new Date(i * 15_000).toISOString(), peak: 0, avg: null, zero_ratio: null,
      session_open: true, tape_advancing: true, samples: 1,
    }));
    const out = await runStep("diarize");
    expect(sqlCalls.some((c) => /FROM bench_level_sample/.test(c.text)), "the gate really ran").toBe(true);
    expect(out.kind).toBe("next");
    if (out.kind !== "next") throw new Error("unreachable");
    expect(out.progress.pyannoteai_job_id).toBeTruthy();
  });

  it("ONLY 'silent' skips — the three verdicts are not two", async () => {
    // Named so the next person reading the job sees that `unknown` is a third state with its own
    // behaviour, not a synonym for either neighbour.
    const { judgeLevels } = await import("@/lib/diarize-level-gate");
    const { DEFAULT_ROOM_ENERGY_FLOOR } = await import("@/lib/stt/window-measure");
    const win = { start_ms: 0, end_ms: 900_000 };
    const bucket = (t: number, peak: number) => ({ t_ms: t, peak, avg: null, zero_ratio: null, session_open: true, tape_advancing: true, samples: 1 });
    const verdicts = new Set([
      judgeLevels([], win).verdict,
      judgeLevels([bucket(0, 0)], win).verdict,
      judgeLevels(Array.from({ length: 60 }, (_, i) => bucket(i * 15_000, 0)), win).verdict,
      judgeLevels([bucket(0, DEFAULT_ROOM_ENERGY_FLOOR)], win).verdict,
    ]);
    expect([...verdicts].sort()).toEqual(["has_sound", "silent", "unknown"]);
    const src = readFileSync("lib/jobs/kinds/diarize-window.ts", "utf8");
    expect(src, "the job skips on the one verdict, never on the absence of another").toContain('level.verdict === "silent"');
  });

  it("a room_day it cannot read NEVER skips — the gate fails safe, it does not fail the window", async () => {
    // The window load deliberately no longer joins room_day (that join broke eleven e2e tests on a
    // schema without the table). The gate resolves it separately and swallows the failure, because
    // a cost guard that could not read its inputs must not stop a clinical window.
    process.env.DIARIZE_ENGINE = "pyannoteai";
    roomDayThrows = true;
    levelRows = Array.from({ length: 60 }, (_, i) => ({
      sampled_at: new Date(i * 15_000).toISOString(), peak: 0, avg: null, zero_ratio: null,
      session_open: true, tape_advancing: true, samples: 1,
    }));
    const out = await runStep("diarize");
    expect(out.kind).toBe("next");                       // submitted, not skipped
    expect(fetchCalls.some((c) => c.url.includes("/v1/diarize"))).toBe(true);
  });

  it("a room_day row that is missing also never skips", async () => {
    process.env.DIARIZE_ENGINE = "pyannoteai";
    roomDayRows = [];
    const out = await runStep("diarize");
    expect(out.kind).toBe("next");
    expect(fetchCalls.some((c) => c.url.includes("/v1/diarize"))).toBe(true);
  });

  it("the core window load does NOT join room_day — one engine's guard cannot break the other's query", () => {
    const src = readFileSync("lib/jobs/kinds/diarize-window.ts", "utf8");
    const load = src.slice(src.indexOf("async function loadWindow"), src.indexOf("async function resolveRoomDay"));
    expect(load).toContain("FROM bench_window");
    expect(load).not.toContain("room_day rd");
    expect(load).not.toMatch(/JOIN/i);
  });

  it("IT DOES NOT NEED DIARIZE_SPEECH_GATE — that flag is unset in every test above", async () => {
    expect(process.env.DIARIZE_SPEECH_GATE).toBeUndefined();
    // Checked by what it IMPORTS, not by what its prose mentions: the file names the flag in a
    // comment precisely to say it does not use it.
    const src = readFileSync("lib/diarize-level-gate.ts", "utf8");
    expect(src).not.toMatch(/^import[^;]*speech-gate/m);
    expect(src).not.toContain("speechGateEnabled(");
  });

  it("the local engine is NOT level-gated — its behaviour is not ours to change", async () => {
    levelRows = Array.from({ length: 60 }, (_, i) => ({
      sampled_at: new Date(i * 15_000).toISOString(), peak: 0, avg: null, zero_ratio: null,
      session_open: true, tape_advancing: true, samples: 1,
    }));
    const out = await runStep("diarize");          // DIARIZE_ENGINE unset = local
    expect(out.kind).toBe("done");
    expect(local.calls).toBe(1);
  });
});

// ── 5. teacher labels ────────────────────────────────────────────────────────────────────────
describe("teacher labels", () => {
  it("are OFF by default — no label row is written", async () => {
    process.env.DIARIZE_ENGINE = "pyannoteai";
    await runStep("pyannote_poll", pollProgress);
    expect(sqlCalls.some((c) => /INSERT INTO diarize_window_label/.test(c.text))).toBe(false);
  });

  it("ON, the teacher's raw turns are recorded with its DERIVED model and job id", async () => {
    process.env.DIARIZE_ENGINE = "pyannoteai";
    process.env.DIARIZE_TEACHER_LABELS = "1";
    await runStep("pyannote_poll", pollProgress);
    const ins = sqlCalls.find((c) => /INSERT INTO diarize_window_label/.test(c.text))!;
    expect(ins.values).toContain("pyannoteai");
    expect(ins.values).toContain("precision-4-fake");
    expect(ins.values).toContain("job-1");
    expect(ins.values).toContain(900);
  });

  it("ON, the hybrid hands off to a local COMPARISON step", async () => {
    process.env.DIARIZE_ENGINE = "pyannoteai";
    process.env.DIARIZE_TEACHER_LABELS = "1";
    const out = await runStep("pyannote_poll", pollProgress);
    expect(out.kind).toBe("next");
    if (out.kind !== "next") throw new Error("x");
    expect(out.step).toBe("local_label");
  });

  it("the comparison run WRITES NO TURNS and no window row — production is untouched", async () => {
    process.env.DIARIZE_TEACHER_LABELS = "1";
    const out = await runStep("local_label", { run_id: "r1", window_id: "w1", hybrid_result: { window_id: "w1" } });
    expect(out.kind).toBe("done");
    expect(local.calls).toBe(1);
    expect(sqlCalls.some((c) => /INSERT INTO room_turn_speaker/.test(c.text))).toBe(false);
    expect(sqlCalls.some((c) => /INSERT INTO room_diarize_window/.test(c.text))).toBe(false);
    expect(sqlCalls.some((c) => /INSERT INTO diarize_window_label/.test(c.text))).toBe(true);
  });

  it("the comparison run is given NO centroids — it is measuring segmentation, not identity", async () => {
    process.env.DIARIZE_TEACHER_LABELS = "1";
    await runStep("local_label", { run_id: "r1", window_id: "w1" });
    expect(local.lastCentroids).toEqual([]);
  });

  it("a failing comparison run NEVER fails the job", async () => {
    process.env.DIARIZE_TEACHER_LABELS = "1";
    local.ok = false;
    const out = await runStep("local_label", { run_id: "r1", window_id: "w1", hybrid_result: { window_id: "w1" } });
    expect(out.kind).toBe("done");
    if (out.kind !== "done") throw new Error("x");
    expect(out.result.local_label).toBe("diarize_failed");
    expect(out.result.window_id).toBe("w1");
  });

  it("a label write that throws never fails the window", async () => {
    process.env.DIARIZE_ENGINE = "pyannoteai";
    process.env.DIARIZE_TEACHER_LABELS = "1";
    const { writeWindowLabel } = await import("@/lib/diarize-labels");
    vi.spyOn(await import("@/lib/diarize-labels"), "writeWindowLabel").mockRejectedValue(new Error("table gone"));
    const out = await runStep("pyannote_poll", pollProgress);
    expect(["done", "next"]).toContain(out.kind);
    expect(sqlCalls.some((c) => /INSERT INTO room_diarize_window/.test(c.text))).toBe(true);
    expect(writeWindowLabel).toBeDefined();
  });

  it("the flag is strict — a typo throws rather than silently not collecting", async () => {
    const { teacherLabelsEnabled } = await import("@/lib/diarize-engine");
    const { FlagValueError } = await import("@/lib/flags");
    expect(teacherLabelsEnabled({})).toBe(false);
    expect(teacherLabelsEnabled({ DIARIZE_TEACHER_LABELS: "1" })).toBe(true);
    expect(() => teacherLabelsEnabled({ DIARIZE_TEACHER_LABELS: "yes please" })).toThrow(FlagValueError);
  });

  it("the label write can only INSERT — a conflict is ignored, never an overwrite", async () => {
    // Append-only is the requirement, not a preference: a teacher label a later run can rewrite is
    // not a label. `DO NOTHING` also makes a REPLAYED step idempotent, so a crash between the write
    // and the step's completion cannot double-count a window in the spend report.
    const { writeWindowLabel } = await import("@/lib/diarize-labels");
    await writeWindowLabel({
      windowId: "w1", roomDayId: "rd1", engine: "pyannoteai", model: "m", providerJobId: "j",
      runId: "r1", segments: [{ start_ms: 0, end_ms: 1000, speaker_idx: 0 }], speakerCount: 1, audioSeconds: 900,
    });
    const ins = sqlCalls.find((c) => /INSERT INTO diarize_window_label/.test(c.text))!;
    expect(ins.text).toContain("ON CONFLICT (window_id, engine, run_id) DO NOTHING");
    expect(ins.text).not.toMatch(/DO UPDATE/i);
    expect(ins.text).not.toMatch(/\bUPDATE\b|\bDELETE\b/i);
    expect(ins.values).toContain(900);
  });

  it("migration 0117's engine vocabulary matches DIARIZE_ENGINES — no drift", async () => {
    const { DIARIZE_ENGINES } = await import("@/lib/diarize-engine");
    const sqlText = readFileSync("db/migrations/0117_diarize_window_label.sql", "utf8");
    const m = sqlText.match(/engine IN \(([^)]*)\)/)!;
    const listed = m[1]!.split(",").map((s) => s.trim().replace(/'/g, ""));
    expect(listed.sort()).toEqual([...DIARIZE_ENGINES].sort());
  });

  it("0117 is the number, and it is append-only", () => {
    const sqlText = readFileSync("db/migrations/0117_diarize_window_label.sql", "utf8");
    expect(sqlText).toContain("CREATE TABLE IF NOT EXISTS diarize_window_label");
    expect(sqlText).toContain("UNIQUE (window_id, engine, run_id)");
    // Nothing here may rewrite a label: that is what makes it a label.
    expect(sqlText).not.toMatch(/\bUPDATE\b|\bDELETE\b|\bDROP\b/);
  });
});

// ── 6. the money is derived, and honest about being an estimate ──────────────────────────────
describe("daily counts", () => {
  it("the rate defaults to the bake-off's figure and rejects nonsense", async () => {
    const { eurPerAudioHour, EUR_PER_AUDIO_HOUR_DEFAULT } = await import("@/lib/diarize-labels");
    expect(EUR_PER_AUDIO_HOUR_DEFAULT).toBe(0.112);
    expect(eurPerAudioHour({})).toBe(0.112);
    expect(eurPerAudioHour({ PYANNOTEAI_EUR_PER_AUDIO_HOUR: "0.2" })).toBe(0.2);
    for (const bad of ["", "abc", "-1"]) {
      expect(eurPerAudioHour({ PYANNOTEAI_EUR_PER_AUDIO_HOUR: bad }), `value ${bad}`).toBe(0.112);
    }
  });

  it("spend is DERIVED from stored audio seconds, and only for the engine we pay", async () => {
    const { dailyLabelCounts } = await import("@/lib/diarize-labels");
    countRows = [
      { ist_date: "2026-09-23", engine: "pyannoteai", windows: 10, audio_seconds: 9000 },
      { ist_date: "2026-09-23", engine: "local", windows: 10, audio_seconds: 9000 },
    ];
    const out = await dailyLabelCounts({ env: {} });
    expect(out[0]).toEqual({ ist_date: "2026-09-23", engine: "pyannoteai", windows: 10, audio_hours: 2.5, estimated_eur: 0.28 });
    // Reporting 0.00 for the free engine would invite the reader to total the column.
    expect(out[1]!.estimated_eur).toBeNull();
  });

  it("a changed rate changes the report, because nothing was accumulated", async () => {
    const { dailyLabelCounts } = await import("@/lib/diarize-labels");
    countRows = [{ ist_date: "2026-09-23", engine: "pyannoteai", windows: 1, audio_seconds: 3600 }];
    expect((await dailyLabelCounts({ env: {} }))[0]!.estimated_eur).toBe(0.112);
    expect((await dailyLabelCounts({ env: { PYANNOTEAI_EUR_PER_AUDIO_HOUR: "0.5" } }))[0]!.estimated_eur).toBe(0.5);
  });
});

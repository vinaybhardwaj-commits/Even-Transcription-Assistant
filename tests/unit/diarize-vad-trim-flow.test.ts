/**
 * DIARIZE_VAD_TRIM through the job: what is sent, what is stored, and what happens when the trim
 * cannot be done.
 *
 * The fake pyannote.ai answers in TRIMMED time. The expected ORIGINAL positions are worked out by
 * hand from the region layout below, never by calling the remap.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { makeFakeClinician } from "../support/fake-identity";

const DOC = makeFakeClinician(1);
const sqlCalls: Array<{ text: string; values: unknown[] }> = [];
let windowRow: Array<Record<string, unknown>> = [];

vi.mock("@/lib/db", () => ({
  sql: (strings: TemplateStringsArray, ...values: unknown[]) => {
    const text = strings.join("?").replace(/\s+/g, " ").trim();
    sqlCalls.push({ text, values });
    if (/FROM bench_window/.test(text)) return Promise.resolve(windowRow);
    if (/FROM room_day/.test(text)) return Promise.resolve([]);          // no level gate verdict
    if (/FROM voice_print/.test(text)) return Promise.resolve([{ clinician_id: DOC.id, full_name: DOC.full_name, centroid_base64: "AAAA" }]);
    return Promise.resolve([]);
  },
}));

const r2 = { puts: [] as Array<{ key: string; type: string; len: number }>, deletes: [] as string[], signed: [] as string[], putThrows: false };
vi.mock("@/lib/r2", () => ({
  getObjectBytes: async () => new Uint8Array([1, 2, 3]),
  headObject: async () => ({ size: 3, content_type: "audio/webm" }),
  signGetUrl: async (o: { key: string }) => { r2.signed.push(o.key); return `https://r2.example/${o.key}?X-Amz-Signature=SIG`; },
  putObjectBytes: async (key: string, bytes: Uint8Array, type: string) => {
    if (r2.putThrows) throw new Error("r2 down");
    r2.puts.push({ key, type, len: bytes.length });
  },
  deleteObject: async (key: string) => { r2.deletes.push(key); },
}));

const local = { calls: 0 };
vi.mock("@/lib/diarize", () => ({
  runDiarize: async () => {
    local.calls += 1;
    return { ok: true, latencyMs: 1, timing: {}, result: {
      speakers: [{ idx: 0, label: "S1", type: "other", embedding_base64: "L" }],
      transcript_segments: [{ start_ms: 0, end_ms: 1000, speaker_idx: 0 }],
      overlap_windows: [], aggregates: {}, model_versions: {},
    } };
  },
}));

// Two kept regions from a 60 s clip at 16 kHz:
//   A: original 10.0-14.0 s -> trimmed 0.0-4.0 s
//   B: original 30.0-33.0 s -> trimmed 4.0-7.0 s   (14-30 s was dead air, not in the file)
const REGIONS = [
  { start_sample: 160000, end_sample: 224000, trim_start_sample: 0 },
  { start_sample: 480000, end_sample: 528000, trim_start_sample: 64000 },
];
const vad = { status: 200, body: null as unknown, calls: 0, lastForm: null as FormData | null };
const logs: string[] = [];
const fetchCalls: Array<{ url: string; body: unknown }> = [];

beforeEach(() => {
  sqlCalls.length = 0; logs.length = 0; fetchCalls.length = 0;
  r2.puts = []; r2.deletes = []; r2.signed = []; r2.putThrows = false;
  local.calls = 0; vad.calls = 0; vad.status = 200; vad.lastForm = null;
  vad.body = { ok: true, sample_rate: 16000, total_samples: 960000, regions: REGIONS, audio_b64: Buffer.from("WAVBYTES").toString("base64"), vad_model: "silero-vad-5" };
  windowRow = [{ id: "w1", room_day_id: "rd1", start_ms: 0, end_ms: 60_000, clip_r2_key: "c/w1.webm" }];
  process.env.DIARIZE_ENGINE = "pyannoteai";
  process.env.DIARIZE_VAD_TRIM = "1";
  process.env.PYANNOTEAI_API_KEY = "k";
  process.env.PYANNOTEAI_BASE_URL = "https://fake-pyannote.test";
  process.env.DIARIZE_BASE_URL = "https://fake-mini.test";
  process.env.DIARIZE_POLL_INTERVAL_MS = "1"; process.env.DIARIZE_POLL_BUDGET_MS = "40";
  delete (process.env as Record<string, string | undefined>).DIARIZE_TEACHER_LABELS;
  for (const m of ["log", "warn", "error"] as const) {
    vi.spyOn(console, m).mockImplementation((...a: unknown[]) => { logs.push(a.map((x) => (typeof x === "string" ? x : JSON.stringify(x))).join(" ")); });
  }
  vi.stubGlobal("fetch", async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    fetchCalls.push({ url, body: init?.body });
    const reply = (status: number, body: unknown) => ({ ok: status >= 200 && status < 300, status, text: async () => JSON.stringify(body) }) as unknown as Response;
    if (url.includes("/speech_regions")) { vad.calls += 1; vad.lastForm = init?.body as FormData; return reply(vad.status, vad.body); }
    if (url.includes("/embed_speakers")) return reply(200, { ok: true, speakers: [
      { idx: 0, embedding_base64: "E0", clinician_id: DOC.id, label: DOC.label, type: "clinician", confidence: 0.8, source: "auto" },
      { idx: 1, embedding_base64: "E1" },
    ] });
    if (url.includes("/v1/diarize")) return reply(200, { jobId: "job-1" });
    if (url.includes("/v2/jobs")) return reply(200, { items: [{ id: "job-1", model: "precision-3" }], nextCursor: null });
    // pyannote.ai answers in TRIMMED time:
    //   SPEAKER_A 1.0-2.5 s  (inside A)            -> original 11.0-12.5 s
    //   SPEAKER_B 3.0-5.0 s  (ACROSS the A/B join) -> original 13.0-14.0 s AND 30.0-31.0 s
    if (url.includes("/v1/jobs/")) return reply(200, { jobId: "job-1", status: "succeeded", output: { diarization: [
      { start: 1.0, end: 2.5, speaker: "SPEAKER_A" },
      { start: 3.0, end: 5.0, speaker: "SPEAKER_B" },
    ] } });
    throw new Error(`unexpected fetch ${url}`);
  });
});
afterEach(() => {
  vi.unstubAllGlobals(); vi.restoreAllMocks();
  for (const k of ["DIARIZE_ENGINE", "DIARIZE_VAD_TRIM", "DIARIZE_TEACHER_LABELS", "DIARIZE_BASE_URL", "PYANNOTEAI_BASE_URL"]) delete (process.env as Record<string, string | undefined>)[k];
});

const runStep = async (step: string, progress: Record<string, unknown> = {}) => {
  const { diarizeWindowKind } = await import("@/lib/jobs/kinds/diarize-window");
  return diarizeWindowKind.run({ job: {} as never, step, args: { window_id: "w1" }, progress });
};
const submitted = async () => {
  const out = await runStep("diarize");
  if (out.kind !== "next") throw new Error(`expected next, got ${out.kind}`);
  return out.progress;
};

describe("the submit step with the trim on", () => {
  it("uploads the speech-only file and hands pyannote.ai THAT, not the clip", async () => {
    const p = await submitted();
    expect(r2.puts).toEqual([{ key: "vad-trim/w1/" + String(p.run_id) + ".wav", type: "audio/wav", len: 8 }]);
    expect(r2.signed).toEqual([`vad-trim/w1/${p.run_id}.wav`]);           // the trim, not c/w1.webm
    const submit = fetchCalls.find((c) => c.url.includes("/v1/diarize"))!;
    expect(String(JSON.parse(String(submit.body)).url)).toContain("vad-trim/w1/");
  });

  it("records the TRIMMED length as what we pay for, with the original beside it", async () => {
    const p = await submitted();
    expect(p.audio_seconds_sent).toBe(7);          // 4 s + 3 s of speech
    expect(p.original_audio_seconds).toBe(60);
    expect((p.vad_trim as { speech_s: number }).speech_s).toBe(7);
  });

  it("sends the Mini the configured params", async () => {
    await submitted();
    expect(vad.lastForm!.get("pad_s")).toBe("0.4");
    expect(vad.lastForm!.get("merge_gap_s")).toBe("1.5");
    expect(vad.lastForm!.get("min_region_s")).toBe("0.5");
  });

  it("A REAL ANSWER OF NO SPEECH skips the paid call and says so", async () => {
    vad.body = { ok: true, sample_rate: 16000, total_samples: 960000, regions: [], vad_model: "silero-vad-5" };
    const out = await runStep("diarize");
    expect(out.kind).toBe("done");
    expect(fetchCalls.some((c) => c.url.includes("/v1/diarize"))).toBe(false);
    const ins = sqlCalls.find((c) => /INSERT INTO room_diarize_window/.test(c.text))!;
    const engine = JSON.parse(String(ins.values.find((v) => typeof v === "string" && v.includes('"engine"')))).engine;
    expect(engine).toMatchObject({ attribution: "none", audio_seconds_sent: 0, skipped: "silent_window:vad_trim" });
  });

  for (const [name, setup, why] of [
    ["an unreachable VAD", () => { vad.status = 503; }, "vad_failed"],
    ["a malformed map", () => { vad.body = { ok: true, sample_rate: 16000, total_samples: 960000, regions: [REGIONS[1], REGIONS[0]], audio_b64: "QQ==" }; }, "vad_bad_map"],
    ["an ok:false answer", () => { vad.body = { ok: false, error: "silero missing" }; }, "vad_bad_response"],
    ["a failed upload", () => { r2.putThrows = true; }, "upload_failed"],
  ] as const) {
    it(`${name} SENDS THE WHOLE CLIP — "could not trim" is never "nothing to hear"`, async () => {
      setup();
      const p = await submitted();
      expect(r2.signed).toEqual(["c/w1.webm"]);                       // the original clip
      expect(p.audio_seconds_sent).toBe(60);
      expect(p.vad_trim).toBeUndefined();
      expect(p.vad_trim_skipped).toBe(why);
    });
  }

  it("with the flag OFF the Mini is not asked and the whole clip goes, exactly as before", async () => {
    delete (process.env as Record<string, string | undefined>).DIARIZE_VAD_TRIM;
    const p = await submitted();
    expect(vad.calls).toBe(0);
    expect(r2.puts).toEqual([]);
    expect(r2.signed).toEqual(["c/w1.webm"]);
    expect(p.audio_seconds_sent).toBe(60);
  });

  it("the speech-only audio never reaches a log line", async () => {
    await submitted();
    const b64 = Buffer.from("WAVBYTES").toString("base64");
    for (const l of logs) expect(l).not.toContain(b64);
  });
});

describe("the poll step puts pyannote.ai's answer back on the original clock", () => {
  it("a segment across the join is stored SPLIT, in original time, never stretched", async () => {
    const p = await submitted();
    const out = await runStep("pyannote_poll", p);
    expect(out.kind).toBe("done");
    const ins = sqlCalls.find((c) => /INSERT INTO room_diarize_window/.test(c.text))!;
    const segs = JSON.parse(String(ins.values.find((v) => typeof v === "string" && v.includes('"speaker_idx"')))) as Array<{ start_ms: number; end_ms: number; speaker_idx: number }>;
    expect(segs.map((s) => [s.start_ms, s.end_ms, s.speaker_idx])).toEqual([
      [11000, 12500, 0],     // SPEAKER_A, inside region A
      [13000, 14000, 1],     // SPEAKER_B, the part in A
      [30000, 31000, 1],     // SPEAKER_B, the part in B
    ]);
    // Nothing is placed in the removed dead air (14-30 s), and trimmed time never leaks through.
    for (const s of segs) expect(s.start_ms >= 14000 && s.end_ms <= 30000).toBe(false);
    expect(segs.some((s) => s.start_ms === 3000 && s.end_ms === 5000)).toBe(false);
  });

  it("the embeddings are asked for ORIGINAL-time spans, on the original clip", async () => {
    const p = await submitted();
    await runStep("pyannote_poll", p);
    const embed = fetchCalls.find((c) => c.url.includes("/embed_speakers"))!;
    const sent = JSON.parse(String((embed.body as FormData).get("speakers")));
    // SPEAKER_B's longest piece is 1.0 s either way; the first (13.0-14.0) wins the tie.
    expect(sent).toEqual([
      { idx: 0, start_s: 11, end_s: 12.5, total_speech_sec: 1.5 },
      { idx: 1, start_s: 13, end_s: 14, total_speech_sec: 2 },
    ]);
  });

  it("the teacher label is stored in original time, with the TRIMMED seconds as the paid length", async () => {
    process.env.DIARIZE_TEACHER_LABELS = "1";
    const p = await submitted();
    await runStep("pyannote_poll", p);
    const lab = sqlCalls.find((c) => /INSERT INTO diarize_window_label/.test(c.text))!;
    const json = String(lab.values.find((v) => typeof v === "string" && v.includes("speaker_idx")));
    expect(json).toContain('"start_ms":30000');
    expect(json).not.toContain('"start_ms":3000,');
    expect(lab.values).toContain(7);           // audio_seconds: what pyannote.ai was sent
  });

  it("the provenance says the trim applied, with its evidence", async () => {
    const p = await submitted();
    await runStep("pyannote_poll", p);
    const ins = sqlCalls.find((c) => /INSERT INTO room_diarize_window/.test(c.text))!;
    const engine = JSON.parse(String(ins.values.find((v) => typeof v === "string" && v.includes('"engine"')))).engine;
    expect(engine.audio_seconds_sent).toBe(7);
    expect(engine.vad_trim).toMatchObject({ applied: true, regions: 2, speech_s: 7, original_s: 60, vad_model: "silero-vad-5" });
  });

  it("the speech-only file is DELETED when the job finishes", async () => {
    const p = await submitted();
    await runStep("pyannote_poll", p);
    expect(r2.deletes).toEqual([`vad-trim/w1/${p.run_id}.wav`]);
  });

  it("…and when pyannote.ai fails and the window falls back to local", async () => {
    const p = await submitted();
    vi.stubGlobal("fetch", async (input: string | URL | Request) => {
      const url = typeof input === "string" ? input : input.toString();
      return { ok: true, status: 200, text: async () => JSON.stringify(url.includes("/v1/jobs/") ? { status: "failed" } : {}) } as unknown as Response;
    });
    const out = await runStep("pyannote_poll", p);
    expect(out.kind).toBe("done");
    expect(local.calls).toBe(1);
    expect(r2.deletes).toEqual([`vad-trim/w1/${p.run_id}.wav`]);
  });

  it("a remap that lands nothing falls back to local rather than storing an empty window", async () => {
    const p = await submitted();
    vi.stubGlobal("fetch", async (input: string | URL | Request) => {
      const url = typeof input === "string" ? input : input.toString();
      // every segment beyond the 7 s trimmed file: inside no region
      const body = url.includes("/v1/jobs/") ? { status: "succeeded", output: { diarization: [{ start: 50, end: 55, speaker: "X" }] } } : {};
      return { ok: true, status: 200, text: async () => JSON.stringify(body) } as unknown as Response;
    });
    const out = await runStep("pyannote_poll", p);
    expect(out.kind).toBe("done");
    expect(local.calls).toBe(1);
    if (out.kind !== "done") throw new Error("x");
    expect(out.result.fallback_reason).toBe("vad_trim_remap_empty");
    expect(r2.deletes).toHaveLength(1);
  });

  it("a poll that is still running keeps the file — it is still needed", async () => {
    const p = await submitted();
    vi.stubGlobal("fetch", async () => ({ ok: true, status: 200, text: async () => JSON.stringify({ status: "running" }) }) as unknown as Response);
    const out = await runStep("pyannote_poll", p);
    expect(out.kind).toBe("next");
    expect(r2.deletes).toEqual([]);
  });

  it("an untrimmed submission is not remapped", async () => {
    delete (process.env as Record<string, string | undefined>).DIARIZE_VAD_TRIM;
    const p = await submitted();
    await runStep("pyannote_poll", p);
    const ins = sqlCalls.find((c) => /INSERT INTO room_diarize_window/.test(c.text))!;
    const segs = JSON.parse(String(ins.values.find((v) => typeof v === "string" && v.includes('"speaker_idx"')))) as Array<{ start_ms: number }>;
    expect(segs.map((s) => s.start_ms)).toEqual([1000, 3000]);    // pyannote.ai's own times, untouched
    expect(r2.deletes).toEqual([]);
  });
});

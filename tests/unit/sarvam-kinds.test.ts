/**
 * S8A / S8A-FIX — the job kinds sarvam_transcribe and sarvam_translate. Everything external is mocked: sql, R2, the Sarvam gateway client, the lab store.
 * No network, no secret, no real audio (synthetic container headers carry the durations). Asserts the step machine, the R2 result object, that no text
 * reaches `progress` or `result`, the consult-only scope, the measured duration, idempotent submit, per-chunk resume and the ledger / lane lines.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { webm, wav } from "./helpers/audio-fixtures";

type Row = Record<string, unknown>;
const statements: Array<{ text: string; values: unknown[] }> = [];
let answer: (text: string, values: unknown[]) => unknown = () => [];
vi.mock("@/lib/db", () => {
  const sql = (strings: TemplateStringsArray, ...values: unknown[]) => {
    const text = strings.join("?");
    statements.push({ text, values });
    const out = answer(text, values);
    return out instanceof Error ? Promise.reject(out) : Promise.resolve(out);
  };
  sql.transaction = async () => [];
  return { sql, db: {} };
});

const store = new Map<string, Uint8Array>();
let headType = "audio/webm";
let failPut = false;
vi.mock("@/lib/r2", async (orig) => ({
  ...((await orig()) as object),
  getObjectBytes: vi.fn(async (k: string) => store.get(k) ?? null),
  putObjectBytes: vi.fn(async (k: string, b: Uint8Array) => { if (failPut) throw new Error("r2_down"); store.set(k, b); }),
  headObject: vi.fn(async () => ({ content_type: headType })),
}));

const gw = { init: vi.fn(), upload: vi.fn(), startJob: vi.fn(), status: vi.fn(), result: vi.fn(), translate: vi.fn() };
vi.mock("@/lib/sarvam-gw", async (orig) => ({
  ...((await orig()) as object),
  gwBatchInit: (...a: unknown[]) => gw.init(...a),
  gwBatchUpload: (...a: unknown[]) => gw.upload(...a),
  gwBatchStartJob: (...a: unknown[]) => gw.startJob(...a),
  gwBatchStatus: (...a: unknown[]) => gw.status(...a),
  gwBatchResult: (...a: unknown[]) => gw.result(...a),
  gwTranslateChunk: (...a: unknown[]) => gw.translate(...a),
}));

const T = await import("@/lib/jobs/kinds/sarvam-transcribe");
const X = await import("@/lib/jobs/kinds/sarvam-translate");
const C = await import("@/lib/jobs/kinds/sarvam-common");
const L = await import("@/lib/sarvam-lab");
const { JOB_KINDS, KIND_BY_NAME } = await import("@/lib/jobs/kinds");
const { JOB_ERROR_CODES } = await import("@/lib/jobs/errors");

const GW_ENV = { SARVAM_GCP_SA_KEY_JSON: "{}", SARVAM_GW_AUDIENCE: "1", SARVAM_GW_ROLE_ARN: "arn", SARVAM_GW_BASE_URL: "https://gw.example.test", SARVAM_GW_REGION: "ap-south-1" };
const savedEnv: Record<string, string | undefined> = {};
const JOB = { id: "job_t1", actor: "mcp:test", created_at: "2026-10-08T06:00:00.000Z" } as never;
const ctx = (step: string, args: Row, progress: Row = {}) => ({ job: JOB, step, args, progress }) as never;
const json = (key: string) => JSON.parse(Buffer.from(store.get(key)!).toString("utf8"));

// in-memory lab store (the R2 bucket eta-lab-results)
const lab = new Map<string, { body: string; etag: string }>();
let labPuts: Array<{ key: string; cond: Row }> = [];
let force412 = 0;
let labDown = false;
const labStore: import("@/lib/sarvam-lab").LabStore = {
  async get(k) { if (labDown) throw new Error("down"); const o = lab.get(k); return o ? { body: o.body, etag: o.etag } : null; },
  async put(k, body, cond) {
    if (labDown) throw new Error("down");
    labPuts.push({ key: k, cond });
    if (force412 > 0) { force412--; return "precondition_failed"; }
    const cur = lab.get(k);
    if (cond.ifNoneMatch && cur) return "precondition_failed";
    if (cond.ifMatch && cur?.etag !== cond.ifMatch) return "precondition_failed";
    lab.set(k, { body, etag: `"e${labPuts.length}"` });
    return "ok";
  },
  async list(prefix) { return [...lab.keys()].filter((k) => k.startsWith(prefix)); },
};
const ledgerLines = (): Row[] => [...lab.entries()].filter(([k]) => k.startsWith("sarvam/ledger/")).flatMap(([, v]) => v.body.split("\n").filter(Boolean).map((l) => JSON.parse(l) as Row));
const lane = (): Row => JSON.parse(lab.get("lanes/sarvam-scribe-mcp.json")!.body);

beforeEach(() => {
  statements.length = 0; store.clear(); lab.clear(); labPuts = []; force412 = 0; labDown = false; failPut = false;
  headType = "audio/webm"; answer = () => [];
  for (const k of Object.keys(GW_ENV)) { savedEnv[k] = process.env[k]; process.env[k] = (GW_ENV as Record<string, string>)[k]; }
  Object.values(gw).forEach((f) => f.mockReset());
  T.sarvamTiming.pollStepMs = 0; T.sarvamTiming.pollIntervalMs = 0; T.sarvamTiming.translateStepMs = 60_000;
  L.setLabStoreForTests(labStore);
});
afterEach(() => {
  for (const [k, v] of Object.entries(savedEnv)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  vi.useRealTimers();
  L.setLabStoreForTests(null);
});

/** a 10-minute webm whose container says so */
const clip10 = () => webm({ declaredMs: 600_000 });

describe("registration", () => {
  it("both kinds are registered with invoke scope, and their error codes are published", () => {
    for (const n of ["sarvam_transcribe", "sarvam_translate"]) {
      expect(KIND_BY_NAME.get(n)?.scope, n).toBe("invoke");
      expect(JOB_KINDS.some((k) => k.name === n)).toBe(true);
    }
    for (const c of ["sarvam_gateway_not_configured", "sarvam_daily_cap", "sarvam_submit_failed", "sarvam_job_failed", "sarvam_timeout", "sarvam_result_failed", "sarvam_translate_failed", "source_not_found", "source_ambiguous", "window_too_long", "result_write_failed", "scope_consult_only", "consult_index_unavailable", "duration_unknown"]) {
      expect(JOB_ERROR_CODES as readonly string[]).toContain(c);
    }
  });
});

describe("A1 — only an encounter or a consult clip", () => {
  const P = T.parseSarvamTranscribeArgs;
  it("accepts {encounter_id} and {consult_uid}; defaults; options", () => {
    expect(P({ encounter_id: "enc_1" })).toEqual({ source: "encounter", encounter_id: "enc_1", mode: "transcribe", english: true });
    expect(P({ consult_uid: "cu_9", mode: "codemix", english: false, num_speakers: 3 })).toEqual({ source: "consult", consult_uid: "cu_9", mode: "codemix", english: false, num_speakers: 3 });
  });
  it("every room / session / window argument is scope_consult_only — alone or with a valid source", () => {
    for (const bad of [{ room: "opd-1" }, { from: "2026-10-08 09:00" }, { to: "2026-10-08 09:10" }, { session_id: "bs_1" }, { from_ms: 0 }, { to_ms: 1000 }, { bench_window_id: "bw_1" },
      { room: "opd-1", from: "2026-10-08 09:00", to: "2026-10-08 09:10" }, { session_id: "bs_1", from_ms: 0, to_ms: 60_000 }]) {
      expect(() => P(bad), JSON.stringify(bad)).toThrow(/^scope_consult_only/);
      expect(() => P({ encounter_id: "enc_1", ...bad }), JSON.stringify(bad)).toThrow(/^scope_consult_only/);
    }
  });
  it("exactly one source; bad options and unknown keys are refused", () => {
    expect(() => P({})).toThrow(/exactly one source/);
    expect(() => P({ encounter_id: "e", consult_uid: "c" })).toThrow(/exactly one source/);
    expect(() => P({ encounter_id: "e", num_speakers: 7 })).toThrow();
    expect(() => P({ encounter_id: "e", mode: "translate" })).toThrow();
    expect(() => P({ encounter_id: "e", surprise: 1 })).toThrow();
  });
});

describe("sarvam_transcribe: prepare", () => {
  const run = (args: Row, progress: Row = {}) => T.sarvamTranscribeKind.run(ctx("prepare", args, progress));
  const enc = { source: "encounter", encounter_id: "enc_1", mode: "transcribe", english: true };

  it("not configured -> sarvam_gateway_not_configured, nothing read", async () => {
    process.env.SARVAM_GW_REGION = "";
    expect(await run(enc)).toEqual({ kind: "fail", error: "sarvam_gateway_not_configured" });
    expect(statements.filter((s) => /encounter/.test(s.text))).toEqual([]);
  });
  it("a consult uid answers consult_index_unavailable (the resolver is not wired)", async () => {
    expect(await run({ source: "consult", consult_uid: "cu_9", mode: "transcribe", english: true })).toEqual({ kind: "fail", error: "consult_index_unavailable" });
  });
  it("today's minutes at the cap -> sarvam_daily_cap", async () => {
    answer = (text) => (/FROM audit_log/.test(text) ? [{ minutes: 240 }] : []);
    expect(await run(enc)).toEqual({ kind: "fail", error: "sarvam_daily_cap" });
  });
  it("an encounter: its audio object and content type, scope and ref recorded; the DATABASE duration is not even selected", async () => {
    answer = (text) => (/FROM encounter/.test(text) ? [{ audio_object_key: "enc/enc_1.webm" }] : []);
    headType = "audio/ogg";
    expect(await run(enc)).toEqual({ kind: "next", step: "init", progress: { clip_key: "enc/enc_1.webm", content_type: "audio/ogg", scope: "encounter", ref: "enc_1", source_kind: "encounter" } });
    expect(statements.find((s) => /FROM encounter/.test(s.text))!.text).not.toMatch(/duration/);
    answer = () => [];
    expect(await run(enc)).toEqual({ kind: "fail", error: "source_not_found" });
    answer = (text) => (/FROM encounter/.test(text) ? [{ audio_object_key: null }] : []);
    expect(await run(enc)).toEqual({ kind: "fail", error: "no_audio_in_range" });
  });
});

describe("sarvam_transcribe: init (F2 measured duration, G3 cap, G2 persisted id)", () => {
  const enc = { source: "encounter", encounter_id: "enc_1", mode: "codemix", english: true, num_speakers: 2 };
  const init = (progress: Row = { clip_key: "clip.webm", content_type: "audio/webm", scope: "encounter", ref: "enc_1" }) => T.sarvamTranscribeKind.run(ctx("init", enc, progress));
  const auditAndReserved = (audit: number, reserved: number) => (text: string) => (/FROM audit_log/.test(text) ? [{ minutes: audit }] : /FROM scribe_job/.test(text) ? [{ minutes: reserved }] : []);

  it("measures the duration from the container, creates the Sarvam job, and PERSISTS its id and the measured duration", async () => {
    store.set("clip.webm", clip10());
    gw.init.mockResolvedValue({ ok: true, jobId: "sj_9" });
    const out = await init();
    expect(gw.init).toHaveBeenCalledWith(expect.objectContaining({ mode: "codemix", numSpeakers: 2 }));
    expect(out).toMatchObject({ kind: "next", step: "upload", progress: { sarvam_job_id: "sj_9", duration_ms: 600_000, clip_key: "clip.webm", scope: "encounter", ref: "enc_1" } });
    expect((out as { progress: Row }).progress.started_at).toEqual(expect.any(String));
  });

  it("a NULL / missing / understated database duration cannot matter: an unreadable container is duration_unknown, a long one window_too_long", async () => {
    store.set("clip.webm", new TextEncoder().encode("this is not audio and carries no duration at all"));
    expect(await init()).toEqual({ kind: "fail", error: "duration_unknown" });
    store.set("clip.webm", webm({ declaredMs: 31 * 60_000 }));
    expect(await init()).toEqual({ kind: "fail", error: "window_too_long" });
    store.set("clip.webm", webm({ declaredMs: 30 * 60_000 }));
    gw.init.mockResolvedValue({ ok: true, jobId: "sj_1" });
    expect(await init()).toMatchObject({ kind: "next", progress: { duration_ms: 1_800_000 } });
    // the client says 60 s, the audio is 2 hours: refused, not charged 1 minute
    store.set("clip.webm", webm({ clusters: Array.from({ length: 1440 }, (_, i) => ({ tc: i * 5_000, blocksRel: [0] })) }));
    expect(await init()).toEqual({ kind: "fail", error: "window_too_long" });
    // wav works too
    store.set("clip.webm", wav(90));
    expect(await init()).toMatchObject({ kind: "next", progress: { duration_ms: 90_000 } });
  });

  it("the cap charges the MEASURED minutes together with today's audited minutes and EARLIER unaudited jobs", async () => {
    store.set("clip.webm", clip10());
    gw.init.mockResolvedValue({ ok: true, jobId: "sj_9" });
    answer = auditAndReserved(200, 29); // 200 + 29 + 10 = 239 <= 240
    expect(await init()).toMatchObject({ kind: "next", step: "upload" });
    answer = auditAndReserved(200, 31); // 241 > 240
    expect(await init()).toMatchObject({ kind: "fail", error: expect.stringMatching(/^sarvam_daily_cap: today 200 \+ reserved 31 \+ this 10 min$/) });
    // only jobs created BEFORE this one count (two racing jobs cannot refuse each other), and only those not yet audited
    const q = statements.find((s) => /FROM scribe_job/.test(s.text))!;
    expect(q.text).toMatch(/created_at < \?::timestamptz OR \(created_at = \?::timestamptz AND id < \?::text\)/);
    expect(q.text).toMatch(/IN \('prepare', 'init', 'upload', 'start'\)/);
    expect(q.values).toContain("job_t1");
    expect(q.values).toContain("2026-10-08T06:00:00.000Z");
  });

  it("G2: with the Sarvam job id already persisted, a replay creates NO second job and reads no audio", async () => {
    const out = await init({ clip_key: "clip.webm", sarvam_job_id: "sj_prev", duration_ms: 600_000 });
    expect(out).toMatchObject({ kind: "next", step: "upload", progress: { sarvam_job_id: "sj_prev" } });
    expect(gw.init).not.toHaveBeenCalled();
  });

  it("G4: a transient init failure THROWS (retried under MAX_FAILURES); a terminal one fails the job by code", async () => {
    store.set("clip.webm", clip10());
    gw.init.mockResolvedValue({ ok: false, error: "init_503", status: 503, transient: true });
    await expect(init()).rejects.toThrow(/sarvam_submit_failed: init_503/);
    gw.init.mockResolvedValue({ ok: false, error: "init_400", status: 400, transient: false });
    expect(await init()).toEqual({ kind: "fail", error: "sarvam_submit_failed: init_400" });
    expect(await init({})).toMatchObject({ kind: "fail" });
    store.delete("clip.webm");
    expect(await init()).toEqual({ kind: "fail", error: "clip_missing_in_r2" });
  });
});

describe("sarvam_transcribe: upload / start (G2 idempotent)", () => {
  const args = { source: "encounter", encounter_id: "enc_1", mode: "transcribe", english: true };
  const prog = { clip_key: "clip.webm", content_type: "audio/webm", sarvam_job_id: "sj_9", duration_ms: 600_000, scope: "encounter", ref: "enc_1", started_at: "2026-10-08T06:00:00.000Z" };
  const step = (name: string, progress: Row = prog) => T.sarvamTranscribeKind.run(ctx(name, args, progress));
  const auditInserts = () => statements.filter((s) => /INSERT INTO audit_log/.test(s.text));

  it("upload sends the stored clip for the persisted Sarvam job; transient throws; terminal fails with a failed ledger line", async () => {
    store.set("clip.webm", clip10());
    gw.upload.mockResolvedValue({ ok: true });
    expect(await step("upload")).toMatchObject({ kind: "next", step: "start" });
    expect(gw.upload).toHaveBeenCalledWith("sj_9", expect.any(Uint8Array), "audio/webm");
    gw.upload.mockResolvedValue({ ok: false, error: "azure_put_503", status: 503, transient: true });
    await expect(step("upload")).rejects.toThrow(/sarvam_submit_failed/);
    expect(ledgerLines()).toEqual([]);
    gw.upload.mockResolvedValue({ ok: false, error: "upload_links_403", status: 403, transient: false });
    expect(await step("upload")).toEqual({ kind: "fail", error: "sarvam_submit_failed: upload_links_403" });
    expect(ledgerLines()).toEqual([expect.objectContaining({ job_id: "job_t1", request_id: "sj_9", status: "failed", http_status: 403, task: "transcribe", mode: "batch", scope: "encounter", ref: "enc_1" })]);
  });

  it("start: a Pending job is started and ONE audit row is written with the scope; the next claim does not start or audit again", async () => {
    gw.status.mockResolvedValue({ ok: true, state: "Pending", outputs: [] });
    gw.startJob.mockResolvedValue({ ok: true });
    const out = await step("start");
    expect(gw.startJob).toHaveBeenCalledWith("sj_9");
    expect(out).toMatchObject({ kind: "next", step: "poll", progress: { sarvam_job_id: "sj_9" } });
    expect((out as { progress: Row }).progress.sarvam_started_ms).toEqual(expect.any(Number));
    const meta = JSON.parse(auditInserts()[0]!.values.find((v) => typeof v === "string" && v.startsWith("{")) as string);
    expect(meta).toMatchObject({ engine: "sarvam-gw", job_id: "job_t1", sarvam_job_id: "sj_9", scope: "encounter", audio_minutes: 10, estimated_cost_usd: null });
    // replay after the start succeeded (Sarvam shows it Running; the audit row exists)
    statements.length = 0;
    gw.startJob.mockClear();
    gw.status.mockResolvedValue({ ok: true, state: "Running", outputs: [] });
    answer = (text) => (/SELECT 1 AS one FROM audit_log/.test(text) ? [{ one: 1 }] : []);
    expect(await step("start")).toMatchObject({ kind: "next", step: "poll" });
    expect(gw.startJob).not.toHaveBeenCalled();
    expect(auditInserts()).toEqual([]);
  });

  it("start: the rate comes from stt_engine when a row exists; a transient start failure throws, a terminal one fails", async () => {
    gw.status.mockResolvedValue({ ok: true, state: "Pending", outputs: [] });
    gw.startJob.mockResolvedValue({ ok: true });
    answer = (text) => (/FROM stt_engine/.test(text) ? [{ id: "sarvam", cost_per_min_usd: "0.0100" }] : []);
    await step("start");
    expect(JSON.parse(auditInserts()[0]!.values.find((v) => typeof v === "string" && v.startsWith("{")) as string)).toMatchObject({ cost_per_min_usd: 0.01, estimated_cost_usd: 0.1, rate_source: "sarvam" });
    gw.startJob.mockResolvedValue({ ok: false, error: "start_429", status: 429, transient: true });
    await expect(step("start")).rejects.toThrow(/sarvam_submit_failed/);
    gw.startJob.mockResolvedValue({ ok: false, error: "start_400", status: 400, transient: false });
    expect(await step("start")).toEqual({ kind: "fail", error: "sarvam_submit_failed: start_400" });
  });
});

describe("sarvam_transcribe: poll / finish / ledger", () => {
  const args = { source: "encounter", encounter_id: "enc_1", mode: "transcribe", english: true };
  const polling = { sarvam_job_id: "sj_9", sarvam_started_ms: Date.now(), clip_key: "clip.webm", duration_ms: 600_000, scope: "encounter", ref: "enc_1", started_at: "2026-10-08T06:00:00.000Z" };
  const poll = (progress: Row = polling) => T.sarvamTranscribeKind.run(ctx("poll", args, progress));

  it("poll: Completed -> finish; Failed -> sarvam_job_failed + a failed ledger line; running -> poll again; a 429 marks throttled", async () => {
    gw.status.mockResolvedValueOnce({ ok: true, state: "Completed", outputs: ["0.json"] });
    expect(await poll()).toMatchObject({ kind: "next", step: "finish", progress: { outputs: ["0.json"], sarvam_job_id: "sj_9" } });
    gw.status.mockResolvedValue({ ok: true, state: "Running", outputs: [] });
    expect(await poll()).toMatchObject({ kind: "next", step: "poll" });
    gw.status.mockResolvedValue({ ok: false, error: "status_429", status: 429, transient: true });
    expect(await poll()).toMatchObject({ kind: "next", step: "poll", progress: { throttled: true } });
    gw.status.mockResolvedValueOnce({ ok: true, state: "Failed", outputs: [] });
    expect(await poll()).toEqual({ kind: "fail", error: "sarvam_job_failed: job_failed" });
    expect(ledgerLines().at(-1)).toMatchObject({ status: "failed", request_id: "sj_9" });
  });

  it("poll: gives up 30 minutes after the start (failed ledger line); no outputs is a result failure", async () => {
    gw.status.mockResolvedValue({ ok: true, state: "Running", outputs: [] });
    expect(await poll({ ...polling, sarvam_started_ms: Date.now() - 31 * 60_000 })).toEqual({ kind: "fail", error: "sarvam_timeout: timeout" });
    expect(await poll({})).toMatchObject({ kind: "fail" });
    gw.status.mockResolvedValueOnce({ ok: true, state: "Completed", outputs: [] });
    expect(await poll()).toEqual({ kind: "fail", error: "sarvam_result_failed: no_outputs" });
  });

  const entries = [
    { transcript: "namaste doctor", start: 0, end: 4.5, speakerId: "0" },
    { transcript: "bukhar hai", start: 5, end: 8, speakerId: "1" },
  ];
  const fin = { ...polling, outputs: ["0.json"] };
  const finish = (a: Row = args, progress: Row = fin) => T.sarvamTranscribeKind.run(ctx("finish", a, progress));

  it("finish: R2 object with speaker-labelled entries + ONE ok ledger line in the contract shape; non-English + english -> translate", async () => {
    gw.result.mockResolvedValue({ ok: true, transcript: "namaste doctor bukhar hai", languageCode: "hi-IN", entries });
    const out = await finish();
    expect(out).toMatchObject({ kind: "next", step: "translate", progress: { total_entries: 2, language_code: "hi-IN" } });
    expect(JSON.stringify((out as { progress: Row }).progress)).not.toContain("namaste");
    expect(json("mcp-sarvam/job_t1.json")).toEqual({
      language_code: "hi-IN", duration_s: 600, speakers: ["0", "1"], transcript: "namaste doctor bukhar hai",
      entries: [{ speaker_id: "0", start_s: 0, end_s: 4.5, text: "namaste doctor" }, { speaker_id: "1", start_s: 5, end_s: 8, text: "bukhar hai" }],
    });
    expect(ledgerLines()).toEqual([{
      caller: "scribe-mcp", machine: "vercel", job_id: "job_t1", request_id: "sj_9", route: "gateway", mode: "batch", task: "transcribe", model: "saaras:v3", audio_s: 600,
      started_at: "2026-10-08T06:00:00.000Z", finished_at: expect.any(String), status: "ok", http_status: 200, throttled: false, scope: "encounter", ref: "enc_1",
    }]);
    expect(JSON.stringify(ledgerLines())).not.toContain("namaste"); // no text in the ledger
  });

  it("finish: english:false -> done now, counts only (no text in the job result)", async () => {
    gw.result.mockResolvedValue({ ok: true, transcript: "namaste doctor bukhar hai", languageCode: "hi-IN", entries });
    const out = await finish({ ...args, english: false });
    expect(out).toEqual({ kind: "done", result: { r2_key: "mcp-sarvam/job_t1.json", entries: 2, speakers: 2, language_code: "hi-IN", duration_s: 600, english: false, transcript_chars: 25, english_chars: 0 } });
    expect(JSON.stringify(out)).not.toContain("namaste");
  });

  it("finish: a language code that says English -> done, no translation call; throttled is carried into the ledger", async () => {
    gw.result.mockResolvedValue({ ok: true, transcript: "hello doctor", languageCode: "en-IN", entries: [{ transcript: "hello doctor", start: 0, end: 2, speakerId: "0" }] });
    const out = await finish(args, { ...fin, throttled: true });
    expect(out).toMatchObject({ kind: "done", result: { english: true, english_chars: 12 } });
    expect(gw.translate).not.toHaveBeenCalled();
    expect(json("mcp-sarvam/job_t1.json")).toMatchObject({ english: "hello doctor", entries: [{ english: "hello doctor" }] });
    expect(ledgerLines()[0]).toMatchObject({ status: "ok", throttled: true });
  });

  it("G7: NO language code -> nothing is assumed from the text; it goes to translation (source auto), plain ASCII included", async () => {
    gw.result.mockResolvedValue({ ok: true, transcript: "bukhar hai doctor sahab", languageCode: null, entries: [{ transcript: "bukhar hai doctor sahab", start: 0, end: 3, speakerId: "0" }] });
    expect(await finish()).toMatchObject({ kind: "next", step: "translate" });
    gw.translate.mockResolvedValue({ ok: true, english: "I have a fever, doctor" });
    const out = await T.sarvamTranscribeKind.run(ctx("translate", args, fin));
    expect(gw.translate).toHaveBeenCalledWith("bukhar hai doctor sahab", null);
    expect(out.kind).toBe("done");
  });

  it("finish: no diarized entries -> one pseudo-entry; a terminal download failure is a named failure with a ledger line; a transient one throws", async () => {
    gw.result.mockResolvedValue({ ok: true, transcript: "namaste", languageCode: "hi-IN", entries: [] });
    expect(await finish()).toMatchObject({ kind: "next", step: "translate", progress: { total_entries: 1 } });
    lab.clear(); // a fresh job: one ledger line per job id
    gw.result.mockResolvedValue({ ok: false, error: "download_links_403", status: 403, transient: false });
    expect(await finish()).toEqual({ kind: "fail", error: "sarvam_result_failed: download_links_403" });
    expect(ledgerLines().at(-1)).toMatchObject({ status: "failed", http_status: 403 });
    gw.result.mockResolvedValue({ ok: false, error: "download_timeout", transient: true });
    await expect(finish()).rejects.toThrow(/sarvam_result_failed/);
  });

  const translate = (progress: Row = fin) => T.sarvamTranscribeKind.run(ctx("translate", args, progress));
  const seed = (entries: Row[]) => store.set("mcp-sarvam/job_t1.json", Buffer.from(JSON.stringify({ language_code: "hi-IN", duration_s: 10, speakers: ["0"], transcript: "t", entries })));

  it("translate: every entry, <= 900 chars per request, the source language passed; done with counts only and an ok text_translate ledger line", async () => {
    seed([{ speaker_id: "0", start_s: 0, end_s: 1, text: "text 0" }, { speaker_id: "0", start_s: 1, end_s: 2, text: "text 1" }]);
    gw.translate.mockImplementation(async (t: string) => ({ ok: true, english: `EN(${t})` }));
    const out = await translate();
    expect(out).toMatchObject({ kind: "done", result: { entries: 2, english: true, language_code: "hi-IN" } });
    expect(gw.translate).toHaveBeenCalledWith("text 0", "hi-IN");
    expect(json("mcp-sarvam/job_t1.json")).toMatchObject({ english: "EN(text 0) EN(text 1)", entries: [{ english: "EN(text 0)" }, { english: "EN(text 1)" }] });
    expect(ledgerLines().at(-1)).toMatchObject({ job_id: "job_t1:translate", task: "text_translate", mode: "sync", model: "mayura:v1", audio_s: 0, chars: 12, status: "ok", scope: "encounter", ref: "enc_1" });
  });

  it("F1: ONE entry of 6 chunks with a tiny step budget resumes mid-entry across claims and never re-sends a translated chunk", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-08T12:00:00Z"));
    T.sarvamTiming.translateStepMs = 1000;
    const text = Array.from({ length: 6 }, (_, i) => `वाक्य ${i}। ` + "क".repeat(480)).join(" ");
    seed([{ speaker_id: "0", start_s: 0, end_s: 9, text }]);
    const sent: string[] = [];
    gw.translate.mockImplementation(async (t: string) => { sent.push(t); vi.setSystemTime(Date.now() + 600); return { ok: true, english: `E${sent.length}` }; });
    let out = await translate();
    let claims = 1;
    expect(out).toMatchObject({ kind: "next", step: "translate" });
    expect(json("mcp-sarvam/job_t1.json").entries[0].parts).toHaveLength(2); // partial English saved inside the entry
    while (out.kind === "next") { out = await translate((out as { progress: Row }).progress); claims++; }
    expect(claims).toBeGreaterThanOrEqual(3);
    expect(sent).toHaveLength(6);
    expect(new Set(sent).size).toBe(6); // no chunk went out twice
    for (const t of sent) expect(t.length).toBeLessThanOrEqual(900);
    expect(json("mcp-sarvam/job_t1.json").entries[0]).toMatchObject({ english: "E1 E2 E3 E4 E5 E6" });
    expect(json("mcp-sarvam/job_t1.json").entries[0].parts).toBeUndefined();
    expect(out).toMatchObject({ kind: "done" });
  });

  it("F1: a failure part-way keeps the chunks already done; the retry resumes after them", async () => {
    const text = Array.from({ length: 3 }, (_, i) => `वाक्य ${i}। ` + "क".repeat(480)).join(" ");
    seed([{ speaker_id: "0", start_s: 0, end_s: 9, text }]);
    gw.translate.mockResolvedValueOnce({ ok: true, english: "one" }).mockResolvedValueOnce({ ok: false, error: "translate_503", status: 503, transient: true });
    await expect(translate()).rejects.toThrow(/sarvam_translate_failed: translate_503/); // G4: transient -> throws
    expect(json("mcp-sarvam/job_t1.json").entries[0].parts).toEqual(["one"]);
    expect(ledgerLines()).toEqual([]); // not finished: no line yet
    gw.translate.mockReset();
    gw.translate.mockImplementation(async () => ({ ok: true, english: "more" }));
    expect((await translate()).kind).toBe("done");
    expect(gw.translate).toHaveBeenCalledTimes(2); // chunks 2 and 3 only
    expect(json("mcp-sarvam/job_t1.json").entries[0].english).toBe("one more more");
  });

  it("G4: a terminal 4xx fails the job with a failed text_translate ledger line; a 429 is transient and throws", async () => {
    seed([{ speaker_id: "0", start_s: 0, end_s: 1, text: "text 0" }]);
    gw.translate.mockResolvedValue({ ok: false, error: "translate_400", status: 400, transient: false });
    expect(await translate()).toEqual({ kind: "fail", error: "sarvam_translate_failed: translate_400" });
    expect(ledgerLines().at(-1)).toMatchObject({ job_id: "job_t1:translate", status: "failed", http_status: 400 });
    gw.translate.mockResolvedValue({ ok: false, error: "translate_429", status: 429, transient: true });
    await expect(translate()).rejects.toThrow(/translate_429/);
  });
});

describe("D — ledger and lane", () => {
  const args = { source: "encounter", encounter_id: "enc_1", mode: "transcribe", english: false };
  const fin = { sarvam_job_id: "sj_9", outputs: ["0.json"], duration_ms: 600_000, scope: "encounter", ref: "enc_1", started_at: "2026-10-08T06:00:00.000Z" };
  const entries = [{ transcript: "hi", start: 0, end: 1, speakerId: "0" }];

  it("one line per job id: a replayed finish writes no second line", async () => {
    gw.result.mockResolvedValue({ ok: true, transcript: "hi", languageCode: "en-IN", entries });
    await T.sarvamTranscribeKind.run(ctx("finish", args, fin));
    await T.sarvamTranscribeKind.run(ctx("finish", args, fin));
    expect(ledgerLines()).toHaveLength(1);
  });

  it("a ledger write that loses the race (412) re-reads and retries; the line lands once", async () => {
    gw.result.mockResolvedValue({ ok: true, transcript: "hi", languageCode: "en-IN", entries });
    force412 = 2;
    await T.sarvamTranscribeKind.run(ctx("finish", args, fin));
    expect(ledgerLines()).toHaveLength(1);
    const keys = labPuts.filter((p) => p.key.startsWith("sarvam/ledger/")).map((p) => p.cond);
    expect(keys).toHaveLength(3);
    expect(keys[0]).toEqual({ ifNoneMatch: true }); // a new object is created only if absent
  });

  it("an existing day file is replaced only with If-Match on its ETag, and the old lines are kept", async () => {
    gw.result.mockResolvedValue({ ok: true, transcript: "hi", languageCode: "en-IN", entries });
    await T.sarvamTranscribeKind.run(ctx("finish", args, fin));
    labPuts = [];
    await T.sarvamTranscribeKind.run({ job: { ...(JOB as object), id: "job_t2" }, step: "finish", args, progress: fin } as never); // another job; the same job id would not be written twice
    expect(ledgerLines()).toHaveLength(2);
    const p = labPuts.find((x) => x.key.startsWith("sarvam/ledger/"))!;
    expect(p.cond).toEqual({ ifMatch: expect.stringMatching(/^"e\d+"$/) });
  });

  it("D4: the lab store failing, or 412 forever, never fails the job; only a code is logged", async () => {
    gw.result.mockResolvedValue({ ok: true, transcript: "hi", languageCode: "en-IN", entries });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    labDown = true;
    expect(await T.sarvamTranscribeKind.run(ctx("finish", args, fin))).toMatchObject({ kind: "done" });
    labDown = false;
    force412 = 99;
    expect(await T.sarvamTranscribeKind.run(ctx("finish", args, fin))).toMatchObject({ kind: "done" });
    const logged = warn.mock.calls.map((c) => String(c[1])).join(" ");
    expect(logged).toMatch(/ledger_write_failed/);
    expect(logged).toMatch(/ledger_412_exhausted/);
    expect(logged).not.toMatch(/hi\b.*transcript/);
    warn.mockRestore();
  });

  it("D3: no lab credentials -> emission is skipped with a logged code and the job still runs", async () => {
    L.setLabStoreForTests(null);
    for (const n of L.LAB_ENV) delete process.env[n];
    gw.result.mockResolvedValue({ ok: true, transcript: "hi", languageCode: "en-IN", entries });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    expect(await T.sarvamTranscribeKind.run(ctx("finish", args, fin))).toMatchObject({ kind: "done" });
    expect(warn.mock.calls.map((c) => String(c[1])).join(" ")).toMatch(/lab_store_not_configured/);
    expect(L.labStoreConfigured()).toBe(false);
    warn.mockRestore();
  });

  it("D2: the lane is rewritten at the end of work (the finishing job excluded) with active jobs from the job rows and today / all_time from the ledger", async () => {
    gw.result.mockResolvedValue({ ok: true, transcript: "hi", languageCode: "en-IN", entries });
    lab.set("sarvam/ledger/scribe-mcp/2026-01-01.jsonl", { body: `${JSON.stringify({ status: "ok", audio_s: 600, throttled: false })}\n${JSON.stringify({ status: "failed", audio_s: 60, throttled: true })}\n`, etag: '"old"' });
    answer = (text) => (/FROM scribe_job/.test(text) && /step <> 'prepare'/.test(text)
      ? [{ id: "job_other", kind: "sarvam_transcribe", step: "poll", duration_ms: "300000", scope: "encounter", started_at: "2026-10-08T06:30:00.000Z", created_at: "2026-10-08T06:00:00.000Z" }, { id: "job_t1", kind: "sarvam_transcribe", step: "finish", duration_ms: "600000", scope: "encounter", started_at: null, created_at: "2026-10-08T06:00:00.000Z" }]
      : []);
    await T.sarvamTranscribeKind.run(ctx("finish", args, fin));
    const l = lane();
    expect(l).toMatchObject({ caller: "scribe-mcp", machine: "vercel", updated_at: expect.any(String) });
    expect(l.active).toEqual([{ job_id: "job_other", mode: "batch", task: "transcribe", model: "saaras:v3", audio_s: 300, started_at: "2026-10-08T06:30:00.000Z", scope: "encounter" }]);
    expect(l.today).toEqual({ jobs: 1, audio_min: 10, failed: 0, throttled: 0 }); // the line this job just wrote
    expect(l.all_time).toEqual({ jobs: 3, audio_min: 20 }); // 2 earlier lines (one ok 10 min, one failed) + today's
    expect(JSON.stringify(l)).not.toMatch(/ref|enc_1|transcript/);
  });

  it("the lane is touched on a non-final step too, but not more than every 20 s", async () => {
    gw.upload.mockResolvedValue({ ok: true });
    store.set("clip.webm", new Uint8Array([1]));
    const prog = { clip_key: "clip.webm", sarvam_job_id: "sj_9", duration_ms: 1000 };
    await T.sarvamTranscribeKind.run(ctx("upload", args, prog));
    expect(labPuts.filter((p) => p.key === "lanes/sarvam-scribe-mcp.json")).toHaveLength(1);
    await T.sarvamTranscribeKind.run(ctx("upload", args, prog));
    expect(labPuts.filter((p) => p.key === "lanes/sarvam-scribe-mcp.json")).toHaveLength(1); // throttled
  });
});

describe("D3 — the allowlist", () => {
  it("writes: only the lane and a ledger day file of this caller; reads: only lanes/ and sarvam/ledger/scribe-mcp/", () => {
    for (const k of ["lanes/sarvam-scribe-mcp.json", "sarvam/ledger/scribe-mcp/2026-10-08.jsonl"]) expect(L.labWritable(k), k).toBe(true);
    for (const k of ["lanes/sarvam-palimpsest.json", "lanes/x.json", "sarvam/ledger/palimpsest/2026-10-08.jsonl", "sarvam/ledger/scribe-mcp/2026-10-08.json", "sarvam/ledger/scribe-mcp/../x.jsonl", "reb/anything.json", "sarvam/ledger/scribe-mcp/latest.jsonl", "", "lanes/sarvam-scribe-mcp.json/x"]) expect(L.labWritable(k), k).toBe(false);
    for (const k of ["lanes/sarvam-palimpsest.json", "lanes/sarvam-scribe-mcp.json", "sarvam/ledger/scribe-mcp/2026-10-08.jsonl", "sarvam/ledger/scribe-mcp/"]) expect(L.labReadable(k), k).toBe(true);
    for (const k of ["reb/x.json", "sarvam/ledger/palimpsest/2026-10-08.jsonl", "sarvam/", "sarvam/ledger/scribe-mcp/../../reb/x", "other/lanes/x.json"]) expect(L.labReadable(k), k).toBe(false);
  });

  it("every store call made by the code stays inside the allowlist (checked on the recorded calls), and a forbidden key never reaches the store", async () => {
    const seen: Array<{ op: string; key: string }> = [];
    const spy: import("@/lib/sarvam-lab").LabStore = {
      get: async (k) => { seen.push({ op: "get", key: k }); return labStore.get(k); },
      put: async (k, b, c) => { seen.push({ op: "put", key: k }); return labStore.put(k, b, c); },
      list: async (p) => { seen.push({ op: "list", key: p }); return labStore.list(p); },
    };
    L.setLabStoreForTests(spy);
    gw.result.mockResolvedValue({ ok: true, transcript: "hi", languageCode: "en-IN", entries: [{ transcript: "hi", start: 0, end: 1, speakerId: "0" }] });
    await T.sarvamTranscribeKind.run(ctx("finish", { source: "encounter", encounter_id: "e", mode: "transcribe", english: false }, { sarvam_job_id: "sj", outputs: ["0.json"], duration_ms: 1000, scope: "encounter", ref: "e" }));
    expect(seen.length).toBeGreaterThan(2);
    for (const s of seen) expect(s.op === "put" ? L.labWritable(s.key) : L.labReadable(s.key), `${s.op} ${s.key}`).toBe(true);
    // the guard sits in front of whatever store is behind it
    seen.length = 0;
    const logged = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    expect(await L.appendLedger({ caller: "scribe-mcp", machine: "vercel", job_id: "j", request_id: null, route: "gateway", mode: "batch", task: "transcribe", model: "m", audio_s: 1, started_at: "2026-13-99T00:00:00Z", finished_at: "not a date", status: "ok", http_status: 200, throttled: false, scope: "encounter", ref: "r" })).toBe(true);
    expect(seen.every((s) => s.key.startsWith("sarvam/ledger/scribe-mcp/"))).toBe(true);
    logged.mockRestore();
  });

  it("tally lines: ok minutes only, failures and throttles counted, torn lines skipped", () => {
    const body = [{ status: "ok", audio_s: 90 }, { status: "ok", audio_s: 30, throttled: true }, { status: "failed", audio_s: 600 }].map((l) => JSON.stringify(l)).join("\n") + "\n{torn";
    expect(L.tallyOf(body)).toEqual({ jobs: 3, audio_min: 2, failed: 1, throttled: 1 });
  });
});

describe("sarvam_translate (A2, F1, G4, G7)", () => {
  const P = X.parseSarvamTranslateArgs;
  const run = (step: string, args: Row, progress: Row = {}) => X.sarvamTranslateKind.run(ctx(step, args, progress));
  const writes = () => statements.filter((s) => /\b(INSERT|UPDATE|DELETE)\b/i.test(s.text));

  it("parseArgs: an encounter or a run; a window or any room / session argument is scope_consult_only", () => {
    expect(P({ encounter_id: "e1" })).toEqual({ kind: "encounter", id: "e1" });
    expect(P({ transcription_run_id: "trun_1" })).toEqual({ kind: "transcription_run", id: "trun_1" });
    expect(() => P({ bench_window_id: "bw_1" })).toThrow(/^scope_consult_only/);
    expect(() => P({ encounter_id: "e1", room: "opd-1" })).toThrow(/^scope_consult_only/);
    expect(() => P({ encounter_id: "e1", session_id: "bs_1" })).toThrow(/^scope_consult_only/);
    expect(() => P({})).toThrow(/exactly one/);
    expect(() => P({ encounter_id: "e", transcription_run_id: "t" })).toThrow(/exactly one/);
    expect(() => P({ encounter_id: "e", x: 1 })).toThrow();
  });

  it("A2: a run is translated only when its subject_type is 'encounter'; a window-subject run is scope_consult_only and nothing is sent", async () => {
    answer = (text) => (/FROM transcription_run WHERE id/.test(text) ? [{ subject_type: "bench_window", transcript_original: "नमस्ते", detected_language: "hi-IN" }] : []);
    expect(await run("prepare", { kind: "transcription_run", id: "trun_w" })).toEqual({ kind: "fail", error: "scope_consult_only: the run's subject is not an encounter" });
    answer = (text) => (/FROM transcription_run WHERE id/.test(text) ? [{ subject_type: "encounter", transcript_original: "नमस्ते", detected_language: "hi-IN" }] : []);
    expect(await run("prepare", { kind: "transcription_run", id: "trun_e" })).toMatchObject({ kind: "next", step: "translate", progress: { scope: "encounter", ref: "run:trun_e" } });
    expect(gw.translate).not.toHaveBeenCalled();
    answer = () => [];
    expect(await run("prepare", { kind: "transcription_run", id: "trun_x" })).toEqual({ kind: "fail", error: "source_not_found" });
    // the SELECT never reaches for a window id
    expect(statements.some((s) => /subject_type = 'bench_window'/.test(s.text))).toBe(false);
  });

  it("encounter: transcript_original first, else transcript_raw; missing / empty / code-says-English finish without a Sarvam call", async () => {
    const enc = (row: Row | null) => (answer = (text) => (/FROM encounter/.test(text) && row ? [row] : []));
    enc({ transcript_original: "नमस्ते डॉक्टर", transcript_raw: "raw", detected_language: "hi-IN" });
    expect(await run("prepare", { kind: "encounter", id: "e1" })).toMatchObject({ kind: "next", step: "translate", progress: { column: "transcript_original", chars_in: 13 } });
    enc({ transcript_original: "  ", transcript_raw: "नमस्ते", detected_language: null });
    expect(await run("prepare", { kind: "encounter", id: "e1" })).toMatchObject({ kind: "next", progress: { column: "transcript_raw" } });
    enc(null);
    expect(await run("prepare", { kind: "encounter", id: "e1" })).toEqual({ kind: "fail", error: "source_not_found" });
    enc({ transcript_original: "", transcript_raw: "", detected_language: "hi-IN" });
    expect(await run("prepare", { kind: "encounter", id: "e1" })).toMatchObject({ kind: "done", result: { reason: "empty_text", chars_in: 0 } });
    enc({ transcript_original: "Patient has fever.", transcript_raw: "", detected_language: "en-IN" });
    expect(await run("prepare", { kind: "encounter", id: "e1" })).toMatchObject({ kind: "done", result: { reason: "already_english", chars_in: 18 } });
    expect(gw.translate).not.toHaveBeenCalled();
    expect(writes()).toEqual([]);
  });

  it("G7: NO language code -> not assumed English, even for plain ASCII (romanised Hindi): it is translated with source auto", async () => {
    answer = (text) => (/FROM encounter/.test(text) ? [{ transcript_original: "mujhe bukhar hai doctor sahab.", transcript_raw: "", detected_language: null }] : []);
    const prep = await run("prepare", { kind: "encounter", id: "e1" });
    expect(prep).toMatchObject({ kind: "next", step: "translate" });
    gw.translate.mockResolvedValue({ ok: true, english: "I have a fever, doctor." });
    expect((await run("translate", { kind: "encounter", id: "e1" }, (prep as { progress: Row }).progress)).kind).toBe("done");
    expect(gw.translate).toHaveBeenCalledWith("mujhe bukhar hai doctor sahab.", null);
  });

  it("needs the gateway only when there is something to translate", async () => {
    process.env.SARVAM_GW_BASE_URL = "";
    answer = (text) => (/FROM encounter/.test(text) ? [{ transcript_original: "Fine.", transcript_raw: "", detected_language: "en" }] : []);
    expect(await run("prepare", { kind: "encounter", id: "e1" })).toMatchObject({ kind: "done" });
    answer = (text) => (/FROM encounter/.test(text) ? [{ transcript_original: "नमस्ते", transcript_raw: "", detected_language: "hi-IN" }] : []);
    expect(await run("prepare", { kind: "encounter", id: "e1" })).toEqual({ kind: "fail", error: "sarvam_gateway_not_configured" });
  });

  it("F1: chunks of <= 900 chars across claims, the English so far saved after EACH chunk, no chunk re-sent; R2 object {source, chars_in, chars_out, english}; only SELECTs on clinical tables; ok ledger line", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-08T12:00:00Z"));
    T.sarvamTiming.translateStepMs = 1000;
    const text = Array.from({ length: 6 }, (_, i) => `वाक्य संख्या ${i}। ` + "क".repeat(480)).join(" ");
    answer = (t2) => (/FROM encounter/.test(t2) ? [{ transcript_original: text, transcript_raw: "", detected_language: "hi-IN" }] : []);
    const args = { kind: "encounter", id: "e1" };
    const prep = await run("prepare", args);
    expect(prep).toMatchObject({ kind: "next", step: "translate", progress: { chunks_total: 6 } });
    expect(JSON.stringify(prep)).not.toContain("वाक्य");
    const sent: string[] = [];
    gw.translate.mockImplementation(async (t: string) => { sent.push(t); vi.setSystemTime(Date.now() + 600); return { ok: true, english: `E${t.length}` }; });
    let out = await run("translate", args, (prep as { progress: Row }).progress);
    let steps = 1;
    expect(json("mcp-sarvam/job_t1.json").parts.length).toBe(2);
    while (out.kind === "next") { out = await run("translate", args, (out as { progress: Row }).progress); steps++; }
    expect(steps).toBeGreaterThan(1);
    expect(new Set(sent).size).toBe(6);
    expect(out).toMatchObject({ kind: "done", result: { r2_key: "mcp-sarvam/job_t1.json", source: { kind: "encounter", id: "e1", column: "transcript_original" }, chars_in: text.length, chunks: 6 } });
    const doc = json("mcp-sarvam/job_t1.json");
    expect(doc.parts).toHaveLength(6);
    expect(doc.chars_out).toBe(doc.english.length);
    for (const t of sent) expect(t.length).toBeLessThanOrEqual(900);
    expect(JSON.stringify(out)).not.toContain("वाक्य");
    expect(writes()).toEqual([]);
    expect(statements.every((s) => /^\s*SELECT/i.test(s.text))).toBe(true);
    expect(ledgerLines().at(-1)).toMatchObject({ job_id: "job_t1", task: "text_translate", mode: "sync", status: "ok", audio_s: 0, chars: text.length, scope: "encounter" });
  });

  it("G4: a transient chunk error throws (the English so far stays saved); a terminal one fails by code; a changed source is named", async () => {
    const args = { kind: "encounter", id: "e1" };
    const orig = Array.from({ length: 3 }, (_, i) => `वाक्य ${i}। ` + "क".repeat(480)).join(" ");
    answer = (t) => (/FROM encounter/.test(t) ? [{ transcript_original: orig, transcript_raw: "", detected_language: "hi-IN" }] : []);
    const prep = await run("prepare", args);
    gw.translate.mockResolvedValueOnce({ ok: true, english: "one" }).mockResolvedValueOnce({ ok: false, error: "translate_429", status: 429, transient: true });
    await expect(run("translate", args, (prep as { progress: Row }).progress)).rejects.toThrow(/translate_429/);
    expect(json("mcp-sarvam/job_t1.json").parts).toEqual(["one"]);
    gw.translate.mockReset();
    gw.translate.mockResolvedValue({ ok: false, error: "translate_400", status: 400, transient: false });
    expect(await run("translate", args, (prep as { progress: Row }).progress)).toEqual({ kind: "fail", error: "sarvam_translate_failed: translate_400" });
    expect(ledgerLines().at(-1)).toMatchObject({ status: "failed", http_status: 400 });
    answer = (t) => (/FROM encounter/.test(t) ? [{ transcript_original: "क".repeat(100), transcript_raw: "", detected_language: "hi-IN" }] : []);
    expect(await run("translate", args, (prep as { progress: Row }).progress)).toEqual({ kind: "fail", error: "sarvam_result_failed: source_changed" });
  });
});

describe("common helpers", () => {
  it("parseWhen / istDayStartIso / looksNonEnglish", () => {
    expect(C.parseWhen("2026-10-08 09:00")).toBe(Date.parse("2026-10-08T09:00:00+05:30"));
    expect(C.parseWhen("2026-10-08T09:00:00")).toBeNull();
    expect(C.istDayStartIso(Date.parse("2026-10-08T20:00:00Z"))).toBe("2026-10-08T18:30:00.000Z");
    expect(C.looksNonEnglish("hello", "en-IN")).toBe(false);
    expect(C.looksNonEnglish("hello", "hi-IN")).toBe(true);
    expect(C.looksNonEnglish("hello", null)).toBe(true); // no code: nothing assumed
    expect(C.looksNonEnglish("hello", "unknown")).toBe(true);
    expect(C.looksNonEnglish("   ", null)).toBe(false); // empty text needs nothing
  });
  it("the cap constant is 240 minutes", () => expect(C.SARVAM_DAILY_CAP_MINUTES).toBe(240));
});

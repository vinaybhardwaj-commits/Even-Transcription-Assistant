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
  C.auditRetry.delaysMs = [0, 0, 0];
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
  it("a consult uid that the index does not hold fails consult_not_indexed (the real index is covered by consult-index-pg.test.ts)", async () => {
    expect(await run({ source: "consult", consult_uid: "cu_9", mode: "transcribe", english: true })).toEqual({ kind: "fail", error: "consult_not_indexed" });
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
  const initNoEn = (progress: Row = { clip_key: "clip.webm", content_type: "audio/webm", scope: "encounter", ref: "enc_1" }) => T.sarvamTranscribeKind.run(ctx("init", { ...enc, english: false }, progress));
  let failedMin = 0;
  const auditAndReserved = (audit: number, reserved: number) => (text: string) => (/j\.progress \? 'en_sarvam_job_id'/.test(text) ? [{ minutes: 0 }] : /j\.progress \? 'sarvam_job_id'/.test(text) ? [{ minutes: failedMin }] : /FROM audit_log/.test(text) ? [{ minutes: audit }] : /FROM scribe_job/.test(text) ? [{ minutes: reserved }] : []);

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
    expect(await initNoEn()).toMatchObject({ kind: "next", step: "upload" });
    answer = auditAndReserved(200, 31); // 241 > 240
    expect(await initNoEn()).toMatchObject({ kind: "fail", error: expect.stringMatching(/^sarvam_daily_cap: today 200 \+ reserved 31 \+ this 10 min$/) });
    // only jobs created BEFORE this one count (two racing jobs cannot refuse each other), and only those not yet audited
    const q = statements.find((s) => /FROM scribe_job/.test(s.text) && !/j\.progress \? 'sarvam_job_id'/.test(s.text))!;
    expect(q.text).toMatch(/created_at < \?::timestamptz OR \(created_at = \?::timestamptz AND id < \?::text\)/);
    expect(q.text).toMatch(/IN \('prepare', 'init', 'upload', 'start'\)/);
    expect(q.values).toContain("job_t1");
    expect(q.values).toContain("2026-10-08T06:00:00.000Z");
  });

  it("G22: a job Sarvam was started for and that has no paid-call row holds its minutes WHATEVER its status (the reservation is part of the cap)", async () => {
    store.set("clip.webm", clip10());
    gw.init.mockResolvedValue({ ok: true, jobId: "sj_9" });
    failedMin = 30;
    answer = auditAndReserved(200, 0); // 200 + 0 + 30 failed-unaudited + 10 = 240
    expect(await initNoEn()).toMatchObject({ kind: "next", step: "upload" });
    failedMin = 31; // 241
    expect(await initNoEn()).toMatchObject({ kind: "fail", error: expect.stringMatching(/^sarvam_daily_cap: today 200 \+ reserved 31 \+ this 10 min$/) });
    const q = statements.find((s) => /j\.progress \? 'sarvam_job_id'/.test(s.text))!;
    expect(q.text).toMatch(/sarvam_started_ms/);
    expect(q.text).not.toMatch(/j\.status = /); // any status
    expect(q.text).toMatch(/NOT EXISTS \(SELECT 1 FROM audit_log/); // once the row lands it is counted as audited minutes, not twice
    failedMin = 0;
  });

  it("S8A4: an English-track job asks the cap for BOTH passes (2 x the measured minutes)", async () => {
    store.set("clip.webm", clip10());
    gw.init.mockResolvedValue({ ok: true, jobId: "sj_9" });
    answer = auditAndReserved(200, 20); // 200 + 20 + 2 x 10 = 240
    expect(await init()).toMatchObject({ kind: "next", step: "upload" });
    answer = auditAndReserved(200, 21); // 241
    expect(await init()).toMatchObject({ kind: "fail", error: expect.stringMatching(/^sarvam_daily_cap: today 200 \+ reserved 21 \+ this 20 min$/) });
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

describe("G10 — a start 4xx on a job that is already running continues instead of failing it", () => {
  const args = { source: "encounter", encounter_id: "enc_1", mode: "transcribe", english: true };
  const prog = { clip_key: "clip.webm", content_type: "audio/webm", sarvam_job_id: "sj_9", duration_ms: 600_000, scope: "encounter", ref: "enc_1", started_at: "2026-10-08T06:00:00.000Z" };
  const start = () => T.sarvamTranscribeKind.run(ctx("start", args, prog));
  const audits = () => statements.filter((s) => /INSERT INTO audit_log/.test(s.text));

  it("the Pending replay: status Pending, start answers 409, Sarvam now shows Running -> poll, one audit row, no failure", async () => {
    gw.status.mockResolvedValueOnce({ ok: true, state: "Pending", outputs: [] }).mockResolvedValueOnce({ ok: true, state: "Running", outputs: [] });
    gw.startJob.mockResolvedValue({ ok: false, error: "start_409", status: 409, transient: false });
    expect(await start()).toMatchObject({ kind: "next", step: "poll" });
    expect(gw.status).toHaveBeenCalledTimes(2);
    expect(audits()).toHaveLength(1);
    expect(ledgerLines()).toEqual([]); // not failed, nothing written yet
  });
  it("a start 4xx while Sarvam still says Pending/Created is a real failure (failed ledger line)", async () => {
    gw.status.mockResolvedValue({ ok: true, state: "Pending", outputs: [] });
    gw.startJob.mockResolvedValue({ ok: false, error: "start_400", status: 400, transient: false });
    expect(await start()).toEqual({ kind: "fail", error: "sarvam_submit_failed: start_400" });
    expect(audits()).toHaveLength(0);
    expect(ledgerLines()).toEqual([expect.objectContaining({ status: "failed", http_status: 400 })]);
    gw.status.mockResolvedValueOnce({ ok: true, state: "Created", outputs: [] }).mockResolvedValueOnce({ ok: false, error: "status_500", status: 500, transient: true });
    lab.clear();
    await expect(start()).rejects.toThrow(/status_500/); // G15: a transient re-check failure is retried, not a verdict
  });
  it("G15: if the recheck after a start 4xx itself fails TRANSIENTLY the step throws (retried under MAX_FAILURES); a terminal recheck failure still fails the job", async () => {
    gw.status.mockResolvedValueOnce({ ok: true, state: "Pending", outputs: [] }).mockResolvedValueOnce({ ok: false, error: "status_503", status: 503, transient: true });
    gw.startJob.mockResolvedValue({ ok: false, error: "start_409", status: 409, transient: false });
    await expect(start()).rejects.toThrow(/sarvam_submit_failed: status_503/);
    expect(ledgerLines()).toEqual([]); // not failed: Sarvam may be running it
    expect(audits()).toHaveLength(0);
    gw.status.mockReset();
    gw.status.mockResolvedValueOnce({ ok: true, state: "Pending", outputs: [] }).mockResolvedValueOnce({ ok: false, error: "status_404", status: 404, transient: false });
    expect(await start()).toEqual({ kind: "fail", error: "sarvam_submit_failed: start_409" });
    expect(ledgerLines()).toEqual([expect.objectContaining({ status: "failed", http_status: 409 })]);
    // and the retry after the throw succeeds once Sarvam answers: Running -> poll, one audit row
    gw.status.mockReset();
    gw.status.mockResolvedValueOnce({ ok: true, state: "Pending", outputs: [] }).mockResolvedValueOnce({ ok: true, state: "Running", outputs: [] });
    lab.clear();
    expect(await start()).toMatchObject({ kind: "next", step: "poll" });
    expect(audits()).toHaveLength(1);
  });
  it("a start that answers Failed state is also past Created, and the poll step will report it", async () => {
    gw.status.mockResolvedValueOnce({ ok: true, state: "Pending", outputs: [] }).mockResolvedValueOnce({ ok: true, state: "Failed", outputs: [] });
    gw.startJob.mockResolvedValue({ ok: false, error: "start_409", status: 409, transient: false });
    expect(await start()).toMatchObject({ kind: "next", step: "poll" });
  });
});

describe("S2 — a failed status read before start is never read as 'not started'", () => {
  const args = { source: "encounter", encounter_id: "enc_1", mode: "transcribe", english: true };
  const prog = { clip_key: "clip.webm", content_type: "audio/webm", sarvam_job_id: "sj_9", duration_ms: 600_000, scope: "encounter", ref: "enc_1", started_at: "2026-10-08T06:00:00.000Z" };
  const start = () => T.sarvamTranscribeKind.run(ctx("start", args, prog));
  const audits = () => statements.filter((s) => /INSERT INTO audit_log/.test(s.text));

  it("a transient failure of the FIRST status read throws (the runner retries); Sarvam's start is never called, so there is no double start; nothing is audited", async () => {
    gw.status.mockResolvedValue({ ok: false, error: "status_503", status: 503, transient: true });
    await expect(start()).rejects.toThrow(/sarvam_submit_failed: status_503/);
    await expect(start()).rejects.toThrow(/status_503/);
    expect(gw.startJob).not.toHaveBeenCalled();
    expect(audits()).toHaveLength(0);
    expect(ledgerLines()).toEqual([]);
    // the retry that finally reads a status carries on normally: Pending -> one start; Running -> no start
    gw.status.mockReset();
    gw.status.mockResolvedValueOnce({ ok: false, error: "status_500", status: 500, transient: true }).mockResolvedValueOnce({ ok: true, state: "Running", outputs: [] });
    await expect(start()).rejects.toThrow();
    expect(await start()).toMatchObject({ kind: "next", step: "poll" });
    expect(gw.startJob).not.toHaveBeenCalled();
    expect(audits()).toHaveLength(1);
  });
  it("a terminal failure of the first status read (the job is unknown to Sarvam) fails the job by code, again WITHOUT calling start", async () => {
    gw.status.mockResolvedValue({ ok: false, error: "status_404", status: 404, transient: false });
    expect(await start()).toEqual({ kind: "fail", error: "sarvam_submit_failed: status_404" });
    expect(gw.startJob).not.toHaveBeenCalled();
    expect(ledgerLines()).toEqual([expect.objectContaining({ status: "failed", http_status: 404 })]);
  });
  it("the cases G15 already covers (the RECHECK after a start 4xx) are cited, not repeated: see 'G15: if the recheck after a start 4xx itself fails TRANSIENTLY'", () => {
    expect(true).toBe(true);
  });
});

describe("S3 — the paid-call audit row is retried, or the step throws and the reservation is kept", () => {
  const args = { source: "encounter", encounter_id: "enc_1", mode: "transcribe", english: true };
  const prog = { clip_key: "clip.webm", content_type: "audio/webm", sarvam_job_id: "sj_9", duration_ms: 600_000, scope: "encounter", ref: "enc_1", started_at: "2026-10-08T06:00:00.000Z" };
  const start = () => T.sarvamTranscribeKind.run(ctx("start", args, prog));
  const inserts = () => statements.filter((s) => /INSERT INTO audit_log/.test(s.text));
  const errLog = () => vi.spyOn(console, "error").mockImplementation(() => undefined);

  it("an insert that fails twice and then succeeds is retried inside the step: one row, the job moves on", async () => {
    const err = errLog();
    gw.status.mockResolvedValue({ ok: true, state: "Pending", outputs: [] });
    gw.startJob.mockResolvedValue({ ok: true });
    let n = 0;
    answer = (text) => (/INSERT INTO audit_log/.test(text) ? (++n <= 2 ? new Error("connection reset") : []) : []);
    expect(await start()).toMatchObject({ kind: "next", step: "poll" });
    expect(inserts()).toHaveLength(3); // two failures and the success
    expect(statements.filter((s) => /SELECT 1 AS one FROM audit_log/.test(s.text)).length).toBe(3); // each attempt re-checks, so a row that landed after a lost reply is not doubled
    err.mockRestore();
  });
  it("an insert that never succeeds does NOT fail the job (G26): the step moves on to poll with audit_pending and the start evidence in the progress it returns; no second start", async () => {
    const err = errLog();
    gw.status.mockResolvedValue({ ok: true, state: "Pending", outputs: [] });
    gw.startJob.mockResolvedValue({ ok: true });
    answer = (text) => (/INSERT INTO audit_log/.test(text) ? new Error("db down") : []);
    const out = await start();
    expect(out).toMatchObject({ kind: "next", step: "poll", progress: { audit_pending: true, sarvam_job_id: "sj_9", duration_ms: 600_000 } });
    expect((out as unknown as { progress: { sarvam_started_ms: number } }).progress.sarvam_started_ms).toBeGreaterThan(0);
    expect(gw.startJob).toHaveBeenCalledTimes(1);
    expect(inserts()).toHaveLength(4); // the first try and three retries
    // no mid-step write of any kind (G27): the start step never touches scribe_job itself
    expect(statements.filter((s) => /UPDATE scribe_job/.test(s.text))).toEqual([]);
    err.mockRestore();
  });
  it("poll retries the audit write on every claim: still failing -> audit_pending stays and polling goes on; once the database is back the row lands ONCE and audit_pending is dropped", async () => {
    const err = errLog();
    const pollProg = { ...prog, sarvam_started_ms: Date.now(), audit_pending: true };
    const poll = () => T.sarvamTranscribeKind.run(ctx("poll", args, pollProg));
    gw.status.mockResolvedValue({ ok: true, state: "Running", outputs: [] });
    answer = (text) => (/INSERT INTO audit_log/.test(text) ? new Error("db down") : []);
    expect(await poll()).toMatchObject({ kind: "next", step: "poll", progress: { audit_pending: true } });
    answer = () => [];
    statements.length = 0;
    const ok = await poll();
    expect(ok).toMatchObject({ kind: "next", step: "poll" });
    expect((ok as { progress: Row }).progress).not.toHaveProperty("audit_pending");
    expect(inserts()).toHaveLength(1);
    // Completed with the audit still pending: the job still goes on to finish (an audit fault never fails it)
    answer = (text) => (/INSERT INTO audit_log/.test(text) ? new Error("db down") : []);
    gw.status.mockResolvedValue({ ok: true, state: "Completed", outputs: ["o.json"] });
    expect(await poll()).toMatchObject({ kind: "next", step: "finish", progress: { audit_pending: true } });
    err.mockRestore();
  });
  it("the retry delays are bounded (3 retries); an existing row ends the loop at once", async () => {
    expect(C.auditRetry.delaysMs.length).toBe(3);
    gw.status.mockResolvedValue({ ok: true, state: "Running", outputs: [] });
    answer = (text) => (/SELECT 1 AS one FROM audit_log/.test(text) ? [{ one: 1 }] : []);
    expect(await start()).toMatchObject({ kind: "next", step: "poll" });
    expect(inserts()).toHaveLength(0);
  });
});

describe("G13 — ledger accuracy", () => {
  const T0 = "2026-10-08T06:00:00.000Z";
  const line = (over: Row = {}) => ({
    caller: "scribe-mcp", machine: "vercel", job_id: "job_x", request_id: "sj", route: "gateway", mode: "batch", task: "transcribe", model: "saaras:v3", audio_s: 600,
    started_at: T0, finished_at: "2026-10-08T06:20:00.000Z", status: "ok", http_status: 200, throttled: false, scope: "encounter", ref: "enc_1", ...over,
  }) as import("@/lib/sarvam-lab").CallLine;

  it("(a) an ok line REPLACES a cancelled / failed line for the same job (one line, audio counted); an ok line is never displaced; non-ok never replaces non-ok", async () => {
    await L.appendLedger(line({ status: "cancelled", audio_s: 600 }));
    expect(ledgerLines()).toEqual([expect.objectContaining({ status: "cancelled" })]);
    expect(L.tallyOf(lab.get("sarvam/ledger/scribe-mcp/2026-10-08.jsonl")!.body).audio_min).toBe(0); // cancelled audio is not counted...
    await L.appendLedger(line({ status: "ok" })); // ...until Sarvam is known to have finished
    expect(ledgerLines()).toEqual([expect.objectContaining({ status: "ok", audio_s: 600 })]);
    expect(L.tallyOf(lab.get("sarvam/ledger/scribe-mcp/2026-10-08.jsonl")!.body).audio_min).toBe(10);
    await L.appendLedger(line({ status: "cancelled" }));
    await L.appendLedger(line({ status: "failed" }));
    expect(ledgerLines()).toEqual([expect.objectContaining({ status: "ok" })]);
    // failed first, then cancelled: the first non-ok line stays
    await L.appendLedger(line({ job_id: "job_y", status: "failed" }));
    await L.appendLedger(line({ job_id: "job_y", status: "cancelled" }));
    expect(ledgerLines().filter((l) => l.job_id === "job_y")).toEqual([expect.objectContaining({ status: "failed" })]);
    // other jobs' lines are untouched by a replacement
    expect(ledgerLines()).toHaveLength(2);
  });

  it("(a) end to end: a cancel lands DURING finish, the finish still completes -> the ledger says ok with the audio counted", async () => {
    const { sarvamJobEnded } = await import("@/lib/jobs/sarvam-hook");
    const fin = { sarvam_job_id: "sj_9", outputs: ["0.json"], duration_ms: 600_000, scope: "encounter", ref: "enc_1", started_at: T0, sarvam_started_ms: Date.now() };
    const j = { id: "job_t1", kind: "sarvam_transcribe", args: { source: "encounter", encounter_id: "enc_1", mode: "transcribe", english: false }, progress: fin, created_at: T0 } as never;
    await sarvamJobEnded(j, "cancelled"); // the cancel arrives first
    expect(ledgerLines()).toEqual([expect.objectContaining({ status: "cancelled", audio_s: 600 })]);
    gw.result.mockResolvedValue({ ok: true, transcript: "hi", languageCode: "en-IN", entries: [{ transcript: "hi", start: 0, end: 1, speakerId: "0" }] });
    await T.sarvamTranscribeKind.run(ctx("finish", { source: "encounter", encounter_id: "enc_1", mode: "transcribe", english: false }, fin)); // Sarvam completed
    expect(ledgerLines()).toEqual([expect.objectContaining({ job_id: "job_t1", status: "ok", audio_s: 600 })]);
  });

  it("(b) translate lines count INPUT characters: the failed line of sarvam_translate and the runner hook both carry the source chars sent so far", async () => {
    const text = Array.from({ length: 3 }, (_, i) => `वाक्य ${i}। ` + "क".repeat(480)).join(" ");
    answer = (t) => (/FROM encounter/.test(t) ? [{ transcript_original: text, transcript_raw: "", detected_language: "hi-IN" }] : []);
    const a = { kind: "encounter", id: "e1" };
    const prep = await X.sarvamTranslateKind.run(ctx("prepare", a));
    const { chunkText } = await import("@/lib/sarvam-gw");
    const chunks = chunkText(text);
    // one chunk done, then a terminal failure: the failed line says how much INPUT went out (chunk 0), not the English that came back
    gw.translate.mockResolvedValueOnce({ ok: true, english: "E" }).mockResolvedValueOnce({ ok: false, error: "translate_400", status: 400, transient: false });
    await X.sarvamTranslateKind.run(ctx("translate", a, (prep as { progress: Row }).progress));
    expect(ledgerLines().at(-1)).toMatchObject({ task: "text_translate", status: "failed", chars: chunks[0]!.length });
    // a step budget that ends after one chunk records the input chars on the job, which is what the runner hook reads
    lab.clear();
    gw.translate.mockReset();
    T.sarvamTiming.translateStepMs = 1;
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-08T12:00:00Z"));
    gw.translate.mockImplementation(async () => { vi.setSystemTime(Date.now() + 50); return { ok: true, english: "E" }; });
    const prep2 = await X.sarvamTranslateKind.run(ctx("prepare", a));
    const step = (await X.sarvamTranslateKind.run(ctx("translate", a, (prep2 as { progress: Row }).progress))) as { kind: string; progress: Row };
    expect(step.kind).toBe("next");
    expect(step.progress.translate_chars).toBe(chunks[0]!.length);
    const { endedLine } = await import("@/lib/jobs/sarvam-hook");
    expect(endedLine({ id: "job_t1", kind: "sarvam_translate", args: a, progress: step.progress, created_at: T0 }, "failed", "t")).toMatchObject({ task: "text_translate", chars: chunks[0]!.length });
  });

  it("(c) the one-line-per-job check covers the START-date file too: a job that crosses IST midnight gets one line, not two", async () => {
    const start = "2026-10-08T18:20:00.000Z"; // 23:50 IST on the 8th
    const midnightCancel = line({ status: "cancelled", started_at: start, finished_at: "2026-10-08T18:25:00.000Z" }); // 23:55 IST, the 8th
    await L.appendLedger(midnightCancel);
    expect([...lab.keys()]).toEqual(["sarvam/ledger/scribe-mcp/2026-10-08.jsonl"]);
    // the job's finish lands at 00:05 IST on the 9th: its own file is the 9th, but the job is already in the 8th's
    await L.appendLedger(line({ status: "failed", started_at: start, finished_at: "2026-10-08T18:35:00.000Z" }));
    expect([...lab.keys()]).toEqual(["sarvam/ledger/scribe-mcp/2026-10-08.jsonl"]); // no second line, no second file
    // and an ok finish replaces the cancelled line IN the start-date file
    await L.appendLedger(line({ status: "ok", started_at: start, finished_at: "2026-10-08T18:35:00.000Z" }));
    expect([...lab.keys()]).toEqual(["sarvam/ledger/scribe-mcp/2026-10-08.jsonl"]);
    expect(ledgerLines()).toEqual([expect.objectContaining({ status: "ok" })]);
    // a job not yet in either file is written to the FINISH-date file
    await L.appendLedger(line({ job_id: "job_new", started_at: start, finished_at: "2026-10-08T18:35:00.000Z" }));
    expect(lab.get("sarvam/ledger/scribe-mcp/2026-10-09.jsonl")!.body).toContain('"job_id":"job_new"');
    // both candidate files are within the allowlist
    for (const k of lab.keys()) expect(L.labWritable(k)).toBe(true);
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
    expect(out).toMatchObject({ kind: "next", step: "en_init", progress: { total_entries: 2, language_code: "hi-IN" } }); // S8A4: the English comes from the audio
    expect(JSON.stringify((out as { progress: Row }).progress)).not.toContain("namaste");
    expect(json("mcp-sarvam/job_t1.json")).toEqual({
      language_code: "hi-IN", duration_s: 600, speakers: ["0", "1"], transcript: "namaste doctor bukhar hai",
      entries: [{ speaker_id: "0", start_s: 0, end_s: 4.5, text: "namaste doctor", script: "Latin", language_code: null }, { speaker_id: "1", start_s: 5, end_s: 8, text: "bukhar hai", script: "Latin", language_code: null }],
      english_pass: "pending", sarvam_job_ids: { native: "sj_9", english: null }, minutes: { native: 10, english: 0 },
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
    expect(out).toEqual({ kind: "done", result: { r2_key: "mcp-sarvam/job_t1.json", entries: 2, speakers: 2, language_code: "hi-IN", duration_s: 600, english: false, transcript_chars: 25, english_chars: 0,
      english_pass: "not_requested", english_entries: 0, english_ok: 0, mayura_fallback: 0, unverified: 0, untranslated: 0, partial: 0, mixed_language: 0, pass_rejected: 0, drug_candidates: 0, minutes: { native: 10, english: 0 } } });
    expect(JSON.stringify(out)).not.toContain("namaste");
  });

  it("finish: a file-level language code that says English does NOT end the job: the English pass still runs (S8A4); throttled is carried into the ledger; no mayura call", async () => {
    gw.result.mockResolvedValue({ ok: true, transcript: "hello doctor", languageCode: "en-IN", entries: [{ transcript: "hello doctor", start: 0, end: 2, speakerId: "0", languageCode: null }] });
    const out = await finish(args, { ...fin, throttled: true });
    expect(out).toMatchObject({ kind: "next", step: "en_init" });
    expect(gw.translate).not.toHaveBeenCalled();
    expect(ledgerLines()[0]).toMatchObject({ status: "ok", throttled: true, task: "transcribe" });
  });

  it("finish: no diarized entries -> one pseudo-entry; a terminal download failure is a named failure with a ledger line; a transient one throws", async () => {
    gw.result.mockResolvedValue({ ok: true, transcript: "namaste", languageCode: "hi-IN", entries: [] });
    expect(await finish()).toMatchObject({ kind: "next", step: "en_init", progress: { total_entries: 1 } });
    expect(json("mcp-sarvam/job_t1.json").entries).toEqual([expect.objectContaining({ text: "namaste", start_s: 0, end_s: 600 })]);
    lab.clear(); // a fresh job: one ledger line per job id
    gw.result.mockResolvedValue({ ok: false, error: "download_links_403", status: 403, transient: false });
    expect(await finish()).toEqual({ kind: "fail", error: "sarvam_result_failed: download_links_403" });
    expect(ledgerLines().at(-1)).toMatchObject({ status: "failed", http_status: 403 });
    gw.result.mockResolvedValue({ ok: false, error: "download_timeout", transient: true });
    await expect(finish()).rejects.toThrow(/sarvam_result_failed/);
  });

  const translate = (progress: Row = fin) => T.sarvamTranscribeKind.run(ctx("translate", args, progress));
  const seed = (entries: Row[]) => store.set("mcp-sarvam/job_t1.json", Buffer.from(JSON.stringify({ language_code: "hi-IN", duration_s: 10, speakers: ["0"], transcript: "t", entries })));

  it("translate: every entry still without English, <= 900 chars per request, the entry's OWN language (else auto) passed; done with counts only and an ok text_translate ledger line", async () => {
    seed([{ speaker_id: "0", start_s: 0, end_s: 1, text: "text 0" }, { speaker_id: "0", start_s: 1, end_s: 2, text: "text 1" }]);
    gw.translate.mockImplementation(async (t: string) => ({ ok: true, english: `EN(${t})` }));
    const out = await translate();
    expect(out).toMatchObject({ kind: "done", result: { entries: 2, english: true, language_code: "hi-IN" } });
    expect(gw.translate).toHaveBeenCalledWith("text 0", null); // S8A4: the entry has no language of its own -> auto, never the file label
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

describe("S8A4 — the English track comes from a second Sarvam pass over the audio", () => {
  const args = { source: "encounter", encounter_id: "enc_1", mode: "transcribe", english: true, num_speakers: 2 };
  const base = { clip_key: "clip.webm", content_type: "audio/webm", scope: "encounter", ref: "enc_1", sarvam_job_id: "sj_9", duration_ms: 600_000, started_at: "2026-10-08T06:00:00.000Z", sarvam_started_ms: Date.now() };
  const step = (name: string, progress: Row, a: Row = args) => T.sarvamTranscribeKind.run(ctx(name, a, progress));
  const nativeEntries = [
    { transcript: "How are you feeling", start: 0, end: 5, speakerId: "0", languageCode: null },
    { transcript: "ನನಗೆ ತಲೆನೋವು ಇದೆ", start: 5, end: 9, speakerId: "1", languageCode: null },
    { transcript: "मुझे बुखार है", start: 9, end: 12, speakerId: "1", languageCode: null },
  ];
  const englishEntries = [
    { transcript: "How are you feeling", start: 0, end: 5, speakerId: "0", languageCode: null },
    { transcript: "I have a headache", start: 5.1, end: 8.9, speakerId: "1", languageCode: null },
    { transcript: "I have fever. Take combat land twice a day", start: 9, end: 12, speakerId: "1", languageCode: null },
  ];
  const auditInserts = () => statements.filter((s) => /INSERT INTO audit_log/.test(s.text));

  it("native finish -> en_init; en_init creates a SECOND Sarvam job in translate mode over the same clip and persists its id; en_upload re-uploads the same audio", async () => {
    store.set("clip.webm", clip10());
    gw.result.mockResolvedValue({ ok: true, transcript: "x", languageCode: "en-IN", entries: nativeEntries });
    expect(await step("finish", { ...base, outputs: ["0.json"] })).toMatchObject({ kind: "next", step: "en_init" });
    gw.init.mockResolvedValue({ ok: true, jobId: "sj_en" });
    const out = await step("en_init", { ...base, outputs: ["0.json"] });
    expect(gw.init).toHaveBeenLastCalledWith(expect.objectContaining({ mode: "translate", numSpeakers: 2 }));
    expect(out).toMatchObject({ kind: "next", step: "en_upload", progress: { en_sarvam_job_id: "sj_en", sarvam_job_id: "sj_9" } });
    gw.upload.mockResolvedValue({ ok: true });
    const up = await step("en_upload", (out as { progress: Row }).progress);
    expect(gw.upload).toHaveBeenLastCalledWith("sj_en", expect.anything(), "audio/webm");
    expect(up).toMatchObject({ kind: "next", step: "en_start" });
    // a replay of en_init does not create a third job
    gw.init.mockClear();
    expect(await step("en_init", (out as { progress: Row }).progress)).toMatchObject({ step: "en_upload" });
    expect(gw.init).not.toHaveBeenCalled();
  });

  it("en_start writes ITS OWN paid-call row under <job id>:en (one per pass, idempotent), then en_poll -> en_finish; both ledger lines have the right task", async () => {
    gw.status.mockResolvedValue({ ok: true, state: "Pending", outputs: [] });
    gw.startJob.mockResolvedValue({ ok: true });
    const withEn = { ...base, outputs: ["0.json"], en_sarvam_job_id: "sj_en", en_started_at: "2026-10-08T06:05:00.000Z" };
    const st = await step("en_start", withEn);
    expect(st).toMatchObject({ kind: "next", step: "en_poll", progress: { en_sarvam_job_id: "sj_en" } });
    expect(Number((st as { progress: Row }).progress.en_started_ms)).toBeGreaterThan(0);
    const row = JSON.parse(String(auditInserts()[0]!.values.find((v) => typeof v === "string" && String(v).includes("sarvam_job_id"))));
    expect(row).toMatchObject({ job_id: "job_t1:en", sarvam_job_id: "sj_en", audio_minutes: 10 });
    gw.status.mockResolvedValue({ ok: true, state: "Completed", outputs: ["1.json"] });
    expect(await step("en_poll", (st as { progress: Row }).progress)).toMatchObject({ kind: "next", step: "en_finish", progress: { en_outputs: ["1.json"] } });
  });

  async function runEnFinish(over: Row = {}) {
    store.set("mcp-sarvam/job_t1.json", Buffer.from(JSON.stringify({
      language_code: "en-IN", duration_s: 600, speakers: ["0", "1"], transcript: "x", english_pass: "pending", sarvam_job_ids: { native: "sj_9", english: null }, minutes: { native: 10, english: 0 },
      entries: [
        { speaker_id: "0", start_s: 0, end_s: 5, text: "How are you feeling", script: "Latin", language_code: null },
        { speaker_id: "1", start_s: 5, end_s: 9, text: "ನನಗೆ ತಲೆನೋವು ಇದೆ", script: "Kannada", language_code: null },
        { speaker_id: "1", start_s: 9, end_s: 12, text: "मुझे बुखार है", script: "Devanagari", language_code: null },
      ],
    })));
    return step("en_finish", { ...base, outputs: ["0.json"], en_sarvam_job_id: "sj_en", en_started_at: "2026-10-08T06:05:00.000Z", en_started_ms: Date.now(), en_outputs: ["1.json"], ...over });
  }

  it("en_finish: the Kannada and Hindi entries get their English from the translate pass (no mayura), no entry is lost, the drug check proposes Combiflam, the result carries both job ids and both minutes", async () => {
    gw.result.mockResolvedValue({ ok: true, transcript: "x", languageCode: "en-IN", entries: englishEntries });
    const out = await runEnFinish();
    expect(out).toMatchObject({ kind: "done", result: { english_pass: "done", english_entries: 3, drug_candidates: 1, minutes: { native: 10, english: 10 } } });
    expect(gw.translate).not.toHaveBeenCalled();
    const doc = json("mcp-sarvam/job_t1.json");
    expect(doc.entries.map((e: Row) => e.english)).toEqual(["How are you feeling", "I have a headache", "I have fever. Take combat land twice a day"]);
    expect(doc.entries.map((e: Row) => e.english_source)).toEqual(["translate_pass", "translate_pass", "translate_pass"]);
    expect(doc.entries.map((e: Row) => e.script)).toEqual(["Latin", "Kannada", "Devanagari"]);
    expect(doc.entries[1].text).toBe("ನನಗೆ ತಲೆನೋವು ಇದೆ"); // the native text is untouched
    expect(doc.english).toBe("How are you feeling I have a headache I have fever. Take combat land twice a day");
    expect(doc.drug_candidates[0]).toEqual({ entry_idx: 2, heard: "combat land", suggested: expect.stringMatching(/^combiflam/i), score: expect.any(Number), source: expect.stringContaining("pulse-medications"), category: "drug" });
    expect(doc.english_entries[2].text).toContain("combat land"); // proposed, not rewritten
    expect(doc.sarvam_job_ids).toEqual({ native: "sj_9", english: "sj_en" });
    expect(ledgerLines().filter((l) => l.job_id === "job_t1:en")).toEqual([expect.objectContaining({ task: "translate", request_id: "sj_en", audio_s: 600, status: "ok", model: "saaras:v3" })]);
  });

  it("a pass-2 entry with no native partner is kept in the English track (native_idx null)", async () => {
    gw.result.mockResolvedValue({ ok: true, transcript: "x", languageCode: "en-IN", entries: [...englishEntries, { transcript: "Okay", start: 30, end: 31, speakerId: "0", languageCode: null }] });
    await runEnFinish();
    const doc = json("mcp-sarvam/job_t1.json");
    expect(doc.english_entries).toHaveLength(4);
    expect(doc.english_entries.at(-1)).toMatchObject({ text: "Okay", native_idx: null, source: "translate_pass" });
  });

  it("the cap refuses the second pass -> NOT a failed job: english_pass skipped_cap; the Latin entry stays, the Kannada and Hindi entries go to mayura PER ENTRY (source auto)", async () => {
    answer = (text) => (/j\.progress \? 'en_sarvam_job_id'/.test(text) ? [{ minutes: 0 }] : /FROM audit_log/.test(text) ? [{ minutes: 235 }] : /FROM scribe_job/.test(text) ? [{ minutes: 0 }] : []);
    const init = await step("en_init", { ...base, outputs: ["0.json"] });
    expect(init).toMatchObject({ kind: "next", step: "en_finish", progress: { en_skip: "skipped_cap" } });
    expect(gw.init).not.toHaveBeenCalledWith(expect.objectContaining({ mode: "translate" }));
    answer = () => [];
    const fin1 = await runEnFinish({ en_skip: "skipped_cap", en_outputs: undefined, en_sarvam_job_id: undefined });
    expect(fin1).toMatchObject({ kind: "next", step: "translate" });
    gw.translate.mockImplementation(async (t: string) => ({ ok: true, english: t.startsWith("ನ") ? "I have a headache" : "I have a fever" }));
    const out = await step("translate", { ...base, outputs: ["0.json"] });
    expect(out).toMatchObject({ kind: "done", result: { english_pass: "skipped_cap", english_ok: 3, untranslated: 0 } });
    expect(gw.translate.mock.calls.map((c) => c[0])).toEqual(["ನನಗೆ ತಲೆನೋವು ಇದೆ", "मुझे बुखार है"]); // only the Indic entries; the Latin one was kept
    expect(gw.translate.mock.calls.map((c) => c[1])).toEqual(["kn-IN", null]); // from the script (Kannada); Devanagari could be hi / mr: auto
    const doc = json("mcp-sarvam/job_t1.json");
    expect(doc.entries.map((e: Row) => e.english_source)).toEqual(["native_latin", "mayura", "mayura"]);
    expect(doc.english_entries).toHaveLength(3);
    expect(doc.minutes).toEqual({ native: 10, english: 0 });
  });

  it("a terminal failure of the English pass (Sarvam says Failed) does not fail the job: a failed ledger line for the pass, then the mayura fallback", async () => {
    gw.status.mockResolvedValue({ ok: true, state: "Failed", outputs: [] });
    const out = await step("en_poll", { ...base, en_sarvam_job_id: "sj_en", en_started_ms: Date.now(), en_started_at: "2026-10-08T06:05:00.000Z" });
    expect(out).toMatchObject({ kind: "next", step: "en_finish", progress: { en_skip: "failed" } });
    expect(ledgerLines().filter((l) => l.job_id === "job_t1:en")).toEqual([expect.objectContaining({ status: "failed", task: "translate", request_id: "sj_en", audio_s: 600 })]);
  });

  it("a transient failure of the English pass still throws (retried under MAX_FAILURES)", async () => {
    gw.init.mockResolvedValue({ ok: false, error: "http_503", status: 503, transient: true });
    await expect(step("en_init", { ...base, outputs: ["0.json"] })).rejects.toThrow(/sarvam_submit_failed/);
  });

  it("english:false never starts a second pass", async () => {
    gw.result.mockResolvedValue({ ok: true, transcript: "x", languageCode: "en-IN", entries: nativeEntries });
    expect(await step("finish", { ...base, outputs: ["0.json"] }, { ...args, english: false })).toMatchObject({ kind: "done", result: { english_pass: "not_requested" } });
  });

  it("the runner-ended hook writes the English pass's own line when that pass had started", async () => {
    const { endedEnLine, endedLine } = await import("@/lib/jobs/sarvam-hook");
    const job = { id: "job_t1", kind: "sarvam_transcribe", args, created_at: "2026-10-08T06:00:00.000Z", progress: { ...base, en_sarvam_job_id: "sj_en", en_started_ms: 5, en_started_at: "2026-10-08T06:05:00.000Z" } };
    expect(endedEnLine(job as never, "failed", "2026-10-08T06:30:00.000Z")).toMatchObject({ job_id: "job_t1:en", request_id: "sj_en", task: "translate", audio_s: 600, status: "failed" });
    expect(endedEnLine({ ...job, progress: base } as never, "failed", "x")).toBeNull();
    expect(endedLine(job as never, "failed", "x")).toMatchObject({ job_id: "job_t1", task: "transcribe" });
  });
});

describe("G43 / G45 — the English track is never trusted to be English", () => {
  const args = { source: "encounter", encounter_id: "enc_1", mode: "transcribe", english: true };
  const base = { clip_key: "clip.webm", content_type: "audio/webm", scope: "encounter", ref: "enc_1", sarvam_job_id: "sj_9", duration_ms: 600_000, started_at: "2026-10-08T06:00:00.000Z", sarvam_started_ms: Date.now(), en_sarvam_job_id: "sj_en", en_started_ms: Date.now(), en_outputs: ["1.json"], outputs: ["0.json"] };
  const seedDoc = (entries: Row[]) => store.set("mcp-sarvam/job_t1.json", Buffer.from(JSON.stringify({
    language_code: "en-IN", duration_s: 600, speakers: ["0"], transcript: "x", english_pass: "pending", sarvam_job_ids: { native: "sj_9", english: null }, minutes: { native: 10, english: 0 }, entries,
  })));
  const nat = (start: number, text: string, script: string, language_code: string | null = null) => ({ speaker_id: "0", start_s: start, end_s: start + 4, text, script, language_code });
  const pass = (rows: Array<[number, string]>) => rows.map(([start, transcript]) => ({ transcript, start, end: start + 4, speakerId: "0", languageCode: null }));
  const finishEn = (over: Row = {}) => T.sarvamTranscribeKind.run(ctx("en_finish", args, { ...base, ...over }));
  const KN = "ನನಗೆ ತಲೆನೋವು ಇದೆ", HI = "मुझे बुखार है";

  it("THE REFUTER'S CASE — the API ignores mode translate and returns the NATIVE text: no Indic text is accepted as English; every entry goes to mayura as mayura_fallback; the pass is 'suspect'; the counts say so", async () => {
    seedDoc([nat(0, KN, "Kannada"), nat(4, HI, "Devanagari")]);
    gw.result.mockResolvedValue({ ok: true, transcript: "x", languageCode: "kn-IN", entries: pass([[0, KN], [4, HI]]) });
    const fin = await finishEn();
    expect(fin).toMatchObject({ kind: "next", step: "translate" });
    expect(json("mcp-sarvam/job_t1.json")).toMatchObject({ english_pass: "suspect", pass_rejected: 2, english_entries: [] });
    expect(json("mcp-sarvam/job_t1.json").entries.map((e: Row) => e.english_source)).toEqual(["mayura_fallback", "mayura_fallback"]);
    gw.translate.mockImplementation(async (t: string) => ({ ok: true, english: t === KN ? "I have a headache" : "I have a fever" }));
    const out = await step2("translate");
    expect(out).toMatchObject({ kind: "done", result: { english_pass: "suspect", entries: 2, english_ok: 0, mayura_fallback: 2, unverified: 0, untranslated: 0, pass_rejected: 2 } });
    const doc = json("mcp-sarvam/job_t1.json");
    expect(doc.entries.map((e: Row) => [e.english, e.english_status])).toEqual([["I have a headache", "mayura_fallback"], ["I have a fever", "mayura_fallback"]]);
    expect(doc.english_entries.map((t: Row) => t.source)).toEqual(["mayura_fallback", "mayura_fallback"]);
    expect(doc.english).toBe("I have a headache I have a fever");
    expect(/[\u0900-\u0d7f]/.test(doc.english)).toBe(false); // no Indic script anywhere in the English track
  });
  const step2 = (name: string, over: Row = {}) => T.sarvamTranscribeKind.run(ctx(name, args, { ...base, ...over }));

  it("(a) a pass entry written in Indic script is refused even when only that entry is wrong; the good ones stay; mayura is told the language the script says", async () => {
    seedDoc([nat(0, "How are you", "Latin"), nat(4, KN, "Kannada")]);
    gw.result.mockResolvedValue({ ok: true, transcript: "x", languageCode: "en-IN", entries: pass([[0, "How are you"], [4, KN]]) });
    expect(await finishEn()).toMatchObject({ kind: "next", step: "translate" });
    gw.translate.mockResolvedValue({ ok: true, english: "I have a headache" });
    await step2("translate");
    expect(gw.translate).toHaveBeenCalledTimes(1);
    expect(gw.translate).toHaveBeenCalledWith(KN, "kn-IN");
    expect(json("mcp-sarvam/job_t1.json")).toMatchObject({ english_pass: "done", pass_rejected: 1 });
  });

  it("(b) romanised Indic: a pass entry (or a Latin native entry) full of Hindi / Kannada function words is not English; the language comes from the entry or the score; unknown language -> unverified, never passed as English", async () => {
    seedDoc([nat(0, "mujhe bukhar hai doctor sahab", "Latin", "hi-IN"), nat(4, "naanu tumba novu ide illa", "Latin"), nat(8, "nahi", "Latin"), nat(12, "Please sit down", "Latin")]);
    gw.result.mockResolvedValue({ ok: true, transcript: "x", languageCode: "en-IN", entries: pass([[0, "mujhe bukhar hai doctor sahab"], [4, "naanu tumba novu ide illa"], [12, "Please sit down"]]) });
    expect(await finishEn()).toMatchObject({ kind: "next", step: "translate" });
    gw.translate.mockImplementation(async (t: string) => ({ ok: true, english: t.startsWith("mujhe") ? "I have a fever, doctor" : "I have a lot of pain" }));
    const out = await step2("translate");
    expect(gw.translate.mock.calls).toEqual([["mujhe bukhar hai doctor sahab", "hi-IN"], ["naanu tumba novu ide illa", "kn-IN"]]);
    const doc = json("mcp-sarvam/job_t1.json");
    expect(doc.entries.map((e: Row) => e.english_status)).toEqual(["mayura_fallback", "mayura_fallback", "unverified", "ok"]);
    expect(doc.entries[2]).toMatchObject({ english_source: "native_unverified" }); // "nahi" alone: hi and mr tie -> language unknown -> unverified
    expect(out).toMatchObject({ kind: "done", result: { english_ok: 1, mayura_fallback: 2, unverified: 1, untranslated: 0 } });
    expect(doc.drug_candidates).toEqual([]);
  });

  it("(c) the pass returned nothing usable for an entry -> mayura on the native entry; mayura returning Indic / empty / the same text -> english_status untranslated and an EMPTY english, never the Indic text", async () => {
    seedDoc([nat(0, KN, "Kannada"), nat(4, HI, "Devanagari"), nat(8, "ਸਤ ਸ੍ਰੀ ਅਕਾਲ", "Gurmukhi")]);
    gw.result.mockResolvedValue({ ok: true, transcript: "", languageCode: "en-IN", entries: [] });
    expect(await finishEn()).toMatchObject({ kind: "next", step: "translate" });
    gw.translate.mockImplementation(async (t: string) => (t === KN ? { ok: true, english: KN } : t === HI ? { ok: true, english: "" } : { ok: true, english: "ਸਤ ਸ੍ਰੀ" }));
    const out = await step2("translate");
    const doc = json("mcp-sarvam/job_t1.json");
    expect(doc.entries.map((e: Row) => [e.english, e.english_status])).toEqual([["", "untranslated"], ["", "untranslated"], ["", "untranslated"]]);
    expect(out).toMatchObject({ kind: "done", result: { entries: 3, english_ok: 0, untranslated: 3 } });
    expect(doc.english).toBe("");
  });

  it("G45: a few Hindi words inside an otherwise English entry -> kept as English with mixed_language, not sent to mayura", async () => {
    seedDoc([nat(0, "The patient says bukhar hai since yesterday and also has a mild cough", "Latin")]);
    gw.result.mockResolvedValue({ ok: true, transcript: "x", languageCode: "en-IN", entries: pass([[0, "The patient says bukhar hai since yesterday and also has a mild cough"]]) });
    const out = await finishEn();
    expect(out).toMatchObject({ kind: "done", result: { english_ok: 1, mixed_language: 1, pass_rejected: 0 } });
    expect(gw.translate).not.toHaveBeenCalled();
    expect(json("mcp-sarvam/job_t1.json").entries[0]).toMatchObject({ mixed_language: true, english_status: "ok" });
    expect(json("mcp-sarvam/job_t1.json").english_entries[0]).toMatchObject({ mixed_language: true });
  });

  const URDU = "\u0645\u062c\u06be\u06d2 \u0628\u062e\u0627\u0631 \u06c1\u06d2";

  it("GATING-G52 — Urdu (a script outside the nine Indic tables): the pass echoes the native text -> refused, mayura_fallback; mayura's echo -> untranslated with EMPTY english; never english == native text with status ok", async () => {
    seedDoc([nat(0, URDU, "Other")]);
    gw.result.mockResolvedValue({ ok: true, transcript: "x", languageCode: "ur-IN", entries: pass([[0, URDU]]) });
    expect(await finishEn()).toMatchObject({ kind: "next", step: "translate" });
    expect(json("mcp-sarvam/job_t1.json")).toMatchObject({ english_pass: "suspect", pass_rejected: 1, english_entries: [] });
    gw.translate.mockImplementation(async (t: string) => ({ ok: true, english: t })); // mayura echoes too
    const out = await step2("translate");
    expect(out).toMatchObject({ kind: "done", result: { english_ok: 0, untranslated: 1, mayura_fallback: 0 } });
    const doc = json("mcp-sarvam/job_t1.json");
    expect(doc.entries[0]).toMatchObject({ english: "", english_status: "untranslated" });
    expect(doc.english).toBe("");
    expect(gw.translate).toHaveBeenCalledWith(URDU, null); // Arabic script: language unknown -> auto
  });

  it("GATING-G52 — no translate-pass entry at all (empty pass): an Urdu native entry goes to mayura, it is never native_latin / ok", async () => {
    seedDoc([nat(0, URDU, "Other"), nat(4, "Take rest", "Latin")]);
    gw.result.mockResolvedValue({ ok: true, transcript: "", languageCode: "en-IN", entries: [] });
    expect(await finishEn()).toMatchObject({ kind: "next", step: "translate" });
    gw.translate.mockResolvedValue({ ok: true, english: "I have a fever" });
    const out = await step2("translate");
    expect(out).toMatchObject({ kind: "done", result: { english_ok: 2, mayura_fallback: 0, untranslated: 0 } });
    const doc = json("mcp-sarvam/job_t1.json");
    expect(doc.entries.map((e: Row) => [e.english_source, e.english_status, e.english])).toEqual([["mayura", "ok", "I have a fever"], ["native_latin", "ok", "Take rest"]]); // no pass entry existed, so this is plain mayura, not a fallback
  });

  it("GATING-G54 — one accepted and one refused part of a native entry: the entry goes to mayura whole (no duplicate English); if mayura refuses (a terminal 4xx / capped) the job still finishes and the entry is `partial`, never ok", async () => {
    const parts = [{ transcript: "I have a headache", start: 0, end: 4, speakerId: "0", languageCode: null }, { transcript: KN, start: 5, end: 9, speakerId: "0", languageCode: null }];
    seedDoc([{ ...nat(0, KN, "Kannada"), end_s: 10 }]);
    gw.result.mockResolvedValue({ ok: true, transcript: "x", languageCode: "en-IN", entries: parts });
    expect(await finishEn()).toMatchObject({ kind: "next", step: "translate" });
    gw.translate.mockResolvedValue({ ok: true, english: "I have a headache and it throbs" });
    const covered = await step2("translate");
    expect(covered).toMatchObject({ kind: "done", result: { english_ok: 0, mayura_fallback: 1, partial: 0 } });
    expect(json("mcp-sarvam/job_t1.json").english).toBe("I have a headache and it throbs"); // not "I have a headache I have a headache and it throbs"
    // now mayura refuses
    seedDoc([{ ...nat(0, KN, "Kannada"), end_s: 10 }]);
    expect(await finishEn()).toMatchObject({ kind: "next", step: "translate" });
    gw.translate.mockReset();
    gw.translate.mockResolvedValue({ ok: false, error: "translate_403", status: 403, transient: false });
    const part = await step2("translate");
    expect(part).toMatchObject({ kind: "done", result: { english_ok: 0, partial: 1, untranslated: 0 } });
    const doc = json("mcp-sarvam/job_t1.json");
    expect(doc.entries[0]).toMatchObject({ english: "I have a headache", english_status: "partial" });
    expect(doc.english_entries).toEqual([expect.objectContaining({ text: "I have a headache", status: "partial" })]);
    // a mayura refusal for an entry with NO set-aside English still fails the job, as before
    seedDoc([nat(0, KN, "Kannada")]);
    gw.result.mockResolvedValue({ ok: true, transcript: "", languageCode: "en-IN", entries: [] });
    expect(await finishEn()).toMatchObject({ kind: "next", step: "translate" });
    expect(await step2("translate")).toMatchObject({ kind: "fail" });
  });

  it("G49 — a transcript-only translate response (no diarized entries): every native entry goes to mayura on its own, the pass text is kept ONLY as a reference field and appears in the English track exactly zero times", async () => {
    const REF = "I have a headache and a fever since yesterday";
    seedDoc([nat(0, KN, "Kannada"), nat(4, HI, "Devanagari"), nat(8, "Take rest", "Latin")]);
    gw.result.mockResolvedValue({ ok: true, transcript: REF, languageCode: "en-IN", entries: [] });
    expect(await finishEn()).toMatchObject({ kind: "next", step: "translate" });
    gw.translate.mockImplementation(async (t: string) => ({ ok: true, english: t === KN ? "I have a headache" : "I have a fever" }));
    const out = await step2("translate");
    expect(gw.translate.mock.calls.map((c) => c[0])).toEqual([KN, HI]); // one mayura call per Indic entry, none for the pass text
    const doc = json("mcp-sarvam/job_t1.json");
    expect(doc.english_pass_reference).toBe(REF);
    expect(doc.english).toBe("I have a headache I have a fever Take rest");
    expect(doc.english).not.toContain("since yesterday"); // never in the English twice
    expect(doc.english_entries.every((t: Row) => t.source !== "translate_pass")).toBe(true);
    expect(doc.entries.map((e: Row) => e.english_source)).toEqual(["mayura", "mayura", "native_latin"]);
    expect(out).toMatchObject({ kind: "done", result: { english_ok: 3, pass_rejected: 0 } });
  });

  it("an honest translate pass is unaffected: all English, status ok, nothing sent to mayura, pass done", async () => {
    seedDoc([nat(0, KN, "Kannada"), nat(4, HI, "Devanagari")]);
    gw.result.mockResolvedValue({ ok: true, transcript: "x", languageCode: "en-IN", entries: pass([[0, "I have a headache"], [4, "I have a fever"]]) });
    expect(await finishEn()).toMatchObject({ kind: "done", result: { english_pass: "done", english_ok: 2, mayura_fallback: 0, unverified: 0, untranslated: 0, pass_rejected: 0 } });
    expect(gw.translate).not.toHaveBeenCalled();
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

  it("GATING-G52 — an en-IN-labelled stored text with an Urdu sentence: the Urdu sentence is translated too (any non-Latin script), the English around it is kept", async () => {
    const ur = "\u0645\u062c\u06be\u06d2 \u0628\u062e\u0627\u0631 \u06c1\u06d2.";
    answer = (t2) => (/FROM encounter/.test(t2) ? [{ transcript_original: `Hello doctor. ${ur} Thank you.`, transcript_raw: "", detected_language: "en-IN" }] : []);
    const args = { kind: "encounter", id: "e1" };
    const prep = await run("prepare", args);
    expect(prep).toMatchObject({ kind: "next", step: "translate", progress: { chunks_total: 1 } });
    gw.translate.mockResolvedValue({ ok: true, english: "I have a fever." });
    expect(await run("translate", args, (prep as { progress: Row }).progress)).toMatchObject({ kind: "done" });
    expect(gw.translate).toHaveBeenCalledWith(ur, null);
    expect(json("mcp-sarvam/job_t1.json").english).toBe("Hello doctor. I have a fever. Thank you.");
  });

  it("S8A4: an en-IN-labelled stored text with a Kannada sentence is NOT already_english: only that sentence is translated, the English around it is kept; a purely English text under the same label still is already_english", async () => {
    const kn = "ನನಗೆ ತಲೆನೋವು ಇದೆ.";
    const text = `How are you feeling today? ${kn} Take rest.`;
    answer = (t2) => (/FROM encounter/.test(t2) ? [{ transcript_original: text, transcript_raw: "", detected_language: "en-IN" }] : []);
    const args = { kind: "encounter", id: "e1" };
    const prep = await run("prepare", args);
    expect(prep).toMatchObject({ kind: "next", step: "translate", progress: { chunks_total: 1 } });
    gw.translate.mockResolvedValue({ ok: true, english: "I have a headache." });
    const out = await run("translate", args, (prep as { progress: Row }).progress);
    expect(out).toMatchObject({ kind: "done" });
    expect(gw.translate).toHaveBeenCalledTimes(1);
    expect(gw.translate).toHaveBeenCalledWith(kn, null); // the file label is not passed as the source language
    expect(json("mcp-sarvam/job_t1.json").english).toBe("How are you feeling today? I have a headache. Take rest.");
    answer = (t2) => (/FROM encounter/.test(t2) ? [{ transcript_original: "How are you feeling today? Take rest.", transcript_raw: "", detected_language: "en-IN" }] : []);
    expect(await run("prepare", args)).toMatchObject({ kind: "done", result: { reason: "already_english" } });
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

/**
 * S8D (V ruling O5, 09 Oct 2026) — Sarvam on ROOM audio for MCP callers only. Everything external is mocked: sql, R2, the Sarvam gateway client, the lab store.
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

const jobStore = { inserted: [] as Row[] };
vi.mock("@/lib/jobs/store", async (orig) => ({
  ...((await orig()) as object),
  findOpenJob: async () => null,
  insertJob: async (j: Row) => { jobStore.inserted.push(j); return { ...j, status: "queued", step: null, progress: {}, result: null, error: null, created_at: "2026-10-08T06:00:00.000Z", attempts: 0, failures: 0 }; },
}));

const T = await import("@/lib/jobs/kinds/sarvam-transcribe");
const X = await import("@/lib/jobs/kinds/sarvam-translate");
const C = await import("@/lib/jobs/kinds/sarvam-common");
const L = await import("@/lib/sarvam-lab");
const S = await import("@/lib/mcp/surface");
const O = await import("@/lib/stt/o4-scope");
const { BLIND_ROOM_DAYS } = await import("@/lib/rubrics/blind-room-days");
const { submitJob } = await import("@/lib/jobs/submit");
const [BD, BR] = BLIND_ROOM_DAYS[0]!;

const GW_ENV = { SARVAM_GCP_SA_KEY_JSON: "{}", SARVAM_GW_AUDIENCE: "1", SARVAM_GW_ROLE_ARN: "arn", SARVAM_GW_BASE_URL: "https://gw.example.test", SARVAM_GW_REGION: "ap-south-1" };
const savedEnv: Record<string, string | undefined> = {};
const JOB = { id: "job_t1", actor: "mcp:test", created_at: "2026-10-08T06:00:00.000Z" } as never;
const ctx = (step: string, args: Row, progress: Row = {}) => ({ job: JOB, step, args, progress }) as never;
const tool = (a: Row, scopes: string[] = ["read", "invoke"]) => S.CALLABLE_TOOLS.get("scribe_sarvam")!.handler(a, { origin: "https://x", actor: "mcp:test", scopes: new Set(scopes) } as never) as Promise<Row>;

const lab = new Map<string, { body: string; etag: string }>();
let labPuts: Array<{ key: string; cond: Row }> = [];
const labStore: import("@/lib/sarvam-lab").LabStore = {
  async get(k) { const o = lab.get(k); return o ? { body: o.body, etag: o.etag } : null; },
  async put(k, body, cond) {
    labPuts.push({ key: k, cond });
    const cur = lab.get(k);
    if (cond.ifNoneMatch && cur) return "precondition_failed";
    if (cond.ifMatch && cur?.etag !== cond.ifMatch) return "precondition_failed";
    lab.set(k, { body, etag: `"e${labPuts.length}"` });
    return "ok";
  },
  async list(prefix) { return [...lab.keys()].filter((k) => k.startsWith(prefix)); },
};

const CHUNK = { id: "bc_1", idx: 0, source: "primary", r2_key: "bench/room/2026-10-08/bs_1/chunk_00000.webm", content_type: "audio/webm", started_at: "2026-10-08T05:00:00Z", ended_at: "2026-10-08T05:05:00Z", upload_state: "verified", duration_ms: 300000, size_bytes: 1000, gap_before_ms: 0, created_at: "2026-10-08T05:05:00Z" };
const WIN = { session_id: "bs_1", start_ms: Date.parse("2026-10-08T05:01:00Z"), end_ms: Date.parse("2026-10-08T05:04:00Z") };
/** a database where window bw_1 exists on session bs_1, one chunk covers it, and (per `blind`) any placement is held out */
const world = (o: { blind?: boolean } = {}) => (text: string): unknown => {
  if (/FROM bench_window WHERE id/.test(text)) return [WIN];
  if (/FROM bench_chunk/.test(text) && !/FROM bench_session s WHERE s\.id/.test(text)) return [CHUNK];
  if (/SELECT \( EXISTS|SELECT \(\s*EXISTS/.test(text)) return [{ blind: o.blind === true }];
  if (/FROM bench_session s WHERE s\.id/.test(text)) return [{ room_id: "r_clean", started_ms: Date.parse("2026-10-08T05:00:00Z"), last_ms: Date.parse("2026-10-08T05:05:00Z"), window_blind: o.blind === true }];
  return [];
};

beforeEach(() => {
  statements.length = 0; store.clear(); lab.clear(); labPuts = []; jobStore.inserted.length = 0;
  headType = "audio/webm"; answer = () => [];
  for (const k of Object.keys(GW_ENV)) { savedEnv[k] = process.env[k]; process.env[k] = (GW_ENV as Record<string, string>)[k]; }
  Object.values(gw).forEach((f) => f.mockReset());
  T.sarvamTiming.pollStepMs = 0; T.sarvamTiming.pollIntervalMs = 0;
  C.auditRetry.delaysMs = [0, 0, 0];
  L.setLabStoreForTests(labStore);
});
afterEach(() => {
  for (const [k, v] of Object.entries(savedEnv)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  L.setLabStoreForTests(null);
});

describe("1. the caller class", () => {
  it("callerClassOf: only the literal 'mcp' is mcp; anything unknown is production (fail closed)", () => {
    expect(O.callerClassOf("mcp")).toBe("mcp");
    for (const v of [undefined, null, "", "MCP", "production", "research", 1, {}, true]) expect(O.callerClassOf(v), String(v)).toBe("production");
    expect(O.roomAudioAllowed("mcp")).toBe(true);
    expect(O.roomAudioAllowed("production")).toBe(false);
  });
  it("PRODUCTION caller with room audio: every room source is scope_consult_only (unchanged), transcribe and translate", () => {
    for (const bad of [{ window_id: "bw_1" }, { session_id: "bs_1", from: "2026-10-08T05:00:00Z", to: "2026-10-08T05:10:00Z" }, { room: "opd-1", date: "2026-10-08", from: "09:00", to: "09:10" }, { encounter_id: "enc_1", window_id: "bw_1" }]) {
      expect(() => T.parseSarvamTranscribeArgs(bad), JSON.stringify(bad)).toThrow(/^scope_consult_only/);
      expect(() => T.parseSarvamTranscribeArgs(bad, "production"), JSON.stringify(bad)).toThrow(/^scope_consult_only/);
    }
    expect(() => X.parseSarvamTranslateArgs({ window_id: "bw_1" })).toThrow(/^scope_consult_only/);
    expect(T.parseSarvamTranscribeArgs({ encounter_id: "enc_1" })).not.toHaveProperty("caller_class");
  });
  it("MCP caller: a window, a session range and a room+date range parse (ISO or HH:MM IST), carrying caller_class mcp; > 30 min and malformed are refused", () => {
    expect(T.parseSarvamTranscribeArgs({ window_id: "bw_1" }, "mcp")).toEqual({ source: "window", window_id: "bw_1", mode: "transcribe", english: true, caller_class: "mcp" });
    expect(T.parseSarvamTranscribeArgs({ session_id: "bs_1", from: "2026-10-08T05:00:00Z", to: "2026-10-08T05:10:00Z" }, "mcp")).toMatchObject({ source: "range", session_id: "bs_1", start: Date.parse("2026-10-08T05:00:00Z"), end: Date.parse("2026-10-08T05:10:00Z"), caller_class: "mcp" });
    expect(T.parseSarvamTranscribeArgs({ room: "opd-1", date: "2026-10-08", from: "10:30", to: "10:40" }, "mcp")).toMatchObject({ source: "range", room: "opd-1", date: "2026-10-08", start: Date.parse("2026-10-08T10:30:00+05:30"), end: Date.parse("2026-10-08T10:40:00+05:30") });
    expect(() => T.parseSarvamTranscribeArgs({ session_id: "bs_1", from: "2026-10-08T05:00:00Z", to: "2026-10-08T05:31:00Z" }, "mcp")).toThrow(/window_too_long/);
    for (const bad of [{ room: "opd-1", from: "10:30", to: "10:40" }, { session_id: "bs_1", from: "10:30", to: "10:40" }, { session_id: "bs_1", from: "2026-10-08T05:10:00Z", to: "2026-10-08T05:00:00Z" }, { session_id: "bs_1", room: "x", date: "2026-10-08", from: "10:30", to: "10:40" }, { window_id: "bw_1", session_id: "bs_1" }, { from_ms: 1 }, { room: "opd-1" }]) {
      expect(() => T.parseSarvamTranscribeArgs(bad, "mcp"), JSON.stringify(bad)).toThrow(/bad args|give exactly|end must be|no room source/);
    }
  });
  it("a job's args CANNOT claim a class: caller_class / origin / use / caller are bad_args for either class; the tool layer sets it, and the stored args carry it", async () => {
    for (const k of ["caller_class", "origin", "use", "caller"]) {
      expect(() => T.parseSarvamTranscribeArgs({ window_id: "bw_1", [k]: "mcp" }, "mcp"), k).toThrow(/cannot be set by a caller/);
      expect(() => T.parseSarvamTranscribeArgs({ encounter_id: "enc_1", [k]: "mcp" }), k).toThrow(/cannot be set by a caller/);
      expect(() => X.parseSarvamTranslateArgs({ window_id: "bw_1", [k]: "mcp" }, "mcp"), k).toThrow(/cannot be set by a caller/);
    }
    answer = world();
    expect(await tool({ action: "transcribe", room_audio: { window_id: "bw_1" } })).toMatchObject({ ok: true });
    expect(jobStore.inserted[0]!.args).toMatchObject({ source: "window", window_id: "bw_1", caller_class: "mcp" });
    // submitJob WITHOUT callerClass (any non-MCP submitter) is production: the room source is refused and no row is written
    jobStore.inserted.length = 0;
    await expect(submitJob({ kind: "sarvam_transcribe", args: { window_id: "bw_1" }, actor: "cron", scopes: new Set(["read", "invoke"]) })).rejects.toThrow(/^scope_consult_only/);
    await expect(submitJob({ kind: "sarvam_transcribe", args: { window_id: "bw_1", caller_class: "mcp" }, actor: "cron", scopes: new Set(["read", "invoke"]), callerClass: "mcp" })).rejects.toThrow(/cannot be set by a caller/);
    expect(jobStore.inserted).toEqual([]);
  });
});

describe("2. held out: refused before any audio read, at submit and at the first step", () => {
  it("MCP submit of a held-out window / session range / room+date: blind_room_day, no job row, 0 R2 reads, 0 Sarvam calls", async () => {
    answer = world({ blind: true });
    const { getObjectBytes } = await import("@/lib/r2");
    expect(await tool({ action: "transcribe", room_audio: { window_id: "bw_1" } })).toMatchObject({ ok: false, error: "blind_room_day" });
    expect(await tool({ action: "transcribe", room_audio: { session_id: "bs_1", from: "2026-10-08T05:00:00Z", to: "2026-10-08T05:10:00Z" } })).toMatchObject({ ok: false, error: "blind_room_day" });
    // a room + date that IS a held-out pair, with a clean-looking session
    answer = (text) => (/FROM room WHERE/.test(text) ? [{ id: BR }] : world()(text));
    expect(await tool({ action: "transcribe", room_audio: { room: BR, date: BD, from: "10:00", to: "10:10" } })).toMatchObject({ ok: false, error: "blind_room_day" });
    answer = world({ blind: true });
    expect(await tool({ action: "translate", room_audio: { window_id: "bw_1" } })).toMatchObject({ ok: false, error: "blind_room_day" });
    expect(jobStore.inserted).toEqual([]);
    expect(getObjectBytes).not.toHaveBeenCalled();
    expect(gw.init).not.toHaveBeenCalled();
    expect(statements.filter((s) => /FROM bench_chunk/.test(s.text) && !/FROM bench_session s WHERE/.test(s.text))).toEqual([]);
  });
  it("a job already in the table (past submit) fails at its first step through the runner hook: heldOut says blind_room_day for window, range and the translate window", async () => {
    answer = world({ blind: true });
    expect(await T.sarvamTranscribeKind.heldOut!({ source: "window", window_id: "bw_1", caller_class: "mcp" })).toBe("blind_room_day");
    expect(await T.sarvamTranscribeKind.heldOut!({ source: "range", session_id: "bs_1", start: WIN.start_ms, end: WIN.end_ms, caller_class: "mcp" })).toBe("blind_room_day");
    expect(await X.sarvamTranslateKind.heldOut!({ kind: "window", id: "bw_1", caller_class: "mcp" })).toBe("blind_room_day");
    answer = world({ blind: false });
    expect(await T.sarvamTranscribeKind.heldOut!({ source: "window", window_id: "bw_1", caller_class: "mcp" })).toBe(null);
  });
});

describe("3. prepare / caps / audit row, in the existing order, through the gateway only", () => {
  const winArgs = { source: "window", window_id: "bw_1", mode: "transcribe", english: false, caller_class: "mcp" };
  it("prepare (MCP stored class): resolves the covering chunk, scope window, use mcp; no audio is read yet", async () => {
    answer = world();
    const out = await T.sarvamTranscribeKind.run(ctx("prepare", winArgs));
    expect(out).toEqual({ kind: "next", step: "init", progress: { clip_key: CHUNK.r2_key, content_type: "audio/webm", scope: "window", ref: "bw_1", source_kind: "room_window", use: "mcp", chunk_whole: true, clip_start_ms: Date.parse(CHUNK.started_at), clip_end_ms: Date.parse(CHUNK.ended_at) } });
    const { getObjectBytes } = await import("@/lib/r2");
    expect(getObjectBytes).not.toHaveBeenCalled();
    const seg = await T.sarvamTranscribeKind.run(ctx("prepare", { source: "range", session_id: "bs_1", start: WIN.start_ms, end: WIN.end_ms, mode: "transcribe", english: false, caller_class: "mcp" }));
    expect(seg).toMatchObject({ kind: "next", progress: { scope: "room_segment", source_kind: "room_segment", use: "mcp", ref: "bs_1" } });
  });
  it("prepare with NO stored mcp class (a production job): scope_consult_only, 0 chunk reads", async () => {
    answer = world();
    const out = await T.sarvamTranscribeKind.run(ctx("prepare", { ...winArgs, caller_class: undefined }));
    expect(out).toMatchObject({ kind: "fail", error: expect.stringMatching(/^scope_consult_only/) });
    expect(statements.filter((s) => /FROM bench_chunk|FROM bench_window/.test(s.text))).toEqual([]);
  });
  it("init: the daily/job cap is checked BEFORE the Sarvam job is created (spy order); a cap refusal never reaches the gateway", async () => {
    store.set(CHUNK.r2_key, webm({ declaredMs: 180_000 }));
    const order: string[] = [];
    gw.init.mockImplementation(async () => { order.push("gw.init"); return { ok: true, jobId: "sj_1" }; });
    answer = (text) => { if (/FROM scribe_job/.test(text) || /FROM audit_log/.test(text)) order.push("cap"); return []; };
    const prog = { clip_key: CHUNK.r2_key, content_type: "audio/webm", scope: "window", ref: "bw_1", use: "mcp" };
    const out = await T.sarvamTranscribeKind.run(ctx("init", winArgs, prog));
    expect(out).toMatchObject({ kind: "next", step: "upload", progress: { sarvam_job_id: "sj_1", duration_ms: 180_000, scope: "window", use: "mcp" } });
    expect(order.indexOf("cap")).toBeGreaterThanOrEqual(0);
    expect(order.indexOf("cap")).toBeLessThan(order.indexOf("gw.init"));
    gw.init.mockClear();
    answer = (text) => (/j\.progress \? 'sarvam_job_id'/.test(text) ? [{ minutes: 0 }] : /FROM audit_log/.test(text) ? [{ minutes: 240 }] : []);
    expect(await T.sarvamTranscribeKind.run(ctx("init", winArgs, prog))).toMatchObject({ kind: "fail", error: expect.stringMatching(/^sarvam_daily_cap/) });
    expect(gw.init).not.toHaveBeenCalled();
  });
  it("start: the ONE paid-call audit row carries use + scope (window / room_segment), counts only; a production caller cannot write a room scope", async () => {
    gw.status.mockResolvedValue({ ok: true, state: "Pending", outputs: [] });
    gw.startJob.mockResolvedValue({ ok: true });
    const prog = { clip_key: "k", content_type: "audio/webm", sarvam_job_id: "sj_9", duration_ms: 180_000, scope: "window", ref: "bw_1", use: "mcp", started_at: "2026-10-08T06:00:00.000Z" };
    await T.sarvamTranscribeKind.run(ctx("start", winArgs, prog));
    const ins = statements.filter((s) => /INSERT INTO audit_log/.test(s.text));
    expect(ins).toHaveLength(1);
    const meta = JSON.parse(ins[0]!.values.find((v) => typeof v === "string" && v.startsWith("{")) as string);
    expect(meta).toMatchObject({ engine: "sarvam-gw", job_id: "job_t1", scope: "window", use: "mcp", audio_minutes: 3 });
    expect(Object.keys(meta).sort()).toEqual(["audio_minutes", "cost_per_min_usd", "duration_ms", "engine", "estimated_cost_usd", "job_id", "rate_source", "sarvam_job_id", "scope", "use"]);
    await expect(C.recordSarvamCall({ actor: "a", jobId: "j", sarvamJobId: "s", durationMs: 1000, scope: "window", use: "production" })).rejects.toThrow(/scope_requires_mcp/);
    await expect(C.recordSarvamCall({ actor: "a", jobId: "j", sarvamJobId: "s", durationMs: 1000, scope: "room_segment" })).rejects.toThrow(/scope_requires_mcp/); // no use = production
    await expect(C.recordSarvamCall({ actor: "a", jobId: "j2", sarvamJobId: "s", durationMs: 1000, scope: "consult_clip" })).resolves.toBeUndefined();
  });
  it("finish: the result is labelled sarvam_mcp_research and the step writes ONLY the R2 result object and a ledger line: no cue, stt_turn or transcription_run write", async () => {
    gw.result.mockResolvedValue({ ok: true, entries: [{ transcript: "hello doctor", start: 0, end: 3, speakerId: "0", languageCode: "en-IN" }], transcript: "hello doctor", languageCode: "en-IN" });
    const fin = { sarvam_job_id: "sj_9", sarvam_started_ms: 1, clip_key: "k", duration_ms: 180_000, scope: "window", ref: "bw_1", use: "mcp", outputs: ["0.json"], started_at: "2026-10-08T06:00:00.000Z" };
    const out = await T.sarvamTranscribeKind.run(ctx("finish", { ...winArgs, english: false }, fin));
    expect(out).toMatchObject({ kind: "done", result: { source: "sarvam_mcp_research" } });
    const doc = JSON.parse(Buffer.from(store.get("mcp-sarvam/job_t1.json")!).toString("utf8"));
    expect(doc.source_label).toBe("sarvam_mcp_research");
    expect(statements.filter((s) => /INSERT INTO (cue|transcription_run|room_turn_speaker|room_span_emotion|jev_)|UPDATE (cue|transcription_run)/.test(s.text))).toEqual([]);
    const lines = [...lab.entries()].filter(([k]) => k.startsWith("sarvam/ledger/")).flatMap(([, v]) => v.body.split("\n").filter(Boolean).map((l) => JSON.parse(l)));
    expect(lines).toEqual([expect.objectContaining({ job_id: "job_t1", scope: "window", use: "mcp", ref: "bw_1", status: "ok" })]);
    // an encounter result carries no research label
    const enc = await T.sarvamTranscribeKind.run(ctx("finish", { source: "encounter", encounter_id: "enc_1", mode: "transcribe", english: false }, { ...fin, scope: "encounter", ref: "enc_1", use: "production" }));
    expect((enc as { result: Row }).result.source).toBeUndefined();
  });
});

describe("4. scribe_transcribe_range with a Sarvam engine (MCP) = a gateway job; never whisper, never the direct adapter", () => {
  it("queues sarvam_transcribe over the range with callerClass mcp; held-out refused with no row", async () => {
    const t = S.CALLABLE_TOOLS.get("scribe_transcribe_range")!;
    const c = { origin: "https://x", actor: "mcp:test", scopes: new Set(["read", "invoke"]) } as never;
    answer = world();
    const out = (await t.handler({ session_id: "bs_1", start: "2026-10-08T05:00:00Z", end: "2026-10-08T05:10:00Z", engine: "sarvam" }, c)) as Row;
    expect(out).toMatchObject({ ok: true, async: true, engine: "sarvam-gw", source: "sarvam_mcp_research", kind: "sarvam_transcribe" });
    expect(jobStore.inserted[0]).toMatchObject({ kind: "sarvam_transcribe", args: { source: "range", session_id: "bs_1", caller_class: "mcp" } });
    jobStore.inserted.length = 0;
    answer = world({ blind: true });
    expect(await t.handler({ session_id: "bs_1", start: "2026-10-08T05:00:00Z", end: "2026-10-08T05:10:00Z", engine: "sarvam" }, c)).toMatchObject({ ok: false, error: "blind_room_day" });
    expect(jobStore.inserted).toEqual([]);
  });
});

describe("5. contract v1.2: the whole day file from Neon, the lane by use / scope / status", () => {
  const audit = (job: string, o: Row = {}) => ({ job_id: job, created_at: "2026-10-08T06:00:00.000Z", meta: { engine: "sarvam-gw", job_id: job, sarvam_job_id: `sj_${job}`, scope: "window", use: "mcp", duration_ms: 180_000, audio_minutes: 3, ...o }, job_status: "done", job_finished_at: "2026-10-08T06:05:00.000Z", job_progress: { started_at: "2026-10-08T06:01:00.000Z" } });
  it("lineFromNeon: sarvam.call.v1 fields exactly, enums only, no text; an unfinished job has no line yet", () => {
    const l = L.lineFromNeon(audit("job_a") as never)!;
    expect(Object.keys(l).sort()).toEqual(["audio_s", "caller", "chars", "finished_at", "http_status", "job_id", "machine", "mode", "model", "ref", "request_id", "route", "scope", "started_at", "status", "task", "throttled", "use"]);
    expect(l).toMatchObject({ caller: "scribe-mcp", scope: "window", use: "mcp", status: "ok", http_status: 200, task: "transcribe", audio_s: 180, request_id: "sj_job_a" });
    expect(L.lineFromNeon({ ...audit("job_b"), job_status: "running" } as never)).toBeNull();
    expect(L.lineFromNeon(audit("job_c", { scope: "room_segment" }) as never)!.scope).toBe("room_segment");
    expect(L.lineFromNeon(audit("job_d", { scope: undefined, use: undefined }) as never)).toMatchObject({ scope: "other", use: "production" });
    expect(L.lineFromNeon({ ...audit("job_e:en") } as never)).toMatchObject({ task: "translate" });
  });
  it("two CONCURRENT finishes (each rewrites the day from Neon, with a 412 in between): the file holds both rows, in order, once each", async () => {
    answer = (text) => (/FROM audit_log a LEFT JOIN scribe_job j/.test(text) ? [audit("job_a"), audit("job_b", { scope: "room_segment" })] : []);
    const results = await Promise.all([L.rewriteLedgerDay("2026-10-08"), L.rewriteLedgerDay("2026-10-08")]);
    expect(results).toEqual([true, true]);
    const body = lab.get("sarvam/ledger/scribe-mcp/2026-10-08.jsonl")!.body;
    const lines = body.split("\n").filter(Boolean).map((l) => JSON.parse(l));
    expect(lines.map((l) => l.job_id)).toEqual(["job_a", "job_b"]);
    expect(body).not.toMatch(/transcript|text|entries/);
    // idempotent: another rewrite changes nothing (no extra put)
    const puts = labPuts.length;
    await L.rewriteLedgerDay("2026-10-08");
    expect(labPuts.length).toBe(puts);
  });
  it("lines already in the file that Neon does not hold (text translations) are kept; an ok line is never displaced by a failed one", async () => {
    lab.set("sarvam/ledger/scribe-mcp/2026-10-08.jsonl", { etag: '"e0"', body: `${JSON.stringify({ caller: "scribe-mcp", job_id: "job_t:translate", task: "text_translate", status: "ok", scope: "encounter", started_at: "2026-10-08T05:00:00.000Z", chars: 10 })}\n${JSON.stringify({ caller: "scribe-mcp", job_id: "job_a", task: "transcribe", status: "ok", scope: "window", use: "mcp", started_at: "2026-10-08T06:01:00.000Z" })}\n` });
    answer = (text) => (/FROM audit_log a LEFT JOIN scribe_job j/.test(text) ? [{ ...audit("job_a"), job_status: "failed" }] : []);
    await L.rewriteLedgerDay("2026-10-08");
    const lines = lab.get("sarvam/ledger/scribe-mcp/2026-10-08.jsonl")!.body.split("\n").filter(Boolean).map((l) => JSON.parse(l));
    expect(lines.map((l) => [l.job_id, l.status])).toEqual([["job_t:translate", "ok"], ["job_a", "ok"]]);
  });
  it("the lane's today carries counts by use / scope / status", async () => {
    answer = (text) => (/FROM audit_log a LEFT JOIN scribe_job j/.test(text) ? [audit("job_a"), audit("job_b", { scope: "room_segment" }), { ...audit("job_c", { scope: "consult_clip", use: "production" }), job_status: "failed" }] : []);
    const today = L.istDateOf(Date.now());
    await L.rewriteLedgerDay("2026-10-08");
    lab.set(`sarvam/ledger/scribe-mcp/${today}.jsonl`, lab.get("sarvam/ledger/scribe-mcp/2026-10-08.jsonl")!);
    await L.touchLane({ force: true });
    const lane = JSON.parse(lab.get("lanes/sarvam-scribe-mcp.json")!.body);
    expect(lane.today).toMatchObject({ jobs: 3, by_use: { mcp: 2, production: 1 }, by_scope: { window: 1, room_segment: 1, consult_clip: 1 }, by_status: { ok: 2, failed: 1 } });
    expect(JSON.stringify(lane)).not.toMatch(/transcript|entries/);
  });
  it("the lab store allowlist: PUT only the two key shapes (day ledger of this caller, lane); anything else is refused", async () => {
    expect(L.labWritable("sarvam/ledger/scribe-mcp/2026-10-08.jsonl")).toBe(true);
    expect(L.labWritable("lanes/sarvam-scribe-mcp.json")).toBe(true);
    for (const k of ["sarvam/ledger/other-caller/2026-10-08.jsonl", "sarvam/ledger/scribe-mcp/2026-10-08.json", "sarvam/ledger/scribe-mcp/../x.jsonl", "lanes/sarvam-other.json", "reb/2026-10-08/x.json", "mcp-sarvam/job_1.json", "sarvam/ledger/scribe-mcp/notadate.jsonl"]) expect(L.labWritable(k), k).toBe(false);
    const guarded = L.labStore()!;
    await expect(guarded.put("sarvam/ledger/other-caller/2026-10-08.jsonl", "x", {})).rejects.toThrow(/lab_key_not_writable/);
  });
  it("a failed write is logged, never thrown, and the next rewrite repairs it (the call still counts in Neon)", async () => {
    answer = (text) => (/FROM audit_log a LEFT JOIN scribe_job j/.test(text) ? [audit("job_a")] : []);
    const bad: import("@/lib/sarvam-lab").LabStore = { ...labStore, put: async () => { throw new Error("down"); } };
    L.setLabStoreForTests(bad);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    await expect(L.rewriteLedgerDay("2026-10-08")).resolves.toBe(false);
    warn.mockRestore();
    L.setLabStoreForTests(labStore);
    await expect(L.rewriteLedgerDay("2026-10-08")).resolves.toBe(true);
    expect(lab.get("sarvam/ledger/scribe-mcp/2026-10-08.jsonl")!.body).toContain("job_a");
  });
});

describe("D-1 the {room, date, from, to} source is checked on the SESSION it resolves to (both refuter repros), R-1 the audit retry, R-2 chunk_whole", () => {
  const DAY = Date.parse("2026-10-05T04:30:00Z");
  /** a database: room r_clean (slug room_clean01) has session bs_2 over the range; sessionBlind says what the session guard answers */
  const rangeWorld = (o: { windowBlind?: boolean; sessionRunsIntoBlind?: boolean } = {}) => (text: string): unknown => {
    if (/FROM room WHERE/.test(text)) return [{ id: "r_clean" }];
    if (/FROM bench_session s\s+JOIN room r|FROM bench_session s JOIN room r|LEFT JOIN bench_chunk c ON c\.session_id = s\.id/.test(text)) return [{ id: "bs_2", room_id: "r_clean", started_at: new Date(DAY - 600_000).toISOString(), ended_at: new Date(DAY + 3_600_000).toISOString(), last_any_chunk_at: new Date(DAY + 3_000_000).toISOString() }];
    if (/FROM bench_session s WHERE s\.id/.test(text)) return [{ room_id: "r_clean", started_ms: DAY - 600_000, last_ms: DAY + 3_000_000, window_blind: o.windowBlind === true || o.sessionRunsIntoBlind === true }];
    if (/FROM bench_chunk/.test(text)) return [{ ...CHUNK, started_at: new Date(DAY).toISOString(), ended_at: new Date(DAY + 900_000).toISOString() }];
    return [];
  };
  const rangeArgs = { room: "room_clean01", date: "2026-10-05", from: "10:05", to: "10:10" };
  it("repro 1 (clean-day range over a session whose window has held-out turn rows) and repro 2 (a session running into the held-out day): refused at submit with NO row and 0 R2 reads, via the hook and via prepare", async () => {
    const { getObjectBytes } = await import("@/lib/r2");
    (getObjectBytes as unknown as { mockClear: () => void }).mockClear();
    for (const o of [{ windowBlind: true }, { sessionRunsIntoBlind: true }]) {
      answer = rangeWorld(o);
      expect(await tool({ action: "transcribe", room_audio: rangeArgs }), JSON.stringify(o)).toMatchObject({ ok: false, error: "blind_room_day" });
      const args = T.parseSarvamTranscribeArgs(rangeArgs, "mcp") as unknown as Row;
      expect(await T.sarvamTranscribeKind.heldOut!(args)).toBe("blind_room_day");
      // a job that got past the hook (inserted at prepare) is still stopped before any chunk read
      statements.length = 0;
      expect(await T.sarvamTranscribeKind.run(ctx("prepare", args))).toMatchObject({ kind: "fail", error: "blind_room_day" });
      expect(statements.filter((s) => /FROM bench_chunk(?! c)/.test(s.text) && !/FROM bench_session s WHERE/.test(s.text))).toEqual([]);
    }
    expect(jobStore.inserted).toEqual([]);
    expect(getObjectBytes).not.toHaveBeenCalled();
    // the clean session is served: queued, and prepare resolves the chunk
    answer = rangeWorld();
    expect(await tool({ action: "transcribe", room_audio: rangeArgs })).toMatchObject({ ok: true });
  });
  it("R-2: a single covering chunk goes whole and the result says chunk_whole:true with the real span of the audio sent", async () => {
    answer = rangeWorld();
    const args = T.parseSarvamTranscribeArgs(rangeArgs, "mcp") as unknown as Row;
    const out = (await T.sarvamTranscribeKind.run(ctx("prepare", args))) as { progress: Row };
    expect(out.progress).toMatchObject({ chunk_whole: true, clip_start_ms: DAY, clip_end_ms: DAY + 900_000 });
    gw.result.mockResolvedValue({ ok: true, entries: [{ transcript: "x", start: 0, end: 1, speakerId: "0" }], transcript: "x", languageCode: "en-IN" });
    const fin = { ...out.progress, sarvam_job_id: "sj_9", sarvam_started_ms: 1, duration_ms: 600_000, outputs: ["0.json"], started_at: "2026-10-08T06:00:00.000Z" };
    const done = await T.sarvamTranscribeKind.run(ctx("finish", { ...args, english: false }, fin));
    expect(done).toMatchObject({ kind: "done", result: { source: "sarvam_mcp_research", chunk_whole: true, clip_span: { start: DAY, end: DAY + 900_000 } } });
  });
  it("R-1: the first audit write FAILS (all retries), the job goes on to poll with audit_pending, and the retry on the next claim writes the row exactly once", async () => {
    gw.status.mockResolvedValue({ ok: true, state: "Pending", outputs: [] });
    gw.startJob.mockResolvedValue({ ok: true });
    let fail = true;
    answer = (text) => (/INSERT INTO audit_log/.test(text) && fail ? new Error("audit table gone") : []);
    const err = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const prog = { clip_key: "k", content_type: "audio/webm", sarvam_job_id: "sj_9", duration_ms: 180_000, scope: "window", ref: "bw_1", use: "mcp", started_at: "2026-10-08T06:00:00.000Z" };
    const started = (await T.sarvamTranscribeKind.run(ctx("start", { source: "window", window_id: "bw_1", mode: "transcribe", english: false, caller_class: "mcp" }, prog))) as { kind: string; step: string; progress: Row };
    expect(started).toMatchObject({ kind: "next", step: "poll", progress: { audit_pending: true, sarvam_job_id: "sj_9" } });
    expect(started.progress.sarvam_started_ms).toEqual(expect.any(Number));
    fail = false;
    statements.length = 0;
    gw.status.mockResolvedValue({ ok: true, state: "Running", outputs: [] });
    const polled = (await T.sarvamTranscribeKind.run(ctx("poll", { source: "window", window_id: "bw_1", mode: "transcribe", english: false, caller_class: "mcp" }, started.progress))) as { progress: Row };
    err.mockRestore();
    expect(polled.progress.audit_pending).toBeUndefined();
    const ins = statements.filter((s) => /INSERT INTO audit_log/.test(s.text));
    expect(ins).toHaveLength(1);
    expect(JSON.parse(ins[0]!.values.find((v) => typeof v === "string" && v.startsWith("{")) as string)).toMatchObject({ scope: "window", use: "mcp", job_id: "job_t1" });
    expect(gw.startJob).toHaveBeenCalledTimes(1);
  });
});

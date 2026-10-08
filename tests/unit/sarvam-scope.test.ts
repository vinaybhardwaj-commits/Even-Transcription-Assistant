/**
 * S8A-FIX2 — V's ruling O4: Sarvam takes ONLY cut consult clips and doctor-app / phone encounter audio. Room and bench audio is refused on every MCP path
 * that could send it (scope_consult_only), and a Sarvam job ended by the runner or by a cancel still writes its one ledger line. sql, the job store, R2
 * and the lab store are mocked; no network.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { readFileSync } from "node:fs";

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

const insertJob = vi.fn(async (i: { id: string; kind: string; args: Row; actor: string | null }) => ({ id: "job_new", kind: i.kind, status: "queued", args: i.args }));
const jobsById = new Map<string, Row>();
const storeFns = {
  failJob: vi.fn(async () => 1),
  recordFailure: vi.fn(async () => ({ failures: 3, status: "failed" })),
  cancelJob: vi.fn(),
  readJob: vi.fn(async (id: string) => jobsById.get(id) ?? null),
};
vi.mock("@/lib/jobs/store", async (orig) => ({
  ...((await orig()) as object),
  insertJob: (...a: unknown[]) => insertJob(...(a as [never])),
  failJob: (...a: unknown[]) => storeFns.failJob(...(a as [])),
  recordFailure: (...a: unknown[]) => storeFns.recordFailure(...(a as [])),
  cancelJob: (...a: unknown[]) => storeFns.cancelJob(...(a as [])),
  readJob: (...a: unknown[]) => storeFns.readJob(...(a as [string])),
}));

const roomPrepare = vi.fn(async () => ({ ok: true, step: "ok", next_progress: {} }));
vi.mock("@/lib/stt/room-drain", async (orig) => ({ ...((await orig()) as object), roomWindowPrepare: (...a: unknown[]) => roomPrepare(...(a as [])) }));
const gwStatus = vi.fn();
vi.mock("@/lib/sarvam-gw", async (orig) => ({ ...((await orig()) as object), gwBatchStatus: (...a: unknown[]) => gwStatus(...a) }));

const Scope = await import("@/lib/stt/sarvam-scope");
const S = await import("@/lib/mcp/surface");
const L = await import("@/lib/sarvam-lab");
const H = await import("@/lib/jobs/sarvam-hook");
const { runOneStep } = await import("@/lib/jobs/runner");
const { KIND_BY_NAME } = await import("@/lib/jobs/kinds");

const ctx = { origin: "https://x", actor: "mcp:test", scopes: new Set(["read", "invoke", "write"]) } as never;
const call = async (tool: string, args: Row) => (await S.CALLABLE_TOOLS.get(tool)!.handler(args, ctx)) as Row;

// the lab store (R2 eta-lab-results) in memory
const lab = new Map<string, { body: string; etag: string }>();
let n = 0;
const labStore: import("@/lib/sarvam-lab").LabStore = {
  async get(k) { const o = lab.get(k); return o ? { body: o.body, etag: o.etag } : null; },
  async put(k, body) { lab.set(k, { body, etag: `"e${++n}"` }); return "ok"; },
  async list(p) { return [...lab.keys()].filter((k) => k.startsWith(p)); },
};
const ledger = (): Row[] => [...lab.entries()].filter(([k]) => k.startsWith("sarvam/ledger/")).flatMap(([, v]) => v.body.split("\n").filter(Boolean).map((l) => JSON.parse(l) as Row));

/** the routing / engine tables: the room stage routes to `roomEngine`; engines can alias to the sarvam adapter */
let roomEngine: string | null = "sarvam";
let engineRows: Record<string, string> = { sarvam: "sarvam", whisper: "whisper", indic_x: "sarvam", route: "route" };
const tables = (text: string, values: unknown[]): unknown => {
  if (/FROM stt_routing/.test(text)) return roomEngine ? [{ engine_id: roomEngine }, { engine_id: "auto" }] : [];
  if (/FROM stt_engine/.test(text)) { const id = String(values[0]); return id in engineRows ? [{ adapter_key: engineRows[id] }] : []; }
  return [];
};

beforeEach(() => {
  statements.length = 0; lab.clear(); n = 0; jobsById.clear();
  roomEngine = "sarvam"; engineRows = { sarvam: "sarvam", whisper: "whisper", indic_x: "sarvam", route: "route" };
  answer = tables;
  insertJob.mockClear(); roomPrepare.mockClear(); gwStatus.mockReset();
  Object.values(storeFns).forEach((f) => f.mockClear());
  storeFns.failJob.mockImplementation(async () => 1);
  storeFns.recordFailure.mockImplementation(async () => ({ failures: 3, status: "failed" }));
  L.setLabStoreForTests(labStore);
});
afterEach(() => L.setLabStoreForTests(null));

describe("the helpers", () => {
  it("G21: the room-stage read has a deterministic ORDER BY and no LIMIT, so no routing row can go unchecked by truncation", async () => {
    const seen: string[] = [];
    answer = (text) => { if (/FROM stt_routing/.test(text)) seen.push(text); return []; };
    await Scope.checkRoomStage();
    expect(seen[0]).toMatch(/ORDER BY engine_id/);
    expect(seen[0]).not.toMatch(/LIMIT/);
  });
  it("namesSarvam: sarvam, sarvam-gw, sarvam_anything, any case — nothing else", () => {
    for (const id of ["sarvam", "SARVAM", "sarvam-gw", "sarvam_scribe", "x-sarvam-y"]) expect(Scope.namesSarvam(id), id).toBe(true);
    for (const id of ["whisper", "deepgram", "route", "indicconformer", "", null, undefined]) expect(Scope.namesSarvam(id as string), String(id)).toBe(false);
  });
  it("engineRoutesToSarvam: by name, or by the stt_engine row's adapter_key; a database error never answers 'no' for a name", async () => {
    expect(await Scope.engineRoutesToSarvam("sarvam")).toBe(true);
    expect(await Scope.engineRoutesToSarvam("indic_x")).toBe(true); // an alias row whose adapter is sarvam
    expect(await Scope.engineRoutesToSarvam("whisper")).toBe(false);
    expect(await Scope.engineRoutesToSarvam("route")).toBe(false);
    expect(await Scope.engineRoutesToSarvam("unknown_engine")).toBe(false);
    answer = () => new Error("db down");
    expect(await Scope.engineRoutesToSarvam("sarvam-gw")).toBe(true);
    // S5: FAIL CLOSED — an id we cannot clear without the table is refused (true), and the reason is its own: unavailable, not "sarvam"
    expect(await Scope.engineRoutesToSarvam("indic_x")).toBe(true);
    expect(await Scope.checkEngine("indic_x")).toBe("unavailable");
    expect(await Scope.checkEngine("sarvam-gw")).toBe("sarvam"); // a name needs no database
    expect(await Scope.checkEngine(null)).toBe("clear");
  });
  it("S5 path 1 — the engine lookup fails: scribe_transcribe_range refuses with scope_check_unavailable (not scope_consult_only), for any named engine", async () => {
    answer = () => new Error("db down");
    for (const engine of ["whisper", "indic_x", "route"]) {
      const out = await call("scribe_transcribe_range", { start: "10:00", end: "10:01", session_id: "bs_1", engine });
      expect(out, engine).toMatchObject({ ok: false, error: "scope_check_unavailable", tool: "scribe_transcribe_range", engine });
    }
    expect(await call("scribe_transcribe_range", { start: "10:00", end: "10:01", session_id: "bs_1", engine: "sarvam" })).toMatchObject({ error: "scope_consult_only" });
  });
  it("S5 path 2 — the routing read fails: an MCP room_window submit is refused with scope_check_unavailable and nothing is queued; the kind refuses the same way before claiming", async () => {
    answer = (text) => (/FROM stt_routing/.test(text) ? new Error("db down") : []);
    expect(await Scope.checkRoomStage()).toBe("unavailable");
    expect(await Scope.roomStageRoutesToSarvam()).toBe(true);
    expect(await call("scribe_job_submit", { kind: "room_window", args: { window_id: "bw_1", origin: "https://x", actor: "mcp:night", via: "mcp" } })).toMatchObject({ ok: false, error: "scope_check_unavailable", kind: "room_window" });
    expect(insertJob).not.toHaveBeenCalled();
    const k = KIND_BY_NAME.get("room_window")!;
    expect(await k.run({ job: { id: "job_r" } as never, step: "prepare", args: { window_id: "bw_1", origin: "https://x", actor: "mcp:night", via: "mcp" }, progress: {} })).toEqual({ kind: "fail", error: expect.stringMatching(/^scope_check_unavailable/) });
    expect(roomPrepare).not.toHaveBeenCalled();
    // a route whose engine row cannot be read is also unavailable; a known Sarvam route wins over it
    answer = (text, values) => (/FROM stt_routing/.test(text) ? [{ engine_id: "indic_x" }, { engine_id: "sarvam" }] : /FROM stt_engine/.test(text) ? new Error("down") : tables(text, values));
    expect(await Scope.checkRoomStage()).toBe("sarvam");
    answer = (text) => (/FROM stt_routing/.test(text) ? [{ engine_id: "indic_x" }] : /FROM stt_engine/.test(text) ? new Error("down") : []);
    expect(await Scope.checkRoomStage()).toBe("unavailable");
    // cron / admin jobs are not subject to the check
    answer = () => new Error("db down");
    await k.run({ job: { id: "job_r" } as never, step: "prepare", args: { window_id: "bw_1", origin: "https://x", actor: "cron", via: "cron" }, progress: {} });
    expect(roomPrepare).toHaveBeenCalledTimes(1);
  });
  it("G12: PRODUCTION's rows — room/english = route, room/indic = route (adapter route) — are ALLOWED; room/indic = sarvam is refused", async () => {
    engineRows = { route: "route", whisper: "whisper", sarvam: "sarvam" };
    const rows = (pairs: Array<[string, string]>) => (text: string, values: unknown[]) =>
      /FROM stt_routing/.test(text) ? pairs.map(([bucket, engine]) => ({ language_bucket: bucket, engine_id: engine })) : tables(text, values);
    answer = rows([["english", "route"], ["indic", "route"]]);
    expect(await Scope.roomStageRoutesToSarvam()).toBe(false);
    answer = rows([["english", "route"], ["indic", "sarvam"]]);
    expect(await Scope.roomStageRoutesToSarvam()).toBe(true);
    answer = rows([["english", "route"], ["indic", "route"], ["default", "sarvam"]]);
    expect(await Scope.roomStageRoutesToSarvam()).toBe(true);
    answer = rows([["english", "route"], ["indic", "auto"]]);
    expect(await Scope.roomStageRoutesToSarvam()).toBe(false);
    // and end to end: with the production rows an MCP room_window submit goes through, with via stamped
    answer = rows([["english", "route"], ["indic", "route"]]);
    expect(await call("scribe_job_submit", { kind: "room_window", args: { window_id: "bw_1", origin: "https://x", actor: "mcp:night", via: "mcp" } })).toMatchObject({ ok: true, kind: "room_window" });
    answer = rows([["english", "route"], ["indic", "sarvam"]]);
    expect(await call("scribe_job_submit", { kind: "room_window", args: { window_id: "bw_1", origin: "https://x", actor: "mcp:night", via: "mcp" } })).toMatchObject({ ok: false, error: "scope_consult_only" });
  });
  it("roomStageRoutesToSarvam: any room bucket that routes to a Sarvam-backed engine", async () => {
    expect(await Scope.roomStageRoutesToSarvam()).toBe(true);
    roomEngine = "whisper";
    expect(await Scope.roomStageRoutesToSarvam()).toBe(false);
    roomEngine = "indic_x";
    expect(await Scope.roomStageRoutesToSarvam()).toBe(true);
    roomEngine = null;
    expect(await Scope.roomStageRoutesToSarvam()).toBe(false);
  });
});

describe("1a — scribe_transcribe_range refuses a Sarvam engine for room / bench ranges", () => {
  const range = { start: "2026-10-08 09:00", end: "2026-10-08 09:05", room: "opd-1" };
  const touchedAudio = () => statements.filter((s) => /bench_chunk|bench_session|FROM room\b/.test(s.text));

  it("sync and async: scope_consult_only, before any range, session or audio is touched", async () => {
    for (const engine of ["sarvam", "sarvam-gw", "indic_x"]) {
      for (const async of [false, true]) {
        statements.length = 0;
        expect(await call("scribe_transcribe_range", { ...range, engine, async }), `${engine} async=${async}`).toMatchObject({ ok: false, error: "scope_consult_only", tool: "scribe_transcribe_range", engine });
        expect(touchedAudio(), `${engine} async=${async}`).toEqual([]);
      }
    }
    expect(insertJob).not.toHaveBeenCalled();
  });

  it("a free engine is not refused by this gate (it proceeds to the ordinary range handling)", async () => {
    const out = await call("scribe_transcribe_range", { ...range, engine: "whisper" });
    expect(out.error).not.toBe("scope_consult_only");
  });
});

describe("1b — the transcribe_range JOB KIND refuses it too, so scribe_job_submit and scribe_jobs cannot bypass the tool", () => {
  const kind = KIND_BY_NAME.get("transcribe_range")!;
  const base = { room: "opd-1", start: "2026-10-08T03:30:00Z", end: "2026-10-08T03:35:00Z" };

  it("parseArgs: a Sarvam-named engine is scope_consult_only; no engine, or whisper, still parses", () => {
    for (const engine of ["sarvam", "SARVAM", "sarvam-gw", "sarvam_batch"]) expect(() => kind.parseArgs({ ...base, engine }), engine).toThrow(/^scope_consult_only/);
    expect(kind.parseArgs({ ...base })).toMatchObject({ room: "opd-1" });
    expect(kind.parseArgs({ ...base, engine: "whisper" })).toMatchObject({ room: "opd-1" });
  });

  it("scribe_job_submit and the scribe_jobs group answer the typed error and queue nothing", async () => {
    expect(await call("scribe_job_submit", { kind: "transcribe_range", args: { ...base, engine: "sarvam" } })).toMatchObject({ ok: false, error: "scope_consult_only", kind: "transcribe_range" });
    expect(await call("scribe_jobs", { action: "submit", kind: "transcribe_range", args: { ...base, engine: "sarvam-gw" } })).toMatchObject({ ok: false, error: "scope_consult_only" });
    expect(insertJob).not.toHaveBeenCalled();
    expect(await call("scribe_job_submit", { kind: "transcribe_range", args: { ...base } })).toMatchObject({ ok: true });
    expect(insertJob).toHaveBeenCalledTimes(1);
  });
});

describe("1c — room_window submitted through MCP", () => {
  const rw = { window_id: "bw_1", origin: "https://x", actor: "mcp:night", via: "mcp" };

  it("refused at submit when the room stage routes to Sarvam — and a caller cannot claim to be 'cron' to get past it", async () => {
    for (const via of ["mcp", "cron", "admin_route"]) {
      expect(await call("scribe_job_submit", { kind: "room_window", args: { ...rw, via } }), via).toMatchObject({ ok: false, error: "scope_consult_only", kind: "room_window" });
    }
    expect(await call("scribe_jobs", { action: "submit", kind: "room_window", args: rw })).toMatchObject({ ok: false, error: "scope_consult_only" });
    expect(insertJob).not.toHaveBeenCalled();
  });

  it("when the room stage does NOT route to Sarvam the submit goes through, with `via` stamped 'mcp' whatever the caller wrote", async () => {
    roomEngine = "whisper";
    expect(await call("scribe_job_submit", { kind: "room_window", args: { ...rw, via: "cron" } })).toMatchObject({ ok: true, kind: "room_window" });
    expect(insertJob.mock.calls[0]![0].args).toMatchObject({ window_id: "bw_1", via: "mcp" });
  });

  it("the kind itself refuses an MCP-origin job BEFORE it claims the window (a job already queued, or a route that changed); cron / admin jobs are untouched", async () => {
    const k = KIND_BY_NAME.get("room_window")!;
    const run = (via: string) => k.run({ job: { id: "job_r" } as never, step: "prepare", args: { ...rw, via }, progress: {} });
    expect(await run("mcp")).toEqual({ kind: "fail", error: "scope_consult_only: room and bench audio is not sent to Sarvam; only cut consult clips and doctor-app / phone encounter audio are" });
    expect(roomPrepare).not.toHaveBeenCalled();
    await run("cron");
    await run("admin_route");
    expect(roomPrepare).toHaveBeenCalledTimes(2);
    roomEngine = "whisper";
    await run("mcp");
    expect(roomPrepare).toHaveBeenCalledTimes(3);
  });
});

describe("G11 — the rule is re-checked where room_window picks the engine for an MCP-origin job (and only there)", () => {
  const k = KIND_BY_NAME.get("room_window")!;
  const segment = vi.fn();
  const rw = { window_id: "bw_1", origin: "https://x", actor: "mcp:night" };
  const run = (step: string, via: string, progress: Row = {}) => k.run({ job: { id: "job_r" } as never, step, args: { ...rw, via }, progress });
  const released = () => statements.filter((s) => /UPDATE bench_window SET state = 'closed'|UPDATE stt_subject_job SET state = 'queued'/.test(s.text));

  beforeEach(async () => {
    segment.mockReset();
    const drain = await import("@/lib/stt/room-drain");
    vi.spyOn(drain, "roomWindowSegment").mockImplementation((async (...a: unknown[]) => segment(...a)) as never);
    vi.spyOn(drain, "roomWindowEngine").mockImplementation((async () => ({ ok: true, step: "ok", next_progress: { done_engine: true } })) as never);
  });
  afterEach(() => vi.restoreAllMocks());

  it("a routing edit AFTER the prepare check: the segment step has just chosen Sarvam -> refused, the window handed back WITHOUT counting an attempt", async () => {
    roomEngine = "whisper"; // prepare/submit passed
    segment.mockResolvedValue({ ok: true, step: "ok", next_progress: { engine_id: "sarvam", silent_window: false } });
    expect(await run("segment", "mcp")).toEqual({ kind: "fail", error: "scope_consult_only: room and bench audio is not sent to Sarvam; only cut consult clips and doctor-app / phone encounter audio are" });
    const rel = released();
    expect(rel).toHaveLength(2);
    expect(rel[0]!.values).toContain("bw_1");
    for (const s of statements) expect(s.text).not.toMatch(/attempts|state = 'failed'/); // no attempt counted, nothing parked
  });
  it("an alias engine id (adapter sarvam) and a database error are refused too (fail closed)", async () => {
    segment.mockResolvedValue({ ok: true, step: "ok", next_progress: { engine_id: "indic_x" } });
    expect(await run("segment", "mcp")).toMatchObject({ kind: "fail", error: expect.stringMatching(/^scope_consult_only/) });
    // S5: with the engine table unreadable, ANY engine id is refused — with its own reason, scope_check_unavailable — and the window is released untouched
    segment.mockResolvedValue({ ok: true, step: "ok", next_progress: { engine_id: "whisper" } });
    answer = () => new Error("db down");
    statements.length = 0;
    expect(await run("segment", "mcp")).toMatchObject({ kind: "fail", error: expect.stringMatching(/^scope_check_unavailable/) });
    expect(released().length).toBeGreaterThanOrEqual(1); // the release was attempted (the database is down, so only the first UPDATE is even tried)
    segment.mockResolvedValue({ ok: true, step: "ok", next_progress: { engine_id: "my_engine" } });
    expect(await run("segment", "mcp")).toMatchObject({ kind: "fail", error: expect.stringMatching(/^scope_check_unavailable/) });
    // the engine step re-check refuses the same way
    expect(await run("engine", "mcp", { engine_id: "whisper" })).toMatchObject({ kind: "fail", error: expect.stringMatching(/^scope_check_unavailable/) });
  });
  it("a non-Sarvam engine proceeds to the engine step; a SILENT window (no engine call) is not refused; cron / admin jobs are untouched", async () => {
    segment.mockResolvedValue({ ok: true, step: "ok", next_progress: { engine_id: "route", silent_window: false } });
    expect(await run("segment", "mcp")).toMatchObject({ kind: "next", step: "engine" });
    segment.mockResolvedValue({ ok: true, step: "ok", next_progress: { engine_id: "sarvam", silent_window: true } });
    expect(await run("segment", "mcp")).toMatchObject({ kind: "next", step: "finish" });
    segment.mockResolvedValue({ ok: true, step: "ok", next_progress: { engine_id: "sarvam", silent_window: false } });
    for (const via of ["cron", "admin_route"]) expect(await run("segment", via), via).toMatchObject({ kind: "next", step: "engine" });
  });
  it("the engine step re-checks too, immediately before the engine is called", async () => {
    roomEngine = "whisper";
    expect(await run("engine", "mcp", { engine_id: "sarvam" })).toMatchObject({ kind: "fail", error: expect.stringMatching(/^scope_consult_only/) });
    expect(released()).toHaveLength(2);
    statements.length = 0;
    const drain = await import("@/lib/stt/room-drain");
    expect(await run("engine", "mcp", { engine_id: "route" })).toMatchObject({ kind: "next" });
    expect(await run("engine", "cron", { engine_id: "sarvam" })).toMatchObject({ kind: "next" });
    expect(vi.mocked(drain.roomWindowEngine)).toHaveBeenCalledTimes(2);
  });
});

describe("1d — the other paths that were checked (nothing to refuse, and the encounter path is untouched)", () => {
  it("stt_fanout (the bench job kind) is a not-implemented stub and sends nothing", async () => {
    const out = await KIND_BY_NAME.get("stt_fanout")!.run({ job: {} as never, step: "start", args: {}, progress: {} });
    expect(out.kind).toBe("fail");
  });
  it("the encounter fan-out and the sarvam kinds do not import the scope gate (encounter paths unchanged)", () => {
    for (const f of ["lib/stt/fanout.ts", "lib/jobs/kinds/sarvam-transcribe.ts", "lib/jobs/kinds/sarvam-translate.ts", "lib/stt/adapters/sarvam.ts"]) {
      expect(readFileSync(f, "utf8"), f).not.toMatch(/engineRoutesToSarvam|roomStageRoutesToSarvam|sarvam-scope/);
    }
  });
  it("the jev, fuse and silence tools carry no engine argument and no adapter call", () => {
    for (const f of ["lib/mcp/tools/jev.ts", "lib/mcp/tools/fuse.ts", "lib/mcp/tools/fuse-report.ts"]) expect(readFileSync(f, "utf8"), f).not.toMatch(/guardedTranscribe|adapterFor\(|\.transcribe\(/);
  });
});

describe("2 — a Sarvam job ended by the runner or cancelled writes one ledger line", () => {
  const job = (over: Row = {}) => ({
    id: "job_s1", kind: "sarvam_transcribe", args: { source: "encounter", encounter_id: "enc_1", mode: "transcribe", english: true }, status: "running", step: "poll",
    progress: { sarvam_job_id: "sj_9", sarvam_started_ms: Date.now(), duration_ms: 600_000, scope: "encounter", ref: "enc_1", started_at: "2026-10-08T06:00:00.000Z", clip_key: "k" },
    result: null, error: null, actor: "mcp:a", created_at: "2026-10-08T05:59:00.000Z", started_at: null, updated_at: "x", finished_at: null, lease_until: null, lease_owner: "r", attempts: 4, failures: 0, ...over,
  }) as never;

  it("endedLine: audio_s is the measured seconds when a batch was started, else 0; ids and enums only", () => {
    const j = job() as { id: string; kind: string; args: Row; progress: Row; created_at: string };
    expect(H.endedLine(j, "failed", "2026-10-08T07:00:00.000Z")).toEqual({
      caller: "scribe-mcp", machine: "vercel", route: "gateway", job_id: "job_s1", request_id: "sj_9", mode: "batch", task: "transcribe", model: "saaras:v3", audio_s: 600,
      started_at: "2026-10-08T06:00:00.000Z", finished_at: "2026-10-08T07:00:00.000Z", status: "failed", http_status: null, throttled: false, scope: "encounter", ref: "enc_1",
    });
    const notStarted = { ...j, progress: { clip_key: "k", scope: "encounter", ref: "enc_1", duration_ms: 600_000, sarvam_job_id: "sj_9" } }; // created at Sarvam, never started
    expect(H.endedLine(notStarted, "cancelled", "t")).toMatchObject({ audio_s: 0, status: "cancelled", request_id: "sj_9" });
    expect(H.endedLine({ ...j, progress: {} }, "cancelled", "t")).toMatchObject({ audio_s: 0, request_id: null, ref: "enc_1", scope: "encounter" });
    expect(H.endedLine({ ...j, args: { source: "consult", consult_uid: "cu_1" }, progress: {} }, "failed", "t")).toMatchObject({ scope: "consult_clip", ref: "cu_1" });
    // translating phase: the text task line
    expect(H.endedLine({ ...j, progress: { ...(j.progress as Row), translate_started_at: "2026-10-08T06:10:00.000Z", translate_chars: 1800 } }, "failed", "t")).toMatchObject({
      job_id: "job_s1:translate", task: "text_translate", mode: "sync", model: "mayura:v1", audio_s: 0, chars: 1800,
    });
    const tr = { id: "job_t1", kind: "sarvam_translate", args: { kind: "transcription_run", id: "trun_1" }, progress: {}, created_at: "2026-10-08T05:00:00.000Z" };
    expect(H.endedLine(tr, "cancelled", "t")).toMatchObject({ job_id: "job_t1", task: "text_translate", ref: "run:trun_1", audio_s: 0, chars: 0, status: "cancelled" });
  });

  it("failures_exceeded (the runner fails the job before running it) -> one failed line, audio_s measured", async () => {
    const out = await runOneStep(job({ failures: 3 }), "runner-1");
    expect(out.outcome).toBe("failures_exceeded");
    expect(ledger()).toEqual([expect.objectContaining({ job_id: "job_s1", status: "failed", audio_s: 600, request_id: "sj_9", task: "transcribe" })]);
    expect(lab.has("lanes/sarvam-scribe-mcp.json")).toBe(true);
  });

  it("the throw that exhausts MAX_FAILURES -> one failed line; a throw that does not exhaust it -> none", async () => {
    gwStatus.mockImplementation(() => { throw new Error("boom"); });
    const err = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const out = await runOneStep(job({ failures: 2 }), "runner-1");
    expect(out.outcome).toBe("failed");
    expect(ledger()).toEqual([expect.objectContaining({ job_id: "job_s1", status: "failed", audio_s: 600 })]);
    lab.clear();
    storeFns.recordFailure.mockImplementation(async () => ({ failures: 1, status: "running" }));
    await runOneStep(job({ failures: 0 }), "runner-1");
    expect(ledger()).toEqual([]);
    err.mockRestore();
  });

  it("a job the runner ends is written ONCE even if the hook fires twice, and not at all when the kind already wrote its line", async () => {
    await H.sarvamJobEnded(job() as never, "failed");
    await H.sarvamJobEnded(job() as never, "failed");
    expect(ledger()).toHaveLength(1);
    lab.clear();
    expect(await L.appendLedger({ ...H.endedLine(job() as never, "failed", "2026-10-08T06:30:00.000Z"), status: "ok" })).toBe(true);
    await H.sarvamJobEnded(job() as never, "cancelled"); // finished ok before the cancel arrived: no second line
    expect(ledger()).toEqual([expect.objectContaining({ status: "ok" })]);
  });

  it("cancel through scribe_job_cancel / scribe_jobs -> one cancelled line; other kinds write nothing", async () => {
    storeFns.cancelJob.mockImplementation(async () => ({ ...(job() as object), status: "cancelled" }));
    expect(await call("scribe_job_cancel", { job_id: "job_s1" })).toMatchObject({ ok: true, status: "cancelled" });
    expect(ledger()).toEqual([expect.objectContaining({ job_id: "job_s1", status: "cancelled", audio_s: 600 })]);
    lab.clear();
    storeFns.cancelJob.mockImplementation(async () => ({ ...(job({ id: "job_o", kind: "transcribe_range" }) as object), status: "cancelled" }));
    expect(await call("scribe_job_cancel", { job_id: "job_o" })).toMatchObject({ ok: true });
    expect(ledger()).toEqual([]);
    // a cancel that finds nothing to cancel writes nothing
    storeFns.cancelJob.mockImplementation(async () => null);
    jobsById.set("job_s2", { status: "done" });
    await call("scribe_job_cancel", { job_id: "job_s2" });
    expect(ledger()).toEqual([]);
  });

  it("D4: the lab store failing makes neither the cancel nor the runner fail", async () => {
    L.setLabStoreForTests({ get: async () => { throw new Error("down"); }, put: async () => { throw new Error("down"); }, list: async () => { throw new Error("down"); } });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    storeFns.cancelJob.mockImplementation(async () => ({ ...(job() as object), status: "cancelled" }));
    expect(await call("scribe_job_cancel", { job_id: "job_s1" })).toMatchObject({ ok: true });
    expect((await runOneStep(job({ failures: 3 }), "r")).outcome).toBe("failures_exceeded");
    warn.mockRestore();
  });
});

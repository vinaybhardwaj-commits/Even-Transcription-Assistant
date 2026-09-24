/**
 * Slice C1b — the room window walks ONE path, whatever engine runs it.
 *
 * These drive the real step machine against a fake database and fake tunnels, so what is asserted
 * is what the code DOES: which rows land, how many router jobs are created, and where a step stops.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const DB = vi.hoisted(() => ({
  runs: [] as Array<{ id: string; window: string; engine: string; text?: string; metrics: Record<string, unknown> }>,
  windowState: "closed",
  deletes: 0,
  routing: "route",
  log: [] as string[],
}));
// `lastOpts` / `opts` capture what the job passed DOWN — the per-job choices (translate, switch override)
// are only real if they reach the router submit and the cue writer, so the tests below read these.
const ROUTER = vi.hoisted(() => ({ submits: 0, states: [] as Array<Record<string, unknown>>, lastUrl: "", lastOpts: undefined as unknown }));
// `silent` makes Whisper report an empty transcript — the quiet-room case the segment step records as a silent window.
const WHISPER = vi.hoisted(() => ({ calls: 0, silent: false }));
const CUES = vi.hoisted(() => ({ written: 0, opts: [] as unknown[] }));

vi.mock("@/lib/db", () => ({
  sql: async (strings: TemplateStringsArray, ...v: unknown[]) => {
    const q = strings.join("?").replace(/\s+/g, " ");
    DB.log.push(q.slice(0, 60));
    if (q.includes("FROM bench_window w JOIN bench_session"))
      return [{ id: "bw_1", session_id: "sess_1", room_day_id: "rd_1", start_ms: 0, end_ms: 900_000,
                source_mic: "primary", clip_r2_key: null, grid_aligned: true, state: DB.windowState, room_id: "room_1" }];
    if (q.includes("FROM bench_chunk"))
      return [{ idx: 0, source: "primary", r2_key: "chunks/a.webm", content_type: "audio/webm",
                started_at: new Date(0).toISOString(), ended_at: new Date(900_000).toISOString(), upload_state: "uploaded" }];
    if (q.includes("UPDATE bench_window SET state = 'transcribing'")) { DB.windowState = "transcribing"; return [{ id: "bw_1" }]; }
    if (q.includes("UPDATE bench_window SET state = 'transcribed'")) { DB.windowState = "transcribed"; return []; }
    // E18 — a silent window settles in its OWN state; the harness records which one the drain actually wrote.
    if (q.includes("UPDATE bench_window SET state = 'silent'")) { DB.windowState = "silent"; return []; }
    if (q.includes("FROM stt_routing")) return [{ engine_id: DB.routing }];
    if (q.includes("FROM stt_engine")) return [{ enabled: true }];
    // E31 A7 — the delete and the insert are now ONE statement, so this fake database must record BOTH from
    // it. Returning on the first match would count the delete and lose the run, which is not what the database
    // does: either both land or neither does.
    if (q.includes("DELETE FROM transcription_run")) DB.deletes += 1;
    if (q.includes("INSERT INTO transcription_run")) {
      // Keep every bound value so a test can read the row's metrics_json without counting
      // parameter positions, which differ between the routed insert and the shadow insert.
      const metricsRaw = v.find((x) => typeof x === "string" && /[{]/.test(x) && /audio_seconds|language_timeline/.test(x));
      // E31 A7 — the routed insert is now preceded by its DELETE inside one statement, and that delete binds
      // the window id FIRST. The positional reads below start after it; the shadow insert has no delete and
      // starts at 0. Read by offset rather than renumbering every index by hand.
      const off = q.includes("DELETE FROM transcription_run") ? 1 : 0;
      DB.runs.push({ id: String(v[off]), window: String(v[off + 1]), engine: String(v[off + 2]),
                     text: v.find((x, i) => i > off + 3 && typeof x === "string" && / /.test(x) && !/[{]/.test(x)) as string | undefined,
                     metrics: metricsRaw ? JSON.parse(String(metricsRaw)) as Record<string, unknown> : {} });
      return [];
    }
    if (q.includes("DELETE FROM transcription_run")) return [];
    if (q.includes("UPDATE stt_subject_job")) return [{ attempts: 1 }];
    return [];
  },
}));
vi.mock("@/lib/r2", () => ({
  getObjectBytes: async () => new Uint8Array([1, 2, 3, 4]),
  signGetUrl: async (o: { key: string }) => (ROUTER.lastUrl = `https://r2.example/${o.key}`),
}));
vi.mock("@/lib/whisper", () => ({
  transcribeWithWhisper: async () => {
    WHISPER.calls += 1;
    if (WHISPER.silent) return { ok: false, error: "empty_transcript", latency_ms: 10, attempts: 1 };
    return { ok: true, transcript: "whisper words", language: "kn", latency_ms: 120, attempts: 1,
             // The REAL WhisperSegment shape: seconds, not milliseconds. One segment inside the
    // 120 s shadow bound and one outside it, so the bounding is observable.
             segments: [{ start_s: 0, end_s: 10, text: "inside the sample" }, { start_s: 300, end_s: 310, text: "outside the sample" }],
             engineVersion: "large-v3-turbo" };
  },
}));
vi.mock("@/lib/bench-join", async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  joinServiceConfigured: () => true,
  callJoinService: async () => ({ ok: true, key: "clips/joined.webm" }),
}));
vi.mock("@/lib/room-switches", () => ({ isTranscriptEnabled: async () => true }));
vi.mock("@/lib/mcp/tools/bench", () => ({
  buildTurns: () => ({ turns: [{ t: 1 }] }),
  buildWindowCue: () => ({}),
  // `complete` is the field cueWriteFailed actually reads — `written` is non-zero even when
  // every turn was rolled back, which is the trap the real helper documents.
  writeWindowCues: async (...a: unknown[]) => { CUES.written += 1; CUES.opts.push(a[7]); return { written: 2, deleted: 0, failed: 0, complete: true, window_recorded: true }; },
}));
vi.mock("@/lib/stt/eta-router", () => ({
  ROUTER_JOB_ON: () => true,
  submitRouteJob: async (_url: string, opts?: unknown) => { ROUTER.submits += 1; ROUTER.lastOpts = opts; return { ok: true, job_id: `rj_${ROUTER.submits}` }; },
  pollRouteJob: async () => ROUTER.states.shift() ?? { ok: true, state: "running" },
  routeTranscribe: async () => ({ ok: true }),
}));

const ACTOR = { actor: "admin_1", via: "admin_route" as const };
const ARGS = { window_id: "bw_1", origin: "https://x.test", ...ACTOR };

/** Drive the machine exactly as the runner does: one step per claim, progress carried on the row. */
async function drive(maxSteps = 20, args: Record<string, unknown> = ARGS) {
  const { roomWindowKind } = await import("@/lib/jobs/kinds/room-window");
  let step = roomWindowKind.first;
  let progress: Record<string, unknown> = {};
  const visited: string[] = [];
  for (let i = 0; i < maxSteps; i += 1) {
    visited.push(step);
    const out = await roomWindowKind.run({ job: {} as never, step, args, progress, runner: "r1" });
    if (out.kind === "done") return { visited, result: (out as { result: Record<string, unknown> }).result, progress };
    if (out.kind === "fail") return { visited, error: (out as { error: string }).error, progress };
    progress = (out as { progress: Record<string, unknown> }).progress;
    step = (out as { step: string }).step;
  }
  throw new Error(`did not settle: ${visited.join(" -> ")}`);
}

beforeEach(() => {
  DB.runs = []; DB.deletes = 0; DB.windowState = "closed"; DB.routing = "route"; DB.log = [];
  ROUTER.submits = 0; ROUTER.states = []; ROUTER.lastOpts = undefined; WHISPER.calls = 0; WHISPER.silent = false; CUES.written = 0; CUES.opts = [];
  vi.useRealTimers();
});

describe("C1b — a 900 s window completes end-to-end on the job path", () => {
  it("engine=route: prepare, segment, engine, poll, finish — and a run lands with engine 'route'", async () => {
    ROUTER.states = [{ ok: true, state: "done", transcript_native: "router words", dominant_language: "kn",
                       language_timeline: [{ start_s: 0, end_s: 900, lang: "kn", engine: "indicconformer", chars: 12 }], sec: 700 }];
    const r = await drive();
    expect(r.error, "the whole path must complete").toBeUndefined();
    expect(r.visited).toEqual(["prepare", "segment", "engine", "poll", "finish"]);
    expect(ROUTER.submits, "exactly one router job for one window").toBe(1);
    const routed = DB.runs.filter((x) => x.engine === "route");
    expect(routed, "one routed run").toHaveLength(1);
    expect(r.result!.run_id).toBe(routed[0]!.id);
    expect(DB.windowState, "the window is transcribed only at the END of the job").toBe("transcribed");
  });

  it("engine=whisper walks the SAME steps and never polls — one path, not two", async () => {
    DB.routing = "whisper";
    const r = await drive();
    expect(r.error).toBeUndefined();
    expect(r.visited, "no poll step: a synchronous adapter answers inside `engine`").toEqual(["prepare", "segment", "engine", "finish"]);
    expect(ROUTER.submits, "a synchronous engine starts no router job").toBe(0);
    expect(DB.runs.some((x) => x.engine === "whisper")).toBe(true);
    expect(DB.windowState).toBe("transcribed");
  });

  it("no window produces two runs for the same (window, engine)", async () => {
    ROUTER.states = [{ ok: true, state: "done", transcript_native: "w", language_timeline: [], sec: 1 }];
    await drive();
    const pairs = DB.runs.map((x) => `${x.window}|${x.engine}`);
    expect(new Set(pairs).size, `duplicate (window, engine): ${pairs.join(", ")}`).toBe(pairs.length);
  });
});

describe("C1b — idempotency is ours, because the router has none", () => {
  it("a crash after submit, replayed, POLLS the existing job and submits exactly once", async () => {
    const { roomWindowKind } = await import("@/lib/jobs/kinds/room-window");
    // Walk to the end of `engine`, which submits and persists the router job id.
    let progress: Record<string, unknown> = {};
    let step = roomWindowKind.first;
    for (const _ of ["prepare", "segment", "engine"]) {
      const out = await roomWindowKind.run({ job: {} as never, step, args: ARGS, progress, runner: "r1" });
      progress = (out as { progress: Record<string, unknown> }).progress;
      step = (out as { step: string }).step;
    }
    expect(ROUTER.submits).toBe(1);
    const jobId = progress.router_job_id;
    expect(jobId, "the id must be on the row before anything else can fail").toBe("rj_1");

    // THE CRASH: the runner died before the poll. The row is re-claimed and the ENGINE step is
    // replayed from the top, which is the worst case — a replay of the step that submits.
    const replay = await roomWindowKind.run({ job: {} as never, step: "engine", args: ARGS, progress, runner: "r2" });
    const replayProgress = (replay as { progress: Record<string, unknown> }).progress;
    expect(ROUTER.submits, "a retry must NEVER create a second router job").toBe(1);
    expect(replayProgress.router_job_id, "it carries the same id forward").toBe(jobId);

    // And it still finishes, against the job it already owned.
    ROUTER.states = [{ ok: true, state: "done", transcript_native: "w", language_timeline: [], sec: 1 }];
    const polled = await roomWindowKind.run({ job: {} as never, step: "poll", args: ARGS, progress: replayProgress, runner: "r2" });
    expect((polled as { step: string }).step).toBe("finish");
    expect(ROUTER.submits).toBe(1);
    expect(DB.runs.filter((x) => x.engine === "route"), "and still exactly one run").toHaveLength(1);
  });

  it("ten replays of the engine step still make exactly one router job", async () => {
    const { roomWindowKind } = await import("@/lib/jobs/kinds/room-window");
    let progress: Record<string, unknown> = {};
    let step = roomWindowKind.first;
    for (const _ of ["prepare", "segment", "engine"]) {
      const out = await roomWindowKind.run({ job: {} as never, step, args: ARGS, progress, runner: "r1" });
      progress = (out as { progress: Record<string, unknown> }).progress;
      step = (out as { step: string }).step;
    }
    for (let i = 0; i < 10; i += 1) {
      const out = await roomWindowKind.run({ job: {} as never, step: "engine", args: ARGS, progress, runner: `r${i}` });
      progress = (out as { progress: Record<string, unknown> }).progress;
    }
    expect(ROUTER.submits).toBe(1);
  });
});

describe("C1b — the 300 s ceiling is unreachable by any path", () => {
  it("a still-running router job hands the row BACK to the queue inside the step budget", async () => {
    const { roomWindowKind, ROOM_POLL_BUDGET_MS } = await import("@/lib/jobs/kinds/room-window");
    const { MAX_STEP_MS, LEASE_MS } = await import("@/lib/jobs/types");
    expect(ROOM_POLL_BUDGET_MS, "one claim's polling must fit inside a step").toBeLessThan(MAX_STEP_MS);
    expect(MAX_STEP_MS, "and a step inside its lease").toBeLessThan(LEASE_MS);

    vi.useFakeTimers();
    ROUTER.states = Array.from({ length: 500 }, () => ({ ok: true, state: "running" }));
    const p = roomWindowKind.run({ job: {} as never, step: "poll", args: ARGS,
      progress: { router_job_id: "rj_1", clip_r2_key: "clips/joined.webm", engine_id: "route", engine_key: "route" }, runner: "r1" });
    await vi.advanceTimersByTimeAsync(ROOM_POLL_BUDGET_MS + 10_000);
    const out = await p;
    vi.useRealTimers();
    expect(out.kind).toBe("next");
    expect((out as { step: string }).step, "it comes back to poll, it does not block").toBe("poll");
    expect((out as { progress: Record<string, unknown> }).progress.router_job_id).toBe("rj_1");
  });

  it("the drain itself now only claims and enqueues — no engine call, no whisper", async () => {
    const submits: Array<Record<string, unknown>> = [];
    vi.doMock("@/lib/jobs/submit", () => ({
      submitJob: async (i: Record<string, unknown>) => { submits.push(i); return { id: "job_1" }; },
    }));
    vi.resetModules();
    const { drainRoomWindow } = await import("@/lib/stt/room-drain");
    const out = await drainRoomWindow("bw_1", "https://x.test", ACTOR);
    expect(out.step, "the drain's success is `enqueued`, not `ok`").toBe("enqueued");
    expect(out.job_id).toBe("job_1");
    expect(submits, "exactly one job").toHaveLength(1);
    expect(submits[0]!.kind).toBe("room_window");
    expect(WHISPER.calls, "the drain must not transcribe anything itself").toBe(0);
    expect(DB.runs, "and must write no run").toHaveLength(0);
    vi.doUnmock("@/lib/jobs/submit");
    vi.resetModules();
  });
});


describe("C1b fix-up 1 — the control run is a BOUNDED SAMPLE, and says so", () => {
  it("covers only the first SHADOW_WINDOW_MS, and is marked so nobody compares it like for like", async () => {
    const { SHADOW_WINDOW_MS } = await import("@/lib/stt/room-drain");
    // Force the sample: rate 1 shadows every window.
    vi.stubEnv("ETA_ROOM_SHADOW_SAMPLE", "1");
    ROUTER.states = [{ ok: true, state: "done", transcript_native: "router words", language_timeline: [], sec: 5 }];
    await drive();
    const shadow = DB.runs.find((r) => r.engine === "whisper");
    expect(shadow, "a control run must exist at rate 1").toBeTruthy();

    expect(SHADOW_WINDOW_MS).toBe(120_000);
    // THE MARKING. Three independent keys, because one a reader must notice is one they will miss.
    expect(shadow!.metrics.shadow_bounded).toBe(true);
    expect(shadow!.metrics.covers_full_window).toBe(false);
    expect(shadow!.metrics.shadow_window_ms).toBe(SHADOW_WINDOW_MS);

    // The yield tripwire divides by audio_seconds, so it must be the SAMPLE's duration (120 s),
    // never the window's (900 s) — otherwise the control looks 7.5x less productive than it is.
    expect(shadow!.metrics.audio_seconds).toBe(120);
    expect(shadow!.metrics.full_window_audio_seconds).toBe(900);

    // And the text is actually truncated: the segment at 300 s is outside the bound.
    expect(shadow!.metrics.segment_count, "only the segment inside 120 s").toBe(1);
    expect(shadow!.metrics.full_window_segment_count).toBe(2);
    expect(shadow!.text).toContain("inside the sample");
    expect(shadow!.text, "a segment past the bound must not be in the control").not.toContain("outside the sample");
    vi.unstubAllEnvs();
  });

  it("the ROUTED run is unbounded — only the control is a sample", async () => {
    vi.stubEnv("ETA_ROOM_SHADOW_SAMPLE", "1");
    ROUTER.states = [{ ok: true, state: "done", transcript_native: "router words", language_timeline: [], sec: 5 }];
    await drive();
    const routed = DB.runs.find((r) => r.engine === "route")!;
    expect(routed.metrics.shadow_bounded).toBeUndefined();
    expect(routed.metrics.audio_seconds, "the routed run covers the whole window").toBe(900);
    vi.unstubAllEnvs();
  });
});

describe("C1b fix-up 2 — routing is resolved ONCE per job", () => {
  it("one stt_routing read across the whole job, and the engine step uses what was persisted", async () => {
    ROUTER.states = [{ ok: true, state: "done", transcript_native: "w", language_timeline: [], sec: 1 }];
    const r = await drive();
    const reads = DB.log.filter((q) => q.includes("FROM stt_routing")).length;
    expect(reads, "a second resolution could disagree with the one the shadow was labelled from").toBe(1);
    expect(r.progress.engine_id, "persisted on the row").toBe("route");
    expect(DB.runs.find((x) => x.engine === "route"), "and the run was written by it").toBeTruthy();
  });

  it("if the persisted engine is missing the step refuses — it does not silently re-resolve", async () => {
    const { roomWindowEngine } = await import("@/lib/stt/room-drain");
    const out = await roomWindowEngine("bw_1", ACTOR, { clip_r2_key: "clips/joined.webm", decided_language: "kn" });
    expect(out.ok).toBe(false);
    expect(out.step).toBe("no_engine");
  });
});

// ---------------------------------------------------------------------------
// V's ruling, 19 Sep 2026 — cues_refused this morning (evenscribe.app failed, the cron origin
// retry succeeded) recorded only the phase, and the reason was unrecoverable from the row.
// `failFromPhase` is pure — no DB, no fetch — so its composition is pinned directly here.
// ---------------------------------------------------------------------------
describe("failFromPhase — the phase stays where it was, the detail joins it", () => {
  it("records the phase AND the detail when the phase carries one", async () => {
    const { failFromPhase } = await import("@/lib/jobs/kinds/room-window");
    const out = failFromPhase({
      window_id: "bw_1", ok: false, step: "cues_refused",
      detail: "brain_permission_denied: 403 @ https://evenscribe.app",
    } as never);
    expect(out).toEqual({
      kind: "fail",
      error: "room_window_failed: cues_refused: brain_permission_denied: 403 @ https://evenscribe.app",
    });
  });

  it("an old row shape with a phase but no detail still reads correctly", async () => {
    const { failFromPhase } = await import("@/lib/jobs/kinds/room-window");
    const out = failFromPhase({ window_id: "bw_1", ok: false, step: "no_room_day" } as never);
    expect(out).toEqual({ kind: "fail", error: "room_window_failed: no_room_day" });
  });

  it("errorCodeOf still finds the published code first, whichever phase or detail follows it", async () => {
    const { failFromPhase } = await import("@/lib/jobs/kinds/room-window");
    const { errorCodeOf } = await import("@/lib/jobs/errors");
    const withDetail = failFromPhase({ window_id: "bw_1", ok: false, step: "cues_refused", detail: "x: y: z" } as never) as { kind: "fail"; error: string };
    const withoutDetail = failFromPhase({ window_id: "bw_1", ok: false, step: "no_room_day" } as never) as { kind: "fail"; error: string };
    expect(errorCodeOf(withDetail.error)).toBe("room_window_failed");
    expect(errorCodeOf(withoutDetail.error)).toBe("room_window_failed");
  });
});

// ---------------------------------------------------------------------------
// Overnight translate (V, 21 Sep 2026) — two PER-JOB choices, both default false.
//   translate        must reach the router submit (it used to be the literal `false`)
//   switch_override  must reach the cue writer (it is what lets a Transcript-off room's turns land)
// A choice that is parsed but never passed down is worth nothing, so these read what the calls received.
// ---------------------------------------------------------------------------
describe("overnight-translate — the per-job choices reach the calls that use them", () => {
  const routed = () => {
    ROUTER.states = [{ ok: true, state: "done", transcript_native: "w", transcript_english: "w", language_timeline: [], sec: 1 }];
  };
  const submitted = () => ROUTER.lastOpts as { translate?: boolean };

  it("a job that asks for neither behaves exactly as before: translate false and no override", async () => {
    routed();
    const r = await drive();
    expect(r.error).toBeUndefined();
    expect(submitted().translate, "the router is asked NOT to translate").toBe(false);
    expect(CUES.opts.length, "at least one cue write happened").toBeGreaterThan(0);
    for (const o of CUES.opts) expect(o).toEqual({ switchOverride: false });
  });

  it("translate:true is what the router submit receives — and does not touch the cue override", async () => {
    routed();
    const r = await drive(20, { ...ARGS, translate: true });
    expect(r.error).toBeUndefined();
    expect(submitted().translate).toBe(true);
    for (const o of CUES.opts) expect(o).toEqual({ switchOverride: false });
  });

  it("switch_override:true reaches EVERY cue write of the job — and does not turn translation on", async () => {
    routed();
    const r = await drive(20, { ...ARGS, switch_override: true });
    expect(r.error).toBeUndefined();
    expect(CUES.opts.length).toBeGreaterThan(0);
    for (const o of CUES.opts) expect(o).toEqual({ switchOverride: true });
    expect(submitted().translate, "the two choices are independent").toBe(false);
  });

  it("both at once: each goes where it belongs", async () => {
    routed();
    const r = await drive(20, { ...ARGS, translate: true, switch_override: true });
    expect(r.error).toBeUndefined();
    expect(submitted().translate).toBe(true);
    for (const o of CUES.opts) expect(o).toEqual({ switchOverride: true });
  });

  it("the SILENT-window path forwards the override too — it is the OTHER cue write in the segment step", async () => {
    WHISPER.silent = true;
    const r = await drive(20, { ...ARGS, switch_override: true });
    expect(r.error).toBeUndefined();
    expect(r.result).toMatchObject({ silent_window: true });
    expect(ROUTER.submits, "a silent window never reaches the routed engine, so translate has nothing to do").toBe(0);
    expect(CUES.opts.length).toBeGreaterThan(0);
    for (const o of CUES.opts) expect(o).toEqual({ switchOverride: true });
  });

  it("and without the override the silent path writes with it OFF", async () => {
    WHISPER.silent = true;
    const r = await drive();
    expect(r.error).toBeUndefined();
    for (const o of CUES.opts) expect(o).toEqual({ switchOverride: false });
  });

  it("anything but the boolean true in the persisted args is NOT a yes (the step re-reads them, so a bad row cannot widen)", async () => {
    routed();
    const r = await drive(20, { ...ARGS, translate: "true", switch_override: 1 });
    expect(r.error).toBeUndefined();
    expect(submitted().translate).toBe(false);
    for (const o of CUES.opts) expect(o).toEqual({ switchOverride: false });
  });
});

describe("room_window parseArgs — the two choices are strict booleans, stored only when true", () => {
  const base = { window_id: "bw_1", origin: "https://x.test", actor: "overnight-translate", via: "mcp" };

  it("no choices: the args are exactly what they always were — same keys, same row, same dedupe", async () => {
    const { roomWindowKind } = await import("@/lib/jobs/kinds/room-window");
    expect(roomWindowKind.parseArgs(base)).toEqual(base);
  });

  it("true is stored; false is not stored at all", async () => {
    const { roomWindowKind } = await import("@/lib/jobs/kinds/room-window");
    expect(roomWindowKind.parseArgs({ ...base, translate: true })).toEqual({ ...base, translate: true });
    expect(roomWindowKind.parseArgs({ ...base, switch_override: true })).toEqual({ ...base, switch_override: true });
    expect(roomWindowKind.parseArgs({ ...base, translate: true, switch_override: true })).toEqual({ ...base, translate: true, switch_override: true });
    expect(roomWindowKind.parseArgs({ ...base, translate: false, switch_override: false })).toEqual(base);
  });

  it("a string, a number or null is REFUSED at submit — 'false' must never be read as yes", async () => {
    const { roomWindowKind } = await import("@/lib/jobs/kinds/room-window");
    const { JobArgsError } = await import("@/lib/jobs/types");
    for (const key of ["translate", "switch_override"]) {
      for (const bad of ["true", "false", "", 1, 0, null, {}, []]) {
        let thrown: unknown;
        try { roomWindowKind.parseArgs({ ...base, [key]: bad }); } catch (e) { thrown = e; }
        expect(thrown, `${key}=${JSON.stringify(bad)} must be refused`).toBeInstanceOf(JobArgsError);
        expect(String((thrown as Error).message)).toContain(key);
      }
    }
  });
});

// ---------------------------------------------------------------------------
// A job that asked for English must not be answered with a silent no. `translate` is honoured on the
// ASYNC router path; a synchronous engine has no such switch. Reviewer finding A: without this guard the job
// would run, be paid for, finish `done` with transcript_english NULL, and be picked again every night.
// ---------------------------------------------------------------------------
describe("overnight-translate — translate on a SYNCHRONOUS engine fails by name, before any spend", () => {
  it("routed to a synchronous engine, translate:true FAILS with a closed detail and writes no run", async () => {
    DB.routing = "whisper";
    const r = await drive(20, { ...ARGS, translate: true });
    expect(r.error).toBe("room_window_failed: engine_failed: translate_unsupported_by_engine");
    expect(DB.windowState, "the window is NOT marked transcribed").not.toBe("transcribed");
    expect(DB.runs.filter((x) => x.engine === "whisper"), "the engine step wrote no run").toHaveLength(0);
    expect(ROUTER.submits).toBe(0);
  });

  it("the same window WITHOUT translate still completes on that engine — nothing else changed", async () => {
    DB.routing = "whisper";
    const r = await drive();
    expect(r.error).toBeUndefined();
    expect(DB.runs.some((x) => x.engine === "whisper")).toBe(true);
    expect(DB.windowState).toBe("transcribed");
  });

  it("routed to the async router, translate:true is accepted and reaches the router (no regression)", async () => {
    DB.routing = "route";
    ROUTER.states = [{ ok: true, state: "done", transcript_native: "w", transcript_english: "w", language_timeline: [], sec: 1 }];
    const r = await drive(20, { ...ARGS, translate: true });
    expect(r.error).toBeUndefined();
    expect((ROUTER.lastOpts as { translate?: boolean }).translate).toBe(true);
  });
});

describe("Drain throughput fix (23 Sep) — join_already_running is a wait, not a failure", () => {
  // A dedicated, stateful callJoinService mock per test, applied with vi.doMock + vi.resetModules
  // so it does not leak into the shared "callJoinService always ok" mock every other test in this
  // file relies on.
  const mockJoin = (impl: () => Promise<{ ok: boolean; error?: string; key?: string }>) =>
    vi.doMock("@/lib/bench-join", async (orig) => ({
      ...(await orig<Record<string, unknown>>()),
      joinServiceConfigured: () => true,
      callJoinService: impl,
    }));

  afterEach(() => {
    vi.useRealTimers();
    vi.doUnmock("@/lib/bench-join");
    vi.resetModules();
  });

  it("CLASSIFICATION — busy twice then ok: prepare advances to segment, not a failure", async () => {
    // The mock is stateful across EVERY callJoinService call the step makes, including the
    // language-probe join that runs right after the main clip join succeeds (C3) — so `calls`
    // legitimately exceeds `busyCalls` by one once the main join stops being busy. Assert on
    // `busyCalls`, which is what this test is actually about.
    let calls = 0;
    let busyCalls = 0;
    mockJoin(async () => {
      calls += 1;
      if (calls <= 2) { busyCalls += 1; return { ok: false, error: "join_already_running" }; }
      return { ok: true, key: "clips/joined.webm" };
    });
    vi.resetModules();
    const { roomWindowKind } = await import("@/lib/jobs/kinds/room-window");

    vi.useFakeTimers();
    const p = roomWindowKind.run({ job: {} as never, step: "prepare", args: ARGS, progress: {}, runner: "r1" });
    await vi.advanceTimersByTimeAsync(150_000);
    const out = await p;
    vi.useRealTimers();

    expect(busyCalls, "two busy answers before it stopped being busy").toBe(2);
    expect(calls, "at least the two busy answers plus the ok that unblocked it").toBeGreaterThanOrEqual(3);
    expect(out.kind, "a busy-then-ok join must ADVANCE the job, never fail it").toBe("next");
    expect((out as { step: string }).step).toBe("segment");
    expect(
      DB.log.some((q) => q.includes("UPDATE stt_subject_job")),
      "a busy retry must not touch the per-window failure accounting (no cooldown row either — that keys off THIS write)",
    ).toBe(false);
  });

  it("CLASSIFICATION — the job runs end to end to done after two busy answers (attempts recorded on the finished result)", async () => {
    // See the busyCalls/calls note in the previous test — the language probe's own join call
    // also goes through this mock once the main join stops being busy.
    let calls = 0;
    let busyCalls = 0;
    mockJoin(async () => {
      calls += 1;
      if (calls <= 2) { busyCalls += 1; return { ok: false, error: "join_already_running" }; }
      return { ok: true, key: "clips/joined.webm" };
    });
    vi.resetModules();
    const { roomWindowKind } = await import("@/lib/jobs/kinds/room-window");
    ROUTER.states = [{ ok: true, state: "done", transcript_native: "router words", dominant_language: "kn",
                       language_timeline: [{ start_s: 0, end_s: 900, lang: "kn", engine: "indicconformer", chars: 12 }], sec: 700 }];

    let step = roomWindowKind.first;
    let progress: Record<string, unknown> = {};
    const visited: string[] = [];
    vi.useFakeTimers();
    let out: Awaited<ReturnType<typeof roomWindowKind.run>> | null = null;
    for (let i = 0; i < 10; i += 1) {
      visited.push(step);
      const p = roomWindowKind.run({ job: {} as never, step, args: ARGS, progress, runner: "r1" });
      await vi.advanceTimersByTimeAsync(150_000);
      out = await p;
      if (out.kind === "done") break;
      if (out.kind === "fail") break;
      progress = (out as { progress: Record<string, unknown> }).progress;
      step = (out as { step: string }).step;
    }
    vi.useRealTimers();

    expect(out?.kind, `visited: ${visited.join(" -> ")}`).toBe("done");
    expect(visited).toEqual(["prepare", "segment", "engine", "poll", "finish"]);
    expect(busyCalls, "two busy answers then one ok unblocked the whole run").toBe(2);
    expect(
      DB.log.some((q) => q.includes("UPDATE stt_subject_job")),
      "the whole run reached done without ever recording a per-window failure",
    ).toBe(false);
  });

  // MUTATION CONTROL — every OTHER join error, named explicitly, is unretried and fails the job
  // exactly as before this change. One test per error string, not a single generic one, because a
  // generic "join_unreachable" case does not by itself prove the classification is an EXACT string
  // match rather than a looser test (e.g. a mutant that folds join_timeout into the busy set, or one
  // that matches on a substring) — see the two dedicated kill tests below this block for those.
  for (const errorCode of ["join_timeout", "join_unreachable", "join_http_502"]) {
    it(`MUTATION CONTROL — ${errorCode} is unretried and fails the job exactly as before`, async () => {
      mockJoin(async () => ({ ok: false, error: errorCode }));
      vi.resetModules();
      const { roomWindowKind } = await import("@/lib/jobs/kinds/room-window");
      const { errorCodeOf } = await import("@/lib/jobs/errors");

      const out = await roomWindowKind.run({ job: {} as never, step: "prepare", args: ARGS, progress: {}, runner: "r1" });

      expect(out.kind, `${errorCode} must fail the job, unretried`).toBe("fail");
      expect(errorCodeOf((out as { error: string }).error)).toBe("room_window_failed");
      expect(
        DB.log.some((q) => q.includes("UPDATE stt_subject_job")),
        "an ordinary failure DOES record, same as before this change",
      ).toBe(true);
    });
  }

  it("MUTATION CONTROL — join_timeout is not folded into the busy set even after two real busy answers", async () => {
    // Kills a mutant that widens the retry condition to `error === "join_already_running" ||
    // error === "join_timeout"` (or any variant that treats timeout as busy): two genuine busy
    // answers retry as designed, but the THIRD answer is a real timeout and must fail the job,
    // not retry a third time.
    let calls = 0;
    mockJoin(async () => {
      calls += 1;
      if (calls <= 2) return { ok: false, error: "join_already_running" };
      return { ok: false, error: "join_timeout" };
    });
    vi.resetModules();
    const { roomWindowKind } = await import("@/lib/jobs/kinds/room-window");
    const { errorCodeOf } = await import("@/lib/jobs/errors");

    vi.useFakeTimers();
    const p = roomWindowKind.run({ job: {} as never, step: "prepare", args: ARGS, progress: {}, runner: "r1" });
    await vi.advanceTimersByTimeAsync(150_000);
    const out = await p;
    vi.useRealTimers();

    expect(calls).toBe(3);
    expect(out.kind, "the timeout on the third call must fail the job, not retry it").toBe("fail");
    expect(errorCodeOf((out as { error: string }).error)).toBe("room_window_failed");
  });

  it("MUTATION CONTROL — a string that merely CONTAINS 'already_running' is not retried (exact match, not substring)", async () => {
    // Kills a mutant that loosens `error === "join_already_running"` to
    // `error.includes("already_running")`. This string is not one the real join service emits
    // (it always emits exactly "join_already_running") — it exists purely to pin that the
    // classification is an exact-equality check, not a looser one.
    //
    // MUST resolve WITHOUT any timer advancement. A plain `out.kind === "fail"` assertion alone
    // is too weak here: under the includes() mutant this error retries in a genuine sleep loop,
    // and if given enough advanced fake time it too would eventually exceed the busy cap and
    // settle to "fail" — the SAME final verdict, just late, which would make the assertion pass
    // for the wrong reason and let the mutant survive. Racing the run() promise against a
    // zero-advance of the fake clock instead proves the real code path never enters the retry
    // loop at all for this string, deterministically and fast.
    mockJoin(async () => ({ ok: false, error: "stale_join_already_running_result" }));
    vi.resetModules();
    const { roomWindowKind } = await import("@/lib/jobs/kinds/room-window");
    const { errorCodeOf } = await import("@/lib/jobs/errors");

    vi.useFakeTimers();
    const PENDING = Symbol("pending");
    const p = roomWindowKind.run({ job: {} as never, step: "prepare", args: ARGS, progress: {}, runner: "r1" });
    await vi.advanceTimersByTimeAsync(0);
    const out = await Promise.race([p, Promise.resolve(PENDING)]);
    vi.useRealTimers();

    expect(out, "must settle instantly — any retry sleep means it is still pending here").not.toBe(PENDING);
    expect((out as { kind: string }).kind, "a substring match on 'already_running' must NOT be treated as busy").toBe("fail");
    expect(errorCodeOf((out as { error: string }).error)).toBe("room_window_failed");
  });

  it("BOUND — still busy past the per-claim budget hands the row back to prepare, not a failure", async () => {
    mockJoin(async () => ({ ok: false, error: "join_already_running" }));
    vi.resetModules();
    const { roomWindowKind } = await import("@/lib/jobs/kinds/room-window");
    const { JOIN_BUSY_STEP_BUDGET_MS } = await import("@/lib/stt/room-drain");
    const { MAX_STEP_MS } = await import("@/lib/jobs/types");
    expect(JOIN_BUSY_STEP_BUDGET_MS, "one claim's busy-retry loop must fit inside a step").toBeLessThan(MAX_STEP_MS);

    vi.useFakeTimers();
    const p = roomWindowKind.run({ job: {} as never, step: "prepare", args: ARGS, progress: {}, runner: "r1" });
    await vi.advanceTimersByTimeAsync(JOIN_BUSY_STEP_BUDGET_MS + 10_000);
    const out = await p;
    vi.useRealTimers();

    expect(out.kind, "still busy past this claim's budget must hand back, not fail").toBe("next");
    expect((out as { step: string }).step).toBe("prepare");
    const progress = (out as { progress: Record<string, unknown> }).progress;
    expect(progress.join_busy_attempts as number).toBeGreaterThan(0);
    expect(DB.log.some((q) => q.includes("UPDATE stt_subject_job")), "still only busy, never a failure").toBe(false);
  });

  it("T2 — a join still busy after FIVE HOURS has burned no attempt: every claim hands back, nothing recorded", async () => {
    // REDUNDANCY-R1 T2: contention is a queue. Under the old 15-minute cap this run failed and recorded
    // within ~6 claims; it must now keep handing the row back with the window's attempts untouched.
    mockJoin(async () => ({ ok: false, error: "join_already_running" }));
    vi.resetModules();
    const { roomWindowKind } = await import("@/lib/jobs/kinds/room-window");

    vi.useFakeTimers();
    let step = "prepare";
    let progress: Record<string, unknown> = {};
    const kinds: string[] = [];
    for (let i = 0; i < 90; i += 1) { // 90 x 200 s = 5 h
      const p = roomWindowKind.run({ job: {} as never, step, args: ARGS, progress, runner: "r1" });
      await vi.advanceTimersByTimeAsync(200_000);
      const out = await p;
      kinds.push(out.kind);
      if (out.kind !== "next") break;
      step = (out as { step: string }).step;
      progress = (out as { progress: Record<string, unknown> }).progress;
    }
    vi.useRealTimers();

    expect(kinds.every((k) => k === "next"), `every claim in 5 h hands back (got ${[...new Set(kinds)].join(",")})`).toBe(true);
    expect(step).toBe("prepare");
    expect(DB.log.some((q) => q.includes("UPDATE stt_subject_job")), "no attempt burned in 5 h of busy").toBe(false);
  });

  it("BOUND — exceeding the cap finally fails the job like an ordinary join failure (never retries forever)", async () => {
    mockJoin(async () => ({ ok: false, error: "join_already_running" }));
    vi.resetModules();
    const { roomWindowKind } = await import("@/lib/jobs/kinds/room-window");

    vi.useFakeTimers();
    let step = "prepare";
    let progress: Record<string, unknown> = {};
    let out: Awaited<ReturnType<typeof roomWindowKind.run>> | null = null;
    // T2: the cap is 6 h, so an unbroken busy run needs ~110 claims of 200 s to reach it.
    for (let i = 0; i < 200; i += 1) {
      const p = roomWindowKind.run({ job: {} as never, step, args: ARGS, progress, runner: "r1" });
      await vi.advanceTimersByTimeAsync(200_000);
      out = await p;
      if (out.kind !== "next") break;
      step = (out as { step: string }).step;
      progress = (out as { progress: Record<string, unknown> }).progress;
    }
    vi.useRealTimers();

    expect(out?.kind, "an unbroken run of busy answers must eventually fail the job, not loop forever").toBe("fail");
    expect(
      DB.log.some((q) => q.includes("UPDATE stt_subject_job")),
      "the terminal failure, once the cap is exceeded, DOES record — exactly like today's unretried failure",
    ).toBe(true);
  });
});

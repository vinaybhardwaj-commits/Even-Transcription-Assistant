/**
 * Slice C1b — the room window walks ONE path, whatever engine runs it.
 *
 * These drive the real step machine against a fake database and fake tunnels, so what is asserted
 * is what the code DOES: which rows land, how many router jobs are created, and where a step stops.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const DB = vi.hoisted(() => ({
  runs: [] as Array<{ id: string; window: string; engine: string; text?: string; metrics: Record<string, unknown> }>,
  windowState: "closed",
  deletes: 0,
  routing: "route",
  log: [] as string[],
}));
const ROUTER = vi.hoisted(() => ({ submits: 0, states: [] as Array<Record<string, unknown>>, lastUrl: "" }));
const WHISPER = vi.hoisted(() => ({ calls: 0 }));
const CUES = vi.hoisted(() => ({ written: 0 }));

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
    if (q.includes("DELETE FROM transcription_run")) { DB.deletes += 1; return []; }
    if (q.includes("INSERT INTO transcription_run")) {
      // Keep every bound value so a test can read the row's metrics_json without counting
      // parameter positions, which differ between the routed insert and the shadow insert.
      const metricsRaw = v.find((x) => typeof x === "string" && /[{]/.test(x) && /audio_seconds|language_timeline/.test(x));
      DB.runs.push({ id: String(v[0]), window: String(v[1]), engine: String(v[2]),
                     text: v.find((x, i) => i > 3 && typeof x === "string" && / /.test(x) && !/[{]/.test(x)) as string | undefined,
                     metrics: metricsRaw ? JSON.parse(String(metricsRaw)) as Record<string, unknown> : {} });
      return [];
    }
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
  writeWindowCues: async () => { CUES.written += 1; return { written: 2, deleted: 0, failed: 0, complete: true, window_recorded: true }; },
}));
vi.mock("@/lib/stt/eta-router", () => ({
  ROUTER_JOB_ON: () => true,
  submitRouteJob: async () => { ROUTER.submits += 1; return { ok: true, job_id: `rj_${ROUTER.submits}` }; },
  pollRouteJob: async () => ROUTER.states.shift() ?? { ok: true, state: "running" },
  routeTranscribe: async () => ({ ok: true }),
}));

const ACTOR = { actor: "admin_1", via: "admin_route" as const };
const ARGS = { window_id: "bw_1", origin: "https://x.test", ...ACTOR };

/** Drive the machine exactly as the runner does: one step per claim, progress carried on the row. */
async function drive(maxSteps = 20) {
  const { roomWindowKind } = await import("@/lib/jobs/kinds/room-window");
  let step = roomWindowKind.first;
  let progress: Record<string, unknown> = {};
  const visited: string[] = [];
  for (let i = 0; i < maxSteps; i += 1) {
    visited.push(step);
    const out = await roomWindowKind.run({ job: {} as never, step, args: ARGS, progress, runner: "r1" });
    if (out.kind === "done") return { visited, result: (out as { result: Record<string, unknown> }).result, progress };
    if (out.kind === "fail") return { visited, error: (out as { error: string }).error, progress };
    progress = (out as { progress: Record<string, unknown> }).progress;
    step = (out as { step: string }).step;
  }
  throw new Error(`did not settle: ${visited.join(" -> ")}`);
}

beforeEach(() => {
  DB.runs = []; DB.deletes = 0; DB.windowState = "closed"; DB.routing = "route"; DB.log = [];
  ROUTER.submits = 0; ROUTER.states = []; WHISPER.calls = 0; CUES.written = 0;
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

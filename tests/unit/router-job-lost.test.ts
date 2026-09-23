/**
 * ROUTER_JOB_LOST — a router job the router forgot must fail the window, not hold it for hours.
 *
 * 23 Sep: the router restarted (~13:17 IST); its job file still said `running` and no thread would ever
 * change it. The room_window poll step re-queued itself every 150 s for 4.5 h and the overnight driver
 * (concurrency 1) stalled behind it. These drive the REAL step machine against a fake database and a fake
 * router — the same harness as c1b-room-window-job.test.ts — so what is asserted is what the code does:
 * the job's error code, how many router jobs were created, and what the window's failure row says.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const DB = vi.hoisted(() => ({
  windowState: "closed",
  failures: [] as string[],
  attempts: 0,
}));
const ROUTER = vi.hoisted(() => ({ submits: 0, polls: 0, states: [] as Array<Record<string, unknown>>,
  impl: null as null | ((jobId: string) => Record<string, unknown>) }));

vi.mock("@/lib/db", () => ({
  sql: async (strings: TemplateStringsArray, ...v: unknown[]) => {
    const q = strings.join("?").replace(/\s+/g, " ");
    if (q.includes("FROM bench_window w JOIN bench_session"))
      return [{ id: "bw_1", session_id: "sess_1", room_day_id: "rd_1", start_ms: 0, end_ms: 900_000,
                source_mic: "primary", clip_r2_key: null, grid_aligned: true, state: DB.windowState, room_id: "room_1" }];
    if (q.includes("FROM bench_chunk"))
      return [{ idx: 0, source: "primary", r2_key: "chunks/a.webm", content_type: "audio/webm",
                started_at: new Date(0).toISOString(), ended_at: new Date(900_000).toISOString(), upload_state: "uploaded" }];
    if (q.includes("UPDATE bench_window SET state = 'transcribing'")) { DB.windowState = "transcribing"; return [{ id: "bw_1" }]; }
    if (q.includes("UPDATE bench_window SET state = 'transcribed'")) { DB.windowState = "transcribed"; return []; }
    // recordFailure's two outcomes: back to the drain, or parked.
    if (q.includes("UPDATE bench_window SET state = 'closed'")) { DB.windowState = "closed"; return []; }
    if (q.includes("UPDATE bench_window SET state = 'failed'")) { DB.windowState = "failed"; return []; }
    if (q.includes("FROM stt_routing")) return [{ engine_id: "route" }];
    if (q.includes("FROM stt_engine")) return [{ enabled: true }];
    if (q.includes("UPDATE stt_subject_job") && q.includes("last_error")) {
      DB.failures.push(String(v[0]));
      DB.attempts += 1;
      return [{ attempts: DB.attempts }];
    }
    if (q.includes("UPDATE stt_subject_job")) return [{ attempts: 1 }];
    return [];
  },
}));
vi.mock("@/lib/r2", () => ({
  getObjectBytes: async () => new Uint8Array([1, 2, 3, 4]),
  signGetUrl: async (o: { key: string }) => `https://r2.example/${o.key}`,
}));
vi.mock("@/lib/whisper", () => ({
  transcribeWithWhisper: async () => ({ ok: true, transcript: "whisper words", language: "kn", latency_ms: 120, attempts: 1,
    segments: [{ start_s: 0, end_s: 10, text: "inside the sample" }], engineVersion: "large-v3-turbo" }),
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
  writeWindowCues: async () => ({ written: 2, deleted: 0, failed: 0, complete: true, window_recorded: true }),
}));
vi.mock("@/lib/stt/eta-router", () => ({
  ROUTER_JOB_ON: () => true,
  submitRouteJob: async () => { ROUTER.submits += 1; return { ok: true, job_id: `rj_${ROUTER.submits}` }; },
  pollRouteJob: async (jobId: string) => { ROUTER.polls += 1; return ROUTER.impl ? ROUTER.impl(jobId) : (ROUTER.states.shift() ?? { ok: true, state: "running" }); },
  routeTranscribe: async () => ({ ok: true }),
}));

const ARGS = { window_id: "bw_1", origin: "https://x.test", actor: "admin_1", via: "admin_route" };
const MIN = 60_000;

type Out = { kind: string; step?: string; progress?: Record<string, unknown>; error?: string; result?: Record<string, unknown> };

/** Run the machine one claim at a time, as the runner does. `beforePoll` fires once, just before the first poll claim. */
async function drive(opts: { beforePoll?: () => void; maxSteps?: number } = {}) {
  const { roomWindowKind } = await import("@/lib/jobs/kinds/room-window");
  let step = roomWindowKind.first;
  let progress: Record<string, unknown> = {};
  const visited: string[] = [];
  let fired = false;
  for (let i = 0; i < (opts.maxSteps ?? 20); i += 1) {
    if (step === "poll" && !fired) { fired = true; opts.beforePoll?.(); }
    visited.push(step);
    const out = (await roomWindowKind.run({ job: {} as never, step, args: ARGS, progress, runner: "r1" })) as Out;
    if (out.kind === "done") return { visited, result: out.result, progress };
    if (out.kind === "fail") return { visited, error: out.error, progress };
    progress = out.progress!;
    step = out.step!;
  }
  throw new Error(`did not settle: ${visited.join(" -> ")}`);
}

const T0 = Date.UTC(2026, 8, 23, 7, 47, 0); // 13:17 IST, the restart

beforeEach(() => {
  DB.windowState = "closed"; DB.failures = []; DB.attempts = 0;
  ROUTER.submits = 0; ROUTER.polls = 0; ROUTER.states = []; ROUTER.impl = null;
  // Fake Date only: the poll loop's own 3 s sleep stays real, so time moves only when a test moves it.
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(T0);
});
afterEach(() => { vi.useRealTimers(); });

describe("the bound", () => {
  it("is twice the audio, never under 30 minutes", async () => {
    const { routerJobMaxRunningMs, ROUTER_JOB_LOST_FLOOR_MS } = await import("@/lib/stt/room-drain");
    expect(ROUTER_JOB_LOST_FLOOR_MS).toBe(30 * MIN);
    expect(routerJobMaxRunningMs(900)).toBe(30 * MIN);      // the 15-minute window: exactly the floor
    expect(routerJobMaxRunningMs(1800)).toBe(60 * MIN);     // longer audio, longer bound
    expect(routerJobMaxRunningMs(60)).toBe(30 * MIN);       // short audio never gets a tighter bound
    for (const bad of [0, -5, null, undefined, Number.NaN]) expect(routerJobMaxRunningMs(bad as number)).toBe(30 * MIN);
  });
});

describe("case 1 — the router says it does not know the job", () => {
  for (const [label, answer] of [
    ["FastAPI's bare 404 (the job file is gone)", { ok: false, error: 'http_404: {"detail":"Not Found"}' }],
    ["the router's own 'unknown job_id'", { ok: false, error: 'http_404: {"ok":false,"error":"unknown job_id"}' }],
  ] as const) {
    it(`${label}: the job fails router_job_lost at the first poll, and the window returns to the drain`, async () => {
      ROUTER.states = [answer];
      const r = await drive();
      expect(r.visited).toEqual(["prepare", "segment", "engine", "poll"]);
      expect(r.error, "its own code, not room_window_failed").toMatch(/^router_job_lost\b/);
      expect(ROUTER.polls, "one poll decided it — no hours of re-polling").toBe(1);
      expect(ROUTER.submits, "nothing resubmits in place").toBe(1);
      expect(DB.failures, "the window's failure row names it").toEqual(["engine_failed: router_job_lost"]);
      expect(DB.windowState, "back to closed, so the drain submits a NEW router job").toBe("closed");
    });
  }

  it("a 5xx is NOT lost inside the bound: the hop failed, the job may be fine", async () => {
    const { roomWindowPoll } = await import("@/lib/stt/room-drain");
    ROUTER.states = [{ ok: false, error: "http_502: bad gateway" }];
    const progress = { router_job_id: "rj_1", router_submitted_at: T0, engine_id: "route", engine_key: "route", clip_r2_key: "clips/joined.webm", audio_seconds: 900 };
    const o = await roomWindowPoll("bw_1", { actor: "admin_1", via: "admin_route" }, progress);
    expect(o.ok).toBe(true);
    expect(o.still_running).toBe(true);
    expect(DB.failures).toEqual([]);
  });
});

describe("case 2 — the clock is time since the router's answer last CHANGED (Refuter, 206acbf)", () => {
  const who = { actor: "admin_1", via: "admin_route" as const };
  const base = { router_job_id: "rj_1", router_submitted_at: T0, engine_id: "route", engine_key: "route", clip_r2_key: "clips/joined.webm", audio_seconds: 900 };

  it("the bounds: running 30 min, waiting (running, nothing done) 4x = 2 h, for a 900 s window", async () => {
    const { routerJobMaxWaitingMs, ROUTER_JOB_WAIT_FACTOR } = await import("@/lib/stt/room-drain");
    expect(ROUTER_JOB_WAIT_FACTOR).toBe(4);
    expect(routerJobMaxWaitingMs(900)).toBe(120 * MIN);
    expect(routerJobMaxWaitingMs(1800)).toBe(240 * MIN);
  });

  it("the Refuter's case: a job first polled 31 min after submit is NOT lost — submit time no longer counts", async () => {
    // Called directly: with Date frozen, the poll step's own 150 s in-step loop would never reach its deadline.
    const { roomWindowPoll } = await import("@/lib/stt/room-drain");
    vi.setSystemTime(T0 + 31 * MIN);
    const o = await roomWindowPoll("bw_1", who, { ...base }); // stamped at T0, never polled
    expect(o.ok).toBe(true);
    expect(o.still_running, "a waiting job is not a lost job").toBe(true);
    expect(o.next_progress?.router_last_change_at, "its clock starts at its first answer").toBe(T0 + 31 * MIN);
    expect(DB.failures).toEqual([]);
  });

  it("PROGRESSED then frozen for 31 min (the restart signature): lost", async () => {
    const { roomWindowPoll } = await import("@/lib/stt/room-drain");
    vi.setSystemTime(T0 + 31 * MIN);
    ROUTER.states = [{ ok: true, state: "running", progress: { done: 2, total: 5 } }];
    const o = await roomWindowPoll("bw_1", who, { ...base, router_last_change_at: T0, router_last_seen: "running:2" });
    expect(o.ok).toBe(false);
    expect(o.detail).toBe("router_job_lost");
    expect(DB.failures).toEqual(["engine_failed: router_job_lost"]);
    expect(DB.windowState).toBe("closed");
  });

  it("the same freeze at 29 min: not lost, and the clock is not reset by an unchanged answer", async () => {
    const { roomWindowPoll } = await import("@/lib/stt/room-drain");
    vi.setSystemTime(T0 + 29 * MIN);
    ROUTER.states = [{ ok: true, state: "running", progress: { done: 2, total: 5 } }];
    const o = await roomWindowPoll("bw_1", who, { ...base, router_last_change_at: T0, router_last_seen: "running:2" });
    expect(o.still_running).toBe(true);
    expect(o.next_progress?.router_last_change_at).toBe(T0);
    expect(DB.failures).toEqual([]);
  });

  it("progress MOVES at 40 min: not lost, and the clock restarts at that poll", async () => {
    const { roomWindowPoll } = await import("@/lib/stt/room-drain");
    vi.setSystemTime(T0 + 40 * MIN);
    ROUTER.states = [{ ok: true, state: "running", progress: { done: 3, total: 5 } }];
    const o = await roomWindowPoll("bw_1", who, { ...base, router_last_change_at: T0, router_last_seen: "running:2" });
    expect(o.still_running).toBe(true);
    expect(o.next_progress?.router_last_change_at).toBe(T0 + 40 * MIN);
    expect(o.next_progress?.router_last_seen).toBe("running:3");
  });

  it("running with NOTHING done is waiting: alive at 90 min, lost only past the 2 h waiting bound", async () => {
    const { roomWindowPoll } = await import("@/lib/stt/room-drain");
    const waiting = { ...base, router_last_change_at: T0, router_last_seen: "running:0" };
    vi.setSystemTime(T0 + 90 * MIN);
    ROUTER.states = [{ ok: true, state: "running", progress: { done: 0, total: 5 } }];
    expect((await roomWindowPoll("bw_1", who, waiting)).still_running).toBe(true);
    vi.setSystemTime(T0 + 121 * MIN);
    ROUTER.states = [{ ok: true, state: "running", progress: { done: 0, total: 5 } }];
    const o = await roomWindowPoll("bw_1", who, waiting);
    expect(o.detail, "a job a restart left waiting is still caught, just later").toBe("router_job_lost");
  });

  it("`queued` is never lost on time — not even after 5 hours", async () => {
    const { roomWindowPoll } = await import("@/lib/stt/room-drain");
    vi.setSystemTime(T0 + 300 * MIN);
    ROUTER.states = [{ ok: true, state: "queued" }];
    const o = await roomWindowPoll("bw_1", who, { ...base, router_last_change_at: T0, router_last_seen: "queued:" });
    expect(o.still_running).toBe(true);
    expect(DB.failures).toEqual([]);
  });

  it("polls that keep FAILING are lost after the running bound from the router's last answer; before that, kept", async () => {
    const { roomWindowPoll } = await import("@/lib/stt/room-drain");
    const last = { ...base, router_last_change_at: T0, router_last_seen: "running:0" };
    vi.setSystemTime(T0 + 20 * MIN);
    ROUTER.states = [{ ok: false, error: "fetch failed" }];
    const early = await roomWindowPoll("bw_1", who, last);
    expect(early.still_running).toBe(true);
    expect(early.next_progress?.router_last_change_at, "an error never resets the clock").toBe(T0);
    vi.setSystemTime(T0 + 45 * MIN);
    ROUTER.states = [{ ok: false, error: "fetch failed" }];
    expect((await roomWindowPoll("bw_1", who, last)).detail).toBe("router_job_lost");
  });

  it("a longer window gets a longer bound: 31 min frozen is fine for 1,800 s of audio", async () => {
    const { roomWindowPoll } = await import("@/lib/stt/room-drain");
    vi.setSystemTime(T0 + 31 * MIN);
    ROUTER.states = [{ ok: true, state: "running", progress: { done: 2, total: 10 } }];
    const o = await roomWindowPoll("bw_1", who, { ...base, audio_seconds: 1800, router_last_change_at: T0, router_last_seen: "running:2" });
    expect(o.still_running).toBe(true);
  });

  it("a job with no clock yet (first poll, or submitted before this change) starts it now — never lost on that poll", async () => {
    const { roomWindowPoll } = await import("@/lib/stt/room-drain");
    vi.setSystemTime(T0 + 300 * MIN);
    ROUTER.states = [{ ok: true, state: "running", progress: { done: 4, total: 5 } }];
    const legacy = { router_job_id: "rj_old", engine_id: "route", engine_key: "route", clip_r2_key: "clips/joined.webm", audio_seconds: 900 };
    const o = await roomWindowPoll("bw_1", who, legacy);
    expect(o.still_running).toBe(true);
    expect(o.next_progress?.router_last_change_at).toBe(T0 + 300 * MIN);
  });
});

describe("the Refuter's batch: FIVE windows submitted together (AUTO_DRAIN_BATCH_LIMIT=5) all finish, none is lost", () => {
  // The router at its worst for waiting: ONE job holds the window semaphore for its whole window (Python's
  // semaphore is not fair), every window takes the worst observed 640 s in 5 sub-windows, and the others
  // wait. Job k starts at k x 640 s — the fifth waits 42.7 min, past the 30-min running bound.
  const W = 640_000;
  const SUB = W / 5;
  const done = { ok: true, state: "done", transcript_native: "router words", dominant_language: "kn",
                 language_timeline: [{ start_s: 0, end_s: 900, lang: "kn", engine: "indicconformer", chars: 12 }], sec: 640 };
  for (const waitingState of ["running", "queued"] as const) {
    it(`waiting jobs report \`${waitingState}\` (router ${waitingState === "running" ? "as built: running from thread start" : "as Fable described it"}): polled every 2.5 min for 60 min, 0 lost, 5 done`, async () => {
      const { roomWindowPoll } = await import("@/lib/stt/room-drain");
      const who = { actor: "admin_1", via: "admin_route" as const };
      ROUTER.impl = (jobId: string) => {
        const k = Number(jobId.replace("rj_", "")) - 1;
        const t = Date.now() - T0 - k * W;
        if (t < 0) return waitingState === "running" ? { ok: true, state: "running", progress: { done: 0, total: 5 } } : { ok: true, state: "queued" };
        if (t >= W) return done;
        return { ok: true, state: "running", progress: { done: Math.floor(t / SUB), total: 5 } };
      };
      const jobs = [1, 2, 3, 4, 5].map((i) => ({ id: `bw_${i}`, finished: false, lost: false,
        progress: { router_job_id: `rj_${i}`, router_submitted_at: T0, engine_id: "route", engine_key: "route", clip_r2_key: "clips/joined.webm", audio_seconds: 900 } as Record<string, unknown> }));
      for (let t = 0; t <= 60 * MIN; t += 2.5 * MIN) {
        vi.setSystemTime(T0 + t);
        for (const j of jobs) {
          if (j.finished || j.lost) continue;
          const o = await roomWindowPoll(j.id, who, j.progress);
          if (!o.ok) { j.lost = true; continue; }
          if (!o.still_running) { j.finished = true; continue; }
          j.progress = o.next_progress!;
        }
      }
      expect(jobs.filter((j) => j.lost).map((j) => j.id), "no waiting window is declared lost").toEqual([]);
      expect(jobs.filter((j) => j.finished).length, "all five finish").toBe(5);
      expect(DB.failures).toEqual([]);
    });
  }
});

describe("the healthy path is unchanged", () => {
  it("submit stamps router_submitted_at, and a job that finishes inside the bound completes", async () => {
    ROUTER.states = [{ ok: true, state: "done", transcript_native: "router words", dominant_language: "kn",
                       language_timeline: [{ start_s: 0, end_s: 900, lang: "kn", engine: "indicconformer", chars: 12 }], sec: 700 }];
    const r = await drive({ beforePoll: () => vi.setSystemTime(T0 + 12 * MIN) });
    expect(r.error).toBeUndefined();
    expect(r.visited).toEqual(["prepare", "segment", "engine", "poll", "finish"]);
    expect(r.progress.router_submitted_at, "stamped at submit, in epoch ms").toBe(T0);
    expect(DB.failures).toEqual([]);
    expect(DB.windowState).toBe("transcribed");
  });
});

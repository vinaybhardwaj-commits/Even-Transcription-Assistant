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
const ROUTER = vi.hoisted(() => ({ submits: 0, polls: 0, states: [] as Array<Record<string, unknown>> }));

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
  pollRouteJob: async () => { ROUTER.polls += 1; return ROUTER.states.shift() ?? { ok: true, state: "running" }; },
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
  ROUTER.submits = 0; ROUTER.polls = 0; ROUTER.states = [];
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

describe("case 2 — the router still says running, past the bound", () => {
  it("31 minutes after submit, a 900 s window's job is lost: router_job_lost, window back to the drain", async () => {
    // The restart case: the file says `running` for ever.
    const r = await drive({ beforePoll: () => vi.setSystemTime(T0 + 31 * MIN) });
    expect(r.error).toMatch(/^router_job_lost\b/);
    expect(ROUTER.polls).toBe(1);
    expect(ROUTER.submits).toBe(1);
    expect(DB.failures).toEqual(["engine_failed: router_job_lost"]);
    expect(DB.windowState).toBe("closed");
  });

  it("29 minutes after submit it is NOT lost: a live job is left alone and the same ref is polled again", async () => {
    const { roomWindowPoll } = await import("@/lib/stt/room-drain");
    vi.setSystemTime(T0 + 29 * MIN);
    ROUTER.states = [{ ok: true, state: "running", progress: { done: 3, total: 5 } }];
    const progress = { router_job_id: "rj_1", router_submitted_at: T0, engine_id: "route", engine_key: "route", clip_r2_key: "clips/joined.webm", audio_seconds: 900 };
    const o = await roomWindowPoll("bw_1", { actor: "admin_1", via: "admin_route" }, progress);
    expect(o.ok).toBe(true);
    expect(o.still_running).toBe(true);
    expect(o.next_progress?.router_submitted_at, "the clock is not reset by a poll").toBe(T0);
    expect(DB.failures).toEqual([]);
  });

  it("a poll that keeps FAILING (router down) past the bound is lost too — it never ends otherwise", async () => {
    const { roomWindowPoll } = await import("@/lib/stt/room-drain");
    vi.setSystemTime(T0 + 45 * MIN);
    ROUTER.states = [{ ok: false, error: "fetch failed" }];
    const progress = { router_job_id: "rj_1", router_submitted_at: T0, engine_id: "route", engine_key: "route", clip_r2_key: "clips/joined.webm", audio_seconds: 900 };
    const o = await roomWindowPoll("bw_1", { actor: "admin_1", via: "admin_route" }, progress);
    expect(o.ok).toBe(false);
    expect(o.detail).toBe("router_job_lost");
    expect(DB.failures).toEqual(["engine_failed: router_job_lost"]);
  });

  it("a longer window gets a longer bound: 31 minutes is fine for 1,800 s of audio", async () => {
    const { roomWindowPoll } = await import("@/lib/stt/room-drain");
    vi.setSystemTime(T0 + 31 * MIN);
    const progress = { router_job_id: "rj_1", router_submitted_at: T0, engine_id: "route", engine_key: "route", clip_r2_key: "clips/joined.webm", audio_seconds: 1800 };
    const o = await roomWindowPoll("bw_1", { actor: "admin_1", via: "admin_route" }, progress);
    expect(o.ok).toBe(true);
    expect(o.still_running).toBe(true);
  });

  it("a job submitted BEFORE this fix (no stamp) is bounded from its first poll, not exempt for ever", async () => {
    const { roomWindowPoll } = await import("@/lib/stt/room-drain");
    const who = { actor: "admin_1", via: "admin_route" as const };
    const legacy = { router_job_id: "rj_old", engine_id: "route", engine_key: "route", clip_r2_key: "clips/joined.webm", audio_seconds: 900 };
    const first = await roomWindowPoll("bw_1", who, legacy);
    expect(first.still_running).toBe(true);
    expect(first.next_progress?.router_first_polled_at, "the first poll starts the clock").toBe(T0);

    vi.setSystemTime(T0 + 31 * MIN);
    const later = await roomWindowPoll("bw_1", who, first.next_progress!);
    expect(later.ok).toBe(false);
    expect(later.detail).toBe("router_job_lost");
    expect(DB.failures).toEqual(["engine_failed: router_job_lost"]);
  });
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

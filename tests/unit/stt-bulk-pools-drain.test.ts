/**
 * STT-STACK-PARITY 2(b) — the drain pins every router poll to the router that took the job.
 *
 * With ETA_ROUTER_BULK_URLS set, a bulk window's job lives on a twin. Its id means nothing to the Mini's
 * router, which would answer 404 — and 404 is ROUTER_JOB_LOST (206acbf). So the submit's endpoint is
 * persisted beside the id and handed back on every poll claim. Same harness as router-job-lost.test.ts:
 * the REAL step machine over a fake database and a fake router client.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const ROUTER = vi.hoisted(() => ({ endpoint: null as string | null, pollEndpoints: [] as Array<string | null>, submits: 0 }));

const DB = vi.hoisted(() => ({
  windowState: "closed",
  failures: [] as string[],
  attempts: 0,
}));

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
  submitRouteJob: async () => {
    ROUTER.submits += 1;
    return { ok: true, job_id: `rj_${ROUTER.submits}`, ...(ROUTER.endpoint ? { endpoint: ROUTER.endpoint } : {}) };
  },
  // A router that forgot the job: decides the window at the first poll, so each case is one claim.
  pollRouteJob: async (_jobId: string, endpoint?: string | null) => {
    ROUTER.pollEndpoints.push(endpoint ?? null);
    return { ok: false, error: 'http_404: {"detail":"Not Found"}' };
  },
  routeTranscribe: async () => ({ ok: true }),
}));

const ARGS = { window_id: "bw_1", origin: "https://x.test", actor: "admin_1", via: "admin_route" };
type Out = { kind: string; step?: string; progress?: Record<string, unknown>; error?: string };

async function drive() {
  const { roomWindowKind } = await import("@/lib/jobs/kinds/room-window");
  let step = roomWindowKind.first;
  let progress: Record<string, unknown> = {};
  for (let i = 0; i < 10; i += 1) {
    const out = (await roomWindowKind.run({ job: {} as never, step, args: ARGS, progress, runner: "r1" })) as Out;
    if (out.kind !== "next") return { error: out.error, progress };
    progress = out.progress!;
    step = out.step!;
  }
  throw new Error("did not settle");
}

beforeEach(() => {
  DB.windowState = "closed"; DB.failures = []; DB.attempts = 0;
  ROUTER.endpoint = null; ROUTER.pollEndpoints = []; ROUTER.submits = 0;
  vi.spyOn(console, "error").mockImplementation(() => {});
});

describe("the poll goes to the router that holds the job", () => {
  it("a pooled submit's endpoint is persisted as router_endpoint and every poll is sent there", async () => {
    ROUTER.endpoint = "https://route-box.example";
    const r = await drive();
    expect(r.progress.router_endpoint).toBe("https://route-box.example");
    expect(ROUTER.pollEndpoints).toEqual(["https://route-box.example"]);
    expect(r.error).toMatch(/^router_job_lost\b/);
  });

  it("NO-POOL IDENTITY: no endpoint from the submit → no router_endpoint key, and the poll is called with the id alone", async () => {
    const r = await drive();
    expect("router_endpoint" in r.progress).toBe(false);
    expect(ROUTER.pollEndpoints).toEqual([null]);
  });

  it("a row written before this change (id, no endpoint) polls where it always did", async () => {
    const { roomWindowPoll } = await import("@/lib/stt/room-drain");
    const progress = { router_job_id: "rj_old", engine_id: "route", engine_key: "route", clip_r2_key: "clips/joined.webm", audio_seconds: 900 };
    await roomWindowPoll("bw_1", { actor: "admin_1", via: "admin_route" }, progress);
    expect(ROUTER.pollEndpoints).toEqual([null]);
  });
});

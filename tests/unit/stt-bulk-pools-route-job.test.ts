/**
 * STT-STACK-PARITY 2(b) — route_transcribe pins its polls to the router that took the job (ETA-Refuter F2).
 *
 * The same rule as the room drain (stt-bulk-pools-drain.test.ts): with a router pool set, the submit's
 * endpoint is persisted as `router_endpoint` and every poll claim goes back there. Without it the job would be
 * submitted to a twin and polled on the Mini, which answers 404 for an id it never had.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const ROUTER = vi.hoisted(() => ({ endpoint: null as string | null, pollEndpoints: [] as Array<string | null> }));

vi.mock("@/lib/r2", () => ({
  headObject: async () => ({ size: 10 }),
  signGetUrl: async (o: { key: string }) => `https://r2.example/${o.key}`,
}));
vi.mock("@/lib/stt/eta-router", () => ({
  ROUTER_JOB_ON: () => true,
  submitRouteJob: async () => ({ ok: true, job_id: "abc123", ...(ROUTER.endpoint ? { endpoint: ROUTER.endpoint } : {}) }),
  pollRouteJob: async (_id: string, endpoint?: string | null) => { ROUTER.pollEndpoints.push(endpoint ?? null); return { ok: false, error: "unknown job_id" }; },
  routeTranscribe: async () => ({ ok: true }),
}));

const ctx = (step: string, args: Record<string, unknown>, progress: Record<string, unknown> = {}) =>
  ({ job: {} as never, step, args, progress, runner: "r1" });

beforeEach(() => {
  ROUTER.endpoint = null; ROUTER.pollEndpoints = [];
  vi.spyOn(console, "error").mockImplementation(() => {});
});

async function submitThenPoll() {
  const { routeTranscribeKind } = await import("@/lib/jobs/kinds/route-transcribe");
  const sub = (await routeTranscribeKind.run(ctx("submit", { clip_key: "clips/a.webm", translate: false }))) as { kind: string; progress: Record<string, unknown> };
  expect(sub.kind).toBe("next");
  await routeTranscribeKind.run(ctx("poll", {}, sub.progress));
  return sub.progress;
}

describe("route_transcribe — the poll goes to the router that holds the job", () => {
  it("a pooled submit's endpoint is persisted as router_endpoint and the poll is sent there", async () => {
    ROUTER.endpoint = "https://route-box.example";
    const progress = await submitThenPoll();
    expect(progress.router_endpoint).toBe("https://route-box.example");
    expect(ROUTER.pollEndpoints).toEqual(["https://route-box.example"]);
  });
  it("NO-POOL IDENTITY: no endpoint → no router_endpoint key, and the poll is called with the id alone", async () => {
    const progress = await submitThenPoll();
    expect("router_endpoint" in progress).toBe(false);
    expect(ROUTER.pollEndpoints).toEqual([null]);
  });
});

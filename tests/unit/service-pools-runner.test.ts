/**
 * REDUNDANCY-R1 Phase 4 — the RUNNER wires pools into every job: the kind's `poolBulk` decides routing for the
 * step, and what the step's pooled calls actually used is written onto the job (progress, then result).
 * With no pool configured, what is saved is exactly what the kind returned.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const store = { saved: [] as Array<{ step: string; progress: Record<string, unknown> }>, finished: [] as Array<Record<string, unknown>> };
vi.mock("@/lib/jobs/store", () => ({
  overFailureCap: () => false,
  readJob: async () => ({ status: "running" }),
  saveStep: async (_id: string, step: string, progress: Record<string, unknown>) => { store.saved.push({ step, progress }); return 1; },
  finishJob: async (_id: string, result: Record<string, unknown>) => { store.finished.push(result); return 1; },
  failJob: async () => 1,
  recordFailure: async () => ({ failures: 1 }),
  cancelJob: async () => 1,
  claimJobs: async () => [],
}));

const fake = { bulk: false, finish: false };
vi.mock("@/lib/jobs/kinds", async () => {
  const { transcribeWithWhisper } = await import("@/lib/whisper");
  const kind = {
    name: "fake_pool", first: "a", scope: "invoke", parseArgs: (x: unknown) => x as Record<string, unknown>,
    poolBulk: async () => fake.bulk,
    run: async () => {
      await transcribeWithWhisper(new Uint8Array([1]));
      return fake.finish ? { kind: "done", result: { ok: true } } : { kind: "next", step: "b", progress: { kept: 1 } };
    },
  };
  return { KIND_BY_NAME: new Map([["fake_pool", kind]]) };
});

import { runOneStep } from "@/lib/jobs/runner";
import { resetBreakers } from "@/lib/service-pool";

const VARS = ["WHISPER_BASE_URL", "WHISPER_BASE_URLS", "WHISPER_BULK_URLS"];
const saved: Record<string, string | undefined> = {};
const urls: string[] = [];
const job = (progress: Record<string, unknown> = {}) =>
  ({ id: "j1", kind: "fake_pool", step: "a", args: {}, progress, failures: 0 }) as never;

beforeEach(() => {
  for (const k of VARS) { saved[k] = process.env[k]; delete process.env[k]; }
  store.saved.length = 0; store.finished.length = 0; urls.length = 0; fake.bulk = false; fake.finish = false;
  resetBreakers();
  vi.stubGlobal("fetch", async (u: string) => {
    urls.push(u);
    return { ok: true, status: 200, json: async () => ({ text: "hi", segments: [] }), text: async () => "" } as unknown as Response;
  });
});
afterEach(() => {
  for (const k of VARS) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
  vi.unstubAllGlobals();
});

describe("runner × pools", () => {
  it("NO-ENV IDENTITY: the progress saved is exactly the kind's — no served_by key", async () => {
    process.env.WHISPER_BASE_URL = "https://mini";
    await runOneStep(job(), "r1");
    expect(urls).toEqual(["https://mini/inference"]);
    expect(store.saved).toEqual([{ step: "b", progress: { kept: 1 } }]);
  });
  it("the kind's poolBulk routes the step's calls to the BULK endpoint, and served_by is saved with the step", async () => {
    process.env.WHISPER_BASE_URL = "https://mini";
    process.env.WHISPER_BULK_URLS = "https://box";
    fake.bulk = true;
    await runOneStep(job(), "r1");
    expect(urls).toEqual(["https://box/inference"]);
    expect(store.saved[0].progress).toEqual({ kept: 1, served_by: { whisper: "https://box" } });
  });
  it("not bulk → the ordinary endpoint, even with a BULK list set", async () => {
    process.env.WHISPER_BASE_URL = "https://mini";
    process.env.WHISPER_BULK_URLS = "https://box";
    await runOneStep(job(), "r1");
    expect(urls).toEqual(["https://mini/inference"]);
    expect(store.saved[0].progress.served_by).toEqual({ whisper: "https://mini" });
  });
  it("the finished result carries what earlier steps recorded plus this step's", async () => {
    process.env.WHISPER_BASE_URLS = "https://gcp";
    fake.finish = true;
    await runOneStep(job({ served_by: { join: "https://box" } }), "r1");
    expect(store.finished).toEqual([{ ok: true, served_by: { join: "https://box", whisper: "https://gcp" } }]);
  });
});

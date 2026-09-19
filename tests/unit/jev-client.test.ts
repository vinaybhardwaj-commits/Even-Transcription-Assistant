/**
 * Slice J1 (ETA-JEV-ARM-D §4) — the Jev provider client.
 *
 * Every test drives an INJECTED transport and an injected trace: no child process, no even-jev MCP,
 * no network, no real Jev call — so this suite runs with D1b closed and proves the client's
 * semantics (flag-off, size guard, retry, trace/token accounting) without ever touching the vendor.
 * Each test states, in one clause, what would have to break for it to fail.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import { McpJevClient, getJevClient, JEV_STATE_MAX_CHARS } from "@/lib/jev/client";
import { MockJevClient } from "@/lib/jev/mock";
import { JevDisabledError, JevStateTooLargeError, JevTransportError, type JevAnswer, type JevRequest } from "@/lib/jev/types";
import type { TraceHandle } from "@/lib/llm-trace/log";

function fakeTrace() {
  // Typed param so .mock.calls[0][0] is the finalise argument (tsconfig.tests.json is strict).
  const finalise = vi.fn(async (_a: Parameters<TraceHandle["finalise"]>[0]) => {});
  const event = vi.fn();
  const handle: TraceHandle = { id: "trace-1", event, finalise };
  return { handle, finalise, event };
}

const noulReq: JevRequest = {
  state: { windows: [{ id: "W1", text: "hello" }] },
  questions: { q_noul: { type: "noul", instructions: "does X happen in W1?" } },
};

beforeEach(() => {
  process.env.ETA_JEV_ENABLED = "1";
  delete process.env.ETA_JEV_MOCK;
  delete process.env.ETA_JEV_MODEL;
  delete process.env.ETA_JEV_TIMEOUT_MS;
});

describe("J1 — the request the transport receives", () => {
  it("sends state, model, and each primitive's questions verbatim (escape option preserved)", async () => {
    const tr = fakeTrace();
    const seen: Array<{ state: unknown; questions: unknown; model: string }> = [];
    const transport = vi.fn(async (payload: { state: unknown; questions: unknown; model: string }) => {
      seen.push(payload);
      return { model: "jev-x", answers: {}, usage: { input_tokens: 10, output_tokens: 0 }, latency_ms: 1 };
    });
    const client = new McpJevClient({ transport, openTrace: async () => tr.handle, sleep: async () => {} });
    const req: JevRequest = {
      state: { windows: [{ id: "W1", text: "x" }] },
      model: "jev-pinned",
      questions: {
        q_noul: { type: "noul", instructions: "a?", criteria: { true: "t", false: "f" } },
        q_choice: { type: "choice", instructions: "which?", criteria: { arrival: "a patient is seated", other: null } },
        q_score: { type: "score", instructions: "how much?", criteria: ["low", "mid", "high"] },
      },
    };
    await client.systemOne(req);
    expect(transport).toHaveBeenCalledTimes(1);
    expect(seen[0].model).toBe("jev-pinned");
    expect(seen[0].state).toEqual(req.state);
    expect(seen[0].questions).toEqual(req.questions);
    // breaks if: the client mutates/drops questions, loses the `other: null` escape option, or ignores an explicit model.
  });
});

describe("J1 — retry semantics", () => {
  it("retries a transient (429-class) failure once, backs off, then succeeds", async () => {
    const tr = fakeTrace();
    let n = 0;
    const transport = vi.fn(async () => {
      n += 1;
      if (n === 1) throw new JevTransportError("HTTP 429 overloaded", { retryable: true, status: 429 });
      return { model: "jev-x", answers: {}, usage: { input_tokens: 10, output_tokens: 0 }, latency_ms: 1 };
    });
    const sleep = vi.fn(async () => {});
    const client = new McpJevClient({ transport, openTrace: async () => tr.handle, sleep });
    const res = await client.systemOne(noulReq);
    expect(transport).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenCalledTimes(1);
    expect(res.model).toBe("jev-x");
    // breaks if: a retryable error is not retried, or is retried with no backoff between attempts.
  });

  it("does NOT retry a non-retryable (422-class) failure and finalises the trace errored", async () => {
    const tr = fakeTrace();
    const transport = vi.fn(async () => { throw new JevTransportError("HTTP 422 invalid question", { retryable: false, status: 422 }); });
    const sleep = vi.fn(async () => {});
    const client = new McpJevClient({ transport, openTrace: async () => tr.handle, sleep });
    await expect(client.systemOne(noulReq)).rejects.toBeInstanceOf(JevTransportError);
    expect(transport).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
    expect(tr.finalise).toHaveBeenCalledWith(expect.objectContaining({ status: "errored" }));
    // breaks if: a 422-class failure is retried, or a failed call leaves the trace un-finalised.
  });
});

describe("J1 — off and oversized are refused before the vendor is touched", () => {
  it("throws JevDisabledError before opening a trace or calling the transport when the flag is off", async () => {
    delete process.env.ETA_JEV_ENABLED;
    const transport = vi.fn();
    const openTraceFn = vi.fn();
    const client = new McpJevClient({ transport, openTrace: openTraceFn as unknown as typeof import("@/lib/llm-trace/log").openTrace });
    await expect(client.systemOne(noulReq)).rejects.toBeInstanceOf(JevDisabledError);
    expect(transport).not.toHaveBeenCalled();
    expect(openTraceFn).not.toHaveBeenCalled();
    // breaks if: a gated-off call opens a trace, spawns the MCP, or reaches the vendor.
  });

  it("throws JevStateTooLargeError (never calls the transport) when the state exceeds the cap", async () => {
    const transport = vi.fn();
    const tr = fakeTrace();
    const client = new McpJevClient({ transport, openTrace: async () => tr.handle });
    const big = "x".repeat(JEV_STATE_MAX_CHARS + 1);
    await expect(client.systemOne({ state: big, questions: noulReq.questions })).rejects.toBeInstanceOf(JevStateTooLargeError);
    expect(transport).not.toHaveBeenCalled();
    // breaks if: an oversized state is sent (silent truncation or a provider 413) instead of failing fast so the caller can chunk.
  });
});

describe("J1 — the trace is the cost/PHI boundary", () => {
  it("finalises the trace with model_calls carrying token counts", async () => {
    const tr = fakeTrace();
    const transport = vi.fn(async () => ({ model: "jev-x", answers: {}, usage: { input_tokens: 321, output_tokens: 7 }, latency_ms: 42 }));
    const client = new McpJevClient({ transport, openTrace: async () => tr.handle, sleep: async () => {} });
    await client.systemOne(noulReq);
    expect(tr.finalise).toHaveBeenCalledTimes(1);
    const arg = tr.finalise.mock.calls[0][0];
    expect(arg.status).toBe("completed");
    expect(arg.model_calls?.[0]).toMatchObject({ model: "jev-x", latency_ms: 42, tokens_in: 321, tokens_out: 7 });
    // breaks if: token counts are not recorded on the trace, leaving Jev cost unobservable from the DB.
  });

  it("opens the trace with question ids and byte size only — never the state text", async () => {
    let captured: { surface?: string; request_input?: { question_ids?: string[]; state_bytes?: number } } = {};
    const tr = fakeTrace();
    const openTraceFn = vi.fn(async (args: typeof captured) => { captured = args; return tr.handle; });
    const transport = vi.fn(async () => ({ model: "jev-x", answers: {}, usage: { input_tokens: 1, output_tokens: 0 }, latency_ms: 1 }));
    const client = new McpJevClient({ transport, openTrace: openTraceFn as unknown as typeof import("@/lib/llm-trace/log").openTrace, sleep: async () => {} });
    await client.systemOne({ state: { note: "PATIENT_WORDS_MARKER" }, questions: noulReq.questions });
    expect(captured.surface).toBe("jev");
    expect(captured.request_input?.question_ids).toEqual(["q_noul"]);
    expect(typeof captured.request_input?.state_bytes).toBe("number");
    expect(JSON.stringify(captured.request_input)).not.toContain("PATIENT_WORDS_MARKER");
    // breaks if: the trace's request_input ever carries the state text — a PHI leak into the trace table.
  });
});

describe("J1 — the mock provider", () => {
  it("getJevClient returns the deterministic mock when ETA_JEV_MOCK is set", async () => {
    process.env.ETA_JEV_MOCK = "1";
    const client = getJevClient();
    expect(client).toBeInstanceOf(MockJevClient);
    const r1 = await client.systemOne(noulReq);
    const r2 = await client.systemOne(noulReq);
    expect(r1).toEqual(r2);
    expect(r1.answers.q_noul).toEqual({ type: "noul", noul: 0 }); // absence-safe default
    expect(r1.usage.input_tokens).toBeGreaterThan(0);
    // breaks if: the mock is non-deterministic, reaches the network, or defaults noul to "yes".
  });

  it("MockJevClient returns fixture answers keyed by question id", async () => {
    const fixtures: Record<string, JevAnswer> = { q_noul: { type: "noul", noul: 0.87 } };
    const r = await new MockJevClient(fixtures).systemOne(noulReq);
    expect(r.answers.q_noul).toEqual({ type: "noul", noul: 0.87 });
    // breaks if: the mock ignores its fixture map, so tests cannot pin specific answers.
  });
});

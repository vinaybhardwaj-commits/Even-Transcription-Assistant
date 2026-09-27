/**
 * tests/unit/jev-client.test.ts — Slice J1. The provider client, against a fake fetch and a fake
 * trace. No test ever reaches the network: fetchImpl is always injected.
 *
 * REFUTER F5 (19 Sep): tests appended below the original suite proving the trace is finalised
 * with status:"errored" on every non-success exit path (a thrown fetch error, a timeout, an
 * abort).
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const traceCalls: Array<{ args: unknown; finalise: unknown[] }> = [];
vi.mock("@/lib/llm-trace/log", () => ({
  openTrace: vi.fn(async (args: unknown) => {
    const rec = { args, finalise: [] as unknown[] };
    traceCalls.push(rec);
    return {
      id: "trace_1",
      event: () => {},
      finalise: async (f: unknown) => {
        rec.finalise.push(f);
      },
    };
  }),
}));

import { createHttpJevClient, _resetJevClientForTests } from "@/lib/jev/client";
import { JevDisabledError, JevStateTooLargeError } from "@/lib/jev/types";
import { FlagValueError } from "@/lib/flags";

const OLD_ENV = { ...process.env };

beforeEach(() => {
  traceCalls.length = 0;
  process.env = { ...OLD_ENV };
  _resetJevClientForTests();
});

describe("J1 — jev client: disabled flag", () => {
  it("ETA_JEV_ENABLED unset throws JevDisabledError BEFORE any fetch", async () => {
    delete process.env.ETA_JEV_ENABLED;
    const fetchImpl = vi.fn();
    const client = createHttpJevClient({ fetchImpl: fetchImpl as unknown as typeof fetch });
    await expect(client.systemOne({ state: {}, questions: {} })).rejects.toBeInstanceOf(JevDisabledError);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  // ETA-JEV-CORE-REFUTER-VERDICT-23-SEP-2026.md: only the TRUTHY half of the flag convention was
  // pinned (this describe block only ever set ETA_JEV_ENABLED="1") — Boolean(process.env[name])
  // would have left this suite green, and under that mutant "off"/"false"/"0" would all ENABLE
  // Jev, and a malformed value would enable it too rather than throwing. For a layer whose flags
  // are specified default-OFF, one per use, that is the dangerous direction: enabling by accident.
  it("ETA_JEV_ENABLED=off DISABLES it, the same as unset — the falsy half of the flag convention", async () => {
    process.env.ETA_JEV_ENABLED = "off";
    const fetchImpl = vi.fn();
    const client = createHttpJevClient({ fetchImpl: fetchImpl as unknown as typeof fetch });
    await expect(client.systemOne({ state: {}, questions: {} })).rejects.toBeInstanceOf(JevDisabledError);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("an unrecognised ETA_JEV_ENABLED value THROWS FlagValueError rather than enabling it", async () => {
    process.env.ETA_JEV_ENABLED = "maybe";
    const fetchImpl = vi.fn();
    const client = createHttpJevClient({ fetchImpl: fetchImpl as unknown as typeof fetch });
    await expect(client.systemOne({ state: {}, questions: {} })).rejects.toBeInstanceOf(FlagValueError);
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

describe("J1 — jev client: request shape", () => {
  it("posts model/state/questions as JSON to /v1/systemone with a bearer header", async () => {
    process.env.ETA_JEV_ENABLED = "1";
    process.env.TYPESAFE_API_KEY = "test-key";
    const fetchImpl = vi.fn(async (url: string, init: RequestInit) => {
      expect(url).toBe("https://api.typesafe.ai/v1/systemone");
      const body = JSON.parse(init.body as string);
      expect(body).toMatchObject({ model: "jev-latest", questions: { q1: { type: "noul", instructions: "x" } } });
      expect((init.headers as Record<string, string>).Authorization).toBe("Bearer test-key");
      return new Response(JSON.stringify({ model: "jev-latest", answers: { q1: { type: "noul", noul: 0.9 } }, usage: { input_tokens: 10, output_tokens: 2 } }), { status: 200 });
    });
    const client = createHttpJevClient({ fetchImpl: fetchImpl as unknown as typeof fetch });
    const r = await client.systemOne({ state: { a: 1 }, questions: { q1: { type: "noul", instructions: "x" } } });
    expect(r.answers.q1).toEqual({ type: "noul", noul: 0.9 });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
});

describe("J1 — jev client: retries", () => {
  it("429 then 200 retries once and succeeds", async () => {
    process.env.ETA_JEV_ENABLED = "1";
    let calls = 0;
    const fetchImpl = vi.fn(async () => {
      calls += 1;
      if (calls === 1) return new Response("rate limited", { status: 429 });
      return new Response(JSON.stringify({ model: "jev-latest", answers: {}, usage: { input_tokens: 1, output_tokens: 1 } }), { status: 200 });
    });
    const client = createHttpJevClient({ fetchImpl: fetchImpl as unknown as typeof fetch });
    const r = await client.systemOne({ state: {}, questions: {} });
    expect(calls).toBe(2);
    expect(r.model).toBe("jev-latest");
  });

  it("422 does not retry", async () => {
    process.env.ETA_JEV_ENABLED = "1";
    const fetchImpl = vi.fn(async () => new Response("bad request", { status: 422 }));
    const client = createHttpJevClient({ fetchImpl: fetchImpl as unknown as typeof fetch });
    await expect(client.systemOne({ state: {}, questions: {} })).rejects.toThrow(/jev http 422/);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
});

describe("J1 — jev client: state size guard", () => {
  it("throws JevStateTooLargeError before fetch when state exceeds the char guard", async () => {
    process.env.ETA_JEV_ENABLED = "1";
    const fetchImpl = vi.fn();
    const client = createHttpJevClient({ fetchImpl: fetchImpl as unknown as typeof fetch });
    const bigState = { text: "x".repeat(100_001) };
    await expect(client.systemOne({ state: bigState, questions: {} })).rejects.toBeInstanceOf(JevStateTooLargeError);
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

describe("J1 — jev client: trace", () => {
  it("finalises the trace with model_calls token counts on success", async () => {
    process.env.ETA_JEV_ENABLED = "1";
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ model: "jev-latest", answers: {}, usage: { input_tokens: 42, output_tokens: 7 } }), { status: 200 }));
    const client = createHttpJevClient({ fetchImpl: fetchImpl as unknown as typeof fetch });
    await client.systemOne({ state: {}, questions: {} });
    expect(traceCalls).toHaveLength(1);
    const rec = traceCalls[0]!;
    expect((rec.args as { surface: string }).surface).toBe("jev");
    // the state text is NEVER in request_input — only question ids and byte size.
    expect(JSON.stringify(rec.args)).not.toContain("state_text");
    const fin = rec.finalise[0] as { status: string; model_calls: Array<{ tokens_in: number; tokens_out: number }> };
    expect(fin.status).toBe("completed");
    expect(fin.model_calls[0]).toMatchObject({ tokens_in: 42, tokens_out: 7 });
  });
});

// =====================================================================================
// REFUTER F5 (19 Sep): the trace is finalised with status:"errored" on EVERY non-success exit,
// not only the explicit 401/422 branch.
// =====================================================================================
describe("F5 — the trace is finalised on every non-success exit path", () => {
  it("a thrown fetch error finalises with status errored and the thrown message", async () => {
    process.env.ETA_JEV_ENABLED = "1";
    const fetchImpl = vi.fn(async () => {
      throw new Error("network down");
    });
    const client = createHttpJevClient({ fetchImpl: fetchImpl as unknown as typeof fetch });
    await expect(client.systemOne({ state: {}, questions: {} })).rejects.toThrow(/network down/);
    expect(traceCalls).toHaveLength(1);
    const fin = traceCalls[0]!.finalise[0] as { status: string; error_message: string };
    expect(fin.status).toBe("errored");
    expect(fin.error_message).toBe("jev_fetch_error: Error"); // W27.7(a): class name only, never the message text
  });

  it("a timed-out attempt finalises with status errored and reason jev_timeout", async () => {
    process.env.ETA_JEV_ENABLED = "1";
    process.env.ETA_JEV_TIMEOUT_MS = "10";
    const fetchImpl = vi.fn((_url: string, init: RequestInit) => {
      return new Promise((_resolve, reject) => {
        const signal = init.signal as AbortSignal;
        signal.addEventListener("abort", () => {
          const e = new Error("This operation was aborted");
          e.name = "AbortError";
          reject(e);
        });
      });
    });
    const client = createHttpJevClient({ fetchImpl: fetchImpl as unknown as typeof fetch });
    await expect(client.systemOne({ state: {}, questions: {} })).rejects.toThrow();
    expect(traceCalls).toHaveLength(1);
    const fin = traceCalls[0]!.finalise[0] as { status: string; error_message: string };
    expect(fin.status).toBe("errored");
    expect(fin.error_message).toBe("jev_timeout");
  });

  it("a caller-aborted request finalises with reason jev_aborted, distinct from a timeout", async () => {
    process.env.ETA_JEV_ENABLED = "1";
    // Pre-abort the caller's own signal BEFORE the call starts: the client's own code checks
    // `opts.signal.aborted` synchronously the moment it wires up the listener, so a signal that
    // is already aborted by then fires the internal abort deterministically — no race against
    // the `await openTrace(...)` the client does first (an abort() fired concurrently with that
    // await could land before the listener is attached and be missed, which is a test-harness
    // race, not a client bug).
    const controller = new AbortController();
    controller.abort();
    const fetchImpl = vi.fn((_url: string, init: RequestInit) => {
      return new Promise((_resolve, reject) => {
        const signal = init.signal as AbortSignal;
        if (signal.aborted) {
          const e = new Error("This operation was aborted");
          e.name = "AbortError";
          reject(e);
          return;
        }
        signal.addEventListener("abort", () => {
          const e = new Error("This operation was aborted");
          e.name = "AbortError";
          reject(e);
        });
      });
    });
    const client = createHttpJevClient({ fetchImpl: fetchImpl as unknown as typeof fetch });
    await expect(client.systemOne({ state: {}, questions: {} }, { signal: controller.signal })).rejects.toThrow();
    expect(traceCalls).toHaveLength(1);
    const fin = traceCalls[0]!.finalise[0] as { status: string; error_message: string };
    expect(fin.status).toBe("errored");
    expect(fin.error_message).toBe("jev_aborted");
  });
});

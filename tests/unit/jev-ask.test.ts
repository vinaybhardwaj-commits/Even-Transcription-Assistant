/**
 * lib/jev/ask.ts — J-CORE-1: the shared entry point. "No caller builds its own request" — fan-out
 * through the registry, confidence bands, cost/latency counters and jev_decision persistence, all
 * in one call. `getJevClient` is mocked (its own retry/timeout/metadata-logging is
 * tests/unit/jev-client.test.ts's job, not this file's); `sql` is mocked, no live DB.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

type Row = Record<string, unknown>;
const dbCalls: Array<{ text: string; values: unknown[] }> = [];
let dbResponder: () => unknown = () => [];
vi.mock("@/lib/db", () => {
  const sql = (strings: TemplateStringsArray, ...values: unknown[]) => {
    dbCalls.push({ text: strings.raw.join("?"), values });
    const result = dbResponder();
    if (result instanceof Error) throw result;
    return Promise.resolve(result);
  };
  return { sql };
});

type FakeResult = { model: string; answers: Row; usage: { input_tokens: number; output_tokens: number }; latency_ms: number };
let fakeResult: FakeResult;
const systemOneMock = vi.fn(async (_req: { state: unknown; questions: Row; model?: string }, _opts?: { signal?: AbortSignal }) => fakeResult);
vi.mock("@/lib/jev/client", () => ({ getJevClient: () => ({ systemOne: systemOneMock }) }));

import { askJev, DuplicateAskKeyError } from "@/lib/jev/ask";
import { _clearJevRegistryForTests, registerJevQuestion } from "@/lib/jev/registry";
import { _resetJevCountersForTests, jevCounterSnapshot } from "@/lib/jev/counters";
import type { JevChoiceQ, JevNoulQ } from "@/lib/jev/types";

beforeEach(() => {
  dbCalls.length = 0;
  dbResponder = () => [];
  systemOneMock.mockClear();
  _clearJevRegistryForTests();
  _resetJevCountersForTests();
  registerJevQuestion<[string]>("test_noul", "v1", (id): JevNoulQ => ({ type: "noul", instructions: `q for ${id}` }));
  registerJevQuestion<[string]>("test_choice", "v1", (id): JevChoiceQ => ({ type: "choice", instructions: `q for ${id}`, criteria: { a: "A", b: "B" } }));
});

describe("askJev — fan-out through the registry, no caller builds its own request", () => {
  it("resolves an ask via the registry and sends ONE systemOne call carrying the built question", async () => {
    fakeResult = { model: "jev-x", answers: { k1: { type: "noul", noul: 0.8 } }, usage: { input_tokens: 100, output_tokens: 10 }, latency_ms: 50 };
    const out = await askJev({ s: 1 }, [{ answerKey: "k1", subjectType: "window", subjectId: "w1", questionId: "test_noul", promptVersion: "v1", args: ["w1"] }], { persist: false });
    expect(systemOneMock).toHaveBeenCalledTimes(1);
    const req = systemOneMock.mock.calls[0]![0] as { questions: Row };
    expect(req.questions.k1).toEqual({ type: "noul", instructions: "q for w1" });
    expect(out.results.k1!.answer).toEqual({ type: "noul", noul: 0.8 });
    expect(out.results.k1!.confidence).toBeCloseTo(0.8);
    expect(out.results.k1!.band).toBe("caution"); // 0.8 is in [0.5, 0.9)
  });

  it("a batch of several asks becomes ONE systemOne call with every answerKey as a question", async () => {
    fakeResult = {
      model: "jev-x",
      answers: { a: { type: "noul", noul: 0.95 }, b: { type: "choice", choice: "a", probabilities: { a: 0.6, b: 0.4 }, confidence: 0.6 } },
      usage: { input_tokens: 200, output_tokens: 20 },
      latency_ms: 80,
    };
    const out = await askJev(
      {},
      [
        { answerKey: "a", subjectType: "window", subjectId: "w1", questionId: "test_noul", promptVersion: "v1", args: ["w1"] },
        { answerKey: "b", subjectType: "window", subjectId: "w1", questionId: "test_choice", promptVersion: "v1", args: ["w1"] },
      ],
      { persist: false },
    );
    expect(systemOneMock).toHaveBeenCalledTimes(1);
    const req = systemOneMock.mock.calls[0]![0] as { questions: Row };
    expect(Object.keys(req.questions).sort()).toEqual(["a", "b"]);
    expect(out.results.a!.band).toBe("act"); // 0.95
    expect(out.results.b!.band).toBe("caution"); // 0.6
  });

  it("a duplicate answerKey in one batch throws BEFORE any systemOne call", async () => {
    await expect(
      askJev({}, [
        { answerKey: "x", subjectType: "window", subjectId: "w1", questionId: "test_noul", promptVersion: "v1", args: ["w1"] },
        { answerKey: "x", subjectType: "window", subjectId: "w1", questionId: "test_choice", promptVersion: "v1", args: ["w1"] },
      ]),
    ).rejects.toBeInstanceOf(DuplicateAskKeyError);
    expect(systemOneMock).not.toHaveBeenCalled();
  });

  it("an unregistered question throws before any systemOne call, never a silently wrong question sent", async () => {
    await expect(
      askJev({}, [{ answerKey: "k1", subjectType: "window", subjectId: "w1", questionId: "nope", promptVersion: "v1" }]),
    ).rejects.toThrow(/no jev question registered/);
    expect(systemOneMock).not.toHaveBeenCalled();
  });

  it("an ask Jev did not answer is ABSENT from results, never a fabricated default", async () => {
    fakeResult = { model: "jev-x", answers: {}, usage: { input_tokens: 10, output_tokens: 1 }, latency_ms: 5 };
    const out = await askJev({}, [{ answerKey: "k1", subjectType: "window", subjectId: "w1", questionId: "test_noul", promptVersion: "v1", args: ["w1"] }], { persist: false });
    expect(out.results.k1).toBeUndefined();
  });

  it("an empty ask batch never calls systemOne at all", async () => {
    const out = await askJev({}, []);
    expect(systemOneMock).not.toHaveBeenCalled();
    expect(out).toEqual({ model: "", latencyMs: 0, results: {}, persisted: { ok: true, written: 0 } });
  });
});

describe("askJev — jev_decision persistence", () => {
  const twoAsks = [
    { answerKey: "a", subjectType: "window" as const, subjectId: "w1", questionId: "test_noul", promptVersion: "v1", args: ["w1"] },
    { answerKey: "b", subjectType: "window" as const, subjectId: "w2", questionId: "test_noul", promptVersion: "v1", args: ["w2"] },
  ];

  it("persists one row per answered ask, in one batched write", async () => {
    fakeResult = { model: "jev-m", answers: { a: { type: "noul", noul: 0.9 }, b: { type: "noul", noul: 0.2 } }, usage: { input_tokens: 100, output_tokens: 10 }, latency_ms: 40 };
    const out = await askJev({}, twoAsks);
    expect(out.persisted).toEqual({ ok: true, written: 2 });
    expect(dbCalls).toHaveLength(1);
  });

  it("input_tokens is apportioned evenly across the batch's rows, matching the counters' own math", async () => {
    fakeResult = { model: "jev-m", answers: { a: { type: "noul", noul: 0.9 }, b: { type: "noul", noul: 0.2 } }, usage: { input_tokens: 100, output_tokens: 10 }, latency_ms: 40 };
    await askJev({}, twoAsks);
    const payload = JSON.parse(dbCalls[0]!.values[0] as string) as Row[];
    expect(payload.map((p) => p.input_tokens)).toEqual([50, 50]);
  });

  it("persist:false skips the write entirely, but still returns the answers", async () => {
    fakeResult = { model: "jev-m", answers: { a: { type: "noul", noul: 0.9 } }, usage: { input_tokens: 10, output_tokens: 1 }, latency_ms: 5 };
    const out = await askJev({}, [twoAsks[0]!], { persist: false });
    expect(out.persisted).toEqual({ ok: true, written: 0 });
    expect(dbCalls).toHaveLength(0);
    expect(out.results.a!.answer).toEqual({ type: "noul", noul: 0.9 });
  });

  it("a persist FAILURE never throws and never takes the answer away — it is logged instead", async () => {
    dbResponder = () => new Error("db down");
    fakeResult = { model: "jev-m", answers: { a: { type: "noul", noul: 0.9 } }, usage: { input_tokens: 10, output_tokens: 1 }, latency_ms: 5 };
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const out = await askJev({}, [twoAsks[0]!]);
    expect(out.results.a!.answer).toEqual({ type: "noul", noul: 0.9 });
    expect(out.persisted.ok).toBe(false);
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });
});

describe("askJev — cost/latency counters", () => {
  it("records one batch call with every question_id, apportioned tokens, shared latency", async () => {
    fakeResult = { model: "jev-m", answers: { a: { type: "noul", noul: 0.9 }, b: { type: "noul", noul: 0.2 } }, usage: { input_tokens: 100, output_tokens: 10 }, latency_ms: 40 };
    await askJev(
      {},
      [
        { answerKey: "a", subjectType: "window", subjectId: "w1", questionId: "test_noul", promptVersion: "v1", args: ["w1"] },
        { answerKey: "b", subjectType: "window", subjectId: "w2", questionId: "test_noul", promptVersion: "v1", args: ["w2"] },
      ],
      { persist: false },
    );
    const snap = jevCounterSnapshot();
    expect(snap.calls).toBe(1);
    expect(snap.inputTokens).toBe(100);
    expect(snap.byQuestion.test_noul!.calls).toBe(2); // one systemOne call, but it answered test_noul twice
    expect(snap.byQuestion.test_noul!.inputTokens).toBeCloseTo(100);
  });
});

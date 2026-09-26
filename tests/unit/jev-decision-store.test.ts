/**
 * lib/jev/decision-store.ts — writes jev_decision (migration 116). Mocked `sql`, no live DB.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

type Row = Record<string, unknown>;
type Call = { text: string; values: unknown[] };
const calls: Call[] = [];
let responder: () => unknown = () => [];

vi.mock("@/lib/db", () => {
  const sql = (strings: TemplateStringsArray, ...values: unknown[]) => {
    const text = strings.raw.join("?").replace(/\s+/g, " ").trim();
    calls.push({ text, values });
    const result = responder();
    if (result instanceof Error) throw result;
    return Promise.resolve(result);
  };
  return { sql };
});

import { insertJevDecisions, newJevDecisionId } from "@/lib/jev/decision-store";

beforeEach(() => {
  calls.length = 0;
  responder = () => [];
});

describe("newJevDecisionId", () => {
  it("is prefixed jd_, matching the codebase's id-generator convention (lib/bench.ts)", () => {
    expect(newJevDecisionId()).toMatch(/^jd_[a-z0-9]{8}$/);
  });

  it("is different on every call", () => {
    expect(newJevDecisionId()).not.toBe(newJevDecisionId());
  });
});

describe("insertJevDecisions — the empty case never touches sql", () => {
  it("an empty array is {ok:true, written:0} with no SQL call at all", async () => {
    const r = await insertJevDecisions([]);
    expect(r).toEqual({ ok: true, written: 0 });
    expect(calls).toHaveLength(0);
  });
});

describe("insertJevDecisions — the SQL shape", () => {
  const row = {
    subjectType: "window" as const,
    subjectId: "w1",
    questionId: "q1",
    promptVersion: "v1",
    model: "jev-x",
    answer: { type: "noul", noul: 0.8 },
    probabilities: null,
    confidence: 0.8,
    latencyMs: 40,
    inputTokens: 100,
  };

  it("issues ONE batched INSERT via jsonb_to_recordset, with an ON CONFLICT upsert on the natural key", async () => {
    const r = await insertJevDecisions([row]);
    expect(r).toEqual({ ok: true, written: 1 });
    expect(calls).toHaveLength(1);
    const text = calls[0]!.text;
    expect(text).toMatch(/INSERT INTO jev_decision/i);
    expect(text).toMatch(/jsonb_to_recordset/i);
    expect(text).toMatch(/ON CONFLICT \(subject_type, subject_id, question_id, prompt_version\)/i);
    expect(text).not.toMatch(/\bDELETE\b/i);
  });

  it("the batch payload is ONE jsonb parameter, not N separate statements, for N rows", async () => {
    await insertJevDecisions([row, { ...row, subjectId: "w2" }, { ...row, subjectId: "w3" }]);
    expect(calls).toHaveLength(1); // still one round trip for three rows
    const payload = JSON.parse(calls[0]!.values[0] as string) as Row[];
    expect(payload).toHaveLength(3);
    expect(payload.map((p) => p.subject_id)).toEqual(["w1", "w2", "w3"]);
  });

  it("every row gets its own generated id, never sharing one across a batch", async () => {
    await insertJevDecisions([row, { ...row, subjectId: "w2" }]);
    const payload = JSON.parse(calls[0]!.values[0] as string) as Row[];
    expect(payload[0]!.id).not.toBe(payload[1]!.id);
    expect(payload[0]!.id).toMatch(/^jd_/);
  });

  it("maps camelCase fields to the table's snake_case columns exactly", async () => {
    await insertJevDecisions([row]);
    const payload = JSON.parse(calls[0]!.values[0] as string) as Row[];
    expect(payload[0]).toMatchObject({
      subject_type: "window",
      subject_id: "w1",
      question_id: "q1",
      prompt_version: "v1",
      model: "jev-x",
      answer: { type: "noul", noul: 0.8 },
      probabilities: null,
      confidence: 0.8,
      latency_ms: 40,
      input_tokens: 100,
    });
  });

  it("a DB error is caught and reported, never thrown to the caller", async () => {
    responder = () => new Error("connection reset");
    const r = await insertJevDecisions([row]);
    expect(r).toEqual({ ok: false, written: 0, error: "jev_error: Error" });
  });
});

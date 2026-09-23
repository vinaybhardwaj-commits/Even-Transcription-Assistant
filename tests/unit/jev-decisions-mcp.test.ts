/**
 * lib/mcp/tools/jev.ts's scribe_jev_decisions — J-CORE-2's read-only MCP view over jev_decision
 * (migration 116). Mocked `query` (lib/brain/db), matching this file's own existing convention
 * for scribe_jev_signals. No live database.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

type Row = Record<string, unknown>;
const calls: Array<{ text: string; values: unknown[] }> = [];
let responder: () => Row[] = () => [];
vi.mock("@/lib/brain/db", () => ({
  query: vi.fn(async (text: string, values: unknown[] = []) => {
    calls.push({ text, values });
    const rows = responder();
    return { rows, rowCount: rows.length };
  }),
}));
vi.mock("@/lib/jobs/submit", () => ({ submitJob: vi.fn() }));

import { JEV_TOOLS } from "@/lib/mcp/tools/jev";
import type { ToolContext } from "@/lib/mcp/registry";

const tool = () => {
  const t = JEV_TOOLS.find((x) => x.name === "scribe_jev_decisions");
  if (!t) throw new Error("scribe_jev_decisions not registered");
  return t;
};
const ctx: ToolContext = { origin: "https://preview.example", actor: "test-actor", scopes: new Set(["read"]) };

beforeEach(() => {
  calls.length = 0;
  responder = () => [];
});

describe("scribe_jev_decisions — read-only, no transcript or state text", () => {
  it("returns whatever jev_decision rows the query finds, unmodified", async () => {
    const row = {
      id: "jd_a1b2c3d4",
      subject_type: "window",
      subject_id: "w1",
      question_id: "phase",
      prompt_version: "jev-arm-d-v1",
      model: "jev-x",
      answer: { type: "choice", choice: "history" },
      probabilities: { history: 0.8, plan: 0.2 },
      confidence: 0.8,
      latency_ms: 40,
      input_tokens: 50,
      created_at: "2026-09-23T00:00:00.000Z",
    };
    responder = () => [row];
    const out = (await tool().handler({}, ctx)) as Row;
    expect(out.ok).toBe(true);
    expect(out.decisions).toEqual([row]);
  });

  it("filters are optional and ANDed — every filter given narrows the WHERE clause", async () => {
    await tool().handler({ subject_type: "window", subject_id: "w1", question_id: "phase", prompt_version: "v1" }, ctx);
    expect(calls).toHaveLength(1);
    const [text, values] = [calls[0]!.text, calls[0]!.values];
    expect(text).toMatch(/subject_type = \$1/);
    expect(text).toMatch(/subject_id = \$2/);
    expect(text).toMatch(/question_id = \$3/);
    expect(text).toMatch(/prompt_version = \$4/);
    expect(values.slice(0, 4)).toEqual(["window", "w1", "phase", "v1"]);
  });

  it("no filters at all still reads (every WHERE clause is satisfied by its own IS NULL branch)", async () => {
    const out = (await tool().handler({}, ctx)) as Row;
    expect(out.ok).toBe(true);
    const values = calls[0]!.values;
    expect(values.slice(0, 4)).toEqual([null, null, null, null]);
  });

  it("limit defaults to 100 and is capped at 500", async () => {
    await tool().handler({}, ctx);
    expect(calls[0]!.values[4]).toBe(100);
    calls.length = 0;
    await tool().handler({ limit: 5_000 }, ctx);
    expect(calls[0]!.values[4]).toBe(500);
  });

  it("the query never selects a text/state column — only the documented, structured columns", async () => {
    await tool().handler({}, ctx);
    const text = calls[0]!.text;
    expect(text).toMatch(/SELECT id, subject_type, subject_id, question_id, prompt_version, model, answer, probabilities,\s*confidence, latency_ms, input_tokens, created_at/);
    expect(text).not.toMatch(/\*/); // never SELECT *, which could pick up a column added later without review
  });

  it("a query failure degrades to an empty list rather than throwing (failSafe)", async () => {
    const { query } = await import("@/lib/brain/db");
    vi.mocked(query).mockRejectedValueOnce(new Error("db unreachable"));
    const out = (await tool().handler({}, ctx)) as Row;
    expect(out.degraded).toBe(true);
    expect(out.decisions).toEqual([]);
  });
});

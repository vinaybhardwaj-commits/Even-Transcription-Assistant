/**
 * W27.7(a) — no provider text can reach an error message, trace error, stored error or log line
 * on the Jev path. SENTINEL stands for a note sentence / transcript excerpt a provider quotes back.
 * The client is driven through its REAL http implementation with a fake fetch; the trace and sql
 * are fakes. Every observable error surface is scanned for the sentinel.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const SENTINEL = "Tab Zylorex 40mg twice daily for Ms Invented Patient";

const traceFinalise: unknown[] = [];
vi.mock("@/lib/llm-trace/log", () => ({
  openTrace: vi.fn(async () => ({ id: "t", event: () => {}, finalise: async (f: unknown) => void traceFinalise.push(f) })),
}));
let dbError: Error | null = null;
vi.mock("@/lib/db", () => ({
  sql: (..._a: unknown[]) => (dbError ? Promise.reject(dbError) : Promise.resolve([])),
}));

import { createHttpJevClient, _resetJevClientForTests } from "@/lib/jev/client";
import { JevBadResponseError, JevHttpError } from "@/lib/jev/types";
import { safeJevErrorMessage } from "@/lib/jev/safe-error";
import { insertJevDecisions } from "@/lib/jev/decision-store";

const OLD_ENV = { ...process.env };
beforeEach(() => {
  traceFinalise.length = 0;
  dbError = null;
  process.env = { ...OLD_ENV, ETA_JEV_ENABLED: "1", TYPESAFE_API_KEY: "k" };
  _resetJevClientForTests();
});

function surfaces(e: unknown): string {
  const err = e as Error;
  return [err.message, err.stack?.split("\n")[0], JSON.stringify(err), JSON.stringify({ ...err }), JSON.stringify(Object.keys(err)), String(err), JSON.stringify(traceFinalise)].join("\n");
}
const call = (fetchImpl: typeof fetch) => createHttpJevClient({ fetchImpl }).systemOne({ state: {}, questions: {} });

describe("no provider text in Jev errors", () => {
  it("HTTP 400 whose body echoes the input: message, JSON, own keys and trace are clean; .body stays readable", async () => {
    const body = JSON.stringify({ code: "invalid", detail: SENTINEL });
    const f = vi.fn(async () => new Response(body, { status: 400 }));
    const e = await call(f as unknown as typeof fetch).catch((x) => x);
    expect(e).toBeInstanceOf(JevHttpError);
    expect(surfaces(e)).not.toContain("Zylorex");
    expect((e as JevHttpError).body).toContain("Zylorex"); // explicit debugging access only
  });

  it("HTTP 400 with a non-JSON body echoing input is clean too", async () => {
    const f = vi.fn(async () => new Response(`bad: ${SENTINEL}`, { status: 400 }));
    const e = await call(f as unknown as typeof fetch).catch((x) => x);
    expect(surfaces(e)).not.toContain("Zylorex");
  });

  it("429 retries exhausted (raw body quoted back) is clean", async () => {
    const f = vi.fn(async () => new Response(SENTINEL, { status: 429 }));
    const p = call(f as unknown as typeof fetch).catch((x) => x);
    const e = await p;
    expect(surfaces(e)).not.toContain("Zylorex");
  }, 30_000);

  it("2xx with a body that is not JSON: no JSON.parse SyntaxError snippet escapes", async () => {
    const f = vi.fn(async () => new Response(`{"answers": ${SENTINEL}`, { status: 200 }));
    const e = await call(f as unknown as typeof fetch).catch((x) => x);
    expect(e).toBeInstanceOf(JevBadResponseError);
    expect(surfaces(e)).not.toContain("Zylorex");
    expect(JSON.stringify(traceFinalise)).toContain("valid JSON");
  });

  it("a fetch failure whose message quotes text is collapsed in the trace to its class name", async () => {
    const f = vi.fn(async () => {
      throw new Error(`upstream said: ${SENTINEL}`);
    });
    await call(f as unknown as typeof fetch).catch(() => {});
    expect(JSON.stringify(traceFinalise)).not.toContain("Zylorex");
    expect(JSON.stringify(traceFinalise)).toContain("jev_fetch_error: Error");
  });

  it("safeJevErrorMessage collapses unknown errors, odd names and non-errors", () => {
    expect(safeJevErrorMessage(new SyntaxError(`Unexpected token in ${SENTINEL}`))).toBe("jev_error: SyntaxError");
    const odd = new Error(SENTINEL);
    odd.name = SENTINEL;
    expect(safeJevErrorMessage(odd)).toBe("jev_error: Error");
    expect(safeJevErrorMessage(SENTINEL)).toBe("jev_error: non-error thrown");
  });

  it("a DB error that quotes a row value is not stored as the persist error", async () => {
    dbError = new Error(`invalid input ... Failing row contains (${SENTINEL})`);
    const out = await insertJevDecisions([
      { subjectType: "note_sentence", subjectId: "e:1", questionId: "q", promptVersion: "v1", model: "m", answer: { type: "noul", noul: 0.5 }, probabilities: null, confidence: 0.5, latencyMs: 1, inputTokens: 1 },
    ]);
    expect(out.ok).toBe(false);
    expect(JSON.stringify(out)).not.toContain("Zylorex");
  });
});

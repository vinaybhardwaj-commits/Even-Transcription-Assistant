/**
 * lib/jev/clinical-route.ts — U6 clinical-or-not routing (order JEV-U6-ROUTE, PLAN-v3 §A).
 * lib/jev/ask.ts is mocked as a black box (its own behaviour is tests/unit/jev-ask.test.ts's job).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

type Row = Record<string, unknown>;
const dbCalls: Array<{ text: string; values: unknown[] }> = [];
let dbResponder: () => Row[] = () => [];
vi.mock("@/lib/db", () => {
  const sql = (strings: TemplateStringsArray, ...values: unknown[]) => {
    dbCalls.push({ text: strings.raw.join("?"), values });
    return Promise.resolve(dbResponder());
  };
  return { sql };
});

// Explicit return type, not inferred from the literal below: an inferred type would make
// `results` an exact shape requiring `kind`, so a later `.mockResolvedValueOnce({..., results: {}})`
// (the "Jev did not answer" case) would fail typecheck even though it is semantically valid — the
// same mock-inference trap this session's Yoga gate has caught on jev-core and note-safety-shadow.
type MockAskJevOutcome = {
  model: string;
  latencyMs: number;
  results: Record<string, { answer: { type: string; choice: string; probabilities: Record<string, number>; confidence: number } }>;
  persisted: { ok: boolean; written: number };
};
const askJevMock = vi.fn(async (_state: Row, _asks: Row[]): Promise<MockAskJevOutcome> => ({
  model: "jev-x",
  latencyMs: 10,
  results: { kind: { answer: { type: "choice", choice: "clinical_consultation", probabilities: {}, confidence: 0.9 } } },
  persisted: { ok: true, written: 1 },
}));
vi.mock("@/lib/jev/ask", () => ({ askJev: (state: Row, asks: Row[]) => askJevMock(state, asks) }));

const ENV = "JEV_CLINICAL_ROUTE";
let savedEnv: string | undefined;

beforeEach(() => {
  dbCalls.length = 0;
  dbResponder = () => [];
  askJevMock.mockClear();
  savedEnv = process.env[ENV];
});
afterEach(() => {
  if (savedEnv === undefined) delete process.env[ENV];
  else process.env[ENV] = savedEnv;
});

import { runClinicalRouteAsync } from "@/lib/jev/clinical-route";
import { FlagValueError } from "@/lib/flags";
import { U6_OPTIONS } from "@/lib/jev/prompts/encounter-v1";

describe("runClinicalRouteAsync — flag off => zero Jev calls, zero DB reads", () => {
  it("flag unset: {ran:false}, zero-filled category counts, no sql, no askJev", async () => {
    delete process.env[ENV];
    const r = await runClinicalRouteAsync("rd_1");
    expect(r.ran).toBe(false);
    expect(r.windowsAsked).toBe(0);
    for (const o of U6_OPTIONS) expect(r.byCategory[o]).toBe(0);
    expect(dbCalls).toHaveLength(0);
    expect(askJevMock).not.toHaveBeenCalled();
  });

  it("JEV_CLINICAL_ROUTE=off / =false / =0 all disable it, despite being non-empty JS-truthy strings", async () => {
    for (const v of ["off", "false", "0"]) {
      process.env[ENV] = v;
      const r = await runClinicalRouteAsync("rd_1");
      expect(r.ran, `JEV_CLINICAL_ROUTE=${v}`).toBe(false);
    }
    expect(askJevMock).not.toHaveBeenCalled();
  });

  it("a malformed value THROWS FlagValueError rather than enabling it", async () => {
    process.env[ENV] = "maybe";
    await expect(runClinicalRouteAsync("rd_1")).rejects.toBeInstanceOf(FlagValueError);
    expect(askJevMock).not.toHaveBeenCalled();
  });
});

describe("runClinicalRouteAsync — flag on: reads bench_window + jev_window_text, asks U6 per window", () => {
  beforeEach(() => {
    process.env[ENV] = "on";
  });

  it("no windows: {ran:true, windowsTotal:0, windowsAsked:0}", async () => {
    dbResponder = () => [];
    const r = await runClinicalRouteAsync("rd_1");
    expect(r).toMatchObject({ ran: true, windowsTotal: 0, windowsAsked: 0 });
    expect(askJevMock).not.toHaveBeenCalled();
  });

  it("a window with no English text (J0 not_ready/empty/failed) is skipped, never asked", async () => {
    dbResponder = () => [{ id: "bw_1", english: null }];
    const r = await runClinicalRouteAsync("rd_1");
    expect(r).toMatchObject({ ran: true, windowsTotal: 1, windowsAsked: 0 });
    expect(askJevMock).not.toHaveBeenCalled();
  });

  it("one call per window with English text, state built from windowState, subjectType='window'", async () => {
    dbResponder = () => [
      { id: "bw_1", english: "the doctor examines the patient" },
      { id: "bw_2", english: "the nurse files the token number" },
    ];
    const r = await runClinicalRouteAsync("rd_1");
    expect(r.windowsAsked).toBe(2);
    expect(askJevMock).toHaveBeenCalledTimes(2);
    const [state1, asks1] = askJevMock.mock.calls[0]!;
    expect(state1).toEqual({ window_text: "the doctor examines the patient" });
    expect(asks1[0]).toMatchObject({ subjectType: "window", subjectId: "bw_1", questionId: "u6_kind", promptVersion: "u6-kind-v2" });
  });

  it("counts every window's chosen category, only from the closed U6 option set", async () => {
    askJevMock
      .mockResolvedValueOnce({ model: "jev-x", latencyMs: 5, results: { kind: { answer: { type: "choice", choice: "clinical_consultation", probabilities: {}, confidence: 0.9 } } }, persisted: { ok: true, written: 1 } })
      .mockResolvedValueOnce({ model: "jev-x", latencyMs: 5, results: { kind: { answer: { type: "choice", choice: "phone_call", probabilities: {}, confidence: 0.8 } } }, persisted: { ok: true, written: 1 } });
    dbResponder = () => [{ id: "bw_1", english: "a" }, { id: "bw_2", english: "b" }];
    const r = await runClinicalRouteAsync("rd_1");
    expect(r.byCategory.clinical_consultation).toBe(1);
    expect(r.byCategory.phone_call).toBe(1);
    expect(r.byCategory.staff_or_admin_talk).toBe(0);
  });

  it("a window Jev did not answer (no 'kind' result) counts nowhere — never a fabricated category", async () => {
    askJevMock.mockResolvedValueOnce({ model: "jev-x", latencyMs: 5, results: {}, persisted: { ok: true, written: 0 } });
    dbResponder = () => [{ id: "bw_1", english: "a" }];
    const r = await runClinicalRouteAsync("rd_1");
    expect(r.windowsAsked).toBe(1);
    for (const o of U6_OPTIONS) expect(r.byCategory[o]).toBe(0);
  });

  it("the SQL joins bench_window to jev_window_text and scopes by room_day_id, ordered by start_ms", async () => {
    dbResponder = () => [];
    await runClinicalRouteAsync("rd_scope");
    expect(dbCalls).toHaveLength(1);
    const text = dbCalls[0]!.text;
    expect(text).toMatch(/FROM bench_window/);
    expect(text).toMatch(/LEFT JOIN jev_window_text/);
    expect(text).toMatch(/room_day_id = \?/);
    expect(text).toMatch(/ORDER BY.*start_ms/);
    expect(dbCalls[0]!.values).toContain("rd_scope");
  });
});

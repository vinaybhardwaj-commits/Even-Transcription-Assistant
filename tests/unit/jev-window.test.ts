/**
 * Slice J2 (ETA-JEV-ARM-D §5.2) — jev-window: ask Jev per room window, persist the signals.
 *
 * Driven against a fake db and an injected Jev client: no network, no vendor, no real call. The
 * client mock THROWS if reached without an impl, so an accidental call fails loudly. Each test states,
 * in one clause, what would have to break for it to fail. The brief's four required cases — the
 * three-state distinction, a Jev outage, a flag-off run, and a re-run after each — are all here, plus
 * batching and the no-silent-truncation chunk-halving.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { JevStateTooLargeError, JevTransportError } from "@/lib/jev/types";

const DB = vi.hoisted(() => ({
  windows: [] as Array<{ id: string; session_id: string; start_ms: number; end_ms: number }>,
  jt: [] as Array<{ window_id: string; source: string; english: string | null }>,
  existing: [] as Array<{ window_id: string; status: string }>,
  written: {} as Record<string, { window_id: string; status: string; phase: string | null; p_start: number | null; p_clinical: number | null; model: string | null; prompt_version: string | null; error: string | null; input_tokens: number | null; batch_id: string | null }>,
  inserts: 0,
}));
const CLIENT = vi.hoisted(() => ({
  calls: [] as Array<{ state: unknown; questionCount: number; targets: string[] }>,
  impl: null as null | ((req: { state: unknown; questions: Record<string, { type: string }> }) => { model: string; answers: Record<string, unknown>; usage: { input_tokens: number; output_tokens: number }; latency_ms: number }),
}));

vi.mock("@/lib/db", () => ({
  sql: async (strings: TemplateStringsArray, ...v: unknown[]) => {
    const q = strings.join(" ").replace(/\s+/g, " ");
    if (q.includes("FROM bench_window WHERE room_day_id")) return DB.windows;
    if (q.includes("FROM bench_window WHERE id = ANY")) { const ids = v[0] as string[]; return DB.windows.filter((w) => ids.includes(w.id)); }
    if (q.includes("FROM jev_window_text WHERE room_day_id")) return DB.jt;
    if (q.includes("FROM jev_window_text WHERE window_id = ANY")) { const ids = v[0] as string[]; return DB.jt.filter((r) => ids.includes(r.window_id)); }
    if (q.includes("FROM jev_window_signal WHERE room_day_id")) return DB.existing;
    if (q.includes("INSERT INTO jev_window_signal")) {
      const [window_id, , , , , status, phase, , , p_start, , , p_clinical, model, prompt_version, error, input_tokens, batch_id] = v as unknown[];
      DB.written[window_id as string] = { window_id: window_id as string, status: status as string, phase: phase as string | null, p_start: p_start as number | null, p_clinical: p_clinical as number | null, model: model as string | null, prompt_version: prompt_version as string | null, error: error as string | null, input_tokens: input_tokens as number | null, batch_id: batch_id as string | null };
      DB.inserts += 1;
      return [];
    }
    return [];
  },
}));

vi.mock("@/lib/jev/client", () => ({
  ETA_JEV_ENABLED: "ETA_JEV_ENABLED",
  ETA_JEV_MOCK: "ETA_JEV_MOCK",
  getJevClient: () => ({
    systemOne: async (req: { state: unknown; questions: Record<string, { type: string }> }) => {
      const targets = [...new Set(Object.keys(req.questions).map((k) => k.split("__")[1]))];
      CLIENT.calls.push({ state: req.state, questionCount: Object.keys(req.questions).length, targets });
      if (!CLIENT.impl) throw new Error("CLIENT.impl not set — a real Jev call would have happened");
      return CLIENT.impl(req);
    },
  }),
}));

import { jevWindowKind } from "@/lib/jobs/kinds/jev-window";
import type { JobRow } from "@/lib/jobs/types";

function okAnswers(questions: Record<string, { type: string }>): Record<string, unknown> {
  const answers: Record<string, unknown> = {};
  for (const id of Object.keys(questions)) {
    if (questions[id].type === "choice") answers[id] = { type: "choice", choice: "history", probabilities: { history: 0.8, plan: 0.2 }, confidence: 0.8 };
    else answers[id] = { type: "noul", noul: id.startsWith("start__") ? 0.9 : id.startsWith("clinical__") ? 0.85 : 0.3 };
  }
  return answers;
}
const okImpl = (usage = { input_tokens: 100, output_tokens: 10 }) => (req: { questions: Record<string, { type: string }> }) => ({ model: "jev-x", answers: okAnswers(req.questions), usage, latency_ms: 5 });

const win = (id: string, i: number) => ({ id, session_id: "s1", start_ms: i * 30000, end_ms: (i + 1) * 30000 });
const jtRow = (id: string, source: string, english: string | null) => ({ window_id: id, source, english });

async function drive(args: Record<string, unknown>): Promise<Record<string, unknown> & { fail?: string }> {
  const parsed = jevWindowKind.parseArgs(args);
  let step = jevWindowKind.first;
  let progress: Record<string, unknown> = {};
  for (let g = 0; g < 1000; g += 1) {
    const out = await jevWindowKind.run({ job: {} as JobRow, step, args: parsed, progress });
    if (out.kind === "done") return out.result;
    if (out.kind === "fail") return { fail: out.error };
    step = out.step; progress = out.progress;
  }
  throw new Error("step machine did not terminate");
}

beforeEach(() => {
  DB.windows = []; DB.jt = []; DB.existing = []; DB.written = {}; DB.inserts = 0;
  CLIENT.calls = []; CLIENT.impl = null;
  delete process.env.ETA_JEV_ENABLED; delete process.env.ETA_JEV_MOCK;
  delete process.env.ETA_JEV_BATCH_WINDOWS; delete process.env.ETA_JEV_CONTEXT_WINDOWS;
});

describe("J2 — the four states are distinct on a row (absence never shares a value with failure)", () => {
  it("no-J0 → not_ready, empty-J0 → empty, answered → ok, non-terminal-J0 → not_ready", async () => {
    process.env.ETA_JEV_ENABLED = "1";
    CLIENT.impl = okImpl();
    DB.windows = [win("a", 0), win("b", 1), win("c", 2), win("d", 3)];
    // a: no jev_window_text row at all. b: usable source but empty text. c: translated with text. d: J0 still not_ready.
    DB.jt = [jtRow("b", "translated", "   "), jtRow("c", "translated", "there is a cough"), jtRow("d", "not_ready", null)];
    const r = await drive({ room_day_id: "rd1" });
    expect(DB.written.a.status).toBe("not_ready");
    expect(DB.written.a.error).toBe("j0_not_ready");
    expect(DB.written.b.status).toBe("empty");
    expect(DB.written.b.error).toBeNull();
    expect(DB.written.c).toMatchObject({ status: "ok", phase: "history", p_start: 0.9, p_clinical: 0.85, model: "jev-x", prompt_version: "jev-arm-d-v1" });
    expect(DB.written.d.status).toBe("not_ready");
    expect(r).toMatchObject({ ok: 1, empty: 1, not_ready: 2 });
    expect(new Set([DB.written.a.status, DB.written.b.status, DB.written.c.status]).size).toBe(3);
    // breaks if any two of the states collapse — e.g. an unanswered window written as ok, or empty vs not_ready merged.
  });
});

describe("J2 — a Jev outage is a retryable failure, never empty, and re-runs", () => {
  it("transport throw → status=failed(jev_transport); a later re-run (no force) succeeds", async () => {
    process.env.ETA_JEV_ENABLED = "1";
    DB.windows = [win("c", 0)];
    DB.jt = [jtRow("c", "translated", "there is a cough")];
    CLIENT.impl = () => { throw new JevTransportError("503 overloaded", { retryable: true, status: 503 }); };
    const r1 = await drive({ room_day_id: "rd1" });
    expect(r1).toMatchObject({ failed: 1, ok: 0 });
    expect(DB.written.c).toMatchObject({ status: "failed", error: "jev_transport", phase: null });
    // failed is non-terminal: a re-run without force re-asks. The row exists as 'failed' now.
    DB.existing = [{ window_id: "c", status: "failed" }];
    CLIENT.impl = okImpl();
    const r2 = await drive({ room_day_id: "rd1" });
    expect(r2).toMatchObject({ ok: 1, skipped: 0 });
    expect(DB.written.c.status).toBe("ok");
    // breaks if: an outage were stored as empty/ok, or a failed row were skipped on re-run.
  });
});

describe("J2 — flag-off writes a NON-terminal state and never calls Jev", () => {
  it("ETA_JEV_ENABLED unset → status=not_ready(jev_disabled), no Jev call; flag on → ok", async () => {
    DB.windows = [win("c", 0)];
    DB.jt = [jtRow("c", "translated", "there is a cough")];
    const r1 = await drive({ room_day_id: "rd1" });
    expect(r1).toMatchObject({ not_ready: 1, ok: 0 });
    expect(DB.written.c).toMatchObject({ status: "not_ready", error: "jev_disabled" });
    expect(CLIENT.calls.length).toBe(0);
    // flag on, re-run without force: not_ready is non-terminal → re-processed and answered.
    process.env.ETA_JEV_ENABLED = "1";
    CLIENT.impl = okImpl();
    DB.existing = [{ window_id: "c", status: "not_ready" }];
    const r2 = await drive({ room_day_id: "rd1" });
    expect(r2).toMatchObject({ ok: 1, skipped: 0 });
    expect(DB.written.c.status).toBe("ok");
    // breaks if: flag-off wrote a terminal state, or reached the vendor, or a not_ready row were skipped.
  });
});

describe("J2 — terminal windows are skipped on re-run unless forced", () => {
  it("an ok window is skipped without force, re-asked with force", async () => {
    process.env.ETA_JEV_ENABLED = "1";
    CLIENT.impl = okImpl();
    DB.windows = [win("c", 0)];
    DB.jt = [jtRow("c", "translated", "there is a cough")];
    DB.existing = [{ window_id: "c", status: "ok" }];
    const r1 = await drive({ room_day_id: "rd1" });
    expect(r1).toMatchObject({ skipped: 1, ok: 0 });
    expect(CLIENT.calls.length).toBe(0);
    expect(DB.inserts).toBe(0);
    const r2 = await drive({ room_day_id: "rd1", force: true });
    expect(r2).toMatchObject({ ok: 1, skipped: 0 });
    // breaks if: a terminal ok window is re-billed on a normal re-run, or force fails to re-ask.
  });

  it("UNKNOWN IS NOT ALLOWED: an unrecognised status reads as neither answered nor skipped", async () => {
    process.env.ETA_JEV_ENABLED = "1";
    CLIENT.impl = okImpl();
    DB.windows = [win("c", 0)];
    DB.jt = [jtRow("c", "translated", "there is a cough")];
    // A status this build does not know — written by a future slice, a hand edit, or a half-applied
    // migration. It must not be trusted as done, and it must not be assumed already answered.
    DB.existing = [{ window_id: "c", status: "weird_future_value" }];
    const r = await drive({ room_day_id: "rd1" });
    expect(r).toMatchObject({ skipped: 0, ok: 1 });
    expect(CLIENT.calls.length, "the window was actually re-asked, not assumed answered").toBe(1);
    expect(DB.written.c.status).toBe("ok");
    // breaks if: an unknown status is added to the terminal set (skipped for ever, never resolved) or
    // is treated as already-answered (never asked) — the same absence/failure collapse, one level up.
  });
});

describe("J2 — batching, context, and cost", () => {
  it("all askable windows get rows across batches, context is sent, cost is accumulated", async () => {
    process.env.ETA_JEV_ENABLED = "1";
    process.env.ETA_JEV_BATCH_WINDOWS = "2";
    process.env.ETA_JEV_CONTEXT_WINDOWS = "1";
    CLIENT.impl = okImpl({ input_tokens: 50, output_tokens: 5 });
    DB.windows = [win("w0", 0), win("w1", 1), win("w2", 2), win("w3", 3), win("w4", 4)];
    DB.jt = DB.windows.map((w) => jtRow(w.id, "translated", `text ${w.id}`));
    const r = await drive({ room_day_id: "rd1" });
    expect(Object.keys(DB.written).sort()).toEqual(["w0", "w1", "w2", "w3", "w4"]);
    expect(r).toMatchObject({ ok: 5 });
    expect(r.cost).toMatchObject({ calls: 3, questions: 25 }); // 5 windows × 5 questions; batches 2+2+1 = 3 calls
    expect((r.cost as { input_tokens: number }).input_tokens).toBe(150); // 3 calls × 50
    // a batch after the first carries a preceding context window (not the first batch, which has none)
    const withContext = CLIENT.calls.find((c) => (c.state as { context_windows: unknown[] }).context_windows.length > 0);
    expect(withContext, "a later batch sends preceding context").toBeTruthy();
    // breaks if: a window is dropped across batches, cost under/over-counts, or context is never sent.
  });

  it("NO SILENT TRUNCATION: an over-large batch is halved until it fits; every window still lands", async () => {
    process.env.ETA_JEV_ENABLED = "1";
    process.env.ETA_JEV_BATCH_WINDOWS = "4";
    DB.windows = [win("w0", 0), win("w1", 1), win("w2", 2), win("w3", 3)];
    DB.jt = DB.windows.map((w) => jtRow(w.id, "translated", `text ${w.id}`));
    // Reject any multi-target call; accept singletons — forces halving down to size 1.
    CLIENT.impl = (req) => {
      const targets = new Set(Object.keys(req.questions).map((k) => k.split("__")[1]));
      if (targets.size > 1) throw new JevStateTooLargeError(200000, 100000);
      return okImpl()(req);
    };
    const r = await drive({ room_day_id: "rd1" });
    expect(r).toMatchObject({ ok: 4, failed: 0 });
    expect(Object.values(DB.written).every((w) => w.status === "ok")).toBe(true);
    // breaks if: an over-large batch is truncated/sent-anyway, or windows are lost during halving.
  });

  it("a single window too large to send is recorded failed(jev_state_too_large), not truncated", async () => {
    process.env.ETA_JEV_ENABLED = "1";
    DB.windows = [win("w0", 0)];
    DB.jt = [jtRow("w0", "translated", "x")];
    CLIENT.impl = () => { throw new JevStateTooLargeError(200000, 100000); };
    const r = await drive({ room_day_id: "rd1" });
    expect(r).toMatchObject({ failed: 1, ok: 0 });
    expect(DB.written.w0).toMatchObject({ status: "failed", error: "jev_state_too_large" });
    // breaks if: an un-halvable window is silently dropped or its text truncated instead of recorded.
  });
});

describe("J2 — an unrecognised flag value fails the job loudly", () => {
  it("ETA_JEV_ENABLED=maybe fails rather than reading as off", async () => {
    process.env.ETA_JEV_ENABLED = "maybe";
    DB.windows = [win("c", 0)];
    DB.jt = [jtRow("c", "translated", "text")];
    const r = await drive({ room_day_id: "rd1" });
    expect(r.fail).toBeTruthy();
    expect(CLIENT.calls.length).toBe(0);
    // breaks if: a garbage flag value is silently treated as off (a window would wrongly land not_ready).
  });
});

/**
 * tests/unit/jev-window-job.test.ts — Slice J2 (ETA-JEV-ARM-D §5.2, §5.6f). The jev_window job
 * kind against a fake db and ETA_JEV_MOCK=1 (never the network — jev-client.test.ts already
 * proves ETA_JEV_ENABLED unset cannot reach fetch; this file proves the mock path end to end).
 *
 * Dry run required by the build contract: tests/fixtures/jev/day-clean.json → jev_window_signal
 * rows, through the mock.
 *
 * REFUTER F6 (19 Sep): tests appended below the original suite for (a) no-English windows keeping
 * their place in the batch as null-text placeholders, (b) per-row input_tokens being the batch
 * total split across target windows, and (c) the in-flight semaphore.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

type WindowRow = { id: string; session_id: string; start_ms: number; end_ms: number };
type TextRow = { window_id: string; english: string | null };
type SignalRow = Record<string, unknown>;

const DB = vi.hoisted(() => ({
  windows: [] as WindowRow[],
  textRows: [] as TextRow[],
  existingSignals: [] as Array<{ window_id: string }>,
  written: {} as Record<string, SignalRow>,
  writes: 0,
}));

// F6(a)/(b): capture the request `state` sent to the Jev client so batch-shape tests can inspect
// window numbering and placeholder framing without reaching into the mock module's internals.
const captured = vi.hoisted(() => [] as Array<{ state: unknown }>);

vi.mock("@/lib/db", () => ({
  sql: async (strings: TemplateStringsArray, ...v: unknown[]) => {
    const q = strings.join(" ").replace(/\s+/g, " ");
    if (q.includes("FROM bench_window WHERE room_day_id")) return DB.windows;
    if (q.includes("FROM jev_window_text WHERE room_day_id")) return DB.textRows;
    if (q.includes("FROM jev_window_signal WHERE room_day_id")) return DB.existingSignals;
    if (q.includes("FROM jev_window_text WHERE window_id = ANY")) {
      const ids = v[0] as string[];
      return DB.textRows.filter((r) => ids.includes(r.window_id));
    }
    if (q.includes("INSERT INTO jev_window_signal")) {
      // The kind's own "no english" skip path inlines phase/phase_confidence/p_*/model/input_tokens/batch_id
      // as SQL literals rather than ${} params (see jev-window.ts), so the params array is shorter there
      // than on the normal ask-path insert. Detect which shape this call is from the literal SQL text.
      if (q.includes("'non_clinical'") && q.includes("'skip'")) {
        const [window_id, room_day_id, session_id, start_ms, end_ms, phase_probs, prompt_version] = v as unknown[];
        DB.written[window_id as string] = {
          window_id, room_day_id, session_id, start_ms, end_ms,
          phase: "non_clinical", phase_probs, phase_confidence: 1,
          p_start: 0, p_end: 0, p_clinician: 0, p_clinical: 0,
          model: "none", prompt_version, input_tokens: 0, batch_id: "skip",
        };
      } else {
        const [window_id, room_day_id, session_id, start_ms, end_ms, phase, phase_probs, phase_confidence, p_start, p_end, p_clinician, p_clinical, model, prompt_version, input_tokens, batch_id] = v as unknown[];
        DB.written[window_id as string] = { window_id, room_day_id, session_id, start_ms, end_ms, phase, phase_probs, phase_confidence, p_start, p_end, p_clinician, p_clinical, model, prompt_version, input_tokens, batch_id };
      }
      DB.writes += 1;
      return [];
    }
    return [];
  },
}));

vi.mock("@/lib/jev/client", async () => {
  const actual = await vi.importActual<typeof import("@/lib/jev/client")>("@/lib/jev/client");
  return {
    ...actual,
    getJevClient: () => {
      const real = actual.getJevClient();
      return {
        systemOne: async (req: { state: unknown; questions: unknown }, opts?: unknown) => {
          captured.push({ state: req.state });
          return real.systemOne(req as never, opts as never);
        },
      };
    },
  };
});

import { jevWindowKind, JEV_WINDOW_KIND, acquireJevSlot, _jevInFlightForTests, _resetJevInFlightForTests } from "@/lib/jobs/kinds/jev-window";
import { setMockJevAnswers, clearMockJevAnswers } from "@/lib/jev/mock";
import { qid } from "@/lib/jev/prompts/arm-d-v1";
import type { JobRow } from "@/lib/jobs/types";

const FIXTURE = JSON.parse(readFileSync(resolve(__dirname, "../fixtures/jev/day-clean.json"), "utf-8")) as {
  room_day_id: string;
  session_id: string;
  windows: Array<{ id: string; start_ms: number; end_ms: number; english: string; phase: string; phase_confidence: number; p_start: number; p_end: number; p_clinician: number; p_clinical: number }>;
};

async function drive(args: Record<string, unknown>): Promise<{ done?: Record<string, unknown>; fail?: string }> {
  const parsed = jevWindowKind.parseArgs(args);
  let step = jevWindowKind.first;
  let progress: Record<string, unknown> = {};
  for (let guard = 0; guard < 100; guard += 1) {
    const out = await jevWindowKind.run({ job: {} as JobRow, step, args: parsed, progress });
    if (out.kind === "done") return { done: out.result };
    if (out.kind === "fail") return { fail: out.error };
    step = out.step;
    progress = out.progress;
  }
  throw new Error("step machine did not terminate");
}

function seedFromFixture(): void {
  DB.windows = FIXTURE.windows.map((w) => ({ id: w.id, session_id: FIXTURE.session_id, start_ms: w.start_ms, end_ms: w.end_ms }));
  DB.textRows = FIXTURE.windows.map((w) => ({ window_id: w.id, english: w.english }));
  const answers: Record<string, ReturnType<typeof mkNoul>> = {};
  for (const w of FIXTURE.windows) {
    answers[qid.phase(w.id)] = { type: "choice", choice: w.phase, probabilities: { [w.phase]: w.phase_confidence }, confidence: w.phase_confidence } as never;
    answers[qid.start(w.id)] = { type: "noul", noul: w.p_start };
    answers[qid.end(w.id)] = { type: "noul", noul: w.p_end };
    answers[qid.clinician(w.id)] = { type: "noul", noul: w.p_clinician };
    answers[qid.clinical(w.id)] = { type: "noul", noul: w.p_clinical };
  }
  setMockJevAnswers(answers as never);
}
function mkNoul(n: number) {
  return { type: "noul" as const, noul: n };
}

beforeEach(() => {
  DB.windows = [];
  DB.textRows = [];
  DB.existingSignals = [];
  DB.written = {};
  DB.writes = 0;
  captured.length = 0;
  clearMockJevAnswers();
  _resetJevInFlightForTests();
  process.env.ETA_JEV_MOCK = "1";
  delete process.env.ETA_JEV_ENABLED;
});

describe("J2 — jev_window kind registration", () => {
  it("is named jev_window and scoped invoke", () => {
    expect(jevWindowKind.name).toBe(JEV_WINDOW_KIND);
    expect(JEV_WINDOW_KIND).toBe("jev_window");
    expect(jevWindowKind.scope).toBe("invoke");
  });
  it("refuses a missing room_day_id at submit", () => {
    expect(() => jevWindowKind.parseArgs({})).toThrow();
  });
});

describe("J2 — jev_english_missing", () => {
  it("fails the job when jev_window_text has no rows for the room-day", async () => {
    DB.windows = [{ id: "w1", session_id: "s1", start_ms: 0, end_ms: 30000 }];
    DB.textRows = [];
    const r = await drive({ room_day_id: "rd1" });
    expect(r.fail).toBe("jev_english_missing");
  });
});

describe("J2 — day-clean.json dry run through the mock", () => {
  it("produces one jev_window_signal row per window, matching the fixture's phase/p_* values", async () => {
    seedFromFixture();
    const r = await drive({ room_day_id: FIXTURE.room_day_id });
    expect(r.done).toMatchObject({ windows_total: FIXTURE.windows.length, windows_asked: FIXTURE.windows.length, windows_skipped: 0 });
    expect(DB.writes).toBe(FIXTURE.windows.length);
    for (const w of FIXTURE.windows) {
      expect(DB.written[w.id]).toMatchObject({
        room_day_id: FIXTURE.room_day_id,
        phase: w.phase,
        p_start: w.p_start,
        p_end: w.p_end,
        p_clinician: w.p_clinician,
        p_clinical: w.p_clinical,
        prompt_version: "jev-arm-d-v1",
      });
    }
  });

  it("force re-runs windows already signalled; without force they are skipped", async () => {
    seedFromFixture();
    DB.existingSignals = FIXTURE.windows.map((w) => ({ window_id: w.id }));
    const r1 = await drive({ room_day_id: FIXTURE.room_day_id });
    expect(r1.done).toMatchObject({ windows_asked: 0, windows_skipped: FIXTURE.windows.length });
    expect(DB.writes).toBe(0);

    const r2 = await drive({ room_day_id: FIXTURE.room_day_id, force: true });
    expect(r2.done).toMatchObject({ windows_asked: FIXTURE.windows.length });
    expect(DB.writes).toBe(FIXTURE.windows.length);
  });
});

describe("J2 — a window with no english text is skipped without a Jev call", () => {
  it("writes phase='non_clinical', all p_*=0, prompt_version='skipped:no_english'", async () => {
    DB.windows = [{ id: "w1", session_id: "s1", start_ms: 0, end_ms: 30000 }];
    DB.textRows = [{ window_id: "w1", english: null }];
    const r = await drive({ room_day_id: "rd1" });
    expect(r.done).toMatchObject({ windows_asked: 0, windows_skipped: 1 });
    expect(DB.written.w1).toMatchObject({ phase: "non_clinical", p_start: 0, p_end: 0, p_clinician: 0, p_clinical: 0, prompt_version: "skipped:no_english" });
  });
});

// =====================================================================================
// REFUTER F6 (19 Sep)
// =====================================================================================
function seedThreeWindowsOneNoEnglish(): void {
  DB.windows = [
    { id: "w1", session_id: "s1", start_ms: 0, end_ms: 30000 },
    { id: "w2", session_id: "s1", start_ms: 30000, end_ms: 60000 },
    { id: "w3", session_id: "s1", start_ms: 60000, end_ms: 90000 },
  ];
  DB.textRows = [
    { window_id: "w1", english: "hello doctor" },
    { window_id: "w2", english: null }, // no English text — placeholder
    { window_id: "w3", english: "how are you feeling" },
  ];
  const mkAns = (id: string) => ({
    [qid.phase(id)]: { type: "choice", choice: "history", probabilities: { history: 0.9 }, confidence: 0.9 },
    [qid.start(id)]: { type: "noul", noul: 0.1 },
    [qid.end(id)]: { type: "noul", noul: 0.1 },
    [qid.clinician(id)]: { type: "noul", noul: 0.5 },
    [qid.clinical(id)]: { type: "noul", noul: 0.7 },
  });
  setMockJevAnswers({ ...mkAns("w1"), ...mkAns("w3") } as never);
}

describe("F6(a) — a no-English window keeps its place in the batch as a null-text placeholder", () => {
  it("state.windows is [w1, w2(null), w3] — consecutive, not closed over the gap", async () => {
    seedThreeWindowsOneNoEnglish();
    const r = await drive({ room_day_id: "rd1" });
    expect(r.done).toMatchObject({ windows_asked: 2, windows_skipped: 1 });
    expect(captured).toHaveLength(1);
    const sentWindows = (captured[0]!.state as { windows: Array<{ id: string; text: string | null; note?: string }> }).windows;
    expect(sentWindows.map((w) => w.id)).toEqual(["w1", "w2", "w3"]);
    expect(sentWindows[1]).toMatchObject({ id: "w2", text: null, note: "no English text" });
    expect(sentWindows[0]!.text).not.toBeNull();
    expect(sentWindows[2]!.text).not.toBeNull();
    // w2's own row is still persisted (unchanged, in `collect`, immediately) — it just never
    // becomes a Jev target and never gets a second, ask-path row.
    expect(DB.written.w2).toMatchObject({ prompt_version: "skipped:no_english" });
  });
});

describe("F6(b) — per-row input_tokens is the batch total split across target windows", () => {
  it("w1 and w3 (the two targets) get equal shares; the job summary keeps the raw batch total once", async () => {
    seedThreeWindowsOneNoEnglish();
    const r = await drive({ room_day_id: "rd1" });
    const t1 = DB.written.w1!.input_tokens as number;
    const t3 = DB.written.w3!.input_tokens as number;
    expect(t1).toBe(t3);
    expect(r.done!.input_tokens).toBe(t1 * 2);
    // w2 was persisted in `collect` as the no-English skip row (batch_id 'skip'), never as an
    // ask-path target row (batch_id `${roomDayId}:0`) with a real per-window token share.
    expect(DB.written.w2).toMatchObject({ batch_id: "skip" });
  });
});

describe("F6(c) — the in-flight semaphore caps concurrent Jev calls", () => {
  it("at most 2 concurrent calls run for the same room-day (default per-job cap)", async () => {
    let concurrent = 0;
    let maxConcurrent = 0;
    async function task(jobKey: string): Promise<void> {
      const release = await acquireJevSlot(jobKey);
      concurrent += 1;
      maxConcurrent = Math.max(maxConcurrent, concurrent);
      await new Promise((r) => setTimeout(r, 15));
      concurrent -= 1;
      release();
    }
    await Promise.all([task("rd1"), task("rd1"), task("rd1"), task("rd1"), task("rd1")]);
    expect(maxConcurrent).toBeLessThanOrEqual(2);
    expect(_jevInFlightForTests().module).toBe(0);
  });

  it("at most 4 concurrent calls run across different room-days (module-wide cap)", async () => {
    let concurrent = 0;
    let maxConcurrent = 0;
    async function task(jobKey: string): Promise<void> {
      const release = await acquireJevSlot(jobKey);
      concurrent += 1;
      maxConcurrent = Math.max(maxConcurrent, concurrent);
      await new Promise((r) => setTimeout(r, 15));
      concurrent -= 1;
      release();
    }
    await Promise.all(["rd1", "rd2", "rd3", "rd4", "rd5", "rd6"].map((k) => task(k)));
    expect(maxConcurrent).toBeLessThanOrEqual(4);
  });
});

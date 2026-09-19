/**
 * tests/unit/jev-window-job.test.ts — Slice J2 (ETA-JEV-ARM-D §5.2, §5.6f). The jev_window job
 * kind against a fake db and ETA_JEV_MOCK=1 (never the network — jev-client.test.ts already
 * proves ETA_JEV_ENABLED unset cannot reach fetch; this file proves the mock path end to end).
 *
 * Dry run required by the build contract: tests/fixtures/jev/day-clean.json → jev_window_signal
 * rows, through the mock.
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

import { jevWindowKind, JEV_WINDOW_KIND } from "@/lib/jobs/kinds/jev-window";
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
  clearMockJevAnswers();
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

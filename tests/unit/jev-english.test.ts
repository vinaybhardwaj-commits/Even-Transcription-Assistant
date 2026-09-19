/**
 * Slice J0 (ETA-JEV-ARM-D §3A) — jev-english: the English text Arm D reads.
 *
 * PURE where it can be (the three-way agreement rule), and the step machine driven against a fake
 * database and a fake qwen. THE MODEL IS NEVER LOADED: the qwen mock THROWS if it is ever reached
 * without a test-supplied impl, so an accidental translation call fails the test loudly. The
 * flag-unset test proves qwen is not called at all.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { isNativeEnglish, languageMix, classifyWindow } from "@/lib/jev/english";

// ── the three-way agreement rule, PURE ───────────────────────────────────────────────────────────
describe("J0 — isNativeEnglish: all three signals must agree to skip translation", () => {
  const en = (mix: Record<string, number>, full = "english", sarvam = "en") =>
    ({ full_window_language: full, sarvam_language: sarvam, language_timeline: { language_mix: mix } });

  it("the real code-mixed shape {en:2,hi:1,und:1} MUST translate (hi present)", () => {
    expect(isNativeEnglish(en({ en: 2, hi: 1, und: 1 }))).toBe(false);
  });
  it("en-and-und-only is native English (und is silence, not a language)", () => {
    expect(isNativeEnglish(en({ en: 3, und: 1 }))).toBe(true);
    expect(isNativeEnglish(en({ en: 1 }))).toBe(true);
  });
  it("any non-en/und key forces translation", () => {
    expect(isNativeEnglish(en({ en: 5, mr: 1 }))).toBe(false);
    expect(isNativeEnglish(en({ hi: 1 }))).toBe(false);
  });
  it("full_window_language must be english", () => {
    expect(isNativeEnglish(en({ en: 2 }, "hindi"))).toBe(false);
    expect(isNativeEnglish(en({ en: 2 }, "english"))).toBe(true);
  });
  it("sarvam_language must start with en", () => {
    expect(isNativeEnglish(en({ en: 2 }, "english", "hi"))).toBe(false);
    expect(isNativeEnglish(en({ en: 2 }, "english", "en-IN"))).toBe(true);
  });
  it("a missing or empty mix is NOT agreement (absent metric never reads as English)", () => {
    expect(isNativeEnglish({ full_window_language: "english", sarvam_language: "en" })).toBe(false);
    expect(isNativeEnglish(en({}))).toBe(false);
    expect(isNativeEnglish(null)).toBe(false);
    expect(isNativeEnglish(undefined)).toBe(false);
  });
  it("languageMix digs out the nested map and ignores non-number values", () => {
    expect(languageMix(en({ en: 2, hi: 1 }))).toEqual({ en: 2, hi: 1 });
    expect(languageMix({ language_timeline: { language_mix: { en: "x" } } })).toEqual({});
    expect(languageMix({})).toBeNull();
  });
});

describe("J0 — classifyWindow: run_english > native_en > needs-translation", () => {
  const base = { window_id: "w1", room_day_id: "rd1", metrics: { full_window_language: "english", sarvam_language: "en", language_timeline: { language_mix: { en: 1 } } } };
  it("transcript_english wins outright", () => {
    const c = classifyWindow({ ...base, transcript_english: "already english", transcript_original: "kuch bhi", metrics: null });
    expect("done" in c && c.done.source).toBe("run_english");
  });
  it("native_en stores the original when the three signals agree", () => {
    const c = classifyWindow({ ...base, transcript_english: null, transcript_original: "hello doctor" });
    expect("done" in c && c.done).toMatchObject({ source: "native_en", english: "hello doctor" });
  });
  it("code-mix needs translation and carries the original", () => {
    const c = classifyWindow({ window_id: "w1", room_day_id: "rd1", transcript_english: null, transcript_original: "namaste", metrics: { full_window_language: "hindi", sarvam_language: "hi", language_timeline: { language_mix: { hi: 2, en: 1 } } } });
    expect("needsTranslation" in c && c.original).toBe("namaste");
  });
});

// ── the kind, against a fake db + fake qwen ──────────────────────────────────────────────────────
const DB = vi.hoisted(() => ({
  windows: [] as Array<{ id: string }>,
  runs: {} as Record<string, { transcript_english: string | null; transcript_original: string | null; metrics_json: unknown; detected_language: string | null }>,
  existing: [] as string[],
  written: {} as Record<string, { window_id: string; room_day_id: string; english: string | null; source: string; char_count: number; model: string | null; latency_ms: number | null }>,
  writes: 0,
}));
const QWEN = vi.hoisted(() => ({ calls: 0, impl: null as null | (() => { json: { english?: string }; raw: string; latency_ms: number; model: string }) }));

vi.mock("@/lib/db", () => ({
  sql: async (strings: TemplateStringsArray, ...v: unknown[]) => {
    const q = strings.join(" ").replace(/\s+/g, " ");
    if (q.includes("FROM bench_window WHERE room_day_id")) return DB.windows;
    if (q.includes("FROM jev_window_text WHERE room_day_id")) return DB.existing.map((id) => ({ window_id: id }));
    if (q.includes("FROM transcription_run")) { const id = v[0] as string; return DB.runs[id] ? [DB.runs[id]] : []; }
    if (q.includes("INSERT INTO jev_window_text")) {
      const [window_id, room_day_id, english, source, char_count, model, latency_ms] = v as [string, string, string | null, string, number, string | null, number | null];
      DB.written[window_id] = { window_id, room_day_id, english, source, char_count, model, latency_ms };
      DB.writes += 1;
      return [];
    }
    return [];
  },
}));

vi.mock("@/lib/qwen", () => ({
  QWEN_MODEL: "qwen2.5:14b",
  qwenJson: async () => {
    QWEN.calls += 1;
    if (!QWEN.impl) throw new Error("MODEL LOADED IN TEST — qwenJson called with no impl; this must never happen");
    return QWEN.impl();
  },
}));

import { jevEnglishKind, JEV_ENGLISH_KIND, JEV_TRANSLATE_BATCH } from "@/lib/jobs/kinds/jev-english";
import type { JobRow } from "@/lib/jobs/types";

async function drive(args: Record<string, unknown>): Promise<{ done?: Record<string, unknown>; fail?: string }> {
  const parsed = jevEnglishKind.parseArgs(args);
  let step = jevEnglishKind.first;
  let progress: Record<string, unknown> = {};
  for (let guard = 0; guard < 100; guard += 1) {
    const out = await jevEnglishKind.run({ job: {} as JobRow, step, args: parsed, progress });
    if (out.kind === "done") return { done: out.result };
    if (out.kind === "fail") return { fail: out.error };
    step = out.step;
    progress = out.progress;
  }
  throw new Error("step machine did not terminate");
}

const ENGLISH_METRICS = { full_window_language: "english", sarvam_language: "en", language_timeline: { language_mix: { en: 2, und: 1 } } };
const MIXED_METRICS = { full_window_language: "hindi", sarvam_language: "hi", language_timeline: { language_mix: { hi: 2, en: 1, und: 1 } } };

beforeEach(() => {
  DB.windows = []; DB.runs = {}; DB.existing = []; DB.written = {}; DB.writes = 0;
  QWEN.calls = 0; QWEN.impl = null;
  delete process.env.ETA_JEV_TRANSLATE_ENABLED;
});
afterEach(() => { delete process.env.ETA_JEV_TRANSLATE_ENABLED; });

describe("J0 — the kind registers and validates its args", () => {
  it("is named jev_english (codebase convention) and scoped invoke", () => {
    expect(jevEnglishKind.name).toBe(JEV_ENGLISH_KIND);
    expect(JEV_ENGLISH_KIND).toBe("jev_english");
    expect(jevEnglishKind.scope).toBe("invoke");
  });
  it("refuses a missing room_day_id at submit", () => {
    expect(() => jevEnglishKind.parseArgs({})).toThrow();
    expect(() => jevEnglishKind.parseArgs({ room_day_id: "  " })).toThrow();
    expect(() => jevEnglishKind.parseArgs({ room_day_id: "rd1", force: "yes" })).toThrow();
  });
});

describe("J0 — every branch writes a row, and the model is never loaded unless translation is enabled", () => {
  it("run_english: the existing English is stored, no model touched", async () => {
    DB.windows = [{ id: "w1" }];
    DB.runs.w1 = { transcript_english: "the patient reports a cough", transcript_original: "x", metrics_json: null, detected_language: null };
    const r = await drive({ room_day_id: "rd1" });
    expect(r.done).toMatchObject({ run_english: 1 });
    expect(DB.written.w1).toMatchObject({ source: "run_english", english: "the patient reports a cough", model: null });
    expect(QWEN.calls).toBe(0);
  });

  it("native_en: an already-English window stores its original, no model touched", async () => {
    DB.windows = [{ id: "w1" }];
    DB.runs.w1 = { transcript_english: null, transcript_original: "good morning, sit down", metrics_json: ENGLISH_METRICS, detected_language: null };
    const r = await drive({ room_day_id: "rd1" });
    expect(r.done).toMatchObject({ native_en: 1 });
    expect(DB.written.w1).toMatchObject({ source: "native_en", english: "good morning, sit down" });
    expect(QWEN.calls).toBe(0);
  });

  it("FLAG UNSET: a code-mixed window lands source=empty and NO model is loaded", async () => {
    DB.windows = [{ id: "w1" }];
    DB.runs.w1 = { transcript_english: null, transcript_original: "bahut din se khaansi hai", metrics_json: MIXED_METRICS, detected_language: "hi" };
    const r = await drive({ room_day_id: "rd1" });
    expect(r.done).toMatchObject({ empty: 1, translated: 0 });
    expect(DB.written.w1).toMatchObject({ source: "empty", english: null, char_count: 0, model: null });
    expect(QWEN.calls, "the 11.5 GB model must not be loaded when translation is gated off").toBe(0);
  });

  it("FLAG ON: a code-mixed window is translated locally, source=translated with the model recorded", async () => {
    process.env.ETA_JEV_TRANSLATE_ENABLED = "1";
    QWEN.impl = () => ({ json: { english: "there has been a cough for many days" }, raw: "", latency_ms: 42, model: "qwen2.5:14b" });
    DB.windows = [{ id: "w1" }];
    DB.runs.w1 = { transcript_english: null, transcript_original: "bahut din se khaansi hai", metrics_json: MIXED_METRICS, detected_language: "hi" };
    const r = await drive({ room_day_id: "rd1" });
    expect(r.done).toMatchObject({ translated: 1 });
    expect(DB.written.w1).toMatchObject({ source: "translated", english: "there has been a cough for many days", model: "qwen2.5:14b", latency_ms: 42 });
    expect(QWEN.calls).toBe(1);
  });

  it("FLAG ON but an EMPTY translation is source=empty, not an exception", async () => {
    process.env.ETA_JEV_TRANSLATE_ENABLED = "1";
    QWEN.impl = () => ({ json: { english: "   " }, raw: "", latency_ms: 9, model: "qwen2.5:14b" });
    DB.windows = [{ id: "w1" }];
    DB.runs.w1 = { transcript_english: null, transcript_original: "…", metrics_json: MIXED_METRICS, detected_language: "hi" };
    const r = await drive({ room_day_id: "rd1" });
    expect(r.done).toMatchObject({ empty: 1, translated: 0 });
    expect(DB.written.w1).toMatchObject({ source: "empty", english: null });
  });

  it("a window with no transcription_run at all is an evidenced empty (D-11), model untouched", async () => {
    process.env.ETA_JEV_TRANSLATE_ENABLED = "1"; // even with translation on, there is nothing to translate
    DB.windows = [{ id: "w1" }];
    const r = await drive({ room_day_id: "rd1" });
    expect(DB.written.w1).toMatchObject({ source: "empty", english: null });
    expect(QWEN.calls).toBe(0);
  });

  it("a row is ALWAYS written — one per window, across a mix of branches", async () => {
    process.env.ETA_JEV_TRANSLATE_ENABLED = "1";
    QWEN.impl = () => ({ json: { english: "translated" }, raw: "", latency_ms: 5, model: "qwen2.5:14b" });
    DB.windows = [{ id: "wA" }, { id: "wB" }, { id: "wC" }, { id: "wD" }];
    DB.runs.wA = { transcript_english: "eng", transcript_original: null, metrics_json: null, detected_language: null };
    DB.runs.wB = { transcript_english: null, transcript_original: "english native", metrics_json: ENGLISH_METRICS, detected_language: null };
    DB.runs.wC = { transcript_english: null, transcript_original: "hindi text", metrics_json: MIXED_METRICS, detected_language: "hi" };
    // wD has no run row → empty
    const r = await drive({ room_day_id: "rd1" });
    expect(Object.keys(DB.written).sort()).toEqual(["wA", "wB", "wC", "wD"]);
    expect(r.done).toMatchObject({ run_english: 1, native_en: 1, translated: 1, empty: 1, windows: 4 });
  });
});

describe("J0 — force re-runs; without it, existing windows are skipped", () => {
  it("without force, a window already in jev_window_text is skipped (no re-translation)", async () => {
    process.env.ETA_JEV_TRANSLATE_ENABLED = "1";
    QWEN.impl = () => ({ json: { english: "x" }, raw: "", latency_ms: 1, model: "qwen2.5:14b" });
    DB.windows = [{ id: "w1" }];
    DB.runs.w1 = { transcript_english: null, transcript_original: "hindi", metrics_json: MIXED_METRICS, detected_language: "hi" };
    DB.existing = ["w1"];
    const r = await drive({ room_day_id: "rd1" });
    expect(r.done).toMatchObject({ skipped: 1, translated: 0 });
    expect(DB.writes).toBe(0);
    expect(QWEN.calls).toBe(0);
  });
  it("with force, the same window is re-processed", async () => {
    process.env.ETA_JEV_TRANSLATE_ENABLED = "1";
    QWEN.impl = () => ({ json: { english: "re-translated" }, raw: "", latency_ms: 3, model: "qwen2.5:14b" });
    DB.windows = [{ id: "w1" }];
    DB.runs.w1 = { transcript_english: null, transcript_original: "hindi", metrics_json: MIXED_METRICS, detected_language: "hi" };
    DB.existing = ["w1"];
    const r = await drive({ room_day_id: "rd1", force: true });
    expect(r.done).toMatchObject({ skipped: 0, translated: 1 });
    expect(DB.written.w1).toMatchObject({ source: "translated", english: "re-translated" });
  });
});

describe("J0 — translation is batched and resumable across steps", () => {
  it("more than JEV_TRANSLATE_BATCH windows still all get rows", async () => {
    process.env.ETA_JEV_TRANSLATE_ENABLED = "1";
    QWEN.impl = () => ({ json: { english: "t" }, raw: "", latency_ms: 1, model: "qwen2.5:14b" });
    const n = JEV_TRANSLATE_BATCH * 2 + 1;
    DB.windows = Array.from({ length: n }, (_, i) => ({ id: `w${i}` }));
    for (let i = 0; i < n; i += 1) DB.runs[`w${i}`] = { transcript_english: null, transcript_original: "hindi", metrics_json: MIXED_METRICS, detected_language: "hi" };
    const r = await drive({ room_day_id: "rd1" });
    expect(Object.keys(DB.written)).toHaveLength(n);
    expect(r.done).toMatchObject({ translated: n });
    expect(QWEN.calls).toBe(n);
  });
});

describe("J0 — an unrecognised flag value fails the job loudly (never read as off)", () => {
  it("fails rather than silently skipping translation", async () => {
    process.env.ETA_JEV_TRANSLATE_ENABLED = "maybe";
    DB.windows = [{ id: "w1" }];
    DB.runs.w1 = { transcript_english: null, transcript_original: "hindi", metrics_json: MIXED_METRICS, detected_language: "hi" };
    const r = await drive({ room_day_id: "rd1" });
    expect(r.fail).toBeTruthy();
    expect(QWEN.calls).toBe(0);
  });
});

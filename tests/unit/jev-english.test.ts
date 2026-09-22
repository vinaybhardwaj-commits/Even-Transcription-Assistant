/**
 * Slice J0 (ETA-JEV-ARM-D §3A) — jev-english: the English text Arm D reads.
 *
 * PURE where it can be (the three-way agreement rule), and the step machine driven against a fake
 * database and a fake qwen. THE MODEL IS NEVER LOADED: the qwen mock THROWS if it is ever reached
 * without a test-supplied impl, so an accidental translation call fails the test loudly.
 *
 * Refuter round 2 — the design rule these tests now pin: an ABSENCE and a FAILURE never share a value.
 *   not_ready (no run yet / gated off) is re-evaluated every run;  empty (run exists, text empty) and
 *   failed (translation attempted and failed, reason recorded) are terminal, failed being retryable.
 * P1/P2/P3 below reproduce fleet's probes and fail if the original defects return.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { isNativeEnglish, languageMix, classifyWindow, nativeEnglishVotes, votesRecord } from "@/lib/jev/english";

// ── the three-way agreement rule, PURE ───────────────────────────────────────────────────────────
describe("J0 — isNativeEnglish: an absent signal abstains, a present one that disagrees vetoes", () => {
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
  it("an ABSENT mix abstains: the other two signals carry it (V, 21 Sep — was false before)", () => {
    expect(isNativeEnglish({ full_window_language: "english", sarvam_language: "en" })).toBe(true);
  });
  it("an EMPTY mix ABSTAINS: it names no language, so it carries no information (V, 21 Sep)", () => {
    expect(isNativeEnglish(en({}))).toBe(true);
    expect(nativeEnglishVotes(en({})).mix).toBe("absent");
  });
  it("an empty mix cannot rescue a window on its own — the other two must still agree", () => {
    expect(isNativeEnglish(en({}, "hindi", "en"))).toBe(false);
    expect(isNativeEnglish({ full_window_language: "english", language_timeline: { language_mix: {} } })).toBe(false);
  });
  it("a mix whose values are all non-numeric reduces to empty, so it abstains as well", () => {
    expect(nativeEnglishVotes({ full_window_language: "english", sarvam_language: "en", language_timeline: { language_mix: { hi: "x" } } } as never).mix).toBe("absent");
  });
  it("no metrics at all is never English — nothing voted", () => {
    expect(isNativeEnglish(null)).toBe(false);
    expect(isNativeEnglish(undefined)).toBe(false);
    expect(isNativeEnglish({})).toBe(false);
  });

  // ── the rule the order names, case by case ────────────────────────────────────────────────────
  it("(1) three present, all English → pass", () => {
    expect(isNativeEnglish(en({ en: 2, und: 1 }, "english", "en-IN"))).toBe(true);
    expect(nativeEnglishVotes(en({ en: 2 }))).toEqual({ full: "english", sarvam: "english", mix: "english" });
  });
  it("(2) two present and English, one absent → pass, whichever one is missing", () => {
    expect(isNativeEnglish({ full_window_language: "english", sarvam_language: "en" })).toBe(true);
    expect(isNativeEnglish({ full_window_language: "english", language_timeline: { language_mix: { en: 1 } } })).toBe(true);
    expect(isNativeEnglish({ sarvam_language: "en", language_timeline: { language_mix: { en: 1, und: 2 } } })).toBe(true);
  });
  it("(3) ONE present is never enough — this is the >= 2 condition, and a mutation to >= 1 fails here", () => {
    expect(isNativeEnglish({ full_window_language: "english" })).toBe(false);
    expect(isNativeEnglish({ sarvam_language: "en" })).toBe(false);
    expect(isNativeEnglish({ language_timeline: { language_mix: { en: 4 } } })).toBe(false);
    for (const m of [{ full_window_language: "english" }, { sarvam_language: "en" }, { language_timeline: { language_mix: { en: 4 } } }]) {
      const v = nativeEnglishVotes(m);
      expect(Object.values(v).filter((x) => x === "english")).toHaveLength(1);
      expect(Object.values(v).filter((x) => x === "absent")).toHaveLength(2);
    }
  });
  it("(4) ANY present signal that disagrees vetoes, even with the other two saying English", () => {
    expect(isNativeEnglish(en({ en: 2 }, "hindi", "en"))).toBe(false);
    expect(isNativeEnglish(en({ en: 2 }, "english", "hi"))).toBe(false);
    expect(isNativeEnglish(en({ en: 2, kn: 1 }, "english", "en"))).toBe(false);
    expect(isNativeEnglish({ full_window_language: "english", sarvam_language: "kn" })).toBe(false);
  });
  it("a present-but-malformed signal is a disagreement, not an abstention", () => {
    expect(isNativeEnglish({ full_window_language: 42, sarvam_language: "en", language_timeline: { language_mix: { en: 1 } } } as never)).toBe(false);
    expect(nativeEnglishVotes({ full_window_language: "", sarvam_language: "en" } as never).full).toBe("other");
  });
  it("the vote record names who voted and who abstained, in a fixed order", () => {
    expect(votesRecord(nativeEnglishVotes({ full_window_language: "english", sarvam_language: "en" })))
      .toBe("full=english,sarvam=english,mix=absent");
    expect(votesRecord(nativeEnglishVotes(en({ en: 1, hi: 1 }))))
      .toBe("full=english,sarvam=english,mix=other");
    expect(votesRecord(nativeEnglishVotes(null))).toBe("full=absent,sarvam=absent,mix=absent");
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
  it("G1/N13 — all three signals English but NO original text is never native_en, and never throws", () => {
    // The live shape: bw_wwq9p6eb_1789821900000_primary (rd_jqj96amk) votes
    // full=english,sarvam=english,mix=english and has no transcript_original.
    for (const original of [null, undefined, "", "   "]) {
      const c = classifyWindow({ ...base, transcript_english: null, transcript_original: original as never });
      expect("done" in c).toBe(false);
      expect("needsTranslation" in c && c.original).toBeNull();
    }
    // and the guard is not doing this by accident — the same metrics WITH text do pass
    expect("done" in classifyWindow({ ...base, transcript_english: null, transcript_original: "hello doctor" })).toBe(true);
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
  existing: [] as Array<{ window_id: string; source: string }>,
  written: {} as Record<string, { window_id: string; room_day_id: string; english: string | null; source: string; char_count: number; model: string | null; error: string | null; input_chars: number | null; latency_ms: number | null }>,
  writes: 0,
}));
const QWEN = vi.hoisted(() => ({ calls: 0, userLens: [] as number[], impl: null as null | ((sys: string, user: string) => { json: { english?: string }; raw: string; latency_ms: number; model: string }) }));

vi.mock("@/lib/db", () => ({
  sql: async (strings: TemplateStringsArray, ...v: unknown[]) => {
    const q = strings.join(" ").replace(/\s+/g, " ");
    if (q.includes("FROM bench_window WHERE room_day_id")) return DB.windows;
    if (q.includes("FROM jev_window_text WHERE room_day_id")) return DB.existing;
    if (q.includes("FROM transcription_run")) { const id = v[0] as string; return DB.runs[id] ? [DB.runs[id]] : []; }
    if (q.includes("INSERT INTO jev_window_text")) {
      const [window_id, room_day_id, english, source, char_count, model, error, input_chars, latency_ms] =
        v as [string, string, string | null, string, number, string | null, string | null, number | null, number | null];
      DB.written[window_id] = { window_id, room_day_id, english, source, char_count, model, error, input_chars, latency_ms };
      DB.writes += 1;
      return [];
    }
    return [];
  },
}));

// The model call is faked at the NETWORK seam translate.ts now uses (22 Sep: off qwen, onto
// OpenRouter). Same tripwire and counters as before, so every existing impl still reads as it did:
// an impl returns the old `{ json: { english } }` shape and the adapter maps it to a chat result.
// Nothing here can reach the real OpenRouter, and this shell has a live key in its environment.
vi.mock("@/lib/openrouter", () => ({
  OpenRouterError: class OpenRouterError extends Error { code: string; constructor(code: string) { super(code); this.name = "OpenRouterError"; this.code = code; } },
  openrouterChat: async (a: { system: string; user: string; model: string }) => {
    QWEN.calls += 1; QWEN.userLens.push(a.user.length);
    if (!QWEN.impl) throw new Error("MODEL CALLED IN TEST — openrouterChat called with no impl; this must never happen");
    const r = await QWEN.impl(a.system, a.user);
    return { content: typeof r.json?.english === "string" ? r.json.english : "", model: r.model ?? a.model, latency_ms: r.latency_ms ?? 0 };
  },
}));

import { jevEnglishKind, JEV_ENGLISH_KIND, JEV_TRANSLATE_BATCH } from "@/lib/jobs/kinds/jev-english";
import { TRANSLATE_CHAR_CAP } from "@/lib/jev/translate";
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
const okImpl = (english: string) => () => ({ json: { english }, raw: "", latency_ms: 1, model: "qwen2.5:14b" });

const ENGLISH_METRICS = { full_window_language: "english", sarvam_language: "en", language_timeline: { language_mix: { en: 2, und: 1 } } };
const MIXED_METRICS = { full_window_language: "hindi", sarvam_language: "hi", language_timeline: { language_mix: { hi: 2, en: 1, und: 1 } } };
const hindiRun = () => ({ transcript_english: null, transcript_original: "bahut din se khaansi hai", metrics_json: MIXED_METRICS, detected_language: "hi" });

beforeEach(() => {
  DB.windows = []; DB.runs = {}; DB.existing = []; DB.written = {}; DB.writes = 0;
  QWEN.calls = 0; QWEN.userLens = []; QWEN.impl = null;
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

describe("J0 — success branches, and the model is never loaded unless translation is enabled", () => {
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

  it("the run REPORTS how the three signals voted, per window, and persists none of it", async () => {
    DB.windows = [{ id: "w1" }, { id: "w2" }];
    // w1: whisper and sarvam say English, the timeline was never written -> the abstain case.
    DB.runs.w1 = { transcript_english: null, transcript_original: "good morning", metrics_json: { full_window_language: "english", sarvam_language: "en" }, detected_language: null };
    // w2: the timeline says code-mixed -> a present signal that disagrees.
    DB.runs.w2 = { transcript_english: null, transcript_original: "aap kaise hain", metrics_json: { full_window_language: "english", sarvam_language: "en", language_timeline: { language_mix: { en: 2, hi: 1 } } }, detected_language: null };
    const r = await drive({ room_day_id: "rd1" });
    expect(r.done).toMatchObject({ native_en: 1, not_ready: 1 });
    expect((r.done as { votes: Record<string, number> }).votes).toEqual({
      "full=english,sarvam=english,mix=absent": 1,
      "full=english,sarvam=english,mix=other": 1,
    });
    // the record is a RUN artefact: nothing about voting reaches the row
    expect(Object.keys(DB.written.w1)).not.toContain("votes");
    expect(DB.written.w1).toMatchObject({ source: "native_en" });
  });

  it("G1/N13 — a live-shaped window, all three signals English with no text, is recorded empty not native_en", async () => {
    DB.windows = [{ id: "w1" }];
    DB.runs.w1 = { transcript_english: null, transcript_original: null, metrics_json: ENGLISH_METRICS, detected_language: null };
    const r = await drive({ room_day_id: "rd1" });
    expect(r.done).toMatchObject({ empty: 1, native_en: 0 });
    expect(DB.written.w1).toMatchObject({ source: "empty", english: null, char_count: 0 });
    expect(QWEN.calls).toBe(0);
  });

  it("G2/N17 — two windows sharing a vote record are COUNTED, not overwritten", async () => {
    DB.windows = [{ id: "w1" }, { id: "w2" }, { id: "w3" }];
    const abstained = { full_window_language: "english", sarvam_language: "en" };
    DB.runs.w1 = { transcript_english: null, transcript_original: "good morning", metrics_json: abstained, detected_language: null };
    DB.runs.w2 = { transcript_english: null, transcript_original: "please sit", metrics_json: abstained, detected_language: null };
    DB.runs.w3 = { transcript_english: null, transcript_original: "aap kaise hain", metrics_json: { ...abstained, language_timeline: { language_mix: { en: 2, hi: 1 } } }, detected_language: null };
    const r = await drive({ room_day_id: "rd1" });
    expect((r.done as { votes: Record<string, number> }).votes).toEqual({
      "full=english,sarvam=english,mix=absent": 2,
      "full=english,sarvam=english,mix=other": 1,
    });
    expect(r.done).toMatchObject({ native_en: 2, not_ready: 1 });
  });

  it("FLAG ON: a code-mixed window is translated locally, source=translated with model + input_chars", async () => {
    process.env.ETA_JEV_TRANSLATE_ENABLED = "1";
    QWEN.impl = () => ({ json: { english: "there has been a cough for many days" }, raw: "", latency_ms: 42, model: "qwen2.5:14b" });
    DB.windows = [{ id: "w1" }]; DB.runs.w1 = hindiRun();
    const r = await drive({ room_day_id: "rd1" });
    expect(r.done).toMatchObject({ translated: 1 });
    expect(DB.written.w1).toMatchObject({ source: "translated", english: "there has been a cough for many days", model: "qwen2.5:14b", latency_ms: 42 });
    expect(DB.written.w1.input_chars).toBe("bahut din se khaansi hai".length);
    expect(QWEN.calls).toBe(1);
  });

  it("FLAG UNSET: a code-mixed window lands source=not_ready (re-eligible), NO model loaded", async () => {
    DB.windows = [{ id: "w1" }]; DB.runs.w1 = hindiRun();
    const r = await drive({ room_day_id: "rd1" });
    expect(r.done).toMatchObject({ not_ready: 1, empty: 0, translated: 0 });
    expect(DB.written.w1).toMatchObject({ source: "not_ready", english: null });
    expect(QWEN.calls, "the 11.5 GB model must not be loaded when translation is gated off").toBe(0);
    // would fail if gated-off translatable text were stamped terminal ('empty') and skipped forever.
  });
});

describe("J0 — the three-way distinction: an absence and a failure never share a value", () => {
  it("no-run=not_ready, empty-source=empty, failed-translation=failed are all distinct and tell a/b/c apart", async () => {
    process.env.ETA_JEV_TRANSLATE_ENABLED = "1";
    DB.windows = [{ id: "a" }, { id: "b" }, { id: "c" }];
    // a: no run at all → not_ready
    // b: run exists, source text genuinely empty → empty
    DB.runs.b = { transcript_english: null, transcript_original: "   ", metrics_json: MIXED_METRICS, detected_language: "hi" };
    // c: run exists with text, translation throws → failed
    DB.runs.c = hindiRun();
    QWEN.impl = (_s, _u) => { throw new Error("ollama unreachable"); };
    const r = await drive({ room_day_id: "rd1" });
    expect(DB.written.a).toMatchObject({ source: "not_ready", error: null });
    expect(DB.written.b).toMatchObject({ source: "empty", error: null });
    expect(DB.written.c).toMatchObject({ source: "failed" });
    expect(DB.written.c.error, "the failure carries a closed-code reason").toBeTruthy();
    expect(r.done).toMatchObject({ not_ready: 1, empty: 1, failed: 1 });
    // three distinct sources; reading a row tells which of a/b/c it is.
    expect(new Set([DB.written.a.source, DB.written.b.source, DB.written.c.source]).size).toBe(3);
  });
});

describe("J0 — P1: a never-transcribed window is not_ready and becomes eligible on its own", () => {
  it("no run → not_ready; when a run later appears, a normal re-run (no force) reprocesses it — never permanently skipped", async () => {
    process.env.ETA_JEV_TRANSLATE_ENABLED = "1";
    DB.windows = [{ id: "w1" }]; // no run yet
    const r1 = await drive({ room_day_id: "rd1" });
    expect(DB.written.w1.source, "never-transcribed must NOT read as evidenced-empty").toBe("not_ready");
    expect(r1.done).toMatchObject({ not_ready: 1 });
    // A run appears. The not_ready row from run 1 is now in the table; a re-run WITHOUT force must
    // re-evaluate it (not_ready is not terminal), not skip it.
    DB.existing = [{ window_id: "w1", source: "not_ready" }];
    DB.runs.w1 = hindiRun();
    QWEN.impl = okImpl("translated at last");
    const r2 = await drive({ room_day_id: "rd1" });
    expect(r2.done).toMatchObject({ skipped: 0, translated: 1 });
    expect(DB.written.w1).toMatchObject({ source: "translated", english: "translated at last" });
    // would fail if: no-run wrote 'empty'/any terminal source, or not_ready were added to the skip set.
  });
});

describe("J0 — P2: a translation outage is a retryable failure, never swallowed as empty", () => {
  it("qwen throws → source=failed with a reason; the job still records it; a later re-run succeeds", async () => {
    process.env.ETA_JEV_TRANSLATE_ENABLED = "1";
    QWEN.impl = (_s, _u) => { throw new Error("ollama unreachable"); };
    DB.windows = [{ id: "w1" }]; DB.runs.w1 = hindiRun();
    const r = await drive({ room_day_id: "rd1" });
    expect(r.done, "the outage must surface, not finish done{empty:1}").toMatchObject({ failed: 1, empty: 0, translated: 0 });
    expect(DB.written.w1).toMatchObject({ source: "failed", english: null, model: null });
    expect(DB.written.w1.error).toBe("translate_error");   // a closed code, never the exception text
    // retryable: failed is not skipped, so a re-run without force re-attempts it.
    DB.existing = [{ window_id: "w1", source: "failed" }];
    QWEN.impl = okImpl("recovered");
    const r2 = await drive({ room_day_id: "rd1" });
    expect(r2.done).toMatchObject({ skipped: 0, translated: 1 });
    expect(DB.written.w1).toMatchObject({ source: "translated", english: "recovered" });
    // would fail if: the outage were persisted as 'empty' (finding 2), or 'failed' were terminal-skipped.
  });

  it("a successful-but-EMPTY translation is failed(empty_output), not empty", async () => {
    process.env.ETA_JEV_TRANSLATE_ENABLED = "1";
    QWEN.impl = () => ({ json: { english: "   " }, raw: "", latency_ms: 9, model: "qwen2.5:14b" });
    DB.windows = [{ id: "w1" }]; DB.runs.w1 = hindiRun();
    const r = await drive({ room_day_id: "rd1" });
    expect(r.done).toMatchObject({ failed: 1, empty: 0 });
    expect(DB.written.w1).toMatchObject({ source: "failed", error: "empty_output" });
    // would fail if an attempted translation that produced nothing were labelled 'empty' (an absence).
  });
});

describe("J0 — P3: input is not silently truncated; input_chars records the true length", () => {
  it("a 9,500-char window is sent to the model in FULL (was clipped to 8,000)", async () => {
    process.env.ETA_JEV_TRANSLATE_ENABLED = "1";
    QWEN.impl = okImpl("t");
    DB.windows = [{ id: "w1" }]; DB.runs.w1 = { transcript_english: null, transcript_original: "a".repeat(9500), metrics_json: MIXED_METRICS, detected_language: "hi" };
    await drive({ room_day_id: "rd1" });
    // Exactly 9,500: the user message is now the original alone, as on the router — the old
    // "Language: …\nTranscript:\n" prefix is gone, which is what `> 9500` was really measuring.
    expect(QWEN.userLens[0], "the whole 9,500 chars must reach the model").toBe(9500);
    expect(DB.written.w1).toMatchObject({ source: "translated", input_chars: 9500 });
    // would fail if TRANSLATE_CHAR_CAP dropped back to 8,000 (userLens ~8,025 < 9,500).
  });
  it("a window beyond the cap is clipped, but input_chars carries the true length so the clip is on the row", async () => {
    process.env.ETA_JEV_TRANSLATE_ENABLED = "1";
    QWEN.impl = okImpl("t");
    const trueLen = TRANSLATE_CHAR_CAP + 5000;
    DB.windows = [{ id: "w1" }]; DB.runs.w1 = { transcript_english: null, transcript_original: "a".repeat(trueLen), metrics_json: MIXED_METRICS, detected_language: "hi" };
    await drive({ room_day_id: "rd1" });
    expect(DB.written.w1.input_chars, "the row records the real length, not the clipped length").toBe(trueLen);
    expect(QWEN.userLens[0]).toBeLessThan(trueLen); // it WAS clipped
    // would fail if truncation were silent (input_chars null) — the corpus could not tell a clip from a full send.
  });
});

describe("J0 — a row is written for every window, across a mix of branches", () => {
  it("run_english, native_en, translated, and no-run(not_ready) each get their row", async () => {
    process.env.ETA_JEV_TRANSLATE_ENABLED = "1";
    QWEN.impl = okImpl("translated");
    DB.windows = [{ id: "wA" }, { id: "wB" }, { id: "wC" }, { id: "wD" }];
    DB.runs.wA = { transcript_english: "eng", transcript_original: null, metrics_json: null, detected_language: null };
    DB.runs.wB = { transcript_english: null, transcript_original: "english native", metrics_json: ENGLISH_METRICS, detected_language: null };
    DB.runs.wC = { transcript_english: null, transcript_original: "hindi text", metrics_json: MIXED_METRICS, detected_language: "hi" };
    // wD has no run row → not_ready (re-eligible), not empty
    const r = await drive({ room_day_id: "rd1" });
    expect(Object.keys(DB.written).sort()).toEqual(["wA", "wB", "wC", "wD"]);
    expect(r.done).toMatchObject({ run_english: 1, native_en: 1, translated: 1, not_ready: 1, windows: 4 });
  });
});

describe("J0 — force re-runs; without it, only TERMINAL windows are skipped", () => {
  it("without force, a terminal (translated) window is skipped — no re-translation", async () => {
    process.env.ETA_JEV_TRANSLATE_ENABLED = "1";
    QWEN.impl = okImpl("x");
    DB.windows = [{ id: "w1" }]; DB.runs.w1 = hindiRun();
    DB.existing = [{ window_id: "w1", source: "translated" }];
    const r = await drive({ room_day_id: "rd1" });
    expect(r.done).toMatchObject({ skipped: 1, translated: 0 });
    expect(DB.writes).toBe(0);
    expect(QWEN.calls).toBe(0);
  });
  it("with force, the same terminal window is re-processed", async () => {
    process.env.ETA_JEV_TRANSLATE_ENABLED = "1";
    QWEN.impl = okImpl("re-translated");
    DB.windows = [{ id: "w1" }]; DB.runs.w1 = hindiRun();
    DB.existing = [{ window_id: "w1", source: "translated" }];
    const r = await drive({ room_day_id: "rd1", force: true });
    expect(r.done).toMatchObject({ skipped: 0, translated: 1 });
    expect(DB.written.w1).toMatchObject({ source: "translated", english: "re-translated" });
  });
});

describe("J0 — translation is batched and resumable across steps", () => {
  it("more than JEV_TRANSLATE_BATCH windows still all get rows", async () => {
    process.env.ETA_JEV_TRANSLATE_ENABLED = "1";
    QWEN.impl = okImpl("t");
    const n = JEV_TRANSLATE_BATCH * 2 + 1;
    DB.windows = Array.from({ length: n }, (_, i) => ({ id: `w${i}` }));
    for (let i = 0; i < n; i += 1) DB.runs[`w${i}`] = hindiRun();
    const r = await drive({ room_day_id: "rd1" });
    expect(Object.keys(DB.written)).toHaveLength(n);
    expect(r.done).toMatchObject({ translated: n });
    expect(QWEN.calls).toBe(n);
  });
});

describe("J0 — an unrecognised flag value fails the job loudly (never read as off)", () => {
  it("fails rather than silently skipping translation", async () => {
    process.env.ETA_JEV_TRANSLATE_ENABLED = "maybe";
    DB.windows = [{ id: "w1" }]; DB.runs.w1 = hindiRun();
    const r = await drive({ room_day_id: "rd1" });
    expect(r.fail).toBeTruthy();
    expect(QWEN.calls).toBe(0);
  });
});

/**
 * tests/unit/speech-gate-wiring.test.ts — the gate is WIRED, and what it writes is asserted.
 *
 * The Refuter's F1/F2: `fetchWindowSpeech` reached nothing on the drain path, and the gate call
 * site was executed by 17 tests without one of them asserting what it produced. Two mutations
 * survived because of that:
 *   M5 — the OFF path stores rawSegments (so OFF stops meaning unjudged)
 *   M6 — an absent VAD defaults to {ok:true, spans:[]} (so every segment is stamped non_speech)
 *
 * M5 is now the REQUIRED behaviour — OFF must be byte-identical to production — so the assertion
 * runs the other way: OFF must carry no gate keys at all. M6 is still a defect, and is pinned here.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import { windowStart, windowEnd } from "@/lib/stt/window-bounds";

const SVC = vi.hoisted(() => ({ out: {} as Record<string, unknown> }));
const H = vi.hoisted(() => ({ vadCalls: [] as Array<{ bytes: number }>, vad: null as unknown }));

vi.mock("@/lib/db", () => ({
  sql: async (strings: TemplateStringsArray) => {
    const q = strings.join("?").replace(/\s+/g, " ");
    if (q.includes("FROM voice_print")) return [];
    return [];
  },
}));
vi.mock("@/lib/diarize", () => ({ runDiarize: async () => SVC.out }));

const SEGS = [
  { start_ms: 0, end_ms: 5000, speaker_idx: 0 },
  { start_ms: 5000, end_ms: 9000, speaker_idx: 1 },
];
const call = () => ({
  windowId: "bw_1", roomDayId: "rd_1",
  window: { start: windowStart(1000), end: windowEnd(901_000) },
  audio: new Uint8Array([1]), runId: "run_unit",
});

beforeEach(() => {
  SVC.out = { ok: true, result: { speakers: [], transcript_segments: SEGS }, timing: null };
  H.vadCalls.length = 0;
  vi.resetModules();
  delete process.env.DIARIZE_SPEECH_GATE;
});

async function run(flag: string | undefined, speech?: unknown) {
  if (flag === undefined) delete process.env.DIARIZE_SPEECH_GATE;
  else process.env.DIARIZE_SPEECH_GATE = flag;
  const { diarizeWindow } = await import("@/lib/stt/diarize-window");
  const r = await diarizeWindow({ ...call(), ...(speech ? { speech } : {}) } as Parameters<typeof diarizeWindow>[0]);
  if (!r.ok) throw new Error("diarize failed in fixture");
  return r.segments as Array<Record<string, unknown>>;
}

describe("FLAG OFF is byte-identical to production", () => {
  it("writes the raw segments, with NOT ONE extra key", async () => {
    const segs = await run(undefined);
    expect(segs).toEqual(SEGS);
    for (const s of segs) expect(Object.keys(s).sort()).toEqual(["end_ms", "speaker_idx", "start_ms"]);
  });

  it("carries no gate vocabulary at all — the row is the row production writes", async () => {
    const segs = await run("0");
    const json = JSON.stringify(segs);
    for (const key of ["verdict", "speech_ms", "speech_ratio", "speech_basis", "unjudged_reason"]) {
      expect(json).not.toContain(key);
    }
    // and the cost that motivated this: the same bytes, not 4x
    expect(json.length).toBe(JSON.stringify(SEGS).length);
  });
});

describe("FLAG ON with a working VAD actually judges — the gate is not inert", () => {
  it("stamps verdicts from the spans it was given", async () => {
    const segs = await run("1", { ok: true, spans: [{ start_ms: 0, end_ms: 4000 }] });
    expect(segs.map((s) => s.verdict)).toEqual(["speech", "non_speech"]);
    expect(segs[0].speech_ms).toBe(4000);
    expect(segs[1].speech_ms).toBe(0);
  });

  it("judged means judged: no segment is left unjudged when spans exist", async () => {
    const segs = await run("1", { ok: true, spans: [{ start_ms: 0, end_ms: 9000 }] });
    expect(segs.every((s) => s.verdict === "speech")).toBe(true);
    expect(segs.every((s) => s.unjudged_reason === undefined)).toBe(true);
  });
});

describe("M6 — FLAG ON with NO VAD answer convicts nothing", () => {
  it("stamps unjudged/vad_unavailable, never non_speech", async () => {
    const segs = await run("1");
    expect(segs.map((s) => s.verdict)).toEqual(["unjudged", "unjudged"]);
    expect(segs.every((s) => s.unjudged_reason === "vad_unavailable")).toBe(true);
    expect(segs.every((s) => s.verdict !== "non_speech")).toBe(true);
  });

  it("an empty-span answer is unjudged too, not a window of noise", async () => {
    const segs = await run("1", { ok: false, reason: "vad_empty_window" });
    expect(segs.every((s) => s.verdict === "unjudged")).toBe(true);
    expect(segs.every((s) => s.unjudged_reason === "vad_empty_window")).toBe(true);
  });
});

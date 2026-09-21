/**
 * tests/unit/diarize-window-job-gate.test.ts — F1: the gate is actually wired to a VAD.
 *
 * The Refuter's blocker was that `fetchWindowSpeech` was imported by exactly one file — a test.
 * `diarizeWindow`'s `speech` argument had no caller, so DIARIZE_SPEECH_GATE=1 stamped every segment
 * `unjudged` and the gate was inert at both flag settings.
 *
 * This asserts the drain path end to end: flag ON, a working /vad, and the segments RECORDED for
 * the window carry real verdicts. Window ids and counts only.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";

const H = vi.hoisted(() => ({
  vadCalls: [] as number[],
  vadReply: { ok: true, spans: [{ start_ms: 0, end_ms: 4000 }] } as unknown,
  recorded: [] as Array<Record<string, unknown>>,
  segments: [
    { start_ms: 0, end_ms: 5000, speaker_idx: 0 },
    { start_ms: 5000, end_ms: 9000, speaker_idx: 1 },
  ],
}));

vi.mock("@/lib/r2", () => ({ getObjectBytes: async () => new Uint8Array([1, 2, 3, 4]) }));
vi.mock("@/lib/db", () => ({
  sql: async (strings: TemplateStringsArray) => {
    const q = strings.join("?").replace(/\s+/g, " ");
    if (q.includes("FROM bench_window")) {
      return [{ id: "bw_1", room_day_id: "rd_1", start_ms: 1000, end_ms: 901000, clip_r2_key: "clips/x.webm" }];
    }
    return [];
  },
}));
vi.mock("@/lib/stt/diarize-window", async (orig) => {
  const actual = (await orig()) as Record<string, unknown>;
  return {
    ...actual,
    // The real gate logic runs inside the real diarizeWindow; only the service and the write are faked.
    recordDiarizeWindow: async (row: Record<string, unknown>) => { H.recorded.push(row); },
    repairStaleDiarizeSegments: async () => ({ repaired: false }),
  };
});
vi.mock("@/lib/diarize", () => ({
  runDiarize: async () => ({ ok: true, result: { speakers: [], transcript_segments: H.segments }, timing: null }),
}));
vi.mock("@/lib/stt/speech-gate", async (orig) => {
  const actual = (await orig()) as Record<string, unknown>;
  return {
    ...actual,
    fetchWindowSpeech: async (audio: Uint8Array) => { H.vadCalls.push(audio.length); return H.vadReply; },
  };
});

async function runStep() {
  const { diarizeWindowKind } = await import("@/lib/jobs/kinds/diarize-window");
  // A kind is a step machine: the runner hands it one step at a time.
  return diarizeWindowKind.run({
    step: "diarize",
    args: { window_id: "bw_1" },
    jobId: "j1",
    attempt: 1,
    progress: {},
  } as unknown as Parameters<typeof diarizeWindowKind.run>[0]);
}

beforeEach(() => {
  H.vadCalls.length = 0; H.recorded.length = 0;
  H.vadReply = { ok: true, spans: [{ start_ms: 0, end_ms: 4000 }] };
  vi.resetModules();
  delete process.env.DIARIZE_SPEECH_GATE;
});

describe("F1 — the drain path asks the VAD, and stores what it answered", () => {
  it("FLAG ON: fetches speech for the window's own audio and records judged segments", async () => {
    process.env.DIARIZE_SPEECH_GATE = "1";
    await runStep();
    expect(H.vadCalls.length).toBe(1);            // it asked
    expect(H.vadCalls[0]).toBe(4);                // with the window's audio, not something else
    const ok = H.recorded.find((r) => r.state !== "failed");
    expect(ok).toBeTruthy();
    const segs = ok!.segments as Array<Record<string, unknown>>;
    expect(segs.map((s) => s.verdict)).toEqual(["speech", "non_speech"]);
    expect(segs.every((s) => s.verdict === "unjudged")).toBe(false);   // NOT inert
  });

  it("FLAG OFF: never calls the VAD, and records the raw segments", async () => {
    await runStep();
    expect(H.vadCalls).toEqual([]);
    const ok = H.recorded.find((r) => r.state !== "failed");
    const segs = ok!.segments as Array<Record<string, unknown>>;
    expect(segs).toEqual(H.segments);
    for (const s of segs) expect(Object.keys(s).sort()).toEqual(["end_ms", "speaker_idx", "start_ms"]);
  });

  it("R5 — carries WHICH refusal it was: empty is not the same as unreachable", async () => {
    // Both refusals stamp `unjudged`, which is why swapping them passed the suite. They answer
    // different questions: `vad_empty_window` means Silero ANSWERED and found nothing — the
    // failure seen on 12 of 80 real windows — and `vad_unavailable` means no answer arrived.
    // A hand-off that only forwards `speech.ok` turns the first into the second and the count
    // of VAD failures silently becomes zero.
    process.env.DIARIZE_SPEECH_GATE = "1";
    H.vadReply = { ok: false, reason: "vad_empty_window" };
    await runStep();
    const ok = H.recorded.find((r) => r.state !== "failed");
    const segs = ok!.segments as Array<Record<string, unknown>>;
    expect(segs.every((s) => s.verdict === "unjudged")).toBe(true);
    expect(segs.every((s) => s.unjudged_reason === "vad_empty_window")).toBe(true);
    expect(segs.some((s) => s.unjudged_reason === "vad_unavailable")).toBe(false);
  });

  it("FLAG ON with the VAD down: asks, is refused, and convicts nothing", async () => {
    process.env.DIARIZE_SPEECH_GATE = "1";
    H.vadReply = { ok: false, reason: "vad_unavailable" };
    await runStep();
    expect(H.vadCalls.length).toBe(1);
    const ok = H.recorded.find((r) => r.state !== "failed");
    const segs = ok!.segments as Array<Record<string, unknown>>;
    expect(segs.every((s) => s.verdict === "unjudged")).toBe(true);
    expect(segs.some((s) => s.verdict === "non_speech")).toBe(false);
  });
});

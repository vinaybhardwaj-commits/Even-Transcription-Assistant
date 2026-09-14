/**
 * S1 — an emotion_window job whose every segment failed is a FAILURE, not `ok`.
 *
 * A caught failure that produces success-shaped output is exactly what this guards against. The
 * three shapes are proven through the kind's own `run`, so the step dispatch and its outcome
 * are the real ones; only the window row writer and the outside world are faked.
 *
 *   planned > 0, scored = 0            -> window `failed`, error emotion_zero_scored, job fails
 *   planned > 0, scored > 0, failed > 0 -> window `ok`, job done (partial success is success)
 *   planned = 0                         -> window `no_segments`, job done (a quiet pass, unchanged)
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const H = vi.hoisted(() => ({
  windows: [] as Array<Record<string, unknown>>,
  sqlResponses: [] as unknown[][],
}));
vi.mock("@/lib/db", () => ({ sql: async () => H.sqlResponses.shift() ?? [] }));
vi.mock("@/lib/r2", () => ({ signGetUrl: async () => "https://r2.example/clip" }));
vi.mock("@/lib/emotion/gate", () => ({ emotionEnabled: () => true }));
vi.mock("@/lib/emotion/client", async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  emotionSecretConfigured: () => true,
  emotionHealth: async () => ({ ok: true, cap_s: 30, loaded: true, model: "m", subfolder: "s" }),
}));
vi.mock("@/lib/emotion/store", () => ({
  recordEmotionWindow: async (r: Record<string, unknown>) => { H.windows.push(r); },
  writeSkipped: async () => {},
  writeScoredOrFailed: async () => {},
}));

const { emotionWindowKind } = await import("@/lib/jobs/kinds/emotion-window");
const { errorCodeOf } = await import("@/lib/jobs/errors");

beforeEach(() => { H.windows.length = 0; H.sqlResponses = []; });

const seg = (i: number) => ({ speaker_idx: 0, clip_start_s: i * 10, clip_end_s: i * 10 + 5 });

/** Run the `finish` step with a plan of `planned` segments, `scored` of them scored and `failed` failed. */
function finishWith(planned: number, scored: number, failed: number) {
  const progress = {
    window_id: "bw_1", room_day_id: "rd_1", window_start_ms: 0, window_end_ms: 900_000, clip_r2_key: "clips/w.webm",
    diarize_run_id: "run_1", cap_s: 30, loaded_before: true, segments: Array.from({ length: planned }, (_, i) => seg(i)),
    skipped: 0, batch: 1, calls: 2, scored, failed, model: "m", subfolder: "s", device: "cpu", started_ms: Date.now(),
  };
  return emotionWindowKind.run({ step: "finish", args: { window_id: "bw_1" }, progress, job: {} as never } as never);
}

describe("finish — zero scored is a failure", () => {
  it("planned > 0, scored = 0: the window is recorded FAILED with emotion_zero_scored, and the job fails", async () => {
    const out = await finishWith(3, 0, 3);
    expect(H.windows).toHaveLength(1);
    expect(H.windows[0]!.state).toBe("failed");
    expect(H.windows[0]!.error).toBe("emotion_zero_scored");
    expect(H.windows[0]!.counts).toMatchObject({ planned: 3, scored: 0, failed: 3 });
    expect(out.kind).toBe("fail");
    const error = (out as { error: string }).error;
    expect(error).toContain("emotion_zero_scored");
    expect(errorCodeOf(error), "the job error still leads with a published code").toBe("emotion_window_failed");
  });

  it("planned > 0, scored > 0, failed > 0: partial success stays OK, and the job is done", async () => {
    const out = await finishWith(3, 1, 2);
    expect(H.windows).toHaveLength(1);
    expect(H.windows[0]!.state).toBe("ok");
    expect(H.windows[0]!.error).toBeNull();
    expect(out.kind).toBe("done");
  });

  it("planned > 0, all scored: OK, done — the refusal above is not universal", async () => {
    const out = await finishWith(3, 3, 0);
    expect(H.windows[0]!.state).toBe("ok");
    expect(out.kind).toBe("done");
  });
});

describe("prepare — planned = 0 is still the no_segments quiet pass", () => {
  it("no attributed turns: no_segments, error null, job done — never reaches finish", async () => {
    H.sqlResponses = [
      [{ id: "bw_1", room_day_id: "rd_1", start_ms: 0, end_ms: 900_000, clip_r2_key: "clips/w.webm", diarize_state: "ok", last_run_id: "run_1" }],
      [],
    ];
    const out = await emotionWindowKind.run({ step: "prepare", args: { window_id: "bw_1" }, progress: {}, job: {} as never } as never);
    expect(H.windows).toHaveLength(1);
    expect(H.windows[0]!.state).toBe("no_segments");
    expect(H.windows[0]!.error).toBeNull();
    expect(H.windows[0]!.counts).toMatchObject({ planned: 0, scored: 0 });
    expect(out.kind).toBe("done");
  });
});

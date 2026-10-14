WT = "/private/tmp/claude-501/-Users-vinaybhardwaj-dev-Even-Transcription-Assistant/d8adbaae-4988-4ddb-8abf-a6544d6db52b/scratchpad/vad-wt"
path = WT + "/tests/unit/vad-starvation-job-path.test.ts"
with open(path, "r") as f:
    src = f.read()

old = '''describe("reading it cold: the tape separates a window that reached an engine from one that never did", () => {
  it("skipped / ran / unknown are three different answers on the row", async () => {
    const { assembleTape } = await import("@/lib/room-day/admin");
    const { buildRouteMetrics } = await import("@/lib/stt/route-run");
    const base = {
      windowRows: [] as never[], diarizeRows: [] as never[], turnRows: [] as never[],
      repeatRunRows: [] as never[], emotionWindowRows: [] as never[], spanEmotionRows: [] as never[],
      clinicianNames: {}, emotion: { compute_enabled: false, surface_enabled: false },
      autoDrainMaxAgeHours: 6,
    };
    const metricsFor = (router?: Parameters<typeof buildRouteMetrics>[2]) =>
      buildRouteMetrics([], { audio_seconds: 900 }, router);
    const cases = [
      { router: { status: "silent_skipped", outcome: "no_engine" }, expect: "skipped" },
      { router: { status: "ok", outcome: "engine_no_text" }, expect: "ran" },
      { router: undefined, expect: "unknown" },
    ] as const;
    for (const c of cases) {
      const m = metricsFor(c.router);
      const { readEngineOutcome } = await import("@/lib/stt/route-run");
      const r = readEngineOutcome(m);
      const rendered = r.known ? (r.skipped ? "skipped" : "ran") : "unknown";
      expect(rendered, `router=${JSON.stringify(c.router)}`).toBe(c.expect);
    }
    void base; void assembleTape;
  });
});'''
assert src.count(old) == 1, f"old count={src.count(old)}"

new = '''describe("reading it cold: the tape separates a window that reached an engine from one that never did", () => {
  it("skipped / ran / unknown are three different answers on the row, through assembleTape itself", async () => {
    // Asserting against the REAL assembleTape output (lib/room-day/admin.ts), not a copy of its
    // ternary inlined here — a copy proves nothing about the 17 lines that file actually changed.
    const { assembleTape, SLOT_MS } = await import("@/lib/room-day/admin");
    const win = {
      id: "bw_1", session_id: "bs_1", room_day_id: "rd_1",
      start_ms: 0, end_ms: SLOT_MS, source_mic: "primary", grid_aligned: true,
      state: "transcribed" as const, closed_at: null,
      auto_drain_refused_at: null, auto_drain_refused_reason: null,
    };
    const baseInput = {
      room: { id: "room_1", name: "R", slug: "r" },
      ist_date: "2026-09-19",
      roomDay: { id: "rd_1", doctor_id: null, started_at: null, ended_at: null },
      spanStartMs: 0, spanEndMs: SLOT_MS,
      windows: [win],
      diarizeRows: [] as never[], turnRows: [] as never[], repeatRunRows: [] as never[],
      emotionWindowRows: [] as never[], spanEmotionRows: [] as never[],
      clinicianNames: {}, emotion: { compute_enabled: false, surface_enabled: false },
      nowMs: SLOT_MS * 1000, autoDrainMaxAgeHours: 6,
    };
    const cases = [
      {
        router: { status: "silent_skipped", segmentation: { outcome: "no_engine", windows_total: 5, windows_skipped: 5 } },
        expect: "skipped", windows_total: 5, windows_skipped: 5,
      },
      {
        router: { status: "ok", segmentation: { outcome: "engine_no_text" } },
        expect: "ran", windows_total: null, windows_skipped: null,
      },
      { router: undefined, expect: "unknown", windows_total: null, windows_skipped: null },
    ] as const;
    for (const c of cases) {
      const metrics = buildRouteMetrics([], { audio_seconds: 900 }, c.router);
      const tape = assembleTape({
        ...baseInput,
        transcriptRows: [{ window_id: "bw_1", engine: "route", error: null, latency_ms: 100, transcript_original: "", metrics_json: metrics }],
      });
      const slot = tape.slots[0]!;
      if (slot.kind !== "window") throw new Error("expected a window slot");
      expect(slot.window.transcript?.engines, `router=${JSON.stringify(c.router)}`).toBe(c.expect);
      // F5: partial starvation survives onto the tape rather than being read and dropped.
      expect(slot.window.transcript?.windows_total).toBe(c.windows_total);
      expect(slot.window.transcript?.windows_skipped).toBe(c.windows_skipped);
    }
  });
});'''
src = src.replace(old, new, 1)

with open(path, "w") as f:
    f.write(src)
print("step C OK")

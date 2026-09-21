/**
 * tests/unit/join-only.test.ts — the join-only path.
 *
 * The claim under test is that producing a clip is separable from transcribing it, and that the
 * separation is honest: the same join step the drain runs, none of the work after it, and every
 * refusal named rather than skipped.
 *
 * Window ids only. No room slugs, no clinician ids, no transcript text.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";

const H = vi.hoisted(() => ({
  /** Calls into the seam. Length is the assertion that matters: 0 means nothing was paid for. */
  joins: [] as Array<{ windowId: string; sessionId: string }>,
  joinResult: { ok: true, key: "clips/w1.webm" } as
    | { ok: true; key: string }
    | { ok: false; error: string; hop?: string },
  ctx: null as unknown,
  transcriptEnabled: true,
  recording: { known: true, rooms: [] as Array<{ room_id: string }> } as
    | { known: true; rooms: Array<{ room_id: string }> }
    | { known: false; reason: string },
  configured: true,
  tooLong: null as null | { error: string; requested_minutes: number; limit_minutes: number },
  queries: [] as string[],
  params: [] as unknown[][],
}));

vi.mock("@/lib/stt/room-drain", () => ({
  loadWindowContext: async () => H.ctx,
  joinClipForWindow: async (a: { windowId: string; sessionId: string }) => {
    H.joins.push({ windowId: a.windowId, sessionId: a.sessionId });
    return H.joinResult;
  },
}));
vi.mock("@/lib/room-switches", () => ({ isTranscriptEnabled: async () => H.transcriptEnabled }));
vi.mock("@/lib/bench-join", () => ({
  refuseIfTooLong: () => H.tooLong,
  roomsRecordingNow: async () => H.recording,
  joinServiceConfigured: () => H.configured,
}));
vi.mock("@/lib/db", () => ({
  sql: (strings: TemplateStringsArray, ...vals: unknown[]) => {
    H.queries.push(strings.join("?"));
    H.params.push(vals);
    return Promise.resolve([]);
  },
}));

/** A closed, clipless, joinable window — the shape `loadWindowContext` returns. */
function ctx(over: Record<string, unknown> = {}) {
  return {
    w: {
      id: "w1", session_id: "sess_1", room_id: "room_1", room_day_id: "rd_1",
      start_ms: 0, end_ms: 900_000, source_mic: "primary",
      clip_r2_key: null, grid_aligned: true, state: "closed", ...over,
    },
    startMs: 0, endMs: 900_000, source: "primary" as const,
    covering: [{ chunk: { idx: 1, r2_key: "chunks/1.webm" }, offset_in_chunk_s: 0, duration_s: 900 }],
    audioSeconds: 900,
  };
}

async function run(opts?: { includeTranscriptDisabled?: boolean }) {
  const { joinOnlyWindow } = await import("@/lib/stt/join-only");
  return joinOnlyWindow("w1", opts);
}

beforeEach(() => {
  H.joins.length = 0; H.queries.length = 0; H.params.length = 0;
  H.joinResult = { ok: true, key: "clips/w1.webm" };
  H.ctx = ctx();
  H.transcriptEnabled = true;
  H.recording = { known: true, rooms: [] };
  H.configured = true;
  H.tooLong = null;
  vi.resetModules();
});

describe("it joins, and it joins through the drain's own step", () => {
  it("produces a clip for a closed clipless window", async () => {
    const r = await run();
    expect(r.ok).toBe(true);
    expect(r).toMatchObject({ clip_r2_key: "clips/w1.webm", joined: true, audio_seconds: 900 });
    expect(H.joins).toEqual([{ windowId: "w1", sessionId: "sess_1" }]);
  });

  it("reports the join's failure by name and writes nothing of its own", async () => {
    H.joinResult = { ok: false, error: "join_unreachable", hop: "worker_to_do" };
    const r = await run();
    expect(r.ok).toBe(false);
    expect(r).toMatchObject({ step: "join_failed" });
    expect((r as { detail: string }).detail).toContain("join_unreachable");
    expect((r as { detail: string }).detail).toContain("worker_to_do");
  });
});

describe("IDEMPOTENCE — a window that has a clip is never re-joined", () => {
  it("returns the existing key and does not call the service", async () => {
    H.ctx = ctx({ clip_r2_key: "clips/already.webm" });
    const r = await run();
    expect(r).toMatchObject({ ok: true, clip_r2_key: "clips/already.webm", joined: false });
    expect(H.joins).toEqual([]);
  });

  it("skips before it even reads the transcript switch, so a re-run is free", async () => {
    H.ctx = ctx({ clip_r2_key: "clips/already.webm" });
    H.transcriptEnabled = false;
    H.recording = { known: false, reason: "sessions_unavailable" };
    const r = await run();
    expect(r.ok).toBe(true); // neither the switch nor the unreadable bus can turn a done window into a refusal
  });
});

describe("THE TWO DECISIONS ARE SEPARATE — and the second one is a parameter", () => {
  it("refuses a transcript-disabled room BY DEFAULT, by name, joining nothing", async () => {
    H.transcriptEnabled = false;
    const r = await run();
    expect(r).toMatchObject({ ok: false, step: "transcript_disabled_room" });
    expect(H.joins).toEqual([]);
  });

  it("joins the same window when explicitly asked to include those rooms", async () => {
    H.transcriptEnabled = false;
    const r = await run({ includeTranscriptDisabled: true });
    expect(r).toMatchObject({ ok: true, joined: true });
    expect(H.joins.length).toBe(1);
  });

  it("the flag turns nothing else off: every audio guard still applies", async () => {
    H.transcriptEnabled = false;
    H.recording = { known: true, rooms: [{ room_id: "room_9" }] };
    const r = await run({ includeTranscriptDisabled: true });
    expect(r).toMatchObject({ ok: false, step: "room_recording" });
    expect(H.joins).toEqual([]);
  });
});

describe("D15 — it backs off rather than competing with a live tape", () => {
  it("refuses while any room is recording, and names a COUNT, never a room", async () => {
    H.recording = { known: true, rooms: [{ room_id: "room_9" }, { room_id: "room_7" }] };
    const r = await run();
    expect(r).toMatchObject({ ok: false, step: "room_recording" });
    expect((r as { detail: string }).detail).toBe("2 recording");
    expect((r as { detail: string }).detail).not.toMatch(/room_9|room_7/);
    expect(H.joins).toEqual([]);
  });

  it("holds when the guard cannot be read — it does not join on an unproven all-clear", async () => {
    H.recording = { known: false, reason: "sessions_unavailable:timeout" };
    const r = await run();
    expect(r).toMatchObject({ ok: false, step: "recording_unknown" });
    expect(H.joins).toEqual([]);
  });

  it("returns instead of retrying: one attempt per call, no loop inside", async () => {
    H.recording = { known: true, rooms: [{ room_id: "room_9" }] };
    await run();
    await run();
    expect(H.joins).toEqual([]); // two calls, two refusals, zero service calls
  });
});

describe("the window must be settled, whole, and joinable", () => {
  it("refuses a window a live drain is holding", async () => {
    H.ctx = ctx({ state: "transcribing" });
    const r = await run();
    expect(r).toMatchObject({ ok: false, step: "wrong_state", detail: "transcribing" });
    expect(H.joins).toEqual([]);
  });

  it("refuses an already-transcribed window rather than making it a second clip", async () => {
    H.ctx = ctx({ state: "transcribed" });
    expect(await run()).toMatchObject({ ok: false, step: "wrong_state" });
  });

  it("carries the loader's own refusals under their own names", async () => {
    H.ctx = { error: "no_chunks", detail: "no covering chunks" };
    expect(await run()).toMatchObject({ ok: false, step: "no_chunks" });
    H.ctx = { error: "not_found" };
    expect(await run()).toMatchObject({ ok: false, step: "not_found" });
    H.ctx = { error: "no_room_day" };
    expect(await run()).toMatchObject({ ok: false, step: "no_room_day" });
  });

  it("refuses a window past the service's length cap, naming the limit", async () => {
    H.tooLong = { error: "window_too_long", requested_minutes: 41.2, limit_minutes: 30 };
    const r = await run();
    expect(r).toMatchObject({ ok: false, step: "too_long" });
    expect((r as { detail: string }).detail).toContain("30");
    expect(H.joins).toEqual([]);
  });

  it("refuses when the join service is not configured, instead of failing inside it", async () => {
    H.configured = false;
    expect(await run()).toMatchObject({ ok: false, step: "join_service_not_configured" });
    expect(H.joins).toEqual([]);
  });
});

describe("IT IS THE JOIN AND NOTHING AFTER IT", () => {
  it("never probes, never transcribes, never writes a turn", async () => {
    const mod = await import("@/lib/stt/join-only");
    await mod.joinOnlyWindow("w1");
    const src = (await import("node:fs")).readFileSync("lib/stt/join-only.ts", "utf8");
    for (const forbidden of ["whisper", "probeSlice", "transcribe", "cue", "diariz"]) {
      expect(src.toLowerCase().split("\n").filter((l) => !l.trim().startsWith("*") && !l.trim().startsWith("//")).join("\n"))
        .not.toContain(forbidden);
    }
  });
});

describe("the listing takes the same decision as the joiner", () => {
  it("excludes transcript-disabled rooms unless asked, and returns no slugs", async () => {
    const { listCliplessWindows } = await import("@/lib/stt/join-only");
    await listCliplessWindows({ limit: 5 });
    expect(H.params[0]).toContain(false);
    expect(H.queries[0]).toMatch(/transcript_enabled\s*=\s*TRUE/i);
    expect(H.queries[0]).not.toMatch(/\bslug\b|\bname\b/i);
  });

  it("includes them when asked", async () => {
    const { listCliplessWindows } = await import("@/lib/stt/join-only");
    await listCliplessWindows({ limit: 5, includeTranscriptDisabled: true });
    expect(H.params[0]).toContain(true);
  });

  it("caps the limit so no caller can turn a listing into a bulk run", async () => {
    const { listCliplessWindows } = await import("@/lib/stt/join-only");
    await listCliplessWindows({ limit: 10_000 });
    expect(H.params[0]).toContain(200);
  });

  it("asks only for clipless closed windows that have a day", async () => {
    const { listCliplessWindows } = await import("@/lib/stt/join-only");
    await listCliplessWindows({ limit: 5 });
    expect(H.queries[0]).toMatch(/clip_r2_key IS NULL/i);
    expect(H.queries[0]).toMatch(/room_day_id IS NOT NULL/i);
  });
});

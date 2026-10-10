/**
 * S7-0 / S8A5 G57 — the blind pre-check in evaluateUnit is itself a guard, not a duplicate of the readers' own: with readers that do NOT guard (stubs that answer ok for anything) the
 * pre-check ALONE refuses a held-out pair, and the readers are never called. Removing the pre-check makes every case here fail.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const calls = vi.hoisted(() => ({ audio: 0, turns: 0, span: 0 }));
vi.mock("@/lib/db", () => ({ sql: async () => [] }));
vi.mock("@/lib/rubrics/readers", async (orig) => ({
  ...((await orig()) as object),
  // pair resolvers answer the held-out pair: 2026-09-13 in room_ux92qpws
  windowPair: async () => ({ room_id: "room_ux92qpws", ist_date: "2026-09-13" }),
  consultPair: async () => ({ room_id: "room_ux92qpws", ist_date: "2026-09-13" }),
  // readers WITHOUT any guard: they return data for anything
  readAudioHour: async () => { calls.audio += 1; return { ok: true, data: { room_id: "x", ist_date: "x", hour: 10, window_start_ms: 0, window_end_ms: 3_600_000, intervals: [{ state: "speech", start_ms: 0, end_ms: 3_000_000 }], samples: { n: 0, zero_ratio_mean: null, peak_max: null }, day: null } }; },
  readWindowTurns: async () => { calls.turns += 1; return { ok: true, data: { window_id: "w", room_day_id: "rd", start_ms: 0, end_ms: 60_000, diarize_state: "ok", attributed: 1, turns: [{ source_ref: "t", start_ms: 0, end_ms: 10_000, speaker_idx: 0, role: "clinician", overlap_ms: 10_000 }] } }; },
  readConsultSpan: async () => { calls.span += 1; return { ok: true, data: { consult_key: "c", room_id: "room_ux92qpws", t_open_ms: 0, t_close_ms: 60_000, ist_date: "2026-09-13", quality: "clean", attribution: "rows", windows: [] } }; },
}));

const { evaluateUnit } = await import("@/lib/rubrics/engines");
const { getRubric } = await import("@/lib/rubrics/registry");
beforeEach(() => { calls.audio = 0; calls.turns = 0; calls.span = 0; });

describe("a formerly held-out pair is read and scored like any day (rule lifted 10 Oct 2026)", () => {
  it("a room-hour on the pair: the audio reader is called and it is scored", async () => {
    const out = await evaluateUnit(getRubric("room_mic_quality")!, "room_hour", "room_ux92qpws:2026-09-13:10");
    expect(out.status).toBe("ok");
    expect(out).not.toMatchObject({ reason: "blind_room_day" });
    expect(calls.audio).toBe(1);
  });
  it("a window whose room-day is the pair: the turns reader is called", async () => {
    const out = await evaluateUnit(getRubric("talk_time")!, "window", "w_any");
    expect(out).not.toMatchObject({ reason: "blind_room_day" });
    expect(calls.turns).toBeGreaterThan(0);
  });
  it("a consult on the pair: the span reader is called", async () => {
    const out = await evaluateUnit(getRubric("talk_time")!, "consult", "enc@m");
    expect(out).not.toMatchObject({ reason: "blind_room_day" });
    expect(calls.span).toBeGreaterThan(0);
  });
  it("control: a nearby day (09-17) of the same room behaves the same way", async () => {
    const out = await evaluateUnit(getRubric("room_mic_quality")!, "room_hour", "room_ux92qpws:2026-09-17:10");
    expect(out.status).toBe("ok");
    expect(calls.audio).toBe(1);
  });
});

/**
 * S7-0-R3 (G53) — only an ENGINE fault becomes a failed unit. The pure engine throws here; the reads around it work (a fake sql answers the audio-state queries).
 */
import { describe, it, expect, vi } from "vitest";

vi.mock("@/lib/db", () => ({
  sql: async (strs: TemplateStringsArray) => {
    const t = strs.join("?");
    if (/FROM room_audio_state/.test(t)) return [{ state: "speech", ts_start: "2026-10-08T04:30:00Z", ts_end: "2026-10-08T05:20:00Z" }];
    if (/FROM bench_level_sample/.test(t)) return [{ n: 0, z: null, pk: null }];
    return [];
  },
}));
vi.mock("@/lib/rubrics/engines/room-mic-quality", () => ({ evaluateRoomMicQuality: () => { throw new Error("boom"); }, MIC_FLAGS: {} }));

describe("engine faults versus infrastructure errors", () => {
  it("an exception inside the pure engine is a failed unit (engine_error) WITH its room and date; nothing else is caught", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const { evaluateUnit } = await import("@/lib/rubrics/engines");
    const { getRubric } = await import("@/lib/rubrics/registry");
    const out = await evaluateUnit(getRubric("room_mic_quality")!, "room_hour", "r1:2026-10-08:10");
    expect(out).toMatchObject({ status: "failed", reason: "engine_error", room_id: "r1", ist_date: "2026-10-08" });
  });
  it("a unit whose room or date cannot be resolved has null room and date (the caller writes no row)", async () => {
    const { evaluateUnit } = await import("@/lib/rubrics/engines");
    const { getRubric } = await import("@/lib/rubrics/registry");
    expect(await evaluateUnit(getRubric("room_mic_quality")!, "room_hour", "not a key")).toMatchObject({ status: "skipped", reason: "bad_unit_key", room_id: null, ist_date: null });
    expect(await evaluateUnit(getRubric("talk_time")!, "window", "nope")).toMatchObject({ status: "skipped", reason: "not_found", room_id: null, ist_date: null });
  });
  it("a database error from the resolver propagates (it is not converted into a unit outcome)", async () => {
    vi.resetModules();
    vi.doMock("@/lib/db", () => ({ sql: async () => { throw new Error("db down"); } }));
    const { evaluateUnit } = await import("@/lib/rubrics/engines");
    const { getRubric } = await import("@/lib/rubrics/registry");
    await expect(evaluateUnit(getRubric("talk_time")!, "window", "w1")).rejects.toThrow("db down");
  });
});

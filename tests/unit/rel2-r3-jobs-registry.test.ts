/**
 * REL2-R3 K3-2 — the registry refuses a job kind that reads room data without a held-out guard, and every registered kind has answered.
 */
import { describe, it, expect, vi } from "vitest";
vi.mock("@/lib/db", () => ({ sql: Object.assign(async () => [], { transaction: async () => [] }) }));

const { JOB_KINDS, assertHeldOutDeclared } = await import("@/lib/jobs/kinds");

const EXPECT: Record<string, boolean> = {
  transcribe_range: true, stitch: true, route_transcribe: true, room_window: true, diarize_window: true, emotion_window: true, jev_english: true, jev_window: true, jev_role: true,
  sarvam_transcribe: true, sarvam_translate: true, rubric_run: true, rubric_bench: false, audio_measure: true, stt_fanout: true, day_manifest: true,
};

describe("K3-2 the job-kind registry", () => {
  it("lists every kind and whether it reads room data; a room-data kind has a guard, a kind that does not says why", () => {
    expect(Object.fromEntries(JOB_KINDS.map((k) => [k.name, k.roomData]))).toEqual(EXPECT);
    for (const k of JOB_KINDS) {
      if (k.roomData) expect(typeof k.heldOut, k.name).toBe("function");
      else expect((k.roomDataNote ?? "").length, k.name).toBeGreaterThan(10);
    }
  });
  it("refuses a kind that reads room data and declares no guard, one that has not answered, and a 'no room data' kind with no reason", () => {
    const base = { name: "x_kind", first: "a", scope: "invoke" as const, parseArgs: () => ({}), run: async () => ({ kind: "fail" as const, error: "x" }) };
    expect(() => assertHeldOutDeclared([{ ...base, roomData: true } as never])).toThrow(/reads room data and declares no heldOut/);
    expect(() => assertHeldOutDeclared([{ ...base } as never])).toThrow(/must declare roomData/);
    expect(() => assertHeldOutDeclared([{ ...base, roomData: false } as never])).toThrow(/roomDataNote/);
    expect(() => assertHeldOutDeclared([{ ...base, roomData: true, heldOut: async () => null } as never])).not.toThrow();
    expect(() => assertHeldOutDeclared([{ ...base, roomData: false, roomDataNote: "reads a lab set, not room data" } as never])).not.toThrow();
    expect(() => assertHeldOutDeclared(JOB_KINDS)).not.toThrow();
  });
});

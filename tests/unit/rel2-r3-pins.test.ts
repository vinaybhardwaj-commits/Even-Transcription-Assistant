/**
 * REL2-R3 K4 — two pins the refuter found surviving: (1) the registry's assertion runs AT LOAD (not only when a test calls it); (2) windowBlindAny is part of windowHeldOut itself.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

type Row = Record<string, unknown>;
let answer: (text: string) => Row[] = () => [];
vi.mock("@/lib/db", () => ({ sql: Object.assign((s: TemplateStringsArray) => Promise.resolve(answer(s.join("?").replace(/\s+/g, " "))), { transaction: async () => [] }) }));

beforeEach(() => { answer = () => []; });

describe("K4 pins", () => {
  it("the kinds registry throws AT LOAD for a room-data kind with no guard (a bad kind in the stub list stops the import)", async () => {
    vi.resetModules();
    vi.doMock("@/lib/jobs/kinds/stubs", () => ({ STUB_KINDS: [{ name: "bad_room_kind", first: "a", scope: "invoke", parseArgs: () => ({}), run: async () => ({ kind: "fail", error: "x" }), roomData: true }] }));
    await expect(import("@/lib/jobs/kinds")).rejects.toThrow(/bad_room_kind.*reads room data and declares no heldOut/);
    vi.doUnmock("@/lib/jobs/kinds/stubs");
    vi.resetModules();
    await expect(import("@/lib/jobs/kinds")).resolves.toBeTruthy();
  });
  it("windowHeldOut itself checks windowBlindAny: a window whose session span and session windows look clean but which has a held-out placement is blind_room_day", async () => {
    const { windowHeldOut } = await import("@/lib/room-access/jobs");
    answer = (t) => {
      if (/FROM bench_window WHERE id/.test(t)) return [{ session_id: "bs_1", start_ms: 1, end_ms: 2 }];
      if (/SELECT \( EXISTS/.test(t)) return [{ blind: true }];
      if (/FROM bench_session s WHERE s\.id/.test(t)) return [{ room_id: "r_clean", started_ms: 0, last_ms: 1, window_blind: false }];
      return [];
    };
    expect(await windowHeldOut("bw_1")).toBe("blind_room_day");
    answer = (t) => (/FROM bench_window WHERE id/.test(t) ? [{ session_id: "bs_1", start_ms: 1, end_ms: 2 }] : /FROM bench_session s WHERE s\.id/.test(t) ? [{ room_id: "r_clean", started_ms: 0, last_ms: 1, window_blind: false }] : /SELECT \( EXISTS/.test(t) ? [{ blind: false }] : []);
    expect(await windowHeldOut("bw_1")).toBe(null);
  });
});

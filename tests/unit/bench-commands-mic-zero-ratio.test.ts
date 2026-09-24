/**
 * The command-poll route's LEVEL PAIR — the zero ratio the Mac sends must reach the level log (24 Sep 2026; root cause eta-refuter #1346, symptom herdr-kit #1341).
 *
 * The Mac sends `mic_peak`/`mic_avg` (its primary levels) AND its install fields in ONE request, and the install fields' zero ratio is the UNPREFIXED `zero_ratio`. The route took the
 * `mic_peak` branch and read `mic_zero_ratio`, which the Mac never sends, so the Mac's exact-zero ratio was dropped: 264,283 capturing level-log rows over two clinic days, none with a
 * zero_ratio, in every room. These tests run the REAL cleanLevels through the REAL route and assert the `mic` object handed to the write, for every shape of poll.
 */
import { describe, it, expect, vi } from "vitest";

type PollInput = { mic?: { peak: number; avg: number | null; zeroRatio?: number } | null };
let last: PollInput | null = null;

vi.mock("@/lib/db", () => ({ sql: async () => [] }));
// The REAL cleanLevels (and everything else in the module) runs; only the write is replaced so the test can read the `mic` object that reaches it.
vi.mock("@/lib/bench-commands", async () => {
  const actual = await vi.importActual<typeof import("@/lib/bench-commands")>("@/lib/bench-commands");
  return {
    ...actual,
    pollCommands: async (input: PollInput) => { last = input; return { now: "2026-09-24T10:00:00.000Z", superseded: false, commands: [] }; },
  };
});
vi.mock("@/lib/room-auth", () => ({ readRoomClaims: async () => ({ room_id: "room_1" }) }));

const { GET } = await import("@/app/api/bench/commands/route");

const mic = async (query: Record<string, string>) => {
  last = null;
  const url = new URL("https://www.evenscribe.app/api/bench/commands");
  url.searchParams.set("tab_id", "app_install_test");
  for (const [k, v] of Object.entries(query)) url.searchParams.set(k, v);
  const res = await GET({ nextUrl: url } as unknown as Parameters<typeof GET>[0]);
  expect(res.status).toBe(200);
  return last!.mic ?? null;
};

describe("the level pair the route hands to the write", () => {
  it("THE MAC: mic_peak + mic_avg + the UNPREFIXED zero_ratio → the zero ratio is KEPT (this was dropped)", async () => {
    expect(await mic({ mic_peak: "0.31", mic_avg: "0.05", zero_ratio: "0.4576" })).toEqual({ peak: 0.31, avg: 0.05, zeroRatio: 0.4576 });
  });

  it("the Mac's exact-zero tape (zero_ratio 1) is kept as 1, the value the alarm exists to see", async () => {
    expect(await mic({ mic_peak: "0", mic_avg: "0", zero_ratio: "1" })).toEqual({ peak: 0, avg: 0, zeroRatio: 1 });
  });

  it("the BROWSER kiosk: mic_peak + mic_avg + mic_zero_ratio → unchanged", async () => {
    expect(await mic({ mic_peak: "0.2", mic_avg: "0.1", mic_zero_ratio: "0.9" })).toEqual({ peak: 0.2, avg: 0.1, zeroRatio: 0.9 });
  });

  it("when BOTH are present, the prefixed mic_zero_ratio wins (nothing that worked changes)", async () => {
    expect(await mic({ mic_peak: "0.2", mic_avg: "0.1", mic_zero_ratio: "0.9", zero_ratio: "0.2" })).toEqual({ peak: 0.2, avg: 0.1, zeroRatio: 0.9 });
  });

  it("a NATIVE-only poll (peak + zero_ratio, no mic_peak) is unchanged", async () => {
    expect(await mic({ peak: "0.4", mic_avg: "0.2", zero_ratio: "0.3" })).toEqual({ peak: 0.4, avg: 0.2, zeroRatio: 0.3 });
  });

  it("no zero ratio anywhere: the pair is exactly what it was, with no zeroRatio key", async () => {
    expect(await mic({ mic_peak: "0.2", mic_avg: "0.1" })).toEqual({ peak: 0.2, avg: 0.1 });
  });

  it("a GARBAGE unprefixed zero_ratio costs ONLY the ratio, never the peak and avg that were fine", async () => {
    for (const bad of ["1.5", "-0.1", "abc", "", "NaN", "Infinity"]) {
      expect(await mic({ mic_peak: "0.2", mic_avg: "0.1", zero_ratio: bad }), bad).toEqual({ peak: 0.2, avg: 0.1 });
    }
  });

  it("a garbage PREFIXED mic_zero_ratio still drops the whole pair, exactly as before (unchanged behaviour)", async () => {
    expect(await mic({ mic_peak: "0.2", mic_avg: "0.1", mic_zero_ratio: "1.5" })).toBeNull();
  });

  it("the unprefixed zero_ratio is NEVER read without a valid mic pair: no mic_peak and no peak means no reading at all", async () => {
    expect(await mic({ zero_ratio: "0.9" })).toBeNull();
    expect(await mic({ mic_avg: "0.1", zero_ratio: "0.9" })).toBeNull();
  });

  it("an invalid mic pair stays invalid whatever the ratio says", async () => {
    expect(await mic({ mic_peak: "2", mic_avg: "0.1", zero_ratio: "0.9" })).toBeNull();
  });
});

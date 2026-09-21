/**
 * The two processing switches — moved out of the environment and onto the room.
 *
 * WHAT WAS WRONG. `ROOM_STT_DRAIN_ENABLED` and `FUSE_LIVE_ENABLED` were environment variables
 * holding a comma-separated list of room ids, and Vercel bakes environment variables into a
 * build. So turning processing off DURING A CLINIC required a redeploy. The only instant switch
 * was `room.disabled_at`, which stops the room entirely including its recording — a hammer, not
 * a dial. And `fuseLiveFlagState()` was exported and called by nothing, so the fuse flag's state
 * could not be read from a running system at all.
 *
 * This holds the five things that must stay true now that they are columns:
 *
 *   1. BOTH VARIABLES ARE GONE FROM THE CODE, not ignored. A dead variable that still changes
 *      behaviour is how a stale RERANK_BACKEND routed production wrongly for seven days.
 *   2. All eight call sites read the room.
 *   3. The cache window is ONE named exported constant, at most 5 seconds — because "takes
 *      effect within seconds" should be a number in one place, not an assumption in five.
 *   4. Nothing snapshots the value at module scope. That is the mistake being undone.
 *   5. A failed read fails CLOSED and does not poison the cache.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";

type Row = { transcript_enabled: boolean; visits_enabled: boolean };
let rows: Row[] = [];
let queries = 0;
let throwNext = false;

vi.mock("@/lib/db", () => ({
  sql: () => {
    queries++;
    if (throwNext) return Promise.reject(new Error("connection terminated"));
    return Promise.resolve(rows);
  },
}));

const {
  readRoomSwitches, isTranscriptEnabled, isVisitsEnabled, invalidateRoomSwitches,
  __resetRoomSwitchCache, ROOM_SWITCH_CACHE_MS, LANE_COLUMN, LANE_LABEL, LANES, isLane, SWITCHES_OFF,
} = await import("@/lib/room-switches");

beforeEach(() => {
  __resetRoomSwitchCache();
  rows = [{ transcript_enabled: true, visits_enabled: true }];
  queries = 0;
  throwNext = false;
});
afterEach(() => vi.restoreAllMocks());

describe("the switch is read from the room, per room", () => {
  it("reads both lanes off one row", async () => {
    rows = [{ transcript_enabled: true, visits_enabled: false }];
    expect(await readRoomSwitches("room_a")).toEqual({ transcript_enabled: true, visits_enabled: false });
    expect(await isTranscriptEnabled("room_a")).toBe(true);
    expect(await isVisitsEnabled("room_a")).toBe(false);
  });

  it("an unknown room is off, and is not an error", async () => {
    rows = [];
    expect(await readRoomSwitches("room_ghost")).toEqual(SWITCHES_OFF);
  });

  it("an empty room id is off without touching the database", async () => {
    expect(await readRoomSwitches("")).toEqual(SWITCHES_OFF);
    expect(queries).toBe(0);
  });

  it("rooms do not share an answer — there is no value that opens every room at once", async () => {
    rows = [{ transcript_enabled: true, visits_enabled: true }];
    await readRoomSwitches("room_a");
    rows = [{ transcript_enabled: false, visits_enabled: false }];
    expect(await readRoomSwitches("room_b")).toEqual(SWITCHES_OFF);
    // and room_a still reads its own cached answer, not room_b's
    expect(await readRoomSwitches("room_a")).toEqual({ transcript_enabled: true, visits_enabled: true });
  });
});

describe("the cache is bounded, named, and expires", () => {
  it("the window is a single exported constant of at most 5 seconds", () => {
    expect(ROOM_SWITCH_CACHE_MS).toBeLessThanOrEqual(5_000);
    const src = readFileSync("lib/room-switches.ts", "utf8");
    expect(src.match(/export const ROOM_SWITCH_CACHE_MS/g) ?? []).toHaveLength(1);
    // and nothing else in the tree invents a second window for the same promise
    const others = execFileSync("git", ["grep", "-l", "ROOM_SWITCH_CACHE_MS", "--", "lib", "app"], { encoding: "utf8" })
      .trim().split("\n").filter(Boolean);
    expect(others).toContain("lib/room-switches.ts");
  });

  it("a second read inside the window does not hit the database", async () => {
    await readRoomSwitches("room_a", 1_000);
    await readRoomSwitches("room_a", 1_000 + ROOM_SWITCH_CACHE_MS - 1);
    expect(queries).toBe(1);
  });

  it("a read past the window re-reads the row, and picks up the new value", async () => {
    await readRoomSwitches("room_a", 1_000);
    rows = [{ transcript_enabled: false, visits_enabled: false }];
    const after = await readRoomSwitches("room_a", 1_000 + ROOM_SWITCH_CACHE_MS);
    expect(queries).toBe(2);
    expect(after).toEqual(SWITCHES_OFF);
  });

  it("invalidating makes the operator's own tap instant", async () => {
    await readRoomSwitches("room_a", 1_000);
    rows = [{ transcript_enabled: false, visits_enabled: false }];
    invalidateRoomSwitches("room_a");
    expect(await readRoomSwitches("room_a", 1_001)).toEqual(SWITCHES_OFF);
  });

  it("invalidating with no argument clears every room — what stop-all needs", async () => {
    await readRoomSwitches("room_a", 1_000);
    await readRoomSwitches("room_b", 1_000);
    queries = 0;
    invalidateRoomSwitches();
    await readRoomSwitches("room_a", 1_001);
    await readRoomSwitches("room_b", 1_001);
    expect(queries).toBe(2);
  });
});

describe("a failed read fails closed and does not poison the cache", () => {
  it("returns off, and the NEXT call retries rather than inheriting the guess", async () => {
    throwNext = true;
    expect(await readRoomSwitches("room_a", 1_000)).toEqual(SWITCHES_OFF);
    throwNext = false;
    rows = [{ transcript_enabled: true, visits_enabled: true }];
    // same instant — a cached failure would have held the room off for the whole window
    expect(await readRoomSwitches("room_a", 1_000)).toEqual({ transcript_enabled: true, visits_enabled: true });
  });
});

describe("the environment variables are GONE, not ignored", () => {
  const tracked = execFileSync("git", ["ls-files", "lib", "app", "components", "db"], { encoding: "utf8" })
    .trim().split("\n").filter((f) => /\.(ts|tsx)$/.test(f));

  it("no file reads either variable from process.env", () => {
    for (const f of tracked) {
      const src = readFileSync(f, "utf8");
      expect(src, f).not.toMatch(/process\.env[.[]\s*["']?(ROOM_STT_DRAIN_ENABLED|FUSE_LIVE_ENABLED)/);
    }
  });

  it("both flag modules are deleted", () => {
    const all = execFileSync("git", ["ls-files"], { encoding: "utf8" });
    expect(all).not.toContain("lib/stt/room-drain-flag.ts");
    expect(all).not.toContain("lib/brain/fuse/live-flag.ts");
  });

  it("the old accessors no longer exist anywhere", () => {
    for (const f of tracked) {
      const src = readFileSync(f, "utf8");
      expect(src, f).not.toMatch(/\bisRoomDrainEnabled\s*\(|\bisFuseLiveEnabled\s*\(|\broomDrainFlagState\s*\(|\bfuseLiveFlagState\s*\(/);
    }
  });
});

describe("all ten call sites read the room", () => {
  /** PRD §5.2, by file. The count is asserted so an eleventh cannot appear unnoticed.
   *  Build 3 §2.1 adds the ninth: drainRoomWaitingWindows re-reads the switch per piece (HAZARD 3),
   *  so one enabled room's waiting batch never carries a disabled room's audio through.
   *
   *  THE TENTH is `lib/stt/join-only.ts`, and it is deliberately not routed through an existing
   *  site. It asks the same room question every other site asks — may this room be turned into
   *  words — but it is the ONE site allowed to be overruled, by an explicit
   *  `includeTranscriptDisabled` parameter, because producing a clip is joining audio and not
   *  transcribing it. Folding it into another site would hide that exception inside a guard whose
   *  whole purpose is to have none. It is counted here instead, in the open.
   *
   *  This census is `git grep`, so it sees TRACKED files only: a new call site is invisible until
   *  it is committed. Run the gate after staging, not before. */
  const EXPECTED: Record<string, number> = {
    "lib/stt/room-drain.ts": 3,
    "lib/bench-window.ts": 1,
    "app/api/brain/cues/route.ts": 2,
    "app/api/admin/bench/drain/route.ts": 1,
    "lib/brain/fuse/live.ts": 2,
    "lib/stt/join-only.ts": 1,
  };

  it("every guard calls the room reader, and there are exactly ten", () => {
    const hits = execFileSync(
      "git", ["grep", "-n", "-E", "isTranscriptEnabled\\(|isVisitsEnabled\\(|readRoomSwitches\\(", "--", "lib", "app"],
      { encoding: "utf8" },
    ).trim().split("\n").filter(Boolean)
      .filter((l) => !l.startsWith("lib/room-switches.ts:"))
      .filter((l) => !/^\S+:\d+:\s*(import|\s*\*)/.test(l));
    const byFile: Record<string, number> = {};
    for (const h of hits) {
      const f = h.split(":")[0]!;
      byFile[f] = (byFile[f] ?? 0) + 1;
    }
    expect(byFile).toEqual(EXPECTED);
    expect(Object.values(byFile).reduce((a, b) => a + b, 0)).toBe(10);
  });

  it("nothing snapshots a switch at module scope — the mistake being undone", () => {
    for (const f of Object.keys(EXPECTED)) {
      const src = readFileSync(f, "utf8");
      expect(src, f).not.toMatch(/^const\s+\w+\s*=\s*await\s+(isTranscriptEnabled|isVisitsEnabled|readRoomSwitches)/m);
    }
  });

  it("every guard is awaited — an un-awaited Promise is always truthy and would open the room", () => {
    for (const f of Object.keys(EXPECTED)) {
      const src = readFileSync(f, "utf8");
      for (const line of src.split("\n")) {
        if (!/isTranscriptEnabled\(|isVisitsEnabled\(/.test(line)) continue;
        if (/^\s*(import|\*|\/\/)/.test(line.trimStart()) || line.includes("//")) continue;
        expect(line, `${f}: ${line.trim()}`).toMatch(/await/);
      }
    }
  });
});

describe("the lane vocabulary is defined once", () => {
  it("two lanes, in the operator's words", () => {
    expect(LANES).toEqual(["transcript", "visits"]);
    expect(LANE_LABEL).toEqual({ transcript: "Transcript", visits: "Visits" });
    expect(LANE_COLUMN).toEqual({ transcript: "transcript_enabled", visits: "visits_enabled" });
  });
  it("isLane refuses anything else", () => {
    expect(isLane("transcript")).toBe(true);
    expect(isLane("drain")).toBe(false);
    expect(isLane("fuse")).toBe(false);
    expect(isLane(1)).toBe(false);
  });
});

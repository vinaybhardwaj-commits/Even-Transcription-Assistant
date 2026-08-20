/**
 * Room Bench remount resume — the pure resume test (ETA-REMOUNT-RESUME PRD v1.0 §3.2,
 * 20 Aug 2026; MCP PRD §8.5 rev 3e). decideResume in lib/bench-resume-core; window and
 * IST calendar imported from the reaper's core, never re-declared.
 *
 * Addendum 2 (FU2): the ordered handover between two tabs — decideHandoverPending against
 * the command bus's own LISTENER_FRESH_MS, hasHandoverCompleted against `since`,
 * decideHandoverWait bounded by ACK_WAIT_MS, and the number-disjointness proof through
 * nextIdxFromMax + seedStartIdx (the same functions the route and the kiosk run).
 */
import { describe, it, expect } from "vitest";
import { STALLED_BADGE_MINUTES } from "../../lib/bench-reaper-core";
import { ACK_WAIT_MS, LISTENER_FRESH_MS } from "../../lib/bench-commands";
import {
  decideHandoverPending,
  decideHandoverWait,
  decideResume,
  hasHandoverCompleted,
  nextIdxFromMax,
  seedStartIdx,
} from "../../lib/bench-resume-core";

const NOW = Date.parse("2026-08-20T12:00:00.000Z");   // 17:30 IST, 20 Aug
const min = (n: number) => n * 60_000;
const iso = (t: number) => new Date(t).toISOString();

describe("decideResume — rule 1: nothing to rejoin", () => {
  it("no candidate → not resumable, reason none", () => {
    expect(decideResume(null, NOW)).toEqual({ resumable: false, reason: "none" });
    expect(decideResume(undefined, NOW)).toEqual({ resumable: false, reason: "none" });
    expect(decideResume({ id: "", status: "recording", started_at: iso(NOW - min(5)) }, NOW)).toEqual({ resumable: false, reason: "none" });
  });
  it("ended → not resumable, reason ended", () => {
    expect(decideResume({ id: "bs_1", status: "ended", started_at: iso(NOW - min(60)) }, NOW)).toEqual({ resumable: false, reason: "ended" });
  });
});

describe("decideResume — rule 2: day rollover (IST)", () => {
  it("a session started yesterday IST → previous_day, even with a fresh chunk", () => {
    expect(decideResume({ id: "bs_y", status: "recording", started_at: "2026-08-19T04:30:00.000Z", last_primary_at: iso(NOW - min(1)) }, NOW))
      .toEqual({ resumable: false, reason: "previous_day" });
  });
  it("the 18:30 UTC boundary is exact: 18:29:59Z on the 19th = yesterday IST → previous_day; 18:30:00Z = today IST → resumable (recording, fresh)", () => {
    expect(decideResume({ id: "b1", status: "recording", started_at: "2026-08-19T18:29:59.000Z", last_primary_at: iso(NOW - min(1)) }, NOW))
      .toEqual({ resumable: false, reason: "previous_day" });
    expect(decideResume({ id: "b2", status: "recording", started_at: "2026-08-19T18:30:00.000Z", last_primary_at: iso(NOW - min(1)) }, NOW))
      .toEqual({ resumable: true, reason: "ok" });
  });
  it("an unparseable started_at degrades to previous_day, never a throw", () => {
    expect(decideResume({ id: "bs_j", status: "recording", started_at: "junk" }, NOW)).toEqual({ resumable: false, reason: "previous_day" });
  });
});

describe("decideResume — rule 3: paused has NO time test (D5)", () => {
  it("paused 12 minutes with the newest chunk 12 minutes old → resumable (a consent pause outlasting the badge window is normal)", () => {
    expect(decideResume({ id: "bs_p", status: "paused", started_at: iso(NOW - min(120)), last_primary_at: iso(NOW - min(12)) }, NOW))
      .toEqual({ resumable: true, reason: "ok" });
  });
  it("paused for hours, today → still resumable; only the day rollover ends it", () => {
    expect(decideResume({ id: "bs_p2", status: "paused", started_at: iso(NOW - min(300)), last_primary_at: iso(NOW - min(240)) }, NOW))
      .toEqual({ resumable: true, reason: "ok" });
  });
});

describe("decideResume — rule 4: recording against the reaper's own window", () => {
  it("newest chunk under the window → resumable; over it → stalled (window = STALLED_BADGE_MINUTES, imported)", () => {
    const under = NOW - min(STALLED_BADGE_MINUTES) + 1_000;
    const over = NOW - min(STALLED_BADGE_MINUTES) - 1_000;
    expect(decideResume({ id: "bs_u", status: "recording", started_at: iso(NOW - min(120)), last_primary_at: iso(under) }, NOW))
      .toEqual({ resumable: true, reason: "ok" });
    expect(decideResume({ id: "bs_o", status: "recording", started_at: iso(NOW - min(120)), last_primary_at: iso(over) }, NOW))
      .toEqual({ resumable: false, reason: "stalled" });
  });
  it("the newest chunk spans BOTH streams: primary stale but a backup chunk 2 min ago keeps it resumable", () => {
    expect(decideResume({ id: "bs_b", status: "recording", started_at: iso(NOW - min(120)), last_primary_at: iso(NOW - min(31)), last_backup_at: iso(NOW - min(2)) }, NOW))
      .toEqual({ resumable: true, reason: "ok" });
  });
  it("no chunks at all: started_at is the fallback — 5 min old → resumable, 11 min old → stalled", () => {
    expect(decideResume({ id: "bs_n", status: "recording", started_at: iso(NOW - min(5)) }, NOW)).toEqual({ resumable: true, reason: "ok" });
    expect(decideResume({ id: "bs_n2", status: "recording", started_at: iso(NOW - min(11)) }, NOW)).toEqual({ resumable: false, reason: "stalled" });
  });
});

describe("decideResume — no second window", () => {
  it("the boundary moves with STALLED_BADGE_MINUTES itself (exactly at the window is NOT stalled — strictly older trips, same comparison as the reaper)", () => {
    const atWindow = NOW - min(STALLED_BADGE_MINUTES);
    expect(decideResume({ id: "bs_e", status: "recording", started_at: iso(NOW - min(120)), last_primary_at: iso(atWindow) }, NOW))
      .toEqual({ resumable: true, reason: "ok" });
  });
});

describe("FU2a — decideHandoverPending: wait only for a LIVE different tab", () => {
  it("a different tab whose poll is within LISTENER_FRESH_MS → true", () => {
    expect(decideHandoverPending({ tab_id: "tab_old", last_poll_at: iso(NOW - LISTENER_FRESH_MS + 1_000) }, "tab_new", NOW)).toBe(true);
    expect(decideHandoverPending({ tab_id: "tab_old", last_poll_at: iso(NOW - LISTENER_FRESH_MS) }, "tab_new", NOW)).toBe(true); // exactly at the window is still fresh
  });
  it("a stale tab → false (a crashed tab stops polling and never asks anyone to wait)", () => {
    expect(decideHandoverPending({ tab_id: "tab_old", last_poll_at: iso(NOW - LISTENER_FRESH_MS - 1_000) }, "tab_new", NOW)).toBe(false);
  });
  it("the same tab → false; no listener → false; junk poll time → false", () => {
    expect(decideHandoverPending({ tab_id: "tab_new", last_poll_at: iso(NOW - 1_000) }, "tab_new", NOW)).toBe(false);
    expect(decideHandoverPending(null, "tab_new", NOW)).toBe(false);
    expect(decideHandoverPending(undefined, "tab_new", NOW)).toBe(false);
    expect(decideHandoverPending({ tab_id: "tab_old", last_poll_at: "junk" }, "tab_new", NOW)).toBe(false);
  });
});

describe("FU2d — hasHandoverCompleted: the wait ends at or after `since`", () => {
  it("an event at `since` or later ends the wait; earlier or absent does not", () => {
    expect(hasHandoverCompleted(iso(NOW), NOW)).toBe(true);
    expect(hasHandoverCompleted(iso(NOW + 3_000), NOW)).toBe(true);
    expect(hasHandoverCompleted(iso(NOW - 1), NOW)).toBe(false);
    expect(hasHandoverCompleted(null, NOW)).toBe(false);
    expect(hasHandoverCompleted("junk", NOW)).toBe(false);
  });
});

describe("FU2c — decideHandoverWait: a start decision, never a hang", () => {
  it("no live handover, or a completed one → start at once", () => {
    expect(decideHandoverWait({ handoverPending: false, handoverComplete: false, waitedMs: 0 })).toBe("start");
    expect(decideHandoverWait({ handoverPending: true, handoverComplete: true, waitedMs: 0 })).toBe("start");
  });
  it("pending and incomplete → wait, but never past ACK_WAIT_MS (the bus's own window, imported)", () => {
    expect(decideHandoverWait({ handoverPending: true, handoverComplete: false, waitedMs: ACK_WAIT_MS - 1 })).toBe("wait");
    expect(decideHandoverWait({ handoverPending: true, handoverComplete: false, waitedMs: ACK_WAIT_MS })).toBe("timeout_start");
    expect(decideHandoverWait({ handoverPending: true, handoverComplete: false, waitedMs: ACK_WAIT_MS * 10 })).toBe("timeout_start");
  });
  it("every input yields a decision that is not an unbounded wait once waitedMs reaches the cap", () => {
    for (const handoverPending of [true, false]) {
      for (const handoverComplete of [true, false]) {
        expect(decideHandoverWait({ handoverPending, handoverComplete, waitedMs: ACK_WAIT_MS })).not.toBe("wait");
      }
    }
  });
});

describe("FU2 — two tabs cannot be issued the same starting number once the handover completes", () => {
  it("after the losing tab's flush, the server holds its numbers, so the winner starts strictly past them", () => {
    const oldTabLast = 87; // the losing tab used 0..87 and uploaded them (handover complete)
    const serverNext = nextIdxFromMax(oldTabLast); // the fresh answer's next_idx
    expect(serverNext).toBe(88);
    // the shared local queue can hold at most the losing tab's own numbers
    for (const localMax of [-1, 0, 40, 87]) {
      const seed = seedStartIdx(serverNext, localMax);
      expect(seed).toBe(88);
      expect(seed).toBeGreaterThan(oldTabLast);
    }
    // an unsent local chunk AHEAD of the server pushes further forward, never backwards
    expect(seedStartIdx(serverNext, 88)).toBe(89);
  });
  it("a stream with no chunk at all starts at 0; junk inputs degrade to 0, never negative", () => {
    expect(nextIdxFromMax(null)).toBe(0);
    expect(nextIdxFromMax(undefined)).toBe(0);
    expect(nextIdxFromMax("")).toBe(0);
    expect(nextIdxFromMax("41")).toBe(42); // pg drivers may hand MAX() back as text
    expect(seedStartIdx(0, -1)).toBe(0);
    expect(seedStartIdx(Number.NaN, Number.NaN)).toBe(0);
  });
});

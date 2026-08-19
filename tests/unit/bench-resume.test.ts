/**
 * Room Bench remount resume — the pure resume test (ETA-REMOUNT-RESUME PRD v1.0 §3.2,
 * 20 Aug 2026; MCP PRD §8.5 rev 3e). decideResume in lib/bench-resume-core; window and
 * IST calendar imported from the reaper's core, never re-declared.
 */
import { describe, it, expect } from "vitest";
import { STALLED_BADGE_MINUTES } from "../../lib/bench-reaper-core";
import { decideResume } from "../../lib/bench-resume-core";

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

/**
 * Room watchdog — `recovered` needs EVIDENCE OF AUDIO while a session is open; a room with no session closes QUIETLY
 * (fleet-attention build, 5 Oct 2026; Refuter fix F4).
 *
 * The fact being fixed: at 04:36 on 5 Oct the watchdog announced `recovered` for rooms whose Macs were still in DarkWake with frozen microphones.
 * The old rule read a room `ok` as soon as its poll looked clean, and a session that CLOSES looks clean (`session_open` false → no `tape_stalled`).
 *   - A session is OPEN: a recovery needs a bench chunk newer than the alert AND >= 2 distinct level values in the last 120 s; otherwise the alert
 *     stays open (no write, no message).
 *   - NO session is open and the poll is clean: there is no tape to prove anything about, so the alert is closed QUIETLY (state write to ok, no
 *     message, no outbox row, no "recovered" text). Otherwise a room closed for the day would stay offline/degraded forever and its NEXT outage
 *     could never alert, because alerts are edge-triggered.
 *
 * Pure planner only; the evidence SELECT (loadRecoveryEvidence) is covered in fleet-attention-sql.test.ts.
 */
import { describe, it, expect } from "vitest";
import {
  planWatchdogRun,
  isGenuineRecovery,
  GENUINE_RECOVERY_MIN_DISTINCT,
  RECOVERY_MIN_LIVE_SAMPLES,
  type RoomRunInput,
  type RoomPollFacts,
  type RecoveryEvidence,
} from "@/lib/room-watchdog";

const ist = (s: string): number => Date.parse(`${s.replace(" ", "T")}+05:30`);
const NOW = ist("2026-10-05 04:36:00");
const iso = (s: string) => new Date(ist(s)).toISOString();

/** A closed session / a Mac with nothing open: perfectly clean, no tape to speak of. */
const cleanPoll = (): RoomPollFacts => ({
  last_seen_at: new Date(NOW - 5_000).toISOString(),
  tape_advancing: false,
  session_open: false,
  disk_free_bytes: 50_000_000_000,
  state_flags: [],
  open_session: null,
});

/** A session is open and the poll reads clean (tape advancing per the poll): the case where a clean poll must NOT be taken as proof. */
const openPoll = (): RoomPollFacts => ({ ...cleanPoll(), tape_advancing: true, session_open: true });

const input = (over: Partial<RoomRunInput> = {}): RoomRunInput => ({
  room_id: "room_opd6",
  room_name: "OPD 6",
  facts: openPoll(),
  prior: { status: "degraded", since: iso("2026-10-05 01:37:00") },
  muted: false,
  ...over,
});

const ev = (chunk_after_alert: boolean, distinct_levels: number): RecoveryEvidence => ({ chunk_after_alert, distinct_levels });

describe("isGenuineRecovery", () => {
  it("needs a chunk after the alert AND at least two distinct level values", () => {
    expect(GENUINE_RECOVERY_MIN_DISTINCT).toBe(2);
    expect(isGenuineRecovery(ev(true, 2))).toBe(true);
    expect(isGenuineRecovery(ev(true, 48))).toBe(true);
    expect(isGenuineRecovery(ev(true, 1))).toBe(false);
    expect(isGenuineRecovery(ev(true, 0))).toBe(false);
    expect(isGenuineRecovery(ev(false, 48))).toBe(false);
    expect(isGenuineRecovery(null)).toBe(false);
    expect(isGenuineRecovery(undefined)).toBe(false);
  });
});

describe("planWatchdogRun — with a session OPEN, a clean poll alone does not recover a room", () => {
  it("the 04:36 case: no chunk since the 01:37 alert and frozen levels → NO `recovered` message and NO state write", () => {
    const plan = planWatchdogRun([input({ recovery_evidence: ev(false, 1) })], NOW);
    expect(plan.messages).toEqual([]);
    expect(plan.writes).toEqual([]);
  });

  it("a chunk landed but the levels are still one frozen value → still withheld", () => {
    const plan = planWatchdogRun([input({ recovery_evidence: ev(true, 1) })], NOW);
    expect(plan.messages).toEqual([]);
    expect(plan.writes).toEqual([]);
  });

  it("moving levels but no chunk after the alert → still withheld", () => {
    expect(planWatchdogRun([input({ recovery_evidence: ev(false, 40) })], NOW).messages).toEqual([]);
  });

  it("evidence that could not be read (null) keeps the alert open rather than guessing", () => {
    const plan = planWatchdogRun([input({ recovery_evidence: null })], NOW);
    expect(plan.messages).toEqual([]);
    expect(plan.writes).toEqual([]);
  });

  it("an open session recorded on the bench side (open_session, even if the poll's session_open flag is null) counts as a session", () => {
    const facts: RoomPollFacts = {
      ...cleanPoll(),
      session_open: null,
      open_session: { status: "recording", started_at: new Date(NOW - 20_000).toISOString(), last_any_chunk_at: new Date(NOW - 5_000).toISOString() },
    };
    const plan = planWatchdogRun([input({ facts, recovery_evidence: ev(false, 0) })], NOW);
    expect(plan.messages).toEqual([]);
    expect(plan.writes).toEqual([]);
  });

  it("the HONEST recovery: a chunk after the alert and moving levels → `recovered`, naming how long it was down, and the state moves to ok", () => {
    const plan = planWatchdogRun([input({ recovery_evidence: ev(true, 37) })], NOW);
    expect(plan.messages).toHaveLength(1);
    expect(plan.messages[0]!.kind).toBe("recovered");
    expect(plan.messages[0]!.room_ids).toEqual(["room_opd6"]);
    expect(plan.messages[0]!.text).toMatch(/recovered after being degraded for 2 h 59 min/);
    expect(plan.writes).toEqual([{ room_id: "room_opd6", status: "ok", since: new Date(NOW).toISOString() }]);
  });

  it("an offline room's recovery needs the same evidence while a session is open", () => {
    const offline = { status: "offline" as const, since: iso("2026-10-05 01:37:00") };
    expect(planWatchdogRun([input({ prior: offline, recovery_evidence: ev(false, 0) })], NOW).messages).toEqual([]);
    const ok = planWatchdogRun([input({ prior: offline, recovery_evidence: ev(true, 5) })], NOW);
    expect(ok.messages.map((m) => m.kind)).toEqual(["recovered"]);
  });

  it("a withheld recovery leaves `since` alone, so the eventual honest recovery names the WHOLE outage", () => {
    const prior = { status: "degraded" as const, since: iso("2026-10-05 01:37:00") };
    // 04:36 — withheld; the caller writes nothing, so prior is unchanged on the next run.
    expect(planWatchdogRun([input({ prior, recovery_evidence: ev(false, 1) })], NOW).writes).toEqual([]);
    // 08:45 — audio is back.
    const later = ist("2026-10-05 08:45:00");
    const plan = planWatchdogRun([input({ prior, facts: { ...openPoll(), last_seen_at: new Date(later - 5_000).toISOString() }, recovery_evidence: ev(true, 30) })], later);
    expect(plan.messages[0]!.text).toMatch(/recovered after being degraded for 7 h 8 min/);
  });

  it("a muted room's recovery is withheld the same way and never messages", () => {
    expect(planWatchdogRun([input({ muted: true, recovery_evidence: ev(false, 0) })], NOW)).toEqual({ messages: [], writes: [] });
    const honest = planWatchdogRun([input({ muted: true, recovery_evidence: ev(true, 9) })], NOW);
    expect(honest.messages).toEqual([]);
    expect(honest.writes).toHaveLength(1);
  });
});

describe("planWatchdogRun — with NO session open, a clean poll closes the alert quietly (F4)", () => {
  it("a degraded room with nothing open → state written to ok, NO message (no outbox row, no `recovered` text), `since` reset", () => {
    const plan = planWatchdogRun([input({ facts: cleanPoll(), recovery_evidence: ev(false, 0) })], NOW);
    expect(plan.messages).toEqual([]);
    expect(plan.writes).toEqual([{ room_id: "room_opd6", status: "ok", since: new Date(NOW).toISOString() }]);
  });

  it("an offline room that comes back clean with nothing open also closes quietly", () => {
    const offline = { status: "offline" as const, since: iso("2026-10-04 20:31:00") };
    const plan = planWatchdogRun([input({ facts: cleanPoll(), prior: offline, recovery_evidence: ev(false, 0) })], NOW);
    expect(plan.messages).toEqual([]);
    expect(plan.writes).toEqual([{ room_id: "room_opd6", status: "ok", since: new Date(NOW).toISOString() }]);
  });

  it("unreadable evidence (null) makes no difference when no session is open", () => {
    const plan = planWatchdogRun([input({ facts: cleanPoll(), recovery_evidence: null })], NOW);
    expect(plan.messages).toEqual([]);
    expect(plan.writes).toHaveLength(1);
    expect(plan.writes[0]!.status).toBe("ok");
  });

  it("a muted room closes quietly too (the write lands, nothing is said)", () => {
    const plan = planWatchdogRun([input({ facts: cleanPoll(), muted: true, recovery_evidence: ev(false, 0) })], NOW);
    expect(plan.messages).toEqual([]);
    expect(plan.writes).toHaveLength(1);
  });

  it("the NEXT outage can alert again: after the quiet close the prior is ok, and a new degraded poll messages", () => {
    const closed = planWatchdogRun([input({ facts: cleanPoll(), recovery_evidence: ev(false, 0) })], NOW);
    const next = ist("2026-10-06 09:10:00");
    const prior = { status: closed.writes[0]!.status, since: closed.writes[0]!.since };
    const again = planWatchdogRun([input({ prior, facts: { ...openPoll(), last_seen_at: new Date(next - 5_000).toISOString(), state_flags: ["DEVICE_MISSING"] } })], next);
    expect(again.messages.map((m) => m.kind)).toEqual(["degraded"]);
  });

  it("fleet_outage counting is unaffected by rooms that close quietly in the same run", () => {
    const stale = (id: string) => input({ room_id: id, room_name: id, facts: { ...cleanPoll(), last_seen_at: new Date(NOW - 10 * 60_000).toISOString() }, prior: { status: "ok", since: iso("2026-10-05 00:00:00") } });
    const quiet = (id: string) => input({ room_id: id, room_name: id, facts: cleanPoll(), prior: { status: "degraded", since: iso("2026-10-05 01:00:00") }, recovery_evidence: ev(false, 0) });
    // 3 of 5 rooms cross into offline, 2 close quietly → fleet outage counts 3 of 5, not 3 of anything else
    const plan = planWatchdogRun([stale("a"), stale("b"), stale("c"), quiet("d"), quiet("e")], NOW);
    expect(plan.messages.map((m) => m.kind)).toEqual(["fleet_outage"]);
    expect(plan.messages[0]!.room_ids).toEqual(["a", "b", "c"]);
    expect(plan.writes.map((w) => `${w.room_id}:${w.status}`).sort()).toEqual(["a:offline", "b:offline", "c:offline", "d:ok", "e:ok"]);
    // a quiet close never adds to the offline count: 1 offline + 4 quiet closes → one ordinary offline message
    const one = planWatchdogRun([stale("a"), quiet("b"), quiet("c"), quiet("d"), quiet("e")], NOW);
    expect(one.messages.map((m) => m.kind)).toEqual(["offline"]);
  });
});

describe("planWatchdogRun — everything else is unchanged", () => {
  it("evidence is consulted ONLY for a recovery: new alerts, and status changes that are not toward ok, are unaffected", () => {
    // ok → degraded still alerts, evidence or not
    const toDegraded = planWatchdogRun([input({ prior: { status: "ok", since: iso("2026-10-05 00:00:00") }, facts: { ...openPoll(), state_flags: ["DEVICE_MISSING"] }, recovery_evidence: ev(false, 0) })], NOW);
    expect(toDegraded.messages.map((m) => m.kind)).toEqual(["degraded"]);
    // degraded → offline still alerts
    const toOffline = planWatchdogRun([input({ facts: { ...openPoll(), last_seen_at: new Date(NOW - 10 * 60_000).toISOString() }, recovery_evidence: ev(false, 0) })], NOW);
    expect(toOffline.messages.map((m) => m.kind)).toEqual(["offline"]);
    // first sight of a room (D2) still seeds silently
    const seed = planWatchdogRun([input({ prior: null })], NOW);
    expect(seed.messages).toEqual([]);
    expect(seed.writes).toHaveLength(1);
  });

  it("with no evidence field at all (the planner's legacy callers) the poll alone still decides, session or not", () => {
    expect(planWatchdogRun([input()], NOW).messages.map((m) => m.kind)).toEqual(["recovered"]);
    expect(planWatchdogRun([input({ facts: cleanPoll() })], NOW).messages.map((m) => m.kind)).toEqual(["recovered"]);
  });
});

// Arch #14 acceptance add: recovery needs speech-level energy held for a dwell, not a tiny non-zero tick.
describe("isGenuineRecovery — dwell on live samples", () => {
  const dwell = (live: number, total: number): RecoveryEvidence => ({ chunk_after_alert: true, distinct_levels: 40, live_samples: live, total_samples: total });
  it("tiny peaks with zero_ratio near 1 (no live samples) never clear degraded, however many distinct values", () => {
    expect(isGenuineRecovery(dwell(0, 80))).toBe(false);
  });
  it("one live tick is not a dwell", () => {
    expect(isGenuineRecovery(dwell(1, 80))).toBe(false);
  });
  it("enough live samples, but under half the window, is not genuine", () => {
    expect(isGenuineRecovery(dwell(RECOVERY_MIN_LIVE_SAMPLES, 80))).toBe(false);
  });
  it("a window that is mostly live is genuine", () => {
    expect(isGenuineRecovery(dwell(60, 80))).toBe(true);
    expect(isGenuineRecovery(dwell(RECOVERY_MIN_LIVE_SAMPLES, RECOVERY_MIN_LIVE_SAMPLES))).toBe(true);
  });
  it("still needs a chunk after the alert", () => {
    expect(isGenuineRecovery({ ...dwell(60, 80), chunk_after_alert: false })).toBe(false);
  });
});

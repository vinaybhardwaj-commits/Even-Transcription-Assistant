/**
 * Room watchdog — `recovered` needs EVIDENCE OF AUDIO (fleet-attention build, 5 Oct 2026).
 *
 * The fact being fixed: at 04:36 on 5 Oct the watchdog announced `recovered` for rooms whose Macs were still in DarkWake with frozen microphones.
 * The old rule read a room `ok` as soon as its poll looked clean, and a session that CLOSES looks clean (`session_open` false → no `tape_stalled`).
 * A recovery now needs a bench chunk newer than the alert AND >= 2 distinct level values in the last 120 s; otherwise the alert stays open —
 * no write (so the room's `since` and status stand) and no message.
 *
 * Pure planner only; the evidence SELECT (loadRecoveryEvidence) is read-only SQL and is not exercised here.
 */
import { describe, it, expect } from "vitest";
import {
  planWatchdogRun,
  isGenuineRecovery,
  GENUINE_RECOVERY_MIN_DISTINCT,
  type RoomRunInput,
  type RoomPollFacts,
  type RecoveryEvidence,
} from "@/lib/room-watchdog";

const ist = (s: string): number => Date.parse(`${s.replace(" ", "T")}+05:30`);
const NOW = ist("2026-10-05 04:36:00");
const iso = (s: string) => new Date(ist(s)).toISOString();

/** What a Mac in DarkWake / a closed session polls: perfectly clean. */
const cleanPoll = (): RoomPollFacts => ({
  last_seen_at: new Date(NOW - 5_000).toISOString(),
  tape_advancing: false,
  session_open: false,
  disk_free_bytes: 50_000_000_000,
  state_flags: [],
  open_session: null,
});

const input = (over: Partial<RoomRunInput> = {}): RoomRunInput => ({
  room_id: "room_opd6",
  room_name: "OPD 6",
  facts: cleanPoll(),
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

describe("planWatchdogRun — a clean poll alone does not recover a room", () => {
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

  it("the HONEST recovery: a chunk after the alert and moving levels → `recovered`, naming how long it was down, and the state moves to ok", () => {
    const plan = planWatchdogRun([input({ recovery_evidence: ev(true, 37) })], NOW);
    expect(plan.messages).toHaveLength(1);
    expect(plan.messages[0]!.kind).toBe("recovered");
    expect(plan.messages[0]!.room_ids).toEqual(["room_opd6"]);
    expect(plan.messages[0]!.text).toMatch(/recovered after being degraded for 2 h 59 min/);
    expect(plan.writes).toEqual([{ room_id: "room_opd6", status: "ok", since: new Date(NOW).toISOString() }]);
  });

  it("an offline room's recovery needs the same evidence", () => {
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
    const plan = planWatchdogRun([input({ prior, facts: { ...cleanPoll(), last_seen_at: new Date(later - 5_000).toISOString() }, recovery_evidence: ev(true, 30) })], later);
    expect(plan.messages[0]!.text).toMatch(/recovered after being degraded for 7 h 8 min/);
  });

  it("evidence is consulted ONLY for a recovery: new alerts, and status changes that are not toward ok, are unaffected", () => {
    // ok → degraded still alerts, evidence or not
    const toDegraded = planWatchdogRun([input({ prior: { status: "ok", since: iso("2026-10-05 00:00:00") }, facts: { ...cleanPoll(), state_flags: ["DEVICE_MISSING"] }, recovery_evidence: ev(false, 0) })], NOW);
    expect(toDegraded.messages.map((m) => m.kind)).toEqual(["degraded"]);
    // degraded → offline still alerts
    const toOffline = planWatchdogRun([input({ facts: { ...cleanPoll(), last_seen_at: new Date(NOW - 10 * 60_000).toISOString() }, recovery_evidence: ev(false, 0) })], NOW);
    expect(toOffline.messages.map((m) => m.kind)).toEqual(["offline"]);
    // first sight of a room (D2) still seeds silently
    const seed = planWatchdogRun([input({ prior: null })], NOW);
    expect(seed.messages).toEqual([]);
    expect(seed.writes).toHaveLength(1);
  });

  it("with no evidence field at all (the planner's legacy callers) the poll alone still decides", () => {
    const plan = planWatchdogRun([input()], NOW);
    expect(plan.messages.map((m) => m.kind)).toEqual(["recovered"]);
  });

  it("a muted room's recovery is withheld the same way and never messages", () => {
    expect(planWatchdogRun([input({ muted: true, recovery_evidence: ev(false, 0) })], NOW)).toEqual({ messages: [], writes: [] });
    const honest = planWatchdogRun([input({ muted: true, recovery_evidence: ev(true, 9) })], NOW);
    expect(honest.messages).toEqual([]);
    expect(honest.writes).toHaveLength(1);
  });
});

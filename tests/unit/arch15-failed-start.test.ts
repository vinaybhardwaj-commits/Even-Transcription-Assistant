/**
 * Arch #15 — a start that died is not "Finished for today". One block per acceptance criterion.
 *   AC1 exit-1 / ~15 s / 0-chunk start surfaces as failed start     AC2 copy invites retry / remount
 *   AC3 a true EOD still says Finished for today                    AC4 Bench (page + MCP door) never shows healthy EOD for it
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { roomState, sessionDiedAtStart, START_FAILED_MAX_MS, START_FAILED_NOTE } from "../../lib/bench-bus-constants";
import { buildRoomLive, failedAckBelongsToSession } from "../../lib/admin/rooms-live";
import { startBlockedReason } from "../../components/admin/BenchRoomsLive";

const NOW = Date.parse("2026-10-05T04:00:00.000Z");
const iso = (t: number) => new Date(t).toISOString();
const listening = { last_poll_at: iso(NOW - 1000), paused: false };
const base = { listenerReadFailed: false, pausedSession: false, recording: false, recordingSince: null, nowMs: NOW, listener: listening, lastSessionEnded: true };

describe("sessionDiedAtStart — the discriminator", () => {
  const s = (over: Record<string, unknown>) => ({ status: "ended", started_at: iso(NOW - 15_000), ended_at: iso(NOW), primary_chunks: 0, backup_chunks: 0, notes: START_FAILED_NOTE, ...over }) as never;
  it("OPD4's signature (15 s, zero pieces) died at start", () => { expect(sessionDiedAtStart(s({}))).toBe(true); });
  it("the 3-minute boundary is exact: 179_999 ms dies at start, 180_000 ms does not", () => {
    expect(START_FAILED_MAX_MS).toBe(180_000);
    expect(sessionDiedAtStart(s({ ended_at: iso(NOW - 15_000 + 179_999) }))).toBe(true);
    expect(sessionDiedAtStart(s({ ended_at: iso(NOW - 15_000 + 180_000) }))).toBe(false);
  });
  it("a LONG zero-piece session stays Finished (the ceiling is real, not 24 h)", () => {
    expect(sessionDiedAtStart(s({ started_at: iso(NOW - 6 * 3_600_000), ended_at: iso(NOW) }))).toBe(false);
  });
  it("F2: an OPERATOR stop inside the window is NOT a failed start — no compensation note, no failed ack, no verdict", () => {
    expect(sessionDiedAtStart(s({ notes: null }))).toBe(false);
    expect(sessionDiedAtStart(s({ notes: "operator note" }))).toBe(false);
    expect(sessionDiedAtStart(s({ notes: undefined, start_failed_ack: false }))).toBe(false);
  });
  it("death evidence is either the compensation note or a start_day acked failed around the session", () => {
    expect(sessionDiedAtStart(s({ notes: null, start_failed_ack: true }))).toBe(true);
    expect(sessionDiedAtStart(s({ notes: `x\n${START_FAILED_NOTE}` }))).toBe(true);
  });
  it("C1: a REAPED zero-chunk session reads as a dead start (its ended_at = started_at, so it is ended, pieceless and short)", () => {
    expect(sessionDiedAtStart(s({ notes: "auto-ended: no chunks >30m (reaper)", ended_at: iso(NOW - 15_000) }))).toBe(true);
    expect(sessionDiedAtStart(s({ notes: "auto-ended: day rollover (reaper)", ended_at: iso(NOW - 15_000) }))).toBe(true);
    // ...but a reaped session that DID record is a real day
    expect(sessionDiedAtStart(s({ notes: "auto-ended: no chunks >30m (reaper)", primary_chunks: 3 }))).toBe(false);
  });
  it("any piece of either stream means it recorded", () => {
    expect(sessionDiedAtStart(s({ primary_chunks: 1 }))).toBe(false);
    expect(sessionDiedAtStart(s({ backup_chunks: 2 }))).toBe(false);
  });
  it("a long zero-piece session is not a start failure (that is a stall, other rules own it)", () => {
    expect(sessionDiedAtStart(s({ ended_at: iso(NOW - 15_000 + START_FAILED_MAX_MS + 1) }))).toBe(false);
  });
  it("not ended / unparseable times answer false, never a guess", () => {
    expect(sessionDiedAtStart(s({ status: "recording" }))).toBe(false);
    expect(sessionDiedAtStart(s({ ended_at: null }))).toBe(false);
    expect(sessionDiedAtStart(s({ started_at: "junk" }))).toBe(false);
  });
});

describe("AC1/AC2 — failed start state", () => {
  const st = roomState({ ...base, lastSessionStartFailed: true });
  it("is start_failed, red, and NOT the finished vocabulary", () => {
    expect(st.state).toBe("start_failed");
    expect(st.level).toBe("red");
    expect(`${st.label} ${st.hint}`).not.toMatch(/finished/i);
  });
  it("invites retry and remount", () => {
    expect(st.hint).toMatch(/retry/i);
    expect(st.hint).toMatch(/remount/i);
  });
  it("offers the retry button only where a kiosk is listening", () => {
    expect(st.start_available).toBe(true);
    expect(roomState({ ...base, lastSessionStartFailed: true, listener: { last_poll_at: iso(NOW - 3_600_000), paused: false } }).start_available).toBe(false);
    expect(startBlockedReason(roomState({ ...base, lastSessionStartFailed: true, listener: null }))).toMatch(/last start failed/);
  });
});

describe("AC3 — true EOD keeps its vocabulary", () => {
  it("ended with audio -> Finished for today · Press start to record again", () => {
    const st = roomState({ ...base, lastSessionStartFailed: false, recordedMsToday: 3_600_000 });
    expect(st.state).toBe("finished");
    expect(st.label).toMatch(/^Finished for today/);
    expect(st.hint).toBe("Press start to record again");
  });
  it("callers that never heard of the new input keep the old chain", () => {
    expect(roomState({ ...base }).state).toBe("finished");
  });
  it("recording / paused still outrank a failed start", () => {
    expect(roomState({ ...base, lastSessionStartFailed: true, recording: true, recordingSince: iso(NOW - 60_000) }).state).toBe("recording");
  });
});

describe("AC4 — Bench never shows healthy EOD for it", () => {
  const live = (sessions: Array<Record<string, unknown>>) => buildRoomLive(
    { id: "room_opd4", slug: "opd-4", name: "OPD4", transcript_enabled: false, visits_enabled: false },
    sessions as never,
    { transcript: {} as never, visits: {} as never },
    { last_warehouse_at: null, marks_today: 0, last_mark_at: null, last_window_asked_at: null, last_window_complete: null },
    0, NOW, [],
  );
  const sess = (over: Record<string, unknown>) => ({ id: "bs_x", room_id: "room_opd4", status: "ended", notes: START_FAILED_NOTE, started_at: iso(NOW - 15_000), ended_at: iso(NOW), last_primary_at: null, last_backup_at: null, backup_chunks: 0, primary_chunks: 0, chunks_after_end: 0, ...over });
  it("the live-monitor row flags the dead start; a real day does not", () => {
    expect(live([sess({})]).last_session_start_failed).toBe(true);
    expect(live([sess({ started_at: iso(NOW - 8 * 3_600_000), primary_chunks: 90, last_primary_at: iso(NOW - 60_000) })]).last_session_start_failed).toBe(false);
  });
  it("an operator stop inside 3 minutes (no evidence) is Finished on the live-monitor row, not failed", () => {
    expect(live([sess({ notes: null })]).last_session_ended).toBe(true);
    expect(live([sess({ notes: null })]).last_session_start_failed).toBe(false);
  });
  it("the Bench card wires the flag into roomState (a card that dropped it would paint EOD over a dead start)", () => {
    const src = readFileSync("components/admin/BenchRoomsLive.tsx", "utf8");
    expect(src).toMatch(/lastSessionStartFailed:\s*Boolean\(r\.last_session_start_failed\)/);
  });
  it("the newest session decides: a good morning followed by a dead restart is a failed start", () => {
    const morning = sess({ id: "bs_am", started_at: iso(NOW - 8 * 3_600_000), ended_at: iso(NOW - 3_600_000), primary_chunks: 90 });
    expect(live([morning, sess({})]).last_session_start_failed).toBe(true);
  });
});

describe("failed-ack window (pins the +180 s edge: a +60 min mutant must fail)", () => {
  const sess = { started_at: iso(NOW - 15_000), ended_at: iso(NOW) };
  it("accepts an ack from 60 s before the start to 180 s after the end, nothing outside", () => {
    expect(failedAckBelongsToSession(NOW + 180_000, sess, NOW)).toBe(true);
    expect(failedAckBelongsToSession(NOW + 180_001, sess, NOW)).toBe(false);
    expect(failedAckBelongsToSession(NOW + 60 * 60_000, sess, NOW)).toBe(false);
    expect(failedAckBelongsToSession(NOW - 15_000 - 60_000, sess, NOW)).toBe(true);
    expect(failedAckBelongsToSession(NOW - 15_000 - 60_001, sess, NOW)).toBe(false);
  });
});

describe("death evidence wiring (source pins)", () => {
  it("the monitor reads failed start acks in its own small query, fail-safe, and sets start_failed_ack only on candidates", () => {
    const src = readFileSync("lib/admin/rooms-live.ts", "utf8");
    expect(src).toMatch(/kind = 'start_day' AND status = 'failed'/);
    expect(src).toMatch(/start_acks_unavailable/);
    expect(src).toMatch(/last_session_start_failed: Boolean\(lastSessionEnded && newest && sessionDiedAtStart\(newest\)\)/);
  });
  it("the Swift start compensation writes the same note the server matches", () => {
    const swift = readFileSync("apps/room-recorder/Sources/RoomRecorderCore/RoomEngine.swift", "utf8");
    expect(swift).toContain(`static let startFailedNote = "${START_FAILED_NOTE}"`);
    expect(swift.match(/notes: Self\.startFailedNote/g)?.length).toBe(2);
  });
});

/**
 * Arch #15 — a start that died is not "Finished for today". One block per acceptance criterion.
 *   AC1 exit-1 / ~15 s / 0-chunk start surfaces as failed start     AC2 copy invites retry / remount
 *   AC3 a true EOD still says Finished for today                    AC4 Bench (page + MCP door) never shows healthy EOD for it
 */
import { describe, it, expect } from "vitest";
import { roomState, sessionDiedAtStart, START_FAILED_MAX_MS } from "../../lib/bench-bus-constants";
import { buildRoomLive } from "../../lib/admin/rooms-live";
import { startBlockedReason } from "../../components/admin/BenchRoomsLive";

const NOW = Date.parse("2026-10-05T04:00:00.000Z");
const iso = (t: number) => new Date(t).toISOString();
const listening = { last_poll_at: iso(NOW - 1000), paused: false };
const base = { listenerReadFailed: false, pausedSession: false, recording: false, recordingSince: null, nowMs: NOW, listener: listening, lastSessionEnded: true };

describe("sessionDiedAtStart — the discriminator", () => {
  const s = (over: Record<string, unknown>) => ({ status: "ended", started_at: iso(NOW - 15_000), ended_at: iso(NOW), primary_chunks: 0, backup_chunks: 0, ...over }) as never;
  it("OPD4's signature (15 s, zero pieces) died at start", () => { expect(sessionDiedAtStart(s({}))).toBe(true); });
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
  const sess = (over: Record<string, unknown>) => ({ id: "bs_x", room_id: "room_opd4", status: "ended", started_at: iso(NOW - 15_000), ended_at: iso(NOW), last_primary_at: null, last_backup_at: null, backup_chunks: 0, primary_chunks: 0, chunks_after_end: 0, ...over });
  it("the live-monitor row flags the dead start; a real day does not", () => {
    expect(live([sess({})]).last_session_start_failed).toBe(true);
    expect(live([sess({ started_at: iso(NOW - 8 * 3_600_000), primary_chunks: 90, last_primary_at: iso(NOW - 60_000) })]).last_session_start_failed).toBe(false);
  });
  it("the newest session decides: a good morning followed by a dead restart is a failed start", () => {
    const morning = sess({ id: "bs_am", started_at: iso(NOW - 8 * 3_600_000), ended_at: iso(NOW - 3_600_000), primary_chunks: 90 });
    expect(live([morning, sess({})]).last_session_start_failed).toBe(true);
  });
});

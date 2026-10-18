/**
 * ORDER SILENT-SESSION. Rule `session_silent`: an OPEN recording session whose newest piece is older than 30 min (or that has no piece and started more than 30 min ago) raises ONE
 * alert, in any roster room (clinic or OT), never a room action; one log_only row closes the episode when pieces arrive. Pure rules: synthetic ids and an explicit IST clock.
 */
import { describe, it, expect } from "vitest";
import { DEFAULT_CONFIG, NEVER_LIVE_ROOM_IDS } from "@/lib/steward/config";
import { decideRoom, SESSION_SILENT_RULE, type RecentAction, type RecentContext } from "@/lib/steward/rules";
import type { RoomSense } from "@/lib/steward/sense";
import { ago, healthy, idle, ist, type DeepPartial } from "../support/steward-fixtures";

const A = ist("11:00");
const recent = (rows: RecentAction[]): RecentContext => ({ room: rows, fleet: { failing: {}, hold: {} } });
const silentOf = (ds: ReturnType<typeof decideRoom>) => ds.filter((d) => d.rule === SESSION_SILENT_RULE);
const rowAt = (at: number, action: string, session: string): RecentAction => ({ ts: new Date(at).toISOString(), rule: SESSION_SILENT_RULE, action, params: { session_id: session }, outcome: "shadow" });

/** an open recording session that started `startedMin` ago and whose newest piece is `pieceMin` ago (null = no piece) */
const open = (now: number, startedMin: number, pieceMin: number | null, over: DeepPartial<RoomSense> = {}): RoomSense => {
  const { recording, ...rest } = over;
  return healthy(now, { ...rest, recording: { session_open: true, session_id: "bs_synth1", session_status: "recording", session_started_at: ago(now, startedMin * 60), last_chunk_at: pieceMin === null ? null : ago(now, pieceMin * 60), ...(recording ?? {}) } });
};
const ot = (now: number, startedMin: number, pieceMin: number | null) =>
  open(now, startedMin, pieceMin, { room_id: "room_ot_synth", room_name: "OT Synth", klass: "ot", kind: "ot" });

describe("session_silent", () => {
  for (const [label, mk] of [["clinic", (n: number) => open(n, 31, null)], ["OT", (n: number) => ot(n, 31, null)]] as const) {
    it(`${label}: an open 0-piece session at 31 min alerts once, not again on the next tick, and closes when a piece arrives`, () => {
      const ds = decideRoom(mk(A), DEFAULT_CONFIG, A, recent([]));
      expect(silentOf(ds)).toHaveLength(1);
      expect(silentOf(ds)[0]).toMatchObject({ action: "alert", severity: "error", params: { session_id: "bs_synth1" } });
      expect(ds.some((d) => d.action.startsWith("scribe_"))).toBe(false);
      // the next tick: the alert row is in memory
      const A2 = A + 60_000;
      expect(silentOf(decideRoom(mk(A2), DEFAULT_CONFIG, A2, recent([rowAt(A, "alert", "bs_synth1")])))).toHaveLength(0);
      // a piece arrives: one closing log_only row, and then nothing
      const A3 = A + 10 * 60_000;
      const back = (n: number) => (label === "OT" ? ot(n, 41, 0.5) : open(n, 41, 0.5));
      const closed = silentOf(decideRoom(back(A3), DEFAULT_CONFIG, A3, recent([rowAt(A, "alert", "bs_synth1")])));
      expect(closed).toHaveLength(1);
      expect(closed[0]).toMatchObject({ action: "log_only", params: { state: "cleared" } });
      const A4 = A3 + 60_000;
      expect(silentOf(decideRoom(back(A4), DEFAULT_CONFIG, A4, recent([rowAt(A3, "log_only", "bs_synth1"), rowAt(A, "alert", "bs_synth1")])))).toHaveLength(0);
    });
  }

  it("under 30 min nothing fires; a piece older than 30 min fires even when the session is days old", () => {
    expect(silentOf(decideRoom(open(A, 29, null), DEFAULT_CONFIG, A, recent([])))).toHaveLength(0);
    expect(silentOf(decideRoom(open(A, 600, 5), DEFAULT_CONFIG, A, recent([])))).toHaveLength(0);
    expect(silentOf(decideRoom(open(A, 600, 31), DEFAULT_CONFIG, A, recent([])))).toHaveLength(1);
  });

  it("an OT room with no session gives nothing (idle between cases), and so does a paused session", () => {
    const noSession = idle(A, { room_id: "room_ot_synth", klass: "ot", kind: "ot" });
    expect(silentOf(decideRoom(noSession, DEFAULT_CONFIG, A, recent([])))).toHaveLength(0);
    const paused = open(A, 120, null, { recording: { session_status: "paused" } });
    expect(silentOf(decideRoom(paused, DEFAULT_CONFIG, A, recent([])))).toHaveLength(0);
  });

  it("a NEW session in the same room after an earlier alert alerts again (deduped per session, not per room)", () => {
    const ds = decideRoom(open(A, 40, null, { recording: { session_id: "bs_synth2" } }), DEFAULT_CONFIG, A, recent([rowAt(A - 3_600_000, "alert", "bs_synth1")]));
    expect(silentOf(ds)).toHaveLength(1);
  });

  it("the never-live ORB2 id, with no bound machine, still gets the alert and never a room action", () => {
    const orb2 = NEVER_LIVE_ROOM_IDS[0]!;
    const s = ot(A, 120, null);
    s.room_id = orb2;
    s.machine = null;
    const ds = decideRoom(s, DEFAULT_CONFIG, A, recent([]));
    expect(silentOf(ds)).toHaveLength(1);
    expect(silentOf(ds)[0]).toMatchObject({ action: "alert", room_id: orb2 });
    expect(ds.filter((d) => d.action === "scribe_start" || d.action === "scribe_stop" || d.action === "scribe_restart")).toHaveLength(0);
  });
});

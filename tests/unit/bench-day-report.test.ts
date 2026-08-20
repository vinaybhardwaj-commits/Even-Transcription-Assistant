/**
 * U3 — one day picture (ETA-MCP-UPGRADE PRD §4, D11). The pure shaping and flag logic
 * behind scribe_day_report / scribe_diff_room: the tape clock governs (the last piece
 * recorded, either microphone — never the stored end time), disagreement and lying-end
 * flags read the reaper's OWN STALLED_BADGE_MINUTES, listener freshness reads the bus's
 * OWN LISTENER_FRESH_MS — every threshold is computed FROM the imported constant here,
 * so changing a constant moves the flag and no test pins a copied number.
 */
import { describe, it, expect } from "vitest";
import { STALLED_BADGE_MINUTES, isBenchStalled } from "@/lib/bench-reaper-core";
import { LISTENER_FRESH_MS, isListening, type ListenerRow } from "@/lib/bench-commands";
import {
  buildDaySession,
  coverageGaps,
  DAY_GAP_MIN_MS,
  endedAtLies,
  endTimeDisagrees,
  tapeEndMs,
  BENCH_TOOLS,
} from "@/lib/mcp/tools/bench";

const T0 = Date.parse("2026-08-19T04:00:00.000Z");
const min = (n: number) => n * 60_000;
const iso = (t: number) => new Date(t).toISOString();
const WINDOW_MS = STALLED_BADGE_MINUTES * min(1);

const chunk = (startMs: number, endMs: number, source: "primary" | "backup" = "primary", upload_state = "verified") => ({
  source,
  started_at: iso(startMs),
  ended_at: iso(endMs),
  upload_state,
});

describe("1 — tape end is the last piece, not the stored end time", () => {
  it("tape_ended_at comes from the newest chunk ended_at (either mic); a stored end hours later is shown beside it, never as the tape end", () => {
    const chunks = [chunk(T0, T0 + min(5)), chunk(T0 + min(5), T0 + min(10))];
    const s = buildDaySession(
      { id: "bs_x", status: "ended", started_at: iso(T0), ended_at: iso(T0 + min(300)) }, // manual close ~5 h later
      chunks,
      [],
    );
    expect(s.tape_ended_at).toBe(iso(T0 + min(10)));
    expect(s.ended_at).toBe(iso(T0 + min(300))); // included because it differs
    expect(s.end_time_disagrees).toBe(true);
    expect(tapeEndMs(chunks)).toBe(T0 + min(10));
  });
  it("no pieces at all → tape_ended_at null, never invented", () => {
    const s = buildDaySession({ id: "bs_n", status: "ended", started_at: iso(T0), ended_at: iso(T0 + min(1)) }, [], []);
    expect(s.tape_ended_at).toBeNull();
    expect(s.end_time_disagrees).toBe(false); // no tape clock to disagree with
  });
});

describe("2 — end_time_disagrees follows the imported stall window", () => {
  it("true just past the window, false at and inside it (threshold computed from STALLED_BADGE_MINUTES)", () => {
    const tape = T0 + min(10);
    expect(endTimeDisagrees(tape + WINDOW_MS + 1, tape)).toBe(true);
    expect(endTimeDisagrees(tape + WINDOW_MS, tape)).toBe(false); // exactly the window is not "more than"
    expect(endTimeDisagrees(tape + WINDOW_MS - min(1), tape)).toBe(false);
    // either direction: a stored end far BEFORE the last piece is just as untrue
    expect(endTimeDisagrees(tape - WINDOW_MS - 1, tape)).toBe(true);
    expect(endTimeDisagrees(null, tape)).toBe(false);
    expect(endTimeDisagrees(tape, null)).toBe(false);
  });
  it("a session ended within the window keeps ended_at visible (differs) but end_time_disagrees false", () => {
    const s = buildDaySession(
      { id: "bs_c", status: "ended", started_at: iso(T0), ended_at: iso(T0 + min(10) + 30_000) }, // 30 s after last audio
      [chunk(T0, T0 + min(10))],
      [],
    );
    expect(s.end_time_disagrees).toBe(false);
    expect(s.ended_at).toBe(iso(T0 + min(10) + 30_000));
  });
});

describe("3 — both microphones counted separately; the tape clock spans both", () => {
  it("primary and backup pieces get their own counts, and a later backup piece sets the tape end", () => {
    const chunks = [
      chunk(T0, T0 + min(5), "primary"),
      chunk(T0 + min(5), T0 + min(10), "primary"),
      chunk(T0 + min(5), T0 + min(10), "backup"),
      chunk(T0 + min(10), T0 + min(15), "backup", "pending"),
    ];
    const s = buildDaySession({ id: "bs_b", status: "ended", started_at: iso(T0), ended_at: iso(T0 + min(15)) }, chunks, []) as {
      chunks: { primary: { count: number; verified: number }; backup: { count: number; verified: number } };
      tape_ended_at: string;
    };
    expect(s.chunks.primary).toEqual({ count: 2, verified: 2 });
    expect(s.chunks.backup).toEqual({ count: 2, verified: 1 });
    expect(s.tape_ended_at).toBe(iso(T0 + min(15))); // the backup's last piece, either mic governs
  });
  it("a hole covered by the backup is not a gap; a hole on both mics is", () => {
    const gaps = coverageGaps([
      chunk(T0, T0 + min(5), "primary"),
      chunk(T0 + min(5), T0 + min(10), "backup"), // primary silent, backup covers → no gap
      chunk(T0 + min(20), T0 + min(25), "primary"), // 10 min hole on BOTH mics → gap
    ]);
    expect(gaps).toEqual([{ from: iso(T0 + min(10)), to: iso(T0 + min(20)), seconds: 600 }]);
    // seams under the rollup's own 2 s line are not gaps
    expect(coverageGaps([chunk(T0, T0 + min(5)), chunk(T0 + min(5) + DAY_GAP_MIN_MS - 1, T0 + min(10))])).toEqual([]);
  });
});

describe("4 — ended_at_lies fires on a stored end far after the last piece, not on a clean session", () => {
  it("directional: later by more than the window fires; a clean close does not; earlier never does", () => {
    const tape = T0 + min(90);
    expect(endedAtLies(tape + WINDOW_MS + 1, tape)).toBe(true); // bs_j9wgfa33's shape: manual close hours late
    expect(endedAtLies(tape + WINDOW_MS, tape)).toBe(false);
    expect(endedAtLies(tape + 30_000, tape)).toBe(false); // clean end, seconds after the last piece
    expect(endedAtLies(tape - WINDOW_MS - 1, tape)).toBe(false); // early ≠ lying about extra tape
    expect(endedAtLies(null, tape)).toBe(false); // still recording → nothing stored → no lie
    expect(endedAtLies(tape, null)).toBe(false);
  });
});

describe("5 — kiosk_not_listening follows the bus's own freshness rule", () => {
  const listener = (ageMs: number, now: number): ListenerRow =>
    ({ room_id: "room_1", tab_id: "tab_1", last_poll_at: iso(now - ageMs), recording_session_id: null, paused: false }) as ListenerRow;
  it("a poll exactly at LISTENER_FRESH_MS is still listening; one past it is not; no row is not", () => {
    const now = T0 + min(60);
    expect(isListening(listener(LISTENER_FRESH_MS, now), new Date(now))).toBe(true);
    expect(isListening(listener(LISTENER_FRESH_MS + 1, now), new Date(now))).toBe(false);
    expect(isListening(null, new Date(now))).toBe(false);
  });
});

describe("6 — every flag reads its threshold from the imported constants", () => {
  it("stalled is the reaper's own isBenchStalled: moving past STALLED_BADGE_MINUTES flips it, and only while recording", () => {
    const now = T0 + min(120);
    const s = (lastMs: number, status = "recording") => ({ status, last_any_chunk_at: iso(lastMs), started_at: iso(T0) });
    expect(isBenchStalled(s(now - WINDOW_MS - 1), now)).toBe(true);
    expect(isBenchStalled(s(now - WINDOW_MS), now)).toBe(false);
    expect(isBenchStalled(s(now - WINDOW_MS - 1, "ended"), now)).toBe(false);
    expect(isBenchStalled(s(now - WINDOW_MS - 1, "paused"), now)).toBe(false);
  });
  it("disagree/lies boundaries sit exactly at STALLED_BADGE_MINUTES so a constant change moves both flags together", () => {
    const tape = T0;
    for (const delta of [1, min(1), min(5)]) {
      expect(endTimeDisagrees(tape + WINDOW_MS + delta, tape)).toBe(true);
      expect(endedAtLies(tape + WINDOW_MS + delta, tape)).toBe(true);
      expect(endTimeDisagrees(tape + WINDOW_MS - Math.min(delta, WINDOW_MS), tape)).toBe(false);
      expect(endedAtLies(tape + WINDOW_MS - Math.min(delta, WINDOW_MS), tape)).toBe(false);
    }
  });
  it("both tools are registered in BENCH_TOOLS as read scope, so both doors expose them", () => {
    const names = BENCH_TOOLS.map((t) => t.name);
    expect(names).toContain("scribe_day_report");
    expect(names).toContain("scribe_diff_room");
    for (const n of ["scribe_day_report", "scribe_diff_room"]) {
      expect(BENCH_TOOLS.find((t) => t.name === n)?.scope).toBe("read");
    }
  });
});

describe("day-report event shaping (marks, mic story, remounts)", () => {
  it("consult marks carry reached_brain; mic events keep time order and reasons; remounts carry silence_seconds", () => {
    const s = buildDaySession(
      { id: "bs_e", status: "ended", started_at: iso(T0), ended_at: iso(T0 + min(10)) },
      [chunk(T0, T0 + min(10))],
      [
        { id: "ev3", kind: "mic_primary_restored", at: iso(T0 + min(6)), brain_status: "none", payload: { reason: "retry" } },
        { id: "ev1", kind: "consult_mark", at: iso(T0 + min(2)), brain_status: "sent", payload: {} },
        { id: "ev2", kind: "mic_primary_lost", at: iso(T0 + min(4)), brain_status: "none", payload: { reason: "track_ended" } },
        { id: "ev4", kind: "consult_mark", at: iso(T0 + min(7)), brain_status: "failed", payload: {} },
        { id: "ev5", kind: "kiosk_remount_resumed", at: iso(T0 + min(8)), brain_status: "none", payload: { silence_seconds: 78 } },
        { id: "ev6", kind: "kiosk_tab_gone", at: iso(T0 + min(8)), brain_status: "none", payload: {} }, // not a mic/mark/remount row
      ],
    ) as { consult_marks: unknown[]; mic_events: unknown[]; remount_events: unknown[] };
    expect(s.consult_marks).toEqual([
      { id: "ev1", at: iso(T0 + min(2)), reached_brain: true },
      { id: "ev4", at: iso(T0 + min(7)), reached_brain: false },
    ]);
    expect(s.mic_events).toEqual([
      { kind: "mic_primary_lost", at: iso(T0 + min(4)), reason: "track_ended" },
      { kind: "mic_primary_restored", at: iso(T0 + min(6)), reason: "retry" },
    ]);
    expect(s.remount_events).toEqual([{ at: iso(T0 + min(8)), silence_seconds: 78 }]);
  });
});

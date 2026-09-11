/**
 * tests/unit/bench-orphan.test.ts — K5 Part A, the pure half.
 *
 * The decision is what makes this safe to put on a room card, so it is tested exhaustively and
 * without a database. The row that matters most is A4: a kiosk that is fresh AND on this very
 * session owns it, and the repair must REFUSE. Everything else here is the four ways a session
 * can be abandoned, each of which must be told apart from the others because they send an
 * operator to different places.
 */
import { describe, it, expect } from "vitest";
import { decideOrphanClose, CLOSE_ORPHAN_KIND } from "@/lib/bench-orphan";
import { LISTENER_FRESH_MS, COMMAND_KINDS } from "@/lib/bench-commands";

const NOW = new Date("2026-08-22T15:00:00.000Z");
const ago = (ms: number) => new Date(NOW.getTime() - ms).toISOString();

const listener = (o: Partial<{ age: number; claims: string | null; tab: string }> = {}) => ({
  room_id: "room_1",
  tab_id: o.tab ?? "tab_a",
  last_poll_at: ago(o.age ?? 1_000),
  recording_session_id: o.claims === undefined ? "bs_1" : o.claims,
  paused: false,
});
const session = (status = "recording", id = "bs_1") => ({ id, status });

describe("A4 — it REFUSES while a kiosk owns the session", () => {
  it("fresh listener claiming THIS session → kiosk_attached, and nothing is closed", () => {
    const d = decideOrphanClose({ listener: listener({ age: 1_000, claims: "bs_1" }), session: session(), now: NOW });
    expect(d.action).toBe("refuse");
    expect(d.action === "refuse" && d.error).toBe("kiosk_attached");
  });

  it("the boundary is LISTENER_FRESH_MS exactly — at the edge it still owns it", () => {
    const atEdge = decideOrphanClose({ listener: listener({ age: LISTENER_FRESH_MS, claims: "bs_1" }), session: session(), now: NOW });
    expect(atEdge.action).toBe("refuse");
    // …and one millisecond past it, the kiosk is gone
    const past = decideOrphanClose({ listener: listener({ age: LISTENER_FRESH_MS + 1, claims: "bs_1" }), session: session(), now: NOW });
    expect(past.action).toBe("close");
  });

  it("a PAUSED session with a fresh kiosk on it is still owned — pause is not abandonment", () => {
    const d = decideOrphanClose({ listener: listener({ age: 500, claims: "bs_1" }), session: session("paused"), now: NOW });
    expect(d.action === "refuse" && d.error).toBe("kiosk_attached");
  });
});

describe("the four ways a session is abandoned, told apart", () => {
  const cases: Array<[string, ReturnType<typeof listener> | null, string]> = [
    ["no kiosk has ever polled this room", null, "no_listener_row"],
    ["a kiosk polled, but long ago", listener({ age: 5 * 60_000, claims: "bs_1" }), "listener_stale"],
    ["a fresh kiosk that is recording NOTHING", listener({ age: 800, claims: null }), "claims_nothing"],
    ["a fresh kiosk that is on a DIFFERENT session", listener({ age: 800, claims: "bs_other" }), "claims_other_session"],
  ];
  for (const [name, l, reason] of cases) {
    it(`${name} → close, reason ${reason}`, () => {
      const d = decideOrphanClose({ listener: l, session: session(), now: NOW });
      expect(d.action).toBe("close");
      expect(d.action === "close" && d.evidence.reason).toBe(reason);
    });
  }

  it("claims_nothing is the EXACT shape of the 22 August failure", () => {
    // the replacement tab: signed in seconds ago, polling happily, holding no session at all,
    // while the room's session row still said 'recording'.
    const d = decideOrphanClose({ listener: listener({ age: 1_200, claims: null, tab: "tab_7e3c8caa" }), session: session(), now: NOW });
    expect(d.action).toBe("close");
    expect(d.action === "close" && d.evidence.reason).toBe("claims_nothing");
    expect(d.action === "close" && d.evidence.listening).toBe(true); // it WAS alive — just not on this tape
  });
});

describe("there is nothing to repair", () => {
  it("no session at all → no_open_session", () => {
    const d = decideOrphanClose({ listener: listener(), session: null, now: NOW });
    expect(d.action === "refuse" && d.error).toBe("no_open_session");
  });
  it("an already-ended session → no_open_session, so a second press is a no-op", () => {
    const d = decideOrphanClose({ listener: null, session: session("ended"), now: NOW });
    expect(d.action === "refuse" && d.error).toBe("no_open_session");
  });
});

describe("the evidence is complete enough to justify the row afterwards", () => {
  it("carries the tab, the poll instant, its age, what it claimed, and the window used", () => {
    const d = decideOrphanClose({ listener: listener({ age: 499_880, claims: null, tab: "tab_7e3c8caa" }), session: session(), now: NOW });
    expect(d.action).toBe("close");
    if (d.action !== "close") return;
    expect(d.evidence).toMatchObject({
      present: true,
      tab_id: "tab_7e3c8caa",
      age_ms: 499_880,
      listening: false,
      claims_session_id: null,
      fresh_window_ms: LISTENER_FRESH_MS,
      reason: "listener_stale",
    });
    expect(typeof d.evidence.last_poll_at).toBe("string");
  });

  it("PURE — same input, same output, and it reads no clock of its own", () => {
    const input = { listener: listener({ age: 60_000 }), session: session(), now: NOW };
    expect(decideOrphanClose(input)).toEqual(decideOrphanClose(input));
  });
});

describe("A2 — the repair is not a kiosk command", () => {
  it("close_orphan is NOT in COMMAND_KINDS, so pollCommands can never hand it to a browser", () => {
    expect(COMMAND_KINDS as readonly string[]).not.toContain(CLOSE_ORPHAN_KIND);
    expect(CLOSE_ORPHAN_KIND).toBe("close_orphan");
  });

  it("R4-D1: the kiosk vocabulary is the four day verbs plus set_audio_input — and Tier 1's three verbs — and nothing else", () => {
    expect([...COMMAND_KINDS]).toEqual([
      "start_day", "pause_day", "resume_day", "end_day", "set_audio_input",
      "check_update_now", "report_diag", "restart_engine",
    ]);
  });
});

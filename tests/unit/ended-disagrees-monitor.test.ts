/**
 * ENDED DISAGREES on the live operator monitor (C2).
 *
 * The half of bs_g3dwud4p that mattered on the day was not the row. It was that the monitor read
 * NOT RECORDING for six hours while the room was still capturing. So the monitor has to be able
 * to say the opposite of what the session row says, and say it in words an operator can act on.
 *
 * DERIVED FROM THE CHUNK ROWS, not from the bench_event the chunk route writes. Same fact, two
 * witnesses, and this is the one that cannot be missed: the event exists only for chunks the
 * route saw after this build shipped, whereas the chunks are the durable evidence and were there
 * all along — including for a session that disagreed before anybody wrote any of this.
 *
 * The test that matters most is the NEGATIVE one. A normal end-of-day must never trip this: the
 * kiosk flushes its whole queue and only then PATCHes end, so on a clean day every chunk's
 * created_at precedes ended_at. An alarm that fires on every ordinary evening is an alarm nobody
 * reads by Wednesday.
 */
import { describe, it, expect } from "vitest";
import { buildRoomLive, normaliseSessions, type LiveSession } from "@/lib/admin/rooms-live";
import { attentionItems } from "@/components/admin/BenchRoomsLive";
import { ENDED_DISAGREES_TITLE, ENDED_DISAGREES_HINT } from "@/lib/bench-bus-constants";

const ROOM = { id: "room_x", slug: "opd-test", name: "OPD Test" };
const NOW = Date.parse("2026-08-23T01:00:00.000Z");
const iso = (t: number) => new Date(t).toISOString();
const mins = (n: number) => n * 60_000;

const BRAIN = { last_warehouse_at: null, marks_today: 0, last_mark_at: null, last_window_asked_at: null, last_window_complete: null };

const session = (o: Partial<LiveSession> = {}): LiveSession => ({
  id: "bs_g3dwud4p", room_id: ROOM.id, status: "ended",
  started_at: iso(NOW - mins(600)), ended_at: iso(NOW - mins(360)),
  last_primary_at: iso(NOW - mins(2)), last_backup_at: null,
  backup_chunks: 0, primary_chunks: 108, chunks_after_end: 108,
  ...o,
});

const build = (sessions: LiveSession[]) => buildRoomLive(ROOM, sessions, BRAIN, 0, NOW, []);

describe("the monitor can contradict the session row", () => {
  it("names the disagreement, the count, and when it started", () => {
    const r = build([session()]);
    expect(r.ended_disagrees).toBe(true);
    expect(r.ended_disagrees_session_id).toBe("bs_g3dwud4p");
    expect(r.ended_disagrees_chunks).toBe(108);
    expect(r.ended_disagrees_ended_at).toBe(iso(NOW - mins(360)));
    expect(r.ended_disagrees_last_piece_at).toBe(iso(NOW - mins(2)));
    // and the room still reads not-recording, which is the whole point: both facts, not one.
    expect(r.recording).toBe(false);
  });

  it("A NORMAL END DOES NOT TRIP IT — the kiosk flushes before it PATCHes end", () => {
    const r = build([session({ chunks_after_end: 0 })]);
    expect(r.ended_disagrees).toBe(false);
    expect(r.ended_disagrees_session_id).toBeNull();
    expect(r.ended_disagrees_chunks).toBe(0);
  });

  it("a live session is not a disagreement, however many chunks it has", () => {
    const r = build([session({ status: "recording", ended_at: null, chunks_after_end: 0 })]);
    expect(r.ended_disagrees).toBe(false);
  });

  it("an ended session with no ended_at cannot disagree with a time it does not have", () => {
    const r = build([session({ ended_at: null, chunks_after_end: 3 })]);
    expect(r.ended_disagrees).toBe(false);
  });

  it("with two disagreeing sessions it reports the one still taking audio most recently", () => {
    const older = session({ id: "bs_old", last_primary_at: iso(NOW - mins(200)), chunks_after_end: 4 });
    const newer = session({ id: "bs_new", last_primary_at: iso(NOW - mins(1)), chunks_after_end: 9 });
    expect(build([older, newer]).ended_disagrees_session_id).toBe("bs_new");
    expect(build([newer, older]).ended_disagrees_session_id).toBe("bs_new"); // order-independent
  });

  it("the count rides the aggregate the query already computes — a missing column is 0, never NaN", () => {
    const [s] = normaliseSessions([{ id: "bs_t", room_id: ROOM.id, status: "ended", started_at: iso(NOW), ended_at: iso(NOW) }]);
    expect(s!.chunks_after_end).toBe(0);
    const [t] = normaliseSessions([{ id: "bs_u", room_id: ROOM.id, status: "ended", started_at: iso(NOW), ended_at: iso(NOW), chunks_after_end: "12" }]);
    expect(t!.chunks_after_end).toBe(12);
  });
});

describe("the query asks for it without asking for anything extra", () => {
  it("counts pieces uploaded after ended_at inside the aggregate that is already there", async () => {
    const { readFileSync } = await import("node:fs");
    const src = readFileSync("lib/admin/rooms-live.ts", "utf8");
    const q = /SELECT s\.id, s\.room_id[\s\S]*?ORDER BY s\.started_at DESC/.exec(src)?.[0] ?? "";
    expect(q).toBeTruthy();
    expect(q).toMatch(/FILTER \(WHERE s\.ended_at IS NOT NULL AND c\.created_at > s\.ended_at\) AS chunks_after_end/);
    // one FROM, one LEFT JOIN — no second query, no second join
    expect(q.match(/JOIN/g) ?? []).toHaveLength(1);
    expect(q.match(/SELECT/g) ?? []).toHaveLength(1);
    // created_at is the UPLOAD clock, the same one the mic vitals use
    expect(q).not.toMatch(/c\.ended_at > s\.ended_at/);
  });
});

describe("the operator's line says what happened and what to do", () => {
  const rooms = [build([session()])];
  const listeners = new Map();

  it("is red, and sits with the rest of the attention list", () => {
    const items = attentionItems(rooms, listeners, true, NOW);
    const item = items.find((i) => i.title === ENDED_DISAGREES_TITLE);
    expect(item).toBeTruthy();
    expect(item!.severity).toBe("red");
    expect(item!.room).toBe("OPD Test");
  });

  it("answers the operator's first question — is the audio safe — before anything else", () => {
    const item = attentionItems(rooms, listeners, true, NOW).find((i) => i.title === ENDED_DISAGREES_TITLE)!;
    expect(item.detail).toContain("108 pieces");
    expect(item.detail).toContain(ENDED_DISAGREES_HINT);
    expect(item.detail).toMatch(/safe/i);
    expect(item.detail).toMatch(/press start/i);
  });

  it("a healthy room raises nothing", () => {
    const ok = [build([session({ status: "recording", ended_at: null, chunks_after_end: 0, last_primary_at: iso(NOW - mins(1)) })])];
    expect(attentionItems(ok, new Map([[ROOM.id, { room_id: ROOM.id, listening: true } as never]]), true, NOW)
      .some((i) => i.title === ENDED_DISAGREES_TITLE)).toBe(false);
  });

  it("the copy is read from the one source, never retyped in the component", async () => {
    const { readFileSync } = await import("node:fs");
    const src = readFileSync("components/admin/BenchRoomsLive.tsx", "utf8");
    expect(src).toMatch(/ENDED_DISAGREES_TITLE/);
    expect(src).toMatch(/ENDED_DISAGREES_HINT/);
    expect(src).not.toContain(ENDED_DISAGREES_TITLE); // the string itself is nowhere in the file
  });
});

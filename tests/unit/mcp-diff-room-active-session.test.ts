/**
 * Fable 28 Sep 08:50 — `scribe_rooms view=now` (scribe_diff_room) reported `recording:false` and
 * `tape_lane` off for OPD 5/6/7, Third Floor and ORB3 while their sessions were open and actively
 * recording; `start_day` on the same rooms correctly replied `already_recording`. Measured live
 * (read-only): all five sessions' `started_at` fell on 27 Sep IST, while the read happened on 28
 * Sep — a session open past midnight.
 *
 * ROOT CAUSE: `recordingSession` was derived from `listBenchSessions({ ist_date: today })`, which
 * filters on `(s.started_at AT TIME ZONE 'Asia/Kolkata')::date = ist_date` (lib/bench.ts) — a
 * session that STARTED on an earlier IST date falls outside that window even though it is still
 * open. `start_day`'s own already_recording check (`findActiveSession`, lib/bench-commands.ts) has
 * no date filter for exactly this reason, so the two disagreed.
 *
 * FIX: `recording` / `recording_session_id` / `tape_lane` / `room_state` now come from the SAME
 * date-independent `findActiveSession` lookup `start_day` uses, not from the today-scoped session
 * list (which stays as it was for the today-only metrics: last_piece_at, any_tape_today, stalled,
 * the day-report rows — a session's contribution to "today" is a separate, larger question this
 * fix does not touch).
 *
 * No live database: `sql` is mocked, distinguishing `listBenchSessions`'s query (today-scoped,
 * `SELECT s.id, s.room_id, s.label...`) from `findActiveSession`'s (no date filter,
 * `SELECT id, status, started_at FROM bench_session WHERE room_id = ...`) by shape alone — the
 * mock does not simulate Postgres date arithmetic, it proves which of the two code paths ships.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";

type Row = Record<string, unknown>;
// A synthetic fixture room, not a real clinic slug (no-identity-literals.test.ts: a clinician's
// name in a room slug is a real identity literal, even in a test).
const ROOM = { id: "room_opd5", slug: "opd-test-wxmp", name: "OPD Test" };

/** What findActiveSession's date-independent query returns, or null for no active session. */
let active: { id: string; status: string; started_at: string } | null = null;
/** What listBenchSessions' TODAY-scoped query returns — deliberately independent of `active`. */
let todaySessions: Row[] = [];

vi.mock("@/lib/db", () => {
  const sql = (strings: TemplateStringsArray, ...values: unknown[]) => {
    const text = strings.join("?").replace(/\s+/g, " ").trim();
    if (/^SELECT id, slug, name FROM room WHERE/.test(text)) {
      return Promise.resolve([{ ...ROOM, created_at: new Date(Date.UTC(2026, 8, 1)) }]);
    }
    // findActiveSession — no date filter. Matched FIRST: its own SELECT list is a strict prefix
    // of nothing else's, but check it before the broader session-list query for clarity.
    if (/^SELECT id, status, started_at FROM bench_session WHERE room_id = \?/.test(text)) {
      return Promise.resolve(active ? [active] : []);
    }
    // listBenchSessions — today-scoped (the query joins room and aggregates chunks).
    if (/^SELECT s\.id, s\.room_id, s\.label/.test(text)) {
      return Promise.resolve(todaySessions);
    }
    if (/^SELECT state_flags FROM room_install/.test(text)) return Promise.resolve([]);
    return Promise.resolve([]);
  };
  sql.transaction = async () => [];
  return { sql, db: {} };
});
vi.mock("@/lib/brain/db", async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return { ...actual, brainLog: () => {}, query: async () => ({ rows: [], rowCount: 0 }) };
});
vi.mock("@/lib/bench-bus", async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return { ...actual, getListener: async () => null };
});

const { BENCH_TOOLS } = await import("@/lib/mcp/tools/bench");
const diffRoom = BENCH_TOOLS.find((t) => t.name === "scribe_diff_room")!;

beforeEach(() => {
  active = null;
  todaySessions = [];
});

const rowOf = async (): Promise<Row> => {
  const out = (await diffRoom.handler({}, { origin: "https://preview.example" } as never)) as { rooms: Row[] };
  expect(out.rooms).toHaveLength(1);
  return out.rooms[0]!;
};

describe("scribe_diff_room — recording follows the SAME active-session check start_day uses", () => {
  it("THE 28 SEP CASE: a session that started YESTERDAY and is still recording reads recording:true, not false", async () => {
    // today's list is empty — exactly what a date-scoped query returns for a session that started
    // on the prior IST date, whether or not it is still open.
    todaySessions = [];
    active = { id: "bs_7t4neksu", status: "recording", started_at: "2026-09-27T03:00:03.491Z" };
    const row = await rowOf();
    expect(row.recording).toBe(true);
    expect(row.recording_session_id).toBe("bs_7t4neksu");
    expect((row.tape_lane as Row).level).toBe("ok");
    expect((row.tape_lane as Row).state).toMatch(/^Recording/);
    expect((row.room_state as Row).state).toBe("recording");
  });

  it("a paused session from before midnight reads paused, not silently healthy", async () => {
    todaySessions = [];
    active = { id: "bs_paused", status: "paused", started_at: "2026-09-27T10:00:00.000Z" };
    const row = await rowOf();
    expect(row.recording).toBe(false);
    expect((row.room_state as Row).state).toBe("paused");
  });

  it("no active session at all (start_day would create one) reads recording:false, matching before this fix", async () => {
    todaySessions = [];
    active = null;
    const row = await rowOf();
    expect(row.recording).toBe(false);
    expect(row.recording_session_id).toBeNull();
  });

  it("a session that started TODAY (the common case) is unaffected: both queries agree", async () => {
    active = { id: "bs_today", status: "recording", started_at: "2026-09-28T03:16:01.849Z" };
    todaySessions = [
      {
        id: "bs_today", room_id: ROOM.id, label: null, mic_label: null,
        started_at: "2026-09-28T03:16:01.849Z", ended_at: null, status: "recording", notes: null,
        room_name: ROOM.name, room_slug: ROOM.slug, chunk_count: 3, verified_count: 3,
        total_bytes: 1000, gap_ms: 0, gap_count: 0, last_chunk_at: "2026-09-28T03:20:00.000Z",
        last_any_chunk_at: "2026-09-28T03:20:00.000Z", backup_chunk_count: 0, backup_verified_count: 0,
        primary_lost_count: 0, primary_restored_count: 0,
      },
    ];
    const row = await rowOf();
    expect(row.recording).toBe(true);
    expect(row.recording_session_id).toBe("bs_today");
  });

  it("ARCH #15: the door reads a 15 s zero-piece ended session as start_failed, and a real ended day as finished", async () => {
    const sess = (over: Row): Row => ({
      id: "bs_x", room_id: ROOM.id, label: null, mic_label: null, started_at: "2026-09-28T03:16:00.000Z", ended_at: "2026-09-28T03:16:15.000Z",
      status: "ended", notes: null, room_name: ROOM.name, room_slug: ROOM.slug, chunk_count: 0, verified_count: 0, total_bytes: 0, gap_ms: 0, gap_count: 0,
      last_chunk_at: null, last_any_chunk_at: null, backup_chunk_count: 0, backup_verified_count: 0, primary_lost_count: 0, primary_restored_count: 0, ...over,
    });
    active = null;
    todaySessions = [sess({})];
    expect(((await rowOf()).room_state as Row).state).toBe("start_failed");
    todaySessions = [sess({ chunk_count: 40, ended_at: "2026-09-28T11:00:00.000Z" })];
    expect(((await rowOf()).room_state as Row).state).toBe("finished");
  });
});

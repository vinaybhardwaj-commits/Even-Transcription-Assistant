/**
 * ORDER SILENT-SESSION. `scribe_rooms view=now` (scribe_diff_room) answered stalled:false,
 * stalled_age_ms null and not_delivering_minutes null for a recording session open for more than
 * 24 h with ZERO pieces. isBenchStalled already falls back to started_at; the defect was the POOL:
 * the stall was read from `listBenchSessions({ ist_date: today })`, and a session that started on an
 * earlier IST date is not in it. The pool now also takes every recording session of the room.
 *
 * No live database: `sql` is mocked and tells the two listBenchSessions calls apart by their
 * bound values (the today-scoped one carries a YYYY-MM-DD date, the open-recording one does not).
 */
import { describe, it, expect, beforeEach, vi } from "vitest";

type Row = Record<string, unknown>;
const ROOM = { id: "room_otx1", slug: "ot-test-wxmp", name: "OT Test" };

let active: { id: string; status: string; started_at: string } | null = null;
let todaySessions: Row[] = [];
let openRecording: Row[] = [];

vi.mock("@/lib/db", () => {
  const sql = (strings: TemplateStringsArray, ...values: unknown[]) => {
    const text = strings.join("?").replace(/\s+/g, " ").trim();
    if (/^SELECT id, slug, name FROM room WHERE/.test(text)) {
      return Promise.resolve([{ ...ROOM, created_at: new Date(Date.UTC(2026, 8, 1)) }]);
    }
    if (/^SELECT id, status, started_at FROM bench_session WHERE room_id = \?/.test(text)) {
      return Promise.resolve(active ? [active] : []);
    }
    if (/^SELECT s\.id, s\.room_id, s\.label/.test(text)) {
      const dated = values.some((v) => typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v));
      return Promise.resolve(dated ? todaySessions : openRecording);
    }
    if (/FROM bench_listener WHERE room_id = \?/.test(text)) {
      return Promise.resolve([{ room_id: ROOM.id, tab_id: "t", last_poll_at: new Date().toISOString(), recording_session_id: null, paused: false }]);
    }
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
  return { ...actual };
});

const { BENCH_TOOLS } = await import("@/lib/mcp/tools/bench");
const diffRoom = BENCH_TOOLS.find((t) => t.name === "scribe_diff_room")!;

const rollup = (id: string, startedMs: number, lastPieceMs: number | null): Row => ({
  id, room_id: ROOM.id, label: null, mic_label: null,
  started_at: new Date(startedMs).toISOString(), ended_at: null, status: "recording", notes: null,
  room_name: ROOM.name, room_slug: ROOM.slug,
  chunk_count: lastPieceMs === null ? 0 : 3, verified_count: 0, total_bytes: 0, gap_ms: 0, gap_count: 0,
  last_chunk_at: lastPieceMs === null ? null : new Date(lastPieceMs).toISOString(),
  last_any_chunk_at: lastPieceMs === null ? null : new Date(lastPieceMs).toISOString(),
  backup_chunk_count: 0, backup_verified_count: 0, primary_lost_count: 0, primary_restored_count: 0,
});

const rowOf = async (): Promise<Row> => {
  const out = (await diffRoom.handler({}, { origin: "https://preview.example" } as never)) as { rooms: Row[] };
  expect(out.rooms).toHaveLength(1);
  return out.rooms[0]!;
};

beforeEach(() => {
  active = null;
  todaySessions = [];
  openRecording = [];
});

describe("scribe_rooms now — a recording session with no piece stalls from started_at", () => {
  it("0 pieces, started 2 h ago, not in today's list: stalled true, not_delivering_minutes 120", async () => {
    const started = Date.now() - 2 * 3_600_000;
    active = { id: "bs_silent1", status: "recording", started_at: new Date(started).toISOString() };
    openRecording = [rollup("bs_silent1", started, null)];
    const row = await rowOf();
    expect((row.flags as Row).stalled).toBe(true);
    expect(row.stalled_age_ms as number).toBeGreaterThanOrEqual(2 * 3_600_000);
    expect(row.not_delivering_minutes).toBe(120);
  });

  it("a fresh piece: not stalled, nothing reported", async () => {
    const started = Date.now() - 2 * 3_600_000;
    active = { id: "bs_live1", status: "recording", started_at: new Date(started).toISOString() };
    openRecording = [rollup("bs_live1", started, Date.now() - 30_000)];
    const row = await rowOf();
    expect((row.flags as Row).stalled).toBe(false);
    expect(row.stalled_age_ms).toBeNull();
    expect(row.not_delivering_minutes).toBeNull();
  });

  it("a session in both lists counts once", async () => {
    const started = Date.now() - 3_600_000;
    active = { id: "bs_both", status: "recording", started_at: new Date(started).toISOString() };
    todaySessions = [rollup("bs_both", started, null)];
    openRecording = [rollup("bs_both", started, null)];
    const row = await rowOf();
    expect(row.not_delivering_minutes).toBe(60);
  });
});

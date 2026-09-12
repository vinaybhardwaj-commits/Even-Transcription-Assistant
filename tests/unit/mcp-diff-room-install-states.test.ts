/**
 * Tier 1 §2, orchestrator fix-up ruling seam 1 — `scribe_diff_room` surfaces the named install
 * states of the Mac bound to the room, as `room_state.flags` and `room_state.drift_since`.
 *
 * The build shipped the states to the fleet card only, which left acceptance item 1 ("mute the
 * TONOR three minutes, read SILENT_WHILE_RECORDING in `scribe_diff_room`") with no surface. This
 * file is that surface: the read the door makes, what it does with each answer, and the three
 * cases that must read as NULL rather than as an empty list — no Mac, never evaluated, read failed.
 *
 * No live database: `sql` is mocked and every statement captured. Everything `diffRoom` reads
 * besides the install row is answered empty; those sections name themselves in `degraded` and are
 * not what is under test here.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

type Row = Record<string, unknown>;
type Call = { text: string; values: unknown[] };

const calls: Call[] = [];
const ROOM = { id: "room_home0001", slug: "home-office", name: "Home Office" };

/** What the bound install row holds in `state_flags`, or an Error to throw for the read. */
let stateFlags: unknown = null;
/** false = the room has no bound Mac at all, so the SELECT returns no row. */
let hasInstall = true;

vi.mock("@/lib/db", () => {
  const sql = (strings: TemplateStringsArray, ...values: unknown[]) => {
    const text = strings.join("?").replace(/\s+/g, " ").trim();
    calls.push({ text, values });
    if (/^SELECT id, slug, name FROM room WHERE/.test(text)) {
      return Promise.resolve([{ ...ROOM, created_at: new Date(Date.UTC(2026, 8, 1)) }]);
    }
    if (/^SELECT state_flags FROM room_install/.test(text)) {
      if (stateFlags instanceof Error) return Promise.reject(stateFlags);
      return Promise.resolve(hasInstall ? [{ state_flags: stateFlags }] : []);
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
  return { ...actual, getListener: async () => null };
});

const { BENCH_TOOLS } = await import("@/lib/mcp/tools/bench");
const diffRoom = BENCH_TOOLS.find((t) => t.name === "scribe_diff_room")!;

beforeEach(() => {
  calls.length = 0;
  stateFlags = null;
  hasInstall = true;
});

const roomState = async (): Promise<Row> => {
  const out = (await diffRoom.handler({}, { origin: "https://preview.example" })) as { rooms: Row[] };
  expect(out.rooms).toHaveLength(1);
  return out.rooms[0]!.room_state as Row;
};

describe("scribe_diff_room carries the install's named states", () => {
  it("reports the flags the install row holds, in the canonical order, with the drift clock", async () => {
    stateFlags = { flags: ["DISK_LOW", "SILENT_WHILE_RECORDING"], drift_since: "2026-09-11T16:00:00.000Z" };
    const st = await roomState();
    expect(st.flags).toEqual(["SILENT_WHILE_RECORDING", "DISK_LOW"]);
    expect(st.drift_since).toBe("2026-09-11T16:00:00.000Z");
  });

  it("reads jsonb handed back as text just as it reads a parsed object", async () => {
    stateFlags = JSON.stringify({ flags: ["CLIPPING"], drift_since: null });
    expect((await roomState()).flags).toEqual(["CLIPPING"]);
  });

  it("an evaluated, healthy Mac is an EMPTY LIST — looked at, and well", async () => {
    stateFlags = { flags: [], drift_since: null };
    const st = await roomState();
    expect(st.flags).toEqual([]);
    expect(st.drift_since).toBeNull();
  });

  it("no bound Mac, never evaluated, and a failed read are all NULL — never []", async () => {
    hasInstall = false;
    expect((await roomState()).flags).toBeNull();

    hasInstall = true;
    stateFlags = null; // the column as migration 0081 left it
    expect((await roomState()).flags).toBeNull();

    stateFlags = new Error("column state_flags does not exist");
    const out = (await diffRoom.handler({}, { origin: "https://preview.example" })) as { rooms: Row[] };
    expect((out.rooms[0]!.room_state as Row).flags).toBeNull();
    // A failed read names itself rather than passing for a healthy room.
    expect(out.rooms[0]!.degraded).toEqual(expect.arrayContaining([expect.stringContaining("install_state_unavailable")]));
  });

  it("the read is one statement, on the room's BOUND install only", async () => {
    await roomState();
    const q = calls.filter((c) => /^SELECT state_flags FROM room_install/.test(c.text));
    expect(q).toHaveLength(1);
    expect(q[0]!.text).toMatch(/WHERE room_id = \? AND enrolled_at IS NOT NULL AND retired_at IS NULL/);
    expect(q[0]!.text).toMatch(/ORDER BY created_at DESC LIMIT 1/);
    expect(q[0]!.values).toEqual([ROOM.id]);
  });

  it("the additive fields sit BESIDE the state word, which is untouched", async () => {
    stateFlags = { flags: ["ENCODER_STALLED"], drift_since: null };
    const st = await roomState();
    // roomState()'s own precedence chain still answers; flags are orthogonal to it.
    expect(typeof st.state).toBe("string");
    expect(st).toHaveProperty("label");
    expect(st).toHaveProperty("start_available");
    expect(st.flags).toEqual(["ENCODER_STALLED"]);
  });

  it("the tool description names the new fields, so a caller is not reading an undocumented key", () => {
    expect(diffRoom.description).toContain("room_state also carries flags and drift_since");
    expect(diffRoom.description).toContain("channel_locked");
  });
});

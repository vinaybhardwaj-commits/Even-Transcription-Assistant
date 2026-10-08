/**
 * S0.6 (8 Oct 2026) — bench-timeline's brain read bound ONE parameter to a statement with TWO
 * placeholders ("bind message supplies 1 parameters, but prepared statement requires 2", 3 prod
 * hits on 7 Oct). The test asserts the parameter count against the SQL text itself, so adding a
 * placeholder to SQL_VISITS_FOR_DAY without updating the caller fails here, not in production.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const queryCalls: Array<{ text: string; params: unknown[] }> = [];
const warnings: string[] = [];

vi.mock("@/lib/db", () => ({ sql: Object.assign(() => Promise.resolve([]), { transaction: async () => [] }), db: {} }));

vi.mock("@/lib/brain/db", () => ({
  query: vi.fn(async (text: string, params: unknown[] = []) => {
    queryCalls.push({ text, params });
    // Behave like Postgres: refuse a bind whose count disagrees with the statement's highest $n.
    const highest = Math.max(0, ...[...text.matchAll(/\$(\d+)/g)].map((m) => Number(m[1])));
    if (params.length !== highest) {
      throw new Error(`bind message supplies ${params.length} parameters, but prepared statement "" requires ${highest}`);
    }
    return { rows: [] };
  }),
}));

vi.mock("@/lib/brain/state", async (orig) => {
  const actual = await orig<typeof import("@/lib/brain/state")>();
  return { ...actual, findRoomDay: vi.fn(async () => ({ id: "rd_1" })) };
});

vi.mock("@/lib/bench", () => ({
  findBenchSession: vi.fn(),
  listBenchConsultMarks: vi.fn(async () => []),
  listBenchEvents: vi.fn(async () => []),
}));

const { renderBenchTimeline } = await import("@/lib/bench-timeline");
const { SQL_VISITS_FOR_DAY, DEFAULT_ARM } = await import("@/lib/brain/state");

const session = {
  id: "bs_1", room_id: "room_1", label: null, mic_label: null, started_at: "2026-10-07T04:00:00.000Z", ended_at: null,
  status: "recording" as const, notes: null, room_slug: "opd-1", room_name: "OPD 1",
};

beforeEach(() => {
  queryCalls.length = 0;
  warnings.length = 0;
  vi.spyOn(console, "warn").mockImplementation((...a: unknown[]) => void warnings.push(a.map(String).join(" ")));
});

describe("bench-timeline visit read", () => {
  it("binds exactly as many parameters as SQL_VISITS_FOR_DAY has placeholders", async () => {
    await renderBenchTimeline("bs_1", session);
    const call = queryCalls.find((c) => c.text === SQL_VISITS_FOR_DAY);
    expect(call, "the visits statement was never run").toBeDefined();
    const placeholders = new Set([...SQL_VISITS_FOR_DAY.matchAll(/\$(\d+)/g)].map((m) => Number(m[1])));
    expect(call!.params).toHaveLength(placeholders.size);
    expect(call!.params).toEqual(["rd_1", DEFAULT_ARM]);
  });

  it("does not log 'brain read failed' for a healthy brain", async () => {
    await renderBenchTimeline("bs_1", session);
    expect(warnings.filter((w) => w.includes("brain read failed"))).toEqual([]);
  });
});

/**
 * scribe_room_levels (lib/mcp/tools/levels.ts) — read-only MCP tool, no admin cookie.
 *
 * Mocked `sql`; asserts the tool reuses readRoomLevelDay's own query (same shape as
 * GET /api/admin/bench/levels) and defaults/validates the same way the route does.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

type Row = Record<string, unknown>;
type Call = { text: string; values: unknown[] };
const calls: Call[] = [];
let responder: (text: string, values: unknown[]) => Row[] | Promise<Row[]> = () => [];

vi.mock("@/lib/db", () => {
  const sql = (strings: TemplateStringsArray, ...values: unknown[]) => {
    const text = strings.raw.join("?").replace(/\s+/g, " ").trim();
    calls.push({ text, values });
    return Promise.resolve(responder(text, values));
  };
  return { sql };
});

import { LEVEL_TOOLS, MAX_RANGE_HOURS, DEFAULT_LIMIT, MAX_LIMIT, parseIstBound, istDaysSpanned } from "@/lib/mcp/tools/levels";
import { LEVEL_TIMELINE_BUCKET_SECONDS } from "@/lib/bench-levels";

const tool = LEVEL_TOOLS.find((t) => t.name === "scribe_room_levels")!;
const ctx = { origin: "https://x", actor: "mcp:test", scopes: new Set(["read"] as const) };

const row = (overrides: Partial<Row> = {}): Row => ({
  sampled_at: "2026-09-22T14:49:00.000Z",
  peak: 0.12,
  avg: 0.03,
  zero_ratio: 0.0007,
  session_open: true,
  tape_advancing: true,
  samples: 7,
  ...overrides,
});

beforeEach(() => {
  calls.length = 0;
  responder = () => [row()];
});

describe("scribe_room_levels", () => {
  it("is registered read-scope with room_id required", () => {
    expect(tool.scope).toBe("read");
    expect((tool.inputSchema as { required?: string[] }).required).toEqual(["room_id"]);
  });

  it("is defined exactly once", () => {
    expect(LEVEL_TOOLS.filter((t) => t.name === "scribe_room_levels")).toHaveLength(1);
  });

  it("room_id required: absent, blank or non-string is refused without a query", async () => {
    for (const args of [{}, { room_id: "" }, { room_id: "   " }, { room_id: 5 }]) {
      const out = (await tool.handler(args as Record<string, unknown>, ctx)) as Row;
      expect(out.error).toBe("room_id_required");
      expect(out.samples).toEqual([]);
    }
    expect(calls).toHaveLength(0);
  });

  it("defaults ist_date to today (IST) when omitted", async () => {
    const out = (await tool.handler({ room_id: "room_1" }, ctx)) as Row;
    expect(typeof out.ist_date).toBe("string");
    expect(out.ist_date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(calls[0]!.values).toContain("room_1");
    expect(calls[0]!.values).toContain(out.ist_date);
  });

  it("an invalid ist_date falls back to today rather than reaching the query as garbage", async () => {
    responder = () => [];
    const out = (await tool.handler({ room_id: "room_1", ist_date: "22-09-2026" }, ctx)) as Row;
    expect(out.ist_date).not.toBe("22-09-2026");
    expect(out.ist_date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it("a valid ist_date is passed through verbatim", async () => {
    const out = (await tool.handler({ room_id: "room_1", ist_date: "2026-09-15" }, ctx)) as Row;
    expect(out.ist_date).toBe("2026-09-15");
    expect(calls[0]!.values).toContain("2026-09-15");
  });

  it("returns the same shape GET /api/admin/bench/levels returns", async () => {
    const out = (await tool.handler({ room_id: "room_1", ist_date: "2026-09-22" }, ctx)) as Row;
    // The admin route's five keys are all still here, unchanged; the range read adds its own.
    for (const k of ["bucket_seconds", "ist_date", "room_id", "sample_count", "samples"]) expect(out).toHaveProperty(k);
    expect(Object.keys(out).sort()).toEqual(
      ["bucket_seconds", "ist_date", "ist_days_read", "limit", "room_id", "sample_count", "samples", "truncated"]);
    expect(out.bucket_seconds).toBe(LEVEL_TIMELINE_BUCKET_SECONDS);
    expect(out.sample_count).toBe(7);
    expect((out.samples as Row[])[0]).toMatchObject({ peak: 0.12, avg: 0.03, zero_ratio: 0.0007, session_open: true, tape_advancing: true, samples: 7 });
  });

  // ── an IST time range ──────────────────────────────────────────────────────────────────────────
  describe("an IST time range", () => {
    const ist = (day: string, clock: string) => Date.parse(`${day}T${clock}.000+05:30`);
    const bucketsAcross = (day: string, clocks: string[]) =>
      clocks.map((c) => row({ sampled_at: new Date(ist(day, c)).toISOString() }));

    it("keeps only the buckets inside [from, to) and reads the aggregator once per IST day", async () => {
      responder = () => bucketsAcross("2026-09-22", ["09:00:00", "10:00:00", "11:00:00", "12:00:00"]);
      const out = (await tool.handler({ room_id: "r", ist_date: "2026-09-22", from: "10:00", to: "12:00" }, ctx)) as Row;
      expect((out.samples as Row[]).map((x) => x.t_ms)).toEqual([ist("2026-09-22", "10:00:00"), ist("2026-09-22", "11:00:00")]);
      expect(out.ist_days_read).toEqual(["2026-09-22"]);
      expect(calls).toHaveLength(1);                       // one day, one call to readRoomLevelDay
      expect(out.sample_count).toBe(14);                   // the RETURNED buckets' rows, not the day's
    });

    it("`to` is exclusive", async () => {
      responder = () => bucketsAcross("2026-09-22", ["10:00:00", "11:00:00"]);
      const out = (await tool.handler({ room_id: "r", ist_date: "2026-09-22", from: "10:00", to: "11:00" }, ctx)) as Row;
      expect((out.samples as Row[]).map((x) => x.t_ms)).toEqual([ist("2026-09-22", "10:00:00")]);
    });

    it("a range crossing midnight reads BOTH IST days, still through the one aggregator", async () => {
      responder = (_t, v) => bucketsAcross(String(v[1]), ["22:30:00", "23:30:00", "00:30:00", "01:30:00"]);
      const out = (await tool.handler(
        { room_id: "r", ist_date: "2026-09-22", from: "2026-09-22T22:00:00+05:30", to: "2026-09-23T02:00:00+05:30" }, ctx)) as Row;
      expect(out.ist_days_read).toEqual(["2026-09-22", "2026-09-23"]);
      expect(calls).toHaveLength(2);
      expect(calls.every((c) => /FROM bench_level_sample/i.test(c.text))).toBe(true);
    });

    it("an EMPTY range returns nothing and says so, without querying", async () => {
      responder = () => bucketsAcross("2026-09-22", ["10:00:00"]);
      for (const args of [{ from: "11:00", to: "11:00" }, { from: "12:00", to: "10:00" }]) {
        const out = (await tool.handler({ room_id: "r", ist_date: "2026-09-22", ...args }, ctx)) as Row;
        expect(out).toMatchObject({ error: "empty_range", samples: [], sample_count: 0 });
        expect(calls).toHaveLength(0);
      }
    });

    it("a range with NO buckets in it is empty but not an error", async () => {
      responder = () => bucketsAcross("2026-09-22", ["10:00:00"]);
      const out = (await tool.handler({ room_id: "r", ist_date: "2026-09-22", from: "14:00", to: "15:00" }, ctx)) as Row;
      expect(out.samples).toEqual([]);
      expect(out.sample_count).toBe(0);
      expect(out.error).toBeUndefined();
    });

    it(`a range over ${MAX_RANGE_HOURS} h is REFUSED, not truncated, and never reaches the database`, async () => {
      responder = () => bucketsAcross("2026-09-22", ["10:00:00"]);
      const out = (await tool.handler(
        { room_id: "r", ist_date: "2026-09-22", from: "2026-09-20T00:00:00+05:30", to: "2026-09-23T00:00:00+05:30" }, ctx)) as Row;
      expect(out).toMatchObject({ error: "range_too_long", max_range_hours: MAX_RANGE_HOURS, samples: [] });
      expect(calls).toHaveLength(0);
    });

    it("exactly 24 h is allowed — the cap is a ceiling, not a fencepost off by one", async () => {
      responder = () => bucketsAcross("2026-09-22", ["10:00:00"]);
      const out = (await tool.handler(
        { room_id: "r", ist_date: "2026-09-22", from: "2026-09-22T00:00:00+05:30", to: "2026-09-23T00:00:00+05:30" }, ctx)) as Row;
      expect(out.error).toBeUndefined();
    });

    it("a malformed bound is refused rather than read as midnight", async () => {
      responder = () => bucketsAcross("2026-09-22", ["10:00:00"]);
      for (const bad of ["25:00", "half past ten", "2026-09-22"]) {
        const out = (await tool.handler({ room_id: "r", ist_date: "2026-09-22", from: bad, to: "12:00" }, ctx)) as Row;
        expect(out).toMatchObject({ error: "bad_range", samples: [] });
      }
      expect(calls).toHaveLength(0);
    });

    it("parseIstBound reads clock time as IST and a full ISO stamp as itself", () => {
      expect(parseIstBound("09:30", "2026-09-22")).toBe(Date.parse("2026-09-22T09:30:00.000+05:30"));
      expect(parseIstBound("09:30:15", "2026-09-22")).toBe(Date.parse("2026-09-22T09:30:15.000+05:30"));
      expect(parseIstBound("2026-09-22T04:00:00Z", "2026-09-22")).toBe(Date.parse("2026-09-22T04:00:00Z"));
      expect(parseIstBound("2026-09-22", "2026-09-22")).toBeNull();
    });

    it("istDaysSpanned names one day inside a day and two across midnight", () => {
      const d = (c: string) => Date.parse(`2026-09-22T${c}+05:30`);
      expect(istDaysSpanned(d("09:00:00"), d("17:00:00"))).toEqual(["2026-09-22"]);
      expect(istDaysSpanned(d("22:00:00"), d("22:00:00") + 4 * 3600_000)).toEqual(["2026-09-22", "2026-09-23"]);
    });
  });

  // ── the row cap ────────────────────────────────────────────────────────────────────────────────
  describe("the row cap", () => {
    const many = (n: number) => Array.from({ length: n }, (_, i) =>
      row({ sampled_at: new Date(Date.parse("2026-09-22T00:00:00.000+05:30") + i * 15_000).toISOString() }));

    it(`returns at most ${DEFAULT_LIMIT} buckets by default, and says where to resume`, async () => {
      responder = () => many(DEFAULT_LIMIT + 5);
      const out = (await tool.handler({ room_id: "r", ist_date: "2026-09-22" }, ctx)) as Row;
      expect((out.samples as Row[]).length).toBe(DEFAULT_LIMIT);
      expect(out.truncated).toBe(true);
      expect(out.limit).toBe(DEFAULT_LIMIT);
      expect(out.next_from_ms).toBe((out.samples as Row[])[DEFAULT_LIMIT - 1]!.t_ms as number + 15_000);
      expect(out.sample_count).toBe(DEFAULT_LIMIT * 7);     // counts the RETURNED buckets only
    });

    it("an answer that fits is not marked truncated and names no resume point", async () => {
      responder = () => many(3);
      const out = (await tool.handler({ room_id: "r", ist_date: "2026-09-22" }, ctx)) as Row;
      expect(out.truncated).toBe(false);
      expect(out.next_from_ms).toBeUndefined();
    });

    it(`an explicit limit is honoured and clamped to ${MAX_LIMIT} (24 h of buckets)`, async () => {
      responder = () => many(50);
      expect(((await tool.handler({ room_id: "r", limit: 10 }, ctx)) as Row).samples).toHaveLength(10);
      expect(((await tool.handler({ room_id: "r", limit: 99_999 }, ctx)) as Row).limit).toBe(MAX_LIMIT);
      // argInt is the shared helper: an out-of-range number is CLAMPED (0 -> the minimum 1), while a
      // missing or non-numeric one falls back to the default. This tool does not invent its own rule.
      expect(((await tool.handler({ room_id: "r", limit: 0 }, ctx)) as Row).limit).toBe(1);
      expect(((await tool.handler({ room_id: "r", limit: "lots" }, ctx)) as Row).limit).toBe(DEFAULT_LIMIT);
    });
  });

  it("carries no transcript text, clinician or patient field — the table holds none, and none is invented", async () => {
    const out = (await tool.handler({ room_id: "room_1" }, ctx)) as Row;
    const seen = JSON.stringify(out);
    expect(seen).not.toMatch(/transcript|clinician|patient|doctor_name/i);
  });

  it("a query failure fails safe: degraded, empty samples, no throw", async () => {
    responder = () => { throw new Error("db down"); };
    const out = (await tool.handler({ room_id: "room_1" }, ctx)) as Row;
    expect(out.degraded).toBe(true);
    expect(out.samples).toEqual([]);
    expect(out.sample_count).toBe(0);
  });

  it("queries bench_level_sample only, scoped by room_id and ist_date", async () => {
    await tool.handler({ room_id: "room_9", ist_date: "2026-09-20" }, ctx);
    expect(calls[0]!.text).toMatch(/FROM bench_level_sample/i);
    expect(calls[0]!.text).toMatch(/room_id\s*=/i);
    expect(calls[0]!.text).toMatch(/ist_date\s*=/i);
  });
});

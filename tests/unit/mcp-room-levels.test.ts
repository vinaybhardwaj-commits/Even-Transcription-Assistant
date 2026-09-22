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

import { LEVEL_TOOLS } from "@/lib/mcp/tools/levels";
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
    expect(Object.keys(out).sort()).toEqual(["bucket_seconds", "ist_date", "room_id", "sample_count", "samples"]);
    expect(out.bucket_seconds).toBe(LEVEL_TIMELINE_BUCKET_SECONDS);
    expect(out.sample_count).toBe(7);
    expect((out.samples as Row[])[0]).toMatchObject({ peak: 0.12, avg: 0.03, zero_ratio: 0.0007, session_open: true, tape_advancing: true, samples: 7 });
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

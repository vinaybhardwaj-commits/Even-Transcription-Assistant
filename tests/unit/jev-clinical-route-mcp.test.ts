/**
 * lib/mcp/tools/jev.ts's scribe_clinical_route_replay — the operator-door wrapper around
 * runClinicalRouteAsync (order JEV-U6-ROUTE). runClinicalRouteAsync's own behaviour (the flag
 * gate, the SQL shape, per-category counting) is tests/unit/jev-clinical-route.test.ts's job;
 * this file mocks it as a black box and tests only what the TOOL itself does: argument
 * validation, passing room_day_id through untouched, shaping the response, and failing safe.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

type Row = Record<string, unknown>;
const runClinicalRouteAsyncMock = vi.fn(async (_roomDayId: string) => ({
  ran: true,
  windowsTotal: 0,
  windowsAsked: 0,
  byCategory: {
    clinical_consultation: 0,
    staff_or_admin_talk: 0,
    phone_call: 0,
    social_chatter: 0,
    garbled_or_no_real_speech: 0,
    cannot_tell: 0,
  },
}));
vi.mock("@/lib/jev/clinical-route", () => ({ runClinicalRouteAsync: (roomDayId: string) => runClinicalRouteAsyncMock(roomDayId) }));
vi.mock("@/lib/brain/db", () => ({ query: vi.fn() }));
vi.mock("@/lib/jobs/submit", () => ({ submitJob: vi.fn() }));

import { JEV_TOOLS } from "@/lib/mcp/tools/jev";
import type { ToolContext } from "@/lib/mcp/registry";

const tool = () => {
  const t = JEV_TOOLS.find((x) => x.name === "scribe_clinical_route_replay");
  if (!t) throw new Error("scribe_clinical_route_replay not registered");
  return t;
};
const ctx: ToolContext = { origin: "https://preview.example", actor: "test-actor", scopes: new Set(["invoke"]) };

beforeEach(() => {
  runClinicalRouteAsyncMock.mockClear();
});

describe("scribe_clinical_route_replay — argument validation", () => {
  it("missing room_day_id: returns { ran:false, error }, never calls runClinicalRouteAsync", async () => {
    const out = (await tool().handler({}, ctx)) as Row;
    expect(out).toEqual({ ran: false, error: "room_day_id_required" });
    expect(runClinicalRouteAsyncMock).not.toHaveBeenCalled();
  });

  it("an empty-string room_day_id is treated the same as missing", async () => {
    const out = (await tool().handler({ room_day_id: "" }, ctx)) as Row;
    expect(out.ran).toBe(false);
    expect(runClinicalRouteAsyncMock).not.toHaveBeenCalled();
  });
});

describe("scribe_clinical_route_replay — passes room_day_id through untouched, shapes the response", () => {
  it("calls runClinicalRouteAsync with exactly the given room_day_id", async () => {
    await tool().handler({ room_day_id: "rd_abc123" }, ctx);
    expect(runClinicalRouteAsyncMock).toHaveBeenCalledTimes(1);
    expect(runClinicalRouteAsyncMock).toHaveBeenCalledWith("rd_abc123");
  });

  it("returns { ok:true, ...outcome } — the outcome's own shape passed through, not reinterpreted", async () => {
    runClinicalRouteAsyncMock.mockResolvedValueOnce({
      ran: true,
      windowsTotal: 12,
      windowsAsked: 9,
      byCategory: {
        clinical_consultation: 5,
        staff_or_admin_talk: 2,
        phone_call: 1,
        social_chatter: 0,
        garbled_or_no_real_speech: 1,
        cannot_tell: 0,
      },
    });
    const out = (await tool().handler({ room_day_id: "rd_abc123" }, ctx)) as Row;
    expect(out).toEqual({
      ok: true,
      ran: true,
      windowsTotal: 12,
      windowsAsked: 9,
      byCategory: {
        clinical_consultation: 5,
        staff_or_admin_talk: 2,
        phone_call: 1,
        social_chatter: 0,
        garbled_or_no_real_speech: 1,
        cannot_tell: 0,
      },
    });
  });

  it("flag-off outcome ({ran:false}, zero counts) is passed through as-is, not treated as an error", async () => {
    runClinicalRouteAsyncMock.mockResolvedValueOnce({
      ran: false,
      windowsTotal: 0,
      windowsAsked: 0,
      byCategory: { clinical_consultation: 0, staff_or_admin_talk: 0, phone_call: 0, social_chatter: 0, garbled_or_no_real_speech: 0, cannot_tell: 0 },
    });
    const out = (await tool().handler({ room_day_id: "rd_abc123" }, ctx)) as Row;
    expect(out.ok).toBe(true);
    expect(out.ran).toBe(false);
  });

  it("the response never contains a text/english field — counts and flags only", async () => {
    runClinicalRouteAsyncMock.mockResolvedValueOnce({
      ran: true,
      windowsTotal: 3,
      windowsAsked: 3,
      byCategory: { clinical_consultation: 3, staff_or_admin_talk: 0, phone_call: 0, social_chatter: 0, garbled_or_no_real_speech: 0, cannot_tell: 0 },
    });
    const out = (await tool().handler({ room_day_id: "rd_abc123" }, ctx)) as Row;
    expect(JSON.stringify(out)).not.toMatch(/english|text|transcript/i);
  });
});

describe("scribe_clinical_route_replay — fails safe", () => {
  it("a thrown error from runClinicalRouteAsync degrades to { ran:false, degraded:true, error } rather than throwing", async () => {
    runClinicalRouteAsyncMock.mockRejectedValueOnce(new Error("db unreachable"));
    const out = (await tool().handler({ room_day_id: "rd_abc123" }, ctx)) as Row;
    expect(out.degraded).toBe(true);
    expect(out.ran).toBe(false);
    expect(String(out.error)).toContain("db unreachable");
  });
});

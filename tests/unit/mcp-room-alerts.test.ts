/**
 * scribe_room_alerts — the watchdog outbox's read door. What matters is what a FAILED read looks like: never an empty list a relay could read as
 * "no new alerts" (eta-refuter F4). Only `ok: true` means the outbox was read.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const R = vi.hoisted(() => ({ impl: null as null | ((o: unknown) => Promise<unknown>), calls: [] as unknown[] }));
vi.mock("@/lib/room-alerts", async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  readRoomAlerts: async (o: unknown) => { R.calls.push(o); return R.impl!(o); },
}));

import { ROOM_ALERT_TOOLS } from "@/lib/mcp/tools/room-alerts";
import { PUBLISHED_TOOLS } from "@/lib/mcp/surface";

const tool = ROOM_ALERT_TOOLS.find((t) => t.name === "scribe_room_alerts")!;
const call = (args: Record<string, unknown> = {}) => tool.handler(args, { scopes: new Set(["read"]) } as never) as Promise<Record<string, unknown>>;

beforeEach(() => { R.calls.length = 0; R.impl = async () => ({ ok: true, new: [], late: [], head_id: 0, heartbeat: { state: "none" } }); });

describe("scribe_room_alerts", () => {
  it("is a read-scope tool, published exactly once", () => {
    expect(tool.scope).toBe("read");
    expect(PUBLISHED_TOOLS.filter((t) => t.name === "scribe_room_alerts")).toHaveLength(1);
  });

  it("a successful read says ok:true and passes the outbox's answer through", async () => {
    const r = await call({ after_id: 7 });
    expect(r.ok).toBe(true);
    expect(r.heartbeat).toEqual({ state: "none" });
    expect(R.calls[0]).toMatchObject({ afterId: 7 });
  });

  it("F4 — a FAILED read is `ok:false` with an error, NOT the degraded shape and NOT an empty list a relay could read as 'no alerts'", async () => {
    R.impl = async () => { throw new Error("connection terminated"); };
    const r = await call();
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/connection terminated/);
    expect("new" in r, "no rows key at all, so nothing to read as empty").toBe(false);
    expect("degraded" in r).toBe(false);
  });

  it("arguments are clamped, never trusted", async () => {
    await call({ after_id: -5, lookback_minutes: 9999, limit: 0 });
    await call({ after_id: "12", lookback_minutes: "3", limit: "500" });
    await call({});
    expect(R.calls).toEqual([
      { afterId: 0, lookbackMinutes: 60, limit: 1 },
      { afterId: 12, lookbackMinutes: 3, limit: 100 },
      { afterId: 0, lookbackMinutes: 10, limit: 50 },
    ]);
  });
});

/**
 * Sentinel S6 read: sentinelView (fresh, the 600 s boundary, unknown code, fail-closed words) and readSentinel (one query, newest per room,
 * failed read). Fake sql only; no database, no kiosk.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

type Row = Record<string, unknown>;
const H = vi.hoisted(() => ({ rows: { value: [] as Row[] }, fail: { value: false }, calls: [] as Array<{ text: string; values: unknown[] }> }));

vi.mock("@/lib/db", () => ({
  sql: (strings: TemplateStringsArray, ...values: unknown[]) => {
    const text = strings.raw.join("?").replace(/\s+/g, " ").trim();
    H.calls.push({ text, values });
    if (/FROM kiosk_health_events/.test(text) && /'sentinel'/.test(text)) {
      if (H.fail.value) return Promise.reject(new Error("boom postgres://user:pw@host/db"));
      return Promise.resolve(H.rows.value);
    }
    return Promise.resolve([]);
  },
}));

import { sentinelView, readSentinel, SENTINEL_SILENT_S } from "@/lib/sentinel-read";

const NOW = Date.parse("2026-10-17T05:00:00.000Z");
const ago = (s: number, base = NOW) => new Date(base - s * 1000).toISOString();
const pl = (over: Row = {}): Row => ({ code: "MIC_MUTED_TONOR", mic_class: "tonor", zr: 0.82, peak: 0.0009, last_action: null, last_result: null, mode: "shadow", ...over });
const row = (room_id: string, payload: Row, receivedAgoS = 30, base = NOW) => ({ room_id, received_at: ago(receivedAgoS, base), payload, rn: 1 });

describe("sentinelView — freshness", () => {
  it("a fresh row is the room's data, with the payload passed through", () => {
    const v = sentinelView(row("room_a", pl({ last_action: "coreaudiod_restart", last_result: "healed" })), NOW)!;
    expect(v).toEqual({
      code: "MIC_MUTED_TONOR", mic_class: "tonor", zr: 0.82, peak: 0.0009,
      last_action: "coreaudiod_restart", last_result: "healed", mode: "shadow",
      updated_at: ago(30), age_s: 30,
    });
  });
  it("exactly 600 s old is still current (the rule is 'more than 600 s')", () => {
    expect(sentinelView(row("room_a", pl(), SENTINEL_SILENT_S), NOW)).not.toBeNull();
  });
  it("601 s old: no data (the forwarder is down or the room went quiet; the tile says nothing)", () => {
    expect(sentinelView(row("room_a", pl(), SENTINEL_SILENT_S + 1), NOW)).toBeNull();
  });
  it("no row, or an unreadable received_at: no data", () => {
    expect(sentinelView(undefined, NOW)).toBeNull();
    expect(sentinelView(null, NOW)).toBeNull();
    expect(sentinelView({ room_id: "room_a", received_at: "not a time", payload: pl(), rn: 1 }, NOW)).toBeNull();
  });
});

describe("sentinelView — never forward what we do not recognise", () => {
  it("an unknown code word is no data", () => {
    expect(sentinelView(row("room_a", pl({ code: "SOME RAW CODE" })), NOW)).toBeNull();
    expect(sentinelView(row("room_a", pl({ code: "mic_muted_tonor" })), NOW)).toBeNull();
    expect(sentinelView(row("room_a", pl({ code: 7 })), NOW)).toBeNull();
  });
  it("an unrecognised class or mode fails closed to the safe word; a malformed ratio or word is dropped", () => {
    const v = sentinelView(row("room_a", pl({ mic_class: "c270", mode: "live", peak: 2.5, last_action: "x".repeat(65) })), NOW)!;
    expect(v.mic_class).toBe("unknown");
    expect(v.mode).toBe("shadow");
    expect(v.peak).toBeNull();
    expect(v.last_action).toBeNull();
    expect(sentinelView(row("room_a", pl({ zr: -0.2 })), NOW)!.zr).toBeNull();
    expect(sentinelView(row("room_a", pl({ zr: "0.9" })), NOW)!.zr).toBeNull();
  });
  it("a payload stored as a JSON string is parsed; junk is no data", () => {
    expect(sentinelView(row("room_a", JSON.stringify(pl()) as never), NOW)!.code).toBe("MIC_MUTED_TONOR");
    expect(sentinelView(row("room_a", "not json" as never), NOW)).toBeNull();
  });
});

describe("readSentinel", () => {
  beforeEach(() => {
    H.calls.length = 0;
    H.rows.value = [];
    H.fail.value = false;
  });
  it("one bound query, newest sentinel row per room, windowed on ts and received_at", async () => {
    H.rows.value = [
      row("room_a", pl(), 30),
      row("room_b", pl({ code: "OK" }), 40),
    ];
    const r = await readSentinel((await import("@/lib/db")).sql as never, ["room_a", "room_b", "room_a"], NOW);
    expect(r.ok).toBe(true);
    expect(Object.keys(r.byRoom).sort()).toEqual(["room_a", "room_b"]);
    expect(r.byRoom.room_a!.code).toBe("MIC_MUTED_TONOR");
    expect(r.byRoom.room_b!.code).toBe("OK");
    expect(H.calls).toHaveLength(1);
    const c = H.calls[0]!;
    expect(c.text).toMatch(/row_number\(\) OVER \(PARTITION BY k\.room_id ORDER BY k\.received_at DESC/);
    expect(c.text).toMatch(/k\.kind = 'sentinel'/);
    expect(c.text).toMatch(/k\.ts >= \?::timestamptz - interval '24 hours'/); // bounded on ts: rides (kind, ts DESC)
    expect(c.values[0]).toEqual(["room_a", "room_b"]);
  });
  it("a room whose newest row is over 600 s old has no entry (stale is no data)", async () => {
    H.rows.value = [row("room_a", pl(), 700), row("room_b", pl(), 30)];
    const r = await readSentinel((await import("@/lib/db")).sql as never, ["room_a", "room_b"], NOW);
    expect(r.ok).toBe(true);
    expect(Object.keys(r.byRoom)).toEqual(["room_b"]);
  });
  it("no rooms: no query", async () => {
    const r = await readSentinel((await import("@/lib/db")).sql as never, [], NOW);
    expect(r).toEqual({ byRoom: {}, ok: true });
    expect(H.calls).toHaveLength(0);
  });
  it("a failed read: ok false, empty, and the error text is not logged", async () => {
    H.fail.value = true;
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const r = await readSentinel((await import("@/lib/db")).sql as never, ["room_a"], NOW);
    expect(r).toEqual({ byRoom: {}, ok: false });
    expect(JSON.stringify(warn.mock.calls)).not.toContain("postgres://");
    warn.mockRestore();
  });
});

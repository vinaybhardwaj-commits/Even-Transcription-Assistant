/**
 * Mic-guard state: the read function (every state, poller_silent, restored-today alert, IST midnight edge), /api/rooms-live/now (admin gets mic_guard,
 * staff and open callers get a byte-identical response), and the bench twin (always has it). Fake sql only; no database, no kiosk.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

type Row = Record<string, unknown>;
const H = vi.hoisted(() => ({ kind: { value: "open" as "admin" | "staff" | "open" }, mgRows: { value: [] as Row[] }, mgFail: { value: false }, calls: [] as Array<{ text: string; values: unknown[] }> }));

vi.mock("@/lib/db", () => ({
  sql: (strings: TemplateStringsArray, ...values: unknown[]) => {
    const text = strings.raw.join("?").replace(/\s+/g, " ").trim();
    H.calls.push({ text, values });
    if (/FROM kiosk_health_events/.test(text) && /'mic_guard'/.test(text)) {
      if (H.mgFail.value) return Promise.reject(new Error("boom postgres://user:pw@host/db"));
      return Promise.resolve(H.mgRows.value);
    }
    if (/FROM room WHERE/.test(text)) return Promise.resolve([{ id: "room_a", slug: "opd-x", name: "OPD X", transcript_enabled: false, visits_enabled: false }]);
    return Promise.resolve([]);
  },
}));
vi.mock("@/lib/brain/db", () => ({
  TOKEN_ENV: "BRAIN_SERVICE_TOKEN",
  getPool: () => ({}),
  query: async () => ({ rows: [], rowCount: 0 }),
}));
vi.mock("@/lib/rooms-live/guard", () => ({ roomsLiveGuard: async () => ({ ok: true, kind: H.kind.value, name: "n" }) }));
vi.mock("@/lib/rooms-live/claims", () => ({ realClaimsPort: () => ({}) }));
vi.mock("@/lib/jev/worker/coverage-view", () => ({ coverageOrNull: async () => null }));
const SNAP = {
  generated_at: "2026-10-16T05:00:00.000Z",
  degraded: [],
  coverage: null,
  steward_status: { state: "unavailable" },
  changes_today: [],
  rooms: [{ room_id: "room_a", label: "A", state: "listening" }, { room_id: "room_b", label: "B", state: "quiet" }],
};
vi.mock("@/lib/rooms-live/snapshot", () => ({ getSnapshot: async () => SNAP }));

import { micGuardBadge, micGuardView, readMicGuard, MG_STATES, type MicGuardState } from "@/lib/micguard-read";
import { readRoomsLive } from "@/lib/admin/rooms-live";

const NOW = Date.parse("2026-10-16T06:00:00.000Z"); // 11:30 IST
const ago = (s: number, base = NOW) => new Date(base - s * 1000).toISOString();
const row = (payload: Row, receivedAgoS = 30, base = NOW): { room_id: string; ts: string; received_at: string; payload: Row } => ({
  room_id: "room_a", ts: ago(receivedAgoS, base), received_at: ago(receivedAgoS, base), payload,
});
const pl = (state: string, over: Row = {}): Row => ({ state, reason: null, last_line_at: ago(20), age_s: 20, restored_today: 0, last_restored_at: null, ...over });

describe("micGuardView — states and alert", () => {
  it("no row -> null", () => {
    expect(micGuardView(undefined, NOW)).toBeNull();
    expect(micGuardView(null, NOW)).toBeNull();
  });
  it.each(MG_STATES.map((s) => [s]))("state %s passes through", (s) => {
    const v = micGuardView(row(pl(s)), NOW)!;
    expect(v.state).toBe(s);
    expect(v.reason).toBeNull();
  });
  it("alert: true for restored, read_error, missing, write_failed, db_missing, stale; false for ok and not_installed", () => {
    const alert = (s: MicGuardState) => micGuardView(row(pl(s)), NOW)!.alert;
    for (const s of ["restored", "read_error", "missing", "write_failed", "db_missing", "stale"] as const) expect(alert(s)).toBe(true);
    for (const s of ["ok", "not_installed"] as const) expect(alert(s)).toBe(false);
  });
  it("a stale reason from the poller is kept", () => {
    const v = micGuardView(row(pl("stale", { reason: "ssh_unreachable", age_s: null })), NOW)!;
    expect([v.state, v.reason, v.alert]).toEqual(["stale", "ssh_unreachable", true]);
  });
  it("an unknown state word becomes read_error/unparsed and is never passed on", () => {
    const v = micGuardView(row(pl("SOME RAW LINE TEXT")), NOW)!;
    expect([v.state, v.reason]).toEqual(["read_error", "unparsed"]);
    expect(JSON.stringify(v)).not.toContain("RAW LINE");
  });
  it("a payload string is parsed; junk payload is read_error", () => {
    expect(micGuardView(row(JSON.stringify(pl("ok")) as never), NOW)!.state).toBe("ok");
    expect(micGuardView(row("not json" as never), NOW)!.state).toBe("read_error");
  });
  it("a bad reason shape is dropped", () => {
    expect(micGuardView(row(pl("stale", { reason: "has spaces; and text" })), NOW)!.reason).toBeNull();
  });
});

describe("micGuardView — ssh_unreachable is an alert only 08:00-21:00 IST (lead addendum)", () => {
  const at = (hhmmIst: string) => Date.parse(`2026-10-16T${hhmmIst}:00+05:30`);
  const unreachable = (t: number) => micGuardView(row(pl("stale", { reason: "ssh_unreachable", age_s: null }), 20, t), t)!;
  it.each([["07:59", false], ["08:00", true], ["20:59", true], ["21:00", false]] as const)("%s IST -> alert %s", (hm, expected) => {
    const v = unreachable(at(hm));
    expect([v.state, v.reason, v.alert]).toEqual(["stale", "ssh_unreachable", expected]);
  });
  it("line_old and poller_silent alert at 03:00 IST", () => {
    const t = at("03:00");
    expect(micGuardView(row(pl("stale", { reason: "line_old" }), 20, t), t)!.alert).toBe(true);
    expect(micGuardView(row(pl("ok"), 700, t), t)!.alert).toBe(true);
  });
});

describe("micGuardView — poller_silent", () => {
  it("newest event 600 s old: still current", () => {
    expect(micGuardView(row(pl("ok"), 600), NOW)!.state).toBe("ok");
  });
  it("newest event 601 s old: stale / poller_silent, alert", () => {
    const v = micGuardView(row(pl("ok"), 601), NOW)!;
    expect([v.state, v.reason, v.alert, v.age_s]).toEqual(["stale", "poller_silent", true, null]);
  });
});

describe("micGuardView — restored today", () => {
  it("restored_today > 0 with a restore today keeps the alert after the line is back to ok, labelled in IST", () => {
    const v = micGuardView(row(pl("ok", { restored_today: 2, last_restored_at: "2026-10-16T09:12:00+05:30" })), NOW)!;
    expect(v.state).toBe("ok");
    expect(v.alert).toBe(true);
    expect(v.restored_label).toBe("restored 09:12 IST");
    expect(v.restored_today).toBe(2);
  });
  it("no restore today: no label, no alert", () => {
    const v = micGuardView(row(pl("ok")), NOW)!;
    expect([v.alert, v.restored_label]).toEqual([false, null]);
  });
  it("IST midnight edge: 23:59 IST the restore of that day still shows; 00:00 IST the next day it does not", () => {
    const received = Date.parse("2026-10-16T18:29:00.000Z"); // 23:59 IST on 16 Oct
    const r = row(pl("ok", { restored_today: 1, last_restored_at: "2026-10-16T23:10:00+05:30" }), 30, received);
    expect(micGuardView(r, received)!.alert).toBe(true);
    const midnight = Date.parse("2026-10-16T18:30:00.000Z"); // 00:00 IST on 17 Oct, row still the newest and 90 s old
    const r2 = row(pl("ok", { restored_today: 1, last_restored_at: "2026-10-16T23:10:00+05:30" }), 90, midnight);
    const v = micGuardView(r2, midnight)!;
    expect(v.alert).toBe(false);
    expect(v.restored_label).toBeNull();
  });
  it("a restore at 00:05 IST counts for the new day", () => {
    const t = Date.parse("2026-10-16T18:40:00.000Z"); // 00:10 IST 17 Oct
    const v = micGuardView(row(pl("ok", { restored_today: 1, last_restored_at: "2026-10-17T00:05:00+05:30" }), 20, t), t)!;
    expect([v.alert, v.restored_label]).toEqual([true, "restored 00:05 IST"]);
  });
  it("restored_today without a stamp falls back to the day the row arrived", () => {
    const v = micGuardView(row(pl("ok", { restored_today: 1 })), NOW)!;
    expect([v.alert, v.restored_label]).toEqual([true, "restored today"]);
  });
});

describe("micGuardBadge", () => {
  it("words and tones", () => {
    expect(micGuardBadge(micGuardView(row(pl("ok")), NOW)!)).toMatchObject({ text: "MIC-PERM ok", tone: "ok" });
    expect(micGuardBadge(micGuardView(row(pl("not_installed")), NOW)!).tone).toBe("idle");
    expect(micGuardBadge(micGuardView(row(pl("ok"), 700), NOW)!)).toMatchObject({ text: "MIC-PERM stale (poller silent)", tone: "alert" });
    expect(micGuardBadge(micGuardView(row(pl("ok", { restored_today: 1, last_restored_at: "2026-10-16T09:12:00+05:30" })), NOW)!).text).toBe("MIC-PERM ok · restored 09:12 IST");
  });
});

describe("readMicGuard", () => {
  beforeEach(() => {
    H.calls.length = 0;
    H.mgRows.value = [];
    H.mgFail.value = false;
    H.kind.value = "open";
  });
  it("one bound query, newest per room, windowed on received_at", async () => {
    H.mgRows.value = [row(pl("ok"))];
    const r = await readMicGuard((await import("@/lib/db")).sql as never, ["room_a", "room_b", "room_a"], NOW);
    expect(r.ok).toBe(true);
    expect(Object.keys(r.byRoom)).toEqual(["room_a"]);
    expect(H.calls).toHaveLength(1);
    const c = H.calls[0]!;
    expect(c.text).toMatch(/DISTINCT ON \(k\.room_id\)/);
    expect(c.text).toMatch(/k\.kind = 'mic_guard'/);
    expect(c.text).toMatch(/received_at >= \?::timestamptz - interval '24 hours'/);
    expect(c.values[0]).toEqual(["room_a", "room_b"]);
  });
  it("no rooms: no query", async () => {
    const r = await readMicGuard((await import("@/lib/db")).sql as never, [], NOW);
    expect(r).toEqual({ byRoom: {}, ok: true });
    expect(H.calls).toHaveLength(0);
  });
  it("a failed read: ok false, empty, and the error text is not logged", async () => {
    H.mgFail.value = true;
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const r = await readMicGuard((await import("@/lib/db")).sql as never, ["room_a"], NOW);
    expect(r).toEqual({ byRoom: {}, ok: false });
    expect(JSON.stringify(warn.mock.calls)).not.toContain("postgres://");
    warn.mockRestore();
  });
});

describe("GET /api/rooms-live/now — mic_guard is admin only", () => {
  beforeEach(() => {
    H.calls.length = 0;
    H.mgFail.value = false;
    H.mgRows.value = [{ room_id: "room_a", ts: new Date().toISOString(), received_at: new Date().toISOString(), payload: pl("restored", { restored_today: 1 }) }];
  });
  it("admin: every room has mic_guard (null where no row)", async () => {
    H.kind.value = "admin";
    const { GET } = await import("@/app/api/rooms-live/now/route");
    const body = await (await GET(new Request("http://x/api/rooms-live/now"))).json();
    expect(body.rooms[0].mic_guard.state).toBe("restored");
    expect(body.rooms[0].mic_guard.alert).toBe(true);
    expect(body.rooms[1].mic_guard).toBeNull();
  });
  it("admin: a failed mic_guard read still answers 200 with null badges", async () => {
    H.kind.value = "admin";
    H.mgFail.value = true;
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { GET } = await import("@/app/api/rooms-live/now/route");
    const res = await GET(new Request("http://x/api/rooms-live/now"));
    expect(res.status).toBe(200);
    expect((await res.json()).rooms.map((r: Row) => r.mic_guard)).toEqual([null, null]);
    warn.mockRestore();
  });
  it.each([["staff"], ["open"]] as const)("%s: byte-identical to the pre-mic_guard response and no kiosk_health query is made", async (kind) => {
    H.kind.value = kind;
    const { GET } = await import("@/app/api/rooms-live/now/route");
    const res = await GET(new Request("http://x/api/rooms-live/now"));
    expect(await res.text()).toBe(JSON.stringify({ ...SNAP, coverage: null }));
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(H.calls.some((c) => /kiosk_health_events/.test(c.text))).toBe(false);
  });
});

describe("bench twin (readRoomsLive) always carries mic_guard", () => {
  beforeEach(() => {
    H.calls.length = 0;
    H.mgFail.value = false;
  });
  it("a room with a guard row gets it, a room without gets null", async () => {
    H.mgRows.value = [{ room_id: "room_a", ts: new Date(NOW - 10_000).toISOString(), received_at: new Date(NOW - 10_000).toISOString(), payload: pl("ok") }];
    const out = await readRoomsLive(new Date(NOW));
    expect(out.rooms).toHaveLength(1);
    expect(out.rooms[0]!.mic_guard?.state).toBe("ok");
    H.mgRows.value = [];
    const out2 = await readRoomsLive(new Date(NOW));
    expect(out2.rooms[0]!.mic_guard).toBeNull();
  });
  it("a failed mic_guard read does not degrade the monitor", async () => {
    H.mgFail.value = true;
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const out = await readRoomsLive(new Date(NOW));
    expect(out.rooms[0]!.mic_guard).toBeNull();
    expect(out.degraded).toEqual([]);
    warn.mockRestore();
  });
});

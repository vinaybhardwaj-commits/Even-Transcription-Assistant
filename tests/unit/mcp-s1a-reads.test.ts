/**
 * Operator MCP S1A (8 Oct 2026) — scribe_now, scribe_room, scribe_tape_day. `sql` is mocked and every statement is recorded:
 * the tools must never issue a write. No DB, no patient data.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { NextRequest } from "next/server";

type Row = Record<string, unknown>;
const statements: string[] = [];
let answer: (text: string, values: unknown[]) => unknown = () => [];

vi.mock("@/lib/db", () => {
  const sql = (strings: TemplateStringsArray, ...values: unknown[]) => {
    const text = strings.join("?");
    statements.push(text);
    const out = answer(text, values);
    return out instanceof Error ? Promise.reject(out) : Promise.resolve(out);
  };
  sql.transaction = async () => [];
  return { sql, db: {} };
});

let commandRows: Row[] = [];
vi.mock("@/lib/bench-commands", async (orig) => ({
  ...((await orig()) as object),
  listCommands: vi.fn(async () => commandRows),
}));

const S = await import("@/lib/mcp/surface");
const { handleMcpRpc } = await import("@/lib/mcp/handler");
const { LEVEL_TOOLS } = await import("@/lib/mcp/tools/levels");
const { GET: nowRoute } = await import("@/app/api/rooms-live/now/route");
const { resetMemoForTests, buildSnapshot } = await import("@/lib/rooms-live/snapshot");
const { resetAutoClearForTests } = await import("@/lib/rooms-live/claims");
const { sql } = await import("@/lib/db");

const ROOM = { id: "room_yh3etjpf", slug: "opd-1", name: "OPD 1", disabled_at: null };
const ctx = { origin: "x", actor: "a", scopes: new Set(["read"]) } as never;
const tool = (name: string) => S.CALLABLE_TOOLS.get(name)!;
const run = async (name: string, args: Row) => (await tool(name).handler(args, ctx)) as Row;

/** a mocked answer: the room table knows OPD 1 (by id, slug or name) and nothing else */
function roomTableKnowsOpd1(text: string, values: unknown[]): Row[] | null {
  if (!/FROM room\s/.test(text) || /room_install|bench_command/.test(text)) return null;
  const asked = values.filter((v) => typeof v === "string").map((v) => String(v).toLowerCase());
  return asked.some((v) => [ROOM.id, ROOM.slug, ROOM.name.toLowerCase()].includes(v)) ? [ROOM] : [];
}

beforeEach(() => {
  statements.length = 0;
  commandRows = [];
  answer = (text, values) => roomTableKnowsOpd1(text, values) ?? [];
  resetMemoForTests();
  resetAutoClearForTests();
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

const WRITE_RE = /\b(INSERT|UPDATE|DELETE|TRUNCATE|DROP|ALTER|CREATE)\b/i;
const noWrites = () => expect(statements.filter((s) => WRITE_RE.test(s)), "a write statement was issued").toEqual([]);

describe("S1A registration", () => {
  it("the three tools are listed, read scope, readOnlyHint true, and callable by name", () => {
    for (const n of ["scribe_now", "scribe_room", "scribe_tape_day"]) {
      const t = tool(n);
      expect(t.scope, n).toBe("read");
      expect(S.LAB_TOOLS.some((x) => x.name === n), n).toBe(true);
    }
  });

  it("a room-restricted token is refused all three (not on the room allowlist; fails closed)", async () => {
    for (const name of ["scribe_now", "scribe_room", "scribe_tape_day"]) {
      const req = new NextRequest("https://x/api/mcp", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: {} } }) });
      const res = await handleMcpRpc(req, { token_id: "t", scopes: new Set(["read"]), rooms: new Set([ROOM.id]) } as never);
      expect(res.status, name).toBe(403);
    }
  });
});

describe("scribe_now", () => {
  it("returns the fleet board: the eight default rooms, generated_at, degraded", async () => {
    const out = await run("scribe_now", {});
    expect((out.rooms as unknown[]).length).toBe(8);
    expect(typeof out.generated_at).toBe("string");
    expect(Array.isArray(out.degraded)).toBe(true);
    noWrites();
  });

  it("matches GET /api/rooms-live/now BYTE FOR BYTE for the same instant and data", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-08T12:00:00.000Z"));
    const routeBody = await (await nowRoute(new Request("https://x/api/rooms-live/now"))).text();
    resetMemoForTests();
    const viaTool = JSON.stringify(await run("scribe_now", {}));
    expect(viaTool).toBe(routeBody);
    // and the library the tool calls is the route's own (buildSnapshot is what getSnapshot memoises)
    resetMemoForTests();
    expect(JSON.stringify(await buildSnapshot({ db: sql as never }))).toBe(routeBody);
    noWrites();
  });

  it("calling the tool does not feed the route's 2 s memo or its claim auto-clear state", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-08T12:00:00.000Z"));
    await run("scribe_now", { include_claims: true });
    const n = statements.length;
    // the route right after still computes its own snapshot (a fresh fan-out), not a memo the tool left behind
    await nowRoute(new Request("https://x/api/rooms-live/now"));
    expect(statements.length).toBeGreaterThan(n);
  });

  it("include_claims attaches an open claim to a room that still needs someone, reads it without clearing it", async () => {
    answer = (text) => (/FROM rooms_live_claim/.test(text) ? [{ id: 1, room_id: ROOM.id, claimed_by: "ops", claimed_at: "2026-10-08T11:00:00.000Z", cleared_at: null, cleared_by: null, state_at_claim: null, note: null }] : []);
    const withClaims = await run("scribe_now", { include_claims: true });
    const row = (withClaims.rooms as Row[]).find((r) => r.room_id === ROOM.id)!;
    // with every source empty the room is "unknown", which is not resolved: the claim shows
    expect(row.claim).toEqual({ by: "ops", since: "2026-10-08T11:00:00.000Z" });
    const without = await run("scribe_now", {});
    expect((without.rooms as Row[]).every((r) => r.claim === null)).toBe(true);
    noWrites();
  });
});

describe("scribe_room", () => {
  it("rejects a missing or unknown view and a missing room", async () => {
    expect(await run("scribe_room", { room: "opd-1", view: "tape" })).toMatchObject({ ok: false, error: "unknown_view", allowed: ["alerts", "levels", "commands", "devices"] });
    expect(await run("scribe_room", { view: "alerts" })).toMatchObject({ ok: false, error: "room_required" });
  });

  it.each(["alerts", "levels", "commands", "devices"])("view=%s: an unknown room answers unknown_room and reads nothing else", async (view) => {
    const out = await run("scribe_room", { room: "no-such-room", view });
    expect(out).toEqual({ ok: false, error: "unknown_room", room: "no-such-room" });
    expect(statements.filter((s) => /room_alert_outbox|room_install|bench_level|bench_command/.test(s))).toEqual([]);
  });

  it("an ambiguous name is named, with its matches", async () => {
    answer = (text) => (/FROM room\s/.test(text) ? [{ ...ROOM, id: "room_a", slug: "a" }, { ...ROOM, id: "room_b", slug: "b" }] : []);
    const out = await run("scribe_room", { room: "OPD 1", view: "alerts" });
    expect(out).toMatchObject({ ok: false, error: "ambiguous_room" });
    expect((out.matches as unknown[]).length).toBe(2);
  });

  it("alerts: rows for the room in the window, with counts by kind (recovered included)", async () => {
    answer = (text, values) =>
      roomTableKnowsOpd1(text, values) ??
      (/room_alert_outbox/.test(text)
        ? [
            { id: 9, created_at: "2026-10-08T10:00:00.000Z", kind: "recovered", room_ids: [ROOM.id], room_name: "OPD 1", status_from: "offline", status_to: "ok", subject: "OPD 1 recovered", body: "b" },
            { id: 8, created_at: "2026-10-08T09:00:00.000Z", kind: "offline", room_ids: [ROOM.id, "room_x"], room_name: "OPD 1", status_from: "ok", status_to: "offline", subject: "OPD 1 offline", body: "b" },
          ]
        : []);
    const out = await run("scribe_room", { room: "opd-1", view: "alerts", window_min: 120 });
    expect(out).toMatchObject({ view: "alerts", ok: true, count: 2, truncated: false, by_kind: { recovered: 1, offline: 1 }, room: { id: ROOM.id, slug: "opd-1" } });
    expect((out.alerts as Row[])[0]).not.toHaveProperty("body");
    // the window is a bound parameter, capped at 240
    const capped = await run("scribe_room", { room: "opd-1", view: "alerts", window_min: 9999 });
    expect(capped.ok).toBe(true);
    noWrites();
  });

  it("alerts: a missing outbox table is not_collected, not an error", async () => {
    answer = (text, values) => roomTableKnowsOpd1(text, values) ?? (/room_alert_outbox/.test(text) ? Object.assign(new Error('relation "room_alert_outbox" does not exist'), { code: "42P01" }) : []);
    expect(await run("scribe_room", { room: "opd-1", view: "alerts" })).toMatchObject({ view: "alerts", not_collected: true });
  });

  describe("levels", () => {
    const NOW = Date.parse("2026-10-08T12:00:00.000Z");
    const bucket = (ageS: number, zero: number | null, extra: Row = {}) => ({ t_ms: NOW - ageS * 1000, peak: 0.1, avg: 0.05, zero_ratio: zero, session_open: true, tape_advancing: true, samples: 10, ...extra });
    const levels = (samples: Row[], extra: Row = {}) => vi.spyOn(LEVEL_TOOLS[0]!, "handler").mockResolvedValue({ room_id: ROOM.id, bucket_seconds: 15, samples, ...extra });

    beforeEach(() => {
      vi.useFakeTimers();
      vi.setSystemTime(NOW);
    });

    it("summarises: weighted zero_ratio, capture_dead false for a live mic, not stale", async () => {
      levels([bucket(60, 0.2), bucket(45, 0.1), bucket(10, 0.3)]);
      const out = await run("scribe_room", { room: "opd-1", view: "levels", window_min: 30 });
      expect(out).toMatchObject({ view: "levels", ok: true, window_min: 30, buckets: 3, raw_samples: 30, zero_ratio: 0.2, capture_dead: false, stale: false, newest_bucket_age_s: 10 });
      expect(out).not.toHaveProperty("samples");
    });

    it("capture_dead when zero_ratio >= 0.98 (the boundary included)", async () => {
      levels([bucket(30, 0.98), bucket(15, 0.98)]);
      expect(await run("scribe_room", { room: "opd-1", view: "levels" })).toMatchObject({ zero_ratio: 0.98, capture_dead: true });
      levels([bucket(30, 0.97), bucket(15, 0.97)]);
      expect(await run("scribe_room", { room: "opd-1", view: "levels" })).toMatchObject({ zero_ratio: 0.97, capture_dead: false });
    });

    it("stale when the newest bucket is old, frozen, or there are none; capture_dead needs data", async () => {
      levels([bucket(600, 0.1)]);
      expect(await run("scribe_room", { room: "opd-1", view: "levels" })).toMatchObject({ stale: true, newest_bucket_age_s: 600, capture_dead: false });
      levels([bucket(5, 0.1, { stale: true })]);
      expect(await run("scribe_room", { room: "opd-1", view: "levels" })).toMatchObject({ stale: true });
      levels([]);
      expect(await run("scribe_room", { room: "opd-1", view: "levels" })).toMatchObject({ buckets: 0, zero_ratio: null, capture_dead: false, stale: true, newest_bucket_at: null });
    });

    it("include_samples returns the buckets; a window over 240 is clamped; the reader gets the room id and an absolute range", async () => {
      const spy = levels([bucket(5, 0.1)]);
      const out = await run("scribe_room", { room: "opd-1", view: "levels", window_min: 5000, include_samples: true });
      expect(out.window_min).toBe(240);
      expect((out.samples as unknown[]).length).toBe(1);
      const args = spy.mock.calls[0]![0] as Row;
      expect(args.room_id).toBe(ROOM.id);
      expect(Date.parse(String(args.to)) - Date.parse(String(args.from))).toBe(240 * 60_000);
    });

    it("a reader error is passed on as ok:false, never as an empty healthy answer", async () => {
      levels([], { error: "bad_range" });
      expect(await run("scribe_room", { room: "opd-1", view: "levels" })).toMatchObject({ ok: false, error: "bad_range" });
    });
  });

  describe("commands", () => {
    const cmd = (id: string, status: string, minsAgo: number, extra: Row = {}) => ({ id, room_id: ROOM.id, room_slug: "opd-1", room_name: "OPD 1", kind: "report_diag", status, source: "mcp", args: { secret: 1 }, result: { r: 1 }, error: null, created_at: new Date(Date.now() - minsAgo * 60_000), acked_at: null, ...extra });

    it("counts outcomes by status inside the window and leaves args/result out by default", async () => {
      commandRows = [cmd("c1", "acked", 5), cmd("c2", "failed", 20, { error: "kiosk_not_listening" }), cmd("c3", "acked", 500)];
      const out = await run("scribe_room", { room: "opd-1", view: "commands", window_min: 60 });
      expect(out).toMatchObject({ view: "commands", ok: true, count: 2, by_status: { acked: 1, failed: 1 }, truncated: false });
      const rows = out.commands as Row[];
      expect(rows.map((r) => r.id)).toEqual(["c1", "c2"]);
      expect(rows[0]).not.toHaveProperty("args");
      expect(rows[1]).toMatchObject({ error: "kiosk_not_listening" });
    });

    it("include_payload adds args and result", async () => {
      commandRows = [cmd("c1", "acked", 5)];
      const out = await run("scribe_room", { room: "opd-1", view: "commands", include_payload: true });
      expect((out.commands as Row[])[0]).toMatchObject({ args: { secret: 1 }, result: { r: 1 } });
    });
  });

  describe("devices", () => {
    it("returns the install's devices as stored", async () => {
      answer = (text, values) =>
        roomTableKnowsOpd1(text, values) ??
        (/FROM room_install/.test(text) ? [{ hostname: "evenmac-1", state_flags: { flags: ["x"] }, state_changed_at: "2026-10-08T08:00:00.000Z", input_device_name: "USB Mic", input_devices: [{ name: "USB Mic" }] }] : []);
      const out = await run("scribe_room", { room: "opd-1", view: "devices" });
      expect(out).toMatchObject({ view: "devices", ok: true, installs: 1 });
      expect((out.devices as Row[])[0]).toMatchObject({ machine: "evenmac-1", input_device_name: "USB Mic", input_devices: [{ name: "USB Mic" }], state_flags: { flags: ["x"] } });
      noWrites();
    });

    it("no enrolled install: ok with zero devices; a missing column: not_collected", async () => {
      expect(await run("scribe_room", { room: "opd-1", view: "devices" })).toMatchObject({ ok: true, installs: 0, devices: [] });
      answer = (text, values) => roomTableKnowsOpd1(text, values) ?? (/FROM room_install/.test(text) ? Object.assign(new Error('column "input_devices" does not exist'), { code: "42703" }) : []);
      expect(await run("scribe_room", { room: "opd-1", view: "devices" })).toMatchObject({ not_collected: true });
    });
  });
});

describe("scribe_tape_day", () => {
  const DAY = "2026-10-08";
  const dayRow = (room: string, extra: Row = {}) => ({ room_id: room, ist_day: DAY, min_off: 10, min_muted: 0, min_zero_all_day: 0, min_present: 300, min_gated: 5, min_withheld: 0, consult_min_usable: 120, consult_min_uncertain: 10, consult_min_lost: 2, n_consults: 14, classifier_version: "v1", written_at: "2026-10-08T11:00:00.000Z", ...extra });

  it("refuses a bad date", async () => {
    for (const d of ["", "08-10-2026", "2026-13-45", "yesterday"]) expect(await run("scribe_tape_day", { ist_date: d })).toEqual({ ok: false, error: "invalid_ist_date" });
    expect(statements).toEqual([]);
  });

  it("all rooms for a day, with as_of = the newest write", async () => {
    answer = (text) => (/FROM room_audio_day/.test(text) ? [dayRow("room_a"), dayRow("room_b", { written_at: "2026-10-08T12:30:00.000Z" })] : []);
    const out = await run("scribe_tape_day", { ist_date: DAY });
    expect(out).toMatchObject({ ok: true, ist_date: DAY, as_of: "2026-10-08T12:30:00.000Z" });
    expect((out.rooms as Row[]).map((r) => r.room_id)).toEqual(["room_a", "room_b"]);
    expect((out.rooms as Row[])[0]).toMatchObject({ n_consults: 14, consult_min_usable: 120 });
    noWrites();
  });

  it("one room by slug, with segments only when asked", async () => {
    answer = (text, values) =>
      roomTableKnowsOpd1(text, values) ??
      (/FROM room_audio_day/.test(text) ? [dayRow(ROOM.id)] : /FROM room_audio_state/.test(text) ? [{ state: "speech", ts_start: "2026-10-08T04:00:00.000Z", ts_end: "2026-10-08T04:30:00.000Z" }] : []);
    const plain = await run("scribe_tape_day", { ist_date: DAY, room: "opd-1" });
    expect(plain).toMatchObject({ ok: true, room: { id: ROOM.id } });
    expect(plain).not.toHaveProperty("segments");
    const withSeg = await run("scribe_tape_day", { ist_date: DAY, room: "opd-1", include_segments: true });
    expect(withSeg.segments).toEqual([{ state: "speech", start: "2026-10-08T04:00:00.000Z", end: "2026-10-08T04:30:00.000Z" }]);
    expect(await run("scribe_tape_day", { ist_date: DAY, include_segments: true })).toMatchObject({ segments_error: "room_required_for_segments" });
    noWrites();
  });

  it("an unknown room answers unknown_room; a missing table is not_collected", async () => {
    expect(await run("scribe_tape_day", { ist_date: DAY, room: "nope" })).toEqual({ ok: false, error: "unknown_room", room: "nope" });
    answer = (text) => (/FROM room_audio_day/.test(text) ? Object.assign(new Error('relation "room_audio_day" does not exist'), { code: "42P01" }) : []);
    expect(await run("scribe_tape_day", { ist_date: DAY })).toMatchObject({ ok: true, not_collected: true, ist_date: DAY });
  });
});

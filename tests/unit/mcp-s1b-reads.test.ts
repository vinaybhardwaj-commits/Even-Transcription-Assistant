/**
 * Operator MCP S1B (8 Oct 2026) — scribe_steward, scribe_kiosks, scribe_stt_windows. `sql` is mocked and every statement is recorded:
 * the tools must never issue a write. No DB, no patient data.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { NextRequest } from "next/server";

type Row = Record<string, unknown>;
const statements: Array<{ text: string; values: unknown[] }> = [];
let answer: (text: string, values: unknown[]) => unknown = () => [];

vi.mock("@/lib/db", () => {
  const sql = (strings: TemplateStringsArray, ...values: unknown[]) => {
    const text = strings.join("?");
    statements.push({ text, values });
    const out = answer(text, values);
    return out instanceof Error ? Promise.reject(out) : Promise.resolve(out);
  };
  sql.transaction = async () => [];
  return { sql, db: {} };
});

const S = await import("@/lib/mcp/surface");
const { handleMcpRpc } = await import("@/lib/mcp/handler");

const ROOM = { id: "room_yh3etjpf", slug: "opd-1", name: "OPD 1", disabled_at: null };
const ctx = { origin: "x", actor: "a", scopes: new Set(["read"]) } as never;
const run = async (name: string, args: Row) => (await S.CALLABLE_TOOLS.get(name)!.handler(args, ctx)) as Row;

const roomTable = (text: string, values: unknown[]): Row[] | null => {
  if (!/FROM room\s/.test(text) || /room_install|steward_|bench_/.test(text)) return null;
  const asked = values.filter((v) => typeof v === "string").map((v) => String(v).toLowerCase());
  return asked.some((v) => [ROOM.id, ROOM.slug, ROOM.name.toLowerCase()].includes(v)) ? [ROOM] : [];
};
const pgErr = (code: string, msg: string) => Object.assign(new Error(msg), { code });

beforeEach(() => {
  statements.length = 0;
  answer = (text, values) => roomTable(text, values) ?? [];
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

const WRITE_RE = /\b(INSERT|UPDATE|DELETE|TRUNCATE|DROP|ALTER|CREATE)\b/i;
const noWrites = () => expect(statements.filter((s) => WRITE_RE.test(s.text)).map((s) => s.text), "a write statement was issued").toEqual([]);

const TOOLS = ["scribe_steward", "scribe_kiosks", "scribe_stt_windows"];

describe("S1B registration", () => {
  it("listed, read scope, not read-only-hinted wrongly, callable by name", () => {
    for (const n of TOOLS) {
      expect(S.CALLABLE_TOOLS.get(n)!.scope, n).toBe("read");
      expect(S.LAB_TOOLS.some((t) => t.name === n), n).toBe(true);
    }
  });

  it("a room-restricted token is refused all three", async () => {
    for (const name of TOOLS) {
      const req = new NextRequest("https://x/api/mcp", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: {} } }) });
      const res = await handleMcpRpc(req, { token_id: "t", scopes: new Set(["read"]), rooms: new Set([ROOM.id]) } as never);
      expect(res.status, name).toBe(403);
    }
  });
});

describe("scribe_steward", () => {
  const CFG = [
    { key: "kill_switch", value: { on: false }, updated_at: "2026-10-08T05:00:00.000Z", updated_by: "admin" },
    { key: "shadow", value: { global: true, actions: {} }, updated_at: "2026-10-08T05:00:00.000Z", updated_by: "migration-0128" },
    { key: "rooms", value: { [ROOM.id]: { flags: ["dev"], machine: "m1" } }, updated_at: "2026-10-08T05:00:00.000Z", updated_by: "admin" },
    { key: "schedule", value: { clinic: { start: "07:30" } }, updated_at: "2026-10-08T05:00:00.000Z", updated_by: null },
  ];
  const decision = (id: number, ts: string, extra: Row = {}) => ({ id, ts, room_id: ROOM.id, room_name: "OPD 1", machine: "m1", window_kind: "clinic", rule: "r_start", action: "start_day", params: { a: 1 }, mode: "shadow", result: "skipped", actor: "steward", why: "inside window", why_not: null, inputs_hash: "h", inputs: { n: 1 }, ...extra });

  it("rejects an unknown view; why needs a room", async () => {
    expect(await run("scribe_steward", { view: "nope" })).toMatchObject({ ok: false, error: "unknown_view" });
    expect(await run("scribe_steward", { view: "why", at: "2026-10-08T09:00:00Z" })).toMatchObject({ ok: false, error: "room_required" });
  });

  it("config: every setting key, never the lease or the last tick", async () => {
    answer = (text) => (/FROM steward_config/.test(text) ? CFG : []);
    const out = await run("scribe_steward", { view: "config" });
    expect((out.config as Row[]).map((c) => c.key)).toEqual(["kill_switch", "shadow", "rooms", "schedule"]);
    const stmt = statements.find((s) => /FROM steward_config/.test(s.text))!;
    expect(stmt.values.flat()).toEqual(expect.arrayContaining(["loop_lease", "last_tick"]));
    noWrites();
  });

  it("decisions: newest first, room name present, params/inputs only with include_payload, since/limit bound", async () => {
    answer = (text) => (/FROM steward_decisions d/.test(text) ? [decision(2, "2026-10-08T09:10:00.000Z"), decision(1, "2026-10-08T09:00:00.000Z")] : []);
    const out = await run("scribe_steward", { view: "decisions" });
    expect(out).toMatchObject({ ok: true, count: 2, since_hours: 24, truncated: false, by_action: { start_day: 2 } });
    const d = (out.decisions as Row[])[0]!;
    expect(d).toMatchObject({ id: 2, room_name: "OPD 1", rule: "r_start", mode: "shadow" });
    expect(d).not.toHaveProperty("params");
    expect(d).not.toHaveProperty("inputs");
    expect(((await run("scribe_steward", { view: "decisions", include_payload: true })).decisions as Row[])[0]).toMatchObject({ params: { a: 1 }, inputs: { n: 1 } });
    const stmt = statements.find((s) => /FROM steward_decisions d/.test(s.text))!;
    expect(stmt.values).toEqual([24, null, null, 51]); // hours, room (twice: null test + equality), limit + 1
    noWrites();
  });

  it("since_hours and limit are clamped and say so", async () => {
    answer = (text) => (/FROM steward_decisions d/.test(text) ? [] : []);
    const out = await run("scribe_steward", { view: "decisions", since_hours: 9999, limit: 5000 });
    expect(out).toMatchObject({ clamped: true, since_hours_applied: 168, limit_applied: 200, since_hours: 168 });
    const stmt = statements.find((s) => /FROM steward_decisions d/.test(s.text))!;
    expect(stmt.values[0]).toBe(168);
    expect(stmt.values[stmt.values.length - 1]).toBe(201);
    expect(await run("scribe_steward", { view: "decisions" })).not.toHaveProperty("clamped");
  });

  it("decisions for a room bind the resolved id; an unknown room reads no steward table", async () => {
    answer = (text, values) => roomTable(text, values) ?? [];
    await run("scribe_steward", { view: "decisions", room: "opd-1" });
    expect(statements.find((s) => /FROM steward_decisions d/.test(s.text))!.values).toContain(ROOM.id);
    statements.length = 0;
    expect(await run("scribe_steward", { view: "decisions", room: "nope" })).toEqual({ ok: false, error: "unknown_room", room: "nope" });
    expect(statements.filter((s) => /steward_/.test(s.text))).toEqual([]);
  });

  it("tickets: no signature, no nonce; params/result only with include_payload", async () => {
    answer = (text) =>
      /FROM steward_tickets t/.test(text)
        ? [{ ticket_id: "t1", machine: "m1", action: "restart_engine", status: "done", issued_at: "2026-10-08T08:00:00.000Z", expires_at: "2026-10-08T08:05:00.000Z", fetched_at: null, completed_at: "2026-10-08T08:01:00.000Z", decision_id: "7", params: { p: 1 }, result: { ok: true }, signature: "SIG", nonce: "NONCE" }]
        : [];
    const out = await run("scribe_steward", { view: "tickets" });
    expect(out).toMatchObject({ count: 1, by_status: { done: 1 } });
    const t = (out.tickets as Row[])[0]!;
    expect(t).toMatchObject({ ticket_id: "t1", decision_id: 7 });
    expect(JSON.stringify(out)).not.toMatch(/SIG|NONCE/);
    expect(statements[0]!.text).not.toMatch(/signature|nonce/);
    expect(t).not.toHaveProperty("params");
    expect(((await run("scribe_steward", { view: "tickets", include_payload: true })).tickets as Row[])[0]).toMatchObject({ params: { p: 1 }, result: { ok: true } });
    noWrites();
  });

  it("F1: a nonce or signature inside a stored result / params / inputs never leaves, include_payload or not", async () => {
    answer = (text) =>
      /FROM steward_tickets t/.test(text)
        ? [{ ticket_id: "t1", machine: "m1", action: "restart_engine", status: "done", issued_at: "2026-10-08T08:00:00.000Z", expires_at: "2026-10-08T08:05:00.000Z", fetched_at: null, completed_at: null, decision_id: null,
             params: { p: 1, Nonce: "PNONCE", nested: { signature: "PSIG", keep: 1 } },
             result: { ticket_id: "t1", nonce: "RNONCE", outcome: "ok", detail: [{ NONCE: "DNONCE", d: 2 }] } }]
        : /FROM steward_decisions d/.test(text) ? [decision(1, "2026-10-08T09:00:00.000Z", { params: { signature: "XSIG", a: 1 }, inputs: { nonce: "XNONCE", n: 1 } })] : [];
    for (const include_payload of [false, true]) {
      const t = await run("scribe_steward", { view: "tickets", include_payload });
      const d = await run("scribe_steward", { view: "decisions", include_payload });
      expect(JSON.stringify([t, d]), `include_payload=${include_payload}`).not.toMatch(/NONCE|PSIG|XSIG/i);
    }
    const t = ((await run("scribe_steward", { view: "tickets", include_payload: true })).tickets as Row[])[0]!;
    expect(t).toMatchObject({ params: { p: 1, nested: { keep: 1 } }, result: { ticket_id: "t1", outcome: "ok", detail: [{ d: 2 }] } });
  });

  it("H1: nonce / signature keys inside steward_config values are scrubbed in config, tick and why", async () => {
    const dirty = { key: "rooms", value: { [ROOM.id]: { flags: ["dev"], machine: "m1", nonce: "CFGNONCE", deep: { Signature: "CFGSIG", keep: 1 } } }, updated_at: "2026-10-08T05:00:00.000Z", updated_by: "admin" };
    answer = (text, values) =>
      roomTable(text, values) ??
      (/FROM steward_config/.test(text) && /ANY/.test(text)
        ? [
            { key: "last_tick", value: { at: "2026-10-08T09:00:00.000Z", rooms: 3, nonce: "TICKNONCE" }, updated_at: "2026-10-08T09:00:01.000Z", age_s: 5 },
            { key: "kill_switch", value: { on: true, signature: "KSIG" }, updated_at: "2026-10-08T05:00:00.000Z", age_s: 9 },
          ]
        : /FROM steward_config/.test(text) ? [dirty, { key: "kill_switch", value: { on: false, nonce: "KNONCE" }, updated_at: "2026-10-08T05:00:00.000Z", updated_by: null }]
        : /FROM steward_decisions d/.test(text) ? []
        : /FROM steward_decisions/.test(text) ? [{ n: 0, newest: null }] : []);
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-08T12:00:00.000Z"));
    const config = await run("scribe_steward", { view: "config" });
    const tick = await run("scribe_steward", { view: "tick" });
    const why = await run("scribe_steward", { view: "why", room: "opd-1", at: "2026-10-08T09:30:00Z" });
    expect(JSON.stringify([config, tick, why])).not.toMatch(/NONCE|SIG/i);
    expect((config.config as Row[])[0]).toMatchObject({ key: "rooms", value: { [ROOM.id]: { flags: ["dev"], deep: { keep: 1 } } } });
    expect(tick).toMatchObject({ kill_switch: true, last_tick: { rooms: 3 } });
    expect((why.config_in_force as Row).room).toMatchObject({ flags: ["dev"], machine: "m1" });
  });

  it("tick: last tick with its age, kill switch, lease held or not (holder never shown), recent decisions", async () => {
    const until = new Date(Date.now() + 30_000).toISOString();
    answer = (text) =>
      /FROM steward_config/.test(text)
        ? [
            { key: "last_tick", value: { at: "2026-10-08T09:00:00.000Z", rooms: 3, decisions_written: 3 }, updated_at: "2026-10-08T09:00:01.000Z", age_s: 42 },
            { key: "loop_lease", value: { holder: "run-secret", until }, updated_at: "2026-10-08T09:00:00.000Z", age_s: 1 },
            { key: "kill_switch", value: { on: true }, updated_at: "2026-10-08T05:00:00.000Z", age_s: 99 },
          ]
        : /FROM steward_decisions/.test(text) ? [{ n: 3, newest: "2026-10-08T09:00:00.000Z" }] : [];
    const out = await run("scribe_steward", { view: "tick" });
    expect(out).toMatchObject({ ok: true, kill_switch: true, decisions_last_hour: 3, last_tick: { rooms: 3, age_s: 42 }, lease: { held: true } });
    expect(JSON.stringify(out)).not.toContain("run-secret");
    noWrites();
  });

  describe("why", () => {
    const AT = "2026-10-08T09:30:00.000Z";
    const rows = [decision(10, "2026-10-08T09:15:00.000Z"), decision(11, "2026-10-08T09:30:00.000Z"), decision(12, "2026-10-08T09:45:00.000Z")];

    beforeEach(() => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date("2026-10-08T12:00:00.000Z"));
      answer = (text, values) => roomTable(text, values) ?? (/FROM steward_decisions d/.test(text) ? rows : /FROM steward_config/.test(text) ? CFG : []);
    });

    it("binds exactly ±15 minutes around `at` and the resolved room id", async () => {
      await run("scribe_steward", { view: "why", room: "opd-1", at: AT });
      const stmt = statements.find((s) => /FROM steward_decisions d/.test(s.text))!;
      expect(stmt.values).toEqual([ROOM.id, "2026-10-08T09:15:00.000Z", "2026-10-08T09:45:00.000Z", 51]);
      expect(stmt.text).toMatch(/d\.ts >= \?::timestamptz AND d\.ts <= \?::timestamptz/); // both edges inclusive
    });

    it("returns the rows (params/inputs only with include_payload, as decisions) and the config now with history:false and this room's flags", async () => {
      const out = await run("scribe_steward", { view: "why", room: "opd-1", at: AT });
      expect(out).toMatchObject({ ok: true, count: 3, truncated: false, window: { minutes_each_side: 15 } });
      expect((out.decisions as Row[])[0]).toMatchObject({ rule: "r_start", why: "inside window" });
      expect((out.decisions as Row[])[0]).not.toHaveProperty("params");
      expect((out.decisions as Row[])[0]).not.toHaveProperty("inputs");
      expect((out.decisions as Row[])[0]).not.toHaveProperty("inputs_hash");
      const full = await run("scribe_steward", { view: "why", room: "opd-1", at: AT, include_payload: true });
      expect((full.decisions as Row[])[0]).toMatchObject({ params: { a: 1 }, inputs: { n: 1 }, inputs_hash: "h" });
      expect(out.config_in_force).toMatchObject({ history: false, kill_switch: { on: false }, room: { flags: ["dev"] } });
      expect(out).not.toHaveProperty("beyond_retention");
      noWrites();
    });

    it("an offset time is read as that instant; a naive or junk time is refused before any decision read", async () => {
      const out = await run("scribe_steward", { view: "why", room: "opd-1", at: "2026-10-08T15:00:00+05:30" });
      expect(out).toMatchObject({ ok: true, at: "2026-10-08T09:30:00.000Z" });
      statements.length = 0;
      for (const at of ["2026-10-08T09:30:00", "yesterday", "2026-13-40T00:00:00Z", ""]) {
        expect(await run("scribe_steward", { view: "why", room: "opd-1", at }), at).toMatchObject({ ok: false });
      }
      expect(statements.filter((s) => /steward_decisions/.test(s.text))).toEqual([]);
    });

    it("older than the 30-day log says beyond_retention; the far future is allowed and just empty", async () => {
      answer = (text, values) => roomTable(text, values) ?? (/FROM steward_config/.test(text) ? CFG : []);
      expect(await run("scribe_steward", { view: "why", room: "opd-1", at: "2026-08-01T00:00:00Z" })).toMatchObject({ ok: true, count: 0, beyond_retention: true, retention_days: 30 });
      expect(await run("scribe_steward", { view: "why", room: "opd-1", at: "2027-01-01T00:00:00Z" })).toMatchObject({ ok: true, count: 0 });
    });

    it("an unknown room, or a missing `at`, is refused", async () => {
      expect(await run("scribe_steward", { view: "why", room: "nope", at: AT })).toMatchObject({ ok: false, error: "unknown_room" });
      expect(await run("scribe_steward", { view: "why", room: "opd-1" })).toMatchObject({ ok: false, error: "at_required" });
    });
  });

  it("a missing steward table is not_collected; any other failure is ok:false", async () => {
    answer = (text) => (/FROM steward_config/.test(text) ? pgErr("42P01", 'relation "steward_config" does not exist') : []);
    expect(await run("scribe_steward", { view: "config" })).toMatchObject({ view: "config", not_collected: true });
    answer = (text) => (/FROM steward_config/.test(text) ? new Error("connection reset") : []);
    const bad = await run("scribe_steward", { view: "config" });
    expect(bad).toMatchObject({ ok: false });
    expect(bad).not.toHaveProperty("not_collected");
  });
});

describe("scribe_kiosks", () => {
  const INSTALL = {
    room_id: ROOM.id, room_name: "OPD 1", hostname: "EvenMac-1", app_version: "2.4.1", build_sha: "abc1234", os_version: "15.1", hardware_model: "Macmini9,1",
    update_channel: "stable", assigned_channel: "stable", last_update_result: "ok", last_update_version: "2.4.1", last_update_error: null, last_update_at: "2026-10-07T20:00:00.000Z",
    first_seen_at: "2026-09-01T00:00:00.000Z", last_seen_at: "2026-10-08T11:59:30.000Z", never_sleep: true, disk_free_bytes: 123, mic_state: "authorized", launch_agent_loaded: true,
    session_open: true, tape_advancing: true, state_flags: { flags: ["x"] }, state_changed_at: "2026-10-08T08:00:00.000Z", input_device_name: "USB Mic", input_devices: [{ name: "USB Mic" }], expected_device_name: "USB Mic",
  };
  const withInstall = (more: (text: string, values: unknown[]) => unknown = () => []) => (text: string, values: unknown[]) =>
    roomTable(text, values) ?? (/FROM room_install i/.test(text) ? [INSTALL] : more(text, values));

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-08T12:00:00.000Z"));
    answer = withInstall();
  });

  it("rejects an unknown view; an unknown room reads no kiosk table", async () => {
    expect(await run("scribe_kiosks", { view: "x" })).toMatchObject({ ok: false, error: "unknown_view", allowed: ["health", "versions", "devices", "power", "last_seen"] });
    statements.length = 0;
    expect(await run("scribe_kiosks", { view: "health", room: "nope" })).toEqual({ ok: false, error: "unknown_room", room: "nope" });
    expect(statements.filter((s) => /room_install|kiosk_health/.test(s.text))).toEqual([]);
  });

  it("devices: as stored", async () => {
    const out = await run("scribe_kiosks", { view: "devices" });
    expect((out.kiosks as Row[])[0]).toMatchObject({ room_id: ROOM.id, machine: "EvenMac-1", input_device_name: "USB Mic", input_devices: [{ name: "USB Mic" }], mic_state: "authorized", state_flags: { flags: ["x"] } });
    noWrites();
  });

  it("devices for a room binds the resolved room id", async () => {
    await run("scribe_kiosks", { view: "devices", room: "OPD 1" });
    expect(statements.find((s) => /FROM room_install i/.test(s.text))!.values).toContain(ROOM.id);
  });

  it("versions: app / OS / channel / last update, and the extension's version from its newest event", async () => {
    answer = withInstall((text) => (/FROM pulse_presence_events/.test(text) ? [{ machine: "evenmac-1", ver: "1.9.3", ts: "2026-10-08T11:58:00.000Z" }] : []));
    const k = ((await run("scribe_kiosks", { view: "versions" })).kiosks as Row[])[0]!;
    expect(k).toMatchObject({ app_version: "2.4.1", build_sha: "abc1234", os_version: "15.1", update_channel: "stable", last_update: { result: "ok", version: "2.4.1" }, extension: { version: "1.9.3" } });
    noWrites();
  });

  it("versions: a missing Pulse table makes the extension field not_collected, not the view", async () => {
    answer = withInstall((text) => (/FROM pulse_presence_events/.test(text) ? pgErr("42P01", 'relation "pulse_presence_events" does not exist') : []));
    const k = ((await run("scribe_kiosks", { view: "versions" })).kiosks as Row[])[0]!;
    expect(k.app_version).toBe("2.4.1");
    expect(k.extension).toMatchObject({ not_collected: true });
  });

  it("health: the newest event per kind with ages, matched to the room through the machine spellings; payloads never selected", async () => {
    answer = withInstall((text) =>
      /FROM kiosk_health_events k/.test(text)
        ? [
            { machine: "evenmac-1.local", kind: "heartbeat", ts: "2026-10-08T11:59:00.000Z", received_at: "2026-10-08T11:59:10.000Z" },
            { machine: "EvenMac-1", kind: "audio.error", ts: "2026-10-08T10:00:00.000Z", received_at: "2026-10-08T10:00:05.000Z" },
            { machine: "EvenMac-1", kind: "heartbeat", ts: "2026-10-08T11:00:00.000Z", received_at: "2026-10-08T11:00:05.000Z" },
            { machine: "someone-else", kind: "heartbeat", ts: "2026-10-08T11:59:00.000Z", received_at: "2026-10-08T11:59:10.000Z" },
          ]
        : [],
    );
    const k = ((await run("scribe_kiosks", { view: "health" })).kiosks as Row[])[0]!;
    expect(k).toMatchObject({ heartbeat_age_s: 50, kinds: 2 });
    expect((k.newest_by_kind as Row[]).map((e) => e.kind)).toEqual(["audio.error", "heartbeat"]);
    expect(statements.find((s) => /FROM kiosk_health_events k/.test(s.text))!.text).not.toMatch(/payload/);
    noWrites();
  });

  it("power: events newest first with reasons; none stored is not_collected", async () => {
    answer = withInstall((text) =>
      /power\.%/.test(text)
        ? [
            { machine: "EvenMac-1", kind: "power.sleep", ts: "2026-10-08T01:00:00.000Z", received_at: "2026-10-08T01:00:30.000Z", reason: "Idle Sleep", kaesleep: "true" },
            { machine: "EvenMac-1", kind: "power.wake", ts: "2026-10-08T03:00:00.000Z", received_at: "2026-10-08T03:00:30.000Z", reason: "EC.LidOpen", kaesleep: null },
          ]
        : [],
    );
    const out = await run("scribe_kiosks", { view: "power" });
    expect(((out.kiosks as Row[])[0]!.events as Row[]).map((e) => e.kind)).toEqual(["power.wake", "power.sleep"]);
    answer = withInstall();
    expect(await run("scribe_kiosks", { view: "power" })).toMatchObject({ view: "power", not_collected: true, reason: expect.stringContaining("power.*") });
    // G3: an install with no hostname has no machine to ask about; the reason says so and no event table is read
    answer = (text, values) => roomTable(text, values) ?? (/FROM room_install i/.test(text) ? [{ ...INSTALL, hostname: null }] : []);
    statements.length = 0;
    expect(await run("scribe_kiosks", { view: "power", room: "opd-1" })).toMatchObject({ not_collected: true, reason: "no machine bound to this room" });
    expect(statements.filter((s) => /kiosk_health_events/.test(s.text))).toEqual([]);
    noWrites();
  });

  it("last_seen: the newest of each signal with ages_s; an absent signal is null, not zero", async () => {
    answer = withInstall((text) =>
      /FROM bench_listener/.test(text) ? [{ room_id: ROOM.id, last_poll_at: "2026-10-08T11:59:50.000Z" }]
      : /FROM kiosk_health_events k/.test(text) && /kind = 'heartbeat'/.test(text) ? [{ machine: "EvenMac-1", received_at: "2026-10-08T11:58:00.000Z" }]
      : /FROM kiosk_health_events k/.test(text) ? [{ machine: "EvenMac-1", received_at: "2026-10-08T11:59:00.000Z" }]
      : [],
    );
    const k = ((await run("scribe_kiosks", { view: "last_seen" })).kiosks as Row[])[0]!;
    expect(k).toMatchObject({
      install_last_seen: { age_s: 30 },
      listener_last_poll: { age_s: 10 },
      kiosk_health_last_event: { age_s: 60 },
      kiosk_health_last_heartbeat: { age_s: 120 },
      extension_last_event: { at: null, age_s: null },
    });
    noWrites();
  });

  it("last_seen: a missing Pulse table marks only the extension signal not_collected", async () => {
    answer = withInstall((text) => (/FROM pulse_presence_events/.test(text) ? pgErr("42703", 'column "ts" does not exist') : []));
    const k = ((await run("scribe_kiosks", { view: "last_seen" })).kiosks as Row[])[0]!;
    expect(k.extension_last_event).toEqual({ not_collected: true });
    expect(k.install_last_seen).toMatchObject({ age_s: 30 });
  });

  it("a missing room_install column is not_collected for the view", async () => {
    answer = (text, values) => roomTable(text, values) ?? (/FROM room_install i/.test(text) ? pgErr("42703", 'column "expected_device_name" does not exist') : []);
    expect(await run("scribe_kiosks", { view: "devices" })).toMatchObject({ not_collected: true });
  });
});

describe("scribe_stt_windows", () => {
  const WIN = { id: "bw_1", session_id: "bs_1", room_day_id: "rd_1", start_ms: 0, end_ms: 900_000, source_mic: "primary", grid_aligned: true, state: "transcribed", closed_at: "2026-10-08T06:00:00.000Z", created_at: "2026-10-08T05:40:00.000Z", auto_drain_refused_at: null, auto_drain_refused_reason: null, room_id: ROOM.id, room_name: "OPD 1", session_started_at: "2026-10-08T04:00:00.000Z" };

  it("needs window_id, or ist_date with room; not both", async () => {
    expect(await run("scribe_stt_windows", {})).toMatchObject({ ok: false, error: "window_id_or_day_and_room" });
    expect(await run("scribe_stt_windows", { window_id: "bw_1", ist_date: "2026-10-08" })).toMatchObject({ ok: false, error: "window_id_or_day_and_room" });
    expect(await run("scribe_stt_windows", { ist_date: "2026-10-08" })).toMatchObject({ ok: false, error: "room_required" });
    expect(statements).toEqual([]);
  });

  it("an unknown window is named", async () => {
    expect(await run("scribe_stt_windows", { window_id: "bw_nope" })).toEqual({ ok: false, error: "unknown_window", window_id: "bw_nope" });
  });

  it("one window: state, drain, jobs, runs without text, encounter link, lab null with the S5 note", async () => {
    answer = (text) =>
      /FROM bench_window w/.test(text) ? [WIN]
      : /FROM stt_subject_job/.test(text) ? [{ tier: "asr", state: "done", attempts: 1, last_error: null, queued_at: "2026-10-08T06:00:00.000Z", started_at: "2026-10-08T06:01:00.000Z", finished_at: "2026-10-08T06:03:00.000Z" }]
      : /FROM scribe_job/.test(text) ? [{ id: "job_1", kind: "room_window", status: "done", step: "finish", attempts: 5, failures: 0, created_at: "2026-10-08T06:00:00.000Z", started_at: null, finished_at: null, has_error: false }]
      : /FROM transcription_run/.test(text) ? [{ id: "trun_1", encounter_id: null, engine: "whisper", stt_engine_id: "whisper", mode: "batch", tier: "asr", detected_language: "en", latency_ms: 9000, cost_usd: "0", error: null, original_chars: 4200, created_at: "2026-10-08T06:02:00.000Z" }]
      : /FROM encounter_hypothesis_run/.test(text) ? [{ id: "ehr_1", created_at: "2026-10-08T07:00:00.000Z", n_hypotheses: 6 }]
      : [];
    const out = await run("scribe_stt_windows", { window_id: "bw_1" });
    expect(out).toMatchObject({ ok: true, window: { id: "bw_1", state: "transcribed", duration_s: 900, room: { id: ROOM.id } }, lab: { reb: null, lab_fields: null } });
    expect((out.lab as Row).note).toContain("S5");
    expect(out.drain).toEqual([expect.objectContaining({ tier: "asr", state: "done" })]);
    expect(out.jobs).toEqual([expect.objectContaining({ id: "job_1", kind: "room_window", has_error: false })]);
    expect((out.runs as Row[])[0]).toMatchObject({ engine: "whisper", original_chars: 4200 });
    expect(out.encounter_link).toMatchObject({ run_encounter_ids: [], room_day_id: "rd_1", hypotheses: { latest_run_id: "ehr_1", n_hypotheses: 6 } });
    // no text column, no storage key is selected anywhere
    for (const s of statements) {
      expect(s.text, s.text).not.toMatch(/transcript_english|note_text|note_json|clip_r2_key|audio_r2_key/);
      expect(s.text.replace(/length\(transcript_original\)/g, "")).not.toMatch(/transcript_original/);
    }
    noWrites();
  });

  it("an injection-shaped window id only ever travels as a bound value", async () => {
    answer = (text) => (/FROM bench_window w/.test(text) ? [WIN] : []);
    const evil = "bw_1'; DROP TABLE x;--";
    await run("scribe_stt_windows", { window_id: evil });
    const job = statements.find((s) => /FROM scribe_job/.test(s.text))!;
    expect(job.values).toContain(evil);
    for (const st of statements) expect(st.text).not.toContain("DROP TABLE");
    noWrites();
  });

  it("a day for a room: counts by state and drain state, windows capped, bound date and room id", async () => {
    answer = (text, values) =>
      roomTable(text, values) ??
      (/FROM bench_window w/.test(text)
        ? [{ id: "bw_1", room_day_id: "rd_1", start_ms: 0, end_ms: 900_000, source_mic: "primary", state: "transcribed", closed_at: null }, { id: "bw_2", room_day_id: "rd_1", start_ms: 900_000, end_ms: 1_800_000, source_mic: "primary", state: "silent", closed_at: null }]
        : /FROM stt_subject_job/.test(text) ? [{ subject_id: "bw_1", tier: "asr", state: "done", attempts: 1 }]
        : []);
    const out = await run("scribe_stt_windows", { ist_date: "2026-10-08", room: "opd-1", limit: 50 });
    expect(out).toMatchObject({ ok: true, count: 2, truncated: false, by_state: { transcribed: 1, silent: 1 }, drain_by_state: { done: 1, no_job: 1 }, room: { id: ROOM.id } });
    const stmt = statements.find((s) => /FROM bench_window w/.test(s.text))!;
    // G2: filtered by the WINDOW's own start (epoch ms) inside the IST day [00:00+05:30, +24 h), not by the session's start date
    expect(stmt.values).toEqual([ROOM.id, Date.parse("2026-10-08T00:00:00+05:30"), Date.parse("2026-10-09T00:00:00+05:30"), 51]);
    expect(stmt.text).not.toMatch(/started_at/);
    noWrites();
  });

  it("G2: a session that crosses IST midnight puts each window on the IST day it starts in", async () => {
    // session started 23:30 IST on the 8th; its windows at 23:30 (8th) and 00:15 (9th)
    const w1 = Date.parse("2026-10-08T23:30:00+05:30");
    const w2 = Date.parse("2026-10-09T00:15:00+05:30");
    const all = [{ id: "bw_a", room_day_id: null, start_ms: w1, end_ms: w1 + 900_000, source_mic: "primary", state: "transcribed", closed_at: null }, { id: "bw_b", room_day_id: null, start_ms: w2, end_ms: w2 + 900_000, source_mic: "primary", state: "transcribed", closed_at: null }];
    // the mock plays the database: it applies the bound [lo, hi) filter
    answer = (text, values) => roomTable(text, values) ?? (/FROM bench_window w/.test(text) ? all.filter((w) => w.start_ms >= (values[1] as number) && w.start_ms < (values[2] as number)) : []);
    const eighth = await run("scribe_stt_windows", { ist_date: "2026-10-08", room: "opd-1" });
    const ninth = await run("scribe_stt_windows", { ist_date: "2026-10-09", room: "opd-1" });
    expect((eighth.windows as Row[]).map((w) => w.id)).toEqual(["bw_a"]);
    expect((ninth.windows as Row[]).map((w) => w.id)).toEqual(["bw_b"]);
  });

  it("day: a bad or impossible date is refused before any SQL; an unknown room reads no window table", async () => {
    for (const d of ["2026-02-30", "x", "08-10-2026"]) expect(await run("scribe_stt_windows", { ist_date: d, room: "opd-1" })).toEqual({ ok: false, error: "invalid_ist_date" });
    expect(statements).toEqual([]);
    expect(await run("scribe_stt_windows", { ist_date: "2026-10-08", room: "nope" })).toMatchObject({ ok: false, error: "unknown_room" });
    expect(statements.filter((s) => /bench_window/.test(s.text))).toEqual([]);
  });

  it("missing tables are not_collected (a missing hypothesis table only blanks the link)", async () => {
    answer = (text) => (/FROM bench_window w/.test(text) ? pgErr("42P01", 'relation "bench_window" does not exist') : []);
    expect(await run("scribe_stt_windows", { window_id: "bw_1" })).toMatchObject({ not_collected: true });
    answer = (text) => (/FROM bench_window w/.test(text) ? [WIN] : /FROM encounter_hypothesis_run/.test(text) ? pgErr("42P01", 'relation "encounter_hypothesis_run" does not exist') : []);
    const out = await run("scribe_stt_windows", { window_id: "bw_1" });
    expect(out.ok).toBe(true);
    expect((out.encounter_link as Row).hypotheses).toMatchObject({ not_collected: true });
  });
});

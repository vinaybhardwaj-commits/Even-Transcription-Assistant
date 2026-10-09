/**
 * S4 — the Steward repair-ticket console (READ ONLY): scribe_steward views ticket_log, ticket_summary, live. sql mocked, every statement recorded.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

type Row = Record<string, unknown>;
const statements: Array<{ text: string; values: unknown[] }> = [];
let answer: (text: string, values: unknown[]) => unknown = () => [];
vi.mock("@/lib/db", () => {
  const sql = (strings: TemplateStringsArray, ...values: unknown[]) => {
    const text = strings.join("?");
    statements.push({ text, values });
    return Promise.resolve(answer(text, values));
  };
  sql.transaction = async () => [];
  return { sql, db: {} };
});
const S = await import("@/lib/mcp/surface");
const T = await import("@/lib/mcp/tools/s1b");
const C = await import("@/lib/steward/config");

const ROOM = { id: "room_yh3etjpf", slug: "opd-1", name: "OPD 1", disabled_at: null };
const ctx = { origin: "x", actor: "a", scopes: new Set(["read"]) } as never;
const run = async (args: Row) => (await S.CALLABLE_TOOLS.get("scribe_steward")!.handler({ ...args }, ctx)) as Row;
const roomTable = (text: string, values: unknown[]): Row[] | null => {
  if (!/FROM room\s/.test(text) || /room_install|steward_|bench_/.test(text)) return null;
  const asked = values.filter((v) => typeof v === "string").map((v) => String(v).toLowerCase());
  return asked.some((v) => [ROOM.id, ROOM.slug, ROOM.name.toLowerCase()].includes(v)) ? [ROOM] : [];
};
beforeEach(() => { statements.length = 0; answer = (t, v) => roomTable(t, v) ?? []; });

const ticketSql = () => statements.filter((s) => /FROM steward_tickets t/.test(s.text));
/** a stored ticket row as the database would hold it: it carries a signature and a nonce, which the SELECT must never ask for */
const TROW = (id: string, o: Row = {}): Row => ({ ticket_id: id, machine: "m1", action: "wake", status: "done", issued_at: "2026-10-05T04:00:00Z", expires_at: "2026-10-05T04:10:00Z", fetched_at: "2026-10-05T04:01:00Z", completed_at: "2026-10-05T04:02:00Z",
  issuer_rule: "kiosk_asleep", decision_mode: "live", room_id: ROOM.id, room_name: "OPD 1", signature: "SIGSIGSIG", nonce: "NONCENONCE", ...o });

describe("ticket_log", () => {
  it("lists tickets in the IST range with room, action, status, issuing rule and mode; the SELECT names no secret column and the answer has no field named *sig*, *key*, *nonce*, *token* or *secret*", async () => {
    answer = (t, v) => (/FROM steward_tickets t/.test(t) ? [TROW("tk1"), TROW("tk2", { status: "failed", decision_mode: null, issuer_rule: null })] : roomTable(t, v) ?? []);
    const out = await run({ view: "ticket_log", from: "2026-10-01", to: "2026-10-07" });
    expect(out).toMatchObject({ ok: true, from: "2026-10-01", to: "2026-10-07", count: 2, truncated: false });
    const t = (out.tickets as Row[])[0]!;
    expect(t).toEqual({ ticket_id: "tk1", room_id: ROOM.id, room_name: "OPD 1", room_source: "decision", machine: "m1", action: "wake", status: "done", issuer_rule: "kiosk_asleep", mode: "live",
      issued_at: "2026-10-05T04:00:00.000Z", expires_at: "2026-10-05T04:10:00.000Z", fetched_at: "2026-10-05T04:01:00.000Z", completed_at: "2026-10-05T04:02:00.000Z" });
    expect((out.tickets as Row[])[1]).toMatchObject({ mode: null, issuer_rule: null });
    const keys = (v: unknown, acc: string[] = []): string[] => { if (Array.isArray(v)) v.forEach((x) => keys(x, acc)); else if (v && typeof v === "object") for (const [k, x] of Object.entries(v)) { acc.push(k); keys(x, acc); } return acc; };
    for (const k of keys(out)) expect(k, k).not.toMatch(/sig|key|nonce|token|secret/i);
    expect(JSON.stringify(out)).not.toMatch(/SIGSIGSIG|NONCENONCE/);
    const q = ticketSql()[0]!;
    expect(q.text).not.toMatch(/\bsignature\b|\bnonce\b|\bparams\b|\bresult\b|\bsig\b|secret|token/i);
    expect(q.values).toContain("2026-09-30T18:30:00.000Z"); // 2026-10-01 00:00 IST
    expect(q.values).toContain("2026-10-07T18:30:00.000Z"); // the end of 2026-10-07 IST, exclusive
  });
  it("dates are bounded: both required, real, in order, at most 31 days inclusive; nothing is read on a refusal", async () => {
    for (const [a, code] of [[{}, "from_and_to_required"], [{ from: "2026-10-01" }, "from_and_to_required"], [{ from: "2026-13-01", to: "2026-13-02" }, "invalid_date"], [{ from: "2026-10-05", to: "2026-10-01" }, "to_before_from"], [{ from: "2026-09-01", to: "2026-10-02" }, "range_too_wide"]] as Array<[Row, string]>) {
      expect(await run({ view: "ticket_log", ...a }), code).toMatchObject({ ok: false, error: code });
      expect(await run({ view: "ticket_summary", ...a }), code).toMatchObject({ ok: false, error: code });
    }
    expect(ticketSql()).toEqual([]);
    expect(await run({ view: "ticket_log", from: "2026-10-01", to: "2026-10-31" })).toMatchObject({ ok: true }); // 31 days
    expect(await run({ view: "ticket_log", from: "2026-10-01", to: "2026-11-01" })).toMatchObject({ ok: false, error: "range_too_wide" }); // 32 days
  });
  it("action and status filters are closed enums (refused before SQL), the room filter is resolved, limit is capped at 200 and says truncated", async () => {
    const r = { view: "ticket_log", from: "2026-10-01", to: "2026-10-02" };
    expect(await run({ ...r, action: "rm -rf" })).toMatchObject({ ok: false, error: "unknown_action" });
    expect(await run({ ...r, status: "x'; --" })).toMatchObject({ ok: false, error: "unknown_status" });
    expect(await run({ ...r, room: "nope" })).toMatchObject({ ok: false, error: "unknown_room" });
    expect(ticketSql()).toEqual([]);
    answer = (t, v) => (/FROM steward_tickets t/.test(t) ? Array.from({ length: 201 }, (_, i) => TROW(`tk${i}`)) : roomTable(t, v) ?? []);
    const out = await run({ ...r, action: "wake", status: "done", room: "opd-1", limit: 9999 });
    expect((out.tickets as Row[]).length).toBe(200);
    expect(out.truncated).toBe(true);
    const q = ticketSql()[0]!;
    expect(q.values).toContain(ROOM.id);
    expect(q.values).toContain("wake");
    expect(q.values).toContain("done");
    expect(q.values).toContain(201);
  });
});

describe("R4-2 room source and R4-3 truncation", () => {
  it("the room comes from the issuing decision only: no decision = room null and room_source unknown; the SELECT reads no install table", async () => {
    answer = (t, v) => (/FROM steward_tickets t/.test(t) ? [TROW("tk1"), TROW("tk2", { room_id: null, room_name: null, issuer_rule: null, decision_mode: null })] : roomTable(t, v) ?? []);
    const out = await run({ view: "ticket_log", from: "2026-10-01", to: "2026-10-07" });
    const t = out.tickets as Row[];
    expect(t[0]).toMatchObject({ room_id: ROOM.id, room_source: "decision" });
    expect(t[1]).toMatchObject({ room_id: null, room_name: null, room_source: "unknown" });
    for (const q of ticketSql()) expect(q.text).not.toMatch(/room_install/);
    await run({ view: "ticket_summary", from: "2026-10-01", to: "2026-10-07" });
    for (const q of ticketSql()) expect(q.text).not.toMatch(/room_install/);
  });
  it("ticket_summary says truncated when the 2000-row limit is hit, and not at exactly 2000", async () => {
    const rows = (n: number): Row[] => Array.from({ length: n }, (_, i) => ({ room_id: `r${i}`, room_name: null, action: "wake", status: "done", decision_mode: "live", n: 1 }));
    answer = (t, v) => (/FROM steward_tickets t/.test(t) ? rows(2001) : roomTable(t, v) ?? []);
    const big = await run({ view: "ticket_summary", from: "2026-10-01", to: "2026-10-07" });
    expect(big).toMatchObject({ truncated: true, total: 2000 });
    expect(ticketSql()[0]!.values).toContain(2001);
    answer = (t, v) => (/FROM steward_tickets t/.test(t) ? rows(2000) : roomTable(t, v) ?? []);
    expect(await run({ view: "ticket_summary", from: "2026-10-01", to: "2026-10-07" })).toMatchObject({ truncated: false, total: 2000 });
  });
});

describe("ticket_summary", () => {
  it("counts per action x status x mode and per room", async () => {
    answer = (t, v) => (/FROM steward_tickets t/.test(t) ? [
      { room_id: "r1", room_name: "OPD 1", action: "wake", status: "done", decision_mode: "live", n: 3 },
      { room_id: "r1", room_name: "OPD 1", action: "wake", status: "failed", decision_mode: "live", n: 1 },
      { room_id: "r2", room_name: "OPD 2", action: "wake", status: "done", decision_mode: "live", n: 2 }] : roomTable(t, v) ?? []);
    const out = await run({ view: "ticket_summary", from: "2026-10-01", to: "2026-10-07" });
    expect(out).toMatchObject({ ok: true, total: 6 });
    expect(out.by_action_status_mode).toEqual([{ action: "wake", status: "done", mode: "live", n: 5 }, { action: "wake", status: "failed", mode: "live", n: 1 }]);
    expect(out.by_room).toEqual([{ room_id: "r1", room_name: "OPD 1", n: 4 }, { room_id: "r2", room_name: "OPD 2", n: 2 }]);
    expect(out.truncated).toBe(false);
    expect(ticketSql()[0]!.text).not.toMatch(/signature|nonce/i);
  });
});

describe("live", () => {
  const SCHED = { clinic: { start: "07:30", end: "21:30", tz: "Asia/Kolkata", late_stop_max_min: 30 }, ot: { start: "06:00", end: "04:00", tz: "Asia/Kolkata", late_stop_max_min: 30 } };
  const cfg = (o: { kill?: boolean; global?: boolean; actions?: Row; startLive?: boolean; noRooms?: boolean; badSchedule?: boolean }): Row[] => [
    { key: "kill_switch", value: { on: o.kill ?? false } }, { key: "shadow", value: { global: o.global ?? false, actions: o.actions ?? {} } },
    ...(o.noRooms ? [] : [{ key: "rooms", value: {} }]), ...(o.badSchedule ? [{ key: "schedule", value: { clinic: "x" } }] : [{ key: "schedule", value: SCHED }]),
    ...(o.startLive === undefined ? [] : [{ key: "start_day_live", value: { on: o.startLive } }])];
  const live = async (rows: Row[]) => { answer = (t) => (/FROM steward_config/.test(t) ? rows : []); return run({ view: "live" }); };
  it("is exactly actionMode over LIVE_CAPABLE_ACTIONS and the database config: the seed is nothing live; the kill switch and the global flag each stop everything; scribe_start also needs start_day_live", async () => {
    expect((await live([])).live_actions).toEqual([]); // no rows = fail-closed defaults
    expect((await live(cfg({ kill: true, global: false, startLive: true }))).live_actions).toEqual([]);
    expect((await live(cfg({ global: true, startLive: true }))).live_actions).toEqual([]);
    expect((await live(cfg({ startLive: false, actions: { message: true } }))).live_actions).toEqual(C.LIVE_CAPABLE_ACTIONS.filter((a) => a !== "scribe_start" && a !== "message"));
    const only = await live(cfg({ startLive: true, actions: Object.fromEntries(C.LIVE_CAPABLE_ACTIONS.filter((a) => a !== "scribe_start").map((a) => [a, true])) }));
    expect(only.live_actions).toEqual(["scribe_start"]);
    expect(only).toMatchObject({ kill_switch: false, shadow_global: false, start_day_live: true });
    const all = (await live(cfg({ startLive: true }))).actions as Row[];
    expect(all.map((a) => a.action)).toEqual([...C.LIVE_CAPABLE_ACTIONS]);
    for (const a of all) expect(a.mode).toBe(C.actionMode({ ...C.DEFAULT_CONFIG, kill_switch: false, shadow: { global: false, actions: {} }, start_day_live: true }, String(a.action)));
  });
  it("R4-1: a fatal config (rooms or schedule missing / malformed) = the loop does not tick: loop_paused true, the reason codes, every action not live, even with the switches open", async () => {
    const open = { startLive: true, actions: {} };
    for (const [o, why] of [[{ ...open, noRooms: true }, ["config:rooms"]], [{ ...open, badSchedule: true }, ["config:schedule"]], [{ ...open, noRooms: true, badSchedule: true }, ["config:rooms", "config:schedule"]]] as Array<[Parameters<typeof cfg>[0], string[]]>) {
      const out = await live(cfg(o));
      expect(out).toMatchObject({ ok: true, loop_paused: true, live_actions: [] });
      expect([...(out.loop_paused_reason as string[])].sort()).toEqual([...why].sort());
      for (const a of out.actions as Row[]) expect(a, String(a.action)).toMatchObject({ mode: "shadow", live: false });
    }
    // the same switches with a sound config ARE live; and no rows at all is paused too
    expect(await live(cfg(open))).toMatchObject({ loop_paused: false });
    expect(((await live(cfg(open))).live_actions as string[]).length).toBeGreaterThan(0);
    expect(await live([])).toMatchObject({ loop_paused: true });
  });
  it("a malformed key is listed and fails closed; config-only (unpublished) action keys are listed and never live; only booleans and action names leave", async () => {
    const out = await live([{ key: "kill_switch", value: "banana" }, { key: "shadow", value: { global: false, actions: { legacy_action: false } } }]);
    expect(out.live_actions).toEqual([]); // kill switch unreadable = on
    expect(out.invalid_config_keys).toContain("kill_switch");
    expect(out.config_only_actions).toEqual(["legacy_action"]);
    const ok = await live(cfg({ startLive: true, actions: { legacy_action: false } }));
    expect(ok.live_actions as string[]).not.toContain("legacy_action");
    expect(JSON.stringify(ok)).not.toMatch(/room_|machine/);
  });
});

describe("read only", () => {
  it("every statement of every new view is a SELECT; the three views are in the schema enum; the tool stays read scope", async () => {
    answer = (t, v) => (/steward_config/.test(t) ? [] : /FROM steward_tickets t/.test(t) ? [TROW("tk1")] : roomTable(t, v) ?? []);
    for (const v of ["ticket_log", "ticket_summary", "live"]) await run({ view: v, from: "2026-10-01", to: "2026-10-02" });
    expect(statements.length).toBeGreaterThan(2);
    for (const s of statements) { expect(s.text.trimStart()).toMatch(/^SELECT/); expect(s.text).not.toMatch(/\b(INSERT|UPDATE|DELETE|TRUNCATE|DROP|ALTER|CREATE)\b/i); }
    const t = S.CALLABLE_TOOLS.get("scribe_steward")!;
    expect(t.scope).toBe("read");
    expect((t.inputSchema as unknown as { properties: { view: { enum: string[] } } }).properties.view.enum).toEqual(expect.arrayContaining(["ticket_log", "ticket_summary", "live"]));
    expect(T.TICKET_RANGE_DAYS_MAX).toBe(31);
  });
});

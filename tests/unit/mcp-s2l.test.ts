/**
 * Operator MCP S2L — scribe_steward_command, scribe_steward view=history, scribe_lanes and scribe_health aspect=routes. sql, fetch and the lab store are
 * mocked; the real SQL of the steward write is proved against postgres in steward-config-history-pg.test.ts.
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
const W = await import("@/lib/steward/write");
const L = await import("@/lib/sarvam-lab");
const R = await import("@/lib/mcp/tools/s2l");
const { handleMcpRpc } = await import("@/lib/mcp/handler");

const ROOM = { id: "room_yh3etjpf", slug: "opd-1", name: "OPD 1", disabled_at: null };
const ctx = (scopes: string[] = ["read", "write"]) => ({ origin: "https://app.example.test", actor: "mcp:op", scopes: new Set(scopes) }) as never;
const call = async (tool: string, args: Row, scopes?: string[]) => (await S.CALLABLE_TOOLS.get(tool)!.handler(args, ctx(scopes))) as Row;
const cmd = (args: Row) => call("scribe_steward_command", args);

/** a fake steward_config table: the tool's SELECT and its single CTE statement are answered from `cfg` */
let cfg: Record<string, unknown>;
let writes: Array<{ key: string; after: unknown; before: unknown; id: string; kind: string; roomId: string | null; actor: string; reason: string; requireKillOff: boolean }>;
let applyResult: { applied: number; logged: number } | "mirror";
const fakeTables = (text: string, values: unknown[]): unknown => {
  if (/FROM room\s/.test(text) && !/steward_/.test(text)) {
    const asked = values.filter((v) => typeof v === "string").map((v) => String(v).toLowerCase());
    return asked.some((v) => [ROOM.id, ROOM.slug, ROOM.name.toLowerCase()].includes(v)) ? [ROOM] : [];
  }
  if (/^\s*SELECT key, value FROM steward_config/.test(text)) {
    const keys = values[0] as string[] | string;
    const list = Array.isArray(keys) ? keys : String(keys).replace(/[{}"]/g, "").split(",");
    return list.filter((k) => k in cfg).map((k) => ({ key: k, value: cfg[k] }));
  }
  if (/WITH k AS \(SELECT value FROM steward_config/.test(text)) {
    const [key, afterJson, actor, requireKillOff, beforeJson, id, , kind, roomId, , , , reason] = [values[0], values[1], values[2], values[3], values[4], values[5], values[6], values[7], values[8], values[9], values[10], values[11], values[12]];
    writes.push({ key: String(key), after: JSON.parse(String(afterJson)), before: beforeJson === null ? null : JSON.parse(String(beforeJson)), id: String(id), kind: String(kind), roomId: roomId === null ? null : String(roomId), actor: String(actor), reason: String(reason), requireKillOff: requireKillOff === true || requireKillOff === "true" });
    if (applyResult === "mirror") { cfg[String(key)] = JSON.parse(String(afterJson)); return [{ applied: 1, logged: 1 }]; }
    return [applyResult];
  }
  return [];
};

const seed = (over: Record<string, unknown> = {}) => ({
  kill_switch: { on: false },
  shadow: { global: true, actions: {} },
  schedule: { clinic: { start: "07:30", end: "21:30", tz: "Asia/Kolkata", late_stop_max_min: 30 }, ot: { start: "06:00", end: "04:00", tz: "Asia/Kolkata", late_stop_max_min: 30 } },
  rooms: { room_jwyrr4dc: { flags: ["dev", "test"], machine: "ORBOX3" } },
  ...over,
});

beforeEach(() => {
  statements.length = 0; writes = []; cfg = seed(); applyResult = "mirror";
  answer = fakeTables;
});

describe("registration", () => {
  it("the tools are listed (54 in all), write / read scope, and scribe_health gained aspect=routes", async () => {
    expect(S.CALLABLE_TOOLS.get("scribe_steward_command")!.scope).toBe("write");
    expect(S.CALLABLE_TOOLS.get("scribe_lanes")!.scope).toBe("read");
    const req = new NextRequest("https://x/api/mcp", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }) });
    const body = (await (await handleMcpRpc(req, { token_id: "t", scopes: new Set(["read"]) } as never)).json()) as { result: { tools: Array<{ name: string; description: string; annotations: Row; inputSchema: Row }> } };
    const t = body.result.tools;
    expect(t.length).toBe(54);
    const sc = t.find((x) => x.name === "scribe_steward_command")!;
    expect(sc.annotations).toMatchObject({ readOnlyHint: false, destructiveHint: true });
    expect(sc.description.length).toBeLessThanOrEqual(200);
    expect(t.find((x) => x.name === "scribe_lanes")!.annotations.readOnlyHint).toBe(true);
    const aspect = ((t.find((x) => x.name === "scribe_health")!.inputSchema as { properties: Row }).properties.aspect as { enum: string[] }).enum;
    expect(aspect).toContain("routes");
    expect(JSON.stringify(body.result).length).toBeLessThanOrEqual(44_000);
  });

  it("the write needs write scope at the door; a room-restricted token is refused", async () => {
    const rpc = async (scopes: string[], rooms?: string[]) => {
      const req = new NextRequest("https://x/api/mcp", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "scribe_steward_command", arguments: { kind: "note", reason: "r", value: "x" } } }) });
      return (await handleMcpRpc(req, { token_id: "t", scopes: new Set(scopes), ...(rooms ? { rooms: new Set(rooms) } : {}) } as never)).status;
    };
    expect(await rpc(["read", "invoke"])).toBe(403);
    expect(await rpc(["read", "write"], ["room_x"])).toBe(403);
    expect(await rpc(["read", "write"])).toBe(200);
  });
});

describe("scribe_steward_command — arguments", () => {
  it("unknown kind, missing / over-long reason, rooms where they do not belong, a missing room where one is needed", async () => {
    expect(await cmd({ kind: "explode", reason: "r" })).toMatchObject({ ok: false, error: "unknown_kind", allowed: [...W.COMMAND_KINDS] });
    for (const reason of ["", "   ", "r".repeat(281)]) expect(await cmd({ kind: "note", reason, value: "x" })).toMatchObject({ ok: false, error: "reason_required" });
    expect(await cmd({ kind: "set_shadow", reason: "r", room: "opd-1", value: { global: false } })).toMatchObject({ ok: false, error: "room_not_used" });
    expect(await cmd({ kind: "add_room", reason: "r", value: {} })).toMatchObject({ ok: false, error: "room_required" });
    expect(await cmd({ kind: "flag_room", reason: "r", room: "nope", value: { add: ["x"] } })).toEqual({ ok: false, error: "unknown_room", room: "nope" });
    expect(writes).toEqual([]);
  });
  it("a 280-character reason is the longest allowed", async () => {
    expect(await cmd({ kind: "note", reason: "r".repeat(280), value: "hello" })).toMatchObject({ ok: true });
  });
});

describe("scribe_steward_command — the kinds", () => {
  it("kill switch ON blocks everything but note and kill_switch, by name, before any write", async () => {
    cfg = seed({ kill_switch: { on: true } });
    for (const a of [
      { kind: "set_shadow", value: { global: false } }, { kind: "start_day_live", value: { on: true } }, { kind: "add_room", room: "opd-1", value: {} },
      { kind: "flag_room", room: "opd-1", value: { add: ["x"] } }, { kind: "set_window", value: { profile: "ot", start: "05:00", end: "03:00" } }, { kind: "mute_alerts", minutes: 30 },
    ]) expect(await cmd({ reason: "r", ...a }), a.kind).toMatchObject({ ok: false, error: "kill_switch_on", kind: a.kind });
    expect(writes).toEqual([]);
    expect(await cmd({ kind: "note", reason: "r", value: "still allowed" })).toMatchObject({ ok: true });
    expect(await cmd({ kind: "kill_switch", reason: "go", value: { on: false } })).toMatchObject({ ok: true, after: { on: false } });
  });
  it("a missing or malformed kill_switch row counts as ON (the safe side)", async () => {
    delete cfg.kill_switch;
    expect(await cmd({ kind: "set_shadow", reason: "r", value: { global: false } })).toMatchObject({ ok: false, error: "kill_switch_on" });
    cfg.kill_switch = { on: "no" };
    expect(await cmd({ kind: "set_shadow", reason: "r", value: { global: false } })).toMatchObject({ ok: false, error: "kill_switch_on" });
  });

  it("the write is ONE statement carrying key, before, after, kind, room, actor, reason and the kill-switch requirement", async () => {
    const out = await cmd({ kind: "set_shadow", reason: "enable start for OPD", value: { global: false, actions: { scribe_start: false } } });
    expect(out).toMatchObject({ ok: true, kind: "set_shadow", key: "shadow", before: { global: true, actions: {} }, after: { global: false, actions: { scribe_start: false } },
      revert: { kind: "set_shadow", value: { global: true, actions: {} }, exact: true } });
    expect(String(out.history_id)).toMatch(/^sch_/);
    expect(writes).toHaveLength(1);
    expect(writes[0]).toMatchObject({ key: "shadow", kind: "set_shadow", roomId: null, actor: "mcp:op", reason: "enable start for OPD", requireKillOff: true, before: { global: true, actions: {} } });
    const stmt = statements.find((s) => /WITH k AS/.test(s.text))!;
    expect(stmt.text).toMatch(/IS NOT DISTINCT FROM/); // compare-and-set
    expect(stmt.text).toMatch(/INSERT INTO steward_config_history/);
    expect(stmt.text).not.toMatch(/\bDELETE\b/);
  });

  it("revert round-trip for every reversible kind: running the revert restores the exact previous value", async () => {
    const roundTrip = async (args: Row, key: string) => {
      const before = JSON.parse(JSON.stringify(cfg[key] ?? null));
      const out = await cmd({ reason: "do", ...args });
      expect(out.ok, JSON.stringify(args)).toBe(true);
      const rv = out.revert as { kind: string; value?: unknown; room?: string; minutes?: number; exact: boolean };
      if (!rv.exact) return out;
      const back = await cmd({ reason: "undo", kind: rv.kind, ...(rv.room ? { room: rv.room } : {}), ...(rv.value !== undefined ? { value: rv.value } : {}), ...(rv.minutes !== undefined ? { minutes: rv.minutes } : {}) });
      expect(back.ok, `revert of ${JSON.stringify(args)}`).toBe(true);
      return { out, before, now: JSON.parse(JSON.stringify(cfg[key] ?? null)) };
    };
    let r = await roundTrip({ kind: "set_shadow", value: { global: false, actions: { message: false } } }, "shadow");
    expect((r as { now: unknown }).now).toEqual((r as { before: unknown }).before);
    r = await roundTrip({ kind: "set_shadow", value: { actions: { "ticket:wake": false } } }, "shadow");
    expect((r as { now: unknown }).now).toEqual((r as { before: unknown }).before);
    r = await roundTrip({ kind: "kill_switch", value: { on: true } }, "kill_switch");
    expect((r as { now: unknown }).now).toEqual((r as { before: unknown }).before);
    cfg.kill_switch = { on: false };
    cfg.rooms = { room_jwyrr4dc: { flags: ["dev"], machine: "m" } };
    // a room that is in the config: flag add / remove and back
    cfg.rooms = { ...(cfg.rooms as Row), [ROOM.id]: { flags: ["pilot"], class: "opd" } };
    r = await roundTrip({ kind: "flag_room", room: "opd-1", value: { add: ["a", "b"], remove: ["pilot"] } }, "rooms");
    expect((r as { now: unknown }).now).toEqual((r as { before: unknown }).before);
    r = await roundTrip({ kind: "set_window", value: { profile: "ot", start: "05:00", end: "03:00", late_stop_max_min: 60 } }, "schedule");
    expect((r as { now: unknown }).now).toEqual((r as { before: unknown }).before);
    r = await roundTrip({ kind: "note", value: "first note" }, "operator_note");
    expect((cfg.operator_note as { text: string }).text).toBe(""); // reverting the first note clears it
  });

  it("G17: set_shadow rejects unknown action keys (allowlist = the published, live-capable action names), naming them and the allowed list; nothing is written", async () => {
    for (const bad of [{ actions: { totally_made_up: true } }, { actions: { "ticket:wake": false, scribe_stat: true } }, { global: false, actions: { restart_everything: false } }]) {
      const out = await cmd({ kind: "set_shadow", reason: "r", value: bad });
      expect(out, JSON.stringify(bad)).toMatchObject({ ok: false, error: "unknown_action", kind: "set_shadow" });
      expect(String(out.detail)).toContain("allowed: scribe_start, ticket:wake");
    }
    expect(writes).toEqual([]);
    for (const good of ["scribe_start", "ticket:wake", "ticket:open_pulse", "ticket:relaunch_chrome", "ticket:policy_cycle", "ticket:restart_recorder_app", "ticket:restart_kiosk_health", "message"]) {
      expect(await cmd({ kind: "set_shadow", reason: "r", value: { actions: { [good]: false } } }), good).toMatchObject({ ok: true });
    }
    // the allowlist IS the Steward's own list (config.ts), so it cannot drift
    const { LIVE_CAPABLE_ACTIONS } = await import("@/lib/steward/config");
    expect(LIVE_CAPABLE_ACTIONS).toContain("scribe_start");
  });
  it("G17: a legacy unknown key already in the map may be CLEARED with null, but not set", async () => {
    cfg.shadow = { global: true, actions: { legacy_action: true, "ticket:wake": false } };
    expect(await cmd({ kind: "set_shadow", reason: "r", value: { actions: { legacy_action: true } } })).toMatchObject({ ok: false, error: "unknown_action" });
    expect(await cmd({ kind: "set_shadow", reason: "clean up", value: { actions: { legacy_action: null } } })).toMatchObject({ ok: true, after: { global: true, actions: { "ticket:wake": false } } });
  });
  it("G18: actions merge PER KEY — a partial update leaves the other keys alone; null clears one key; global alone leaves the map", async () => {
    cfg.shadow = { global: true, actions: { "ticket:wake": false, message: true } };
    const a = await cmd({ kind: "set_shadow", reason: "r", value: { actions: { scribe_start: false } } });
    expect(a).toMatchObject({ ok: true, after: { global: true, actions: { "ticket:wake": false, message: true, scribe_start: false } } });
    const b = await cmd({ kind: "set_shadow", reason: "r", value: { actions: { message: null, "ticket:wake": true } } });
    expect(b).toMatchObject({ ok: true, after: { global: true, actions: { "ticket:wake": true, scribe_start: false } } });
    expect((cfg.shadow as { actions: Row }).actions).not.toHaveProperty("message");
    const c = await cmd({ kind: "set_shadow", reason: "r", value: { global: false, actions: { scribe_start: false } } });
    expect(c).toMatchObject({ ok: true, after: { global: false, actions: { "ticket:wake": true, scribe_start: false, message: true } } }); // every unnamed published action is HELD
    // clearing a key that is not there is a no-op; an empty partial update changes nothing
    expect(await cmd({ kind: "set_shadow", reason: "r", value: { actions: {} } })).toMatchObject({ ok: true, unchanged: true });
  });
  const PUBLISHED = ["scribe_start", "ticket:wake", "ticket:open_pulse", "ticket:relaunch_chrome", "ticket:policy_cycle", "ticket:restart_recorder_app", "ticket:restart_kiosk_health", "message"];
  it("SF1: global:false is refused without an actions map naming an action (explicit_actions_required) and writes nothing; null is refused too", async () => {
    cfg.shadow = { global: true, actions: {} };
    for (const v of [{ global: false }, { global: false, actions: {} }]) {
      expect(await cmd({ kind: "set_shadow", reason: "r", value: v }), JSON.stringify(v)).toMatchObject({ ok: false, error: "explicit_actions_required" });
    }
    expect(await cmd({ kind: "set_shadow", reason: "r", value: { global: false, actions: { message: null } } })).toMatchObject({ ok: false, error: "bad_value" });
    expect(cfg.shadow).toEqual({ global: true, actions: {} });
    expect(writes).toEqual([]);
  });
  it("G51 — {global:false} without a named action is ALWAYS explicit_actions_required, whatever the current global: true (the transition) and false (no transition) alike; nothing is written", async () => {
    for (const cur of [{ global: true, actions: {} }, { global: false, actions: { message: false, "ticket:wake": true } }]) {
      for (const v of [{ global: false }, { global: false, actions: {} }]) {
        cfg.shadow = structuredClone(cur);
        writes.length = 0;
        expect(await cmd({ kind: "set_shadow", reason: "r", value: v }), `${JSON.stringify(cur)} <- ${JSON.stringify(v)}`).toMatchObject({ ok: false, error: "explicit_actions_required" });
        expect(cfg.shadow).toEqual(cur);
        expect(writes).toEqual([]);
      }
    }
    // naming an action is still fine in both states
    cfg.shadow = { global: false, actions: { message: true } };
    expect(await cmd({ kind: "set_shadow", reason: "r", value: { global: false, actions: { message: false } } })).toMatchObject({ ok: true, changed_actions: ["message"] });
  });
  it("SF1: global:false with actions {message:false} makes EXACTLY message live; every other published action is written held (true); the answer lists live_actions and changed_actions", async () => {
    cfg.shadow = { global: true, actions: {} };
    const out = await cmd({ kind: "set_shadow", reason: "go live for message", value: { global: false, actions: { message: false } } });
    expect(out).toMatchObject({ ok: true, live_actions: ["message"], changed_actions: ["message"] });
    const sh = cfg.shadow as { global: boolean; actions: Record<string, boolean> };
    expect(sh.global).toBe(false);
    for (const a of PUBLISHED) expect(sh.actions[a], a).toBe(a !== "message");
    // revert: global back on, every published key back to absent
    expect(out.revert).toMatchObject({ kind: "set_shadow", exact: true, value: { global: true } });
    const rv = out.revert as { value: unknown };
    expect(await cmd({ kind: "set_shadow", reason: "undo", value: rv.value })).toMatchObject({ ok: true, live_actions: [], changed_actions: ["message"] });
    expect(cfg.shadow).toEqual({ global: true, actions: {} });
  });
  it("SF1: scribe_start is live only if the call names it false; naming one action true holds it; an actions-only change while global is already false changes only the named actions", async () => {
    cfg.shadow = { global: true, actions: {} };
    const a = await cmd({ kind: "set_shadow", reason: "r", value: { global: false, actions: { scribe_start: false, message: true } } });
    expect(a).toMatchObject({ ok: true, live_actions: ["scribe_start"] });
    const b = await cmd({ kind: "set_shadow", reason: "r", value: { actions: { "ticket:wake": false } } });
    expect(b).toMatchObject({ ok: true, live_actions: ["scribe_start", "ticket:wake"], changed_actions: ["ticket:wake"] });
    // the revert of an actions-only change under global:false replays (it carries an explicit map, so global:false is not refused)
    const rv = (await cmd({ kind: "set_shadow", reason: "r", value: { global: true } })).revert as { value: unknown };
    expect(rv).toMatchObject({ value: { global: false } });
    expect(await cmd({ kind: "set_shadow", reason: "undo the undo", value: rv.value })).toMatchObject({ ok: true, live_actions: ["scribe_start", "ticket:wake"] });
  });
  it("G35: while global is false, null on a PUBLISHED key is held (true), not cleared; null on an unpublished legacy key still removes it; while global is true null clears", async () => {
    cfg.shadow = { global: false, actions: { ...Object.fromEntries(PUBLISHED.map((x) => [x, true])), message: false, legacy_action: true } };
    const a = await cmd({ kind: "set_shadow", reason: "r", value: { actions: { "ticket:wake": null, message: null, legacy_action: null } } });
    expect(a).toMatchObject({ ok: true, live_actions: [], changed_actions: ["message"], after: { global: false, actions: Object.fromEntries(PUBLISHED.map((x) => [x, true])) } });
    expect((a.revert as { exact: boolean }).exact).toBe(false); // the legacy key (SF3)
    cfg.shadow = { global: true, actions: { message: true } };
    expect(await cmd({ kind: "set_shadow", reason: "r", value: { actions: { message: null } } })).toMatchObject({ ok: true, after: { global: true, actions: {} } });
  });
  it("G41: while global is false, holding a key that was ABSENT (= live) gives a revert that names false and is NOT exact (it restores the behaviour, not the stored bytes); replaying it makes the action live again", async () => {
    cfg.shadow = { global: false, actions: { "ticket:wake": true } }; // every other published action is absent = live
    const before = await cmd({ kind: "set_shadow", reason: "r", value: { actions: { "ticket:wake": true } } });
    expect(before).toMatchObject({ ok: true, unchanged: true });
    const out = await cmd({ kind: "set_shadow", reason: "hold message", value: { actions: { message: true } } });
    expect(out).toMatchObject({ ok: true, changed_actions: ["message"] });
    expect(out.live_actions).not.toContain("message");
    const rv = out.revert as { exact: boolean; note?: string; value: Row };
    expect(rv.value).toEqual({ actions: { message: false } });
    expect(rv.exact).toBe(false);
    expect(rv.note).toMatch(/message was absent.*explicit false/);
    const back = await cmd({ kind: "set_shadow", reason: "undo", value: rv.value });
    expect(back.live_actions).toContain("message"); // live again, as before
    // an absent key while global is TRUE is shadow: clearing it again is exact
    cfg.shadow = { global: true, actions: {} };
    const t = await cmd({ kind: "set_shadow", reason: "r", value: { actions: { message: true } } });
    expect(t.revert).toMatchObject({ exact: true, value: { actions: { message: null } } });
    // turning global back ON from OFF with absent (live) keys: the explicit map restores behaviour, not bytes
    cfg.shadow = { global: false, actions: { "ticket:wake": true } };
    const on = await cmd({ kind: "set_shadow", reason: "r", value: { global: true } });
    expect((on.revert as { exact: boolean }).exact).toBe(false);
  });
  it("SF1: a plain shadow-only change (global stays true) lists no live action", async () => {
    cfg.shadow = { global: true, actions: {} };
    expect(await cmd({ kind: "set_shadow", reason: "r", value: { actions: { message: false } } })).toMatchObject({ ok: true, live_actions: [], changed_actions: [] });
  });
  it("SF3: clearing a LEGACY unpublished key gives a revert that is NOT exact, says why, and does not carry the key (so replaying it cannot hit unknown_action)", async () => {
    cfg.shadow = { global: true, actions: { legacy_action: true, "ticket:wake": false } };
    const out = await cmd({ kind: "set_shadow", reason: "clean", value: { actions: { legacy_action: null, "ticket:wake": true } } });
    const rv = out.revert as { exact: boolean; note?: string; value: { actions: Row } };
    expect(rv.exact).toBe(false);
    expect(rv.note).toMatch(/legacy_action.*not re-created/);
    expect(rv.value.actions).toEqual({ "ticket:wake": false });
    expect(await cmd({ kind: "set_shadow", reason: "replay", value: rv.value })).toMatchObject({ ok: true });
  });
  it("G18: the revert of a partial update restores exactly the keys it touched (a new key is cleared, a changed one goes back, a cleared one returns)", async () => {
    cfg.shadow = { global: true, actions: { "ticket:wake": false, message: true } };
    const out = await cmd({ kind: "set_shadow", reason: "r", value: { actions: { scribe_start: false, "ticket:wake": true, message: null } } });
    expect(out).toMatchObject({ ok: true, revert: { kind: "set_shadow", exact: true, value: { actions: { scribe_start: null, "ticket:wake": false, message: true } } } });
    const rv = out.revert as { kind: string; value: unknown };
    expect(await cmd({ kind: rv.kind, reason: "undo", value: rv.value })).toMatchObject({ ok: true });
    expect(cfg.shadow).toEqual({ global: true, actions: { "ticket:wake": false, message: true } });
  });
  it("G24: the revert carries ONLY the fields the command touched — an actions-only change has no `global` (whatever global is), and a later change of global is not undone by it", async () => {
    cfg.shadow = { global: true, actions: { "ticket:wake": false } };
    const a = await cmd({ kind: "set_shadow", reason: "r", value: { actions: { message: true } } });
    expect((a.revert as { value: Row }).value).toEqual({ actions: { message: null } });
    // someone turns global off meanwhile (naming what goes live); reverting the ACTIONS-only change must leave global alone
    cfg.shadow = { global: false, actions: { "ticket:wake": false, message: true, scribe_start: true } };
    await cmd({ kind: "set_shadow", reason: "undo", value: (a.revert as { value: unknown }).value });
    expect((cfg.shadow as { global: boolean }).global).toBe(false);
    expect((cfg.shadow as { actions: Row }).actions.message).toBe(true); // G35: null under global:false is HELD, not removed
    // an actions-only change made while global is already false: its revert is actions-only too
    const b = await cmd({ kind: "set_shadow", reason: "r", value: { actions: { scribe_start: false } } });
    expect((b.revert as { value: Row }).value).toEqual({ actions: { scribe_start: true } });
  });


  it("add_room: resolves the room by name, refuses a duplicate, and its revert is inexact (flag dev), said so", async () => {
    const out = await cmd({ kind: "add_room", reason: "new OPD", room: "OPD 1", value: { class: "opd", flags: ["pilot"], machine: "mac-7" } });
    expect(out).toMatchObject({ ok: true, key: "rooms", room: { id: ROOM.id, slug: "opd-1" }, after: { [ROOM.id]: { flags: ["pilot"], class: "opd", machine: "mac-7" }, room_jwyrr4dc: { flags: ["dev", "test"], machine: "ORBOX3" } },
      revert: { kind: "flag_room", room: "opd-1", value: { add: ["dev"] }, exact: false } });
    expect(writes[0]).toMatchObject({ roomId: ROOM.id, kind: "add_room" });
    expect(await cmd({ kind: "add_room", reason: "again", room: "opd-1", value: {} })).toMatchObject({ ok: false, error: "room_exists" });
    expect(await cmd({ kind: "flag_room", reason: "r", room: "OPD 1", value: { add: ["x".repeat(40)] } })).toMatchObject({ ok: false, error: "bad_value" });
  });

  it("validation per kind: shadow, window, flags, note length, minutes", async () => {
    for (const [a, err] of [
      [{ kind: "set_shadow", value: {} }, "bad_value"], [{ kind: "set_shadow", value: { global: "yes" } }, "bad_value"], [{ kind: "set_shadow", value: { actions: { "bad key!": true } } }, "bad_value"],
      [{ kind: "kill_switch", value: { on: "off" } }, "bad_value"], [{ kind: "kill_switch" }, "bad_value"],
      [{ kind: "start_day_live", value: { on: 1 } }, "bad_value"],
      [{ kind: "set_window", value: { profile: "icu", start: "08:00", end: "09:00" } }, "bad_value"], [{ kind: "set_window", value: { profile: "ot", start: "8:00", end: "09:00" } }, "bad_value"],
      [{ kind: "set_window", value: { profile: "ot", start: "08:00", end: "09:00", late_stop_max_min: 0 } }, "bad_value"], [{ kind: "set_window", value: { profile: "ot", start: "08:00", end: "09:00", extra: 1 } }, "bad_value"],
      [{ kind: "note", value: "n".repeat(501) }, "bad_value"], [{ kind: "note", value: { text: "x" } }, "bad_value"],
      [{ kind: "mute_alerts" }, "bad_minutes"], [{ kind: "mute_alerts", minutes: 4 }, "bad_minutes"], [{ kind: "mute_alerts", minutes: 721 }, "bad_minutes"], [{ kind: "mute_alerts", minutes: 10.5 }, "bad_minutes"],
    ] as Array<[Row, string]>) expect(await cmd({ reason: "r", ...a }), JSON.stringify(a)).toMatchObject({ ok: false, error: err });
    expect(writes).toEqual([]);
    for (const m of [0, 5, 60, 720]) expect(await cmd({ kind: "mute_alerts", reason: "r", minutes: m })).toMatchObject({ ok: true });
  });

  it("mute_alerts: 5..720 minutes, per room or '*', expired mutes pruned, 0 unmutes", async () => {
    const out = await cmd({ kind: "mute_alerts", reason: "maintenance", room: "opd-1", minutes: 45 });
    expect(out.ok).toBe(true);
    const until = ((cfg.alert_mutes as { rooms: Row }).rooms[ROOM.id] as { until: string }).until;
    expect(Date.parse(until) - Date.now()).toBeGreaterThan(44 * 60_000);
    expect(Date.parse(until) - Date.now()).toBeLessThan(46 * 60_000);
    cfg.alert_mutes = { rooms: { ...(cfg.alert_mutes as { rooms: Row }).rooms, "*": { until: "2020-01-01T00:00:00.000Z", by: "x", set_at: "x" } } };
    await cmd({ kind: "mute_alerts", reason: "all", minutes: 10 });
    expect(Object.keys((cfg.alert_mutes as { rooms: Row }).rooms).sort()).toEqual(["*", ROOM.id].sort());
    expect(Date.parse(((cfg.alert_mutes as { rooms: Row }).rooms["*"] as { until: string }).until)).toBeGreaterThan(Date.now()); // the expired "*" was replaced, not kept
    await cmd({ kind: "mute_alerts", reason: "unmute", room: "opd-1", minutes: 0 });
    expect(Object.keys((cfg.alert_mutes as { rooms: Row }).rooms)).toEqual(["*"]);
  });

  it("no-op changes write nothing; a lost compare-and-set retries and then gives up by name", async () => {
    expect(await cmd({ kind: "start_day_live", reason: "r", value: { on: false } })).toMatchObject({ ok: true, unchanged: false }); // absent -> explicit false is a change
    expect(await cmd({ kind: "start_day_live", reason: "r", value: { on: false } })).toMatchObject({ ok: true, unchanged: true, history_id: null });
    expect(writes).toHaveLength(1);
    applyResult = { applied: 0, logged: 0 };
    writes = [];
    expect(await cmd({ kind: "start_day_live", reason: "r", value: { on: true } })).toMatchObject({ ok: false, error: "config_changed_concurrently" });
    expect(writes).toHaveLength(3);
  });
});

describe("scribe_steward view=history", () => {
  it("reads steward_config_history with bound parameters; room filter; clamps; values scrubbed of nonce / signature", async () => {
    answer = (text, values) =>
      /FROM steward_config_history/.test(text)
        ? [{ id: "sch_1", key: "shadow", kind: "set_shadow", room_id: null, before: { global: true, actions: {}, nonce: "NN" }, after: { global: false, actions: {}, Signature: "SS" }, actor: "mcp:op", reason: "why", via: "mcp", created_at: "2026-10-08T10:00:00.000Z" }]
        : fakeTables(text, values);
    const out = await call("scribe_steward", { view: "history", since_hours: 9999, limit: 5000 });
    expect(out).toMatchObject({ view: "history", ok: true, count: 1, since_hours: 168, clamped: true, changes: [{ id: "sch_1", key: "shadow", kind: "set_shadow", actor: "mcp:op", reason: "why", via: "mcp", at: "2026-10-08T10:00:00.000Z" }] });
    expect(JSON.stringify(out)).not.toMatch(/NN|SS/);
    const q = statements.find((s) => /FROM steward_config_history/.test(s.text))!;
    expect(q.values).toEqual([168, null, null, 201]);
    statements.length = 0;
    await call("scribe_steward", { view: "history", room: "opd-1" });
    expect(statements.find((s) => /FROM steward_config_history/.test(s.text))!.values).toContain(ROOM.id);
    expect(statements.every((s) => !/\b(INSERT|UPDATE|DELETE)\b/.test(s.text))).toBe(true);
  });
  it("not_collected on SQLSTATE 42P01 only", async () => {
    answer = (text) => (/FROM steward_config_history/.test(text) ? Object.assign(new Error('relation "steward_config_history" does not exist'), { code: "42P01" }) : []);
    expect(await call("scribe_steward", { view: "history" })).toMatchObject({ view: "history", not_collected: true });
    answer = (text) => (/FROM steward_config_history/.test(text) ? new Error('relation "x" does not exist') : []);
    const bad = await call("scribe_steward", { view: "history" });
    expect(bad).toMatchObject({ ok: false });
    expect(bad).not.toHaveProperty("not_collected");
  });
});

describe("scribe_lanes", () => {
  const files = new Map<string, { body: string; etag: string; last_modified?: string }>();
  const gets: string[] = [];
  const puts: string[] = [];
  const store: import("@/lib/sarvam-lab").LabStore = {
    async get(k) { gets.push(k); const o = files.get(k); return o ? { body: o.body, etag: o.etag, last_modified: o.last_modified ?? null } : null; },
    async put(k) { puts.push(k); return "ok"; },
    async list(p) { return [...files.keys()].filter((k) => k.startsWith(p)); },
  };
  const ago = (s: number) => new Date(Date.now() - s * 1000).toISOString();
  beforeEach(() => { files.clear(); gets.length = 0; puts.length = 0; L.setLabStoreForTests(store); });
  afterEach(() => L.setLabStoreForTests(null));

  it("not_configured without the SCRIBE_LAB_R2_* variables (and nothing is read)", async () => {
    L.setLabStoreForTests(null);
    for (const n of L.LAB_ENV) delete process.env[n];
    expect(await call("scribe_lanes", { view: "fleet" })).toMatchObject({ ok: false, not_configured: true, error: "not_configured" });
    expect(await call("scribe_lanes", { view: "lanes" })).toMatchObject({ not_configured: true });
    expect(await call("scribe_lanes", { view: "nope" })).toMatchObject({ ok: false, error: "unknown_view" });
  });

  it("fleet: lanes/_fleet.json exactly as written plus age_s; absent is said, not invented", async () => {
    expect(await call("scribe_lanes", { view: "fleet" })).toMatchObject({ ok: true, present: false });
    const fleet = { schema: "v1", updated_at: ago(90), machines: [{ name: "mini", state: "up" }], agents: [{ name: "a1" }], jobs: [{ id: "j1" }], extra_field: { keep: true } };
    files.set("lanes/_fleet.json", { body: JSON.stringify(fleet), etag: '"1"' });
    const out = await call("scribe_lanes", { view: "fleet" });
    expect(out).toMatchObject({ ok: true, present: true, fleet });
    expect(out.age_s as number).toBeGreaterThanOrEqual(90);
    expect(out.age_s as number).toBeLessThan(100);
    files.set("lanes/_fleet.json", { body: "{not json", etag: '"2"' });
    expect(await call("scribe_lanes", { view: "fleet" })).toMatchObject({ ok: false, error: "not_json" });
    files.set("lanes/_fleet.json", { body: " ".repeat(600 * 1024), etag: '"3"' });
    expect(await call("scribe_lanes", { view: "fleet" })).toMatchObject({ ok: false, error: "file_too_large" });
  });

  it("lanes: every lanes/*.json except _fleet, with name, updated_at, age_s, stale (> 600 s) and a summary; expected-but-absent lanes say 'none written'", async () => {
    files.set("lanes/_fleet.json", { body: "{}", etag: '"f"' });
    files.set("lanes/sarvam-scribe-mcp.json", { body: JSON.stringify({ caller: "scribe-mcp", machine: "vercel", updated_at: ago(30), active: [{ job_id: "j" }, { job_id: "k" }], today: { jobs: 3, audio_min: 12, failed: 0, throttled: 0 }, all_time: { jobs: 9, audio_min: 40 } }), etag: '"1"' });
    files.set("lanes/sarvam-palimpsest.json", { body: JSON.stringify({ caller: "palimpsest", updated_at: ago(601), active: [] }), etag: '"2"' });
    files.set("lanes/other.json", { body: JSON.stringify({ state: "idle", jobs: 4, mystery: 1 }), etag: '"3"', last_modified: ago(10) });
    files.set("lanes/sub/dir.json", { body: "{}", etag: '"4"' });
    files.set("lanes/readme.txt", { body: "x", etag: '"5"' });
    const out = await call("scribe_lanes", { view: "lanes" }) as { lanes: Row[]; count: number };
    const by = Object.fromEntries(out.lanes.map((l) => [String(l.name), l]));
    expect(Object.keys(by).sort()).toEqual(["other", "sarvam-backfill", "sarvam-palimpsest", "sarvam-scribe-mcp"]);
    expect(by["sarvam-scribe-mcp"]).toMatchObject({ stale: false, summary: { active: 2, today: { jobs: 3, audio_min: 12 }, all_time: { jobs: 9 }, caller: "scribe-mcp", machine: "vercel" } });
    expect(by["sarvam-palimpsest"]).toMatchObject({ stale: true });
    expect(by.other).toMatchObject({ stale: false, summary: { state: "idle", jobs: 4 } }); // age from the object's own modified time
    expect(by["sarvam-backfill"]).toEqual({ name: "sarvam-backfill", status: "none written" });
    expect(JSON.stringify(by["sarvam-scribe-mcp"])).not.toContain("job_id"); // a summary, not the file
    expect(gets).not.toContain("lanes/_fleet.json");
  });

  it("never writes, and reads only under lanes/ (the allowlist module guards the store)", async () => {
    files.set("lanes/sarvam-scribe-mcp.json", { body: "{}", etag: '"1"' });
    await call("scribe_lanes", { view: "lanes" });
    await call("scribe_lanes", { view: "fleet" });
    expect(puts).toEqual([]);
    for (const k of gets) expect(k.startsWith("lanes/")).toBe(true);
    const r = L.labReader()!;
    await expect(r.get("reb/anything.json")).rejects.toThrow(/lab_key_not_readable/);
    await expect(r.list("reb/")).rejects.toThrow(/lab_key_not_readable/);
    expect((r as unknown as Record<string, unknown>).put).toBeUndefined();
  });

  it("a store failure is a named error, not a crash", async () => {
    L.setLabStoreForTests({ get: async () => { throw new Error("down"); }, put: async () => "ok", list: async () => { throw new Error("down"); } });
    expect(await call("scribe_lanes", { view: "lanes" })).toMatchObject({ ok: false, error: "lab_read_failed" });
  });

  it("summariseLane states only what the file holds", () => {
    expect(R.summariseLane({ active: [1, 2, 3] })).toEqual({ active: 3 });
    expect(R.summariseLane({ zzz: 1, aaa: 2 })).toEqual({ keys: ["zzz", "aaa"] });
    expect(R.summariseLane([1])).toEqual({ shape: "array" });
  });
});

describe("scribe_health aspect=routes", () => {
  const fetchMock = vi.fn();
  const savedApp = process.env.APP_URL;
  // G79: the fetch the code under test sees THROWS after 60 calls in one test. An unbounded redirect loop (the if -> while mutant at s2l.ts:229) otherwise lives on microtasks alone, starves the timers and
  // the test timeout can never fire; with the bound it ends in a network error and the call-count assertions FAIL.
  const boundedFetch = (...a: unknown[]) => { if (fetchMock.mock.calls.length >= 60) throw new Error("test fetch bound exceeded"); return (fetchMock as (...x: unknown[]) => unknown)(...a); };
  beforeEach(() => { fetchMock.mockReset(); vi.stubGlobal("fetch", boundedFetch); process.env.APP_URL = "https://app.example.test"; });
  afterEach(() => { vi.unstubAllGlobals(); if (savedApp === undefined) delete process.env.APP_URL; else process.env.APP_URL = savedApp; });

  it("probes the fixed allow-list on the request's own origin, no credentials, no query strings; ok by route", async () => {
    fetchMock.mockImplementation(async (_u: string, init: { method: string }) => new Response(null, { status: init.method === "OPTIONS" ? 204 : 200 }));
    const out = await call("scribe_health", { aspect: "routes" }, ["read"]);
    expect(out).toMatchObject({ ok: true, origin: "https://app.example.test", checked: 5 });
    expect((out.routes as Row[]).map((r) => `${r.method} ${r.route}`)).toEqual(R.ROUTE_ALLOWLIST.map((r) => `${r.method} ${r.route}`));
    for (const r of out.routes as Row[]) expect(r).toMatchObject({ status: expect.any(Number), ms: expect.any(Number), ok: true });
    expect(out.skipped).toEqual([{ route: "/api/encounter-windows", reason: expect.stringContaining("read token") }]);
    for (const [url, init] of fetchMock.mock.calls as Array<[string, { headers: Record<string, string>; redirect: string; method: string }]>) {
      expect(url).toMatch(/^https:\/\/app\.example\.test\/api\/[a-z/-]+$/);
      expect(url).not.toContain("?");
      expect(Object.keys(init.headers).map((k) => k.toLowerCase())).toEqual(["accept"]); // no Authorization, no cookie
      expect(init.redirect).toBe("manual");
    }
    expect(fetchMock.mock.calls.some(([u]) => String(u).includes("encounter-windows"))).toBe(false);
  });

  it("a failing route, a wrong status for an OPTIONS, a timeout and a network error are reported by code; the answer is ok:false", async () => {
    fetchMock.mockImplementation(async (u: string, init: { method: string }) => {
      if (u.endsWith("/api/health")) return new Response(null, { status: 503 });
      if (u.endsWith("/api/mcp")) return new Response(null, { status: 200 }); // OPTIONS must be 204
      if (u.endsWith("/api/brain/health")) throw Object.assign(new Error("slow"), { name: "TimeoutError" });
      if (u.endsWith("/api/rooms-live/now")) throw new TypeError("fetch failed https://secret.example/x?token=ABC");
      return new Response(null, { status: init.method === "OPTIONS" ? 204 : 200 });
    });
    const out = await call("scribe_health", { aspect: "routes" }, ["read"]);
    expect(out.ok).toBe(false);
    const by = Object.fromEntries((out.routes as Row[]).map((r) => [String(r.route), r]));
    expect(by["/api/health"]).toMatchObject({ status: 503, ok: false });
    expect(by["/api/mcp"]).toMatchObject({ status: 200, ok: false });
    expect(by["/api/mcp/lab"]).toMatchObject({ status: 204, ok: true });
    expect(by["/api/brain/health"]).toMatchObject({ status: null, ok: false, error: "timeout" });
    expect(by["/api/rooms-live/now"]).toMatchObject({ status: null, ok: false, error: "network" });
    expect(JSON.stringify(out)).not.toMatch(/secret\.example|ABC/);
  });

  it("each probe carries its own 5 s timeout and the whole run a 20 s one; the route list is not caller-controlled", async () => {
    expect(R.ROUTE_TIMEOUT_MS).toBe(5_000);
    expect(R.ROUTES_TOTAL_MS).toBe(20_000);
    fetchMock.mockImplementation(async () => new Response(null, { status: 200 }));
    await call("scribe_health", { aspect: "routes", route: "/api/admin/anything", url: "https://evil.example/x" }, ["read"]);
    for (const [url, init] of fetchMock.mock.calls as Array<[string, { signal: AbortSignal }]>) {
      expect(url).not.toContain("evil.example");
      expect(url).not.toContain("admin");
      expect(init.signal).toBeInstanceOf(AbortSignal);
    }
  });

  it("S8A8 G69 — APP_URL on the APEX is probed on www (APP_URL unchanged); exactly ONE same-site redirect is followed; another site, another path or a second hop is reported as the redirect", async () => {
    process.env.APP_URL = "https://evenscribe.app";
    fetchMock.mockImplementation(async (u: string, init: { method: string }) => {
      if (u.startsWith("https://evenscribe.app/")) return new Response(null, { status: 307, headers: { location: u.replace("https://evenscribe.app", "https://www.evenscribe.app") } });
      return new Response(null, { status: init.method === "OPTIONS" ? 204 : 200 });
    });
    const t = S.CALLABLE_TOOLS.get("scribe_health_routes")!;
    let out = await t.handler({}, { actor: "a", scopes: new Set(["read"]) } as never) as Row;
    expect(out).toMatchObject({ ok: true, origin: "https://www.evenscribe.app" });
    expect(fetchMock.mock.calls.every(([u]) => String(u).startsWith("https://www.evenscribe.app/"))).toBe(true); // the apex is never even asked
    expect(process.env.APP_URL).toBe("https://evenscribe.app"); // not changed
    // a configured non-apex origin that redirects once, same site: followed once
    process.env.APP_URL = "https://app.example.test";
    fetchMock.mockReset();
    fetchMock.mockImplementation(async (u: string, init: { method: string }) => {
      if (u.startsWith("https://app.example.test/")) return new Response(null, { status: 307, headers: { location: u.replace("://app.", "://www.app.") } });
      return new Response(null, { status: init.method === "OPTIONS" ? 204 : 200 });
    });
    out = await t.handler({}, { actor: "a", scopes: new Set(["read"]) } as never) as Row;
    expect(out.ok).toBe(true);
    expect((out.routes as Row[]).every((r) => r.redirected === true)).toBe(true);
    expect(fetchMock.mock.calls.length).toBe(10); // 5 routes x (the redirect + the one follow)
    // not followed: another site, another path, a second hop (the redirect is reported as the status it is, ok:false)
    for (const loc of ["https://evil.example/api/health", "https://app.example.test/other", "https://app.example.test/api/health?x=1", "https://app.example.test:8443/api/health"]) { // T3: a port change is not followed either
      fetchMock.mockReset();
      fetchMock.mockImplementation(async () => new Response(null, { status: 307, headers: { location: loc } }));
      out = await t.handler({}, { actor: "a", scopes: new Set(["read"]) } as never) as Row;
      expect(out.ok, loc).toBe(false);
      expect(fetchMock.mock.calls.length, loc).toBe(5); // never followed
    }
    fetchMock.mockReset();
    fetchMock.mockImplementation(async (u: string) => new Response(null, { status: 307, headers: { location: u.replace("://app.", "://www.app.").replace("://www.www.", "://www.") } }));
    out = await t.handler({}, { actor: "a", scopes: new Set(["read"]) } as never) as Row;
    expect(out.ok).toBe(false); // the redirect never ends in 200: ONE hop was followed, the second 307 is the answer
    expect(fetchMock.mock.calls.length).toBe(10);
    expect((out.routes as Row[]).every((r) => r.status === 307)).toBe(true);
  }, 15_000); // an unbounded-redirect mutant must FAIL here, not hang

  it("S8A8 G76 / G77 — only https redirects are followed (an http APP_URL and an http same-site Location is NOT followed); an apex APP_URL with a port keeps the port on www", async () => {
    const t = S.CALLABLE_TOOLS.get("scribe_health_routes")!;
    const ctx = { actor: "a", scopes: new Set(["read"]) } as never;
    process.env.APP_URL = "http://app.example.test";
    fetchMock.mockImplementation(async (u: string) => new Response(null, { status: 307, headers: { location: u.replace("http://app.", "http://www.app.") } }));
    const out = await t.handler({}, ctx) as Row;
    expect(out.ok).toBe(false);
    expect(fetchMock.mock.calls.length).toBe(5); // never followed: 5 routes, 1 request each
    expect((out.routes as Row[]).every((r) => r.status === 307 && r.redirected === undefined)).toBe(true);
    expect(R.sameSiteTarget(new URL("http://a.example.test/x"), "http://www.a.example.test/x")).toBeNull();
    expect(R.sameSiteTarget(new URL("https://a.example.test/x"), "https://www.a.example.test/x")?.href).toBe("https://www.a.example.test/x");
    // G77: the apex with a port
    fetchMock.mockReset();
    fetchMock.mockImplementation(async (_u: string, init: { method: string }) => new Response(null, { status: init.method === "OPTIONS" ? 204 : 200 }));
    process.env.APP_URL = "https://evenscribe.app:8443";
    expect(R.probeOrigin()!.origin).toBe("https://www.evenscribe.app:8443");
    process.env.APP_URL = "https://evenscribe.app";
    expect(R.probeOrigin()!.origin).toBe("https://www.evenscribe.app");
    // REL2: an http apex is still probed on https://www (never http://www), with or without a port
    process.env.APP_URL = "http://evenscribe.app";
    expect(R.probeOrigin()!.origin).toBe("https://www.evenscribe.app");
    process.env.APP_URL = "http://evenscribe.app:8080";
    expect(R.probeOrigin()!.origin).toBe("https://www.evenscribe.app:8080");
    process.env.APP_URL = "https://evenscribe.app:8443";
    const ok = await t.handler({}, ctx) as Row;
    expect(ok.origin).toBe("https://www.evenscribe.app:8443");
    expect(fetchMock.mock.calls.every(([u]) => String(u).startsWith("https://www.evenscribe.app:8443/"))).toBe(true);
  }, 15_000);

  it("G19: the origin is configuration (APP_URL, else the production constant) — NEVER the request's own origin / Host", async () => {
    fetchMock.mockImplementation(async () => new Response(null, { status: 200 }));
    const t = S.CALLABLE_TOOLS.get("scribe_health_routes")!;
    // a hostile request origin (what a spoofed Host / X-Forwarded-Host would produce) is ignored
    const out = await t.handler({}, { origin: "https://evil.example", actor: "a", scopes: new Set(["read"]) } as never) as Row;
    expect(out.origin).toBe("https://app.example.test");
    for (const [url] of fetchMock.mock.calls as Array<[string]>) { expect(url.startsWith("https://app.example.test/")).toBe(true); expect(url).not.toContain("evil"); }
    // APP_URL with a path / query / credentials keeps only its origin
    process.env.APP_URL = "https://user:pw@app.example.test/some/path?x=1";
    expect(R.publicOrigin()!.href).toBe("https://app.example.test/");
    // unset -> the production constant
    delete process.env.APP_URL;
    expect(R.publicOrigin()!.origin).toBe(R.PUBLIC_ORIGIN_DEFAULT);
    expect(R.PUBLIC_ORIGIN_DEFAULT).toBe("https://www.evenscribe.app");
    expect(R.PUBLIC_ORIGIN_DEFAULT).not.toBe("https://evenscribe.app"); // G50: the apex answers 307 and the probe would read the redirect, not the route
    fetchMock.mockClear();
    await t.handler({}, { origin: "https://evil.example", actor: "a", scopes: new Set(["read"]) } as never);
    for (const [url] of fetchMock.mock.calls as Array<[string]>) expect(url.startsWith("https://www.evenscribe.app/")).toBe(true);
    // the handler does not even read ctx.origin: a context with none still works
    fetchMock.mockClear();
    expect(await t.handler({}, { actor: "a", scopes: new Set(["read"]) } as never)).toMatchObject({ origin: "https://www.evenscribe.app", checked: 5 });
  });

  it("an APP_URL that is not an http(s) URL -> a named error and no fetch", async () => {
    const t = S.CALLABLE_TOOLS.get("scribe_health_routes")!;
    process.env.APP_URL = "ftp://x";
    expect(await t.handler({}, { origin: "https://app.example.test", actor: "a", scopes: new Set(["read"]) } as never)).toEqual({ ok: false, error: "no_origin" });
    process.env.APP_URL = "not a url";
    expect(await t.handler({}, { origin: "https://app.example.test", actor: "a", scopes: new Set(["read"]) } as never)).toEqual({ ok: false, error: "no_origin" });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

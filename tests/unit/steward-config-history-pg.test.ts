/**
 * tests/unit/steward-config-history-pg.test.ts — REQUIRED PROOF for migration 0136 and lib/steward/write.ts against a real postgres:16
 * (tests/support/s1-pg.ts: every value a bound parameter sent as an untyped string, as the Neon HTTP driver sends it).
 *   1. 0136 survives the app's splitSql, applies twice (and as raw psql), registers itself, creates its indexes, grants and creates no role.
 *   2. Every command kind against the REAL seeded steward_config (0128): the config and the history row land in ONE statement; the new config parses
 *      through the Steward's own parseConfig with no new invalid key; the revert undoes the change exactly.
 *   3. The kill switch: ON blocks everything except kill_switch and note; turning it OFF needs a reason; the SQL itself refuses a write when the
 *      switch is ON even if the plan was made while it was OFF (the race), and writes NOTHING (no history row either).
 *   4. Compare-and-set: a value changed between the read and the write is not overwritten; the command re-reads and retries.
 */
import { describe, it, expect, vi, beforeAll } from "vitest";
import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import ts from "typescript";
import { dockerAvailable, pgContainer } from "../support/s1-pg";
import { parseConfig, actionMode } from "@/lib/steward/config";
import { runCommand, planCommand, COMMAND_KINDS, type CommandKind } from "@/lib/steward/write";

const HAVE_DOCKER = dockerAvailable();
const ALLOW_SKIP = process.env.ETA_ALLOW_SKIP_E2E === "1";
const pg = pgContainer("eta-steward-history-0136");
const read = (f: string) => readFileSync(`db/migrations/${f}`, "utf8");

function loadSplitSql(): (body: string) => string[] {
  const src = readFileSync("app/api/run-migrations/route.ts", "utf8");
  const start = src.indexOf("function splitSql(");
  const end = src.indexOf("export async function POST");
  expect(start).toBeGreaterThan(0);
  const js = ts.transpileModule(src.slice(start, end), { compilerOptions: { target: ts.ScriptTarget.ES2020 } }).outputText;
  return new Function(`${js}\nreturn splitSql;`)() as (body: string) => string[];
}
function psql(text: string): string {
  try {
    return execFileSync("docker", ["exec", "-i", pg.name, "psql", "-qAt", "-v", "ON_ERROR_STOP=1", "-U", "postgres", "-d", "postgres"],
      { input: text, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] }).trim();
  } catch (e) {
    throw new Error(String((e as { stderr?: unknown }).stderr ?? e));
  }
}
const fails = (text: string) => { try { psql(text); return ""; } catch (e) { return (e as Error).message; } };
const cfgRows = () => (JSON.parse(psql(`SELECT coalesce(json_agg(json_build_object('key', key, 'value', value)), '[]') FROM steward_config;`)) as Array<{ key: string; value: unknown }>);
const hist = () => (JSON.parse(psql(`SELECT coalesce(json_agg(h ORDER BY created_at, id), '[]') FROM (SELECT * FROM steward_config_history) h;`)) as Array<Record<string, unknown>>);
const val = (key: string): unknown => cfgRows().find((r) => r.key === key)?.value;
const run = (kind: CommandKind, extra: Record<string, unknown> = {}) =>
  runCommand(pg.sql as never, { kind, value: undefined, minutes: null, roomId: null, nowMs: Date.parse("2026-10-08T12:00:00Z"), actor: "mcp:tester", reason: "pg test", ...extra } as never);

const PUBLISHED = ["scribe_start", "ticket:wake", "ticket:open_pulse", "ticket:relaunch_chrome", "ticket:policy_cycle", "ticket:restart_recorder_app", "ticket:restart_kiosk_health", "message"];
const HELD_EXCEPT_START = Object.fromEntries(PUBLISHED.map((a) => [a, a !== "scribe_start"]));

describe("REQUIRED PROOF — 0136 against a real postgres", () => {
  it("ran, or was skipped deliberately", () => {
    if (HAVE_DOCKER || ALLOW_SKIP) return;
    throw new Error("REQUIRED PROOF NOT RUN: tests/unit/steward-config-history-pg.test.ts needs Docker for postgres:16. Start Docker, or set ETA_ALLOW_SKIP_E2E=1.");
  });
});

describe.skipIf(!HAVE_DOCKER)("0136 steward_config_history and lib/steward/write.ts over real postgres", () => {
  beforeAll(() => {
    pg.start();
    vi.spyOn(console, "warn").mockImplementation(() => {});
  }, 240_000);

  it("applies through splitSql twice and as raw psql; registers itself; indexes; no grant, no role", () => {
    pg.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW())`);
    pg.exec(read("0128_room_steward.sql")); // the real steward_config, seeded: kill switch ON
    const split = loadSplitSql();
    const stmts = split(read("0136_steward_config_history.sql"));
    expect(stmts.length).toBeGreaterThanOrEqual(6);
    for (let pass = 0; pass < 2; pass += 1) psql(`BEGIN;\n${stmts.map((s) => `${s};`).join("\n")}\nCOMMIT;`);
    pg.exec(read("0136_steward_config_history.sql"));
    expect(psql(`SELECT version || ':' || name FROM schema_migrations WHERE version = 136;`)).toBe("136:0136_steward_config_history");
    expect(psql(`SELECT count(*) FROM schema_migrations WHERE version = 136;`)).toBe("1");
    expect(psql(`SELECT indexname FROM pg_indexes WHERE tablename = 'steward_config_history' AND indexname NOT LIKE '%pkey' ORDER BY indexname;`).split("\n")).toEqual([
      "steward_config_history_created_idx", "steward_config_history_key_idx", "steward_config_history_room_idx",
    ]);
    expect(read("0136_steward_config_history.sql")).not.toMatch(/^\s*(GRANT|CREATE ROLE)\b|PASSWORD\s+'/im);
    expect(psql(`SELECT count(*) FROM information_schema.role_table_grants WHERE table_name = 'steward_config_history' AND grantee NOT IN ('postgres');`)).toBe("0");
    // CHECKs: reason 1..280, via 'mcp' only, after NOT NULL
    const ins = (reason: string, via = "mcp", after = "'{}'") => `INSERT INTO steward_config_history (id, key, after, actor, reason, via) VALUES ('x${Math.random()}', 'k', ${after}, 'a', '${reason}', '${via}');`;
    expect(fails(ins(""))).toMatch(/violates check constraint/);
    expect(fails(ins("r".repeat(281)))).toMatch(/violates check constraint/);
    expect(fails(ins("ok", "cron"))).toMatch(/violates check constraint/);
    expect(fails(ins("ok", "mcp", "NULL"))).toMatch(/not-null/);
    psql(ins("fine"));
    psql(`DELETE FROM steward_config_history;`);
  }, 240_000);

  it("the seed: kill switch ON, so every kind but note and kill_switch is refused and NOTHING is written", async () => {
    expect(val("kill_switch")).toEqual({ on: true });
    for (const [kind, value, roomId] of [
      ["set_shadow", { global: false, actions: { message: false } }, null], ["start_day_live", { on: true }, null], ["add_room", {}, "room_new"],
      ["flag_room", { add: ["dev"] }, "room_jwyrr4dc"], ["set_window", { profile: "clinic", start: "08:00", end: "20:00" }, null],
    ] as Array<[CommandKind, unknown, string | null]>) {
      expect(await run(kind, { value, roomId }), kind).toMatchObject({ ok: false, error: "kill_switch_on" });
    }
    expect(await run("mute_alerts", { minutes: 30 })).toMatchObject({ ok: false, error: "kill_switch_on" });
    expect(hist()).toEqual([]);
    expect(val("shadow")).toEqual({ global: true, actions: {} });
  });

  it("note works while the switch is ON, and is logged", async () => {
    const r = await run("note", { value: "kiosk 3 cable replaced", roomId: "room_yh3etjpf" });
    expect(r).toMatchObject({ ok: true, kind: "note", key: "operator_note", before: null, unchanged: false });
    expect(val("operator_note")).toMatchObject({ text: "kiosk 3 cable replaced", room_id: "room_yh3etjpf", actor: "mcp:tester" });
    const h = hist();
    expect(h).toHaveLength(1);
    expect(h[0]).toMatchObject({ key: "operator_note", kind: "note", room_id: "room_yh3etjpf", actor: "mcp:tester", reason: "pg test", via: "mcp", before: null });
    expect(String(h[0]!.id)).toMatch(/^sch_/);
    expect((await run("note", { value: "kiosk 3 cable replaced", roomId: "room_yh3etjpf" })) as { unchanged?: boolean }).toMatchObject({ ok: true }); // same text but a new timestamp -> a change
  });

  it("turning the kill switch OFF needs a reason; ON is always allowed; each is logged with before / after", async () => {
    expect(await run("kill_switch", { value: { on: false }, reason: "   " })).toMatchObject({ ok: false, error: "reason_required" });
    expect(val("kill_switch")).toEqual({ on: true });
    const off = await run("kill_switch", { value: { on: false }, reason: "clinic opens; shadow-mode check done" });
    expect(off).toMatchObject({ ok: true, key: "kill_switch", before: { on: true }, after: { on: false }, revert: { kind: "kill_switch", value: { on: true }, exact: true } });
    expect(val("kill_switch")).toEqual({ on: false });
    expect(hist().at(-1)).toMatchObject({ key: "kill_switch", reason: "clinic opens; shadow-mode check done", before: { on: true }, after: { on: false } });
    // ON again is allowed whatever the state, and a no-op ON writes nothing
    const n = hist().length;
    expect(await run("kill_switch", { value: { on: false } })).toMatchObject({ ok: true, unchanged: true, history_id: null });
    expect(hist()).toHaveLength(n);
    expect(await run("kill_switch", { value: { on: true } })).toMatchObject({ ok: true, after: { on: true } });
    expect(await run("kill_switch", { value: { on: true } })).toMatchObject({ ok: true, unchanged: true });
    expect(await run("kill_switch", { value: { on: false } })).toMatchObject({ ok: true }); // back OFF for the rest
  });

  it("every command kind, switch OFF: config + history in one statement, the Steward's parseConfig still accepts the config, and the revert undoes it exactly", async () => {
    const baseline = parseConfig(cfgRows());
    expect(baseline.invalid).toEqual([]);
    const cases: Array<{ kind: CommandKind; extra: Record<string, unknown>; key: string; check: (v: any) => void }> = [
      { kind: "set_shadow", extra: { value: { global: false, actions: { scribe_start: false } } }, key: "shadow", check: (v) => expect(v).toEqual({ global: false, actions: HELD_EXCEPT_START }) },
      { kind: "start_day_live", extra: { value: { on: true } }, key: "start_day_live", check: (v) => expect(v).toEqual({ on: true }) },
      { kind: "add_room", extra: { roomId: "room_aaaa1111", value: { class: "opd", flags: ["pilot"], machine: "mac-9" } }, key: "rooms", check: (v) => expect(v.room_aaaa1111).toEqual({ flags: ["pilot"], class: "opd", machine: "mac-9" }) },
      { kind: "flag_room", extra: { roomId: "room_aaaa1111", value: { add: ["dev"], remove: ["pilot"] } }, key: "rooms", check: (v) => expect(v.room_aaaa1111.flags).toEqual(["dev"]) },
      { kind: "set_window", extra: { value: { profile: "clinic", start: "08:00", end: "20:30", late_stop_max_min: 45 } }, key: "schedule", check: (v) => expect(v.clinic).toEqual({ start: "08:00", end: "20:30", tz: "Asia/Kolkata", late_stop_max_min: 45 }) },
      { kind: "mute_alerts", extra: { minutes: 60, roomId: "room_aaaa1111" }, key: "alert_mutes", check: (v) => expect(Date.parse(v.rooms.room_aaaa1111.until)).toBe(Date.parse("2026-10-08T13:00:00Z")) },
    ];
    for (const c of cases) {
      const before = val(c.key);
      const r = await run(c.kind, c.extra) as Extract<Awaited<ReturnType<typeof run>>, { ok: true }>;
      expect(r.ok, c.kind).toBe(true);
      c.check(val(c.key));
      const parsed = parseConfig(cfgRows());
      expect(parsed.invalid, `${c.kind} left an invalid key`).toEqual([]);
      expect(parsed.fatal).toEqual([]);
      const h = hist().at(-1)!;
      expect(h, c.kind).toMatchObject({ key: c.key, kind: c.kind, actor: "mcp:tester", reason: "pg test", via: "mcp" });
      expect(h.after).toEqual(val(c.key));
      expect(h.before ?? null).toEqual(before ?? null);
      // the revert, run as a command, restores the previous value (add_room's is flag_room dev: exact false)
      if (r.revert.exact) {
        const rv = await run(r.revert.kind, { value: r.revert.value, roomId: r.revert.room ?? null, minutes: r.revert.minutes ?? null });
        expect(rv.ok, `revert of ${c.kind}`).toBe(true);
        if (c.kind === "mute_alerts") expect((val(c.key) as { rooms: Record<string, unknown> }).rooms.room_aaaa1111).toBeUndefined();
        // the row was absent before: its revert writes the explicit equivalent ({on:false}, which parseConfig reads exactly as "absent")
        else if (c.kind === "start_day_live") expect(val(c.key)).toEqual({ on: false });
        else expect(val(c.key) ?? null, `revert of ${c.kind}`).toEqual(before ?? null);
      }
    }
    expect(parseConfig(cfgRows()).config.start_day_live).toBe(false); // the revert switched it back
  });

  it("SF1 from the seed shadow {global:true, actions:{}}: {global:false} and {global:false, actions:{}} are REFUSED; {global:false, actions:{message:false}} makes exactly message live (by the Steward's own actionMode); the revert round-trips", async () => {
    expect(val("shadow")).toEqual({ global: true, actions: {} });
    const n = hist().length;
    for (const value of [{ global: false }, { global: false, actions: {} }]) {
      expect(await run("set_shadow", { value }), JSON.stringify(value)).toMatchObject({ ok: false, error: "explicit_actions_required" });
    }
    expect(val("shadow")).toEqual({ global: true, actions: {} });
    expect(hist()).toHaveLength(n); // nothing written, no history row
    const liveNow = () => { const c = parseConfig(cfgRows()).config; return PUBLISHED.filter((a) => actionMode(c, a) === "live"); };
    expect(liveNow()).toEqual([]);
    const r = await run("set_shadow", { value: { global: false, actions: { message: false } } }) as Extract<Awaited<ReturnType<typeof run>>, { ok: true }> & { live_actions: string[]; changed_actions: string[] };
    expect(r).toMatchObject({ ok: true, live_actions: ["message"], changed_actions: ["message"] });
    expect(val("shadow")).toEqual({ global: false, actions: Object.fromEntries(PUBLISHED.map((a) => [a, a !== "message"])) });
    expect(liveNow()).toEqual(["message"]); // the Steward itself agrees: exactly message
    // the revert, replayed as a command, restores the seed exactly
    const rv = await run("set_shadow", { value: r.revert.value });
    expect(rv).toMatchObject({ ok: true, live_actions: [] });
    expect(val("shadow")).toEqual({ global: true, actions: {} });
    expect(liveNow()).toEqual([]);
    // going live with scribe_start named: still only that one
    const s2 = await run("set_shadow", { value: { global: false, actions: { scribe_start: false } } });
    expect(s2).toMatchObject({ ok: true, live_actions: ["scribe_start"] });
    // an actions-only change under global:false touches only the named action, and its revert (which carries an explicit map) is accepted
    const s3 = await run("set_shadow", { value: { actions: { message: false } } }) as Extract<Awaited<ReturnType<typeof run>>, { ok: true }>;
    expect(s3).toMatchObject({ ok: true, changed_actions: ["message"] });
    expect(liveNow()).toEqual(["message"]); // scribe_start is in live_actions (shadow config) but the Steward also needs start_day_live, which is off here
    expect(await run("set_shadow", { value: { actions: { message: true } } })).toMatchObject({ ok: true, live_actions: ["scribe_start"] });
    const back = await run("set_shadow", { value: { global: true, actions: Object.fromEntries(PUBLISHED.map((a) => [a, null])) } });
    expect(back).toMatchObject({ ok: true, live_actions: [] });
    expect(val("shadow")).toEqual({ global: true, actions: {} });
  });

  it("G35 while global is already false: null on a published action means HELD, never live; only false takes one live; the revert round-trips", async () => {
    expect(val("shadow")).toEqual({ global: true, actions: {} });
    await run("set_shadow", { value: { global: false, actions: { message: false } } });
    const liveNow = () => { const c = parseConfig(cfgRows()).config; return PUBLISHED.filter((a) => actionMode(c, a) === "live"); };
    expect(liveNow()).toEqual(["message"]);
    // null on a held published key: stays held (the old behaviour deleted the key, and an absent key is live)
    const a = await run("set_shadow", { value: { actions: { "ticket:policy_cycle": null } } }) as Extract<Awaited<ReturnType<typeof run>>, { ok: true }> & { live_actions: string[] };
    expect(a).toMatchObject({ ok: true, live_actions: ["message"], unchanged: true });
    expect((val("shadow") as { actions: Record<string, boolean> }).actions["ticket:policy_cycle"]).toBe(true);
    expect(liveNow()).toEqual(["message"]);
    // null on the LIVE action: back to held, nothing is live
    const b = await run("set_shadow", { value: { actions: { message: null } } }) as Extract<Awaited<ReturnType<typeof run>>, { ok: true }> & { live_actions: string[] };
    expect(b).toMatchObject({ ok: true, live_actions: [], changed_actions: ["message"] });
    expect((val("shadow") as { actions: Record<string, boolean> }).actions.message).toBe(true);
    expect(liveNow()).toEqual([]);
    // the revert of b round-trips to message live
    const rv = await run("set_shadow", { value: b.revert.value });
    expect(rv).toMatchObject({ ok: true, live_actions: ["message"] });
    expect(liveNow()).toEqual(["message"]);
    // back to the seed
    expect(await run("set_shadow", { value: { global: true, actions: Object.fromEntries(PUBLISHED.map((x) => [x, null])) } })).toMatchObject({ ok: true, live_actions: [] });
    expect(val("shadow")).toEqual({ global: true, actions: {} });
  });

  it("the SQL refuses a write when the kill switch is ON even if the plan was made while it was OFF (the race), and writes NOTHING", async () => {
    // plan against a state where the switch is OFF, apply after it flipped ON: do exactly what runCommand's statement does
    psql(`UPDATE steward_config SET value = '{"on":true}'::jsonb WHERE key = 'kill_switch';`);
    const nHist = hist().length;
    const before = JSON.stringify(val("days"));
    const out = (await pg.sql`
      WITH k AS (SELECT value FROM steward_config WHERE key = 'kill_switch'),
      upd AS (
        INSERT INTO steward_config (key, value, updated_by)
        SELECT ${"days"}::text, ${JSON.stringify({ mode: "every_day", closed: ["2026-10-10"] })}::jsonb, ${"mcp:x"}::text
         WHERE (NOT ${true}::boolean OR EXISTS (SELECT 1 FROM k WHERE k.value->>'on' = 'false'))
        ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value WHERE steward_config.value IS NOT DISTINCT FROM ${before}::jsonb
        RETURNING key
      ),
      hist AS (INSERT INTO steward_config_history (id, key, after, actor, reason) SELECT 'sch_race', 'days', '{}'::jsonb, 'a', 'r' FROM upd RETURNING id)
      SELECT (SELECT count(*) FROM upd)::int AS applied, (SELECT count(*) FROM hist)::int AS logged` ) as Array<{ applied: number; logged: number }>;
    expect(out[0]).toMatchObject({ applied: 0, logged: 0 });
    expect(JSON.stringify(val("days"))).toBe(before);
    expect(hist()).toHaveLength(nHist);
    // and through the helper: the next read sees the switch ON and refuses by name
    expect(await run("set_window", { value: { profile: "ot", start: "06:00", end: "04:00" } })).toMatchObject({ ok: false, error: "kill_switch_on" });
    psql(`UPDATE steward_config SET value = '{"on":false}'::jsonb WHERE key = 'kill_switch';`);
  });

  it("compare-and-set: a value changed between the read and the write is not overwritten; the command re-reads and retries", async () => {
    // start from global:false so the command below is a real change; wrap the sql so the FIRST write statement sees a concurrent change land just before it
    psql(`UPDATE steward_config SET value = '{"global":false,"actions":{}}'::jsonb WHERE key = 'shadow';`);
    let injected = false;
    const racing = (async (s: TemplateStringsArray, ...v: unknown[]) => {
      if (!injected && /INSERT INTO steward_config/.test(s.join("?"))) {
        injected = true;
        psql(`UPDATE steward_config SET value = '{"global":false,"actions":{"ticket:wake":false}}'::jsonb WHERE key = 'shadow';`);
      }
      return pg.sql(s, ...v);
    }) as never;
    const r = await runCommand(racing, { kind: "set_shadow", value: { global: true }, minutes: null, roomId: null, nowMs: 0, actor: "mcp:tester", reason: "race" });
    expect(r).toMatchObject({ ok: true, key: "shadow" });
    // the other writer's actions survived (set_shadow without `actions` keeps the map as it NOW is), only global changed
    expect(val("shadow")).toEqual({ global: true, actions: { "ticket:wake": false } });
    expect(hist().at(-1)).toMatchObject({ reason: "race", before: { global: false, actions: { "ticket:wake": false } } });
    // a writer that keeps losing gives up by name and writes nothing
    const always = (async (s: TemplateStringsArray, ...v: unknown[]) => {
      if (/INSERT INTO steward_config/.test(s.join("?"))) psql(`UPDATE steward_config SET value = jsonb_set(value, '{global}', to_jsonb(NOT (value->>'global')::boolean)) WHERE key = 'shadow';`);
      return pg.sql(s, ...v);
    }) as never;
    const n = hist().length;
    expect(await runCommand(always, { kind: "set_shadow", value: { actions: { "ticket:wake": true } }, minutes: null, roomId: null, nowMs: 0, actor: "mcp:tester", reason: "lose" })).toMatchObject({ ok: false, error: "config_changed_concurrently" });
    expect(hist()).toHaveLength(n);
  });

  it("add_room on a room already in the roster, flag_room on an unknown one, a bad window: refused by name, nothing written", async () => {
    const n = hist().length;
    expect(await run("add_room", { roomId: "room_jwyrr4dc", value: {} })).toMatchObject({ ok: false, error: "room_exists" });
    expect(await run("flag_room", { roomId: "room_zzzz9999", value: { add: ["x"] } })).toMatchObject({ ok: false, error: "room_not_in_config" });
    expect(await run("set_window", { value: { profile: "clinic", start: "25:00", end: "20:00" } })).toMatchObject({ ok: false, error: "bad_value" });
    expect(await run("mute_alerts", { minutes: 3 })).toMatchObject({ ok: false, error: "bad_minutes" });
    expect(await run("mute_alerts", { minutes: 721 })).toMatchObject({ ok: false, error: "bad_minutes" });
    expect(hist()).toHaveLength(n);
  });

  it("every kind is covered by the proof above", () => {
    expect([...COMMAND_KINDS].sort()).toEqual(["add_room", "flag_room", "kill_switch", "mute_alerts", "note", "set_shadow", "set_window", "start_day_live"]);
    expect(typeof planCommand).toBe("function");
  });
});

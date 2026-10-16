/**
 * buddy-relay-pg.test.ts — Encounter Buddy relay C7: the REAL open CTE (ref row + consult_started command in one statement) on postgres:16 with every migration (0166 included).
 * newcat (decide) is an injected fake: no network, no key. All ids are synthetic. DOCKER: CI host only.
 *
 *   1. window:true lands both rows;
 *   2. a fault on the command insert rolls the ref row back: neither lands, and a retry lands both;
 *   3. concurrent opens for one consult give exactly one ref row and one command;
 *   4. window:false and a decide fault write nothing;
 *   5. consult_ended updates the ref and enqueues one command, and a second close enqueues none;
 *   6. shadow (window:false, live:true): on an ACTIVE install at 0.1.43 one ref row and one command with args exactly {opaque_id, window:false, live:true} (JSON booleans);
 *      on 0.1.42 nothing lands; consult_ended after a shadow open lands its command.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { dockerAvailable, pgContainer } from "../support/s1-pg";

const H = vi.hoisted(() => ({
  sql: (async () => []) as unknown as (s: TemplateStringsArray, ...v: unknown[]) => Promise<unknown[]>,
}));
vi.mock("@/lib/db", () => ({ sql: (s: TemplateStringsArray, ...v: unknown[]) => H.sql(s, ...v) }));
vi.setConfig({ testTimeout: 180_000, hookTimeout: 300_000 });

const HAVE = dockerAvailable();
const pg = pgContainer("eta-buddy-relay");
type Row = Record<string, any>;
const q = async <T = Row>(strings: TemplateStringsArray, ...v: unknown[]) => (await pg.sql(strings, ...v)) as T[];

const R = await import("@/lib/buddy/relay");

const ROOM = "room_bpg1";
const UID = "bpg-consult-1";
const row = (event: "encounter_open" | "encounter_close", uid = UID) =>
  ({ source: "ext" as const, machine: "MAC-BPG-1", room: null, event, ts: new Date().toISOString(), email: null, payload: { encounter_id: uid } });
const yes = async () => true;
const shadow = async () => ({ window: false, live: true });
const ROOM43 = "room_bpg43";
const ROOM42 = "room_bpg42";
const row2 = (event: "encounter_open" | "encounter_close", machine: string, uid: string) =>
  ({ source: "ext" as const, machine, room: null, event, ts: new Date().toISOString(), email: null, payload: { encounter_id: uid } });

beforeAll(() => {
  if (!HAVE) return;
  pg.start();
  for (const f of readdirSync("db/migrations").filter((x) => x.endsWith(".sql")).sort()) pg.exec(readFileSync(`db/migrations/${f}`, "utf8"));
  H.sql = pg.sql as never;
  pg.exec(`
    INSERT INTO room (id, slug, name, pin_hash, transcript_enabled) VALUES ('${ROOM}', 'bpg-1', 'BPG Room', 'x', TRUE);
    INSERT INTO room_install (install_id, room_id, enrolled_at, enrolled_by, hostname, app_version) VALUES ('inst_bpg1', '${ROOM}', now(), 'test', 'MAC-BPG-1', '0.1.30');
    INSERT INTO room (id, slug, name, pin_hash, transcript_enabled) VALUES ('${ROOM43}', 'bpg-43', 'BPG Room 43', 'x', TRUE), ('${ROOM42}', 'bpg-42', 'BPG Room 42', 'x', TRUE);
    INSERT INTO room_install (install_id, room_id, enrolled_at, enrolled_by, hostname, app_version) VALUES
      ('inst_bpg43', '${ROOM43}', now(), 'test', 'MAC-BPG-43', '0.1.43'),
      ('inst_bpg42', '${ROOM42}', now(), 'test', 'MAC-BPG-42', '0.1.42');
  `);
  process.env.BUDDY_RELAY_ROOMS = [ROOM, ROOM43, ROOM42].join(",");
}, 300_000);
afterAll(() => { if (HAVE) pg.stop(); delete process.env.BUDDY_RELAY_ROOMS; });
beforeEach(() => {
  if (!HAVE) return;
  pg.exec(`DELETE FROM bench_command WHERE kind IN ('consult_started','consult_ended'); DELETE FROM buddy_consult_ref; DROP TRIGGER IF EXISTS bpg_fail ON bench_command;`);
});

const counts = async () => ({
  refs: (await q<{ n: number }>`SELECT count(*)::int AS n FROM buddy_consult_ref`)[0]!.n,
  started: (await q<{ n: number }>`SELECT count(*)::int AS n FROM bench_command WHERE kind = 'consult_started'`)[0]!.n,
  ended: (await q<{ n: number }>`SELECT count(*)::int AS n FROM bench_command WHERE kind = 'consult_ended'`)[0]!.n,
});

describe.skipIf(!HAVE)("relay CTE on real postgres", () => {
  it("window:true lands the ref row and the command, and the args are {opaque_id, window, live}", async () => {
    expect(await R.relayConsultEvent(row("encounter_open") as never, Date.now() + 5000, yes)).toBe("sent");
    expect(await counts()).toEqual({ refs: 1, started: 1, ended: 0 });
    const c = (await q<{ args: Record<string, unknown>; source: string; room_id: string }>`SELECT args, source, room_id FROM bench_command WHERE kind = 'consult_started'`)[0]!;
    const r = (await q<{ opaque_id: string }>`SELECT opaque_id FROM buddy_consult_ref`)[0]!;
    expect(c.args).toEqual({ opaque_id: r.opaque_id, window: true, live: false });
    expect(c).toMatchObject({ source: "buddy", room_id: ROOM });
  });

  it("both rows land, or neither: a failing command insert rolls the ref row back, and a retry lands both", async () => {
    pg.exec(`
      CREATE OR REPLACE FUNCTION bpg_fail_fn() RETURNS trigger AS $$ BEGIN RAISE EXCEPTION 'bpg forced fault'; END $$ LANGUAGE plpgsql;
      CREATE TRIGGER bpg_fail BEFORE INSERT ON bench_command FOR EACH ROW EXECUTE FUNCTION bpg_fail_fn();
    `);
    await expect(R.relayConsultEvent(row("encounter_open") as never, Date.now() + 5000, yes)).rejects.toThrow();
    expect(await counts()).toEqual({ refs: 0, started: 0, ended: 0 });
    pg.exec(`DROP TRIGGER bpg_fail ON bench_command;`);
    expect(await R.relayConsultEvent(row("encounter_open") as never, Date.now() + 5000, yes)).toBe("sent");
    expect(await counts()).toEqual({ refs: 1, started: 1, ended: 0 });
  });

  it("concurrent opens for one consult give one ref row and one command", async () => {
    const out = await Promise.all(Array.from({ length: 6 }, () => R.relayConsultEvent(row("encounter_open") as never, Date.now() + 20_000, yes)));
    expect(out.filter((o) => o === "sent")).toHaveLength(1);
    expect(out.filter((o) => o === "duplicate")).toHaveLength(5);
    expect(await counts()).toEqual({ refs: 1, started: 1, ended: 0 });
  });

  it("window:false and a decide fault write nothing", async () => {
    expect(await R.relayConsultEvent(row("encounter_open") as never, Date.now() + 5000, async () => false)).toBe("decide_false");
    expect(await R.relayConsultEvent(row("encounter_open") as never, Date.now() + 5000, async () => { throw new Error("down"); })).toBe("decide_fault");
    expect(await counts()).toEqual({ refs: 0, started: 0, ended: 0 });
  });

  it("close: one consult_ended for an open ref, none for a second close, none without a ref", async () => {
    expect(await R.relayConsultEvent(row("encounter_close", "bpg-no-ref") as never, Date.now() + 5000, yes)).toBe("duplicate");
    await R.relayConsultEvent(row("encounter_open") as never, Date.now() + 5000, yes);
    expect(await R.relayConsultEvent(row("encounter_close") as never, Date.now() + 5000, yes)).toBe("sent");
    expect(await R.relayConsultEvent(row("encounter_close") as never, Date.now() + 5000, yes)).toBe("duplicate");
    expect(await counts()).toEqual({ refs: 1, started: 1, ended: 1 });
    expect((await q<{ closed: boolean }>`SELECT closed_at IS NOT NULL AS closed FROM buddy_consult_ref`)[0]!.closed).toBe(true);
  });

  it("shadow (window:false, live:true) on an ACTIVE 0.1.43 install lands one ref row and one command, args exactly {opaque_id, window:false, live:true} as JSON booleans", async () => {
    expect(await R.relayConsultEvent(row2("encounter_open", "MAC-BPG-43", "bpg-shadow-43") as never, Date.now() + 5000, shadow)).toBe("sent");
    expect(await counts()).toEqual({ refs: 1, started: 1, ended: 0 });
    const c = (await q<{ args: Record<string, unknown>; room_id: string; w: string; l: string; keys: string[] }>`
      SELECT args, room_id, jsonb_typeof(args->'window') AS w, jsonb_typeof(args->'live') AS l, ARRAY(SELECT jsonb_object_keys(args) ORDER BY 1) AS keys
        FROM bench_command WHERE kind = 'consult_started'`)[0]!;
    const r = (await q<{ opaque_id: string }>`SELECT opaque_id FROM buddy_consult_ref`)[0]!;
    expect(c.args).toEqual({ opaque_id: r.opaque_id, window: false, live: true });
    expect(c.keys).toEqual(["live", "opaque_id", "window"]);
    expect([c.w, c.l]).toEqual(["boolean", "boolean"]);
    expect(c.room_id).toBe(ROOM43);
  });

  it("shadow on a 0.1.42 install lands no ref row and no command", async () => {
    expect(await R.relayConsultEvent(row2("encounter_open", "MAC-BPG-42", "bpg-shadow-42") as never, Date.now() + 5000, shadow)).toBe("decide_false");
    expect(await counts()).toEqual({ refs: 0, started: 0, ended: 0 });
  });

  it("consult_ended after a shadow open lands its command", async () => {
    await R.relayConsultEvent(row2("encounter_open", "MAC-BPG-43", "bpg-shadow-43") as never, Date.now() + 5000, shadow);
    expect(await R.relayConsultEvent(row2("encounter_close", "MAC-BPG-43", "bpg-shadow-43") as never, Date.now() + 5000, shadow)).toBe("sent");
    expect(await counts()).toEqual({ refs: 1, started: 1, ended: 1 });
    const e = (await q<{ args: Record<string, unknown> }>`SELECT args FROM bench_command WHERE kind = 'consult_ended'`)[0]!;
    const r = (await q<{ opaque_id: string }>`SELECT opaque_id FROM buddy_consult_ref`)[0]!;
    expect(e.args).toEqual({ opaque_id: r.opaque_id });
  });
});

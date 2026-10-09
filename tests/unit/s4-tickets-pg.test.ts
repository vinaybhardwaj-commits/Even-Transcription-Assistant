/**
 * S4 on a real postgres:16 — migration 0128's real tables, fixture rows: ticket_log and ticket_summary through the IST range, the room via decision or install, filters, and no secret in the answer.
 */
import { describe, it, expect, vi, beforeAll, afterAll } from "vitest";
import { readFileSync } from "node:fs";
import { dockerAvailable, pgContainer } from "../support/s1-pg";

const H = vi.hoisted(() => ({ sql: null as null | ((s: TemplateStringsArray, ...v: unknown[]) => Promise<unknown[]>), statements: [] as string[] }));
vi.mock("@/lib/db", () => ({ sql: Object.assign((s: TemplateStringsArray, ...v: unknown[]) => { H.statements.push(s.join("?")); return H.sql!(s, ...v); }, { transaction: async () => [] }) }));
vi.setConfig({ testTimeout: 60_000, hookTimeout: 180_000 });

const HAVE = dockerAvailable();
const pg = pgContainer("eta-s4-tickets");

beforeAll(() => {
  if (!HAVE) return;
  pg.start();
  pg.exec(`
    CREATE TABLE schema_migrations (version integer PRIMARY KEY, name text, applied_at timestamptz DEFAULT now());
    CREATE TABLE room (id text PRIMARY KEY, slug text, name text, disabled_at timestamptz, created_at timestamptz DEFAULT now());
    CREATE TABLE room_install (room_id text, hostname text, retired_at timestamptz, last_seen_at timestamptz);
  `);
  pg.exec(readFileSync("db/migrations/0128_room_steward.sql", "utf8"));
  H.sql = pg.sql as never;
  pg.exec(`
    INSERT INTO room (id, slug, name) VALUES ('r1', 'opd-1', 'OPD 1'), ('r2', 'opd-2', 'OPD 2');
    INSERT INTO room_install VALUES ('r2', 'machine-b', NULL, now());
    INSERT INTO steward_decisions (id, ts, room_id, machine, rule, action, mode) VALUES (1, '2026-10-05T04:00:00Z', 'r1', 'machine-a', 'kiosk_asleep', 'ticket:wake', 'live'), (2, '2026-10-05T05:00:00Z', 'r1', 'machine-a', 'profile_unloaded', 'ticket:open_pulse', 'shadow');
    INSERT INTO steward_tickets (ticket_id, machine, action, decision_id, issued_at, expires_at, nonce, signature, status) VALUES
      ('t_in_1', 'machine-a', 'wake', 1, '2026-10-05T04:00:00Z', '2026-10-05T04:10:00Z', 'n1', 'SIGSECRET1', 'done'),
      ('t_in_2', 'machine-a', 'open_pulse', 2, '2026-10-05T05:00:00Z', '2026-10-05T05:10:00Z', 'n2', 'SIGSECRET2', 'failed'),
      ('t_install', 'machine-b', 'wake', NULL, '2026-10-06T04:00:00Z', '2026-10-06T04:10:00Z', 'n3', 'SIGSECRET3', 'expired'),
      ('t_edge_in', 'machine-c', 'relaunch_chrome', NULL, '2026-10-06T18:29:59Z', '2026-10-06T18:39:59Z', 'n4', 'SIGSECRET4', 'done'),
      ('t_edge_out', 'machine-c', 'relaunch_chrome', NULL, '2026-10-06T18:30:00Z', '2026-10-06T18:40:00Z', 'n5', 'SIGSECRET5', 'done'),
      ('t_before', 'machine-c', 'policy_cycle', NULL, '2026-09-30T18:29:59Z', '2026-09-30T18:39:59Z', 'n6', 'SIGSECRET6', 'done');
  `);
});
afterAll(() => { if (HAVE) pg.stop(); });

(HAVE ? describe : describe.skip)("S4 on real postgres", () => {
  const run = async (args: Record<string, unknown>) => {
    const { CALLABLE_TOOLS } = await import("@/lib/mcp/surface");
    return (await CALLABLE_TOOLS.get("scribe_steward")!.handler({ ...args }, { origin: "x", actor: "a", scopes: new Set(["read"]) } as never)) as Record<string, unknown>;
  };
  it("ticket_log: the IST range is [from 00:00, to+1 00:00) IST; room by the issuing decision only (R4-2); issuer rule and mode from the decision; no secret anywhere", async () => {
    const out = await run({ view: "ticket_log", from: "2026-10-01", to: "2026-10-06" });
    const t = out.tickets as Array<Record<string, unknown>>;
    expect(t.map((x) => x.ticket_id)).toEqual(["t_edge_in", "t_install", "t_in_2", "t_in_1"]);
    const by = Object.fromEntries(t.map((x) => [String(x.ticket_id), x]));
    expect(by.t_in_1).toMatchObject({ room_id: "r1", room_source: "decision", room_name: "OPD 1", issuer_rule: "kiosk_asleep", mode: "live", action: "wake", status: "done" });
    expect(by.t_in_2).toMatchObject({ mode: "shadow", status: "failed" });
    expect(by.t_install).toMatchObject({ room_id: null, room_source: "unknown", issuer_rule: null, mode: null }); // R4-2: the install's CURRENT room (r2) is NOT used
    expect(by.t_edge_in).toMatchObject({ room_id: null });
    expect(JSON.stringify(out)).not.toMatch(/SIGSECRET|"n[0-9]"|nonce|signature/);
  });
  it("filters: room (decision or install), action, status", async () => {
    expect(((await run({ view: "ticket_log", from: "2026-10-01", to: "2026-10-06", room: "opd-2" })).tickets as Array<Row>).map((x) => x.ticket_id)).toEqual([]); // t_install ran on a machine now in opd-2: not counted (R4-2)
    expect(((await run({ view: "ticket_log", from: "2026-10-01", to: "2026-10-06", room: "opd-1" })).tickets as Array<Row>).map((x) => x.ticket_id)).toEqual(["t_in_2", "t_in_1"]);
    expect(((await run({ view: "ticket_log", from: "2026-10-01", to: "2026-10-06", action: "wake" })).tickets as Array<Row>).map((x) => x.ticket_id)).toEqual(["t_install", "t_in_1"]);
    expect(((await run({ view: "ticket_log", from: "2026-10-01", to: "2026-10-06", status: "failed" })).tickets as Array<Row>).map((x) => x.ticket_id)).toEqual(["t_in_2"]);
    expect(((await run({ view: "ticket_log", from: "2026-09-30", to: "2026-09-30" })).tickets as Array<Row>).map((x) => x.ticket_id)).toEqual(["t_before"]);
  });
  it("ticket_summary counts per action x status x mode and per room; every statement of the suite was a SELECT", async () => {
    const out = await run({ view: "ticket_summary", from: "2026-10-01", to: "2026-10-06" });
    expect(out.total).toBe(4);
    expect((out.by_action_status_mode as Row[]).find((c) => c.action === "wake" && c.status === "done")).toMatchObject({ mode: "live", n: 1 });
    expect((out.by_room as Row[]).find((c) => c.room_id === "r1")).toMatchObject({ n: 2 });
    expect((out.by_room as Row[]).find((c) => c.room_id === null)).toMatchObject({ n: 2 });
    expect(out.truncated).toBe(false);
    for (const s of H.statements.filter((x) => /steward_tickets/.test(x))) expect(s.trimStart()).toMatch(/^SELECT/);
  });
});
type Row = Record<string, unknown>;

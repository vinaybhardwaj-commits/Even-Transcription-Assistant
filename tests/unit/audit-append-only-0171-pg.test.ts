/**
 * audit-append-only-0171-pg.test.ts — REQUIRED PROOF for migration 0171 (Scribe OAuth C4): audit_log person and mcp.* rows are append-only on a REAL postgres:16
 * with EVERY migration applied in order, the way mcp-oauth-o3-pg.test.ts and fleet-rekey-pg.test.ts apply them.
 *
 *   1. person row UPDATE and DELETE refused; mcp.* row (any actor_type) UPDATE and DELETE refused; SQLSTATE 42501, message audit_append_only.
 *   2. an admin row cannot be turned INTO a protected row (action -> mcp.x, actor_type -> person); TRUNCATE refused.
 *   3. the legitimate path still works: lib/admin-audit.ts insertAdminAuditStrict + finishAdminAudit (UPDATE by id of an admin.* row) through the real module;
 *      INSERT of person and mcp rows succeeds; a non-protected row can still be deleted.
 *   4. running 0171 twice is a no-op (same triggers, one schema_migrations row, guard still on).
 *
 * WHERE THE DATABASE COMES FROM. Docker when the daemon answers (tests/support/s1-pg.ts, the repo's CI pattern). Otherwise ETA_PG_LOCAL_PSQL, a JSON argv prefix for a
 * local psql that reaches a postgres 16 superuser (e.g. ["runuser","-u","postgres","--","psql"]): the suite creates and drops its own database. Neither: skipped,
 * like mcp-oauth-o3-pg.test.ts.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { execFileSync } from "node:child_process";
import { readFileSync, readdirSync } from "node:fs";
import { dockerAvailable, pgContainer, type Sql } from "../support/s1-pg";

const H = vi.hoisted(() => ({ sql: (async () => []) as unknown as (s: TemplateStringsArray, ...v: unknown[]) => Promise<unknown[]> }));
vi.mock("@/lib/db", () => ({ sql: (s: TemplateStringsArray, ...v: unknown[]) => H.sql(s, ...v) }));
vi.setConfig({ testTimeout: 60_000, hookTimeout: 300_000 });

const { insertAdminAuditStrict, finishAdminAudit, writeAdminAudit } = await import("@/lib/admin-audit");

type Db = { start(): void; stop(): void; exec(text: string): void; sql: Sql };

/** A local psql in place of the container: same contract as pgContainer (exec = DDL, sql = values BOUND as untyped strings through PREPARE/EXECUTE). */
function localPg(prefix: string[]): Db {
  const db = `eta_audit_0171_${process.pid}`;
  const run = (d: string, text: string) =>
    execFileSync(prefix[0]!, [...prefix.slice(1), "-qAt", "-v", "ON_ERROR_STOP=1", "-d", d], { input: text, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] });
  const lit = (v: unknown) => (v === null || v === undefined ? "NULL" : `'${(typeof v === "object" ? JSON.stringify(v) : String(v)).replace(/'/g, "''")}'`);
  return {
    start: () => { run("postgres", `DROP DATABASE IF EXISTS ${db};`); run("postgres", `CREATE DATABASE ${db};`); },
    stop: () => { try { run("postgres", `DROP DATABASE IF EXISTS ${db};`); } catch { /* already gone */ } },
    exec: (text) => { run(db, text); },
    sql: async (strings, ...values) => {
      let q = "";
      strings.forEach((s, i) => { q += s + (i < values.length ? `$${i + 1}` : ""); });
      const body = q.trim().replace(/;\s*$/, "");
      const returns = /^select\b/i.test(body) || /\breturning\b/i.test(body);
      const prepared = returns ? `WITH __q AS (${body}\n) SELECT COALESCE(jsonb_agg(__q)::text, '[]') FROM __q` : body;
      const args = values.length ? `(${values.map(lit).join(", ")})` : "";
      const out = run(db, `PREPARE __s AS ${prepared}\n;\nEXECUTE __s${args};\n`).trim();
      return returns && out ? (JSON.parse(out) as unknown[]) : [];
    },
  };
}

const LOCAL = process.env.ETA_PG_LOCAL_PSQL ? (JSON.parse(process.env.ETA_PG_LOCAL_PSQL) as string[]) : null;
const HAVE_DOCKER = !LOCAL && dockerAvailable();
const pg: Db | null = LOCAL ? localPg(LOCAL) : HAVE_DOCKER ? pgContainer("eta-audit-0171") : null;
const HAVE = pg !== null;

type Row = Record<string, any>;
const q = async <T = Row>(strings: TemplateStringsArray, ...v: unknown[]) => (await pg!.sql(strings, ...v)) as T[];
const MIG = "db/migrations/0171_audit_append_only.sql";

/** Runs `text` and returns the error psql printed ("" when it succeeded). The refusal must carry the SQLSTATE and the message. */
function refusal(text: string): string {
  try { pg!.exec(`\\set VERBOSITY verbose\n${text}`); return ""; } catch (e) { return String((e as { stderr?: string }).stderr ?? (e as Error).message); }
}
const REFUSED = /ERROR:\s+42501: audit_append_only/;

async function seed(actor_type: string, action: string, actor_id = "seed"): Promise<string> {
  const rows = await q<{ id: string }>`INSERT INTO audit_log (actor_type, actor_id, action, target_type, target_id, metadata_json)
    VALUES (${actor_type}, ${actor_id}, ${action}, ${"test"}, ${"t1"}, ${JSON.stringify({ n: 1 })}::jsonb) RETURNING id`;
  return rows[0]!.id;
}
const count = async (id: string) => (await q<{ n: number }>`SELECT count(*)::int AS n FROM audit_log WHERE id = ${id}::uuid`)[0]!.n;

beforeAll(() => {
  if (!pg) return;
  pg.start();
  for (const f of readdirSync("db/migrations").filter((x) => x.endsWith(".sql")).sort()) pg.exec(readFileSync(`db/migrations/${f}`, "utf8"));
  H.sql = pg.sql as never;
}, 300_000);
afterAll(() => { pg?.stop(); });

describe.skipIf(!HAVE)("0171: audit_log person and mcp.* rows are append-only on real postgres", () => {
  it("INSERT of person and mcp rows succeeds (the O3 writer's shapes)", async () => {
    expect(await count(await seed("person", "mcp.tools/call", "person:alice@example.test"))).toBe(1);
    expect(await count(await seed("person", "admin.person_list", "person:alice@example.test"))).toBe(1);
    expect(await count(await seed("system", "mcp.rpc", "mcp:admin:gating"))).toBe(1);
    expect(await count(await seed("mcp", "mcp.tools/call"))).toBe(1);
  });

  it("person row: UPDATE refused, DELETE refused, row unchanged", async () => {
    const id = await seed("person", "admin.person_list", "person:alice@example.test");
    expect(refusal(`UPDATE audit_log SET metadata_json = '{"x":1}'::jsonb WHERE id = '${id}';`)).toMatch(REFUSED);
    expect(refusal(`UPDATE audit_log SET actor_type = 'admin' WHERE id = '${id}';`)).toMatch(REFUSED);
    expect(refusal(`DELETE FROM audit_log WHERE id = '${id}';`)).toMatch(REFUSED);
    expect((await q`SELECT actor_type::text AS t, metadata_json AS m FROM audit_log WHERE id = ${id}::uuid`)[0]).toEqual({ t: "person", m: { n: 1 } });
  });

  it("mcp.* row, any actor_type: UPDATE refused, DELETE refused", async () => {
    for (const actor of ["system", "admin", "mcp", "doctor"]) {
      const id = await seed(actor, "mcp.tools/call");
      expect(refusal(`UPDATE audit_log SET metadata_json = '{}'::jsonb WHERE id = '${id}';`), actor).toMatch(REFUSED);
      expect(refusal(`UPDATE audit_log SET action = 'admin.x' WHERE id = '${id}';`), actor).toMatch(REFUSED);
      expect(refusal(`DELETE FROM audit_log WHERE id = '${id}';`), actor).toMatch(REFUSED);
      expect(await count(id)).toBe(1);
    }
  });

  it("an admin row cannot be turned into a protected row", async () => {
    const id = await seed("admin", "admin.room_disable", "adm_1");
    expect(refusal(`UPDATE audit_log SET action = 'mcp.x' WHERE id = '${id}';`)).toMatch(REFUSED);
    expect(refusal(`UPDATE audit_log SET actor_type = 'person' WHERE id = '${id}';`)).toMatch(REFUSED);
    expect((await q`SELECT actor_type::text AS t, action FROM audit_log WHERE id = ${id}::uuid`)[0]).toEqual({ t: "admin", action: "admin.room_disable" });
  });

  it("TRUNCATE refused, every row survives", async () => {
    const before = (await q<{ n: number }>`SELECT count(*)::int AS n FROM audit_log`)[0]!.n;
    expect(before).toBeGreaterThan(0);
    expect(refusal(`TRUNCATE audit_log;`)).toMatch(REFUSED);
    expect((await q<{ n: number }>`SELECT count(*)::int AS n FROM audit_log`)[0]!.n).toBe(before);
  });

  it("lib/admin-audit.ts: the strict insert then finishAdminAudit's UPDATE by id of an admin.* row still succeeds", async () => {
    const id = await insertAdminAuditStrict({ actor: { type: "system", id: "mcp:admin:gating" }, action: "admin.room_disable", targetType: "room", targetId: "room_c4", meta: { reason: "c4" } });
    expect(await finishAdminAudit(id, { result: "ok" })).toBe(true);
    expect((await q`SELECT metadata_json AS m FROM audit_log WHERE id = ${id}::uuid`)[0]!.m).toEqual({ reason: "c4", result: "ok" });
    expect(await writeAdminAudit({ actor: { type: "person", id: "person:alice@example.test" }, action: "admin.person_list", targetType: "mcp_person", targetId: "x", meta: {}, strict: true })).toBe(true);
  });

  it("finishAdminAudit on a person-actor row is refused by the trigger and reported as false (best-effort, never throws)", async () => {
    const id = await insertAdminAuditStrict({ actor: { type: "person", id: "person:alice@example.test" }, action: "admin.person_grant", targetType: "mcp_person", targetId: "x", meta: {} });
    expect(await finishAdminAudit(id, { result: "ok" })).toBe(false);
  });

  it("a non-protected row can still be UPDATEd and DELETEd", async () => {
    const id = await seed("system", "stt.paid_call");
    expect(refusal(`UPDATE audit_log SET metadata_json = '{}'::jsonb WHERE id = '${id}';`)).toBe("");
    expect(refusal(`DELETE FROM audit_log WHERE id = '${id}';`)).toBe("");
    expect(await count(id)).toBe(0);
  });

  it("running 0171 twice is a no-op: same two triggers, one schema_migrations row, guard still on", async () => {
    const snap = async () => ({
      triggers: (await q<{ n: string }>`SELECT tgname AS n FROM pg_trigger WHERE tgrelid = 'audit_log'::regclass AND NOT tgisinternal ORDER BY tgname`).map((r) => r.n),
      versions: (await q<{ n: number }>`SELECT count(*)::int AS n FROM schema_migrations WHERE version = 171`)[0]!.n,
      fns: (await q<{ n: number }>`SELECT count(*)::int AS n FROM pg_proc WHERE proname = 'audit_log_append_only'`)[0]!.n,
    });
    const once = await snap();
    expect(once).toEqual({ triggers: ["audit_log_append_only_row", "audit_log_no_truncate"], versions: 1, fns: 1 });
    pg!.exec(readFileSync(MIG, "utf8"));
    pg!.exec(readFileSync(MIG, "utf8"));
    expect(await snap()).toEqual(once);
    const id = await seed("person", "mcp.rpc");
    expect(refusal(`DELETE FROM audit_log WHERE id = '${id}';`)).toMatch(REFUSED);
  });
});

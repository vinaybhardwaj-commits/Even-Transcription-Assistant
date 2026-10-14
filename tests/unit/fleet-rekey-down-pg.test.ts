/**
 * 0167's rollback (db/rollbacks/0167_fleet_rekey_approval.down.sql) on a REAL postgres:16: the fleet_devices catalogue after up-then-down equals the catalogue before 0167;
 * a 'rotated' row makes the down raise and change nothing; 0167 re-applies after a down. No row data is read; all ids are fake.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { dockerAvailable, pgContainer } from "../support/s1-pg";

vi.setConfig({ testTimeout: 90_000, hookTimeout: 300_000 });
const HAVE = dockerAvailable();
const pg = pgContainer("eta-fleet-rekey-down");

const UP = readFileSync("db/migrations/0167_fleet_rekey_approval.sql", "utf8");
const DOWN = readFileSync("db/rollbacks/0167_fleet_rekey_approval.down.sql", "utf8");

/** Everything `\d fleet_devices` shows, from the catalogue, plus whether the two new tables and the migration row exist. */
async function catalogue() {
  const s = pg.sql;
  const cols = await s`SELECT column_name, data_type, column_default, is_nullable FROM information_schema.columns WHERE table_name = 'fleet_devices' ORDER BY ordinal_position`;
  const cons = await s`SELECT conname, contype::text AS contype, pg_get_constraintdef(oid) AS def FROM pg_constraint WHERE conrelid = 'fleet_devices'::regclass ORDER BY conname`;
  const idx = await s`SELECT indexname, indexdef FROM pg_indexes WHERE tablename = 'fleet_devices' ORDER BY indexname`;
  const tabs = await s`SELECT table_name FROM information_schema.tables WHERE table_name IN ('fleet_rekey_approval', 'fleet_rekey_attempt') ORDER BY table_name`;
  const mig = await s`SELECT version FROM schema_migrations WHERE version = 167`;
  return { cols, cons, idx, tabs: tabs.length, mig: mig.length };
}

beforeAll(() => {
  if (!HAVE) return;
  pg.start();
  for (const f of readdirSync("db/migrations").filter((x) => x.endsWith(".sql") && !x.startsWith("0167_")).sort()) pg.exec(readFileSync(`db/migrations/${f}`, "utf8"));
}, 300_000);
afterAll(() => { if (HAVE) pg.stop(); });

(HAVE ? describe : describe.skip)("0167 down-migration on real postgres", () => {
  it("up then down leaves the pre-0167 fleet_devices catalogue (columns, constraints, indexes), no new tables, no schema_migrations row 167", async () => {
    const before = await catalogue();
    expect((before.cons as Array<{ conname: string }>).map((c) => c.conname)).toContain("fleet_devices_status_check");
    expect(before.tabs).toBe(0);
    pg.exec(UP);
    const during = await catalogue();
    expect(during).not.toEqual(before);
    expect(during.tabs).toBe(2);
    expect(during.mig).toBe(1);
    pg.exec(DOWN);
    expect(await catalogue()).toEqual(before);
  });

  it("with a 'rotated' (or 'retired') row present, down raises and changes nothing", async () => {
    pg.exec(UP);
    const upShape = await catalogue();
    for (const st of ["rotated", "retired"]) {
      pg.exec(`INSERT INTO fleet_devices (device_id, install_id, room_id, machine, public_key, status) VALUES ('dev_${st === "rotated" ? "a" : "b"}${"0".repeat(23)}', 'inst_down_1', 'room_x', 'm', 'k', '${st}')`);
      expect(() => pg.exec(DOWN)).toThrow();
      expect(await catalogue()).toEqual(upShape);
      expect((await pg.sql`SELECT count(*)::int AS n FROM fleet_devices WHERE status = ${st}`)[0]).toEqual({ n: 1 });
      pg.exec(`DELETE FROM fleet_devices WHERE status = '${st}'`);
    }
    pg.exec(DOWN); // clean now: the guard passes
  });

  it("0167 applies again after a down, and down runs again after that (idempotent round trip)", async () => {
    const before = await catalogue();
    pg.exec(UP);
    expect((await catalogue()).tabs).toBe(2);
    pg.exec(UP); // 0167 itself is idempotent
    pg.exec(DOWN);
    expect(await catalogue()).toEqual(before);
  });
});

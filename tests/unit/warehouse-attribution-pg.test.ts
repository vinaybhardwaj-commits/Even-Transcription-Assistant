/**
 * Warehouse attribution against a REAL Postgres: migration 0124 applies, the window refresh PRESERVES the warehouse_* /
 * consulting_* columns, attributeFromWarehouse writes them with the real UPDATE, and the precedence, mismatch flag, queue,
 * race guard and read filter hold on real rows. Metabase is an injected function (never called).
 *
 * Migrations 0122, 0123 and 0124 are the real files. room / room_install are minimal hand-written DDL (only what the
 * crosswalk reads). Values are BOUND ($1..$n) through tests/support/s1-pg.ts, as the Neon driver does.
 * NOTE (s1-pg divergence): rows come back through jsonb_agg, so timestamps are ISO strings with an offset, as Neon returns.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import { readFileSync } from "node:fs";
import { dockerAvailable, pgContainer } from "../support/s1-pg";
import { refreshWindows, queryWindows, type WindowsDb } from "@/lib/encounter-windows";
import { attributeFromWarehouse } from "@/lib/encounter-windows/warehouse-attribution";
import { makeFakeClinician } from "../support/fake-identity";

const NA = makeFakeClinician(1).full_name;
const NB = makeFakeClinician(2).full_name;
const NX = makeFakeClinician(3).full_name;
const NY = makeFakeClinician(4).full_name;
const NZ = makeFakeClinician(5).full_name;
const NW = makeFakeClinician(6).full_name;
const NBWH = `${NB} (wh)`;
const NWH = makeFakeClinician(7).full_name;
const NEXT = makeFakeClinician(8).full_name;

const HAVE_DOCKER = dockerAvailable();
const ALLOW_SKIP = process.env.ETA_ALLOW_SKIP_E2E === "1";
const pg = pgContainer("eta-warehouse-attrib");
const noRecord = (f: string) => readFileSync(f, "utf8").replace(/INSERT INTO schema_migrations[\s\S]*?;/g, "");

describe("REQUIRED PROOF — warehouse attribution runs against a real postgres", () => {
  it("ran, or was skipped deliberately", () => {
    if (HAVE_DOCKER || ALLOW_SKIP) return;
    throw new Error("REQUIRED PROOF NOT RUN: tests/unit/warehouse-attribution-pg.test.ts needs Docker for postgres:16. Start Docker, or set ETA_ALLOW_SKIP_E2E=1 to accept that it was not proven.");
  });
});

/** The Neon-shaped db: a tag returning a lazy thenable (so db.transaction([...]) can run them in order). */
function makeDb(): WindowsDb {
  const tag = ((s: TemplateStringsArray, ...v: unknown[]) => {
    const run = () => pg.sql(s, ...v);
    return { run, then: (res: (x: unknown) => unknown, rej: (e: unknown) => unknown) => run().then(res, rej) };
  }) as unknown as WindowsDb & { transaction: unknown };
  (tag as unknown as { transaction: (qs: Array<{ run: () => Promise<unknown[]> }>) => Promise<unknown[]> }).transaction = async (qs) => {
    const out: unknown[] = [];
    for (const q of qs) out.push(await q.run());
    return out;
  };
  return tag as WindowsDb;
}

const M = "EHRC-TEST1s-Mac-mini";
const NOW = () => Date.now();
const iso = (minAgo: number) => new Date(NOW() - minAgo * 60_000).toISOString();
const ev = (event: string, minAgo: number, payload: Record<string, unknown>) =>
  `INSERT INTO pulse_presence_events (source, machine, event, ts, payload) VALUES ('ext', '${M}', '${event}', '${iso(minAgo)}', '${JSON.stringify({ tab_focus: "true", ...payload })}'::jsonb);`;
const consult = (enc: string, openAgo: number, closeAgo: number | null, uid: string | null, name: string | null) =>
  ev("encounter_open", openAgo, { encounter_id: enc, ...(uid ? { doctor_uid: uid, display_name: name } : {}) }) +
  (closeAgo === null ? "" : ev("encounter_close", closeAgo, { encounter_id: enc, ...(uid ? { doctor_uid: uid } : {}) }));

type Wh = { consult_uid: string | null; prescription_uid?: string | null; doctor_uid: string | null; doctor_name?: string | null; created_at: string };
const metabase = (rows: Wh[]) => vi.fn(async () => rows.map((r) => ({ prescription_uid: null, doctor_name: null, ...r })));

const refresh = (db: WindowsDb) => refreshWindows(db, { from: NOW() - 3 * 3_600_000, to: NOW() + 5 * 60_000 }, { asOf: NOW() });
const rowOf = async (key: string) =>
  ((await pg.sql`SELECT * FROM eta_encounter_windows WHERE consult_key = ${key}`) as Array<Record<string, unknown>>)[0];

beforeAll(() => {
  if (!HAVE_DOCKER) return;
  pg.start();
  pg.exec(`
    CREATE TABLE schema_migrations (version int PRIMARY KEY, name text);
    CREATE TABLE room (id text PRIMARY KEY, slug text, name text, disabled_at timestamptz);
    CREATE TABLE room_install (install_id text PRIMARY KEY, room_id text NOT NULL, hostname text, enrolled_at timestamptz, retired_at timestamptz);
  `);
  for (const f of ["0122_pulse_presence_events", "0123_eta_encounter_windows", "0124_encounter_windows_warehouse_attribution"]) {
    pg.exec(noRecord(`db/migrations/${f}.sql`));
  }
}, 240_000);
afterAll(() => { if (HAVE_DOCKER) pg.stop(); });

const it_ = HAVE_DOCKER ? it : it.skip;
let db: WindowsDb;
beforeEach(() => {
  vi.spyOn(console, "info").mockImplementation(() => {}); // the mismatch log line, asserted in the unit test
  if (!HAVE_DOCKER) return;
  db = makeDb();
  pg.exec(`
    TRUNCATE pulse_presence_events; TRUNCATE eta_encounter_windows;
    DELETE FROM room_install; DELETE FROM room;
    INSERT INTO room (id, slug, name) VALUES ('r1', 'opd-test-1', 'OPD TEST 1');
    INSERT INTO room_install (install_id, room_id, hostname, enrolled_at) VALUES ('i1', 'r1', '${M}', now() - interval '30 days');
  `);
});

describe("migration 0124", () => {
  it_("is re-runnable: IF NOT EXISTS everywhere, so a second run is a no-op", () => {
    pg.exec(noRecord("db/migrations/0124_encounter_windows_warehouse_attribution.sql")); // IF NOT EXISTS everywhere: a second run is a no-op
  });

  it_("column list, defaults, index predicate and attribution_source CHECK are as documented", async () => {
    const cols = (await pg.sql`
      SELECT column_name, data_type, is_nullable, column_default FROM information_schema.columns
       WHERE table_name = 'eta_encounter_windows' AND column_name = ANY(${[
         "warehouse_doctor_uid", "warehouse_doctor_name", "warehouse_checked_at", "warehouse_prescription_uid",
         "consulting_doctor_uid", "consulting_doctor_name", "attribution_source", "doctor_mismatch", "warehouse_attempts"]}::text[])
       ORDER BY column_name`) as Array<{ column_name: string; data_type: string; is_nullable: string; column_default: string | null }>;
    expect(cols.map((c) => c.column_name)).toEqual([
      "attribution_source", "consulting_doctor_name", "consulting_doctor_uid", "doctor_mismatch", "warehouse_attempts", "warehouse_checked_at",
      "warehouse_doctor_name", "warehouse_doctor_uid", "warehouse_prescription_uid"]);
    const mm = cols.find((c) => c.column_name === "doctor_mismatch")!;
    expect([mm.data_type, mm.is_nullable, mm.column_default]).toEqual(["boolean", "NO", "false"]);
    expect(cols.find((c) => c.column_name === "warehouse_checked_at")!.data_type).toBe("timestamp with time zone");
    const att = cols.find((c) => c.column_name === "warehouse_attempts")!;
    expect([att.data_type, att.is_nullable, att.column_default]).toEqual(["integer", "NO", "0"]);
    const idx = (await pg.sql`SELECT indexdef FROM pg_indexes WHERE indexname = 'eta_encounter_windows_wh_unchecked_idx'`) as Array<{ indexdef: string }>;
    expect(idx[0]!.indexdef).toMatch(/\(t_open\) WHERE \(warehouse_checked_at IS NULL\)/);
    await expect(
      pg.sql`INSERT INTO eta_encounter_windows (consult_key, machine, attribution, t_open, close_reason, quality, resolver_version, attribution_source)
             VALUES ('bad@m', 'm', 'none', now(), 'open', 'unclosed', 'v', 'bogus')`,
    ).rejects.toThrow();
  });
});

describe("refresh preserves the warehouse columns", () => {
  it_("a refreshed row keeps its warehouse attribution (and the extension's own columns stay the extension's)", async () => {
    pg.exec(consult("E1", 60, 50, "UA", NA) + consult("E2", 40, 30, "UB", NB));
    await refresh(db);
    // before the warehouse answers: provisional extension attribution
    expect(await rowOf(`E1@${M}`)).toMatchObject({ doctor_uid: "UA", attribution: "rows", consulting_doctor_uid: "UA", consulting_doctor_name: NA, attribution_source: "extension", doctor_mismatch: false, warehouse_checked_at: null });

    await attributeFromWarehouse(db, {
      query: metabase([{ consult_uid: "E1", prescription_uid: "RXE1", doctor_uid: "UX", doctor_name: NX, created_at: iso(59) }]),
    });
    const before = (await rowOf(`E1@${M}`))!;
    expect(before).toMatchObject({
      doctor_uid: "UA", display_name: NA, attribution: "rows", // the extension view is untouched
      warehouse_doctor_uid: "UX", warehouse_doctor_name: NX, warehouse_prescription_uid: "RXE1",
      consulting_doctor_uid: "UX", consulting_doctor_name: NX, attribution_source: "warehouse", doctor_mismatch: true,
    });
    expect(before.warehouse_checked_at).not.toBeNull();

    const r = await refresh(db); // the 5-minute cron / hourly sweep, over the same range
    expect(r.inserted).toBe(2);
    expect(r.deleted).toBe(0); // nothing vanished, so nothing was deleted
    const after = (await rowOf(`E1@${M}`))!;
    for (const k of ["warehouse_doctor_uid", "warehouse_doctor_name", "warehouse_prescription_uid", "warehouse_checked_at", "consulting_doctor_uid", "consulting_doctor_name", "attribution_source", "doctor_mismatch"]) {
      expect(after[k], k).toEqual(before[k]);
    }
    expect(after.id).toBe(before.id); // the same row, not a delete + insert
    expect(after.doctor_uid).toBe("UA");
  });

  it_("a refresh recomputes consulting_*/mismatch against the STORED warehouse doctor and the fresh extension doctor", async () => {
    pg.exec(consult("E1", 60, 50, "UA", NA));
    await refresh(db);
    // the warehouse said UA all along; a stale mismatch flag from an earlier extension view is corrected by the refresh
    pg.exec(`UPDATE eta_encounter_windows SET warehouse_doctor_uid = 'UA', warehouse_doctor_name = '${NA} (wh)', warehouse_checked_at = now(),
                    consulting_doctor_uid = 'UA', consulting_doctor_name = '${NA} (wh)', attribution_source = 'warehouse', doctor_mismatch = true;`);
    await refresh(db);
    expect(await rowOf(`E1@${M}`)).toMatchObject({ consulting_doctor_name: `${NA} (wh)`, attribution_source: "warehouse", doctor_mismatch: false, warehouse_doctor_uid: "UA" });
  });

  it_("an unanswered row follows the extension on refresh (consulting_* tracks doctor_uid until the warehouse speaks)", async () => {
    pg.exec(consult("E1", 60, 50, "UA", NA));
    await refresh(db);
    pg.exec(`UPDATE eta_encounter_windows SET consulting_doctor_uid = 'STALE', consulting_doctor_name = 'Stale', attribution_source = 'none';`);
    await refresh(db);
    expect(await rowOf(`E1@${M}`)).toMatchObject({ consulting_doctor_uid: "UA", consulting_doctor_name: NA, attribution_source: "extension", warehouse_checked_at: null });
  });

  it_("a consult that vanished from the compute is still deleted; the others stay", async () => {
    pg.exec(consult("E1", 60, 50, "UA", NA) + consult("E2", 40, 30, "UB", NB));
    await refresh(db);
    pg.exec(`DELETE FROM pulse_presence_events WHERE payload->>'encounter_id' = 'E2';`);
    const r = await refresh(db);
    expect(r.deleted).toBe(1);
    expect(await rowOf(`E2@${M}`)).toBeUndefined();
    expect(await rowOf(`E1@${M}`)).toBeDefined();
  });
});

describe("attributeFromWarehouse on real rows", () => {
  it_("precedence: warehouse wins, extension when the warehouse has nothing, none when neither; summary counts match the table", async () => {
    pg.exec(consult("E1", 60, 50, "UA", NA) + consult("E2", 40, 30, "UB", NB) + consult("E3", 20, null, null, null));
    await refresh(db);
    const query = metabase([
      { consult_uid: "E1", prescription_uid: "RX1", doctor_uid: "UX", doctor_name: NX, created_at: iso(59) },
      { consult_uid: "E1", prescription_uid: "RX1b", doctor_uid: "UY", doctor_name: NY, created_at: iso(58) }, // later duplicate: ignored
      { consult_uid: "E2", prescription_uid: "RX2", doctor_uid: null, created_at: iso(39) },                          // row exists, no doctor
    ]);
    const s = await attributeFromWarehouse(db, { query });
    expect(s).toEqual({ candidates: 3, checked: 3, resolved: 1, unresolved: 2, mismatches: 1, raced: 0, deferred: 0, gave_up: 0 });
    expect(query).toHaveBeenCalledTimes(1);

    expect(await rowOf(`E1@${M}`)).toMatchObject({ warehouse_doctor_uid: "UX", consulting_doctor_uid: "UX", consulting_doctor_name: NX, attribution_source: "warehouse", doctor_mismatch: true, warehouse_prescription_uid: "RX1" });
    expect(await rowOf(`E2@${M}`)).toMatchObject({ warehouse_doctor_uid: null, consulting_doctor_uid: "UB", consulting_doctor_name: NB, attribution_source: "extension", doctor_mismatch: false, warehouse_prescription_uid: "RX2" });
    const e3 = (await rowOf(`E3@${M}`))!;
    expect(e3.warehouse_checked_at).not.toBeNull();
    expect(e3.warehouse_doctor_uid).toBeNull();
    expect(e3.attribution_source).toBe(e3.doctor_uid ? "extension" : "none");
    expect(e3.doctor_mismatch).toBe(false);
  });

  it_("the queue: answered rows are never asked again; unanswered ones wait 10 minutes; an answer later resolves them", async () => {
    pg.exec(consult("E1", 60, 50, "UA", NA) + consult("E2", 40, 30, "UB", NB));
    await refresh(db);
    await attributeFromWarehouse(db, { query: metabase([{ consult_uid: "E1", doctor_uid: "UX", doctor_name: NX, created_at: iso(59) }]) });

    const idle = metabase([]);
    expect((await attributeFromWarehouse(db, { query: idle })).candidates).toBe(0); // E1 answered, E2 checked just now
    expect(idle).not.toHaveBeenCalled();

    pg.exec(`UPDATE eta_encounter_windows SET warehouse_checked_at = now() - interval '11 minutes' WHERE consult_key = 'E2@${M}';`);
    const again = metabase([{ consult_uid: "E2", doctor_uid: "UZ", doctor_name: NZ, created_at: iso(39) }]);
    const s = await attributeFromWarehouse(db, { query: again });
    expect(s).toMatchObject({ candidates: 1, resolved: 1, mismatches: 1 });
    expect(String((again.mock.calls[0] as unknown[])[0])).toContain("'E2'");
    expect(String((again.mock.calls[0] as unknown[])[0])).not.toContain("'E1'");
    expect(await rowOf(`E2@${M}`)).toMatchObject({ warehouse_doctor_uid: "UZ", consulting_doctor_uid: "UZ", attribution_source: "warehouse", doctor_mismatch: true });
  });

  it_("only rows inside the hours window are asked about", async () => {
    pg.exec(consult("E1", 60, 50, "UA", NA));
    await refresh(db);
    pg.exec(`UPDATE eta_encounter_windows SET t_open = now() - interval '40 hours', t_close = now() - interval '39 hours';`);
    expect((await attributeFromWarehouse(db, { hours: 36, query: metabase([]) })).candidates).toBe(0);
    expect((await attributeFromWarehouse(db, { hours: 48, query: metabase([]) })).candidates).toBe(1);
  });

  it_("RETRY CAP: 12 unresolved lookups and the row is never queued again; the cap survives a refresh and the attribution stays extension", async () => {
    pg.exec(consult("E1", 60, 50, "UA", NA));
    await refresh(db);
    const none = metabase([]);
    for (let i = 1; i <= 12; i++) {
      pg.exec(`UPDATE eta_encounter_windows SET warehouse_checked_at = now() - interval '11 minutes';`); // let the 10-minute pace elapse
      const s = await attributeFromWarehouse(db, { query: none });
      expect(s, `check ${i}`).toMatchObject({ candidates: 1, unresolved: 1, gave_up: i === 12 ? 1 : 0 });
      expect((await rowOf(`E1@${M}`))!.warehouse_attempts, `attempts after ${i}`).toBe(i);
    }
    pg.exec(`UPDATE eta_encounter_windows SET warehouse_checked_at = now() - interval '2 hours';`);
    const idle = metabase([{ consult_uid: "E1", doctor_uid: "UX", doctor_name: NX, created_at: iso(59) }]);
    expect((await attributeFromWarehouse(db, { query: idle })).candidates).toBe(0); // given up: not asked, even though the warehouse would now answer
    expect(idle).not.toHaveBeenCalled();
    await refresh(db);
    expect(await rowOf(`E1@${M}`)).toMatchObject({ warehouse_attempts: 12, attribution_source: "extension", consulting_doctor_uid: "UA", warehouse_doctor_uid: null });
    // an ANSWERED lookup does not count as an unresolved attempt
    pg.exec(`TRUNCATE eta_encounter_windows;`);
    pg.exec(consult("E9", 30, 20, "UA", NA));
    await refresh(db);
    await attributeFromWarehouse(db, { query: metabase([{ consult_uid: "E9", doctor_uid: "UX", doctor_name: NX, created_at: iso(29) }]) });
    expect((await rowOf(`E9@${M}`))!.warehouse_attempts).toBe(0);
  });

  it_("matches on prescription_ref when the consult has no consult_uid", async () => {
    pg.exec(`
      INSERT INTO eta_encounter_windows (consult_key, consult_uid, prescription_ref, machine, attribution, t_open, close_reason, quality, resolver_version, doctor_uid, display_name)
      VALUES ('rx-only@m', NULL, 'RXONLY', 'm', 'rows', now() - interval '20 minutes', 'open', 'unclosed', 'v', 'UA', '${NA}');`);
    const s = await attributeFromWarehouse(db, { query: metabase([{ consult_uid: null, prescription_uid: "RXONLY", doctor_uid: "UW", doctor_name: NW, created_at: iso(19) }]) });
    expect(s).toMatchObject({ resolved: 1, mismatches: 1 });
    expect(await rowOf("rx-only@m")).toMatchObject({ warehouse_doctor_uid: "UW", warehouse_prescription_uid: "RXONLY", attribution_source: "warehouse" });
  });

  it_("RACE GUARD: a refresh that changes the extension doctor between the read and the write leaves the row queued, not stamped", async () => {
    pg.exec(consult("E1", 60, 50, "UA", NA));
    await refresh(db);
    const query = vi.fn(async () => {
      pg.exec(`UPDATE eta_encounter_windows SET doctor_uid = 'UCHANGED';`); // lands while Metabase is answering
      return [{ consult_uid: "E1", prescription_uid: "RX1", doctor_uid: "UX", doctor_name: NX, created_at: iso(59) }];
    });
    const s = await attributeFromWarehouse(db, { query });
    expect(s).toMatchObject({ candidates: 1, checked: 0, raced: 1 });
    expect(await rowOf(`E1@${M}`)).toMatchObject({ warehouse_checked_at: null, warehouse_doctor_uid: null });
    // and the next run (extension doctor now stable) writes it
    const s2 = await attributeFromWarehouse(db, { query: metabase([{ consult_uid: "E1", prescription_uid: "RX1", doctor_uid: "UX", doctor_name: NX, created_at: iso(59) }]) });
    expect(s2).toMatchObject({ checked: 1, resolved: 1, mismatches: 1 });
  });

  it_("the update never changes doctor_uid, display_name or attribution on any row", async () => {
    pg.exec(consult("E1", 60, 50, "UA", NA) + consult("E2", 40, 30, "UB", NB));
    await refresh(db);
    const snap = async () => (await pg.sql`SELECT consult_key, doctor_uid, display_name, attribution, quality, t_open, t_close FROM eta_encounter_windows ORDER BY consult_key`);
    const before = await snap();
    await attributeFromWarehouse(db, { query: metabase([
      { consult_uid: "E1", doctor_uid: "UX", doctor_name: NX, created_at: iso(59) },
      { consult_uid: "E2", doctor_uid: "UY", doctor_name: NY, created_at: iso(39) }]) });
    expect(await snap()).toEqual(before);
  });
});

describe("GET /api/encounter-windows data layer — queryWindows", () => {
  it_("returns both views of the doctor, ISO timestamps, and filters mismatch=true", async () => {
    pg.exec(consult("E1", 60, 50, "UA", NA) + consult("E2", 40, 30, "UB", NB));
    await refresh(db);
    await attributeFromWarehouse(db, { query: metabase([
      { consult_uid: "E1", prescription_uid: "RX1", doctor_uid: "UX", doctor_name: NX, created_at: iso(59) },
      { consult_uid: "E2", prescription_uid: "RX2", doctor_uid: "UB", doctor_name: NBWH, created_at: iso(39) }]) });

    const all = await queryWindows(db, {});
    expect(all.map((w) => w.consult_uid)).toEqual(["E1", "E2"]);
    const e1 = all[0]!;
    expect(e1).toMatchObject({
      doctor_uid: "UA", display_name: NA, attribution: "rows",
      warehouse_doctor_uid: "UX", warehouse_doctor_name: NX, warehouse_prescription_uid: "RX1",
      consulting_doctor_uid: "UX", consulting_doctor_name: NX, attribution_source: "warehouse", doctor_mismatch: true,
    });
    expect(new Date(e1.warehouse_checked_at!).toISOString()).toBe(e1.warehouse_checked_at);
    expect(all[1]).toMatchObject({ doctor_mismatch: false, attribution_source: "warehouse", consulting_doctor_name: `${NB} (wh)` });

    expect((await queryWindows(db, { mismatch: true })).map((w) => w.consult_uid)).toEqual(["E1"]);
    expect((await queryWindows(db, { mismatch: false })).map((w) => w.consult_uid)).toEqual(["E2"]);
    // doctor_uid matches the doctor to REPORT (consulting) OR the extension's: UX only via consulting, UA only via the extension, UB both
    expect((await queryWindows(db, { doctor_uid: "UX" })).map((w) => w.consult_uid)).toEqual(["E1"]);
    expect((await queryWindows(db, { doctor_uid: "UA" })).map((w) => w.consult_uid)).toEqual(["E1"]);
    expect((await queryWindows(db, { doctor_uid: "UB" })).map((w) => w.consult_uid)).toEqual(["E2"]);
    expect(await queryWindows(db, { doctor_uid: "NOBODY" })).toEqual([]);
    expect((await queryWindows(db, { mismatch: null })).map((w) => w.consult_uid)).toEqual(["E1", "E2"]);
  });
});

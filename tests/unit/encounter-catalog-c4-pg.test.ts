/**
 * encounter-catalog-c4-pg.test.ts — migration 0169 and the C4 columns against a REAL postgres:16 (never on the Mini: the harness refuses there).
 * Only the driver is a stand-in (as in encounter-catalog-pg.test.ts). Ids and tokens are synthetic; no text anywhere.
 */
import { describe, it, expect, vi, beforeAll, afterAll } from "vitest";
import { readFileSync } from "node:fs";
import { dockerAvailable, pgContainer } from "../support/s1-pg";

const H = vi.hoisted(() => ({ tag: null as null | ((s: TemplateStringsArray, ...v: unknown[]) => Promise<unknown[]>) }));
vi.mock("@/lib/db", () => ({
  sql: (text: string, params: unknown[]) => {
    const parts = text.split(/\$\d+/);
    if (parts.length - 1 !== params.length) throw new Error("test driver: placeholders and params differ");
    return H.tag!(Object.assign(parts, { raw: parts }) as unknown as TemplateStringsArray, ...params);
  },
}));

import { ingestCatalogRows } from "@/lib/encounter-catalog/store";
import { parseSearch, searchCatalog } from "@/lib/encounter-catalog/search";

const HAVE_DOCKER = dockerAvailable();
const ALLOW_SKIP = process.env.ETA_ALLOW_SKIP_E2E === "1";
const pg = pgContainer("eta-encounter-catalog-c4");
const UP168 = readFileSync("db/migrations/0168_encounter_catalog.sql", "utf8");
const UP = readFileSync("db/migrations/0169_encounter_catalog_c4.sql", "utf8");
const DOWN = readFileSync("db/rollbacks/0169_encounter_catalog_c4.down.sql", "utf8");

describe("REQUIRED PROOF — encounter catalog C4 runs against a real postgres", () => {
  it("ran, or was skipped deliberately", () => {
    if (HAVE_DOCKER || ALLOW_SKIP) return;
    throw new Error("REQUIRED PROOF NOT RUN: tests/unit/encounter-catalog-c4-pg.test.ts needs Docker for postgres:16 (not on the Mini). Run it on the lab box / c3, or set ETA_ALLOW_SKIP_E2E=1 to accept that it was not proven.");
  });
});

const d = HAVE_DOCKER ? describe : describe.skip;
const q = async (text: string, ...v: unknown[]): Promise<Array<Record<string, unknown>>> => {
  const parts = text.split("?");
  return (await H.tag!(Object.assign(parts, { raw: parts }) as unknown as TemplateStringsArray, ...v)) as Array<Record<string, unknown>>;
};
const rowOf = async (uid: string) => (await q("SELECT * FROM encounter_catalog WHERE consult_uid = ?", uid))[0];
const one = async (text: string) => Object.values((await q(text))[0] ?? {})[0];
const cols = async () => (await q("SELECT column_name FROM information_schema.columns WHERE table_name = 'encounter_catalog' ORDER BY ordinal_position")).map((r) => r.column_name);

const AT = "2026-10-15T09:00:00Z";
const JEV = { sets: [{ set_id: "consult_rubric", set_sha: "ab12cd34ef56", band: "high", label: "complete", model: "jev-model-1", at: AT }] };
const CLEF = { lanes: [{ lane: "affect", scores: { calm: 0.8, tension: 0.1 }, model_rev: "rev3", at: AT }] };
const T_OPEN = 1_760_243_000_000;
const PRES = { encounter_open: T_OPEN, encounter_close: T_OPEN + 600_000, boundary_source: "pqm", close_reason: "idle_timeout" };
const box = (uid: string, over: Record<string, unknown> = {}) => ({
  consult_uid: uid, ist_date: "2026-10-12", doctor_uid: "DOC12345", room_id: "room_abc", t_open: T_OPEN, t_close: T_OPEN + 600_000, source: "cutter", stages: { stt: { state: "ok", reason: null } },
  first_gap: "freescript:none_yet", catalog_version: 2, generated_at: "2026-10-15T06:00:00Z", presence: PRES, ...over,
});

d("encounter_catalog C4 columns on postgres:16", () => {
  beforeAll(() => {
    pg.start();
    H.tag = pg.sql;
    pg.exec("CREATE TABLE schema_migrations (version integer PRIMARY KEY, name text NOT NULL);");
    pg.exec(UP168);
  });
  afterAll(() => { pg.stop(); });

  it("0169 adds exactly the three columns, records itself, is idempotent and keeps the existing rows", async () => {
    const before = await cols();
    pg.exec("INSERT INTO encounter_catalog (consult_uid, doctor_uid, ist_date) VALUES ('synth-c4-old', 'DOC12345', '2026-10-12')");     // a 0168-era row
    pg.exec(UP);
    expect((await cols()).filter((c) => !before.includes(c))).toEqual(["jev", "clef_affect", "presence"]);
    expect(await one("SELECT name FROM schema_migrations WHERE version = 169")).toBe("0169_encounter_catalog_c4");
    pg.exec(UP);
    expect(await one("SELECT count(*)::int FROM schema_migrations WHERE version = 169")).toBe(1);
    expect((await cols()).length).toBe(before.length + 3);
    const old = await rowOf("synth-c4-old");
    expect([old.jev, old.clef_affect, old.presence, old.doctor_uid]).toEqual([null, null, null, "DOC12345"]);
    // the constraint is real: a non-object is refused by the database too
    expect(() => pg.exec("UPDATE encounter_catalog SET jev = '[1]'::jsonb WHERE consult_uid = 'synth-c4-old'")).toThrow();
  });

  it("the box feed writes presence; newcat's partial rows write jev and clef_affect without touching anything else, and the box's next row keeps them", async () => {
    expect(await ingestCatalogRows([box("synth-c4-a")])).toEqual({ updated: 0, inserted: 1, stale: 0 });
    const a0 = await rowOf("synth-c4-a");
    expect(a0.presence).toEqual(PRES);
    expect([a0.jev, a0.clef_affect]).toEqual([null, null]);
    expect(await ingestCatalogRows([{ consult_uid: "synth-c4-a", jev: JEV }])).toEqual({ updated: 1, inserted: 0, stale: 0 });
    expect(await ingestCatalogRows([{ consult_uid: "synth-c4-a", clef_affect: CLEF }])).toEqual({ updated: 1, inserted: 0, stale: 0 });
    const a1 = await rowOf("synth-c4-a");
    expect([a1.jev, a1.clef_affect, a1.presence]).toEqual([JEV, CLEF, PRES]);
    for (const k of ["ist_date", "doctor_uid", "room_id", "t_open", "t_close", "source", "stages", "first_gap", "catalog_version", "generated_at"]) expect(a1[k], k).toEqual(a0[k]);
    // the box's next hourly row (no jev / clef_affect key) keeps newcat's columns; a new presence replaces the box's own
    await ingestCatalogRows([box("synth-c4-a", { generated_at: "2026-10-15T07:00:00Z", presence: { ...PRES, close_reason: "endConsult" } })]);
    const a2 = await rowOf("synth-c4-a");
    expect([a2.jev, a2.clef_affect]).toEqual([JEV, CLEF]);
    expect((a2.presence as { close_reason: string }).close_reason).toBe("endConsult");
    // an explicit null clears one column only
    await ingestCatalogRows([{ consult_uid: "synth-c4-a", jev: null }]);
    const a3 = await rowOf("synth-c4-a");
    expect([a3.jev, a3.clef_affect]).toEqual([null, CLEF]);
  });

  it("a stale box row (older generated_at) does not overwrite presence, and newcat's partial rows are never guarded", async () => {
    expect(await ingestCatalogRows([box("synth-c4-a", { generated_at: "2026-10-15T01:00:00Z", presence: { ...PRES, close_reason: "pqm" } })])).toEqual({ updated: 0, inserted: 0, stale: 1 });
    expect(((await rowOf("synth-c4-a")).presence as { close_reason: string }).close_reason).toBe("endConsult");
    expect(await ingestCatalogRows([{ consult_uid: "synth-c4-a", jev: JEV }])).toEqual({ updated: 1, inserted: 0, stale: 0 });
  });

  it("the search returns the three columns as stored", async () => {
    const p = parseSearch(new URLSearchParams("from=2026-10-12&to=2026-10-12"));
    if (!p.ok) throw new Error(p.error);
    const r = await searchCatalog(p.q);
    const a = r.rows.find((x) => x.consult_uid === "synth-c4-a")!;
    expect([a.jev, a.clef_affect]).toEqual([JEV, CLEF]);
    expect((a.presence as { encounter_open: number }).encounter_open).toBe(T_OPEN);
  });

  it("CS-3 updateOnly: an existing uid is updated, a missing uid stays absent and is counted, and the default (route) path still inserts", async () => {
    const n0 = await one("SELECT count(*)::int FROM encounter_catalog");
    expect(await ingestCatalogRows([{ consult_uid: "synth-c4-a", jev: JEV }, { consult_uid: "synth-c4-gone", jev: JEV }], { updateOnly: true })).toEqual({ updated: 1, inserted: 0, stale: 0, missing: 1 });
    expect(await rowOf("synth-c4-gone")).toBeUndefined();
    expect(await one("SELECT count(*)::int FROM encounter_catalog")).toBe(n0);
    expect(await ingestCatalogRows([{ consult_uid: "synth-c4-gone", jev: JEV }], { updateOnly: true })).toEqual({ updated: 0, inserted: 0, stale: 0, missing: 1 });
    // stale rows are stale, not missing
    expect(await ingestCatalogRows([box("synth-c4-a", { generated_at: "2026-10-15T01:00:00Z" })], { updateOnly: true })).toEqual({ updated: 0, inserted: 0, stale: 1, missing: 0 });
    // updateOnly:false is the route's behaviour: it inserts
    expect(await ingestCatalogRows([{ consult_uid: "synth-c4-new", jev: JEV }], { updateOnly: false })).toEqual({ updated: 0, inserted: 1, stale: 0 });
    pg.exec("DELETE FROM encounter_catalog WHERE consult_uid = 'synth-c4-new'");
  });

  it("CS-4: a jev set with state retired round-trips through the database", async () => {
    const J = { sets: [{ ...JEV.sets[0], state: "retired" }] };
    expect(await ingestCatalogRows([{ consult_uid: "synth-c4-a", jev: J }], { updateOnly: true })).toEqual({ updated: 1, inserted: 0, stale: 0, missing: 0 });
    expect((await rowOf("synth-c4-a")).jev).toEqual(J);
  });

  it("the rollback drops only the three columns and its schema_migrations row; 0168's table and rows stay; 0169 can be applied again", async () => {
    const withC4 = await cols();
    pg.exec(DOWN);
    expect((await cols())).toEqual(withC4.filter((c) => !["jev", "clef_affect", "presence"].includes(c as string)));
    expect(await one("SELECT count(*)::int FROM schema_migrations WHERE version = 169")).toBe(0);
    expect(await one("SELECT count(*)::int FROM schema_migrations WHERE version = 168")).toBe(1);
    expect(await one("SELECT count(*)::int FROM encounter_catalog")).toBe(2);
    pg.exec(UP);
    expect((await cols()).length).toBe(withC4.length);
    expect(await one("SELECT count(*)::int FROM schema_migrations WHERE version = 169")).toBe(1);
  });
});

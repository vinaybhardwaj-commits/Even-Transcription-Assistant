/**
 * encounter-catalog-pg.test.ts — migration 0168 and the catalog's SQL against a REAL postgres:16 (never on the Mini: the harness refuses there).
 * Only the driver is a stand-in: `@/lib/db` sql(text, params) runs through psql with the values bound as $1..$n. Ids are synthetic; no text anywhere.
 */
import { describe, it, expect, vi, beforeAll, afterAll } from "vitest";
import { readFileSync } from "node:fs";
import { dockerAvailable, pgContainer } from "../support/s1-pg";

const H = vi.hoisted(() => ({ tag: null as null | ((s: TemplateStringsArray, ...v: unknown[]) => Promise<unknown[]>) }));
vi.mock("@/lib/db", () => ({
  // The app calls sql(text, params); the harness speaks the tagged-template form. Every statement here uses each $n once and in order.
  sql: (text: string, params: unknown[]) => {
    const parts = text.split(/\$\d+/);
    if (parts.length - 1 !== params.length) throw new Error("test driver: placeholders and params differ");
    return H.tag!(Object.assign(parts, { raw: parts }) as unknown as TemplateStringsArray, ...params);
  },
}));

import { makeFakeClinician } from "../support/fake-identity";
import { ingestCatalogRows } from "@/lib/encounter-catalog/store";
import { parseSearch, searchCatalog } from "@/lib/encounter-catalog/search";

const HAVE_DOCKER = dockerAvailable();
const ALLOW_SKIP = process.env.ETA_ALLOW_SKIP_E2E === "1";
const pg = pgContainer("eta-encounter-catalog");
const UP = readFileSync("db/migrations/0168_encounter_catalog.sql", "utf8");
const DOWN = readFileSync("db/rollbacks/0168_encounter_catalog.down.sql", "utf8");

describe("REQUIRED PROOF — encounter catalog runs against a real postgres", () => {
  it("ran, or was skipped deliberately", () => {
    if (HAVE_DOCKER || ALLOW_SKIP) return;
    throw new Error("REQUIRED PROOF NOT RUN: tests/unit/encounter-catalog-pg.test.ts needs Docker for postgres:16 (not on the Mini). Run it on the lab box / c3, or set ETA_ALLOW_SKIP_E2E=1 to accept that it was not proven.");
  });
});

const d = HAVE_DOCKER ? describe : describe.skip;
const q = async (text: string, ...v: unknown[]): Promise<Array<Record<string, unknown>>> => {
  const parts = text.split("?");
  return (await H.tag!(Object.assign(parts, { raw: parts }) as unknown as TemplateStringsArray, ...v)) as Array<Record<string, unknown>>;
};
const rowOf = async (uid: string) => (await q("SELECT * FROM encounter_catalog WHERE consult_uid = ?", uid))[0];
const one = async (text: string) => Object.values((await q(text))[0] ?? {})[0];

const DOC_NAME = makeFakeClinician(1).full_name;
const PAT_NAME = "Fake Patient 0001";
const T_OPEN = 1_760_243_000_000;
const mk = (uid: string, over: Record<string, unknown> = {}) => ({
  consult_uid: uid, ist_date: "2026-10-12", doctor_uid: "DOC12345", room_id: "room_abc", t_open: T_OPEN, t_close: T_OPEN + 600_000, source: "cutter",
  clip: { r2_key: "consult-clips/x/consult.flac", minutes: 10 }, layers: { stt: { r2_key: "reb/x/tracks/stt.sarvam-saaras-v3__v1__abcd1234.json", status: "ok" }, parts: null },
  freescript: { artifact_id: null, state: null }, stages: { stt: { state: "ok", reason: null } }, first_gap: "freescript:none_yet", allowance: { earned_min: 22, spent_min: 5 },
  catalog_version: 1, generated_at: "2026-10-14T06:00:00Z", ...over,
});

d("encounter_catalog on postgres:16", () => {
  beforeAll(() => {
    pg.start();
    H.tag = pg.sql;
    pg.exec("CREATE TABLE schema_migrations (version integer PRIMARY KEY, name text NOT NULL);");
    pg.exec(UP);
  });
  afterAll(() => { pg.stop(); });

  it("migration 0168 recorded itself, is idempotent, and created the table with its indexes", async () => {
    expect(await one("SELECT name FROM schema_migrations WHERE version = 168")).toBe("0168_encounter_catalog");
    pg.exec(UP);
    expect(await one("SELECT count(*)::int FROM schema_migrations WHERE version = 168")).toBe(1);
    const idx = (await q("SELECT indexname FROM pg_indexes WHERE tablename = 'encounter_catalog' ORDER BY 1")).map((r) => r.indexname);
    expect(idx).toEqual(["encounter_catalog_date_idx", "encounter_catalog_doctor_date_idx", "encounter_catalog_has_prescription_idx", "encounter_catalog_individual_uid_idx", "encounter_catalog_pkey", "encounter_catalog_prescription_uid_idx", "encounter_catalog_room_date_idx"]);
    const def = await one("SELECT indexdef FROM pg_indexes WHERE indexname = 'encounter_catalog_has_prescription_idx'");
    expect(String(def)).toMatch(/WHERE \(prescription IS NOT NULL\)/);
  });

  it("inserts new rows (times from UTC ms, json objects as sent) and a repeat of the same batch updates, not duplicates", async () => {
    const batch = [mk("synth-cat-a"), mk("synth-cat-b", { ist_date: "2026-10-13", doctor_uid: "DOC99999", room_id: "room_xyz" }), mk("synth-cat-c", { ist_date: "2026-10-11", source: "caa" })];
    const res = await ingestCatalogRows(batch);
    expect(res).toEqual({ updated: 0, inserted: 3 });
    const r = await rowOf("synth-cat-a");
    expect(new Date(r.t_open as string).toISOString()).toBe(new Date(T_OPEN).toISOString());
    expect(new Date(r.t_close as string).getTime() - new Date(r.t_open as string).getTime()).toBe(600_000);
    expect(r.clip).toEqual({ r2_key: "consult-clips/x/consult.flac", minutes: 10 });
    expect((r.layers as { parts: unknown }).parts).toBeNull();
    expect([r.source, r.first_gap, r.catalog_version, r.prescription]).toEqual(["cutter", "freescript:none_yet", 1, null]);
    expect(await ingestCatalogRows(batch)).toEqual({ updated: 3, inserted: 0 });
    expect(await one("SELECT count(*)::int FROM encounter_catalog")).toBe(3);
  });

  it("is field-level: the prescription join sends only {consult_uid, prescription} and nothing else changes; the box's next row keeps the prescription; an explicit null clears it", async () => {
    const before = await rowOf("synth-cat-a");
    await new Promise((r) => setTimeout(r, 30));
    expect(await ingestCatalogRows([{ consult_uid: "synth-cat-a", prescription: { prescription_uid: "rx-1", presc_state: "final" } }])).toEqual({ updated: 1, inserted: 0 });
    const withRx = await rowOf("synth-cat-a");
    expect(withRx.prescription).toEqual({ prescription_uid: "rx-1", presc_state: "final" });
    for (const k of ["ist_date", "doctor_uid", "room_id", "t_open", "t_close", "source", "clip", "layers", "freescript", "stages", "first_gap", "allowance", "catalog_version", "generated_at"])
      expect(withRx[k], k).toEqual(before[k]);
    expect(new Date(withRx.updated_at as string).getTime()).toBeGreaterThan(new Date(before.updated_at as string).getTime());
    await ingestCatalogRows([mk("synth-cat-a", { first_gap: null, freescript: { artifact_id: "art-1", state: "written" } })]);
    const after = await rowOf("synth-cat-a");
    expect(after.prescription).toEqual({ prescription_uid: "rx-1", presc_state: "final" });
    expect([after.first_gap, after.freescript]).toEqual([null, { artifact_id: "art-1", state: "written" }]);
    await ingestCatalogRows([{ consult_uid: "synth-cat-a", prescription: null, doctor_uid: null }]);
    const cleared = await rowOf("synth-cat-a");
    expect([cleared.prescription, cleared.doctor_uid, cleared.room_id]).toEqual([null, null, "room_abc"]);
    await ingestCatalogRows([{ consult_uid: "synth-cat-a", doctor_uid: "DOC12345", prescription: { prescription_uid: "rx-1", presc_state: "final" } }]);
  });

  it("the C3 join fills the identity columns by the same field-level upsert; the box row never blanks them; search shows them to admins only", async () => {
    const c3 = { consult_uid: "synth-cat-a", doctor_name: DOC_NAME, patient_name: PAT_NAME, individual_uid: "ind_fake0001", prescription_uid: "rx_fake0001", presc_state: "final" };
    expect(await ingestCatalogRows([c3])).toEqual({ updated: 1, inserted: 0 });
    const r = await rowOf("synth-cat-a");
    expect([r.doctor_name, r.patient_name, r.individual_uid, r.prescription_uid, r.presc_state]).toEqual([DOC_NAME, PAT_NAME, "ind_fake0001", "rx_fake0001", "final"]);
    expect(r.room_id).toBe("room_abc");
    await ingestCatalogRows([mk("synth-cat-a")]);                                    // the box's next row carries none of them
    const again = await rowOf("synth-cat-a");
    expect([again.doctor_name, again.patient_name, again.individual_uid, again.prescription_uid, again.presc_state]).toEqual([DOC_NAME, PAT_NAME, "ind_fake0001", "rx_fake0001", "final"]);
    const admin = (await searchCatalog({ limit: 10, prescription_uid: "rx_fake0001" }, true)).rows;
    expect(admin.map((x) => x.consult_uid)).toEqual(["synth-cat-a"]);
    expect([admin[0].patient_name, admin[0].doctor_name, admin[0].individual_uid, admin[0].presc_state]).toEqual([PAT_NAME, DOC_NAME, "ind_fake0001", "final"]);
    const plain = (await searchCatalog({ limit: 10, doctor_uid: "DOC12345", from: "2026-10-12", to: "2026-10-12" })).rows;
    expect(Object.keys(plain[0])).not.toContain("patient_name");
    expect(JSON.stringify(plain)).not.toContain(PAT_NAME);
    expect((await searchCatalog({ limit: 10, individual_uid: "ind_fake0001" }, true)).rows).toHaveLength(1);
    expect((await searchCatalog({ limit: 10, individual_uid: "ind_nobody" }, true)).rows).toHaveLength(0);
    await ingestCatalogRows([{ consult_uid: "synth-cat-a", patient_name: null, doctor_name: null, individual_uid: null, prescription_uid: null, presc_state: null }]);
    expect((await rowOf("synth-cat-a")).patient_name).toBeNull();
    await ingestCatalogRows([{ consult_uid: "synth-cat-a", prescription: { prescription_uid: "rx-1", presc_state: "final" } }]);
  });

  it("the database CHECKs refuse a bad identity uid and an over-long name", async () => {
    await expect(ingestCatalogRows([{ consult_uid: "synth-cat-bad3", individual_uid: "has space" }])).rejects.toThrow();
    await expect(q("INSERT INTO encounter_catalog (consult_uid, patient_name) VALUES (?, ?)", "synth-cat-bad4", "x".repeat(201))).rejects.toThrow();
  });

  it("a prescription-only row for a consult the box has not sent yet inserts a thin row that the box row later fills", async () => {
    expect(await ingestCatalogRows([{ consult_uid: "synth-cat-early", prescription: { prescription_uid: "rx-9" } }])).toEqual({ updated: 0, inserted: 1 });
    expect((await rowOf("synth-cat-early")).ist_date).toBeNull();
    await ingestCatalogRows([mk("synth-cat-early", { ist_date: "2026-10-10" })]);
    const r = await rowOf("synth-cat-early");
    expect(r.ist_date).toBe("2026-10-10");
    expect(r.prescription).toEqual({ prescription_uid: "rx-9" });
  });

  it("the database CHECKs refuse what the validator should already have refused", async () => {
    await expect(ingestCatalogRows([{ consult_uid: "synth-cat-bad", source: "other" }])).rejects.toThrow();
    await expect(ingestCatalogRows([{ consult_uid: "synth-cat-bad2", first_gap: "has spaces" }])).rejects.toThrow();
    expect(await one("SELECT count(*)::int FROM encounter_catalog WHERE consult_uid LIKE 'synth-cat-bad%'")).toBe(0);   // the failing statement left nothing behind
  });

  const run = async (qs: string) => {
    const p = parseSearch(new URLSearchParams(qs));
    if (!p.ok) throw new Error(p.error);
    return searchCatalog(p.q);
  };
  const uids = (r: { rows: Array<Record<string, unknown>> }) => r.rows.map((x) => x.consult_uid);

  it("search filters: doctor, date range (inclusive), room, has_prescription; newest first; times come back as UTC ISO strings", async () => {
    expect(uids(await run("doctor_uid=DOC99999"))).toEqual(["synth-cat-b"]);
    expect(uids(await run("from=2026-10-12&to=2026-10-12"))).toEqual(["synth-cat-a"]);
    expect(uids(await run("from=2026-10-12"))).toEqual(["synth-cat-b", "synth-cat-a"]);
    expect(uids(await run("to=2026-10-11"))).toEqual(["synth-cat-c", "synth-cat-early"]);
    expect(uids(await run("room=room_xyz"))).toEqual(["synth-cat-b"]);
    expect(uids(await run("has_prescription=true"))).toEqual(["synth-cat-a", "synth-cat-early"]);
    expect(new Set(uids(await run("has_prescription=false")))).toEqual(new Set(["synth-cat-b", "synth-cat-c"]));
    expect(uids(await run("doctor_uid=DOC12345&room=room_abc&has_prescription=true&from=2026-10-12"))).toEqual(["synth-cat-a"]);
    const r = (await run("doctor_uid=DOC99999")).rows[0];
    expect([r.ist_date, r.t_open, r.updated_at === null]).toEqual(["2026-10-13", new Date(T_OPEN).toISOString(), false]);
    expect(Object.keys(r).sort()).toEqual(["allowance", "catalog_version", "clip", "consult_uid", "doctor_uid", "first_gap", "freescript", "generated_at", "ist_date", "layers", "prescription", "room_id", "source", "stages", "t_close", "t_open", "updated_at"]);
  });

  it("search pages with the cursor: every row exactly once, newest first, undated rows last, no row skipped at a page edge", async () => {
    await ingestCatalogRows([mk("synth-cat-d", { ist_date: "2026-10-12" }), mk("synth-cat-e", { ist_date: "2026-10-12" }), { consult_uid: "synth-cat-undated" }]);
    const all = await run("limit=500");
    expect(all.next_cursor).toBeNull();
    const expected = uids(all);
    expect(expected.length).toBe(Number(await one("SELECT count(*)::int FROM encounter_catalog")));
    expect(expected.slice(0, 2)).toEqual(["synth-cat-b", "synth-cat-e"]);          // 13 Oct first, then the 12 Oct rows by consult_uid descending
    expect(expected[expected.length - 1]).toBe("synth-cat-undated");
    for (const size of [1, 2, 3]) {
      const seen: unknown[] = [];
      let cursor: string | null = null;
      for (let guard = 0; guard < 50; guard += 1) {
        const page: Awaited<ReturnType<typeof run>> = await run(`limit=${size}${cursor ? "&cursor=" + cursor : ""}`);
        expect(page.rows.length).toBeLessThanOrEqual(size);
        seen.push(...uids(page));
        cursor = page.next_cursor;
        if (!cursor) break;
      }
      expect(seen).toEqual(expected);
    }
  });

  it("the rollback drops the table and its schema_migrations row, and the migration can be applied again", async () => {
    pg.exec(DOWN);
    expect(await one("SELECT to_regclass('encounter_catalog')::text")).toBeNull();
    expect(await one("SELECT count(*)::int FROM schema_migrations WHERE version = 168")).toBe(0);
    pg.exec(UP);
    expect(await one("SELECT count(*)::int FROM encounter_catalog")).toBe(0);
    expect(await one("SELECT count(*)::int FROM schema_migrations WHERE version = 168")).toBe(1);
  });
});

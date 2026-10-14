/**
 * encounter-catalog-pg.test.ts — migration 0168 and the catalog's SQL against a REAL postgres:16 (never on the Mini: the harness refuses there).
 * Only the driver is a stand-in: `@/lib/db` sql(text, params) runs through psql with the values bound as $1..$n. Ids are synthetic; no text anywhere.
 */
import { describe, it, expect, vi, beforeAll, afterAll } from "vitest";
import { readFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { dockerAvailable, pgContainer } from "../support/s1-pg";

const H = vi.hoisted(() => ({ tag: null as null | ((s: TemplateStringsArray, ...v: unknown[]) => Promise<unknown[]>), sqlText: null as null | ((t: string, p: unknown[]) => Promise<unknown[]>) }));
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
import { INGEST_SQL } from "@/lib/encounter-catalog/ingest-sql";
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
    H.sqlText = (t, p) => { const parts = t.split(/\$\d+/); return H.tag!(Object.assign(parts, { raw: parts }) as unknown as TemplateStringsArray, ...p); };
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
    expect(res).toEqual({ updated: 0, inserted: 3, stale: 0 });
    const r = await rowOf("synth-cat-a");
    expect(new Date(r.t_open as string).toISOString()).toBe(new Date(T_OPEN).toISOString());
    expect(new Date(r.t_close as string).getTime() - new Date(r.t_open as string).getTime()).toBe(600_000);
    expect(r.clip).toEqual({ r2_key: "consult-clips/x/consult.flac", minutes: 10 });
    expect((r.layers as { parts: unknown }).parts).toBeNull();
    expect([r.source, r.first_gap, r.catalog_version, r.prescription]).toEqual(["cutter", "freescript:none_yet", 1, null]);
    expect(await ingestCatalogRows(batch)).toEqual({ updated: 3, inserted: 0, stale: 0 });
    expect(await one("SELECT count(*)::int FROM encounter_catalog")).toBe(3);
  });

  it("is field-level: the prescription join sends only {consult_uid, prescription} and nothing else changes; the box's next row keeps the prescription; an explicit null clears it", async () => {
    const before = await rowOf("synth-cat-a");
    await new Promise((r) => setTimeout(r, 30));
    expect(await ingestCatalogRows([{ consult_uid: "synth-cat-a", prescription: { prescription_uid: "rx-1", presc_state: "final" } }])).toEqual({ updated: 1, inserted: 0, stale: 0 });
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

  it("the C3 join fills the identity columns by the same field-level upsert; the box row never blanks them; the (admin-only) search returns them", async () => {
    const c3 = { consult_uid: "synth-cat-a", doctor_name: DOC_NAME, patient_name: PAT_NAME, individual_uid: "ind_fake0001", prescription_uid: "rx_fake0001", presc_state: "final" };
    expect(await ingestCatalogRows([c3])).toEqual({ updated: 1, inserted: 0, stale: 0 });
    const r = await rowOf("synth-cat-a");
    expect([r.doctor_name, r.patient_name, r.individual_uid, r.prescription_uid, r.presc_state]).toEqual([DOC_NAME, PAT_NAME, "ind_fake0001", "rx_fake0001", "final"]);
    expect(r.room_id).toBe("room_abc");
    await ingestCatalogRows([mk("synth-cat-a")]);                                    // the box's next row carries none of them
    const again = await rowOf("synth-cat-a");
    expect([again.doctor_name, again.patient_name, again.individual_uid, again.prescription_uid, again.presc_state]).toEqual([DOC_NAME, PAT_NAME, "ind_fake0001", "rx_fake0001", "final"]);
    const admin = (await searchCatalog({ limit: 10, prescription_uid: "rx_fake0001" })).rows;
    expect(admin.map((x) => x.consult_uid)).toEqual(["synth-cat-a"]);
    expect([admin[0].patient_name, admin[0].doctor_name, admin[0].individual_uid, admin[0].presc_state]).toEqual([PAT_NAME, DOC_NAME, "ind_fake0001", "final"]);
    expect(admin[0].prescription).toEqual({ prescription_uid: "rx-1", presc_state: "final" });   // an admin sees the prescription jsonb too
    expect((await searchCatalog({ limit: 10, individual_uid: "ind_fake0001" })).rows).toHaveLength(1);
    expect((await searchCatalog({ limit: 10, individual_uid: "ind_nobody" })).rows).toHaveLength(0);
    await ingestCatalogRows([{ consult_uid: "synth-cat-a", patient_name: null, doctor_name: null, individual_uid: null, prescription_uid: null, presc_state: null }]);
    expect((await rowOf("synth-cat-a")).patient_name).toBeNull();
    await ingestCatalogRows([{ consult_uid: "synth-cat-a", prescription: { prescription_uid: "rx-1", presc_state: "final" } }]);
  });

  it("the database CHECKs refuse a bad identity uid and an over-long name", async () => {
    await expect(ingestCatalogRows([{ consult_uid: "synth-cat-bad3", individual_uid: "has space" }])).rejects.toThrow();
    await expect(q("INSERT INTO encounter_catalog (consult_uid, patient_name) VALUES (?, ?)", "synth-cat-bad4", "x".repeat(201))).rejects.toThrow();
  });

  it("a prescription-only row for a consult the box has not sent yet inserts a thin row that the box row later fills", async () => {
    expect(await ingestCatalogRows([{ consult_uid: "synth-cat-early", prescription: { prescription_uid: "rx-9" } }])).toEqual({ updated: 0, inserted: 1, stale: 0 });
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
    expect(Object.keys(r).sort()).toEqual(["allowance", "catalog_version", "clip", "consult_uid", "doctor_name", "doctor_uid", "first_gap", "freescript", "generated_at", "individual_uid", "ist_date", "layers", "patient_name", "presc_state", "prescription", "prescription_uid", "room_id", "source", "stages", "t_close", "t_open", "updated_at"]);
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

  it("C3 stale-write guard: an older generated_at never overwrites a newer row, an equal or newer one does, a row without generated_at is not guarded, and the skips are counted", async () => {
    const at = (iso: string, over: Record<string, unknown> = {}) => mk("synth-cat-g3", { generated_at: iso, ...over });
    expect(await ingestCatalogRows([at("2026-10-14T10:00:00Z", { first_gap: "from_10" })])).toEqual({ updated: 0, inserted: 1, stale: 0 });
    expect(await ingestCatalogRows([at("2026-10-14T09:00:00Z", { first_gap: "from_09" })])).toEqual({ updated: 0, inserted: 0, stale: 1 });      // a replayed old batch
    expect((await rowOf("synth-cat-g3")).first_gap).toBe("from_10");
    expect(await ingestCatalogRows([at("2026-10-14T10:00:00Z", { first_gap: "from_10b" })])).toEqual({ updated: 1, inserted: 0, stale: 0 });         // equal is not older
    expect(await ingestCatalogRows([at("2026-10-14T11:00:00Z", { first_gap: "from_11" })])).toEqual({ updated: 1, inserted: 0, stale: 0 });
    expect((await rowOf("synth-cat-g3")).first_gap).toBe("from_11");
    // C3's partial row has no generated_at: never guarded, and it leaves generated_at alone
    expect(await ingestCatalogRows([{ consult_uid: "synth-cat-g3", prescription_uid: "rx_fake0003" }])).toEqual({ updated: 1, inserted: 0, stale: 0 });
    const r = await rowOf("synth-cat-g3");
    expect([r.prescription_uid, r.first_gap, new Date(r.generated_at as string).toISOString()]).toEqual(["rx_fake0003", "from_11", "2026-10-14T11:00:00.000Z"]);
    // a null generated_at on the stored row (a thin row from C3) is filled by the box's row
    await ingestCatalogRows([{ consult_uid: "synth-cat-g3b", prescription_uid: "rx_fake0004" }]);
    expect(await ingestCatalogRows([at("2026-10-14T08:00:00Z", { consult_uid: "synth-cat-g3b" })])).toEqual({ updated: 1, inserted: 0, stale: 0 });
    // a mixed batch: the stale row is skipped and counted, the rest is applied, nothing is 409
    const mix = await ingestCatalogRows([at("2026-10-14T01:00:00Z", { first_gap: "old" }), mk("synth-cat-g3c", { generated_at: "2026-10-14T01:00:00Z" })]);
    expect(mix).toEqual({ updated: 0, inserted: 1, stale: 1 });
    expect((await rowOf("synth-cat-g3")).first_gap).toBe("from_11");
  });

  it("C3 RACE: a stale row that only loses on the lock re-check is skipped, not applied: the statement alone says 0/0/0, the rerun counts it stale and the newer data stands", async () => {
    await ingestCatalogRows([mk("synth-cat-g3r", { generated_at: "2026-10-14T10:00:00Z", first_gap: "base" })]);
    // Session A commits a NEWER generated_at (12:00) after 3 s; the ingest of an OLDER one (11:00) starts inside that window: its snapshot still sees 10:00 (not stale), its UPDATE waits for A, and the re-check
    // against the committed row skips it.
    const a = spawn("docker", ["exec", "-i", pg.name, "psql", "-qAt", "-v", "ON_ERROR_STOP=1", "-U", "postgres", "-d", "postgres"], { stdio: ["pipe", "pipe", "pipe"] });
    a.stdin.write("BEGIN; UPDATE encounter_catalog SET generated_at = '2026-10-14T12:00:00Z', first_gap = 'from_A' WHERE consult_uid = 'synth-cat-g3r'; SELECT pg_sleep(3); COMMIT;\n");
    a.stdin.end();
    const done = new Promise<void>((res) => a.on("close", () => res()));
    await new Promise((r) => setTimeout(r, 1000));
    const bare = (await H.sqlText!(INGEST_SQL, [JSON.stringify([mk("synth-cat-g3r", { generated_at: "2026-10-14T11:00:00Z", first_gap: "from_B_old" })])])) as Array<{ updated: number; inserted: number; stale: number }>;
    await done;
    expect(bare[0]).toEqual({ updated: 0, inserted: 0, stale: 0 });                    // skipped on the re-check, invisible to the snapshot count
    const r0 = await rowOf("synth-cat-g3r");
    expect([r0.first_gap, new Date(r0.generated_at as string).toISOString()]).toEqual(["from_A", "2026-10-14T12:00:00.000Z"]);
    // through the app the same overlap ends as a counted stale skip, never a 409 and never a lost newer write
    const b = spawn("docker", ["exec", "-i", pg.name, "psql", "-qAt", "-v", "ON_ERROR_STOP=1", "-U", "postgres", "-d", "postgres"], { stdio: ["pipe", "pipe", "pipe"] });
    b.stdin.write("BEGIN; UPDATE encounter_catalog SET generated_at = '2026-10-14T14:00:00Z', first_gap = 'from_A2' WHERE consult_uid = 'synth-cat-g3r'; SELECT pg_sleep(3); COMMIT;\n");
    b.stdin.end();
    const done2 = new Promise<void>((res) => b.on("close", () => res()));
    await new Promise((r) => setTimeout(r, 1000));
    const res = await ingestCatalogRows([mk("synth-cat-g3r", { generated_at: "2026-10-14T13:00:00Z", first_gap: "from_B_old2" })]);
    await done2;
    expect(res).toEqual({ updated: 0, inserted: 0, stale: 1, retried: true });
    expect((await rowOf("synth-cat-g3r")).first_gap).toBe("from_A2");
  });

  it("RACE: a post for a new consult_uid that overlaps another post's insert is not lost: the statement alone drops it (updated 0, inserted 0), the rerun updates it", async () => {
    const SQL = readFileSync("lib/encounter-catalog/ingest-sql.ts", "utf8");
    expect(SQL).toContain("ON CONFLICT (consult_uid) DO NOTHING");
    // Session A inserts the NEW uid and commits after 3 s; the ingest statement (session B) starts inside that window: its UPDATE does not see A's row, its INSERT waits for A and then loses.
    const a = spawn("docker", ["exec", "-i", pg.name, "psql", "-qAt", "-v", "ON_ERROR_STOP=1", "-U", "postgres", "-d", "postgres"], { stdio: ["pipe", "pipe", "pipe"] });
    a.stdin.write("BEGIN; INSERT INTO encounter_catalog (consult_uid, doctor_uid) VALUES ('synth-cat-race', 'DOC_FROM_A'); SELECT pg_sleep(3); COMMIT;\n");
    a.stdin.end();
    const done = new Promise<void>((res) => a.on("close", () => res()));
    await new Promise((r) => setTimeout(r, 1000));
    // one raw statement, exactly as the app sends it: no rerun, to show what the bare statement does
    const rows = JSON.stringify([{ consult_uid: "synth-cat-race", room_id: "room_from_b" }]);
    const bare = (await H.sqlText!(INGEST_SQL, [rows])) as Array<{ updated: number; inserted: number }>;
    await done;
    expect(bare[0]).toEqual({ updated: 0, inserted: 0, stale: 0 });                     // the lost write
    expect((await rowOf("synth-cat-race")).room_id).toBeNull();
    // the app: the same overlap again with a new uid, through ingestCatalogRows
    const b = spawn("docker", ["exec", "-i", pg.name, "psql", "-qAt", "-v", "ON_ERROR_STOP=1", "-U", "postgres", "-d", "postgres"], { stdio: ["pipe", "pipe", "pipe"] });
    b.stdin.write("BEGIN; INSERT INTO encounter_catalog (consult_uid, doctor_uid) VALUES ('synth-cat-race2', 'DOC_FROM_A'); SELECT pg_sleep(3); COMMIT;\n");
    b.stdin.end();
    const done2 = new Promise<void>((res) => b.on("close", () => res()));
    await new Promise((r) => setTimeout(r, 1000));
    const res = await ingestCatalogRows([{ consult_uid: "synth-cat-race2", room_id: "room_from_b" }]);
    await done2;
    expect(res).toEqual({ updated: 1, inserted: 0, stale: 0, retried: true });
    const r2 = await rowOf("synth-cat-race2");
    expect([r2.doctor_uid, r2.room_id]).toEqual(["DOC_FROM_A", "room_from_b"]);   // A's column kept, B's write applied: nothing lost
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

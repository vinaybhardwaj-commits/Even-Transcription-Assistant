/**
 * spine-ingest-pg.test.ts — Spine S1 ingest SQL against a REAL postgres:16 (never on the Mini). Migration 0173 is the schema; the three proxy tables are minimal stand-ins
 * carrying only the columns the ingest reads. Only the driver is a stand-in (see encounter-catalog-pg.test.ts). Ids are synthetic; no text anywhere.
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

import { ingestSpineSignals, storeSignals } from "@/lib/spine/ingest-store";

const HAVE_DOCKER = dockerAvailable();
const ALLOW_SKIP = process.env.ETA_ALLOW_SKIP_E2E === "1";
const pg = pgContainer("eta-spine-ingest");
const UP = readFileSync("db/migrations/0173_spine.sql", "utf8");

describe("REQUIRED PROOF — spine ingest runs against a real postgres", () => {
  it("ran, or was skipped deliberately", () => {
    if (HAVE_DOCKER || ALLOW_SKIP) return;
    throw new Error("REQUIRED PROOF NOT RUN: tests/unit/spine-ingest-pg.test.ts needs Docker for postgres:16 (not on the Mini). Run it on c3 / the lab box, or set ETA_ALLOW_SKIP_E2E=1 to accept that it was not proven.");
  });
});

const NOW = Date.parse("2026-10-18T06:00:00Z");
const T0 = Date.parse("2026-10-18T04:00:00Z");
const d = HAVE_DOCKER ? describe : describe.skip;
const q = async (text: string, ...v: unknown[]): Promise<Array<Record<string, unknown>>> => {
  const parts = text.split("?");
  return (await H.tag!(Object.assign(parts, { raw: parts }) as unknown as TemplateStringsArray, ...v)) as Array<Record<string, unknown>>;
};
const count = async (where = "true") => Number(Object.values((await q(`SELECT count(*)::int FROM spine_signal WHERE ${where}`))[0])[0]);
const setConfig = (key: string, json: string) => pg.exec(`INSERT INTO spine_config (key, value) VALUES ('${key}', '${json}') ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value;`);
const clearConfig = () => pg.exec("DELETE FROM spine_config;");

d("spine ingest on postgres:16", () => {
  beforeAll(() => {
    pg.start();
    H.tag = pg.sql;
    pg.exec("CREATE TABLE schema_migrations (version integer PRIMARY KEY, name text NOT NULL);");
    pg.exec(UP);
    pg.exec(`
      CREATE TABLE room_day (id text PRIMARY KEY, room_id text NOT NULL);
      CREATE TABLE eta_encounter_windows (consult_key text PRIMARY KEY, consult_uid text, room_id text, t_open timestamptz NOT NULL, t_close timestamptz, close_reason text NOT NULL, quality text NOT NULL, computed_at timestamptz NOT NULL DEFAULT now());
      CREATE TABLE encounter_hypothesis_run (id text PRIMARY KEY, room_day_id text NOT NULL, source text NOT NULL DEFAULT 'acoustic', smoother_version text NOT NULL DEFAULT 'sv', created_at timestamptz NOT NULL DEFAULT now());
      CREATE TABLE encounter_hypothesis (id text PRIMARY KEY, run_id text NOT NULL, room_day_id text NOT NULL, start_ms bigint NOT NULL, end_ms bigint NOT NULL, closed_by text NOT NULL, created_at timestamptz NOT NULL DEFAULT now());
      CREATE TABLE encounter_timeline_shadow (id text PRIMARY KEY, run_id text NOT NULL, room_day_id text NOT NULL, consult_key text NOT NULL, start_ms bigint NOT NULL, end_ms bigint NOT NULL, closed_by text NOT NULL, created_at timestamptz NOT NULL DEFAULT now());
      INSERT INTO room_day VALUES ('rd_abcd2345', 'room_abcd2345');
      INSERT INTO eta_encounter_windows VALUES
        ('enc_testaaaaaaaaaaaa@mach_test', 'enc_testaaaaaaaaaaaa', 'room_abcd2345', '2026-10-18T04:00:00Z', '2026-10-18T04:10:00Z', 'endConsult', 'clean', '2026-10-18T04:11:00Z'),
        ('enc_testbbbbbbbbbbbb@mach_test', 'enc_testbbbbbbbbbbbb', 'room_abcd2345', '2026-10-18T04:30:00Z', NULL, 'open', 'unclosed', '2026-10-18T04:31:00Z'),
        ('enc_testoldoldoldx@mach_test', 'enc_testoldoldoldx', 'room_abcd2345', '2026-10-01T04:00:00Z', '2026-10-01T04:10:00Z', 'endConsult', 'clean', '2026-10-01T04:11:00Z');
      INSERT INTO encounter_hypothesis_run VALUES ('hr_test_01', 'rd_abcd2345', 'acoustic', '2026-10-18T04:12:00Z');
      INSERT INTO encounter_hypothesis VALUES ('eh_abcdefghjkmn', 'hr_test_01', 'rd_abcd2345', ${T0}, ${T0 + 600000}, 'non_speech', '2026-10-18T04:12:00Z');
      INSERT INTO encounter_timeline_shadow VALUES
        ('tl_test_01', 'run_test_01', 'rd_abcd2345', 'enc_testaaaaaaaaaaaa@mach_test', ${T0}, ${T0 + 590000}, 'patient_left', '2026-10-18T04:12:00Z'),
        ('tl_test_02', 'run_test_02', 'rd_abcd2345', 'enc_testaaaaaaaaaaaa@mach_test', ${T0}, ${T0 + 600000}, 'patient_left', '2026-10-18T05:12:00Z');
    `);
  });
  afterAll(() => { pg.stop(); });

  it("with no config, or off, or malformed, or killed: a no-op that writes nothing, not even a tick", async () => {
    expect(await ingestSpineSignals(NOW)).toEqual({ skipped: "off" });
    for (const [k, v] of [["ingest", '"off"'], ["ingest", '"banana"'], ["ingest", "42"]] as const) { clearConfig(); setConfig(k, v); expect(await ingestSpineSignals(NOW), `${k}=${v}`).toEqual({ skipped: "off" }); }
    clearConfig(); setConfig("ingest", '"shadow"'); setConfig("kill_switch", '{"on": true}');
    expect(await ingestSpineSignals(NOW)).toEqual({ skipped: "off" });
    expect(await count()).toBe(0);
    expect(Number(Object.values((await q("SELECT count(*)::int FROM spine_tick"))[0])[0])).toBe(0);
  });

  it("shadow writes the rows inside the 72 h horizon (pulse 2, acoustic 1, timeline 1 from the newest run) and one tick", async () => {
    clearConfig(); setConfig("ingest", '"shadow"'); setConfig("kill_switch", '{"on": false}');
    const res = await ingestSpineSignals(NOW);
    expect(res).toMatchObject({ mode: "shadow", read: { pulse: 2, acoustic: 1, timeline: 1 }, inserted: { pulse: 2, acoustic: 1, timeline: 1 } });
    expect(await count()).toBe(4);
    const tl = (await q("SELECT source_rev, room_id, t_close, attrs FROM spine_signal WHERE proxy = 'timeline'"))[0];
    expect([tl.source_rev, tl.room_id, new Date(tl.t_close as string).getTime()]).toEqual([1, "room_abcd2345", T0 + 600000]);   // the newest run's row
    expect(tl.attrs).toEqual({ ids: { shadow_id: "tl_test_02", run_id: "run_test_02", consult_key: "enc_testaaaaaaaaaaaa@mach_test", }, close_reason: "patient_left" });
    expect(Number(Object.values((await q("SELECT count(*)::int FROM spine_tick"))[0])[0])).toBe(1);
  });

  it("a second pass with nothing changed inserts nothing; a moved t_close and a closing window each add rev 2, and the old rev stays", async () => {
    expect(await ingestSpineSignals(NOW)).toMatchObject({ inserted: { pulse: 0, acoustic: 0, timeline: 0 } });
    pg.exec("UPDATE eta_encounter_windows SET t_close = '2026-10-18T04:12:00Z' WHERE consult_key = 'enc_testaaaaaaaaaaaa@mach_test'; UPDATE eta_encounter_windows SET t_close = '2026-10-18T04:40:00Z', close_reason = 'endConsult' WHERE consult_key = 'enc_testbbbbbbbbbbbb@mach_test'; UPDATE eta_encounter_windows SET computed_at = now();");
    expect(await ingestSpineSignals(NOW)).toMatchObject({ inserted: { pulse: 2, acoustic: 0, timeline: 0 } });
    expect(await ingestSpineSignals(NOW)).toMatchObject({ inserted: { pulse: 0, acoustic: 0, timeline: 0 } });
    const revs = (await q("SELECT source_key, source_rev FROM spine_signal WHERE proxy = 'pulse' ORDER BY 1, 2")).map((r) => `${r.source_key}:${r.source_rev}`);
    expect(revs).toEqual(["enc_testaaaaaaaaaaaa@mach_test:1", "enc_testaaaaaaaaaaaa@mach_test:2", "enc_testbbbbbbbbbbbb@mach_test:1", "enc_testbbbbbbbbbbbb@mach_test:2"]);
  });

  it("storeSignals: an explicit rev twice is a duplicate; with no rev the rev rule applies; the attrs CHECK still refuses a stray key", async () => {
    const s = { proxy: "pqm" as const, source_key: "pqm_a1b2c3d4e5f6a7b8c9d0e1", room_id: "room_abcd2345", t_open: "2026-10-18T04:00:00.000Z", t_close: "2026-10-18T04:10:00.000Z", observed_at: "2026-10-18T04:20:00.000Z", attrs: { close_reason: "pqm" } };
    expect(await storeSignals([{ ...s, source_rev: 1 }])).toEqual({ inserted: 1, duplicate: 0, conflict: 0 });
    expect(await storeSignals([{ ...s, source_rev: 1 }])).toEqual({ inserted: 0, duplicate: 1, conflict: 0 });
    expect(await storeSignals([s])).toEqual({ inserted: 0, duplicate: 1, conflict: 0 });                                               // unchanged: same hash as stored rev 1
    expect(await storeSignals([{ ...s, t_close: "2026-10-18T04:15:00.000Z" }])).toEqual({ inserted: 1, duplicate: 0, conflict: 0 });   // moved: rev 2
    expect(await count("proxy = 'pqm' AND source_rev = 2")).toBe(1);
    await expect(storeSignals([{ ...s, source_key: "pqm_test_bad", source_rev: 1, attrs: { stray: 1 } as never }])).rejects.toThrow();
  });
});

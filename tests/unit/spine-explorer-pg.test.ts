/**
 * spine-explorer-pg.test.ts — Spine S4b explorer reads against a REAL postgres:16 with migration 0173 (never on the Mini). Fixture: 2 rooms, 3 encounters (one ambiguous, one merged), links, signals, jobs in 4 states, artefacts.
 * Ids are synthetic; no text anywhere.
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

import { dayView, encounterDetail, encounterPage, parsePage, readExplorerEnabled } from "@/lib/spine/explorer-read";

const HAVE_DOCKER = dockerAvailable();
const ALLOW_SKIP = process.env.ETA_ALLOW_SKIP_E2E === "1";
const pg = pgContainer("eta-spine-explorer");
const UP = readFileSync("db/migrations/0173_spine.sql", "utf8");
const NOW = Date.parse("2026-10-18T06:00:00Z");
const A = "enc_testaaaaaaaaaaaa", B = "enc_testbbbbbbbbbbbb", C = "enc_testcccccccccccc";

describe("REQUIRED PROOF — the explorer reads run against a real postgres", () => {
  it("ran, or was skipped deliberately", () => {
    if (HAVE_DOCKER || ALLOW_SKIP) return;
    throw new Error("REQUIRED PROOF NOT RUN: tests/unit/spine-explorer-pg.test.ts needs Docker for postgres:16 (not on the Mini). Run it on c3 / the lab box, or set ETA_ALLOW_SKIP_E2E=1 to accept that it was not proven.");
  });
});

const d = HAVE_DOCKER ? describe : describe.skip;
d("explorer reads on postgres:16", () => {
  beforeAll(() => {
    pg.start();
    H.tag = pg.sql;
    pg.exec("CREATE TABLE schema_migrations (version integer PRIMARY KEY, name text NOT NULL);");
    pg.exec(UP);
  });
  afterAll(() => { pg.stop(); });

  it("empty tables: flag off, no rooms, empty page, unknown encounter", async () => {
    expect(await readExplorerEnabled()).toBe(false);
    expect(await dayView({ ist_date: "2026-10-18" }, NOW)).toEqual({ ist_date: "2026-10-18", rooms: [] });
    expect(await encounterPage({ ist_date: "2026-10-18", limit: 100 })).toEqual({ rows: [], next_cursor: null });
    expect(await encounterDetail(A)).toBeNull();
  });

  it("the flag reads true/shadow, and a jsonb string 'off' is off", async () => {
    pg.exec(`INSERT INTO spine_config (key, value) VALUES ('explorer', '"shadow"')`);
    expect(await readExplorerEnabled()).toBe(true);
    pg.exec(`UPDATE spine_config SET value = '"off"' WHERE key = 'explorer'`);
    expect(await readExplorerEnabled()).toBe(false);
    pg.exec(`UPDATE spine_config SET value = '{"mode":"shadow"}' WHERE key = 'explorer'`);
    expect(await readExplorerEnabled()).toBe(true);
  });

  describe("fixture", () => {
    beforeAll(() => {
      pg.exec(`
        INSERT INTO spine_encounter (encounter_id, ist_date, room_id, t_open, t_close, status, merged_into, anchor_proxy, merge_version, reason, flags) VALUES
          ('${A}', '2026-10-18', 'room_r1', '2026-10-18T04:00:00Z', '2026-10-18T04:20:00Z', 'confirmed', NULL, 'pulse', 'mv1', 'strong', '{ambiguous,multi_machine}'),
          ('${B}', '2026-10-18', 'room_r1', '2026-10-18T04:05:00Z', '2026-10-18T04:15:00Z', 'merged', '${A}', 'pqm', 'mv1', 'merged', '{}'),
          ('${C}', '2026-10-18', 'room_r2', '2026-10-18T05:00:00Z', NULL, 'candidate', NULL, 'cutter', 'mv1', 'weak_single', '{pulse_overlap}'),
          ('enc_testdddddddddddd', '2026-10-17', 'room_r1', '2026-10-17T04:00:00Z', NULL, 'confirmed', NULL, 'pulse', 'mv1', 'strong', '{}');
        INSERT INTO spine_link (encounter_id, key_kind, value, basis, active) VALUES
          ('${A}', 'consult_uid', 'uid_test_01', 'exact', true), ('${A}', 'pqm_uid', 'pqm_test_01', 'overlap', true), ('${A}', 'window_id', 'win_test_01', 'merge', false);
        INSERT INTO spine_signal (proxy, source_key, source_rev, room_id, t_open, t_close, observed_at, encounter_id, attrs) VALUES
          ('pulse', 'pk_test_01', 1, 'room_r1', '2026-10-18T04:00:00Z', NULL, '2026-10-18T04:01:00Z', '${A}', '{}'),
          ('pulse', 'pk_test_01', 2, 'room_r1', '2026-10-18T04:00:00Z', '2026-10-18T04:20:00Z', '2026-10-18T04:21:00Z', '${A}', '{"close_reason":"endConsult","ids":{"consult_uid":"uid_test_01"}}'),
          ('pqm', 'pqm_test_01', 1, 'room_r1', '2026-10-18T04:05:00Z', '2026-10-18T04:15:00Z', '2026-10-18T04:16:00Z', '${B}', '{}'),
          ('cutter', 'ck_test_01', 1, 'room_r2', '2026-10-18T05:00:00Z', NULL, '2026-10-18T05:01:00Z', '${C}', '{}'),
          ('acoustic', 'ak_test_01', 1, 'room_r1', '2026-10-18T04:30:00Z', NULL, '2026-10-18T04:31:00Z', NULL, '{}'),
          ('acoustic', 'ak_test_02', 1, 'room_r1', '2026-10-17T04:30:00Z', NULL, '2026-10-17T04:31:00Z', NULL, '{}');
        INSERT INTO spine_job (encounter_id, stage, cut_version, input_key, status, attempts, next_attempt_at, last_error_class, last_error_code, created_at) VALUES
          ('${A}', 'transcribe', 'cv1', 'ik_1', 'queued', 0, '2026-10-18T05:30:00Z', NULL, NULL, '2026-10-18T05:00:00Z'),
          ('${A}', 'transcribe', 'cv1', 'ik_2', 'queued', 0, NULL, NULL, NULL, '2026-10-18T05:30:00Z'),
          ('${A}', 'diarize', 'cv1', 'ik_1', 'shadow', 0, NULL, NULL, NULL, '2026-10-18T05:00:00Z'),
          ('${C}', 'transcribe', 'cv1', 'ik_1', 'done', 1, NULL, NULL, NULL, '2026-10-18T05:10:00Z'),
          ('${C}', 'note', 'cv1', 'ik_1', 'failed', 3, '2026-10-18T06:30:00Z', 'transient', 'http_503', '2026-10-18T05:20:00Z'),
          ('${C}', 'note', 'cv0', 'ik_1', 'superseded', 1, NULL, NULL, NULL, '2026-10-18T05:05:00Z');
        INSERT INTO spine_artefact (encounter_id, stage, engine, version, cfg8, cut_version, store, bucket, object_key, sha256, status) VALUES
          ('${A}', 'transcribe', 'eng_test', 'v1', 'cfg00001', 'cv1', 'r2', 'bkt_test', 'obj/test/a1', 'sha_test_01', 'ok'),
          ('${C}', 'transcribe', 'eng_test', 'v1', 'cfg00001', 'cv1', 'r2', 'bkt_test', 'obj/test/c1', 'sha_test_02', 'ok'),
          ('${C}', 'diarize', 'eng_test', 'v1', 'cfg00001', 'cv1', 'box', NULL, NULL, NULL, 'empty');
      `);
    });

    it("day: exact counts per room; only the asked IST date; a signal counts once however many revs", async () => {
      const out = await dayView({ ist_date: "2026-10-18" }, NOW);
      expect(out.rooms.map((r) => r.room_id)).toEqual(["room_r1", "room_r2"]);
      const [r1, r2] = out.rooms;
      expect(r1!.encounters).toEqual({ candidate: 0, confirmed: 1, rejected: 0, merged: 1, total: 2 });
      expect(r1!.flags).toEqual({ ambiguous: 1, multi_machine: 1, pulse_overlap: 0 });
      expect(r1!.signals_by_proxy).toMatchObject({ pulse: 1, pqm: 1, acoustic: 1, cutter: 0 });
      expect(r1!.jobs_by_stage).toEqual({
        transcribe: { queued: 2, leased: 0, done: 0, failed: 0, dead: 0, superseded: 0, shadow: 0, oldest_queued_age_s: 3600 },
        diarize: { queued: 0, leased: 0, done: 0, failed: 0, dead: 0, superseded: 0, shadow: 1, oldest_queued_age_s: null },
      });
      expect(r2!.encounters).toEqual({ candidate: 1, confirmed: 0, rejected: 0, merged: 0, total: 1 });
      expect(r2!.flags).toEqual({ ambiguous: 0, multi_machine: 0, pulse_overlap: 1 });
      expect(r2!.signals_by_proxy).toMatchObject({ cutter: 1, pulse: 0 });
      expect(r2!.jobs_by_stage.note).toMatchObject({ failed: 1, superseded: 1, queued: 0, oldest_queued_age_s: null });
      expect(r2!.jobs_by_stage.transcribe).toMatchObject({ done: 1 });
      const one = await dayView({ ist_date: "2026-10-18", room_id: "room_r2" }, NOW);
      expect(one.rooms.map((r) => r.room_id)).toEqual(["room_r2"]);
      expect((await dayView({ ist_date: "2026-10-17" }, NOW)).rooms.map((r) => [r.room_id, r.encounters.total, r.signals_by_proxy.acoustic])).toEqual([["room_r1", 1, 1]]);
    });

    it("encounters: shapes, the flag filter (@>), status, room, and keyset paging", async () => {
      const all = await encounterPage({ ist_date: "2026-10-18", limit: 100 });
      expect(all.next_cursor).toBeNull();
      expect(all.rows.map((r) => r.encounter_id)).toEqual([A, B, C]);
      expect(all.rows[0]).toEqual({
        encounter_id: A, ist_date: "2026-10-18", room_id: "room_r1", t_open: "2026-10-18T04:00:00.000Z", t_close: "2026-10-18T04:20:00.000Z", status: "confirmed", merged_into: null, anchor_proxy: "pulse",
        boundary_rev: 0, merge_version: "mv1", reason: "strong", flags: ["ambiguous", "multi_machine"], created_at: expect.any(String), updated_at: expect.any(String),
        proxies_seen: ["pulse"], jobs: { transcribe: "queued", diarize: "shadow" }, artefact_count: 1,
      });
      expect(all.rows[1]).toMatchObject({ status: "merged", merged_into: A, proxies_seen: ["pqm"], jobs: {}, artefact_count: 0 });
      expect(all.rows[2]).toMatchObject({ t_close: null, proxies_seen: ["cutter"], jobs: { transcribe: "done", note: "failed" }, artefact_count: 2 });
      const amb = await encounterPage({ ist_date: "2026-10-18", flag: "ambiguous", limit: 100 });
      expect(amb.rows.map((r) => r.encounter_id)).toEqual([A]);
      expect((await encounterPage({ ist_date: "2026-10-18", status: "merged", limit: 100 })).rows.map((r) => r.encounter_id)).toEqual([B]);
      expect((await encounterPage({ ist_date: "2026-10-18", room_id: "room_r2", limit: 100 })).rows.map((r) => r.encounter_id)).toEqual([C]);
      const p1 = await encounterPage({ ist_date: "2026-10-18", limit: 2 });
      expect(p1.rows.map((r) => r.encounter_id)).toEqual([A, B]);
      expect(p1.next_cursor).not.toBeNull();
      const parsed = parsePage(new URLSearchParams({ ist_date: "2026-10-18", limit: "2", cursor: p1.next_cursor! }));
      expect(parsed.ok).toBe(true);
      const p2 = await encounterPage((parsed as { q: Parameters<typeof encounterPage>[0] }).q);
      expect(p2.rows.map((r) => r.encounter_id)).toEqual([C]);
      expect(p2.next_cursor).toBeNull();
    });

    it("encounter: the row, links, signals (no attrs beyond close_reason), jobs, artefacts; a merged one shows merged_into", async () => {
      const a = (await encounterDetail(A))!;
      expect(a.encounter).toMatchObject({ encounter_id: A, status: "confirmed", merged_into: null, flags: ["ambiguous", "multi_machine"] });
      expect(a.links).toEqual([
        { key_kind: "consult_uid", value: "uid_test_01", basis: "exact", active: true },
        { key_kind: "pqm_uid", value: "pqm_test_01", basis: "overlap", active: true },
        { key_kind: "window_id", value: "win_test_01", basis: "merge", active: false },
      ]);
      expect(a.signals).toEqual([
        { proxy: "pulse", source_key: "pk_test_01", source_rev: 1, t_open: "2026-10-18T04:00:00.000Z", t_close: null, close_reason: null },
        { proxy: "pulse", source_key: "pk_test_01", source_rev: 2, t_open: "2026-10-18T04:00:00.000Z", t_close: "2026-10-18T04:20:00.000Z", close_reason: "endConsult" },
      ]);
      expect(a.jobs.map((j) => [j.stage, j.cut_version, j.status, j.attempts])).toEqual([["diarize", "cv1", "shadow", 0], ["transcribe", "cv1", "queued", 0], ["transcribe", "cv1", "queued", 0]]);
      expect(a.jobs[1]).toEqual({ stage: "transcribe", cut_version: "cv1", status: "queued", attempts: 0, next_attempt_at: "2026-10-18T05:30:00.000Z", last_error_class: null, last_error_code: null });
      expect(a.artefacts).toEqual([{ stage: "transcribe", engine: "eng_test", version: "v1", cut_version: "cv1", store: "r2", bucket: "bkt_test", object_key: "obj/test/a1", sha256: "sha_test_01", status: "ok" }]);
      const c = (await encounterDetail(C))!;
      expect(c.jobs.find((j) => j.status === "failed")).toMatchObject({ attempts: 3, last_error_class: "transient", last_error_code: "http_503" });
      expect((await encounterDetail(B))!.encounter).toMatchObject({ status: "merged", merged_into: A });
      expect(await encounterDetail("enc_testeeeeeeeeeeee")).toBeNull();
    });
  });
});

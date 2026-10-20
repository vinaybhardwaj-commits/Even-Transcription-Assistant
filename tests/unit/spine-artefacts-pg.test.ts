/**
 * spine-artefacts-pg.test.ts — Spine S3 artefact index against a REAL postgres:16 (never on the Mini), with the source tables built from
 * their own migrations (0135, 0140, 0150, 0157, 0168/0169) and the spine tables from 0173. Synthetic ids; no text anywhere.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { ROOM_STUBS_SQL } from "../support/spine-room-stubs";
import { dockerAvailable, pgContainer } from "../support/s1-pg";
import { hash8, SOURCES, SOURCE_DEFS, sourceSelect, INSERT_SQL, CURSOR_UPSERT_SQL, EXISTING_SQL, CONFIG_SQL, mapRow, parseArtefactsMode, planArtefacts } from "@/lib/spine/artefacts";
import type { SourceRow } from "@/lib/spine/artefacts";
import { indexSpineArtefacts } from "@/lib/spine/artefacts-store";
import type { SpineDb } from "@/lib/spine/artefacts-store";

const HAVE_DOCKER = dockerAvailable();
const ALLOW_SKIP = process.env.ETA_ALLOW_SKIP_E2E === "1";
const pg = pgContainer("eta-spine-artefacts");
const mig = (f: string) => readFileSync(`db/migrations/${f}`, "utf8");
const NO_BLIND = { blindDays: [] as Array<readonly [string, string]> };
const NOW = new Date("2026-10-19T10:00:00Z");

describe("REQUIRED PROOF — spine artefact index runs against a real postgres", () => {
  it("ran, or was skipped deliberately", () => {
    if (HAVE_DOCKER || ALLOW_SKIP) return;
    throw new Error("REQUIRED PROOF NOT RUN: tests/unit/spine-artefacts-pg.test.ts needs Docker for postgres:16 (not on the Mini). Run it on c3 / the lab box, or set ETA_ALLOW_SKIP_E2E=1 to accept that it was not proven.");
  });
});

// ── pure parts: no docker needed ──
describe("spine artefacts: pure mapping and gate", () => {
  it("the mode is off unless the config says shadow or live ('on' is malformed)", () => {
    for (const v of [undefined, null, "", "OFF", "yes", 1, true, [], {}, { mode: "ON" }, { mode: 1 }, "onn", "on", { mode: "on" }, "Shadow", " live"]) expect(parseArtefactsMode(v)).toBe("off");
    expect(parseArtefactsMode("live")).toBe("live");
    expect(parseArtefactsMode({ mode: "live" })).toBe("live");
    expect(parseArtefactsMode("shadow")).toBe("shadow");
  });
  it("every SELECT is a SELECT: no INSERT/UPDATE/DELETE/DDL word in any source statement", () => {
    for (const s of SOURCES) {
      const q = sourceSelect(s);
      expect(q, s).toMatch(/^SELECT /);
      expect(q, s).not.toMatch(/\b(insert|update|delete|truncate|alter|drop|create|grant)\b/i);
    }
    expect(CONFIG_SQL + EXISTING_SQL).not.toMatch(/\b(insert|update|delete|truncate|alter|drop|create)\b/i);
  });
  it("the only write statement targets spine_artefact and never overwrites", () => {
    expect(INSERT_SQL).toMatch(/^INSERT INTO spine_artefact \(/);
    expect(INSERT_SQL).toMatch(/ON CONFLICT ON CONSTRAINT spine_artefact_key_uq DO NOTHING/);
    expect(INSERT_SQL).not.toMatch(/\bDO UPDATE\b|\bUPDATE\b|\bDELETE\b/i);
  });
  it("each source's SELECT column list is exactly its ref columns; no body, text, name or prescription column anywhere", () => {
    expect(SOURCE_DEFS.consult_index.columns).toEqual(["s.consult_uid", "s.cut_version", "s.code_commit", "s.clip_r2_key", "s.source_sha256", expect.stringMatching(/ AS blind$/), "l.encounter_id"]);
    expect(SOURCE_DEFS.consult_sarvam_result.columns).toEqual(["s.consult_uid", "s.cut_version", "s.mode", "s.english", "s.model_rev", "s.pipeline_rev", "s.result_r2_key", expect.stringMatching(/ AS blind$/), "l.encounter_id"]);
    expect(SOURCE_DEFS.freescript_run.columns.slice(0, 5)).toEqual(["s.id", "s.consult_uid", "s.schema_version", "s.state", "s.input_sha256"]);
    const FORBIDDEN = /\b(turns_json|config|artifact|validator_errors|completion_required|doctor_name|patient_name|prescription_uid|presc_uid|individual_uid|prescription|transcript\w*|text|note|english_chars|stages|allowance|freescript|jev|clef_affect|presence)\b/i;
    for (const s of SOURCES) {
      if (s in SOURCE_DEFS) expect(SOURCE_DEFS[s as keyof typeof SOURCE_DEFS].columns.join(", ").replace(/::text\b/g, ""), s).not.toMatch(FORBIDDEN);
      expect(sourceSelect(s).replace(/freescript_artifact|freescript_run|encounter_catalog/g, ""), s).not.toMatch(/\b(turns_json|validator_errors|completion_required|doctor_name|patient_name|prescription_uid|presc_uid|individual_uid)\b/i);
    }
  });
  it("mapRow refuses a row with a missing key or an unknown status instead of guessing", () => {
    expect(mapRow("reb_track_index", { layer: "stt", engine: "e", version: "v", config_hash: "abcd1234ef", r2_key: "k", sha256: null, status: "weird" })).toBeNull();
    expect(mapRow("consult_index", { clip_r2_key: null, cut_version: "cv1" })).toBeNull();
    expect(mapRow("encounter_catalog", { layer: "stt", r2_key: "k", status: "mystery" })).toBeNull();
  });
  it("planArtefacts places by encounter_id only: a row without one is an orphan, whatever else it carries", () => {
    const row = { encounter_id: null, consult_uid: "cu_test_x", cut_version: "cv1", clip_r2_key: "consult-clips/x", source_sha256: "a".repeat(64), room_id: "room_a", t0_ms: 1 } as SourceRow;
    const p = planArtefacts([{ source: "consult_index", row }], []);
    expect(p.inserts).toEqual([]);
    expect(p.counts.orphans).toEqual({ consult_index: 1 });
  });
});

// ── the pg part ──
const E1 = "enc_testaaaaaaaaaaaa";
const E2 = "enc_testbbbbbbbbbbbb";
const SHA_A = "a".repeat(64);
const SHA_B = "b".repeat(64);
const d = HAVE_DOCKER ? describe : describe.skip;
d("spine artefact index on postgres:16", () => {
  let log: string[] = [];
  const db: SpineDb = (text, params = []) => {
    log.push(text);
    const bits = text.split(/\$(\d+)/);   // [text, n, text, n, ...]: a placeholder may repeat or come out of order
    const parts = bits.filter((_, i) => i % 2 === 0);
    const vals = bits.filter((_, i) => i % 2 === 1).map((n) => params[Number(n) - 1]);
    if (new Set(bits.filter((_, i) => i % 2 === 1).map(Number)).size !== params.length) throw new Error("test driver: placeholders and params differ");
    return pg.sql(Object.assign(parts, { raw: parts }) as unknown as TemplateStringsArray, ...vals);
  };
  const rows = async (text: string): Promise<Array<Record<string, unknown>>> => (await db(text, [])) as Array<Record<string, unknown>>;
  const one = async (text: string) => Object.values((await rows(text))[0] ?? {})[0];
  const setMode = (v: string | null) => {
    pg.exec("DELETE FROM spine_config WHERE key = 'artefacts';");
    if (v !== null) pg.exec(`INSERT INTO spine_config (key, value) VALUES ('artefacts', '${v}'::jsonb);`);
  };
  const artefacts = () => rows("SELECT encounter_id, stage, engine, version, cfg8, cut_version, store, bucket, object_key, sha256, status, source_table FROM spine_artefact ORDER BY source_table, stage, engine, object_key");

  beforeAll(() => {
    pg.start();
    pg.exec("CREATE TABLE schema_migrations (version integer PRIMARY KEY, name text NOT NULL); " + ROOM_STUBS_SQL);
    pg.exec("CREATE TABLE diarize_window_label (id serial PRIMARY KEY, engine text);");   // 0140 alters it; stub only
    for (const f of ["0135_reb_track_index.sql", "0140_diarize_nemotron.sql", "0150_consult_index.sql", "0157_freescript.sql", "0168_encounter_catalog.sql", "0169_encounter_catalog_c4.sql", "0173_spine.sql"]) pg.exec(mig(f));
    pg.exec(`
      INSERT INTO spine_encounter (encounter_id, ist_date, room_id, t_open, t_close, status, merge_version) VALUES
        ('${E1}', '2026-10-19', 'room_a', '2026-10-19T04:00:00Z', '2026-10-19T04:30:00Z', 'confirmed', 'mv1'),
        ('${E2}', '2026-10-19', 'room_b', '2026-10-19T05:00:00Z', '2026-10-19T05:30:00Z', 'confirmed', 'mv1');
      INSERT INTO spine_link (encounter_id, key_kind, value, basis) VALUES
        ('${E1}', 'consult_uid', 'cu_test_01', 'exact'), ('${E2}', 'window_id', 'bw_test_01', 'exact');
      -- an INACTIVE link must not place anything
      INSERT INTO spine_link (encounter_id, key_kind, value, basis, active) VALUES ('${E2}', 'consult_uid', 'cu_test_old', 'exact', false);

      INSERT INTO consult_index (consult_uid, room_id, room_slug, ist_date, t0_ms, t1_ms, clip_r2_key, cut_version, code_commit, source_sha256) VALUES
        ('cu_test_01', 'room_a', 'ra', '2026-10-19', 1792382400000, 1792383000000, 'consult-clips/t/one.flac', 'cv1', 'abc1234', '${SHA_A}'),
        -- orphan whose room and times sit inside E1: it must stay an orphan
        ('cu_test_orph', 'room_a', 'ra', '2026-10-19', 1792382500000, 1792382900000, 'consult-clips/t/orph.flac', 'cv1', 'abc1234', '${SHA_B}'),
        ('cu_test_old', 'room_b', 'rb', '2026-10-19', 1792386000000, 1792386600000, 'consult-clips/t/old.flac', 'cv1', 'abc1234', '${SHA_B}');
      INSERT INTO consult_sarvam_result (consult_uid, cut_version, mode, english, job_id, result_r2_key, model_stt, model_translate, model_rev, pipeline_rev, t0_ms) VALUES
        ('cu_test_01', 'cv1', 'transcribe', false, 'job_t1', 'mcp-sarvam/job_t1.json', 'm_stt', 'm_tr', 'rev1', 'p1', 1792382400000),
        ('cu_test_01', 'cv1', 'transcribe', true, 'job_t2', 'mcp-sarvam/job_t2.json', 'm_stt', 'm_tr', 'rev1', 'p1', 1792382400000),
        ('cu_test_orph', 'cv1', 'codemix', false, 'job_t3', 'mcp-sarvam/job_t3.json', 'm_stt', 'm_tr', 'rev1', 'p1', 1792382500000);
      INSERT INTO reb_track_index (window_id, ist_date, room_id, layer, engine, version, config_hash, shadow, status, r2_key, sha256) VALUES
        ('bw_test_01', '2026-10-19', 'room_b', 'stt', 'engx', 'v1', 'abcd1234ffff', false, 'ok', 'reb/t/stt.json', '${SHA_A}'),
        ('bw_test_01', '2026-10-19', 'room_b', 'stt', 'engx', 'v1', 'abcd1234ffff', true, 'empty', 'reb/t/stt-shadow.json', '${SHA_B}'),
        ('bw_test_orph', '2026-10-19', 'room_b', 'stt', 'engx', 'v1', 'abcd1234ffff', false, 'ok', 'reb/t/orph.json', '${SHA_B}');
      INSERT INTO diarize_nemotron_window (window_id, room_day_id, model, model_rev, config, config_hash, worker_id, machine, audio_ms, turns_json, payload_sha256, status) VALUES
        ('bw_test_01', 'rd_test_01', 'm_d', 'drev1', '{}'::jsonb, 'feed5678aaaa', 'w1', 'box', 1000, '[[0,100,"spk0"]]'::jsonb, '${SHA_A}', 'ok'),
        ('bw_test_orph', 'rd_test_01', 'm_d', 'drev1', '{}'::jsonb, 'feed5678aaaa', 'w1', 'box', 1000, '[]'::jsonb, '${SHA_B}', 'ok');
      INSERT INTO freescript_run (consult_uid, prescription_uid, schema_version, state, validator_ok, generator_code_sha, generator_prompt_sha, input_sha256) VALUES
        ('cu_test_01', 'rx_test_01', 'eta.freescript.v0.2', 'ok', true, '${SHA_A}', '${SHA_A}', '${SHA_B}'),
        ('cu_test_01', NULL, 'eta.freescript.v0.2', 'invalid', false, '${SHA_A}', '${SHA_A}', '${SHA_A}'),
        ('cu_test_orph', NULL, 'eta.freescript.v0.2', 'ok', true, '${SHA_A}', '${SHA_A}', '${SHA_A}');
      INSERT INTO freescript_artifact (run_id, consult_uid, schema_version, artifact, completion_required, validator_ok)
        SELECT id, consult_uid, schema_version, '{"k":1}'::jsonb, '[]'::jsonb, validator_ok FROM freescript_run WHERE state = 'ok' AND consult_uid = 'cu_test_01';
      INSERT INTO encounter_catalog (consult_uid, clip, layers, prescription_uid, individual_uid) VALUES
        ('cu_test_01', '{"r2_key":"consult-clips/t/one.flac","minutes":10}'::jsonb, '{"stt":{"r2_key":"reb/t/cat-stt.json","status":"ok"},"parts":null,"diar":{"r2_key":"reb/t/cat-diar.json","status":"strange"}}'::jsonb, 'rx_test_01', 'ind_test_01'),
        ('cu_test_orph', '{"r2_key":"consult-clips/t/orph.flac"}'::jsonb, NULL, NULL, NULL);
    `);
  });
  afterAll(() => { pg.stop(); });
  beforeEach(() => { log = []; });

  it("off (no config row, and malformed values) makes no query on the sources and no write", async () => {
    for (const v of [null, '"off"', '"on"', '"ON"', '42', '{"mode":"loud"}', '[]']) {
      setMode(v);
      log = [];
      const r = await indexSpineArtefacts(NOW, db, NO_BLIND);
      expect(r.mode, String(v)).toBe("off");
      expect(r.inserted).toBe(0);
      expect(log).toEqual([CONFIG_SQL]);
      expect(await one("SELECT count(*)::int FROM spine_artefact")).toBe(0);
    }
  });

  it("shadow reads and counts but writes nothing", async () => {
    setMode('"shadow"');
    const r = await indexSpineArtefacts(NOW, db, NO_BLIND);
    expect(r.mode).toBe("shadow");
    expect(r.inserted).toBe(0);
    expect(r.counts.to_insert).toBeGreaterThan(0);
    expect(await one("SELECT count(*)::int FROM spine_artefact")).toBe(0);
  });

  it("on: one join fixture per source lands the expected refs, and only through an active link", async () => {
    setMode('{"mode":"live"}');
    const r = await indexSpineArtefacts(NOW, db, NO_BLIND);
    expect(r.mode).toBe("live");
    const all = await artefacts();
    const by = (t: string) => all.filter((a) => a.source_table === t);
    expect(by("consult_index")).toEqual([
      { encounter_id: E1, stage: "cut", engine: "cutter", version: "abc1234", cfg8: hash8("cu_test_01"), cut_version: "cv1", store: "r2", bucket: null, object_key: "consult-clips/t/one.flac", sha256: SHA_A, status: "ok", source_table: "consult_index" },
    ]);
    expect(by("consult_sarvam_result").map((a) => [a.encounter_id, a.engine, a.object_key, a.version, a.sha256])).toEqual([
      [E1, "sarvam_transcribe", "mcp-sarvam/job_t1.json", "rev1", null],
      [E1, "sarvam_transcribe_en", "mcp-sarvam/job_t2.json", "rev1", null],
    ]);
    expect(by("reb_track_index").map((a) => [a.encounter_id, a.stage, a.engine, a.cfg8, a.object_key, a.status])).toEqual([
      [E2, "stt", "engx", "abcd1234", "reb/t/stt.json", "ok"],
      [E2, "stt", "engx:shadow", "abcd1234", "reb/t/stt-shadow.json", "empty"],
    ]);
    expect(by("diarize_nemotron_window")).toEqual([
      { encounter_id: E2, stage: "diarize", engine: "nemotron", version: "drev1", cfg8: "feed5678", cut_version: "window:bw_test_01", store: "neon", bucket: null, object_key: "diarize_nemotron_window/1", sha256: SHA_A, status: "ok", source_table: "diarize_nemotron_window" },
    ]);
    expect(by("freescript_run").map((a) => [a.encounter_id, a.status, a.cfg8, a.store])).toEqual([
      [E1, "ok", hash8("cu_test_01", SHA_B), "neon"],
      [E1, "failed", hash8("cu_test_01", SHA_A), "neon"],
    ]);
    expect(by("encounter_catalog").map((a) => [a.encounter_id, a.stage, a.object_key, a.status])).toEqual([
      [E1, "stt", "reb/t/cat-stt.json", "ok"],
    ]);
    expect(r.counts.dup_source).toEqual({ encounter_catalog: 1 });   // the clip is already indexed from consult_index
    expect(r.counts.unmapped).toEqual({ encounter_catalog: 1 });   // the layer with an unknown status, not guessed
    expect(r.inserted).toBe(all.length);
    expect(await one("SELECT count(*)::int FROM spine_artefact WHERE bucket IS NOT NULL OR source_table IS NULL")).toBe(0);
  });

  it("orphans are counted by source table, never time-matched into the overlapping encounter", async () => {
    setMode('"shadow"');
    const r = await indexSpineArtefacts(NOW, db, NO_BLIND);
    expect(r.counts.orphans).toEqual({ consult_index: 2, consult_sarvam_result: 1, reb_track_index: 1, diarize_nemotron_window: 1, freescript_run: 1, encounter_catalog: 1 });
    expect(await one(`SELECT count(*)::int FROM spine_artefact WHERE object_key LIKE '%orph%' OR object_key LIKE '%old%' OR object_key LIKE '%job_t3%'`)).toBe(0);
  });

  it("rerun makes 0 changes", async () => {
    setMode('"live"');
    const before = await artefacts();
    const again = await indexSpineArtefacts(new Date("2026-10-20T00:00:00Z"), db, NO_BLIND);
    expect(again.inserted).toBe(0);
    expect(again.counts.to_insert).toBe(0);
    expect(again.counts.conflicts).toEqual({});
    expect(again.counts.unchanged).toBe(before.length);
    expect(await artefacts()).toEqual(before);
    expect(await one("SELECT count(*)::int FROM spine_artefact WHERE created_at <> '2026-10-19T10:00:00Z'")).toBe(0);
  });

  it("a sha conflict on the unique key is counted by source and never overwritten", async () => {
    setMode('"live"');
    pg.exec(`UPDATE consult_index SET source_sha256 = '${SHA_B}' WHERE consult_uid = 'cu_test_01';
             UPDATE diarize_nemotron_window SET payload_sha256 = '${SHA_B}' WHERE window_id = 'bw_test_01';`);
    const before = await artefacts();
    const r = await indexSpineArtefacts(NOW, db, NO_BLIND);
    expect(r.counts.conflicts).toEqual({ consult_index: 1, diarize_nemotron_window: 1 });
    expect(r.inserted).toBe(0);
    expect(await artefacts()).toEqual(before);
    expect(await one("SELECT sha256 FROM spine_artefact WHERE source_table = 'consult_index'")).toBe(SHA_A);
  });

  it("read-only: every statement run against the sources is a SELECT; the only write is INSERT INTO spine_artefact; no prescription/individual id or text column is selected", async () => {
    setMode('"live"');
    pg.exec(`INSERT INTO consult_index (consult_uid, room_id, room_slug, ist_date, t0_ms, t1_ms, clip_r2_key, cut_version, source_sha256) VALUES ('cu_test_02', 'room_a', 'ra', '2026-10-19', 1, 2, 'consult-clips/t/two.flac', 'cv1', '${SHA_A}');
             INSERT INTO spine_link (encounter_id, key_kind, value, basis) VALUES ('${E1}', 'consult_uid', 'cu_test_02', 'exact');`);
    log = [];
    const r = await indexSpineArtefacts(NOW, db, NO_BLIND);
    expect(r.inserted).toBe(1);
    for (const stmt of log) {
      if (stmt === INSERT_SQL || stmt === CURSOR_UPSERT_SQL) continue;
      expect(stmt.trim().startsWith("SELECT"), stmt.slice(0, 40)).toBe(true);
      expect(stmt).not.toMatch(/\bFOR UPDATE\b/i);
      expect(stmt).not.toMatch(/\b(insert|update|delete|truncate|alter|drop)\b/i);
      expect(stmt).not.toMatch(/\b(prescription_uid|presc_uid|individual_uid|turns_json|patient_name|doctor_name|validator_errors)\b/i);
    }
    expect(log.filter((s) => s === INSERT_SQL)).toHaveLength(1);
    // the sources are untouched
    expect(await one("SELECT count(*)::int FROM consult_index")).toBe(4);
    expect(await one("SELECT count(*)::int FROM encounter_catalog WHERE prescription_uid = 'rx_test_01' AND individual_uid = 'ind_test_01'")).toBe(1);
  });
});

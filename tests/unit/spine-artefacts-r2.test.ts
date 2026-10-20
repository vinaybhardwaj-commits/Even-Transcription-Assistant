/** Spine S3 R2: the Opus refuter's adversarial tests (ported), plus the R2 fixes: key identity, null sha, foreign keys, order, catalog dedupe, cursor. Synthetic ids only. */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { ROOM_STUBS_SQL } from "../support/spine-room-stubs";
import { dockerAvailable, pgContainer } from "../support/s1-pg";
import { SOURCES, sourceSelect, CONFIG_SQL, hash8, parseArtefactsMode, planArtefacts, mapRow } from "@/lib/spine/artefacts";
import type { SourceRow } from "@/lib/spine/artefacts";
import { indexSpineArtefacts } from "@/lib/spine/artefacts-store";
import type { SpineDb } from "@/lib/spine/artefacts-store";

const pg = pgContainer("eta-spine-artefacts-r2");
const mig = (f: string) => readFileSync(`db/migrations/${f}`, "utf8");
const NO_BLIND = { blindDays: [] as Array<readonly [string, string]> };
const NOW = new Date("2026-10-19T10:00:00Z");
const SHA = (c: string) => c.repeat(64);
const MARK = "PHIMARK";

function asParam(v: unknown): string {
  if (v === null || v === undefined) return "NULL";
  const s = Array.isArray(v) ? `{${v.map((e) => (e === null ? "NULL" : `"${String(e).replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`)).join(",")}}` : String(v);
  return `'${s.replace(/'/g, "''")}'`;
}
/** A driver that runs every statement as role `user` (not superuser). */
function dbAs(user: string, seen: unknown[]): SpineDb {
  return async (text, params = []) => {
    const body = text.trim();
    const prepared = `WITH __q AS (${body}\n) SELECT COALESCE(jsonb_agg(__q)::text, '[]') FROM __q`;
    const args = params.length ? `(${params.map(asParam).join(", ")})` : "";
    const out = execFileSync("docker", ["exec", "-i", pg.name, "psql", "-qAt", "-v", "ON_ERROR_STOP=1", "-U", user, "-d", "postgres"],
      { input: `PREPARE __s AS ${prepared};\nEXECUTE __s${args};\n`, encoding: "utf8", maxBuffer: 256 * 1024 * 1024, stdio: ["pipe", "pipe", "pipe"] }).trim();
    const rows = out ? (JSON.parse(out) as unknown[]) : [];
    seen.push(...rows);
    return rows;
  };
}
const q1 = (sql: string) => execFileSync("docker", ["exec", "-i", pg.name, "psql", "-qAt", "-v", "ON_ERROR_STOP=1", "-U", "postgres", "-d", "postgres"], { input: sql, encoding: "utf8" }).trim();
const setMode = (v: string) => pg.exec(`DELETE FROM spine_config WHERE key='artefacts'; INSERT INTO spine_config (key, value) VALUES ('artefacts', '${v}'::jsonb);`);

const d = dockerAvailable() ? describe : describe.skip;
d("oref adversarial: spine S3 on postgres:16", () => {
  beforeAll(() => {
    pg.start();
    pg.exec("CREATE TABLE schema_migrations (version integer PRIMARY KEY, name text NOT NULL); CREATE TABLE diarize_window_label (id serial PRIMARY KEY, engine text); " + ROOM_STUBS_SQL);
    for (const f of ["0135_reb_track_index.sql", "0140_diarize_nemotron.sql", "0150_consult_index.sql", "0157_freescript.sql", "0168_encounter_catalog.sql", "0169_encounter_catalog_c4.sql", "0173_spine.sql"]) pg.exec(mig(f));
    // Read-only role: SELECT on every source, INSERT only on spine_artefact. Writes on sources explicitly revoked.
    pg.exec(`CREATE ROLE spine_ro LOGIN;
      GRANT SELECT ON consult_index, consult_sarvam_result, reb_track_index, diarize_nemotron_window, freescript_run, freescript_artifact, encounter_catalog TO spine_ro;
      REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON consult_index, consult_sarvam_result, reb_track_index, diarize_nemotron_window, freescript_run, freescript_artifact, encounter_catalog FROM spine_ro;
      GRANT SELECT ON spine_link, spine_encounter TO spine_ro;
      GRANT SELECT, INSERT ON spine_artefact TO spine_ro; GRANT SELECT, INSERT, UPDATE ON spine_config TO spine_ro; GRANT USAGE ON SEQUENCE spine_artefact_id_seq TO spine_ro;`);
    pg.exec(`
      INSERT INTO spine_encounter (encounter_id, ist_date, room_id, t_open, t_close, status, merge_version) VALUES
        ('enc_testpppppppppppp', '2026-10-19', 'room_p', '2026-10-19T04:00:00Z', '2026-10-19T04:30:00Z', 'confirmed', 'mv1');
      INSERT INTO spine_link (encounter_id, key_kind, value, basis) VALUES
        ('enc_testpppppppppppp', 'consult_uid', 'cu_test_p1', 'exact'), ('enc_testpppppppppppp', 'window_id', 'bw_test_p1', 'exact');
      -- PHI-like markers in EVERY unselected column that can hold text
      INSERT INTO consult_index (consult_uid, room_id, room_slug, ist_date, session_id, t0_ms, t1_ms, clip_r2_key, doctor_uid, cut_version, code_commit, quality, source_sha256) VALUES
        ('cu_test_p1', '${MARK}_room', '${MARK}_slug', '2026-10-19', '${MARK}_sess', 1, 2, 'consult-clips/p/one.flac', '${MARK}_doc', 'cv1', 'c1', '${MARK}_q', '${SHA("a")}');
      INSERT INTO consult_sarvam_result (consult_uid, cut_version, mode, english, job_id, result_r2_key, model_stt, model_translate, model_rev, pipeline_rev, language_code, english_pass, t0_ms) VALUES
        ('cu_test_p1', 'cv1', 'transcribe', false, '${MARK}_job', 'mcp-sarvam/p1.json', '${MARK}_m', '${MARK}_t', 'rev1', 'p1', '${MARK}_lc', '${MARK}_ep', 1);
      INSERT INTO reb_track_index (window_id, ist_date, room_id, layer, engine, model, version, config_hash, shadow, status, reason, machine, r2_key, sha256) VALUES
        ('bw_test_p1', '2026-10-19', '${MARK}_room', 'stt', 'engx', '${MARK}_model', 'v1', 'abcd1234ffff', false, 'ok', '${MARK}_reason', '${MARK}_mach', 'reb/p/stt.json', '${SHA("a")}');
      INSERT INTO diarize_nemotron_window (window_id, room_day_id, model, model_rev, config, config_hash, worker_id, machine, audio_ms, turns_json, payload_sha256, status, error_code) VALUES
        ('bw_test_p1', '${MARK}_rd', '${MARK}_m', 'drev1', '{"x":"${MARK}"}'::jsonb, 'feed5678aaaa', '${MARK}_w', 'box', 1000, '[[0,100,"${MARK}"]]'::jsonb, '${SHA("a")}', 'failed', '${MARK}_err');
      INSERT INTO freescript_run (consult_uid, prescription_uid, schema_version, room_slug, room_id, doctor_uid8, state, validator_ok, validator_errors, generator_code_sha, generator_prompt_sha, model_id, input_sha256, job_id) VALUES
        ('cu_test_p1', '${MARK}_rx', 'eta.freescript.v0.2', '${MARK}_s', '${MARK}_r', 'PHIMARK1', 'ok', true, '["${MARK}"]'::jsonb, '${SHA("a")}', '${SHA("a")}', '${MARK}_mid', '${SHA("b")}', 'job_${MARK}');
      INSERT INTO freescript_artifact (run_id, consult_uid, prescription_uid, schema_version, artifact, completion_required, validator_ok, validator_errors)
        SELECT id, consult_uid, '${MARK}_rx', schema_version, '{"t":"${MARK}"}'::jsonb, '["${MARK}"]'::jsonb, true, '["${MARK}"]'::jsonb FROM freescript_run;
      INSERT INTO encounter_catalog (consult_uid, doctor_uid, room_id, source, clip, layers, freescript, stages, first_gap, allowance, prescription, doctor_name, patient_name, individual_uid, prescription_uid, presc_state, jev, clef_affect, presence) VALUES
        ('cu_test_p1', '${MARK}_d', '${MARK}_r', 'cutter', '{"r2_key":"consult-clips/p/one.flac","patient":"${MARK}"}'::jsonb,
         '{"stt":{"r2_key":"reb/p/cat.json","status":"ok","note":"${MARK}"}}'::jsonb, '{"t":"${MARK}"}'::jsonb, '{"t":"${MARK}"}'::jsonb, '${MARK}_g',
         '{"t":"${MARK}"}'::jsonb, '{"t":"${MARK}"}'::jsonb, '${MARK} Doc', '${MARK} Pat', '${MARK}_ind', '${MARK}_rx', '${MARK}_ps', '{"t":"${MARK}"}'::jsonb, '{"t":"${MARK}"}'::jsonb, '{"t":"${MARK}"}'::jsonb);
    `);
  });
  afterAll(() => { pg.stop(); });

  it("REVOKE: the control bites (the ro role cannot UPDATE a source)", () => {
    expect(() => execFileSync("docker", ["exec", "-i", pg.name, "psql", "-qAt", "-v", "ON_ERROR_STOP=1", "-U", "spine_ro", "-d", "postgres"],
      { input: "UPDATE consult_index SET quality = 'x';", encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] })).toThrow(/permission denied/);
  });

  it("REVOKE + PHI: on-mode run as a SELECT-only role succeeds; no marker reaches the app or spine_artefact", async () => {
    setMode('"live"');
    const seen: unknown[] = [];
    const r = await indexSpineArtefacts(NOW, dbAs("spine_ro", seen), NO_BLIND);
    expect(r.mode).toBe("live");
    expect(r.inserted).toBe(6);    // cut, sarvam, reb, nemotron, freescript, catalog stt (the catalog clip is dup_source)
    expect(JSON.stringify(seen)).not.toContain(MARK);
    expect(q1("SELECT coalesce(string_agg(t::text, '|'), '') FROM spine_artefact t")).not.toContain(MARK);
  });

  it("collision: one encounter with two windows, same reb engine/config: both artefacts should land", async () => {
    pg.exec(`DELETE FROM spine_artefact;
      INSERT INTO spine_encounter (encounter_id, ist_date, room_id, t_open, t_close, status, merge_version) VALUES ('enc_testwwwwwwwwwwww', '2026-10-19', 'room_w', '2026-10-19T06:00:00Z', '2026-10-19T06:30:00Z', 'confirmed', 'mv1');
      INSERT INTO spine_link (encounter_id, key_kind, value, basis) VALUES ('enc_testwwwwwwwwwwww', 'window_id', 'bw_test_w1', 'exact'), ('enc_testwwwwwwwwwwww', 'window_id', 'bw_test_w2', 'exact');
      INSERT INTO reb_track_index (window_id, ist_date, room_id, layer, engine, version, config_hash, status, r2_key, sha256) VALUES
        ('bw_test_w1', '2026-10-19', 'room_w', 'stt', 'engx', 'v1', 'abcd1234ffff', 'ok', 'reb/w/w1.json', '${SHA("c")}'),
        ('bw_test_w2', '2026-10-19', 'room_w', 'stt', 'engx', 'v1', 'abcd1234ffff', 'ok', 'reb/w/w2.json', '${SHA("d")}');
      INSERT INTO diarize_nemotron_window (window_id, room_day_id, model, model_rev, config, config_hash, worker_id, machine, audio_ms, payload_sha256, status) VALUES
        ('bw_test_w1', 'rd_w', 'm', 'drev1', '{}'::jsonb, 'feed5678aaaa', 'w', 'box', 1000, '${SHA("c")}', 'ok'),
        ('bw_test_w2', 'rd_w', 'm', 'drev1', '{}'::jsonb, 'feed5678aaaa', 'w', 'box', 1000, '${SHA("d")}', 'ok');`);
    const r = await indexSpineArtefacts(NOW, dbAs("postgres", []), NO_BLIND);
    const keys = q1("SELECT string_agg(object_key, ',' ORDER BY object_key) FROM spine_artefact WHERE encounter_id = 'enc_testwwwwwwwwwwww'");
    expect({ keys, conflicts: r.counts.conflicts }).toEqual({ keys: "diarize_nemotron_window/2,diarize_nemotron_window/3,reb/w/w1.json,reb/w/w2.json", conflicts: {} });
  });

  it("collision: one encounter with two consult_uids (M8 merge survivor), same sarvam config: both should land, none 'unchanged'", async () => {
    pg.exec(`DELETE FROM spine_artefact;
      INSERT INTO spine_encounter (encounter_id, ist_date, room_id, t_open, t_close, status, merge_version) VALUES ('enc_testmmmmmmmmmmmm', '2026-10-19', 'room_m', '2026-10-19T07:00:00Z', '2026-10-19T07:30:00Z', 'confirmed', 'mv1');
      INSERT INTO spine_link (encounter_id, key_kind, value, basis) VALUES ('enc_testmmmmmmmmmmmm', 'consult_uid', 'cu_test_m1', 'exact'), ('enc_testmmmmmmmmmmmm', 'consult_uid', 'cu_test_m2', 'merge');
      INSERT INTO consult_index (consult_uid, room_id, room_slug, ist_date, t0_ms, t1_ms, clip_r2_key, cut_version, code_commit, source_sha256) VALUES
        ('cu_test_m1', 'room_m', 'rm', '2026-10-19', 1, 2, 'consult-clips/m/1.flac', 'cv1', 'c1', '${SHA("c")}'),
        ('cu_test_m2', 'room_m', 'rm', '2026-10-19', 3, 4, 'consult-clips/m/2.flac', 'cv1', 'c1', '${SHA("d")}');
      INSERT INTO consult_sarvam_result (consult_uid, cut_version, mode, english, job_id, result_r2_key, model_stt, model_translate, model_rev, pipeline_rev, t0_ms) VALUES
        ('cu_test_m1', 'cv1', 'transcribe', false, 'job_m1', 'mcp-sarvam/m1.json', 'a', 'b', 'rev1', 'p1', 1),
        ('cu_test_m2', 'cv1', 'transcribe', false, 'job_m2', 'mcp-sarvam/m2.json', 'a', 'b', 'rev1', 'p1', 3);`);
    const r = await indexSpineArtefacts(NOW, dbAs("postgres", []), NO_BLIND);
    const keys = q1("SELECT string_agg(object_key, ',' ORDER BY object_key) FROM spine_artefact WHERE encounter_id = 'enc_testmmmmmmmmmmmm'");
    expect({ keys, unchanged: r.counts.unchanged }).toEqual({ keys: "consult-clips/m/1.flac,consult-clips/m/2.flac,mcp-sarvam/m1.json,mcp-sarvam/m2.json", unchanged: 0 });
  });

  it("a key already held by another writer (other source_table) is reported, not silently dropped", async () => {
    pg.exec(`DELETE FROM spine_artefact;
      INSERT INTO spine_artefact (encounter_id, stage, engine, version, cfg8, cut_version, store, object_key, sha256, status, source_table)
        VALUES ('enc_testpppppppppppp', 'cut', 'cutter', 'c1', '${hash8("cu_test_p1")}', 'cv1', 'r2', 'consult-clips/p/other.flac', '${SHA("e")}', 'ok', 'spine_report');`);
    const r = await indexSpineArtefacts(NOW, dbAs("postgres", []), NO_BLIND);
    expect(q1("SELECT sha256 FROM spine_artefact WHERE source_table = 'spine_report'")).toBe(SHA("e"));   // not overwritten
    expect(r.counts.to_insert).toBe(r.inserted);
    expect(r.counts.foreign_conflict).toEqual({ consult_index: 1 });   // counted, not dropped
  });

  it("null sha256 never equals null: two sarvam rows of one key with different object keys are both kept; same object is unchanged", async () => {
    pg.exec(`DELETE FROM spine_artefact; DELETE FROM spine_config WHERE key = 'artefacts_cursor';`);
    // plan level: a held row with a null sha and a different object key is a conflict, the same object key is unchanged
    const row = (key: string) => ({ source: "consult_sarvam_result" as const, row: { encounter_id: "enc_testnnnnnnnnnnnn", consult_uid: "cu_test_n1", cut_version: "cv1", mode: "transcribe", english: false, model_rev: "r1", pipeline_rev: "p1", result_r2_key: key } as SourceRow });
    const first = planArtefacts([row("mcp-sarvam/a.json")], []).inserts[0];
    const held = [{ ...first, sha256: null }];
    expect(planArtefacts([row("mcp-sarvam/b.json")], held).counts).toMatchObject({ conflicts: { consult_sarvam_result: 1 }, unchanged: 0, to_insert: 0 });
    expect(planArtefacts([row("mcp-sarvam/a.json")], held).counts).toMatchObject({ conflicts: {}, unchanged: 1 });
  });

  it("M8: a freescript run with state ok but no artifact is not ok", async () => {
    pg.exec(`DELETE FROM spine_artefact;
      INSERT INTO freescript_run (consult_uid, schema_version, state, validator_ok, generator_code_sha, generator_prompt_sha, input_sha256) VALUES ('cu_test_p1', 'eta.freescript.v0.2', 'ok', true, '${SHA("a")}', '${SHA("a")}', '${SHA("f")}');`);
    await indexSpineArtefacts(NOW, dbAs("postgres", []), NO_BLIND);
    expect(q1(`SELECT string_agg(status, ',' ORDER BY status) FROM spine_artefact WHERE source_table = 'freescript_run' AND cfg8 = '${hash8("cu_test_p1", SHA("f"))}'`)).toBe("skipped");
  });

  it("catalog dedupe: a catalog object already indexed from consult_index is dup_source, not a second row; the clip sha is used when present", async () => {
    pg.exec(`DELETE FROM spine_artefact; DELETE FROM encounter_catalog WHERE consult_uid = 'cu_test_p1';
      INSERT INTO encounter_catalog (consult_uid, clip, layers) VALUES ('cu_test_p1', '{"r2_key":"consult-clips/p/one.flac"}'::jsonb, '{"stt":{"r2_key":"reb/p/stt.json","status":"ok"},"diar":{"r2_key":"reb/p/own.json","status":"ok"}}'::jsonb);`);
    const r = await indexSpineArtefacts(NOW, dbAs("postgres", []), NO_BLIND);
    expect(r.counts.dup_source).toEqual({ encounter_catalog: 2 });   // the clip (consult_index) and reb/p/stt.json (reb row of a linked window)
    expect(q1("SELECT string_agg(object_key, ',' ORDER BY object_key) FROM spine_artefact WHERE source_table = 'encounter_catalog'")).toBe("reb/p/own.json");
    pg.exec(`DELETE FROM spine_artefact; UPDATE encounter_catalog SET clip = '{"r2_key":"consult-clips/p/solo.flac","sha256":"${SHA("9")}"}'::jsonb WHERE consult_uid = 'cu_test_p1';`);
    await indexSpineArtefacts(NOW, dbAs("postgres", []), NO_BLIND);
    expect(q1("SELECT sha256 FROM spine_artefact WHERE source_table = 'encounter_catalog' AND object_key = 'consult-clips/p/solo.flac'")).toBe(SHA("9"));
  });

  it("cursor: 5000 synthetic rows index fully over 3 runs, no duplicates, no skips; a fourth run restarts the sweep and changes nothing", async () => {
    pg.exec(`DELETE FROM spine_artefact; DELETE FROM spine_config WHERE key = 'artefacts_cursor';
      DELETE FROM encounter_catalog; DELETE FROM freescript_artifact; DELETE FROM freescript_run; DELETE FROM consult_sarvam_result; DELETE FROM diarize_nemotron_window; DELETE FROM reb_track_index; DELETE FROM consult_index;
      INSERT INTO spine_encounter (encounter_id, ist_date, room_id, t_open, t_close, status, merge_version) VALUES ('enc_testcccccccccccc', '2026-10-19', 'room_c', '2026-10-19T08:00:00Z', '2026-10-19T08:30:00Z', 'confirmed', 'mv1');
      INSERT INTO spine_link (encounter_id, key_kind, value, basis)
        SELECT 'enc_testcccccccccccc', 'consult_uid', 'cu_test_c' || lpad(g::text, 5, '0'), 'exact' FROM generate_series(1, 5000) g;
      INSERT INTO consult_index (consult_uid, room_id, room_slug, ist_date, t0_ms, t1_ms, clip_r2_key, cut_version, code_commit, source_sha256)
        SELECT 'cu_test_c' || lpad(g::text, 5, '0'), 'room_c', 'rc', '2026-10-19', 1, 2, 'consult-clips/c/' || g || '.flac', 'cv1', 'c1', '${SHA("a")}' FROM generate_series(1, 5000) g;`);
    const got: number[] = [];
    for (let run = 1; run <= 3; run++) {
      const r = await indexSpineArtefacts(NOW, dbAs("postgres", []), NO_BLIND);
      got.push(r.inserted);
      expect(r.counts.conflicts).toEqual({});
      expect(r.counts.unchanged, `run ${run}: a page must not re-read the row at the watermark`).toBe(0);
    }
    expect(got).toEqual([2000, 2000, 1000]);
    expect(q1("SELECT count(*) || ',' || count(DISTINCT object_key) FROM spine_artefact WHERE source_table = 'consult_index'")).toBe("5000,5000");
    const again = await indexSpineArtefacts(NOW, dbAs("postgres", []), NO_BLIND);
    expect([again.inserted, again.counts.unchanged]).toEqual([0, 2000]);   // the sweep restarted from the top and found nothing new
  });
});

describe("oref adversarial: pure", () => {
  it("config spellings: the plan's 'live' is off; case and junk are off; extra keys keep the mode", () => {
    expect(parseArtefactsMode("live")).toBe("live");
    expect(parseArtefactsMode("on")).toBe("off");
    expect(parseArtefactsMode("Shadow")).toBe("off");
    expect(parseArtefactsMode({ mode: "shadow", extra: 1 })).toBe("shadow");
    expect(parseArtefactsMode(" on")).toBe("off");
    expect(CONFIG_SQL).toMatch(/^SELECT value FROM spine_config WHERE key = \$1$/);
  });
  it("colliding rows: the winner depends on input order (nondeterministic without ORDER BY)", () => {
    const mk = (w: string, sha: string) => ({ source: "reb_track_index" as const, row: { encounter_id: "enc_testwwwwwwwwwwww", window_id: w, layer: "stt", engine: "e", version: "v", config_hash: "abcd1234ff", shadow: false, status: "ok", r2_key: `reb/${w}`, sha256: sha } as SourceRow });
    const a = planArtefacts([mk("w1", SHA("c")), mk("w2", SHA("d"))], []).inserts.map((x) => x.object_key);
    const b = planArtefacts([mk("w2", SHA("d")), mk("w1", SHA("c"))], []).inserts.map((x) => x.object_key);
    expect(a).toEqual(b);
  });
});

describe("R2: pure", () => {
  it("every source SELECT is ordered by its primary key and paged after the watermark", () => {
    for (const src of SOURCES) {
      const q = sourceSelect(src);
      expect(q, src).toMatch(/ORDER BY .+ LIMIT 2000$/);
      expect(q, src).toMatch(/ > \$1 /);
    }
  });
  const mk = (w: string, sha: string | null) => ({ source: "reb_track_index" as const, row: { encounter_id: "enc_testwwwwwwwwwwww", window_id: w, layer: "stt", engine: "e", version: "v", config_hash: "abcd1234ff", shadow: false, status: "ok", r2_key: `reb/${w}`, sha256: sha } as SourceRow });
  it("two windows of one encounter get distinct keys (window id is in cut_version)", () => {
    const p = planArtefacts([mk("bw_1", SHA("c")), mk("bw_2", SHA("c"))], []);
    expect(p.inserts).toHaveLength(2);
    expect(new Set(p.inserts.map((i) => i.cut_version)).size).toBe(2);
  });
  it("shuffled source order gives an identical insert set (sorted by key)", () => {
    const rows = ["bw_1", "bw_2", "bw_3", "bw_4"].map((w) => mk(w, SHA("c")));
    const sig = (r: typeof rows) => planArtefacts(r, []).inserts.map((i) => `${i.cut_version}|${i.object_key}`).sort();
    expect(sig([...rows].reverse())).toEqual(sig(rows));
    expect(sig([rows[2], rows[0], rows[3], rows[1]])).toEqual(sig(rows));
  });
  it("every source's mapped key differs for two different real objects", () => {
    const a = mapRow("freescript_run", { id: 1, consult_uid: "cu_a", schema_version: "v", state: "ok", input_sha256: SHA("1"), has_artifact: true });
    const b = mapRow("freescript_run", { id: 2, consult_uid: "cu_b", schema_version: "v", state: "ok", input_sha256: SHA("1"), has_artifact: true });
    expect(a?.cfg8).not.toBe(b?.cfg8);
  });
  it("a held row from another source_table is a foreign_conflict, not unchanged and not dropped silently", () => {
    const base = planArtefacts([mk("bw_1", SHA("c"))], []).inserts[0];
    const p = planArtefacts([mk("bw_1", SHA("c"))], [{ ...base, source_table: "spine_report" }]);
    expect(p.counts.foreign_conflict).toEqual({ reb_track_index: 1 });
    expect(p.counts.unchanged).toBe(0);
  });
});

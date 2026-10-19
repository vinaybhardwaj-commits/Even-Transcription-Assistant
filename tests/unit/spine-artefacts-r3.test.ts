/** spine-s3-r3: G1 (blind windows never reach spine_artefact), L1 (nemotron key = row id), L2 (catalog page key unique), N9 (dup probe needs the SAME encounter). postgres:16, synthetic ids only. */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { dockerAvailable, pgContainer } from "../support/s1-pg";
import { SOURCES, sourceSelect, CONFIG_SQL, hash8, parseArtefactsMode, planArtefacts, mapRow } from "@/lib/spine/artefacts";
import type { SourceRow } from "@/lib/spine/artefacts";
import { indexSpineArtefacts } from "@/lib/spine/artefacts-store";
import type { SpineDb } from "@/lib/spine/artefacts-store";

const pg = pgContainer("eta-spine-s3r3");
const mig = (f: string) => readFileSync(`db/migrations/${f}`, "utf8");
const NO_BLIND = { blindIds: async () => [] as string[] };
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


const ex = (t: string) => { try { pg.exec(t); } catch (e) { throw new Error(String((e as { stderr?: unknown }).stderr ?? e)); } };
const ENC = (s: string) => `enc_test${s.repeat(12)}`;
const enc = (s: string) => `INSERT INTO spine_encounter (encounter_id, ist_date, room_id, t_open, t_close, status, merge_version) VALUES ('${ENC(s)}', '2026-10-19', 'room_${s}', '2026-10-19T04:00:00Z', '2026-10-19T04:30:00Z', 'confirmed', 'mv1') ON CONFLICT DO NOTHING;`;
const wipe = () => ex(`DELETE FROM spine_artefact; DELETE FROM spine_config; DELETE FROM spine_link; DELETE FROM encounter_catalog; DELETE FROM freescript_artifact; DELETE FROM freescript_run; DELETE FROM consult_sarvam_result; DELETE FROM diarize_nemotron_window; DELETE FROM reb_track_index; DELETE FROM consult_index;`);
const snap = () => q1("SELECT coalesce(string_agg(concat_ws('|', encounter_id, stage, engine, version, cfg8, cut_version, store, object_key, sha256, status, source_table), E'\\n' ORDER BY 1), '') FROM spine_artefact");
const run = (blind: string[] = []) => indexSpineArtefacts(NOW, dbAs("postgres", []), { blindIds: async () => blind });
const d = dockerAvailable() ? describe : describe.skip;
d("spine-s3-r3: blind windows, nemotron row key, catalog page key, dup probe", () => {
  beforeAll(() => {
    pg.start();
    pg.exec("CREATE TABLE schema_migrations (version integer PRIMARY KEY, name text NOT NULL); CREATE TABLE diarize_window_label (id serial PRIMARY KEY, engine text);");
    for (const f of ["0135_reb_track_index.sql", "0140_diarize_nemotron.sql", "0150_consult_index.sql", "0157_freescript.sql", "0168_encounter_catalog.sql", "0169_encounter_catalog_c4.sql", "0173_spine.sql"]) pg.exec(mig(f));
  });
  afterAll(() => { pg.stop(); });

  it("G1 a blind window's reb and nemotron rows never reach spine_artefact and are counted blind_excluded; a blind catalog ref too", async () => {
    wipe(); setMode('"live"');
    ex(`${enc("b")} INSERT INTO spine_link (encounter_id, key_kind, value, basis) VALUES ('${ENC("b")}','window_id','bw_test_blind','exact'), ('${ENC("b")}','window_id','bw_test_ok','exact'), ('${ENC("b")}','consult_uid','cu_test_b1','exact');
      INSERT INTO reb_track_index (window_id, ist_date, room_id, layer, engine, version, config_hash, shadow, status, r2_key, sha256) VALUES
        ('bw_test_blind','2026-10-19','r','stt','e','v1','abcd1234ffff',false,'ok','reb/blind/a.json','${SHA("5")}'), ('bw_test_blind','2026-10-19','r','stt','e','v1','abcd1234ffff',true,'ok','reb/blind/b.json','${SHA("6")}'),
        ('bw_test_ok','2026-10-19','r','stt','e','v1','abcd1234ffff',false,'ok','reb/ok/a.json','${SHA("7")}');
      INSERT INTO diarize_nemotron_window (window_id, room_day_id, model, model_rev, config, config_hash, worker_id, machine, audio_ms, payload_sha256, status) VALUES
        ('bw_test_blind','rd','m','r1','{}','aaaa0000x1','w','box',1000,'${SHA("1")}','ok'), ('bw_test_ok','rd','m','r1','{}','aaaa0000x1','w','box',1000,'${SHA("3")}','ok');
      INSERT INTO encounter_catalog (consult_uid, clip, layers) VALUES ('cu_test_b1', NULL, '{"stt":{"r2_key":"reb/blind/a.json","status":"ok"},"diar":{"r2_key":"reb/other/d.json","status":"ok"}}');`);
    const r = await run(["bw_test_blind"]);
    expect(r.counts.blind_excluded).toEqual({ reb_track_index: 2, diarize_nemotron_window: 1, encounter_catalog: 1 });
    expect(r.inserted).toBe(3);   // reb ok, nemotron ok, catalog diar
    expect(q1("SELECT count(*) FROM spine_artefact WHERE object_key LIKE 'reb/blind/%' OR cut_version = 'window:bw_test_blind'")).toBe("0");
    expect(q1("SELECT string_agg(object_key, ',' ORDER BY object_key) FROM spine_artefact WHERE source_table = 'reb_track_index'")).toBe("reb/ok/a.json");
    const open = await run([]);   // control: with no blind ids the same rows are indexed
    expect(open.counts.blind_excluded).toEqual({});
    expect(q1("SELECT count(*) FROM spine_artefact WHERE object_key LIKE 'reb/blind/%'")).toBe("2");   // the two reb rows; the catalog stt ref is now a dup of the first;
  });

  it("G1 off and a failing blind lookup: the lookup is never skipped; a throw stops the run before any source read", async () => {
    wipe(); setMode('"live"');
    const calls: string[] = [];
    const db: SpineDb = async (t, p) => { calls.push(t.slice(0, 20)); return dbAs("postgres", [])(t, p); };
    await expect(indexSpineArtefacts(NOW, db, { blindIds: async () => { throw new Error("blind lookup down"); } })).rejects.toThrow("blind lookup down");
    expect(calls.every((c) => c.startsWith("SELECT value FROM sp"))).toBe(true);
  });

  it("L1 two nemotron configs of one window get two object keys (the row id), not one", async () => {
    wipe(); setMode('"live"');
    ex(`${enc("l")} INSERT INTO spine_link (encounter_id, key_kind, value, basis) VALUES ('${ENC("l")}','window_id','bw_test_l1','exact');
      INSERT INTO diarize_nemotron_window (window_id, room_day_id, model, model_rev, config, config_hash, worker_id, machine, audio_ms, payload_sha256, status) VALUES
        ('bw_test_l1','rd','m','r1','{}','aaaa0000x1','w','box',1000,'${SHA("1")}','ok'), ('bw_test_l1','rd','m','r1','{}','bbbb0000x1','w','box',1000,'${SHA("2")}','ok');`);
    await run();
    expect(q1("SELECT count(DISTINCT object_key) || '/' || count(*) FROM spine_artefact WHERE source_table='diarize_nemotron_window'")).toBe("2/2");
    expect(q1("SELECT count(*) FROM spine_artefact WHERE object_key = 'diarize_nemotron_window/bw_test_l1'")).toBe("0");
  });

  it("L2 a layer named 'clip' cannot tie the clip row at a page boundary: both rows are indexed in one sweep", async () => {
    wipe(); setMode('"live"');
    ex(`${enc("k")} INSERT INTO spine_link (encounter_id, key_kind, value, basis) VALUES ('${ENC("k")}','consult_uid','cu_test_k02000','exact');
      INSERT INTO encounter_catalog (consult_uid, clip) SELECT 'cu_test_k'||lpad(g::text,5,'0'), jsonb_build_object('r2_key','consult-clips/k'||g||'.flac') FROM generate_series(1,1999) g;
      INSERT INTO encounter_catalog (consult_uid, clip, layers) VALUES ('cu_test_k02000','{"r2_key":"consult-clips/kx.flac"}','{"clip":{"r2_key":"reb/k/layerclip.json","status":"ok"}}');`);
    for (let i = 0; i < 4; i++) await run();
    expect(q1(`SELECT count(*) FROM spine_artefact WHERE encounter_id='${ENC("k")}'`)).toBe("2");
  });

  it("N9 dup_source needs an ACTIVE link to the SAME encounter: another encounter's reb row, or an inactive link, leaves the catalog object indexed", async () => {
    wipe(); setMode('"live"');
    ex(`${enc("p")} ${enc("q")} ${enc("r")}
      INSERT INTO spine_link (encounter_id, key_kind, value, basis, active) VALUES
        ('${ENC("p")}','consult_uid','cu_test_p1','exact',true), ('${ENC("q")}','window_id','bw_test_p_other','exact',true),
        ('${ENC("r")}','consult_uid','cu_test_r1','exact',true), ('${ENC("r")}','window_id','bw_test_r_old','exact',false),
        ('${ENC("p")}','consult_uid','cu_test_s1','exact',true), ('${ENC("p")}','window_id','bw_test_p_same','exact',true);
      INSERT INTO reb_track_index (window_id, ist_date, room_id, layer, engine, version, config_hash, shadow, status, r2_key, sha256) VALUES
        ('bw_test_p_other','2026-10-19','r','stt','e','v1','abcd1234ffff',false,'ok','reb/p/other.json','${SHA("5")}'),
        ('bw_test_r_old','2026-10-19','r','stt','e','v1','abcd1234ffff',false,'ok','reb/r/old.json','${SHA("6")}'),
        ('bw_test_p_same','2026-10-19','r','stt','e','v1','abcd1234ffff',false,'ok','reb/p/same.json','${SHA("7")}');
      INSERT INTO encounter_catalog (consult_uid, clip, layers) VALUES
        ('cu_test_p1', NULL, '{"stt":{"r2_key":"reb/p/other.json","status":"ok"}}'),
        ('cu_test_r1', NULL, '{"stt":{"r2_key":"reb/r/old.json","status":"ok"}}'),
        ('cu_test_s1', NULL, '{"stt":{"r2_key":"reb/p/same.json","status":"ok"}}');`);
    const r = await run();
    expect(r.counts.dup_source).toEqual({ encounter_catalog: 1 });   // only the same-encounter, active-link match
    expect(q1("SELECT string_agg(object_key, ',' ORDER BY object_key) FROM spine_artefact WHERE source_table='encounter_catalog'")).toBe("reb/p/other.json,reb/r/old.json");
  });
});

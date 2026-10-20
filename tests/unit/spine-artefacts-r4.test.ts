/** spine-s3-r4: F2 (blindness by ROOM-DAY on every source: bench AND consult tracks, nemotron, consult_index, sarvam, freescript, the catalog side door), F1 (the reader owns its SQL; lib/spine has none), L3. postgres:16, synthetic ids only. */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { dockerAvailable, pgContainer } from "../support/s1-pg";
import { ROOM_STUBS_SQL } from "../support/spine-room-stubs";
import { scanSource } from "../support/room-access-scan";
import { sourceSelect } from "@/lib/spine/artefacts";
import { blindParams } from "@/lib/room-access/readers/spine-artefacts";
import { indexSpineArtefacts } from "@/lib/spine/artefacts-store";
import type { SpineDb } from "@/lib/spine/artefacts-store";

const pg = pgContainer("eta-spine-s3r4");
const mig = (f: string) => readFileSync(`db/migrations/${f}`, "utf8");
const NOW = new Date("2026-10-19T10:00:00Z");
const SHA = (c: string) => c.repeat(64);
type Days = Array<readonly [string, string]>;
const BLIND: Days = [["2026-10-19", "rb"]];

function asParam(v: unknown): string {
  if (v === null || v === undefined) return "NULL";
  const s = Array.isArray(v) ? `{${v.map((e) => (e === null ? "NULL" : `"${String(e).replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`)).join(",")}}` : String(v);
  return `'${s.replace(/'/g, "''")}'`;
}
function dbAs(user: string): SpineDb {
  return async (text, params = []) => {
    const prepared = `WITH __q AS (${text.trim()}\n) SELECT COALESCE(jsonb_agg(__q)::text, '[]') FROM __q`;
    const args = params.length ? `(${params.map(asParam).join(", ")})` : "";
    const out = execFileSync("docker", ["exec", "-i", pg.name, "psql", "-qAt", "-v", "ON_ERROR_STOP=1", "-U", user, "-d", "postgres"],
      { input: `PREPARE __s AS ${prepared};\nEXECUTE __s${args};\n`, encoding: "utf8", maxBuffer: 256 * 1024 * 1024, stdio: ["pipe", "pipe", "pipe"] }).trim();
    return out ? (JSON.parse(out) as unknown[]) : [];
  };
}
const q1 = (sql: string) => execFileSync("docker", ["exec", "-i", pg.name, "psql", "-qAt", "-v", "ON_ERROR_STOP=1", "-U", "postgres", "-d", "postgres"], { input: sql, encoding: "utf8" }).trim();
const setMode = (v: string) => pg.exec(`DELETE FROM spine_config WHERE key='artefacts'; INSERT INTO spine_config (key, value) VALUES ('artefacts', '${v}'::jsonb);`);
const ex = (t: string) => { try { pg.exec(t); } catch (e) { throw new Error(String((e as { stderr?: unknown }).stderr ?? e)); } };
const ENC = (s: string) => `enc_test${s.repeat(12)}`;
const enc = (s: string) => `INSERT INTO spine_encounter (encounter_id, ist_date, room_id, t_open, t_close, status, merge_version) VALUES ('${ENC(s)}', '2026-10-19', 'room_${s}', '2026-10-19T04:00:00Z', '2026-10-19T04:30:00Z', 'confirmed', 'mv1') ON CONFLICT DO NOTHING;`;
const wipe = () => ex(`DELETE FROM spine_artefact; DELETE FROM spine_config; DELETE FROM spine_link; DELETE FROM encounter_catalog; DELETE FROM freescript_artifact; DELETE FROM freescript_run; DELETE FROM consult_sarvam_result; DELETE FROM diarize_nemotron_window; DELETE FROM reb_track_index; DELETE FROM consult_index; DELETE FROM room_day; DELETE FROM bench_window; DELETE FROM room_diarize_window;`);
const run = (days: Days = [], user = "postgres") => indexSpineArtefacts(NOW, dbAs(user), { blindDays: days });
const REBCOLS = "INSERT INTO reb_track_index (window_id, ist_date, room_id, layer, engine, version, config_hash, shadow, status, r2_key, sha256) VALUES ";
const REB = (w: string, key: string, sha: string, room = "r", date = "2026-10-19") => `('${w}','${date}','${room}','stt','e','v1','abcd1234ffff',false,'ok','${key}','${SHA(sha)}')`;
const NEMCOLS = "INSERT INTO diarize_nemotron_window (window_id, room_day_id, model, model_rev, config, config_hash, worker_id, machine, audio_ms, payload_sha256, status) VALUES ";
const NEM = (w: string, rd: string, cfg: string, sha: string) => `('${w}','${rd}','m','r1','{}','${cfg}','w','box',1000,'${SHA(sha)}','ok')`;
const CI = (uid: string, room: string, key: string) => `INSERT INTO consult_index (consult_uid, room_id, room_slug, ist_date, t0_ms, t1_ms, clip_r2_key, cut_version, code_commit, source_sha256) VALUES ('${uid}','${room}','rs','2026-10-19',1,2,'${key}','cv1','c1','${SHA("9")}');`;
const link = (e: string, kind: string, v: string) => `INSERT INTO spine_link (encounter_id, key_kind, value, basis) VALUES ('${ENC(e)}','${kind}','${v}','exact');`;

describe("R4 static: F1", () => {
  it("the reader's SQL carries explicit FROM/JOIN: the scanner sees reb_track_index and diarize_nemotron_window, 4+ reads", () => {
    const v = scanSource("lib/x.ts", readFileSync("lib/room-access/readers/spine-artefacts.ts", "utf8"));
    expect(new Set(v.map((x) => x.what))).toEqual(new Set(["reb_track_index", "diarize_nemotron_window", "bench_window", "room_diarize_window"]));
    expect(v.filter((x) => x.what === "reb_track_index").length).toBeGreaterThanOrEqual(3);
    expect(v.filter((x) => x.what === "diarize_nemotron_window").length).toBeGreaterThanOrEqual(1);
  });
  it("lib/spine holds no room-table SQL at all", () => {
    for (const f of ["lib/spine/artefacts.ts", "lib/spine/artefacts-store.ts"]) expect(scanSource(f, readFileSync(f, "utf8")), f).toEqual([]);
    for (const f of ["lib/spine/artefacts.ts", "lib/spine/artefacts-store.ts"]) expect(readFileSync(f, "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, ""), f).not.toMatch(/\b(?:FROM|JOIN)\s+(?:reb_track_index|diarize_nemotron_window|bench_window|bench_session|room_day)\b/i);
  });
  it("every source page binds the day predicate, and a sample per source selects only refs", () => {
    for (const s of ["consult_index", "consult_sarvam_result", "reb_track_index", "diarize_nemotron_window", "freescript_run", "encounter_catalog"] as const) expect(sourceSelect(s), s).toMatch(/= ANY\(\$2::text\[\]\)/);
  });
});

const d = dockerAvailable() ? describe : describe.skip;
d("R4 on postgres:16", () => {
  beforeAll(() => {
    pg.start();
    pg.exec("CREATE TABLE schema_migrations (version integer PRIMARY KEY, name text NOT NULL); CREATE TABLE diarize_window_label (id serial PRIMARY KEY, engine text); " + ROOM_STUBS_SQL);
    for (const f of ["0135_reb_track_index.sql", "0140_diarize_nemotron.sql", "0150_consult_index.sql", "0157_freescript.sql", "0168_encounter_catalog.sql", "0169_encounter_catalog_c4.sql", "0173_spine.sql"]) pg.exec(mig(f));
    pg.exec(`CREATE ROLE spine_ro4 LOGIN;
      GRANT SELECT ON consult_index, consult_sarvam_result, reb_track_index, diarize_nemotron_window, freescript_run, freescript_artifact, encounter_catalog, spine_link, spine_encounter, room_day, bench_window, room_diarize_window TO spine_ro4;
      GRANT SELECT, INSERT ON spine_artefact TO spine_ro4; GRANT SELECT, INSERT, UPDATE ON spine_config TO spine_ro4; GRANT USAGE ON SEQUENCE spine_artefact_id_seq TO spine_ro4;`);
  });
  afterAll(() => { pg.stop(); });

  /** One blind day (rb) and one open day (r): bench track, consult track, nemotron, consult_index, sarvam, freescript and the catalog all on both. */
  const seedBothDays = () => {
    ex(`${enc("z")} ${link("z", "window_id", "bw_test_zb")} ${link("z", "window_id", "bw_test_zo")} ${link("z", "window_id", "consult-cu_test_zb")} ${link("z", "window_id", "consult-cu_test_zo")}
      ${link("z", "consult_uid", "cu_test_zb")} ${link("z", "consult_uid", "cu_test_zo")}
      INSERT INTO room_day VALUES ('rd_b','2026-10-19','rb'), ('rd_o','2026-10-19','r');
      ${REBCOLS} ${REB("bw_test_zb", "reb/zb/w.json", "1", "rb")}, ${REB("consult-cu_test_zb", "reb/zb/_consults/c.json", "2", "rb")}, ${REB("bw_test_zo", "reb/zo/w.json", "3")}, ${REB("consult-cu_test_zo", "reb/zo/_consults/c.json", "4")};
      ${NEMCOLS} ${NEM("bw_test_zb", "rd_b", "aaaa0000x1", "5")}, ${NEM("bw_test_zo", "rd_o", "aaaa0000x1", "6")};
      ${CI("cu_test_zb", "rb", "consult-clips/zb.flac")} ${CI("cu_test_zo", "r", "consult-clips/zo.flac")}
      INSERT INTO consult_sarvam_result (consult_uid, cut_version, mode, english, job_id, result_r2_key, model_stt, model_translate, model_rev, pipeline_rev, t0_ms) VALUES
        ('cu_test_zb','cv1','transcribe',false,'j','mcp-sarvam/zb.json','m','m','r1','p1',1), ('cu_test_zo','cv1','transcribe',false,'j','mcp-sarvam/zo.json','m','m','r1','p1',1);
      INSERT INTO freescript_run (consult_uid, schema_version, state, validator_ok, generator_code_sha, generator_prompt_sha, input_sha256) VALUES ('cu_test_zb','eta.freescript.v0.1','ok',true,'${SHA("a")}','${SHA("a")}','${SHA("7")}'), ('cu_test_zo','eta.freescript.v0.1','ok',true,'${SHA("a")}','${SHA("a")}','${SHA("8")}');
      INSERT INTO encounter_catalog (consult_uid, clip, layers) VALUES
        ('cu_test_zb', '{"r2_key":"consult-clips/zbc.flac"}', '{"stt":{"r2_key":"reb/zb/_consults/c.json","status":"ok"}}'),
        ('cu_test_zo', '{"r2_key":"consult-clips/zoc.flac"}', '{"stt":{"r2_key":"reb/zo/_consults/c.json","status":"ok"}}');`);
  };

  it("F2 a blind day's bench AND consult tracks, nemotron, consult_index, sarvam, freescript and catalog clip/layer refs never reach spine_artefact; the open day does", async () => {
    wipe(); setMode('"live"'); seedBothDays();
    const r = await run(BLIND);
    expect(q1("SELECT count(*) FROM spine_artefact WHERE object_key LIKE '%zb%' OR cut_version LIKE '%zb%'")).toBe("0");
    expect(q1("SELECT count(*) FROM spine_artefact WHERE object_key LIKE 'reb/zo%' OR object_key LIKE 'consult-clips/zo.flac' OR object_key LIKE 'mcp-sarvam/zo%' OR object_key LIKE 'freescript_run/%' OR source_table = 'diarize_nemotron_window'")).toBe("6");
    expect(r.counts.blind_excluded).toEqual({ reb_track_index: 2, diarize_nemotron_window: 1, consult_index: 1, consult_sarvam_result: 1, freescript_run: 1, encounter_catalog: 2 });
    expect(r.counts.orphans).toEqual({});
  });

  it("F2 lifting the day indexes every row (marked, never dropped)", async () => {
    wipe(); setMode('"live"'); seedBothDays();
    await run(BLIND);
    const n0 = Number(q1("SELECT count(*) FROM spine_artefact"));
    for (let i = 0; i < 2; i++) await run([]);
    expect(Number(q1("SELECT count(*) FROM spine_artefact"))).toBeGreaterThan(n0);
    expect(q1("SELECT count(*) FROM spine_artefact WHERE object_key LIKE '%zb%'")).not.toBe("0");
    expect(q1("SELECT count(*) FROM spine_artefact WHERE object_key = 'reb/zb/_consults/c.json' OR object_key = 'consult-clips/zbc.flac'")).toBe("2");
  });

  it("F2 catalog side door alone: a catalog row with only its own blind pair, or only its consult_index day, or only a blind reb ref, is excluded", async () => {
    wipe(); setMode('"shadow"');
    ex(`${enc("y")} ${link("y", "consult_uid", "cu_test_y1")} ${link("y", "consult_uid", "cu_test_y2")} ${link("y", "consult_uid", "cu_test_y3")}
      INSERT INTO encounter_catalog (consult_uid, ist_date, room_id, clip) VALUES ('cu_test_y1','2026-10-19','rb','{"r2_key":"consult-clips/y1.flac"}');
      ${CI("cu_test_y2", "rb", "consult-clips/y2src.flac")}
      INSERT INTO encounter_catalog (consult_uid, clip) VALUES ('cu_test_y2','{"r2_key":"consult-clips/y2src.flac"}');   -- also a dup of its consult_index clip: blind is decided first
      ${REBCOLS} ${REB("bw_test_y3", "reb/y3/a.json", "1", "rb")};
      INSERT INTO encounter_catalog (consult_uid, clip) VALUES ('cu_test_y3','{"r2_key":"reb/y3/a.json"}');`);
    const r = await run(BLIND);
    expect(r.counts.blind_excluded.encounter_catalog).toBe(3);
    expect(r.counts.dup_source).toEqual({});
    expect(r.counts.blind_excluded.consult_index).toBe(1);
  });

  it("F2 nemotron: the window's OWN room day decides (bench_window / room_diarize_window), not only the row's room_day_id; an unresolvable day is blind while the set is non-empty", async () => {
    wipe(); setMode('"shadow"');
    ex(`${enc("n")} ${link("n", "window_id", "bw_test_n1")} ${link("n", "window_id", "bw_test_n2")} ${link("n", "window_id", "bw_test_n3")}
      INSERT INTO room_day VALUES ('rd_b','2026-10-19','rb'), ('rd_o','2026-10-19','r'), ('rd_s','2026-10-19','room_scratch_rb');
      INSERT INTO bench_window VALUES ('bw_test_n1','rd_b');
      INSERT INTO room_diarize_window VALUES ('bw_test_n2','rd_b');
      ${NEMCOLS} ${NEM("bw_test_n1", "rd_o", "aaaa0000x1", "1")}, ${NEM("bw_test_n2", "rd_o", "aaaa0000x1", "2")}, ${NEM("bw_test_n3", "rd_gone", "aaaa0000x1", "3")}, ${NEM("bw_test_n4", "rd_o", "aaaa0000x1", "4")};`);
    const r = await run(BLIND);
    expect(r.counts.blind_excluded.diarize_nemotron_window).toBe(3);   // n1 via bench_window, n2 via room_diarize_window, n3 unresolvable; n4 is open (an orphan)
    const open = await run([]);
    expect(open.counts.blind_excluded).toEqual({});
  });

  it("F2 a scratch twin room is the same room", async () => {
    wipe(); setMode('"shadow"');
    ex(`${enc("t")} ${link("t", "window_id", "bw_test_t1")} ${REBCOLS} ${REB("bw_test_t1", "reb/t/a.json", "1", "room_scratch_rb")};`);
    expect((await run([["2026-10-19", "room_rb"]])).counts.blind_excluded).toEqual({ reb_track_index: 1 });
  });

  it("A2 shadow + blind: blind counted, nothing written; a blind orphan is counted blind (not orphan)", async () => {
    wipe(); setMode('"shadow"');
    ex(`${enc("s")} ${link("s", "window_id", "bw_test_s")} INSERT INTO room_day VALUES ('rd_b','2026-10-19','rb');
      ${REBCOLS} ${REB("bw_test_s", "reb/s/a.json", "1", "rb")}, ${REB("bw_test_orph", "reb/s/o.json", "2", "rb")};
      ${NEMCOLS} ${NEM("bw_test_orph", "rd_b", "aaaa0000x1", "3")};`);
    const r = await run(BLIND);
    expect(r.counts.blind_excluded).toEqual({ reb_track_index: 2, diarize_nemotron_window: 1 });
    expect(r.counts.orphans).toEqual({});
    expect(q1("SELECT count(*) FROM spine_artefact")).toBe("0");
  });

  it("A3 nothing is lost across the page cursor: 2,500 rows, half on the blind day, then the day is lifted", async () => {
    wipe(); setMode('"live"');
    ex(`${enc("m")} INSERT INTO spine_link (encounter_id, key_kind, value, basis) SELECT '${ENC("m")}','window_id','bw_test_m'||g,'exact' FROM generate_series(1,30) g;
      INSERT INTO reb_track_index (window_id, ist_date, room_id, layer, engine, version, config_hash, shadow, status, r2_key, sha256)
        SELECT 'bw_test_m'||(g % 30 + 1), '2026-10-19', CASE WHEN g % 2 = 0 THEN 'rb' ELSE 'r' END,'stt','e','v'||g,'abcd1234ffff',false,'ok','reb/m/'||g||'.json', repeat('a',64) FROM generate_series(1,2500) g;`);
    for (let i = 0; i < 3; i++) await run(BLIND);
    expect(q1("SELECT count(*) FROM spine_artefact WHERE source_table='reb_track_index'")).toBe("1250");
    for (let i = 0; i < 3; i++) await run([]);
    expect(q1("SELECT count(*) FROM spine_artefact WHERE source_table='reb_track_index'")).toBe("2500");
  });

  it("A4 a SELECT-only role runs live with a non-empty set", async () => {
    wipe(); setMode('"live"');
    ex(`${enc("v")} ${link("v", "window_id", "bw_test_v1")} ${link("v", "window_id", "bw_test_v2")} ${REBCOLS} ${REB("bw_test_v1", "reb/v/1.json", "1", "rb")}, ${REB("bw_test_v2", "reb/v/2.json", "2")};`);
    const r = await run(BLIND, "spine_ro4");
    expect(r.inserted).toBe(1);
    expect(q1("SELECT string_agg(object_key, ',') FROM spine_artefact")).toBe("reb/v/2.json");
  });

  it("A5 cost: 14 blind pairs, 20,000 reb rows, 5,000 nemotron rows, 2,000 catalog consults x 2 layers, one full page of each", async () => {
    wipe(); setMode('"live"');
    const days: Days = [...Array.from({ length: 13 }, (_, i) => [`2026-09-${String(i + 1).padStart(2, "0")}`, "rb"] as const), ["2026-10-19", "rb"]];
    ex(`${enc("c")} INSERT INTO spine_link (encounter_id, key_kind, value, basis) SELECT '${ENC("c")}','window_id','bw_test_c'||g,'exact' FROM generate_series(1,20000) g;
      INSERT INTO spine_link (encounter_id, key_kind, value, basis) SELECT '${ENC("c")}','consult_uid','cu_test_c'||lpad(g::text,5,'0'),'exact' FROM generate_series(1,2000) g;
      INSERT INTO room_day VALUES ('rd_o','2026-10-19','r');
      INSERT INTO reb_track_index (window_id, ist_date, room_id, layer, engine, version, config_hash, shadow, status, r2_key, sha256)
        SELECT 'bw_test_c'||g, '2026-10-19', CASE WHEN g % 2 = 0 THEN 'rb' ELSE 'r' END,'stt','e','v1','abcd1234ffff',false,'ok','reb/c/'||g||'.json', repeat('a',64) FROM generate_series(1,20000) g;
      INSERT INTO diarize_nemotron_window (window_id, room_day_id, model, model_rev, config, config_hash, worker_id, machine, audio_ms, payload_sha256, status)
        SELECT 'bw_test_c'||g,'rd_o','m','r1','{}','aaaa0000x1','w','box',1000, repeat('b',64),'ok' FROM generate_series(1,5000) g;
      INSERT INTO encounter_catalog (consult_uid, clip, layers) SELECT 'cu_test_c'||lpad(g::text,5,'0'), NULL,
        jsonb_build_object('stt', jsonb_build_object('r2_key','reb/c/'||g||'.json','status','ok'), 'diar', jsonb_build_object('r2_key','reb/cx/'||g||'.json','status','ok')) FROM generate_series(1,2000) g;
      ANALYZE;`);
    const t0 = Date.now(); const r = await run(days); const ms = Date.now() - t0;
    const plan = (src: "encounter_catalog") => {
      const sql = sourceSelect(src).replace(/\$1/g, "''").replace(/\$2::text\[\]/g, `ARRAY[${blindParams(days)[0].map((k) => `'${k}'`).join(",")}]::text[]`);
      return q1(`EXPLAIN (ANALYZE) ${sql}`).split("\n").map((l) => l.slice(0, 150)).join("\n");
    };
    if (process.env.SPINE_PLAN) console.log(plan("encounter_catalog"));
    const page = (src: "reb_track_index" | "encounter_catalog") => {
      const sql = sourceSelect(src).replace(/\$1/g, "''").replace(/\$2::text\[\]/g, `ARRAY[${blindParams(days)[0].map((k) => `'${k}'`).join(",")}]::text[]`);
      return /Execution Time: ([\d.]+) ms/.exec(q1(`EXPLAIN (ANALYZE) ${sql}`))?.[1];
    };
    console.log(`A5 R4 one run ${ms} ms; reb page ${page("reb_track_index")} ms; catalog page ${page("encounter_catalog")} ms; blind ${JSON.stringify(r.counts.blind_excluded)}`);
    expect(r.counts.blind_excluded.reb_track_index).toBe(1000);   // 14 pairs, one of them the data's day: the even-numbered rows of the 2,000-row page are in room rb
    expect(ms).toBeLessThan(30000);
  }, 120000);
});

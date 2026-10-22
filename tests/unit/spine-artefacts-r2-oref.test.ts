/** spine-s3-r2-oref: refuter R2 adversarial tests (throwaway), plus the R2 fixes: key identity, null sha, foreign keys, order, catalog dedupe, cursor. Synthetic ids only. */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { catalogPageSql, blindDaySql } from "@/lib/room-access/readers/spine-artefacts";
import { ROOM_STUBS_SQL } from "../support/spine-room-stubs";
import { dockerAvailable, pgContainer } from "../support/s1-pg";
import { SOURCES, sourceSelect, CONFIG_SQL, hash8, parseArtefactsMode, planArtefacts, mapRow } from "@/lib/spine/artefacts";
import type { SourceRow } from "@/lib/spine/artefacts";
import { indexSpineArtefacts } from "@/lib/spine/artefacts-store";
import type { SpineDb } from "@/lib/spine/artefacts-store";

const pg = pgContainer("eta-spine-s3r2-oref");
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


const ex = (t: string) => { try { pg.exec(t); } catch (e) { throw new Error(String((e as { stderr?: unknown }).stderr ?? e)); } };
const ENC = (s: string) => `enc_test${s.repeat(12)}`;
const enc = (s: string) => `INSERT INTO spine_encounter (encounter_id, ist_date, room_id, t_open, t_close, status, merge_version) VALUES ('${ENC(s)}', '2026-10-19', 'room_${s}', '2026-10-19T04:00:00Z', '2026-10-19T04:30:00Z', 'confirmed', 'mv1') ON CONFLICT DO NOTHING;`;
const wipe = () => ex(`DELETE FROM spine_artefact; DELETE FROM spine_config; DELETE FROM spine_link; DELETE FROM encounter_catalog; DELETE FROM freescript_artifact; DELETE FROM freescript_run; DELETE FROM consult_sarvam_result; DELETE FROM diarize_nemotron_window; DELETE FROM reb_track_index; DELETE FROM consult_index;`);
const snap = () => q1("SELECT coalesce(string_agg(concat_ws('|', encounter_id, stage, engine, version, cfg8, cut_version, store, object_key, sha256, status, source_table), E'\\n' ORDER BY 1), '') FROM spine_artefact");
const run = () => indexSpineArtefacts(NOW, dbAs("postgres", []), NO_BLIND);
const d = dockerAvailable() ? describe : describe.skip;
d("spine-s3-r2-oref adversarial", () => {
  beforeAll(() => {
    pg.start();
    pg.exec("CREATE TABLE schema_migrations (version integer PRIMARY KEY, name text NOT NULL); CREATE TABLE diarize_window_label (id serial PRIMARY KEY, engine text); " + ROOM_STUBS_SQL);
    for (const f of ["0135_reb_track_index.sql", "0140_diarize_nemotron.sql", "0150_consult_index.sql", "0157_freescript.sql", "0168_encounter_catalog.sql", "0169_encounter_catalog_c4.sql", "0173_spine.sql"]) pg.exec(mig(f));
  });
  afterAll(() => { pg.stop(); });

  it("A1 two-window encounter, 2 nemotron configs per window, reb shadow+live: every real row lands with a distinct key", async () => {
    wipe(); setMode('"live"');
    ex(`${enc("w")} INSERT INTO spine_link (encounter_id, key_kind, value, basis) VALUES ('${ENC("w")}', 'window_id', 'bw_test_w1', 'exact'), ('${ENC("w")}', 'window_id', 'bw_test_w2', 'overlap');
      INSERT INTO reb_track_index (window_id, ist_date, room_id, layer, engine, version, config_hash, shadow, status, r2_key, sha256) VALUES
        ('bw_test_w1','2026-10-19','r','stt','engx','v1','abcd1234ffff',false,'ok','reb/w1a.json','${SHA("5")}'), ('bw_test_w1','2026-10-19','r','stt','engx','v1','abcd1234ffff',true,'ok','reb/w1b.json','${SHA("6")}'),
        ('bw_test_w2','2026-10-19','r','stt','engx','v1','abcd1234ffff',false,'ok','reb/w2a.json','${SHA("7")}'), ('bw_test_w2','2026-10-19','r','stt','engx','v1','abcd1234ffff',true,'ok','reb/w2b.json','${SHA("8")}');
      INSERT INTO diarize_nemotron_window (window_id, room_day_id, model, model_rev, config, config_hash, worker_id, machine, audio_ms, payload_sha256, status) VALUES
        ('bw_test_w1','rd','m','r1','{}','aaaa0000x1','w','box',1000,'${SHA("1")}','ok'), ('bw_test_w1','rd','m','r1','{}','bbbb0000x1','w','box',1000,'${SHA("2")}','ok'),
        ('bw_test_w2','rd','m','r1','{}','aaaa0000x1','w','box',1000,'${SHA("3")}','ok'), ('bw_test_w2','rd','m','r1','{}','bbbb0000x1','w','box',1000,'${SHA("4")}','ok');`);
    const r = await run();
    expect([r.inserted, r.counts.conflicts, r.counts.unchanged]).toEqual([8, {}, 0]);
    const again = await run();
    expect([again.inserted, again.counts.unchanged, again.counts.conflicts]).toEqual([0, 8, {}]);
  });

  it("A1b nemotron object_key names the window, not the row: two configs of one window share an object_key (ambiguous ref)", async () => {
    expect(q1("SELECT count(DISTINCT object_key) || '/' || count(*) FROM spine_artefact WHERE source_table='diarize_nemotron_window'")).toBe("4/4");
  });

  it("A2 M8 survivor with 2 consult_uids: consult_index, sarvam (null shas), freescript (same input sha), catalog all kept twice", async () => {
    wipe(); setMode('"live"');
    ex(`${enc("m")} INSERT INTO spine_link (encounter_id, key_kind, value, basis) VALUES ('${ENC("m")}','consult_uid','cu_test_m1','exact'), ('${ENC("m")}','consult_uid','cu_test_m2','merge');
      INSERT INTO consult_index (consult_uid, room_id, room_slug, ist_date, t0_ms, t1_ms, clip_r2_key, cut_version, code_commit, source_sha256) VALUES
        ('cu_test_m1','r','rs','2026-10-19',1,2,'consult-clips/m1.flac','cv1','c1','${SHA("c")}'), ('cu_test_m2','r','rs','2026-10-19',3,4,'consult-clips/m2.flac','cv1','c1','${SHA("d")}');
      INSERT INTO consult_sarvam_result (consult_uid, cut_version, mode, english, job_id, result_r2_key, model_stt, model_translate, model_rev, pipeline_rev, t0_ms) VALUES
        ('cu_test_m1','cv1','transcribe',false,'j1','mcp-sarvam/m1.json','a','b','rev1','p1',1), ('cu_test_m2','cv1','transcribe',false,'j2','mcp-sarvam/m2.json','a','b','rev1','p1',3),
        ('cu_test_m1','cv1','transcribe',true,'j3','mcp-sarvam/m1e.json','a','b','rev1','p1',1), ('cu_test_m2','cv1','transcribe',true,'j4','mcp-sarvam/m2e.json','a','b','rev1','p1',3);
      INSERT INTO freescript_run (consult_uid, schema_version, state, validator_ok, generator_code_sha, generator_prompt_sha, input_sha256) VALUES
        ('cu_test_m1','eta.freescript.v0.2','ok',true,'${SHA("a")}','${SHA("a")}','${SHA("f")}'), ('cu_test_m2','eta.freescript.v0.2','ok',true,'${SHA("a")}','${SHA("a")}','${SHA("f")}');
      INSERT INTO encounter_catalog (consult_uid, clip, layers) VALUES ('cu_test_m1', NULL, '{"stt":{"r2_key":"reb/cat/m1.json","status":"ok"}}'), ('cu_test_m2', NULL, '{"stt":{"r2_key":"reb/cat/m2.json","status":"ok"}}');`);
    const r = await run();
    expect([r.inserted, r.counts.conflicts, r.counts.unchanged]).toEqual([10, {}, 0]);
    expect(q1("SELECT string_agg(source_table || ':' || status, ',' ORDER BY source_table, object_key) FROM spine_artefact WHERE source_table='freescript_run'")).toBe("freescript_run:skipped,freescript_run:skipped");
    const again = await run();
    expect([again.inserted, again.counts.unchanged]).toEqual([0, 10]);
  });

  it("A3 null sha on pg: a held null-sha row with another object_key is a conflict, never overwritten; a held row with NULL source_table is foreign", async () => {
    wipe(); setMode('"live"');
    ex(`${enc("n")} INSERT INTO spine_link (encounter_id, key_kind, value, basis) VALUES ('${ENC("n")}','consult_uid','cu_test_n1','exact'), ('${ENC("n")}','consult_uid','cu_test_n2','exact');
      INSERT INTO consult_index (consult_uid, room_id, room_slug, ist_date, t0_ms, t1_ms, clip_r2_key, cut_version, code_commit, source_sha256) VALUES
        ('cu_test_n1','r','rs','2026-10-19',1,2,'consult-clips/n1.flac','cv1','c1','${SHA("e")}'), ('cu_test_n2','r','rs','2026-10-19',1,2,'consult-clips/n2.flac','cv1','c1','${SHA("b")}');
      INSERT INTO spine_artefact (encounter_id, stage, engine, version, cfg8, cut_version, store, object_key, sha256, status, source_table) VALUES
        ('${ENC("n")}','cut','cutter','c1','${hash8("cu_test_n1")}','cv1','r2','consult-clips/OTHER.flac',NULL,'ok','consult_index'),
        ('${ENC("n")}','cut','cutter','c1','${hash8("cu_test_n2")}','cv1','r2','consult-clips/n2.flac',NULL,'ok',NULL);`);
    const r = await run();
    expect([r.inserted, r.counts.conflicts, r.counts.foreign_conflict]).toEqual([0, { consult_index: 1 }, { consult_index: 1 }]);
    expect(q1("SELECT string_agg(coalesce(object_key,'-'), ',' ORDER BY object_key COLLATE \"C\") FROM spine_artefact")).toBe("consult-clips/OTHER.flac,consult-clips/n2.flac");
  });

  it("A4 shuffled physical order (colliding reb rows: same 8-char cfg prefix) gives a byte-identical spine_artefact set", async () => {
    const seed = () => { wipe(); setMode('"live"'); ex(`${enc("s")} INSERT INTO spine_link (encounter_id, key_kind, value, basis) VALUES ('${ENC("s")}','window_id','bw_test_s1','exact');`); };
    const rows = [["abcd1234aaaa","reb/s/a.json","1"],["abcd1234bbbb","reb/s/b.json","2"],["abcd1234cccc","reb/s/c.json","3"]];
    const ins = (rs: string[][]) => ex(rs.map(([h,k,s]) => `INSERT INTO reb_track_index (window_id, ist_date, room_id, layer, engine, version, config_hash, status, r2_key, sha256) VALUES ('bw_test_s1','2026-10-19','r','stt','e','v1','${h}','ok','${k}','${SHA(s)}');`).join("\n"));
    seed(); ins(rows); const a = await run(); const s1 = snap();
    seed(); ins([...rows].reverse()); const b = await run(); const s2 = snap();
    expect(s2).toBe(s1);
    expect([a.counts.conflicts, b.counts.conflicts]).toEqual([{ reb_track_index: 2 }, { reb_track_index: 2 }]);
  });

  it("A5 cursor under inserts between runs: text-pk rows below the watermark, out-of-order bigserial ids, late links; converges with no dup, no skip", async () => {
    wipe(); setMode('"live"');
    ex(`${enc("c")}
      INSERT INTO spine_link (encounter_id, key_kind, value, basis) SELECT '${ENC("c")}','consult_uid','cu_test_m'||lpad(g::text,5,'0'),'exact' FROM generate_series(1,2500) g;
      INSERT INTO consult_index (consult_uid, room_id, room_slug, ist_date, t0_ms, t1_ms, clip_r2_key, cut_version, code_commit, source_sha256)
        SELECT 'cu_test_m'||lpad(g::text,5,'0'),'r','rs','2026-10-19',1,2,'consult-clips/m'||g||'.flac','cv1','c1','${SHA("a")}' FROM generate_series(1,2500) g;
      INSERT INTO spine_link (encounter_id, key_kind, value, basis) SELECT '${ENC("c")}','window_id','bw_test_'||lpad(g::text,5,'0'),'exact' FROM generate_series(1,2500) g WHERE g <> 7;
      INSERT INTO reb_track_index (id, window_id, ist_date, room_id, layer, engine, version, config_hash, status, r2_key, sha256)
        SELECT g*10, 'bw_test_'||lpad(g::text,5,'0'),'2026-10-19','r','stt','e','v1','cfg00000','ok','reb/c/'||g||'.json','${SHA("b")}' FROM generate_series(1,2500) g;`);
    let total = 0;
    const r1 = await run(); total += r1.inserted;
    expect(r1.inserted).toBe(3999);   // 2000 cut + 1999 reb (window 7 orphan)
    // between runs: new consult uids BELOW and ABOVE the watermark; reb rows with ids below the watermark (late commit) and above; window 7 gets linked
    ex(`INSERT INTO spine_link (encounter_id, key_kind, value, basis) SELECT '${ENC("c")}','consult_uid', u, 'exact' FROM unnest(ARRAY['cu_test_a00001','cu_test_z00001']) u;
      INSERT INTO consult_index (consult_uid, room_id, room_slug, ist_date, t0_ms, t1_ms, clip_r2_key, cut_version, code_commit, source_sha256) VALUES
        ('cu_test_a00001','r','rs','2026-10-19',1,2,'consult-clips/a.flac','cv1','c1','${SHA("1")}'), ('cu_test_z00001','r','rs','2026-10-19',1,2,'consult-clips/z.flac','cv1','c1','${SHA("2")}');
      INSERT INTO spine_link (encounter_id, key_kind, value, basis) VALUES ('${ENC("c")}','window_id','bw_test_lo','exact'), ('${ENC("c")}','window_id','bw_test_hi','exact'), ('${ENC("c")}','window_id','bw_test_00007','exact');
      INSERT INTO reb_track_index (id, window_id, ist_date, room_id, layer, engine, version, config_hash, status, r2_key, sha256) VALUES
        (15,'bw_test_lo','2026-10-19','r','stt','e','v1','cfg00000','ok','reb/c/lo.json','${SHA("3")}'), (999999,'bw_test_hi','2026-10-19','r','stt','e','v1','cfg00000','ok','reb/c/hi.json','${SHA("4")}');`);
    for (let i = 0; i < 4; i++) { const r = await run(); total += r.inserted; expect(r.counts.conflicts).toEqual({}); }
    const n = q1("SELECT count(*) FROM spine_artefact");
    expect([Number(n), total]).toEqual([5004, 5004]);
    expect(q1("SELECT count(*) FROM spine_artefact WHERE object_key IN ('consult-clips/a.flac','consult-clips/z.flac','reb/c/lo.json','reb/c/hi.json','reb/c/7.json')")).toBe("5");
    expect(q1("SELECT count(*) - count(DISTINCT object_key) FROM spine_artefact")).toBe("0");
  });

  it("A6 shadow never persists a cursor and reads the same first page every time; a live cursor is left untouched by shadow; off touches nothing", async () => {
    const cur0 = q1("SELECT value::text FROM spine_config WHERE key='artefacts_cursor'");
    setMode('"shadow"');
    const s1 = await run(); const s2 = await run();
    expect(q1("SELECT value::text FROM spine_config WHERE key='artefacts_cursor'")).toBe(cur0);
    expect(s1.counts).toEqual(s2.counts); expect(s1.inserted).toBe(0);
    setMode('"on"');
    const calls: string[] = [];
    const db: SpineDb = async (t, p) => { calls.push(t); return dbAs("postgres", [])(t, p); };
    const o = await indexSpineArtefacts(NOW, db, NO_BLIND);
    expect([o.mode, calls.length]).toEqual(["off", 1]);
    expect(q1("SELECT value::text FROM spine_config WHERE key='artefacts_cursor'")).toBe(cur0);
  });

  it("A7 catalog: a layers key named 'clip' ties the clip row's pk at a page boundary; the tied row must still be indexed eventually", async () => {
    wipe(); setMode('"live"');
    ex(`${enc("k")} INSERT INTO spine_link (encounter_id, key_kind, value, basis) VALUES ('${ENC("k")}','consult_uid','cu_test_k02000','exact');
      INSERT INTO encounter_catalog (consult_uid, clip) SELECT 'cu_test_k'||lpad(g::text,5,'0'), jsonb_build_object('r2_key','consult-clips/k'||g||'.flac') FROM generate_series(1,1999) g;
      INSERT INTO encounter_catalog (consult_uid, clip, layers) VALUES ('cu_test_k02000','{"r2_key":"consult-clips/kx.flac"}','{"clip":{"r2_key":"reb/k/layerclip.json","status":"ok"}}');`);
    for (let i = 0; i < 4; i++) await run();
    expect(q1(`SELECT count(*) FROM spine_artefact WHERE encounter_id='${ENC("k")}'`)).toBe("2");
  });

  it("A8 cost: the catalog page (2000 consults x 3 layers, dup probe) against 60k reb rows and 2000 consult_index rows; same rows as the old query, bounded plan work, also at 2x data", async () => {
    wipe(); setMode('"shadow"');
    ex(`${enc("c")}
      INSERT INTO encounter_catalog (consult_uid, clip, layers) SELECT 'cu_test_q'||lpad(g::text,5,'0'), jsonb_build_object('r2_key','consult-clips/q'||g||'.flac'),
        jsonb_build_object('stt', jsonb_build_object('r2_key','reb/q/'||g||'.json','status','ok'), 'diar', jsonb_build_object('r2_key','reb/q/d'||g||'.json','status','ok')) FROM generate_series(1,2000) g;
      INSERT INTO consult_index (consult_uid, room_id, room_slug, ist_date, t0_ms, t1_ms, clip_r2_key, cut_version, code_commit, source_sha256) SELECT 'cu_test_q'||lpad(g::text,5,'0'),'r','rs','2026-10-19',1,2,'consult-clips/q'||g||'.flac','cv1','c1',md5(g::text)||md5(g::text) FROM generate_series(1,2000) g;
      INSERT INTO spine_link (encounter_id, key_kind, value, basis) SELECT '${ENC("c")}','consult_uid','cu_test_q'||lpad(g::text,5,'0'),'exact' FROM generate_series(1,1000) g;
      INSERT INTO reb_track_index (window_id, ist_date, room_id, layer, engine, version, config_hash, status, r2_key, sha256) SELECT 'bw_test_q'||g,'2026-10-19',CASE WHEN g <= 100 THEN 'rb' ELSE 'r' END,'stt','e','v'||g,'c','ok','reb/q/'||g||'.json',md5(g::text)||md5(g::text) FROM generate_series(1,60000) g;
      INSERT INTO spine_link (encounter_id, key_kind, value, basis) SELECT '${ENC("c")}','window_id','bw_test_q'||g,'exact' FROM generate_series(1,60000) g;
      ANALYZE;`);
    const PAGE = 2000; // ROW_LIMIT of the index
    const bind = (sql: string, blind: string[]) => sql.replace("$1", "''").replace(/\$2::text\[\]/g, `ARRAY[${blind.map((b) => `'${b}'`).join(",")}]::text[]`);
    const rowsOf = (sql: string) => q1(`SELECT count(*) || ' ' || md5(coalesce(string_agg(t::text, E'\\n' ORDER BY t.pk COLLATE "C"), '')) FROM (${sql}) t`);
    /** Plan work from EXPLAIN (ANALYZE): the worst "Rows Removed by Join Filter" of any node, and the work summed over all nodes: rows x loops of every node plus the rows each node discarded (scan "Rows Removed by Filter" and "Rows Removed by Join Filter", both reported per loop, so x loops). No wall clock. */
    const cost = (sql: string) => {
      const lines = q1(`EXPLAIN (ANALYZE) ${sql}`).split("\n");
      const removed = lines.map((l) => Number(/Rows Removed by Join Filter: (\d+)/.exec(l)?.[1] ?? 0));
      let work = 0, loops = 1;
      for (const l of lines) {
        const m = /actual time=\S+ rows=(\d+) loops=(\d+)/.exec(l);
        if (m) { loops = Number(m[2]); work += Number(m[1]) * loops; continue; }
        // Detail lines belong to the node header above them. A correlated Seq Scan with empty output still reads and discards every row on every loop, so its discards count as work.
        const d = /Rows Removed by (?:Join )?Filter: (\d+)/.exec(l);
        if (d) work += Number(d[1]) * loops;
      }
      return { maxJoinFilterRemoved: Math.max(0, ...removed), work };
    };
    // K: a page may discard up to 10 rows per output row by join filter (a hash join with a residual condition discards a few; the old nested loop discarded 50k per output row).
    const K = 10 * PAGE;
    // Work: each node's rows x loops summed. The index scans (reb 60k, link 60k, hash builds, sorts) are linear in the TABLES, not the page, so the bound is 400 x page = 800k at 60k reb rows (the fixed plan measures ~550k), scaled with the table; the old plan did 10^8.
    const WORK_BOUND = (rebRows: number) => 400 * PAGE * (rebRows / 60000);
    // The pre-fix query, kept verbatim as the negative control: the joins sit under ORDER BY/LIMIT with no fence.
    const pk = "(c.consult_uid || chr(31) || c.kind)";
    const OLD_SQL = `SELECT s.consult_uid, c.layer, c.r2_key, c.sha256, c.status, c.dup_source, c.blind, l.encounter_id, ${pk} AS pk
    FROM (SELECT k.consult_uid, 'clip' AS layer, 'c' AS kind, k.clip->>'r2_key' AS r2_key, k.clip->>'sha256' AS sha256, NULL::text AS status FROM encounter_catalog k
            WHERE jsonb_typeof(k.clip) = 'object' AND k.clip->>'r2_key' IS NOT NULL
          UNION ALL
          SELECT k.consult_uid, e.key, 'l' || chr(31) || e.key, e.value->>'r2_key', NULL::text, e.value->>'status' FROM encounter_catalog k
            CROSS JOIN LATERAL jsonb_each(CASE WHEN jsonb_typeof(k.layers) = 'object' THEN k.layers ELSE '{}'::jsonb END) e
            WHERE jsonb_typeof(e.value) = 'object' AND e.value->>'r2_key' IS NOT NULL) c0
         JOIN encounter_catalog s ON s.consult_uid = c0.consult_uid
         LEFT JOIN spine_link l ON l.key_kind = 'consult_uid' AND l.value = c0.consult_uid AND l.active
         LEFT JOIN (SELECT rt.r2_key, array_agg(DISTINCT wl.encounter_id) AS encs FROM reb_track_index rt JOIN spine_link wl ON wl.key_kind = 'window_id' AND wl.value = rt.window_id AND wl.active
                     WHERE NOT ${blindDaySql("rt.ist_date", "rt.room_id")} GROUP BY rt.r2_key) rd ON rd.r2_key = c0.r2_key
         LEFT JOIN (SELECT DISTINCT rb.r2_key FROM reb_track_index rb WHERE ${blindDaySql("rb.ist_date", "rb.room_id")}) rbl ON rbl.r2_key = c0.r2_key
         CROSS JOIN LATERAL (SELECT c0.consult_uid, c0.layer, c0.kind, c0.r2_key, c0.sha256, c0.status,
            (COALESCE(l.encounter_id = ANY(rd.encs), false) OR EXISTS (SELECT 1 FROM consult_index ci WHERE ci.consult_uid = c0.consult_uid AND ci.clip_r2_key = c0.r2_key)) AS dup_source,
            (rbl.r2_key IS NOT NULL OR ${blindDaySql("s.ist_date", "s.room_id")}
              OR EXISTS (SELECT 1 FROM consult_index cb WHERE cb.consult_uid = c0.consult_uid AND ${blindDaySql("cb.ist_date", "cb.room_id")})) AS blind) c
    WHERE ${pk} COLLATE "C" > $1 ORDER BY ${pk} COLLATE "C" LIMIT ${PAGE}`;

    for (const blind of [[], ["2026-10-19|rb"]]) {
      const fixed = bind(catalogPageSql(PAGE), blind);
      expect(rowsOf(fixed), `same rows as the old query, blind=${blind.length}`).toBe(rowsOf(bind(OLD_SQL, blind)));
      expect(rowsOf(fixed).startsWith(`${PAGE} `)).toBe(true);
    }
    expect(q1(`SELECT count(*) FROM (${bind(catalogPageSql(PAGE), [])}) t WHERE dup_source`)).not.toBe("0");
    expect(q1(`SELECT count(*) FROM (${bind(catalogPageSql(PAGE), ["2026-10-19|rb"])}) t WHERE blind`)).not.toBe("0");

    // Production binds a default blind list (at least 2 entries), so the plan is measured with it too: a join that is hashable with an empty list may not be with a non-empty one.
    const BLIND2 = ["2026-10-19|rb", "2026-10-18|rb"];
    const fixed1 = cost(bind(catalogPageSql(PAGE), []));
    const fixed1b = cost(bind(catalogPageSql(PAGE), BLIND2));
    console.log(`A8 catalog page fixed: ${JSON.stringify(fixed1)} blind: ${JSON.stringify(fixed1b)} old: ${JSON.stringify(cost(bind(OLD_SQL, [])))}`);
    expect(fixed1.maxJoinFilterRemoved, "fixed: join-filter discards").toBeLessThanOrEqual(K);
    expect(fixed1.work, "fixed: total plan rows").toBeLessThanOrEqual(WORK_BOUND(60000));
    expect(fixed1b.maxJoinFilterRemoved, "fixed, blind set: join-filter discards").toBeLessThanOrEqual(K);
    expect(fixed1b.work, "fixed, blind set: total plan rows").toBeLessThanOrEqual(WORK_BOUND(60000));
    // Negative control: the guard must reject the old plan.
    const old1 = cost(bind(OLD_SQL, []));
    expect(old1.maxJoinFilterRemoved > K || old1.work > WORK_BOUND(60000), `the guard failed to flag the old plan: ${JSON.stringify(old1)}`).toBe(true);

    // 2x data: the fixed plan stays inside the bound (scaled to the table), the old one stays out.
    ex(`INSERT INTO reb_track_index (window_id, ist_date, room_id, layer, engine, version, config_hash, status, r2_key, sha256) SELECT 'bw_test_q'||g,'2026-10-19','r','stt','e','v'||g,'c','ok','reb/q/'||g||'.json',md5(g::text)||md5(g::text) FROM generate_series(60001,120000) g;
      INSERT INTO spine_link (encounter_id, key_kind, value, basis) SELECT '${ENC("c")}','window_id','bw_test_q'||g,'exact' FROM generate_series(60001,120000) g;
      ANALYZE;`);
    const fixed2 = cost(bind(catalogPageSql(PAGE), []));
    expect(fixed2.maxJoinFilterRemoved, "fixed 2x: join-filter discards").toBeLessThanOrEqual(K);
    expect(fixed2.work, "fixed 2x: total plan rows").toBeLessThanOrEqual(WORK_BOUND(120000));
    const fixed2b = cost(bind(catalogPageSql(PAGE), BLIND2));
    expect(fixed2b.maxJoinFilterRemoved, "fixed 2x, blind set: join-filter discards").toBeLessThanOrEqual(K);
    expect(fixed2b.work, "fixed 2x, blind set: total plan rows").toBeLessThanOrEqual(WORK_BOUND(120000));
    const old2 = cost(bind(OLD_SQL, []));
    expect(old2.maxJoinFilterRemoved > K || old2.work > WORK_BOUND(120000), `the guard failed to flag the old plan at 2x: ${JSON.stringify(old2)}`).toBe(true);
  }, 300000);
});

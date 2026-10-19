/**
 * spine-schema-pg.test.ts — migration 0173 (Spine S0) against a REAL postgres:16 (never on the Mini). Ids are synthetic; no text anywhere.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { readFileSync } from "node:fs";
import { dockerAvailable, pgContainer } from "../support/s1-pg";

const HAVE_DOCKER = dockerAvailable();
const ALLOW_SKIP = process.env.ETA_ALLOW_SKIP_E2E === "1";
const pg = pgContainer("eta-spine-schema");
const UP = readFileSync("db/migrations/0173_spine.sql", "utf8");
const DOWN = readFileSync("db/rollbacks/0173_spine.down.sql", "utf8");

describe("REQUIRED PROOF — spine schema runs against a real postgres", () => {
  it("ran, or was skipped deliberately", () => {
    if (HAVE_DOCKER || ALLOW_SKIP) return;
    throw new Error("REQUIRED PROOF NOT RUN: tests/unit/spine-schema-pg.test.ts needs Docker for postgres:16 (not on the Mini). Run it on c3 / the lab box, or set ETA_ALLOW_SKIP_E2E=1 to accept that it was not proven.");
  });
});

const TABLES = ["spine_artefact", "spine_config", "spine_encounter", "spine_job", "spine_link", "spine_signal", "spine_tick"];
const E1 = "enc_testaaaaaaaaaaaa";
const E2 = "enc_testbbbbbbbbbbbb";

const d = HAVE_DOCKER ? describe : describe.skip;
d("spine schema on postgres:16", () => {
  const rejects = (sqlText: string) => expect(() => pg.exec(sqlText)).toThrow();
  const names = async (q: string) => ((await pg.sql(Object.assign([q], { raw: [q] }) as unknown as TemplateStringsArray)) as Array<Record<string, unknown>>).map((r) => Object.values(r)[0] as string);
  const spineObjects = () => names("SELECT relname FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND relname LIKE 'spine\\_%' ORDER BY 1");
  const sig = (cols: string, vals: string) => `INSERT INTO spine_signal (proxy, source_key, source_rev, t_open, observed_at${cols}) VALUES ${vals};`;

  beforeAll(() => {
    pg.start();
    pg.exec("CREATE TABLE schema_migrations (version integer PRIMARY KEY, name text NOT NULL);");
    pg.exec(UP);
  });
  afterAll(() => { pg.stop(); });

  it("creates every table and registers itself", async () => {
    const tabs = (await names("SELECT table_name FROM information_schema.tables WHERE table_schema='public' AND table_name LIKE 'spine\\_%' ORDER BY 1"));
    expect(tabs).toEqual(TABLES);
    expect(await names("SELECT name FROM schema_migrations WHERE version = 173")).toEqual(["0173_spine"]);
    expect(await names("SELECT count(*)::text FROM spine_config")).toEqual(["0"]);
  });

  it("spine_signal: proxy CHECK, attrs CHECK, UNIQUE (proxy, source_key, source_rev)", () => {
    pg.exec(sig("", "('pulse','k1',1,now(),now())"));
    pg.exec(sig(", attrs", `('cutter','k2',1,now(),now(),'{"ids":["a"],"quality":1,"close_reason":"x"}')`));
    rejects(sig("", "('bogus','k3',1,now(),now())"));
    rejects(sig(", attrs", `('pqm','k4',1,now(),now(),'{"text":"x"}')`));
    rejects(sig(", attrs", `('pqm','k5',1,now(),now(),'[1]')`));
    rejects(sig("", "('pulse','k1',1,now(),now())"));
    pg.exec(sig("", "('pulse','k1',2,now(),now())"));
    pg.exec(sig("", "('nemotron_window','k6',1,now(),now())"));
  });

  it("spine_signal: attrs refuse identity-like keys at any depth, arrays included; id keys allowed; t_close >= t_open", () => {
    const a = (k: string, json: string) => sig(", attrs", `('pqm','${k}',1,now(),now(),'${json}')`);
    rejects(a("d1", '{"ids":{"text":"x"}}'));
    rejects(a("d2", '{"ids":{"a":{"Phone":1}}}'));
    rejects(a("d3", '{"quality":{"a":{"b":{"transcript":1}}}}'));
    rejects(a("d4", '{"quality":[{"patient_id":1}]}'));
    rejects(a("d5", '{"ids":[[{"x":{"EMAIL":1}}]]}'));
    rejects(a("d6", '{"ids":{"uhid":1}}'));
    rejects(a("d7", '{"ids":{"firstname":1}}'));
    pg.exec(a("ok1", '{"ids":{"consult_uid":"uid_test_01","window_id":"w1"},"quality":[{"score":1}],"close_reason":"x"}'));
    pg.exec(a("ok2", '{"ids":[{"pqm_uid":"uid_test_02"}]}'));
    rejects(sig(", t_close", "('pulse','kc',1, now(), now(), now() - interval '1 minute')"));
    pg.exec(sig(", t_close", "('pulse','kc',1, now(), now(), now())"));
  });

  it("spine_encounter: id format CHECK (incl. no 8-digit run), status CHECK, primary key", () => {
    const ins = (id: string, status: string) => `INSERT INTO spine_encounter (encounter_id, ist_date, t_open, status, merge_version) VALUES ('${id}', '2026-10-19', now(), '${status}', 'mv1');`;
    pg.exec(ins(E1, "candidate"));
    pg.exec(ins(E2, "merged"));
    rejects(ins("enc_testcccccccccccc", "bogus"));
    rejects(ins("enc_TESTCCCCCCCCCCCC", "candidate"));
    rejects(ins("enc_short", "candidate"));
    rejects(ins("enc_testcccccccccccc9", "candidate"));
    rejects(ins("xnc_testcccccccccccc", "candidate"));
    rejects(ins("enc_22222222cccccccc", "candidate"));
    rejects(ins("enc_cc34567234cccccc", "candidate"));
    rejects(ins(E1, "candidate"));
    rejects(ins("enc_testddddddddddddd", "candidate")); // 17 chars
    for (const bad of ["enc_testeeeeeeeeeee0", "enc_testeeeeeeeeeee1", "enc_testeeeeeeeeeee8", "enc_testeeeeeeeeeee9"]) rejects(ins(bad, "candidate"));
    pg.exec(ins("enc_test2345a2345a23", "candidate"));
  });

  it("spine_encounter: boundary_rev defaults to 0; t_close before t_open refused", async () => {
    expect(await names("SELECT boundary_rev::text FROM spine_encounter WHERE encounter_id = '" + E1 + "'")).toEqual(["0"]);
    const ins = (id: string, close: string) => `INSERT INTO spine_encounter (encounter_id, ist_date, t_open, t_close, status, merge_version) VALUES ('${id}', '2026-10-19', now(), ${close}, 'candidate', 'mv1');`;
    rejects(ins("enc_testffffffffffff", "now() - interval '1 minute'"));
    pg.exec(ins("enc_testffffffffffff", "now()"));
  });

  it("spine_link: kind and basis CHECKs; partial unique allows a duplicate only when the old row is inactive", () => {
    const ins = (kind: string, val: string, basis: string, active = true) => `INSERT INTO spine_link (encounter_id, key_kind, value, basis, active) VALUES ('${E1}', '${kind}', '${val}', '${basis}', ${active});`;
    pg.exec(ins("consult_uid", "uid_test_01", "exact"));
    rejects(ins("bogus", "uid_test_02", "exact"));
    rejects(ins("pqm_uid", "uid_test_02", "bogus"));
    rejects(ins("consult_uid", "uid_test_01", "merge"));
    pg.exec("UPDATE spine_link SET active = false WHERE value = 'uid_test_01';");
    pg.exec(ins("consult_uid", "uid_test_01", "merge"));
    pg.exec(ins("consult_uid", "uid_test_01", "merge", false));
    rejects(`INSERT INTO spine_link (encounter_id, key_kind, value, basis) VALUES ('enc_testzzzzzzzzzzzz', 'pqm_uid', 'uid_test_09', 'exact');`);
  });

  it("spine_artefact: store and status CHECKs, UNIQUE key", () => {
    const ins = (store: string, status: string, ver = "v1") => `INSERT INTO spine_artefact (encounter_id, stage, engine, version, cfg8, cut_version, store, status) VALUES ('${E1}', 'stt', 'eng', '${ver}', 'cfg00000', 'cv1', '${store}', '${status}');`;
    pg.exec(ins("r2", "ok"));
    rejects(ins("bogus", "ok", "v2"));
    rejects(ins("r2", "bogus", "v2"));
    rejects(ins("box", "empty"));
    pg.exec(ins("box", "empty", "v2"));
    const cv = (c: string) => `INSERT INTO spine_artefact (encounter_id, stage, engine, version, cfg8, cut_version, store, status) VALUES ('${E1}', 'stt', 'eng', 'v9', 'cfg00000', '${c}', 'r2', 'ok');`;
    pg.exec(cv("cvA"));
    pg.exec(cv("cvB"));
    rejects(cv("cvA"));
  });

  it("spine_job: status and error-class CHECKs, UNIQUE key, no status default", async () => {
    const ins = (status: string, key = "in1", cls = "NULL") => `INSERT INTO spine_job (encounter_id, stage, cut_version, input_key, status, last_error_class) VALUES ('${E1}', 'stt', 'cv1', '${key}', '${status}', ${cls});`;
    pg.exec(ins("shadow"));
    rejects(ins("bogus", "in2"));
    rejects(ins("queued", "in3", "'bogus'"));
    rejects(ins("queued"));
    pg.exec(ins("queued", "in4", "'budget'"));
    expect(await names("SELECT status FROM spine_job WHERE input_key = 'in4'")).toEqual(["queued"]);
    rejects(`INSERT INTO spine_job (encounter_id, stage, cut_version, input_key) VALUES ('${E1}', 'stt', 'cv1', 'in5');`);
  });

  it("spine_config and spine_tick: key is unique, counts must be an object", () => {
    pg.exec(`INSERT INTO spine_config (key, value) VALUES ('kill_switch', 'true');`);
    rejects(`INSERT INTO spine_config (key, value) VALUES ('kill_switch', 'false');`);
    pg.exec(`INSERT INTO spine_tick (kind, counts) VALUES ('cron', '{"n":1}');`);
    rejects(`INSERT INTO spine_tick (kind, counts) VALUES ('cron', '[1]');`);
  });

  it("rollback leaves no spine object and is repeatable; re-apply succeeds and is idempotent", async () => {
    pg.exec(UP);
    pg.exec(DOWN);
    expect(await spineObjects()).toEqual([]);
    expect(await names("SELECT count(*)::text FROM schema_migrations WHERE version = 173")).toEqual(["0"]);
    pg.exec(DOWN);
    pg.exec(UP);
    pg.exec(UP);
    expect((await spineObjects()).filter((n) => TABLES.includes(n))).toEqual(TABLES);
    expect(await names("SELECT count(*)::text FROM schema_migrations WHERE version = 173")).toEqual(["1"]);
  });

  it("rollback leaves a foreign schema_migrations row with version 173 and another name", async () => {
    pg.exec(DOWN);
    pg.exec("INSERT INTO schema_migrations (version, name) VALUES (173, '0173_other');");
    pg.exec(DOWN);
    expect(await names("SELECT name FROM schema_migrations WHERE version = 173")).toEqual(["0173_other"]);
    pg.exec("DELETE FROM schema_migrations WHERE version = 173;");
  });
});

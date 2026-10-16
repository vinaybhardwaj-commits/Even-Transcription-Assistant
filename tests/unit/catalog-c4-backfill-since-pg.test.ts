/**
 * JEV-C4-BACKFILL-SINCE, C4 side, on a REAL postgres:16 with every migration applied: the second paged scan (CATALOG_C4_BACKFILL_SINCE) after the live-window scan.
 * Synthetic ids and tokens only; no text.
 */
import { describe, it, expect, vi, beforeAll, afterAll, afterEach, beforeEach } from "vitest";
vi.setConfig({ testTimeout: 180_000 });
import { readdirSync, readFileSync } from "node:fs";
import { dockerAvailable, pgContainer } from "../support/s1-pg";

const H = vi.hoisted(() => ({
  tag: null as null | ((s: TemplateStringsArray, ...v: unknown[]) => Promise<unknown[]>),
  sqlCalls: 0,
  posted: [] as unknown[][],
  throwStep: false,
  beforeIngest: null as null | (() => void),   // FU2: runs just before the real ingest (a row deleted mid-tick)
  ingestDelayMs: 0,                              // FU2 G3: the ingest takes this long
  delayMs: 0,                                    // FU2 G3: every select takes this long
  onSql: null as null | ((n: number) => void),   // FIX1: runs on the nth statement of a tick (advances an injected clock)
}));
vi.mock("@/lib/db", () => {
  const fn = (a: TemplateStringsArray | string, ...v: unknown[]) => {
    H.sqlCalls += 1;
    H.onSql?.(H.sqlCalls);
    if (H.delayMs > 0 && typeof a !== "string") return new Promise((res, rej) => setTimeout(() => H.tag!(a, ...v).then(res, rej), H.delayMs));
    if (typeof a === "string") {   // ingestCatalogRows: sql(text, params)
      const params = v[0] as unknown[];
      const parts = a.split(/\$\d+/);
      return H.tag!(Object.assign(parts, { raw: parts }) as unknown as TemplateStringsArray, ...params);
    }
    return H.tag!(a, ...v);
  };
  return { sql: fn };
});
vi.mock("@/jev/question-sets", async (orig) => {
  const real = (await orig()) as { QUESTION_SET_FILES: unknown[] };
  const q = (id: string, kind: string, body: Record<string, unknown>) => ({ question_id: id, kind, body: { type: kind, instructions: "synthetic", ...body } });
  const syn = (id: string, qs: unknown[]) => ({ id, version: "t1", use: "consult_rubric", subject_type: "consult", state_schema: "synthetic", model_pin: "jev-1.13.0", created_by: "test", questions: qs });
  return {
    QUESTION_SET_FILES: [...real.QUESTION_SET_FILES,
      syn("syn-noul", [q("is_x", "noul", {})]),
      syn("syn-score", [q("level", "score", { criteria: ["none", "mild", "severe"] })])],
  };
});
vi.mock("@/lib/encounter-catalog/store", async (orig) => {
  const real = (await orig()) as typeof import("@/lib/encounter-catalog/store");
  return { ...real, ingestCatalogRows: async (rows: unknown[], opts?: unknown) => { H.posted.push(rows); H.beforeIngest?.(); if (H.ingestDelayMs > 0) await new Promise((r) => setTimeout(r, H.ingestDelayMs)); return real.ingestCatalogRows(rows as never, opts as never); } };
});

import { QUESTION_SET_FILES } from "@/jev/question-sets";
import { setSha, validateSetFile } from "@/lib/jev/worker/sets";
import { runCatalogC4Sync, catalogC4BackfillSince, zeroCounts, CATALOG_SYNC_BUDGET_MS, CATALOG_SYNC_HARD_MS } from "@/lib/jev/worker/catalog-sync";

const HAVE = dockerAvailable();
const ALLOW_SKIP = process.env.ETA_ALLOW_SKIP_E2E === "1";
const pg = pgContainer("eta-c4-backfill-since");
const ALL = readdirSync("db/migrations").filter((f) => f.endsWith(".sql")).sort();
const rows = async (q: TemplateStringsArray, ...v: unknown[]) => (await H.tag!(q, ...v)) as Array<Record<string, any>>;
const suite = HAVE || !ALLOW_SKIP ? describe : describe.skip;

const TODAY0 = "(date_trunc('day', now() AT TIME ZONE 'Asia/Kolkata') AT TIME ZONE 'Asia/Kolkata')";
const SHA: Record<string, string> = {};
const fileOf = (id: string) => QUESTION_SET_FILES.map((f) => validateSetFile(f)).find((f) => f.id === id)!;
let n = 0;

/** One window (+ optionally its catalog row). */
function win(key: string, uid: string, o: { daysAgo?: number; min?: number; catalog?: boolean } = {}): void {
  const { daysAgo = 0, min = 0, catalog = true } = o;
  const open = `${TODAY0} - interval '${daysAgo} days' + interval '${min} minutes'`;
  pg.exec(`INSERT INTO eta_encounter_windows (consult_key, consult_uid, machine, room_id, attribution, t_open, t_close, close_reason, quality, resolver_version)
           VALUES ('${key}', '${uid}', 'mc_1', 'rm_a', 'none', ${open}, ${open} + interval '1 second', 'endConsult', 'clean', 'v_t')`);
  if (catalog) pg.exec(`INSERT INTO encounter_catalog (consult_uid) VALUES ('${uid}') ON CONFLICT DO NOTHING`);
}
function decide(key: string, setId: string, qid: string, answer: unknown, o: { mode?: string; band?: string | null; model?: string; outcome?: string; evidence?: unknown; at?: string } = {}): void {
  const { mode = "shadow", band = "review", model = "jev-1.13.0", outcome = "answered", evidence = {}, at = "now()" } = o;
  const f = fileOf(setId);
  pg.exec(`INSERT INTO jev_decision (id, subject_type, subject_id, question_id, prompt_version, model, question_set_id, question_set_version, question_set_sha256, order_variant, mode, answer, band, outcome, evidence, created_at)
           VALUES ('jd_${++n}', 'consult', '${key}', '${qid}', 'pv', '${model}', '${setId}', '${f.version}', '${SHA[setId]}', 'derived', '${mode}', '${JSON.stringify(answer)}'::jsonb, ${band === null ? "NULL" : `'${band}'`}, '${outcome}', '${JSON.stringify(evidence)}'::jsonb, ${at === "now()" ? "now()" : `'${at}'`})`);
}
const affect = (uid: string, o: { cut?: string; started?: string; pv?: string; set?: string } = {}) => {
  const { cut = "cut1", started = "2026-10-15 03:00:00+00", pv = "tv1", set = "arousal_median = 3.2, arousal_raw_median = 0.4, arousal_open = 3.0, valence_median = 3.9, valence_raw_close = 0.7" } = o;
  pg.exec(`INSERT INTO affect_run (pipeline_version, git_sha, compute, speaker_source, arousal_model_id, arousal_model_rev, fallback_model_id, fallback_model_rev, valence_model_id, clef_question_set, purity_rule_version, purity_rule_json, calibration_arousal_id, calibration_valence_id, scope_json, input_manifest_sha256, state, started_at, n_consults, n_windows, n_scorable)
           VALUES ('${pv}', '${"a".repeat(40)}', 'cpu_dev', 'segments', 'a', 'r', 'f', 'r', 'v', 'q', 'pr', '{}', 1, 2, '{}', 'x', 'ok', '${started}', 1, 5, 3);`);
  pg.exec(`INSERT INTO affect_consult (run_id, consult_uid, cut_version, ist_date, n_windows, n_scorable, scorable_pct, doctor_uid8, room_slug, n_too_short, ${set.split(",").map((s) => s.split("=")[0]!.trim()).join(", ")})
           VALUES ((SELECT max(id) FROM affect_run), '${uid}', '${cut}', '2026-10-15', 5, 3, 60.0, 'abcd1234', 'rm_slug', 2, ${set.split(",").map((s) => s.split("=")[1]!.trim()).join(", ")})`);
};
const catalogOf = async (uid: string) => (await rows`SELECT jev, clef_affect, ist_date, generated_at FROM encounter_catalog WHERE consult_uid = ${uid}`)[0];
const wipe = () => pg.exec("DELETE FROM encounter_catalog; DELETE FROM jev_decision; DELETE FROM eta_encounter_windows; DELETE FROM affect_consult; DELETE FROM affect_run;");
const on = () => { process.env.CATALOG_C4_SYNC_ENABLED = "1"; };
  const bulkWins = (prefix: string, count: number, daysAgo: number) => pg.exec(
    `INSERT INTO eta_encounter_windows (consult_key, consult_uid, machine, room_id, attribution, t_open, t_close, close_reason, quality, resolver_version)
     SELECT '${prefix}_' || g || '@ma', '${prefix}u_' || lpad(g::text, 4, '0'), 'mc_1', 'rm_a', 'none', ${TODAY0} - interval '${daysAgo} days' + g * interval '1 second', ${TODAY0} - interval '${daysAgo} days' + g * interval '1 second' + interval '1 second', 'endConsult', 'clean', 'v_t'
       FROM generate_series(1, ${count}) g;
     INSERT INTO encounter_catalog (consult_uid) SELECT '${prefix}u_' || lpad(g::text, 4, '0') FROM generate_series(1, ${count}) g;`);
  const bulkDecisions = (prefix: string, count: number, sha: string, version: string, evidence: string) => pg.exec(
    `INSERT INTO jev_decision (id, subject_type, subject_id, question_id, prompt_version, model, question_set_id, question_set_version, question_set_sha256, order_variant, mode, answer, band, outcome, evidence)
     SELECT 'jd${prefix}_' || g, 'consult', '${prefix}_' || g || '@ma', 'distress', 'pv', 'jev-1.13.0', 'chair-affect', '${version}', '${sha}', 'derived', 'shadow', '{"type":"choice","choice":"low"}', 'review', 'answered', '${evidence}'::jsonb FROM generate_series(1, ${count}) g;`);

const istDay = (daysAgo: number): string => new Date(Date.now() + 5.5 * 3_600_000 - daysAgo * 86_400_000).toISOString().slice(0, 10);
const infoLines = (spy: { mock: { calls: unknown[][] } }) => spy.mock.calls.map((c) => String(c[0]));
const tickOf = (spy: { mock: { calls: unknown[][] } }) => JSON.parse(infoLines(spy).find((l) => l.startsWith("catalog_c4 tick "))!.slice("catalog_c4 tick ".length));
const vclock = () => { const k = { t: 0 }; return { k, now: () => k.t }; };
/** `count` consults `daysAgo` days back, each with an answered current-sha decision and a catalog block that is NOT the shape the sync writes: they are candidates, yield no row (invariant_dropped). */
const bulkSilent = (prefix: string, count: number, daysAgo: number) => pg.exec(
  `INSERT INTO eta_encounter_windows (consult_key, consult_uid, machine, room_id, attribution, t_open, t_close, close_reason, quality, resolver_version)
   SELECT '${prefix}_' || g || '@ma', '${prefix}u_' || lpad(g::text, 5, '0'), 'mc_1', 'rm_a', 'none', ${TODAY0} - interval '${daysAgo} days' + g * interval '1 second', ${TODAY0} - interval '${daysAgo} days' + g * interval '1 second' + interval '1 second', 'endConsult', 'clean', 'v_t'
     FROM generate_series(1, ${count}) g;
   INSERT INTO encounter_catalog (consult_uid, jev) SELECT '${prefix}u_' || lpad(g::text, 5, '0'), '{"x":1}'::jsonb FROM generate_series(1, ${count}) g;
   INSERT INTO jev_decision (id, subject_type, subject_id, question_id, prompt_version, model, question_set_id, question_set_version, question_set_sha256, order_variant, mode, answer, band, outcome, evidence)
   SELECT 'jd${prefix}_' || g, 'consult', '${prefix}_' || g || '@ma', 'distress', 'pv', 'jev-1.13.0', 'chair-affect', 'v0', '${SHA["chair-affect"]}', 'derived', 'shadow', '{"type":"choice","choice":"low"}', 'review', 'answered', '{}'::jsonb FROM generate_series(1, ${count}) g;`);
const cd = (key: string, uid: string, daysAgo: number) => { win(key, uid, { daysAgo }); decide(key, "chair-affect", "distress", { type: "choice", choice: "low" }); };

suite("CATALOG-C4 backfill since — second scan", () => {
  beforeAll(() => {
    if (!HAVE) throw new Error("docker is required (set ETA_ALLOW_SKIP_E2E=1 to skip)");
    pg.start();
    H.tag = pg.sql;
    pg.exec("CREATE ROLE brain_svc NOLOGIN;");
    for (const f of ALL) pg.exec(readFileSync(`db/migrations/${f}`, "utf8"));
    const f = fileOf("chair-affect");
    SHA["chair-affect"] = setSha(f);
    pg.exec(`INSERT INTO jev_question_set (id, version, use, subject_type, state_schema, model_pin, content_sha256, status, created_by, ratified_by, ratified_at)
             VALUES ('${f.id}', '${f.version}', '${f.use}', '${f.subject_type}', 'x', '${f.model_pin}', '${SHA["chair-affect"]}', 'shadow', 'test', 'v', now())`);
  }, 300_000);
  afterAll(() => pg.stop());
  beforeEach(() => { wipe(); H.posted.length = 0; H.sqlCalls = 0; H.beforeIngest = null; H.ingestDelayMs = 0; H.delayMs = 0; H.onSql = null; });
  afterEach(() => { delete process.env.CATALOG_C4_SYNC_ENABLED; delete process.env.CATALOG_C4_BACKFILL_SINCE; });
  const sinceOn = (daysAgo = 14) => { process.env.CATALOG_C4_BACKFILL_SINCE = istDay(daysAgo); };
  const posted = () => H.posted.flat().map((r) => (r as { consult_uid: string }).consult_uid).sort();

  it("env parse: absent, empty, junk, bad calendar date, before the floor and the future are OFF; a valid date and today are on", () => {
    const NOW = Date.UTC(2026, 9, 16, 12, 0, 0);
    const old = process.env.CATALOG_C4_BACKFILL_SINCE;
    try {
      for (const v of [undefined, "", "junk", "2026-09-31", "2026-02-30", "2026-08-31", "2026-10-17"]) {
        if (v === undefined) delete process.env.CATALOG_C4_BACKFILL_SINCE; else process.env.CATALOG_C4_BACKFILL_SINCE = v;
        expect(catalogC4BackfillSince(NOW), String(v)).toBeNull();
      }
      for (const v of ["2026-09-09", "2026-10-16", "2026-09-01"]) { process.env.CATALOG_C4_BACKFILL_SINCE = v; expect(catalogC4BackfillSince(NOW)).toBe(v); }
    } finally { if (old === undefined) delete process.env.CATALOG_C4_BACKFILL_SINCE; else process.env.CATALOG_C4_BACKFILL_SINCE = old; }
  });
  it("OFF: only the live-window consult is posted, backfill_rows is 0, the tick line carries it, and the result equals the base shape", async () => {
    on();
    cd("cx_live@ma", "u_live", 3); cd("cx_old@ma", "u_old", 10);
    const spy = vi.spyOn(console, "info").mockImplementation(() => {});
    try {
      const r = await runCatalogC4Sync();
      expect(r).toMatchObject({ posted: 1, updated: 1, backfill_rows: 0, error_class: null });
      expect({ ...r, backfill_rows: undefined }).toEqual({ ...zeroCounts(), posted: 1, updated: 1, backfill_rows: undefined });
      expect(tickOf(spy)).toEqual({ ...r, ms: expect.any(Number) });
      expect(JSON.parse(infoLines(spy)[1]!.slice("catalog_c4 ceiling ".length))).toEqual({ pages: 1, candidates_scanned: 1, max_pages: 10, page_size: 500 });
    } finally { spy.mockRestore(); }
    expect(posted()).toEqual(["u_live"]);
    expect((await catalogOf("u_old"))!.jev).toBeNull();
  });
  it("ON: the second scan runs after the first is exhausted; both are posted; backfill_rows counts the older one only", async () => {
    on(); sinceOn();
    cd("cx_live@ma", "u_live", 3); cd("cx_old@ma", "u_old", 10); cd("cx_older@ma", "u_older", 12);
    const spy = vi.spyOn(console, "info").mockImplementation(() => {});
    try {
      const r = await runCatalogC4Sync();
      expect(r).toMatchObject({ posted: 3, updated: 3, inserted: 0, backfill_rows: 2, error_class: null, budget_hit: false });
      expect(tickOf(spy).backfill_rows).toBe(2);
      expect(JSON.parse(infoLines(spy)[1]!.slice("catalog_c4 ceiling ".length))).toMatchObject({ pages: 2, candidates_scanned: 3 });
    } finally { spy.mockRestore(); }
    expect(posted()).toEqual(["u_live", "u_old", "u_older"]);
    expect((await catalogOf("u_old"))!.jev.sets[0]).toMatchObject({ set_id: "chair-affect:distress", state: "current" });
  });
  it("the SINCE bound is inclusive at 00:00 IST for the consult's first t_open; a consult first opened before it is out", async () => {
    on(); sinceOn(10);
    cd("cx_in@ma", "u_in", 10); win("cx_out@ma", "u_out", { daysAgo: 10, min: -1 }); decide("cx_out@ma", "chair-affect", "distress", { type: "choice", choice: "low" });
    await runCatalogC4Sync();
    expect(posted()).toEqual(["u_in"]);
  });
  it("a uid whose windows straddle the 8-day boundary is scanned once (first scan only); one whose first window is before SINCE is out", async () => {
    on(); sinceOn(14);
    win("cx_s1@ma", "u_0801", { daysAgo: 9 }); win("cx_s2@ma", "u_0801", { daysAgo: 2 }); decide("cx_s1@ma", "chair-affect", "distress", { type: "choice", choice: "low" });
    win("cx_t1@ma", "u_0802", { daysAgo: 20 }); win("cx_t2@ma", "u_0802", { daysAgo: 11 }); decide("cx_t2@ma", "chair-affect", "distress", { type: "choice", choice: "low" });
    const r = await runCatalogC4Sync();
    expect(r).toMatchObject({ posted: 1, backfill_rows: 0 });
    expect(posted()).toEqual(["u_0801"]);
  });
  it("the second scan does not run after BATCH_ROWS is reached (520 live candidates, 500 rows)", async () => {
    on(); sinceOn();
    bulkWins("p", 520, 3); bulkDecisions("p", 520, SHA["chair-affect"]!, "v0", "{}");
    cd("cx_old@ma", "u_old", 10);
    const r = await runCatalogC4Sync();
    expect(r).toMatchObject({ posted: 500, backfill_rows: 0 });
    expect(posted()).not.toContain("u_old");
  });
  it("the second scan does not run after budget_hit (the live scan stops on the budget with another page due)", async () => {
    on(); sinceOn();
    bulkSilent("s", 600, 3);      // two pages, no rows: the first scan needs page 2
    cd("cx_old@ma", "u_old", 10);
    const { k, now } = vclock();
    H.onSql = (n) => { if (n === 4) k.t = CATALOG_SYNC_BUDGET_MS + 1; };      // calls 1-4 are page 1 (candidates, sets, jev picks, clef picks)
    const r = await runCatalogC4Sync(now);
    expect(r).toMatchObject({ budget_hit: true, posted: 0, backfill_rows: 0, error_class: null });
    expect(H.sqlCalls).toBe(4);
    expect(H.posted).toHaveLength(0);
  });
  it("the budget can also run out between the scans: the second scan starts no select and posts the live rows", async () => {
    on(); sinceOn();
    cd("cx_live@ma", "u_live", 3); cd("cx_old@ma", "u_old", 10);
    const { k, now } = vclock();
    H.onSql = (n) => { if (n === 4) k.t = CATALOG_SYNC_BUDGET_MS + 1; };
    const r = await runCatalogC4Sync(now);
    expect(r).toMatchObject({ budget_hit: true, posted: 1, backfill_rows: 0 });
    expect(posted()).toEqual(["u_live"]);
    expect(H.sqlCalls).toBe(5);      // 4 selects + 1 ingest, no second-scan select
  });
  it("the hard deadline during the second scan keeps the live rows and counts what the second scan had collected", async () => {
    on(); sinceOn();
    cd("cx_live@ma", "u_live", 3); cd("cx_old@ma", "u_old", 10);
    const { k, now } = vclock();
    H.onSql = (n) => { if (n === 5) k.t = CATALOG_SYNC_HARD_MS + 1; };      // call 5 = the second scan's candidates select
    const r = await runCatalogC4Sync(now);
    expect(r).toMatchObject({ budget_hit: true, backfill_rows: 0 });
    expect(H.posted).toHaveLength(0);      // no time left for the ingest either (FIX1)
  });
  it("the second scan does not run after MAX_PAGES (5,200 live candidates fill all 10 pages)", async () => {
    on(); sinceOn();
    bulkSilent("m", 5200, 3);
    cd("cx_old@ma", "u_old", 10);
    const spy = vi.spyOn(console, "info").mockImplementation(() => {});
    try {
      const r = await runCatalogC4Sync();
      expect(r).toMatchObject({ posted: 0, backfill_rows: 0, error_class: null });
      expect(JSON.parse(infoLines(spy)[1]!.slice("catalog_c4 ceiling ".length))).toMatchObject({ pages: 10, candidates_scanned: 5000 });
    } finally { spy.mockRestore(); }
    expect((await catalogOf("u_old"))!.jev).toBeNull();
  });
  it("MAX_PAGES is shared: 9 pages live (4,400 candidates) leave one for the second scan", async () => {
    on(); sinceOn();
    bulkSilent("m", 4400, 3);
    cd("cx_old@ma", "u_old", 10);
    const spy = vi.spyOn(console, "info").mockImplementation(() => {});
    try {
      const r = await runCatalogC4Sync();
      expect(r).toMatchObject({ posted: 1, backfill_rows: 1, error_class: null });
      expect(JSON.parse(infoLines(spy)[1]!.slice("catalog_c4 ceiling ".length))).toMatchObject({ pages: 10, candidates_scanned: 4401 });
    } finally { spy.mockRestore(); }
  });
  it("second-scan rows obey updateOnly and the unchanged test: no catalog row = no candidate and no insert; an up-to-date row is not posted again", async () => {
    on(); sinceOn();
    cd("cx_old@ma", "u_old", 10);
    win("cx_nocat@ma", "u_nocat", { daysAgo: 11, catalog: false }); decide("cx_nocat@ma", "chair-affect", "distress", { type: "choice", choice: "low" });
    const r1 = await runCatalogC4Sync();
    expect(r1).toMatchObject({ posted: 1, updated: 1, inserted: 0, missing: 0, backfill_rows: 1 });
    expect((await rows`SELECT count(*)::int AS c FROM encounter_catalog WHERE consult_uid = 'u_nocat'`)[0]!.c).toBe(0);
    const before = await catalogOf("u_old");
    H.posted.length = 0;
    const r2 = await runCatalogC4Sync();
    expect(r2).toMatchObject({ posted: 0, updated: 0, unchanged: 1, backfill_rows: 0 });
    expect(H.posted).toHaveLength(0);
    expect((await catalogOf("u_old"))!.jev).toEqual(before!.jev);
  });
  it("a retired entry on a second-scan consult is carried forward (never removed) by the same per-row logic", async () => {
    on(); sinceOn();
    cd("cx_old@ma", "u_old", 10);
    const gone = { set_id: "gone-set:q", set_sha: "c".repeat(64), band: "review", label: "low", model: "jev-1.13.0", at: "2026-09-10T00:00:00.000Z", state: "current" };
    pg.exec(`UPDATE encounter_catalog SET jev = '${JSON.stringify({ sets: [gone] })}'::jsonb WHERE consult_uid = 'u_old'`);
    const r = await runCatalogC4Sync();
    expect(r).toMatchObject({ posted: 1, retired: 1, backfill_rows: 1 });
    const sets = (await catalogOf("u_old"))!.jev.sets as Array<Record<string, unknown>>;
    expect(sets.find((s) => s.set_id === "gone-set:q")).toMatchObject({ state: "retired", set_sha: gone.set_sha });
    expect(sets.find((s) => s.set_id === "chair-affect:distress")).toMatchObject({ state: "current" });
  });
  it("flag off reads nothing even with SINCE set", async () => {
    sinceOn();
    cd("cx_old@ma", "u_old", 10);
    expect(await runCatalogC4Sync()).toEqual(zeroCounts());
    expect(H.sqlCalls).toBe(0);
  });
});

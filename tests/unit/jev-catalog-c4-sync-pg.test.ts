/**
 * CATALOG-C4-SYNC on a REAL postgres:16 with every migration applied: the in-process step that copies Jev answers and Clef affect onto EXISTING encounter_catalog rows.
 * Only the driver is a stand-in. Ids and tokens are synthetic; no text anywhere. The question-set list is the repo's own plus two synthetic consult sets (a noul and a score),
 * because no shipped consult set uses those kinds.
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
import { validateBatch } from "@/lib/encounter-catalog/store";
import { labelOf, runCatalogC4Sync, buildClef, zeroCounts, NOUL_YES_THRESHOLD, CATALOG_SYNC_BUDGET_MS, CATALOG_SYNC_STATEMENT_TIMEOUT_MS, CATALOG_SYNC_HARD_MS, mergeJev, carriesAllStored, storedEntries, type JevEntry } from "@/lib/jev/worker/catalog-sync";

const HAVE = dockerAvailable();
const ALLOW_SKIP = process.env.ETA_ALLOW_SKIP_E2E === "1";
const pg = pgContainer("eta-jev-catalog-c4");
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

suite("CATALOG-C4-SYNC — Jev and Clef into encounter_catalog", () => {
  beforeAll(() => {
    if (!HAVE) throw new Error("docker is required (set ETA_ALLOW_SKIP_E2E=1 to skip)");
    pg.start();
    H.tag = pg.sql;
    pg.exec("CREATE ROLE brain_svc NOLOGIN;");
    for (const f of ALL) pg.exec(readFileSync(`db/migrations/${f}`, "utf8"));
    pg.exec(`INSERT INTO affect_calibration_map (id, target, score_col, calib_version, min_n, fit_on, git_sha, sha256, payload) VALUES (1, 'arousal', 'a', 'v', 1, 'f', '${"a".repeat(40)}', '${"b".repeat(64)}', '{}'), (2, 'valence', 'v', 'v', 1, 'f', '${"a".repeat(40)}', '${"c".repeat(64)}', '{}')`);
    for (const id of ["chair-affect", "syn-noul", "syn-score"]) {
      const f = fileOf(id);
      SHA[id] = setSha(f);
      pg.exec(`INSERT INTO jev_question_set (id, version, use, subject_type, state_schema, model_pin, content_sha256, status, created_by, ratified_by, ratified_at)
               VALUES ('${f.id}', '${f.version}', '${f.use}', '${f.subject_type}', 'x', '${f.model_pin}', '${SHA[id]}', 'shadow', 'test', 'v', now())`);
    }
  }, 300_000);
  afterAll(() => pg.stop());
  beforeEach(() => { wipe(); H.posted.length = 0; H.sqlCalls = 0; H.beforeIngest = null; H.ingestDelayMs = 0; H.delayMs = 0; H.onSql = null; });
  afterEach(() => { delete process.env.CATALOG_C4_SYNC_ENABLED; });

  it("flag off (unset, 0) reads NOTHING and posts nothing", async () => {
    win("cx_0001@ma", "u_0001"); decide("cx_0001@ma", "chair-affect", "distress", { type: "choice", choice: "low" });
    for (const v of [undefined, "0"]) {
      if (v === undefined) delete process.env.CATALOG_C4_SYNC_ENABLED; else process.env.CATALOG_C4_SYNC_ENABLED = v;
      expect(await runCatalogC4Sync()).toEqual(zeroCounts());
    }
    expect(H.sqlCalls).toBe(0);
    expect((await catalogOf("u_0001"))!.jev).toBeNull();
  });
  it("an unrecognised flag value is off, reads nothing, and is counted", async () => {
    process.env.CATALOG_C4_SYNC_ENABLED = "maybe";
    expect(await runCatalogC4Sync()).toEqual({ ...zeroCounts(), error_class: "bad_flag" });
    expect(H.sqlCalls).toBe(0);
  });
  it("only consults that ALREADY have a catalog row get a row: inserted is 0 and no row appears", async () => {
    on();
    win("cx_0001@ma", "u_0001"); win("cx_0002@ma", "u_0002", { catalog: false });
    for (const k of ["cx_0001@ma", "cx_0002@ma"]) decide(k, "chair-affect", "distress", { type: "choice", choice: "high" });
    affect("u_0002");
    const r = await runCatalogC4Sync();
    expect(r).toMatchObject({ posted: 1, updated: 1, inserted: 0, error_class: null });
    expect((await rows`SELECT count(*)::int AS c FROM encounter_catalog`)[0]!.c).toBe(1);
    expect((await catalogOf("u_0001"))!.jev.sets[0]).toMatchObject({ set_id: "chair-affect:distress", label: "high", band: "review", set_sha: SHA["chair-affect"] });
  });
  it("no_state marker rows are excluded, and so are non-answered, bench-mode and non-derived rows", async () => {
    on();
    win("cx_0001@ma", "u_0001");
    decide("cx_0001@ma", "chair-affect", "distress", { type: "none" }, { outcome: "no_answer", evidence: { no_state: "no_transcript" } });
    decide("cx_0001@ma", "chair-affect", "confusion", { type: "choice", choice: "low" }, { evidence: { no_state: "x" } });
    decide("cx_0001@ma", "chair-affect", "frustration", { type: "choice", choice: "low" }, { outcome: "gated_overwritten" });
    expect(await runCatalogC4Sync()).toMatchObject({ posted: 0 });
    expect((await catalogOf("u_0001"))!.jev).toBeNull();
  });
  it("an off-enum choice gives label null (counted), a null band stays null (the DB CHECK jev_decision_band_chk makes an off-enum band unreachable, so that guard is defence in depth); a bad model token skips the entry (counted)", async () => {
    on();
    win("cx_0001@ma", "u_0001");
    decide("cx_0001@ma", "chair-affect", "distress", { type: "choice", choice: "some free model text" });
    decide("cx_0001@ma", "chair-affect", "confusion", { type: "choice", choice: "low" }, { band: null });
    decide("cx_0001@ma", "chair-affect", "frustration", { type: "choice", choice: "low" }, { model: "bad model!" });
    const r = await runCatalogC4Sync();
    expect(r).toMatchObject({ posted: 1, skipped_off_enum: 1, skipped_bad_token: 1, error_class: null });
    const sets = (await catalogOf("u_0001"))!.jev.sets as Array<Record<string, unknown>>;
    expect(sets.map((s) => s.set_id)).toEqual(["chair-affect:confusion", "chair-affect:distress"]);
    expect(sets.find((s) => s.set_id === "chair-affect:distress")).toMatchObject({ label: null });
    expect(sets.find((s) => s.set_id === "chair-affect:confusion")).toMatchObject({ label: "low", band: null });
  });
  it("noul and score labels map through the closed enums (end to end)", async () => {
    on();
    win("cx_0001@ma", "u_0001");
    decide("cx_0001@ma", "syn-noul", "is_x", { type: "noul", noul: NOUL_YES_THRESHOLD });
    decide("cx_0001@ma", "syn-score", "level", { type: "score", score: 2, probabilities: {}, legend: {}, confidence: 0.5 });
    await runCatalogC4Sync();
    const sets = (await catalogOf("u_0001"))!.jev.sets as Array<Record<string, unknown>>;
    expect(sets.map((s) => [s.set_id, s.label])).toEqual([["syn-noul:is_x", "yes"], ["syn-score:level", "score_2"]]);
  });
  it("labelOf: noul below the threshold is no; score outside 0..levels-1, a non-integer, a wrong answer type or a missing definition is null", () => {
    const noul = { kind: "noul" as const, options: null, levels: 0 }, score = { kind: "score" as const, options: null, levels: 3 };
    expect(labelOf(noul, { type: "noul", noul: 0.49 })).toBe("no");
    expect(labelOf(noul, { type: "noul", noul: 0.9 })).toBe("yes");
    expect(labelOf(noul, { type: "noul", noul: Number.NaN })).toBeNull();
    expect(labelOf(score, { type: "score", score: 0 })).toBe("score_0");
    expect(labelOf(score, { type: "score", score: 3 })).toBeNull();
    expect(labelOf(score, { type: "score", score: -1 })).toBeNull();
    expect(labelOf(score, { type: "score", score: 1.5 })).toBeNull();
    expect(labelOf(score, { type: "noul", noul: 1 })).toBeNull();
    expect(labelOf(undefined, { type: "noul", noul: 1 })).toBeNull();
  });
  it("live wins over shadow for one question", async () => {
    on();
    win("cx_0001@ma", "u_0001");
    decide("cx_0001@ma", "chair-affect", "distress", { type: "choice", choice: "low" }, { mode: "live", at: "2026-10-14 01:00:00+00" });
    decide("cx_0001@ma", "chair-affect", "distress", { type: "choice", choice: "high" }, { mode: "shadow", at: "2026-10-15 01:00:00+00" });
    await runCatalogC4Sync();
    const sets = (await catalogOf("u_0001"))!.jev.sets;
    expect(sets).toHaveLength(1);
    expect(sets[0]).toMatchObject({ label: "low", at: "2026-10-14T01:00:00.000Z" });
  });
  it("a decision pinned to an OLD sha (the set changed) is not sent", async () => {
    on();
    win("cx_0001@ma", "u_0001");
    pg.exec(`INSERT INTO jev_decision (id, subject_type, subject_id, question_id, prompt_version, model, question_set_id, question_set_version, question_set_sha256, order_variant, mode, answer, band, outcome, evidence)
             VALUES ('jd_old', 'consult', 'cx_0001@ma', 'distress', 'pv', 'jev-1.13.0', 'chair-affect', 'v0', '${"f".repeat(64)}', 'derived', 'shadow', '{"type":"choice","choice":"low"}', 'review', 'answered', '{}')`);
    expect(await runCatalogC4Sync()).toMatchObject({ posted: 0 });
  });
  it("unchanged is not posted; a second tick posts 0 and writes nothing", async () => {
    on();
    win("cx_0001@ma", "u_0001"); win("cx_0002@ma", "u_0002");
    decide("cx_0001@ma", "chair-affect", "distress", { type: "choice", choice: "low" }); affect("u_0002");
    expect(await runCatalogC4Sync()).toMatchObject({ posted: 2, updated: 2, unchanged: 0 });
    const stamp = (await rows`SELECT consult_uid, updated_at::text AS u FROM encounter_catalog ORDER BY 1`);
    H.posted.length = 0;
    expect(await runCatalogC4Sync()).toMatchObject({ posted: 0, updated: 0, unchanged: 2, error_class: null });
    expect(H.posted).toHaveLength(0);
    expect(await rows`SELECT consult_uid, updated_at::text AS u FROM encounter_catalog ORDER BY 1`).toEqual(stamp);
  });
  it("a new decision after a sync changes only the jev block (clef untouched) and posts that one row", async () => {
    on();
    win("cx_0001@ma", "u_0001"); decide("cx_0001@ma", "chair-affect", "distress", { type: "choice", choice: "low" }); affect("u_0001");
    await runCatalogC4Sync(); H.posted.length = 0;
    decide("cx_0001@ma", "chair-affect", "confusion", { type: "choice", choice: "high" });
    expect(await runCatalogC4Sync()).toMatchObject({ posted: 1, updated: 1 });
    expect(Object.keys(H.posted[0]![0] as object).sort()).toEqual(["consult_uid", "jev"]);
  });
  it("the clef lane mapping: newest run wins across cut_versions, nulls and non-finite are omitted, an all-empty lane is omitted, coverage is always there, no forbidden key leaves", async () => {
    on();
    win("cx_0001@ma", "u_0001");
    affect("u_0001", { cut: "cut_old", started: "2026-10-14 03:00:00+00", pv: "tv_old", set: "arousal_median = 1.0" });
    affect("u_0001", { cut: "cut_new", started: "2026-10-15 03:00:00+00", pv: "tv_new", set: "arousal_median = 3.2, arousal_raw_median = 0.4, valence_raw_close = 0.7" });
    await runCatalogC4Sync();
    const clef = (await catalogOf("u_0001"))!.clef_affect;
    expect(clef.lanes.map((l: any) => l.lane)).toEqual(["arousal", "valence", "coverage"]);
    expect(clef.lanes[0].scores).toEqual({ median: 3.2, raw_median: 0.4 });
    expect(clef.lanes[1].scores).toEqual({ raw_close: 0.7 });
    expect(clef.lanes[2].scores).toEqual({ n_windows: 5, n_scorable: 3, scorable_pct: 60 });
    expect(clef.lanes.every((l: any) => l.model_rev === "tv_new" && l.at === "2026-10-15T03:00:00.000Z")).toBe(true);
    expect(JSON.stringify(clef)).not.toMatch(/abcd1234|rm_slug|cut_new|doctor|room/);
  });
  it("buildClef: a lane with only nulls is omitted; a non-token pipeline_version skips the block (counted); NaN is omitted", () => {
    const base = { consult_uid: "u", pipeline_version: "tv1", at: "2026-10-15T03:00:00.000Z", n_windows: 4, n_scorable: 0, scorable_pct: Number.NaN } as any;
    const c = zeroCounts();
    expect(buildClef(base, c)!.lanes).toEqual([{ lane: "coverage", scores: { n_windows: 4, n_scorable: 0 }, model_rev: "tv1", at: base.at }]);
    expect(buildClef({ ...base, pipeline_version: "bad version" }, c)).toBeNull();
    expect(c.skipped_bad_token).toBe(1);
  });
  it("every posted batch passes validateBatch and carries no key outside {consult_uid, jev, clef_affect}", async () => {
    on();
    for (let i = 1; i <= 4; i++) { win(`cx_000${i}@ma`, `u_000${i}`); decide(`cx_000${i}@ma`, "chair-affect", "distress", { type: "choice", choice: "low" }); if (i % 2) affect(`u_000${i}`); }
    await runCatalogC4Sync();
    expect(H.posted).toHaveLength(1);
    expect(validateBatch({ rows: H.posted[0] }).ok).toBe(true);
    for (const r of H.posted[0] as Array<Record<string, unknown>>) expect(Object.keys(r).every((k) => ["consult_uid", "jev", "clef_affect"].includes(k))).toBe(true);
    const c = await catalogOf("u_0001");
    expect(c!.generated_at).toBeNull();
    expect(c!.ist_date).toBeNull();
  });
  it("oldest first, inside the 8-IST-day window only, at most 500 rows per tick (the rest next tick)", async () => {
    on();
    win("cx_old@ma", "u_old", { daysAgo: 20 }); decide("cx_old@ma", "chair-affect", "distress", { type: "choice", choice: "low" });
    pg.exec(`INSERT INTO eta_encounter_windows (consult_key, consult_uid, machine, room_id, attribution, t_open, t_close, close_reason, quality, resolver_version)
             SELECT 'cxb_' || g || '@ma', 'ub_' || lpad(g::text, 4, '0'), 'mc_1', 'rm_a', 'none', ${TODAY0} - interval '3 days' + g * interval '1 second', ${TODAY0} - interval '3 days' + g * interval '1 second' + interval '1 second', 'endConsult', 'clean', 'v_t'
               FROM generate_series(1, 520) g;
             INSERT INTO encounter_catalog (consult_uid) SELECT 'ub_' || lpad(g::text, 4, '0') FROM generate_series(1, 520) g;
             INSERT INTO jev_decision (id, subject_type, subject_id, question_id, prompt_version, model, question_set_id, question_set_version, question_set_sha256, order_variant, mode, answer, band, outcome, evidence)
             SELECT 'jdb_' || g, 'consult', 'cxb_' || g || '@ma', 'distress', 'pv', 'jev-1.13.0', 'chair-affect', 'v0', '${SHA["chair-affect"]}', 'derived', 'shadow', '{"type":"choice","choice":"low"}', 'review', 'answered', '{}' FROM generate_series(1, 520) g;`);
    expect(await runCatalogC4Sync()).toMatchObject({ posted: 500, updated: 500, inserted: 0 });
    expect((H.posted[0] as Array<{ consult_uid: string }>)[0]!.consult_uid).toBe("ub_0001");
    expect((await catalogOf("u_old"))!.jev).toBeNull();
    expect(await runCatalogC4Sync()).toMatchObject({ posted: 20, unchanged: 500 });
  });
  it("more than 50 entries for a consult keeps the newest 50", async () => {
    on();
    win("cx_0001@ma", "u_0001");
    pg.exec(`INSERT INTO jev_decision (id, subject_type, subject_id, question_id, prompt_version, model, question_set_id, question_set_version, question_set_sha256, order_variant, mode, answer, band, outcome, evidence, created_at)
             SELECT 'jdm_' || g, 'consult', 'cx_0001@ma', 'q' || lpad(g::text, 2, '0'), 'pv', 'jev-1.13.0', 'chair-affect', 'v0', '${SHA["chair-affect"]}', 'derived', 'shadow', '{"type":"choice","choice":"low"}', 'review', 'answered', '{}', '2026-10-01'::timestamptz + g * interval '1 minute' FROM generate_series(1, 55) g;`);
    expect(await runCatalogC4Sync()).toMatchObject({ posted: 1, error_class: null });
    const sets = (await catalogOf("u_0001"))!.jev.sets as Array<{ set_id: string }>;
    expect(sets).toHaveLength(50);
    expect(sets.some((s) => s.set_id === "chair-affect:q01")).toBe(false);
    expect(sets.some((s) => s.set_id === "chair-affect:q55")).toBe(true);
  });
  it("a database failure in the step is a class token, never a throw, and leaves the catalog as it was", async () => {
    on();
    win("cx_0001@ma", "u_0001"); decide("cx_0001@ma", "chair-affect", "distress", { type: "choice", choice: "low" });
    pg.exec("ALTER TABLE jev_question_set RENAME TO jev_question_set_gone");
    try {
      const r = await runCatalogC4Sync();
      expect(r.error_class).toMatch(/^(db_error:[0-9A-Z]{5}|persist_failed)$/);
      expect(r.posted).toBe(0);
    } finally { pg.exec("ALTER TABLE jev_question_set_gone RENAME TO jev_question_set"); }
    expect((await catalogOf("u_0001"))!.jev).toBeNull();
  });

  // ---- CATALOG-C4-SYNC-FU1: CS-2 time budget, CS-5 scan ceiling ----
  /** A scripted clock: each call returns the next value (the last one repeats). */
  const clock = (...v: number[]) => { let i = 0; return () => v[Math.min(i++, v.length - 1)]!; };
  const OVER = CATALOG_SYNC_BUDGET_MS + 1;
  const bulkWins = (prefix: string, count: number, daysAgo: number) => pg.exec(
    `INSERT INTO eta_encounter_windows (consult_key, consult_uid, machine, room_id, attribution, t_open, t_close, close_reason, quality, resolver_version)
     SELECT '${prefix}_' || g || '@ma', '${prefix}u_' || lpad(g::text, 4, '0'), 'mc_1', 'rm_a', 'none', ${TODAY0} - interval '${daysAgo} days' + g * interval '1 second', ${TODAY0} - interval '${daysAgo} days' + g * interval '1 second' + interval '1 second', 'endConsult', 'clean', 'v_t'
       FROM generate_series(1, ${count}) g;
     INSERT INTO encounter_catalog (consult_uid) SELECT '${prefix}u_' || lpad(g::text, 4, '0') FROM generate_series(1, ${count}) g;`);
  const bulkDecisions = (prefix: string, count: number, sha: string, version: string, evidence: string) => pg.exec(
    `INSERT INTO jev_decision (id, subject_type, subject_id, question_id, prompt_version, model, question_set_id, question_set_version, question_set_sha256, order_variant, mode, answer, band, outcome, evidence)
     SELECT 'jd${prefix}_' || g, 'consult', '${prefix}_' || g || '@ma', 'distress', 'pv', 'jev-1.13.0', 'chair-affect', '${version}', '${sha}', 'derived', 'shadow', '{"type":"choice","choice":"low"}', 'review', 'answered', '${evidence}'::jsonb FROM generate_series(1, ${count}) g;`);
  const OLD_SHA = "e".repeat(64);
  const withOldVersion = async (fn: () => Promise<void>) => {
    pg.exec(`INSERT INTO jev_question_set (id, version, use, subject_type, state_schema, model_pin, content_sha256, status, created_by, ratified_by, ratified_at, created_at)
             VALUES ('chair-affect', 'v_old', '${fileOf("chair-affect").use}', 'consult', 'x', 'jev-1.13.0', '${OLD_SHA}', 'shadow', 'test', 'v', now(), '2020-01-01')`);
    try { await fn(); } finally { pg.exec("DELETE FROM jev_decision; DELETE FROM jev_question_set WHERE version = 'v_old'"); }
  };

  it("CS-2: the budget gone before the first page: 0 SQL, nothing posted, budget_hit true", async () => {
    on();
    win("cx_0001@ma", "u_0001"); decide("cx_0001@ma", "chair-affect", "distress", { type: "choice", choice: "low" });
    H.sqlCalls = 0;
    const r = await runCatalogC4Sync(clock(0, OVER));
    expect(H.sqlCalls).toBe(0);
    expect(r).toEqual({ ...zeroCounts(), budget_hit: true });
    expect(H.posted).toHaveLength(0);
    expect((await catalogOf("u_0001"))!.jev).toBeNull();
  });
  it("CS-2: the budget gone mid-paging stops paging and posts what it collected (plain monotonic clock)", async () => {
    on();
    bulkWins("p", 520, 3); bulkDecisions("p", 520, SHA["chair-affect"]!, "v0", "{}");
    expect(await runCatalogC4Sync()).toMatchObject({ posted: 500 });   // first tick: page 1 fills the batch
    H.posted.length = 0;
    decide("p_1@ma", "chair-affect", "confusion", { type: "choice", choice: "high" });   // page 1 now holds 1 changed row and 499 unchanged, so page 2 would be read
    // clock calls: start, page-1 check, page-2 check (over); no ingest check
    const r = await runCatalogC4Sync(clock(0, 0, OVER));
    expect(r).toMatchObject({ posted: 1, updated: 1, unchanged: 499, budget_hit: true, error_class: null });
    expect(H.posted).toHaveLength(1);
    expect((H.posted[0] as Array<{ consult_uid: string }>).map((x) => x.consult_uid)).toEqual(["pu_0001"]);
  });
  it("CS-2: the budget gone after the last page still posts the collected rows (paging did not stop early, so budget_hit is false)", async () => {
    on();
    win("cx_0001@ma", "u_0001"); decide("cx_0001@ma", "chair-affect", "distress", { type: "choice", choice: "low" });
    const r = await runCatalogC4Sync(clock(0, 0, OVER, OVER));   // start, page-1 check, then over for any later read
    expect(r).toMatchObject({ posted: 1, updated: 1, budget_hit: false, error_class: null });
    expect(H.posted).toHaveLength(1);
    expect((await catalogOf("u_0001"))!.jev).not.toBeNull();
  });
  it("CS-2: a tick inside the budget leaves budget_hit false", async () => {
    on();
    win("cx_0001@ma", "u_0001"); decide("cx_0001@ma", "chair-affect", "distress", { type: "choice", choice: "low" });
    expect(await runCatalogC4Sync(clock(0, 1, 2))).toMatchObject({ posted: 1, budget_hit: false, capped: 0 });
  });
  it("CS-2: the >50-entry drop count is in the response", async () => {
    on();
    win("cx_0001@ma", "u_0001");
    pg.exec(`INSERT INTO jev_decision (id, subject_type, subject_id, question_id, prompt_version, model, question_set_id, question_set_version, question_set_sha256, order_variant, mode, answer, band, outcome, evidence, created_at)
             SELECT 'jdm_' || g, 'consult', 'cx_0001@ma', 'q' || lpad(g::text, 2, '0'), 'pv', 'jev-1.13.0', 'chair-affect', 'v0', '${SHA["chair-affect"]}', 'derived', 'shadow', '{"type":"choice","choice":"low"}', 'review', 'answered', '{}', '2026-10-01'::timestamptz + g * interval '1 minute' FROM generate_series(1, 55) g;`);
    expect(await runCatalogC4Sync()).toMatchObject({ posted: 1, capped: 5, budget_hit: false });
  });
  it("CS-5: a consult whose only decisions are no_state markers, or sit on an old sha, is not a candidate (unless it has a clef row)", async () => {
    on();
    await withOldVersion(async () => {
      win("cx_0001@ma", "u_0001"); decide("cx_0001@ma", "chair-affect", "distress", { type: "choice", choice: "low" }, { evidence: { no_state: "x" } });
      win("cx_0002@ma", "u_0002");
      pg.exec(`INSERT INTO jev_decision (id, subject_type, subject_id, question_id, prompt_version, model, question_set_id, question_set_version, question_set_sha256, order_variant, mode, answer, band, outcome, evidence)
               VALUES ('jd_oldv', 'consult', 'cx_0002@ma', 'distress', 'pv', 'jev-1.13.0', 'chair-affect', 'v_old', '${OLD_SHA}', 'derived', 'shadow', '{"type":"choice","choice":"low"}', 'review', 'answered', '{}')`);
      expect(await runCatalogC4Sync()).toMatchObject({ posted: 0, unchanged: 0, error_class: null });   // unchanged 0: never a candidate, so no page spent
      win("cx_0003@ma", "u_0003"); decide("cx_0003@ma", "chair-affect", "distress", { type: "choice", choice: "low" }, { evidence: { no_state: "x" } }); affect("u_0003");
      expect(await runCatalogC4Sync()).toMatchObject({ posted: 1 });
      expect(Object.keys(H.posted[0]![0] as object).sort()).toEqual(["clef_affect", "consult_uid"]);
    });
  });
  it("CS-5: 600 no_state-only or old-sha-only consults ahead of one real consult: the real one is still posted", async () => {
    on();
    await withOldVersion(async () => {
      bulkWins("n", 300, 3); bulkDecisions("n", 300, SHA["chair-affect"]!, "v0", '{"no_state":"x"}');
      bulkWins("o", 300, 3); bulkDecisions("o", 300, OLD_SHA, "v_old", "{}");
      win("cx_real@ma", "u_real", { daysAgo: 0 }); decide("cx_real@ma", "chair-affect", "distress", { type: "choice", choice: "low" });
      const r = await runCatalogC4Sync();
      expect(r).toMatchObject({ posted: 1, updated: 1, unchanged: 0, budget_hit: false, error_class: null });
      expect((H.posted[0] as Array<{ consult_uid: string }>).map((x) => x.consult_uid)).toEqual(["u_real"]);
    });
  });

  // ---- CATALOG-C4-SYNC-FU2: updateOnly (CS-3), retired entries kept (CS-4), statement timeout, tick + ceiling log ----
  const NEW_SHA = "d".repeat(64);
  const bumpVersion = () => pg.exec(`INSERT INTO jev_question_set (id, version, use, subject_type, state_schema, model_pin, content_sha256, status, created_by, ratified_by, ratified_at, created_at)
             VALUES ('chair-affect', 'v_new', '${fileOf("chair-affect").use}', 'consult', 'x', 'jev-1.13.0', '${NEW_SHA}', 'shadow', 'test', 'v', now(), now() + interval '1 hour')`);
  const unbump = () => pg.exec("DELETE FROM jev_question_set WHERE version = 'v_new'");
  const setStatus = (id: string, st: string) => pg.exec(`UPDATE jev_question_set SET status = '${st}' WHERE id = '${id}'`);
  type Entry = Record<string, unknown>;
  const setsOf = async (uid: string) => ((await catalogOf(uid))!.jev?.sets ?? []) as Entry[];
  const noNullJev = () => { for (const b of H.posted) for (const r of b as Array<Record<string, unknown>>) if ("jev" in r) expect(r.jev).not.toBeNull(); };
  const infoLines = (spy: { mock: { calls: unknown[][] } }) => spy.mock.calls.map((c) => String(c[0]));

  it("FU2 G1: the ingest is updateOnly: a row deleted mid-tick is counted missing, never inserted, and retried:true is not an error", async () => {
    on();
    win("cx_0001@ma", "u_0001"); win("cx_0002@ma", "u_0002");
    for (const k of ["cx_0001@ma", "cx_0002@ma"]) decide(k, "chair-affect", "distress", { type: "choice", choice: "low" });
    H.beforeIngest = () => pg.exec("DELETE FROM encounter_catalog WHERE consult_uid = 'u_0002'");
    const r = await runCatalogC4Sync();
    expect(r).toMatchObject({ posted: 2, updated: 1, inserted: 0, missing: 1, retried: 1, error_class: null });
    expect((await rows`SELECT count(*)::int AS c FROM encounter_catalog`)[0]!.c).toBe(1);
    expect((await rows`SELECT count(*)::int AS c FROM encounter_catalog WHERE consult_uid = 'u_0002'`)[0]!.c).toBe(0);
  });
  it("FU2 G1: a normal tick reports missing 0, retried 0, inserted 0 (the unexpected_insert class no longer exists)", async () => {
    on();
    win("cx_0001@ma", "u_0001"); decide("cx_0001@ma", "chair-affect", "distress", { type: "choice", choice: "low" });
    expect(await runCatalogC4Sync()).toMatchObject({ posted: 1, updated: 1, inserted: 0, missing: 0, retried: 0, error_class: null });
  });
  it("FU2 G2: every posted entry carries state current; a first tick stores state current", async () => {
    on();
    win("cx_0001@ma", "u_0001"); decide("cx_0001@ma", "chair-affect", "distress", { type: "choice", choice: "low" }); decide("cx_0001@ma", "chair-affect", "confusion", { type: "choice", choice: "high" });
    await runCatalogC4Sync();
    expect((await setsOf("u_0001")).map((e) => e.state)).toEqual(["current", "current"]);
  });
  it("FU2 G2 proof (set version bump): the old-sha entry is retired on tick N and is still there, retired and byte-equal, on N+1 and N+2; the ticks after the first post 0", async () => {
    on();
    win("cx_0001@ma", "u_0001"); decide("cx_0001@ma", "chair-affect", "distress", { type: "choice", choice: "low" });
    await runCatalogC4Sync();
    const before = (await setsOf("u_0001"))[0]!;
    expect(before).toMatchObject({ state: "current", set_sha: SHA["chair-affect"] });
    bumpVersion();
    try {
      H.posted.length = 0;
      expect(await runCatalogC4Sync()).toMatchObject({ posted: 1, updated: 1, retired: 1, error_class: null });   // tick N
      expect(await setsOf("u_0001")).toEqual([{ ...before, state: "retired" }]);
      for (let i = 1; i <= 2; i++) {                                                                                 // N+1, N+2
        H.posted.length = 0;
        expect(await runCatalogC4Sync()).toMatchObject({ posted: 0, updated: 0, error_class: null });
        expect(H.posted).toHaveLength(0);
        expect(await setsOf("u_0001")).toEqual([{ ...before, state: "retired" }]);
      }
      // a decision on the new version later: the block holds BOTH the retired and the new current entry
      pg.exec(`INSERT INTO jev_decision (id, subject_type, subject_id, question_id, prompt_version, model, question_set_id, question_set_version, question_set_sha256, order_variant, mode, answer, band, outcome, evidence)
               VALUES ('jd_newv', 'consult', 'cx_0001@ma', 'distress', 'pv', 'jev-1.13.0', 'chair-affect', 'v_new', '${NEW_SHA}', 'derived', 'shadow', '{"type":"choice","choice":"low"}', 'review', 'answered', '{}')`);
      await runCatalogC4Sync();
      const sets = await setsOf("u_0001");
      expect(sets.map((e) => [e.set_sha, e.state])).toEqual([[NEW_SHA, "current"], [SHA["chair-affect"], "retired"]].sort((a, b) => (a[0]! < b[0]! ? -1 : 1)));
      expect(sets.find((e) => e.state === "retired")).toEqual({ ...before, state: "retired" });
      expect((await runCatalogC4Sync())).toMatchObject({ posted: 0 });
    } finally { unbump(); }
    noNullJev();
  });
  it("FU2 G2 proof (set retirement): the entry is retired on tick N even though nothing current is left to send, and is still there on N+1 and N+2", async () => {
    on();
    win("cx_0001@ma", "u_0001"); decide("cx_0001@ma", "syn-noul", "is_x", { type: "noul", noul: 0.9 }); decide("cx_0001@ma", "chair-affect", "distress", { type: "choice", choice: "low" });
    await runCatalogC4Sync();
    const before = await setsOf("u_0001");
    expect(before.map((e) => e.state)).toEqual(["current", "current"]);
    setStatus("syn-noul", "retired");
    try {
      expect(await runCatalogC4Sync()).toMatchObject({ posted: 1, retired: 1 });                                      // tick N
      const afterN = await setsOf("u_0001");
      expect(afterN.find((e) => e.set_id === "chair-affect:distress")).toEqual(before.find((e) => e.set_id === "chair-affect:distress"));
      expect(afterN.find((e) => e.set_id === "syn-noul:is_x")).toEqual({ ...before.find((e) => e.set_id === "syn-noul:is_x"), state: "retired" });
      // now the other set goes too: no current entry and no current decision remain; the consult is still a candidate once, then quiet
      setStatus("chair-affect", "retired");
      expect(await runCatalogC4Sync()).toMatchObject({ posted: 1, retired: 1 });
      for (let i = 0; i < 2; i++) {
        H.posted.length = 0;
        expect(await runCatalogC4Sync()).toMatchObject({ posted: 0, error_class: null });
        expect((await setsOf("u_0001")).map((e) => e.state)).toEqual(["retired", "retired"]);
      }
      expect((await setsOf("u_0001")).map((e) => [e.set_id, e.label, e.model, e.at, e.band])).toEqual(before.map((e) => [e.set_id, e.label, e.model, e.at, e.band]).sort((a, b) => (String(a[0]) < String(b[0]) ? -1 : 1)));
    } finally { setStatus("syn-noul", "shadow"); setStatus("chair-affect", "shadow"); }
    noNullJev();
  });
  it("FU2 G2: a stored entry written before FU2 (no state) is classified by sha: current gets state current, an old sha gets retired; then a second tick posts 0", async () => {
    on();
    win("cx_0001@ma", "u_0001");
    const at = "2026-10-14T01:00:00.000Z";
    const legacy = { sets: [
      { set_id: "chair-affect:distress", set_sha: SHA["chair-affect"], band: "review", label: "low", model: "jev-1.13.0", at },
      { set_id: "chair-affect:confusion", set_sha: "c".repeat(64), band: null, label: null, model: "jev-1.13.0", at }] };
    pg.exec(`UPDATE encounter_catalog SET jev = '${JSON.stringify(legacy)}'::jsonb WHERE consult_uid = 'u_0001'`);
    expect(await runCatalogC4Sync()).toMatchObject({ posted: 1, retired: 1, error_class: null });
    expect(await setsOf("u_0001")).toEqual([
      { ...legacy.sets[1], state: "retired" },      // chair-affect:confusion sorts first
      { ...legacy.sets[0], state: "current" }]);
    expect(await runCatalogC4Sync()).toMatchObject({ posted: 0 });
  });
  it("FU2 G2: the cap drops the OLDEST retired entries first (counted in capped); the current entries all stay", async () => {
    on();
    win("cx_0001@ma", "u_0001");
    const old = Array.from({ length: 48 }, (_, i) => ({ set_id: `gone:q${String(i).padStart(2, "0")}`, set_sha: "c".repeat(64), band: null, label: null, model: "jev-1.13.0", at: `2026-10-01T00:${String(i).padStart(2, "0")}:00.000Z`, state: "retired" }));
    pg.exec(`UPDATE encounter_catalog SET jev = '${JSON.stringify({ sets: old })}'::jsonb WHERE consult_uid = 'u_0001'`);
    for (const q of ["distress", "confusion", "frustration", "pain"]) decide("cx_0001@ma", "chair-affect", q, { type: "choice", choice: "low" });
    const r = await runCatalogC4Sync();
    const sets = await setsOf("u_0001");
    expect(sets).toHaveLength(50);
    expect(r).toMatchObject({ capped: 48 + 4 - 50, posted: 1 });
    expect(sets.filter((e) => e.state === "current")).toHaveLength(4);
    expect(sets.some((e) => e.set_id === "gone:q00")).toBe(false);
    expect(sets.some((e) => e.set_id === "gone:q01")).toBe(false);
    expect(sets.some((e) => e.set_id === "gone:q02")).toBe(true);
  });
  it("mergeJev: current entries alone over the cap keep the newest 50 current and drop every retired entry; a retired entry whose sha is current again is current", () => {
    const c = zeroCounts();
    const cur = [{ id: "s", sha: "a".repeat(40) }];
    const e = (i: number, sha: string, state?: "current" | "retired"): JevEntry => ({ set_id: `s:q${String(i).padStart(2, "0")}`, set_sha: sha, band: null, label: null, model: "m", at: `2026-10-01T00:${String(i % 60).padStart(2, "0")}:00.000Z`, ...(state ? { state } : {}) });
    const stored = [...Array.from({ length: 55 }, (_, i) => e(i, "a".repeat(40), "current")), e(60, "b".repeat(40), "retired")];
    const m = mergeJev(stored, [], cur, c);
    expect(m.block!.sets).toHaveLength(50);
    expect(m.block!.sets.every((x) => x.state === "current")).toBe(true);
    expect(c.capped).toBe(6);
    expect(m.capDropped.size).toBe(6);
    expect(carriesAllStored(stored, m.block, m.capDropped)).toBe(true);
    const back = mergeJev([e(1, "a".repeat(40), "retired")], [], cur, zeroCounts());
    expect(back.block!.sets[0]).toMatchObject({ state: "current" });
  });
  it("FU2 G2 assertion: carriesAllStored rejects a block that lost a stored entry (not dropped by the cap) and a null block; storedEntries refuses an unreadable stored value", () => {
    const e = (id: string): JevEntry => ({ set_id: id, set_sha: "a".repeat(40), band: null, label: null, model: "m", at: "2026-10-01T00:00:00.000Z", state: "current" });
    expect(carriesAllStored([e("s:a"), e("s:b")], { sets: [e("s:a")] }, new Set())).toBe(false);
    expect(carriesAllStored([e("s:a")], null, new Set())).toBe(false);
    expect(carriesAllStored([], null, new Set())).toBe(true);
    expect(carriesAllStored([e("s:a"), e("s:b")], { sets: [e("s:a")] }, new Set([`s:b\u0000${"a".repeat(40)}`]))).toBe(true);
    expect(storedEntries({ sets: "no" })).toBeNull();
    expect(storedEntries({ sets: [{ set_id: 1 }] })).toBeNull();
    expect(storedEntries("x")).toBeNull();
    expect(storedEntries(null)).toEqual([]);
  });
  it("FU2 G2: an unreadable stored jev block is left exactly as it is (the row's jev is not posted, invariant_dropped counts it)", async () => {
    on();
    win("cx_0001@ma", "u_0001"); decide("cx_0001@ma", "chair-affect", "distress", { type: "choice", choice: "low" });
    pg.exec(`UPDATE encounter_catalog SET jev = '{"sets":"not-an-array"}'::jsonb WHERE consult_uid = 'u_0001'`);
    const r = await runCatalogC4Sync();
    expect(r).toMatchObject({ posted: 0, invariant_dropped: 1 });
    expect((await catalogOf("u_0001"))!.jev).toEqual({ sets: "not-an-array" });
    expect(H.posted).toHaveLength(0);
  });
  it("FU2 G3: a select slower than the statement timeout stops the step with error_class statement_timeout; nothing is posted; the function does not throw", async () => {
    on();
    win("cx_0001@ma", "u_0001"); decide("cx_0001@ma", "chair-affect", "distress", { type: "choice", choice: "low" });
    expect(CATALOG_SYNC_STATEMENT_TIMEOUT_MS).toBe(15_000);
    H.delayMs = 400;
    const r = await runCatalogC4Sync(Date.now, 50);
    expect(r).toMatchObject({ posted: 0, error_class: "statement_timeout" });
    expect(H.posted).toHaveLength(0);
    await new Promise((res) => setTimeout(res, 450));   // let the abandoned statements finish before the next test
  });
  it("FU2 G3: an ingest slower than the statement timeout is statement_timeout too (the posted batch is counted as not applied: posted stays 0)", async () => {
    on();
    win("cx_0001@ma", "u_0001"); decide("cx_0001@ma", "chair-affect", "distress", { type: "choice", choice: "low" });
    H.ingestDelayMs = 400;
    const r = await runCatalogC4Sync(Date.now, 50);
    expect(r).toMatchObject({ posted: 0, error_class: "statement_timeout" });
    await new Promise((res) => setTimeout(res, 450));
  });
  it("FU2 G3: a timeout in this step leaves the jev-sweep route's body as it was except catalog.error_class", async () => {
    vi.resetModules();
    process.env.CRON_SECRET = "s"; process.env.JEV_WORKER_ENABLED = "1";
    vi.doMock("@/lib/jev/worker/sync", () => ({ syncQuestionSets: async () => [] }));
    vi.doMock("@/lib/jev/worker/sweeper", () => ({ sweepJev: async () => ({ uses: [], drift_enqueued: false }) }));
    vi.doMock("@/lib/jev/worker/register", () => ({}));
    vi.doMock("@/lib/jev/worker/catalog-sync", async (orig) => ({ ...((await orig()) as object), runCatalogC4Sync: async () => ({ ...zeroCounts(), error_class: "statement_timeout" }) }));
    const { GET } = await import("@/app/api/cron/jev-sweep/route");
    const { NextRequest } = await import("next/server");
    const res = await GET(new NextRequest("http://x/api/cron/jev-sweep", { headers: { authorization: "Bearer s" } }));
    const data = (await res.json()); const d = data.data ?? data;
    expect(res.status).toBe(200);
    expect(d.catalog.error_class).toBe("statement_timeout");
    expect(d.uses).toEqual([]);
    vi.doUnmock("@/lib/jev/worker/catalog-sync");
    delete process.env.CRON_SECRET; delete process.env.JEV_WORKER_ENABLED;
  });
  it("FU2 G4: an enabled tick emits exactly one tick line and one ceiling line (console.info), counts and tokens only", async () => {
    on();
    win("cx_0001@ma", "u_0001"); decide("cx_0001@ma", "chair-affect", "distress", { type: "choice", choice: "low" }); affect("u_0001");
    const spy = vi.spyOn(console, "info").mockImplementation(() => {});
    try {
      const r = await runCatalogC4Sync();
      const lines = infoLines(spy);
      expect(lines).toHaveLength(2);
      expect(lines[0]).toMatch(/^catalog_c4 tick \{/);
      expect(lines[1]).toMatch(/^catalog_c4 ceiling \{/);
      const tick = JSON.parse(lines[0]!.slice("catalog_c4 tick ".length));
      expect(tick).toEqual({ ...r, ms: expect.any(Number) });
      expect(tick.ms).toBeGreaterThanOrEqual(0);
      expect(JSON.parse(lines[1]!.slice("catalog_c4 ceiling ".length))).toEqual({ pages: 1, candidates_scanned: 1, max_pages: 10, page_size: 500 });
      expect(lines.join("\n")).not.toMatch(/u_0001|cx_0001|chair-affect|distress|jev-1\.13/);
    } finally { spy.mockRestore(); }
  });
  it("FU2 G4: the ceiling line counts pages and candidates scanned; a failing tick still logs its two lines with the error_class", async () => {
    on();
    bulkWins("p", 520, 3); bulkDecisions("p", 520, SHA["chair-affect"]!, "v0", "{}");
    const spy = vi.spyOn(console, "info").mockImplementation(() => {});
    try {
      await runCatalogC4Sync();
      expect(JSON.parse(infoLines(spy)[1]!.slice("catalog_c4 ceiling ".length))).toEqual({ pages: 1, candidates_scanned: 500, max_pages: 10, page_size: 500 });
      spy.mockClear();
      H.delayMs = 300;
      await runCatalogC4Sync(Date.now, 40);
      const lines = infoLines(spy);
      expect(lines).toHaveLength(2);
      expect(JSON.parse(lines[0]!.slice("catalog_c4 tick ".length)).error_class).toBe("statement_timeout");
      await new Promise((res) => setTimeout(res, 350));
    } finally { spy.mockRestore(); }
  });
  describe("FIX1 X1: the hard deadline", () => {
    const vclock = () => { const k = { t: 0 }; return { k, now: () => k.t }; };
    it("a slow later page cannot push the step past HARD_MS: the next statement is not started, budget_hit, nothing posted (the ingest has no time either), both info lines emitted", async () => {
      on();
      expect(CATALOG_SYNC_HARD_MS).toBe(35_000);
      bulkWins("p", 520, 3); bulkDecisions("p", 520, SHA["chair-affect"]!, "v0", "{}");
      await runCatalogC4Sync();
      H.posted.length = 0; H.sqlCalls = 0;
      decide("p_1@ma", "chair-affect", "confusion", { type: "choice", choice: "high" });
      const { k, now } = vclock();
      H.onSql = (n) => { if (n === 5) k.t = CATALOG_SYNC_HARD_MS + 1; };      // call 5 = page-2 candidates select: it "takes" past the hard deadline
      const spy = vi.spyOn(console, "info").mockImplementation(() => {});
      try {
        const r = await runCatalogC4Sync(now);
        expect(r).toMatchObject({ posted: 0, budget_hit: true, error_class: null });
        expect(H.sqlCalls).toBe(5);       // page-2 picks never started
        expect(H.posted).toHaveLength(0);
        expect(infoLines(spy)).toHaveLength(2);
      } finally { spy.mockRestore(); }
    });
    it("an ingest that would start after HARD_MS does not start; the collected rows are not applied", async () => {
      on();
      win("cx_0001@ma", "u_0001"); decide("cx_0001@ma", "chair-affect", "distress", { type: "choice", choice: "low" });
      const { k, now } = vclock();
      H.onSql = (n) => { if (n === 4) k.t = CATALOG_SYNC_HARD_MS; };          // call 4 = clef picks, the last select: left is exactly 0
      const spy = vi.spyOn(console, "info").mockImplementation(() => {});
      try {
        const r = await runCatalogC4Sync(now);
        expect(r).toMatchObject({ posted: 0, updated: 0, budget_hit: true, error_class: null });
        expect(H.posted).toHaveLength(0);
        expect((await catalogOf("u_0001"))!.jev).toBeNull();
        expect(infoLines(spy)).toHaveLength(2);
      } finally { spy.mockRestore(); }
    });
    it("a statement gets min(statement limit, time left): 50 ms left caps a 400 ms ingest even with a 15 s statement limit", async () => {
      on();
      win("cx_0001@ma", "u_0001"); decide("cx_0001@ma", "chair-affect", "distress", { type: "choice", choice: "low" });
      const { k, now } = vclock();
      H.onSql = (n) => { if (n === 4) k.t = CATALOG_SYNC_HARD_MS - 50; };
      H.ingestDelayMs = 400;
      const r = await runCatalogC4Sync(now);
      expect(r).toMatchObject({ posted: 0, error_class: "statement_timeout" });
      await new Promise((res) => setTimeout(res, 450));
    });
    it("a tick well inside the hard deadline is unaffected", async () => {
      on();
      win("cx_0001@ma", "u_0001"); decide("cx_0001@ma", "chair-affect", "distress", { type: "choice", choice: "low" });
      const { now } = vclock();
      expect(await runCatalogC4Sync(now)).toMatchObject({ posted: 1, updated: 1, budget_hit: false, error_class: null });
    });
  });
  it("FU2 G4: flag off (unset, 0) and an unrecognised flag value emit NO console.info line", async () => {
    win("cx_0001@ma", "u_0001"); decide("cx_0001@ma", "chair-affect", "distress", { type: "choice", choice: "low" });
    const spy = vi.spyOn(console, "info").mockImplementation(() => {});
    try {
      for (const v of [undefined, "0", "maybe"]) {
        if (v === undefined) delete process.env.CATALOG_C4_SYNC_ENABLED; else process.env.CATALOG_C4_SYNC_ENABLED = v;
        await runCatalogC4Sync();
      }
      expect(spy).not.toHaveBeenCalled();
    } finally { spy.mockRestore(); }
  });
});

// the route: a thrown step changes only catalog.error_class
describe("jev-sweep route isolation", () => {
  it("a step that throws leaves the sweep body as it was, adding only catalog.error_class", async () => {
    vi.resetModules();
    process.env.CRON_SECRET = "s"; process.env.JEV_WORKER_ENABLED = "1";
    const sweepBody = { uses: [{ use: "x" }], drift_enqueued: false };
    vi.doMock("@/lib/jev/worker/sync", () => ({ syncQuestionSets: async () => [{ id: "a", version: "v0", result: "unchanged" }] }));
    vi.doMock("@/lib/jev/worker/sweeper", () => ({ sweepJev: async () => sweepBody }));
    vi.doMock("@/lib/jev/worker/register", () => ({}));
    vi.doMock("@/lib/jev/worker/catalog-sync", async (orig) => ({ ...((await orig()) as object), runCatalogC4Sync: async () => { throw new Error("boom with detail"); } }));
    const { GET } = await import("@/app/api/cron/jev-sweep/route");
    const { NextRequest } = await import("next/server");
    const res = await GET(new NextRequest("http://x/api/cron/jev-sweep", { headers: { authorization: "Bearer s" } }));
    const j = await res.json();
    expect(res.status).toBe(200);
    const data = j.data ?? j;
    expect(data.synced).toEqual([{ id: "a", version: "v0", result: "unchanged" }]);
    expect(data.uses).toEqual(sweepBody.uses);
    expect(data.catalog).toEqual({ ...zeroCounts(), error_class: "step_failed" });
    expect(JSON.stringify(j)).not.toMatch(/boom/);
    vi.doUnmock("@/lib/jev/worker/catalog-sync");
    delete process.env.CRON_SECRET; delete process.env.JEV_WORKER_ENABLED;
  });
});

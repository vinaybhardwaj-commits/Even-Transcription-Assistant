/**
 * JEV-NODATA-RETRY on a REAL postgres:16 with every migration applied: a no_state = 'no_data' marker is re-offered after NODATA_RETRY_MIN, once per cooldown;
 * every other marker reason stays terminal; real answers are never touched and replace marker rows. Synthetic ids only; no text.
 */
import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from "vitest";
vi.setConfig({ testTimeout: 180_000 });
import { readdirSync, readFileSync } from "node:fs";
import { dockerAvailable, pgContainer } from "../support/s1-pg";

const H = vi.hoisted(() => ({ tag: null as null | ((s: TemplateStringsArray, ...v: unknown[]) => Promise<unknown[]>) }));
vi.mock("@/lib/db", () => ({ sql: (a: TemplateStringsArray, ...v: unknown[]) => H.tag!(a, ...v) }));

import { allTranscribedConsults, CONSULT_SUBJECT_TYPE } from "@/lib/jev/worker/consult-eligible";
import { pendingSubjects } from "@/lib/jev/worker/sweeper";
import type { JevUseDef } from "@/lib/jev/worker/uses";
import { insertNoStateMarkers, selectTranscribedConsults, selectTranscribedConsultsBefore, NODATA_RETRY_MIN, NODATA_RETRY_MAX_AGE_H } from "@/lib/room-access/consult-select";
import { upsertDecisions, type WorkerDecision } from "@/lib/jev/worker/persist";

const HAVE = dockerAvailable();
const ALLOW_SKIP = process.env.ETA_ALLOW_SKIP_E2E === "1";
const pg = pgContainer("eta-jev-nodata-retry");
const ALL = readdirSync("db/migrations").filter((f) => f.endsWith(".sql")).sort();
const suite = HAVE || !ALLOW_SKIP ? describe : describe.skip;
const TODAY0 = "(date_trunc('day', now() AT TIME ZONE 'Asia/Kolkata') AT TIME ZONE 'Asia/Kolkata')";
const SHA = "a".repeat(64);
const ctx = { sha: SHA, mode: "shadow" };
const QS = Array.from({ length: 7 }, (_, i) => `q_${i + 1}`);

function win(key: string, uid0: string, daysAgo = 1): void {
  const uid = `uid_${uid0}`;      // the catalog check wants 4+ chars
  const open = `${TODAY0} - interval '${daysAgo} days'`;
  pg.exec(`INSERT INTO eta_encounter_windows (consult_key, consult_uid, machine, room_id, attribution, t_open, t_close, close_reason, quality, resolver_version)
           VALUES ('${key}', '${uid}', 'mc_1', 'rm_a', 'none', ${open}, ${open} + interval '1 second', 'endConsult', 'clean', 'v_t')`);
  pg.exec(`INSERT INTO encounter_catalog (consult_uid, stages) VALUES ('${uid}', '{"sealed":{"state":"ok"},"stt":{"state":"ok"},"translate":{"state":"ok"}}'::jsonb) ON CONFLICT DO NOTHING`);
}
const dec = (key: string, q: string, o: Partial<WorkerDecision> = {}): WorkerDecision => ({
  subjectType: "consult", subjectId: key, questionId: q, promptVersion: "pv", model: "m", setId: "s", setVersion: "1", setSha: SHA, orderVariant: "derived", optionOrderSha: null, lane: "text",
  answer: { type: "none" }, probabilities: null, confidence: null, band: null, outcome: "no_answer", callId: null, jobId: null, mode: "shadow", latencyMs: null, inputTokens: null, outputTokens: null,
  costUsd: null, evidence: {}, stateSha: null, mock: true, ...o,
});
const marker = (key: string, reason = "no_data") => insertNoStateMarkers(QS.map((q) => dec(key, q, { evidence: { no_state: reason } })));
const answered = (key: string) => upsertDecisions(QS.map((q) => dec(key, q, { outcome: "answered", answer: { type: "yes" }, band: "act", evidence: { n: 1 } })));
const age = (key: string, mins: number) => pg.exec(`UPDATE jev_decision SET created_at = now() - interval '${mins} minutes' WHERE subject_id = '${key}'`);
const rows = (key: string) => pg.sql`SELECT outcome, evidence, created_at FROM jev_decision WHERE subject_id = ${key}` as Promise<Array<{ outcome: string; evidence: Record<string, unknown>; created_at: string }>>;
const wipe = () => pg.exec("DELETE FROM encounter_catalog; DELETE FROM jev_decision; DELETE FROM eta_encounter_windows;");

suite("JEV no_data marker retry", () => {
  beforeAll(() => {
    if (!HAVE) throw new Error("docker is required (set ETA_ALLOW_SKIP_E2E=1 to skip)");
    pg.start(); H.tag = pg.sql;
    pg.exec("CREATE ROLE brain_svc NOLOGIN;");
    for (const f of ALL) pg.exec(readFileSync(`db/migrations/${f}`, "utf8"));
  }, 300_000);
  afterAll(() => pg.stop());
  beforeEach(() => { wipe(); delete process.env.JEV_CONSULT_BACKFILL_SINCE; vi.restoreAllMocks(); });

  it("the cooldown is 30 minutes", () => { expect(NODATA_RETRY_MIN).toBe(30); });

  it("a no_data marker younger than 30 min is not re-offered; older is; a re-mark restarts the cooldown (once per 30 min)", async () => {
    win("cx_a@ma", "u_a");
    expect(await marker("cx_a@ma")).toBe(7);
    age("cx_a@ma", 29);
    expect(await allTranscribedConsults(50, ctx)).toEqual([]);
    age("cx_a@ma", 31);
    expect(await allTranscribedConsults(50, ctx)).toEqual(["cx_a@ma"]);
    // the retry builds nothing again: the re-mark refreshes created_at
    expect(await marker("cx_a@ma")).toBe(7);
    const r = await rows("cx_a@ma");
    expect(r).toHaveLength(7);
    expect(r.every((x) => x.outcome === "no_answer" && x.evidence.no_state === "no_data")).toBe(true);
    expect(await allTranscribedConsults(50, ctx)).toEqual([]);      // second sweep inside 30 min: not re-offered
    age("cx_a@ma", 31);
    expect(await allTranscribedConsults(50, ctx)).toEqual(["cx_a@ma"]);
  });

  it("a fresh consult with no rows is returned (base behaviour)", async () => {
    win("cx_f@ma", "u_f");
    expect(await allTranscribedConsults(50, ctx)).toEqual(["cx_f@ma"]);
  });

  it("other marker reasons never retry", async () => {
    for (const reason of ["read_refused", "not_found", "build_error", "blind_room_day"]) {
      const k = `cx_${reason}@ma`; win(k, `u_${reason}`);
      await marker(k, reason); age(k, 600);
    }
    expect(await allTranscribedConsults(50, ctx)).toEqual([]);
  });

  it("a re-mark never rewrites a terminal marker", async () => {
    win("cx_r@ma", "u_r"); await marker("cx_r@ma", "read_refused"); age("cx_r@ma", 600);
    expect(await marker("cx_r@ma", "no_data")).toBe(0);
    const r = await rows("cx_r@ma");
    expect(r.every((x) => x.evidence.no_state === "read_refused")).toBe(true);
  });

  it("a real answer after a retry replaces the marker rows (7 answered, no marker left); a re-mark never touches answered rows", async () => {
    win("cx_b@ma", "u_b"); await marker("cx_b@ma"); age("cx_b@ma", 40);
    expect(await allTranscribedConsults(50, ctx)).toEqual(["cx_b@ma"]);
    await answered("cx_b@ma");
    let r = await rows("cx_b@ma");
    expect(r).toHaveLength(7);
    expect(r.every((x) => x.outcome === "answered" && !("no_state" in x.evidence))).toBe(true);
    const before = r.map((x) => String(x.created_at));
    expect(await marker("cx_b@ma")).toBe(0);
    r = await rows("cx_b@ma");
    expect(r.every((x) => x.outcome === "answered" && !("no_state" in x.evidence))).toBe(true);
    expect(r.map((x) => String(x.created_at))).toEqual(before);
    age("cx_b@ma", 600);
    expect(await allTranscribedConsults(50, ctx)).toEqual([]);      // decided for good
  });

  it("mixed rows (some answered, some marker) are decided; the marker rows are never rewritten", async () => {
    win("cx_m@ma", "u_m");
    await upsertDecisions([dec("cx_m@ma", "q_1", { outcome: "answered", answer: { type: "yes" }, evidence: { n: 1 } })]);
    await insertNoStateMarkers([dec("cx_m@ma", "q_2", { evidence: { no_state: "no_data" } })]);      // skipped: a real row exists for the sha
    expect((await rows("cx_m@ma")).length).toBe(1);
    pg.exec(`INSERT INTO jev_decision (id, subject_type, subject_id, question_id, prompt_version, model, question_set_sha256, order_variant, mode, answer, outcome, evidence, created_at)
             VALUES ('jd_mx', 'consult', 'cx_m@ma', 'q_2', 'pv', 'm', '${SHA}', 'derived', 'shadow', '{"type":"none"}', 'no_answer', '{"no_state":"no_data"}', now() - interval '600 minutes')`);
    age("cx_m@ma", 600);
    expect(await allTranscribedConsults(50, ctx)).toEqual([]);
    expect(await marker("cx_m@ma")).toBe(0);
    expect((await rows("cx_m@ma")).filter((x) => x.outcome === "answered")).toHaveLength(1);
  });

  it("a marker for a different sha does not count; the retry is per (sha, mode)", async () => {
    win("cx_s@ma", "u_s"); await marker("cx_s@ma"); age("cx_s@ma", 600);
    expect(await allTranscribedConsults(50, { sha: "b".repeat(64), mode: "shadow" })).toEqual(["cx_s@ma"]);
    expect(await allTranscribedConsults(50, { sha: SHA, mode: "live" })).toEqual(["cx_s@ma"]);
  });

  it("pass 2 (backfill) honours the same rule: a no_data marker is terminal only when the uid's NEWEST t_close is past 48 h (FIX2), cooldown or not", async () => {
    win("cx_old@ma", "u_old", 10); await marker("cx_old@ma");
    process.env.JEV_CONSULT_BACKFILL_SINCE = new Date(Date.now() + 5.5 * 3_600_000 - 12 * 86_400_000).toISOString().slice(0, 10);
    expect(await allTranscribedConsults(50, ctx)).toEqual([]);
    age("cx_old@ma", 31);
    expect(await allTranscribedConsults(50, ctx)).toEqual([]);
    // an undecided backfill consult is still picked (base behaviour)
    win("cx_old3@ma", "u_old3", 10);
    expect(await allTranscribedConsults(50, ctx)).toEqual(["cx_old3@ma"]);
    // direct pass-2 call, terminal reason
    win("cx_old2@ma", "u_old2", 10); await marker("cx_old2@ma", "read_refused"); age("cx_old2@ma", 600);
    const lo = new Date(Date.now() - 13 * 86_400_000).toISOString(), hi = new Date(Date.now() - 2 * 86_400_000).toISOString();
    expect(await selectTranscribedConsultsBefore(50, lo, hi, [], SHA, "shadow", "consult")).toEqual(["cx_old3@ma"]);      // only the undecided one: the read_refused and the aged no_data are terminal
    expect(await selectTranscribedConsults(50, 7, SHA, "shadow", "consult")).toEqual([]);
  });
  it("C1: a real answered row whose evidence is SQL NULL is decided: never re-offered, and a no_data re-mark neither rewrites nor adds rows", async () => {
    win("cx_n@ma", "u_n"); win("cx_n2@ma", "u_n2", 10);
    await answered("cx_n@ma"); await answered("cx_n2@ma");
    pg.exec("UPDATE jev_decision SET evidence = NULL WHERE subject_id IN ('cx_n@ma', 'cx_n2@ma')");
    const nulls = (await pg.sql`SELECT subject_id FROM jev_decision WHERE evidence IS NULL AND outcome = 'answered'`) as Array<{ subject_id: string }>;
    expect(nulls).toHaveLength(14);      // proves NULL was exercised, not {}
    const lo = new Date(Date.now() - 13 * 86_400_000).toISOString(), hi = new Date(Date.now() - 2 * 86_400_000).toISOString();
    for (const mins of [5, 600]) {      // inside and outside the 30 min cooldown
      age("cx_n@ma", mins); age("cx_n2@ma", mins);
      expect(await selectTranscribedConsults(50, 7, SHA, "shadow", "consult")).toEqual([]);
      expect(await selectTranscribedConsultsBefore(50, lo, hi, [], SHA, "shadow", "consult")).toEqual([]);      // pass 2
      expect(await allTranscribedConsults(50, ctx)).toEqual([]);
    }
    const before = (await pg.sql`SELECT id, created_at FROM jev_decision ORDER BY id` as Array<{ id: string; created_at: string }>).map((x) => `${x.id}@${x.created_at}`);
    expect(await marker("cx_n@ma")).toBe(0);
    expect(await marker("cx_n2@ma")).toBe(0);
    const after = (await pg.sql`SELECT id, created_at, outcome, evidence FROM jev_decision ORDER BY id` as Array<{ id: string; created_at: string; outcome: string; evidence: unknown }>);
    expect(after.map((x) => `${x.id}@${x.created_at}`)).toEqual(before);      // same rows, none rewritten or added
    expect(after).toHaveLength(14);
    expect(after.every((x) => x.outcome === "answered" && x.evidence === null)).toBe(true);
    const mk = (await pg.sql`SELECT 1 FROM jev_decision WHERE evidence->>'no_state' = 'no_data'`) as unknown[];
    expect(mk).toHaveLength(0);
  });

  // FIX1: through pendingSubjects (the sweeper's and jev-ask's pick), not just the selects
  const def = { use: "consult_rubric", setId: "pitch-detect", subjectType: CONSULT_SUBJECT_TYPE, eligible: (l: number, c?: { sha: string; mode: string }) => allTranscribedConsults(l, c), build: async () => null } as unknown as JevUseDef;
  const bulk = (prefix: string, count: number, daysAgo: number) => {
    pg.exec(`INSERT INTO eta_encounter_windows (consult_key, consult_uid, machine, room_id, attribution, t_open, t_close, close_reason, quality, resolver_version)
             SELECT '${prefix}' || lpad(g::text, 4, '0') || '@ma', 'u${prefix}' || lpad(g::text, 4, '0'), 'mc_1', 'rm_a', 'none', ${TODAY0} - interval '${daysAgo} days' + g * interval '1 second', ${TODAY0} - interval '${daysAgo} days' + g * interval '1 second' + interval '1 second', 'endConsult', 'clean', 'v_t' FROM generate_series(1, ${count}) g`);
    pg.exec(`INSERT INTO encounter_catalog (consult_uid, stages) SELECT 'u${prefix}' || lpad(g::text, 4, '0'), '{"sealed":{"state":"ok"},"stt":{"state":"ok"},"translate":{"state":"ok"}}'::jsonb FROM generate_series(1, ${count}) g`);
  };
  const infoLines = (spy: ReturnType<typeof vi.spyOn>) => spy.mock.calls.map((a) => String(a[0]));

  it("FIX1 F1/F4: pendingSubjects re-offers a stale no_data consult and logs nodata_retry=1; base no-marker behaviour unchanged (nodata_retry=0)", async () => {
    win("cx_p@ma", "u_p"); await marker("cx_p@ma");
    const info = vi.spyOn(console, "info").mockImplementation(() => {});
    age("cx_p@ma", 29);
    expect(await pendingSubjects(def, SHA, "shadow", 12)).toEqual([]);
    age("cx_p@ma", 40);
    expect(await pendingSubjects(def, SHA, "shadow", 12)).toEqual(["cx_p@ma"]);
    expect(infoLines(info)).toContain("jev consult nodata_retry=1");
    wipe(); info.mockClear();
    win("cx_n@ma", "u_n");
    expect(await pendingSubjects(def, SHA, "shadow", 12)).toEqual(["cx_n@ma"]);
    expect(infoLines(info)).toEqual(["jev consult nodata_retry=0"]);
  });

  it("FIX1 F2: 200 stale no_data + 1 fresh, limit 50: the fresh consult is picked on the FIRST sweep, the log counts only built retries", async () => {
    bulk("st", 200, 1);
    pg.exec(`INSERT INTO jev_decision (id, subject_type, subject_id, question_id, prompt_version, model, question_set_sha256, order_variant, mode, answer, outcome, evidence, created_at)
             SELECT 'jd_st' || g, 'consult', 'cxst' || lpad(g::text, 4, '0') || '@ma', 'q_1', 'pv', 'm', '${SHA}', 'derived', 'shadow', '{"type":"none"}', 'no_answer', '{"no_state":"no_data"}', now() - interval '600 minutes' FROM generate_series(1, 200) g`);
    // the generated keys use the prefix 'st' + 4 digits: align with the window keys ('st0001@ma')
    pg.exec(`UPDATE jev_decision SET subject_id = replace(subject_id, 'cxst', 'st') WHERE subject_id LIKE 'cxst%'`);
    win("cx_fresh@ma", "u_fresh");
    pg.exec(`UPDATE eta_encounter_windows SET t_open = now() - interval '2 hours', t_close = now() - interval '2 hours' + interval '1 second' WHERE consult_key = 'cx_fresh@ma'`);
    const info = vi.spyOn(console, "info").mockImplementation(() => {});
    const picked = await pendingSubjects(def, SHA, "shadow", 50);
    expect(picked).toHaveLength(50);
    expect(picked[0]).toBe("cx_fresh@ma");
    expect(infoLines(info)).toEqual(["jev consult nodata_retry=49"]);
  });

  it("FIX1 F3: a no_data consult with t_close older than 48 h is never re-offered (terminal); inside the window it is", async () => {
    expect(NODATA_RETRY_MAX_AGE_H).toBe(48);
    win("cx_o@ma", "u_o"); await marker("cx_o@ma"); age("cx_o@ma", 600);
    pg.exec(`UPDATE eta_encounter_windows SET t_open = now() - interval '49 hours', t_close = now() - interval '49 hours' + interval '1 second' WHERE consult_key = 'cx_o@ma'`);
    expect(await pendingSubjects(def, SHA, "shadow", 12)).toEqual([]);
    expect(await allTranscribedConsults(50, ctx)).toEqual([]);
    pg.exec(`UPDATE eta_encounter_windows SET t_open = now() - interval '47 hours', t_close = now() - interval '47 hours' + interval '1 second' WHERE consult_key = 'cx_o@ma'`);
    expect(await pendingSubjects(def, SHA, "shadow", 12)).toEqual(["cx_o@ma"]);
  });
});

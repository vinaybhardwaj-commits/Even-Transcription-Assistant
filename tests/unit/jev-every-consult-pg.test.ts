/**
 * JEV-EVERY-CONSULT S1 on a REAL postgres:16 with every migration applied: allTranscribedConsults (one key per uid, no prescription needed, transcript test, window bounds,
 * SQL exclusion of decided subjects, oldest first, no starvation), the sweeper's idempotency, the no_state marker, and the coverage read. Synthetic ids only; no text.
 */
import { describe, it, expect, vi, beforeAll, afterAll, afterEach, beforeEach } from "vitest";

// Many tests here run several docker/psql round trips: a per-FILE timeout (not the global one) keeps them deterministic under load.
vi.setConfig({ testTimeout: 180_000 });
import { execFile, execFileSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { dockerAvailable, pgContainer } from "../support/s1-pg";

const H = vi.hoisted(() => ({
  pg: null as null | { sql: (s: TemplateStringsArray, ...v: unknown[]) => Promise<unknown[]>; name: string },
  dropLock: false, dwell: false,
  calls: [] as Array<{ questions: Record<string, { type: string; criteria?: Record<string, string> }>; state: unknown; model?: string }>,
  script: null as null | ((req: { questions: Record<string, { type: string; criteria?: Record<string, string> }>; state: unknown; model?: string }) => unknown),
  sqlCalls: 0,
}));

const quote = (v: unknown): string => {
  if (v === null || v === undefined) return "NULL";
  if (Array.isArray(v)) return `'{${v.map((e) => `"${String(e).replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`).join(",")}}'`;
  return `'${(v instanceof Date ? v.toISOString() : String(v)).replace(/'/g, "''")}'`;
};
const render = (text: string, values: unknown[]): string => text.replace(/\$(\d+)/g, (_m, n) => quote(values[Number(n) - 1]));

vi.mock("@/lib/db", () => {
  const lazy = (strings: TemplateStringsArray, values: unknown[]) => {
    let text = "";
    strings.forEach((s, i) => { text += s + (i < values.length ? `$${i + 1}` : ""); });
    return { text, values, then(res: (v: unknown) => unknown, rej?: (e: unknown) => unknown) { H.sqlCalls += 1; return H.pg!.sql(strings, ...values).then(res, rej); } };
  };
  const sql = Object.assign((s: TemplateStringsArray, ...v: unknown[]) => lazy(s, v), {
    transaction: (qs: Array<{ text: string; values: unknown[] }>) => new Promise<unknown[]>((resolve, reject) => {
      H.sqlCalls += 1;
      const parts = qs.map((q) => render(q.text, q.values).trim().replace(/;\s*$/, ""));
      const last = parts.length - 1;
      const returning = /\bRETURNING\b/i.test(parts[last]!);
      const body = parts.map((p, i) => {
        if (i === 0 && H.dropLock && /advisory/i.test(p)) return "SELECT 1";
        if (i === last && returning) return `WITH u AS (${p}) SELECT coalesce(jsonb_agg(u), '[]'::jsonb) FROM u${H.dwell ? ";\nSELECT pg_sleep(0.6)" : ""}`;
        return p;
      }).join(";\n");
      const child = execFile("docker", ["exec", "-i", H.pg!.name, "psql", "-qAt", "-v", "ON_ERROR_STOP=1", "-U", "postgres", "-d", "postgres"], { maxBuffer: 16 * 1024 * 1024 }, (err, stdout) => {
        if (err) return reject(err);
        const lines = stdout.trim().split("\n").filter(Boolean);
        const rows = returning ? (JSON.parse(lines[lines.length - 1] ?? "[]") as unknown[]) : [];
        resolve([...parts.slice(0, last).map(() => []), rows]);
      });
      child.stdin!.end(`BEGIN;\n${body};\nCOMMIT;\n`);
    }),
  });
  return { sql };
});
vi.mock("@/lib/jev/client", () => ({
  getJevClient: () => ({
    async systemOne(req: { questions: Record<string, { type: string; criteria?: Record<string, string> }>; state: unknown; model?: string }) {
      H.calls.push(req);
      if (H.script) return H.script(req);
      return { model: "jev-mock", answers: {}, usage: { input_tokens: 0, output_tokens: 0 }, latency_ms: 1 };
    },
  }),
  _resetJevClientForTests: () => undefined,
}));
vi.mock("@/lib/brain/db", () => ({
  query: async (text: string, values: unknown[] = []) => {
    const rendered = render(text, values);
    const out = execFileSync("docker", ["exec", "-i", H.pg!.name, "psql", "-qAt", "-v", "ON_ERROR_STOP=1", "-U", "postgres", "-d", "postgres"],
      { input: `RESET ROLE;\nSET ROLE brain_svc;\nSELECT coalesce(jsonb_agg(q), '[]'::jsonb) FROM (${rendered.trim().replace(/;\s*$/, "")}) q;`, encoding: "utf8" });
    return { rows: JSON.parse(out.trim().split("\n").pop()!) };
  },
}));
vi.mock("@/lib/jobs/submit", () => ({ submitJob: vi.fn() }));


import { _clearUsesForTests, getUse } from "@/lib/jev/worker/uses";
import { syncQuestionSets, moveStatus } from "@/lib/jev/worker/sync";
import { registerP2Uses } from "@/lib/jev/worker/register";
import { allTranscribedConsults, backfillDays } from "@/lib/jev/worker/consult-eligible";
import { consultCoverage } from "@/lib/jev/worker/coverage";
import { jevHealth } from "@/lib/jev/worker/health";
import { pendingSubjects, sweepUse } from "@/lib/jev/worker/sweeper";
import { askSubject } from "@/lib/jev/worker/call";
import { jevAskKind } from "@/lib/jobs/kinds/jev-ask";
import type { StepContext } from "@/lib/jobs/types";

const HAVE = dockerAvailable();
const ALLOW_SKIP = process.env.ETA_ALLOW_SKIP_E2E === "1";
const pg = pgContainer("eta-jev-every-consult");
const ALL = readdirSync("db/migrations").filter((f) => f.endsWith(".sql")).sort();
const rows = async (q: TemplateStringsArray, ...v: unknown[]) => (await H.pg!.sql(q, ...v)) as Array<Record<string, any>>;
const suite = HAVE || !ALLOW_SKIP ? describe : describe.skip;

const TODAY0 = "(date_trunc('day', now() AT TIME ZONE 'Asia/Kolkata') AT TIME ZONE 'Asia/Kolkata')";
let SHA_PITCH = "", SHA_CHAIR = "";
let n = 0;
/** One eta_encounter_windows row: opened `daysAgo` IST days before today's midnight (+ `min` minutes), closed 1 s after. Synthetic ids only.
 *  FU2 G5: daysAgo defaults to 1 (always in the past: TODAY0 + 30 min is in the future between 00:00 and 00:30 IST). `today: true` is for the coverage cases, which need an IST-today window:
 *  it opens at TODAY0 + `min` minutes but never later than 1 s ago, so it is today and in the past at any clock time after 00:00:01 IST. */
function win(key: string, uid: string | null, o: { today?: boolean; daysAgo?: number; min?: number; closed?: boolean; room?: string | null; rx?: string | null; text?: boolean; sealed?: string | null; stt?: string | null; translate?: string | null; reason?: string | null } = {}): void {
  const { daysAgo = 1, min = 0, closed = true, room = "rm_a", rx = null, text = true, sealed = "ok", reason = null } = o;
  // catalog stages (INFERRED keys): text:false = stt and translate never ran; stt/translate default to ok
  const stt = o.stt !== undefined ? o.stt : text ? "ok" : null, translate = o.translate !== undefined ? o.translate : text ? "ok" : null;
  const open = o.today ? `LEAST(${TODAY0} + interval '${min} minutes', now() - interval '1 second')` : `${TODAY0} - interval '${daysAgo} days' + interval '${min} minutes'`;
  pg.exec(`INSERT INTO eta_encounter_windows (consult_key, consult_uid, prescription_ref, machine, room_id, attribution, t_open, t_close, close_reason, quality, resolver_version)
           VALUES ('${key}', ${uidSql(uid)}, ${rx ? `'${rx}'` : "NULL"}, 'mc_1', ${room ? `'${room}'` : "NULL"}, 'none', ${open}, ${closed ? `${open} + interval '1 second'` : "NULL"}, '${closed ? "endConsult" : "open"}', 'clean', 'v_t')`);
  if (!uid) return;
  const st: Record<string, unknown> = {};
  if (sealed) st.sealed = { state: sealed };
  if (stt) st.stt = { state: stt };
  if (translate) st.translate = reason ? { state: translate, reason } : { state: translate };
  if (sealed || stt || translate) pg.exec(`INSERT INTO encounter_catalog (consult_uid, stages) VALUES ('${uid}', '${JSON.stringify(st)}'::jsonb) ON CONFLICT DO NOTHING`);
}
const uidSql = (u: string | null) => (u ? `'${u}'` : "NULL");
const decide = (key: string, sha: string, mode = "shadow", type = "consult") =>
  pg.exec(`INSERT INTO jev_decision (id, subject_type, subject_id, question_id, prompt_version, model, question_set_sha256, order_variant, mode, answer) VALUES ('jd_${++n}', '${type}', '${key}', 'q_1', 'pv', 'jev-mock', '${sha}', 'derived', '${mode}', '{"type":"none"}')`);
const wipe = () => { pg.exec(`DELETE FROM encounter_catalog; DELETE FROM consult_sarvam_result; DELETE FROM cue; DELETE FROM bench_window; DELETE FROM bench_session; DELETE FROM room_day; DELETE FROM room; DELETE FROM jev_decision; DELETE FROM reb_track_index; DELETE FROM eta_encounter_windows; DELETE FROM scribe_job; DELETE FROM affect_consult; DELETE FROM affect_run; DELETE FROM affect_calibration_map;`); };

suite("JEV-EVERY-CONSULT S1 — every transcribed consult, record-only", () => {
  beforeAll(async () => {
    if (!HAVE) throw new Error("docker is required (set ETA_ALLOW_SKIP_E2E=1 to skip)");
    pg.start();
    H.pg = pg as never;
    pg.exec(`CREATE ROLE brain_svc NOLOGIN;`);
    for (const f of ALL) pg.exec(readFileSync(`db/migrations/${f}`, "utf8"));
    _clearUsesForTests();
    registerP2Uses();
    await syncQuestionSets();
    for (const id of ["pitch-detect", "chair-affect"]) {
      const v = (await rows`SELECT version FROM jev_question_set WHERE id = ${id} ORDER BY created_at DESC LIMIT 1`)[0]!.version as string;
      await moveStatus({ id, version: v, to: "bench", actor: "test", reason: "t" });
      await moveStatus({ id, version: v, to: "shadow", actor: "test", ratifiedBy: "v" });
    }
    SHA_PITCH = (await rows`SELECT content_sha256 AS s FROM jev_question_set WHERE id = 'pitch-detect' AND status = 'shadow'`)[0]!.s;
    SHA_CHAIR = (await rows`SELECT content_sha256 AS s FROM jev_question_set WHERE id = 'chair-affect' AND status = 'shadow'`)[0]!.s;
  }, 300_000);
  afterAll(() => pg.stop());
  beforeEach(() => { wipe(); delete process.env.JEV_CONSULT_BACKFILL_DAYS; });
  afterEach(() => { for (const k of ["JEV_WORKER_ENABLED", "ETA_JEV_TEXT_LANE", "JEV_USE_CONSULT_RUBRIC"]) delete process.env[k]; });
  const ctx = (sha: string) => ({ sha, mode: "shadow" });

  it("returns ONE key per consult_uid: the lexically smallest (one row per machine)", async () => {
    win("cx_0002@mb", "u_0001", { min: 1 }); win("cx_0002@ma", "u_0001", { min: 1 }); win("cx_0003@ma", "u_0002", { min: 2 });
    expect(await allTranscribedConsults(50, ctx(SHA_PITCH))).toEqual(["cx_0002@ma", "cx_0003@ma"]);
  });
  it("includes a consult with NO prescription uid, and one with a prescription ref", async () => {
    win("cx_0001@ma", "u_0001", { rx: null }); win("cx_0002@ma", "u_0002", { rx: "rx_0001" });
    expect((await allTranscribedConsults(50, ctx(SHA_PITCH))).sort()).toEqual(["cx_0001@ma", "cx_0002@ma"]);
  });
  it("excludes an untranscribed, an open, a uid-less and a room-less window", async () => {
    win("cx_0001@ma", "u_0001", { text: false }); win("cx_0002@ma", "u_0002", { closed: false }); win("cx_0003@ma", null); win("cx_0004@ma", "u_0004", { room: null }); win("cx_0005@ma", "u_0005");
    expect(await allTranscribedConsults(50, ctx(SHA_PITCH))).toEqual(["cx_0005@ma"]);
  });
  it("FIX 2 catalog stages: translate ok in; translate n/a + english in; n/a + other reason out; translate pending/failed (stt ok) out; stt not ok out; sealed not ok out", async () => {
    win("cx_0001@ma", "u_0001", { min: 1 });
    win("cx_0002@ma", "u_0002", { min: 2, translate: "n/a", reason: "english" });
    win("cx_0003@ma", "u_0003", { min: 3, translate: "n/a", reason: "no_speech" });
    win("cx_0004@ma", "u_0004", { min: 4, translate: "pending" });
    win("cx_0005@ma", "u_0005", { min: 5, translate: "failed" });
    win("cx_0006@ma", "u_0006", { min: 6, stt: "pending" });
    win("cx_0007@ma", "u_0007", { min: 7, stt: "failed", translate: "ok" });
    win("cx_0008@ma", "u_0008", { min: 8, sealed: "recut_queued" });
    win("cx_0009@ma", "u_0009", { min: 9, translate: "n/a" });
    expect(await allTranscribedConsults(50, ctx(SHA_PITCH))).toEqual(["cx_0001@ma", "cx_0002@ma"]);
  });
  it("FIX 2: a reb_track_index row or a sarvam result alone no longer makes a consult transcribed", async () => {
    win("cx_0001@ma", "u_0001", { text: false });
    pg.exec(`INSERT INTO reb_track_index (window_id, ist_date, room_id, layer, engine, version, config_hash, status, r2_key, sha256) VALUES ('consult-u_0001', current_date, 'rm_a', 'translate', 'e', 'v', 'h', 'ok', 'k_1', 's_1')`);
    expect(await allTranscribedConsults(50, ctx(SHA_PITCH))).toEqual([]);
  });
  it("ADDENDUM 2: encounter_catalog sealed state other than ok (or no catalog row, or no sealed stage) excludes the consult", async () => {
    win("cx_0001@ma", "u_0001", { sealed: "recut_queued" }); win("cx_0002@ma", "u_0002", { sealed: null }); win("cx_0003@ma", "u_0003", { sealed: "ok" });
    pg.exec(`INSERT INTO encounter_catalog (consult_uid, stages) VALUES ('u_0099', '{}'::jsonb)`);
    win("cx_0099@ma", "u_0099", { sealed: null });
    expect(await allTranscribedConsults(50, ctx(SHA_PITCH))).toEqual(["cx_0003@ma"]);
  });
  it("excludes a consult already decided for the sha (shadow), includes it for a different sha, and for a different mode; a decision on the sibling machine's key counts", async () => {
    win("cx_0001@ma", "u_0001", { min: 1 }); win("cx_0002@ma", "u_0002", { min: 2 }); win("cx_0003@ma", "u_0003", { min: 3 }); win("cx_0003@mb", "u_0003", { min: 3 });
    decide("cx_0001@ma", SHA_PITCH); decide("cx_0003@mb", SHA_PITCH);
    expect(await allTranscribedConsults(50, ctx(SHA_PITCH))).toEqual(["cx_0002@ma"]);
    expect(await allTranscribedConsults(50, ctx(SHA_CHAIR))).toEqual(["cx_0001@ma", "cx_0002@ma", "cx_0003@ma"]);
    expect(await allTranscribedConsults(50, { sha: SHA_PITCH, mode: "live" })).toHaveLength(3);
  });
  it("orders oldest close first", async () => {
    win("cx_0009@ma", "u_0009", { daysAgo: 1, min: 5 }); win("cx_0001@ma", "u_0001", { daysAgo: 3 }); win("cx_0005@ma", "u_0005", { daysAgo: 1, min: 1 });
    expect(await allTranscribedConsults(50, ctx(SHA_PITCH))).toEqual(["cx_0001@ma", "cx_0005@ma", "cx_0009@ma"]);
  });
  it("window bounds: default 7 IST days back (day 7 in, day 8 out), JEV_CONSULT_BACKFILL_DAYS widens to a max of 14, never a future window", async () => {
    win("cx_d07@ma", "u_d07", { daysAgo: 7 }); win("cx_d08@ma", "u_d08", { daysAgo: 8 }); win("cx_d14@ma", "u_d14", { daysAgo: 14 }); win("cx_d15@ma", "u_d15", { daysAgo: 15 });
    win("cx_fut@ma", "u_fut", { daysAgo: -1 });
    expect(backfillDays()).toBe(7);
    expect(await allTranscribedConsults(50, ctx(SHA_PITCH))).toEqual(["cx_d07@ma"]);
    process.env.JEV_CONSULT_BACKFILL_DAYS = "30";
    expect(backfillDays()).toBe(14);
    expect(await allTranscribedConsults(50, ctx(SHA_PITCH))).toEqual(["cx_d14@ma", "cx_d08@ma", "cx_d07@ma"]);
    process.env.JEV_CONSULT_BACKFILL_DAYS = "junk";
    expect(backfillDays()).toBe(7);
  });
  it("NO STARVATION: 300 decided old consults and 1 new one: eligible(50) returns the new one (and pendingSubjects, which asks limit*4)", async () => {
    pg.exec(`INSERT INTO eta_encounter_windows (consult_key, consult_uid, machine, room_id, attribution, t_open, t_close, close_reason, quality, resolver_version)
             SELECT 'cx_old' || lpad(g::text, 4, '0') || '@ma', 'u_old' || lpad(g::text, 4, '0'), 'mc_1', 'rm_a', 'none', ${TODAY0} - interval '3 days' + g * interval '1 second', ${TODAY0} - interval '3 days' + g * interval '1 second' + interval '1 second', 'endConsult', 'clean', 'v_t' FROM generate_series(1, 300) g`);
    pg.exec(`INSERT INTO encounter_catalog (consult_uid, stages) SELECT 'u_old' || lpad(g::text, 4, '0'), '{"sealed":{"state":"ok"},"stt":{"state":"ok"},"translate":{"state":"ok"}}'::jsonb FROM generate_series(1, 300) g`);
    pg.exec(`INSERT INTO jev_decision (id, subject_type, subject_id, question_id, prompt_version, model, question_set_sha256, order_variant, mode, answer)
             SELECT 'jd_old' || g, 'consult', 'cx_old' || lpad(g::text, 4, '0') || '@ma', 'q_1', 'pv', 'm', '${SHA_PITCH}', 'derived', 'shadow', '{"type":"none"}' FROM generate_series(1, 300) g`);
    win("cx_new1@ma", "u_new1", { min: 30 });
    expect(await allTranscribedConsults(50, ctx(SHA_PITCH))).toEqual(["cx_new1@ma"]);
    const def = getUse("consult_rubric", "pitch-detect")!;
    expect(await pendingSubjects(def, SHA_PITCH, "shadow", 12)).toEqual(["cx_new1@ma"]);
    // control: WITHOUT the sha the 50 oldest (all decided) come back and the new one is missing — the starvation the SQL exclusion removes
    expect(await allTranscribedConsults(50)).not.toContain("cx_new1@ma");
  });
  it("re-sweep idempotency: with everything decided a sweep enqueues 0 jobs; with one pending it enqueues one, a second sees the open job", async () => {
    Object.assign(process.env, { JEV_WORKER_ENABLED: "1", ETA_JEV_TEXT_LANE: "1", JEV_USE_CONSULT_RUBRIC: "1" });
    win("cx_0001@ma", "u_0001"); win("cx_0002@ma", "u_0002", { min: 1 });
    decide("cx_0001@ma", SHA_PITCH); decide("cx_0002@ma", SHA_PITCH);
    const def = getUse("consult_rubric", "pitch-detect")!;
    expect(await sweepUse(def)).toMatchObject({ enqueued: false, skipped: "nothing_pending" });
    expect(await sweepUse(def)).toMatchObject({ enqueued: false, skipped: "nothing_pending" });
    expect((await rows`SELECT count(*)::int AS c FROM scribe_job`)[0]!.c).toBe(0);
    win("cx_0003@ma", "u_0003", { min: 2 });
    expect(await sweepUse(def)).toMatchObject({ enqueued: true, pending: 1 });
    expect(await sweepUse(def)).toMatchObject({ enqueued: false, skipped: "open_job" });
    expect((await rows`SELECT count(*)::int AS c FROM scribe_job`)[0]!.c).toBe(1);
  });
  it("an unbuildable / null build leaves a no_state marker, so the subject is NOT re-offered; bench mode writes none", async () => {
    win("cx_0001@ma", "u_0001"); win("cx_0002@ma", "u_0002", { min: 1 }); win("cx_0003@ma", "u_0003", { min: 2 });
    const def = getUse("consult_rubric", "pitch-detect")!;
    const set = (await rows`SELECT id, version, content_sha256 AS sha, model_pin FROM jev_question_set WHERE id = 'pitch-detect' AND status = 'shadow'`)[0]!;
    const q = (await rows`SELECT question_id FROM jev_question WHERE question_set_id = 'pitch-detect' AND version = ${set.version}`);
    const defs = q.map((r) => ({ question_id: r.question_id })) as never;
    const ref = { id: set.id, version: set.version, sha: set.sha, modelPin: set.model_pin, use: "consult_rubric", subjectType: "consult" };
    await askSubject({ jobId: null, set: ref, defs, mode: "bench", subjectId: "cx_0001@ma", build: { unbuildable: "no_data" } });
    expect((await rows`SELECT count(*)::int AS c FROM jev_decision`)[0]!.c).toBe(0);
    await askSubject({ jobId: null, set: ref, defs, mode: "shadow", subjectId: "cx_0001@ma", build: { unbuildable: "no_data" } });
    await askSubject({ jobId: null, set: ref, defs, mode: "shadow", subjectId: "cx_0002@ma", build: null });
    const m = await rows`SELECT subject_id, outcome, evidence->>'no_state' AS why, band FROM jev_decision ORDER BY subject_id`;
    expect(m.map((r) => [r.subject_id, r.outcome, r.why, r.band])).toEqual(expect.arrayContaining([["cx_0001@ma", "no_answer", "no_data", "abstain"], ["cx_0002@ma", "no_answer", "null_build", "abstain"]]));
    expect(await pendingSubjects(def, SHA_PITCH, "shadow", 10)).toEqual(["cx_0003@ma"]);
  });
  it("JEV-NODATA-RETRY FIX1 F5: a stale no_data consult is re-offered END TO END (sweepUse enqueues a job, askSubject runs again), and a fresh marker is not", async () => {
    Object.assign(process.env, { JEV_WORKER_ENABLED: "1", ETA_JEV_TEXT_LANE: "1", JEV_USE_CONSULT_RUBRIC: "1" });
    win("cx_0001@ma", "u_0001");
    const def = getUse("consult_rubric", "pitch-detect")!;
    const set = (await rows`SELECT id, version, content_sha256 AS sha, model_pin FROM jev_question_set WHERE id = 'pitch-detect' AND status = 'shadow'`)[0]!;
    const q = (await rows`SELECT question_id FROM jev_question WHERE question_set_id = 'pitch-detect' AND version = ${set.version}`);
    const defs = q.map((r) => ({ question_id: r.question_id })) as never;
    const ref = { id: set.id, version: set.version, sha: set.sha, modelPin: set.model_pin, use: "consult_rubric", subjectType: "consult" };
    await askSubject({ jobId: null, set: ref, defs, mode: "shadow", subjectId: "cx_0001@ma", build: { unbuildable: "no_data" } });
    expect(await sweepUse(def)).toMatchObject({ enqueued: false, skipped: "nothing_pending" });      // inside the cooldown
    pg.exec(`UPDATE jev_decision SET created_at = now() - interval '40 minutes'`);
    expect(await sweepUse(def)).toMatchObject({ enqueued: true, pending: 1 });                        // re-offered and queued
    expect(await pendingSubjects(def, SHA_PITCH, "shadow", 10)).toEqual(["cx_0001@ma"]);
    const before = (await rows`SELECT min(created_at) AS t FROM jev_decision`)[0]!.t;
    await askSubject({ jobId: null, set: ref, defs, mode: "shadow", subjectId: "cx_0001@ma", build: { unbuildable: "no_data" } });   // the job's askSubject: re-mark
    expect((await rows`SELECT min(created_at) AS t FROM jev_decision`)[0]!.t).not.toEqual(before);
    expect(await pendingSubjects(def, SHA_PITCH, "shadow", 10)).toEqual([]);
    expect(Number((await rows`SELECT count(*)::int AS c FROM jev_decision WHERE subject_id = 'cx_0001@ma'`)[0]!.c)).toBeGreaterThan(0);
  });
  it("JEV-NODATA-RETRY FIX2 MUST-4: one full sweep cycle (sweepUse, the job plan, askSubject) logs exactly ONE nodata_retry line, equal to the retries the job builds (200 stale + 1 fresh = 199)", async () => {
    Object.assign(process.env, { JEV_WORKER_ENABLED: "1", ETA_JEV_TEXT_LANE: "1", JEV_USE_CONSULT_RUBRIC: "1" });
    pg.exec(`INSERT INTO eta_encounter_windows (consult_key, consult_uid, machine, room_id, attribution, t_open, t_close, close_reason, quality, resolver_version)
             SELECT 'st' || lpad(g::text, 4, '0') || '@ma', 'ust' || lpad(g::text, 4, '0'), 'mc_1', 'rm_a', 'none', now() - interval '3 hours' + g * interval '1 second', now() - interval '3 hours' + g * interval '1 second' + interval '1 second', 'endConsult', 'clean', 'v_t' FROM generate_series(1, 200) g`);
    pg.exec(`INSERT INTO encounter_catalog (consult_uid, stages) SELECT 'ust' || lpad(g::text, 4, '0'), '{"sealed":{"state":"ok"},"stt":{"state":"ok"},"translate":{"state":"ok"}}'::jsonb FROM generate_series(1, 200) g`);
    pg.exec(`INSERT INTO jev_decision (id, subject_type, subject_id, question_id, prompt_version, model, question_set_sha256, order_variant, mode, answer, outcome, evidence, created_at)
             SELECT 'jd_st' || g, 'consult', 'st' || lpad(g::text, 4, '0') || '@ma', 'q_1', 'pv', 'm', '${SHA_PITCH}', 'derived', 'shadow', '{"type":"none"}', 'no_answer', '{"no_state":"no_data"}', now() - interval '600 minutes' FROM generate_series(1, 200) g`);
    win("cx_fresh@ma", "u_fresh");
    const def = getUse("consult_rubric", "pitch-detect")!;
    const set = (await rows`SELECT id, version, content_sha256 AS sha, model_pin FROM jev_question_set WHERE id = 'pitch-detect' AND status = 'shadow'`)[0]!;
    const q = (await rows`SELECT question_id FROM jev_question WHERE question_set_id = 'pitch-detect' AND version = ${set.version}`);
    const ref = { id: set.id, version: set.version, sha: set.sha, modelPin: set.model_pin, use: "consult_rubric", subjectType: "consult" };
    const info = vi.spyOn(console, "info").mockImplementation(() => {});
    const lines = () => info.mock.calls.map((a) => String(a[0])).filter((l) => l.startsWith("jev consult nodata_retry="));
    try {
      expect(await sweepUse(def)).toMatchObject({ enqueued: true, pending: 50 });
      expect(lines()).toEqual([]);                                                       // the sweep's pick builds nothing: no line
      const args = { use: "consult_rubric", mode: "shadow", set_id: set.id, version: set.version, subjects_key: "sweep" };
      const out = await jevAskKind.run({ job: { id: "job_fix2", kind: "jev_ask", args, status: "running", step: "plan", progress: {}, result: null, error: null, actor: "test", created_at: "", started_at: "", updated_at: "", finished_at: null, lease_until: null, lease_owner: null, attempts: 1, failures: 0 }, step: "plan", args, progress: {} } as StepContext);
      expect(out.kind).toBe("next");
      const subjects = (out as unknown as { progress: { subjects: string[] } }).progress.subjects;
      const built = subjects.filter((k) => k !== "cx_fresh@ma").length;                  // every plan subject except the fresh one is a retry
      expect(subjects).toHaveLength(200);
      expect(subjects[0]).toBe("cx_fresh@ma");
      expect(built).toBe(199);
      for (const id of subjects.slice(0, 3)) await askSubject({ jobId: null, set: ref, defs: q.map((r) => ({ question_id: r.question_id })) as never, mode: "shadow", subjectId: id, build: { unbuildable: "no_data" } });
      expect(lines()).toEqual([`jev consult nodata_retry=${built}`]);                   // ONE line, from the plan pick
    } finally { info.mockRestore(); }
  });
  it("JEV-NODATA-RETRY FIX2 F3: the 48 h window uses max(t_close) over the uid's windows, not the picked key's (@ma 50 h ago, @mb 1 h ago: still re-offered; both old: terminal)", async () => {
    win("cx_0001@ma", "u_0001", { daysAgo: 1 }); win("cx_0001@mb", "u_0001", { daysAgo: 1 });
    pg.exec(`UPDATE eta_encounter_windows SET t_open = now() - interval '50 hours', t_close = now() - interval '50 hours' + interval '1 second' WHERE consult_key = 'cx_0001@ma'`);
    pg.exec(`UPDATE eta_encounter_windows SET t_open = now() - interval '1 hour', t_close = now() - interval '1 hour' + interval '1 second' WHERE consult_key = 'cx_0001@mb'`);
    const def = getUse("consult_rubric", "pitch-detect")!;
    pg.exec(`INSERT INTO jev_decision (id, subject_type, subject_id, question_id, prompt_version, model, question_set_sha256, order_variant, mode, answer, outcome, evidence, created_at)
             VALUES ('jd_f3', 'consult', 'cx_0001@ma', 'q_1', 'pv', 'm', '${SHA_PITCH}', 'derived', 'shadow', '{"type":"none"}', 'no_answer', '{"no_state":"no_data"}', now() - interval '600 minutes')`);
    expect(await pendingSubjects(def, SHA_PITCH, "shadow", 10)).toEqual(["cx_0001@ma"]);
    pg.exec(`UPDATE eta_encounter_windows SET t_open = now() - interval '49 hours', t_close = now() - interval '49 hours' + interval '1 second' WHERE consult_key = 'cx_0001@mb'`);
    expect(await pendingSubjects(def, SHA_PITCH, "shadow", 10)).toEqual([]);
  });
  it("coverage counts on a seeded fixture (counts only) and jevHealth carries them as `coverage`", async () => {
    win("cx_0001@ma", "u_0001", { today: true }); win("cx_0001@mb", "u_0001", { today: true }); win("cx_0002@ma", "u_0002", { today: true, min: 1 }); win("cx_0003@ma", "u_0003", { today: true, min: 2 });
    win("cx_0004@ma", "u_0004", { today: true, min: 3, text: false }); win("cx_0006@ma", "u_0006", { today: true, min: 5, sealed: null }); win("cx_0005@ma", "u_0005", { today: true, min: 4, closed: false });
    win("cx_old1@ma", "u_old1", { daysAgo: 2 });   // not today
    decide("cx_0001@ma", SHA_PITCH); decide("cx_0002@ma", SHA_PITCH); decide("cx_0003@ma", SHA_CHAIR); decide("cx_old1@ma", SHA_PITCH); decide("cx_0001@ma", SHA_CHAIR, "live");
    pg.exec(`INSERT INTO affect_calibration_map (id, target, score_col, calib_version, min_n, fit_on, git_sha, sha256, payload) VALUES (1, 'arousal', 'a', 'v', 1, 'f', '${"a".repeat(40)}', '${"b".repeat(64)}', '{}'), (2, 'valence', 'v', 'v', 1, 'f', '${"a".repeat(40)}', '${"c".repeat(64)}', '{}')`);
    pg.exec(`INSERT INTO affect_run (id, pipeline_version, git_sha, compute, speaker_source, arousal_model_id, arousal_model_rev, fallback_model_id, fallback_model_rev, valence_model_id, clef_question_set, purity_rule_version, purity_rule_json, calibration_arousal_id, calibration_valence_id, scope_json, input_manifest_sha256, state)
             VALUES (1, 'p', '${"a".repeat(40)}', 'cpu_dev', 'segments', 'a', 'r', 'f', 'r', 'v', 'q', 'pr', '{}', 1, 2, '{}', 'x', 'ok')`);
    pg.exec(`INSERT INTO affect_consult (run_id, consult_uid, cut_version, ist_date, n_windows, n_scorable) VALUES (1, 'u_0001', 'cv', (now() AT TIME ZONE 'Asia/Kolkata')::date, 0, 0), (1, 'u_0002', 'cv', (now() AT TIME ZONE 'Asia/Kolkata')::date, 0, 0), (1, 'u_old1', 'cv', (now() AT TIME ZONE 'Asia/Kolkata')::date - 2, 0, 0)`);
    const c = await consultCoverage();
    expect(c).toMatchObject({ cut: 5, transcribed: 3, jev_done: { "pitch-detect": 2, "chair-affect": 1 }, clef_done: 2 });
    expect(c.ist_date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(Object.keys(c).sort()).toEqual(["clef_done", "cut", "ist_date", "jev_done", "no_state", "transcribed"]);
    const h = await jevHealth();
    expect(h.coverage).toEqual({ ...c, backfill_since: "off" });
  });

  const setRef = async () => {
    const set = (await rows`SELECT id, version, content_sha256 AS sha, model_pin FROM jev_question_set WHERE id = 'pitch-detect' AND status = 'shadow'`)[0]!;
    const q = await rows`SELECT question_id FROM jev_question WHERE question_set_id = 'pitch-detect' AND version = ${set.version}`;
    return { defs: q.map((r) => ({ question_id: r.question_id })) as never, ref: { id: set.id, version: set.version, sha: set.sha, modelPin: set.model_pin, use: "consult_rubric", subjectType: "consult" } as never };
  };
  it("M1 (RF-A1): a transient unbuildable never changes 7 real answered rows; call_id is kept", async () => {
    win("cx_0001@ma", "u_0001");
    const { defs, ref } = await setRef();
    for (let i = 1; i <= 7; i++) pg.exec(`INSERT INTO jev_decision (id, subject_type, subject_id, question_id, prompt_version, model, question_set_sha256, order_variant, mode, answer, outcome, call_id) VALUES ('jd_r${i}', 'consult', 'cx_0001@ma', 'q_${i}', 'pv', 'jev-real', '${SHA_PITCH}', 'derived', 'shadow', '{"type":"noul","p":0.5}', 'answered', 'jc_real_1')`);
    const before = await rows`SELECT id, question_id, outcome, call_id, answer, model FROM jev_decision ORDER BY id`;
    for (const build of [{ unbuildable: "read_refused" }, null] as const) await askSubject({ jobId: null, set: ref, defs, mode: "shadow", subjectId: "cx_0001@ma", build: build as never });
    expect(await rows`SELECT id, question_id, outcome, call_id, answer, model FROM jev_decision ORDER BY id`).toEqual(before);
    expect(before).toHaveLength(7);
    expect(before.every((r) => r.call_id === "jc_real_1" && r.outcome === "answered")).toBe(true);
  });
  it("M1: a marker written twice gives one row per question; another mode / sha is not blocked by the skip", async () => {
    win("cx_0001@ma", "u_0001");
    const { defs, ref } = await setRef();
    for (let i = 0; i < 2; i++) await askSubject({ jobId: null, set: ref, defs, mode: "shadow", subjectId: "cx_0001@ma", build: { unbuildable: "no_data" } });
    const nq = (defs as unknown[]).length;
    expect((await rows`SELECT count(*)::int AS c FROM jev_decision WHERE subject_id = 'cx_0001@ma' AND mode = 'shadow'`)[0]!.c).toBe(nq);
    await askSubject({ jobId: null, set: ref, defs, mode: "live", subjectId: "cx_0001@ma", build: { unbuildable: "no_data" } });
    expect((await rows`SELECT count(*)::int AS c FROM jev_decision WHERE subject_id = 'cx_0001@ma' AND mode = 'live'`)[0]!.c).toBe(nq);
  });
  it("M2 (RF-A5): markers are not jev_done (they are no_state), and an untranscribed consult's decision is not counted", async () => {
    win("cx_0001@ma", "u_0001", { today: true }); win("cx_0002@ma", "u_0002", { today: true, min: 1, text: false });
    const { defs, ref } = await setRef();
    await askSubject({ jobId: null, set: ref, defs, mode: "shadow", subjectId: "cx_0001@ma", build: null });
    decide("cx_0002@ma", SHA_PITCH);
    const c = await consultCoverage();
    expect(c).toMatchObject({ cut: 2, transcribed: 1, jev_done: { "pitch-detect": 0, "chair-affect": 0 }, no_state: { "pitch-detect": 1, "chair-affect": 0 } });
    decide("cx_0001@mb", SHA_PITCH); // a real row on the sibling key: the consult now counts as done, not no_state
    win("cx_0001@mb", "u_0001", { today: true });
    expect(await consultCoverage()).toMatchObject({ jev_done: { "pitch-detect": 1 }, no_state: { "pitch-detect": 0 } });
  });
  it("L2: coverage throwing gives coverage { unavailable: true } and the rest of jevHealth is unchanged", async () => {
    pg.exec(`ALTER TABLE encounter_catalog RENAME TO encounter_catalog_x`);
    try {
      const h = await jevHealth();
      expect(h.coverage).toEqual({ unavailable: true, backfill_since: "off" });
      expect(h.uses.length).toBeGreaterThan(0);
      expect(h.budget).toBeDefined();
    } finally { pg.exec(`ALTER TABLE encounter_catalog_x RENAME TO encounter_catalog`); }
  });
});

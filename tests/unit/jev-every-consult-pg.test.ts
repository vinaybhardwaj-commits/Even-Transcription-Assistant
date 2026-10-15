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

const HAVE = dockerAvailable();
const ALLOW_SKIP = process.env.ETA_ALLOW_SKIP_E2E === "1";
const pg = pgContainer("eta-jev-every-consult");
const ALL = readdirSync("db/migrations").filter((f) => f.endsWith(".sql")).sort();
const rows = async (q: TemplateStringsArray, ...v: unknown[]) => (await H.pg!.sql(q, ...v)) as Array<Record<string, any>>;
const suite = HAVE || !ALLOW_SKIP ? describe : describe.skip;

const TODAY0 = "(date_trunc('day', now() AT TIME ZONE 'Asia/Kolkata') AT TIME ZONE 'Asia/Kolkata')";
let SHA_PITCH = "", SHA_CHAIR = "";
let n = 0;
/** One eta_encounter_windows row: opened `daysAgo` IST days before today's midnight (+ `min` minutes), closed 1 s after. Synthetic ids only. */
function win(key: string, uid: string | null, o: { daysAgo?: number; min?: number; closed?: boolean; room?: string | null; rx?: string | null; text?: boolean; layer?: "translate" | "stt"; lang?: string | null; sealed?: string | null } = {}): void {
  const { daysAgo = 0, min = 0, closed = true, room = "rm_a", rx = null, text = true, layer = "translate", lang = null, sealed = "ok" } = o;
  const open = `${TODAY0} - interval '${daysAgo} days' + interval '${min} minutes'`;
  pg.exec(`INSERT INTO eta_encounter_windows (consult_key, consult_uid, prescription_ref, machine, room_id, attribution, t_open, t_close, close_reason, quality, resolver_version)
           VALUES ('${key}', ${uidSql(uid)}, ${rx ? `'${rx}'` : "NULL"}, 'mc_1', ${room ? `'${room}'` : "NULL"}, 'none', ${open}, ${closed ? `${open} + interval '1 second'` : "NULL"}, '${closed ? "endConsult" : "open"}', 'clean', 'v_t')`);
  if (!uid) return;
  if (text) pg.exec(`INSERT INTO reb_track_index (window_id, ist_date, room_id, layer, engine, version, config_hash, status, r2_key, sha256) VALUES ('consult-${uid}', current_date, '${room ?? "rm_a"}', '${layer}', 'e_${++n}', 'v', 'h', 'ok', 'k_${n}', 's_${n}') ON CONFLICT DO NOTHING`);
  if (lang) pg.exec(`INSERT INTO consult_sarvam_result (consult_uid, cut_version, mode, english, job_id, result_r2_key, model_stt, model_translate, model_rev, pipeline_rev, language_code, t0_ms) SELECT '${uid}', 'cv', 'transcribe', false, 'j_${++n}', 'mcp-sarvam/j_${n}.json', 'm', 'm', 'r', 'r', '${lang}', 0 WHERE NOT EXISTS (SELECT 1 FROM consult_sarvam_result WHERE consult_uid = '${uid}')`);
  if (sealed) pg.exec(`INSERT INTO encounter_catalog (consult_uid, stages) VALUES ('${uid}', '{"sealed":{"state":"${sealed}"}}'::jsonb) ON CONFLICT DO NOTHING`);
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
  it("ADDENDUM 1: a non-English consult with stt ok and NO translate is excluded; an English stt-only consult is included; a translate-ok consult is included", async () => {
    win("cx_0001@ma", "u_0001", { layer: "stt", lang: "hi-IN" }); win("cx_0002@ma", "u_0002", { layer: "stt", lang: "en-IN" }); win("cx_0003@ma", "u_0003", { layer: "translate", lang: "hi-IN" });
    win("cx_0004@ma", "u_0004", { layer: "stt", lang: null });
    expect((await allTranscribedConsults(50, ctx(SHA_PITCH))).sort()).toEqual(["cx_0002@ma", "cx_0003@ma"]);
  });
  it("ADDENDUM 1(c): the bench_window stt_turn cue alone is NOT a transcript any more", async () => {
    win("cx_0001@ma", "u_0001", { text: false });
    pg.exec(`INSERT INTO room (id, slug, name, pin_hash) VALUES ('rm_a', 'rm-a-t1', 'Room T', 'x') ON CONFLICT DO NOTHING; INSERT INTO room_day (id, room_id, ist_date) VALUES ('rd_1', 'rm_a', current_date); INSERT INTO bench_session (id, room_id) VALUES ('bs_1', 'rm_a')`);
    const t = (await rows`SELECT (extract(epoch FROM t_open) * 1000)::bigint AS o FROM eta_encounter_windows WHERE consult_key = 'cx_0001@ma'`)[0]!.o;
    pg.exec(`INSERT INTO bench_window (id, session_id, room_day_id, start_ms, end_ms, source_mic) VALUES ('bw_1', 'bs_1', 'rd_1', ${Number(t) - 1000}, ${Number(t) + 60000}, 'mic_1')`);
    pg.exec(`INSERT INTO cue (id, room_day_id, type, at, payload) VALUES ('cu_1', 'rd_1', 'stt_turn', now(), '{"window":{"start_ms":${Number(t) - 1000}}}')`);
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
    pg.exec(`INSERT INTO reb_track_index (window_id, ist_date, room_id, layer, engine, version, config_hash, status, r2_key, sha256)
             SELECT 'consult-u_old' || lpad(g::text, 4, '0'), current_date, 'rm_a', 'translate', 'e', 'v', 'h', 'ok', 'k' || g, 's' || g FROM generate_series(1, 300) g`);
    pg.exec(`INSERT INTO encounter_catalog (consult_uid, stages) SELECT 'u_old' || lpad(g::text, 4, '0'), '{"sealed":{"state":"ok"}}'::jsonb FROM generate_series(1, 300) g`);
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
  it("coverage counts on a seeded fixture (counts only) and jevHealth carries them as `coverage`", async () => {
    win("cx_0001@ma", "u_0001"); win("cx_0001@mb", "u_0001"); win("cx_0002@ma", "u_0002", { min: 1 }); win("cx_0003@ma", "u_0003", { min: 2 });
    win("cx_0004@ma", "u_0004", { min: 3, text: false }); win("cx_0006@ma", "u_0006", { min: 5, sealed: null }); win("cx_0005@ma", "u_0005", { min: 4, closed: false });
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
    expect(h.coverage).toEqual(c);
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
    win("cx_0001@ma", "u_0001"); win("cx_0002@ma", "u_0002", { min: 1, text: false });
    const { defs, ref } = await setRef();
    await askSubject({ jobId: null, set: ref, defs, mode: "shadow", subjectId: "cx_0001@ma", build: null });
    decide("cx_0002@ma", SHA_PITCH);
    const c = await consultCoverage();
    expect(c).toMatchObject({ cut: 2, transcribed: 1, jev_done: { "pitch-detect": 0, "chair-affect": 0 }, no_state: { "pitch-detect": 1, "chair-affect": 0 } });
    decide("cx_0001@mb", SHA_PITCH); // a real row on the sibling key: the consult now counts as done, not no_state
    win("cx_0001@mb", "u_0001");
    expect(await consultCoverage()).toMatchObject({ jev_done: { "pitch-detect": 1 }, no_state: { "pitch-detect": 0 } });
  });
  it("L2: coverage throwing gives coverage { unavailable: true } and the rest of jevHealth is unchanged", async () => {
    pg.exec(`ALTER TABLE encounter_catalog RENAME TO encounter_catalog_x`);
    try {
      const h = await jevHealth();
      expect(h.coverage).toEqual({ unavailable: true });
      expect(h.uses.length).toBeGreaterThan(0);
      expect(h.budget).toBeDefined();
    } finally { pg.exec(`ALTER TABLE encounter_catalog_x RENAME TO encounter_catalog`); }
  });
  it("L3: an older-cut en row plus a current-cut non-en row, stt only, is excluded; a current-cut en row is included", async () => {
    win("cx_0001@ma", "u_0001", { layer: "stt" }); win("cx_0002@ma", "u_0002", { min: 1, layer: "stt" });
    const ins = (uid: string, cv: string, lang: string, at: string) => pg.exec(`INSERT INTO consult_sarvam_result (consult_uid, cut_version, mode, english, job_id, result_r2_key, model_stt, model_translate, model_rev, pipeline_rev, language_code, t0_ms, created_at) VALUES ('${uid}', '${cv}', 'transcribe', false, 'j_${++n}', 'mcp-sarvam/j_${n}.json', 'm', 'm', 'r', 'r', '${lang}', 0, now() - interval '${at}')`);
    ins("u_0001", "cv_old", "en-IN", "2 hours"); ins("u_0001", "cv_new", "hi-IN", "1 hour");
    ins("u_0002", "cv_old", "hi-IN", "2 hours"); ins("u_0002", "cv_new", "en-IN", "1 hour");
    expect(await allTranscribedConsults(50, ctx(SHA_PITCH))).toEqual(["cx_0002@ma"]);
  });
});

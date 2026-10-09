/**
 * tests/unit/s7-rubric-pg.test.ts — REQUIRED PROOF for S7-0 on a real postgres:16 (bound parameters, as the Neon driver sends them):
 *   1. migration 0139 applies twice and its constraints hold (no text columns, unique (rubric, version, unit, lab), statuses, scores are objects);
 *   2. the readers on fixture tables shaped like the real ones (blind room-days refused; the turn-text key and the join documented in the reader; window and turn times in ABSOLUTE epoch ms, as measured on production);
 *   3. the job kinds rubric_run and rubric_bench through the REAL runner (claimJobs / runOneStep): results in Neon, evidence in R2 (an in-memory lab store), bench pass / fail.
 * The fixture DDL below carries only the columns the readers use; it mirrors migrations 0042, 0057, 0074, 0085, 0089, 0105, 0112, 0123 and 0129 (read, not applied: their FKs reach
 * tables this suite does not need).
 */
import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { dockerAvailable, pgContainer } from "../support/s1-pg";

type Row = Record<string, unknown>;
const H = vi.hoisted(() => ({ sql: null as null | ((s: TemplateStringsArray, ...v: unknown[]) => Promise<unknown[]>), statements: [] as Array<{ text: string }> }));
const statements = H.statements;
vi.mock("@/lib/db", () => ({
  // `transaction` of the Neon driver: the statements arrive already started (the harness runs each one synchronously, in order), so the transaction is their results in order
  sql: Object.assign((s: TemplateStringsArray, ...v: unknown[]) => { H.statements.push({ text: s.join("?") }); return H.sql!(s, ...v); }, { transaction: async (qs: Array<Promise<unknown>>) => Promise.all(qs) }),
}));
vi.setConfig({ testTimeout: 60_000, hookTimeout: 180_000 });

const HAVE = dockerAvailable();
const pg = pgContainer("eta-s7-rubric");

const FIXTURE_DDL = `
CREATE TABLE schema_migrations (version integer PRIMARY KEY, name text, applied_at timestamptz DEFAULT now());
CREATE TABLE room_day (id text PRIMARY KEY, room_id text NOT NULL, ist_date date NOT NULL, UNIQUE (room_id, ist_date));
CREATE TABLE bench_session (id text PRIMARY KEY, room_id text NOT NULL, started_at timestamptz NOT NULL);
CREATE TABLE bench_window (id text PRIMARY KEY, session_id text NOT NULL, room_day_id text, start_ms bigint NOT NULL, end_ms bigint NOT NULL);
CREATE TABLE cue (id text PRIMARY KEY, room_day_id text NOT NULL, type text NOT NULL, source_ref text, payload jsonb, at timestamptz NOT NULL DEFAULT now());
CREATE TABLE room_turn_speaker (window_id text NOT NULL, source_ref text NOT NULL, speaker_idx integer NOT NULL, overlap_ms integer NOT NULL DEFAULT 0, room_day_id text,
  clinician_id text, role text, match_confidence double precision, no_role_reason text, PRIMARY KEY (window_id, source_ref),
  CONSTRAINT room_turn_speaker_role_ck CHECK (role IS NULL OR role = 'clinician'),
  CONSTRAINT room_turn_speaker_clinician_ck CHECK (role <> 'clinician' OR (clinician_id IS NOT NULL AND btrim(clinician_id) <> '' AND match_confidence IS NOT NULL)),
  CONSTRAINT room_turn_speaker_identity_ck CHECK ((clinician_id IS NULL AND match_confidence IS NULL) OR COALESCE(role, '') = 'clinician'),
  CONSTRAINT room_turn_speaker_no_role_ck CHECK ((role IS NULL) = (no_role_reason IS NOT NULL)),
  CONSTRAINT room_turn_speaker_reason_ck CHECK (no_role_reason IS NULL OR no_role_reason IN ('straddle', 'no_match')),
  CONSTRAINT room_turn_speaker_confidence_ck CHECK (match_confidence IS NULL OR (match_confidence >= 0 AND match_confidence <= 1)));
CREATE TABLE room_diarize_window (window_id text PRIMARY KEY, room_day_id text, state text NOT NULL);
CREATE TABLE room_span_emotion (window_id text NOT NULL, diarize_run_id text NOT NULL, run_start_ms bigint NOT NULL, run_end_ms bigint NOT NULL, chunk_idx integer NOT NULL, speaker_idx integer NOT NULL,
  segment_start_ms bigint NOT NULL, segment_end_ms bigint NOT NULL, state text NOT NULL, anger double precision, disgust double precision, enthusiasm double precision, fear double precision,
  happiness double precision, neutral double precision, sadness double precision, top_label text, top_score double precision, PRIMARY KEY (window_id, diarize_run_id, speaker_idx, run_start_ms, chunk_idx));
CREATE TABLE jev_window_text (window_id text PRIMARY KEY, room_day_id text NOT NULL, english text, source text NOT NULL, char_count int NOT NULL);
CREATE TABLE room_audio_state (id bigserial PRIMARY KEY, room_id text NOT NULL, source text NOT NULL DEFAULT 'kiosk', ist_day date NOT NULL, state text NOT NULL, ts_start timestamptz NOT NULL, ts_end timestamptz NOT NULL);
CREATE TABLE room_audio_day (room_id text NOT NULL, ist_day date NOT NULL, min_off integer NOT NULL DEFAULT 0, min_muted integer NOT NULL DEFAULT 0, min_zero_all_day integer NOT NULL DEFAULT 0,
  min_present integer NOT NULL DEFAULT 0, min_gated integer NOT NULL DEFAULT 0, PRIMARY KEY (room_id, ist_day));
CREATE TABLE bench_level_sample (id bigserial PRIMARY KEY, room_id text NOT NULL, ist_date date NOT NULL, sampled_at timestamptz NOT NULL, peak real NOT NULL, avg real, zero_ratio real);
CREATE TABLE eta_encounter_windows (id serial PRIMARY KEY, consult_key text NOT NULL UNIQUE, room_id text, t_open timestamptz NOT NULL, t_close timestamptz, quality text NOT NULL DEFAULT 'clean', attribution text NOT NULL DEFAULT 'rows');
`;
const IST = (hhmmss: string, date = "2026-10-08") => `${date}T${hhmmss}+05:30`;
/** ABSOLUTE epoch ms, the frame of bench_window.start_ms / end_ms and of a stt_turn cue's start_ms / end_ms (G56) */
const EP = (hhmmss: string, date = "2026-10-08") => Date.parse(IST(hhmmss, date));
const W1 = EP("10:00:00"), W3 = EP("10:00:00", "2026-08-23"), W4 = EP("10:00:00", "2026-08-24");

beforeAll(() => {
  if (!HAVE) return;
  pg.start();
  pg.exec(FIXTURE_DDL);
  pg.exec("ALTER TABLE eta_encounter_windows ADD COLUMN IF NOT EXISTS consult_uid text, ADD COLUMN IF NOT EXISTS warehouse_prescription_uid text;");
  pg.exec(readFileSync("db/migrations/0082_scribe_job.sql", "utf8"));
  pg.exec(readFileSync("db/migrations/0139_rubric_results.sql", "utf8"));
  H.sql = pg.sql as never;
  const rows = (s: string) => pg.exec(s);
  rows(`
    INSERT INTO room_day VALUES ('rd1', 'r1', '2026-10-08'), ('rd2', 'room_qyzghzaf', '2026-08-23'), ('rd3', 'room_qyzghzaf', '2026-08-24');
    INSERT INTO room_audio_day (room_id, ist_day, min_present) VALUES ('r1', '2026-10-08', 100);
    INSERT INTO bench_session VALUES ('bs1', 'r1', '${IST("08:00:00")}'), ('bs2', 'room_qyzghzaf', '${IST("08:00:00", "2026-08-23")}'), ('bs3', 'room_qyzghzaf', '${IST("08:00:00", "2026-08-24")}');
    INSERT INTO bench_window VALUES ('w1', 'bs1', 'rd1', ${W1}, ${W1 + 60000}), ('w2', 'bs1', 'rd1', ${W1 + 60000}, ${W1 + 120000}), ('w3', 'bs2', 'rd2', ${W3}, ${W3 + 60000}), ('w4', 'bs3', 'rd3', ${W4}, ${W4 + 60000});
    INSERT INTO room_diarize_window VALUES ('w1', 'rd1', 'ok'), ('w3', 'rd2', 'ok'), ('w4', 'rd3', 'ok');
    -- w1: four turns (0-10 s doctor, 8-20 s other, 25-35 s doctor, 40-42 s unattributed)
    INSERT INTO cue (id, room_day_id, type, source_ref, payload) VALUES
      ('c1','rd1','stt_turn','w1:t1','{"start_ms":${W1 + 0},"end_ms":${W1 + 10000},"text":"alpha","window":{"start_ms":${W1},"end_ms":${W1 + 60000}}}'),
      ('c2','rd1','stt_turn','w1:t2','{"start_ms":${W1 + 8000},"end_ms":${W1 + 20000},"text":"bravo","window":{"start_ms":${W1},"end_ms":${W1 + 60000}}}'),
      ('c3','rd1','stt_turn','w1:t3','{"start_ms":${W1 + 25000},"end_ms":${W1 + 35000},"text":"charlie","window":{"start_ms":${W1},"end_ms":${W1 + 60000}}}'),
      ('c4','rd1','stt_turn','w1:t4','{"start_ms":${W1 + 40000},"end_ms":${W1 + 42000},"text":"delta","window":{"start_ms":${W1},"end_ms":${W1 + 60000}}}'),
      ('c5','rd1','stt_turn','w2:t1','{"start_ms":${(W1 + 60000) + 0},"end_ms":${(W1 + 60000) + 10000},"text":"echo","window":{"start_ms":${(W1 + 60000)},"end_ms":${(W1 + 60000) + 60000}}}'),
      ('c6','rd2','stt_turn','w3:t1','{"start_ms":${W3 + 0},"end_ms":${W3 + 5000},"text":"foxtrot","window":{"start_ms":${W3},"end_ms":${W3 + 60000}}}'),
      ('c7','rd3','stt_turn','w4:t1','{"start_ms":${W4 + 0},"end_ms":${W4 + 5000},"text":"golf","window":{"start_ms":${W4},"end_ms":${W4 + 60000}}}'),
      ('c8','rd3','stt_turn','w4:t2','{"start_ms":${W4 + 6000},"end_ms":${W4 + 9000},"text":"hotel","window":{"start_ms":${W4},"end_ms":${W4 + 60000}}}');
    INSERT INTO room_turn_speaker (window_id, source_ref, speaker_idx, overlap_ms, room_day_id, clinician_id, role, match_confidence, no_role_reason) VALUES
      ('w1','w1:t1',0,10000,'rd1','clin_a','clinician',0.9,NULL), ('w1','w1:t2',1,12000,'rd1',NULL,NULL,NULL,'no_match'), ('w1','w1:t3',0,10000,'rd1','clin_a','clinician',0.88,NULL),
      ('w4','w4:t1',0,5000,'rd3','clin_b','clinician',0.8,NULL), ('w4','w4:t2',1,3000,'rd3',NULL,NULL,NULL,'no_match');
    INSERT INTO jev_window_text VALUES ('w1','rd1','English text of w1','run_english',18), ('w2','rd1',NULL,'not_ready',0), ('w3','rd2','x','native_en',1), ('w4','rd3','y','native_en',1);
    INSERT INTO room_span_emotion VALUES ('w1','dr1',0,60000,0,0,0,10000,'scored',.1,.0,.2,.0,.3,.3,.1,'happiness',.3), ('w1','dr1',0,60000,1,1,8000,20000,'skipped',NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL);
    -- room r1, IST hour 10: speech 10:00-10:50, muted 10:50-11:00; hour 11: off 11:00-11:30, audio_present 11:30-12:00; r2 hour 10: zero_all_day
    INSERT INTO room_audio_state (room_id, ist_day, state, ts_start, ts_end) VALUES
      ('r1','2026-10-08','speech','${IST("10:00:00")}','${IST("10:50:00")}'), ('r1','2026-10-08','muted','${IST("10:50:00")}','${IST("11:00:00")}'),
      ('r1','2026-10-08','recorder_off','${IST("11:00:00")}','${IST("11:30:00")}'), ('r1','2026-10-08','audio_present','${IST("11:30:00")}','${IST("12:00:00")}'),
      ('room_qyzghzaf','2026-08-23','device_dead','${IST("10:00:00", "2026-08-23")}','${IST("11:00:00", "2026-08-23")}'),
      ('room_qyzghzaf','2026-08-24','device_dead','${IST("10:00:00", "2026-08-24")}','${IST("11:00:00", "2026-08-24")}');
    INSERT INTO bench_level_sample (room_id, ist_date, sampled_at, peak, avg, zero_ratio) VALUES ('r1','2026-10-08','${IST("10:10:00")}',0.99,0.2,0.0), ('r1','2026-10-08','${IST("10:20:00")}',0.5,0.2,0.02);
    -- a consult of r1 from 10:00:00 to 10:00:30, and an open one
    INSERT INTO eta_encounter_windows (consult_key, room_id, t_open, t_close) VALUES ('enc1@m1','r1','${IST("10:00:00")}','${IST("10:00:30")}'), ('enc2@m1','r1','${IST("10:05:00")}',NULL), ('enc3@m2','room_qyzghzaf','${IST("10:00:00", "2026-08-23")}','${IST("10:00:30", "2026-08-23")}'), ('enc4@m2','room_qyzghzaf','${IST("10:00:00", "2026-08-24")}','${IST("10:00:30", "2026-08-24")}');
  `);
}, 240_000);
afterAll(() => { if (HAVE) pg.stop(); });

describe("REQUIRED PROOF ran, or was skipped deliberately", () => {
  it("needs Docker", () => {
    if (HAVE || process.env.ETA_ALLOW_SKIP_E2E === "1") return;
    throw new Error("REQUIRED PROOF NOT RUN: tests/unit/s7-rubric-pg.test.ts needs Docker for postgres:16, or set ETA_ALLOW_SKIP_E2E=1.");
  });
});

describe.runIf(HAVE)("migration 0139", () => {
  it("applies a second time without error and registers once", () => {
    pg.exec(readFileSync("db/migrations/0139_rubric_results.sql", "utf8"));
  });
  it("registers once and has no text column", async () => {
    expect(((await pg.sql`SELECT count(*)::int AS n FROM schema_migrations WHERE version = 139`)[0] as { n: number }).n).toBe(1);
    expect(((await pg.sql`SELECT count(*)::int AS n FROM information_schema.columns WHERE table_name IN ('rubric_run', 'rubric_result') AND column_name IN ('transcript', 'text', 'english', 'transcript_text', 'body')`)[0] as { n: number }).n).toBe(0);
  });
  it("its constraints hold: kinds, statuses, unit kinds, an object score, an array findings, unique (rubric, version, unit, lab), run FK", () => {
    const fails = (q: string) => { try { pg.exec(q); return ""; } catch (e) { return String((e as { stderr?: unknown }).stderr ?? e); } };
    pg.exec(`INSERT INTO rubric_run (run_id, rubric_id, version, kind) VALUES ('rub_t', 'talk_time', '0.1.0', 'run');`);
    expect(fails(`INSERT INTO rubric_run (run_id, rubric_id, version, kind) VALUES ('rub_x', 'talk_time', '0.1.0', 'other');`)).toMatch(/check constraint/);
    expect(fails(`INSERT INTO rubric_run (run_id, rubric_id, version, kind) VALUES ('rub_x', 'Bad-Id', '0.1.0', 'run');`)).toMatch(/check constraint/);
    const ins = (over: string) => `INSERT INTO rubric_result (rubric_id, version, unit_kind, unit_key, run_id, status, score, findings, lab) VALUES ${over};`;
    pg.exec(ins(`('talk_time','0.1.0','window','u1','rub_t','ok','{"a":1}','["x"]',true)`));
    expect(fails(ins(`('talk_time','0.1.0','window','u1','rub_t','ok','{"a":1}','[]',true)`))).toMatch(/unique|duplicate/i);
    pg.exec(ins(`('talk_time','0.1.0','window','u1','rub_t','ok','{"a":1}','[]',false)`)); // the same unit, a production row beside the lab one
    expect(fails(ins(`('talk_time','0.1.0','window','u2','rub_t','maybe',NULL,NULL,false)`))).toMatch(/check constraint/);
    expect(fails(ins(`('talk_time','0.1.0','sprocket','u2','rub_t','ok',NULL,NULL,false)`))).toMatch(/check constraint/);
    expect(fails(ins(`('talk_time','0.1.0','window','u2','rub_t','ok','[1]',NULL,false)`))).toMatch(/check constraint/);
    expect(fails(ins(`('talk_time','0.1.0','window','u2','rub_t','ok',NULL,'{"a":1}',false)`))).toMatch(/check constraint/);
    expect(fails(ins(`('talk_time','0.1.0','window','u2','rub_nope','ok',NULL,NULL,false)`))).toMatch(/foreign key/);
    pg.exec(`DELETE FROM rubric_result; DELETE FROM rubric_run;`);
  });
});

describe.runIf(HAVE)("the readers on fixtures", () => {
  it("audio_state: the hour's intervals, the level samples and the day rollup; a room-hour with no state is no_data; bad keys are refused", async () => {
    const R = await import("@/lib/rubrics/readers");
    const got = await R.readAudioHour("r1", "2026-10-08", 10);
    expect(got.ok && got.data.intervals.map((i) => i.state)).toEqual(["speech", "muted"]);
    expect(got.ok && got.data.samples).toMatchObject({ n: 2, peak_max: expect.closeTo(0.99, 5) });
    expect(got.ok && got.data.day).toMatchObject({ min_present: 100 });
    expect(await R.readAudioHour("r1", "2026-10-08", 3)).toMatchObject({ ok: false, reason: "no_data" });
    expect(await R.readAudioHour("r1; DROP TABLE x", "2026-10-08", 3)).toMatchObject({ ok: false, reason: "bad_unit_key" });
    expect(await R.readAudioHour("r1", "2026-13-40", 3)).toMatchObject({ ok: false, reason: "bad_unit_key" });
    // the held-out pair is refused by EVERY reader, audio_state included, before any fetch; the neighbour day of the same room is not
    statements.length = 0;
    expect(await R.readAudioHour("room_qyzghzaf", "2026-08-23", 10)).toMatchObject({ ok: false, reason: "blind_room_day" });
    expect(statements).toEqual([]); // no query was made at all
    expect(await R.readAudioHour("room_qyzghzaf", "2026-08-24", 10)).toMatchObject({ ok: true });
    expect(await R.listAudioHours({ from: "2026-10-08", to: "2026-10-08", limit: 100 })).toMatchObject({ keys: ["r1:2026-10-08:10", "r1:2026-10-08:11"], truncated: false, blind_excluded: 0 });
    expect(await R.listAudioHours({ from: "2026-08-23", to: "2026-08-24", limit: 100 })).toMatchObject({ keys: ["room_qyzghzaf:2026-08-24:10"], blind_excluded: 1 }); // the blind hour is never offered
    expect(await R.listAudioHours({ rooms: ["r1"], from: "2026-10-08", to: "2026-10-08", limit: 1 })).toMatchObject({ keys: ["r1:2026-10-08:10"], truncated: true });
    expect(R.parseRoomHourKey("r1:2026-10-08:10")).toEqual({ room_id: "r1", ist_date: "2026-10-08", hour: 10 });
    expect(R.parseRoomHourKey("r1:2026-10-08:25")).toBeNull();
  });
  it("turns: the cue timings joined to room_turn_speaker; text only when asked; the blind room-day is refused", async () => {
    const R = await import("@/lib/rubrics/readers");
    const got = await R.readWindowTurns("w1");
    expect(got.ok && got.data.turns.map((t) => [t.start_ms, t.end_ms, t.speaker_idx, t.role])).toEqual([[W1, W1 + 10000, 0, "clinician"], [W1 + 8000, W1 + 20000, 1, null], [W1 + 25000, W1 + 35000, 0, "clinician"], [W1 + 40000, W1 + 42000, null, null]]);
    expect(got.ok && got.data).toMatchObject({ attributed: 3, diarize_state: "ok", start_ms: W1, end_ms: W1 + 60000 });
    expect(got.ok && "text" in got.data.turns[0]!).toBe(false);
    const withText = await R.readWindowTurns("w1", { includeText: true });
    expect(withText.ok && withText.data.turns.map((t) => t.text)).toEqual(["alpha", "bravo", "charlie", "delta"]);
    statements.length = 0;
    expect(await R.readWindowTurns("w3")).toMatchObject({ ok: false, reason: "blind_room_day" });
    expect(statements.some((q) => /FROM cue|room_turn_speaker|room_diarize_window/.test(q.text))).toBe(false); // the cues were never read
    expect(await R.readWindowTurns("w4")).toMatchObject({ ok: true, data: { attributed: 2 } }); // the next day of the same room
    expect(await R.readWindowTurns("nope")).toMatchObject({ ok: false, reason: "not_found" });
  });
  it("window_english: success sources only, text only on request, blind refused; emotion: scored spans only; stubs answer not_implemented", async () => {
    const R = await import("@/lib/rubrics/readers");
    const a = await R.readWindowEnglish("w1");
    expect(a).toMatchObject({ ok: true, data: { source: "run_english", char_count: 18, english: null } });
    expect((await R.readWindowEnglish("w1", { includeText: true }) as { data: { english: string } }).data.english).toBe("English text of w1");
    expect(await R.readWindowEnglish("w2")).toMatchObject({ ok: false, reason: "no_data" });
    statements.length = 0;
    expect(await R.readWindowEnglish("w3")).toMatchObject({ ok: false, reason: "blind_room_day" });
    expect(statements.some((q) => /jev_window_text/.test(q.text))).toBe(false);
    expect(await R.readWindowEnglish("w4")).toMatchObject({ ok: true });
    const e = await R.readWindowEmotion("w1");
    expect(e.ok && e.data.spans).toHaveLength(1);
    expect(e.ok && e.data.spans[0]).toMatchObject({ speaker_idx: 0, top_label: "happiness", scores: { happiness: 0.3 } });
    statements.length = 0;
    expect(await R.readWindowEmotion("w3")).toMatchObject({ ok: false, reason: "blind_room_day" });
    expect(statements.some((q) => /room_span_emotion/.test(q.text))).toBe(false);
    expect(await R.readPulseRecord("x")).toMatchObject({ ok: false, reason: "not_found" }); // S7-2: a real reader; unknown consult
  });
  it("consult_span: the open and close, the overlapping windows with absolute times; an open consult and a blind day are refused", async () => {
    const R = await import("@/lib/rubrics/readers");
    const c = await R.readConsultSpan("enc1@m1");
    expect(c.ok && c.data).toMatchObject({ room_id: "r1", ist_date: "2026-10-08", t_close_ms: Date.parse(IST("10:00:30")) });
    expect(c.ok && c.data.windows).toEqual([{ window_id: "w1", abs_start_ms: Date.parse(IST("10:00:00")), abs_end_ms: Date.parse(IST("10:01:00")) }]);
    expect(await R.readConsultSpan("enc2@m1")).toMatchObject({ ok: false, reason: "no_data" });
    statements.length = 0;
    expect(await R.readConsultSpan("enc3@m2")).toMatchObject({ ok: false, reason: "blind_room_day" });
    expect(statements.some((q) => /bench_window/.test(q.text))).toBe(false); // the windows were never looked up
    expect(await R.readConsultSpan("enc4@m2")).toMatchObject({ ok: true, data: { room_id: "room_qyzghzaf", ist_date: "2026-08-24" } });
    expect(await R.readConsultSpan("nope")).toMatchObject({ ok: false, reason: "not_found" });
    expect(await R.listConsultKeys({ from: "2026-10-08", to: "2026-10-08", limit: 10 })).toEqual({ keys: ["enc1@m1"], truncated: false, blind_excluded: 0 });
    expect(await R.listConsultKeys({ from: "2026-08-23", to: "2026-08-24", limit: 10 })).toEqual({ keys: ["enc4@m2"], truncated: false, blind_excluded: 1 });
  });
});

describe.runIf(HAVE)("rubric_run and rubric_bench through the real runner", () => {
  const mem = new Map<string, string>();
  beforeAll(async () => {
    const L = await import("@/lib/sarvam-lab");
    L.setLabStoreForTests({
      get: async (k) => (mem.has(k) ? { body: mem.get(k)!, etag: "e" } : null),
      put: async (k, b) => { mem.set(k, b); return "ok"; },
      list: async (p) => [...mem.keys()].filter((k) => k.startsWith(p)),
    });
    vi.spyOn(console, "error").mockImplementation(() => undefined);
  });
  beforeEach(() => { mem.clear(); pg.exec(`DELETE FROM scribe_job; DELETE FROM rubric_result; DELETE FROM rubric_run;`); });

  async function runJob(kind: string, rawArgs: Record<string, unknown>): Promise<{ job: Record<string, any>; steps: string[] }> {
    const { KIND_BY_NAME } = await import("@/lib/jobs/kinds");
    const { claimJobs } = await import("@/lib/jobs/store");
    const { runOneStep } = await import("@/lib/jobs/runner");
    const args = KIND_BY_NAME.get(kind)!.parseArgs(rawArgs);
    const id = `job_${kind}_${Math.random().toString(36).slice(2, 8)}`;
    await pg.sql`INSERT INTO scribe_job (id, kind, args, actor) VALUES (${id}, ${kind}, ${JSON.stringify(args)}::jsonb, 'mcp:tester')`;
    const steps: string[] = [];
    for (let i = 0; i < 20; i++) {
      const [job] = await claimJobs(1, 240_000, `runner-${i}`);
      if (!job) break;
      steps.push(String(job.step ?? KIND_BY_NAME.get(kind)!.first));
      await runOneStep(job, `runner-${i}`);
    }
    const j = (await pg.sql`SELECT id, status, step, progress, result, error FROM scribe_job WHERE id = ${id}`)[0] as Record<string, any>;
    return { job: j, steps };
  }

  it("rubric_run on room_mic_quality (a draft: lab:true + explicit units): results in Neon with the right numbers, evidence in R2, a skipped unit with its reason, the run row closed", async () => {
    const { job, steps } = await runJob("rubric_run", { rubric_id: "room_mic_quality", lab: true, unit_keys: ["r1:2026-10-08:10", "r1:2026-10-08:11", "room_qyzghzaf:2026-08-24:10", "r1:2026-10-08:03", "room_qyzghzaf:2026-08-23:10"] });
    expect(job).toMatchObject({ status: "done", result: { rubric_id: "room_mic_quality", version: "0.1.0", units_planned: 5, ok: 3, failed: 0, skipped: 2, blind_room_days: 1 } });
    expect(steps).toEqual(["resolve", "evaluate", "finish"]);
    const rows = (await pg.sql`SELECT unit_key, status, score, findings, lab, room_id, ist_date::text AS d FROM rubric_result ORDER BY unit_key`) as Array<Record<string, any>>;
    const by = Object.fromEntries(rows.map((r) => [r.unit_key, r]));
    expect(by["r1:2026-10-08:10"]).toMatchObject({ status: "ok", lab: true, room_id: "r1", d: "2026-10-08", findings: ["muted", "clipping"], score: { recorded_min: 50, muted_min: 10, speech_min: 50 } });
    expect(by["r1:2026-10-08:11"].findings).toEqual(["low_recording", "off", "no_speech"]);
    expect(by["room_qyzghzaf:2026-08-24:10"].findings).toEqual(["low_recording", "dead"]); // the NEXT day of the held-out room is scored
    expect(by["room_qyzghzaf:2026-08-23:10"]).toBeUndefined(); // the held-out pair: no row, no evidence
    expect([...mem.keys()].some((k) => k.includes("2026-08-23"))).toBe(false);
    expect(by["r1:2026-10-08:03"]).toMatchObject({ status: "skipped", score: { reason: "no_audio_state" } });
    const ev = JSON.parse(mem.get("rubric/room_mic_quality/0.1.0/r1:2026-10-08:10.json")!);
    expect(ev).toMatchObject({ rubric_id: "room_mic_quality", unit_key: "r1:2026-10-08:10", lab: true, status: "ok", score: { recorded_min: 50 } });
    expect(by["r1:2026-10-08:10"].score.evidence_key).toBe("rubric/room_mic_quality/0.1.0/r1:2026-10-08:10.json");
    expect(mem.has("rubric/room_mic_quality/0.1.0/r1:2026-10-08:03.json")).toBe(false); // a skipped unit has no evidence
    const run = (await pg.sql`SELECT kind, units_planned, units_ok, units_failed, finished_at FROM rubric_run`)[0] as Record<string, any>;
    expect(run).toMatchObject({ kind: "run", units_planned: 5, units_ok: 3, units_failed: 0 });
    expect(run.finished_at).not.toBeNull();
    // a rerun REPLACES the result (unique key), it does not add a row
    await runJob("rubric_run", { rubric_id: "room_mic_quality", lab: true, unit_keys: ["r1:2026-10-08:10"] });
    expect(((await pg.sql`SELECT count(*)::int AS n FROM rubric_result WHERE unit_key = 'r1:2026-10-08:10'`)[0] as { n: number }).n).toBe(1);
    // no transcript text anywhere in the tables
    expect(JSON.stringify(await pg.sql`SELECT * FROM rubric_result`)).not.toMatch(/alpha|bravo|charlie/);
  });

  it("rubric_run on talk_time windows: the numbers from the fixture, blind room-day and missing diarization skipped with their reasons, never failed", async () => {
    const { job } = await runJob("rubric_run", { rubric_id: "talk_time", lab: true, unit: "window", unit_keys: ["w1", "w2", "w3", "w4", "nope"] });
    expect(job).toMatchObject({ status: "done", result: { ok: 2, failed: 0, skipped: 3, blind_room_days: 1 } });
    const rows = (await pg.sql`SELECT unit_key, status, score, room_id FROM rubric_result ORDER BY unit_key`) as Array<Record<string, any>>;
    const by = Object.fromEntries(rows.map((r) => [r.unit_key, r]));
    expect(by.w1).toMatchObject({ status: "ok", room_id: "r1", score: { doctor_talk_ms: 20000, other_talk_ms: 12000, doctor_share: 0.625, interruptions: 1, overlap_ms: 2000, longest_monologue_ms: 12000, speakers: 2 } });
    expect(by.w2.score.reason).toBe("no_diarization"); // w2 has a turn cue but no room_turn_speaker row: nobody attributed
    expect(by.w3).toBeUndefined(); // held-out: nothing written
    expect(by.w4).toMatchObject({ status: "ok", room_id: "room_qyzghzaf", score: { doctor_talk_ms: 5000, other_talk_ms: 3000 } });
    expect(by.nope).toBeUndefined(); // no such window: its room and date are unknown, so NO row is written (counted as unresolved)
    expect(job.result.unresolved).toBe(1);
  });

  it("rubric_run on talk_time consults: the turns of the overlapping windows clipped to the span; a blind consult is skipped", async () => {
    const { job } = await runJob("rubric_run", { rubric_id: "talk_time", lab: true, unit: "consult", unit_keys: ["enc1@m1", "enc3@m2", "enc2@m1"] });
    expect(job).toMatchObject({ status: "done", result: { ok: 1, skipped: 2, blind_room_days: 1 } });
    const r = (await pg.sql`SELECT unit_key, status, score FROM rubric_result WHERE unit_key = 'enc1@m1'`)[0] as Record<string, any>;
    expect(r).toMatchObject({ status: "ok", score: { span_ms: 30000, doctor_talk_ms: 15000, other_talk_ms: 12000, interruptions: 1 } });
    expect(await pg.sql`SELECT 1 FROM rubric_result WHERE unit_key = 'enc3@m2'`).toEqual([]);
  });

  it("the WRITERS refuse the held-out set too: upsertResult and writeEvidence throw blind_room_day before any statement or put, by columns or by a room-hour key", async () => {
    const St = await import("@/lib/rubrics/store");
    const { BlindRoomDayError } = await import("@/lib/rubrics/blind-room-days");
    const base = { rubric_id: "room_mic_quality", version: "0.1.0", unit_kind: "room_hour", run_id: "rub_x", status: "ok" as const, score: { a: 1 }, findings: [], lab: true };
    statements.length = 0;
    await expect(St.upsertResult({ ...base, unit_key: "k", room_id: "room_ux92qpws", ist_date: "2026-09-13" })).rejects.toThrow(BlindRoomDayError);
    await expect(St.upsertResult({ ...base, unit_key: "room_ux92qpws:2026-09-13:10", room_id: null, ist_date: null })).rejects.toThrow(BlindRoomDayError); // the pair is in the key
    await expect(St.writeEvidence("room_mic_quality", "0.1.0", "k", {}, { room_id: "room_ux92qpws", ist_date: "2026-09-13" })).rejects.toThrow(BlindRoomDayError);
    await expect(St.writeEvidence("room_mic_quality", "0.1.0", "room_ux92qpws:2026-09-13:10", {})).rejects.toThrow(BlindRoomDayError);
    expect(statements).toEqual([]);
    expect(mem.size).toBe(0);
    await pg.sql`INSERT INTO rubric_run (run_id, rubric_id, version, kind) VALUES ('rub_x', 'room_mic_quality', '0.1.0', 'run')`;
    await St.upsertResult({ ...base, unit_key: "room_ux92qpws:2026-09-12:10", room_id: "room_ux92qpws", ist_date: "2026-09-12" }); // the day before: fine
    expect(((await pg.sql`SELECT count(*)::int AS n FROM rubric_result`)[0] as { n: number }).n).toBe(1);
  });

  it("G56 — the consult frame is ABSOLUTE epoch ms: the covering window is found although its session began two hours earlier; a session-relative frame would find none (this test fails if it comes back)", async () => {
    const R = await import("@/lib/rubrics/readers");
    const c = await R.readConsultSpan("enc1@m1");
    expect(c.ok && c.data.windows.map((w) => w.window_id)).toEqual(["w1"]);
    expect(c.ok && c.data.windows[0]).toEqual({ window_id: "w1", abs_start_ms: W1, abs_end_ms: W1 + 60000 });
    // what the WRONG frame (session started_at + window ms) would have computed for the same row: a window 55 years in the future, overlapping nothing
    const wrong = (await pg.sql`SELECT extract(epoch FROM s.started_at)::float8 * 1000 + w.start_ms AS rel FROM bench_window w JOIN bench_session s ON s.id = w.session_id WHERE w.id = 'w1'`)[0] as { rel: number };
    expect(wrong.rel).toBeGreaterThan(W1 + 1e12);
    // the engine uses the cue times as they are (absolute): doctor talk of the consult comes out right with no offset
    const { job } = await runJob("rubric_run", { rubric_id: "talk_time", lab: true, unit: "consult", unit_keys: ["enc1@m1"] });
    expect(job.result.ok).toBe(1);
    expect(((await pg.sql`SELECT score FROM rubric_result WHERE unit_key = 'enc1@m1'`)[0] as { score: Row }).score).toMatchObject({ doctor_talk_ms: 15000, other_talk_ms: 12000 });
  });

  it("G53 — a failing guard query for a window THROWS: the job is retried and ends failed, ZERO rubric_result rows, no evidence; a transient failure is retried and the unit is then written once", async () => {
    const real = H.sql!;
    // (a) the room-day metadata join fails every time
    H.sql = (async (strs: TemplateStringsArray, ...v: unknown[]) => { if (/LEFT JOIN room_day rd ON rd.id = w.room_day_id/.test(strs.join("?"))) throw new Error("db down"); return real(strs, ...v); }) as never;
    const dead = await runJob("rubric_run", { rubric_id: "talk_time", lab: true, unit: "window", unit_keys: ["w3"] });
    H.sql = real;
    expect(dead.job.status).toBe("failed");
    expect(String(dead.job.error)).toMatch(/^failures_exceeded|^step_threw/);
    expect(await pg.sql`SELECT 1 FROM rubric_result`).toEqual([]);
    expect(mem.size).toBe(0);
    // (b) it fails ONCE (a blip): the step is retried and the unit comes out right, one row
    let blipped = false;
    H.sql = (async (strs: TemplateStringsArray, ...v: unknown[]) => { if (!blipped && /LEFT JOIN room_day rd ON rd.id = w.room_day_id/.test(strs.join("?"))) { blipped = true; throw new Error("blip"); } return real(strs, ...v); }) as never;
    const ok = await runJob("rubric_run", { rubric_id: "talk_time", lab: true, unit: "window", unit_keys: ["w1"] });
    H.sql = real;
    expect(blipped).toBe(true);
    expect(ok.job).toMatchObject({ status: "done", result: { ok: 1, failed: 0 } });
    expect(((await pg.sql`SELECT count(*)::int AS n FROM rubric_result WHERE unit_key = 'w1'`)[0] as { n: number }).n).toBe(1);
  });

  it("G53 — a failing READ (the turns query) is a thrown error too, never a stored failed / engine_error row", async () => {
    const real = H.sql!;
    H.sql = (async (strs: TemplateStringsArray, ...v: unknown[]) => { if (/FROM cue c LEFT JOIN room_turn_speaker/.test(strs.join("?"))) throw new Error("db down"); return real(strs, ...v); }) as never;
    const dead = await runJob("rubric_run", { rubric_id: "talk_time", lab: true, unit: "window", unit_keys: ["w1"] });
    H.sql = real;
    expect(dead.job.status).toBe("failed");
    expect(await pg.sql`SELECT 1 FROM rubric_result`).toEqual([]);
  });

  it("G52 — the talk_time window listing excludes held-out windows in the query and reports blind_excluded", async () => {
    const { resolveUnits } = await import("@/lib/rubrics/engines");
    const { getRubric } = await import("@/lib/rubrics/registry");
    const plan = await resolveUnits(getRubric("talk_time")!, "window", { rooms: ["room_qyzghzaf"], from: "2026-08-23", to: "2026-08-24", limit: 10 });
    expect(plan).toEqual({ keys: ["w4"], truncated: false, blind_excluded: 1 });
    const wide = await resolveUnits(getRubric("talk_time")!, "window", { from: "2026-08-23", to: "2026-09-22", limit: 10 }); // no room filter: every room, 31 days
    expect(wide).toMatchObject({ keys: ["w4"], blind_excluded: 1 });
    expect(await resolveUnits(getRubric("talk_time")!, "window", { rooms: ["room_qyzghzaf"], from: "2026-08-23", to: "2026-08-24", limit: 1 })).toEqual({ keys: ["w4"], truncated: false, blind_excluded: 1 }); // the limit counts real units only
  });

  it("G55 mirror — the fixture table carries the real 0085 CHECKs: a clinician row needs an id and a confidence, an identity needs the claim, a role-less row needs a reason", () => {
    const fails = (q: string) => { try { pg.exec(q); return ""; } catch (e) { return String((e as { stderr?: unknown }).stderr ?? e); } };
    const ins = (cols: string, vals: string) => `INSERT INTO room_turn_speaker (window_id, source_ref, speaker_idx, ${cols}) VALUES ('wx', 'wx:' || md5(random()::text), 0, ${vals});`;
    expect(fails(ins("role, no_role_reason", "'clinician', NULL"))).toMatch(/clinician_ck/);
    expect(fails(ins("clinician_id, match_confidence, no_role_reason", "'c', 0.5, 'no_match'"))).toMatch(/identity_ck/);
    expect(fails(ins("role, no_role_reason", "NULL, NULL"))).toMatch(/no_role_ck/);
    expect(fails(ins("role, clinician_id, match_confidence, no_role_reason", "'clinician', 'c', 1.5, NULL"))).toMatch(/confidence_ck/);
    expect(fails(ins("role, clinician_id, match_confidence, no_role_reason", "'clinician', 'c', 0.5, NULL"))).toBe("");
    pg.exec(`DELETE FROM room_turn_speaker WHERE window_id = 'wx';`);
  });

  it("the refusals are made at SUBMIT (parseArgs), so nothing is queued: lab_required, explicit_units_required, engine_not_available, unit_not_supported, unknown_rubric", async () => {
    const { KIND_BY_NAME } = await import("@/lib/jobs/kinds");
    const p = KIND_BY_NAME.get("rubric_run")!.parseArgs;
    expect(() => p({ rubric_id: "talk_time" })).toThrow(/^lab_required/);
    expect(() => p({ rubric_id: "talk_time", lab: true })).toThrow(/^explicit_units_required/);
    expect(() => p({ rubric_id: "care_sentiment", lab: true, unit_keys: ["x"] })).toThrow(/^engine_not_available/);
    expect(() => p({ rubric_id: "talk_time", lab: true, unit: "room_hour", unit_keys: ["x"] })).toThrow(/^unit_not_supported/);
    expect(() => p({ rubric_id: "nope", lab: true })).toThrow(/^unknown_rubric/);
    expect(() => p({ rubric_id: "talk_time", lab: true, unit_keys: ["x"], surprise: 1 })).toThrow(/bad args/);
  });

  it("rubric_bench: scores the rubric against its labelled set (a set in the lab store), writes the report to R2 and a rubric_run kind bench, writes NO rubric_result; pass and fail", async () => {
    mem.set("rubric/room_mic_quality/0.1.0/bench.json", JSON.stringify({ unit: "room_hour", items: [
      { unit_key: "r1:2026-10-08:10", expected: { recorded_min: 50, muted_min: 10, flags: ["muted", "clipping"] } },
      { unit_key: "r1:2026-10-08:11", expected: { recorded_min: 30, off_min: 30, flags: ["low_recording", "off", "no_speech"] } },
    ] }));
    const pass = await runJob("rubric_bench", { rubric_id: "room_mic_quality" });
    expect(pass.job).toMatchObject({ status: "done", result: { metric: "field_accuracy", value: 1, threshold: 0.9, passed: true, items: 2, fields: 6, unscored: 0, status_at_run: "draft" } });
    const report = JSON.parse(mem.get(pass.job.result.report_key)!);
    expect(report).toMatchObject({ passed: true, items: 2, per_field: { recorded_min: { n: 2, equal: 2 } } });
    expect(((await pg.sql`SELECT count(*)::int AS n FROM rubric_result`)[0] as { n: number }).n).toBe(0);
    expect(await pg.sql`SELECT kind, units_planned FROM rubric_run`).toEqual([{ kind: "bench", units_planned: 2 }]);
    mem.set("rubric/room_mic_quality/0.1.0/bench.json", JSON.stringify({ unit: "room_hour", items: [
      { unit_key: "r1:2026-10-08:10", expected: { recorded_min: 40, flags: ["muted"] } },
      { unit_key: "r1:2026-10-08:03", expected: { recorded_min: 10 } },
    ] }));
    const fail = await runJob("rubric_bench", { rubric_id: "room_mic_quality" });
    expect(fail.job.result).toMatchObject({ passed: false, unscored: 1, items: 2 });
    expect(fail.job.result.value).toBeLessThan(0.9);
  });

  it("rubric_bench with no bench set fails by code (bench_set_missing); a metric a code engine cannot score fails by code", async () => {
    const miss = await runJob("rubric_bench", { rubric_id: "room_mic_quality" });
    expect(miss.job.status).toBe("failed");
    expect(String(miss.job.error)).toMatch(/^bench_set_missing/);
    const { getRubric } = await import("@/lib/rubrics/registry");
    expect(getRubric("talk_time")!.bench.metric).toBe("field_accuracy");
  });

  it("our G65 on real SQL — rows planted by direct INSERT with a NULL room or a NULL date (and a blind pair) are not listed and their evidence is not fetched", async () => {
    const S = await import("@/lib/rubrics/store");
    await pg.sql`INSERT INTO rubric_run (run_id, rubric_id, version, kind, units_planned) VALUES ('rub_null', 'talk_time', '0.1.0', 'run', 3) ON CONFLICT DO NOTHING`;
    await pg.sql`INSERT INTO rubric_result (rubric_id, version, unit_kind, unit_key, room_id, ist_date, run_id, status, score, findings, lab) VALUES
      ('talk_time','0.1.0','window','n_room_only','room_qyzghzaf',NULL,'rub_null','ok','{"evidence_key":"rubric/talk_time/0.1.0/n_room_only.json"}','[]',true),
      ('talk_time','0.1.0','window','n_nopair',NULL,NULL,'rub_null','ok','{"evidence_key":"rubric/talk_time/0.1.0/n_nopair.json"}','[]',true),
      ('talk_time','0.1.0','window','n_ok','r1','2026-10-08','rub_null','ok','{"evidence_key":"rubric/talk_time/0.1.0/n_ok.json"}','[]',true)`;
    const rows = await S.listResults({ rubric_id: "talk_time", limit: 50 });
    expect(rows.map((r) => r.unit_key)).toEqual(["n_ok"]);
  });

  it("S7-1 consult_text: the speaker lines of a consult from the turns of its windows (t from the open, doctor / other / unknown), blind refused before any text query; llm rubric_run + rubric_bench through the real runner with a fake model", async () => {
    const R = await import("@/lib/rubrics/readers");
    const LLM = await import("@/lib/rubrics/llm");
    const t = await R.readConsultText("enc1@m1");
    expect(t.ok && t.data.source).toBe("database");
    expect(t.ok && t.data.lines.map((l) => [l.t_ms, l.speaker, l.text])).toEqual([[0, "doctor", "alpha"], [8000, "other", "bravo"], [25000, "doctor", "charlie"]]); // delta (40 s) is after the close; the unknown turn would read "unknown"
    statements.length = 0;
    expect(await R.readConsultText("enc3@m2")).toMatchObject({ ok: false, reason: "blind_room_day" });
    expect(statements.some((q) => /cue|jev_window_text/.test(q.text))).toBe(false);
    expect(await R.readConsultText("enc2@m1")).toMatchObject({ ok: false }); // open consult
    expect(await R.readConsultText("nope")).toMatchObject({ ok: false, reason: "not_found" });

    const good = { scorable: true, distress: "low", confusion: "low", frustration: "low", reassurance: "medium", teach_back: "none", recommendations: [{ uptake: ["accept"], resolution_type: "patient_agrees", quote: "charlie" }],
      cases_lite: { engagement_process: "present", information_present: true, doctor_effect_proxy: "load_eased", dominant_mix: "mixed" }, evidence: [{ item: "distress", quote: "bravo" }] };
    let calls = 0;
    LLM.setRubricChatForTests(async () => { calls++; return { content: JSON.stringify(good), model: "fake/model", latency_ms: 1 }; });
    try {
      const run = await runJob("rubric_run", { rubric_id: "consult_chair_affect", lab: true, unit_keys: ["enc1@m1", "enc3@m2", "nope"] });
      expect(run.job).toMatchObject({ status: "done", result: { rubric_id: "consult_chair_affect", version: "1.1.0", ok: 1, skipped: 2, blind_room_days: 1 } });
      expect(calls).toBe(1); // the blind consult and the unknown key never reached the model
      const rows = (await pg.sql`SELECT unit_key, status, score, findings, lab FROM rubric_result ORDER BY unit_key`) as Array<Record<string, any>>;
      expect(rows.map((r) => r.unit_key)).toEqual(["enc1@m1"]); // no row without a room and date; none for the blind day
      expect(rows[0]).toMatchObject({ status: "ok", lab: true, score: { distress: "low", uptake_codes: ["accept"] } });
      expect(JSON.stringify(rows)).not.toMatch(/alpha|bravo|charlie/); // no transcript text in the table
      const evKey = `rubric/consult_chair_affect/1.1.0/${"enc1@m1"}.json`; // (built, so no literal reads as an email address)
      expect(JSON.parse(mem.get(evKey)!).quotes ?? JSON.parse(mem.get(evKey)!).evidence.quotes.length).toBeTruthy();
      expect([...mem.keys()].some((k) => k.includes("enc3"))).toBe(false);

      // bench: gold from the lab store (JSONL), Meet text from the lab store, no rubric_result rows
      mem.set("rubric/bench/consult_chair_affect/gold.jsonl", [{ unit_key: "m001", expected: { distress: "low", uptake_codes: ["accept"] } }, { unit_key: "m002", expected: { distress: "high" } }].map((x) => JSON.stringify(x)).join("\n") + "\n");
      for (const k of ["m001", "m002"]) mem.set(`rubric/bench/consult_chair_affect/text/${k}.json`, JSON.stringify({ lines: [{ t_s: 3, speaker: "doctor", text: "hello" }, { t_s: 9, speaker: "patient", text: "okay" }, { t_s: 20, speaker: "doctor", text: "charlie" }] }));
      await pg.sql`DELETE FROM rubric_result`;
      const b = await runJob("rubric_bench", { rubric_id: "consult_chair_affect" });
      expect(b.job).toMatchObject({ status: "done", result: { metric: "field_accuracy", items: 2, fields: 3, passed: false } });
      expect(b.job.result.value).toBeCloseTo(0.667, 2);
      expect(JSON.parse(mem.get(b.job.result.report_key)!).population).toMatch(/Meet teleconsult.*no room tape/);
      expect(((await pg.sql`SELECT count(*)::int AS n FROM rubric_result`)[0] as { n: number }).n).toBe(0);
      // a model outage mid-run THROWS: the step is retried, nothing is stored as a failed unit
      LLM.setRubricChatForTests(async () => { throw new (await import("@/lib/openrouter")).OpenRouterError("openrouter_http_503"); });
      const down = await runJob("rubric_run", { rubric_id: "consult_chair_affect", lab: true, unit_keys: ["enc1@m1"] });
      expect(down.job.status).not.toBe("done");
      expect(((await pg.sql`SELECT count(*)::int AS n FROM rubric_result WHERE status = 'failed'`)[0] as { n: number }).n).toBe(0);
    } finally {
      LLM.setRubricChatForTests(null);
    }
  });

  it("S71-AB/C — rubric_bench by set: grokbot_agreement is reported as agreement_with_grokbot (no accuracy, no pass line, human_gold false); human_v as accuracy_vs_V with n stated; the default set is unchanged", async () => {
    const LLM = await import("@/lib/rubrics/llm");
    const good = { surgery_recommended: true, recommendation_kind: "surgery", pitch_source: "own", pitch_balance: { benefits_named: true, risks_named: true, alternatives_named: true, timing_named: true }, uptake_of_surgery: "accept", evidence: [] };
    LLM.setRubricChatForTests(async () => ({ content: JSON.stringify(good), model: "fake/model", latency_ms: 1 }));
    try {
      const gold = (rows: unknown[]) => rows.map((x) => JSON.stringify(x)).join("\n") + "\n";
      mem.set("rubric/bench/consult_surgical_pitch/grokbot_agreement.jsonl", gold([{ unit_key: "g1", provenance: "model_grokbot", human_gold: false, expected: { surgery_recommended: true } }, { unit_key: "g2", expected: { surgery_recommended: false } }]));
      for (const k of ["g1", "g2", "enc1@m1"]) mem.set(`rubric/bench/consult_surgical_pitch/text/${k}.json`, JSON.stringify({ lines: [{ t_s: 3, speaker: "doctor", text: "hello" }, { t_s: 9, speaker: "patient", text: "okay" }] }));
      const ag = await runJob("rubric_bench", { rubric_id: "consult_surgical_pitch", set: "grokbot_agreement" });
      expect(ag.job).toMatchObject({ status: "done", result: { set: "grokbot_agreement", metric: "agreement_with_grokbot", passed: null, threshold: null, n: 2 } });
      const rep = JSON.parse(mem.get(ag.job.result.report_key)!);
      expect(rep).toMatchObject({ set: "grokbot_agreement", metric: "agreement_with_grokbot", human_gold: false, provenance: "model_grokbot" });
      expect(rep.metrics.accuracy).toBeUndefined();
      expect(rep.metrics.agreement).toBeCloseTo(0.5, 2);
      mem.set("rubric/bench/consult_surgical_pitch/human_v.jsonl", gold([{ unit_key: "enc1@m1", human_gold: true, rater: "V", expected: { surgery_recommended: true, recommendation_kind: "surgery" } }]));
      const hv = await runJob("rubric_bench", { rubric_id: "consult_surgical_pitch", set: "human_v" });
      expect(hv.job).toMatchObject({ status: "done", result: { set: "human_v", metric: "accuracy_vs_V", n: 1, passed: null } });
      const rep2 = JSON.parse(mem.get(hv.job.result.report_key)!);
      expect(rep2).toMatchObject({ metric: "accuracy_vs_V", human_gold: true, rater: "V", n: 1 });
      expect(rep2.metrics.agreement).toBeUndefined();
      expect(rep2.metrics.accuracy_vs_V).toBe(1);
      // an unknown set is refused at submit
      const { KIND_BY_NAME } = await import("@/lib/jobs/kinds");
      expect(() => KIND_BY_NAME.get("rubric_bench")!.parseArgs({ rubric_id: "consult_surgical_pitch", set: "nope" })).toThrow();
    } finally {
      LLM.setRubricChatForTests(null);
    }
  });

  it("S71-C2 — rubric_bench human_v on EXCERPTS: text from the lab store only (no consult / room-day query), reported as accuracy_vs_V on excerpts (n=..) with the partial-consult note; the excerpt prompt says it is an excerpt; a mixed set is refused", async () => {
    const LLM = await import("@/lib/rubrics/llm");
    const seen: string[] = [];
    LLM.setRubricChatForTests(async (a) => {
      seen.push(String((a as { user?: string }).user));
      const anti = /No-op/.test(String((a as { user?: string }).user)) ? { surgery_recommended: false, recommendation_kind: "no_surgery" } : { surgery_recommended: true, recommendation_kind: "surgery", pitch_source: "own", pitch_balance: { benefits_named: true, risks_named: false, alternatives_named: false, timing_named: false }, uptake_of_surgery: "accept", evidence: [] };
      return { content: JSON.stringify(anti), model: "fake/model", latency_ms: 1 };
    });
    try {
      const jl = (rows: unknown[]) => rows.map((x) => JSON.stringify(x)).join("\n") + "\n";
      mem.set("rubric/bench/consult_surgical_pitch/human_v.jsonl", jl([
        { unit_key: "hv-a", unit_kind: "excerpt", room_id: "r1", ist_date: "2026-10-08", expected: { surgery_recommended: true, recommendation_kind: "surgery" } },
        { unit_key: "hv-b", unit_kind: "excerpt", room_id: "r1", ist_date: "2026-10-08", expected: { surgery_recommended: false, recommendation_kind: "no_surgery" } },
        { unit_key: "hv-c", unit_kind: "excerpt", room_id: "r1", ist_date: "2026-10-08", expected: { surgery_recommended: false } },
      ]));
      mem.set("rubric/bench/consult_surgical_pitch/text/hv-a.json", JSON.stringify({ lines: [{ t_s: 0, speaker: "unknown", text: "He advised for surgery." }] }));
      mem.set("rubric/bench/consult_surgical_pitch/text/hv-b.json", JSON.stringify({ lines: [{ t_s: 0, speaker: "unknown", text: "No-op needed, just medicines." }] }));
      mem.set("rubric/bench/consult_surgical_pitch/text/hv-c.json", JSON.stringify({ lines: [{ t_s: 0, speaker: "unknown", text: "No-op, only tablets." }] }));
      statements.length = 0;
      const b = await runJob("rubric_bench", { rubric_id: "consult_surgical_pitch", set: "human_v" });
      expect(b.job).toMatchObject({ status: "done", result: { set: "human_v", metric: "accuracy_vs_V_on_excerpts", n: 3, passed: null } });
      expect(statements.some((q) => /eta_encounter_windows|bench_window|room_day|cue/.test(q.text.replace(/scribe_job|rubric_run|rubric_result/g, "")) && !/scribe_job/.test(q.text))).toBe(false);
      const rep = JSON.parse(mem.get(b.job.result.report_key)!);
      expect(rep).toMatchObject({ metric: "accuracy_vs_V_on_excerpts", label: "accuracy_vs_V on excerpts (n=3)", human_gold: true, rater: "V", n: 3 });
      expect(rep.note).toMatch(/partial consults/);
      expect(rep.population).toMatch(/excerpts/);
      expect(rep.metrics.accuracy_vs_V_on_excerpts).toBeGreaterThan(0.5); // hv-a, hv-b right; hv-c: anti-pitch kind is not in its expected fields
      expect(seen.every((u) => /EXCERPT of a consultation/.test(u))).toBe(true);
      expect(((await pg.sql`SELECT count(*)::int AS n FROM rubric_result`)[0] as { n: number }).n).toBe(0);
      // an excerpt unit is never run outside a bench, and a mixed set is not a set
      mem.set("rubric/bench/consult_surgical_pitch/human_v.jsonl", jl([{ unit_key: "hv-a", unit_kind: "excerpt", room_id: "r1", ist_date: "2026-10-08", expected: { surgery_recommended: true } }, { unit_key: "enc1@m1", unit_kind: "consult", expected: { surgery_recommended: true } }]));
      const bad = await runJob("rubric_bench", { rubric_id: "consult_surgical_pitch", set: "human_v" });
      expect(bad.job.status).toBe("failed");
      expect(String(bad.job.error)).toMatch(/^bench_set_missing/);
    } finally {
      LLM.setRubricChatForTests(null);
    }
  });

  it("S71-E G68 — excerpt units are accepted only from set human_v: gold and grokbot_agreement naming excerpts are refused as no set (bench_set_missing), 0 model calls", async () => {
    const LLM = await import("@/lib/rubrics/llm");
    let calls = 0;
    LLM.setRubricChatForTests(async () => { calls++; return { content: JSON.stringify({ surgery_recommended: false }), model: "fake/model", latency_ms: 1 }; });
    try {
      const rows = [{ unit_key: "hv-a", unit_kind: "excerpt", room_id: "r1", ist_date: "2026-10-08", expected: { surgery_recommended: false } }].map((x) => JSON.stringify(x)).join("\n") + "\n";
      mem.set("rubric/bench/consult_surgical_pitch/text/hv-a.json", JSON.stringify({ lines: [{ t_s: 0, speaker: "unknown", text: "No-op needed." }] }));
      for (const set of ["gold", "grokbot_agreement"] as const) {
        mem.set(`rubric/bench/consult_surgical_pitch/${set === "gold" ? "gold" : set}.jsonl`, rows);
        const r = await runJob("rubric_bench", set === "gold" ? { rubric_id: "consult_surgical_pitch" } : { rubric_id: "consult_surgical_pitch", set });
        expect(r.job.status, set).toBe("failed");
        expect(String(r.job.error), set).toMatch(/^bench_set_missing/);
      }
      expect(calls).toBe(0);
      mem.set("rubric/bench/consult_surgical_pitch/human_v.jsonl", rows);
      const ok = await runJob("rubric_bench", { rubric_id: "consult_surgical_pitch", set: "human_v" });
      expect(ok.job).toMatchObject({ status: "done", result: { metric: "accuracy_vs_V_on_excerpts", n: 1 } });
      expect(calls).toBe(1);
    } finally {
      LLM.setRubricChatForTests(null);
    }
  });

  it("S71-R4 G71 — a running llm job STOPS at the ceiling: the remaining items are unscored (reason llm_cap), no further model call", async () => {
    const LLM = await import("@/lib/rubrics/llm");
    let calls = 0;
    LLM.setRubricChatForTests(async () => { calls++; return { content: JSON.stringify({ surgery_recommended: false }), model: "fake/model", latency_ms: 1 }; });
    const saved = process.env.RUBRIC_LLM_JOB_CALL_CAP;
    process.env.RUBRIC_LLM_JOB_CALL_CAP = "2";
    try {
      const rows = ["g1", "g2", "g3", "g4"].map((k) => JSON.stringify({ unit_key: k, expected: { surgery_recommended: false } })).join("\n") + "\n";
      mem.set("rubric/bench/consult_surgical_pitch/gold.jsonl", rows);
      for (const k of ["g1", "g2", "g3", "g4"]) mem.set(`rubric/bench/consult_surgical_pitch/text/${k}.json`, JSON.stringify({ lines: [{ t_s: 1, speaker: "doctor", text: "hello" }] }));
      // planned (4) exceeds the per-job ceiling (2) at SUBMIT in the tool path; here the job is inserted directly, as an already-queued job, to exercise the mid-run stop
      const b = await runJob("rubric_bench", { rubric_id: "consult_surgical_pitch" });
      expect(b.job).toMatchObject({ status: "done", result: { items: 4, llm_calls: 2, skipped_llm_cap: 2, unscored: 2 } });
      expect(calls).toBe(2);
    } finally {
      if (saved === undefined) delete process.env.RUBRIC_LLM_JOB_CALL_CAP; else process.env.RUBRIC_LLM_JOB_CALL_CAP = saved;
      LLM.setRubricChatForTests(null);
    }
  });

  it("S71-R5 Q3 — the run-time stop of rubric_run: a running llm run stops at the job ceiling (2 of 4 units scored, 2 skipped llm_cap, 2 model calls); the stop-removed mutant makes 4 calls", async () => {
    const LLM = await import("@/lib/rubrics/llm");
    for (const k of ["encA@m1", "encB@m1", "encC@m1"]) await pg.sql`INSERT INTO eta_encounter_windows (consult_key, room_id, t_open, t_close) VALUES (${k}, 'r1', ${IST("10:00:00")}::timestamptz, ${IST("10:00:30")}::timestamptz)`;
    let calls = 0;
    LLM.setRubricChatForTests(async () => { calls++; return { content: JSON.stringify({ scorable: false }), model: "fake/model", latency_ms: 1 }; });
    const saved = process.env.RUBRIC_LLM_JOB_CALL_CAP;
    process.env.RUBRIC_LLM_JOB_CALL_CAP = "2";
    try {
      const run = await runJob("rubric_run", { rubric_id: "consult_chair_affect", lab: true, unit_keys: ["enc1@m1", "encA@m1", "encB@m1", "encC@m1"] });
      expect(run.job).toMatchObject({ status: "done", result: { llm_calls: 2, skipped_llm_cap: 2 } });
      expect(calls).toBe(2);
    } finally {
      if (saved === undefined) delete process.env.RUBRIC_LLM_JOB_CALL_CAP; else process.env.RUBRIC_LLM_JOB_CALL_CAP = saved;
      LLM.setRubricChatForTests(null);
      await pg.sql`DELETE FROM eta_encounter_windows WHERE consult_key IN ('encA@m1','encB@m1','encC@m1')`;
    }
  });

  it("S71-R5 Q4 — three CONCURRENT 30-unit submits under a day cap of 50: exactly ONE job is queued (the capped insert runs behind an advisory lock); a claimed job with no run row yet is counted by its args", async () => {
    const { submitJob } = await import("@/lib/jobs/submit");
    const saved = process.env.RUBRIC_LLM_DAILY_CALL_CAP;
    process.env.RUBRIC_LLM_DAILY_CALL_CAP = "50";
    await pg.exec(`DELETE FROM scribe_job; DELETE FROM rubric_run;`);
    const keys = (tag: string) => Array.from({ length: 30 }, (_, i) => `${tag}${i}`);
    try {
      const sub = (tag: string) => submitJob({ kind: "rubric_run", args: { rubric_id: "consult_chair_affect", lab: true, unit_keys: keys(tag) }, actor: "mcp:t", scopes: new Set(["invoke"] as never) });
      statements.length = 0;
      const res = await Promise.allSettled([sub("a"), sub("b"), sub("c")]);
      // the capped insert is [advisory lock, conditional insert] in ONE transaction, in that order (the synchronous harness cannot interleave, so the lock itself is pinned by its statement)
      const order = statements.map((q) => (/pg_advisory_xact_lock/.test(q.text) ? "lock" : /INSERT INTO scribe_job/.test(q.text) ? "insert" : "")).filter(Boolean);
      expect(order).toEqual(["lock", "insert", "lock", "insert", "lock", "insert"]);
      expect(res.filter((r) => r.status === "fulfilled")).toHaveLength(1);
      for (const r of res.filter((x) => x.status === "rejected")) expect(String((r as PromiseRejectedResult).reason?.reason ?? (r as PromiseRejectedResult).reason)).toMatch(/^llm_daily_cap/);
      expect(((await pg.sql`SELECT count(*)::int AS n FROM scribe_job WHERE kind = 'rubric_run'`)[0] as { n: number }).n).toBe(1);
      // a RUNNING job that has no run row yet still holds its reservation (counted from its args): the next 30 are refused
      await pg.exec(`UPDATE scribe_job SET status = 'running', progress = '{}'::jsonb;`);
      await expect(sub("d")).rejects.toMatchObject({ reason: expect.stringMatching(/^llm_daily_cap/) });
      // once the run row exists (progress.run_id) the reservation moves to the run row (units_planned), which is still counted until it finishes
      await pg.exec(`INSERT INTO rubric_run (run_id, rubric_id, version, kind, units_planned) VALUES ('rub_q4', 'consult_chair_affect', '1.1.0', 'run', 30); UPDATE scribe_job SET progress = '{"run_id":"rub_q4"}'::jsonb;`);
      await expect(sub("e")).rejects.toMatchObject({ reason: expect.stringMatching(/^llm_daily_cap/) });
      // a finished run counts (units_ok + units_failed) x 2 = the worst case
      await pg.exec(`UPDATE rubric_run SET units_ok = 20, units_failed = 5, finished_at = now(); UPDATE scribe_job SET status = 'done';`);
      const C = await import("@/lib/rubrics/llm-cap");
      expect(await C.dayUsage()).toEqual({ used: 50, queued: 0 }); // (20 + 5) x 2
      await expect(sub("f")).rejects.toMatchObject({ reason: expect.stringMatching(/^llm_daily_cap/) }); // 50 + 30 > 50
    } finally {
      if (saved === undefined) delete process.env.RUBRIC_LLM_DAILY_CALL_CAP; else process.env.RUBRIC_LLM_DAILY_CALL_CAP = saved;
      await pg.exec(`DELETE FROM scribe_job; DELETE FROM rubric_run;`);
    }
  });

  it("S71-R5 Q2 — a row carrying BOTH room_id and room_ids is checked against the UNION: a blind room_id with clean room_ids is blind_room_day, 0 reads, 0 calls", async () => {
    const LLM = await import("@/lib/rubrics/llm");
    let calls = 0;
    LLM.setRubricChatForTests(async () => { calls++; return { content: JSON.stringify({ surgery_recommended: false }), model: "fake/model", latency_ms: 1 }; });
    try {
      const rows = [{ unit_key: "hv-q2", unit_kind: "excerpt", room_id: "room_4ggnkg5x", room_ids: ["r1", "r2"], ist_date: "2026-09-23", expected: { surgery_recommended: false } }].map((x) => JSON.stringify(x)).join("\n") + "\n";
      mem.set("rubric/bench/consult_surgical_pitch/human_v.jsonl", rows);
      mem.set("rubric/bench/consult_surgical_pitch/text/hv-q2.json", JSON.stringify({ lines: [{ t_s: 0, speaker: "unknown", text: "No-op needed." }] }));
      const b = await runJob("rubric_bench", { rubric_id: "consult_surgical_pitch", set: "human_v" });
      expect(b.job).toMatchObject({ status: "done", result: { n: 1, unscored: 1 } });
      expect(calls).toBe(0);
    } finally {
      LLM.setRubricChatForTests(null);
    }
  });

  it("S7-2 encounter_vs_record through the real runner: record (fake warehouse) vs tape (fake model) -> a discrepancy report; blind skipped before the warehouse; read-only; evr_perturb bench selects its windows at run time", async () => {
    const LLM = await import("@/lib/rubrics/llm");
    const REC = await import("@/lib/rubrics/evr/record");
    await pg.sql`UPDATE eta_encounter_windows SET consult_uid = 'ConsultUidEnc1AaaaaaaaaaaZ', warehouse_prescription_uid = 'recA' WHERE consult_key = 'enc1@m1'`;
    await pg.sql`UPDATE eta_encounter_windows SET consult_uid = 'ConsultUidEnc3AaaaaaaaaaaZ', warehouse_prescription_uid = 'recB' WHERE consult_key = 'enc3@m2'`;
    const queries: string[] = [];
    REC.setMetabaseForTests(async (q) => { queries.push(q); return [{ rec_uid: "recA", uploaded_at: "2026-10-08T10:00:00Z", exam: "", complaints: [], plan: [], ai_meta: {}, meds: [
      { generic_name: "Alphamox", strength: "500 mg", frequency: "BD" }, { generic_name: "Warfarin", strength: "5 mg", frequency: "OD" }], investigations: [], refer_to: [], advice: [] }]; });
    LLM.setRubricChatForTests(async () => ({ content: JSON.stringify({ scorable: true, meds: [{ name: "Alphamox", dose: "250 mg", freq: "twice a day", quote: "alpha" }] }), model: "fake/model", latency_ms: 1 }));
    try {
      const run = await runJob("rubric_run", { rubric_id: "encounter_vs_record", lab: true, unit_keys: ["enc1@m1", "enc3@m2", "nope"] });
      expect(run.job).toMatchObject({ status: "done", result: { rubric_id: "encounter_vs_record", ok: 1, skipped: 2, blind_room_days: 1 } });
      expect(queries).toHaveLength(1); // the blind consult never reached the warehouse
      expect(queries[0]).toMatch(/^SELECT /);
      const rows = (await pg.sql`SELECT unit_key, status, score, findings FROM rubric_result`) as Array<Record<string, any>>;
      expect(rows.map((r) => r.unit_key)).toEqual(["enc1@m1"]);
      expect(rows[0]).toMatchObject({ status: "ok", score: { label: "discrepancy report", severity: "obvious", n_findings: 2 } });
      expect(rows[0].findings).toEqual(["obvious:in_record_not_said:drug", "obvious:value_mismatch:dose"]);
      expect(JSON.stringify(rows)).not.toMatch(/Warfarin|Alphamox|alpha/); // no record or tape text in the table
      const ev = JSON.parse(mem.get(`rubric/encounter_vs_record/0.1.0/${"enc1@m1"}.json`)!);
      expect(JSON.stringify(ev)).toContain("no support found");
      expect([...mem.keys()].some((k) => k.includes("enc3"))).toBe(false);
      // evr_perturb: the file holds a header only; the windows are selected in the job (enc1@m1 qualifies; the open and the blind consults do not)
      mem.set("rubric/bench/encounter_vs_record/evr_perturb.jsonl", JSON.stringify({ header: { selection: "closed windows from 2026-10-02 with a prescription uid, not held out, with a stored transcript; md5 order by seed", seed: 5, n_windows: 40 } }) + "\n");
      queries.length = 0;
      const b = await runJob("rubric_bench", { rubric_id: "encounter_vs_record", set: "evr_perturb" });
      expect(b.job).toMatchObject({ status: "done", result: { set: "evr_perturb", metric: "perturbation_recall", n: 1, passed: null } });
      const rep = JSON.parse(mem.get(b.job.result.report_key)!);
      expect(rep).toMatchObject({ windows_planned: 1, windows_scored: 1, human_gold: false });
      expect(rep.per_kind.add_drug).toMatchObject({ n_applicable: 1, recall: 1 });
      expect(rep.per_kind.dose_x2.n_applicable).toBe(1);
      expect(rep.baseline_flag_rate.obvious).toBe(1); // the original holds the unsupported Warfarin: reported as a flag rate, not as a label
      expect(rep.note).toMatch(/NOT negatives/);
      expect(JSON.stringify(rep)).not.toMatch(/Warfarin|Alphamox/);
      expect(((await pg.sql`SELECT count(*)::int AS n FROM rubric_result`)[0] as { n: number }).n).toBe(1); // the bench wrote no result row
      // an EXPLICIT blind unit_key row (R2): refused blind_room_day, counted, and the warehouse is never asked for it
      mem.set("rubric/bench/encounter_vs_record/evr_perturb.jsonl", [{ header: { seed: 5, n_windows: 40 } }, { unit_key: "enc1@m1" }, { unit_key: "enc3@m2" }].map((x) => JSON.stringify(x)).join("\n") + "\n");
      queries.length = 0;
      const bb = await runJob("rubric_bench", { rubric_id: "encounter_vs_record", set: "evr_perturb" });
      expect(bb.job).toMatchObject({ status: "done", result: { n: 1, windows_skipped: { blind_room_day: 1 } } });
      expect(queries).toHaveLength(1); // enc1 only
      // evr_perturb is for encounter_vs_record only
      const { KIND_BY_NAME } = await import("@/lib/jobs/kinds");
      expect(() => KIND_BY_NAME.get("rubric_bench")!.parseArgs({ rubric_id: "consult_surgical_pitch", set: "evr_perturb" })).toThrow();
    } finally {
      LLM.setRubricChatForTests(null);
      REC.setMetabaseForTests(null);
    }
  });
});

/**
 * pulse-doctor-voice-pg.test.ts — 0142 and every SQL statement of lib/room-access/pulse-doctor-voice.ts against real
 * Postgres 16: which windows label a Pulse doctor, which doctors are due a build, the one-statement generation write
 * and the run log. Times are fixed IST instants typed here; the lookback is passed wide so the fixture never ages out.
 * Every id is fake. The held-out rule was lifted on 10 Oct (BLIND_ROOM_DAYS is empty): the formerly held-out pair, typed
 * here as the identity pg test does, is now served like any other day, and the chooser counts 0 excluded.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { dockerAvailable, pgContainer } from "../support/s1-pg";
import { makeFakeClinician } from "../support/fake-identity";

const H = vi.hoisted(() => ({ sql: null as null | ((s: TemplateStringsArray, ...v: unknown[]) => Promise<unknown[]>) }));
vi.mock("@/lib/db", () => ({ sql: (s: TemplateStringsArray, ...v: unknown[]) => H.sql!(s, ...v) }));

vi.setConfig({ testTimeout: 60_000, hookTimeout: 180_000 });
const HAVE = dockerAvailable();
const pg = pgContainer("eta-pulse-doctor-voice-0142");

const BLIND_DAY = "2026-09-28";
const BLIND_ROOM = "room_qyzghzaf";
const WIDE = 3650; // days: the fixture's fixed dates stay inside the lookback
const at = (day: string, hhmm: string) => Date.parse(`${day}T${hhmm}:00+05:30`);
const MIN15 = 900_000;

const FIXTURE_DDL = `
CREATE TABLE schema_migrations (version integer PRIMARY KEY, name text, applied_at timestamptz DEFAULT now());
CREATE TABLE room_day (id text PRIMARY KEY, room_id text NOT NULL, ist_date date NOT NULL);
CREATE TABLE bench_session (id text PRIMARY KEY, room_id text NOT NULL, started_at timestamptz NOT NULL, ended_at timestamptz);
CREATE TABLE bench_chunk (session_id text NOT NULL, ended_at timestamptz);
CREATE TABLE bench_window (id text PRIMARY KEY, session_id text NOT NULL, room_day_id text, start_ms bigint NOT NULL, end_ms bigint NOT NULL,
  state text NOT NULL DEFAULT 'closed', grid_aligned boolean NOT NULL DEFAULT true, clip_r2_key text, source_mic text);
CREATE TABLE room_diarize_window (window_id text PRIMARY KEY, room_day_id text);
CREATE TABLE room_turn_speaker (window_id text, room_day_id text);
CREATE TABLE jev_window_text (window_id text, room_day_id text);
CREATE TABLE room_span_emotion (window_id text, room_day_id text);
CREATE TABLE scribe_job (id text PRIMARY KEY, kind text NOT NULL, args jsonb NOT NULL, status text NOT NULL);
-- the columns of eta_encounter_windows (0123/0124) these queries read
CREATE TABLE eta_encounter_windows (consult_key text PRIMARY KEY, room_id text, doctor_uid text, warehouse_doctor_uid text,
  quality text NOT NULL, t_open timestamptz NOT NULL, t_close timestamptz);
`;

const q = async <T = Record<string, unknown>>(text: string): Promise<T[]> => {
  const s = Object.assign([text], { raw: [text] }) as unknown as TemplateStringsArray;
  return (await H.sql!(s)) as T[];
};
const fails = (text: string) => { try { pg.exec(text); return ""; } catch (e) { return String((e as { stderr?: unknown }).stderr ?? e); } };

let nWin = 0;
/** A stored Nemotron window in `room` starting at `startMs`. Returns its window id. */
function nemo(room: string, day: string, startMs: number, status: "ok" | "empty" = "ok"): string {
  const id = `bw_fake${String(++nWin).padStart(3, "0")}_${startMs}_primary`;
  const rd = `rd_${room}_${day}`;
  pg.exec(`INSERT INTO room_day (id, room_id, ist_date) VALUES ('${rd}', '${room}', '${day}') ON CONFLICT DO NOTHING;
    INSERT INTO bench_session (id, room_id, started_at, ended_at) VALUES ('bs_${id}', '${room}', '${day} 08:00+05:30', '${day} 20:00+05:30');
    INSERT INTO bench_window (id, session_id, room_day_id, start_ms, end_ms, clip_r2_key) VALUES ('${id}', 'bs_${id}', '${rd}', ${startMs}, ${startMs + MIN15}, 'clips/bs_${id}/a.webm');
    INSERT INTO diarize_nemotron_window (window_id, room_day_id, engine, model, model_rev, config, config_hash, worker_id, machine, audio_ms,
      turns_json, speaker_count, turn_count, speech_ms, overlap_ms, payload_sha256, status, error_code)
    VALUES ('${id}', '${rd}', 'nemotron', 'm', 'r', '{}', 'h', 'wk', 'box', ${MIN15}, '${status === "ok" ? '[[0,1000,"spk0"]]' : "[]"}', ${status === "ok" ? 1 : 0},
      ${status === "ok" ? 1 : 0}, ${status === "ok" ? 1000 : 0}, 0, 'p', '${status}', NULL);`);
  return id;
}
let nCon = 0;
function consult(room: string, o: { wh?: string | null; ext?: string | null; quality?: string; from: number; to: number | null }) {
  pg.exec(`INSERT INTO eta_encounter_windows (consult_key, room_id, doctor_uid, warehouse_doctor_uid, quality, t_open, t_close) VALUES
    ('ck_fake${++nCon}', '${room}', ${o.ext ? `'${o.ext}'` : "NULL"}, ${o.wh ? `'${o.wh}'` : "NULL"}, '${o.quality ?? "clean"}',
     to_timestamp(${o.from / 1000}), ${o.to === null ? "NULL" : `to_timestamp(${o.to / 1000})`});`);
}

const R = "room_fake1", U1 = "pulse_doc_fake1", U2 = "pulse_doc_fake2";
const W: Record<string, string> = {};

beforeAll(async () => {
  if (!HAVE) return;
  pg.start();
  pg.exec(FIXTURE_DDL);
  pg.exec(readFileSync("db/migrations/0117_diarize_window_label.sql", "utf8"));
  pg.exec(readFileSync("db/migrations/0140_diarize_nemotron.sql", "utf8"));
  pg.exec(readFileSync("db/migrations/0142_pulse_doctor_voice.sql", "utf8"));
  const A = "2026-10-03", B = "2026-10-05";
  // U1 (warehouse uid) holds 09:00-10:00 on A and 09:00-09:30 on B: four plus two whole windows
  consult(R, { wh: U1, from: at(A, "09:00"), to: at(A, "09:40") });
  consult(R, { wh: U1, ext: "pulse_doc_ext_other", from: at(A, "09:40"), to: at(A, "10:00") }); // warehouse uid wins
  for (const t of ["09:00", "09:15", "09:30", "09:45"]) W[`a${t}`] = nemo(R, A, at(A, t));
  consult(R, { ext: U1, from: at(B, "09:00"), to: at(B, "09:30") }); // extension uid when the warehouse has none
  for (const t of ["09:00", "09:15"]) W[`b${t}`] = nemo(R, B, at(B, t));
  // 40% covered by U1: out
  consult(R, { wh: U1, from: at(A, "11:00"), to: at(A, "11:06") }); W.partial = nemo(R, A, at(A, "11:00"));
  // exactly half covered by U1: in
  consult(R, { wh: U1, from: at(A, "11:30"), to: at(A, "11:37") + 30_000 }); W.half = nemo(R, A, at(A, "11:30"));
  // U1 all of it, but U2 overlaps for a minute: out (for both)
  consult(R, { wh: U1, from: at(A, "12:00"), to: at(A, "12:14") }); consult(R, { wh: U2, from: at(A, "12:14"), to: at(A, "12:30") }); W.shared = nemo(R, A, at(A, "12:00"));
  // U1 all of it, and an unattributed consult overlaps: out
  consult(R, { wh: U1, from: at(A, "13:00"), to: at(A, "13:15") }); consult(R, { from: at(A, "13:10"), to: at(A, "13:20") }); W.unattributed = nemo(R, A, at(A, "13:00"));
  // a multi_doctor consult of U1: out
  consult(R, { wh: U1, quality: "multi_doctor", from: at(A, "14:00"), to: at(A, "14:15") }); W.multi = nemo(R, A, at(A, "14:00"));
  // an open consult (no t_close): no coverage, out
  consult(R, { wh: U1, quality: "unclosed", from: at(A, "15:00"), to: null }); W.open = nemo(R, A, at(A, "15:00"));
  // a non-ok Nemotron row inside U1's time: out
  consult(R, { wh: U1, from: at(A, "16:00"), to: at(A, "16:15") }); W.empty = nemo(R, A, at(A, "16:00"), "empty");
  // a formerly held-out room-day, fully U1's: in since the rule was lifted
  consult(BLIND_ROOM, { wh: U1, from: at(BLIND_DAY, "10:00"), to: at(BLIND_DAY, "10:15") }); W.blind = nemo(BLIND_ROOM, BLIND_DAY, at(BLIND_DAY, "10:00"));
  // U2 owns three whole windows on two days: below MIN_WINDOWS
  consult(R, { wh: U2, from: at(B, "14:00"), to: at(B, "14:30") }); nemo(R, B, at(B, "14:00")); nemo(R, B, at(B, "14:15"));
  consult(R, { wh: U2, from: at(A, "17:00"), to: at(A, "17:15") }); nemo(R, A, at(A, "17:00"));
  H.sql = pg.sql as never;
}, 240_000);
afterAll(() => { if (HAVE) pg.stop(); });

describe("REQUIRED PROOF ran, or was skipped deliberately", () => {
  it("needs Docker", () => {
    if (HAVE || process.env.ETA_ALLOW_SKIP_E2E === "1") return;
    throw new Error("REQUIRED PROOF NOT RUN: tests/unit/pulse-doctor-voice-pg.test.ts needs Docker for postgres:16, or set ETA_ALLOW_SKIP_E2E=1.");
  });
});

describe.runIf(HAVE)("migration 0142", () => {
  it("applies a second time without error and registers once", async () => {
    pg.exec(readFileSync("db/migrations/0142_pulse_doctor_voice.sql", "utf8"));
    expect((await q<{ n: number }>("SELECT count(*)::int AS n FROM schema_migrations WHERE version = 142"))[0]!.n).toBe(1);
  });

  it("constraints: dimension, counts, support, nearest pair, retirement, run outcome/reason/voice", () => {
    const ins = (cols: string) => `INSERT INTO pulse_doctor_voice (id, pulse_doctor_uid, generation, embedding, embedding_model, embedding_dim, n_windows, n_days, windows_offered, support, nearest_clinician_id, nearest_score, retired_at, retired_by, retired_reason) VALUES (${cols});`;
    expect(fails(ins(`'pdv_c1','u',1,'{1,0}','m',3,4,2,4,1,NULL,NULL,NULL,NULL,NULL`))).toContain("pulse_doctor_voice_dim_chk");
    expect(fails(ins(`'pdv_c2','u',1,'{1,0}','m',2,5,2,4,1,NULL,NULL,NULL,NULL,NULL`))).toContain("pulse_doctor_voice_counts_chk");
    expect(fails(ins(`'pdv_c3','u',1,'{1,0}','m',2,4,2,4,0,NULL,NULL,NULL,NULL,NULL`))).toContain("pulse_doctor_voice_support_chk");
    expect(fails(ins(`'pdv_c4','u',1,'{1,0}','m',2,4,2,4,1,'doc_fake0001',NULL,NULL,NULL,NULL`))).toContain("pulse_doctor_voice_nearest_chk");
    expect(fails(ins(`'pdv_c5','u',1,'{1,0}','m',2,4,2,4,1,NULL,NULL,now(),NULL,NULL`))).toContain("pulse_doctor_voice_retirement_chk");
    expect(fails(`INSERT INTO pulse_doctor_voice_run (pulse_doctor_uid, outcome, reason) VALUES ('u', 'built', 'x');`)).toContain("pulse_doctor_voice_run_reason_chk");
    expect(fails(`INSERT INTO pulse_doctor_voice_run (pulse_doctor_uid, outcome, reason) VALUES ('u', 'refused', NULL);`)).toContain("pulse_doctor_voice_run_reason_chk");
    expect(fails(`INSERT INTO pulse_doctor_voice_run (pulse_doctor_uid, outcome, reason) VALUES ('u', 'built', NULL);`)).toContain("pulse_doctor_voice_run_voice_chk");
    expect(fails(`INSERT INTO pulse_doctor_voice_run (pulse_doctor_uid, outcome, reason) VALUES ('u', 'skipped', 'x');`)).toContain("pulse_doctor_voice_run_outcome_chk");
  });
});

describe.runIf(HAVE)("which windows label a doctor", () => {
  it("U1: the six whole windows, the half-covered one and the formerly held-out one, newest first; every other case left out; nothing excluded", async () => {
    const S = await import("@/lib/room-access/pulse-doctor-voice");
    const r = await S.doctorWindows(U1, WIDE, 50);
    expect(r.windows.map((w) => w.window_id)).toEqual([W["b09:15"], W["b09:00"], W.half, W["a09:45"], W["a09:30"], W["a09:15"], W["a09:00"], W.blind]);
    expect(r.windows[0]).toMatchObject({ day: "2026-10-05", clip_r2_key: `clips/bs_${W["b09:15"]}/a.webm` });
    expect(typeof r.windows[0]!.row_id).toBe("number");
    expect(r.n_blind_excluded).toBe(0);
  });

  it("honours the limit and the lookback", async () => {
    const S = await import("@/lib/room-access/pulse-doctor-voice");
    expect((await S.doctorWindows(U1, WIDE, 2)).windows.map((w) => w.window_id)).toEqual([W["b09:15"], W["b09:00"]]);
    expect((await S.doctorWindows(U1, 1, 50)).windows).toEqual([]);
  });

  it("U2 gets its three own windows, and not the one it shares with U1", async () => {
    const S = await import("@/lib/room-access/pulse-doctor-voice");
    const r = await S.doctorWindows(U2, WIDE, 50);
    expect(r.windows).toHaveLength(3);
    expect(r.windows.map((w) => w.window_id)).not.toContain(W.shared);
  });
});

describe.runIf(HAVE)("which doctors are due a build", () => {
  it("U1 (8 windows) is due and U2 (3) is not; a recent run or an open job takes U1 out", async () => {
    const S = await import("@/lib/room-access/pulse-doctor-voice");
    expect((await S.doctorsToBuild(WIDE, 4, 20, 10)).uids).toEqual([{ uid: U1, windows: 8 }]);
    expect((await S.doctorsToBuild(WIDE, 3, 20, 10)).uids).toEqual([{ uid: U1, windows: 8 }, { uid: U2, windows: 3 }]);
    pg.exec(`INSERT INTO scribe_job (id, kind, args, status) VALUES ('job_fake1', 'pulse_doctor_voice', '{"pulse_doctor_uid": "${U1}"}', 'queued');`);
    expect((await S.doctorsToBuild(WIDE, 4, 20, 10)).uids).toEqual([]);
    pg.exec(`UPDATE scribe_job SET status = 'done' WHERE id = 'job_fake1';
             INSERT INTO pulse_doctor_voice_run (pulse_doctor_uid, outcome, reason, created_at) VALUES ('${U1}', 'refused', 'low_support', now() - interval '21 hours');`);
    expect((await S.doctorsToBuild(WIDE, 4, 20, 10)).uids).toEqual([{ uid: U1, windows: 8 }]);
    await S.recordDoctorVoiceRun({ uid: U1, outcome: "refused", reason: "too_few_days", windows_offered: 7, windows_embedded: 7, n_windows: 5, n_days: 1, runner_up_windows: 0, n_blind_excluded: 1 });
    expect((await S.doctorsToBuild(WIDE, 4, 20, 10)).uids).toEqual([]);
  });
});

describe.runIf(HAVE)("the generation write", () => {
  it("gen 1 then gen 2: one active row, the old one retired with who and why, a built run per write; a refusal leaves the print alone", async () => {
    const S = await import("@/lib/room-access/pulse-doctor-voice");
    const doc = makeFakeClinician(1).id;
    const base = { uid: "pulse_doc_fake9", actor: "job:pulse_doctor_voice", embedding_model: "m", n_windows: 6, n_days: 2, windows_offered: 7, windows_embedded: 7, support: 6 / 7, runner_up_windows: 2, n_blind_excluded: 1, source: { members: [] } };
    const one = await S.writeDoctorVoice({ ...base, id: "pdv_fake1", embedding: [1, 0, 0], nearest: { clinician_id: doc, score: 0.41 } });
    expect(one).toEqual({ id: "pdv_fake1", generation: 1, retired: 0 });
    const two = await S.writeDoctorVoice({ ...base, id: "pdv_fake2", embedding: [0, 1, 0], nearest: null });
    expect(two).toEqual({ id: "pdv_fake2", generation: 2, retired: 1 });
    const rows = await q<{ id: string; generation: number; retired: boolean; retired_by: string | null; retired_reason: string | null; nearest_clinician_id: string | null; embedding: string }>(
      "SELECT id, generation, retired_at IS NOT NULL AS retired, retired_by, retired_reason, nearest_clinician_id, embedding::text AS embedding FROM pulse_doctor_voice WHERE pulse_doctor_uid = 'pulse_doc_fake9' ORDER BY generation");
    expect(rows.map((r) => [r.id, r.generation, r.retired, r.retired_by, r.retired_reason, r.nearest_clinician_id])).toEqual([
      ["pdv_fake1", 1, true, "job:pulse_doctor_voice", "superseded_by:pdv_fake2", doc],
      ["pdv_fake2", 2, false, null, null, null],
    ]);
    expect(rows[1]!.embedding).toBe("{0,1,0}");
    await S.recordDoctorVoiceRun({ uid: "pulse_doc_fake9", outcome: "failed", reason: "embed_failed", windows_offered: 7, windows_embedded: 0, n_windows: 0, n_days: 0, runner_up_windows: 0, n_blind_excluded: 1 });
    const runs = await q<{ outcome: string; reason: string | null; voice_id: string | null; n_windows: number }>("SELECT outcome, reason, voice_id, n_windows FROM pulse_doctor_voice_run WHERE pulse_doctor_uid = 'pulse_doc_fake9' ORDER BY id");
    expect(runs).toEqual([
      { outcome: "built", reason: null, voice_id: "pdv_fake1", n_windows: 6 },
      { outcome: "built", reason: null, voice_id: "pdv_fake2", n_windows: 6 },
      { outcome: "failed", reason: "embed_failed", voice_id: null, n_windows: 0 },
    ]);
    expect((await q<{ n: number }>("SELECT count(*)::int AS n FROM pulse_doctor_voice WHERE pulse_doctor_uid = 'pulse_doc_fake9' AND retired_at IS NULL"))[0]!.n).toBe(1);
  });
});

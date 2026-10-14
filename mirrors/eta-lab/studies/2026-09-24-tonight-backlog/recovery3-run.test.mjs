// Tests for recovery3-run.mjs against a THROWAWAY postgres:16 container (own name, tmpfs, removed with `docker rm -fv`). Invented rows only.
//   node --test recovery3-run.test.mjs      (needs docker; the runner's own SQL text is what executes, via psql -1 = one transaction)
import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { STEP0, EVIDENCE, commitStatements } from "./recovery3-run.mjs";

const C = `yd-r3-test-${process.pid}`;
const LO = 1789842600000;
const psql = (sql, flags = []) => spawnSync("docker", ["exec", "-i", C, "psql", "-U", "postgres", "-X", "-q", "-t", "-A", "-v", "ON_ERROR_STOP=1", ...flags], { input: sql, encoding: "utf8" });
const val = (sql) => psql(sql).stdout.trim();

before(() => {
  execFileSync("docker", ["run", "-d", "--name", C, "-e", "POSTGRES_PASSWORD=x", "--tmpfs", "/var/lib/postgresql/data", "postgres:16"], { stdio: "ignore" });
  for (let i = 0; i < 60; i++) { if (psql("select 1").stdout.trim() === "1") return; execFileSync("sleep", ["1"]); }
  throw new Error("postgres did not start");
});
after(() => { try { execFileSync("docker", ["rm", "-fv", C], { stdio: "ignore" }); } catch { /* already gone */ } });

const ERR = "join_failed: join_already_running after 4 busy retries over 900s";
function seed(extra = "") {
  const r = psql(`DROP SCHEMA public CASCADE; CREATE SCHEMA public;
CREATE TABLE room (id text, transcript_enabled bool);
CREATE TABLE bench_session (id text, room_id text);
CREATE TABLE bench_window (id text, session_id text, state text, start_ms bigint, grid_aligned bool, room_day_id text);
CREATE TABLE stt_subject_job (subject_type text, subject_id text, tier text, state text, attempts int, last_error text, finished_at timestamptz);
CREATE TABLE scribe_job (id text, kind text, status text, args jsonb, updated_at timestamptz DEFAULT now());
CREATE TABLE audit_log (actor_type text, actor_id text, action text, target_type text, target_id text, metadata_json jsonb);
INSERT INTO room VALUES ('r1', true); INSERT INTO bench_session VALUES ('s1', 'r1');
INSERT INTO bench_window VALUES ('w1','s1','failed',${LO + 1000},true,'d'),('w2','s1','closed',${LO + 2000},true,'d'),('w3','s1','closed',${LO + 3000},true,'d'),
  ('w4','s1','closed',${LO + 4000},true,'d'),('w5','s1','closed',${LO + 5000},true,'d');
INSERT INTO stt_subject_job VALUES ('bench_window','w1','asr','failed',5,'${ERR}',now()),('bench_window','w2','asr','failed',2,'${ERR}',now()),('bench_window','w3','asr','failed',3,'${ERR}',now()),
  ('bench_window','w4','asr','failed',1,'whisper_unavailable',now()),('bench_window','w5','asr','failed',1,'${ERR}',now());
INSERT INTO scribe_job VALUES ('j1','room_window','failed','{"window_id":"w1"}',now()),('j3','room_window','failed','{"window_id":"w3"}',now()),('j5','room_window','queued','{"window_id":"w5"}',now());
${extra}`);
  assert.equal(r.status, 0, r.stderr);
}
const state = () => val(`SELECT (SELECT string_agg(id || ':' || state, ',' ORDER BY id) FROM bench_window) || '|' || (SELECT string_agg(subject_id || ':' || attempts || ':' || state, ',' ORDER BY subject_id) FROM stt_subject_job) || '|' || (SELECT count(*) FROM audit_log)`);
const commit = (statements) => psql(statements.join(";\n") + ";", ["-1"]);
const W = 3, J = 3;

test("STEP 0 and the evidence queries run and count what the fixture holds", () => {
  seed();
  const s0 = JSON.parse(val(`SELECT json_agg(t) FROM (${STEP0}) t`));
  assert.equal(s0.reduce((a, r) => a + r.n, 0), 3);
  const ev = Object.fromEntries(EVIDENCE.map(([n, q]) => [n, JSON.parse(val(`SELECT json_agg(t) FROM (${q}) t`))]));
  assert.equal(ev.windows_frozen[0].n, 3);
  assert.equal(ev.target_jobs[0].n, 3);
  assert.deepEqual(ev.target_jobs_by_state, [{ state: "failed", n: 3 }]);
  assert.deepEqual(ev.targets_by_window_state, [{ window_state: "closed", n: 2 }, { window_state: "failed", n: 1 }]);
  assert.deepEqual(ev.targets_by_latest_room_window_job_status, [{ latest_job_status: "failed", n: 2 }, { latest_job_status: "no_job", n: 1 }]);
  assert.deepEqual(ev.live_room_window_jobs_all, [{ status: "queued", n: 1 }]);
});

test("happy path: one transaction reopens the parked window, refunds exactly the target jobs, writes one audit row, touches nothing else", () => {
  seed();
  const r = commit(commitStatements(W, J));
  assert.equal(r.status, 0, r.stderr);
  assert.equal(val("SELECT string_agg(id || ':' || state, ',' ORDER BY id) FROM bench_window"), "w1:closed,w2:closed,w3:closed,w4:closed,w5:closed");
  assert.equal(val("SELECT string_agg(subject_id || ':' || attempts || ':' || state, ',' ORDER BY subject_id) FROM stt_subject_job"), "w1:0:queued,w2:0:queued,w3:0:queued,w4:1:failed,w5:1:failed");
  const a = JSON.parse(val("SELECT metadata_json FROM audit_log"));
  assert.deepEqual([a.target_windows, a.target_jobs, a.reopened_parked], [3, 3, 1]);
  assert.equal(val("SELECT last_error FROM stt_subject_job WHERE subject_id = 'w1'"), ERR);           // last_error kept
});

const aborts = (name, extra, w, j, why) => test(`guard fires and writes nothing: ${name}`, () => {
  seed(extra);
  const before = state();
  const r = commit(commitStatements(w, j));
  assert.notEqual(r.status, 0, "must abort");
  assert.match(r.stderr, new RegExp(why));
  assert.equal(state(), before, "nothing written");
});
aborts("wrong window count", "", 4, 3, "window set is not the approved size");
aborts("wrong job count", "", 3, 4, "asr job set is not the approved size");
aborts("a target asr job is queued", "UPDATE stt_subject_job SET state = 'queued' WHERE subject_id = 'w2';", 3, 3, "target asr job is not failed");
aborts("a target's latest room_window job is done", "INSERT INTO scribe_job VALUES ('j3d','room_window','done','{\"window_id\":\"w3\"}', now() + interval '1 minute');", 3, 3, "queued, running or done room_window job");
aborts("a live room_window job appears for a target (window set shrinks)", "INSERT INTO scribe_job VALUES ('j2q','room_window','queued','{\"window_id\":\"w2\"}', now());", 3, 3, "window set is not the approved size");
aborts("a second matching asr row with attempts 0 (UPDATE would touch more than the frozen jobs)", `INSERT INTO stt_subject_job VALUES ('bench_window','w2','asr','failed',0,'${ERR}',now());`, 3, 3, "refunded row count");

test("windows and jobs are counted separately: a window with two matching asr rows is 1 window, 2 jobs", () => {
  seed(`INSERT INTO stt_subject_job VALUES ('bench_window','w2','asr','failed',1,'${ERR}',now());`);
  assert.equal(val(`SELECT count(*) FROM (${EVIDENCE.find(([n]) => n === "windows_frozen")[1]}) x`), "1");
  assert.equal(JSON.parse(val(`SELECT json_agg(t) FROM (${EVIDENCE.find(([n]) => n === "windows_frozen")[1]}) t`))[0].n, 3);
  assert.equal(JSON.parse(val(`SELECT json_agg(t) FROM (${EVIDENCE.find(([n]) => n === "target_jobs")[1]}) t`))[0].n, 4);
  const r = commit(commitStatements(3, 4));
  assert.equal(r.status, 0, r.stderr);
});

// Mutants: remove one guard; the scenario that relied on it must now COMMIT (the test above would then fail = the mutant is killed).
const mutants = [
  ["window-count guard", /IF \(SELECT count\(\*\) FROM recovery3_targets\) <> \d+ THEN RAISE EXCEPTION 'recovery3_guard: window set[^;]*; END IF;/, "", 4, 3],
  ["asr-state guard", /IF EXISTS \(SELECT 1 FROM recovery3_jobs WHERE state IS DISTINCT FROM 'failed'\) THEN RAISE EXCEPTION[^;]*; END IF;/, "UPDATE stt_subject_job SET state = 'queued' WHERE subject_id = 'w2';", 3, 3],
  ["room_window-latest guard", /IF EXISTS \(SELECT 1 FROM recovery3_targets t JOIN LATERAL[\s\S]*?END IF;/, "INSERT INTO scribe_job VALUES ('j3d','room_window','done','{\"window_id\":\"w3\"}', now() + interval '1 minute');", 3, 3],
  ["refunded-row-count guard", /IF n <> \d+ THEN RAISE EXCEPTION 'recovery3_guard: refunded[^;]*; END IF;/, `INSERT INTO stt_subject_job VALUES ('bench_window','w2','asr','failed',0,'${ERR}',now());`, 3, 3],
];
for (const [name, rx, extra, w, j] of mutants) {
  test(`mutant killed: without the ${name} the bad scenario commits`, () => {
    seed(extra);
    const st = commitStatements(w, j).map((q) => q.replace(rx, ""));
    assert.notEqual(st.join("\n"), commitStatements(w, j).join("\n"), "the mutation changed the SQL");
    const r = commit(st);
    assert.equal(r.status, 0, "the mutant should have let the bad scenario through (so the guard test detects its removal): " + r.stderr);
  });
}

test("the job-count guard is redundant with the refunded-row-count guard (equivalent mutant): removing it still aborts on a wrong J, one guard later", () => {
  seed();
  const rx = /IF \(SELECT count\(\*\) FROM recovery3_jobs\) <> \d+ THEN RAISE EXCEPTION 'recovery3_guard: asr job set[^;]*; END IF;/;
  const st = commitStatements(3, 4).map((q) => q.replace(rx, ""));
  assert.notEqual(st.join("\n"), commitStatements(3, 4).join("\n"));
  const before = state();
  const r = commit(st);
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /refunded row count/);
  assert.equal(state(), before);
});

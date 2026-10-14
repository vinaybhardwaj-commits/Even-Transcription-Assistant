#!/usr/bin/env node
// RECOVERY-3 runner (Fable r238 + the 25 Sep follow-up). Runs the statements of RECOVERY-3.sql, and only those.
//
//   cd <an ETA checkout with node_modules> && node <this file> --print-sql            prints the statements; no DB, no URL needed
//   cd <...> && node <this file>                                                        STEP 0: SELECT-only, counts to stdout
//   cd <...> && node <this file> --commit --expect-windows W --expect-jobs J           STEPS 1-4 in ONE transaction; aborts (nothing written) unless the frozen sets are exactly W windows and J asr jobs
//
// Only run with --commit after eta-refuter-2 has compared the STEP 0 counts and posted PASS with W and J.
// CREDENTIAL: env DATABASE_URL, else the 0600 file ~/.claude/secrets/eta_database_url, read inside this process only. Never argv, never printed;
// errors are printed as a class plus a short message with any postgres URL redacted. Output is counts only: no window id, room id, job id, text.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";

const LO = 1789842600000, HI = 1790101800000;   // 20 Sep 00:00 IST .. 23 Sep 00:00 IST (as RECOVERY-3.sql)
const LIVE = `NOT EXISTS (SELECT 1 FROM scribe_job j WHERE j.kind = 'room_window' AND j.args->>'window_id' = w.id AND j.status IN ('queued', 'running'))`;
const FROM = `FROM bench_window w
    JOIN bench_session s ON s.id = w.session_id
    JOIN room r ON r.id = s.room_id AND r.transcript_enabled = TRUE
    JOIN stt_subject_job sj ON sj.subject_type = 'bench_window' AND sj.subject_id = w.id AND sj.tier = 'asr'`;

// STEP 0 as in RECOVERY-3.sql (informational: it has no grid_aligned / room_day filter, STEP 1 does)
export const STEP0 = `SELECT w.state AS window_state, sj.state AS subject_state, sj.attempts, regexp_replace(sj.last_error, '[0-9]+', 'N', 'g') AS error_shape, count(*)::int AS n
  ${FROM}
 WHERE w.state IN ('closed', 'failed') AND w.start_ms >= ${LO} AND w.start_ms < ${HI}
   AND sj.last_error LIKE 'join_failed: join_already_running%' AND sj.attempts >= 1 AND ${LIVE}
 GROUP BY 1, 2, 3, 4 ORDER BY 5 DESC`;

// STEP 1 target set (frozen): the same rows STEPS 2-4 act on
const TARGET_WHERE = `WHERE w.state IN ('closed', 'failed') AND w.start_ms >= ${LO} AND w.start_ms < ${HI}
     AND w.grid_aligned = TRUE AND w.room_day_id IS NOT NULL
     AND sj.last_error LIKE 'join_failed: join_already_running%' AND sj.attempts >= 1 AND ${LIVE}`;
const TARGETS = `SELECT DISTINCT w.id AS window_id, w.state AS window_state ${FROM} ${TARGET_WHERE}`;
// the asr job rows those windows carry (what STEP 3 refunds); a window is a window, a job is a job (refuter-2 #1738 must-fix 2)
const JOB_ROWS = (targets) => `SELECT sj.subject_id, sj.state FROM stt_subject_job sj
     WHERE sj.subject_type = 'bench_window' AND sj.tier = 'asr' AND sj.last_error LIKE 'join_failed: join_already_running%' AND sj.attempts >= 1
       AND sj.subject_id IN (SELECT window_id FROM ${targets})`;

// Extra read-only evidence for refuter-2's rule ("every target job failed, 0 queued/running")
export const EVIDENCE = [
  ["windows_frozen", `SELECT count(*)::int AS n FROM (${TARGETS}) t`],
  ["target_jobs", `SELECT count(*)::int AS n FROM (${JOB_ROWS(`(${TARGETS}) t0`)}) j`],
  ["target_jobs_by_state", `SELECT coalesce(j.state, 'null') AS state, count(*)::int AS n FROM (${JOB_ROWS(`(${TARGETS}) t0`)}) j GROUP BY 1 ORDER BY 1`],
  ["targets_by_window_state", `SELECT window_state, count(*)::int AS n FROM (${TARGETS}) t GROUP BY 1 ORDER BY 1`],
  ["targets_by_latest_room_window_job_status", `SELECT coalesce(lj.status, 'no_job') AS latest_job_status, count(*)::int AS n FROM (${TARGETS}) t
     LEFT JOIN LATERAL (SELECT j.status FROM scribe_job j WHERE j.kind = 'room_window' AND j.args->>'window_id' = t.window_id ORDER BY j.updated_at DESC LIMIT 1) lj ON TRUE GROUP BY 1 ORDER BY 1`],
  ["live_room_window_jobs_all", `SELECT status, count(*)::int AS n FROM scribe_job WHERE kind = 'room_window' AND status IN ('queued', 'running') GROUP BY 1`],
];

export function commitStatements(expectWindows, expectJobs) {
  for (const n of [expectWindows, expectJobs]) if (!Number.isInteger(n) || n < 1) throw new Error("--expect-windows and --expect-jobs must be positive integers");
  return [
    `CREATE TEMP TABLE recovery3_targets ON COMMIT DROP AS ${TARGETS}`,
    `CREATE TEMP TABLE recovery3_jobs ON COMMIT DROP AS ${JOB_ROWS("recovery3_targets")}`,
    `DO $g$ BEGIN
       IF (SELECT count(*) FROM recovery3_targets) <> ${expectWindows} THEN RAISE EXCEPTION 'recovery3_guard: window set is not the approved size'; END IF;
       IF (SELECT count(*) FROM recovery3_jobs) <> ${expectJobs} THEN RAISE EXCEPTION 'recovery3_guard: asr job set is not the approved size'; END IF;
       IF EXISTS (SELECT 1 FROM recovery3_jobs WHERE state IS DISTINCT FROM 'failed') THEN RAISE EXCEPTION 'recovery3_guard: a target asr job is not failed'; END IF;
       IF EXISTS (SELECT 1 FROM recovery3_targets t JOIN LATERAL (SELECT j.status FROM scribe_job j WHERE j.kind = 'room_window' AND j.args->>'window_id' = t.window_id ORDER BY j.updated_at DESC LIMIT 1) lj ON TRUE
                   WHERE lj.status IN ('queued', 'running', 'done')) THEN RAISE EXCEPTION 'recovery3_guard: a target has a queued, running or done room_window job'; END IF;
     END $g$`,
    `DO $g$ DECLARE n int; BEGIN
       UPDATE bench_window SET state = 'closed' WHERE id IN (SELECT window_id FROM recovery3_targets WHERE window_state = 'failed') AND state = 'failed';
       GET DIAGNOSTICS n = ROW_COUNT;
       IF n <> (SELECT count(*) FROM recovery3_targets WHERE window_state = 'failed') THEN RAISE EXCEPTION 'recovery3_guard: reopened window count differs from the frozen set'; END IF;
     END $g$`,
    `DO $g$ DECLARE n int; BEGIN
       UPDATE stt_subject_job SET attempts = 0, state = 'queued', finished_at = NULL
        WHERE subject_type = 'bench_window' AND tier = 'asr' AND subject_id IN (SELECT window_id FROM recovery3_targets) AND last_error LIKE 'join_failed: join_already_running%';
       GET DIAGNOSTICS n = ROW_COUNT;
       IF n <> ${expectJobs} THEN RAISE EXCEPTION 'recovery3_guard: refunded row count (from the UPDATE itself) is not the approved size'; END IF;
     END $g$`,
    `INSERT INTO audit_log (actor_type, actor_id, action, target_type, target_id, metadata_json)
     VALUES ('system', 'fable-manual-recovery', 'room_window.recovery3_refund_join_busy_attempts', 'bench_window', NULL,
             jsonb_build_object('order', 'orders/queue/eta-lab-t4:yoga-drain/001-yoga-drain-3.md', 'ran_at', now(),
                                'target_windows', (SELECT count(*) FROM recovery3_targets), 'target_jobs', (SELECT count(*) FROM recovery3_jobs),
                                'reopened_parked', (SELECT count(*) FROM recovery3_targets WHERE window_state = 'failed')))`,
    `SELECT (SELECT count(*)::int FROM recovery3_targets) AS windows, (SELECT count(*)::int FROM recovery3_targets WHERE window_state = 'failed') AS reopened_parked`,
  ];
}

const redact = (s) => String(s ?? "").replace(/postgres(ql)?:\/\/\S+/gi, "<redacted-url>").slice(0, 160);

function dbUrl() {
  let u = (process.env.DATABASE_URL ?? "").trim();
  if (!u) {
    const p = path.join(os.homedir(), ".claude/secrets/eta_database_url");
    if (fs.existsSync(p)) u = fs.readFileSync(p, "utf8").trim();
  }
  if (!/^postgres(ql)?:\/\//.test(u)) throw new Error("no usable DATABASE_URL (env) or ~/.claude/secrets/eta_database_url on this machine");
  return u;
}

async function main() {
  const a = process.argv.slice(2);
  const commit = a.includes("--commit");
  const arg = (f) => { const i = a.indexOf(f); return i >= 0 ? Number(a[i + 1]) : null; };
  const expW = arg("--expect-windows"), expJ = arg("--expect-jobs");
  if (a.includes("--print-sql")) {
    console.log("-- STEP 0\n" + STEP0 + ";\n");
    for (const [n, q] of EVIDENCE) console.log(`-- evidence: ${n}\n${q};\n`);
    console.log("-- COMMIT MODE (one transaction; N = --expect)\n" + commitStatements(998, 999).join(";\n") + ";");
    return 0;
  }
  if (commit && (expW === null || expJ === null)) throw new Error("--commit needs --expect-windows W and --expect-jobs J (the counts eta-refuter-2 approved)");
  const require = createRequire(process.cwd() + "/");
  const { neon } = require("@neondatabase/serverless");
  const sql = neon(dbUrl());
  const run = (q) => Object.assign([q], { raw: [q] });
  if (!commit) {
    const qs = [STEP0, ...EVIDENCE.map(([, q]) => q)];
    const res = await sql.transaction(qs.map((q) => sql(run(q))), { readOnly: true });
    console.log(JSON.stringify({ ev: "step0", mode: "select_only", at: new Date().toISOString(), step0_rows: res[0], step0_total: res[0].reduce((x, r) => x + r.n, 0),
      ...Object.fromEntries(EVIDENCE.map(([n], i) => [n, res[i + 1]])) }));
    return 0;
  }
  const st = commitStatements(expW, expJ);
  try {
    const res = await sql.transaction(st.map((q) => sql(run(q))));
    const last = res[res.length - 1][0];
    console.log(JSON.stringify({ ev: "commit", ok: true, at: new Date().toISOString(), expect_windows: expW, expect_jobs: expJ, windows: last.windows, reopened_parked: last.reopened_parked, refunded_jobs: expJ }));
    return 0;
  } catch (e) {
    console.log(JSON.stringify({ ev: "commit", ok: false, written: false, error_class: /recovery3_guard/.test(String(e?.message)) ? "guard" : "error", detail: redact(e?.message) }));
    return 5;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === new URL(import.meta.url).pathname) {
  main().then((c) => process.exit(c), (e) => { console.log(JSON.stringify({ ev: "fatal", detail: redact(e?.message) })); process.exit(1); });
}

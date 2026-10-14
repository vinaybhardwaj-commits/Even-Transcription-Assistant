#!/usr/bin/env node
// Paced room_window feeder for the 20-22 Sep backlog (order 001-yoga-drain-3, 24 Sep 2026).
//
//   cd <an ETA checkout with node_modules> && node <this file> [--go]
//
// DEFAULT IS A DRY RUN: it reads production (SELECT only, via kit/neon-select.mjs, the same guarded helper every
// pane uses) and prints counts; it needs no token and submits nothing.  --go submits.
//
// WHAT IT DOES: keeps at most MAX_IN_FLIGHT (default and hard ceiling 3) room_window jobs queued+running, counted
// across EVERY actor, so the join service's one-at-a-time mutex is never queued deeper than the drain-join-busy wait
// can absorb.  Candidates come from SUBMIT-LIST-3.csv in rank order (likely-speech first); a window is submitted only
// if production says it is STILL closed, its room switch is ON, its subject attempts < 3 and no job for it is live,
// so the list can be stale and the feed stays correct.  It stops SUBMITTING at 07:30 IST (in-flight jobs finish on
// their own) and refuses to start submitting before 20:45 IST.
//
// SUBMIT PATH: scribe_job_submit kind=room_window via the Scribe MCP door (POST {APP_URL}/api/mcp) with a token that
// holds `invoke` and NOT `write` (see FINDINGS-3.md).  Token: env SCRIBE_FEEDER_TOKEN, else
// ~/.claude/secrets/night_feeder_token.  Never printed, never in argv.
//
// LOGS COUNTS ONLY: no window id, room id, job id, token or text ever reaches stdout or the log file.
//
// SAFETY: circuit breaker (3 of this run's last 6 settled jobs failed -> pause 15 min; a second trip exits 3);
// a window is submitted at most twice per run; exits 2 on a refused token; exits 4 after 3 consecutive submit errors.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const NEON_SELECT = process.env.NEON_SELECT ?? path.join(HERE, "../../kit/neon-select.mjs");
const LIST = process.env.FEEDER_LIST ?? path.join(HERE, "SUBMIT-LIST-3.csv");
const APP_URL = (process.env.APP_URL ?? "https://www.evenscribe.app").replace(/\/$/, "");
const ACTOR = "night-feeder";
const MAX_IN_FLIGHT = Math.min(3, Math.max(1, Number(process.env.MAX_IN_FLIGHT ?? 3) || 3));
const POLL_MS = Math.max(5_000, Number(process.env.FEEDER_POLL_MS ?? 45_000));
const STALE_MIN = 20;
const IST_MIN = 330;

// ---- pure helpers (unit-tested in feeder-3.test.mjs) ------------------------------------------------------------
export const istMinutes = (d) => (((d.getUTCHours() * 60 + d.getUTCMinutes() + IST_MIN) % 1440) + 1440) % 1440;
/** Inside the feed window [start, stop) IST, wrapping midnight.  Defaults 20:45 -> 07:30. */
export function inFeedWindow(d, startMin = 20 * 60 + 45, stopMin = 7 * 60 + 30) {
  const m = istMinutes(d);
  return startMin <= stopMin ? m >= startMin && m < stopMin : m >= startMin || m < stopMin;
}
export function parseCsv(text) {
  const [head, ...lines] = text.trim().split(/\r?\n/);
  const cols = head.split(",");
  return lines.map((l) => Object.fromEntries(l.split(",").map((v, i) => [cols[i], v])));
}
/** Next ids to submit: rank order, only eligible, at most `slots`, at most 2 submissions per window per run. */
export function pickNext(ranked, eligible, submittedCount, slots) {
  const out = [];
  for (const id of ranked) {
    if (out.length >= slots) break;
    if (eligible.has(id) && (submittedCount.get(id) ?? 0) < 2) out.push(id);
  }
  return out;
}
/** Breaker: true when at least 3 of the last 6 settled outcomes failed. */
export const breakerTripped = (settled) => settled.slice(-6).filter((o) => o === "failed").length >= 3;
export function errorClass(e) {
  if (!e) return "none";
  if (/join_already_running/.test(e)) return "join_busy";
  const m = /^([a-z_]+):\s*([a-z_]+)?/.exec(e);
  return !m ? "other" : m[1] === "room_window_failed" ? (m[2] ?? "room_window_failed") : m[1];
}

// ---- IO ---------------------------------------------------------------------------------------------------------
const ETA_DIR = process.cwd();
const sel = (q) => JSON.parse(execFileSync("node", [NEON_SELECT, q], { cwd: ETA_DIR, encoding: "utf8", maxBuffer: 64 << 20 }));
const logDir = path.join(os.homedir(), "feeder-logs");
const log = (o) => {
  const line = JSON.stringify({ ts: new Date().toISOString(), ...o });
  console.log(line);
  try { fs.mkdirSync(logDir, { recursive: true }); fs.appendFileSync(path.join(logDir, "feeder-3.log"), line + "\n"); } catch { /* console copy stands */ }
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const idOk = (s) => /^bw_[a-z0-9_]+$/.test(s);

function token() {
  let t = process.env.SCRIBE_FEEDER_TOKEN ?? "";
  for (const f of ["night_feeder_token", "scribe_feeder_token"]) {
    if (t.trim()) break;
    const p = path.join(os.homedir(), ".claude/secrets", f);
    if (fs.existsSync(p)) t = fs.readFileSync(p, "utf8");
  }
  if (!t.trim()) throw new Error("no SCRIBE_FEEDER_TOKEN and no ~/.claude/secrets/night_feeder_token");
  return t.trim();
}

async function submit(windowId, tok) {
  const body = { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "scribe_job_submit", arguments: { kind: "room_window", args: { window_id: windowId, origin: APP_URL, actor: ACTOR, via: "mcp" } } } };
  const r = await fetch(`${APP_URL}/api/mcp`, { method: "POST", signal: AbortSignal.timeout(30_000), headers: { "content-type": "application/json", accept: "application/json", authorization: `Bearer ${tok}` }, body: JSON.stringify(body) });
  if (r.status === 401 || r.status === 403) return { fatal: "auth" };
  if (!r.ok) return { err: `http_${r.status}` };
  const j = await r.json().catch(() => null);
  const sc = j?.result?.structuredContent;
  if (j?.result?.isError || !sc?.ok || !/^[A-Za-z0-9_-]{1,64}$/.test(String(sc.job_id ?? ""))) return { err: /^[a-z_]{1,40}$/.test(String(sc?.error ?? "")) ? sc.error : "refused" };
  return { jobId: sc.job_id };
}

const flight = () => sel(`SELECT count(*) FILTER (WHERE status = 'queued')::int AS queued, count(*) FILTER (WHERE status = 'running')::int AS running, count(*) FILTER (WHERE status = 'running' AND updated_at < now() - interval '${STALE_MIN} minutes')::int AS stale FROM scribe_job WHERE kind = 'room_window' AND status IN ('queued', 'running')`)[0];

function eligibleIds(ids) {
  const out = new Set();
  for (let i = 0; i < ids.length; i += 80) {
    const chunk = ids.slice(i, i + 80).map((x) => `'${x}'`).join(",");
    const rows = sel(`SELECT w.id FROM bench_window w JOIN bench_session s ON s.id = w.session_id JOIN room r ON r.id = s.room_id AND r.transcript_enabled = TRUE LEFT JOIN stt_subject_job sj ON sj.subject_type = 'bench_window' AND sj.subject_id = w.id AND sj.tier = 'asr' WHERE w.id IN (${chunk}) AND w.state = 'closed' AND w.grid_aligned = TRUE AND w.room_day_id IS NOT NULL AND COALESCE(sj.attempts, 0) < 3 AND NOT EXISTS (SELECT 1 FROM scribe_job j WHERE j.kind = 'room_window' AND j.args->>'window_id' = w.id AND j.status IN ('queued', 'running'))`);
    for (const r of rows) out.add(r.id);
  }
  return out;
}

const settle = (ids) => (ids.length ? sel(`SELECT id, status, error FROM scribe_job WHERE id IN (${ids.map((x) => `'${x}'`).join(",")}) AND status IN ('done', 'failed', 'cancelled')`) : []);

// ---- main -------------------------------------------------------------------------------------------------------
async function main() {
  const go = process.argv.includes("--go");
  const anytime = process.env.FEEDER_ALLOW_ANYTIME === "1";
  const ranked = parseCsv(fs.readFileSync(LIST, "utf8")).map((r) => r.window_id).filter(idOk);
  const tok = go ? token() : "";
  log({ ev: "start", mode: go ? "go" : "dry_run", list: ranked.length, max_in_flight: MAX_IN_FLIGHT, window: "20:45-07:30 IST" });

  if (!go) {
    const f = flight();
    const el = eligibleIds(ranked);
    log({ ev: "dry_run", list: ranked.length, eligible_now: el.size, in_flight: f.queued + f.running, stale: f.stale, would_submit_now: pickNext(ranked, el, new Map(), Math.max(0, MAX_IN_FLIGHT - f.queued - f.running)).length });
    return 0;
  }

  const submitted = new Map();
  const own = new Set();
  const settled = [];
  const errs = {};
  let done = 0, failed = 0, trips = 0, consecErr = 0, waitedOnce = false;

  for (;;) {
    const now = new Date();
    if (!anytime && !inFeedWindow(now)) {
      if (istMinutes(now) >= 7 * 60 + 30 && istMinutes(now) < 20 * 60 + 45 && submitted.size === 0) {
        if (!waitedOnce) { log({ ev: "waiting_for_20_45_ist" }); waitedOnce = true; }
        await sleep(POLL_MS); continue;
      }
      log({ ev: "stop_time_reached", submitted: [...submitted.values()].reduce((a, b) => a + b, 0), done, failed, error_classes: errs });
      return 0;
    }
    // settle what we submitted
    const fin = settle([...own]);
    for (const j of fin) {
      own.delete(j.id);
      if (j.status === "done") { done++; settled.push("done"); } else { failed++; settled.push("failed"); const c = errorClass(j.error); errs[c] = (errs[c] ?? 0) + 1; }
    }
    if (fin.length && breakerTripped(settled)) {
      trips++;
      log({ ev: "breaker_tripped", trips, last6_failed: settled.slice(-6).filter((x) => x === "failed").length, error_classes: errs });
      if (trips >= 2) return 3;
      settled.length = 0;
      await sleep(15 * 60_000); continue;
    }
    const f = flight();
    const inFlight = f.queued + f.running;
    const slots = MAX_IN_FLIGHT - inFlight;
    let sent = 0, remaining = null;
    if (slots > 0) {
      const el = eligibleIds(ranked);
      remaining = el.size;
      for (const id of pickNext(ranked, el, submitted, slots)) {
        const r = await submit(id, tok);
        if (r.fatal) { log({ ev: "auth_refused" }); return 2; }
        if (r.err) { errs[`submit_${r.err}`] = (errs[`submit_${r.err}`] ?? 0) + 1; if (++consecErr >= 3) { log({ ev: "submit_errors_abort", error_classes: errs }); return 4; } continue; }
        consecErr = 0; sent++;
        submitted.set(id, (submitted.get(id) ?? 0) + 1);
        own.add(r.jobId);
      }
      if (remaining === 0 && inFlight === 0 && own.size === 0) { log({ ev: "list_exhausted", done, failed, error_classes: errs }); return 0; }
    }
    log({ ev: "tick", in_flight: inFlight, stale: f.stale, sent, eligible_left: remaining, own_open: own.size, done, failed, error_classes: errs });
    await sleep(POLL_MS);
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().then((c) => process.exit(c), (e) => { log({ ev: "fatal", class: String(e?.message ?? e).slice(0, 60).replace(/[A-Za-z0-9_-]{24,}/g, "<redacted>") }); process.exit(1); });
}

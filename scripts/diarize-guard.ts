/**
 * scripts/diarize-guard.ts — runs the diarize-leak guard's decision (lib/overnight-translate/diarize-guard.ts)
 * against the real Mini: finds eta-diarize's pid, reads its memory via `top` (Fable, 22 Sep 07:25: `ps -o rss`
 * lied — 1.17 GB against top's 11 GB), reads whether the overnight driver has a job in flight from the
 * driver's own log, and restarts eta-diarize through launchd when the decision says to. Run every 300 s by
 * launchd (com.vinaybhardwaj.eta-diarize-guard). Replaces diarize-guard.sh, backed up as
 * diarize-guard.sh.bak-scribe3-0725 — that script's "no connection for 60 s" test never fired (the bench
 * worker keeps 2 ESTABLISHED keep-alive sockets to :8001 even while idle).
 *
 *   node diarize-guard.mjs [THRESHOLD_GB]   default 6
 *
 * Build:  node_modules/.bin/esbuild scripts/diarize-guard.ts --bundle --platform=node --format=esm \
 *           --banner:js="import {createRequire} from 'module'; const require = createRequire(import.meta.url);" \
 *           --outfile=$HOME/overnight-translate/diarize-guard.mjs
 *
 * STATE (overStreak / firstOverAtMs) is written to STATE_FILE between runs, since each launchd fire is a
 * fresh process with no memory of the last one. Every log line is plain text, one per run, the same shape
 * the shell guard used — counts and the decision's own fields only, never the driver log's content.
 */
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync, appendFileSync } from "node:fs";
import {
  parseTopMemGb, driverInFlight, guardDecision, EMPTY_STATE, type GuardState, type DriverLogEvent,
} from "../lib/overnight-translate/diarize-guard";

const LABEL = "uk.llmvinayminihome.eta-diarize";
const PID_PATTERN = "eta-diarize/.venv/bin/uvicorn";
const HOME = process.env.HOME ?? "";
const LOG_FILE = process.env.DIARIZE_GUARD_LOG_FILE ?? `${HOME}/overnight-translate/diarize-guard.log`;
const STATE_FILE = process.env.DIARIZE_GUARD_STATE_FILE ?? `${HOME}/overnight-translate/diarize-guard-state.json`;
const DRIVER_LOG_FILE = process.env.DIARIZE_GUARD_DRIVER_LOG ?? `${HOME}/overnight-translate/overnight-translate.log`;
// A few hundred lines comfortably spans one job's submit..finish (or several, at a future higher
// concurrency) without reading the whole, ever-growing driver log on every 300 s tick.
const DRIVER_LOG_TAIL_LINES = 200;

const stamp = (): string => new Date().toISOString();
function log(line: string): void {
  const l = `${stamp()} guard: ${line}`;
  console.log(l);
  try { appendFileSync(LOG_FILE, l + "\n"); } catch { /* console already has it */ }
}

function readState(): GuardState {
  try {
    const raw = JSON.parse(readFileSync(STATE_FILE, "utf8")) as unknown;
    if (raw && typeof raw === "object") {
      const r = raw as Record<string, unknown>;
      if (typeof r.overStreak === "number" && (r.firstOverAtMs === null || typeof r.firstOverAtMs === "number")) {
        return { overStreak: r.overStreak, firstOverAtMs: r.firstOverAtMs as number | null };
      }
    }
  } catch { /* first run, or an unreadable/corrupt file — start clean, never crash on it */ }
  return EMPTY_STATE;
}
function writeState(s: GuardState): void {
  try { writeFileSync(STATE_FILE, JSON.stringify(s)); } catch (e) { log(`state write failed: ${(e as NodeJS.ErrnoException).code ?? "error"}`); }
}

/** pgrep exits 1 (no match) as routine, not an error. */
function findPid(): string | null {
  try {
    const out = execFileSync("pgrep", ["-f", PID_PATTERN], { encoding: "utf8" }).trim();
    return out.split("\n")[0]?.trim() || null;
  } catch {
    return null;
  }
}

function readMemGb(pid: string): number | null {
  try {
    const out = execFileSync("top", ["-l", "1", "-pid", pid, "-stats", "mem"], { encoding: "utf8", timeout: 10_000 });
    return parseTopMemGb(out);
  } catch (e) {
    log(`top failed: ${(e as NodeJS.ErrnoException).code ?? "error"}`);
    return null;
  }
}

/** Fails safe to "not in flight" on any read/parse trouble — the two hard ceilings are what still catch a
 *  leak if this read is wrong, so this function never needs to fail closed the way the pressure gate does. */
function readDriverInFlight(): boolean {
  let raw: string;
  try {
    raw = readFileSync(DRIVER_LOG_FILE, "utf8");
  } catch {
    return false; // no driver log at all: nothing is submitting jobs against diarize right now
  }
  const lines = raw.split("\n").filter((l) => l.trim() !== "").slice(-DRIVER_LOG_TAIL_LINES);
  const events: DriverLogEvent[] = [];
  for (const l of lines) {
    try { events.push(JSON.parse(l) as DriverLogEvent); } catch { /* a partial trailing write mid-append; skip it */ }
  }
  return driverInFlight(events);
}

function main(): void {
  const thresholdArg = process.argv[2];
  const thresholdGb = thresholdArg ? Number(thresholdArg) : 6;
  if (!Number.isFinite(thresholdGb) || thresholdGb <= 0) {
    log(`refused: bad threshold arg ${JSON.stringify(thresholdArg)}`);
    process.exitCode = 2;
    return;
  }

  const pid = findPid();
  if (!pid) { log(`no diarize process found (label ${LABEL}), nothing to check`); return; }

  const rssGb = readMemGb(pid);
  if (rssGb === null) { log(`pid ${pid} memory unreadable, nothing to do`); return; }

  const inFlight = readDriverInFlight();
  const state = readState();
  const d = guardDecision({ nowMs: Date.now(), rssGb, thresholdGb, inFlight, state });
  writeState(d.nextState);

  if (d.action === "skip") {
    log(`diarize pid ${pid} RSS ${rssGb.toFixed(2)}GB threshold ${thresholdGb}GB in_flight=${inFlight} -> ${d.reason}`);
    return;
  }
  try {
    execFileSync("launchctl", ["kickstart", "-k", `gui/${process.getuid ? process.getuid() : ""}/${LABEL}`], { encoding: "utf8" });
    log(`RESTARTED ${LABEL} — pid was ${pid}, RSS ${rssGb.toFixed(2)}GB (threshold ${thresholdGb}GB), reason=${d.reason}, in_flight=${inFlight}`);
  } catch (e) {
    log(`launchctl kickstart failed: ${(e as NodeJS.ErrnoException).code ?? "error"}`);
  }
}

main();

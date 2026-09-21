/**
 * lib/overnight-translate/driver.ts — the overnight transcribe + translate loop.
 *
 * ONE WINDOW AT A TIME: pick → submit a `room_window` job (translate:true) → poll it to a terminal state →
 * next. Concurrency stays 1 (V: "do not raise concurrency"); the Mini's Ollama already serialises
 * translation (`OLLAMA_NUM_PARALLEL=1`) and the join service is a single-job container, so a second job
 * in flight would only queue against the first.
 *
 * WHAT IT DECLINES TO DO, and where each is enforced:
 *   - submit outside 21:30-07:10 IST ............ hours.ts `maySubmit`, checked before EVERY submit;
 *   - submit while the watchdog says STOP or disk is under 40 GB ... gate.ts, checked before EVERY submit;
 *   - retry a refused credential ................ door.ts `fatal`, the run stops on the first one;
 *   - keep feeding a failing pipe ............... CONSECUTIVE_FAILURE_LIMIT, then stop;
 *   - retry a window that failed this run ....... `tried`, and MAX_FAILED_JOBS across runs (select.ts);
 *   - wait on a job past its deadline ........... WINDOW_DEADLINE_MS, then stop: one stuck job is a
 *                                                 pipeline fault, not a reason to pile more on;
 *   - stand by a job into clinic hours .......... `closedHoursOver`: the driver stops WAITING (it cannot
 *                                                 cancel: the router has no cancel endpoint) and logs the
 *                                                 job id it left running;
 *   - trust a `done` that produced no English ... the ENGLISH CANARY: after each finished job it asks the
 *                                                 store whether the window has text but no English, and counts
 *                                                 that as a failure. It is what turns a deploy that predates this
 *                                                 branch (whose room_window parseArgs DROPS `translate` without a
 *                                                 word), or a routing change to a synchronous engine, into a stop
 *                                                 after 5 windows instead of a whole night of nothing.
 *
 * PER-WINDOW ARGS: `translate: true` always; `switch_override: true` ONLY when the window's room has its own
 * Transcript switch off (V's ruling of 21 Sep 2026: those rooms are in scope, and their switch is not
 * touched). A room whose switch is on does not get the override — least privilege per job. The override needs
 * `write` scope (V, 16:00 ruling), so the driver's token must carry read, invoke AND write.
 *
 * LOGGING: one JSON object per event, ids / counts / durations / closed codes only. No transcript text is
 * ever read by this module, and the token is never in scope here (door.ts holds it).
 */
import { maySubmit, msUntilMaySubmit, closedHoursOver } from "./hours";
import type { GateDecision } from "./gate";
import type { Store, Summary, Candidate } from "./select";
import type { Door, RoomWindowSubmit } from "./door";

/** Stamped on every job's args and, via the token, on its row: who asked. */
export const ACTOR = "overnight-translate";
export const GATE_POLL_MS = 30_000;
export const STATUS_POLL_MS = 10_000;
/** A window's job normally settles in 2-10 min (router p90 384 s, max 613 s, plus join, probe and poll steps). */
export const WINDOW_DEADLINE_MS = 25 * 60_000;
export const CONSECUTIVE_FAILURE_LIMIT = 5;
export const DEFERRED_LIMIT = 5;
export const DEFAULT_MAX_FAILED_JOBS = 2;

export type FatalCode =
  | "mcp_not_configured" | "mcp_auth_refused" | "mcp_scope_refused" | "door_unreachable" | "too_many_failures" | "job_stuck" | "store_unreadable";
export type StopReason = "backlog_empty" | "submit_window_closed" | "closed_hours_over" | "aborted" | "fatal" | "limit" | "dry_run_done";

export type Deps = {
  store: Store;
  door: Door;
  /** The app origin the job's segment step posts its cues to. Must be the canonical host (see the launcher). */
  origin: string;
  now(): number;
  sleep(ms: number, signal: AbortSignal): Promise<void>;
  /** Watchdog + disk, read fresh on every call. */
  gate(): GateDecision;
  log(ev: Record<string, unknown>): void;
};

export type RunSummary = {
  started: number;
  done: number;
  failed: number;
  refused: number;
  abandoned: number;
  /** `done` jobs whose English check could not be read: not counted as done, counted toward the failure stop. */
  unverified: number;
  overridden: number;
  fatal: FatalCode | null;
  stop: StopReason;
};

const EMPTY_SUMMARY: Summary = {
  fixture_windows: 0, fixture_need_asr: 0, fixture_need_english_only: 0, fixture_skipped_native_english: 0, fixture_skipped_proxy: 0,
  backlog_remaining: 0, backlog_in_transcript_off_rooms: 0, excluded_closed_hours: 0, excluded_no_speakers: 0,
};

const newSummary = (): RunSummary => ({ started: 0, done: 0, failed: 0, refused: 0, abandoned: 0, unverified: 0, overridden: 0, fatal: null, stop: "backlog_empty" });

/** The args of the job for one candidate. Exported so a test pins exactly what goes on the wire. */
export function jobArgsFor(c: Candidate, origin: string): RoomWindowSubmit {
  return {
    window_id: c.window_id,
    origin,
    actor: ACTOR,
    via: "mcp",
    translate: true,
    ...(c.room_transcript_on ? {} : { switch_override: true as const }),
  };
}

export async function runOvernight(deps: Deps, mode: "run" | "dry-run", limit: number, signal: AbortSignal): Promise<RunSummary> {
  const s = newSummary();
  const tried = new Set<string>();
  // The counts are for the log; not being able to read them must not stop a night that can still select windows.
  let summary: Summary;
  try {
    summary = await deps.store.summarize();
  } catch (e) {
    deps.log({ event: "summary_unavailable", error_name: (e as Error)?.name ?? "Error" });
    summary = EMPTY_SUMMARY;
  }
  deps.log({ event: "night_start", mode, limit: limit > 0 ? limit : null, ...summary });

  // ── DRY RUN: what WOULD be submitted, in order. Nothing is sent, so no clock or gate applies. ─────────
  if (mode === "dry-run") {
    for (let n = 1; n <= limit; n += 1) {
      let c: Candidate | null;
      try {
        c = await deps.store.next(tried);
      } catch (e) {
        deps.log({ event: "store_error", error_name: (e as Error)?.name ?? "Error" });
        s.fatal = "store_unreadable";
        break;
      }
      if (!c) break;
      tried.add(c.window_id);
      deps.log({
        event: "plan", n, window_id: c.window_id, room_day_id: c.room_day_id, klass: c.klass, has_run: c.has_run,
        room_transcript_on: c.room_transcript_on, switch_override: !c.room_transcript_on, translate: true,
      });
    }
    s.stop = "dry_run_done";
    deps.log({ event: "night_end", mode, ...s });
    return s;
  }

  let heldReason: string | null = null;
  let deferredStreak = 0;
  let consecutiveFailures = 0;
  let storeFailures = 0;
  let nightBegun = false;   // true once we have been inside the submit window in THIS process
  let waitLogged = false;

  const fatal = (code: FatalCode, extra: Record<string, unknown> = {}) => {
    s.fatal = code;
    s.stop = "fatal";
    deps.log({ event: "fatal", code, ...extra });
  };

  outer: while (!signal.aborted) {
    if (limit > 0 && s.started >= limit) { s.stop = "limit"; break; }

    // ── 1. THE CLOCK. Before every submit, never remembered. ──────────────────────────────────────────
    const t = deps.now();
    if (!maySubmit(t)) {
      if (nightBegun) { s.stop = closedHoursOver(t) ? "closed_hours_over" : "submit_window_closed"; break; }
      // Started in the day: wait for tonight, in bounded steps so an abort or a clock jump is noticed.
      if (!waitLogged) { deps.log({ event: "waiting_for_closed_hours", ms: msUntilMaySubmit(t) }); waitLogged = true; }
      await deps.sleep(Math.min(60_000, Math.max(1_000, msUntilMaySubmit(t))), signal);
      continue;
    }
    nightBegun = true;

    // ── 2. THE GATES: watchdog + disk. Before every submit, read fresh. ───────────────────────────────
    const g = deps.gate();
    if (!g.go) {
      if (g.reason !== heldReason) deps.log({ event: "gate_hold", reason: g.reason });
      heldReason = g.reason;
      await deps.sleep(GATE_POLL_MS, signal);
      continue;
    }
    if (heldReason !== null) { deps.log({ event: "gate_go" }); heldReason = null; }

    // ── 3. THE NEXT WINDOW ────────────────────────────────────────────────────────────────────────────
    let c: Candidate | null;
    try {
      c = await deps.store.next(tried);
      storeFailures = 0;
    } catch (e) {
      // A database blip is not a verdict on any window. Retry a few times, then stop with a name. Only the
      // error's NAME is logged: its message can carry SQL or connection detail.
      storeFailures += 1;
      deps.log({ event: "store_error", error_name: (e as Error)?.name ?? "Error", streak: storeFailures });
      if (storeFailures >= DEFERRED_LIMIT) { fatal("store_unreadable", { streak: storeFailures }); break; }
      await deps.sleep(GATE_POLL_MS, signal);
      continue;
    }
    if (!c) { s.stop = "backlog_empty"; break; }

    // ── 3b. RE-CHECK, IMMEDIATELY BEFORE THE CALL ─────────────────────────────────────────────────────
    // Steps 1 and 2 were read BEFORE the selection above, and selection is a database round trip (the
    // fixture query alone joins a lateral over ~100 rows). A slow query that starts at 07:09:58 must not
    // become a submit at 07:10:23, and a watchdog STOP that lands during it must be seen. So the two
    // decisions are taken again here, on the far side of the wait, and the candidate is dropped (it is not
    // marked tried) if either has turned.
    if (!maySubmit(deps.now())) continue;                 // the top of the loop names the stop
    const g2 = deps.gate();
    if (!g2.go) {
      if (g2.reason !== heldReason) deps.log({ event: "gate_hold", reason: g2.reason });
      heldReason = g2.reason;
      await deps.sleep(GATE_POLL_MS, signal);             // no busy loop against the database
      continue;
    }

    // ── 4. SUBMIT ─────────────────────────────────────────────────────────────────────────────────────
    const args = jobArgsFor(c, deps.origin);
    const sub = await deps.door.submitRoomWindow(args, signal);
    if (!sub.ok) {
      if (sub.kind === "fatal") { fatal(sub.code, { window_id: c.window_id }); break; }
      if (sub.kind === "deferred") {
        deferredStreak += 1;
        deps.log({ event: "door_deferred", code: sub.code, streak: deferredStreak });
        if (deferredStreak >= DEFERRED_LIMIT) { fatal("door_unreachable", { streak: deferredStreak }); break; }
        await deps.sleep(GATE_POLL_MS, signal);
        continue;
      }
      // refused: about THIS window. Recorded, not retried this run, and it counts toward the failure limit.
      tried.add(c.window_id);
      s.refused += 1;
      consecutiveFailures += 1;
      deps.log({ event: "window_refused", window_id: c.window_id, code: sub.code });
      if (consecutiveFailures >= CONSECUTIVE_FAILURE_LIMIT) { fatal("too_many_failures", { consecutive: consecutiveFailures }); break; }
      continue;
    }
    deferredStreak = 0;
    tried.add(c.window_id);
    s.started += 1;
    if (!c.room_transcript_on) s.overridden += 1;
    const t0 = deps.now();
    deps.log({
      event: "window_submitted", window_id: c.window_id, job_id: sub.job_id, klass: c.klass, has_run: c.has_run,
      room_transcript_on: c.room_transcript_on, switch_override: !c.room_transcript_on,
    });

    // ── 5. POLL THE ONE JOB TO A TERMINAL STATE ───────────────────────────────────────────────────────
    let terminal: { status: "done" | "failed" | "cancelled"; step: string | null; error_code: string | null } | null = null;
    while (!terminal) {
      if (signal.aborted) { s.stop = "aborted"; s.abandoned += 1; deps.log({ event: "left_running", window_id: c.window_id, job_id: sub.job_id, why: "aborted" }); break outer; }
      const st = await deps.door.jobStatus(sub.job_id, signal);
      if (!st.ok) {
        if (st.kind === "fatal") { fatal(st.code, { window_id: c.window_id, job_id: sub.job_id }); break outer; }
        if (st.kind === "refused") { terminal = { status: "failed", step: null, error_code: st.code }; break; }
        deferredStreak += 1;
        if (deferredStreak >= DEFERRED_LIMIT) { fatal("door_unreachable", { streak: deferredStreak, job_id: sub.job_id }); break outer; }
      } else {
        deferredStreak = 0;
        if (st.status === "done" || st.status === "failed" || st.status === "cancelled") {
          terminal = { status: st.status, step: st.step, error_code: st.error_code };
          break;
        }
      }
      const now = deps.now();
      if (closedHoursOver(now)) {
        // Into clinic hours. The job cannot be cancelled; stop waiting and say exactly which one is left.
        s.abandoned += 1; s.stop = "closed_hours_over";
        deps.log({ event: "left_running", window_id: c.window_id, job_id: sub.job_id, why: "closed_hours_over" });
        break outer;
      }
      if (now - t0 > WINDOW_DEADLINE_MS) { s.abandoned += 1; fatal("job_stuck", { window_id: c.window_id, job_id: sub.job_id }); break outer; }
      await deps.sleep(STATUS_POLL_MS, signal);
    }
    if (!terminal) break;

    const wall_s = Math.round((deps.now() - t0) / 1000);
    if (terminal.status === "done") {
      // THE ENGLISH CANARY. `done` says the job ran; it does not say it made English. A window with text and no
      // `transcript_english` is a failure of THIS driver's purpose, counted like any other.
      // IT FAILS CLOSED (V's engineering ruling, 21 Sep 2026, on the Refuter's flag). If the check itself cannot be read,
      // nothing is known about the window, so it is NOT recorded as done, it does NOT reset the counter, and it counts
      // toward the same consecutive-failure stop. Otherwise a database blip would switch off the only bound that caps a
      // silent no-English night at five windows. The window is left unverified (a separate count, `unverified`) and its
      // id and room-day are logged, so a later run can look at it again (see the report on how).
      let english: "ok" | "missing" | "unavailable" = "ok";
      let checkError = "";
      try {
        english = await deps.store.englishCheck(c.window_id);
      } catch (e) {
        english = "unavailable";
        checkError = (e as Error)?.name ?? "Error"; // the NAME only: the message can carry SQL or connection detail
      }
      if (english !== "ok") {
        consecutiveFailures += 1;
        if (english === "missing") {
          s.failed += 1;
          deps.log({ event: "window_failed", window_id: c.window_id, job_id: sub.job_id, status: "done", step: terminal.step, error_code: "no_english", wall_s });
        } else {
          s.unverified += 1;
          deps.log({ event: "english_check_unavailable", window_id: c.window_id, room_day_id: c.room_day_id, job_id: sub.job_id, error_name: checkError, consecutive: consecutiveFailures });
        }
        if (consecutiveFailures >= CONSECUTIVE_FAILURE_LIMIT) { fatal("too_many_failures", { consecutive: consecutiveFailures }); break; }
        continue;
      }
      s.done += 1;
      consecutiveFailures = 0;
      deps.log({ event: "window_done", window_id: c.window_id, job_id: sub.job_id, klass: c.klass, wall_s });
    } else {
      s.failed += 1;
      consecutiveFailures += 1;
      deps.log({ event: "window_failed", window_id: c.window_id, job_id: sub.job_id, status: terminal.status, step: terminal.step, error_code: terminal.error_code, wall_s });
      if (consecutiveFailures >= CONSECUTIVE_FAILURE_LIMIT) { fatal("too_many_failures", { consecutive: consecutiveFailures }); break; }
    }
  }

  if (signal.aborted && s.stop === "backlog_empty") s.stop = "aborted";
  deps.log({ event: "night_end", mode, ...s });
  return s;
}

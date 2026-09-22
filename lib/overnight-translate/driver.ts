/**
 * lib/overnight-translate/driver.ts — the overnight transcribe + translate loop.
 *
 * UP TO `ETA_OVERNIGHT_CONCURRENCY` WINDOWS AT ONCE (default 1, the original behaviour). Fable's order
 * of 22 Sep 2026, 07:00, after the diarize-leak thrash was fixed and the real cost was found to be serial
 * work, not memory: the router already runs `ETA_MAX_INFLIGHT=3` in parallel, so up to 3 jobs in flight
 * matches what the router can actually do at once. ALL gates (clock, pressure/disk, the failure and
 * deferred streaks, the English canary) are checked fresh before EVERY submit, exactly as with one job —
 * concurrency changes how many SLOTS are filled, never what a slot is allowed to do. The consecutive-
 * failure counter is ONE counter shared across every slot, updated in the order completions actually
 * land (see `finishSlot`), so a bad run trips the same 5-in-a-row stop whether the failures come from one
 * job or from several finishing close together.
 *
 * WHAT IT DECLINES TO DO, and where each is enforced:
 *   - count a JOIN-SERVICE COLLISION as a real failure ... the audio-join service has its own single-job mutex
 *                                                 (lib/bench-join.ts), so a second simultaneous join for a
 *                                                 DIFFERENT window is refused `join_already_running` — a fact
 *                                                 about TIMING, not about the window. Retried up to
 *                                                 JOIN_RETRY_LIMIT times after a short backoff (V, 22 Sep 2026
 *                                                 08:20, option b), not counted toward the failure stop unless
 *                                                 the retries themselves run out. THE RETRY RESUBMIT IS NOT
 *                                                 EXEMPT FROM THE CLOCK OR THE WATCHDOG GATE: both are re-checked
 *                                                 on the far side of the backoff sleep, exactly as they are
 *                                                 before every other submit (Refuter finding 1, 22 Sep 2026). If
 *                                                 either says stop, the retry is abandoned — logged as
 *                                                 `window_deferred` (reason `clock_closed` or `gate_hold`), which
 *                                                 is neither a failure nor a touch of `consecutiveFailures`. When
 *                                                 the retries themselves run out, that is logged as `window_failed`
 *                                                 with `error_code: "join_contention_exhausted"` — a real failure
 *                                                 for the run's tally, but kept OUT of the canary's consecutive-
 *                                                 failure count (Refuter finding 2). A FATAL answer (401/403,
 *                                                 `mcp_scope_refused`) on the retry submit stops the run the same
 *                                                 way a fatal answer on any other submit does (Refuter finding 3);
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
/** A join-service collision (`join_already_running`) is retried this many times before it counts as a real
 *  failure. Bounded, per V's ruling: a window that keeps colliding is no longer just unlucky timing. */
export const JOIN_RETRY_LIMIT = 2;
/** Backoff before a retry, so a resubmit right into the same contention is less likely — the collision is
 *  between this driver and whatever ELSE just joined audio (the cron auto-drain, an admin route), and both
 *  sides retrying instantly only raises the odds of colliding again. */
export const JOIN_RETRY_DELAY_MS = 5_000;
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
  /** Job attempts that collided with the join service's own mutex and were retried — not counted as failures
   *  unless JOIN_RETRY_LIMIT ran out (that outcome lands in `failed`, like any other exhausted retry). */
  joinDeferred: number;
  /** A join-retry resubmit that was abandoned because the clock closed or the watchdog/disk gate said stop
   *  during the backoff — not a failure, not a touch of the consecutive-failure count; the window is simply
   *  left for a later run (`window_deferred`, reason `clock_closed` or `gate_hold`). */
  windowDeferred: number;
  overridden: number;
  fatal: FatalCode | null;
  stop: StopReason;
};

const EMPTY_SUMMARY: Summary = {
  fixture_windows: 0, fixture_need_asr: 0, fixture_need_english_only: 0, fixture_skipped_native_english: 0, fixture_skipped_proxy: 0,
  retry_pending: 0, parked: 0, backlog_remaining: 0, backlog_in_transcript_off_rooms: 0, excluded_closed_hours: 0, excluded_no_speakers: 0,
};

const newSummary = (): RunSummary => ({
  started: 0, done: 0, failed: 0, refused: 0, abandoned: 0, unverified: 0, joinDeferred: 0, windowDeferred: 0, overridden: 0, fatal: null, stop: "backlog_empty",
});

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

export const DEFAULT_CONCURRENCY = 1;

export async function runOvernight(
  deps: Deps, mode: "run" | "dry-run", limit: number, signal: AbortSignal, concurrency: number = DEFAULT_CONCURRENCY,
): Promise<RunSummary> {
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
        event: "plan", n, window_id: c.window_id, room_day_id: c.room_day_id, klass: c.klass, has_run: c.has_run, attempt: c.attempt,
        room_transcript_on: c.room_transcript_on, switch_override: !c.room_transcript_on, translate: true,
      });
    }
    s.stop = "dry_run_done";
    deps.log({ event: "night_end", mode, ...s });
    return s;
  }

  const n = Math.max(1, Math.floor(concurrency) || 1);

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

  type Slot = { c: Candidate; t0: number; joinRetries: number };
  // Insertion order = submission order, which JS Maps preserve — the order `finishSlot` and the poll batch
  // below iterate a tick's completions in, so a shared `consecutiveFailures` counts interleaved completions
  // deterministically (the order they actually landed), not the order slots were opened.
  const active = new Map<string, Slot>();

  /** Every job still in `active` is left running server-side; the driver only stops WATCHING it. */
  function abandonAll(why: string): void {
    for (const [jobId, a] of active) {
      s.abandoned += 1;
      deps.log({ event: "left_running", window_id: a.c.window_id, job_id: jobId, why });
    }
    active.clear();
  }

  /**
   * One finished job (`done` / `failed` / `cancelled`), exactly the original per-window ending — the English
   * canary included — just callable per slot instead of inline. Returns true if this finish set `s.fatal`
   * (too_many_failures, or a fatal answer on a join-contention retry submit), so the caller knows to stop
   * filling and drain.
   */
  async function finishSlot(
    jobId: string, a: Slot, terminal: { status: "done" | "failed" | "cancelled"; step: string | null; error_code: string | null; joinContended: boolean },
  ): Promise<boolean> {
    active.delete(jobId);

    // A JOIN-SERVICE COLLISION: a fact about timing, not about the window. Retry it — under the bound — rather
    // than spend one of the run's consecutive-failure slots on contention that has nothing to do with this
    // window's content. Not attempted for `done`/`cancelled`; only a `failed` job can carry this signal.
    if (terminal.status === "failed" && terminal.joinContended) {
      if (a.joinRetries < JOIN_RETRY_LIMIT) {
        await deps.sleep(JOIN_RETRY_DELAY_MS, signal);

        // THE SAME TWO GATES EVERY OTHER SUBMIT CHECKS (driver.ts's own steps 1 and 2), re-read on the far
        // side of the backoff sleep — real time the retry itself just spent. A clock that closed, or a
        // watchdog/disk gate that said STOP, while this retry waited is not a fact about THIS window, so it
        // is not a failure and it does not touch `consecutiveFailures`: the retry is simply abandoned and the
        // window is left for a later run to re-pick (Refuter finding 1, 22 Sep 2026).
        if (!maySubmit(deps.now())) {
          s.windowDeferred += 1;
          deps.log({ event: "window_deferred", window_id: a.c.window_id, job_id: jobId, reason: "clock_closed", retry: a.joinRetries + 1 });
          return false;
        }
        const g = deps.gate();
        if (!g.go) {
          s.windowDeferred += 1;
          deps.log({ event: "window_deferred", window_id: a.c.window_id, job_id: jobId, reason: "gate_hold", retry: a.joinRetries + 1 });
          return false;
        }

        const sub = await deps.door.submitRoomWindow(jobArgsFor(a.c, deps.origin), signal);
        if (sub.ok) {
          s.joinDeferred += 1;
          deps.log({ event: "window_join_deferred", window_id: a.c.window_id, job_id: jobId, retry_job_id: sub.job_id, retry: a.joinRetries + 1 });
          active.set(sub.job_id, { c: a.c, t0: deps.now(), joinRetries: a.joinRetries + 1 });
          return false;
        }
        // A FATAL answer on the RETRY submit (401/403, `mcp_scope_refused`) is exactly what it would be on
        // any other submit: every window would fail the credential the same way, so the run stops here —
        // NOT counted as a window failure (Refuter finding 3, 22 Sep 2026).
        if (sub.kind === "fatal") {
          fatal(sub.code, { window_id: a.c.window_id, job_id: jobId });
          return true;
        }
        // The RETRY submit itself was refused or deferred: retries are exhausted from here, same as running
        // the bound out below.
      }

      // JOIN CONTENTION EXHAUSTED (Refuter finding 2, 22 Sep 2026): a distinct, non-generic outcome — this
      // window's fate was decided by contention timing, not by anything about the window's own content — so
      // it is recorded as a real failure for the run's tally, but kept OUT of the canary's consecutive-
      // failure count (unlike a generic `window_failed`, which does count toward it).
      const wall_s = Math.round((deps.now() - a.t0) / 1000);
      s.failed += 1;
      deps.log({ event: "window_failed", window_id: a.c.window_id, job_id: jobId, status: terminal.status, step: terminal.step, error_code: "join_contention_exhausted", wall_s });
      return false;
    }

    // A FOREIGN CANCEL (Fable, 22 Sep 2026 21:10, ETA-OVERNIGHT-FATALS-ROOTCAUSE): a `cancelled` terminal that
    // THIS driver did not ask for — it never calls `scribe_job_cancel` on its own jobs (door.ts exposes no
    // cancel method at all; a test asserts the door calls only submit and status). The 16:21 and 19:43 IST
    // fatals were an admin-route serial loop and a direct-SQL canceller outside the app cancelling OUR jobs
    // and this driver counting each as its own failure. A cancel we did not ask for is a fact about someone
    // ELSE's action, not about this window's content, so — exactly like `unverified` — it is neither a
    // failure nor a touch of `consecutiveFailures`, and the window is left for a later run to re-pick.
    if (terminal.status === "cancelled") {
      s.windowDeferred += 1;
      deps.log({ event: "window_deferred", window_id: a.c.window_id, job_id: jobId, reason: "foreign_cancel" });
      return false;
    }

    const wall_s = Math.round((deps.now() - a.t0) / 1000);
    if (terminal.status === "done") {
      // THE ENGLISH CANARY. `done` says the job ran; it does not say it made English. A window with text and no
      // `transcript_english` is a failure of THIS driver's purpose, counted like any other.
      // IT FAILS CLOSED (V's engineering ruling, 21 Sep 2026, on the Refuter's flag). If the check itself cannot be read,
      // nothing is known about the window, so it is NOT recorded as done, it does NOT reset the counter, and it counts
      // toward the same consecutive-failure stop. Otherwise a database blip would switch off the only bound that caps a
      // silent no-English night at five windows. The window is left unverified (a separate count, `unverified`) and its
      // id, room-day and attempt number are logged. A LATER run re-picks it by itself (select.ts, the canary retry: up to
      // RETRY_MAX_ATTEMPTS attempts in all, then parked and counted, never called done).
      let english: "ok" | "missing" | "unavailable" = "ok";
      let checkError = "";
      try {
        english = await deps.store.englishCheck(a.c.window_id);
      } catch (e) {
        english = "unavailable";
        checkError = (e as Error)?.name ?? "Error"; // the NAME only: the message can carry SQL or connection detail
      }
      if (english !== "ok") {
        consecutiveFailures += 1;
        if (english === "missing") {
          s.failed += 1;
          deps.log({ event: "window_failed", window_id: a.c.window_id, job_id: jobId, status: "done", step: terminal.step, error_code: "no_english", attempt: a.c.attempt, wall_s });
        } else {
          s.unverified += 1;
          deps.log({ event: "english_check_unavailable", window_id: a.c.window_id, room_day_id: a.c.room_day_id, job_id: jobId, error_name: checkError, attempt: a.c.attempt, consecutive: consecutiveFailures });
        }
        if (consecutiveFailures >= CONSECUTIVE_FAILURE_LIMIT) { fatal("too_many_failures", { consecutive: consecutiveFailures }); return true; }
        return false;
      }
      s.done += 1;
      consecutiveFailures = 0;
      deps.log({ event: "window_done", window_id: a.c.window_id, job_id: jobId, klass: a.c.klass, wall_s });
      return false;
    }
    s.failed += 1;
    consecutiveFailures += 1;
    deps.log({ event: "window_failed", window_id: a.c.window_id, job_id: jobId, status: terminal.status, step: terminal.step, error_code: terminal.error_code, wall_s });
    if (consecutiveFailures >= CONSECUTIVE_FAILURE_LIMIT) { fatal("too_many_failures", { consecutive: consecutiveFailures }); return true; }
    return false;
  }

  outer: while (true) {
    if (signal.aborted) { abandonAll("aborted"); s.stop = "aborted"; break; }
    if (limit > 0 && s.started >= limit && active.size === 0) { s.stop = "limit"; break; }

    // ── FILL: open slots up to `n`, one candidate at a time, each with its own fresh clock+gate check. ──
    // A submission this pass counts as progress (see `progressed` below); a slot left open because the
    // clock/gate/backlog/door said no is NOT an error — it just means this pass filled fewer than `n`.
    let progressed = false;
    fill: while (active.size < n && !(limit > 0 && s.started >= limit)) {
      // ── 1. THE CLOCK. Before every submit, never remembered. ──────────────────────────────────────
      const t = deps.now();
      if (!maySubmit(t)) {
        if (active.size > 0) break fill;   // jobs in flight: stop trying to fill, go poll them instead
        if (nightBegun) { s.stop = closedHoursOver(t) ? "closed_hours_over" : "submit_window_closed"; break outer; }
        // Started in the day: wait for tonight, in bounded steps so an abort or a clock jump is noticed.
        if (!waitLogged) { deps.log({ event: "waiting_for_closed_hours", ms: msUntilMaySubmit(t) }); waitLogged = true; }
        await deps.sleep(Math.min(60_000, Math.max(1_000, msUntilMaySubmit(t))), signal);
        continue outer;
      }
      nightBegun = true;

      // ── 2. THE GATES: watchdog + disk. Before every submit, read fresh. ───────────────────────────
      const g = deps.gate();
      if (!g.go) {
        if (g.reason !== heldReason) deps.log({ event: "gate_hold", reason: g.reason });
        heldReason = g.reason;
        if (active.size > 0) break fill;
        await deps.sleep(GATE_POLL_MS, signal);
        continue outer;
      }
      if (heldReason !== null) { deps.log({ event: "gate_go" }); heldReason = null; }

      // ── 3. THE NEXT WINDOW ──────────────────────────────────────────────────────────────────────
      let c: Candidate | null;
      try {
        c = await deps.store.next(tried);
        storeFailures = 0;
      } catch (e) {
        // A database blip is not a verdict on any window. Retry a few times, then stop with a name. Only the
        // error's NAME is logged: its message can carry SQL or connection detail.
        storeFailures += 1;
        deps.log({ event: "store_error", error_name: (e as Error)?.name ?? "Error", streak: storeFailures });
        if (storeFailures >= DEFERRED_LIMIT) { fatal("store_unreadable", { streak: storeFailures }); break outer; }
        if (active.size > 0) break fill;
        await deps.sleep(GATE_POLL_MS, signal);
        continue outer;
      }
      if (!c) {
        if (active.size === 0) { s.stop = "backlog_empty"; break outer; }
        break fill;   // nothing new to submit right now; the jobs in flight may still free a window later
      }

      // ── 3b. RE-CHECK, IMMEDIATELY BEFORE THE CALL ──────────────────────────────────────────────
      // Steps 1 and 2 were read BEFORE the selection above, and selection is a database round trip (the
      // fixture query alone joins a lateral over ~100 rows). A slow query that starts at 07:09:58 must not
      // become a submit at 07:10:23, and a watchdog STOP that lands during it must be seen. So the two
      // decisions are taken again here, on the far side of the wait, and the candidate is dropped (it is not
      // marked tried) if either has turned — this fill pass simply stops early.
      if (!maySubmit(deps.now())) break fill;
      const g2 = deps.gate();
      if (!g2.go) {
        if (g2.reason !== heldReason) deps.log({ event: "gate_hold", reason: g2.reason });
        heldReason = g2.reason;
        // n=1 (nothing else in flight): sleep GATE_POLL_MS right here, exactly as the single-job original did
        // ("no busy loop against the database"). n>1 with other jobs running: just stop filling and go poll
        // them instead — STATUS_POLL_MS will pace the next attempt, and sleeping here would delay watching them.
        if (active.size === 0) { await deps.sleep(GATE_POLL_MS, signal); continue outer; }
        break fill;
      }

      // ── 4. SUBMIT ───────────────────────────────────────────────────────────────────────────────
      const args = jobArgsFor(c, deps.origin);
      const sub = await deps.door.submitRoomWindow(args, signal);
      if (!sub.ok) {
        if (sub.kind === "fatal") { fatal(sub.code, { window_id: c.window_id }); break outer; }
        if (sub.kind === "deferred") {
          deferredStreak += 1;
          deps.log({ event: "door_deferred", code: sub.code, streak: deferredStreak });
          if (deferredStreak >= DEFERRED_LIMIT) { fatal("door_unreachable", { streak: deferredStreak }); break outer; }
          break fill;
        }
        // refused: about THIS window. Recorded, not retried this run, and it counts toward the failure limit.
        tried.add(c.window_id);
        s.refused += 1;
        consecutiveFailures += 1;
        deps.log({ event: "window_refused", window_id: c.window_id, code: sub.code });
        if (consecutiveFailures >= CONSECUTIVE_FAILURE_LIMIT) { fatal("too_many_failures", { consecutive: consecutiveFailures }); break outer; }
        continue fill;   // try another candidate in the same fill pass
      }
      deferredStreak = 0;
      tried.add(c.window_id);
      s.started += 1;
      if (!c.room_transcript_on) s.overridden += 1;
      const t0 = deps.now();
      deps.log({
        event: "window_submitted", window_id: c.window_id, job_id: sub.job_id, klass: c.klass, has_run: c.has_run, attempt: c.attempt,
        room_transcript_on: c.room_transcript_on, switch_override: !c.room_transcript_on,
      });
      active.set(sub.job_id, { c, t0, joinRetries: 0 });
      progressed = true;
    }

    if (signal.aborted) { abandonAll("aborted"); s.stop = "aborted"; break; }
    if (active.size === 0) continue;   // fill made no progress and left nothing running: re-evaluate from the top

    // ── 5. POLL EVERY JOB IN FLIGHT ────────────────────────────────────────────────────────────────
    // The first poll of a freshly filled slot happens with NO sleep first (matches n=1: `door.jobStatus` is
    // called immediately after submit). A sleep only happens when a whole pass makes no progress at all —
    // nothing filled and nothing finished — so as not to spin against the door.
    const entries = [...active.entries()];
    const results = await Promise.all(entries.map(([jobId]) => deps.door.jobStatus(jobId, signal)));

    let anyStillRunning = false;
    for (let i = 0; i < entries.length; i += 1) {
      const [jobId, a] = entries[i]!;
      const st = results[i]!;
      let terminal: { status: "done" | "failed" | "cancelled"; step: string | null; error_code: string | null; joinContended: boolean } | null = null;
      if (!st.ok) {
        if (st.kind === "fatal") { fatal(st.code, { window_id: a.c.window_id, job_id: jobId }); active.delete(jobId); abandonAll("fatal"); break outer; }
        if (st.kind === "refused") {
          terminal = { status: "failed", step: null, error_code: st.code, joinContended: false };
        } else {
          deferredStreak += 1;
          if (deferredStreak >= DEFERRED_LIMIT) { fatal("door_unreachable", { streak: deferredStreak, job_id: jobId }); active.delete(jobId); abandonAll("fatal"); break outer; }
          anyStillRunning = true;
        }
      } else {
        deferredStreak = 0;
        if (st.status === "done" || st.status === "failed" || st.status === "cancelled") {
          terminal = { status: st.status, step: st.step, error_code: st.error_code, joinContended: st.join_contended };
        } else {
          anyStillRunning = true;
        }
      }

      if (terminal) {
        progressed = true;
        const stopNow = await finishSlot(jobId, a, terminal);
        if (stopNow) { abandonAll("fatal"); break outer; }
        continue;
      }

      // Still running (or a deferred status read that did not exceed the streak): the same two checks the
      // single-job loop made on every "still running" tick, before it slept.
      const now = deps.now();
      if (closedHoursOver(now)) {
        // Into clinic hours. The job cannot be cancelled; stop waiting on ALL of them and say which are left.
        abandonAll("closed_hours_over");
        s.stop = "closed_hours_over";
        break outer;
      }
      if (now - a.t0 > WINDOW_DEADLINE_MS) {
        s.abandoned += 1;   // the stuck job itself, same as the single-job original
        fatal("job_stuck", { window_id: a.c.window_id, job_id: jobId });
        active.delete(jobId);
        abandonAll("fatal");   // any OTHER jobs still in flight
        break outer;
      }
    }

    if (!progressed && anyStillRunning) await deps.sleep(STATUS_POLL_MS, signal);
  }

  if (signal.aborted && s.stop === "backlog_empty") s.stop = "aborted";
  deps.log({ event: "night_end", mode, ...s });
  return s;
}

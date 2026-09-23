/**
 * lib/room-window-reaper-core.ts — PURE decisions for the room_window "orphaned transcribing"
 * sweep (23 Sep 2026, L1 orphaned-transcribing-windows order).
 *
 * THE BUG THIS CLOSES. `drainRoomWindow` claims a window by setting bench_window.state =
 * 'transcribing', then hands it to a room_window job. Every ordinary failure path the job itself
 * takes runs through room-drain.ts's own `recordFailure`, which moves the window back to
 * 'closed' (or parks it 'failed' at DRAIN_MAX_ATTEMPTS) — so the window is always visible again
 * afterwards. But a room_window job can also leave `scribe_job` in a TERMINAL state WITHOUT ever
 * reaching that code: `cancelJob()` (a generic job-system primitive with no idea what kind it is
 * cancelling) sets status='cancelled' and touches nothing else; the runner's own
 * failures_exceeded/unknown_kind paths set status='failed' the same way. Either one leaves
 * bench_window stuck at 'transcribing' forever — not 'closed' (so the auto-drain scan, which
 * only offers `state = 'closed'`, will never re-offer it) and not 'failed' either (so nothing
 * flags it for attention). 56 real windows were found stuck this way on 23 Sep, ALL via a manual
 * cancel (error 'cancelled_for_serial_retry'/'cancelled_for_serial_force_drain', or no error at
 * all) enforcing one-drainer-at-a-time concurrency — a legitimate operational action the job
 * system has no path to recover from on its own.
 *
 * WHAT THIS DOES NOT TOUCH. A window whose latest room_window job is 'done' is left alone and
 * flagged as an anomaly rather than acted on — 'done' should mean roomWindowFinish already moved
 * the window to 'transcribed' in the same step, so a 'transcribing' row beside a 'done' job is a
 * different, stranger problem than the one this sweep exists for, and closing it back over a real
 * transcript would be a genuine data loss risk. A window whose latest room_window job is still
 * 'queued' or 'running' is not a candidate at all (that IS the in-horizon, still-live case).
 *
 * MIRRORS `recordFailure` (lib/stt/room-drain.ts) exactly, so a reaped window is indistinguishable
 * from one that failed and was recorded normally: attempts < DRAIN_MAX_ATTEMPTS -> bench_window
 * 'closed', stt_subject_job 'queued'; attempts >= DRAIN_MAX_ATTEMPTS -> bench_window 'failed',
 * stt_subject_job 'failed'. UNLIKE `recordFailure`, this never increments `attempts` — a
 * cancelled-for-serial-retry job never actually made and lost a real attempt at transcribing the
 * window, so counting it as one would burn down the retry budget for a failure that never
 * happened.
 */

export const ROOM_WINDOW_REAP_STALE_MINUTES = 15;
export const ROOM_WINDOW_REAP_CAP = 200;
/** Matches DRAIN_MAX_ATTEMPTS in lib/stt/room-drain.ts. Duplicated, not imported: this module is
 *  DB-free and dependency-free by design (see the file header), and the bound is pinned by a test
 *  that reads the real constant, so the two cannot silently drift apart. */
export const DRAIN_MAX_ATTEMPTS = 3;

export type RoomWindowJobStatus = "queued" | "running" | "done" | "failed" | "cancelled" | null;

/** One candidate as the sweep's SELECT returns it: a bench_window stuck in 'transcribing',
 *  joined to its LATEST room_window job (by created_at) and its stt_subject_job attempts. */
export interface RoomWindowReapCandidate {
  window_id: string;
  /** ISO or Date — when the LATEST job reached a terminal state (finished_at); null if no job
   *  was ever created for this window, or it has none finished (still queued/running). */
  job_finished_at: string | Date | null;
  job_status: RoomWindowJobStatus;
  /** stt_subject_job.attempts for (bench_window, this window_id, tier='asr'); null if no row. */
  subject_attempts: number | null;
}

export interface RoomWindowReapDecision {
  window_id: string;
  next_bench_state: "closed" | "failed";
  next_subject_state: "queued" | "failed";
  reason: "job_cancelled" | "job_failed_without_bookkeeping";
}

const toMs = (v: string | Date | null | undefined): number | null => {
  if (v == null || v === "") return null;
  const t = v instanceof Date ? v.getTime() : Date.parse(String(v));
  return Number.isFinite(t) ? t : null;
};

/**
 * PURE — which stuck 'transcribing' windows get reaped, and to what.
 *
 * A candidate is reaped ONLY when its latest room_window job is 'cancelled' or 'failed' (a
 * terminal outcome that bypassed the ordinary bench_window bookkeeping) AND that job finished
 * more than ROOM_WINDOW_REAP_STALE_MINUTES ago — the buffer exists so a job cancelled seconds ago,
 * about to be immediately resubmitted by whatever cancelled it, is not raced. 'done' and
 * still-live (queued/running/null) jobs are never reaped; junk rows (no window_id) are skipped.
 * Capped, oldest-finished first so a long backlog drains in a stable order across repeated calls.
 */
export function decideRoomWindowReaps(
  rows: readonly RoomWindowReapCandidate[],
  now: Date | number,
  cap: number = ROOM_WINDOW_REAP_CAP,
): RoomWindowReapDecision[] {
  const nowMs = typeof now === "number" ? now : now.getTime();
  const staleBeforeMs = nowMs - ROOM_WINDOW_REAP_STALE_MINUTES * 60_000;
  const eligible = rows
    .filter((r): r is RoomWindowReapCandidate & { job_finished_at: string | Date } => {
      if (!r || typeof r.window_id !== "string" || !r.window_id) return false;
      if (r.job_status !== "cancelled" && r.job_status !== "failed") return false;
      const finishedMs = toMs(r.job_finished_at);
      if (finishedMs == null) return false;
      return finishedMs <= staleBeforeMs;
    })
    .sort((a, b) => (toMs(a.job_finished_at) ?? 0) - (toMs(b.job_finished_at) ?? 0));

  const out: RoomWindowReapDecision[] = [];
  for (const r of eligible) {
    if (out.length >= cap) break;
    const attempts = typeof r.subject_attempts === "number" && Number.isFinite(r.subject_attempts) ? r.subject_attempts : 0;
    const exhausted = attempts >= DRAIN_MAX_ATTEMPTS;
    out.push({
      window_id: r.window_id,
      next_bench_state: exhausted ? "failed" : "closed",
      next_subject_state: exhausted ? "failed" : "queued",
      reason: r.job_status === "cancelled" ? "job_cancelled" : "job_failed_without_bookkeeping",
    });
  }
  return out;
}

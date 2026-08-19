/**
 * lib/bench-resume-core.ts — PURE decision for the Room Bench remount resume
 * (ETA-REMOUNT-RESUME PRD v1.0, 20 Aug 2026; MCP PRD §8.5 rev 3e; decisions D1–D6).
 * No DB, no fetch, no clock: the caller passes `nowMs`.
 *
 * The server decides whether a reloaded kiosk may rejoin its room's open session
 * (GET /api/bench/sessions/active calls this). The window and the IST calendar are
 * the REAPER'S OWN — imported from lib/bench-reaper-core, never re-declared — so the
 * no-race argument holds by construction: resumable only under STALLED_BADGE_MINUTES
 * (10), reaped only over STALL_MINUTES (30). A paused session has no time test (D5);
 * only the day rollover ends it.
 *
 * Rules, in order (PRD §3.2):
 *   1. No candidate, or status 'ended'          → not resumable ("none" / "ended")
 *   2. started_at is not today in IST           → "previous_day"
 *   3. status 'paused'                          → resumable, no time test (D5)
 *   4. status 'recording' and the newest chunk across both streams (else started_at)
 *      is older than STALLED_BADGE_MINUTES      → "stalled"
 *   5. otherwise                                → resumable
 */

import {
  istDate,
  lastAudioMs,
  STALLED_BADGE_MINUTES,
  type BenchReapCandidate,
} from "./bench-reaper-core";

/** Same row shape the reaper's sweep SELECT returns (newest chunk per source, null when none). */
export type BenchResumeCandidate = BenchReapCandidate;

export type ResumeReason = "ok" | "none" | "stalled" | "previous_day" | "ended";

export interface ResumeDecision {
  resumable: boolean;
  reason: ResumeReason;
}

export function decideResume(
  candidate: BenchResumeCandidate | null | undefined,
  nowMs: number,
): ResumeDecision {
  // Rule 1 — nothing to rejoin.
  if (!candidate || typeof candidate.id !== "string" || !candidate.id) {
    return { resumable: false, reason: "none" };
  }
  if (candidate.status === "ended") return { resumable: false, reason: "ended" };
  // Rule 2 — day rollover (an unparseable started_at yields "" and lands here: fail-safe).
  if (istDate(candidate.started_at) !== istDate(nowMs)) {
    return { resumable: false, reason: "previous_day" };
  }
  // Rule 3 — paused: no time test (D5).
  if (candidate.status === "paused") return { resumable: true, reason: "ok" };
  // Rule 4 — recording gone quiet past the reaper's own badge window.
  if (candidate.status === "recording") {
    const last = lastAudioMs(candidate);
    if (last == null || nowMs - last > STALLED_BADGE_MINUTES * 60_000) {
      return { resumable: false, reason: "stalled" };
    }
  }
  // Rule 5.
  return { resumable: true, reason: "ok" };
}

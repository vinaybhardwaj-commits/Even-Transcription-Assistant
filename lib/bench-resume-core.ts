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
import { ACK_WAIT_MS, LISTENER_FRESH_MS } from "./bench-commands";

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

// ---------------------------------------------------------------------------
// Chunk numbering (D2) — the route and the kiosk run THESE, so the disjointness
// proof in tests/unit/bench-resume.test.ts is about the shipped functions.
// ---------------------------------------------------------------------------

const msOf = (v: string | Date | null | undefined): number | null => {
  if (v == null || v === "") return null;
  const t = v instanceof Date ? v.getTime() : Date.parse(String(v));
  return Number.isFinite(t) ? t : null;
};

/** The route's next_idx: highest stored chunk number + 1; a stream with no chunk returns 0. */
export function nextIdxFromMax(v: number | string | null | undefined): number {
  if (v === null || v === undefined || v === "") return 0;
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? Math.trunc(n) + 1 : 0;
}

/**
 * The kiosk's seeded starting number for one stream: the higher of the server's next_idx
 * and one more than the highest number in the kiosk's own unsent queue (pass -1 for an
 * empty queue). Never lower than either — counting from zero would write over the tape.
 */
export function seedStartIdx(serverNextIdx: number, localMaxIdx: number): number {
  const server = Number.isFinite(serverNextIdx) && serverNextIdx >= 0 ? Math.trunc(serverNextIdx) : 0;
  const local = Number.isFinite(localMaxIdx) ? Math.trunc(localMaxIdx) : -1;
  return Math.max(server, local + 1);
}

// ---------------------------------------------------------------------------
// Ordered handover between two tabs (FU2) — the new tab waits for the old tab
// to finish its last segment, then takes its numbers from a fresh answer.
// ---------------------------------------------------------------------------

/**
 * FU2a — a wait is needed only when a LIVE different tab holds the room: the listener row
 * carries another tab_id whose last poll is within LISTENER_FRESH_MS (the command bus's own
 * freshness window, imported — never a second number). A crashed tab stops polling, goes
 * stale, and never asks anyone to wait.
 */
export function decideHandoverPending(
  listener: { tab_id: string; last_poll_at: string | Date } | null | undefined,
  callerTabId: string | null | undefined,
  nowMs: number,
): boolean {
  if (!listener || typeof listener.tab_id !== "string" || !listener.tab_id) return false;
  if (callerTabId && listener.tab_id === callerTabId) return false;
  const polled = msOf(listener.last_poll_at);
  if (polled == null) return false;
  return nowMs - polled <= LISTENER_FRESH_MS;
}

/** FU2d — the wait is over once a kiosk_handover_complete event exists at or after `since`. */
export function hasHandoverCompleted(
  latestHandoverAt: string | Date | null | undefined,
  sinceMs: number,
): boolean {
  const t = msOf(latestHandoverAt);
  return t !== null && t >= sinceMs;
}

export type HandoverWaitDecision = "start" | "wait" | "timeout_start";

/**
 * FU2c — one wait-loop step. Never hangs: no live handover or a completed one starts at
 * once; a wait longer than ACK_WAIT_MS (the command bus's own ack window, imported) starts
 * anyway — a room that is not recording is worse than a number that might clash.
 */
export function decideHandoverWait(i: {
  handoverPending: boolean;
  handoverComplete: boolean;
  waitedMs: number;
}): HandoverWaitDecision {
  if (!i.handoverPending || i.handoverComplete) return "start";
  if (i.waitedMs >= ACK_WAIT_MS) return "timeout_start";
  return "wait";
}

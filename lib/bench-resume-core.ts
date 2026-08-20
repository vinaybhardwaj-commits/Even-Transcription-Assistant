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
// S3-2: the pure constants module, NOT bench-commands — this core is imported by the kiosk,
// and bench-commands carries the database module graph.
import { ACK_WAIT_MS, LISTENER_FRESH_MS, POLL_HIDDEN_MS } from "./bench-bus-constants";

/**
 * S3-1c / S4-2 — the proof-of-life probe: how long the rejoining tab waits for the losing
 * tab's kiosk_handover_started announce before concluding nobody is alive to hand over.
 * The displaced tab is the one that just LOST focus, so it polls hidden: one hidden poll
 * round is POLL_HIDDEN_MS (5,000 ms), and this leaves margin for one late round. Derived,
 * never typed twice. An ordinary reload does not pay this — the dying tab's pagehide beacon
 * sets tab_gone and the new tab starts at once. Only a CRASHED tab (no beacon, no announce)
 * pays the full probe and then starts: rare, and bounded. It is a probe, not a second stall
 * window — do not apply it anywhere else.
 */
export const HANDOVER_PROBE_MS = POLL_HIDDEN_MS + 1_500;

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
 * FU2a + S3-1b — a wait is needed only when a LIVE different tab holds THIS session. Both
 * must hold: the listener row carries another tab_id whose last poll is within
 * LISTENER_FRESH_MS (the command bus's own freshness window, imported — never a second
 * number), AND that listener's recording_session_id equals the session being rejoined. A
 * crashed tab stops polling and goes stale; a tab that polls but holds no session — or a
 * different one — cannot block anybody.
 */
export function decideHandoverPending(
  listener:
    | { tab_id: string; last_poll_at: string | Date; recording_session_id?: string | null }
    | null
    | undefined,
  callerTabId: string | null | undefined,
  sessionId: string,
  nowMs: number,
): boolean {
  if (!listener || typeof listener.tab_id !== "string" || !listener.tab_id) return false;
  if (callerTabId && listener.tab_id === callerTabId) return false;
  if (!sessionId || listener.recording_session_id !== sessionId) return false;
  const polled = msOf(listener.last_poll_at);
  if (polled == null) return false;
  return nowMs - polled <= LISTENER_FRESH_MS;
}

/**
 * S4-2 — has the tab named in the listener row announced its own death? An EXACT tab_id
 * match between the newest kiosk_tab_gone event's payload and the listener's current tab_id,
 * never a time comparison. A stale gone-event from an older tab does not count, and a
 * missing/malformed payload counts as "not gone" (fail safe: the caller then probes).
 */
export function isListenerTabGone(
  goneEventPayload: unknown,
  listenerTabId: string | null | undefined,
): boolean {
  if (!listenerTabId) return false;
  const p = (typeof goneEventPayload === "object" && goneEventPayload !== null
    ? goneEventPayload
    : {}) as { tab_id?: unknown };
  return typeof p.tab_id === "string" && p.tab_id.length > 0 && p.tab_id === listenerTabId;
}

/** FU2d — does a handover event (started or complete) exist at or after `since`? */
export function hasHandoverEventSince(
  latestEventAt: string | Date | null | undefined,
  sinceMs: number,
): boolean {
  const t = msOf(latestEventAt);
  return t !== null && t >= sinceMs;
}

export type HandoverWaitDecision = "start" | "wait" | "timeout_start";

/**
 * FU2c + S3-1c + S4-2 — one wait-loop step. Never hangs:
 *
 *   Fast path (tabGone): the tab named in the listener announced its own death (pagehide
 *   beacon) — the ordinary reload. Start at once: no probe, no wait, no timeout event.
 *   Stage one (no kiosk_handover_started seen): a live losing tab announces BEFORE it
 *   works; if nothing announces within HANDOVER_PROBE_MS, nobody is alive to hand over —
 *   start at once, and record NO timeout. Only a crashed tab (no beacon, no announce)
 *   lands here, and it pays exactly one bounded probe.
 *   Stage two (the announce arrived): wait up to ACK_WAIT_MS (the command bus's own ack
 *   window, imported) for kiosk_handover_complete; past it, start anyway with the timeout
 *   recorded — a room that is not recording is worse than a number that might clash.
 *
 * `waitedMs` is the caller's stage clock: ms since the wait began while in stage one, reset
 * to ms since the announce was first seen once in stage two.
 */
export function decideHandoverWait(i: {
  handoverPending: boolean;
  tabGone: boolean;
  handoverStarted: boolean;
  handoverComplete: boolean;
  waitedMs: number;
}): HandoverWaitDecision {
  if (!i.handoverPending || i.tabGone || i.handoverComplete) return "start";
  if (!i.handoverStarted) return i.waitedMs >= HANDOVER_PROBE_MS ? "start" : "wait";
  return i.waitedMs >= ACK_WAIT_MS ? "timeout_start" : "wait";
}

/**
 * S4-3 — the mic story a resume fallback writes, as a PAIR. The stored primary did not
 * open (absent) and the default did: a lost with no restored after it would leave the
 * admin mic badge reading on-backup for the rest of the day while the default microphone
 * records perfectly well. Both kinds are already in BENCH_EVENT_KINDS.
 */
export function primaryFallbackEvents(
  deviceId: string | null | undefined,
): Array<{ kind: "mic_primary_lost" | "mic_primary_restored"; payload: Record<string, unknown> }> {
  return [
    {
      kind: "mic_primary_lost",
      payload: { reason: "device_missing_on_resume", ...(deviceId ? { device_id: deviceId } : {}) },
    },
    { kind: "mic_primary_restored", payload: { reason: "default_on_resume" } },
  ];
}

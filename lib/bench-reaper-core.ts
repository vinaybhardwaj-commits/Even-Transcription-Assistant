/**
 * lib/bench-reaper-core.ts — PURE decisions for the Room Bench session janitor and the admin
 * "stalled" badge (ETA-BENCH-RESILIENCE PRD, Kickoff K-A v2, 19 Aug 2026; decisions R1–R3, R10–R11).
 * No DB, no clock: every function takes `now`.
 *
 * The two bugs this closes: a kiosk crash left a session "recording" for 5+ hours with nothing to
 * reap it, and the admin list showed a stale "recording" chip identical to a healthy one.
 *
 *   Rule 1 (R1/R3) — STALL: status = 'recording' and the newest chunk ACROSS BOTH SOURCES (primary
 *     and backup) is older than 30 min (zero chunks: started_at older than 30 min) → ended, with
 *     ended_at = the honest last-audio time (newest chunk, else started_at), NEVER now(). A session
 *     whose backup stream is still landing chunks is ALIVE — never reaped (the mic badges cover it).
 *   Rule 2 (R2) — DAY ROLLOVER: status <> 'ended' (recording OR paused), started_at's IST date is
 *     before today's IST date, AND no chunk from either source inside STALL_MINUTES → the same
 *     honest ending. The only rule that touches paused.
 *
 *     THE LIVENESS CONDITION IS NOT DECORATION. Until 23 Aug 2026 this rule was a CALENDAR TEST
 *     ALONE, and on the night of 22 August it ended bs_g3dwud4p — a deliberate overnight run on
 *     Home Office — at the IST midnight boundary while the kiosk was still recording. It stamped
 *     ended_at 19:00:36Z; the tape went on to write chunks until 00:58:46Z, six hours later, into
 *     a session the database considered finished. No audio was lost (108/108 primary and 108/108
 *     backup verified) but the row now claims a three-hour session holding nine hours of audio,
 *     and the operator monitor showed the room as NOT RECORDING while it was still capturing.
 *
 *     Rule 2 exists for a kiosk that CRASHED and left a session open across a night. A crashed
 *     kiosk stops producing chunks, so the liveness test costs that case nothing — it is reaped
 *     STALL_MINUTES after it goes quiet, exactly as before. What it can no longer do is end a
 *     session that is still writing audio. A clinic day sits inside one IST date and never met
 *     this rule either way; an overnight run does, and was the only thing it could harm.
 *   Badge (R10) — STALLED: a 'recording' session whose newest chunk across both sources is older
 *     than 10 min (zero chunks: started_at). K-B's mic badges take visual precedence.
 */

export const STALL_MINUTES = 30;
export const STALLED_BADGE_MINUTES = 10;
export const REAP_CAP = 50;
export const NOTE_STALL = "auto-ended: no chunks >30m (reaper)";
export const NOTE_ROLLOVER = "auto-ended: day rollover (reaper)";
export const IST_TZ = "Asia/Kolkata";

/** One candidate as the sweep's SELECT returns it (newest chunk per source, null when none). */
export interface BenchReapCandidate {
  id: string;
  status: string;
  started_at: string | Date;
  last_primary_at?: string | Date | null;
  last_backup_at?: string | Date | null;
  /** Arch #21 — for the alert only; absent in older callers and tests. */
  room_id?: string;
  room_name?: string | null;
}

export interface BenchReapDecision {
  id: string;
  rule: "stall" | "rollover";
  note: string;
  /** ISO — the honest last-audio time: newest chunk across both sources, else started_at. */
  ended_at: string;
}

const ms = (v: string | Date | null | undefined): number | null => {
  if (v == null || v === "") return null;
  const t = v instanceof Date ? v.getTime() : Date.parse(String(v));
  return Number.isFinite(t) ? t : null;
};

/** Newest chunk across BOTH sources, in ms; null when the session has no chunk at all. */
export function newestChunkMs(c: Pick<BenchReapCandidate, "last_primary_at" | "last_backup_at">): number | null {
  const p = ms(c.last_primary_at), b = ms(c.last_backup_at);
  if (p == null && b == null) return null;
  return Math.max(p ?? -Infinity, b ?? -Infinity);
}

/** The honest last-audio time: newest chunk across both sources, else started_at. */
export function lastAudioMs(c: BenchReapCandidate): number | null {
  return newestChunkMs(c) ?? ms(c.started_at);
}

/** YYYY-MM-DD of an instant in Asia/Kolkata (IST = UTC+05:30, no DST — computed arithmetically so
 *  the 18:30 UTC boundary is exact and needs no Intl data). */
export function istDate(v: string | Date | number): string {
  const t = typeof v === "number" ? v : ms(v);
  if (t == null) return "";
  return new Date(t + 5.5 * 3_600_000).toISOString().slice(0, 10);
}

/**
 * PURE — which candidates get reaped, and how. Rule 1 wins the note when both apply (the stall is
 * the concrete cause; the rollover is the calendar). Junk rows (no id / unparseable started_at) are
 * skipped, never a throw. Capped.
 */
export function decideBenchReaps(rows: readonly BenchReapCandidate[], now: Date | number, cap: number = REAP_CAP): BenchReapDecision[] {
  const nowMs = typeof now === "number" ? now : now.getTime();
  const today = istDate(nowMs);
  const out: BenchReapDecision[] = [];
  for (const r of rows) {
    if (out.length >= cap) break;
    if (!r || typeof r.id !== "string" || !r.id) continue;
    if (r.status === "ended") continue;
    const last = lastAudioMs(r);
    if (last == null) continue;
    const endedAt = new Date(last).toISOString();
    // Rule 1 — stall (recording only; ANY source landing a chunk inside 30 min keeps it alive)
    if (r.status === "recording" && nowMs - last > STALL_MINUTES * 60_000) {
      out.push({ id: r.id, rule: "stall", note: NOTE_STALL, ended_at: endedAt });
      continue;
    }
    // Rule 2 — day rollover (recording OR paused): started on an earlier IST date AND has
    // gone quiet. The liveness half was added 23 Aug 2026 after it stamped a session as
    // finished while it was still recording — see below.
    const startedDay = istDate(r.started_at);
    if (startedDay && startedDay < today && nowMs - last > STALL_MINUTES * 60_000) {
      out.push({ id: r.id, rule: "rollover", note: NOTE_ROLLOVER, ended_at: endedAt });
    }
  }
  return out;
}

/** R10 — the admin list's time-based STALLED badge: a 'recording' session whose newest chunk across
 *  both sources (else started_at) is older than 10 min. Never on ended / paused. */
export function isBenchStalled(
  s: { status: string; last_any_chunk_at?: string | Date | null; started_at?: string | Date | null },
  nowMs: number,
): boolean {
  if (s.status !== "recording") return false;
  const last = ms(s.last_any_chunk_at) ?? ms(s.started_at ?? null);
  if (last == null) return false;
  return nowMs - last > STALLED_BADGE_MINUTES * 60_000;
}

// ---------------------------------------------------------------------------
// Arch #21 — a reap is a capture-failure event, not a silent cleanup.
// ---------------------------------------------------------------------------

/** The outbox / bench_event kind a reap writes. */
export const SESSION_REAPED = "session_reaped";

/**
 * Clinic hours, IST, for the copy split only (08:00 up to 19:00). It decides which WORDS an alert
 * uses, never whether one is sent: every reap alerts. Dietary went dark at 17:23 and OPD4 at 12:26
 * — both inside this window. A named constant so a different clinic day is a one-line change.
 */
export const CLINIC_START_HOUR_IST = 8;
export const CLINIC_END_HOUR_IST = 19;

export type ReapPhase = "clinic_hours" | "end_of_day" | "overnight";

/** A reaped session's note, recognised on the ended row (chunk route, poll reply). */
export function isReaperNote(notes: string | null | undefined): boolean {
  return typeof notes === "string" && (notes.includes(NOTE_STALL) || notes.includes(NOTE_ROLLOVER));
}

/** PURE — when the audio stopped, in IST words. The rollover rule is by definition a session left open overnight. */
export function classifyReap(rule: BenchReapDecision["rule"], lastAudioIso: string): ReapPhase {
  if (rule === "rollover") return "overnight";
  const t = Date.parse(lastAudioIso);
  if (!Number.isFinite(t)) return "clinic_hours";   // unknown time: say the louder thing
  const hour = new Date(t + 5.5 * 3_600_000).getUTCHours();
  return hour >= CLINIC_START_HOUR_IST && hour < CLINIC_END_HOUR_IST ? "clinic_hours" : "end_of_day";
}

const istClock = (iso: string): string => {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return "an unknown time";
  const d = new Date(t + 5.5 * 3_600_000);
  return `${String(d.getUTCHours()).padStart(2, "0")}:${String(d.getUTCMinutes()).padStart(2, "0")} IST`;
};

/** PURE — the alert's words. Session id, room name, times and counts only; no patient data exists here. */
export function reapAlertCopy(input: { roomName: string; sessionId: string; rule: BenchReapDecision["rule"]; lastAudioIso: string }): {
  phase: ReapPhase; subject: string; body: string;
} {
  const phase = classifyReap(input.rule, input.lastAudioIso);
  const at = istClock(input.lastAudioIso);
  const { roomName: room, sessionId: sid } = input;
  if (phase === "clinic_hours") {
    return {
      phase,
      subject: `EvenScribe: ${room} recording was cut off during clinic hours`,
      body: `${room} session ${sid} was ended by the system during clinic hours: no audio arrived after ${at} (no chunks for over ${STALL_MINUTES} min). Capture has FAILED and nothing is recording now. Go and look, then press start.`,
    };
  }
  if (phase === "overnight") {
    return {
      phase,
      subject: `EvenScribe: ${room} left a session open overnight`,
      body: `${room} session ${sid} was still open after midnight and had gone quiet; last audio ${at}. It was closed by the system (day rollover). Press start for today's recording.`,
    };
  }
  return {
    phase,
    subject: `EvenScribe: ${room} recording ended after hours (no operator end)`,
    body: `${room} session ${sid} was closed by the system after hours: last audio ${at}, no chunks for over ${STALL_MINUTES} min and no operator end. Likely end of day; confirm the room went quiet on purpose.`,
  };
}

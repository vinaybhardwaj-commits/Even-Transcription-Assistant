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

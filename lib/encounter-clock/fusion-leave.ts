/**
 * lib/encounter-clock/fusion-leave.ts — consult boundaries for the timeline shadow table (epic #23 f, g).
 *
 * A consult ends when the patient leaves. The note being submitted (Pulse endConsult) ends the encounter,
 * which is a later fact, stored beside the consult and never used as the consult end. url_clear is a weak
 * close (the doctor left the patient page), not a patient leaving and not a note.
 *
 * START is the Pulse Start, 60 s early. It moves later only when a calibrated late-start answer says so
 * and doctor-plus-other speech does not already precede that point.
 *
 * END, first that applies, then clamped to the next Start minus 15 s when a next Start exists:
 *   1. a calibrated Jev end row (patient still in the room), unless other voices continue
 *   2. the last row of other-than-doctor speech, once the doctor is alone or the room goes quiet
 *   3. the next Start, as the fallback bound
 *   4. the 90-minute cap
 * Jev acts only through timeline-calibration. A raw confidence, including 0.95, does not place an end
 * when there is no fit or the fit says that bin was usually wrong.
 */
import type { Anchor } from "@/lib/encounter-clock/anchors";
import type { RowMeta } from "@/lib/encounter-clock/timeline";
import { calibratedP, jevActs, type Calibration } from "@/lib/encounter-clock/timeline-calibration";
import type { RowFact } from "@/lib/encounter-clock/fusion-timeline";

export const FUSION_LEAVE_VERSION = "encounter-clock-fusion-leave-v1";
export const PRE_START_MS = 60_000;
export const NEXT_START_BACKOFF_MS = 15_000;
export const CAP_MS = 90 * 60_000;
export const VETO_OTHER_S = 20;
export const QUIET_ROWS = 3;

export const LEAVE_REASONS = [
  "patient_left", "voices_left", "jev_end_row", "next_start_bound", "tape_off", "dead_mic", "cap",
  "no_patient_voice", "uncalibrated_jev", "acoustic_veto", "note_submitted", "late_start", "late_start_refused",
  "weak_url_clear", "zero_speech",
] as const;
export type LeaveReason = (typeof LEAVE_REASONS)[number];

export const LEAVE_CLOSED_BY = ["patient_left", "next_start", "tape_off", "dead_mic", "cap"] as const;
export type LeaveClosedBy = (typeof LEAVE_CLOSED_BY)[number];

export type LeaveReading = {
  end_row: string | null;
  end_signal: string | null;
  end_conf: number | null;
  late_start_p: number | null;
  kind: string | null;
  kind_conf: number | null;
};

export type LeaveInput = {
  anchor: Anchor;
  meta: readonly RowMeta[];
  rows: readonly RowFact[];
  other_speech: readonly { start_ms: number; end_ms: number }[];
  jev: LeaveReading | null;
  calibration: Calibration | null;
};

export type LeaveFusion = {
  start_ms: number;
  end_ms: number;
  confidence: number | null;
  raw_confidence: number | null;
  reason_codes: LeaveReason[];
  closed_by: LeaveClosedBy;
  encounter_end_ms: number | null;
  jev_used: boolean;
};

const END_SKIP = new Set(["continues_past_segment", "cannot_tell", "no_consultation_in_segment", "insufficient_evidence"]);
const QUIET = new Set(["quiet", "dead_mic", "tape_off"]);

function push(codes: LeaveReason[], c: LeaveReason): void {
  if (!codes.includes(c)) codes.push(c);
}

function lastOtherIn(spans: readonly { start_ms: number; end_ms: number }[], row: { start_ms: number; end_ms: number }): number | null {
  const ends = spans.filter((s) => s.end_ms > row.start_ms && s.start_ms < row.end_ms).map((s) => Math.min(s.end_ms, row.end_ms));
  return ends.length ? Math.max(...ends) : null;
}

export function fuseLeave(input: LeaveInput): LeaveFusion {
  const { anchor, rows, meta, jev, calibration } = input;
  const codes: LeaveReason[] = [];
  let start = anchor.start_ms - PRE_START_MS;

  if (jev?.late_start_p != null) {
    if (jevActs(jev.late_start_p, calibration)) {
      const firstBoth = rows.find((r) => r.doc_s > 0 && r.other_s > 0);
      if (firstBoth && firstBoth.start_ms >= anchor.start_ms && firstBoth.start_ms > start) {
        start = firstBoth.start_ms;
        push(codes, "late_start");
      } else push(codes, "late_start_refused");
    } else push(codes, "uncalibrated_jev");
  }

  const cap = Math.min(anchor.start_ms + CAP_MS, anchor.next_start_ms ?? Infinity);
  const otherRows = rows.filter((r) => r.other_s > 0);
  if (!otherRows.length && !(input.other_speech.length)) push(codes, "no_patient_voice");
  if (input.other_speech.length === 0 && rows.every((r) => (r.speech_s ?? 0) === 0)) push(codes, "zero_speech");

  let jevEnd: number | null = null;
  let jevUsed = false;
  const raw = jev?.end_conf ?? null;
  if (jev?.end_row && !END_SKIP.has(jev.end_row)) {
    if (!jevActs(raw, calibration)) push(codes, "uncalibrated_jev");
    else {
      const k = meta.findIndex((m) => m.t === jev.end_row);
      if (k >= 0) {
        const row = rows[k]!;
        const next = rows[k + 1];
        if (next && next.other_s >= VETO_OTHER_S && row.other_s > 0) push(codes, "acoustic_veto");
        else if (input.other_speech.length === 0) push(codes, "zero_speech");
        else {
          jevEnd = lastOtherIn(input.other_speech, row) ?? row.start_ms;
          jevUsed = true;
          push(codes, "jev_end_row");
          push(codes, "patient_left");
        }
      }
    }
  } else if (jev && raw != null && !jevActs(raw, calibration)) push(codes, "uncalibrated_jev");

  let end = start + 1;
  let closed: LeaveClosedBy = "cap";

  if (jevEnd != null && jevEnd > start) {
    end = jevEnd;
    closed = "patient_left";
  } else {
    const last = [...rows].reverse().find((r) => r.other_s > 0);
    const lastIdx = last ? rows.indexOf(last) : -1;
    const after = lastIdx >= 0 ? rows.slice(lastIdx + 1) : [];
    const doctorAlone = after.some((r) => r.other_s === 0 && r.doc_s > 0);
    const quietRun = after.length >= QUIET_ROWS && after.slice(0, QUIET_ROWS).every((r) => QUIET.has(r.sound));
    const tape = after.find((r) => r.sound === "tape_off" || r.sound === "dead_mic");
    if (last && (doctorAlone || quietRun || tape)) {
      end = lastOtherIn(input.other_speech, last) ?? last.end_ms;
      if (tape && !doctorAlone) {
        closed = tape.sound === "tape_off" ? "tape_off" : "dead_mic";
        push(codes, closed);
      } else {
        closed = "patient_left";
        push(codes, "voices_left");
        push(codes, "patient_left");
      }
    } else if (anchor.next_start_ms != null && anchor.next_start_ms - NEXT_START_BACKOFF_MS > start) {
      end = Math.min(anchor.next_start_ms - NEXT_START_BACKOFF_MS, cap);
      closed = "next_start";
      push(codes, "next_start_bound");
    } else {
      end = Number.isFinite(cap) ? cap : start + CAP_MS;
      closed = "cap";
      push(codes, "cap");
    }
  }

  if (anchor.next_start_ms != null) {
    const bound = anchor.next_start_ms - NEXT_START_BACKOFF_MS;
    if (end > bound && bound > start) {
      end = bound;
      if (closed !== "next_start") push(codes, "next_start_bound");
      closed = closed === "cap" ? "next_start" : closed;
    }
  }

  const encounter_end_ms = anchor.end_click_ms;
  if (encounter_end_ms != null) push(codes, "note_submitted");
  if (anchor.end_weak_kind === "url_clear") push(codes, "weak_url_clear");

  if (!(end > start)) end = start + 1;
  return {
    start_ms: start,
    end_ms: end,
    confidence: jevUsed ? calibratedP(raw, calibration) : null,
    raw_confidence: raw,
    reason_codes: codes,
    closed_by: closed,
    encounter_end_ms,
    jev_used: jevUsed,
  };
}

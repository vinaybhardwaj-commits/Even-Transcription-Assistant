/**
 * lib/encounter-clock/timeline-calibration-fit.ts — the fitted calibration the leave lane runs with (epic #23 f).
 *
 * This is the stored output of `fitCalibration(pairs)` (timeline-calibration.ts, default target 0.8).
 * The pairs are in tests/fixtures/timeline-leave-calibration-pairs.json (raw confidence + correct only:
 * no ids, no times, no text). A test refits them and checks they equal LEAVE_CALIBRATION, so this
 * constant cannot drift from its inputs.
 *
 * HOW THE PAIRS WERE MADE (12 Oct 2026).
 *   Fit days: 2–6 Oct 2026, every room-day with Pulse anchors (20 room-days). Held out: 7–10 Oct.
 *   Source: `scribe_encounter_shadow_run` with timeline:true on prod ff18043 (no fit), latest
 *   encounter_timeline_shadow run per room-day. One pair per consult where Jev named an end row
 *   (raw = end-row confidence) and Pulse has an explicit close (endConsult or url_clear).
 *   Jev end = the named 30 s row (end of row when it has speakers, start otherwise), as fuseLeave places it.
 *   correct = |Jev end - Pulse close| <= 90 s.
 *   194 pairs, 166 correct (0.856). Held-out 7–10 Oct: 209 pairs, 0.823 correct.
 *
 * CAVEAT. The Jev state carries the Pulse end_click / end_weak header, so Jev's end row largely follows
 * the Pulse close (median +57 s). Pulse close is the truth here because it is the best labelled boundary
 * we have; it is not an independent patient-leave label. Refit when patient-leave labels exist.
 *
 * Shadow only. Nothing here is read by note generation.
 */
import type { Calibration } from "@/lib/encounter-clock/timeline-calibration";

export const LEAVE_CALIBRATION_META = {
  fitted_on: "2026-10-02..2026-10-06",
  held_out: "2026-10-07..2026-10-10",
  truth: "pulse_explicit_close",
  tolerance_s: 90,
  pairs: 194,
  correct: 166,
  model: "jev-1.13.0",
  prompt_version: "u10-timeline-v1",
  fitted_at: "2026-10-12",
} as const;

export const LEAVE_CALIBRATION: Calibration = {
  method: "isotonic",
  bins: [
    { lo: 0, hi: 0.45, n: 39, p: 0.41025641025641024 },
    { lo: 0.45, hi: 0.57, n: 39, p: 0.9230769230769231 },
    { lo: 0.57, hi: 1.000001, n: 116, p: 0.9827586206896551 },
  ],
  act_at: 0.41025641025641024,
  target_precision: 0.8,
};

/**
 * lib/encounter-clock/timeline-view.ts — the read-only board for encounter_timeline_shadow (epic #23 i).
 *
 * PURE. Intervals in, counts and timings out. Agreement uses the E-7 match (overlap at least half the
 * shorter interval) against Pulse presence windows and against consult-index cuts. Pulse close kinds
 * are counted with endConsult split from url_clear. No text, no names.
 */
import { boundaryScore, closeCoverage, type Boundary } from "@/lib/encounter-clock/e7-boundaries";

export type TimelineConsult = {
  consult_key: string;
  start_ms: number;
  end_ms: number;
  confidence: number | null;
  reason_codes: string[];
  closed_by: string;
  encounter_end_ms: number | null;
  jev_used: boolean;
};

export type PulseWindow = {
  start_ms: number;
  end_ms: number;
  close_kind: string;
  end_clicked: boolean;
};

export type CutWindow = { start_ms: number; end_ms: number };

const asBoundary = (room_id: string, rows: readonly { start_ms: number; end_ms: number }[]): Boundary[] =>
  rows.filter((r) => r.end_ms > r.start_ms).map((r) => ({ start_ms: r.start_ms, end_ms: r.end_ms, room_id }));

/** PURE — shadow consults plus agreement against Pulse and the cutter, and Pulse close-reason coverage. */
export function timelineBoard(input: {
  room_id: string;
  consults: readonly TimelineConsult[];
  pulse: readonly PulseWindow[];
  cuts: readonly CutWindow[];
}) {
  const consults = input.consults.map((c) => ({
    consult_key: c.consult_key,
    start_ms: c.start_ms,
    end_ms: c.end_ms,
    confidence: c.confidence,
    reason_codes: [...c.reason_codes],
    closed_by: c.closed_by,
    encounter_end_ms: c.encounter_end_ms,
    jev_used: c.jev_used,
  }));
  return {
    consults,
    agreement: {
      pulse: boundaryScore(asBoundary(input.room_id, input.pulse), asBoundary(input.room_id, consults)),
      cuts: boundaryScore(asBoundary(input.room_id, input.cuts), asBoundary(input.room_id, consults)),
    },
    pulse_close: closeCoverage(input.pulse.map((p) => ({ close_kind: p.close_kind, end_clicked: p.end_clicked }))),
  };
}

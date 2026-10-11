/**
 * lib/room-access/encounter-timeline-read.ts — the only SQL for the timeline shadow view (epic #23 i).
 *
 * Three reads: the latest encounter_timeline_shadow run, Pulse presence windows (times and close_reason
 * only), and consult_index cuts. No speech text and no names. A database error is a sqlstate, not a throw.
 */
import { sql } from "@/lib/db";
import { CLOSE_KIND, istDayRange, type CloseKind } from "@/lib/encounter-clock/anchors";
import type { CutWindow, PulseWindow, TimelineConsult } from "@/lib/encounter-clock/timeline-view";

type Row = Record<string, unknown>;

export type TimelineLoad = {
  run: { id: string; model: string; calibration_sha: string } | null;
  consults: TimelineConsult[];
  pulse: PulseWindow[];
  cuts: CutWindow[];
  truncated: boolean;
};

const num = (v: unknown): number | null => (v == null || v === "" || Number.isNaN(Number(v)) ? null : Number(v));
const sqlState = (e: unknown): string => {
  const code = (e as { code?: unknown })?.code;
  return typeof code === "string" && /^[0-9A-Z]{5}$/.test(code) ? code : "unknown";
};

function pulseKind(reason: string): { close_kind: string; end_clicked: boolean } {
  if (Object.prototype.hasOwnProperty.call(CLOSE_KIND, reason)) {
    const close_kind: CloseKind = CLOSE_KIND[reason as keyof typeof CLOSE_KIND];
    return { close_kind, end_clicked: close_kind === "clicked_end" };
  }
  return { close_kind: "unknown", end_clicked: false };
}

/** Latest shadow run for the room-day, its consults, Pulse windows for the IST day, and consult cuts. */
export async function loadTimelineView(q: { room_id: string; room_day_id: string; ist_date: string; limit: number }): Promise<TimelineLoad | { error: string }> {
  try {
    const { from, to } = istDayRange(q.ist_date);
    const runs = (await sql`
      SELECT id, model, calibration_sha
        FROM encounter_timeline_shadow_run
       WHERE room_day_id = ${q.room_day_id}
       ORDER BY created_at DESC
       LIMIT 1
    `) as Row[];
    const run = runs[0] ? { id: String(runs[0].id), model: String(runs[0].model), calibration_sha: String(runs[0].calibration_sha) } : null;
    const consultRows = run ? (await sql`
      SELECT consult_key, start_ms::float8 AS start_ms, end_ms::float8 AS end_ms, confidence::float8 AS confidence,
             reason_codes, closed_by, encounter_end_ms::float8 AS encounter_end_ms, jev_used
        FROM encounter_timeline_shadow
       WHERE run_id = ${run.id}
       ORDER BY start_ms
       LIMIT ${q.limit}::int
    `) as Row[] : [];
    const pulseRows = (await sql`
      SELECT (EXTRACT(EPOCH FROM t_open) * 1000)::float8 AS start_ms,
             (EXTRACT(EPOCH FROM t_close) * 1000)::float8 AS end_ms,
             close_reason
        FROM eta_encounter_windows
       WHERE room_id = ${q.room_id}
         AND t_open >= ${from}::timestamptz
         AND t_open < ${to}::timestamptz
       ORDER BY t_open
       LIMIT ${q.limit}::int
    `) as Row[];
    const cutRows = (await sql`
      SELECT t0_ms::float8 AS start_ms, t1_ms::float8 AS end_ms
        FROM consult_index
       WHERE ist_date = ${q.ist_date}::date AND room_id = ${q.room_id}
       ORDER BY t0_ms
       LIMIT ${q.limit}::int
    `) as Row[];
    const consults: TimelineConsult[] = consultRows.map((r) => ({
      consult_key: String(r.consult_key),
      start_ms: Number(r.start_ms),
      end_ms: Number(r.end_ms),
      confidence: num(r.confidence),
      reason_codes: Array.isArray(r.reason_codes) ? r.reason_codes.map(String) : [],
      closed_by: String(r.closed_by),
      encounter_end_ms: num(r.encounter_end_ms),
      jev_used: r.jev_used === true,
    }));
    const pulse: PulseWindow[] = pulseRows.map((r) => {
      const kind = pulseKind(String(r.close_reason ?? ""));
      return { start_ms: Number(r.start_ms), end_ms: Number(r.end_ms), ...kind };
    });
    const cuts: CutWindow[] = cutRows.map((r) => ({ start_ms: Number(r.start_ms), end_ms: Number(r.end_ms) }));
    return {
      run, consults, pulse, cuts,
      truncated: consults.length >= q.limit || pulse.length >= q.limit || cuts.length >= q.limit,
    };
  } catch (e) {
    return { error: `db_error:${sqlState(e)}` };
  }
}

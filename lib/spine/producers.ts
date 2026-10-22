/**
 * lib/spine/producers.ts — SPINE-P1: run the two encounter shadow producers over today's room-days. Pure orchestration: no clock, no env, no SQL; the caller passes `now()` and the deps.
 * acoustic = runShadowForRoomDay (encounter_hypothesis(_run)); timeline = runTimelineShadowForRoomDay (shadow-v3, encounter_hypothesis(_run) with source 'timeline')
 * then runTimelineLeaveForRoomDay (encounter_timeline_shadow(_run), the spine's timeline proxy), in voice.ts's order. Blind room-days are never run.
 * A timeline flag that cannot be parsed (parseFlag throws) skips the timeline and is counted; acoustic still runs. Failures are counted by CLASS; no id or text leaves this module.
 */
export type RoomDayRef = { id: string; room_id: string; ist_date: string };
type Res = { ok: boolean; error?: string };

export type ProducerDeps = {
  now: () => number;
  isBlind: (roomDay: RoomDayRef) => Promise<boolean>;
  acoustic: (i: { room_id: string; room_day_id: string; ist_date: string }) => Promise<Res>;
  timeline: (i: { room_id: string; room_day_id: string; ist_date: string; gate_diar: boolean }) => Promise<Res>;
  leave: (i: { room_id: string; room_day_id: string; ist_date: string; gate_diar: boolean }) => Promise<Res>;
  timelineEnabled: () => boolean;   // may throw (parseFlag)
  gateDiar: () => boolean;          // may throw (parseFlag)
};

export type ProducerCounts = {
  room_days: number; acoustic_ok: number; acoustic_err: number; timeline_ok: number; timeline_err: number; leave_ok: number; leave_err: number;
  blind_skipped: number; timeline_enabled: boolean; timeline_flag_invalid: number;
  /** failure classes seen (error code or "threw"), for one log line each */
  classes: string[];
};

export const DEFAULT_MAX = 12;
export const STOP_AFTER_MS = 45_000;

export function parseMax(raw: string | undefined): number {
  const n = raw === undefined ? NaN : Number(raw.trim());
  return Number.isInteger(n) && n >= 1 && n <= 200 ? n : DEFAULT_MAX;
}

export async function runProducers(days: readonly RoomDayRef[], max: number, deps: ProducerDeps): Promise<ProducerCounts> {
  const c: ProducerCounts = { room_days: 0, acoustic_ok: 0, acoustic_err: 0, timeline_ok: 0, timeline_err: 0, leave_ok: 0, leave_err: 0, blind_skipped: 0, timeline_enabled: false, timeline_flag_invalid: 0, classes: [] };
  const seen = new Set<string>();
  const cls = (k: string) => { if (!seen.has(k)) { seen.add(k); c.classes.push(k); } };
  let wantTimeline = false, gateDiar = false;
  try { wantTimeline = deps.timelineEnabled(); if (wantTimeline) gateDiar = deps.gateDiar(); } catch { wantTimeline = false; c.timeline_flag_invalid = 1; cls("timeline_flag_invalid"); }
  c.timeline_enabled = wantTimeline;
  const start = deps.now();
  for (const d of days) {
    if (c.room_days >= max || deps.now() - start >= STOP_AFTER_MS) break;
    c.room_days++;
    let blind = true;   // fail closed: if the check itself fails the day is treated as blind
    try { blind = await deps.isBlind(d); } catch { cls("blind_check_failed"); }
    if (blind) { c.blind_skipped++; continue; }
    try {
      const r = await deps.acoustic({ room_id: d.room_id, room_day_id: d.id, ist_date: d.ist_date });
      if (r.ok) c.acoustic_ok++; else { c.acoustic_err++; cls(`acoustic:${r.error ?? "unknown"}`); }
    } catch { c.acoustic_err++; cls("acoustic:threw"); }
    if (!wantTimeline) continue;
    try {
      const r = await deps.timeline({ room_id: d.room_id, room_day_id: d.id, ist_date: d.ist_date, gate_diar: gateDiar });
      if (r.ok) c.timeline_ok++; else { c.timeline_err++; cls(`timeline:${r.error ?? "unknown"}`); }
    } catch { c.timeline_err++; cls("timeline:threw"); }
    try {
      const r = await deps.leave({ room_id: d.room_id, room_day_id: d.id, ist_date: d.ist_date, gate_diar: gateDiar });
      if (r.ok) c.leave_ok++; else { c.leave_err++; cls(`leave:${r.error ?? "unknown"}`); }
    } catch { c.leave_err++; cls("leave_err"); }
  }
  return c;
}

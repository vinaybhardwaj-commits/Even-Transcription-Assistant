/**
 * lib/spine/producers.ts — SPINE-P1: run the encounter shadow producers over today's room-days. Pure orchestration: no clock, no env, no SQL; the caller passes `now()` and the deps.
 * acoustic = runShadowForRoomDay (encounter_hypothesis(_run)), at most once per hour per room-day (the first tick of each IST hour, `acousticDue`);
 * timeline = runTimelineLeaveForRoomDay (encounter_timeline_shadow(_run), the spine's timeline proxy), every tick, only when the timeline flag is on.
 * Order per room-day: acoustic (when due), then leave. voice.ts runs v3, leave, then acoustic (or fused); no reader depends on the order (the acoustic reader filters to source 'acoustic').
 * shadow-v3 (runTimelineShadowForRoomDay) is NOT run here (R3, interim pending fable): the spine reads none of its output and it asks Jev (paid) per segment per tick with no cache.
 * The room-day list is rotated by the tick index (by the hour index on acoustic-due ticks) so the 45 s stop and the max bound never starve the same tail rooms. Blind room-days are never run.
 * A timeline flag that cannot be parsed (parseFlag throws) skips leave and is counted; acoustic still runs. Failures are counted by CLASS; no id or text leaves this module.
 */
export type RoomDayRef = { id: string; room_id: string; ist_date: string };
type Res = { ok: boolean; error?: string };

export type ProducerDeps = {
  now: () => number;
  isBlind: (roomDay: RoomDayRef) => Promise<boolean>;
  acoustic: (i: { room_id: string; room_day_id: string; ist_date: string }) => Promise<Res>;
  leave: (i: { room_id: string; room_day_id: string; ist_date: string; gate_diar: boolean }) => Promise<Res>;
  timelineEnabled: () => boolean;   // may throw (parseFlag)
  gateDiar: () => boolean;          // may throw (parseFlag)
};

export type ProducerCounts = {
  room_days: number; acoustic_ok: number; acoustic_err: number; leave_ok: number; leave_err: number;
  blind_skipped: number; acoustic_due: boolean; timeline_enabled: boolean; timeline_flag_invalid: number;
  /** failure classes seen (error code or "threw"), for one log line each */
  classes: string[];
};

export const DEFAULT_MAX = 12;
export const STOP_AFTER_MS = 45_000;

export const TICK_MS = 900_000;
const IST_MS = 19_800_000;

/** Acoustic runs on the first tick of each IST hour: the IST minute is below 15 (ticks are 15 min apart, so exactly one tick per hour qualifies). */
export function acousticDue(nowMs: number): boolean {
  return new Date(nowMs + IST_MS).getUTCMinutes() < 15;
}

export const HOUR_MS = 3_600_000;

/** The list rotated left by floor(now / periodMs) mod n (default one tick, 15 min): the head moves each period, so a bounded run does not always serve the same rooms. */
export function rotateByTick<T>(list: readonly T[], nowMs: number, periodMs: number = TICK_MS): T[] {
  if (list.length === 0) return [];
  const k = Math.floor(nowMs / periodMs) % list.length;
  return [...list.slice(k), ...list.slice(0, k)];
}

export function parseMax(raw: string | undefined): number {
  const n = raw === undefined ? NaN : Number(raw.trim());
  return Number.isInteger(n) && n >= 1 && n <= 200 ? n : DEFAULT_MAX;
}

export async function runProducers(days: readonly RoomDayRef[], max: number, deps: ProducerDeps): Promise<ProducerCounts> {
  const c: ProducerCounts = { room_days: 0, acoustic_ok: 0, acoustic_err: 0, leave_ok: 0, leave_err: 0, blind_skipped: 0, acoustic_due: false, timeline_enabled: false, timeline_flag_invalid: 0, classes: [] };
  const seen = new Set<string>();
  const cls = (k: string) => { if (!seen.has(k)) { seen.add(k); c.classes.push(k); } };
  let wantTimeline = false, gateDiar = false;
  try { wantTimeline = deps.timelineEnabled(); if (wantTimeline) gateDiar = deps.gateDiar(); } catch { wantTimeline = false; c.timeline_flag_invalid = 1; cls("timeline_flag_invalid"); }
  c.timeline_enabled = wantTimeline;
  const start = deps.now();
  const due = acousticDue(start);
  c.acoustic_due = due;
  // Acoustic ticks are 4 apart, so rotating them by the tick index only reaches offsets = 2 mod gcd(4,n) and starves the rest (R3 F4): rotate due ticks by the hour index.
  for (const d of rotateByTick(days, start, due ? HOUR_MS : TICK_MS)) {
    if (c.room_days >= max || deps.now() - start >= STOP_AFTER_MS) break;
    c.room_days++;
    let blind = true;   // fail closed: if the check itself fails the day is treated as blind
    try { blind = await deps.isBlind(d); } catch { cls("blind_check_failed"); }
    if (blind) { c.blind_skipped++; continue; }
    if (due) try {
      const r = await deps.acoustic({ room_id: d.room_id, room_day_id: d.id, ist_date: d.ist_date });
      if (r.ok) c.acoustic_ok++; else { c.acoustic_err++; cls(`acoustic:${r.error ?? "unknown"}`); }
    } catch { c.acoustic_err++; cls("acoustic:threw"); }
    if (!wantTimeline) continue;
    try {
      const r = await deps.leave({ room_id: d.room_id, room_day_id: d.id, ist_date: d.ist_date, gate_diar: gateDiar });
      if (r.ok) c.leave_ok++; else { c.leave_err++; cls(`leave:${r.error ?? "unknown"}`); }
    } catch { c.leave_err++; cls("leave_err"); }
  }
  return c;
}

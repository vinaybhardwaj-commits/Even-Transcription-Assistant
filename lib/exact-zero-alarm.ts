/**
 * lib/exact-zero-alarm.ts — DRAFT (Fable ruling 255b, 24 Sep 2026): the HOURLY EXACT-ZERO ALARM, per recording room.
 * SPEC: docs/handoff/ETA-EXACT-ZERO-ALARM-SPEC-24-SEP-2026.md. THIS FILE IS INERT: it reads and it decides, and nothing calls it. No route, no cron, no
 * migration, no write. It is a draft for Fable to review in daylight; wiring it is a separate, later change.
 *
 * WHY. 12.7 % of the HIST tape (137 of 1,080 h) is bit-exact digital zero while the room showed "recording" (4 rooms, intermittent, none after 22 Sep 07:40). Bit-exact zero is
 * the TONOR TM20 hardware-mute signature. The recorder's own detector (SILENT_WHILE_RECORDING, lib/bench-bus-constants.ts) needs EIGHTY CONSECUTIVE silent polls, about two
 * minutes, and lives in the poll ring. It cannot see a mute that comes and goes, and nobody sees it afterwards. This is the second, SERVER-SIDE check, over the persisted level log
 * (bench_level_sample, 7 IST days): how much of each IST hour's RECORDED time was exactly zero.
 *
 * DEFINITIONS (all of them decisions, all pinned by tests/unit/exact-zero-alarm.test.ts):
 *  - a BUCKET is 15 s (LEVEL_TIMELINE_BUCKET_SECONDS), the reader's own unit;
 *  - a bucket is RECORDING only if session_open AND tape_advancing at some sample in it;
 *  - a recording bucket is MEASURED only if some sample in it reported zero_ratio. A bucket that did not report is NEITHER ok NOR zero: it is left out of the share, and counted
 *    as `unmeasured`, because "not reported" must never read as "fine" (the standing rule behind B2-D7);
 *  - a measured bucket is EXACT ZERO only if EVERY reporting sample in it has zero_ratio >= EXACT_ZERO_RATIO. That is `min`, not the reader's `max`: one glitch sample is a live
 *    microphone, one live sample must clear the bucket;
 *  - hours are IST hours, 05:30 ahead of UTC, so a bucket at 00:20 IST belongs to the hour starting 00:00 IST.
 */
import { sql } from "@/lib/db";
import { LEVEL_TIMELINE_BUCKET_SECONDS } from "@/lib/bench-levels";

/** The IST offset in ms. India has no daylight saving, so this is exact. */
export const IST_OFFSET_MS = 5.5 * 3_600_000;
export const HOUR_MS = 3_600_000;
/** Stricter than the recorder's SILENT_ZERO_RATIO (0.98): this alarm means BIT-EXACT zero, the measured defect, and not merely a dead-looking input. Rounding tolerance only. */
export const EXACT_ZERO_RATIO = 0.999;

/**
 * PROPOSED thresholds. NOT calibrated against production yet: the calibration query is in the spec and has been requested (bus #1295). Change them there, not by feel.
 *  - an hour is JUDGED only once it has MIN_MEASURED_BUCKETS of measured recording (20 buckets = 5 minutes); with less it is `insufficient`, never `ok`;
 *  - it ALARMS when at least ALARM_MIN_ZERO_BUCKETS were exact zero (20 = 5 minutes) AND that is at least ALARM_SHARE of the measured buckets (10 %).
 * Both conditions, so a long hour with a brief mute does not alarm, and a short hour that is all zero still does once it has enough measured time.
 */
export const MIN_MEASURED_BUCKETS = 20;
export const ALARM_MIN_ZERO_BUCKETS = 20;
export const ALARM_SHARE = 0.1;

export type ExactZeroHour = {
  room_id: string;
  /** The IST hour's start, as a UTC instant (ISO). */
  hour_start: string;
  recording_buckets: number;
  measured_buckets: number;
  exact_zero_buckets: number;
};

export type HourState = "ok" | "alarm" | "insufficient";
export type HourVerdict = {
  state: HourState;
  /** exact_zero_buckets / measured_buckets, or null when nothing was measured. */
  zero_share: number | null;
  zero_minutes: number;
  /** recording buckets that never reported zero_ratio: named, never folded into ok. */
  unmeasured_buckets: number;
};

const minutes = (buckets: number) => (buckets * LEVEL_TIMELINE_BUCKET_SECONDS) / 60;

export type Thresholds = { minMeasured: number; alarmMinZero: number; alarmShare: number };
export const DEFAULT_THRESHOLDS: Thresholds = { minMeasured: MIN_MEASURED_BUCKETS, alarmMinZero: ALARM_MIN_ZERO_BUCKETS, alarmShare: ALARM_SHARE };

/**
 * PURE — one hour's verdict. `insufficient` when fewer than minMeasured buckets were MEASURED (including a room that reported no zero_ratio at all: absent is not healthy, and
 * it is not an alarm either, it is unknown and is listed as such). Otherwise `alarm` iff both the count and the share conditions hold, else `ok`.
 * Malformed counts (negative, non-finite, zero above measured, measured above recording) are `insufficient`, never a silent `ok`.
 */
export function classifyHour(h: Pick<ExactZeroHour, "recording_buckets" | "measured_buckets" | "exact_zero_buckets">, t: Thresholds = DEFAULT_THRESHOLDS): HourVerdict {
  const { recording_buckets: rec, measured_buckets: meas, exact_zero_buckets: zero } = h;
  const sane = [rec, meas, zero].every((n) => Number.isFinite(n) && n >= 0) && zero <= meas && meas <= rec;
  if (!sane) return { state: "insufficient", zero_share: null, zero_minutes: 0, unmeasured_buckets: 0 };
  const unmeasured = rec - meas;
  if (meas < t.minMeasured) {
    return { state: "insufficient", zero_share: meas > 0 ? zero / meas : null, zero_minutes: minutes(zero), unmeasured_buckets: unmeasured };
  }
  const share = zero / meas;
  const alarm = zero >= t.alarmMinZero && share >= t.alarmShare;
  return { state: alarm ? "alarm" : "ok", zero_share: share, zero_minutes: minutes(zero), unmeasured_buckets: unmeasured };
}

/** PURE — the IST hour (as a UTC instant) that contains `t_ms`. */
export function istHourStart(t_ms: number): number {
  return Math.floor((t_ms + IST_OFFSET_MS) / HOUR_MS) * HOUR_MS - IST_OFFSET_MS;
}

/** PURE — "HH:00 IST on D Mon" for a message, no seconds and no identity. */
export function istHourLabel(hour_start_ms: number): string {
  const d = new Date(hour_start_ms + IST_OFFSET_MS);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ${pad(d.getUTCHours())}:00 IST`;
}

/**
 * PURE — the alarm text. Counts and times only: a room id (or the name the caller already holds), minutes and a percentage. Never audio, never a transcript. `roomLabel` is the
 * caller's choice (the bus may carry the name; a tracked file carries the room id only, design decision 3 of the watchdog alert path).
 */
export function exactZeroMessage(roomLabel: string, hour: ExactZeroHour, v: HourVerdict): { subject: string; text: string } {
  const label = istHourLabel(Date.parse(hour.hour_start));
  const pct = v.zero_share === null ? "n/a" : `${Math.round(v.zero_share * 100)} %`;
  return {
    subject: `EvenScribe: ${roomLabel} recorded exact digital silence in the hour of ${label}`,
    text:
      `${roomLabel}: ${v.zero_minutes.toFixed(1)} of the ${minutes(hour.measured_buckets).toFixed(1)} minutes measured in the hour starting ${label} were bit-exact zero (${pct}), ` +
      `while the room showed recording. That is the hardware-mute signature (the input reads perfect silence, not a quiet room). Check the microphone and its mute control.` +
      (v.unmeasured_buckets > 0 ? ` ${minutes(v.unmeasured_buckets).toFixed(1)} minutes of recording did not report a level and are not counted either way.` : ""),
  };
}

/**
 * READ-ONLY — per room and IST hour, from the persisted level log. One statement, no write.
 * `roomId` narrows it; `sinceMs`/`untilMs` bound it (untilMs exclusive). The bucket key and the `min(zero_ratio)` per bucket are the definitions above.
 * The hour is grouped in Postgres with `AT TIME ZONE 'Asia/Kolkata'` and returned as a UTC instant.
 */
export async function readExactZeroHours(opts: { roomId?: string; sinceMs: number; untilMs: number }): Promise<ExactZeroHour[]> {
  const since = new Date(opts.sinceMs).toISOString();
  const until = new Date(opts.untilMs).toISOString();
  const room = opts.roomId ?? null;
  // The bucket size is bound ONCE, in the SELECT, and every later step groups by the NAMED column. Binding it a second time in a GROUP BY makes it a different positional
  // parameter, and Postgres then refuses to match the two expressions ("must appear in the GROUP BY clause"). Found by the real-postgres test, not by reading.
  const rows = (await sql`
    WITH b AS (
      SELECT room_id,
             floor(extract(epoch FROM sampled_at) / ${LEVEL_TIMELINE_BUCKET_SECONDS}::int) AS bucket,
             min(sampled_at) AS t,
             bool_or(session_open) AS rec,
             bool_or(tape_advancing) AS adv,
             min(zero_ratio) FILTER (WHERE zero_ratio IS NOT NULL) AS zr_min
        FROM bench_level_sample
       WHERE sampled_at >= ${since}::timestamptz
         AND sampled_at <  ${until}::timestamptz
         AND (${room}::text IS NULL OR room_id = ${room}::text)
       GROUP BY room_id, bucket
    ), h AS (
      SELECT room_id, rec, adv, zr_min, date_trunc('hour', t AT TIME ZONE 'Asia/Kolkata') AS ist_hour
        FROM b
    )
    SELECT room_id,
           (ist_hour AT TIME ZONE 'Asia/Kolkata')                                            AS hour_start,
           (count(*) FILTER (WHERE rec AND adv))::int                                        AS recording_buckets,
           (count(*) FILTER (WHERE rec AND adv AND zr_min IS NOT NULL))::int                 AS measured_buckets,
           (count(*) FILTER (WHERE rec AND adv AND zr_min >= ${EXACT_ZERO_RATIO}::real))::int AS exact_zero_buckets
      FROM h
     GROUP BY room_id, ist_hour
    HAVING count(*) FILTER (WHERE rec AND adv) > 0
     ORDER BY hour_start, room_id
  `) as Array<{ room_id: string; hour_start: string | Date; recording_buckets: number | string; measured_buckets: number | string; exact_zero_buckets: number | string }>;
  return rows.map((r) => ({
    room_id: r.room_id,
    hour_start: new Date(r.hour_start).toISOString(),
    recording_buckets: Number(r.recording_buckets),
    measured_buckets: Number(r.measured_buckets),
    exact_zero_buckets: Number(r.exact_zero_buckets),
  }));
}

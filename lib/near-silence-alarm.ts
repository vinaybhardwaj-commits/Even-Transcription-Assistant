/**
 * lib/near-silence-alarm.ts — DRAFT (Fable ruling 345, 25 Sep 2026): the hourly NEAR-SILENCE alarm, per recording room. OPTION E of docs/handoff/ETA-EXACT-ZERO-ALARM-SPEC-24-SEP-2026.md §9.
 * THIS FILE IS INERT: it reads and it decides, and nothing calls it. No route, no cron, no migration, no write, no page. Ruling 345 keeps the thresholds in SHADOW for 48 h and
 * gives NO pages until Fable rules on the numbers; wiring is a separate, later change.
 *
 * WHY THIS AND NOT lib/exact-zero-alarm.ts. The exact-zero draft reads the level log's `zero_ratio`, which no Mac row carries (command-poll route bug, fix 1e75667). The level log DOES carry
 * `peak` on every capturing Mac row. `peak` is the Mac's `mic_peak`: ONE 1.25 s RMS window per poll (eta-refuter #1856), printed with 4 decimals. So:
 *   - peak = 0        means RMS below about 5e-5   (about -86 dBFS);
 *   - peak < 0.001    means RMS below 0.001         (about -60 dBFS).
 * Both are NEAR-silence, a superset of bit-exact zero, and are worded so. The word "zero" and the claim "digital silence" never appear in a message from this module.
 *
 * DEFINITIONS (all decisions, all pinned by tests/unit/near-silence-alarm.test.ts):
 *  - a SAMPLE is one level-log row with session_open AND tape_advancing AND peak present (the poll cadence is the sampling; there is no bucketing, unlike the exact-zero draft, because
 *    peak is a per-poll point, not a per-sample count);
 *  - it is NEAR-SILENT at the "zero" floor if peak = 0, at the "loose" floor if peak < 0.001. Every "zero" sample is also a "loose" one, so z0 <= z1 <= n;
 *  - an hour is JUDGED only with at least MIN_SAMPLES samples (fewer = `insufficient`, never `ok`); it ALARMS when the near-silent share is at least ALARM_SHARE;
 *  - hours are IST hours (05:30 ahead of UTC), returned as UTC instants;
 *  - a room with NO judged hour in the window is UNKNOWN (never green): "we never measured" must not read as "fine" (the standing rule behind B2-D7 and the VAD starvation).
 *  - an EPISODE is a run of alarming hours in one room; an `insufficient` or missing hour HOLDS it open (absence of evidence does not end it), and only an `ok` hour ends it (recovered).
 *
 * CALIBRATION (posted #1970, #2048; 7 days of the level log, 9 rooms): at ALARM_SHARE 0.10 and MIN_SAMPLES 100, peak = 0 alarms on 8 of OPD 4's 16 judged hours and 0 of the 171 hours in the other
 * eight rooms; peak < 0.001 alarms on 9 of 16 and still 0 elsewhere (largest healthy share 1.1 %). ONE positive room, and every "healthy" hour is a C270 webcam hour (eta-refuter #1979): the
 * numbers below are PROPOSED, in shadow, to be re-run per mic type after the TM20 switch-back. Change them by ruling, not by feel.
 */
import { sql } from "@/lib/db";
import { HOUR_MS, IST_OFFSET_MS, istHourLabel, istHourStart } from "@/lib/exact-zero-alarm";

export { HOUR_MS, IST_OFFSET_MS, istHourLabel, istHourStart };

/** A sample is "near-silent at the zero floor" when peak is exactly 0 (printed 0.0000). */
export const ZERO_FLOOR_PEAK = 0;
/** A sample is "near-silent at the loose floor" when peak is below this (RMS below about -60 dBFS). */
export const LOOSE_FLOOR_PEAK = 0.001;

/** PROPOSED, in shadow. An hour is judged only with this many capturing samples (every real hour in the 7-day data had at least 231). */
export const MIN_SAMPLES = 100;
/** PROPOSED, in shadow. An hour alarms when at least this share of its samples is near-silent. */
export const ALARM_SHARE = 0.1;
/** Ruling 279: a running episode is re-announced only after this long without a notice. */
export const RENOTICE_AFTER_MS = 3 * HOUR_MS;

export type Floor = "zero" | "loose";

/** How each floor is worded. Never "zero", never "digital silence". */
export const FLOOR_WORDING: Record<Floor, string> = {
  zero: "near-silence (peak below -86 dBFS)",
  loose: "near-silence (peak below -60 dBFS)",
};

export type NearSilenceHour = {
  room_id: string;
  /** The IST hour's start, as a UTC instant (ISO). */
  hour_start: string;
  /** capturing samples with a peak */
  samples: number;
  /** of those, peak = 0 */
  zero_samples: number;
  /** of those, peak < 0.001 (includes every zero sample) */
  loose_samples: number;
};

export type HourState = "ok" | "alarm" | "insufficient";
export type HourVerdict = { state: HourState; share: number | null; near_silent_samples: number; samples: number };

export type Thresholds = { minSamples: number; alarmShare: number };
export const DEFAULT_THRESHOLDS: Thresholds = { minSamples: MIN_SAMPLES, alarmShare: ALARM_SHARE };

/**
 * PURE — one hour's verdict at one floor. `insufficient` when fewer than minSamples were taken. Malformed counts (negative, non-finite, zero above loose, loose above samples) are
 * `insufficient`, never a silent `ok`: a broken row must not read as a healthy room.
 */
export function classifyHour(h: Pick<NearSilenceHour, "samples" | "zero_samples" | "loose_samples">, floor: Floor, t: Thresholds = DEFAULT_THRESHOLDS): HourVerdict {
  const { samples: n, zero_samples: z0, loose_samples: z1 } = h;
  const sane = [n, z0, z1].every((x) => Number.isFinite(x) && x >= 0) && z0 <= z1 && z1 <= n;
  const silent = floor === "zero" ? z0 : z1;
  if (!sane) return { state: "insufficient", share: null, near_silent_samples: 0, samples: Number.isFinite(n) && n >= 0 ? n : 0 };
  if (n < t.minSamples) return { state: "insufficient", share: n > 0 ? silent / n : null, near_silent_samples: silent, samples: n };
  const share = silent / n;
  return { state: share >= t.alarmShare ? "alarm" : "ok", share, near_silent_samples: silent, samples: n };
}

export type Episode = {
  room_id: string;
  /** first alarming hour's start, ms */
  start_ms: number;
  /** last alarming hour's start, ms */
  last_alarm_hour_ms: number;
  alarming_hours: number;
  /** true once an `ok` hour followed; the start of that hour, else null (still open) */
  recovered_at_ms: number | null;
};

/**
 * PURE — group one floor's hourly verdicts into episodes, per room. Input order does not matter. An `insufficient` hour, or an hour with no row at all, holds an open episode open and
 * does not extend it; an `ok` hour closes it (recovered). A new alarm after a recovery is a NEW episode.
 */
export function groupEpisodes(hours: ReadonlyArray<{ room_id: string; hour_start_ms: number; state: HourState }>): Episode[] {
  const byRoom = new Map<string, Array<{ hour_start_ms: number; state: HourState }>>();
  for (const h of hours) {
    const list = byRoom.get(h.room_id) ?? [];
    list.push({ hour_start_ms: h.hour_start_ms, state: h.state });
    byRoom.set(h.room_id, list);
  }
  const out: Episode[] = [];
  for (const [room_id, list] of [...byRoom.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    list.sort((a, b) => a.hour_start_ms - b.hour_start_ms);
    let open: Episode | null = null;
    for (const h of list) {
      if (h.state === "alarm") {
        if (open) {
          open.last_alarm_hour_ms = h.hour_start_ms;
          open.alarming_hours += 1;
        } else {
          open = { room_id, start_ms: h.hour_start_ms, last_alarm_hour_ms: h.hour_start_ms, alarming_hours: 1, recovered_at_ms: null };
          out.push(open);
        }
      } else if (h.state === "ok" && open) {
        open.recovered_at_ms = h.hour_start_ms;
        open = null;
      }
      // insufficient: holds `open` as it is
    }
  }
  return out;
}

/** PURE — an open episode is re-announced only when the last notice is at least RENOTICE_AFTER_MS old. A recovered episode is never re-announced. */
export function renoticeDue(episode: Pick<Episode, "recovered_at_ms">, lastNoticeMs: number, nowMs: number): boolean {
  return episode.recovered_at_ms === null && nowMs - lastNoticeMs >= RENOTICE_AFTER_MS;
}

/**
 * PURE — the rooms with NO judged hour: UNKNOWN, listed and never green. `expectedRoomIds` is the caller's list of rooms that should be recording (the fleet), so a room that produced
 * no samples at all is named too.
 */
export function unknownRooms(expectedRoomIds: readonly string[], hours: ReadonlyArray<NearSilenceHour>, t: Thresholds = DEFAULT_THRESHOLDS): string[] {
  const judged = new Set(hours.filter((h) => h.samples >= t.minSamples).map((h) => h.room_id));
  return [...new Set(expectedRoomIds)].filter((r) => !judged.has(r)).sort();
}

/**
 * PURE — the message text. Counts, a percentage and a time only: a room label the caller chooses, never audio, never a transcript, never a person. Says what was measured (a sampled peak)
 * and what it cannot say (why).
 */
export function nearSilenceMessage(roomLabel: string, hour: NearSilenceHour, floor: Floor, v: HourVerdict): { subject: string; text: string } {
  const label = istHourLabel(Date.parse(hour.hour_start));
  const pct = v.share === null ? "n/a" : `${Math.round(v.share * 100)} %`;
  return {
    subject: `EvenScribe: ${roomLabel} recorded ${FLOOR_WORDING[floor]} in the hour of ${label}`,
    text:
      `${roomLabel}: ${v.near_silent_samples} of ${v.samples} level readings in the hour starting ${label} were ${FLOOR_WORDING[floor]} (${pct}), while the room showed recording. ` +
      `That is a sampled level, not a count of audio samples, and it does not say why (a muted or dropped microphone, a wrong input, or a very quiet room at a very low gain look the same). ` +
      `Check the microphone and the selected input.`,
  };
}

/**
 * READ-ONLY — per room and IST hour, from the persisted level log (7 IST days). One statement, no write. `roomId` narrows it; `sinceMs`/`untilMs` bound it (untilMs exclusive).
 * Hours are grouped in Postgres with `AT TIME ZONE 'Asia/Kolkata'` and returned as a UTC instant. The floors are bound ONCE, in the SELECT (binding a value again in a GROUP BY makes it a
 * different positional parameter and Postgres refuses to match the two, found by the exact-zero draft's real-postgres test), and the grouping is by NAMED columns.
 */
export async function readNearSilenceHours(opts: { roomId?: string; sinceMs: number; untilMs: number }): Promise<NearSilenceHour[]> {
  const since = new Date(opts.sinceMs).toISOString();
  const until = new Date(opts.untilMs).toISOString();
  const room = opts.roomId ?? null;
  const rows = (await sql`
    WITH s AS (
      SELECT room_id, peak, date_trunc('hour', sampled_at AT TIME ZONE 'Asia/Kolkata') AS ist_hour
        FROM bench_level_sample
       WHERE session_open AND tape_advancing AND peak IS NOT NULL
         AND sampled_at >= ${since}::timestamptz
         AND sampled_at <  ${until}::timestamptz
         AND (${room}::text IS NULL OR room_id = ${room}::text)
    )
    SELECT room_id,
           (ist_hour AT TIME ZONE 'Asia/Kolkata')                                       AS hour_start,
           count(*)::int                                                                AS samples,
           (count(*) FILTER (WHERE peak = ${ZERO_FLOOR_PEAK}::real))::int               AS zero_samples,
           (count(*) FILTER (WHERE peak < ${LOOSE_FLOOR_PEAK}::real))::int              AS loose_samples
      FROM s
     GROUP BY room_id, ist_hour
     ORDER BY hour_start, room_id
  `) as Array<{ room_id: string; hour_start: string | Date; samples: number | string; zero_samples: number | string; loose_samples: number | string }>;
  return rows.map((r) => ({
    room_id: r.room_id,
    hour_start: new Date(r.hour_start).toISOString(),
    samples: Number(r.samples),
    zero_samples: Number(r.zero_samples),
    loose_samples: Number(r.loose_samples),
  }));
}

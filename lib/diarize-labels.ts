/**
 * lib/diarize-labels.ts — the only writer and reader of `diarize_window_label` (migration 0117).
 *
 * WHAT THIS IS FOR. V's ruling of 23 Sep makes pyannote.ai a TEACHER: we pay it to label our room
 * audio so the local diarizer can be trained to match it, with written permission from pyannote.ai
 * to do so. Both engines write here — the teacher's turns and our own — so the lab can measure the
 * gap night by night rather than guess at it.
 *
 * APPEND-ONLY, AND THAT IS THE REQUIREMENT, not a preference. A teacher label that a later local
 * run can overwrite is not a label. Nothing in this file updates or deletes; a re-run is a new row
 * under a new run_id. The one concession is `ON CONFLICT DO NOTHING`, which makes a REPLAYED step
 * idempotent — the job runner can replay a step after a crash, and that must not double-count a
 * window in the spend report.
 *
 * LABELLING FAILING MUST NEVER FAIL A WINDOW. Production's diarization does not depend on whether
 * we kept a training label, so `writeWindowLabel` is called where a throw is caught and counted.
 * The alternative — a clinician's window failing because a lab table was unavailable — is not a
 * trade this system should ever make.
 */
import { sql } from "@/lib/db";
import { randomUUID } from "node:crypto";
import type { DiarizeEngine } from "@/lib/diarize-engine";
import { BLIND_ROOM_DAYS } from "@/lib/rubrics/blind-room-days";

/**
 * What pyannote.ai precision-3 costs per audio-hour.
 *
 * EUR 0.112/h is the figure the 22 Sep bake-off ran its own cost line against, consistent with the
 * "~EUR 0.11 per audio-hour" in the switch order. Overridable, because a rate is a commercial fact
 * that changes without any code changing.
 *
 * IT IS AN ESTIMATE, NOT AN INVOICE. It is multiplied by the audio seconds WE sent; pyannote.ai
 * bills on its own measure and rounds by its own rules. Every number this file reports derived from
 * it is labelled `estimated_`.
 */
export const EUR_PER_AUDIO_HOUR_DEFAULT = 0.112;
export const EUR_PER_AUDIO_HOUR_ENV = "PYANNOTEAI_EUR_PER_AUDIO_HOUR";
export function eurPerAudioHour(env: Record<string, string | undefined> = process.env): number {
  const text = env[EUR_PER_AUDIO_HOUR_ENV];
  // AN EMPTY VALUE IS ABSENT, NOT ZERO. `Number("")` is 0, which is finite and non-negative, so a
  // variable that is set-but-blank — the normal shape of an unfilled deploy setting — would pass
  // every numeric check and silently report a spend of nothing. A rate of exactly 0 stays legal
  // when someone actually writes "0".
  if (text === undefined || text.trim() === "") return EUR_PER_AUDIO_HOUR_DEFAULT;
  const raw = Number(text);
  // A nonsensical rate is ignored rather than honoured: a negative or non-numeric rate would make
  // the spend report quietly wrong, and wrong is worse than the documented default.
  return Number.isFinite(raw) && raw >= 0 ? raw : EUR_PER_AUDIO_HOUR_DEFAULT;
}

export type WindowLabel = {
  windowId: string;
  roomDayId: string;
  engine: DiarizeEngine;
  /** Derived from the engine's own answer. NULL when it did not say — never what we asked for. */
  model: string | null;
  providerJobId: string | null;
  runId: string;
  /** Clip-relative spans in the local service's shape. No text, no audio. */
  segments: ReadonlyArray<{ start_ms: number; end_ms: number; speaker_idx: number }>;
  speakerCount: number;
  audioSeconds: number | null;
};

/** ONE STATEMENT, append-only. A replayed step writes the same row rather than a second one. */
export async function writeWindowLabel(row: WindowLabel): Promise<void> {
  await sql`
    INSERT INTO diarize_window_label
      (id, window_id, room_day_id, engine, model, provider_job_id, run_id,
       segments_json, speaker_count, segment_count, audio_seconds)
    VALUES
      (${randomUUID()}, ${row.windowId}, ${row.roomDayId}, ${row.engine}, ${row.model},
       ${row.providerJobId}, ${row.runId}, ${JSON.stringify(row.segments)}::jsonb,
       ${row.speakerCount}, ${row.segments.length}, ${row.audioSeconds})
    ON CONFLICT (window_id, engine, run_id) DO NOTHING
  `;
}

export type DailyLabelCount = {
  /** IST calendar date, because that is the day a clinic ran. */
  ist_date: string;
  engine: DiarizeEngine;
  windows: number;
  audio_hours: number;
  /** Null for an engine we do not pay for. Estimated — see eurPerAudioHour. */
  estimated_eur: number | null;
};

/**
 * Windows labelled, audio-hours and estimated spend, per engine per IST day.
 *
 * THE MONEY IS DERIVED AT READ TIME from stored audio seconds, never accumulated into a column. An
 * accumulator is a number nobody can re-derive when the rate changes or a row is found to be wrong,
 * and this one exists precisely to be checked against an invoice.
 */
const BLIND_DAYS_ARG = BLIND_ROOM_DAYS.map(([d]) => d);
const BLIND_ROOMS_ARG = BLIND_ROOM_DAYS.map(([, r]) => r);

export async function dailyLabelCounts(opts: { days?: number; env?: Record<string, string | undefined> } = {}): Promise<DailyLabelCount[]> {
  const days = Number.isFinite(opts.days) && (opts.days as number) > 0 ? Math.min(Math.floor(opts.days as number), 90) : 14;
  const rows = (await sql`
    SELECT to_char((created_at AT TIME ZONE 'Asia/Kolkata')::date, 'YYYY-MM-DD') AS ist_date,
           engine,
           COUNT(*)::int                     AS windows,
           COALESCE(SUM(audio_seconds), 0)   AS audio_seconds
      FROM diarize_window_label
     WHERE created_at >= (now() - make_interval(days => ${days}))
       AND NOT (EXISTS (SELECT 1 FROM room_day r0, unnest(${BLIND_DAYS_ARG}::date[], ${BLIND_ROOMS_ARG}::text[]) AS b0(d, r) WHERE r0.id = diarize_window_label.room_day_id AND b0.d = r0.ist_date AND b0.r = r0.room_id)
            OR EXISTS (SELECT 1 FROM bench_window w LEFT JOIN room_diarize_window dw ON dw.window_id = w.id WHERE w.id = diarize_window_label.window_id AND (
                 EXISTS (SELECT 1 FROM room_day r1, unnest(${BLIND_DAYS_ARG}::date[], ${BLIND_ROOMS_ARG}::text[]) AS b(d, r) WHERE r1.id IN (w.room_day_id, dw.room_day_id) AND b.d = r1.ist_date AND b.r = r1.room_id)
                 OR EXISTS (SELECT 1 FROM room_turn_speaker t JOIN room_day r2 ON r2.id = t.room_day_id, unnest(${BLIND_DAYS_ARG}::date[], ${BLIND_ROOMS_ARG}::text[]) AS b2(d, r) WHERE t.window_id = w.id AND b2.d = r2.ist_date AND b2.r = r2.room_id)
                 OR EXISTS (SELECT 1 FROM jev_window_text j JOIN room_day r3 ON r3.id = j.room_day_id, unnest(${BLIND_DAYS_ARG}::date[], ${BLIND_ROOMS_ARG}::text[]) AS b3(d, r) WHERE j.window_id = w.id AND b3.d = r3.ist_date AND b3.r = r3.room_id)
                 OR EXISTS (SELECT 1 FROM room_span_emotion e JOIN room_day r4 ON r4.id = e.room_day_id, unnest(${BLIND_DAYS_ARG}::date[], ${BLIND_ROOMS_ARG}::text[]) AS b4(d, r) WHERE e.window_id = w.id AND b4.d = r4.ist_date AND b4.r = r4.room_id))))
     GROUP BY 1, 2
     ORDER BY 1 DESC, 2 ASC
  `) as Array<{ ist_date: string; engine: string; windows: number; audio_seconds: string | number }>;

  const rate = eurPerAudioHour(opts.env);
  return rows.map((r) => {
    const hours = Number(r.audio_seconds) / 3600;
    return {
      ist_date: r.ist_date,
      engine: r.engine as DiarizeEngine,
      windows: Number(r.windows),
      audio_hours: Math.round(hours * 1000) / 1000,
      // Only the paid engine gets a cost. Reporting EUR 0.00 for the local one would invite the
      // reader to add the column up and believe the total.
      estimated_eur: r.engine === "pyannoteai" ? Math.round(hours * rate * 10000) / 10000 : null,
    };
  });
}

/** K3-4: the labels in the window that were left out of dailyLabelCounts because the window or its room-day is held out (counts only). */
export async function blindLabelCount(opts: { days?: number } = {}): Promise<number> {
  const days = Number.isFinite(opts.days) && (opts.days as number) > 0 ? Math.min(Math.floor(opts.days as number), 90) : 14;
  const rows = (await sql`
    SELECT COUNT(*)::int AS n FROM diarize_window_label
     WHERE created_at >= (now() - make_interval(days => ${days}))
       AND (EXISTS (SELECT 1 FROM room_day r0, unnest(${BLIND_DAYS_ARG}::date[], ${BLIND_ROOMS_ARG}::text[]) AS b0(d, r) WHERE r0.id = diarize_window_label.room_day_id AND b0.d = r0.ist_date AND b0.r = r0.room_id)
            OR EXISTS (SELECT 1 FROM bench_window w LEFT JOIN room_diarize_window dw ON dw.window_id = w.id WHERE w.id = diarize_window_label.window_id AND (
                 EXISTS (SELECT 1 FROM room_day r1, unnest(${BLIND_DAYS_ARG}::date[], ${BLIND_ROOMS_ARG}::text[]) AS b(d, r) WHERE r1.id IN (w.room_day_id, dw.room_day_id) AND b.d = r1.ist_date AND b.r = r1.room_id)
                 OR EXISTS (SELECT 1 FROM room_turn_speaker t JOIN room_day r2 ON r2.id = t.room_day_id, unnest(${BLIND_DAYS_ARG}::date[], ${BLIND_ROOMS_ARG}::text[]) AS b2(d, r) WHERE t.window_id = w.id AND b2.d = r2.ist_date AND b2.r = r2.room_id)
                 OR EXISTS (SELECT 1 FROM jev_window_text j JOIN room_day r3 ON r3.id = j.room_day_id, unnest(${BLIND_DAYS_ARG}::date[], ${BLIND_ROOMS_ARG}::text[]) AS b3(d, r) WHERE j.window_id = w.id AND b3.d = r3.ist_date AND b3.r = r3.room_id)
                 OR EXISTS (SELECT 1 FROM room_span_emotion e JOIN room_day r4 ON r4.id = e.room_day_id, unnest(${BLIND_DAYS_ARG}::date[], ${BLIND_ROOMS_ARG}::text[]) AS b4(d, r) WHERE e.window_id = w.id AND b4.d = r4.ist_date AND b4.r = r4.room_id))))
  `) as Array<{ n: number }>;
  return Number(rows[0]?.n ?? 0);
}

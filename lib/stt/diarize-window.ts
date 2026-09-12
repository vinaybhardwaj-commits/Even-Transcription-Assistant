/**
 * lib/stt/diarize-window.ts — C2 Part B. Speaker spans for a room window.
 *
 * THIS IS AN ALIGNMENT, NOT A TRANSCRIPTION. `/diarize` returns timings and a speaker index and no
 * text at all (`{start_ms, end_ms, speaker_idx, overlap}`), so the work here is a join: take the
 * turns this window already produced, and for each one ask which speaker was talking during it.
 * Nothing re-transcribes, and no audio or text crosses a step boundary.
 *
 * THE JOIN IS ON THE TURNS, and the turns are whisper's. `stt_turn` cues carry `start_ms`/`end_ms`
 * derived from whisper's SEGMENT timings today; the spec prefers WORD-level timings, and whisper's
 * verbose_json does return them (`{word, start, end, t_dtw, probability}`). Word timings matter
 * exactly where a speaker changes mid-segment, because a segment that straddles the change smears
 * across both and the overlap-max rule below then binds the whole thing to whoever held more of it.
 * The cue is the unit this table is keyed by (`source_ref`), so word timings are a REFINEMENT OF
 * THE CUE BOUNDARY, not a new row type — and they are not available on the cue today. Flagged in
 * the build report rather than faked: binding to a boundary we do not have would be a precision
 * claim with nothing behind it.
 */
import { sql } from "@/lib/db";
import { runDiarize, type DiarizeSpeaker } from "@/lib/diarize";
import { parseDiarizeSegments, bindTurnsToSpeakers, type TurnSpan } from "./speaker-clusters";
import { rolesByIndex, UNATTRIBUTED, type SpanRole } from "./speaker-roles";

/** The two clinicians with live centroids today. Loaded, never typed — see loadClinicianCentroids. */
export type ClinicianCentroid = { clinician_id: string; full_name: string; centroid_base64: string };

/**
 * EVERY enrolled voiceprint, not one.
 *
 * The encounter path loads the centroid for the encounter's own doctor, because it knows whose
 * consultation it is. A room window does not: a room has whoever walked into it. So this offers
 * the service every enrolled voice and lets the cosine match decide — which is the only thing that
 * may decide (see speaker-roles.ts).
 */
export async function loadClinicianCentroids(): Promise<ClinicianCentroid[]> {
  const rows = (await sql`
    SELECT vp.doctor_id AS clinician_id,
           COALESCE(d.full_name, vp.doctor_id) AS full_name,
           encode(vp.centroid, 'base64') AS centroid_base64
      FROM voice_print vp
      LEFT JOIN clinician d ON d.id = vp.doctor_id
     WHERE vp.centroid IS NOT NULL
     ORDER BY vp.doctor_id
  `) as Array<{ clinician_id: string; full_name: string | null; centroid_base64: string | null }>;
  return rows
    .filter((r) => !!r.centroid_base64)
    .map((r) => ({ clinician_id: r.clinician_id, full_name: r.full_name ?? r.clinician_id, centroid_base64: r.centroid_base64! }));
}

/** This window's turn cues — the rows the spans are joined onto. Same query shape as the cron path. */
export async function loadWindowTurns(roomDayId: string, startMs: number, endMs: number): Promise<TurnSpan[]> {
  const rows = (await sql`
    SELECT source_ref,
           (payload->>'start_ms')::bigint AS start_ms,
           (payload->>'end_ms')::bigint AS end_ms
      FROM cue
     WHERE room_day_id = ${roomDayId}
       AND type = 'stt_turn'
       AND (payload->'window'->>'start_ms')::bigint = ${startMs}
       AND (payload->'window'->>'end_ms')::bigint = ${endMs}
       AND source_ref IS NOT NULL
  `) as Array<{ source_ref: string; start_ms: string | number; end_ms: string | number }>;
  return rows
    .map((t) => ({ source_ref: String(t.source_ref), start_ms: Number(t.start_ms), end_ms: Number(t.end_ms) }))
    .filter((t) => Number.isFinite(t.start_ms) && Number.isFinite(t.end_ms));
}

export type DiarizeWindowOutcome = {
  spans: number;
  turns: number;
  bound: number;
  speakers: number;
  attributed_speakers: number;
  attributed_turns: number;
  latency_ms: number | null;
};

/**
 * Run the service, align, and write. `encounter_id` carries the WINDOW ID, deliberately.
 *
 * The service treats that field as opaque: it is a required Form value (`server.py:131`) echoed
 * back in the response (`:295`) and used nowhere else — it touches no database and persists
 * nothing. So passing the window id is honest labelling, and inventing an `encounter` row for room
 * audio to satisfy a field name would be creating clinical records to please a string.
 */
export async function diarizeWindow(opts: {
  windowId: string;
  roomDayId: string;
  startMs: number;
  endMs: number;
  audio: Uint8Array;
  contentType?: string;
  centroids?: ClinicianCentroid[];
}): Promise<{ ok: true; outcome: DiarizeWindowOutcome } | { ok: false; error: string; retryable: boolean }> {
  const centroids = opts.centroids ?? (await loadClinicianCentroids());

  const res = await runDiarize(opts.audio, opts.contentType ?? "audio/webm", {
    encounterId: opts.windowId,
    clinicianCentroids: centroids,
  });
  // Branch on `ok`. /diarize returns real 4xx, but its sibling /enroll answers 200 with ok:false,
  // and a client that reads status learns the wrong lesson from whichever it meets first.
  if (!res.ok) return { ok: false, error: res.error, retryable: res.retryable === true };

  const speakers = (res.result.speakers ?? []) as DiarizeSpeaker[];
  const roles = rolesByIndex(speakers);
  const segments = parseDiarizeSegments(res.result.transcript_segments);
  const turns = await loadWindowTurns(opts.roomDayId, opts.startMs, opts.endMs);

  // Clip-relative → wall clock, once, here: the service times from the start of the audio it was
  // given, the cues are stamped on the day's clock.
  const onClock = segments.map((s) => ({ ...s, start_ms: opts.startMs + s.start_ms, end_ms: opts.startMs + s.end_ms }));
  const bindings = bindTurnsToSpeakers(onClock, turns);

  let attributedTurns = 0;
  for (const b of bindings) {
    const r: SpanRole = roles.get(b.speaker_idx) ?? UNATTRIBUTED;
    if (r.role === "clinician") attributedTurns += 1;
    await sql`
      INSERT INTO room_turn_speaker
        (window_id, source_ref, speaker_idx, cluster_id, overlap_ms, room_day_id,
         clinician_id, role, match_confidence, created_at)
      VALUES
        (${opts.windowId}, ${b.source_ref}, ${b.speaker_idx}, NULL, ${b.overlap_ms}, ${opts.roomDayId},
         ${r.clinician_id}, ${r.role}, ${r.match_confidence}, NOW())
      ON CONFLICT (window_id, source_ref) DO UPDATE
        SET speaker_idx = EXCLUDED.speaker_idx,
            overlap_ms = EXCLUDED.overlap_ms,
            clinician_id = EXCLUDED.clinician_id,
            role = EXCLUDED.role,
            match_confidence = EXCLUDED.match_confidence
    `;
  }

  let attributedSpeakers = 0;
  for (const r of roles.values()) if (r.role === "clinician") attributedSpeakers += 1;

  return {
    ok: true,
    outcome: {
      spans: segments.length,
      turns: turns.length,
      bound: bindings.length,
      speakers: roles.size,
      attributed_speakers: attributedSpeakers,
      attributed_turns: attributedTurns,
      latency_ms: res.latencyMs ?? null,
    },
  };
}

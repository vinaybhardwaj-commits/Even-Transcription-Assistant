/**
 * lib/stt/diarize-window.ts — C2 Part B. Speaker spans for a room window.
 *
 * THIS IS AN ALIGNMENT, NOT A TRANSCRIPTION. `/diarize` returns timings and a speaker index and no
 * text at all (`{start_ms, end_ms, speaker_idx, overlap}`), so the work here is a join: take the
 * turns this window already produced, and for each one ask which speaker was talking during it.
 * Nothing re-transcribes, and no audio or text crosses a step boundary.
 *
 * THE JOIN IS ON THE TURNS, and the turns are whisper's. `stt_turn` cues carry `start_ms`/`end_ms`
 * derived from whisper's SEGMENT timings; word-level timings exist in whisper's verbose_json but
 * are not persisted on the cue, so the cue is the finest boundary available here.
 *
 * THAT LIMIT IS NOW HANDLED RATHER THAN ADMITTED. Where a speaker boundary falls inside a turn, the
 * earlier version bound the whole turn to whoever held more of it and wrote a name across the lot —
 * so 400 ms of a patient's speech could be recorded as the doctor's. A turn containing a speaker
 * change now gets its `speaker_idx` (the dominant one, still useful) and NO role at all. The same
 * rule covers a turn crossing a SLICE seam: two slices are two separate clusterings, so a turn
 * spanning them has no single speaker to name.
 */
import { sql } from "@/lib/db";
import { runDiarize, type DiarizeSpeaker } from "@/lib/diarize";
import { parseDiarizeSegments, type TurnSpan } from "./speaker-clusters";
import { rolesByIndex, UNATTRIBUTED, bindTurnsExclusive, type SpanRole } from "./speaker-roles";
import { DIARIZE_BATCH_THRESHOLD, type StitchedIdentity } from "./diarize-slicing";

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

export type DiarizeSliceOutcome = {
  slice: number;
  spans: number;
  turns: number;
  bound: number;
  named: number;
  straddled: number;
  seam_skipped: number;
  speakers: number;
  latency_ms: number | null;
};

/** PURE. A turn crossing a slice boundary belongs to two clusterings and can be named by neither. */
export function crossesSeam(turn: { start_ms: number; end_ms: number }, slice: { start_ms: number; end_ms: number }): boolean {
  return turn.start_ms < slice.start_ms || turn.end_ms > slice.end_ms;
}

/**
 * Diarize ONE SLICE of a window and write its spans.
 *
 * `encounter_id` carries the WINDOW id (plus the slice), deliberately. The service treats that
 * field as opaque — a required Form value echoed back and used nowhere else, touching no database —
 * so inventing an `encounter` row for room audio to satisfy a field name would be creating clinical
 * records to please a string.
 */
export async function diarizeSlice(opts: {
  windowId: string;
  roomDayId: string;
  slice: { index: number; start_ms: number; end_ms: number };
  audio: Uint8Array;
  contentType?: string;
  centroids?: ClinicianCentroid[];
}): Promise<
  | { ok: true; outcome: DiarizeSliceOutcome; speakers: DiarizeSpeaker[] }
  | { ok: false; error: string; retryable: boolean }
> {
  const centroids = opts.centroids ?? (await loadClinicianCentroids());

  const res = await runDiarize(opts.audio, opts.contentType ?? "audio/webm", {
    encounterId: `${opts.windowId}#${opts.slice.index}`,
    clinicianCentroids: centroids,
    // D5 — the validated floor, on the wire, every time. The service's own default is 0.70 and is
    // not ours; a stricter remote default fails quietly, which is how an unvalidated number
    // governs identity for months.
    batchThreshold: DIARIZE_BATCH_THRESHOLD,
  });
  if (!res.ok) return { ok: false, error: res.error, retryable: res.retryable === true };

  const speakers = (res.result.speakers ?? []) as DiarizeSpeaker[];
  const roles = rolesByIndex(speakers);
  const segments = parseDiarizeSegments(res.result.transcript_segments);
  const turns = await loadWindowTurns(opts.roomDayId, opts.slice.start_ms, opts.slice.end_ms);

  // Slice-relative → wall clock, once, here.
  const onClock = segments.map((sg) => ({ ...sg, start_ms: opts.slice.start_ms + sg.start_ms, end_ms: opts.slice.start_ms + sg.end_ms }));
  const bindings = bindTurnsExclusive(onClock, turns);
  const byRef = new Map(turns.map((t) => [t.source_ref, t]));

  let named = 0, straddled = 0, seamSkipped = 0;
  for (const b of bindings) {
    const turn = byRef.get(b.source_ref)!;
    const seam = crossesSeam(turn, opts.slice);
    // THREE conditions, all required, before a name may be written. Any one failing leaves the
    // span with its speaker_idx and nothing else.
    const r: SpanRole = !b.exclusive || seam ? UNATTRIBUTED : (roles.get(b.speaker_idx) ?? UNATTRIBUTED);
    if (!b.exclusive) straddled += 1;
    if (seam) seamSkipped += 1;
    if (r.role === "clinician") named += 1;
    await sql`
      INSERT INTO room_turn_speaker
        (window_id, source_ref, speaker_idx, cluster_id, overlap_ms, room_day_id,
         clinician_id, role, match_confidence, created_at)
      VALUES
        (${opts.windowId}, ${b.source_ref}, ${b.speaker_idx}, ${`s${opts.slice.index}:${b.speaker_idx}`}, ${b.overlap_ms}, ${opts.roomDayId},
         ${r.clinician_id}, ${r.role}, ${r.match_confidence}, NOW())
      ON CONFLICT (window_id, source_ref) DO UPDATE
        SET speaker_idx = EXCLUDED.speaker_idx,
            -- D9: cluster_id travels with speaker_idx. Replacing one and keeping the other leaves
            -- a row whose cluster came from a different clustering than its index.
            cluster_id = EXCLUDED.cluster_id,
            overlap_ms = EXCLUDED.overlap_ms,
            clinician_id = EXCLUDED.clinician_id,
            role = EXCLUDED.role,
            match_confidence = EXCLUDED.match_confidence
    `;
  }

  return {
    ok: true,
    speakers,
    outcome: {
      slice: opts.slice.index,
      spans: segments.length,
      turns: turns.length,
      bound: bindings.length,
      named,
      straddled,
      seam_skipped: seamSkipped,
      speakers: roles.size,
      latency_ms: res.latencyMs ?? null,
    },
  };
}

/**
 * Apply the cross-slice stitch: give every span its identity's cluster_id, and propagate a
 * clinician to slices where the service did not match it itself.
 *
 * A propagated name is still a name granted by a cosine match — the service's, then ours, both at
 * the same floor — and it carries the WEAKEST confidence in that chain rather than the last hop's.
 * A straddled or seam-crossing span is never given one: those rows were disqualified for a reason
 * the stitch does not address.
 */
export async function applyStitch(windowId: string, identities: Map<string, StitchedIdentity>): Promise<number> {
  let updated = 0;
  for (const [k, id] of identities) {
    const [sliceStr, idxStr] = k.split(":");
    const clusterKey = `s${sliceStr}:${idxStr}`;
    const rows = (await sql`
      UPDATE room_turn_speaker
         SET cluster_id = ${id.cluster_id},
             clinician_id = CASE WHEN role = 'clinician' THEN clinician_id
                                 WHEN role = 'unattributed' AND ${id.clinician_id}::text IS NOT NULL THEN ${id.clinician_id}
                                 ELSE clinician_id END,
             role = CASE WHEN role = 'unattributed' AND ${id.clinician_id}::text IS NOT NULL THEN 'clinician' ELSE role END,
             match_confidence = CASE WHEN role = 'unattributed' AND ${id.clinician_id}::text IS NOT NULL THEN ${id.match_confidence}
                                     ELSE match_confidence END
       WHERE window_id = ${windowId} AND cluster_id = ${clusterKey}
       RETURNING source_ref
    `) as Array<{ source_ref: string }>;
    updated += rows.length;
  }
  return updated;
}

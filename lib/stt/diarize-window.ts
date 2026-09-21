/**
 * lib/stt/diarize-window.ts — C2 Part B. Speaker spans for a room window: ONE /diarize call.
 *
 * THIS IS AN ALIGNMENT, NOT A TRANSCRIPTION. `/diarize` returns timings and a speaker index and no
 * text at all (`{start_ms, end_ms, speaker_idx, overlap}`), so the work here is a join: take the
 * turns this window already produced, and for each one ask which speaker was talking during it.
 * Nothing re-transcribes, and no audio or text crosses a step boundary.
 *
 * ONE CALL PER WINDOW. An earlier version sliced the window into 120 s pieces, stitched speaker
 * identity back together across them, and snapped the cuts to turn gaps — all to fit a 240 s lease
 * under an assumed 1.5x realtime. Measured on the Mini across four real 900 s windows the service
 * runs at 0.071-0.085x (64-76 s wall), flat in speech density, so a whole window fits the lease
 * with 3x headroom. The slicing, the stitch and the seams were machinery built around a wrong
 * number, and they are gone.
 *
 * THE JOIN IS ON THE TURNS, and the turns are whisper's. `stt_turn` cues carry whisper's SEGMENT
 * bounds; word-level timings exist in verbose_json but are not persisted on the cue, so the cue is
 * the finest boundary available. Where a speaker boundary falls INSIDE a turn, that turn keeps its
 * dominant `speaker_idx` and gets NO role — `no_role_reason: 'straddle'` — rather than a name
 * smeared across someone else's speech.
 */
import { gateSegments, speechGateEnabled, ungatedSegments, type WindowSpeech } from "./speech-gate";
import { sql } from "@/lib/db";
import { runDiarize, type DiarizeSpeaker } from "@/lib/diarize";
import { parseDiarizeSegments, type TurnSpan } from "./speaker-clusters";
import { rolesByIndex, UNATTRIBUTED, noRole, bindTurnsExclusive, type SpanRole } from "./speaker-roles";
import { shadowMatch, shadowTrusted, SCORE_BASIS_APP_RECOMPUTED } from "./losing-score";
import { ms, type WindowStartMs, type WindowEndMs } from "./window-bounds";

/**
 * The cosine floor for accepting that an enrolled centroid matches a voice.
 *
 * SENT EXPLICITLY ON EVERY CALL. The service defaults to 0.70 (`server.py:134`) and that default is
 * not ours: it is stricter, so the failure is quiet — fewer attributions, no error — which is how
 * an unvalidated number governs identity for months. 0.65 is the validated figure; it travels.
 */
export const DIARIZE_BATCH_THRESHOLD = 0.65;

/** An enrolled clinician's voiceprint, as /diarize wants it. Loaded, never typed. */
export type ClinicianCentroid = { clinician_id: string; full_name: string; centroid_base64: string };

/**
 * EVERY enrolled voiceprint of an ACTIVE clinician, not one.
 *
 * The encounter path loads the centroid for the encounter's own doctor, because it knows whose
 * consultation it is. A room window does not: a room has whoever walked into it. So this offers
 * the service every enrolled voice and lets the cosine match decide — which is the only thing that
 * may decide (see speaker-roles.ts).
 *
 * ACTIVE ONLY: `status = 'active' AND deleted_at IS NULL`, the predicate the admin dashboard already
 * counts active clinicians by. A disabled or deleted clinician's voiceprint stays on disk and is no
 * longer offered, so a departed doctor's voice cannot be attributed to a room. A voiceprint with no
 * clinician row at all is not offered either — the join is INNER. `locked` (the PIN lockout) is not
 * active by this predicate; such a clinician drops out of matching until an admin resets the PIN.
 */
export async function loadClinicianCentroids(): Promise<ClinicianCentroid[]> {
  const rows = (await sql`
    SELECT vp.doctor_id AS clinician_id,
           d.full_name,
           encode(vp.centroid, 'base64') AS centroid_base64
      FROM voice_print vp
      JOIN clinician d ON d.id = vp.doctor_id
     WHERE vp.centroid IS NOT NULL
       AND d.status = 'active'
       AND d.deleted_at IS NULL
     ORDER BY vp.doctor_id
  `) as Array<{ clinician_id: string; full_name: string | null; centroid_base64: string | null }>;
  return rows
    .filter((r) => !!r.centroid_base64)
    .map((r) => ({ clinician_id: r.clinician_id, full_name: r.full_name ?? r.clinician_id, centroid_base64: r.centroid_base64! }));
}

/**
 * ONE clinician's voiceprint, for an ENCOUNTER — the encounter knows whose consultation it is.
 * Same active predicate as loadClinicianCentroids: a disabled or deleted doctor's voice is not
 * offered, and the encounter is still processed with heuristic speaker labels.
 */
export async function loadActiveClinicianCentroid(doctorId: string): Promise<ClinicianCentroid | null> {
  const rows = (await sql`
    SELECT encode(vp.centroid, 'base64') AS centroid_b64, d.full_name AS full_name
      FROM voice_print vp JOIN clinician d ON d.id = vp.doctor_id
     WHERE vp.doctor_id = ${doctorId}
       AND d.status = 'active'
       AND d.deleted_at IS NULL
     LIMIT 1
  `) as Array<{ centroid_b64: string | null; full_name: string }>;
  if (!rows[0]?.centroid_b64) return null;
  return { clinician_id: doctorId, full_name: rows[0].full_name, centroid_base64: rows[0].centroid_b64 };
}

/**
 * Every turn of a window.
 *
 * `payload->'window'` holds the WINDOW bounds `buildTurns` stamps on every cue, and it identifies
 * which window's turns these are. The bounds are branded `WindowStartMs`/`WindowEndMs` because this
 * exact join once compared window bounds against a different quantity passed as a plain `number`
 * and matched nothing for every window; the brand makes that a compile error.
 */
export async function loadWindowTurns(roomDayId: string, window: { start: WindowStartMs; end: WindowEndMs }): Promise<TurnSpan[]> {
  const rows = (await sql`
    SELECT source_ref,
           (payload->>'start_ms')::bigint AS start_ms,
           (payload->>'end_ms')::bigint AS end_ms
      FROM cue
     WHERE room_day_id = ${roomDayId}
       AND type = 'stt_turn'
       AND (payload->'window'->>'start_ms')::bigint = ${ms(window.start)}
       AND (payload->'window'->>'end_ms')::bigint = ${ms(window.end)}
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
  named: number;
  straddled: number;
  speakers: number;
  latency_ms: number | null;
  /** E20: no_match turns that got a losing score and clinician (score_basis 'app_recomputed'). */
  losing_recorded: number;
  /** E20: the control on the app-side recomputation, for THIS window (lib/stt/losing-score.ts). */
  shadow: { matched_checked: number; disagreements: number; unmatched_above_threshold: number; unrecomputable: number; max_abs_diff: number | null; trusted: boolean };
};

/**
 * Diarize a whole window and write its spans.
 *
 * `encounter_id` carries the WINDOW id, deliberately. The service treats that field as opaque — a
 * required Form value echoed back and used nowhere else, touching no database — so inventing an
 * `encounter` row for room audio to satisfy a field name would be creating clinical records to
 * please a string.
 */
export async function diarizeWindow(opts: {
  windowId: string;
  roomDayId: string;
  window: { start: WindowStartMs; end: WindowEndMs };
  audio: Uint8Array;
  contentType?: string;
  centroids?: ClinicianCentroid[];
  /** One id per run, stamped on every turn row this run writes (0090). */
  runId: string;
  /**
   * What the VAD said about this window's audio, when the caller asked it. Supplied by the caller
   * rather than fetched here so this function stays testable without a service, and so a caller
   * that has no VAD simply does not pass one — which judges nothing.
   */
  speech?: WindowSpeech;
}): Promise<
  | { ok: true; outcome: DiarizeWindowOutcome; speakers: DiarizeSpeaker[]; segments: unknown[]; timing: unknown }
  | { ok: false; error: string; retryable: boolean; timing: unknown }
> {
  const centroids = opts.centroids ?? (await loadClinicianCentroids());

  const res = await runDiarize(opts.audio, opts.contentType ?? "audio/webm", {
    encounterId: opts.windowId,
    clinicianCentroids: centroids,
    // The validated floor, on the wire, every time — never the service's own 0.70 default.
    batchThreshold: DIARIZE_BATCH_THRESHOLD,
  });
  // Branch on `ok`. /diarize returns real 4xx, but its sibling /enroll answers 200 with ok:false,
  // and a client that reads status learns the wrong lesson from whichever it meets first.
  if (!res.ok) return { ok: false, error: res.error, retryable: res.retryable === true, timing: res.timing ?? null };

  const speakers = (res.result.speakers ?? []) as DiarizeSpeaker[];
  const roles = rolesByIndex(speakers);
  const rawSegments = parseDiarizeSegments(res.result.transcript_segments);

  // ── THE SPEECH GATE ──────────────────────────────────────────────────────────────────────
  // Between pyannote and storage, which is the only place a re-check can happen: the service has
  // already decided, and the rows below are what everything downstream reads. DEFAULT OFF, and
  // it FLAGS rather than drops — `segments` keeps every span pyannote returned either way, so a
  // window stores the same count it always did and the gate can be retuned against stored data.
  const gateOn = speechGateEnabled();
  const gated = gateOn
    ? gateSegments(rawSegments, opts.speech ?? { ok: false, reason: "vad_unavailable" })
    : { segments: ungatedSegments(rawSegments), summary: null };
  const segments = gated.segments;
  if (gateOn && gated.summary) {
    console.log(`[diarize-window] ${opts.windowId}: speech gate ` + JSON.stringify(gated.summary));
  }
  const turns = await loadWindowTurns(opts.roomDayId, opts.window);

  // Clip-relative → wall clock, once, here: the service times from the start of the audio it was
  // given, the cues are stamped on the day's clock.
  const onClock = segments.map((sg) => ({ ...sg, start_ms: ms(opts.window.start) + sg.start_ms, end_ms: ms(opts.window.start) + sg.end_ms }));
  const bindings = bindTurnsExclusive(onClock, turns);

  // E20 — THE SCORE THAT LOST. The service discards it (server.py:209-216), so it is recomputed from the
  // embeddings it returned, against the SAME centroids this call sent, with the service's greedy exclusion.
  // Written only when this window's control is clean: every matched speaker recomputed to the service's own
  // clinician and 3-dp confidence, and no unmatched speaker recomputed at or above the threshold.
  const shadow = shadowMatch(speakers, centroids, DIARIZE_BATCH_THRESHOLD);
  const trusted = shadowTrusted(shadow.guard);
  if (!trusted) {
    console.warn(`[diarize-window] ${opts.windowId}: losing scores NOT written — shadow disagrees with the service ` +
      `(matched ${shadow.guard.matched_checked}, disagreements ${shadow.guard.disagreements}, unmatched at/above threshold ${shadow.guard.unmatched_above_threshold})`);
  }

  let named = 0, straddled = 0, losingRecorded = 0;
  for (const b of bindings) {
    // A turn held by more than one speaker is refused a name, and the row records WHY.
    const r: SpanRole = !b.exclusive ? noRole("straddle") : (roles.get(b.speaker_idx) ?? UNATTRIBUTED);
    if (!b.exclusive) straddled += 1;
    if (r.role === "clinician") named += 1;
    // ONLY an exclusive no_match turn. A named turn keeps exactly today's row; a straddle never reached the
    // matcher as one speaker and gets nothing. 0096's CHECKs refuse either if this line is ever wrong.
    const losing = trusted && b.exclusive && r.role === null && r.no_role_reason === "no_match" ? shadow.losingByIdx.get(b.speaker_idx) : undefined;
    if (losing) losingRecorded += 1;
    await sql`
      INSERT INTO room_turn_speaker
        (window_id, source_ref, speaker_idx, cluster_id, overlap_ms, room_day_id,
         clinician_id, role, match_confidence, no_role_reason, run_id, created_at,
         losing_clinician_id, losing_score, score_basis)
      VALUES
        (${opts.windowId}, ${b.source_ref}, ${b.speaker_idx}, NULL, ${b.overlap_ms}, ${opts.roomDayId},
         ${r.clinician_id}, ${r.role}, ${r.match_confidence}, ${r.no_role_reason}, ${opts.runId}, NOW(),
         ${losing?.clinician_id ?? null}, ${losing?.score ?? null}, ${losing ? SCORE_BASIS_APP_RECOMPUTED : null})
      ON CONFLICT (window_id, source_ref) DO UPDATE
        SET speaker_idx = EXCLUDED.speaker_idx,
            run_id = EXCLUDED.run_id,
            -- cluster_id travels with speaker_idx: replacing one and keeping the other would leave
            -- a row whose cluster came from a different clustering than its index.
            cluster_id = EXCLUDED.cluster_id,
            overlap_ms = EXCLUDED.overlap_ms,
            clinician_id = EXCLUDED.clinician_id,
            role = EXCLUDED.role,
            match_confidence = EXCLUDED.match_confidence,
            no_role_reason = EXCLUDED.no_role_reason,
            -- A re-run replaces the losing candidate with its own, or clears it: a turn named on the
            -- re-run must not keep the previous run's losing score beside its name.
            losing_clinician_id = EXCLUDED.losing_clinician_id,
            losing_score = EXCLUDED.losing_score,
            score_basis = EXCLUDED.score_basis
    `;
  }
  const diffs = shadow.guard.diffs;

  return {
    ok: true,
    // PASSED THROUGH, not derived: the exact response the caller needs for room_diarize_window.
    speakers,
    segments,
    timing: res.timing ?? null,
    outcome: {
      spans: segments.length,
      turns: turns.length,
      bound: bindings.length,
      named,
      straddled,
      speakers: roles.size,
      latency_ms: res.latencyMs ?? null,
      losing_recorded: losingRecorded,
      shadow: {
        matched_checked: shadow.guard.matched_checked,
        disagreements: shadow.guard.disagreements,
        unmatched_above_threshold: shadow.guard.unmatched_above_threshold,
        unrecomputable: shadow.guard.unrecomputable,
        max_abs_diff: diffs.length ? Math.max(...diffs) : null,
        trusted,
      },
    },
  };
}

/**
 * The /diarize speakers array AS STORED. The service's heuristic `type`, `label`, `source` and
 * `role_source` are its own guess about who a voice is — not an attribution. Stored at the top level,
 * one join on the speaker index made an unmatched speaker read as whatever the service guessed. They
 * are kept, nested under a key that says what they are; the embedding, index, timings and any
 * voiceprint match (clinician_id, confidence) stay where readers expect them. A role in this system
 * comes only from a voiceprint match (room_turn_speaker.role).
 */
export const SERVICE_GUESS_KEY = "unverified_service_guess";
const GUESS_FIELDS = ["type", "label", "source", "role_source"] as const;
export function speakersForStorage(speakers: DiarizeSpeaker[]): Array<Record<string, unknown>> {
  return speakers.map((sp) => {
    const rest: Record<string, unknown> = { ...(sp as unknown as Record<string, unknown>) };
    const guess: Record<string, unknown> = {};
    for (const f of GUESS_FIELDS) {
      if (rest[f] !== undefined) guess[f] = rest[f];
      delete rest[f];
    }
    guess.is = "the diarize service's own heuristic guess, not an attribution; a role comes only from a voiceprint match";
    return { ...rest, [SERVICE_GUESS_KEY]: guess };
  });
}

export type DiarizeWindowState = "ok" | "failed" | "no_speakers";

/**
 * THE ONLY WRITER OF room_diarize_window — except the one named repair path below,
 * `repairStaleDiarizeSegments`, which may replace speakers/segments for a window whose emotion row is
 * already `diarize_stale` (E24 R10), and nothing else.
 *
 * MOVED from the room diarize pass (`markWindow`) when the pass was deleted in C2. Same columns and
 * values, so the one live reader — `app/api/admin/speaker-calibration/route.ts` — sees the row shape
 * it always has. That reader is how SPEAKER_MATCH_THRESHOLD gets frozen.
 *
 * FIRST WRITE INSERTS. A LATER WRITE REPLACES ONLY A `failed` ROW, and preserves it: the previous
 * attempt's error and time are appended to `failure_history` and `attempts` goes up by one. A row
 * in any other state is final and a second write changes nothing, exactly as the old
 * `DO NOTHING` did. The retry BOUND is not here — it is in the enqueue scan
 * (DIARIZE_MAX_ATTEMPTS) — so an attempt that did run is always recorded, never dropped.
 *
 * NO try/catch. On the job a throw fails the step, which is the honest outcome — a state row that
 * could not be written is not a window that was diarized.
 *
 * `skipped` is not written: on the job "no slot" fails the step as `diarize_unavailable`, which the
 * queue retries. The CHECK still permits it.
 */
export async function recordDiarizeWindow(row: {
  windowId: string;
  roomDayId: string;
  state: DiarizeWindowState;
  error: string | null;
  speakers: DiarizeSpeaker[] | null;
  segments: unknown[] | null;
  clipR2Key: string | null;
  timing: unknown;
  /** The run's id. Recorded as last_run_id only when the run wrote turns (ok or no_speakers). */
  runId: string;
}): Promise<void> {
  const wroteTurns = row.state === "ok" || row.state === "no_speakers";
  // Every column but last_run_id is replaced only when the stored row FAILED (0088). last_run_id moves
  // on EVERY run that wrote turns — a successful re-run of an ok window included — because that is
  // the one signal a reader of the turns can compare against (0090).
  // E24 R9 (0099): segments_run_id is written on EXACTLY the terms segments_json is — the same value on
  // insert, the same CASE on conflict — so it always names the run whose segments are stored. The keep-rule
  // itself is unchanged (R10).
  await sql`
    INSERT INTO room_diarize_window
      (window_id, room_day_id, state, speakers_json, segments_json, segments_run_id, clip_r2_key, error, timing_json, last_run_id, diarized_at)
    VALUES
      (${row.windowId}, ${row.roomDayId}, ${row.state},
       ${row.speakers === null ? null : JSON.stringify(speakersForStorage(row.speakers))}::jsonb,
       ${row.segments === null ? null : JSON.stringify(row.segments)}::jsonb,
       ${row.segments === null ? null : row.runId},
       ${row.clipR2Key}, ${row.error === null ? null : row.error.slice(0, 300)},
       ${row.timing === null || row.timing === undefined ? null : JSON.stringify(row.timing)}::jsonb,
       ${wroteTurns ? row.runId : null}, NOW())
    ON CONFLICT (window_id) DO UPDATE SET
      state           = CASE WHEN room_diarize_window.state = 'failed' THEN EXCLUDED.state ELSE room_diarize_window.state END,
      speakers_json   = CASE WHEN room_diarize_window.state = 'failed' THEN EXCLUDED.speakers_json ELSE room_diarize_window.speakers_json END,
      segments_json   = CASE WHEN room_diarize_window.state = 'failed' THEN EXCLUDED.segments_json ELSE room_diarize_window.segments_json END,
      segments_run_id = CASE WHEN room_diarize_window.state = 'failed' THEN EXCLUDED.segments_run_id ELSE room_diarize_window.segments_run_id END,
      clip_r2_key     = CASE WHEN room_diarize_window.state = 'failed' THEN EXCLUDED.clip_r2_key ELSE room_diarize_window.clip_r2_key END,
      error           = CASE WHEN room_diarize_window.state = 'failed' THEN EXCLUDED.error ELSE room_diarize_window.error END,
      timing_json     = CASE WHEN room_diarize_window.state = 'failed' THEN EXCLUDED.timing_json ELSE room_diarize_window.timing_json END,
      diarized_at     = CASE WHEN room_diarize_window.state = 'failed' THEN EXCLUDED.diarized_at ELSE room_diarize_window.diarized_at END,
      attempts        = CASE WHEN room_diarize_window.state = 'failed' THEN room_diarize_window.attempts + 1 ELSE room_diarize_window.attempts END,
      failure_history = CASE WHEN room_diarize_window.state = 'failed'
                             THEN room_diarize_window.failure_history || jsonb_build_array(jsonb_build_object(
                                    'attempt', room_diarize_window.attempts,
                                    'error', room_diarize_window.error,
                                    'diarized_at', room_diarize_window.diarized_at))
                             ELSE room_diarize_window.failure_history END,
      last_run_id     = COALESCE(EXCLUDED.last_run_id, room_diarize_window.last_run_id)
  `;
}

/** The emotion window state that marks a window's diarize segments as another run's (0099). */
export const EMOTION_DIARIZE_STALE_STATE = "diarize_stale";

/**
 * E24 R10 — THE NAMED REPAIR PATH, and the only way a newer run's segments replace an `ok` row's.
 *
 * The keep-rule in `recordDiarizeWindow` is NOT changed: an ok row keeps its segments on a successful
 * re-run, for a reason not yet established (ruling R10). This path is scoped to the case that rule makes
 * permanent — a window the emotion job has already recorded `diarize_stale`, whose segments are another
 * run's — and it accepts THIS run's speakers and segments for that window only, ONE statement, when:
 *   - THIS RUN ENDED `ok` (E25 R13). A `no_speakers` run is refused, not imported: the keep-rule leaves the
 *     row's state `ok`, and the repair never writes state, so importing its empty content would make `state`
 *     name one run and the content another. A failed run never reaches here (the job returns first);
 *   - the diarize row is `ok` and this run is its latest (last_run_id = runId: a later run wins);
 *   - the stored segments are not already this run's;
 *   - the window's emotion row is `diarize_stale` AND its mark was made against the segments stored now
 *     (E25 R15). One mark permits one repair: once the segments are replaced, a further diarize run before
 *     the window is rescored meets the keep-rule like any other window.
 * Any other window is untouched. Call it after `recordDiarizeWindow` for a run that wrote turns.
 * Returns whether the row was repaired. The emotion enqueue then offers the window again, because its
 * emotion row names an older run than last_run_id.
 */
export async function repairStaleDiarizeSegments(row: {
  windowId: string;
  runId: string;
  /** The state THIS run ended in — the same value passed to recordDiarizeWindow. */
  runState: DiarizeWindowState;
  speakers: DiarizeSpeaker[];
  segments: unknown[];
}): Promise<boolean> {
  if (row.runState !== "ok") return false;
  const rows = (await sql`
    UPDATE room_diarize_window d
       SET speakers_json   = ${JSON.stringify(speakersForStorage(row.speakers))}::jsonb,
           segments_json   = ${JSON.stringify(row.segments)}::jsonb,
           segments_run_id = ${row.runId}::text
     WHERE d.window_id = ${row.windowId}
       AND d.state = 'ok'
       AND d.last_run_id = ${row.runId}::text
       AND d.segments_run_id IS DISTINCT FROM ${row.runId}::text
       AND EXISTS (SELECT 1 FROM room_emotion_window e
                    WHERE e.window_id = d.window_id AND e.state = ${EMOTION_DIARIZE_STALE_STATE}::text
                      AND e.stale_segments_run_id IS NOT DISTINCT FROM d.segments_run_id)
    RETURNING d.window_id
  `) as Array<{ window_id: string }>;
  return rows.length === 1;
}

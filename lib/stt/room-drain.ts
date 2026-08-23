/**
 * lib/stt/room-drain.ts — the room tape reaches speech-to-text (K4b Part C).
 *
 * A closed bench_window becomes: one joined clip, one language probe, one paid transcription,
 * one transcription_run, and one window's worth of turn cues. Nothing here runs for a room
 * unless ROOM_STT_DRAIN_ENABLED names that room.
 *
 * ─── WHY TWO ENGINES FOR ONE WINDOW ──────────────────────────────────────────────────────
 * Sarvam returns ONE untimed transcript for a fifteen-minute window. `buildTurns` needs timed
 * segments, and C8's report-only vocabulary needs a real `segment_count` — "1 to 3 segments on a
 * window of ten minutes or more is thin" is meaningless if the count is structurally always 1.
 * So the two jobs are split along what each engine can actually answer:
 *
 *   WHISPER (Mac Mini, free) — segmentation, timing, and language identification.
 *   SARVAM  (paid, routed)   — the window's transcript and its own language label.
 *
 * ONE PAID CALL PER WINDOW. Whisper is local, so running it twice per window (a 30-second probe
 * and the full window) costs nothing but latency and buys both the C3 arbitration and the T5
 * disagreement measurement.
 *
 * The turn cues therefore name WHISPER as their engine, because Whisper produced those segments.
 * That is not a placeholder: it is the engine that did the work, read from the adapter's own
 * `key`. The Sarvam transcript is the transcription_run, which names Sarvam for the same reason.
 *
 * ─── WHY THE LANGUAGE IS PROBED AND FORCED ───────────────────────────────────────────────
 * On 18 June Sarvam picked an Indian language for an English dictation and TRANSLITERATED the
 * English into that script — and the language rule then read Sarvam's own script to confirm
 * Sarvam's own choice. The signal was circular. Fix f9da77f made Whisper's language id the
 * arbitrator (lib/language-route.ts). Calling Sarvam alone removes the arbitrator, so this file
 * puts it back: Whisper decides the language, and Sarvam is TOLD what it is.
 *
 * ─── WHAT THIS FILE MAY NOT DO ───────────────────────────────────────────────────────────
 * No diarization (K5 owns it). No note generation. No fan-out — one routed engine, because a
 * seven-hour day is ~28 windows and nine engines across four rooms would be ~1000 paid calls a
 * day. No VAD and no content threshold: silence is REPORTED from segment counts, never minted.
 */

import { sql } from "@/lib/db";
import { getObjectBytes } from "@/lib/r2";
import { transcribeWithWhisper } from "@/lib/whisper";
import { resolveRange, type CoveringChunk, type RangeChunk } from "@/lib/bench-range";
import { buildJoinRequest, callJoinService, refuseIfTooLong, clipKey, joinServiceConfigured } from "@/lib/bench-join";
import { isRoomDrainEnabled } from "./room-drain-flag";
import { resolveRouting } from "./routing";
import { adapterFor } from "./registry";
import { whisperAdapter } from "./adapters/whisper";
import { isEnglishCode } from "@/lib/language-route";
import { buildTurns, buildWindowCue, writeWindowCues } from "@/lib/mcp/tools/bench";

/** C7 — three attempts, then park with a reason. Never retried again by this module. */
export const DRAIN_MAX_ATTEMPTS = 3;

/** C3 — the probe length. A STARTING VALUE, not a measured one; T5 reports whether it holds. */
export const PROBE_SECONDS = 30;

/**
 * THE CUE `source` IS "replay", NOT A NEW VALUE — and that is a compromise, recorded here
 * rather than hidden. writeWindowCues stamps TURN_CUE_SOURCE on every row it writes, and
 * CueSource is a closed set of exactly two values ("mcp", "replay") in lib/mcp/tools/brain.ts.
 * A third value would mean widening the brain's own vocabulary, which is a bigger change than
 * this build should make two days before a live OPD day.
 *
 * The cost: a drained window's cues are indistinguishable BY SOURCE from an operator replay of
 * the same window. They are still distinguishable by payload — `engine` and the run behind them
 * — so nothing is unrecoverable, but a `WHERE source = ...` cannot separate them. Worth fixing
 * when the brain's source vocabulary is next opened; noted in ETA-BACKLOG-SCOPED.md.
 */

/** The routing stage this drain resolves on. Never 'live' — changing the room engine must not
 *  change the engine a doctor sees during a consultation. */
export const DRAIN_STAGE = "room" as const;

// ---------------------------------------------------------------------------
// PURE — the report-only vocabulary (C8)
// ---------------------------------------------------------------------------

export type WindowActivity = "silent" | "thin" | "loop" | "speech";

/**
 * C8 — DESCRIBE what came back. This function mints nothing.
 *
 * The designer's ruling of 22 August stands: no VAD, no second STT stack, no content threshold.
 * Every branch below is a statement about the COUNT of segments and whether their text repeats —
 * never about whether the audio "sounded like" speech, which is precisely the judgement this
 * system is not allowed to make from a transcript.
 *
 *   silent  segment_count 0 — the transcriber returned nothing at all.
 *   thin    1..3 segments on a window of ten minutes or more.
 *   loop    every non-blank segment carries identical text — a known failure of both engines.
 *   speech  anything else. NOT a quality claim; only "there were segments".
 */
export function describeWindowActivity(segmentCount: number, windowMs: number, texts: readonly string[]): WindowActivity {
  if (segmentCount <= 0) return "silent";
  const nonBlank = texts.map((t) => t.trim()).filter((t) => t.length > 0);
  if (nonBlank.length > 1 && new Set(nonBlank).size === 1) return "loop";
  if (segmentCount <= 3 && windowMs >= 10 * 60_000) return "thin";
  return "speech";
}

/**
 * PURE — the covering pieces needed for the FIRST `seconds` of the window, and the trim that
 * selects them. Used for the language probe, so a 30-second probe never downloads or joins the
 * whole fifteen minutes.
 */
export function probeSlice<C extends RangeChunk>(
  covering: readonly CoveringChunk<C>[],
  seconds: number,
): { pieces: CoveringChunk<C>[]; seconds: number } {
  const out: CoveringChunk<C>[] = [];
  let acc = 0;
  for (const c of covering) {
    if (acc >= seconds) break;
    const take = Math.min(c.duration_s, seconds - acc);
    out.push({ ...c, duration_s: take });
    acc += take;
  }
  return { pieces: out, seconds: Math.round(acc * 100) / 100 };
}

/**
 * PURE — Whisper's language id → the code Sarvam expects.
 *
 * Whisper answers ISO-639-1 ("en", "hi", "kn"); Sarvam wants a BCP-47 Indian locale ("en-IN",
 * "hi-IN"). An unknown code returns null, which means "do not force" rather than "force
 * something plausible": inventing a locale for a language Whisper is unsure about would
 * reintroduce exactly the wrong-language failure this probe exists to prevent.
 */
const SARVAM_LOCALES: Record<string, string> = {
  en: "en-IN", hi: "hi-IN", bn: "bn-IN", gu: "gu-IN", kn: "kn-IN", ml: "ml-IN",
  mr: "mr-IN", od: "od-IN", or: "od-IN", pa: "pa-IN", ta: "ta-IN", te: "te-IN",
};

export function sarvamLanguageCode(whisperLang: string | null | undefined): string | null {
  if (!whisperLang) return null;
  const l = whisperLang.toLowerCase().trim();
  if (!l || l === "auto" || l === "und" || l === "unknown") return null;
  if (SARVAM_LOCALES[l]) return SARVAM_LOCALES[l]!;
  if (isEnglishCode(l)) return "en-IN";
  return null;
}

/** The language bucket the routing matrix is keyed on. */
export function bucketFor(lang: string | null): "english" | "indic" {
  return isEnglishCode(lang) ? "english" : "indic";
}

// ---------------------------------------------------------------------------
// The drain
// ---------------------------------------------------------------------------

export type DrainStep =
  | "flag_off" | "not_found" | "wrong_state" | "no_room_day" | "no_chunks"
  | "too_long" | "join_failed" | "clip_missing" | "probe_failed"
  | "no_engine" | "engine_failed" | "attempts_exhausted" | "ok";

export type DrainOutcome = {
  window_id: string;
  ok: boolean;
  step: DrainStep;
  detail?: string;
  clip_r2_key?: string | null;
  probe_language?: string | null;
  probe_seconds?: number | null;
  language_sent?: string | null;
  full_language?: string | null;
  engine?: string | null;
  segment_count?: number;
  activity?: WindowActivity;
  turns_written?: number;
  turns_deleted?: number;
  /** K4b — WHY the cues did not land. `turns_written: 0` on its own is indistinguishable from a
   *  window that legitimately produced nothing, and the first live run of this drain wrote 506
   *  segments to nowhere while still reporting ok. These make that impossible to miss again. */
  turns_failed?: number;
  turns_failed_reason?: string;
  turn_write_error?: string;
  window_recorded?: boolean;
  run_id?: string | null;
  attempts?: number;
  sarvam_ms?: number | null;
  audio_seconds?: number | null;
};

type WindowRow = {
  id: string; session_id: string; room_day_id: string | null;
  start_ms: string | number; end_ms: string | number; source_mic: string;
  clip_r2_key: string | null; grid_aligned: boolean; state: string;
};

const runId = () => `tr_${Math.random().toString(36).slice(2, 12)}`;

/** Record a failure against the job row and park the window once attempts are exhausted. */
async function recordFailure(windowId: string, step: DrainStep, detail: string): Promise<number> {
  const rows = (await sql`
    UPDATE stt_subject_job
       SET attempts = attempts + 1,
           last_error = ${`${step}: ${detail}`.slice(0, 300)},
           state = CASE WHEN attempts + 1 >= ${DRAIN_MAX_ATTEMPTS} THEN 'failed' ELSE 'queued' END,
           finished_at = CASE WHEN attempts + 1 >= ${DRAIN_MAX_ATTEMPTS} THEN NOW() ELSE NULL END
     WHERE subject_type = 'bench_window' AND subject_id = ${windowId} AND tier = 'asr'
     RETURNING attempts
  `) as Array<{ attempts: number }>;
  const attempts = rows[0]?.attempts ?? 0;
  if (attempts >= DRAIN_MAX_ATTEMPTS) {
    // C7 — parked. The reason lives on the job row; bench_window carries the state only, so
    // there is exactly one place a reason can be read from and it cannot disagree with itself.
    await sql`UPDATE bench_window SET state = 'failed' WHERE id = ${windowId} AND state = 'transcribing'`;
  } else {
    await sql`UPDATE bench_window SET state = 'closed' WHERE id = ${windowId} AND state = 'transcribing'`;
  }
  return attempts;
}

/**
 * Drain ONE window, end to end. Never throws — every failure is a named step, so a caller can
 * report what happened rather than a stack trace.
 */
export async function drainRoomWindow(windowId: string, origin: string): Promise<DrainOutcome> {
  const out: DrainOutcome = { window_id: windowId, ok: false, step: "not_found" };
  try {
    const wr = (await sql`
      SELECT w.id, w.session_id, w.room_day_id, w.start_ms, w.end_ms, w.source_mic,
             w.clip_r2_key, w.grid_aligned, w.state, s.room_id
        FROM bench_window w JOIN bench_session s ON s.id = w.session_id
       WHERE w.id = ${windowId} LIMIT 1
    `) as Array<WindowRow & { room_id: string }>;
    const w = wr[0];
    if (!w) return out;

    // HAZARD call site 2 of 3 — see lib/stt/room-drain-flag.ts. Checked on entry so the runner
    // is safe to call directly and cannot be reached with the flag off by a future caller.
    if (!isRoomDrainEnabled(w.room_id)) return { ...out, step: "flag_off" };

    if (w.state !== "closed" && w.state !== "transcribing") {
      return { ...out, step: "wrong_state", detail: w.state };
    }
    if (!w.grid_aligned) return { ...out, step: "wrong_state", detail: "not_grid_aligned" };

    const startMs = Number(w.start_ms);
    const endMs = Number(w.end_ms);
    const source = w.source_mic === "backup" ? "backup" : "primary";

    // A3 — turns are cues, and a cue needs a room_day. A window whose day was never created
    // cannot be written; that is reported, not invented. This build does not create room_days.
    if (!w.room_day_id) return { ...out, step: "no_room_day" };

    const tooLong = refuseIfTooLong(startMs, endMs);
    if (tooLong) return { ...out, step: "too_long", detail: `${tooLong.requested_minutes}m` };
    if (!joinServiceConfigured()) return { ...out, step: "join_failed", detail: "join_service_not_configured" };

    // Claim it. Guarded so two drains cannot both take the same window.
    const claimed = (await sql`
      UPDATE bench_window SET state = 'transcribing'
       WHERE id = ${windowId} AND state IN ('closed', 'transcribing') RETURNING id
    `) as Array<{ id: string }>;
    if (claimed.length === 0) return { ...out, step: "wrong_state", detail: "claim_lost" };
    await sql`
      UPDATE stt_subject_job SET state = 'running', started_at = NOW()
       WHERE subject_type = 'bench_window' AND subject_id = ${windowId} AND tier = 'asr'
    `;

    const chunks = (await sql`
      SELECT idx, source, r2_key, content_type, started_at, ended_at, upload_state
        FROM bench_chunk WHERE session_id = ${w.session_id} ORDER BY source, idx
    `) as RangeChunk[];
    const res = resolveRange(chunks, startMs, endMs, source);
    if (res.kind === "none") {
      const attempts = await recordFailure(windowId, "no_chunks", "no covering chunks");
      return { ...out, step: "no_chunks", attempts };
    }
    const covering = res.kind === "single" ? [res.covering] : res.covering;
    const audioSeconds = Math.round(covering.reduce((a, c) => a + c.duration_s, 0) * 100) / 100;

    // --- C2. JOIN -------------------------------------------------------------------------
    const join = await callJoinService(buildJoinRequest(w.session_id, covering, startMs, endMs, source));
    if (!join.ok) {
      const attempts = await recordFailure(windowId, "join_failed", `${join.error}${join.hop ? ` @${join.hop}` : ""}`);
      return { ...out, step: "join_failed", detail: join.error, attempts };
    }
    await sql`UPDATE bench_window SET clip_r2_key = ${join.key} WHERE id = ${windowId}`;
    out.clip_r2_key = join.key;

    // --- C3. LANGUAGE PROBE ---------------------------------------------------------------
    // The first PROBE_SECONDS of the window, joined on their own so the probe never downloads
    // fifteen minutes to read one language code.
    const slice = probeSlice(covering, PROBE_SECONDS);
    const probeReq = buildJoinRequest(w.session_id, slice.pieces, startMs, startMs + Math.round(slice.seconds * 1000), source);
    probeReq.out_key = clipKey(w.session_id, startMs, startMs + Math.round(slice.seconds * 1000), source).replace(/\.webm$/, `-probe${PROBE_SECONDS}.webm`);
    const probeJoin = await callJoinService(probeReq);
    let probeLanguage: string | null = null;
    if (probeJoin.ok) {
      const pb = await getObjectBytes(probeJoin.key);
      if (pb) {
        const pw = await transcribeWithWhisper(Buffer.from(pb), "audio/webm", { timeoutMs: 90_000 });
        if (pw.ok) probeLanguage = pw.language ?? null;
      }
    }
    out.probe_language = probeLanguage;
    out.probe_seconds = slice.seconds;

    // --- Whisper on the FULL window: segments, timing, and a second language opinion --------
    const bytes = await getObjectBytes(join.key);
    if (!bytes) {
      const attempts = await recordFailure(windowId, "clip_missing", join.key);
      return { ...out, step: "clip_missing", attempts };
    }
    const full = await transcribeWithWhisper(Buffer.from(bytes), "audio/webm", {
      timeoutMs: 180_000,
      // Force the probe's answer here too, so the segmentation pass cannot drift to a third
      // language and produce turns in a script neither the probe nor Sarvam agreed on.
      ...(probeLanguage ? { language: probeLanguage } : {}),
    });
    if (!full.ok) {
      const attempts = await recordFailure(windowId, "probe_failed", full.error ?? "whisper_failed");
      return { ...out, step: "probe_failed", detail: full.error, attempts };
    }
    out.full_language = full.language ?? null;

    // --- C4. TRANSCRIBE, with the language FORCED ------------------------------------------
    const decided = probeLanguage ?? full.language ?? null;
    const engineId = await resolveRouting(DRAIN_STAGE, bucketFor(decided));
    const adapter = engineId ? adapterFor(engineId) : null;
    if (!engineId || !adapter) {
      const attempts = await recordFailure(windowId, "no_engine", `stage=room bucket=${bucketFor(decided)}`);
      return { ...out, step: "no_engine", attempts };
    }
    const languageSent = sarvamLanguageCode(decided);
    out.language_sent = languageSent;
    const asr = await adapter.transcribe(Buffer.from(bytes), {
      contentType: "audio/webm",
      longForm: true,
      mode: "transcribe",
      ...(languageSent ? { language: languageSent } : {}),
    });
    out.sarvam_ms = asr.latencyMs;
    out.audio_seconds = audioSeconds;

    // C5 — THE ENGINE ID IS READ FROM THE ADAPTER THAT WAS CALLED. `adapter.key` is the object
    // whose transcribe() just ran; nothing here re-derives it from a string the caller supplied.
    const engineKey = adapter.key;
    out.engine = engineKey;

    if (asr.error) {
      const attempts = await recordFailure(windowId, "engine_failed", asr.error);
      return { ...out, step: "engine_failed", detail: asr.error, attempts };
    }

    // --- C5. STORE --------------------------------------------------------------------------
    const segments = full.segments ?? [];
    const activity = describeWindowActivity(segments.length, endMs - startMs, segments.map((s) => s.text));
    out.segment_count = segments.length;
    out.activity = activity;
    const id = runId();
    await sql`
      INSERT INTO transcription_run
        (id, encounter_id, subject_type, subject_id, engine, stt_engine_id, mode, tier,
         detected_language, transcript_original, transcript_english, latency_ms, cost_usd,
         error, metrics_json, created_at)
      VALUES
        (${id}, NULL, 'bench_window', ${windowId}, ${engineKey}, ${engineId}, 'batch', 'asr',
         ${asr.language ?? decided}, ${asr.original}, ${asr.english}, ${asr.latencyMs}, ${asr.costUsd},
         NULL, ${JSON.stringify({
           // C3 — the probe's language AND its length, on the run, so T4/T5 are answerable from
           // the row rather than from a log line.
           probe_language: probeLanguage,
           probe_seconds: slice.seconds,
           probe_engine: whisperAdapter.key,
           full_window_language: full.language ?? null,
           language_sent: languageSent,
           sarvam_language: asr.language ?? null,
           segment_count: segments.length,
           activity,
           audio_seconds: audioSeconds,
           clip_r2_key: join.key,
           window: { start_ms: startMs, end_ms: endMs, source_mic: source },
         })}::jsonb, NOW())
    `;
    out.run_id = id;

    // --- C6. TURNS --------------------------------------------------------------------------
    // Whisper's segments, so the engine on the cue is Whisper — derived from the adapter, never
    // typed. Window-as-unit replace: the whole window's turns go, then this run's turns land.
    const build = buildTurns({
      engine: whisperAdapter.key,
      sessionId: w.session_id,
      clipStartMs: startMs,
      windowStartMs: startMs,
      windowEndMs: endMs,
      segments,
      language: full.language ?? decided,
      sourceUsed: source,
    });
    const counts = await writeWindowCues(
      origin, w.room_id, w.room_day_id, w.session_id,
      { startMs, endMs }, build.turns,
      (complete, stoppedEarly) => buildWindowCue({
        engine: whisperAdapter.key,
        sessionId: w.session_id,
        windowStartMs: startMs,
        windowEndMs: endMs,
        complete,
        segmentCount: segments.length,
        language: full.language ?? decided,
        sourceUsed: source,
        stoppedEarly,
      }),
    );
    out.turns_written = counts.written;
    out.turns_deleted = counts.deleted;
    out.turns_failed = counts.failed;
    out.window_recorded = counts.window_recorded;
    if (counts.failed_reason) out.turns_failed_reason = counts.failed_reason;
    if (counts.turn_write_error) out.turn_write_error = counts.turn_write_error;

    // A window whose turns did not land is NOT transcribed. Saying otherwise would park a
    // silent hole in the day: the run exists, the clip exists, and the transcript is nowhere a
    // reader looks. Fall through to the failure path so the attempt is counted and retried.
    if (counts.written === 0 && build.turns.length > 0) {
      const attempts = await recordFailure(windowId, "engine_failed", `turns_not_written: ${counts.failed_reason ?? counts.turn_write_error ?? "unknown"}`);
      return { ...out, step: "engine_failed", detail: "turns_not_written", attempts };
    }

    // --- C7. STATE --------------------------------------------------------------------------
    await sql`UPDATE bench_window SET state = 'transcribed' WHERE id = ${windowId} AND state = 'transcribing'`;
    await sql`
      UPDATE stt_subject_job SET state = 'done', finished_at = NOW(), last_error = NULL
       WHERE subject_type = 'bench_window' AND subject_id = ${windowId} AND tier = 'asr'
    `;
    return { ...out, ok: true, step: "ok" };
  } catch (e) {
    const detail = String((e as Error)?.message ?? e).slice(0, 200);
    try {
      const attempts = await recordFailure(windowId, "engine_failed", detail);
      return { ...out, step: "engine_failed", detail, attempts };
    } catch {
      return { ...out, step: "engine_failed", detail };
    }
  }
}

/**
 * Drain queued room windows, oldest first. Manual only — nothing schedules this.
 *
 * The per-job flag check is HAZARD call site 3 of 3: one enabled room's queue must never carry a
 * disabled room's window through on the same pass, so the room is re-read per job rather than
 * once for the batch.
 */
export async function drainQueuedRoomWindows(origin: string, limit = 1): Promise<DrainOutcome[]> {
  const jobs = (await sql`
    SELECT j.subject_id, s.room_id
      FROM stt_subject_job j
      JOIN bench_window w ON w.id = j.subject_id
      JOIN bench_session s ON s.id = w.session_id
     WHERE j.subject_type = 'bench_window' AND j.tier = 'asr' AND j.state = 'queued'
       AND j.attempts < ${DRAIN_MAX_ATTEMPTS}
     ORDER BY j.queued_at ASC
     LIMIT ${Math.max(1, Math.min(50, limit))}
  `) as Array<{ subject_id: string; room_id: string }>;
  const out: DrainOutcome[] = [];
  for (const j of jobs) {
    if (!isRoomDrainEnabled(j.room_id)) {
      out.push({ window_id: j.subject_id, ok: false, step: "flag_off" });
      continue;
    }
    out.push(await drainRoomWindow(j.subject_id, origin));
  }
  return out;
}

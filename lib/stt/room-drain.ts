/**
 * lib/stt/room-drain.ts — the room tape reaches speech-to-text (K4b Part C).
 *
 * A closed bench_window becomes: one joined clip, one language probe, one paid transcription,
 * one transcription_run, and one window's worth of turn cues. Nothing here runs for a room
 * unless that room's Transcript switch is on (room.transcript_enabled).
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
import { isTranscriptEnabled } from "@/lib/room-switches";
import { enqueueSubject } from "@/lib/stt/fanout";
import { resolveRouting } from "./routing";
import { adapterFor } from "./registry";
import { whisperAdapter } from "./adapters/whisper";
import { isEnglishCode, whisperLanguageToIso } from "@/lib/language-route";
import { buildTurns, buildWindowCue, writeWindowCues } from "@/lib/mcp/tools/bench";

/**
 * PURE — did this window's turns actually land AS A SET?
 *
 * `written` IS NOT THE TEST, and getting that wrong is how the first live run of this drain
 * reported success while posting nothing. writeWindowCues has three outcomes:
 *
 *   whole batch OK      complete:true,  written = turns + marker
 *   turns REFUSED       complete:false, written = 1  ← the marker-only admission, and the trap:
 *                       written is NON-ZERO while every turn was rolled back
 *   nothing committed   complete:false, written = 0
 *
 * Only the first is a transcribed window. `complete` is the field that says so, and it is the
 * only field that distinguishes the middle case from success.
 */
export function cueWriteFailed(counts: { complete?: boolean }): boolean {
  return counts.complete !== true;
}

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
  ur: "ur-IN",
};

/**
 * The language decision for one window, as three outcomes rather than a nullable string.
 *
 *   { kind: "none" }      Whisper had no opinion. Do not force — the long-standing correct
 *                         behaviour, unchanged.
 *   { kind: "ok", code }  Force this locale on the paid engine.
 *   { kind: "unmapped" }  Whisper NAMED a language this system cannot carry. The drain must stop
 *                         and say so.
 *
 * WHY THIS IS A UNION AND NOT A NULLABLE STRING. `sarvamLanguageCode` returned null for both of
 * the first and third cases, and that single null is the entire defect (grounding §A6): a
 * confident "hindi" and an unsure shrug produced the same value, so the arbitrator built to stop
 * Sarvam picking its own language switched itself off, silently, for exactly the windows it was
 * built for. A type that cannot express the difference cannot be guarded, so the type changed.
 */
export type SarvamLanguageResolution =
  | { kind: "none" }
  | { kind: "ok"; code: string }
  | { kind: "unmapped"; answer: string };

/**
 * PURE — Whisper's language answer → the locale Sarvam is told, or a loud refusal.
 *
 * BLAST RADIUS, FLAGGED RATHER THAN DECIDED QUIETLY. The spec names "an unmapped NAME" as the
 * loud case. This treats any confident answer with no locale as unmapped — including a
 * two-letter ISO code outside SARVAM_LOCALES, e.g. a window whisper.cpp calls "fr". That is a
 * widening of the letter of the spec and it is deliberate, because the normative sentence is
 * "never silently pass the guard" and a French code disables the arbitrator in precisely the way
 * a French name would. It is called out in the build report for the orchestrator to confirm.
 */
export function resolveSarvamLanguage(whisperLang: string | null | undefined): SarvamLanguageResolution {
  const iso = whisperLanguageToIso(whisperLang);
  if (iso.kind === "unknown") return { kind: "none" };
  if (iso.kind === "unmapped") return { kind: "unmapped", answer: iso.answer };
  const locale = SARVAM_LOCALES[iso.code];
  if (locale) return { kind: "ok", code: locale };
  if (isEnglishCode(iso.code)) return { kind: "ok", code: "en-IN" };
  // A code with no locale is a language this system cannot serve. Loud, not null.
  return { kind: "unmapped", answer: iso.code };
}

/**
 * The pre-existing nullable accessor, kept so nothing that reads a locale has to learn a union.
 * It CANNOT distinguish unmapped from unknown — that is the whole point of the union above — so
 * the drain itself calls `resolveSarvamLanguage` and this remains for callers that only want the
 * locale when there is one.
 */
export function sarvamLanguageCode(whisperLang: string | null | undefined): string | null {
  const r = resolveSarvamLanguage(whisperLang);
  return r.kind === "ok" ? r.code : null;
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
  /**
   * Build 1 §C.3 — Whisper answered on NEITHER attempt. Distinct from `probe_failed`, which this
   * step replaces for the full-window call: the old name blamed the 30-second probe for a
   * failure of the fifteen-minute pass and made a dead transcriber unreadable from the operator
   * report. NO SILENT SKIP: the window parks with this name on it.
   */
  | "whisper_unavailable"
  /**
   * Build 1 §C.1 — whisper.cpp named a language with no Sarvam locale behind it. The drain
   * REFUSES rather than proceeding unforced, because proceeding unforced is exactly the silent
   * failure the language probe exists to prevent.
   */
  | "language_unmapped"
  | "no_engine" | "engine_failed" | "cues_refused" | "attempts_exhausted" | "ok";

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
  /**
   * Build 1 §C.2 — WHISPER'S OWN TIME ON THE ROOM PATH, at last. Whisper is called twice per
   * window and neither call left a latency figure anywhere in the database (grounding §A5), so
   * the drain's local-compute time has been unobservable while Whisper was simultaneously the
   * room path's hard single point of failure. Both calls are reported here and both are written
   * to metrics_json.
   */
  whisper_probe_ms?: number | null;
  whisper_full_ms?: number | null;
  /** 1 or 2 per call — a window that only transcribed on the retry is a healthy answer from an
   *  unhealthy link, and a latency trend that cannot see the retry reads a flapping tunnel as a
   *  fast server. */
  whisper_probe_attempts?: number | null;
  whisper_full_attempts?: number | null;
  audio_seconds?: number | null;
  /** §3.10 — EVERY RUN REPORTS WHAT IT COST, PER WINDOW. Characters out, seconds taken and the
   *  paid engine's own cost, so an operator who asked for a batch sees exactly what the batch did
   *  and what it spent. Null where the engine reported no cost (e.g. a local/free engine). */
  cost_usd?: number | null;
  transcript_chars?: number | null;
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
export async function drainRoomWindow(windowId: string, origin: string, opts: { force?: boolean } = {}): Promise<DrainOutcome> {
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

    // The switch, checked ON ENTRY so the runner is safe to call directly and cannot be reached
    // with Transcript off by a future caller. Read from the room row (lib/room-switches), not
    // from the environment: turning it off takes effect within ROOM_SWITCH_CACHE_MS and needs
    // no deploy. `step: "flag_off"` keeps its wire name — callers and tests read it.
    if (!(await isTranscriptEnabled(w.room_id))) return { ...out, step: "flag_off" };

    // `force` is how a window is RE-transcribed (T6). Without it a settled window is left
    // alone, so a queue pass can never redo work that is already done and already paid for.
    // With it, the window goes round again and the window-as-unit replace does the rest: the
    // previous run's turns are deleted before the new ones land, never merged with them.
    const drainable = opts.force
      ? ["closed", "transcribing", "transcribed", "failed"]
      : ["closed", "transcribing"];
    if (!drainable.includes(w.state)) {
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
       WHERE id = ${windowId} AND state = ANY(${drainable}::text[]) RETURNING id
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
    // §C.2 — the probe's own time, recorded whether it answered or not. A probe that FAILED is
    // still a Whisper call that took time on the Mini, and a latency series that silently drops
    // the failures is a series about the good days only.
    let whisperProbeMs: number | null = null;
    let whisperProbeAttempts: number | null = null;
    if (probeJoin.ok) {
      const pb = await getObjectBytes(probeJoin.key);
      if (pb) {
        const pw = await transcribeWithWhisper(Buffer.from(pb), "audio/webm", { timeoutMs: 90_000 });
        whisperProbeMs = pw.latency_ms;
        whisperProbeAttempts = pw.attempts ?? 1;
        // A FAILED PROBE IS STILL NOT AN ERROR (unchanged). probeLanguage stays null and the
        // drain proceeds unforced — that has always been the rule and this build does not
        // change it. What changes is only that the failure is now VISIBLE in the latency and
        // attempt figures instead of leaving no trace at all.
        if (pw.ok) probeLanguage = pw.language ?? null;
      }
    }
    out.probe_language = probeLanguage;
    out.probe_seconds = slice.seconds;
    out.whisper_probe_ms = whisperProbeMs;
    out.whisper_probe_attempts = whisperProbeAttempts;

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
    out.whisper_full_ms = full.latency_ms;
    out.whisper_full_attempts = full.attempts ?? 1;
    if (!full.ok) {
      // §C.3 — BOTH ATTEMPTS FAILED. The client has already retried once with backoff, so
      // reaching here means Whisper did not answer twice, two seconds apart. Named
      // `whisper_unavailable` rather than the inherited `probe_failed`: the probe is a different
      // call on a different clip that is allowed to fail harmlessly, and labelling a dead
      // transcriber with the harmless failure's name is how an outage reads as a quiet skip in
      // the operator report. The report already renders the step verbatim, so this name is the
      // visibility the spec asks for.
      const attempts = await recordFailure(windowId, "whisper_unavailable", full.error ?? "whisper_failed");
      return { ...out, step: "whisper_unavailable", detail: full.error, attempts };
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
    // §C.1 — THE GUARD THAT USED TO PASS SILENTLY. `decided` is whisper.cpp's answer, which is a
    // full language NAME. A name with no Sarvam locale behind it stops the window here instead
    // of proceeding with no language forced, which is the failure mode the probe exists to
    // prevent and which would have fired on the first Indic window ever drained.
    const resolution = resolveSarvamLanguage(decided);
    if (resolution.kind === "unmapped") {
      const attempts = await recordFailure(windowId, "language_unmapped", resolution.answer);
      return { ...out, step: "language_unmapped", detail: resolution.answer, attempts };
    }
    const languageSent = resolution.kind === "ok" ? resolution.code : null;
    out.language_sent = languageSent;
    const asr = await adapter.transcribe(Buffer.from(bytes), {
      contentType: "audio/webm",
      longForm: true,
      mode: "transcribe",
      ...(languageSent ? { language: languageSent } : {}),
    });
    out.sarvam_ms = asr.latencyMs;
    out.audio_seconds = audioSeconds;
    // §3.10 — the per-window cost report. Characters and cost come from what the engine actually
    // returned on THIS call, not from a re-read, so they cannot drift from the run just written.
    out.cost_usd = asr.costUsd ?? null;
    out.transcript_chars = typeof asr.original === "string" ? asr.original.length : null;

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
    // A re-transcription REPLACES the previous run for this subject, exactly as the turns are
    // replaced. Two runs for one window would make "the window's transcript" ambiguous, and the
    // STT lab groups on (subject_type, subject_id).
    await sql`DELETE FROM transcription_run WHERE subject_type = 'bench_window' AND subject_id = ${windowId}`;
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
           // §C.2 — WHISPER'S LATENCY, on the run, at last. Grounding §A5: metrics_json carried
           // probe_engine, probe_seconds and segment_count but no whisper_ms, so the room path's
           // local-compute time was unobservable from the database while Whisper was
           // simultaneously its hard single point of failure. Placed here rather than on a new
           // column because this blob is already the run's provenance record and a reader
           // holding the run has the numbers in the same fetch.
           whisper_probe_ms: whisperProbeMs,
           whisper_probe_attempts: whisperProbeAttempts,
           whisper_full_ms: full.latency_ms,
           whisper_full_attempts: full.attempts ?? 1,
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

    // A window whose turns did not land is NOT transcribed. Saying otherwise parks a silent
    // hole in the day: the run exists, the clip exists, and the transcript is nowhere a reader
    // looks. The engine is not at fault here and the step does not blame it — `cues_refused`
    // names what happened, and the reason carries the brain's own error (not_a_scratch_day,
    // brain_permission_denied, brain_timeout, …) rather than a generic failure.
    if (cueWriteFailed(counts)) {
      const why = counts.turn_write_error ?? counts.failed_reason ?? "unknown";
      const attempts = await recordFailure(windowId, "cues_refused", why);
      return { ...out, step: "cues_refused", detail: why, attempts };
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
/**
 * §3.10 (Build 3 §2.1) — RUN A ROOM'S WAITING AUDIO. The recovery control behind "run this room's
 * waiting audio".
 *
 * WHAT IT PROCESSES. Finished windows that have NO JOB AT ALL — the exact state Cardiology's
 * seventeen windows were in on 24 August, when the card said "17 waiting" and nothing had ever
 * been enqueued, so there was no queue for them to wait in and no control that would run them. A
 * closed, grid-aligned window with a room_day and no stt_subject_job row is one nobody has run;
 * this enqueues it and drains it. Oldest first.
 *
 * ONE OPERATOR ACTION, ONE BOUNDED BATCH. `limit` is small (the route caps it) so the whole batch
 * finishes inside one request and the operator sees what every window cost before deciding to run
 * more. NOTHING SCHEDULES THIS — every paid call in it was asked for by a person pressing a button.
 *
 * THE PER-JOB FLAG CHECK IS THE THIRD HAZARD CALL SITE. The room's Transcript switch is re-read on
 * entry to drainRoomWindow, so a switch flipped off mid-batch stops the rest of it.
 *
 * WHY closed-AND-no-job rather than the drain's own queued set: a window Build 2 already enqueued
 * has a job and rides drainQueuedRoomWindows; THIS is for the windows that fell through the crack
 * the whole build exists to close — finished audio nobody ever queued.
 */
export async function drainRoomWaitingWindows(roomId: string, origin: string, limit = 4): Promise<DrainOutcome[]> {
  const n = Math.max(1, Math.min(12, Math.trunc(limit) || 4));
  const rows = (await sql`
    SELECT w.id
      FROM bench_window w
      JOIN bench_session s ON s.id = w.session_id
     WHERE s.room_id = ${roomId}
       AND w.state = 'closed'
       AND w.grid_aligned = TRUE
       AND w.room_day_id IS NOT NULL
       AND NOT EXISTS (
             SELECT 1 FROM stt_subject_job j
              WHERE j.subject_type = 'bench_window' AND j.subject_id = w.id AND j.tier = 'asr'
           )
     ORDER BY w.start_ms ASC
     LIMIT ${n}
  `) as Array<{ id: string }>;
  const out: DrainOutcome[] = [];
  for (const r of rows) {
    // Re-read the switch per window (HAZARD 3). A window with the switch off is reported, not run.
    if (!(await isTranscriptEnabled(roomId))) {
      out.push({ window_id: r.id, ok: false, step: "flag_off" });
      continue;
    }
    // Enqueue first so drainRoomWindow has a job row to track, then drain. enqueueSubject is
    // idempotent (ON CONFLICT DO NOTHING), so a retry after a crash mid-batch never double-queues.
    await enqueueSubject("bench_window", r.id, "asr");
    out.push(await drainRoomWindow(r.id, origin));
  }
  return out;
}

/** §3.10 — how many finished windows are waiting to be run in this room (closed, grid-aligned,
 *  with a day, no job). Drives the control's count and its "each is a paid call" reminder. */
export async function countRoomWaitingWindows(roomId: string): Promise<number> {
  const rows = (await sql`
    SELECT COUNT(*)::int AS n
      FROM bench_window w
      JOIN bench_session s ON s.id = w.session_id
     WHERE s.room_id = ${roomId}
       AND w.state = 'closed'
       AND w.grid_aligned = TRUE
       AND w.room_day_id IS NOT NULL
       AND NOT EXISTS (
             SELECT 1 FROM stt_subject_job j
              WHERE j.subject_type = 'bench_window' AND j.subject_id = w.id AND j.tier = 'asr'
           )
  `) as Array<{ n: number }>;
  return Number(rows[0]?.n) || 0;
}

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
    if (!(await isTranscriptEnabled(j.room_id))) {
      out.push({ window_id: j.subject_id, ok: false, step: "flag_off" });
      continue;
    }
    out.push(await drainRoomWindow(j.subject_id, origin));
  }
  return out;
}

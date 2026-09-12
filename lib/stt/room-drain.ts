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
import {
  GEMINI_ADAPTER_KEY,
  GEMINI_PREFERRED_JOIN_FORMAT,
  GEMINI_PREFERRED_CONTENT_TYPE,
} from "./adapters/gemini";
import { isEnglishCode, whisperLanguageToIso } from "@/lib/language-route";
import { buildTurns, buildWindowCue, writeWindowCues } from "@/lib/mcp/tools/bench";
import { actorProblem, audioReceipt, providerEngineVersion, type RunActor } from "./receipt";
import { signGetUrl } from "@/lib/r2";
import { guardedTranscribe } from "./guarded-transcribe";
import { ROOM_WINDOW_KIND } from "@/lib/jobs/kinds/room-window-kind";
import { LEASE_MS } from "@/lib/jobs/types";
import type { McpScope } from "@/lib/mcp/auth";
import type { SttTranscribeResult } from "./types";
import { buildRouteMetrics } from "./route-run";
import { shouldShadow } from "./shadow";

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

/**
 * C1b fix-up 1 — how much of the window the CONTROL run covers. Two minutes, deliberately.
 *
 * The shadow exists to compare engines, not to produce a second production transcript of every
 * sampled window. Two minutes is long enough to hold several exchanges of a consultation — enough
 * to see whether an engine is mis-detecting the language or dropping code-mixed speech — and short
 * enough that the row is obviously a sample rather than a rival transcript.
 *
 * Every shadow row carries this value as `shadow_window_ms` alongside `shadow_bounded: true` and
 * `covers_full_window: false`, because a bounded row compared against a 900 s routed run as if
 * they were like for like would make the routed engine look seven times more productive on any
 * chars-per-audio-second measure. The tripwire divides by the SAMPLE's own audio_seconds.
 */
export const SHADOW_WINDOW_MS = 120_000;

/**
 * C1b fix-up 6 — PRE-FLIGHT SIZING FOR THE `segment` STEP.
 *
 * WHAT ACTUALLY BOUNDS THIS STEP, since the obvious answer is wrong: `MAX_STEP_MS` is NEVER
 * enforced on a running step — its only use is admission control in the runner (runner.ts:149), so
 * nothing kills `segment` at 200 s. The ceilings that are real are whisper's own `timeoutMs`
 * (180 s, and a timeout is deliberately not retried) and `LEASE_MS` (240 s), past which another
 * runner may re-claim the row and REDO the work. The write is safe — a stale owner writes nothing —
 * but the inference is paid for twice.
 *
 * So the budget below is LEASE_MS, not MAX_STEP_MS: overrunning the lease is the thing with a
 * consequence. The margin covers what happens around the inference — an R2 GET of the whole clip,
 * buildTurns, writeWindowCues (an HTTP call to our own origin) and one INSERT — none of which
 * whisper's own timeout covers.
 *
 * The factor is whisper's realtime ratio. 0.2 is the figure this codebase has been asserting in
 * comments without a measurement behind it, so it is an ENV VAR: when someone measures the Mini
 * properly, this moves without a deploy. At 0.2 the refusal bites above ~975 s of audio, which
 * admits the 900 s production window with about 15 s of headroom and refuses the longer,
 * non-standard windows that would otherwise fail as a lease-expiry mystery instead of a named
 * error at admission.
 */
export const SEGMENT_IO_MARGIN_MS = 45_000;
export const SEGMENT_REALTIME_FACTOR_ENV = "ETA_WHISPER_REALTIME_FACTOR";
export const DEFAULT_WHISPER_REALTIME_FACTOR = 0.2;

/** PURE. The factor, from the environment, clamped to something a typo cannot make absurd. */
export function whisperRealtimeFactor(raw: string | undefined = process.env[SEGMENT_REALTIME_FACTOR_ENV]): number {
  if (raw === undefined || raw.trim() === "") return DEFAULT_WHISPER_REALTIME_FACTOR;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_WHISPER_REALTIME_FACTOR;
  return Math.min(5, n);
}

/** PURE. What `segment` is projected to cost, and whether that fits before the lease expires. */
export function segmentFits(audioSeconds: number, factor: number = whisperRealtimeFactor()): { fits: boolean; projected_ms: number; budget_ms: number } {
  const projected_ms = Math.round(audioSeconds * factor * 1000) + SEGMENT_IO_MARGIN_MS;
  return { fits: projected_ms <= LEASE_MS, projected_ms, budget_ms: LEASE_MS };
}


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
  /**
   * Build 2 §B — the edge did not say who asked. Returned BEFORE the window is claimed and
   * before any paid call, so a broken caller costs nothing. Never a default: see receipt.ts.
   */
  | "no_actor"
  /**
   * Build 3.1 — the routed engine needs an ogg clip and the join service could not produce one
   * (service down, or a box still running the pre-3.1 image that ignores `format`). Loud and
   * named, BEFORE the paid call, exactly like the MIME refusal it replaces on this path.
   */
  | "ogg_join_unavailable"
  | "no_engine" | "engine_failed" | "cues_refused" | "attempts_exhausted" | "ok"
  /**
   * C1b - the drain accepted the window and handed it to a job. The work has NOT happened yet:
   * this is the DRAIN's success, not the window's. The window reaches "transcribed" only when the
   * job's last step runs, which is why the state transition moved there.
   */
  | "enqueued"
  /**
   * C1b fix-up 4 — the routed engine costs money and NOBODY NAMED IT. This path reaches its
   * engine from a routing row alone, over a 900 s window, which is exactly the unattended spend
   * PRD §1.6 forbids. A paid engine on this path is a configuration mistake, not a transient
   * fault, so it is named rather than folded into `engine_failed`.
   */
  | "paid_engine_refused"
  /**
   * C1b fix-up 6 — refused at admission because this window cannot finish inside the LEASE.
   * Named, because the alternative is a window that runs, overruns, gets re-claimed and re-run,
   * and shows up as nothing at all except a Mini that did the same work twice.
   */
  | "segment_would_exceed_budget";

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
  /** C1 step 5 — the control run's id when this window was sampled for a shadow, else absent. */
  shadow_run_id?: string | null;
  /** C1b - the scribe_job this window was handed to. */
  job_id?: string | null;
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
  /** Build 2 §B — the receipt as written, echoed so an operator sees it without a re-read. */
  initiated_by?: string | null;
  initiated_via?: string | null;
  audio_sha256?: string | null;
  engine_version_reported?: string | null;
  receipt_complete?: boolean;
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
export async function drainRoomWindow(
  windowId: string,
  origin: string,
  /**
   * Build 2 §B — `actor` and `via` are REQUIRED, and required is the point. `drainRoomWindow`
   * used to have no idea who asked (its signature was `(windowId, origin, opts)`), while both
   * HTTP edges had already resolved the admin id and thrown it away. Making these optional would
   * have threaded the plumbing without closing the gap: every caller that forgot would compile,
   * and the ledger would fill with runs nobody asked for.
   */
  opts: { force?: boolean } & RunActor,
): Promise<DrainOutcome> {
  const out: DrainOutcome = { window_id: windowId, ok: false, step: "not_found" };
  try {
    // THE FIRST THING, BEFORE ANYTHING COSTS ANYTHING. Not after the window is claimed and not
    // after the clip is joined: a caller that cannot say who it is must not be able to spend
    // money, and must not leave a window parked in 'transcribing' either.
    const problem = actorProblem(opts);
    if (problem) return { ...out, step: "no_actor", detail: problem };
    out.initiated_by = opts.actor;
    out.initiated_via = opts.via;
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

    // ── C1b. ENQUEUE, AND RETURN ─────────────────────────────────────────────────────────────
    // Everything expensive now belongs to a job: the join, whisper, the routed engine and the
    // run. This function's remaining cost is the guards and the claim above, so the 300 s ceiling
    // is unreachable from here by construction rather than by budgeting.
    // IMPORTED LAZILY, and it has to be. The kind registry imports the room_window kind, which
    // imports this file for its phases — a static import here would close that cycle and leave the
    // registry holding an undefined kind at module-load time. The dynamic import defers it to the
    // first enqueue, by which point every module is built.
    const { submitJob } = await import("@/lib/jobs/submit");
    const job = await submitJob({
      kind: ROOM_WINDOW_KIND,
      args: { window_id: windowId, origin, actor: opts.actor, via: opts.via },
      actor: opts.actor,
      origin,
      scopes: new Set<McpScope>(["invoke"]),
    });
    out.job_id = job.id;
    return { ...out, ok: true, step: "enqueued", job_id: job.id };
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


// ═══════════════════════════════════════════════════════════════════════════════════════════════
// C1b — THE DRAIN ENQUEUES; THE JOB DOES THE WORK.
//
// WHY. A room window is 900 s of audio (WINDOW_MS). The drain ran inside one request under a 300 s
// ceiling, and the router is ~1.3x realtime — so `route` could never have worked inline, and the
// whisper pass alone (capped at 180 s) already put the old path within sight of the ceiling on a
// slow join. The fix is not a larger ceiling. It is that no single request does the work.
//
// ONE PATH FOR EVERY ENGINE. whisper and sarvam go through exactly the same steps as route. There
// is no inline-vs-async branch on engine identity, because two control flows selected by engine is
// the shape that produced the silent-window defect — the sync path handled a case the job path had
// dropped. What DOES differ is transport, and it is chosen by a declared CAPABILITY
// (`adapter.capabilities.async`), never by an engine name: an async adapter submits and polls, a
// synchronous one returns in its step. A new engine declares what it is and needs no edit here.
//
// EACH STEP IS BOUNDED AND RESUMABLE. The phases below re-derive their own context from the window
// row rather than trusting anything expensive to survive in `progress`, and NO TRANSCRIPT TEXT ever
// crosses a step boundary — which is why whisper's segments and the turns they become are produced
// and consumed inside one step.
// ═══════════════════════════════════════════════════════════════════════════════════════════════

/** A phase returns a DrainOutcome; on success it also says what the next step must be handed. */
export type PhaseOutcome = DrainOutcome & { next_progress?: Record<string, unknown> };

/** Everything every phase re-derives for itself, so a step is resumable from the window id alone. */
type WindowContext = {
  // room_day_id is NON-NULL here: the loader refuses a window without one, exactly as the drain
  // did, so every phase downstream can write cues without re-proving it.
  w: WindowRow & { room_id: string; room_day_id: string };
  startMs: number;
  endMs: number;
  source: "primary" | "backup";
  covering: CoveringChunk<RangeChunk>[];
  audioSeconds: number;
};

/**
 * Re-read the window and re-resolve its covering chunks. Three cheap reads, paid once per step,
 * and the price of steps that do not depend on a process that may no longer exist.
 */
async function loadWindowContext(windowId: string): Promise<WindowContext | { error: DrainStep; detail?: string }> {
  const wr = (await sql`
    SELECT w.id, w.session_id, w.room_day_id, w.start_ms, w.end_ms, w.source_mic,
           w.clip_r2_key, w.grid_aligned, w.state, s.room_id
      FROM bench_window w JOIN bench_session s ON s.id = w.session_id
     WHERE w.id = ${windowId} LIMIT 1
  `) as Array<WindowRow & { room_id: string }>;
  const w = wr[0];
  if (!w) return { error: "not_found" };
  if (!w.room_day_id) return { error: "no_room_day" };
  const wd = w as WindowRow & { room_id: string; room_day_id: string };
  const startMs = Number(w.start_ms);
  const endMs = Number(w.end_ms);
  const source = w.source_mic === "backup" ? "backup" : "primary";
  const chunks = (await sql`
    SELECT idx, source, r2_key, content_type, started_at, ended_at, upload_state
      FROM bench_chunk WHERE session_id = ${w.session_id} ORDER BY source, idx
  `) as RangeChunk[];
  const res = resolveRange(chunks, startMs, endMs, source);
  if (res.kind === "none") return { error: "no_chunks", detail: "no covering chunks" };
  const covering = res.kind === "single" ? [res.covering] : res.covering;
  return { w: wd, startMs, endMs, source, covering, audioSeconds: Math.round(covering.reduce((a, c) => a + c.duration_s, 0) * 100) / 100 };
}

/** What every phase after `prepare` reads off the job row. Counts, ids and labels only. */
export type WindowProgress = {
  clip_r2_key: string;
  audio_seconds: number;
  probe_language: string | null;
  probe_seconds: number | null;
  whisper_probe_ms: number | null;
  whisper_probe_attempts: number | null;
  full_language: string | null;
  whisper_full_ms: number | null;
  whisper_full_attempts: number | null;
  whisper_model_reported: string | null;
  segment_count: number;
  activity: WindowActivity | null;
  decided_language: string | null;
  router_job_id: string | null;
};

export function readWindowProgress(raw: Record<string, unknown>): WindowProgress {
  const n = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
  const s = (v: unknown): string | null => (typeof v === "string" && v ? v : null);
  return {
    clip_r2_key: String(raw.clip_r2_key ?? ""),
    audio_seconds: n(raw.audio_seconds) ?? 0,
    probe_language: s(raw.probe_language),
    probe_seconds: n(raw.probe_seconds),
    whisper_probe_ms: n(raw.whisper_probe_ms),
    whisper_probe_attempts: n(raw.whisper_probe_attempts),
    full_language: s(raw.full_language),
    whisper_full_ms: n(raw.whisper_full_ms),
    whisper_full_attempts: n(raw.whisper_full_attempts),
    whisper_model_reported: s(raw.whisper_model_reported),
    segment_count: n(raw.segment_count) ?? 0,
    activity: (s(raw.activity) as WindowActivity | null),
    decided_language: s(raw.decided_language),
    router_job_id: s(raw.router_job_id),
  };
}

/** PHASE 1 — join the clip and read one language off its first seconds. No engine work. */
export async function roomWindowPrepare(windowId: string, opts: RunActor): Promise<PhaseOutcome> {
  const out: DrainOutcome = { window_id: windowId, ok: false, step: "not_found", initiated_by: opts.actor, initiated_via: opts.via };
  const ctx = await loadWindowContext(windowId);
  if ("error" in ctx) {
    if (ctx.error === "no_chunks") { const attempts = await recordFailure(windowId, "no_chunks", ctx.detail ?? ""); return { ...out, step: "no_chunks", attempts }; }
    return { ...out, step: ctx.error, ...(ctx.detail ? { detail: ctx.detail } : {}) };
  }
  const { w, startMs, endMs, source, covering, audioSeconds } = ctx;

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

  return {
    ...out, ok: true, step: "ok",
    next_progress: {
      clip_r2_key: join.key,
      audio_seconds: audioSeconds,
      probe_language: probeLanguage,
      probe_seconds: slice.seconds,
      whisper_probe_ms: whisperProbeMs,
      whisper_probe_attempts: whisperProbeAttempts,
    },
  };
}

/**
 * PHASE 2 — whisper on the full window, and the turns it becomes.
 *
 * THESE TWO BELONG TOGETHER AND CANNOT BE SPLIT. Whisper's segments carry TEXT, and a job's
 * progress may never carry text, so the segments are produced and consumed in one step. Everything
 * that leaves here is a count, a label or a language code.
 *
 * The turns now land BEFORE the routed engine runs, where they used to land after it. That is a
 * deliberate consequence and an improvement: the turns are whisper's product, so a paid engine
 * failing no longer erases the transcript from the day view. `cues_refused` still stops the window.
 */
export async function roomWindowSegment(windowId: string, origin: string, opts: RunActor, progress: Record<string, unknown>): Promise<PhaseOutcome> {
  const out: DrainOutcome = { window_id: windowId, ok: false, step: "not_found", initiated_by: opts.actor, initiated_via: opts.via };
  const p = readWindowProgress(progress);
  const ctx = await loadWindowContext(windowId);
  if ("error" in ctx) return { ...out, step: ctx.error, ...(ctx.detail ? { detail: ctx.detail } : {}) };
  const { w, startMs, endMs, source, audioSeconds } = ctx;
  const join = { key: p.clip_r2_key };
  const probeLanguage = p.probe_language;
  if (!join.key) return { ...out, step: "clip_missing", detail: "no clip key on the job row" };

  // PRE-FLIGHT. `audio_seconds` is already on the row from `prepare`, so this costs one comparison
  // and happens before the clip is downloaded or whisper is touched. A window too long to finish
  // inside the lease is refused HERE, with a name, instead of being discovered as a silent re-run
  // when a second runner reclaims the row.
  const fit = segmentFits(p.audio_seconds);
  if (!fit.fits) {
    const detail = `projected ${Math.round(fit.projected_ms / 1000)}s > ${Math.round(fit.budget_ms / 1000)}s for ${p.audio_seconds}s of audio`;
    const attempts = await recordFailure(windowId, "segment_would_exceed_budget", detail);
    return { ...out, step: "segment_would_exceed_budget", detail, attempts };
  }
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


  const decided = probeLanguage ?? full.language ?? null;
  const segments = full.segments ?? [];
  const activity = describeWindowActivity(segments.length, endMs - startMs, segments.map((s) => s.text));
  const segmentCount = segments.length;
  out.segment_count = segmentCount;
  out.activity = activity;

  // The routing answer is read here ONLY to label the control run and to apply the
  // cannot-be-its-own-control rule. The engine step resolves it again, authoritatively.
  // C1b fix-up 2 — RESOLVED ONCE, HERE, AND PERSISTED. This is the earliest step that can resolve
  // it: the bucket comes from `decided`, which needs whisper's answer. The engine step used to
  // resolve it a second time, authoritatively, which meant a routing row edited mid-job produced a
  // shadow labelled with one engine and a run written by another. It now reads what this step
  // wrote, so a job has one routing truth for its whole life.
  const routed = await resolveRouting(DRAIN_STAGE, bucketFor(decided));
  // ── AMENDMENT A: A NULL ROUTE IS A LOUD FAILURE, NOT A SILENT SUBSTITUTION ───────────────────
  // Migration 0083 would have added a (room,'default') row to "catch" this. That was the wrong
  // instinct and it is deleted: room resolves to sarvam, so the catch-all would have been a PAID
  // engine quietly absorbing a misconfiguration — exactly the unattended spend the guard exists to
  // stop, dressed as resilience. No stage has a default row in live data, and that is correct.
  //
  // So the refusal happens HERE, before the shadow row and before the turns, which is where the
  // pre-C1b inline drain raised it too. Nothing downstream gets to treat a null route as "skip
  // this window": the job fails, named, with the bucket that found nothing.
  if (!routed) {
    const bucket = bucketFor(decided);
    const attempts = await recordFailure(windowId, "no_engine", `stage=${DRAIN_STAGE} bucket=${bucket}`);
    return { ...out, step: "no_engine", detail: `stage=${DRAIN_STAGE} bucket=${bucket}`, attempts };
  }
  const engineKey = routed;
    // --- C1 step 5. THE SHADOW RUN --------------------------------------------------------------
    //
    // A SECOND transcription_run over the SAME audio, by the engine the room used before, on a
    // sampled minority of windows — so the switch can be refuted against a side-by-side instead of
    // against nothing.
    //
    // IT COSTS NO EXTRA ENGINE PASS HERE, and that is worth stating because the spec budgeted for
    // one. Whisper has ALREADY transcribed this whole window a few lines above: the drain needs its
    // segments for the turns and its language as a second opinion, whatever engine is routed. So
    // `full` is in hand and the shadow is one INSERT, not one inference. The sampling rate is kept
    // anyway: the rows are not free, and a rate is the dial that exists when they stop being cheap.
    //
    // ONE RUN PER (WINDOW x ENGINE) — the leaderboard groups by tr.engine, so two rows with two
    // different engine values aggregate correctly and the existing query needs no change. Skipped
    // when the routed engine IS whisper, because a window cannot be its own control.
    if (full.ok && engineKey !== whisperAdapter.key && shouldShadow(windowId)) {
      const shadowId = runId();
      const shadowReceipt = audioReceipt(join.key, bytes);
      // C1b fix-up 1 — THE CONTROL IS A BOUNDED SAMPLE, NOT A SECOND PRODUCTION TRANSCRIPT.
      // It covers the first SHADOW_WINDOW_MS of the window and no more. The shadow exists to
      // compare engines; a full second transcript of every sampled window is a cost with no extra
      // comparison in it.
      //
      // TAKEN BY TRUNCATION, not by a second inference, and that is strictly cheaper than it
      // sounds: whisper has already read the whole window for the turns, so selecting the
      // segments inside the bound costs nothing and puts NO additional load on a Mini that is
      // concurrently recording — which was the ruling's own reason. A fresh 120 s whisper call
      // would have added load to remove some.
      // WhisperSegment times are SECONDS and are relative to the clip, which starts at the
      // window's own start — so this is literally "the segments inside the first two minutes".
      const shadowSegments = segments.filter((sg) => sg.end_s <= SHADOW_WINDOW_MS / 1000);
      const shadowText = shadowSegments.map((sg) => sg.text).join(" ").trim();
      const shadowEndMs = Math.min(endMs, startMs + SHADOW_WINDOW_MS);
      const shadowSeconds = Math.round(((shadowEndMs - startMs) / 1000) * 100) / 100;
      await sql`
        INSERT INTO transcription_run
          (id, encounter_id, subject_type, subject_id, engine, stt_engine_id, mode, tier,
           detected_language, transcript_original, transcript_english, latency_ms, cost_usd,
           error, metrics_json, created_at,
           initiated_by, initiated_via, engine_version_reported,
           audio_r2_key, audio_byte_start, audio_byte_end, audio_sha256)
        VALUES
          (${shadowId}, NULL, 'bench_window', ${windowId}, ${whisperAdapter.key}, ${whisperAdapter.key}, 'batch', 'asr',
           ${full.language ?? null}, ${shadowText || null}, NULL, ${full.latency_ms}, 0,
           NULL, ${JSON.stringify({
             shadow_of_engine: engineKey,
             shadow_sampled: true,
             // ── THIS ROW IS NOT A FULL-WINDOW RUN. Three keys say so, because one that a reader
             // has to notice is one a reader will miss, and comparing this to a 900 s routed run
             // as if they were like for like would make the routed engine look 7x more productive
             // on every chars-per-second chart.
             shadow_bounded: true,
             shadow_window_ms: SHADOW_WINDOW_MS,
             covers_full_window: false,
             // audio_seconds is what the yield tripwire divides by, so it MUST be the sample's
             // own duration, not the window's. This is the single number that makes the bounded
             // row comparable at all.
             audio_seconds: shadowSeconds,
             full_window_audio_seconds: audioSeconds,
             segment_count: shadowSegments.length,
             full_window_segment_count: segmentCount,
             clip_r2_key: join.key,
             whisper_model_reported: full.engineVersion ?? null,
             window: { start_ms: startMs, end_ms: shadowEndMs, source_mic: source },
           })}::jsonb, NOW(),
           ${opts.actor}, ${opts.via}, ${full.engineVersion ?? null},
           ${shadowReceipt.audio_r2_key}, ${shadowReceipt.audio_byte_start}, ${shadowReceipt.audio_byte_end},
           ${shadowReceipt.audio_sha256})
      `;
      out.shadow_run_id = shadowId;
    }

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


  return {
    ...out, ok: true, step: "ok",
    next_progress: {
      ...progress,
      full_language: full.language ?? null,
      whisper_full_ms: full.latency_ms,
      whisper_full_attempts: full.attempts ?? 1,
      whisper_model_reported: full.engineVersion ?? null,
      segment_count: segmentCount,
      activity,
      decided_language: decided,
      // fix-up 2 — the one routing truth, read by every later step.
      engine_id: engineKey || null,
      ...(out.shadow_run_id ? { shadow_run_id: out.shadow_run_id } : {}),
    },
  };
}

/**
 * The routed engine's run. ONE WRITER, reached by both transports — the synchronous adapter path
 * and the router's poll path — so the two cannot drift into writing different rows for the same
 * window. That drift is exactly what produced the silent-window defect one slice ago.
 */
async function writeRoutedRun(
  windowId: string, ctx: WindowContext, p: WindowProgress, opts: RunActor,
  asr: SttTranscribeResult, receipt: { audio_r2_key: string | null; audio_byte_start: number | null; audio_byte_end: number | null; audio_sha256: string | null },
  engineId: string, engineKey: string, engineVersion: string | null,
  /** What the engine was actually told to expect. Belongs to the caller that resolved it. */
  languageSent: string | null,
): Promise<string> {
  const { startMs, endMs, source, audioSeconds } = ctx;
  const join = { key: p.clip_r2_key };
  const decided = p.decided_language;
  const out: DrainOutcome = { window_id: windowId, ok: false, step: "not_found" };
  void out;
    // --- C5. STORE --------------------------------------------------------------------------
    // C1b — whisper's segments never leave the step that produced them (no text in progress),
    // so the two facts this row needs from them, the COUNT and the activity label, are carried.
    const activity = p.activity;
    // A re-transcription REPLACES the previous run for this subject, exactly as the turns are
    // replaced. Two runs for one window would make "the window's transcript" ambiguous, and the
    // STT lab groups on (subject_type, subject_id).
    await sql`DELETE FROM transcription_run WHERE subject_type = 'bench_window' AND subject_id = ${windowId}`;
    const id = runId();
    await sql`
      INSERT INTO transcription_run
        (id, encounter_id, subject_type, subject_id, engine, stt_engine_id, mode, tier,
         detected_language, transcript_original, transcript_english, latency_ms, cost_usd,
         error, metrics_json, created_at,
         initiated_by, initiated_via, engine_version_reported,
         audio_r2_key, audio_byte_start, audio_byte_end, audio_sha256)
      VALUES
        (${id}, NULL, 'bench_window', ${windowId}, ${engineKey}, ${engineId}, 'batch', 'asr',
         ${asr.language ?? decided}, ${asr.original}, ${asr.english}, ${asr.latencyMs}, ${asr.costUsd},
         NULL, ${JSON.stringify({
           // C3 — the probe's language AND its length, on the run, so T4/T5 are answerable from
           // the row rather than from a log line.
           probe_language: p.probe_language,
           probe_seconds: p.probe_seconds,
           probe_engine: whisperAdapter.key,
           full_window_language: p.full_language,
           language_sent: languageSent,
           sarvam_language: asr.language ?? null,
           segment_count: p.segment_count,
           activity,
           // §C.2 — WHISPER'S LATENCY, on the run, at last. Grounding §A5: metrics_json carried
           // probe_engine, probe_seconds and segment_count but no whisper_ms, so the room path's
           // local-compute time was unobservable from the database while Whisper was
           // simultaneously its hard single point of failure. Placed here rather than on a new
           // column because this blob is already the run's provenance record and a reader
           // holding the run has the numbers in the same fetch.
           whisper_probe_ms: p.whisper_probe_ms,
           whisper_probe_attempts: p.whisper_probe_attempts,
           whisper_full_ms: p.whisper_full_ms,
           whisper_full_attempts: p.whisper_full_attempts,
           // Build 3 (PRD §5 amendment) — the model whisper.cpp reported, when it reports one.
           //
           // WHY HERE AND NOT IN engine_version_reported. That column belongs to the engine the
           // ROW NAMES, which on this path is the paid engine (Sarvam today, Gemini when routed).
           // Whisper is the segmenter and the language arbitrator on the same window, not the
           // run's engine, so its version rides in metrics_json beside its latency — exactly
           // where Build 1 put `whisper_probe_ms`. Writing it into engine_version_reported would
           // caption a Sarvam run with Whisper's version, which is the typed-provider-label
           // failure wearing a new hat.
           whisper_model_reported: p.whisper_model_reported,
           audio_seconds: audioSeconds,
           clip_r2_key: join.key,
           window: { start_ms: startMs, end_ms: endMs, source_mic: source },
           // Slice C1 step 3 — the router's per-span timeline, VERBATIM, under one key. Spread
           // conditionally so a run by any other engine is byte-identical to what it wrote before:
           // nine adapters return no timeline and must not acquire an empty one.
           ...(asr.languageTimeline ? buildRouteMetrics(asr.languageTimeline) : {}),
         })}::jsonb, NOW(),
         ${opts.actor}, ${opts.via}, ${engineVersion},
         ${receipt.audio_r2_key}, ${receipt.audio_byte_start}, ${receipt.audio_byte_end},
         ${receipt.audio_sha256})
    `;


  return id;
}

/**
 * PHASE 3 — resolve the engine and start it.
 *
 * THE ONLY BRANCH IS ON A DECLARED CAPABILITY, never on an engine name. An adapter that says
 * `capabilities.async` is handed the router's submit/poll protocol; one that does not is called
 * and answers inside this step. Adding an engine means declaring what it is, not editing this.
 */
export async function roomWindowEngine(windowId: string, opts: RunActor, progress: Record<string, unknown>): Promise<PhaseOutcome> {
  const out: DrainOutcome = { window_id: windowId, ok: false, step: "not_found", initiated_by: opts.actor, initiated_via: opts.via };
  const p = readWindowProgress(progress);
  const ctxOrErr = await loadWindowContext(windowId);
  if ("error" in ctxOrErr) return { ...out, step: ctxOrErr.error, ...(ctxOrErr.detail ? { detail: ctxOrErr.detail } : {}) };
  const ctx = ctxOrErr;
  const { w, startMs, endMs, source, covering, audioSeconds } = ctx;
  const join = { key: p.clip_r2_key };
  const probeLanguage = p.probe_language;
  // C1b fix-up 3, ACCEPTED AND DELIBERATE: this is the SECOND download of this clip — the segment
  // step downloaded it too. It is inherent to steps that cannot pass bytes. A job's progress is a
  // database column read by operators and may carry no audio and no transcript, and the process
  // that ran the previous step may no longer exist, so the only alternatives are smuggling bytes
  // through state or keeping one giant step that reintroduces the ceiling this slice removed.
  // DO NOT "fix" this by caching the buffer somewhere global: an R2 GET is cheap and a step that
  // depends on another step's memory is a step that breaks the first time a runner is recycled.
  const bytes = await getObjectBytes(join.key);
  if (!bytes) { const attempts = await recordFailure(windowId, "clip_missing", join.key); return { ...out, step: "clip_missing", attempts }; }
    // --- C4. TRANSCRIBE, with the language FORCED ------------------------------------------
    // C1b — decided ONCE, in the segment step, and carried on the row. Re-deriving it here
    // would need whisper's answer, which this step no longer holds.
    const decided = p.decided_language;
    // fix-up 2 — READ, NOT RESOLVED. The segment step resolved this and wrote it on the job; a
    // second resolution here could disagree with the one the shadow row was labelled from if an
    // operator edited stt_routing while the job was in flight. One resolution, one truth.
    const engineId = typeof progress.engine_id === "string" && progress.engine_id ? progress.engine_id : null;
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
    // C5's rule, unchanged: the engine id is READ FROM THE ADAPTER that will run, never re-derived
    // from a string the caller supplied.
    const engineKey = adapter.key;
    out.engine = engineKey;

    // --- Build 3.1. THE CONTAINER THE ROUTED ENGINE CAN ACTUALLY READ -----------------------
    //
    // Gemini accepts ogg and not webm; every other engine takes the webm clip that was already
    // joined, downloaded and handed to Whisper. So this is a SECOND join for one engine, not a
    // change to the clip everything else uses — the webm clip and its Whisper segments are
    // untouched, and a window routed to Sarvam does exactly what it did yesterday.
    //
    // WHY A SECOND JOIN RATHER THAN A CONVERSION. Vercel has no ffmpeg. The join service is the
    // only thing in this system that can mux audio, and it is already being asked for this
    // window's bytes — asking it once more with `format: "ogg"` costs one container call and
    // produces a clip with its own R2 key, so the two containers coexist rather than one
    // overwriting the other under a deterministic key.
    //
    // THE RECEIPT FOLLOWS THE BYTES. `audioBytes` and `audioKey` below are what the engine was
    // actually handed, so `audio_sha256` fingerprints the ogg for a Gemini run and the webm for
    // every other — never the clip we happened to download first.
    let audioBytes: Uint8Array = bytes;
    let audioKey: string = join.key;
    let audioContentType = "audio/webm";

    if (adapter.key === GEMINI_ADAPTER_KEY) {
      // `now` is positional and defaults, so it is passed explicitly to reach `format` — the
      // parameter order is left alone rather than reshuffled under the existing callers.
      const oggReq = buildJoinRequest(w.session_id, covering, startMs, endMs, source, new Date(), GEMINI_PREFERRED_JOIN_FORMAT);
      const oggJoin = await callJoinService(oggReq);
      if (!oggJoin.ok) {
        // No spend. A join service that is down, or a box still running the pre-3.1 image, must
        // not become a paid call against a container the engine will reject.
        const attempts = await recordFailure(windowId, "ogg_join_unavailable", oggJoin.error);
        return { ...out, step: "ogg_join_unavailable", detail: oggJoin.error, attempts };
      }
      const oggBytes = await getObjectBytes(oggJoin.key);
      if (!oggBytes) {
        const attempts = await recordFailure(windowId, "ogg_join_unavailable", `clip_missing:${oggJoin.key}`);
        return { ...out, step: "ogg_join_unavailable", detail: `clip_missing:${oggJoin.key}`, attempts };
      }
      audioBytes = oggBytes;
      audioKey = oggJoin.key;
      audioContentType = GEMINI_PREFERRED_CONTENT_TYPE;
    }

  // ── TRANSPORT, CHOSEN BY CAPABILITY ──────────────────────────────────────────────────────────
  if (adapter.capabilities.async) {
    // IDEMPOTENCE IS OURS, because the router has none. If this row already carries a router job
    // id, a previous attempt already submitted — poll that one. Resubmitting would mint a second
    // job over the same audio and do the whole thing twice.
    if (p.router_job_id) {
      return { ...out, ok: true, step: "ok", next_progress: { ...progress, engine_id: engineId, engine_key: engineKey, language_sent: languageSent } };
    }
    // C2 Part A — an adapter that DECLARES async must IMPLEMENT it. A missing submit/poll is a
    // registry bug, not a reason to quietly fall back to the synchronous path: the sync path on a
    // 900 s window is the timeout this whole seam exists to avoid.
    if (typeof adapter.submit !== "function" || typeof adapter.poll !== "function") {
      const attempts = await recordFailure(windowId, "engine_failed", "async_engine_missing_submit_poll");
      return { ...out, step: "engine_failed", detail: "async_engine_missing_submit_poll", attempts };
    }
    let audioUrl: string;
    try {
      audioUrl = await signGetUrl({ key: audioKey, expiresInSeconds: routerPresignTtlSeconds(audioSeconds) });
    } catch (e) {
      const attempts = await recordFailure(windowId, "engine_failed", `presign_failed: ${String(e).slice(0, 80)}`);
      return { ...out, step: "engine_failed", detail: "presign_failed", attempts };
    }
    const sub = await adapter.submit({ audioUrl, durationMs: Math.round(audioSeconds * 1000), translate: false, ...(languageSent ? { language: languageSent } : {}) });
    if (!sub.ok) {
      // The provider's message can quote a path or the audio; it goes to the log, not the row.
      console.error("[drain] async submit failed", JSON.stringify({ window: windowId, engine: engineId, err: String(sub.error).slice(0, 200) }));
      const attempts = await recordFailure(windowId, "engine_failed", "async_submit_failed");
      return { ...out, step: "engine_failed", detail: "async_submit_failed", attempts };
    }
    // Persisted BEFORE anything else can fail, so a retry finds it and polls instead of resubmitting.
    return {
      ...out, ok: true, step: "ok",
      next_progress: { ...progress, router_job_id: sub.jobRef, engine_id: engineId, engine_key: engineKey, language_sent: languageSent },
    };
  }

  // ── ITEM 4: ROUTING INHERITANCE MAY NOT REACH A PAID ENGINE ──────────────────────────────────
  // This path picks its engine purely from `stt_routing` — nobody named it in a request, and the
  // window is 900 s, well past the per-call cap. That is the textbook unattended spend: a config
  // row, times twelve windows a press, with no audit trail. `explicitlyNamed: false` is therefore
  // a LITERAL here, not a variable: there is no way for this call site to ever be a naming, and
  // writing it as a literal means no future edit can quietly make it one.
  const g = await guardedTranscribe({
    adapter, engineId, audio: Buffer.from(audioBytes),
    durationMs: Math.round(audioSeconds * 1000),
    explicitlyNamed: false,
    actor: opts.actor,
    subject: `bench_window:${windowId}`,
    transcribeOpts: {
      contentType: audioContentType, longForm: true, mode: "transcribe",
      durationMs: Math.round(audioSeconds * 1000),
      ...(languageSent ? { language: languageSent } : {}),
    },
  });
  if (!g.ok) {
    // Named, so an operator reading the window sees WHY it stopped rather than a generic failure.
    const attempts = await recordFailure(windowId, "paid_engine_refused", g.refusal.error);
    return { ...out, step: "paid_engine_refused", detail: g.refusal.error, attempts };
  }
  const asr = g.result;
  if (asr.error) { const attempts = await recordFailure(windowId, "engine_failed", asr.error); return { ...out, step: "engine_failed", detail: asr.error, attempts }; }
  const receipt = audioReceipt(audioKey, audioBytes);
  const engineVersion = providerEngineVersion(asr);
  const runIdWritten = await writeRoutedRun(windowId, ctx, p, opts, asr, receipt, engineId, engineKey, engineVersion, languageSent);
  out.run_id = runIdWritten;
  out.cost_usd = asr.costUsd ?? null;
  out.transcript_chars = typeof asr.original === "string" ? asr.original.length : null;
  return { ...out, ok: true, step: "ok", next_progress: { ...progress, engine_id: engineId, engine_key: engineKey, run_id: runIdWritten, done_engine: true } };
}

/**
 * PHASE 4 — poll the router job this window already owns.
 *
 * IT NEVER SUBMITS. The id was persisted by phase 3 and is the only thing this step acts on: a
 * retry, a crash, a re-claim after a lost lease all land here and poll the SAME job. The router
 * has no idempotency key and its job files expire after an hour, so if we resubmitted on retry we
 * would pay for the same 900 s twice and have two answers with no way to say which was used.
 */
export async function roomWindowPoll(windowId: string, opts: RunActor, progress: Record<string, unknown>): Promise<PhaseOutcome & { still_running?: boolean }> {
  const out: DrainOutcome = { window_id: windowId, ok: false, step: "not_found", initiated_by: opts.actor, initiated_via: opts.via };
  const p = readWindowProgress(progress);
  if (!p.router_job_id) return { ...out, step: "engine_failed", detail: "no router job id on the row" };
  const ctxOrErr = await loadWindowContext(windowId);
  if ("error" in ctxOrErr) return { ...out, step: ctxOrErr.error, ...(ctxOrErr.detail ? { detail: ctxOrErr.detail } : {}) };
  const ctx = ctxOrErr;

  const engineId = String(progress.engine_id ?? "");
  const engineKey = String(progress.engine_key ?? "");
  const adapter = engineId ? adapterFor(engineId) : null;
  if (!adapter || typeof adapter.poll !== "function") {
    const attempts = await recordFailure(windowId, "engine_failed", "async_engine_missing_submit_poll");
    return { ...out, step: "engine_failed", detail: "async_engine_missing_submit_poll", attempts };
  }

  const st = await adapter.poll(p.router_job_id);
  if (!st.ok) {
    console.error("[drain] async poll failed", JSON.stringify({ window: windowId, job: p.router_job_id, engine: engineId, err: String(st.error).slice(0, 200), terminal: st.terminal }));
    // A non-terminal failure is worth another claim: the ref is still good, the hop was not.
    if (!st.terminal) return { ...out, ok: true, step: "ok", still_running: true, next_progress: { ...progress, last_router_state: "poll_error" } };
    const attempts = await recordFailure(windowId, "engine_failed", "async_job_failed");
    return { ...out, step: "engine_failed", detail: "async_job_failed", attempts };
  }
  if (st.state !== "done") {
    // Still working. The row goes back to the queue; the next claim polls the same ref.
    return { ...out, ok: true, step: "ok", still_running: true, next_progress: { ...progress, last_router_state: st.state } };
  }

  const asr = st.result;
  if (asr.error) { const attempts = await recordFailure(windowId, "engine_failed", asr.error); return { ...out, step: "engine_failed", detail: asr.error, attempts }; }
  // The receipt describes the bytes the ROUTER was given — the same object the presigned URL named.
  const bytes = await getObjectBytes(p.clip_r2_key);
  if (!bytes) { const attempts = await recordFailure(windowId, "clip_missing", p.clip_r2_key); return { ...out, step: "clip_missing", attempts }; }
  const receipt = audioReceipt(p.clip_r2_key, bytes);
  const runIdWritten = await writeRoutedRun(windowId, ctx, p, opts, asr, receipt, engineId, engineKey, providerEngineVersion(asr), typeof progress.language_sent === "string" ? progress.language_sent : null);
  out.run_id = runIdWritten;
  out.transcript_chars = typeof asr.original === "string" ? asr.original.length : null;
  return { ...out, ok: true, step: "ok", next_progress: { ...progress, run_id: runIdWritten, done_engine: true } };
}

/** PHASE 5 — the window is transcribed. Only reached once a run exists. */
export async function roomWindowFinish(windowId: string, opts: RunActor, progress: Record<string, unknown>): Promise<PhaseOutcome> {
  const out: DrainOutcome = {
    window_id: windowId, ok: false, step: "not_found",
    initiated_by: opts.actor, initiated_via: opts.via,
    run_id: typeof progress.run_id === "string" ? progress.run_id : null,
  };
    // --- C7. STATE --------------------------------------------------------------------------
    await sql`UPDATE bench_window SET state = 'transcribed' WHERE id = ${windowId} AND state = 'transcribing'`;
    await sql`
      UPDATE stt_subject_job SET state = 'done', finished_at = NOW(), last_error = NULL
       WHERE subject_type = 'bench_window' AND subject_id = ${windowId} AND tier = 'asr'
    `;
    return { ...out, ok: true, step: "ok" };
}

/** TTL for the router's presigned pull: 2x an expectation of 3x realtime, floor ten minutes. */
export function routerPresignTtlSeconds(audioSeconds: number): number {
  if (!Number.isFinite(audioSeconds) || audioSeconds <= 0) return 600;
  return Math.max(600, Math.ceil(audioSeconds * 3 * 2));
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
export async function drainRoomWaitingWindows(
  roomId: string,
  origin: string,
  limit = 4,
  /** Build 2 §B — required, and carried unchanged onto every window in the batch. */
  actor?: RunActor,
): Promise<DrainOutcome[]> {
  // A batch that cannot say who asked refuses AS A BATCH, before the first window is read. The
  // alternative — refusing per window inside the loop — would still be correct but would burn a
  // query per window to report the same single fact about the caller.
  const problem = actorProblem(actor);
  if (problem) return [{ window_id: "", ok: false, step: "no_actor", detail: problem }];
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
    out.push(await drainRoomWindow(r.id, origin, actor!));
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

export async function drainQueuedRoomWindows(
  origin: string,
  limit = 1,
  /** Build 2 §B — required. An unattended sweep passes SYSTEM_ACTOR with via 'cron', deliberately. */
  actor?: RunActor,
): Promise<DrainOutcome[]> {
  const problem = actorProblem(actor);
  if (problem) return [{ window_id: "", ok: false, step: "no_actor", detail: problem }];
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
    out.push(await drainRoomWindow(j.subject_id, origin, actor!));
  }
  return out;
}

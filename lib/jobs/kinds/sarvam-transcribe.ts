/**
 * lib/jobs/kinds/sarvam-transcribe.ts — S8A. Transcribe ISOLATED CONSULT AUDIO with Sarvam saaras:v3 THROUGH THE AWS GATEWAY
 * (lib/sarvam-gateway.ts), with speaker labels and (by default) an English rendering from mayura:v1.
 *
 * V's STANDING RULE (restated 08 Oct ~20:40): only isolated consult audio goes to Sarvam. No other room audio, never whole windows. So the sources are
 *   { encounter_id }  a doctor-recorded encounter (audio production already sends to Sarvam today)         scope "encounter"
 *   { consult_uid }   a clip cut by the CONSULT cutter, resolved through the consult_index table (0146); refusals: consult_not_indexed, consult_sealed, consult_voice_isolated,
 *                     mirror_minutes_missing, already_transcribed, audio_unreadable. A result for the SAME CUT VERSION and options already stored is returned, never re-sent.  scope "consult_clip"
 * Room / session arguments (room, from, to, session_id, from_ms, to_ms) are REFUSED with scope_consult_only.
 *
 *   prepare   gateway + cap check; the encounter's audio object, or the consult's index row + clip (an existing result for that cut ends the job here, before any Sarvam call)
 *   init      read the clip, MEASURE its duration from the container (never trust the DB / client value), refuse unknown or > 30 min, re-check the cap
 *             counting earlier unaudited jobs, create the Sarvam batch job and PERSIST its id
 *   upload    upload-files + Azure PUT (re-runnable: it overwrites the blob)
 *   start     start (skipped if Sarvam already shows the job running), then ONE stt.paid_call audit row (idempotent on the job id)
 *   poll      status, re-entered until Completed (~90 s per claim); gives up 30 min after the start
 *   finish    download-files, write the result JSON to R2 mcp-sarvam/<job_id>.json, one ledger line (batch)
 *   translate mayura:v1, <= 900 chars a request, the deadline checked PER CHUNK and the partial English saved after EACH chunk, so a claim resumes
 *             mid-entry and never re-sends a translated chunk
 *
 * TRANSIENT failures (429, 5xx, timeout, network) THROW, so the runner retries the step under MAX_FAILURES; a terminal 4xx is failWith.
 * THE TEXT LIVES IN R2 ONLY. `progress` and `result` carry counts, duration, speaker count, language and the key.
 */
import { z } from "zod";
import { sql } from "@/lib/db";
import { JOIN_MAX_MS } from "@/lib/bench-join";
import { measureAudioMs } from "@/lib/audio-duration";
import { getObjectBytes, headObject } from "@/lib/r2";
import { preflightClip } from "@/lib/consult-clip";
import { recordResult, type ConsultResult } from "@/lib/room-access/consult-index-store";
import { gatewayConfigured } from "@/lib/sarvam-gateway";
import { chunkText, gwBatchInit, gwBatchResult, gwBatchStartJob, gwBatchStatus, gwBatchUpload, gwTranslateChunk, SARVAM_GW_STT_MODEL, SARVAM_GW_TRANSLATE_MODEL, type Fail } from "@/lib/sarvam-gw";
import { SARVAM_MEDICAL_PROMPT } from "@/lib/sarvam";
import { appendLedger, touchLane, type CallLine } from "@/lib/sarvam-lab";
import { JobArgsError, doneWith, failWith, nextStep, type JobKind, type StepContext, type StepOutcome } from "../types";
import { jobError, type JobErrorCode } from "../errors";
import {
  SARVAM_WALL_MS, capRefusalForJob, dailyCapRefusal, readJson, recordSarvamCall, resultKey, writeJson,
  type EnglishEntry, type ResultDoc, type SarvamScope,
} from "./sarvam-common";
import { addMayura, alignEnglish, englishCounts, finalizeEnglish, settleUnpaired, tagNative } from "./sarvam-english";
import { DRUG_LEXICON } from "@/lib/drug-lexicon";

export const SARVAM_TRANSCRIBE_KIND = "sarvam_transcribe";
const STEPS = {
  prepare: "prepare", init: "init", upload: "upload", start: "start", poll: "poll", finish: "finish",
  // S8A4: the second Sarvam pass (saaras:v3 translate mode, speech -> English) on the same audio, then the merge
  enInit: "en_init", enUpload: "en_upload", enStart: "en_start", enPoll: "en_poll", enFinish: "en_finish",
  translate: "translate",
} as const;

/** The two Sarvam passes of one job. The native pass keeps its original progress keys; the English pass uses the en_ ones. */
type Pass = "native" | "en";
const KEYS = {
  native: { job: "sarvam_job_id", started: "sarvam_started_ms", startedAt: "started_at", outputs: "outputs", throttled: "throttled", pending: "audit_pending" },
  en: { job: "en_sarvam_job_id", started: "en_started_ms", startedAt: "en_started_at", outputs: "en_outputs", throttled: "en_throttled", pending: "en_audit_pending" },
} as const;
/** The audit_log job id: the job's own id for the native pass, `<id>:en` for the English pass (one paid-call row per pass, idempotent on it). */
const auditJobId = (ctx: StepContext, pass: Pass): string => (pass === "en" ? `${ctx.job.id}:en` : ctx.job.id);

/** Timing knobs (mutable so a test can run the loops without waiting). A step must stay well inside MAX_STEP_MS (200 s). */
export const sarvamTiming = { pollStepMs: 90_000, pollIntervalMs: 5_000, translateStepMs: 120_000 };

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Arguments that name room tape rather than a consult. Refused, not ignored. */
export const ROOM_AUDIO_ARGS = ["room", "from", "to", "session_id", "from_ms", "to_ms", "bench_window_id"] as const;

const Args = z.object({
  encounter_id: z.string().trim().min(1).max(128).optional(),
  consult_uid: z.string().trim().min(1).max(128).optional(),
  mode: z.enum(["transcribe", "codemix"]).default("transcribe"),
  english: z.boolean().default(true),
  num_speakers: z.number().int().min(1).max(6).optional(),
}).strict();

export type SarvamTranscribeArgs =
  | { source: "encounter"; encounter_id: string; mode: "transcribe" | "codemix"; english: boolean; num_speakers?: number }
  | { source: "consult"; consult_uid: string; mode: "transcribe" | "codemix"; english: boolean; num_speakers?: number };

/** PURE. Exactly one of encounter_id / consult_uid; any room or session argument is scope_consult_only. Throws JobArgsError. */
export function parseSarvamTranscribeArgs(raw: unknown): SarvamTranscribeArgs {
  const o = (raw ?? {}) as Record<string, unknown>;
  const room = ROOM_AUDIO_ARGS.filter((k) => o[k] !== undefined && o[k] !== null);
  if (room.length > 0) throw new JobArgsError(`scope_consult_only: only an encounter_id or a consult_uid may be sent to Sarvam (not ${room.join(", ")})`);
  const p = Args.safeParse(o);
  if (!p.success) throw new JobArgsError(`bad args: ${p.error.issues[0]?.path.join(".") || "args"} ${p.error.issues[0]?.message ?? ""}`.trim().slice(0, 160));
  const a = p.data;
  const common = { mode: a.mode, english: a.english, ...(a.num_speakers ? { num_speakers: a.num_speakers } : {}) };
  if ((a.encounter_id === undefined) === (a.consult_uid === undefined)) throw new JobArgsError("give exactly one source: {encounter_id} or {consult_uid}");
  return a.encounter_id !== undefined ? { source: "encounter", encounter_id: a.encounter_id, ...common } : { source: "consult", consult_uid: a.consult_uid!, ...common };
}

/** Sarvam's states for a job that exists but has not been started (everything else means it has been started: running, completed or failed). */
const isCreatedState = (state: string): boolean => state === "Pending" || state === "Accepted" || state === "Created";

/** A failed gateway call: transient ones THROW (the runner retries the step under MAX_FAILURES), terminal ones fail the job by code. */
function bail(f: Fail, code: JobErrorCode): StepOutcome {
  if (f.transient) throw new Error(`${code}: ${f.error}`);
  return failWith(jobError(code, f.error));
}

export const sarvamTranscribeKind: JobKind = {
  name: SARVAM_TRANSCRIBE_KIND,
  first: STEPS.prepare,
  roomData: false,
  roomDataNote: "source is a doctor-PWA encounter or a cut consult clip resolved through consult_index (the held-out rule is lifted, V 10 Oct); a room audio argument is refused at parse (scope_consult_only)",
  scope: "invoke",
  parseArgs: (raw) => parseSarvamTranscribeArgs(raw) as unknown as Record<string, unknown>,
  // S4: one open job per source; a second ask for the same encounter / consult gets the open job's id back
  dedupeOn: (args) => {
    const a = args as unknown as SarvamTranscribeArgs;
    // G23: the options are part of the identity (a codemix ask must not be answered with an open transcribe-mode job). A caller that sends the defaults (or the
    // same options) still dedupes; only a DIFFERENT mode / english / num_speakers opens a second job.
    const id: [string, string] = a.source === "encounter" ? ["encounter_id", a.encounter_id] : ["consult_uid", a.consult_uid];
    return [id, ["mode", a.mode], ["english", String(a.english)], ["num_speakers", a.num_speakers === undefined ? null : String(a.num_speakers)]];
  },
  async run(ctx: StepContext) {
    const out = await runStep(ctx);
    // D2: the lane is rewritten on every step, and once more when work ends (forced, the finishing job excluded from `active`)
    const terminal = out.kind !== "next";
    await touchLane({ force: terminal, excludeJobId: terminal ? ctx.job.id : null });
    return out;
  },
};

async function runStep(ctx: StepContext): Promise<StepOutcome> {
  switch (ctx.step) {
    case STEPS.prepare: return prepareStep(ctx);
    case STEPS.init: return initStep(ctx, "native");
    case STEPS.upload: return uploadStep(ctx, "native");
    case STEPS.start: return startStep(ctx, "native");
    case STEPS.poll: return pollStep(ctx, "native");
    case STEPS.finish: return finishStep(ctx);
    case STEPS.enInit: return initStep(ctx, "en");
    case STEPS.enUpload: return uploadStep(ctx, "en");
    case STEPS.enStart: return startStep(ctx, "en");
    case STEPS.enPoll: return pollStep(ctx, "en");
    case STEPS.enFinish: return enFinishStep(ctx);
    case STEPS.translate: return translateStep(ctx);
    default: return failWith(jobError("unknown_step", ctx.step));
  }
}

const num = (v: unknown): number => (typeof v === "number" ? v : Number(v));
const scopeOf = (ctx: StepContext): SarvamScope => (ctx.progress.scope === "consult_clip" ? "consult_clip" : "encounter");

// --- prepare --------------------------------------------------------------------------------------------------------------------------------
async function prepareStep(ctx: StepContext): Promise<StepOutcome> {
  const a = ctx.args as unknown as SarvamTranscribeArgs;
  if (a.source === "consult") return prepareConsult(ctx, a);
  if (!gatewayConfigured()) return failWith(jobError("sarvam_gateway_not_configured"));
  if (await dailyCapRefusal()) return failWith(jobError("sarvam_daily_cap"));
  const rows = (await sql`SELECT audio_object_key FROM encounter WHERE id = ${a.encounter_id}::text LIMIT 1`) as Array<{ audio_object_key: string | null }>;
  const enc = rows[0];
  if (!enc) return failWith(jobError("source_not_found"));
  if (!enc.audio_object_key) return failWith(jobError("no_audio_in_range"));
  let contentType = "audio/webm";
  try {
    contentType = (await headObject(enc.audio_object_key)).content_type || contentType;
  } catch {
    /* the init step reads the bytes and fails by name if the object is gone */
  }
  return nextStep(STEPS.init, { clip_key: enc.audio_object_key, content_type: contentType, scope: "encounter", ref: a.encounter_id, source_kind: "encounter" });
}

/**
 * A consult clip: the index row and every refusal first (lib/consult-clip.ts). A result already stored for this cut version and these options ends the job HERE, before the gateway or the cap is looked at
 * (so a capped day, or a gateway that is down, still answers an old question) and without one Sarvam call.
 */
async function prepareConsult(ctx: StepContext, a: Extract<SarvamTranscribeArgs, { source: "consult" }>): Promise<StepOutcome> {
  const pre = await preflightClip(a.consult_uid, { mode: a.mode, english: a.english });
  if (!pre.ok) return failWith(jobError(pre.error));
  if (pre.existing) return doneWith(existingSummary(pre.existing));
  if (!gatewayConfigured()) return failWith(jobError("sarvam_gateway_not_configured"));
  if (await dailyCapRefusal()) return failWith(jobError("sarvam_daily_cap"));
  return nextStep(STEPS.init, {
    clip_key: pre.key, content_type: pre.content_type, scope: "consult_clip", ref: a.consult_uid, source_kind: "consult", cut_version: pre.row.cut_version, clip_t0_ms: pre.row.t0_ms,
    ...(typeof pre.row.minutes === "number" && Number.isFinite(pre.row.minutes) ? { mirror_minutes: pre.row.minutes } : {}),
  });
}

/** What a job answers when the cut already has its result: pointers and counts only, flagged `existing` (no Sarvam call was made, nothing was billed). */
export function existingSummary(r: ConsultResult): Record<string, unknown> {
  return {
    existing: true, consult_uid: r.consult_uid, cut_version: r.cut_version, source_job_id: r.job_id, r2_key: r.result_r2_key, model_stt: r.model_stt, model_translate: r.model_translate, model_rev: r.model_rev,
    language_code: r.language_code, duration_s: r.duration_s, speakers: r.speaker_count, transcript_chars: r.transcript_chars, english_chars: r.english_chars, english_pass: r.english_pass ?? "not_requested",
  };
}

// --- init -----------------------------------------------------------------------------------------------------------------------------------
/** The English pass could not be run or finished: the native result stands, the entries still needing English go to mayura (per entry). Never fails the job. */
const enSkip = (ctx: StepContext, reason: "skipped_cap" | "failed", extra: Record<string, unknown> = {}): StepOutcome => nextStep(STEPS.enFinish, { ...ctx.progress, ...extra, en_skip: reason });

/** A terminal failure of a pass: the native pass fails the job (ledger line + code); the English pass logs its failed line and falls back to mayura. */
async function passFailed(ctx: StepContext, pass: Pass, f: Fail, code: JobErrorCode, extra: { throttled?: boolean } = {}): Promise<StepOutcome> {
  if (pass === "native") return ledgerFailed(ctx, f, code, extra);
  if (typeof ctx.progress[KEYS.en.job] === "string") await ledgerBatch(ctx, "failed", f.status ?? httpStatusOf(f.error), extra.throttled === true || ctx.progress[KEYS.en.throttled] === true || f.status === 429, "en");
  return enSkip(ctx, "failed");
}

async function initStep(ctx: StepContext, pass: Pass): Promise<StepOutcome> {
  if (!gatewayConfigured()) return pass === "en" ? enSkip(ctx, "failed") : failWith(jobError("sarvam_gateway_not_configured"));
  const a = ctx.args as unknown as SarvamTranscribeArgs;
  const K = KEYS[pass];
  const clipKey = String(ctx.progress.clip_key ?? "");
  if (!clipKey) return failWith(jobError("progress_incomplete", "clip key"));
  // already created on an earlier claim: do NOT create a second Sarvam job
  if (typeof ctx.progress[K.job] === "string" && ctx.progress[K.job]) return nextStep(pass === "en" ? STEPS.enUpload : STEPS.upload, ctx.progress);

  if (pass === "en") {
    // the SAME audio again (a batch job owns its upload); its measured duration is already in progress. The second pass's minutes must fit the cap too.
    const minutes = num(ctx.progress.duration_ms) / 60_000;
    const cap = await capRefusalForJob({ id: ctx.job.id, created_at: ctx.job.created_at }, minutes);
    if (cap) return enSkip(ctx, "skipped_cap");
    const init = await gwBatchInit({ mode: "translate", numSpeakers: a.num_speakers ?? null, prompt: SARVAM_MEDICAL_PROMPT });
    if (!init.ok) {
      console.error("[sarvam] english-pass init failed", JSON.stringify({ job: ctx.job.id, err: init.error, transient: init.transient }));
      return init.transient ? bail(init, "sarvam_submit_failed") : enSkip(ctx, "failed");
    }
    return nextStep(STEPS.enUpload, { ...ctx.progress, [K.job]: init.jobId, [K.startedAt]: new Date().toISOString() });
  }

  const bytes = await getObjectBytes(clipKey);
  if (!bytes) return failWith(jobError("clip_missing_in_r2"));
  // F2: the duration is MEASURED from the audio's own container. A NULL or understated database / client value cannot get past this.
  const measured = measureAudioMs(bytes);
  if (measured === null) return failWith(jobError("duration_unknown"));
  // a consult clip is never shorter than the index says (max of the container, the size floor in measureAudioMs and the index minutes x 60)
  const mirrorMs = typeof ctx.progress.mirror_minutes === "number" && Number.isFinite(ctx.progress.mirror_minutes) ? ctx.progress.mirror_minutes * 60_000 : 0;
  const ms = Math.max(measured, mirrorMs);
  if (ms > JOIN_MAX_MS) return failWith(jobError("window_too_long"));
  const minutes = ms / 60_000;
  // S8A4: an English-track job makes TWO Sarvam passes over the audio, so it asks the cap for both
  const cap = await capRefusalForJob({ id: ctx.job.id, created_at: ctx.job.created_at }, minutes * (a.english ? 2 : 1));
  if (cap) return failWith(jobError("sarvam_daily_cap", `today ${cap.today} + reserved ${cap.reserved} + this ${cap.own} min`));
  const init = await gwBatchInit({ mode: a.mode, numSpeakers: a.num_speakers ?? null, prompt: SARVAM_MEDICAL_PROMPT });
  if (!init.ok) {
    console.error("[sarvam] init failed", JSON.stringify({ job: ctx.job.id, err: init.error, transient: init.transient }));
    return bail(init, "sarvam_submit_failed");
  }
  // G2: the id is persisted by returning it in progress BEFORE the upload, so a replay resumes instead of paying for a second job
  return nextStep(STEPS.upload, { ...ctx.progress, sarvam_job_id: init.jobId, duration_ms: Math.round(ms), started_at: new Date().toISOString() });
}

// --- upload ---------------------------------------------------------------------------------------------------------------------------------
async function uploadStep(ctx: StepContext, pass: Pass): Promise<StepOutcome> {
  const K = KEYS[pass];
  const jobId = String(ctx.progress[K.job] ?? "");
  const clipKey = String(ctx.progress.clip_key ?? "");
  if (!jobId || !clipKey) return failWith(jobError("progress_incomplete", "sarvam job"));
  const bytes = await getObjectBytes(clipKey);
  if (!bytes) return pass === "en" ? enSkip(ctx, "failed") : failWith(jobError("clip_missing_in_r2"));
  const up = await gwBatchUpload(jobId, bytes, String(ctx.progress.content_type ?? "audio/webm"));
  if (!up.ok) {
    console.error("[sarvam] upload failed", JSON.stringify({ job: ctx.job.id, pass, err: up.error, transient: up.transient }));
    return up.transient ? bail(up, "sarvam_submit_failed") : passFailed(ctx, pass, up, "sarvam_submit_failed");
  }
  return nextStep(pass === "en" ? STEPS.enStart : STEPS.start, ctx.progress);
}

// --- start ----------------------------------------------------------------------------------------------------------------------------------
async function startStep(ctx: StepContext, pass: Pass): Promise<StepOutcome> {
  const K = KEYS[pass];
  const jobId = String(ctx.progress[K.job] ?? "");
  if (!jobId) return failWith(jobError("progress_incomplete", "sarvam job"));
  // a replay after a successful start must not start twice: ask Sarvam first
  const st = await gwBatchStatus(jobId);
  // S2: a FAILED status read says nothing about whether the job was started, so it is never read as "not started" (that would start it a second time and
  // pay twice). A transient failure throws (the runner retries the step); a terminal one (the job is unknown to Sarvam) fails the job by code.
  if (!st.ok) {
    console.error("[sarvam] status before start failed", JSON.stringify({ job: ctx.job.id, pass, err: st.error, transient: st.transient }));
    return st.transient ? bail(st, "sarvam_submit_failed") : passFailed(ctx, pass, st, "sarvam_submit_failed");
  }
  const alreadyStarted = !isCreatedState(st.state);
  if (!alreadyStarted) {
    const s = await gwBatchStartJob(jobId);
    if (!s.ok) {
      console.error("[sarvam] start failed", JSON.stringify({ job: ctx.job.id, pass, err: s.error, transient: s.transient }));
      if (s.transient) return bail(s, "sarvam_submit_failed");
      // G10: a 4xx on start may only mean the job is ALREADY started (a replay that raced). Ask again: if Sarvam has the job past Created it is running
      // (and billing), so carry on polling it instead of failing a job Sarvam is still working on.
      const again = await gwBatchStatus(jobId);
      // G15: if the recheck ITSELF fails transiently (503, timeout), Sarvam may well be running the job: throw, so the runner retries the step under
      // MAX_FAILURES, instead of failing a job we cannot say is not running.
      if (!again.ok && again.transient) return bail(again, "sarvam_submit_failed");
      if (!(again.ok && !isCreatedState(again.state))) return passFailed(ctx, pass, s, "sarvam_submit_failed");
    }
  }
  // G22/G26: THE START EVIDENCE TRAVELS IN THE STEP'S OWN RESULT. The started-at stamp goes into the progress this step returns (saved by the runner under the lease), never
  // through a mid-step write (G27) and never by throwing: a throw makes the runner write the PRE-step progress back and erase it.
  const progress = { ...ctx.progress, [K.started]: num(ctx.progress[K.started]) || Date.now() };
  // S3: the paid-call audit row is what the daily cap counts. It is retried inside the call. If it still cannot be written the job does NOT fail while Sarvam is running:
  // the step moves on to `poll` with the pending flag, and poll retries the write on every claim (settleAudit) until it lands. Meanwhile the minutes stay reserved
  // (reservedMinutesEarlier counts any job with a recorded start and no audit row, whatever its status).
  return nextStep(pass === "en" ? STEPS.enPoll : STEPS.poll, await settleAudit(ctx, { ...progress, [K.pending]: true }, pass));
}

/** Write the paid-call row for a pass if progress says it is pending; on success the flag is dropped, on audit_write_failed it stays (never throws for that). */
async function settleAudit(ctx: StepContext, progress: Record<string, unknown>, pass: Pass = "native"): Promise<Record<string, unknown>> {
  const K = KEYS[pass];
  if (progress[K.pending] !== true) return progress;
  try {
    await recordSarvamCall({ actor: ctx.job.actor ?? null, jobId: auditJobId(ctx, pass), sarvamJobId: String(progress[K.job] ?? ""), durationMs: num(progress.duration_ms) || 0, scope: scopeOf(ctx) });
  } catch (e) {
    if (!/^audit_write_failed/.test(String((e as Error)?.message ?? e))) throw e;
    return progress;
  }
  const { [K.pending]: _done, ...rest } = progress;
  void _done;
  return rest;
}

// --- poll -----------------------------------------------------------------------------------------------------------------------------------
async function pollStep(ctx: StepContext, pass: Pass): Promise<StepOutcome> {
  const K = KEYS[pass];
  ctx = { ...ctx, progress: await settleAudit(ctx, ctx.progress, pass) }; // G26: an audit fault never fails the job while Sarvam runs; retried on every claim
  const jobId = String(ctx.progress[K.job] ?? "");
  const startedMs = num(ctx.progress[K.started]);
  if (!jobId || !startedMs) return failWith(jobError("progress_incomplete", "sarvam job"));
  const deadline = Date.now() + sarvamTiming.pollStepMs;
  let throttled = ctx.progress[K.throttled] === true;
  for (;;) {
    if (Date.now() - startedMs > SARVAM_WALL_MS) return passFailed(ctx, pass, { ok: false, error: "timeout", transient: false }, "sarvam_timeout", { throttled });
    const st = await gwBatchStatus(jobId);
    if (st.ok) {
      if (st.state === "Completed") {
        if (st.outputs.length === 0) return passFailed(ctx, pass, { ok: false, error: "no_outputs", transient: false }, "sarvam_result_failed", { throttled });
        return nextStep(pass === "en" ? STEPS.enFinish : STEPS.finish, { ...ctx.progress, [K.outputs]: st.outputs, [K.throttled]: throttled });
      }
      if (st.state === "Failed") return passFailed(ctx, pass, { ok: false, error: "job_failed", transient: false }, "sarvam_job_failed", { throttled });
    } else if (st.status === 429) throttled = true; // a transient status error is retried inside the window, as lib/sarvam.ts does
    await touchLane(); // throttled to once per 20 s: the lane stays fresh while we wait
    if (Date.now() + sarvamTiming.pollIntervalMs >= deadline) break;
    await sleep(sarvamTiming.pollIntervalMs);
  }
  return nextStep(pass === "en" ? STEPS.enPoll : STEPS.poll, { ...ctx.progress, [K.throttled]: throttled });
}

// --- ledger helpers (D1; failures never fail the job, D4) -----------------------------------------------------------------------------------
function httpStatusOf(error: string): number | null {
  const m = /(?:^|_|\s)(\d{3})(?:\s|$)/.exec(error);
  return m ? Number(m[1]) : null;
}
const refOf = (ctx: StepContext): string => {
  const a = ctx.args as unknown as SarvamTranscribeArgs;
  return String(ctx.progress.ref ?? (a.source === "encounter" ? a.encounter_id : a.consult_uid));
};

/** One ledger line per Sarvam batch pass: the native pass is task "transcribe" under the job's id; the English pass is task "translate" under `<id>:en`. */
async function ledgerBatch(ctx: StepContext, status: "ok" | "failed", httpStatus: number | null, throttled: boolean, pass: Pass = "native"): Promise<void> {
  const K = KEYS[pass];
  await appendLedger({
    caller: "scribe-mcp", machine: "vercel", job_id: auditJobId(ctx, pass), request_id: typeof ctx.progress[K.job] === "string" ? (ctx.progress[K.job] as string) : null,
    route: "gateway", mode: "batch", task: pass === "en" ? "translate" : "transcribe", model: SARVAM_GW_STT_MODEL, audio_s: Math.round(num(ctx.progress.duration_ms) / 10) / 100 || 0,
    started_at: typeof ctx.progress[K.startedAt] === "string" ? (ctx.progress[K.startedAt] as string) : new Date().toISOString(), finished_at: new Date().toISOString(),
    status, http_status: httpStatus, throttled, scope: scopeOf(ctx), ref: refOf(ctx),
  } satisfies CallLine);
}

async function ledgerTranslation(ctx: StepContext, status: "ok" | "failed", chars: number, httpStatus: number | null, throttled: boolean): Promise<void> {
  await appendLedger({
    caller: "scribe-mcp", machine: "vercel", job_id: `${ctx.job.id}:translate`, request_id: null, route: "gateway", mode: "sync", task: "text_translate",
    model: SARVAM_GW_TRANSLATE_MODEL, audio_s: 0, chars, started_at: typeof ctx.progress.translate_started_at === "string" ? ctx.progress.translate_started_at : new Date().toISOString(),
    finished_at: new Date().toISOString(), status, http_status: httpStatus, throttled, scope: scopeOf(ctx), ref: refOf(ctx),
  } satisfies CallLine);
}

/** A terminal failure after Sarvam has (or may have) the work: one `failed` ledger line, then fail the job by code. */
async function ledgerFailed(ctx: StepContext, f: Fail, code: JobErrorCode, extra: { throttled?: boolean } = {}): Promise<StepOutcome> {
  if (typeof ctx.progress.sarvam_job_id === "string") await ledgerBatch(ctx, "failed", f.status ?? httpStatusOf(f.error), extra.throttled === true || ctx.progress.throttled === true || f.status === 429);
  return failWith(jobError(code, f.error));
}

// --- finish (native pass) ------------------------------------------------------------------------------------------------------------------
async function finishStep(ctx: StepContext): Promise<StepOutcome> {
  ctx = { ...ctx, progress: await settleAudit(ctx, ctx.progress, "native") }; // one more try at a still-pending audit row; never fatal
  const a = ctx.args as unknown as SarvamTranscribeArgs;
  const jobId = String(ctx.progress.sarvam_job_id ?? "");
  const outputs = (ctx.progress.outputs as string[] | undefined) ?? [];
  if (!jobId || outputs.length === 0) return failWith(jobError("progress_incomplete", "outputs"));
  const res = await gwBatchResult(jobId, outputs);
  if (!res.ok) {
    console.error("[sarvam] result failed", JSON.stringify({ job: ctx.job.id, err: res.error, transient: res.transient }));
    return res.transient ? bail(res, "sarvam_result_failed") : ledgerFailed(ctx, res, "sarvam_result_failed");
  }
  const knownMs = num(ctx.progress.duration_ms);
  let raw = res.entries.map((e) => ({ speaker_id: e.speakerId, start_s: e.start, end_s: e.end, text: e.transcript, language_code: e.languageCode }));
  const durationS = knownMs > 0 ? Math.round(knownMs / 10) / 100 : raw.reduce((m, e) => Math.max(m, e.end_s), 0);
  // no diarized entries: the whole transcript is one pseudo-entry (translated chunk by chunk, so its length is no problem)
  if (raw.length === 0 && res.transcript.trim()) raw = [{ speaker_id: "", start_s: 0, end_s: durationS, text: res.transcript, language_code: null }];
  const entries = tagNative(raw);
  const speakers = [...new Set(entries.map((e) => e.speaker_id))].sort();
  const wantEnglish = a.english === true;
  const doc: ResultDoc = {
    language_code: res.languageCode, duration_s: durationS, speakers, entries, transcript: res.transcript,
    english_pass: wantEnglish ? "pending" : "not_requested", sarvam_job_ids: { native: jobId, english: null }, minutes: { native: Math.round((knownMs / 60_000) * 1000) / 1000, english: 0 },
  };
  try {
    await writeJson(resultKey(ctx.job.id), doc);
  } catch {
    throw new Error("result_write_failed"); // transient by nature: retried under MAX_FAILURES, the Sarvam output is still downloadable
  }
  if (!wantEnglish) await recordConsult(ctx, doc); // a consult's result is registered under its cut version before the job reports done (a throw retries the step; nothing is re-sent to Sarvam)
  await ledgerBatch(ctx, "ok", 200, ctx.progress.throttled === true);
  // S8A4: the English track comes from the AUDIO: a second saaras:v3 pass in translate mode, whatever the file-level language_code says
  if (wantEnglish) return nextStep(STEPS.enInit, { ...ctx.progress, total_entries: entries.length, language_code: res.languageCode });
  return doneWith({ ...summary(ctx.job.id, doc), ...consultFields(ctx) });
}

// --- en_finish: download the English pass, align, settle what is unpaired --------------------------------------------------------------------
async function enFinishStep(ctx: StepContext): Promise<StepOutcome> {
  ctx = { ...ctx, progress: await settleAudit(ctx, ctx.progress, "en") };
  const key = resultKey(ctx.job.id);
  const doc = await readJson<ResultDoc>(key);
  if (!doc) return failWith(jobError("sarvam_result_failed", "result_missing"));
  const K = KEYS.en;
  let pass: "done" | "skipped_cap" | "failed" = ctx.progress.en_skip === "skipped_cap" ? "skipped_cap" : ctx.progress.en_skip === "failed" ? "failed" : "done";
  let track: EnglishEntry[] = [];
  let rejected = 0;
  let passReference: string | null = null;
  let rejectedNative = new Set<number>();
  const enJobId = String(ctx.progress[K.job] ?? "");
  if (pass === "done") {
    const outputs = (ctx.progress[K.outputs] as string[] | undefined) ?? [];
    if (!enJobId || outputs.length === 0) return failWith(jobError("progress_incomplete", "english outputs"));
    const res = await gwBatchResult(enJobId, outputs);
    if (!res.ok) {
      console.error("[sarvam] english result failed", JSON.stringify({ job: ctx.job.id, err: res.error, transient: res.transient }));
      if (res.transient) return bail(res, "sarvam_result_failed");
      await ledgerBatch(ctx, "failed", res.status ?? httpStatusOf(res.error), false, "en");
      pass = "failed";
    } else {
      let raw = res.entries.map((e) => ({ speaker_id: e.speakerId, start_s: e.start, end_s: e.end, text: e.transcript }));
      // G49: a transcript-only response has no entries to align. It is NOT turned into a pseudo-entry attached to one native entry (its text would sit in the English next to
      // mayura's translation of the same speech): every native entry is settled on its own (Latin kept, the rest to mayura) and the pass text is kept only as a reference.
      if (raw.length === 0 && res.transcript.trim()) passReference = res.transcript.trim();
      // G43: the pass is not trusted to have returned English: every entry is checked, refused ones send their native partner to mayura
      const aligned = alignEnglish(doc.entries, raw);
      track = aligned.track;
      rejected = aligned.rejected;
      rejectedNative = aligned.rejectedNative;
      if (rejected > 0 && rejected > track.length) console.error("[sarvam] english pass looks untranslated", JSON.stringify({ job: ctx.job.id, rejected, of: raw.length }));
      await ledgerBatch(ctx, "ok", 200, ctx.progress[K.throttled] === true, "en");
    }
  }
  doc.english_entries = track;
  const need = settleUnpaired(doc.entries, track, rejectedNative);
  doc.pass_rejected = rejected;
  if (passReference) doc.english_pass_reference = passReference;
  // "suspect": most of what the pass returned was not English (the API most likely ignored mode translate)
  doc.english_pass = pass === "done" && rejected > 0 && rejected > (doc.english_entries?.length ?? 0) ? "suspect" : pass;
  doc.sarvam_job_ids = { native: doc.sarvam_job_ids?.native ?? null, english: enJobId || null };
  doc.minutes = { native: doc.minutes?.native ?? 0, english: pass === "done" ? Math.round((num(ctx.progress.duration_ms) / 60_000) * 1000) / 1000 : 0 };
  if (need.length > 0) {
    try {
      await writeJson(key, doc);
    } catch {
      throw new Error("result_write_failed");
    }
    return nextStep(STEPS.translate, { ...ctx.progress, remaining_entries: need.length, translate_started_at: new Date().toISOString() });
  }
  return finishDoc(ctx, key, doc, 0, false);
}

/** Order the English track, compute the drug candidates, write the final object, finish. */
async function finishDoc(ctx: StepContext, key: string, doc: ResultDoc, mayuraChars: number, throttled: boolean): Promise<StepOutcome> {
  finalizeEnglish(doc, DRUG_LEXICON);
  try {
    await writeJson(key, doc);
  } catch {
    throw new Error("result_write_failed");
  }
  await recordConsult(ctx, doc);
  if (mayuraChars > 0) await ledgerTranslation(ctx, "ok", mayuraChars, 200, throttled);
  return doneWith({ ...summary(ctx.job.id, doc), ...consultFields(ctx) });
}

/** Which cut a consult job's result belongs to (ids only). */
const consultFields = (ctx: StepContext): Record<string, unknown> =>
  (ctx.args as unknown as SarvamTranscribeArgs).source === "consult" ? { consult_uid: (ctx.args as { consult_uid: string }).consult_uid, cut_version: ctx.progress.cut_version ?? null } : {};

/** Our code identity, recorded with every consult result beside the vendor's model revision. */
export const PIPELINE_REV = `sarvam-consult-1:${(process.env.VERCEL_GIT_COMMIT_SHA ?? "dev").slice(0, 12)}`;

/**
 * Register the finished result of a consult under (consult_uid, cut_version, mode, english): the UNIQUE key is what makes the next ask for this cut a lookup, not a second bill.
 * Model + revision are recorded. A no-op for an encounter source, or when another job already registered this cut.
 */
async function recordConsult(ctx: StepContext, doc: ResultDoc): Promise<void> {
  const a = ctx.args as unknown as SarvamTranscribeArgs;
  const cut = ctx.progress.cut_version;
  if (a.source !== "consult" || typeof cut !== "string" || !cut) return;
  await recordResult({
    consult_uid: a.consult_uid, cut_version: cut, mode: a.mode, english: a.english, num_speakers: a.num_speakers ?? null, job_id: ctx.job.id, result_r2_key: resultKey(ctx.job.id),
    model_stt: SARVAM_GW_STT_MODEL, model_translate: SARVAM_GW_TRANSLATE_MODEL, model_rev: SARVAM_GW_STT_MODEL, pipeline_rev: PIPELINE_REV, language_code: doc.language_code, duration_s: doc.duration_s,
    speaker_count: doc.speakers.length, transcript_chars: doc.transcript.length, english_chars: doc.english?.length ?? 0, english_pass: doc.english_pass ?? "not_requested",
    t0_ms: num(ctx.progress.clip_t0_ms) || 0,
  });
}

function summary(jobId: string, doc: ResultDoc): Record<string, unknown> {
  return {
    r2_key: resultKey(jobId),
    speakers: doc.speakers.length,
    language_code: doc.language_code,
    duration_s: doc.duration_s,
    english: doc.english !== undefined,
    transcript_chars: doc.transcript.length,
    english_chars: doc.english?.length ?? 0,
    english_pass: doc.english_pass ?? "not_requested",
    english_entries: doc.english_entries?.length ?? 0,
    ...englishCounts(doc),
    pass_rejected: doc.pass_rejected ?? 0,
    drug_candidates: doc.drug_candidates?.length ?? 0,
    minutes: doc.minutes ?? { native: 0, english: 0 },
  };
}

// --- translate: mayura, PER ENTRY, for the entries the English pass did not cover ----------------------------------------------------------------
async function translateStep(ctx: StepContext): Promise<StepOutcome> {
  const key = resultKey(ctx.job.id);
  const doc = await readJson<ResultDoc>(key);
  if (!doc) return failWith(jobError("sarvam_result_failed", "result_missing"));
  const deadline = Date.now() + sarvamTiming.translateStepMs;
  const throttled = ctx.progress.translate_throttled === true;
  let sent = num(ctx.progress.translate_chars) || 0;

  for (const entry of doc.entries) {
    if (entry.english !== undefined) continue;
    const chunks = chunkText(entry.text);
    const parts = entry.parts ?? [];
    // the entry's OWN language if Sarvam gave one, else "auto": the file-level code is not trusted for a mixed-language consult
    const src = entry.mayura_lang ?? (entry.language_code && entry.language_code.includes("-") && !/^en-/i.test(entry.language_code) ? entry.language_code : null);
    let gaveUp = false;
    // F1: the deadline is checked per CHUNK, and the partial English is saved after EACH chunk, so a claim resumes mid-entry and never re-sends
    while (parts.length < chunks.length) {
      if (Date.now() >= deadline) {
        entry.parts = parts;
        return persistAndContinue(ctx, key, doc, throttled, sent);
      }
      const r = await gwTranslateChunk(chunks[parts.length]!, src);
      if (!r.ok) {
        entry.parts = parts;
        await writeJson(key, doc).catch(() => undefined);
        console.error("[sarvam] translate failed", JSON.stringify({ job: ctx.job.id, err: r.error, transient: r.transient }));
        if (r.transient) throw new Error(`sarvam_translate_failed: ${r.error}`);
        await ledgerTranslation(ctx, "failed", sent, r.status ?? httpStatusOf(r.error), throttled || r.status === 429);
        // G54: mayura refuses (unavailable, capped, a 4xx) an entry the translate pass had PARTLY covered: the job goes on, the entry keeps that part and says so (status partial)
        if (entry.partial_english) {
          entry.english = "";
          delete entry.parts;
          gaveUp = true;
          break;
        }
        return failWith(jobError("sarvam_translate_failed", r.error));
      }
      parts.push(r.english);
      sent += chunks[parts.length - 1]!.length;
      entry.parts = parts;
      try {
        await writeJson(key, doc);
      } catch {
        throw new Error("result_write_failed");
      }
    }
    if (gaveUp) continue; // the entry stays english "" with its partial English set aside (addMayura restores it as status partial)
    entry.english = parts.join(" ").trim();
    entry.english_source = entry.english_source === "mayura_fallback" ? "mayura_fallback" : "mayura";
    delete entry.parts;
  }
  const remaining = doc.entries.filter((e) => e.english === undefined).length;
  if (remaining > 0) return persistAndContinue(ctx, key, doc, throttled, sent);
  doc.english_entries = doc.english_entries ?? [];
  addMayura(doc.entries, doc.english_entries, doc.entries.map((_, i) => i).filter((i) => doc.entries[i]!.english_source === "mayura" || doc.entries[i]!.english_source === "mayura_fallback"));
  return finishDoc(ctx, key, doc, sent, throttled);
}

async function persistAndContinue(ctx: StepContext, key: string, doc: ResultDoc, throttled: boolean, sent: number): Promise<StepOutcome> {
  try {
    await writeJson(key, doc);
  } catch {
    throw new Error("result_write_failed");
  }
  const remaining = doc.entries.filter((e) => e.english === undefined).length;
  return nextStep(STEPS.translate, { ...ctx.progress, remaining_entries: remaining, translate_throttled: throttled, translate_chars: sent });
}

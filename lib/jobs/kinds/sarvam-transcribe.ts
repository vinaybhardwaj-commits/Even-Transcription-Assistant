/**
 * lib/jobs/kinds/sarvam-transcribe.ts — S8A. Transcribe ISOLATED CONSULT AUDIO with Sarvam saaras:v3 THROUGH THE AWS GATEWAY
 * (lib/sarvam-gateway.ts), with speaker labels and (by default) an English rendering from mayura:v1.
 *
 * V's STANDING RULE (restated 08 Oct ~20:40): only isolated consult audio goes to Sarvam. No other room audio, never whole windows. So the sources are
 *   { encounter_id }  a doctor-recorded encounter (audio production already sends to Sarvam today)         scope "encounter"
 *   { consult_uid }   a clip cut by the CONSULT cutter (resolver pending: answers consult_index_unavailable)  scope "consult_clip"
 * Room / session arguments (room, from, to, session_id, from_ms, to_ms) are REFUSED with scope_consult_only.
 *
 *   prepare   gateway + cap check; the encounter's audio object (or, for a consult, consult_index_unavailable)
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
import { gatewayConfigured } from "@/lib/sarvam-gateway";
import { chunkText, gwBatchInit, gwBatchResult, gwBatchStartJob, gwBatchStatus, gwBatchUpload, gwTranslateChunk, SARVAM_GW_STT_MODEL, SARVAM_GW_TRANSLATE_MODEL, type Fail } from "@/lib/sarvam-gw";
import { SARVAM_MEDICAL_PROMPT } from "@/lib/sarvam";
import { appendLedger, touchLane, type CallLine } from "@/lib/sarvam-lab";
import { JobArgsError, doneWith, failWith, nextStep, type JobKind, type StepContext, type StepOutcome } from "../types";
import { saveStep } from "../store";
import { jobError, type JobErrorCode } from "../errors";
import {
  SARVAM_WALL_MS, capRefusalForJob, dailyCapRefusal, looksNonEnglish, readJson, recordSarvamCall, resultKey, writeJson,
  type ResultDoc, type SarvamScope,
} from "./sarvam-common";

export const SARVAM_TRANSCRIBE_KIND = "sarvam_transcribe";
const STEPS = { prepare: "prepare", init: "init", upload: "upload", start: "start", poll: "poll", finish: "finish", translate: "translate" } as const;

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
    case STEPS.init: return initStep(ctx);
    case STEPS.upload: return uploadStep(ctx);
    case STEPS.start: return startStep(ctx);
    case STEPS.poll: return pollStep(ctx);
    case STEPS.finish: return finishStep(ctx);
    case STEPS.translate: return translateStep(ctx);
    default: return failWith(jobError("unknown_step", ctx.step));
  }
}

const num = (v: unknown): number => (typeof v === "number" ? v : Number(v));
const scopeOf = (ctx: StepContext): SarvamScope => (ctx.progress.scope === "consult_clip" ? "consult_clip" : "encounter");

// --- prepare --------------------------------------------------------------------------------------------------------------------------------
async function prepareStep(ctx: StepContext): Promise<StepOutcome> {
  if (!gatewayConfigured()) return failWith(jobError("sarvam_gateway_not_configured"));
  const a = ctx.args as unknown as SarvamTranscribeArgs;
  // a consult clip comes from the CONSULT cutter's index; its resolver is not wired yet
  if (a.source === "consult") return failWith(jobError("consult_index_unavailable"));
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

// --- init -----------------------------------------------------------------------------------------------------------------------------------
async function initStep(ctx: StepContext): Promise<StepOutcome> {
  if (!gatewayConfigured()) return failWith(jobError("sarvam_gateway_not_configured"));
  const a = ctx.args as unknown as SarvamTranscribeArgs;
  const clipKey = String(ctx.progress.clip_key ?? "");
  if (!clipKey) return failWith(jobError("progress_incomplete", "clip key"));
  // already created on an earlier claim: do NOT create a second Sarvam job
  if (typeof ctx.progress.sarvam_job_id === "string" && ctx.progress.sarvam_job_id) return nextStep(STEPS.upload, ctx.progress);

  const bytes = await getObjectBytes(clipKey);
  if (!bytes) return failWith(jobError("clip_missing_in_r2"));
  // F2: the duration is MEASURED from the audio's own container. A NULL or understated database / client value cannot get past this.
  const ms = measureAudioMs(bytes);
  if (ms === null) return failWith(jobError("duration_unknown"));
  if (ms > JOIN_MAX_MS) return failWith(jobError("window_too_long"));
  const minutes = ms / 60_000;
  const cap = await capRefusalForJob({ id: ctx.job.id, created_at: ctx.job.created_at }, minutes);
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
async function uploadStep(ctx: StepContext): Promise<StepOutcome> {
  const jobId = String(ctx.progress.sarvam_job_id ?? "");
  const clipKey = String(ctx.progress.clip_key ?? "");
  if (!jobId || !clipKey) return failWith(jobError("progress_incomplete", "sarvam job"));
  const bytes = await getObjectBytes(clipKey);
  if (!bytes) return failWith(jobError("clip_missing_in_r2"));
  const up = await gwBatchUpload(jobId, bytes, String(ctx.progress.content_type ?? "audio/webm"));
  if (!up.ok) {
    console.error("[sarvam] upload failed", JSON.stringify({ job: ctx.job.id, err: up.error, transient: up.transient }));
    return up.transient ? bail(up, "sarvam_submit_failed") : ledgerFailed(ctx, up, "sarvam_submit_failed");
  }
  return nextStep(STEPS.start, ctx.progress);
}

// --- start ----------------------------------------------------------------------------------------------------------------------------------
async function startStep(ctx: StepContext): Promise<StepOutcome> {
  const jobId = String(ctx.progress.sarvam_job_id ?? "");
  if (!jobId) return failWith(jobError("progress_incomplete", "sarvam job"));
  // a replay after a successful start must not start twice: ask Sarvam first
  const st = await gwBatchStatus(jobId);
  // S2: a FAILED status read says nothing about whether the job was started, so it is never read as "not started" (that would start it a second time and
  // pay twice). A transient failure throws (the runner retries the step); a terminal one (the job is unknown to Sarvam) fails the job by code.
  if (!st.ok) {
    console.error("[sarvam] status before start failed", JSON.stringify({ job: ctx.job.id, err: st.error, transient: st.transient }));
    return st.transient ? bail(st, "sarvam_submit_failed") : ledgerFailed(ctx, st, "sarvam_submit_failed");
  }
  const alreadyStarted = !isCreatedState(st.state);
  if (!alreadyStarted) {
    const s = await gwBatchStartJob(jobId);
    if (!s.ok) {
      console.error("[sarvam] start failed", JSON.stringify({ job: ctx.job.id, err: s.error, transient: s.transient }));
      if (s.transient) return bail(s, "sarvam_submit_failed");
      // G10: a 4xx on start may only mean the job is ALREADY started (a replay that raced). Ask again: if Sarvam has the job past Created it is running
      // (and billing), so carry on polling it instead of failing a job Sarvam is still working on.
      const again = await gwBatchStatus(jobId);
      // G15: if the recheck ITSELF fails transiently (503, timeout), Sarvam may well be running the job: throw, so the runner retries the step under
      // MAX_FAILURES, instead of failing a job we cannot say is not running.
      if (!again.ok && again.transient) return bail(again, "sarvam_submit_failed");
      if (!(again.ok && !isCreatedState(again.state))) return ledgerFailed(ctx, s, "sarvam_submit_failed");
    }
  }
  // S3: the paid-call audit row is what the daily cap counts. It is retried inside the call and, if it still cannot be written, this step THROWS: the job stays
  // in `start` (so its minutes stay RESERVED for the cap, see reservedMinutesEarlier) and the replay finds the job already started, skips the start, and writes the row.
  // G22: persist the START EVIDENCE (sarvam_job_id and duration_ms are already in progress; this adds sarvam_started_ms) BEFORE the audit write, so a job the runner
  // ends after MAX_FAILURES of audit_write_failed still carries proof that Sarvam was started: the cap keeps reserving its minutes and the ledger line counts its audio.
  const startedMs = num(ctx.progress.sarvam_started_ms) || Date.now();
  const progress = { ...ctx.progress, sarvam_started_ms: startedMs };
  if (ctx.runner && !num(ctx.progress.sarvam_started_ms)) await saveStep(ctx.job.id, STEPS.start, progress, ctx.runner);
  await recordSarvamCall({ actor: ctx.job.actor ?? null, jobId: ctx.job.id, sarvamJobId: jobId, durationMs: num(ctx.progress.duration_ms) || 0, scope: scopeOf(ctx) });
  return nextStep(STEPS.poll, progress);
}

// --- poll -----------------------------------------------------------------------------------------------------------------------------------
async function pollStep(ctx: StepContext): Promise<StepOutcome> {
  const jobId = String(ctx.progress.sarvam_job_id ?? "");
  const startedMs = num(ctx.progress.sarvam_started_ms);
  if (!jobId || !startedMs) return failWith(jobError("progress_incomplete", "sarvam job"));
  const deadline = Date.now() + sarvamTiming.pollStepMs;
  let throttled = ctx.progress.throttled === true;
  for (;;) {
    if (Date.now() - startedMs > SARVAM_WALL_MS) return ledgerFailed(ctx, { ok: false, error: "timeout", transient: false }, "sarvam_timeout", { throttled });
    const st = await gwBatchStatus(jobId);
    if (st.ok) {
      if (st.state === "Completed") {
        if (st.outputs.length === 0) return ledgerFailed(ctx, { ok: false, error: "no_outputs", transient: false }, "sarvam_result_failed", { throttled });
        return nextStep(STEPS.finish, { ...ctx.progress, outputs: st.outputs, throttled });
      }
      if (st.state === "Failed") return ledgerFailed(ctx, { ok: false, error: "job_failed", transient: false }, "sarvam_job_failed", { throttled });
    } else if (st.status === 429) throttled = true; // a transient status error is retried inside the window, as lib/sarvam.ts does
    await touchLane(); // throttled to once per 20 s: the lane stays fresh while we wait
    if (Date.now() + sarvamTiming.pollIntervalMs >= deadline) break;
    await sleep(sarvamTiming.pollIntervalMs);
  }
  return nextStep(STEPS.poll, { ...ctx.progress, throttled });
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

async function ledgerBatch(ctx: StepContext, status: "ok" | "failed", httpStatus: number | null, throttled: boolean): Promise<void> {
  await appendLedger({
    caller: "scribe-mcp", machine: "vercel", job_id: ctx.job.id, request_id: typeof ctx.progress.sarvam_job_id === "string" ? ctx.progress.sarvam_job_id : null,
    route: "gateway", mode: "batch", task: "transcribe", model: SARVAM_GW_STT_MODEL, audio_s: Math.round(num(ctx.progress.duration_ms) / 10) / 100 || 0,
    started_at: typeof ctx.progress.started_at === "string" ? ctx.progress.started_at : new Date().toISOString(), finished_at: new Date().toISOString(),
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

// --- finish ---------------------------------------------------------------------------------------------------------------------------------
async function finishStep(ctx: StepContext): Promise<StepOutcome> {
  const a = ctx.args as unknown as SarvamTranscribeArgs;
  const jobId = String(ctx.progress.sarvam_job_id ?? "");
  const outputs = (ctx.progress.outputs as string[] | undefined) ?? [];
  if (!jobId || outputs.length === 0) return failWith(jobError("progress_incomplete", "outputs"));
  const res = await gwBatchResult(jobId, outputs);
  if (!res.ok) {
    console.error("[sarvam] result failed", JSON.stringify({ job: ctx.job.id, err: res.error, transient: res.transient }));
    return res.transient ? bail(res, "sarvam_result_failed") : ledgerFailed(ctx, res, "sarvam_result_failed");
  }
  const entries = res.entries.map((e) => ({ speaker_id: e.speakerId, start_s: e.start, end_s: e.end, text: e.transcript }));
  const speakers = [...new Set(entries.map((e) => e.speaker_id))].sort();
  const knownMs = num(ctx.progress.duration_ms);
  const durationS = knownMs > 0 ? Math.round(knownMs / 10) / 100 : entries.reduce((m, e) => Math.max(m, e.end_s), 0);
  const doc: ResultDoc = { language_code: res.languageCode, duration_s: durationS, speakers, entries, transcript: res.transcript };

  const wantEnglish = a.english === true;
  const needsTranslate = wantEnglish && looksNonEnglish(res.transcript, res.languageCode);
  if (wantEnglish && !needsTranslate) {
    // the language code says English: no Sarvam text call, the English IS the transcript
    doc.english = res.transcript;
    for (const e of doc.entries) e.english = e.text;
  }
  if (needsTranslate && doc.entries.length === 0) {
    // no diarized entries: the whole transcript is one pseudo-entry (translated chunk by chunk, so its length is no problem)
    doc.entries = [{ speaker_id: "", start_s: 0, end_s: durationS, text: res.transcript }];
  }
  try {
    await writeJson(resultKey(ctx.job.id), doc);
  } catch {
    throw new Error("result_write_failed"); // transient by nature: retried under MAX_FAILURES, the Sarvam output is still downloadable
  }
  await ledgerBatch(ctx, "ok", 200, ctx.progress.throttled === true);
  if (needsTranslate) return nextStep(STEPS.translate, { ...ctx.progress, total_entries: doc.entries.length, language_code: res.languageCode, translate_started_at: new Date().toISOString() });
  return doneWith(summary(ctx.job.id, doc));
}

function summary(jobId: string, doc: ResultDoc): Record<string, unknown> {
  return {
    r2_key: resultKey(jobId),
    entries: doc.entries.length,
    speakers: doc.speakers.length,
    language_code: doc.language_code,
    duration_s: doc.duration_s,
    english: doc.english !== undefined,
    transcript_chars: doc.transcript.length,
    english_chars: doc.english?.length ?? 0,
  };
}

// --- translate ------------------------------------------------------------------------------------------------------------------------------
async function translateStep(ctx: StepContext): Promise<StepOutcome> {
  const key = resultKey(ctx.job.id);
  const doc = await readJson<ResultDoc>(key);
  if (!doc) return failWith(jobError("sarvam_result_failed", "result_missing"));
  const deadline = Date.now() + sarvamTiming.translateStepMs;
  const lang = doc.language_code;
  const throttled = ctx.progress.translate_throttled === true;
  let sent = num(ctx.progress.translate_chars) || 0;

  for (const entry of doc.entries) {
    if (entry.english !== undefined) continue;
    const chunks = chunkText(entry.text);
    const parts = entry.parts ?? [];
    // F1: the deadline is checked per CHUNK, and the partial English is saved after EACH chunk, so a claim resumes mid-entry and never re-sends
    while (parts.length < chunks.length) {
      if (Date.now() >= deadline) {
        entry.parts = parts;
        return persistAndContinue(ctx, key, doc, throttled, sent);
      }
      const r = await gwTranslateChunk(chunks[parts.length]!, lang);
      if (!r.ok) {
        entry.parts = parts;
        await writeJson(key, doc).catch(() => undefined);
        console.error("[sarvam] translate failed", JSON.stringify({ job: ctx.job.id, err: r.error, transient: r.transient }));
        if (r.transient) throw new Error(`sarvam_translate_failed: ${r.error}`);
        await ledgerTranslation(ctx, "failed", sent, r.status ?? httpStatusOf(r.error), throttled || r.status === 429);
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
    entry.english = parts.join(" ").trim();
    delete entry.parts;
  }
  const remaining = doc.entries.filter((e) => e.english === undefined).length;
  if (remaining > 0) return persistAndContinue(ctx, key, doc, throttled, sent);
  doc.english = doc.entries.map((e) => e.english ?? "").filter(Boolean).join(" ");
  try {
    await writeJson(key, doc);
  } catch {
    throw new Error("result_write_failed");
  }
  await ledgerTranslation(ctx, "ok", sent, 200, throttled);
  return doneWith(summary(ctx.job.id, doc));
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

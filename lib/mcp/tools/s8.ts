/**
 * lib/mcp/tools/s8.ts — S8A (8 Oct 2026): scribe_sarvam, Sarvam through the Even AWS gateway.
 *
 *   action  transcribe | translate -> validate with the job kind's parseArgs, submit the job, return { job_id, kind, status }
 *           status (job_id)        -> the job row summary
 *           result (job_id)        -> summary + R2 key; include_text:true also returns the stored JSON
 *           usage  (ist_date | days <= 30) -> sarvam-gw minutes / cost estimate / calls per day, sarvam jobs by kind x status, sarvam transcription runs
 *           health                 -> which of the five env NAMES are set, creds_ok, sts_expires_at (the chain to STS only; Sarvam is not called)
 *
 * Registered with the READ scope (the group gate, like scribe_jobs); the two submitting actions need `invoke`, enforced by submitJob itself.
 * Bound SELECTs only. The job's text lives in R2 (mcp-sarvam/<job_id>.json); the job row carries counts, never text. No secret value, token or
 * signature is ever returned (lib/sarvam-gateway.ts).
 */
import { sql } from "@/lib/db";
import { readJob } from "@/lib/jobs/store";
import { JobArgsError, submitJob, UnknownKindError } from "@/lib/jobs/submit";
import { errorCodeOf } from "@/lib/jobs/errors";
import { ROOM_AUDIO_ARGS, SARVAM_TRANSCRIBE_KIND, existingSummary, parseSarvamTranscribeArgs } from "@/lib/jobs/kinds/sarvam-transcribe";
import { SARVAM_CONSULT_BATCH_KIND, parseBatchArgs } from "@/lib/jobs/kinds/sarvam-consult-batch";
import { preflightClip } from "@/lib/consult-clip";
import { palimpsestAsResult } from "@/lib/consult-index/palimpsest-view";
import { signatureVersion } from "@/lib/consult-index/parse";
import { findSarvamTracks } from "@/lib/room-access/readers/reb-consult";
import { consultResultView } from "@/lib/consult-index/result-view";
import { getIndexRow, latestSync, listIndexDay, listResults } from "@/lib/room-access/consult-index-store";
import { SARVAM_TRANSLATE_KIND, parseSarvamTranslateArgs } from "@/lib/jobs/kinds/sarvam-translate";
import { labStoreConfigured } from "@/lib/sarvam-lab";
import { SARVAM_DAILY_CAP_MINUTES, SARVAM_ENGINE, dailyCapRefusal, istDayStartIso, readJson, resultKey, sarvamMinutesToday } from "@/lib/jobs/kinds/sarvam-common";
import { gatewayConfigured, gatewayHealth } from "@/lib/sarvam-gateway";
import { argBool, argInt, argStr, type McpTool, type ToolArgs, type ToolContext } from "../registry";
import { isRealDate, notCollectedReason } from "./s1";

type Row = Record<string, unknown>;

export const SARVAM_ACTIONS = ["transcribe", "translate", "status", "result", "usage", "health", "consult_clips", "consult_result"] as const;
type Action = (typeof SARVAM_ACTIONS)[number];
export const SARVAM_KINDS = [SARVAM_TRANSCRIBE_KIND, SARVAM_TRANSLATE_KIND, SARVAM_CONSULT_BATCH_KIND] as const;
export const USAGE_DAYS_DEFAULT = 7;
export const USAGE_DAYS_MAX = 30;

/** The documented keys, plus the room-audio ones, which are passed on ONLY so the kind can refuse them by name (scope_consult_only). */
const SUBMIT_KEYS = ["encounter_id", "consult_uid", "consult_uids", "force", "mode", "english", "num_speakers", "transcription_run_id", ...ROOM_AUDIO_ARGS] as const;
const submitArgs = (args: ToolArgs): Row => Object.fromEntries(SUBMIT_KEYS.filter((k) => args[k] !== undefined && args[k] !== null).map((k) => [k, args[k]]));
const num = (v: unknown): number | null => (v === null || v === undefined || Number.isNaN(Number(v)) ? null : Number(v));
const round = (n: number, d = 4): number => Math.round(n * 10 ** d) / 10 ** d;

async function submit(kind: string, args: ToolArgs, ctx: ToolContext): Promise<Row> {
  const raw = submitArgs(args);
  // 1. validate by the kind's own parser, so a refusal is typed and nothing is queued
  // a list of consult_uids is ONE batch job (progress through scribe_job_status)
  if (kind === SARVAM_TRANSCRIBE_KIND && raw.consult_uids !== undefined) {
    try { parseBatchArgs(Object.fromEntries(Object.entries(raw).filter(([k]) => k !== "encounter_id" && k !== "consult_uid"))); } catch (e) {
      if (e instanceof JobArgsError) return e.reason.startsWith("scope_consult_only") ? { ok: false, error: "scope_consult_only", detail: e.reason.replace(/^scope_consult_only:\s*/, "") } : { ok: false, error: "bad_args", kind: SARVAM_CONSULT_BATCH_KIND, detail: e.reason };
      throw e;
    }
    if (raw.encounter_id !== undefined || raw.consult_uid !== undefined) return { ok: false, error: "bad_args", kind: SARVAM_CONSULT_BATCH_KIND, detail: "give consult_uids on its own" };
    if (!gatewayConfigured()) return { ok: false, error: "sarvam_gateway_not_configured" };
    return enqueue(SARVAM_CONSULT_BATCH_KIND, raw, ctx);
  }
  try {
    if (kind === SARVAM_TRANSCRIBE_KIND) {
      const parsed = parseSarvamTranscribeArgs(raw);
      // a consult clip comes from the consult_index table: not indexed / sealed / voice isolated / palimpsest already has it / audio unreadable are refused here; a result already stored for THIS CUT VERSION is returned, not re-sent
      if (parsed.source === "consult") {
        const pre = await preflightClip(parsed.consult_uid, { mode: parsed.mode, english: parsed.english, force: parsed.force === true });
        if (!pre.ok) return { ok: false, error: pre.error };
        if (pre.existing) return { ok: true, existing: true, job_id: pre.existing.job_id, ...existingSummary(pre.existing), billed: false };
        // the palimpsest already holds this cut's Sarvam track: it is returned (labelled), Sarvam is not called and nothing is queued
        if (pre.reuse) return { ok: true, existing: true, job_id: null, ...existingSummary(pre.reuse.view.result), billed: false };
      }
    } else {
      const parsed = parseSarvamTranslateArgs(raw);
      if (parsed.kind === "transcription_run") {
        // only a run whose subject is an ENCOUNTER may be translated; a window-subject run is room tape text
        const rows = (await sql`SELECT subject_type FROM transcription_run WHERE id = ${parsed.id}::text LIMIT 1`) as Array<{ subject_type: string | null }>;
        if (rows[0] && rows[0].subject_type !== "encounter") return { ok: false, error: "scope_consult_only", detail: "the run's subject is not an encounter" };
      }
    }
  } catch (e) {
    if (e instanceof JobArgsError) return e.reason.startsWith("scope_consult_only") ? { ok: false, error: "scope_consult_only", detail: e.reason.replace(/^scope_consult_only:\s*/, "") } : { ok: false, error: "bad_args", kind, detail: e.reason };
    throw e;
  }
  if (kind === SARVAM_TRANSCRIBE_KIND) {
    if (!gatewayConfigured()) return { ok: false, error: "sarvam_gateway_not_configured" };
    const cap = await dailyCapRefusal();
    if (cap) return { ok: false, ...cap };
  }
  return enqueue(kind, raw, ctx);
}

async function enqueue(kind: string, raw: Row, ctx: ToolContext): Promise<Row> {
  try {
    const job = await submitJob({ kind, args: raw, actor: ctx.actor, origin: ctx.origin, scopes: ctx.scopes });
    // S4: an open job for the same source is returned, not duplicated
    return { ok: true, job_id: job.id, kind: job.kind, status: job.status, ...(job.deduped ? { deduped: true } : {}) };
  } catch (e) {
    if (e instanceof JobArgsError) return { ok: false, error: "bad_args", kind, detail: e.reason };
    if (e instanceof UnknownKindError) return { ok: false, error: "unknown_kind", kind };
    throw e; // ToolScopeError -> the door's 403
  }
}

const UID_OK = /^[A-Za-z0-9_-]{1,128}$/;
const publicClip = (r: Awaited<ReturnType<typeof getIndexRow>> & object): Row => ({
  consult_uid: r.consult_uid, ist_date: r.ist_date, room_slug: r.room_slug, room_id: r.room_id, session_id: r.session_id, t0_ms: r.t0_ms, t1_ms: r.t1_ms, minutes: r.minutes, cut_version: r.cut_version,
  sealed: r.sealed, voice_isolated: r.voice_isolated, quality: r.quality, coverage: r.coverage,
  // as the cutter recorded it: a hint, never identity (VP-ACC-01 failed); the warehouse consulting_doctor_uid is the doctor truth
  doctor_uid: r.doctor_uid, doctor_identified: r.doctor_identified, doctor_uid_note: "cutter record; not identity",
});

/** consult_clips {ist_date, room_slug?}: the index for one IST day (counts + rows), from the consult_index table. */
async function consultClips(args: ToolArgs): Promise<Row> {
  const date = argStr(args, "ist_date", 10), room = argStr(args, "room_slug", 64);
  if (!date || !isRealDate(date)) return { ok: false, error: "invalid_ist_date" };
  if (room && !/^[A-Za-z0-9_-]{1,64}$/.test(room)) return { ok: false, error: "invalid_room" };
  const limit = 100;
  const day = await listIndexDay(date, room, limit);
  const sync = await latestSync();
  return {
    ok: true, ist_date: date, count: day.total, sealed: day.rows.filter((r) => r.sealed).length, voice_isolated: day.rows.filter((r) => r.voice_isolated === true).length, truncated: day.total > day.rows.length,
    rows: day.rows.map(publicClip), index_sync: sync ? { status: sync.status, finished_at: sync.finished_at, rows_written: sync.rows_written, error_code: sync.error_code } : null,
  };
}

type IndexRowT = NonNullable<Awaited<ReturnType<typeof getIndexRow>>>;
type ResultRowT = Awaited<ReturnType<typeof listResults>>[number];

/**
 * THE ONE HEAD. Our own stored results and the palimpsest's tracks (palimpsestAsResult) both go through this function, so the key sets are identical by construction; `source` says which it was
 * ("scribe_sarvam" for a job of ours, "palimpsest" for a reused track). tests/unit/consult-index-pg.test.ts compares the two field by field.
 */
function resultHead(hit: ResultRowT & { source?: string }, row: IndexRowT, others: string[]): Row {
  return {
    ok: true, consult_uid: hit.consult_uid, source: hit.source ?? "scribe_sarvam", cut_version: hit.cut_version, current_cut_version: row.cut_version, stale: hit.cut_version !== row.cut_version, mode: hit.mode, english: hit.english,
    job_id: hit.job_id || null, model_stt: hit.model_stt, model_translate: hit.model_translate, model_rev: hit.model_rev, pipeline_rev: hit.pipeline_rev, language_code: hit.language_code, duration_s: hit.duration_s,
    speakers: hit.speaker_count, transcript_chars: hit.transcript_chars, english_chars: hit.english_chars, english_pass: hit.english_pass, clip: { t0_ms: hit.t0_ms, t1_ms: row.t1_ms },
    created_at: hit.created_at || null, other_cuts: others,
  };
}

/**
 * No result of our own for this consult: the palimpsest's Sarvam track of THIS cut, in the normal result shape (palimpsestAsResult + resultHead + consultResultView), labelled source palimpsest.
 * If the lookup cannot be made the answer says so (reuse_lookup_unavailable); it is never "no result". A track the index lists but whose object is gone is track_missing.
 */
async function palimpsestResult(uid: string, row: IndexRowT, withText: boolean): Promise<Row> {
  const r = await findSarvamTracks(row.consult_uid, row.room_id, row.room_slug, row.cut_version, signatureVersion);
  if ("unavailable" in r) return { ok: false, error: "reuse_lookup_unavailable" };
  if (r.found?.stt) {
    const v = palimpsestAsResult(row, r.found.stt, r.found.translate);
    const head = { ...resultHead(v.result, row, []), billed: false };
    return withText ? { ...head, ...consultResultView(v.doc, row.t0_ms) } : head;
  }
  if (r.missing.includes("stt")) return { ok: false, error: "track_missing" };
  return { ok: true, consult_uid: uid, result: null, current_cut_version: row.cut_version, note: "no stored result; transcribe it first" };
}

/** consult_result {consult_uid, include_text?}: the stored Sarvam result of a consult (model + revision always; transcript, English and segments with ABSOLUTE UTC times only with include_text). No Sarvam call. */
async function consultResult(args: ToolArgs): Promise<Row> {
  const uid = argStr(args, "consult_uid", 128);
  if (!uid || !UID_OK.test(uid)) return { ok: false, error: "consult_uid_invalid" };
  const row = await getIndexRow(uid);
  if (!row) return { ok: false, error: "consult_not_indexed" };
  const results = await listResults(uid);
  const hit = results.find((r) => r.cut_version === row.cut_version) ?? results[0];
  if (!hit) return palimpsestResult(uid, row, argBool(args, "include_text"));
  const head = resultHead(hit, row, results.filter((r) => r !== hit).map((r) => r.cut_version));
  if (!argBool(args, "include_text")) return head;
  let doc;
  try { doc = await readJson<import("@/lib/jobs/kinds/sarvam-common").ResultDoc>(hit.result_r2_key); } catch { return { ...head, content: null, content_note: "r2_read_failed" }; }
  if (!doc) return { ...head, content: null, content_note: "no_stored_text" };
  return { ...head, ...consultResultView(doc, hit.t0_ms) };
}

async function loadSarvamJob(args: ToolArgs): Promise<{ job: NonNullable<Awaited<ReturnType<typeof readJob>>> } | { error: Row }> {
  const id = argStr(args, "job_id", 128);
  if (!id) return { error: { ok: false, error: "job_id_required" } };
  const job = await readJob(id);
  if (!job) return { error: { ok: false, error: "unknown_job", job_id: id } };
  if (!(SARVAM_KINDS as readonly string[]).includes(job.kind)) return { error: { ok: false, error: "not_a_sarvam_job", job_id: id, kind: job.kind } };
  return { job };
}

/** progress with the Sarvam job id, the clip key and the output names left out: counts and times only */
const SAFE_PROGRESS = ["duration_ms", "piece_count", "clip_kind", "source_kind", "total_entries", "remaining_entries", "chunks_total", "chunks_done", "chars_in", "column", "language_code"] as const;
const safeProgress = (p: Row | null | undefined): Row => Object.fromEntries(SAFE_PROGRESS.filter((k) => p && p[k] !== undefined).map((k) => [k, (p as Row)[k]]));

function jobSummary(j: NonNullable<Awaited<ReturnType<typeof readJob>>>): Row {
  return {
    job_id: j.id,
    kind: j.kind,
    status: j.status,
    step: j.step,
    attempts: j.attempts,
    failures: j.failures,
    error_code: errorCodeOf(j.error),
    progress: safeProgress(j.progress as Row | null),
    created_at: j.created_at,
    started_at: j.started_at,
    finished_at: j.finished_at,
  };
}

async function section(fn: () => Promise<Row>): Promise<Row> {
  try {
    return await fn();
  } catch (e) {
    const why = notCollectedReason(e);
    if (why) return { not_collected: true, reason: why };
    return { ok: false, error: String((e as Error)?.message ?? e).slice(0, 160) };
  }
}

async function usage(args: ToolArgs): Promise<Row> {
  const day = argStr(args, "ist_date", 10);
  let fromIso: string;
  let toIso: string;
  const clamp: Row = {};
  if (day) {
    if (!isRealDate(day)) return { ok: false, error: "invalid_ist_date" };
    const lo = Date.parse(`${day}T00:00:00+05:30`);
    fromIso = new Date(lo).toISOString();
    toIso = new Date(lo + 86_400_000).toISOString();
  } else {
    const days = argInt(args, "days", USAGE_DAYS_DEFAULT, 1, USAGE_DAYS_MAX);
    const asked = typeof args.days === "number" ? Math.trunc(args.days) : typeof args.days === "string" ? Math.trunc(Number(args.days)) : null;
    if (asked !== null && Number.isFinite(asked) && asked !== days) Object.assign(clamp, { clamped: true, days_applied: days });
    const todayStart = Date.parse(istDayStartIso());
    fromIso = new Date(todayStart - (days - 1) * 86_400_000).toISOString();
    toIso = new Date(todayStart + 86_400_000).toISOString();
  }
  const [perDay, jobs, runs, today] = await Promise.all([
    section(async () => {
      const rows = (await sql`
        SELECT to_char(created_at AT TIME ZONE 'Asia/Kolkata', 'YYYY-MM-DD') AS day, count(*)::int AS calls,
               COALESCE(sum((metadata_json->>'audio_minutes')::numeric), 0)::float8 AS minutes,
               COALESCE(sum((metadata_json->>'estimated_cost_usd')::numeric), 0)::float8 AS est_cost_usd,
               count(metadata_json->>'estimated_cost_usd')::int AS priced_calls
          FROM audit_log
         WHERE action = 'stt.paid_call' AND target_type = 'stt_engine' AND target_id = ${SARVAM_ENGINE}
           AND created_at >= ${fromIso}::timestamptz AND created_at < ${toIso}::timestamptz
         GROUP BY 1 ORDER BY 1 DESC
         LIMIT 40
      `) as Row[];
      return { ok: true, days: rows.map((r) => ({ day: String(r.day), calls: num(r.calls), audio_minutes: round(num(r.minutes) ?? 0, 3), est_cost_usd: round(num(r.est_cost_usd) ?? 0, 5), unpriced_calls: (num(r.calls) ?? 0) - (num(r.priced_calls) ?? 0) })) };
    }),
    section(async () => {
      const rows = (await sql`
        SELECT kind, status, count(*)::int AS n FROM scribe_job
         WHERE kind = ANY(${[...SARVAM_KINDS]}::text[]) AND created_at >= ${fromIso}::timestamptz AND created_at < ${toIso}::timestamptz
         GROUP BY kind, status ORDER BY kind, status LIMIT 40
      `) as Row[];
      return { ok: true, by_kind_status: rows.map((r) => ({ kind: String(r.kind), status: String(r.status), count: num(r.n) })) };
    }),
    section(async () => {
      const rows = (await sql`
        SELECT engine, count(*)::int AS runs, count(*) FILTER (WHERE cost_usd IS NULL)::int AS cost_unreported, count(*) FILTER (WHERE error IS NOT NULL)::int AS errors
          FROM transcription_run
         WHERE engine LIKE 'sarvam%' AND created_at >= ${fromIso}::timestamptz AND created_at < ${toIso}::timestamptz
         GROUP BY engine ORDER BY engine LIMIT 20
      `) as Row[];
      return { ok: true, engines: rows.map((r) => ({ engine: String(r.engine), runs: num(r.runs), cost_unreported: num(r.cost_unreported), errors: num(r.errors) })) };
    }),
    section(async () => ({ ok: true, minutes_today: round(await sarvamMinutesToday(), 3), cap_minutes: SARVAM_DAILY_CAP_MINUTES })),
  ]);
  return { ok: true, from: fromIso, to: toIso, ...clamp, gateway_calls: perDay, jobs, transcription_runs: runs, daily_cap: today };
}

const sarvam: McpTool = {
  name: "scribe_sarvam",
  description:
    "Sarvam speech AI through the Even AWS gateway (saaras:v3 transcription with speaker labels, mayura:v1 translation); Sarvam is zero-data-retention. Reads and writes the job queue and one R2 result object per job; touches no room; " +
    "never writes a clinical table. ONLY ISOLATED CONSULT AUDIO goes to Sarvam (V's standing rule): `action` transcribe takes {encounter_id} (a doctor-recorded encounter; its duration is measured from the audio, max 30 min) or {consult_uid} (a cut clip, resolved by the consult index; refusals consult_not_indexed, consult_sealed, consult_voice_isolated; a result stored for the same cut returns billed:false) or {consult_uids:[<=25]} (one batch job); " +
    "consult_clips {ist_date, room_slug?}; consult_result {consult_uid, include_text?} (model + revision; text and absolute-UTC segments with include_text); options mode transcribe|codemix, english default true, num_speakers 1-6. Any room / session / window argument is refused with scope_consult_only. translate takes {encounter_id} or {transcription_run_id} (the run's subject must be an encounter). " +
    "Both queue a job and need invoke scope. status / result {job_id} (include_text returns the stored JSON: transcript, speaker-labelled entries, English); usage {ist_date | days <= 30}: gateway minutes, estimated cost, calls, Sarvam jobs and runs; " +
    "health: configured env names, lab_store_configured, credential check, STS expiry (Sarvam is not called). " +
    `A daily cap of ${SARVAM_DAILY_CAP_MINUTES} audio minutes applies, counting earlier queued jobs. Results are written to R2 mcp-sarvam/<job_id>.json; the job row carries counts only. Usage is also logged to the shared Sarvam ledger (sarvam.call.v1) and lane file. Times UTC.`,
  scope: "read",
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  inputSchema: {
    type: "object",
    properties: {
      action: { type: "string", enum: [...SARVAM_ACTIONS] },
      job_id: { type: "string" },
      include_text: { type: "boolean" },
      encounter_id: { type: "string" },
      consult_uid: { type: "string" },
      consult_uids: { type: "array", items: { type: "string" } },
      force: { type: "boolean" },
      room_slug: { type: "string" },
      mode: { type: "string", enum: ["transcribe", "codemix"] },
      english: { type: "boolean" },
      num_speakers: { type: "integer", minimum: 1, maximum: 6 },
      transcription_run_id: { type: "string" },
      ist_date: { type: "string" },
      days: { type: "integer", minimum: 1, maximum: USAGE_DAYS_MAX },
    },
    required: ["action"],
    additionalProperties: false,
  },
  handler: async (args: ToolArgs, ctx: ToolContext) => {
    const action = argStr(args, "action", 16) as Action | null;
    if (!action || !SARVAM_ACTIONS.includes(action)) return { ok: false, error: "unknown_action", allowed: [...SARVAM_ACTIONS] };
    switch (action) {
      case "transcribe": return submit(SARVAM_TRANSCRIBE_KIND, args, ctx);
      case "translate": return submit(SARVAM_TRANSLATE_KIND, args, ctx);
      case "status": {
        const got = await loadSarvamJob(args);
        return "error" in got ? got.error : { ok: true, ...jobSummary(got.job) };
      }
      case "result": {
        const got = await loadSarvamJob(args);
        if ("error" in got) return got.error;
        const base = { ok: true, ...jobSummary(got.job), result: got.job.result ?? null };
        if (!argBool(args, "include_text")) return base;
        if (got.job.status !== "done") return { ...base, content: null, content_note: "job_not_done" };
        const r2 = typeof got.job.result?.r2_key === "string" ? (got.job.result.r2_key as string) : resultKey(got.job.id);
        try {
          const content = await readJson<Row>(r2);
          return { ...base, content, ...(content ? {} : { content_note: "no_stored_text" }) };
        } catch {
          return { ...base, content: null, content_note: "r2_read_failed" };
        }
      }
      case "consult_clips": return consultClips(args);
      case "consult_result": return consultResult(args);
      case "usage": return usage(args);
      case "health": return { ok: true, ...(await gatewayHealth()), lab_store_configured: labStoreConfigured() };
    }
  },
};

export const S8_TOOLS: McpTool[] = [sarvam];

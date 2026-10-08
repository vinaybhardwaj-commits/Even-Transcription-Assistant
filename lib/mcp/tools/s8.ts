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
import { ROOM_AUDIO_ARGS, SARVAM_TRANSCRIBE_KIND, parseSarvamTranscribeArgs } from "@/lib/jobs/kinds/sarvam-transcribe";
import { SARVAM_TRANSLATE_KIND, parseSarvamTranslateArgs } from "@/lib/jobs/kinds/sarvam-translate";
import { labStoreConfigured } from "@/lib/sarvam-lab";
import { SARVAM_DAILY_CAP_MINUTES, SARVAM_ENGINE, dailyCapRefusal, istDayStartIso, readJson, resultKey, sarvamMinutesToday } from "@/lib/jobs/kinds/sarvam-common";
import { gatewayConfigured, gatewayHealth } from "@/lib/sarvam-gateway";
import { argBool, argInt, argStr, type McpTool, type ToolArgs, type ToolContext } from "../registry";
import { isRealDate, notCollectedReason } from "./s1";

type Row = Record<string, unknown>;

export const SARVAM_ACTIONS = ["transcribe", "translate", "status", "result", "usage", "health"] as const;
type Action = (typeof SARVAM_ACTIONS)[number];
export const SARVAM_KINDS = [SARVAM_TRANSCRIBE_KIND, SARVAM_TRANSLATE_KIND] as const;
export const USAGE_DAYS_DEFAULT = 7;
export const USAGE_DAYS_MAX = 30;

/** The documented keys, plus the room-audio ones, which are passed on ONLY so the kind can refuse them by name (scope_consult_only). */
const SUBMIT_KEYS = ["encounter_id", "consult_uid", "mode", "english", "num_speakers", "transcription_run_id", ...ROOM_AUDIO_ARGS] as const;
const submitArgs = (args: ToolArgs): Row => Object.fromEntries(SUBMIT_KEYS.filter((k) => args[k] !== undefined && args[k] !== null).map((k) => [k, args[k]]));
const num = (v: unknown): number | null => (v === null || v === undefined || Number.isNaN(Number(v)) ? null : Number(v));
const round = (n: number, d = 4): number => Math.round(n * 10 ** d) / 10 ** d;

async function submit(kind: string, args: ToolArgs, ctx: ToolContext): Promise<Row> {
  const raw = submitArgs(args);
  // 1. validate by the kind's own parser, so a refusal is typed and nothing is queued
  try {
    if (kind === SARVAM_TRANSCRIBE_KIND) {
      const parsed = parseSarvamTranscribeArgs(raw);
      // a consult clip comes from the CONSULT cutter's index, whose resolver is not wired yet
      if (parsed.source === "consult") return { ok: false, error: "consult_index_unavailable" };
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
  try {
    const job = await submitJob({ kind, args: raw, actor: ctx.actor, origin: ctx.origin, scopes: ctx.scopes });
    return { ok: true, job_id: job.id, kind: job.kind, status: job.status };
  } catch (e) {
    if (e instanceof JobArgsError) return { ok: false, error: "bad_args", kind, detail: e.reason };
    if (e instanceof UnknownKindError) return { ok: false, error: "unknown_kind", kind };
    throw e; // ToolScopeError -> the door's 403
  }
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
    "never writes a clinical table. ONLY ISOLATED CONSULT AUDIO goes to Sarvam (V's standing rule): `action` transcribe takes {encounter_id} (a doctor-recorded encounter; its duration is measured from the audio, max 30 min) or {consult_uid} (a clip from the CONSULT cutter; " +
    "answers consult_index_unavailable until that resolver exists); options mode transcribe|codemix, english default true, num_speakers 1-6. Any room / session / window argument is refused with scope_consult_only. translate takes {encounter_id} or {transcription_run_id} (the run's subject must be an encounter). " +
    "Both queue a job and need invoke scope. status / result {job_id} (include_text returns the stored JSON: transcript, speaker-labelled entries, English); usage {ist_date | days <= 30}: gateway minutes, estimated cost, calls, Sarvam jobs and runs; " +
    "health: configured env names, lab_store_configured, credential check, STS expiry (Sarvam is not called). " +
    `A daily cap of ${SARVAM_DAILY_CAP_MINUTES} audio minutes applies, counting earlier queued jobs. Results are written to R2 mcp-sarvam/<job_id>.json; the job row carries counts only. Usage is also logged to the shared Sarvam ledger (sarvam.call.v1) and lane file. Times UTC.`,
  scope: "read",
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  inputSchema: {
    type: "object",
    properties: {
      action: { type: "string", enum: [...SARVAM_ACTIONS] },
      job_id: { type: "string", description: "status / result" },
      include_text: { type: "boolean", description: "result: return the stored JSON" },
      encounter_id: { type: "string", description: "a doctor-recorded encounter" },
      consult_uid: { type: "string", description: "a CONSULT-cutter clip (resolver pending)" },
      mode: { type: "string", enum: ["transcribe", "codemix"] },
      english: { type: "boolean", description: "also translate to English; default true" },
      num_speakers: { type: "integer", minimum: 1, maximum: 6 },
      transcription_run_id: { type: "string", description: "translate" },
      ist_date: { type: "string", description: "usage: YYYY-MM-DD (IST)" },
      days: { type: "integer", minimum: 1, maximum: USAGE_DAYS_MAX, description: "usage; default 7" },
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
      case "usage": return usage(args);
      case "health": return { ok: true, ...(await gatewayHealth()), lab_store_configured: labStoreConfigured() };
    }
  },
};

export const S8_TOOLS: McpTool[] = [sarvam];

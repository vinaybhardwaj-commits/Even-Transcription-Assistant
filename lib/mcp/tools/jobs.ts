/**
 * lib/mcp/tools/jobs.ts — Tier 2 §3's four job tools, plus §-rollout's audit reader.
 *
 * The job tools are deliberately THIN. Everything that decides anything lives in lib/jobs; these
 * validate an argument, call it, and shape the answer — so the same job behaves identically however
 * it was submitted.
 */

import { JOB_STATUSES, type JobStatus } from "@/lib/jobs/types";
import { cancelJob, listJobs, readJob } from "@/lib/jobs/store";
import { JobArgsError, submitJob, UnknownKindError, JOB_KIND_NAMES } from "@/lib/jobs/submit";
import { KIND_BY_NAME } from "@/lib/jobs/kinds";
import { readRecentAudit, AUDIT_ACTIONS_HINT } from "@/lib/jobs/audit-read";
import { argInt, argStr, argBool, failSafe, ToolScopeError, type McpTool, type ToolArgs, type ToolContext } from "../registry";

/** PURE — the row a caller sees. `result` is withheld unless asked for: it can be large. */
function jobView(j: NonNullable<Awaited<ReturnType<typeof readJob>>>, includeResult: boolean) {
  return {
    job_id: j.id,
    kind: j.kind,
    status: j.status,
    step: j.step,
    attempts: j.attempts,
    failures: j.failures,
    progress: j.progress,
    error: j.error,
    actor: j.actor,
    created_at: j.created_at,
    started_at: j.started_at,
    updated_at: j.updated_at,
    finished_at: j.finished_at,
    lease_until: j.lease_until,
    ...(includeResult ? { result: j.result } : {}),
    ...(!includeResult && j.result ? { has_result: true } : {}),
  };
}

const submit: McpTool = {
  name: "scribe_job_submit",
  description:
    "Queue long work and get an id back in under two seconds (Tier 2 §3). kind is one of transcribe_range, stitch, audio_measure, emotion_clip, diarize_clip, stt_fanout, day_manifest; args are validated by the kind at submit, so a job that cannot run is refused here rather than queued. Five of the seven kinds are registered but not yet implemented and will fail with not_implemented — that is 'not yet', not 'unknown kind'. Returns {job_id, kind, status}. Ask scribe_job_status about it; nothing is waited on here.",
  scope: "invoke",
  inputSchema: {
    type: "object",
    properties: {
      kind: { type: "string", enum: JOB_KIND_NAMES, description: "which step machine to run" },
      args: { type: "object", description: "the kind's own arguments; validated at submit" },
    },
    required: ["kind"],
    additionalProperties: false,
  },
  handler: async (args: ToolArgs, ctx: ToolContext) =>
    failSafe({ ok: false }, async () => {
      const kind = argStr(args, "kind", 64) ?? "";
      // Refuter item 4 — EACH KIND CARRIES ITS OWN SCOPE, and submit is the only place that can
      // enforce it. This tool is `invoke` so a read-only token cannot reach it at all today; the
      // check matters the moment a read-scope kind (day_manifest) makes a lower tool scope
      // sensible, and it keeps the rule where the kind declares it rather than in the tool's name.
      const declared = KIND_BY_NAME.get(kind);
      if (declared && !ctx.scopes.has(declared.scope)) {
        throw new ToolScopeError(declared.scope, { kind, kind_scope: declared.scope });
      }
      try {
        const job = await submitJob({
          kind,
          args: (args as Record<string, unknown>).args ?? {},
          // Fix-up (3): the resolved token's actor, so a job row says who asked for it.
          actor: ctx.actor,
          origin: ctx.origin,
        });
        return { ok: true, job_id: job.id, kind: job.kind, status: job.status };
      } catch (e) {
        if (e instanceof UnknownKindError) return { ok: false, error: "unknown_kind", kind, allowed: JOB_KIND_NAMES };
        if (e instanceof JobArgsError) return { ok: false, error: "bad_args", kind, detail: e.reason };
        throw e;
      }
    }),
};

/**
 * Refuter item 2 — links are minted HERE, on demand, and never stored on the row. A key in a result
 * is inert; a presigned URL is a way to fetch the audio, so it is a stronger permission than reading
 * the row and is gated on `invoke`.
 */
async function mintUrls(result: Record<string, unknown> | null): Promise<Array<Record<string, unknown>>> {
  if (!result) return [];
  const { signGetUrl } = await import("@/lib/r2");
  const keys: Array<{ clip_key: string; start?: unknown; end?: unknown }> = [];
  if (typeof result.clip_key === "string") keys.push({ clip_key: result.clip_key });
  if (Array.isArray(result.pieces)) {
    for (const p of result.pieces as Array<Record<string, unknown>>) {
      if (typeof p.clip_key === "string") keys.push({ clip_key: p.clip_key, start: p.start, end: p.end });
    }
  }
  return Promise.all(
    keys.map(async (k) => ({ ...k, url: await signGetUrl({ key: k.clip_key, expiresInSeconds: CLIP_URL_SECONDS }) })),
  );
}

/** An hour, the same window scribe_extract_audio's joined clips use. */
const CLIP_URL_SECONDS = 3600;

const status: McpTool = {
  name: "scribe_job_status",
  description:
    "One job: status (queued|running|done|failed|cancelled), the step it has reached, attempts (claims), failures (steps that threw), progress, error and timings. NEITHER `progress` NOR `result` EVER CARRIES TRANSCRIPT TEXT — a transcription job's result carries a transcription_run_id, character and segment counts and the detected language, and whoever wants the words goes to the run, where identity rules apply. include_result:true adds that pointer set. include_urls:true mints presigned links for the clip keys and REQUIRES invoke scope, because a link fetches audio.",
  scope: "read",
  inputSchema: {
    type: "object",
    properties: {
      job_id: { type: "string" },
      include_result: { type: "boolean", default: false },
      include_urls: { type: "boolean", default: false, description: "mint presigned URLs for the clip keys in the result. REQUIRES invoke scope: a link is a way to fetch the audio, so it is a stronger permission than reading the row." },
    },
    required: ["job_id"],
    additionalProperties: false,
  },
  handler: async (args: ToolArgs, ctx: ToolContext) =>
    failSafe({ ok: false }, async () => {
      const id = argStr(args, "job_id", 64);
      if (!id) return { ok: false, error: "job_id_required" };
      const job = await readJob(id);
      if (!job) return { ok: false, error: "unknown_job", job_id: id };
      const wantUrls = argBool(args, "include_urls");
      if (wantUrls && !ctx.scopes.has("invoke")) {
        throw new ToolScopeError("invoke", { reason: "include_urls mints presigned audio links" });
      }
      const view = jobView(job, argBool(args, "include_result"));
      return { ok: true, ...view, ...(wantUrls ? { urls: await mintUrls(job.result) } : {}) };
    }),
};

const list: McpTool = {
  name: "scribe_job_list",
  description:
    "The job queue, newest first: id, kind, status, step, attempts and timings. Filter by status and/or kind. Results are never included here — ask scribe_job_status for one.",
  scope: "read",
  inputSchema: {
    type: "object",
    properties: {
      status: { type: "string", enum: [...JOB_STATUSES] },
      kind: { type: "string", enum: JOB_KIND_NAMES },
      limit: { type: "integer", minimum: 1, maximum: 200, default: 50 },
    },
    additionalProperties: false,
  },
  handler: async (args: ToolArgs) =>
    failSafe({ jobs: [] as unknown[] }, async () => {
      const s = argStr(args, "status", 16);
      const jobs = await listJobs({
        status: (JOB_STATUSES as readonly string[]).includes(s ?? "") ? (s as JobStatus) : null,
        kind: argStr(args, "kind", 64),
        limit: argInt(args, "limit", 50, 1, 200),
      });
      return { jobs: jobs.map((j) => jobView(j, false)) };
    }),
};

const cancel: McpTool = {
  name: "scribe_job_cancel",
  description:
    "Cancel a queued or running job. A QUEUED job stops immediately. A RUNNING job is honoured at its next step boundary: the step already in flight finishes its work and its outcome is then discarded rather than being torn in half, so nothing is left half-written. A job that is already done, failed or cancelled is left exactly as it is.",
  scope: "write",
  inputSchema: {
    type: "object",
    properties: { job_id: { type: "string" } },
    required: ["job_id"],
    additionalProperties: false,
  },
  handler: async (args: ToolArgs) =>
    failSafe({ ok: false }, async () => {
      const id = argStr(args, "job_id", 64);
      if (!id) return { ok: false, error: "job_id_required" };
      const job = await cancelJob(id);
      if (!job) {
        const existing = await readJob(id);
        return existing
          ? { ok: false, error: "not_cancellable", job_id: id, status: existing.status }
          : { ok: false, error: "unknown_job", job_id: id };
      }
      return { ok: true, job_id: job.id, status: job.status, step: job.step };
    }),
};

/**
 * Slice A's rollout found this gap: §2.2 and §2.3 write audit rows that NOBODY CAN READ. The only
 * routed `SELECT … FROM audit_log` needs an admin cookie, so the one question the rows exist to
 * answer — "did the poll write fail, when, and how often" — could not be asked from an agent shell.
 */
const auditRecent: McpTool = {
  name: "scribe_audit_recent",
  description: `Recent audit_log rows, newest first: action, actor, target and the stored metadata. ${AUDIT_ACTIONS_HINT} Filter by action and/or a since time. Metadata is returned AS STORED — the writers already restrict it to ids, counts and flags — and no free-text field is exposed: there is no query argument and no message body. Read-only.`,
  scope: "read",
  inputSchema: {
    type: "object",
    properties: {
      action: { type: "string", description: "exact action, e.g. install.poll_write_failed" },
      since: { type: "string", description: "ISO time; defaults to the last 24 hours" },
      limit: { type: "integer", minimum: 1, maximum: 200, default: 50 },
    },
    additionalProperties: false,
  },
  handler: async (args: ToolArgs) =>
    failSafe({ rows: [] as unknown[] }, async () => {
      const since = argStr(args, "since", 40);
      return readRecentAudit({
        action: argStr(args, "action", 64),
        since: since && Number.isFinite(Date.parse(since)) ? new Date(Date.parse(since)).toISOString() : null,
        limit: argInt(args, "limit", 50, 1, 200),
      });
    }),
};

export const JOB_TOOLS: McpTool[] = [submit, status, list, cancel, auditRecent];
export { KIND_BY_NAME };

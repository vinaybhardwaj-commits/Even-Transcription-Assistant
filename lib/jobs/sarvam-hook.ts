/**
 * lib/jobs/sarvam-hook.ts — S8A-FIX2. A Sarvam job that the RUNNER ended (it threw three times: failures_exceeded) or that someone CANCELLED never reaches
 * the kind's own terminal step, so it would leave no line in the Sarvam usage ledger. This hook writes that one line: status failed / cancelled,
 * audio_s = the measured seconds if a Sarvam batch was started, else 0 (a text task: audio_s 0, chars = what was sent so far).
 *
 * It does NOTHING for any other kind. It never throws. The ledger append is once-per-job-id, so a job that already wrote its own line (the kind
 * failed it by code, or it finished ok before the cancel arrived) gets no second one.
 */
import { appendLedger, touchLane, type CallLine } from "@/lib/sarvam-lab";
import type { JobRow } from "./types";

const SARVAM_KINDS = ["sarvam_transcribe", "sarvam_translate"] as const;
export const isSarvamKind = (kind: string): boolean => (SARVAM_KINDS as readonly string[]).includes(kind);
const n = (v: unknown): number => (typeof v === "number" ? v : Number(v)) || 0;
const s = (v: unknown): string | null => (typeof v === "string" && v ? v : null);

/** PURE — the ledger line for a job the runner or a cancel ended. */
export function endedLine(job: Pick<JobRow, "id" | "kind" | "args" | "progress" | "created_at">, status: "failed" | "cancelled", nowIso: string): CallLine {
  const p = job.progress ?? {};
  const a = (job.args ?? {}) as Record<string, unknown>;
  const consult = a.source === "consult";
  const scope = p.scope === "consult_clip" || consult ? "consult_clip" : "encounter";
  const ref = s(p.ref) ?? s(a.encounter_id) ?? s(a.consult_uid) ?? (s(a.id) ? (a.kind === "transcription_run" ? `run:${a.id}` : String(a.id)) : "unknown");
  const throttled = p.throttled === true || p.translate_throttled === true;
  const base = { caller: "scribe-mcp", machine: "vercel", route: "gateway", finished_at: nowIso, status, http_status: null, throttled, scope, ref } as const;
  const translating = job.kind === "sarvam_translate" || typeof p.translate_started_at === "string";
  if (translating) {
    return {
      ...base, job_id: job.kind === "sarvam_translate" ? job.id : `${job.id}:translate`, request_id: null, mode: "sync", task: "text_translate", model: "mayura:v1",
      audio_s: 0, chars: n(p.translate_chars), started_at: s(p.translate_started_at) ?? s(p.started_at) ?? job.created_at,
    };
  }
  // G22: the start step persists sarvam_started_ms BEFORE its audit write, so a job ended after audit_write_failed still counts its audio here. (The Sarvam job id alone,
  // set at init, is NOT proof of a start: a job that failed at upload has a request id and was never billed.)
  const started = n(p.sarvam_started_ms) > 0;
  return {
    ...base, job_id: job.id, request_id: s(p.sarvam_job_id), mode: "batch", task: "transcribe", model: "saaras:v3",
    audio_s: started ? Math.round(n(p.duration_ms) / 10) / 100 : 0, started_at: s(p.started_at) ?? job.created_at,
  };
}

/** PURE — S8A4: the line for the ENGLISH pass of a sarvam_transcribe job the runner or a cancel ended, or null when that pass never started at Sarvam. */
export function endedEnLine(job: Pick<JobRow, "id" | "kind" | "args" | "progress" | "created_at">, status: "failed" | "cancelled", nowIso: string): CallLine | null {
  const p = job.progress ?? {};
  if (job.kind !== "sarvam_transcribe" || n(p.en_started_ms) <= 0) return null;
  const base = endedLine(job, status, nowIso);
  return { ...base, job_id: `${job.id}:en`, request_id: s(p.en_sarvam_job_id), task: "translate", audio_s: Math.round(n(p.duration_ms) / 10) / 100, started_at: s(p.en_started_at) ?? base.started_at };
}

/** Write the line (once) and refresh the lane. A no-op for any other kind. Never throws. */
export async function sarvamJobEnded(job: JobRow, status: "failed" | "cancelled"): Promise<void> {
  if (!isSarvamKind(job.kind)) return;
  try {
    const now = new Date().toISOString();
    await appendLedger(endedLine(job, status, now));
    const en = endedEnLine(job, status, now);
    if (en) await appendLedger(en);
    await touchLane({ force: true, excludeJobId: job.id });
  } catch (e) {
    console.warn("[sarvam-lab]", JSON.stringify({ code: "ended_hook_failed", err: (e as { name?: string })?.name ?? "error" }));
  }
}

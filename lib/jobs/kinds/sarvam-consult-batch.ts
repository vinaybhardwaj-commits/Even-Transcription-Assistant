/**
 * lib/jobs/kinds/sarvam-consult-batch.ts — `sarvam_consult_batch`: a list of consult_uids -> ONE job id; progress through scribe_job_status. Reuse, not a second pipeline: for each consult the batch submits
 * an ordinary `sarvam_transcribe` job ({consult_uid, mode, english, num_speakers}) and waits for them, so every consult goes through the same index resolution, the same refusals, the same daily cap, the same
 * gateway code and the same idempotency (a result already stored for the cut version is answered, never re-sent) as a single ask.
 *
 *   fan   per uid, once: index pre-flight (lib/consult-clip.ts). Refused (not indexed / sealed / voice isolated / ...) -> recorded with its code, nothing queued. A cut that already has its result ->
 *         `existing`, nothing queued. Otherwise the child job is submitted (deduped on an open job for the same consult and options).
 *   wait  look at the children, then hold this job back 30 s (delay_s) so the younger children are not starved by an older, always-claimable parent; done when every one is final; fails `consult_batch_timeout` 6 h after the batch was created, with the children left running.
 *
 * Progress and result carry consult_uids, job ids, states and codes ONLY: no text, no clip key, no doctor field.
 */
import { z } from "zod";
import { preflightClip } from "@/lib/consult-clip";
import { errorCodeOf, jobError } from "../errors";
import { readJob } from "../store";
import { JobArgsError, doneWith, failWith, nextStep, type JobKind, type StepContext, type StepOutcome } from "../types";
import { ROOM_AUDIO_ARGS, SARVAM_TRANSCRIBE_KIND } from "./sarvam-transcribe";
import { UID_RE } from "@/lib/consult-index/parse";

export const SARVAM_CONSULT_BATCH_KIND = "sarvam_consult_batch";
export const BATCH_MAX_UIDS = 25;
export const BATCH_DEADLINE_MS = 6 * 3_600_000;
/** Timing knobs (mutable so a test can run the loop without waiting). */
export const batchTiming = { holdS: 30 };

const Args = z.object({
  consult_uids: z.array(z.string().trim().min(1).max(128)).min(1).max(BATCH_MAX_UIDS),
  mode: z.enum(["transcribe", "codemix"]).default("transcribe"),
  english: z.boolean().default(true),
  num_speakers: z.number().int().min(1).max(6).optional(),
}).strict();

export type BatchArgs = { consult_uids: string[]; mode: "transcribe" | "codemix"; english: boolean; num_speakers?: number };

/** PURE. Throws JobArgsError; a room or session argument is scope_consult_only, exactly as for a single ask. */
export function parseBatchArgs(raw: unknown): BatchArgs {
  const o = (raw ?? {}) as Record<string, unknown>;
  const room = ROOM_AUDIO_ARGS.filter((k) => o[k] !== undefined && o[k] !== null);
  if (room.length > 0) throw new JobArgsError(`scope_consult_only: only consult_uids may be sent to Sarvam (not ${room.join(", ")})`);
  const p = Args.safeParse(o);
  if (!p.success) throw new JobArgsError(`bad args: ${p.error.issues[0]?.path.join(".") || "args"} ${p.error.issues[0]?.message ?? ""}`.trim().slice(0, 160));
  const bad = p.data.consult_uids.find((u) => !UID_RE.test(u));
  if (bad !== undefined) throw new JobArgsError("bad args: consult_uids must be plain ids");
  const uids = [...new Set(p.data.consult_uids)];
  return { consult_uids: uids, mode: p.data.mode, english: p.data.english, ...(p.data.num_speakers ? { num_speakers: p.data.num_speakers } : {}) };
}

type Child = { state: "queued" | "existing" | "refused" | "done" | "failed"; job_id?: string; code?: string; source?: "palimpsest" };
type Children = Record<string, Child>;
const FINAL = new Set<Child["state"]>(["existing", "refused", "done", "failed"]);

export const sarvamConsultBatchKind: JobKind = {
  name: SARVAM_CONSULT_BATCH_KIND,
  first: "fan",
  roomData: false,
  roomDataNote: "consult clips only, resolved through consult_index (the held-out rule is lifted, V 10 Oct); each consult is a sarvam_transcribe child job; a room audio argument is refused at parse (scope_consult_only)",
  scope: "invoke",
  parseArgs: (raw) => parseBatchArgs(raw) as unknown as Record<string, unknown>,

  async run(ctx: StepContext): Promise<StepOutcome> {
    const a = ctx.args as unknown as BatchArgs;
    switch (ctx.step) {
      case "fan": return fan(ctx, a);
      case "wait": return wait(ctx, a);
      default: return failWith(jobError("unknown_step", ctx.step));
    }
  },
};

async function fan(ctx: StepContext, a: BatchArgs): Promise<StepOutcome> {
  const children: Children = { ...((ctx.progress.children as Children | undefined) ?? {}) };
  for (const uid of a.consult_uids) {
    if (children[uid]) continue; // a replayed claim never queues a consult twice
    const pre = await preflightClip(uid, { mode: a.mode, english: a.english });
    if (!pre.ok) { children[uid] = { state: "refused", code: pre.error }; continue; }
    if (pre.existing) { children[uid] = { state: "existing", job_id: pre.existing.job_id }; continue; }
    if (pre.reuse) { children[uid] = { state: "existing", source: "palimpsest" }; continue; }
    const { submitJob } = await import("../submit"); // lazy: submit imports the kind registry, which imports this file
    const job = await submitJob({
      kind: SARVAM_TRANSCRIBE_KIND, args: { consult_uid: uid, mode: a.mode, english: a.english, ...(a.num_speakers ? { num_speakers: a.num_speakers } : {}) },
      actor: ctx.job.actor ?? "sarvam_consult_batch", scopes: new Set(["invoke"] as const),
    });
    children[uid] = { state: "queued", job_id: job.id };
  }
  return nextStep("wait", { ...ctx.progress, children });
}

async function wait(ctx: StepContext, a: BatchArgs): Promise<StepOutcome> {
  const children: Children = { ...((ctx.progress.children as Children | undefined) ?? {}) };
  if (a.consult_uids.some((u) => !children[u])) return failWith(jobError("progress_incomplete", "children"));
  for (const uid of a.consult_uids) {
    const c = children[uid]!;
    if (FINAL.has(c.state) || !c.job_id) continue;
    const j = await readJob(c.job_id);
    if (!j) { children[uid] = { state: "failed", job_id: c.job_id, code: "unknown_job" }; continue; }
    if (j.status === "done") children[uid] = { state: j.result?.existing === true ? "existing" : "done", job_id: c.job_id };
    else if (j.status === "failed" || j.status === "cancelled") children[uid] = { state: "failed", job_id: c.job_id, code: j.status === "cancelled" ? "cancelled" : (errorCodeOf(j.error) ?? "unknown_error") };
  }
  const open = a.consult_uids.filter((u) => !FINAL.has(children[u]!.state));
  if (open.length === 0) {
    const count = (s: Child["state"]) => a.consult_uids.filter((u) => children[u]!.state === s).length;
    return doneWith({
      total: a.consult_uids.length, done: count("done"), existing: count("existing"), refused: count("refused"), failed: count("failed"),
      items: a.consult_uids.map((u) => ({ consult_uid: u, ...children[u]! })),
    });
  }
  if (Date.parse(ctx.job.created_at) + BATCH_DEADLINE_MS < Date.now()) return failWith(jobError("consult_batch_timeout", `${open.length} of ${a.consult_uids.length} unfinished`));
  // The children are YOUNGER than this job and claims are oldest-first, so a parent that is claimable at once would take every slot and starve them: hold it back between looks.
  return nextStep("wait", { ...ctx.progress, children }, batchTiming.holdS);
}

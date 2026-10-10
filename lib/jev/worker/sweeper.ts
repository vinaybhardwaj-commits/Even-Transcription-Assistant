/**
 * lib/jev/worker/sweeper.ts — find subjects with evidence ready and no decision under the current question-set hash, and queue ONE
 * capped jev_ask job per use (PRD §3.2, P1.5). Idempotent: it is the primary trigger because it catches whatever a nudge missed.
 *
 * Flag off (JEV_WORKER_ENABLED, or the use's flag): zero jobs, zero calls, and the cron route reads nothing. Per use it skips, by name,
 * when: the circuit is open, the day's budget is spent (paused until 00:00 IST), no shadow/live set exists, a job for that set is already open,
 * or nothing is pending. NOT BUILT (PROVISIONAL in the PRD): the per-subject "failed 3 times, not before tomorrow" backoff.
 */
import { sql } from "@/lib/db";
import { findOpenJob, insertJob, newJobId } from "@/lib/jobs/store";
import { breakerIsOpen } from "./breaker";
import { dailyCapUsd, askBatch, liveFlagOn, modeGate, REAL_USES, type JevMode, type RealUse } from "./flags";
import { reservationUsd, spentTodayUsd, submitJevAskCapped } from "./budget";
import "./register";   // any entry into the sweeper (the cron route, a nudge) sees every registered use
import { listUses, usesOf, type JevUseDef } from "./uses";

export type SweepSkip = "worker_disabled" | "use_flag_off" | "text_lane_off" | "live_flag_off" | "circuit_open" | "budget_paused" | "no_set" | "open_job" | "nothing_pending" | "cap_would_overshoot";
export type SweepUse = { use: string; enqueued: boolean; skipped?: SweepSkip; job_id?: string; pending?: number; mode?: JevMode };

/** The subjects of `def` that have evidence ready and NO derived decision under this set hash in this mode. */
export async function pendingSubjects(def: JevUseDef, sha: string, mode: JevMode, limit: number): Promise<string[]> {
  const ids = await def.eligible(limit * 4);
  if (ids.length === 0) return [];
  const done = (await sql`
    SELECT subject_id FROM jev_decision
     WHERE question_set_sha256 = ${sha} AND mode = ${mode} AND order_variant = 'derived' AND subject_type = ${def.subjectType}
       AND subject_id = ANY(${ids}::text[])`) as Array<{ subject_id: string }>;
  const have = new Set(done.map((r) => r.subject_id));
  return ids.filter((i) => !have.has(i)).slice(0, limit);
}

/** The set a use's sweep asks: its LIVE set, else its SHADOW set (newest first). */
export async function currentSet(use: string, setId?: string): Promise<{ id: string; version: string; sha: string; status: string } | null> {
  const rows = (await sql`
    SELECT id, version, content_sha256, status FROM jev_question_set
     WHERE use = ${use} AND (${setId ?? null}::text IS NULL OR id = ${setId ?? null}) AND status IN ('live', 'shadow') ORDER BY (status = 'live') DESC, created_at DESC LIMIT 1`) as Array<{ id: string; version: string; content_sha256: string; status: string }>;
  return rows[0] ? { id: rows[0].id, version: rows[0].version, sha: rows[0].content_sha256, status: rows[0].status } : null;
}

export async function sweepUse(def: JevUseDef, actor = "cron:jev_sweep"): Promise<SweepUse> {
  const use = def.use as RealUse;
  const gate = modeGate(use, "shadow");
  if (!gate.ok) return { use, enqueued: false, skipped: gate.reason === "live_flag_off" ? "use_flag_off" : gate.reason };
  if (await breakerIsOpen(use)) return { use, enqueued: false, skipped: "circuit_open" };
  if ((await spentTodayUsd()) >= dailyCapUsd()) return { use, enqueued: false, skipped: "budget_paused" };
  const set = await currentSet(use, def.setId);
  if (!set) return { use, enqueued: false, skipped: "no_set" };
  const mode: JevMode = set.status === "live" && liveFlagOn(use) ? "live" : "shadow";
  const open = await findOpenJob("jev_ask", [["use", use], ["mode", mode], ["set_id", set.id], ["version", set.version], ["subjects_key", "sweep"]]);
  if (open) return { use, enqueued: false, skipped: "open_job", job_id: open.id, mode };
  const pending = await pendingSubjects(def, set.sha, mode, askBatch());
  if (pending.length === 0) return { use, enqueued: false, skipped: "nothing_pending", pending: 0, mode };
  const reserve = pending.length * reservationUsd(8_000, 2_000) * 2;
  const job = await submitJevAskCapped({ use, mode, set_id: set.id, version: set.version, subjects_key: "sweep" }, actor, reserve);
  if (!job) return { use, enqueued: false, skipped: "cap_would_overshoot", pending: pending.length, mode };
  return { use, enqueued: true, job_id: job.id, pending: pending.length, mode };
}

/** Yesterday's drift report, once per use per IST day (a job of any status for that date counts as done). */
export async function enqueueDriftIfDue(now = new Date()): Promise<string[]> {
  const yesterday = new Date(now.getTime() + 330 * 60_000 - 86_400_000).toISOString().slice(0, 10);
  const out: string[] = [];
  for (const use of REAL_USES) {
    if (usesOf(use).length === 0) continue;
    const have = (await sql`SELECT 1 FROM scribe_job WHERE kind = 'jev_drift' AND args->>'use' = ${use} AND args->>'ist_date' = ${yesterday} LIMIT 1`) as unknown[];
    if (have.length) continue;
    await insertJob({ id: newJobId(), kind: "jev_drift", args: { use, ist_date: yesterday }, actor: "cron:jev_sweep" });
    out.push(use);
  }
  return out;
}

export async function sweepJev(): Promise<{ uses: SweepUse[]; drift_enqueued: string[] }> {
  const uses: SweepUse[] = [];
  for (const def of listUses()) uses.push(await sweepUse(def));
  const anyOn = uses.some((u) => u.skipped !== "worker_disabled");
  return { uses, drift_enqueued: anyOn ? await enqueueDriftIfDue() : [] };
}

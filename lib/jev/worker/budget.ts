/**
 * lib/jev/worker/budget.ts — the daily spend cap (PRD §10), enforced at SUBMIT and at EVERY STEP.
 *
 *   JEV_DAILY_USD_CAP (default $5, hard) and JEV_DAILY_USD_SOFT ($2, warn), per IST day.
 *   SUBMIT:  `submitJevAskCapped` is ONE transaction behind an advisory lock: spent today (jev_call) + what queued/running jev_ask
 *            jobs have reserved + this job's reservation must fit under the cap, else nothing is inserted. Three concurrent
 *            submits therefore cannot overshoot: the second statement takes a fresh snapshot AFTER the lock, so it sees the
 *            first's insert.
 *   STEP:    `budgetCheck` before every call: spent today + this call's reservation. Over the cap the job ends budget_exceeded
 *            (resumes next IST day), and the sweeper pauses that use until 00:00 IST.
 * Cost is input tokens x $0.042/M (lib/jev/counters.ts); output is not billed.
 */
import { sql } from "@/lib/db";
import { JEV_INPUT_TOKEN_COST_USD } from "../counters";
import { dailyCapUsd, dailySoftUsd } from "./flags";
import { newJobId } from "@/lib/jobs/store";

export const JEV_SUBMIT_LOCK_KEY = 7_102_026_055;
export const JEV_ASK_KIND = "jev_ask";

export const costUsd = (inputTokens: number): number => Math.round(inputTokens * JEV_INPUT_TOKEN_COST_USD * 1e8) / 1e8;
/** ~4 chars a token, plus the question text the call carries. A reservation, not a measurement: the ledger records the real tokens. */
export const estimateTokens = (stateBytes: number, questionChars: number): number => Math.max(1, Math.ceil((stateBytes + questionChars) / 4));
export const reservationUsd = (stateBytes: number, questionChars: number): number => costUsd(estimateTokens(stateBytes, questionChars));

const n = (v: unknown): number => (typeof v === "number" ? v : Number(v ?? 0));

/** USD spent so far this IST day, optionally for one use. */
export async function spentTodayUsd(use?: string): Promise<number> {
  const rows = (await sql`
    SELECT coalesce(sum(cost_usd), 0) AS usd FROM jev_call
     WHERE created_at >= (date_trunc('day', now() AT TIME ZONE 'Asia/Kolkata') AT TIME ZONE 'Asia/Kolkata')
       AND (${use ?? null}::text IS NULL OR use = ${use ?? null}::text)`) as Array<{ usd: unknown }>;
  return n(rows[0]?.usd);
}

export type BudgetVerdict = { ok: boolean; spent: number; cap: number; soft: number; soft_exceeded: boolean; left: number };

export function judgeBudget(spent: number, reserve: number, cap = dailyCapUsd(), soft = dailySoftUsd()): BudgetVerdict {
  return { ok: spent + reserve <= cap, spent, cap, soft, soft_exceeded: spent + reserve > soft, left: Math.max(0, cap - spent) };
}

export async function budgetCheck(reserve: number): Promise<BudgetVerdict> {
  return judgeBudget(await spentTodayUsd(), reserve);
}

/** The capped insert of a jev_ask job. Returns null when the job would break the day's cap (nothing was inserted). */
export async function submitJevAskCapped(args: Record<string, unknown>, actor: string | null, reserveUsd: number, cap = dailyCapUsd()): Promise<{ id: string } | null> {
  const id = newJobId();
  const withReserve = { ...args, reserve_usd: reserveUsd };
  const results = (await sql.transaction([
    sql`SELECT pg_advisory_xact_lock(${JEV_SUBMIT_LOCK_KEY}::bigint)`,
    sql`
      INSERT INTO scribe_job (id, kind, args, actor)
      SELECT ${id}, ${JEV_ASK_KIND}, ${JSON.stringify(withReserve)}::jsonb, ${actor}
       WHERE (
         (SELECT coalesce(sum(cost_usd), 0) FROM jev_call WHERE created_at >= (date_trunc('day', now() AT TIME ZONE 'Asia/Kolkata') AT TIME ZONE 'Asia/Kolkata'))
         + (SELECT coalesce(sum(CASE WHEN (args->>'reserve_usd') ~ '^[0-9]+(\\.[0-9]+)?$' THEN (args->>'reserve_usd')::numeric ELSE 0 END), 0)
              FROM scribe_job WHERE kind = ${JEV_ASK_KIND} AND status IN ('queued', 'running'))
         + ${reserveUsd}::numeric
       ) <= ${cap}::numeric
      RETURNING id`,
  ])) as unknown as Array<Array<{ id: string }>>;
  return results[1]?.[0] ?? null;
}

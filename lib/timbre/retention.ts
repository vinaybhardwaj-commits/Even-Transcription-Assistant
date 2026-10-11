/**
 * lib/timbre/retention.ts — 36-month retention for EVERY Timbre table (Vinay's ruling, 11 Oct 2026; replaces the 24-month
 * window and the 90-day superseded-run purge). Windows and consult summaries are treated the same.
 *
 * Age is the DATA's age where the row has one, else the row's own time:
 *   affect_window   whose consult's ist_date (same run/consult/cut) is older than 36 months, or whose own abs_start_ms is
 *   affect_consult  ist_date older than 36 months
 *   affect_run      started_at older than 36 months (its windows / consults go with it: ON DELETE CASCADE)
 *   affect_calibration_map  created_at older than 36 months AND referenced by no remaining run
 * The cutoff is computed in SQL from current_date (IST is not needed at month resolution). Batches of 5000 until a batch
 * deletes nothing or the budget is spent. Switch: TIMBRE_RETENTION=0 turns it off (default on). Deletes affect_* rows only.
 */
import { sql } from "@/lib/db";

export const TIMBRE_RETENTION_MONTHS = 36;
export const TIMBRE_RETENTION_ENV = "TIMBRE_RETENTION";
const BATCH = 5000;

export type TimbreRetentionResult = { enabled: boolean; windows: number; consults: number; runs: number; calibration_maps: number; budget_hit: boolean };

export function timbreRetentionEnabled(env: Record<string, string | undefined> = process.env): boolean {
  const v = (env[TIMBRE_RETENTION_ENV] ?? "").trim().toLowerCase();
  return !(v === "0" || v === "false" || v === "off" || v === "no");
}

type Step = () => Promise<number>;

export async function purgeTimbre(opts: { budgetMs?: number; now?: () => number; env?: Record<string, string | undefined> } = {}): Promise<TimbreRetentionResult> {
  const out: TimbreRetentionResult = { enabled: timbreRetentionEnabled(opts.env), windows: 0, consults: 0, runs: 0, calibration_maps: 0, budget_hit: false };
  if (!out.enabled) return out;
  const now = opts.now ?? Date.now;
  const start = now();
  const budget = opts.budgetMs ?? 20_000;
  const months = TIMBRE_RETENTION_MONTHS;
  const steps: Array<[keyof Omit<TimbreRetentionResult, "enabled" | "budget_hit">, Step]> = [
    ["windows", async () => ((await sql`
      DELETE FROM affect_window WHERE ctid IN (
        SELECT w.ctid FROM affect_window w
          LEFT JOIN affect_consult c ON c.run_id = w.run_id AND c.consult_uid = w.consult_uid AND c.cut_version = w.cut_version
         WHERE c.ist_date < (current_date - make_interval(months => ${months}::int))
            OR (w.abs_start_ms IS NOT NULL AND w.abs_start_ms < (extract(epoch FROM (current_date - make_interval(months => ${months}::int))) * 1000)::bigint)
         LIMIT ${BATCH}::int)
      RETURNING 1`) as unknown[]).length],
    ["consults", async () => ((await sql`
      DELETE FROM affect_consult WHERE ctid IN (
        SELECT ctid FROM affect_consult WHERE ist_date < (current_date - make_interval(months => ${months}::int)) LIMIT ${BATCH}::int)
      RETURNING 1`) as unknown[]).length],
    ["runs", async () => ((await sql`
      DELETE FROM affect_run WHERE id IN (
        SELECT id FROM affect_run WHERE started_at < (current_date - make_interval(months => ${months}::int)) ORDER BY id LIMIT 50)
      RETURNING 1`) as unknown[]).length],
    ["calibration_maps", async () => ((await sql`
      DELETE FROM affect_calibration_map m
       WHERE m.created_at < (current_date - make_interval(months => ${months}::int))
         AND NOT EXISTS (SELECT 1 FROM affect_run r WHERE r.calibration_arousal_id = m.id OR r.calibration_valence_id = m.id)
      RETURNING 1`) as unknown[]).length],
  ];
  for (const [key, step] of steps) {
    for (;;) {
      if (now() - start >= budget) { out.budget_hit = true; return out; }
      const n = await step();
      out[key] += n;
      if (n === 0 || key === "calibration_maps") break;
    }
  }
  return out;
}

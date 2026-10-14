import type { Sql } from '../../db/sql.js'
import { chargeBudget, setBudgetMax } from '../../llm/ledger.js'
import { ClefBudgetError } from './wav.js'

export const CLEF_BUDGET_ID = 'clef'
export const DEFAULT_CLEF_BUDGET_MAX = 1000
export const USD_PER_MILLION_INPUT_TOKENS = 0.15

/** Recorded, not trusted for billing. */
export function inputCostUsd(inputTokens: number): number {
  return (inputTokens * USD_PER_MILLION_INPUT_TOKENS) / 1_000_000
}

export function budgetMaxFromEnv(raw: string | undefined): number {
  if (raw === undefined || raw.trim() === '') return DEFAULT_CLEF_BUDGET_MAX
  const n = Number(raw)
  if (!Number.isInteger(n) || n < 0) throw new ClefBudgetError('CLEF_BUDGET_MAX must be a non-negative integer')
  return n
}

/**
 * Creates the 'clef' row when absent (no migration), then sets its max. An existing row is left alone,
 * so operator edits and the used count survive a restart. setBudgetMax is an UPDATE, so it cannot create the row.
 */
export async function ensureClefBudget(sql: Sql, maxCalls: number): Promise<void> {
  const rows = await sql.query<{ id: string }>('insert into call_budgets (id, calls_used, max_calls) values ($1, 0, $2) on conflict (id) do nothing returning id', [
    CLEF_BUDGET_ID,
    maxCalls,
  ])
  if (rows.rows.length === 0) return
  await setBudgetMax(sql, CLEF_BUDGET_ID, maxCalls)
}

/** Charges one call. Throws ClefBudgetError when the row has no headroom. */
export async function chargeClef(sql: Sql): Promise<void> {
  const charge = await chargeBudget(sql, CLEF_BUDGET_ID)
  if (!charge.ok) throw new ClefBudgetError('clef budget exhausted')
}

import type { Sql } from '../../db/sql.js'
import type { AgentBudget } from './types.js'

export type BudgetKind = 'llm' | 'jev' | 'clef'

/** Per-run, per-trace counter. The global `call_budgets` ledger still applies underneath. */
export class RunBudget {
  private used: Record<BudgetKind, number> = { llm: 0, jev: 0, clef: 0 }
  private readonly caps: Record<BudgetKind, number>

  constructor(budget: AgentBudget) {
    this.caps = { llm: budget.llmCalls, jev: budget.jevCalls, clef: budget.clefCalls ?? 0 }
  }

  /** Takes one call. False means the per-run cap would be exceeded. */
  take(kind: BudgetKind): boolean {
    if (this.used[kind] >= this.caps[kind]) return false
    this.used[kind] += 1
    return true
  }

  snapshot(): Record<BudgetKind, number> {
    return { ...this.used }
  }
}

/** Reads the global ledger without charging. False when a ledger row has no headroom. */
export async function ledgerHasHeadroom(sql: Sql, ids: Array<'llm' | 'jev'>): Promise<boolean> {
  for (const id of ids) {
    const rows = await sql.query<{ calls_used: number | string; max_calls: number | string }>(
      'select calls_used, max_calls from call_budgets where id = $1',
      [id],
    )
    const row = rows.rows[0]
    if (!row) continue
    if (Number(row.calls_used) >= Number(row.max_calls)) return false
  }
  return true
}

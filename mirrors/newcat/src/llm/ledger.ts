import { asNumber, type Sql } from '../db/sql.js'
import { newId } from '../ids.js'

export async function chargeBudget(sql: Sql, budgetId: string): Promise<{ ok: true; callsUsed: number } | { ok: false }> {
  const rows = await sql.query<{ calls_used: number | string }>(
    `update call_budgets set calls_used = calls_used + 1
     where id = $1 and calls_used < max_calls
     returning calls_used`,
    [budgetId],
  )
  const used = rows.rows[0]?.calls_used
  if (used === undefined) return { ok: false }
  return { ok: true, callsUsed: Number(used) }
}

export interface ModelCallDraft {
  traceId: string
  provider: 'bedrock' | 'typesafe' | 'fake' | 'cloudflare'
  tier: string
  intendedModelId: string
  servedModelId: string | null
  inputTokens: number | null
  outputTokens: number | null
  latencyMs: number | null
  costUsd: number | null
  status: 'ok' | 'unavailable' | 'truncated' | 'refused' | 'failed'
  stopReason: string | null
  errorType: string | null
  purpose: string
}

export async function recordModelCall(sql: Sql, draft: ModelCallDraft): Promise<string> {
  const id = newId()
  await sql.query(
    `insert into model_calls (
       id, trace_id, provider, tier, intended_model_id, served_model_id,
       input_tokens, output_tokens, latency_ms, cost_usd, status, stop_reason, error_type, purpose
     ) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`,
    [
      id,
      draft.traceId,
      draft.provider,
      draft.tier,
      draft.intendedModelId,
      draft.servedModelId,
      draft.inputTokens,
      draft.outputTokens,
      draft.latencyMs,
      draft.costUsd,
      draft.status,
      draft.stopReason,
      draft.errorType,
      draft.purpose,
    ],
  )
  return id
}

export async function countModelCalls(sql: Sql): Promise<number> {
  const rows = await sql.query<{ n: number | string }>('select count(*)::int as n from model_calls')
  return Number(rows.rows[0]?.n ?? 0)
}

export async function costForTrace(sql: Sql, traceId: string): Promise<number> {
  const rows = await sql.query<{ cost: string | number | null }>('select coalesce(sum(cost_usd), 0) as cost from model_calls where trace_id = $1', [
    traceId,
  ])
  return asNumber(rows.rows[0]?.cost ?? 0)
}

export async function setBudgetMax(sql: Sql, budgetId: string, maxCalls: number): Promise<void> {
  await sql.query('update call_budgets set max_calls = $2 where id = $1', [budgetId, maxCalls])
}

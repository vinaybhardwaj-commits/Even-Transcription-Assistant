import type { Env } from '../../../config.js'
import type { Sql } from '../../../db/sql.js'
import { geminiConfig, vertexSender, type GeminiConfig, type GeminiSender } from '../../../llm/gemini.js'
import { geminiSecondJudge } from '../../../platform/judge/gemini-second.js'
import type { SecondJudge } from '../../../platform/judge/second.js'

/**
 * The offline runner's second judge (spec section 14, S3): the platform's Gemini second judge, built the way
 * platform/agent/define.ts builds it (defaultWiring.second): only when NEWCAT_GEMINI=live and the Vertex config is complete
 * and on the allowlist. Anything else is null and every finding holds (judge_unavailable); never a substitute model.
 * `sender` is for tests (a fake); live runs use vertexSender over VERTEX_SA_KEY_JSON. Nothing here prints env values or keys.
 */
export function geminiConfigOf(env: Env): GeminiConfig | null {
  return env.NEWCAT_GEMINI === 'live' ? geminiConfig(env) : null
}

export function makeSecondJudge(env: Env, sql: Sql, traceId: string, sender?: GeminiSender): SecondJudge | null {
  const config = geminiConfigOf(env)
  if (!config) return null
  try {
    return geminiSecondJudge({ sql, config, sender: sender ?? vertexSender(config.keyJson), traceId })
  } catch {
    return null
  }
}

/** The per-consult factory the batch wiring takes. Null when Gemini is not usable (decided once, from env). */
export type SecondFactory = (traceId: string, sql: Sql) => SecondJudge | null

export function secondFactory(env: Env, sender?: GeminiSender): SecondFactory {
  const config = geminiConfigOf(env)
  if (!config) return () => null
  // One sender (one GoogleAuth, one cached token) for the whole run, not one per consult.
  let shared: GeminiSender
  try {
    shared = sender ?? vertexSender(config.keyJson)
  } catch {
    return () => null
  }
  return (traceId, sql) => makeSecondJudge(env, sql, traceId, shared)
}

/** Env NAMES (never values) NEWCAT_GEMINI=live still needs; empty when the config resolves or Gemini is not asked for. */
export function missingGeminiEnv(env: Env): string[] {
  if (env.NEWCAT_GEMINI !== 'live') return []
  const missing: string[] = []
  if (!env.GEMINI_MODEL) missing.push('GEMINI_MODEL')
  if (!env.VERTEX_PROJECT) missing.push('VERTEX_PROJECT')
  if (!env.VERTEX_LOCATION) missing.push('VERTEX_LOCATION')
  if (!env.VERTEX_SA_KEY_JSON) missing.push('VERTEX_SA_KEY_JSON')
  if (missing.length === 0 && geminiConfig(env) === null) missing.push('GEMINI_MODEL/VERTEX_PROJECT/VERTEX_LOCATION (unusable: allowlist, region or name)')
  return missing
}

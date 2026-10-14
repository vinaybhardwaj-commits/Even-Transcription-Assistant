import { ZodObject } from 'zod'
import { jevReadiness } from '../../config.js'
import { jevJudge } from '../jev/judge.js'
import type { Capability, CapabilityContext } from '../../api/registry.js'
import type { SecondJudge } from '../judge/second.js'
import { unavailableJudge, type JudgePort } from './judge-port.js'
import { isIdentifierKey } from '../../audience/serialize.js'
import { runAgent } from './run.js'
import type { AgentDefinition, AnyAgentDefinition } from './types.js'

/** How an agent gets its judges for one request. */
export interface AgentWiring {
  judge(ctx: CapabilityContext): JudgePort
  second(ctx: CapabilityContext): SecondJudge | null
}

/**
 * The judge is the F1 adapter over ctx.jev. When Jev is not ready (jevReadiness 'unavailable') every
 * judge is unavailable, so a registered agent holds its findings instead of guessing.
 */
export const defaultWiring: AgentWiring = {
  judge: (ctx) =>
    jevReadiness(ctx.env) === 'unavailable'
      ? unavailableJudge
      : jevJudge({ transport: ctx.jev, traceId: ctx.traceId, purpose: 'agent_judge' }),
  second: () => null,
}

const META_KEY = /^[a-z][a-z0-9_]{0,63}$/
const REASON = /^[a-z][a-z0-9_]*$/
/** Names that would collide with Object.prototype if a reason ever became a plain-object key. */
const PROTOTYPE_NAMES = new Set(['constructor', '__proto__', 'prototype', 'tostring', 'hasownproperty', 'valueof', 'tolocalestring', 'isprototypeof', 'propertyisenumerable'])

/** Fails fast on a definition that breaks a template rule. */
export function validateDefinition(def: AnyAgentDefinition): void {
  const fail = (message: string): never => {
    throw new Error(`agent ${def.id}: ${message}`)
  }
  if (!/^[a-z][a-z0-9]*(\.[a-z][a-z0-9_-]*)+$/.test(def.id)) fail('id must look like "audit.consult"')
  if (def.modes.length === 0) fail('modes is empty')
  if (def.audiences.length === 0) fail('audiences is empty')
  if (def.doctorVisible === 'never' && def.audiences.includes('doctor')) fail("doctorVisible 'never' cannot list the doctor audience")
  if (def.input instanceof ZodObject && def.input._def.unknownKeys !== 'strict') fail('input schema must be strict')
  for (const reason of [...def.abstention.reasons, ...def.abstention.emptyReasons]) {
    if (!REASON.test(reason)) fail('reasons must be snake_case identifiers')
  }
  const countReasons = def.countReasons ?? []
  for (const reason of countReasons) {
    if (!REASON.test(reason)) fail('countReasons must be snake_case identifiers')
    if (PROTOTYPE_NAMES.has(reason.toLowerCase())) fail('countReasons cannot use an Object.prototype name')
  }
  if (new Set(countReasons).size !== countReasons.length) fail('countReasons must be unique')
  const metaKeys = def.metaKeys ?? []
  for (const key of metaKeys) {
    if (!META_KEY.test(key)) fail('metaKeys must be snake_case slugs')
    if (isIdentifierKey(key)) fail('metaKeys cannot use an identifier-like name')
    if (PROTOTYPE_NAMES.has(key)) fail('metaKeys cannot use an Object.prototype name')
  }
  if (new Set(metaKeys).size !== metaKeys.length) fail('metaKeys must be unique')
  const { safety, nonSafety } = def.judge.thresholds
  if (!(safety > 0 && safety <= 1 && nonSafety > 0 && nonSafety <= 1)) fail('thresholds must be in (0, 1]')
  const ruleIds = def.rules.map((rule) => rule.id)
  if (new Set(ruleIds).size !== ruleIds.length) fail('rule ids must be unique')
  for (const [ruleId, set] of Object.entries(def.judge.questionSets ?? {})) {
    if (!ruleIds.includes(ruleId)) fail(`questionSets names an unknown rule: ${ruleId}`)
    if (!set.id || !set.sha || !set.question) fail(`questionSets entry for ${ruleId} is incomplete`)
  }
  if (def.audiences.includes('governance') && !def.serializers?.governance) fail('audiences lists governance without serializers.governance')
  if (def.budget.llmCalls < 0 || def.budget.jevCalls < 0) fail('budget caps cannot be negative')
}

export function toCapability(def: AnyAgentDefinition, wiring: AgentWiring = defaultWiring): Capability {
  validateDefinition(def)
  return {
    id: def.id,
    version: def.version,
    summary: def.summary,
    modes: def.modes,
    requiredScopes: [def.id],
    audiences: def.audiences,
    input: def.input,
    output: def.output,
    serializers: def.serializers,
    run: (ctx, input) =>
      runAgent(
        def,
        {
          sql: ctx.sql,
          models: ctx.models,
          traceId: ctx.traceId,
          ...(ctx.idempotencyKey !== undefined ? { idempotencyKey: ctx.idempotencyKey } : {}),
          purpose: ctx.purpose,
          audience: ctx.audience,
          judge: wiring.judge(ctx),
          second: wiring.second(ctx),
        },
        input,
      ),
  }
}

/** Validates the definition and returns the capability it becomes. */
export function defineAgent<I, F>(def: AgentDefinition<I, F>, wiring: AgentWiring = defaultWiring): Capability {
  return toCapability(def, wiring)
}

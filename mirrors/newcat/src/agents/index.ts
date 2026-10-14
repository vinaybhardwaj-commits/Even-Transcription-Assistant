import type { AnyAgentDefinition } from '../platform/agent/types.js'
import { surgicalConsult } from './surgical-consult/definition.js'

/**
 * Every registered agent. Adding an agent is one import plus one entry here.
 * The example.echo toy agent is deliberately not listed: it exists for tests only.
 */
export const AGENTS: AnyAgentDefinition[] = [surgicalConsult]

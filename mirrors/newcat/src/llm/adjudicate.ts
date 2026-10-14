import type { StageOutcome } from '../outcome.js'
import type { ModelClient, ModelCompletion } from './types.js'

/**
 * Opus drafts an adjudication note. Phase 0 does not call this from the audit pipe.
 * A model failure stays a typed failure. It is never turned into a route.
 */
export async function draftAdjudication(
  models: ModelClient,
  input: { traceId: string; findingId: string },
): Promise<StageOutcome<ModelCompletion>> {
  return models.complete({
    tier: 'opus',
    system: 'You draft a short adjudication note for a human reviewer. You do not assign a route.',
    user: `finding_id=${input.findingId}\nReturn one sentence a reviewer can edit.`,
    maxOutputTokens: 256,
    traceId: input.traceId,
    purpose: 'adjudication_draft',
  })
}

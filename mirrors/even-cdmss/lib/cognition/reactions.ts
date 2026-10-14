/**
 * lib/cognition/reactions.ts — WM2 v1: the reaction vocabulary and the replay guard (reaction/0.1).
 *
 * PURE. No db, no LLM, no I/O. All SQL lives in lib/cognition/reactions-store.ts.
 *
 * A reaction is a belief record: what a doctor pressed on a Findings card, provenance
 * CLINICIAN_REPORTED_BELIEF. It notifies nobody, escalates nothing, and opens no thread. One
 * reaction per signal per physician, immutable — so the interesting logic is not "what does this
 * mean" but "has this person already answered this card", which is what classifyReaction decides.
 *
 * The shape mirrors classifyDoctorResponse in lib/opd-gov-signal-core.ts deliberately: same three
 * words, same posture — a replay is a read, a changed answer is refused, and only an unanswered
 * subject takes a write.
 */
export { REACTION_VERBS, type ReactionVerb } from './schema';
import { REACTION_VERBS } from './schema';
import type { ReactionVerb } from './schema';

/** Is this exactly one of the three verbs? Case-sensitive and whitespace-sensitive by design —
 *  'Dismiss' and 'dismiss ' are not the vocabulary, and a store that accepted them would hold two
 *  spellings of one belief. */
export function isReactionVerb(v: unknown): v is ReactionVerb {
  return typeof v === 'string' && (REACTION_VERBS as readonly string[]).includes(v);
}

/**
 * One reaction per signal per physician.
 *   'first'    — nothing stored; the caller writes the row.
 *   'replay'   — the same verb again; the caller returns the stored row and writes nothing.
 *   'conflict' — a different verb; the caller returns 409 and writes nothing. A reaction is
 *                immutable: changing one's mind is a new belief, not an edit of the old one.
 */
export function classifyReaction(
  stored: { reaction: string } | null,
  incoming: string,
): 'first' | 'replay' | 'conflict' {
  if (stored == null) return 'first';
  return stored.reaction === incoming ? 'replay' : 'conflict';
}

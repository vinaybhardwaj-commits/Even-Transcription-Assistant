/**
 * lib/review/session.ts — WM6: the sequential-review step model (review/0.1).
 *
 * PURE. No db, no LLM, no I/O. All SQL lives in lib/review/store.ts.
 *
 * A review walks one case forward, one cut at a time. The rules that matter are all about what a
 * reviewer is ALLOWED to do next, and they exist because the measurement is worthless otherwise:
 *
 *  - A REVEALED CUT CANNOT BE UNSEEN. `revealedIndex` only moves forward, and the route never
 *    returns a cut beyond it. A reviewer who has seen day 5 cannot honestly record what they would
 *    have believed on day 3.
 *  - THE BASE BELIEF COMES FIRST, then each chosen perturbation in catalogue order. A perturbed
 *    belief recorded before the base one is not a counterfactual, it is a different question.
 *  - BELIEFS ARE FINAL. `classifyBelief` gives a replay the same answer twice and refuses a
 *    changed one; there is no edit path anywhere in this ship.
 *  - AN OUTAGE ENDS THE SESSION, A QUIET DAY DOES NOT. `context_fetch_failed` is "we could not read
 *    the spine" and stops the walk as `incomplete`. `no_prior_history` is knowledge — the record
 *    genuinely held nothing before that day — so that cut is shown and takes beliefs like any
 *    other. Collapsing the two would let an outage be recorded as a belief about an empty chart.
 */
import { NEXT_INVESTIGATIONS, type ReviewBeliefPayload, type ReviewVariantId } from '../cognition/schema';
import { isVariantId } from './perturbations';

export type ReviewCutStatus = 'ok' | 'no_prior_history' | 'context_fetch_failed';
export type ReviewStatus = 'active' | 'completed' | 'incomplete';
export type ReviewerRole = 'consulting_physician' | 'neurologist';

export interface ReviewSession {
  id: string;
  variants: ReviewVariantId[];
  cutCount: number;
  revealedIndex: number;
  status: ReviewStatus;
  cuts: Array<{ date: string; status: ReviewCutStatus }>;
}

export interface BeliefKey {
  stepIndex: number;
  variantId: ReviewVariantId | null;
}

/** The two roles a reviewer can sit in. A role, never a person — nothing here identifies anyone. */
export const REVIEWER_ROLES: readonly ReviewerRole[] = ['consulting_physician', 'neurologist'];
export function isReviewerRole(v: unknown): v is ReviewerRole {
  return typeof v === 'string' && (REVIEWER_ROLES as readonly string[]).includes(v);
}

/** Does this cut take beliefs? Everything except an outage. See the file header. */
export function cutTakesBeliefs(status: ReviewCutStatus): boolean {
  return status !== 'context_fetch_failed';
}

/** The keys one step needs, in the order they must be recorded: base first, then each chosen
 *  variant in catalogue order (the order `variants` was stored in at start). */
export function requiredKeys(session: ReviewSession, stepIndex: number): BeliefKey[] {
  return [{ stepIndex, variantId: null }, ...session.variants.map((v) => ({ stepIndex, variantId: v }))];
}

const sameKey = (a: BeliefKey, b: BeliefKey) => a.stepIndex === b.stepIndex && a.variantId === b.variantId;

/** The first key of the CURRENT step not yet recorded, or null when the step is finished. */
export function nextRequired(session: ReviewSession, recorded: BeliefKey[]): BeliefKey | null {
  for (const key of requiredKeys(session, session.revealedIndex)) {
    if (!recorded.some((r) => sameKey(r, key))) return key;
  }
  return null;
}

/** May this exact key be recorded right now? Every condition is a refusal, never a correction. */
export function canRecord(session: ReviewSession, recorded: BeliefKey[], key: BeliefKey): boolean {
  if (session.status !== 'active') return false;
  if (key.stepIndex !== session.revealedIndex) return false;
  const cut = session.cuts[session.revealedIndex];
  if (!cut || !cutTakesBeliefs(cut.status)) return false;
  if (key.variantId !== null && !isVariantId(key.variantId)) return false;
  const next = nextRequired(session, recorded);
  return next != null && sameKey(next, key);
}

/**
 * Move the session on, if the current step is finished. Returns the session unchanged while any key
 * of the current step is still outstanding.
 *
 * The newly revealed cut decides what happens next: an outage there ends the session as
 * `incomplete`, and running out of cuts ends it as `completed`.
 */
export function advance(session: ReviewSession, recorded: BeliefKey[]): ReviewSession {
  if (nextRequired(session, recorded) != null) return session;
  const nextIndex = session.revealedIndex + 1;
  if (nextIndex < session.cutCount) {
    const revealed = session.cuts[nextIndex];
    const status: ReviewStatus = revealed && !cutTakesBeliefs(revealed.status) ? 'incomplete' : 'active';
    return { ...session, revealedIndex: nextIndex, status };
  }
  return { ...session, status: 'completed' };
}

/**
 * Stable serialisation for the payload comparison: object keys sorted at every depth, arrays left
 * in order.
 *
 * A THIRD COPY, ON PURPOSE. `lib/preop-assemble-core.ts` and `lib/lab-v2/contracts.ts` each carry
 * their own `canonicalJson`; neither is a shared utility, and importing either would put an edge
 * from the review model into a preop scoring core or into lab-v2's contracts on the generated
 * architecture map — a dependency that does not exist in fact. Six lines beat a false edge.
 */
function canonicalJson(v: unknown): string {
  if (v === null || typeof v !== 'object') return JSON.stringify(v ?? null);
  if (Array.isArray(v)) return `[${v.map(canonicalJson).join(',')}]`;
  const o = v as Record<string, unknown>;
  return `{${Object.keys(o).sort().map((k) => `${JSON.stringify(k)}:${canonicalJson(o[k])}`).join(',')}}`;
}

/**
 * Is this belief new, the same one again, or a changed one? Payloads compare by canonical JSON, so
 * key order never decides. A conflict is refused, not merged: a reviewer who wants to say something
 * different is saying a second thing, and this ship has nowhere to put it.
 */
export function classifyBelief(
  stored: { payload: unknown } | null,
  incoming: { payload: unknown },
): 'first' | 'replay' | 'conflict' {
  if (stored == null) return 'first';
  return canonicalJson(stored.payload) === canonicalJson(incoming.payload) ? 'replay' : 'conflict';
}

// ── validation ────────────────────────────────────────────────────────────────

export type Parsed<T> = { ok: true; value: T } | { ok: false; error: string };

/** The chosen perturbations: catalogue ids, no repeats, empty allowed. Returned in catalogue order
 *  so `requiredKeys` is stable no matter what order the form sent them in. */
export function parseVariants(input: unknown): Parsed<ReviewVariantId[]> {
  if (!Array.isArray(input)) return { ok: false, error: 'unknown variant' };
  const out: ReviewVariantId[] = [];
  for (const v of input) {
    if (!isVariantId(v) || out.includes(v)) return { ok: false, error: 'unknown variant' };
    out.push(v);
  }
  return { ok: true, value: out };
}

const MAX_TEXT = 200;
const isInt = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v);

/**
 * The four-field belief. Every failure names its field, because a reviewer who cannot see which
 * field was refused will retype all four.
 */
export function validateBeliefPayload(input: unknown): Parsed<ReviewBeliefPayload> {
  if (input == null || typeof input !== 'object') return { ok: false, error: 'payload is required' };
  const p = input as Record<string, unknown>;

  const leading = typeof p.leading_diagnosis === 'string' ? p.leading_diagnosis.trim() : '';
  if (!leading || leading.length > MAX_TEXT) {
    return { ok: false, error: `leading_diagnosis must be 1 to ${MAX_TEXT} characters` };
  }
  if (!isInt(p.confidence) || p.confidence < 0 || p.confidence > 100) {
    return { ok: false, error: 'confidence must be an integer from 0 to 100' };
  }
  const next = p.next_investigation;
  if (typeof next !== 'string' || !(NEXT_INVESTIGATIONS as readonly string[]).includes(next)) {
    return { ok: false, error: `next_investigation must be one of ${NEXT_INVESTIGATIONS.join('|')}` };
  }
  let otherText: string | null = null;
  if (next === 'other') {
    const t = typeof p.other_text === 'string' ? p.other_text.trim() : '';
    if (!t || t.length > MAX_TEXT) return { ok: false, error: `other_text must be 1 to ${MAX_TEXT} characters when next_investigation is other` };
    otherText = t;
  } else if (p.other_text != null && String(p.other_text).trim() !== '') {
    return { ok: false, error: 'other_text must be null unless next_investigation is other' };
  }
  if (typeof p.unsafe_to_wait !== 'boolean') return { ok: false, error: 'unsafe_to_wait must be a boolean' };

  return {
    ok: true,
    value: {
      leading_diagnosis: leading,
      confidence: p.confidence,
      next_investigation: next as ReviewBeliefPayload['next_investigation'],
      other_text: otherText,
      unsafe_to_wait: p.unsafe_to_wait,
    },
  };
}

/** Wall-clock on one step. Bounded so a tab left open overnight cannot land as a burden figure. */
export function parseSecondsSpent(input: unknown): Parsed<number> {
  if (!isInt(input) || input < 0 || input > 3600) return { ok: false, error: 'seconds_spent must be an integer from 0 to 3600' };
  return { ok: true, value: input };
}

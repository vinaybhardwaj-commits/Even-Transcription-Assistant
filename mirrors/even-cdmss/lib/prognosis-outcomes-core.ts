/**
 * lib/prognosis-outcomes-core.ts — PX Phase 2 (outcome linkage) PURE core. No I/O, no DB.
 *
 * PRD: CDMSS-PROGNOSIS-PHASE-2-OUTCOME-LINKAGE-PRD-v1.0-4-AUG-2026 (decisions P-1..P-10, settled).
 *
 * WHAT LIVES HERE and why it is pure:
 *   · the stable complication binding (P-2) — hash of the NORMALIZED complication name, because
 *     lib/ipd-audit/store.ts upserts `ON CONFLICT (document_id, engine_version) DO UPDATE SET
 *     report = EXCLUDED.report`: a re-audit rewrites the complications array in place, so a stored
 *     integer index silently points at a different complication, and an engine bump writes a NEW
 *     row that orphans the old link. Same defect class as G-1 order independence.
 *   · classification derivation (P-5) — derived from form state, NEVER typed by the user.
 *   · hash resolution — by hash ONLY. The integer index is advisory/debugging; falling back to it
 *     is the exact bug P-2 exists to prevent, so no function in this module even accepts it.
 *   · the follow-up bucket rule (§5.5) — `not_followed_up` is a first-class answer. This mirrors
 *     lib/opd-audit/investigations-lookup.ts: null means unknown, not zero — an absent outcome row
 *     must never be read as "nothing happened".
 */

import { createHash } from 'crypto';

// ── vocabulary ─────────────────────────────────────────────────────────────────────────────────

export const OUTCOME_SOURCES = ['complaint', 'readmission', 'revisit', 'reoperation', 'call', 'other'] as const;
export type OutcomeSource = (typeof OUTCOME_SOURCES)[number];
export function isOutcomeSource(x: unknown): x is OutcomeSource {
  return typeof x === 'string' && (OUTCOME_SOURCES as readonly string[]).includes(x);
}

/** P-5: four values, not three. `no_adverse_outcome` is what makes over-warning computable —
 *  without it, an absent row is ambiguous between "nothing happened" and "nobody looked". */
export const OUTCOME_CLASSIFICATIONS = ['predicted_occurred', 'unpredicted_occurred', 'benefit_failure', 'no_adverse_outcome'] as const;
export type OutcomeClassification = (typeof OUTCOME_CLASSIFICATIONS)[number];
export function isOutcomeClassification(x: unknown): x is OutcomeClassification {
  return typeof x === 'string' && (OUTCOME_CLASSIFICATIONS as readonly string[]).includes(x);
}

// ── the stable binding (P-2) ───────────────────────────────────────────────────────────────────

/** Normalize a complication name for hashing: trim, lower-case, collapse internal whitespace to a
 *  single space. EXACTLY these three steps — normalization is part of the stored contract, so
 *  adding a step later would orphan every previously stored hash. */
export function normalizeComplicationName(name: string): string {
  return String(name ?? '').trim().toLowerCase().replace(/\s+/g, ' ');
}

/** The stable binding: Node crypto sha256 of the normalized name, hex, FIRST 16 CHARACTERS.
 *  No new dependency (P-2 / non-goal 6). */
export function complicationHash(name: string): string {
  return createHash('sha256').update(normalizeComplicationName(name), 'utf8').digest('hex').slice(0, 16);
}

/** Shape check for a stored hash — 16 lowercase hex chars, exactly what complicationHash emits. */
export function isComplicationHash(x: unknown): x is string {
  return typeof x === 'string' && /^[0-9a-f]{16}$/.test(x);
}

// ── classification derivation (§5.3) — shown, not typed ────────────────────────────────────────

/** The form state the classification derives from. There is deliberately no `classification`
 *  input anywhere in this module's write path — deriving it removes a class of entry error. */
export interface OutcomeFormState {
  /** "Followed up, nothing happened." */
  noAdverseOutcome: boolean;
  /** "This is a benefit failure." */
  benefitFailure: boolean;
  /** The selected complication's hash, or null for "nobody predicted this". */
  matchedComplicationHash: string | null;
}

export interface DerivedClassification {
  classification: OutcomeClassification;
  /** The hash to STORE — `no_adverse_outcome` forces it to NULL (normative). */
  matchedComplicationHash: string | null;
}

/**
 * §5.3, verbatim rules:
 *   · "followed up, nothing happened" → no_adverse_outcome, and the complication select is
 *     disabled — so the stored hash is FORCED to null whatever the form held.
 *   · the benefit-failure tick → benefit_failure.
 *   · a complication selected → predicted_occurred.
 *   · "nobody predicted this" (null hash) → unpredicted_occurred.
 */
export function deriveClassification(s: OutcomeFormState): DerivedClassification {
  if (s.noAdverseOutcome) return { classification: 'no_adverse_outcome', matchedComplicationHash: null };
  if (s.benefitFailure) return { classification: 'benefit_failure', matchedComplicationHash: s.matchedComplicationHash };
  if (s.matchedComplicationHash != null) return { classification: 'predicted_occurred', matchedComplicationHash: s.matchedComplicationHash };
  return { classification: 'unpredicted_occurred', matchedComplicationHash: null };
}

// ── resolution (P-2) — by hash, never by index ─────────────────────────────────────────────────

/**
 * How a stored hash reads against the CURRENT complications block.
 *   · matched     — the hash names a complication in the block (index/name are of the CURRENT
 *                   block, for rendering).
 *   · unpredicted — the stored hash is NULL: nobody predicted this outcome (or it is a
 *                   no_adverse_outcome row, which the caller tells apart by classification).
 *   · unresolved  — the hash matches nothing. FIRST-CLASS STATE, NOT AN ERROR: the block changed
 *                   under a recorded outcome, which is information worth seeing. NEVER silently
 *                   re-pointed at whatever now sits at the stored integer index.
 */
export type HashResolution =
  | { status: 'matched'; index: number; complication: string }
  | { status: 'unpredicted' }
  | { status: 'unresolved' };

export function resolveComplicationHash(
  hash: string | null | undefined,
  complications: ReadonlyArray<{ complication: string }>,
): HashResolution {
  if (hash == null || hash === '') return { status: 'unpredicted' };
  const list = Array.isArray(complications) ? complications : [];
  for (let i = 0; i < list.length; i++) {
    const name = list[i]?.complication;
    if (typeof name === 'string' && complicationHash(name) === hash) {
      return { status: 'matched', index: i, complication: name };
    }
  }
  return { status: 'unresolved' };
}

// ── supersede (P-7) — append-only reading rules ────────────────────────────────────────────────

/** Non-superseded rows only — what every read path and the metrics view count. The history
 *  toggle shows everything; the default shows these. */
export function currentRows<T extends { superseded: boolean }>(rows: ReadonlyArray<T>): T[] {
  return (Array.isArray(rows) ? rows : []).filter((r) => r?.superseded !== true);
}

// ── the follow-up bucket (§5.5) — the honest denominator ───────────────────────────────────────

export type FollowUpBucket = 'followed_up' | 'not_followed_up';

/** A document with ANY non-superseded outcome row (event or no_adverse_outcome) is followed up.
 *  With none it is `not_followed_up` — counted and shown, never folded into a rate. */
export function followUpBucket(
  outcomes: ReadonlyArray<{ classification: OutcomeClassification | string; superseded: boolean }>,
): FollowUpBucket {
  return currentRows(outcomes).length > 0 ? 'followed_up' : 'not_followed_up';
}

/**
 * §5.5: "anticipated and never occurred" is counted ONLY where a `no_adverse_outcome` row exists
 * for the document. An event row alone does not qualify — it proves someone looked at ONE outcome,
 * not that the remaining anticipated complications were checked and found absent. Everything else
 * stays outside the over-warning denominator rather than silently inflating it.
 */
export function inOverWarningDenominator(
  outcomes: ReadonlyArray<{ classification: OutcomeClassification | string; superseded: boolean }>,
): boolean {
  return currentRows(outcomes).some((r) => r.classification === 'no_adverse_outcome');
}

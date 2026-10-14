/**
 * lib/review/perturbations.ts — WM6: the perturbation catalogue (review/0.1).
 *
 * PURE. No db, no LLM, no I/O.
 *
 * ⚠️ THE OVERLAY IS TEXT AND ONLY TEXT. A perturbation does NOT modify the snapshot. The object
 * handed to the renderer is the same object with or without a variant — byte-for-byte the same
 * reference — and the counterfactual lives entirely in a sentence shown beside it. This is the
 * whole safety property of the design: a reviewer's perturbed belief is recorded against the real
 * record plus a stated assumption, never against a fabricated record. If a future ship ever wants
 * a perturbation that edits the spine, it must be a different mechanism with a different name, and
 * this module must not grow it.
 *
 * The three sentences are the ratified strings (CAT Design, 8 Sep 2026). They are quoted verbatim
 * in the report. Never paraphrase one.
 */
import { REVIEW_VARIANT_IDS, type ReviewVariantId } from '../cognition/schema';

export interface Perturbation {
  id: ReviewVariantId;
  /** The sentence shown to the reviewer, in the Perturbation box and on the start form's checkbox. */
  overlay: string;
}

export const PERTURBATIONS: readonly Perturbation[] = [
  { id: 'fever_39_5', overlay: 'Perturbation: assume a temperature of 39.5 °C was recorded at this visit.' },
  { id: 'ct_done_normal', overlay: 'Perturbation: assume a non-contrast CT head was done at this visit and reported normal.' },
  { id: 'age_plus_30', overlay: 'Perturbation: assume the patient is 30 years older than shown.' },
] as const;

/** Is this exactly one of the catalogue ids? Case- and whitespace-sensitive. */
export function isVariantId(v: unknown): v is ReviewVariantId {
  return typeof v === 'string' && (REVIEW_VARIANT_IDS as readonly string[]).includes(v);
}

/** The overlay text for a variant id. Throws on an unknown id — a silent empty overlay would put a
 *  reviewer in front of an unlabelled counterfactual, which is worse than a failed render. */
export function overlayFor(variantId: string): string {
  const found = PERTURBATIONS.find((p) => p.id === variantId);
  if (!found) throw new Error(`unknown variant: ${variantId}`);
  return found.overlay;
}

/**
 * lib/opd-audit-layers-core.ts — the three-layer report vocabulary for the OPD case-audit page
 * (facts-then-rules PR 1; docs/DETERMINISTIC-AUDIT-ARCHITECTURE.md §3.2, §3.3, §3.7).
 *
 * PURE. No IO, no imports, no rendering. It exists so the ONE rule that matters can be asserted
 * by a unit test instead of trusted to a JSX reader:
 *
 *   finding_origin comes from the STORED `source` field and from nothing else.
 *
 * Never infer origin from `rule_ref`. The matcher (`stampLvcMetadata`) keyword-matches finding
 * PROSE after the findings already exist, so a model-authored finding can carry a `rule_ref` and
 * it proves nothing fired (§3.2; Saul Rep 39 blocker 2). `findingOrigin` therefore accepts ONLY
 * the source field — a caller physically cannot pass a rule_ref into it.
 *
 * `unknown` is an honest value, not an error state: rows written before `source` existed, or with
 * it absent, are legacy-honest (§3.7). Do not guess.
 *
 * Layer scope (PR 1): Facts · Findings · Model. Proposals are NOT a layer here — the model-
 * proposal type arrives in PR 2, and a historical model-authored finding is a FINDING, never a
 * proposal (§3.7). Nothing in this file scores, and PR 1 changes nothing the engine writes.
 */

export type FindingOrigin = 'deterministic' | 'model' | 'unknown';

/**
 * The stored-field origin of one finding (§3.3 `finding_origin`).
 * `source === 'deterministic'` → deterministic · `source === 'llm'` → model · anything else
 * (absent, null, an unrecognised value) → unknown. The parameter is the source field ALONE.
 */
export function findingOrigin(source: string | null | undefined): FindingOrigin {
  if (source === 'deterministic') return 'deterministic';
  if (source === 'llm') return 'model';
  return 'unknown';
}

export interface OriginPresentation {
  /** The chip's visible text — exactly the three governed values. */
  label: FindingOrigin;
  /** What the chip means, in plain words (hover title). */
  title: string;
  /** Tailwind classes; deliberately distinct from the grounding chip and the longitudinal badge. */
  cls: string;
}

/**
 * ONE home for the origin chip's presentation (the GROUNDING_PRESENTATION convention).
 *
 * The `model` copy is the wording the kickoff fixed in meaning: a legacy model-authored FINDING.
 * It is not a proposal, and it is not relabelled as one.
 */
export const ORIGIN_PRESENTATION: Record<FindingOrigin, OriginPresentation> = {
  deterministic: {
    label: 'deterministic',
    title: 'Deterministic finding — code decided this from the note, not a model.',
    cls: 'border-indigo-200 bg-indigo-50 text-indigo-700',
  },
  model: {
    label: 'model',
    title: 'Legacy model-authored finding — the model wrote this finding itself, and it scored as one. It is a finding, not a proposal.',
    cls: 'border-purple-200 bg-purple-50 text-purple-700',
  },
  unknown: {
    label: 'unknown',
    title: 'Origin not recorded on this row — written before the audit stored where a finding came from. An honest gap, not an error.',
    cls: 'border-slate-200 bg-slate-50 text-slate-500',
  },
};

/** The three layers, in the page's existing order. Copy lives here so the page reads as prose. */
export const LAYER_COPY = {
  facts: {
    n: 1,
    title: 'Facts',
    line: 'Current source data, read now. Not the facts as they were when this note was audited.',
  },
  findings: {
    n: 2,
    title: 'Findings',
    line: 'What the audit concluded, and where each conclusion came from. A model chip means a legacy model-authored finding — the model wrote it directly; it is a finding, not a proposal. An unknown chip means the row predates the origin field.',
  },
  model: {
    n: 3,
    title: 'Model ratings',
    line: 'PDQI-9 is model-derived — a rating, not a rule — and is about 25% of the index. Making findings more deterministic does not make the whole index deterministic.',
  },
} as const;
